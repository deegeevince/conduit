// pnpm record --url <server> --journey car --out <dir> [--size 1920x1080] [--scale 2] [--fps 60] [--timeout 1200]
//
// Films a journey (web/src/app/journey.ts) on a running server: Chrome at 1920x1080 plays `/?journey=<name>` and its screen is captured with the
// DevTools screencast, supersampled (the page is rendered at `--scale` and handed down to the size), every frame kept with its own timestamp.
// Out come, in <dir>:
//
//   <name>.mp4      H.264, a constant 60 fps, built from the timestamped frames with the system ffmpeg (the timeline is the page's real time)
//   journey.json    window.__journey: each step's timings (page clock + performance.now()), the model as the brain reported it, and `video`: the
//                   epoch time of the first frame (`firstFrameAt`) so any stamp's film time is (at - firstFrameAt) / 1000
//   focus.json      [{t, id, element:{x,y,w,h}|null, row:{x,y,w,h}|null}]: what is being performed, in pixels of the film, t in seconds from its first frame
//   frames.json     the frame pacing: frames received each second, the longest gaps
//
// It is not part of `pnpm check`: it needs a real server and (for the real thing) a real brain. Everything it starts is stopped on the way out.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { spawnTracked } from '../brains/claude-cli/process';
import { claimPort, releasePort } from './check-ports';
import { CHROME_CANDIDATES, Cdp, chromeFlags, sleep, stop, waitFor } from './explore-browser';
import type { FocusSample, JourneyState } from '../../../web/src/app/journey-script';

const FFMPEG = process.env['FFMPEG_BIN'] ?? '/opt/homebrew/bin/ffmpeg';

interface Args {
  readonly url: string;
  readonly journey: string;
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly fps: number;
  readonly timeoutMs: number;
}

function usage(message: string): never {
  process.stderr.write(`record: ${message}\nusage: pnpm record --url <server> --journey car --out <dir> [--size 1920x1080] [--scale 2] [--fps 60] [--timeout <seconds>]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') continue;
    if (!arg.startsWith('--')) usage(`unexpected ${arg}`);
    const name = arg.slice(2);
    if (!['url', 'journey', 'out', 'size', 'scale', 'fps', 'timeout'].includes(name)) usage(`unknown flag ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) usage(`--${name} needs a value`);
    flags.set(name, value);
    i += 1;
  }
  const url = flags.get('url');
  const journey = flags.get('journey');
  const out = flags.get('out');
  if (url === undefined || journey === undefined || out === undefined) usage('--url, --journey and --out are needed');
  const size = /^(\d{3,5})x(\d{3,5})$/.exec(flags.get('size') ?? '1920x1080');
  if (size === null) usage('--size is like 1920x1080');
  if (!/^[\w-]{1,40}$/.test(journey)) usage('--journey is a name like car');
  return {
    url: url.replace(/\/+$/, ''),
    journey,
    out: resolve(out),
    width: Number(size[1]),
    height: Number(size[2]),
    scale: Number(flags.get('scale') ?? 2),
    fps: Number(flags.get('fps') ?? 60),
    timeoutMs: Number(flags.get('timeout') ?? 1200) * 1000,
  };
}

interface Frame {
  readonly t: number;
  readonly file: string;
}

