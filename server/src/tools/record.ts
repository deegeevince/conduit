// pnpm record --url <server> --journey car --out <dir> [--size 1920x1080] [--css 1280x720] [--scale 1.5] [--legacy] [--fps 60] [--timeout 1200]
//
// Films a journey (web/src/app/journey.ts) on a running server: Chrome plays `/?journey=<name>` and its screen is captured with the DevTools screencast, every
// frame kept with its own timestamp. The film is `--size` (1920x1080). The page is laid out in `--css` CSS pixels and rendered at `--scale` device pixels to a CSS
// pixel (a render bigger than the film is handed down to it). For a 1920x1080 film the default is 1280x720 at 1.5: every word 1.5 times as big as the same page at
// 1920x1080 CSS pixels, which is what a person watching on a phone can read. `--legacy` is the old way: the page laid out at the film's own size and rendered at 2.
// Out come, in <dir>:
//
//   <name>.mp4      H.264, a constant 60 fps, built from the timestamped frames with the system ffmpeg (the timeline is the page's real time)
//   journey.json    window.__journey: each step's timings (page clock + performance.now()), the model as the brain reported it, and `video`: the
//                   epoch time of the first frame (`firstFrameAt`) so any stamp's film time is (at - firstFrameAt) / 1000. A step has `firstLine` (the first new line
//                   to PAINT: a panel row or a stage element) and `rest` (the last visible change); `firstLineEvent` (the line arriving in the page's log) and `restSettled`
//                   (when the page judged the stage settled) are what they were before the paint was timed. `events` names them by step, on the film's clock.
//   focus.json      [{t, id, element:{x,y,w,h}|null, row:{x,y,w,h}|null}]: what is being performed, in pixels of the film, t in seconds from its first frame
//   frames.json     the frame pacing: frames received each second, the longest gaps
//
// It is not part of `pnpm check`: it needs a real server and (for the real thing) a real brain. Everything it starts is stopped on the way out.

import { createHash } from 'node:crypto';
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
import { chooseView } from './record-view';
import type { RecordView } from './record-view';

const FFMPEG = process.env['FFMPEG_BIN'] ?? '/opt/homebrew/bin/ffmpeg';

interface Args extends RecordView {
  readonly url: string;
  readonly journey: string;
  readonly out: string;
  readonly fps: number;
  readonly timeoutMs: number;
}

function usage(message: string): never {
  process.stderr.write(`record: ${message}\nusage: pnpm record --url <server> --journey car --out <dir> [--size 1920x1080] [--css 1280x720] [--scale 1.5] [--legacy] [--fps 60] [--timeout <seconds>]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') continue;
    if (!arg.startsWith('--')) usage(`unexpected ${arg}`);
    const name = arg.slice(2);
    if (name === 'legacy') {
      flags.set(name, 'true');
      continue;
    }
    if (!['url', 'journey', 'out', 'size', 'css', 'scale', 'fps', 'timeout'].includes(name)) usage(`unknown flag ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) usage(`--${name} needs a value`);
    flags.set(name, value);
    i += 1;
  }
  const url = flags.get('url');
  const journey = flags.get('journey');
  const out = flags.get('out');
  if (url === undefined || journey === undefined || out === undefined) usage('--url, --journey and --out are needed');
  const view = chooseView({ ...(flags.has('size') ? { size: flags.get('size') as string } : {}), ...(flags.has('css') ? { css: flags.get('css') as string } : {}), ...(flags.has('scale') ? { scale: flags.get('scale') as string } : {}), legacy: flags.has('legacy') });
  if (typeof view === 'string') usage(view);
  if (!/^[\w-]{1,40}$/.test(journey)) usage('--journey is a name like car');
  return {
    url: url.replace(/\/+$/, ''),
    journey,
    out: resolve(out),
    ...view,
    fps: Number(flags.get('fps') ?? 60),
    timeoutMs: Number(flags.get('timeout') ?? 1200) * 1000,
  };
}

