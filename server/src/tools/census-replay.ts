// pnpm census-replay: a logged turn, put through the census and the invariants. Report-only.
//
//   tsx src/tools/census-replay.ts <log> [turn ...] [--all] [--screen 1280x720] [--screen 390x844] [--json <file>] [--web <url>] [--data <dir>]
//
// Replays the turn exactly as `pnpm capture` does (the logged lines at their logged arrival playheads, from the stage the log left,
// through the app's own timeline and renderer in a headless Chrome), then hands the page's frames to web/src/core: the census at rest
// (from the painter's own views and plan, with the resting picture), at the end of play and at every tenth second of play, and every
// rule over them. It prints each turn's violations and writes them as JSON. Nothing is written to a log. The log reading, the browser
// and the page-script setup are capture.ts's, copied so that file stays another package's.
// The page half is a script this file hands to the page. The page already serves the app's modules over the dev server, so the script
// imports them (the same instances the app uses) rather than carrying a copy of any of it.

import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { StageBase } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { withDataFlag } from '../data-dir';
import { processEnvironment, resolveLogDir } from '../env';
import type { SessionRecord } from '../domain/session-log';

const WEB_PORT = Number(process.env.CAPTURE_WEB_PORT ?? 4950);
const CHROME_PORT = Number(process.env.CAPTURE_CHROME_PORT ?? 4951);
const SCREENS: Readonly<Record<string, { width: number; height: number }>> = { '1280x720': { width: 1280, height: 720 }, '390x844': { width: 390, height: 844 }, '1920x825': { width: 1920, height: 825 } };
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function usage(message: string): never {
  process.stderr.write(`census-replay: ${message}\n`);
  process.stderr.write('usage: census-replay <log> [turn ...] [--all] [--shell] [--screen WxH] [--json file] [--web url] [--data dir]\n  <log> is a path, or the log file name or session id as found in the data folder\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The log

type Of<T extends SessionRecord['type']> = Extract<SessionRecord, { type: T }>;

interface LoggedTurn {
  readonly turn: string;
  readonly asked: string;
  /** how the turn was opened (`input.kind`), which decides whether the choices it was answering leave */
  readonly opened: string;
  readonly at: number;
  /** ms the viewer first saw something (the painter's `started`), else the first line's arrival */
  readonly shownAt: number;
  readonly lines: readonly { readonly seq: number; readonly text: string; readonly floor: number }[];
  /** the resting stage this turn left, as the painter reported it; null when it reported none */
  readonly left: StageBase | null;
  readonly snapshot: string | null;
}

async function readLog(file: string): Promise<LoggedTurn[]> {
  const records: SessionRecord[] = [];
  for (const raw of (await readFile(file, 'utf8')).split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const record = JSON.parse(raw) as SessionRecord;
      if (typeof record.type === 'string') records.push(record);
    } catch {
      // a line cut short by a kill
    }
  }
  const opens = records.filter((record): record is Of<'turn'> => record.type === 'turn');
  return opens.map((open) => {
    const mine = records.filter((record) => 'turn' in record && record.turn === open.turn);
    const lines = mine.filter((record): record is Of<'line'> => record.type === 'line' && (record.pass ?? 1) <= 1);
    const started = mine.find((record): record is Of<'started'> => record.type === 'started');
    const report = mine.find((record): record is Of<'report'> => record.type === 'report');
    const snapshot = mine.find((record): record is Of<'snapshot'> => record.type === 'snapshot');
    const first = lines[0];
    const shownAt = started?.at ?? first?.at ?? open.at;
    const input = open.input;
    const asked = input.kind === 'prompt' || input.kind === 'tap' || input.kind === 'act' ? input.text : input.kind === 'demo' ? `demo ${input.script}` : input.kind;
    return {
      turn: open.turn,
      asked,
      opened: input.kind,
      at: open.at,
      shownAt,
      // The playhead a line arrived at is how long the viewer had been watching; it can never be later than where the line started.
      lines: lines.map((line) => ({ seq: line.seq, text: line.text, floor: Math.max(0, Math.min((line.at - shownAt) / 1000, line.start)) })),
      left: report === undefined ? null : report.report.stage,
      snapshot: snapshot?.file ?? null,
    };
  });
}

/** The stage a turn began from: what the nearest earlier turn that reported left behind; null is the empty stage. */
function baseOf(turns: readonly LoggedTurn[], index: number): StageBase | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const left = turns[i]?.left;
    if (left !== null && left !== undefined) return left;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class Cdp {
  private id = 0;
  private readonly waiting = new Map<number, Pending>();
  private constructor(private readonly socket: WebSocket) {
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
    return new Promise<T>((resolvePromise, reject) => {
      this.waiting.set(id, { resolve: resolvePromise as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }
  close(): void {
    this.socket.close();
  }
}

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

const CHROME_CANDIDATES = [processEnvironment()['CHROME_BIN'], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter((path): path is string => typeof path === 'string' && path !== '');

interface Page {
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

async function openPage(web: string | null): Promise<{ page: Page; web: string }> {
  const started: ChildProcess[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const close = async (): Promise<void> => {
    for (const child of started.splice(0)) await stop(child);
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  };
  try {
    let url = web;
    if (url === null) {
      url = `http://127.0.0.1:${WEB_PORT}`;
      const running = await fetch(`${url}/explore.html`).then((reply) => reply.ok).catch(() => false);
      if (!running) {
        started.push(spawnTracked('pnpm', ['--filter', '@conduit/web', 'exec', 'vite'], undefined, { cwd: repoRoot, env: { VITE_PORT: String(WEB_PORT), VITE_API: 'http://127.0.0.1:1' }, quiet: true }));
        await waitFor('the web dev server', 60_000, async () => ((await fetch(`${url}/explore.html`)).ok ? true : null));
      }
    }
    const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
    if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
    const profile = await mkdtemp(join(tmpdir(), 'conduit-capture-'));
    cleanups.push(() => rm(profile, { recursive: true, force: true }));
    started.push(
      spawnTracked(chrome, ['--headless=new', '--mute-audio', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], undefined, { quiet: true }),
    );
    const endpoint = await waitFor('Chrome', 20_000, async () => {
      const reply = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
      const body = (await reply.json()) as { webSocketDebuggerUrl?: string };
      return body.webSocketDebuggerUrl ?? null;
    });
    const browser = await Cdp.open(endpoint);
    cleanups.unshift(async () => browser.close());
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, sessionId);
    // Any page of the app will do: it is only the origin the script imports the app's modules from. The review page's is the lightest.
    await browser.send('Page.navigate', { url: `${url}/explore.html` }, sessionId);
    const page: Page = {
      async evaluate<T>(expression: string): Promise<T> {
        const out = await browser.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
        return out.result.value as T;
      },
      close,
    };
    await waitFor('the page', 30_000, async () => ((await page.evaluate<string>('document.readyState')) === 'complete' ? true : null));
    return { page, web: url };
  } catch (error) {
    await close();
    throw error;
  }
}


/** A log named by its path, or by its file name or session id, which is looked for in the data folder's logs. */
function locate(log: string, data: string | null): string {
  if (existsSync(log) || log.includes('/')) return resolve(log);
  const dir = resolveLogDir(withDataFlag(data === null ? [] : ['--data', data], processEnvironment()));
  if (dir === null || !existsSync(dir)) return resolve(log);
  const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().reverse();
  const found = names.find((name) => name === log || name === `${log}.jsonl` || name.endsWith(`-${log}.jsonl`) || name.startsWith(log));
  return found === undefined ? resolve(log) : join(dir, found);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The page's half

interface Job {
  readonly language: string;
  readonly turn: string;
  readonly opened: string;
  readonly base: StageBase | null;
  readonly lines: readonly { readonly seq: number; readonly text: string; readonly floor: number }[];
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
}

interface Found {
  readonly rule: string;
  readonly severity: string;
  readonly at: { readonly kind: string; readonly time: number };
  readonly keys: readonly string[];
  readonly detail: string;
}

interface Made {
  readonly duration: number;
  readonly digest: string;
  readonly leaves: number;
  readonly expected: number;
  readonly violations: readonly Found[];
  readonly notes: readonly string[];
}

/** Source of an async function of a Job, run in the page. Setup as capture.ts's; then the frames go through web/src/core. */
const PAGE_SCRIPT = String.raw`async (job) => {
  const L = await import(job.language);
  const [{ buildTimeline, settledEnd }, { pinnedWallTime }, { REST_POSE }, { CHARTS_READY, createChartEngine }, { createHarnessChartHost }, { loadChartFonts }, { createPlainRenderer }, { canUseThree, createThreeRenderer }, { witness }] = await Promise.all([
    import('/src/painter/timeline.ts'), import('/src/painter/clock.ts'), import('/src/contracts/space.ts'), import('/src/render/chart/index.ts'),
    import('/src/explore/chart-host.ts'), import('/src/app/chart-host.ts'), import('/src/render/plain/index.ts'), import('/src/render/three/index.ts'), import('/src/core/invariants.ts'),
  ]);
  const notes = [];
  const base = job.base === null ? L.EMPTY_STAGE : job.base;
  const viewport = job.viewport;
  const normalizer = new L.LineNormalizer(() => 'cx' + (++counter));
  let counter = 0;
  const score = new L.TurnScore(base, job.opened);
  const arrivals = new Map();
  for (const entry of job.lines) {
    const parsed = L.parseLine(entry.text);
    if (parsed.kind !== 'line') { notes.push('line ' + entry.seq + ' does not read back'); continue; }
    const normalized = normalizer.normalize(parsed.line);
    if (normalized.line === null) continue;
    const pushed = score.push(normalized.line, entry.seq, entry.floor);
    for (const element of pushed.schedule.elements) {
      if (element.kind !== 'structure' && element.kind !== 'node' && element.kind !== 'link') continue;
      if (!element.carried && !arrivals.has(element.key)) arrivals.set(element.key, entry.floor);
      if (element.figure && element.figure.kind === 'structure') element.figure.rows.forEach((_, i) => arrivals.has(element.key + '#r' + i) || arrivals.set(element.key + '#r' + i, entry.floor));
    }
  }
  const schedule = score.schedule;
  const context = (arrivalMap) => ({ viewport, reducedMotion: false, lockLook: null, paintings: new Map(), arrivals: arrivalMap, charts: { kinds: CHARTS_READY, data: new Map() } });
  const timeline = buildTimeline(schedule, base, context(arrivals));
  const duration = settledEnd(timeline, null, base.scene.mood);
  const stage = L.settle(schedule, base, duration + 1e-6);
  const restTimeline = buildTimeline(new L.TurnScore(stage).schedule, stage, context(new Map()));
  const instantAt = (seconds, ambient) => ({ time: seconds, ambient: ambient === undefined ? seconds : ambient, wallTime: pinnedWallTime(seconds), clock: 'paused' });
  const restFrame = { ...restTimeline.frameAt(instantAt(0, 3)), camera: REST_POSE };

  // the resting picture, as the brain is shown it
  const hold = document.createElement('div');
  hold.style.cssText = 'position:fixed;left:-30000px;top:0;width:' + viewport.width + 'px;height:' + viewport.height + 'px;overflow:hidden;';
  document.body.append(hold);
  const engine = createChartEngine();
  const charts = engine === null ? null : createHarnessChartHost(engine, hold);
  await loadChartFonts();
  const renderer = canUseThree() ? createThreeRenderer() : createPlainRenderer();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + viewport.width + 'px;height:' + viewport.height + 'px;overflow:hidden;';
  document.body.append(host);
  await renderer.mount(host, viewport, restFrame.look);
  if (!renderer.capabilities.capture) throw new Error('this renderer cannot capture pictures here');
  renderer.reset();
  let blob = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let incomplete = false;
    let chartStill;
    if (charts !== null) {
      charts.sync(restFrame.charts || [], 1);
      if ((restFrame.charts || []).length > 0) await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      chartStill = (key) => charts.still(key);
    }
    blob = await renderer.rasterise(restFrame, { maxSide: Math.max(viewport.width, viewport.height), mime: 'image/png', onIncomplete: () => { incomplete = true; }, ...(chartStill === undefined ? {} : { chartStill }) });
    if (blob === null) throw new Error('the renderer returned no picture');
    if (!incomplete) break;
    if (attempt === 2) notes.push('the resting picture was taken before all its text could be drawn');
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const pixels = g.getImageData(0, 0, bitmap.width, bitmap.height);
  const raster = { width: bitmap.width, height: bitmap.height, data: pixels.data, scale: bitmap.width / viewport.width };
  bitmap.close();
  renderer.dispose(); host.remove(); charts && charts.dispose(); hold.remove();

  const screen = { width: viewport.width, height: viewport.height, pointer: viewport.width <= 600 ? 'coarse' : 'fine' };
  const expected = stage.elements
    .filter((element) => (timeline.retired.get(element.key) === undefined))
    .map((element) => ({ key: element.key, id: element.id, kind: element.kind, text: element.text, struck: element.struck === true,
      control: element.figure && element.figure.kind === 'control' ? { kind: element.figure.control, min: element.figure.min, max: element.figure.max, step: element.figure.step, options: element.figure.options } : null }));
  const input = (tl, seconds, ambient, at, withExpected) => ({ at, views: tl.viewsAt(instantAt(seconds, ambient)), plan: tl.planAt(seconds), screen, expected: withExpected ? expected : null, raster: withExpected ? raster : null });
  const ticks = [];
  for (let s = 0; s < duration; s += 10) ticks.push(input(timeline, s, s, { kind: 'play', time: s }, false));
  const result = witness({
    rest: input(restTimeline, 0, 3, { kind: 'rest', time: duration }, true),
    end: input(timeline, Math.max(0, duration - 1e-3), duration, { kind: 'play', time: duration }, false),
    ticks,
  });
  return { duration, digest: result.digest, leaves: result.leaves, expected: expected.length, violations: result.violations.map((v) => ({ rule: v.rule, severity: v.severity, at: v.at, keys: v.keys, detail: v.detail })), notes };
}`;


/** The shell rule over the prompt bar, in every look, with the app's own stylesheet and the app's own `applyLook`. */
const SHELL_SCRIPT = String.raw`async () => {
  await Promise.all([import('/src/styles/tokens.css'), import('/src/styles/chrome.css')]);
  const [{ LOOKS }, { applyLook }, { mountPromptBar }, { checkShell }] = await Promise.all([import('/src/looks/index.ts'), import('/src/app/theme.ts'), import('/src/chrome/prompt.ts'), import('/src/core/shell.ts')]);
  const out = [];
  for (const [look, spec] of Object.entries(LOOKS)) {
    const host = document.createElement('div');
    document.body.append(host);
    applyLook(host, spec);
    document.body.style.background = spec.roles.ground;
    document.documentElement.style.background = spec.roles.ground;
    const bar = mountPromptBar(host, { onSubmit: () => {}, onStop: () => {} });
    bar.setStatus('Thinking');
    const field = host.querySelector('textarea');
    field.value = 'the words the person typed';
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    for (const v of checkShell(host, { kind: 'rest', time: 0 }, look)) out.push({ rule: v.rule, severity: v.severity, at: v.at, keys: v.keys, detail: v.detail });
    bar.dispose();
    host.remove();
  }
  return out;
}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// The command

async function main(): Promise<void> {
  const positional: string[] = [];
  const screens: string[] = [];
  let all = false;
  let shell = false;
  let json: string | null = null;
  let web: string | null = null;
  let data: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const value = (): string => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === '--all') all = true;
    else if (arg === '--shell') shell = true;
    else if (arg === '--screen') screens.push(value());
    else if (arg === '--json') json = value();
    else if (arg === '--web') web = value();
    else if (arg === '--data') data = value();
    else if (arg.startsWith('--')) usage(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  if (shell) {
    const { page } = await openPage(web);
    try {
      const found = await page.evaluate<Found[]>(`(${SHELL_SCRIPT})()`);
      process.stdout.write(`shell: ${found.length === 0 ? 'clean in every look' : `${found.length} violations`}\n`);
      for (const one of found) process.stdout.write(`    ${one.severity.padEnd(8)} ${one.rule.padEnd(9)} ${one.detail}\n`);
    } finally {
      await page.close();
    }
    return;
  }
  const logArg = positional[0];
  if (logArg === undefined) usage('which log?');
  const file = locate(logArg, data);
  if (!existsSync(file)) usage(`no such log: ${file}`);
  const turns = await readLog(file);
  const named = positional.slice(1);
  const wanted = all || named.length === 0 ? turns.map((_, index) => index) : named.map((name) => turns.findIndex((turn) => turn.turn === name));
  if (wanted.some((index) => index < 0)) usage(`the log has no such turn: it has ${turns.map((turn) => turn.turn).join(', ')}`);
  const sizes = (screens.length === 0 ? ['1280x720'] : screens).map((name) => {
    const sized = /^(\d{3,4})x(\d{3,4})$/.exec(name);
    const screen = SCREENS[name] ?? (sized === null ? undefined : { width: Number(sized[1]), height: Number(sized[2]) });
    return screen === undefined ? usage(`--screen is WxH, like ${Object.keys(SCREENS).join(', ')}`) : { name, ...screen };
  });
  const { page } = await openPage(web);
  const out: { log: string; turn: string; asked: string; screen: string; made: Made | null }[] = [];
  try {
    for (const index of wanted) {
      const turn = turns[index];
      if (turn === undefined) continue;
      for (const size of sizes) {
        if (turn.lines.length === 0) {
          process.stdout.write(`${turn.turn} ${size.name}: no lines logged (drew nothing): skipped\n`);
          continue;
        }
        const job: Job = { language: `/@fs${repoRoot}/language/src/index.ts`, turn: turn.turn, opened: turn.opened, base: baseOf(turns, index), lines: turn.lines, viewport: { width: size.width, height: size.height, dpr: 1 } };
        let made: Made | null = null;
        try {
          made = await page.evaluate<Made>(`(${PAGE_SCRIPT})(${JSON.stringify(job)})`);
        } catch (error) {
          process.stdout.write(`${turn.turn} ${size.name}: the replay failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
        }
        out.push({ log: basename(file), turn: turn.turn, asked: turn.asked.slice(0, 80), screen: size.name, made });
        if (made === null) continue;
        const byRule = new Map<string, number>();
        for (const found of made.violations) byRule.set(found.rule, (byRule.get(found.rule) ?? 0) + 1);
        process.stdout.write(`${turn.turn} ${size.name} ${JSON.stringify(turn.asked.slice(0, 50))} ${made.duration.toFixed(1)} s, ${made.leaves} leaves at rest of ${made.expected} held: ${made.violations.length === 0 ? 'clean' : [...byRule].map(([rule, count]) => `${rule} x${count}`).join(', ')}\n`);
        for (const found of made.violations) process.stdout.write(`    ${found.severity.padEnd(8)} ${found.rule.padEnd(9)} ${found.at.kind}@${found.at.time.toFixed(1)}  ${found.detail}\n`);
        for (const note of made.notes) process.stdout.write(`    note: ${note}\n`);
      }
    }
  } finally {
    await page.close();
  }
  if (json !== null) {
    await mkdir(dirname(resolve(json)), { recursive: true });
    await writeFile(resolve(json), JSON.stringify(out, null, 1));
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`census-replay: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
