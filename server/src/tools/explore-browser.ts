// The runner's eyes. Starts the web dev server (unless it is given one) and a headless Chrome, opens
// `explore.html#harness` (web/src/explore/harness.ts), and asks it, over the DevTools protocol on Node's own
// WebSocket, to lay a recorded answer out, say how it landed, and take pictures of it.
// Nothing here is part of the server. Everything it starts is stopped by `close()` and, failing that, on exit.

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnTracked } from '../brains/claude-cli/process';
import { processEnvironment } from '../env';

/** The harness's request and reply, as web/src/explore/harness.ts declares them. They cross as JSON, so they are typed loosely here. */
export interface HarnessReply {
  readonly report: import('@conduit/language').TurnReport;
  readonly duration: number;
  readonly judge: readonly string[];
  readonly thumbs: readonly string[];
  readonly snapshot: string | null;
  readonly complete: boolean;
  readonly renderer: string;
  readonly geometry: import('@conduit/language').ExploreGeometry;
  /** v2.1. The answer is told in captions: the first of `judge` are then the strip's stills */
  readonly captioned: boolean;
  readonly placed: readonly import('@conduit/language').PlacedBox[];
}

export interface DriveRequest {
  readonly turn: string;
  readonly base: import('@conduit/language').StageBase;
  readonly lines: readonly { readonly seq: number; readonly line: import('@conduit/language').Line }[];
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly side: number;
  /** the look to work the answer in; absent or null: the one it chose */
  readonly look?: import('@conduit/language').LookId | null;
}

/** What working an answer's controls and charts came to, as web/src/explore/drive.ts reports it. */
export interface DriveReply {
  readonly capabilities: import('@conduit/language').Capabilities | null;
  readonly controls: readonly {
    readonly id: string;
    readonly kind: import('@conduit/language').ControlKind;
    readonly label: string;
    readonly bound: boolean;
    readonly send: boolean;
    readonly changed: number | null;
    readonly ownChanged: number | null;
    readonly reported: boolean;
    readonly description: string;
    readonly ends: readonly [string, string] | null;
  }[];
  readonly values: import('@conduit/language').ControlValues;
  readonly pressed: { readonly id: string; readonly text: string; readonly values: import('@conduit/language').ControlValues } | null;
  readonly charts: readonly { readonly id: string; readonly kind: string; readonly crosshair: boolean; readonly zoomed: boolean; readonly silent: boolean; readonly frameMs: { readonly median: number; readonly worst: number }; readonly ticks: { readonly x: readonly string[]; readonly y: readonly string[] }; readonly stage: import('@conduit/language').ChartStageCheck }[];
  readonly fault: string | null;
}

export interface HarnessRequest {
  readonly turn: string;
  readonly base: import('@conduit/language').StageBase;
  readonly lines: readonly { readonly seq: number; readonly line: import('@conduit/language').Line }[];
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly playhead: number | null;
  readonly earlier: readonly number[];
  readonly judgeSide: number;
  /** v2.1. Lay the answer out in this look, whatever it chose; absent or null: the one it chose */
  readonly look?: import('@conduit/language').LookId | null;
  /** v2.1. False: count and take no pictures (the replay pass). Default true */
  readonly pictures?: boolean;
  /** v2.1. Shares of the answer at which to picture it first when it is told in captions */
  readonly strip?: readonly number[];
}

export interface Eyes {
  look(request: HarnessRequest): Promise<HarnessReply>;
  /** what the page's painter says it can do at this window: the brain is taught exactly this */
  capabilities(viewport: { readonly width: number; readonly height: number; readonly dpr: number }): Promise<import('@conduit/language').Capabilities | null>;
  /** works every control and chart of an answer through the page's painter */
  drive(request: DriveRequest): Promise<DriveReply>;
  close(): Promise<void>;
}

const CHROME_CANDIDATES = [
  processEnvironment()['CHROME_BIN'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((path): path is string => typeof path === 'string' && path !== '');

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | null>): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await probe().catch(() => null);
    if (found !== null) return found;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('close', () => done());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  });
}

/** A DevTools connection to one page. */
class Cdp {
  private id = 0;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const entry = this.waiting.get(message.id);
      if (entry === undefined) return;
      this.waiting.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const entry of this.waiting.values()) entry.reject(new Error('Chrome closed the DevTools connection'));
      this.waiting.clear();
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((done, fail) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => done(new Cdp(socket)));
      socket.addEventListener('error', () => fail(new Error(`cannot open ${url}`)));
    });
  }
  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = (this.id += 1);
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }
  close(): void {
    this.socket.close();
  }
}

export interface EyesOptions {
  /** a running web server (the dev server); null starts one on `port` */
  readonly web: string | null;
  readonly port: number;
  readonly repo: string;
}

export async function openEyes(options: EyesOptions): Promise<Eyes> {
  const started: ChildProcess[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const close = async (): Promise<void> => {
    for (const child of started.splice(0)) await stop(child);
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  };

  try {
    let web = options.web;
    if (web === null) {
      web = `http://127.0.0.1:${options.port}`;
      const vite = spawnTracked('pnpm', ['--filter', '@conduit/web', 'exec', 'vite'], undefined, {
        cwd: options.repo,
        env: { VITE_PORT: String(options.port), VITE_API: 'http://127.0.0.1:1' },
        quiet: true,
      });
      started.push(vite);
      await waitFor('the web dev server', 60_000, async () => ((await fetch(`${web}/explore.html`)).ok ? true : null));
    }

    const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
    if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
    const profile = await mkdtemp(join(tmpdir(), 'conduit-explore-'));
    cleanups.push(() => rm(profile, { recursive: true, force: true }));
    const child = spawnTracked(
      chrome,
      ['--headless=new', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'],
      undefined,
      { quiet: true },
    );
    started.push(child);
    const endpoint = await waitFor('Chrome', 20_000, async () => {
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const [port, path] = text.split('\n');
      return port !== undefined && path !== undefined ? `ws://127.0.0.1:${port}${path}` : null;
    });
    const browser = await Cdp.open(endpoint);
    cleanups.unshift(async () => browser.close());
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Page.navigate', { url: `${web}/explore.html#harness` }, sessionId);

    const evaluate = async <T>(expression: string): Promise<T> => {
      const out = await browser.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
      return out.result.value as T;
    };
    await waitFor('the harness page', 60_000, async () => ((await evaluate<boolean>('Boolean(window.__harness && window.__harness.ready)')) ? true : null));

    return {
      look: (request) => evaluate<HarnessReply>(`window.__harness.run(${JSON.stringify(request)})`),
      capabilities: (viewport) => evaluate(`window.__harness.capabilities(${JSON.stringify(viewport)})`),
      drive: (request) => evaluate<DriveReply>(`window.__harness.drive(${JSON.stringify({ ...request, viewport: request.viewport })})`),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export const repoRoot = (): string => resolve(import.meta.dirname, '..', '..', '..');