function run(bin: string, args: readonly string[]): Promise<{ code: number; text: string }> {
  return new Promise((done) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => (text = (text + chunk.toString()).slice(-6000)));
    child.on('close', (code) => done({ code: code ?? 1, text }));
    child.on('error', (error) => done({ code: 1, text: String(error) }));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(FFMPEG)) throw new Error(`no ffmpeg at ${FFMPEG} (set FFMPEG_BIN)`);
  const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
  await mkdir(args.out, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'conduit-record-'));
  const frames: Frame[] = [];
  const port = await claimPort('the recorder\'s Chrome', true);
  let child: ChildProcess | null = null;
  let browser: Cdp | null = null;
  try {
    child = spawnTracked(
      chrome,
      [...chromeFlags(), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${args.width},${args.height}`, `--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, 'profile')}`, 'about:blank'],
      undefined,
      { quiet: true },
    );
    const endpoint = await waitFor('Chrome', 20_000, async () => {
      if (port !== 0) return ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? null;
      const text = await readFile(join(scratch, 'profile', 'DevToolsActivePort'), 'utf8');
      const [chosen, path] = text.split('\n');
      return chosen !== undefined && path !== undefined ? `ws://127.0.0.1:${chosen}${path}` : null;
    });
    browser = await Cdp.open(endpoint);
    const cdp = browser;
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => cdp.send<T>(method, params, sessionId);
    const evaluate = async <T>(expression: string): Promise<T> => {
      const out = await send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
      return out.result.value as T;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: args.width, height: args.height, deviceScaleFactor: args.scale, mobile: false });
    const consoleErrors: string[] = [];

    const frameDir = join(scratch, 'frames');
    await mkdir(frameDir, { recursive: true });
    const writes: Promise<void>[] = [];
    cdp.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Runtime.consoleAPICalled' && event.params['type'] === 'error') consoleErrors.push(JSON.stringify(event.params['args']).slice(0, 300));
      if (event.method !== 'Page.screencastFrame') return;
      const p = event.params as { data: string; sessionId: number; metadata: { timestamp?: number } };
      // acknowledged at once: the browser sends the next frame only when it is
      void send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
      const t = p.metadata.timestamp ?? Date.now() / 1000;
      const file = join(frameDir, `${String(frames.length + 1).padStart(6, '0')}.jpg`);
      frames.push({ t, file });
      writes.push(writeFile(file, Buffer.from(p.data, 'base64')));
    });

    await send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: args.width, maxHeight: args.height, everyNthFrame: 1 });
    process.stdout.write(`recording ${args.url}/?journey=${args.journey} at ${args.width}x${args.height} (rendered at ${args.scale}x)\n`);
    await send('Page.navigate', { url: `${args.url}/?journey=${args.journey}` });

    const began = Date.now();
    let last = '';
    for (;;) {
      await sleep(500);
      const status = await evaluate<string | null>('window.__journey ? window.__journey.status : null').catch(() => null);
      if (status !== null && status !== last) process.stdout.write(`  journey ${status} (${((Date.now() - began) / 1000).toFixed(0)} s)\n`);
      if (status !== null) last = status;
      if (status === 'done' || status === 'stopped') break;
      if (Date.now() - began > args.timeoutMs) throw new Error(`the journey did not finish within ${args.timeoutMs / 1000} s`);
    }
    // a moment of the finished stage, then stop
    await sleep(2000);
    const regions = await evaluate<Record<string, { x: number; y: number; w: number; h: number } | null>>(`(() => { const box = (el) => { if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }; const stage = document.getElementById('stage'); const panel = document.querySelector('.lang'); return { panel: box(panel), stage: box(stage), input: box(document.querySelector('.prompt')), modelLabel: box(document.querySelector('.model-label')), rowPitch: (() => { const rows = document.querySelectorAll('.lang__row'); return rows.length > 1 ? { x: 0, y: 0, w: 0, h: rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top } : null; })() }; })()`);
    const wordmark = await evaluate<boolean>('/conduit/i.test(document.body.innerText)');
    if (wordmark) process.stdout.write('  note: the word "Conduit" appears in the page text\n');
    const journey = await evaluate<JourneyState>('JSON.parse(JSON.stringify(window.__journey))');
    await send('Page.stopScreencast');
    await sleep(300);
    await Promise.all(writes);
    if (frames.length < 2) throw new Error(`the screencast delivered ${frames.length} frames`);

    // ---- the film: every frame shown from its own time to the next one's, resampled to a constant frame rate
    const first = (frames[0] as Frame).t;
    const lastFrame = frames[frames.length - 1] as Frame;
    const lines: string[] = ['ffconcat version 1.0'];
    frames.forEach((frame, index) => {
      const next = frames[index + 1];
      const seconds = next === undefined ? 0.5 : Math.max(0.001, next.t - frame.t);
      lines.push(`file '${frame.file}'`, `duration ${seconds.toFixed(6)}`);
    });
    lines.push(`file '${lastFrame.file}'`);
    const list = join(scratch, 'frames.txt');
    await writeFile(list, `${lines.join('\n')}\n`);
    const mp4 = join(args.out, `${args.journey}.mp4`);
    const made = await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${args.width}:${args.height}:flags=lanczos,fps=${args.fps},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-movflags', '+faststart', '-an', mp4]);
    if (made.code !== 0) throw new Error(`ffmpeg failed: ${made.text}`);

    // ---- what the page said, on the film's clock
    const { focus, ...rest } = journey;
    const track = focus.map((sample: FocusSample) => ({ t: Math.round(((sample.at / 1000 - first) * 1000)) / 1000, id: sample.id, kind: sample.kind, element: sample.element, row: sample.row }));
    await writeFile(join(args.out, 'focus.json'), JSON.stringify({ version: 1, clock: `seconds since the first frame of ${args.journey}.mp4`, viewport: { w: args.width, h: args.height, dpr: 1, renderScale: args.scale }, regions, samples: track }));
    // named steps, on the film's clock: `car.send`, `brakes.tap`, `stop.rest`, `dragSpeed.dragStart`...
    const secs = (stamp: { readonly at: number } | null): number | null => (stamp === null ? null : Math.round((stamp.at / 1000 - first) * 1000) / 1000);
    const events: Record<string, Record<string, number | null>> = {};
    journey.steps.forEach((step, index) => {
      if (step.name === null) return;
      const after = journey.steps.slice(index + 1).find((later) => later.op === 'rest');
      events[step.name] = {
        typeStart: secs(step.typingStart),
        typeEnd: secs(step.typingEnd),
        send: secs(step.sent ?? step.tapAt),
        tap: secs(step.tapAt),
        firstLine: secs(step.firstLine),
        turnEnded: secs(step.turnEnded),
        rest: secs(after?.rest ?? null),
        dragStart: secs(step.dragStart),
        dragEnd: secs(step.dragEnd),
        back: step.op === 'back' ? secs(step.tapAt) : null,
      };
    });
    await writeFile(join(args.out, 'journey.json'), JSON.stringify({ ...rest, events, regions, video: { file: `${args.journey}.mp4`, width: args.width, height: args.height, fps: args.fps, firstFrameAt: Math.round(first * 1000), durationSeconds: Math.round((lastFrame.t - first) * 1000) / 1000, framesReceived: frames.length } }, null, 1));

    // ---- the pacing
    const seconds = Math.ceil(lastFrame.t - first);
    const perSecond: number[] = Array.from({ length: seconds }, () => 0);
    for (const frame of frames) {
      const bucket = Math.min(seconds - 1, Math.floor(frame.t - first));
      perSecond[bucket] = (perSecond[bucket] ?? 0) + 1;
    }
    const gaps = frames.slice(1).map((frame, index) => ({ at: Math.round(((frames[index] as Frame).t - first) * 1000) / 1000, ms: Math.round((frame.t - (frames[index] as Frame).t) * 1000) }));
    const active = journey.started === null ? 0 : journey.started.at / 1000 - first;
    const activeEnd = journey.finished === null ? seconds : journey.finished.at / 1000 - first;
    const long = gaps.filter((gap) => gap.ms > 250).sort((a, b) => b.ms - a.ms);
    const moving = perSecond.slice(Math.max(0, Math.floor(active)), Math.max(1, Math.ceil(activeEnd)));
    await writeFile(join(args.out, 'frames.json'), JSON.stringify({ total: frames.length, seconds, perSecond, medianGapMs: [...gaps].map((gap) => gap.ms).sort((a, b) => a - b)[Math.floor(gaps.length / 2)], longestGaps: long.slice(0, 20), consoleErrors }, null, 1));
    const sorted = [...moving].sort((a, b) => a - b);
    process.stdout.write(
      [
        `${mp4}`,
        `  ${frames.length} frames over ${(lastFrame.t - first).toFixed(1)} s; while the journey ran: frames a second min ${sorted[0] ?? 0}, median ${sorted[Math.floor(sorted.length / 2)] ?? 0}, max ${sorted[sorted.length - 1] ?? 0}`,
        `  gaps over 250 ms: ${long.length}${long.length === 0 ? '' : ` (longest ${long[0]?.ms} ms at ${long[0]?.at} s)`}`,
        `  focus samples: ${track.length}; model: ${journey.model === null ? 'none reported' : `${journey.model.model} / ${journey.model.effort}`}; journey ${journey.status}${journey.message === null ? '' : `: ${journey.message}`}`,
        ...(consoleErrors.length === 0 ? [] : [`  console errors: ${consoleErrors.length}`]),
      ].join('\n') + '\n',
    );
    if (journey.status !== 'done') process.exitCode = 1;
  } finally {
    browser?.close();
    if (child !== null) await stop(child);
    releasePort(port);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`record: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