interface Frame {
  readonly t: number;
  readonly file: string;
  /** a hash of the picture: two frames with the same one are the same picture */
  readonly hash: string;
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
      [...chromeFlags(), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${args.cssWidth},${args.cssHeight}`, `--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, 'profile')}`, 'about:blank'],
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
    await send('Emulation.setDeviceMetricsOverride', { width: args.cssWidth, height: args.cssHeight, deviceScaleFactor: args.scale, mobile: false });
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
      frames.push({ t, file, hash: createHash('md5').update(p.data).digest('hex') });
      writes.push(writeFile(file, Buffer.from(p.data, 'base64')));
    });

    await send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: args.width, maxHeight: args.height, everyNthFrame: 1 });
    process.stdout.write(`recording ${args.url}/?journey=${args.journey} as ${args.width}x${args.height}, laid out in ${args.cssWidth}x${args.cssHeight} CSS pixels and rendered at ${args.scale}x\n`);
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
    const inPage = await evaluate<Record<string, { x: number; y: number; w: number; h: number } | null>>(`(() => { const box = (el) => { if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }; const stage = document.getElementById('stage'); const panel = document.querySelector('.lang'); return { panel: box(panel), stage: box(stage), input: box(document.querySelector('.prompt')), modelLabel: box(document.querySelector('.model-label')), rowPitch: (() => { const rows = document.querySelectorAll('.lang__row'); return rows.length > 1 ? { x: 0, y: 0, w: 0, h: rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top } : null; })() }; })()`);
    // the page measures in CSS pixels; the film is `zoom` times as many: everything handed on is in pixels of the film
    const film = (box: { x: number; y: number; w: number; h: number } | null): { x: number; y: number; w: number; h: number } | null =>
      box === null ? null : { x: Math.round(box.x * args.zoom * 10) / 10, y: Math.round(box.y * args.zoom * 10) / 10, w: Math.round(box.w * args.zoom * 10) / 10, h: Math.round(box.h * args.zoom * 10) / 10 };
    const regions = Object.fromEntries(Object.entries(inPage).map(([name, box]) => [name, film(box)]));
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
    const track = focus.map((sample: FocusSample) => ({ t: Math.round(((sample.at / 1000 - first) * 1000)) / 1000, id: sample.id, kind: sample.kind, element: film(sample.element), row: film(sample.row) }));
    await writeFile(join(args.out, 'focus.json'), JSON.stringify({ version: 1, clock: `seconds since the first frame of ${args.journey}.mp4`, viewport: { w: args.width, h: args.height, dpr: 1, renderScale: args.scale, css: { w: args.cssWidth, h: args.cssHeight }, zoom: args.zoom }, regions, samples: track }));
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
        firstLineEvent: secs(step.firstLineEvent),
        turnEnded: secs(step.turnEnded),
        rest: secs(after?.rest ?? null),
        restSettled: secs(after?.restSettled ?? null),
        dragStart: secs(step.dragStart),
        dragEnd: secs(step.dragEnd),
        back: step.op === 'back' ? secs(step.tapAt) : null,
      };
    });
    await writeFile(join(args.out, 'journey.json'), JSON.stringify({ ...rest, events, regions, video: { file: `${args.journey}.mp4`, width: args.width, height: args.height, css: { width: args.cssWidth, height: args.cssHeight }, zoom: args.zoom, renderScale: args.scale, fps: args.fps, firstFrameAt: Math.round(first * 1000), durationSeconds: Math.round((lastFrame.t - first) * 1000) / 1000, framesReceived: frames.length } }, null, 1));

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
    // distinct pictures: a frame the same as the one before is not a new picture. While a slider is dragged a person sees as many pictures a second as there are distinct frames.
    const distinct = frames.map((frame, index) => index === 0 || frame.hash !== (frames[index - 1] as Frame).hash);
    const distinctPerSecond: number[] = Array.from({ length: seconds }, () => 0);
    frames.forEach((frame, index) => {
      if (distinct[index] === true) distinctPerSecond[Math.min(seconds - 1, Math.floor(frame.t - first))] = (distinctPerSecond[Math.min(seconds - 1, Math.floor(frame.t - first))] ?? 0) + 1;
    });
    const drags = journey.steps.flatMap((step) => {
      if (step.dragStart === null || step.dragEnd === null) return [];
      const from = step.dragStart.at / 1000;
      const to = step.dragEnd.at / 1000;
      const inside = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => frame.t >= from && frame.t <= to);
      const pictures = inside.filter(({ index }) => distinct[index] === true);
      let run = 0;
      let longestRun = 0;
      for (const { index } of inside) {
        run = distinct[index] === true ? 1 : run + 1;
        longestRun = Math.max(longestRun, run);
      }
      let longestGap = 0;
      pictures.forEach(({ frame }, at) => {
        const before = at === 0 ? from : (pictures[at - 1] as { frame: Frame }).frame.t;
        longestGap = Math.max(longestGap, frame.t - before);
      });
      const span = Math.max(0.001, to - from);
      return [{ step: step.n, name: step.name, control: step.drag?.control ?? null, seconds: Math.round(span * 100) / 100, framesReceived: inside.length, framesPerSecond: Math.round((inside.length / span) * 10) / 10, distinctPictures: pictures.length, distinctPerSecond: Math.round((pictures.length / span) * 10) / 10, longestGapBetweenPicturesMs: Math.round(longestGap * 1000), longestRunOfSameFrame: longestRun, pacing: step.drag?.pacing ?? null }];
    });
    const long = gaps.filter((gap) => gap.ms > 250).sort((a, b) => b.ms - a.ms);
    const moving = perSecond.slice(Math.max(0, Math.floor(active)), Math.max(1, Math.ceil(activeEnd)));
    await writeFile(join(args.out, 'frames.json'), JSON.stringify({ total: frames.length, seconds, perSecond, medianGapMs: [...gaps].map((gap) => gap.ms).sort((a, b) => a - b)[Math.floor(gaps.length / 2)], longestGaps: long.slice(0, 20), distinctPerSecond, drags, consoleErrors }, null, 1));
    const sorted = [...moving].sort((a, b) => a - b);
    process.stdout.write(
      [
        `${mp4}`,
        `  ${frames.length} frames over ${(lastFrame.t - first).toFixed(1)} s; while the journey ran: frames a second min ${sorted[0] ?? 0}, median ${sorted[Math.floor(sorted.length / 2)] ?? 0}, max ${sorted[sorted.length - 1] ?? 0}`,
        `  gaps over 250 ms: ${long.length}${long.length === 0 ? '' : ` (longest ${long[0]?.ms} ms at ${long[0]?.at} s)`}`,
        `  focus samples: ${track.length}; model: ${journey.model === null ? 'none reported' : `${journey.model.model} / ${journey.model.effort}`}; journey ${journey.status}${journey.message === null ? '' : `: ${journey.message}`}`,
        ...drags.map((drag) => `  drag ${drag.control ?? ''} (step ${drag.step}, ${drag.seconds} s): ${drag.framesPerSecond} frames a second, ${drag.distinctPerSecond} distinct pictures a second, longest gap between pictures ${drag.longestGapBetweenPicturesMs} ms, longest run of the same frame ${drag.longestRunOfSameFrame}${drag.pacing === null ? '' : `; the page's own frames: mean ${drag.pacing.meanMs} ms, p95 ${drag.pacing.p95Ms} ms, longest ${drag.pacing.longestMs} ms, ${drag.pacing.slow} slower than 25 ms; the pointer's step changed by at most ${drag.pacing.jerkPx} px from one frame to the next`}`),
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
