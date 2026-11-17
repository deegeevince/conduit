// pnpm capture: a logged turn, seen as motion.
//
//   pnpm capture <log> <turn> [--screen 1280x720|1920x825|390x844] [--look <id>] [--out <dir>] [--fps 15] [--no-video] [--shade] [--lens]
//   --lens                                      performs it as the page does with ?lens=1: an answer that would be squeezed grows a page taller than the screen, and the resting picture is of the whole page
//   --shade                                     performs it as the page does with ?shade=1 (light, rim and contact shadow on what the brain drew)
//   --svg                                       also writes the resting picture as the app exports it (<stem>.rest.svg) and that file drawn as a picture (<stem>.rest.svg.png)
//   --plain                                     also draws the resting picture with the plain (no WebGL) renderer's own svg layers (<stem>.rest.plain.png); its text is not drawn
//   pnpm capture --all <log> [same flags]       every turn of the log that drew something
//
// Replays the turn's logged lines at their logged arrival times (the playhead each arrived at, as the painter was told it), from the
// stage the previous turn left (its logged report), through the app's own timeline, renderer and exporter, in a headless Chrome. It
// writes beside the log (or into --out):
//   <log>-<turn>[-<look>][-<w>x<h>].strip.png   twelve frames in a grid, the last at rest, each labelled with its time
//   <log>-<turn>[...].rest.png                   the resting picture at full size, as the brain is shown it
//   <log>-<turn>[...].webm                       the whole turn as a film, from the app's own exporter
// and prints what it did. It never writes to a log. Nothing here is part of the server: the browser, and the web server it starts
// when it is not given one (--web http://127.0.0.1:4729), are stopped on exit.
//
// The page half is a script this file hands to the page. The page already serves the app's modules over the dev server, so the script
// imports them (the same instances the app uses) rather than carrying a copy of any of it.

import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { StageBase } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { resolveDataDir, withDataFlag } from '../data-dir';
import { processEnvironment, resolveLogDir } from '../env';
import type { SessionRecord } from '../domain/session-log';

const WEB_PORT = Number(process.env.CAPTURE_WEB_PORT ?? 4729);
const CHROME_PORT = Number(process.env.CAPTURE_CHROME_PORT ?? 4761);
const STRIP_FRAMES = 12;
const SCREENS: Readonly<Record<string, { width: number; height: number }>> = { '1280x720': { width: 1280, height: 720 }, '390x844': { width: 390, height: 844 }, '1920x825': { width: 1920, height: 825 } };
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function usage(message: string): never {
  process.stderr.write(`capture: ${message}\n`);
  process.stderr.write('usage: pnpm capture <log> <turn> [--screen 1280x720|1920x825|390x844] [--look <id>] [--out <dir>] [--fps n] [--no-video] [--shade] [--svg] [--plain] [--web <url>] [--data <dir>]\n  <log> is a path, or the log file name or session id as found in the data folder\n       pnpm capture --all <log> [flags]\n');
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

async function openPage(web: string | null, query = ''): Promise<{ page: Page; web: string }> {
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
        await waitFor('the web dev server', 240_000, async () => ((await fetch(`${url}/explore.html`)).ok ? true : null));
      }
    }
    const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
    if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
    const profile = await mkdtemp(join(tmpdir(), 'conduit-capture-'));
    cleanups.push(() => rm(profile, { recursive: true, force: true }));
    started.push(
      spawnTracked(chrome, ['--headless=new', '--mute-audio', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], undefined, { quiet: true }),
    );
    const endpoint = await waitFor('Chrome', 90_000, async () => {
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
    await browser.send('Page.navigate', { url: `${url}/explore.html${query}` }, sessionId);
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

// ---------------------------------------------------------------------------------------------------------------------------------
// The page's half

/** What the page is told. Everything crosses as JSON. */
interface Job {
  readonly language: string;
  readonly turn: string;
  readonly asked: string;
  readonly opened: string;
  readonly base: StageBase | null;
  readonly lines: readonly { readonly seq: number; readonly text: string; readonly floor: number }[];
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly look: string | null;
  readonly shade: boolean;
  /** `?lens=1`: grow mode */
  readonly lens: boolean;
  /** also return the resting picture as an exported svg, and that svg drawn */
  readonly svg: boolean;
  /** also return the resting picture drawn by the plain renderer's svg layers */
  readonly plain: boolean;
  readonly frames: number;
  readonly fps: number;
  readonly video: boolean;
  /** a film longer than this (seconds) is made of its first part only */
  readonly maxSeconds: number;
  /** also return the plan and every element's box at each strip time and at rest */
  readonly debug: boolean;
  /** `--trace from,to,step`: the boxes of what is drawn (not words) at these times, into the debug file */
  readonly trace: readonly number[] | null;
  /** `--spots`: for each `say … at=x,y in=<pic>` line, how far from that spot (percent of the photo's width) its leader ends at rest */
  readonly spots: boolean;
  /** the user's photos this turn draws, by upload id: a data address, so the harness shows the photo where the app would */
  readonly photos: Readonly<Record<string, string>>;
}

/**
 * The photos a turn puts on stage (`pic … from=u1`, and any the stage it began from still shows), read from the data folder's uploads
 * (`<DATA_DIR>/uploads/<run>-<session>/u1.jpg`; the folder whose name ends with the log's session id first). A photo that is not there is left out.
 */
function photosOf(options: Options, turn: LoggedTurn, base: StageBase | null): Record<string, string> {
  const wanted = new Set<string>();
  for (const line of turn.lines) {
    const found = /\bfrom=(u\d+)\b/.exec(line.text);
    if (line.text.startsWith('pic') && found?.[1] !== undefined) wanted.add(found[1]);
  }
  for (const element of base?.elements ?? []) if (element.figure?.kind === 'picture' && typeof element.figure.from === 'string') wanted.add(element.figure.from);
  if (wanted.size === 0) return {};
  const root = join(options.data === null ? resolveDataDir(processEnvironment()) : resolve(options.data), 'uploads');
  if (!existsSync(root)) return {};
  const session = basename(options.log, '.jsonl');
  const folders = readdirSync(root).sort((a, b) => Number(session.endsWith(b.replace(/^.*-/, ''))) < Number(session.endsWith(a.replace(/^.*-/, ''))) ? 1 : -1);
  const out: Record<string, string> = {};
  for (const id of wanted) {
    for (const folder of folders) {
      const kind = ['jpg', 'png'].find((extension) => existsSync(join(root, folder, `${id}.${extension}`)));
      if (kind !== undefined) {
        out[id] = `data:image/${kind === 'jpg' ? 'jpeg' : 'png'};base64,${readFileSync(join(root, folder, `${id}.${kind}`)).toString('base64')}`;
        break;
      }
    }
  }
  return out;
}

interface Made {
  readonly duration: number;
  readonly times: readonly number[];
  readonly strip: string;
  readonly rest: string;
  readonly svgText: string | null;
  readonly svgPng: string | null;
  readonly plainPng: string | null;
  readonly webm: string | null;
  readonly videoNote: string | null;
  readonly notes: readonly string[];
  readonly rejected: number;
  readonly debug: unknown;
  readonly spots: readonly { readonly id: string; readonly words: string; readonly error: number | null }[];
}

/** Source of an async function of a Job, run in the page. Plain JavaScript: the page has no TypeScript. */
const PAGE_SCRIPT = String.raw`async (job) => {
  const L = await import(job.language);
  const [{ buildTimeline, settledEnd }, { wholePage, stillSide }, { pinnedWallTime }, { REST_POSE }, { CHARTS_READY, createChartEngine }, { createHarnessChartHost }, { loadChartFonts }, { createExporter }, { createPlainRenderer }, { canUseThree, createThreeRenderer }] = await Promise.all([
    import('/src/painter/timeline.ts'), import('/src/painter/view.ts'), import('/src/painter/clock.ts'), import('/src/contracts/space.ts'), import('/src/render/chart/index.ts'),
    import('/src/explore/chart-host.ts'), import('/src/app/chart-host.ts'), import('/src/export/index.ts'), import('/src/render/plain/index.ts'), import('/src/render/three/index.ts'),
  ]);
  const notes = [];
  // --shade loads the harness page with ?shade=1, the way the bake-off does: the painter reads the switch from the address
  const base = job.base === null ? L.EMPTY_STAGE : job.base;
  const viewport = job.viewport;

  // The score, as the painter heard it: each line pushed at the playhead it arrived at; each part's arrival noted for its layout epochs.
  // the user's photos: how wide each is for how tall, and the address the renderer draws it from
  const shapes = {};
  for (const [id, url] of Object.entries(job.photos)) {
    const image = new Image();
    image.src = url;
    await image.decode();
    shapes[id] = image.naturalWidth / image.naturalHeight;
  }
  const normalizer = new L.LineNormalizer(() => 'cx' + (++counter), [], { photos: shapes });
  let counter = 0;
  const score = new L.TurnScore(base, job.opened);
  const arrivals = new Map();
  let rejected = 0;
  for (const entry of job.lines) {
    const parsed = L.parseLine(entry.text);
    if (parsed.kind !== 'line') { rejected += 1; notes.push('line ' + entry.seq + ' does not read back: ' + entry.text.slice(0, 80)); continue; }
    const normalized = normalizer.normalize(parsed.line);
    if (normalized.line === null) { rejected += 1; continue; }
    const pushed = score.push(normalized.line, entry.seq, entry.floor);
    for (const element of pushed.schedule.elements) {
      if (element.kind !== 'structure' && element.kind !== 'node' && element.kind !== 'link') continue;
      if (!element.carried && !arrivals.has(element.key)) arrivals.set(element.key, entry.floor);
      if (element.figure && element.figure.kind === 'structure') element.figure.rows.forEach((_, i) => arrivals.has(element.key + '#r' + i) || arrivals.set(element.key + '#r' + i, entry.floor));
    }
  }
  const schedule = score.schedule;
  const lockLook = job.look;
  const paintings = new Map();
  for (const element of schedule.elements) {
    const from = element.figure && element.figure.kind === 'picture' ? element.figure.from : null;
    if (from && job.photos[from]) paintings.set(element.key, { status: 'ready', url: job.photos[from], since: 0, aspect: shapes[from] });
  }
  const context = (arrivalMap) => ({ viewport, reducedMotion: false, lockLook, paintings,  arrivals: arrivalMap, charts: { kinds: CHARTS_READY, data: new Map() }, ...(job.lens ? { grow: true } : {}) });
  const timeline = buildTimeline(schedule, base, context(arrivals));
  const duration = settledEnd(timeline, null, base.scene.mood);
  const frameAt = (seconds) => { const time = Math.max(0, seconds); return timeline.frameAt({ time, ambient: time, wallTime: pinnedWallTime(time), clock: 'paused' }); };
  const film = { duration, viewport, frameAt, script: () => job.lines.map((l) => l.text).join('\n') };

  // The resting stage as the painter pictures it for the brain: the settled stage alone on a fresh schedule, camera at rest, ambient 3 s.
  const stage = L.settle(schedule, base, duration + 1e-6);
  const restTimeline = buildTimeline(new L.TurnScore(stage).schedule, stage, context(new Map()));
  const restFrame = { ...restTimeline.frameAt({ time: 0, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' }), camera: REST_POSE };

  // --spots: where each leader of a callout written at a spot of a photo ends, against that spot read off the photo's own frame (box and transform)
  const spots = [];
  if (job.spots) {
    const pictures = restFrame.figures.filter((f) => f.kind === 'picture');
    for (const entry of job.lines) {
      const m = /^say (\S+)[^|]*\bat=(-?[\d.]+),(-?[\d.]+)[^|]*\bin=(\S+)[^|]*\|\s*(.*)$/.exec(entry.text);
      if (!m) continue;
      const picture = pictures.find((f) => f.id === m[4]);
      const leader = restFrame.figures.find((f) => f.key.endsWith('/leader') && f.id === m[1]);
      const mine = { id: m[1], words: m[5], error: null };
      if (picture && leader) {
        const t = picture.transform;
        const px = picture.box.x + (Number(m[2]) / 100) * picture.box.width;
        const py = picture.box.y + (Number(m[3]) / 100) * picture.box.height;
        const want = { x: t.a * px + t.c * py + t.e, y: t.b * px + t.d * py + t.f };
        const points = leader.outline[0].points;
        const ends = [points[0], points[points.length - 1]];
        const wide = Math.abs(t.a) * picture.box.width;
        mine.error = Math.min(...ends.map((q) => Math.hypot(q.x - want.x, q.y - want.y))) / wide * 100;
      }
      spots.push(mine);
    }
  }
  const makeRenderer = () => (canUseThree() ? createThreeRenderer() : createPlainRenderer());
  const hold = document.createElement('div');
  hold.style.cssText = 'position:fixed;left:-30000px;top:0;width:' + viewport.width + 'px;height:' + viewport.height + 'px;overflow:hidden;';
  document.body.append(hold);
  const engine = createChartEngine();
  const charts = engine === null ? null : createHarnessChartHost(engine, hold);
  await loadChartFonts();
  const frameCharts = async (frame) => {
    if (charts === null) return undefined;
    charts.sync(frame.charts || [], 1);
    if ((frame.charts || []).length > 0) await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    return (key) => charts.still(key);
  };

  const instantAt = (seconds) => ({ time: seconds, ambient: seconds, wallTime: pinnedWallTime(seconds), clock: 'paused' });
  const viewsOf = (tl, seconds) => tl.viewsAt(instantAt(seconds)).filter((v) => v.opacity > 0.02).map((v) => ({ key: v.key, id: v.id, kind: v.kind, text: v.text.slice(0, 40), box: [v.box.x, v.box.y, v.box.width, v.box.height].map((n) => Math.round(n)), px: Math.round(v.fontPx) }));
  let debug = null;
  if (job.debug && job.trace === null) {

    debug = { viewport, rest: { plan: restTimeline.planAt(0), views: viewsOf(restTimeline, 0), notes: [...restTimeline.layoutNotesAt(0)].map(([k, n]) => k + ': ' + n.join(',')) }, at: [] };
    for (let i = 0; i <= 12; i += 1) { const t = (duration * i) / 12; debug.at.push({ t: +t.toFixed(2), plan: timeline.planAt(t), views: viewsOf(timeline, t) }); }
  }
  if (job.trace !== null) {
    const [from, to, step] = job.trace;
    debug = debug || { viewport, at: [] };
    debug.trace = [];
    for (let t = from; t <= to + 1e-9; t += step) debug.trace.push({ t: +t.toFixed(2), views: viewsOf(timeline, t).filter((v) => v.kind !== 'text') });
  }
  const times = [];
  for (let i = 0; i < job.frames - 1; i += 1) times.push((duration * i) / (job.frames - 1));
  const renderer = makeRenderer();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + viewport.width + 'px;height:' + viewport.height + 'px;overflow:hidden;';
  document.body.append(host);
  await renderer.mount(host, viewport, frameAt(0).look);
  if (!renderer.capabilities.capture) throw new Error('this renderer cannot capture pictures here');
  renderer.reset();
  const picture = async (frame, maxSide) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let incomplete = false;
      const chartStill = await frameCharts(frame);
      const blob = await renderer.rasterise(frame, { maxSide, mime: 'image/png', onIncomplete: () => { incomplete = true; }, ...(chartStill === undefined ? {} : { chartStill }) });
      if (blob === null) throw new Error('the renderer returned no picture');
      if (!incomplete || attempt === 2) { if (incomplete) notes.push('a picture was taken before all its text could be drawn'); return blob; }
    }
    throw new Error('unreachable');
  };
  const frames = [];
  for (const time of times) frames.push(await picture(frameAt(time), 1280));
  frames.push(await picture(restFrame, 1280));
  const restBlob = await picture(wholePage(restFrame), stillSide(restFrame, 1600));

  // The contact strip: a grid of the frames, each with its time.
  const portrait = viewport.height > viewport.width;
  const columns = portrait ? 6 : 4;
  const cellWidth = portrait ? 260 : 560;
  const cellHeight = Math.round((cellWidth * viewport.height) / viewport.width);
  const label = 22;
  const gap = 6;
  const rows = Math.ceil(frames.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * cellWidth + (columns + 1) * gap;
  canvas.height = rows * (cellHeight + label) + (rows + 1) * gap + 28;
  const g = canvas.getContext('2d');
  g.fillStyle = '#16181d'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = '14px ui-monospace, Menlo, monospace'; g.fillStyle = '#d8dbe2'; g.textBaseline = 'middle';
  const heading = job.turn + '  ' + job.asked.replace(/\s+/g, ' ').slice(0, 110) + '  [' + viewport.width + 'x' + viewport.height + (job.look === null ? '' : ', look ' + job.look) + ', ' + duration.toFixed(1) + ' s]';
  g.fillText(heading, gap, 14);
  for (let i = 0; i < frames.length; i += 1) {
    const x = gap + (i % columns) * (cellWidth + gap);
    const y = 28 + gap + Math.floor(i / columns) * (cellHeight + label + gap);
    const bitmap = await createImageBitmap(frames[i]);
    g.drawImage(bitmap, x, y + label, cellWidth, cellHeight);
    bitmap.close();
    g.fillStyle = i === frames.length - 1 ? '#ffd166' : '#d8dbe2';
    g.fillText(i === frames.length - 1 ? 'at rest' : (times[i]).toFixed(1) + ' s', x + 2, y + label / 2);
  }
  const base64Of = (blob) => new Promise((done, fail) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(',')[1] || ''); r.onerror = () => fail(new Error('read failed')); r.readAsDataURL(blob); });
  const strip = await base64Of(await new Promise((done) => canvas.toBlob(done, 'image/png')));
  const rest = await base64Of(restBlob);
  renderer.dispose();
  host.remove();

  // The same resting frame as the app's exporter draws it (svg), and as the plain renderer's own svg layers draw it.
  const drawn = async (markup) => {
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    await image.decode();
    return image;
  };
  const picturePng = async (layers) => {
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const g = canvas.getContext('2d');
    g.fillStyle = restFrame.spec ? restFrame.spec.roles.ground : '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    for (const layer of layers) g.drawImage(layer, 0, 0, canvas.width, canvas.height);
    return base64Of(await new Promise((done) => canvas.toBlob(done, 'image/png')));
  };
  let svgText = null;
  let svgPng = null;
  if (job.svg) {
    const { frameToSvg } = await import('/src/export/svg.ts');
    svgText = await frameToSvg(restFrame, { width: viewport.width, height: viewport.height });
    svgPng = await picturePng([await drawn(svgText)]);
  }
  let plainPng = null;
  if (job.plain) {
    const plain = createPlainRenderer();
    const plainHost = document.createElement('div');
    plainHost.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + viewport.width + 'px;height:' + viewport.height + 'px;overflow:hidden;';
    document.body.append(plainHost);
    await plain.mount(plainHost, viewport, restFrame.look);
    plain.render(restFrame);
    const layers = [];
    for (const svg of plainHost.querySelectorAll('svg')) {
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('viewBox', '0 0 ' + viewport.width + ' ' + viewport.height);
      layers.push(await drawn(new XMLSerializer().serializeToString(svg)));
    }
    plainPng = await picturePng(layers);
    plain.dispose();
    plainHost.remove();
  }

  // The film, from the app's own exporter, at the viewport's own size.
  let webm = null;
  let videoNote = null;
  if (job.video) {
    const exporter = createExporter({ createRenderer: makeRenderer, chartStill: (frame, key) => { const chart = (frame.charts || []).find((c) => c.key === key); return chart === undefined || charts === null ? null : charts.stillOf(chart); } });
    try {
      const formats = await exporter.formats();
      if (!formats.video.includes('webm')) videoNote = 'this browser cannot encode WebM';
      else {
        const to = Math.min(duration, job.maxSeconds);
        if (to < duration) notes.push('the film stops at ' + job.maxSeconds + ' s of ' + duration.toFixed(1));
        const job2 = exporter.start(film, { kind: 'video', format: 'webm', width: viewport.width, height: viewport.height, fps: job.fps, from: 0, to });
        const out = await job2.done;
        webm = await base64Of(out.blob);
      }
    } catch (error) {
      videoNote = 'the film could not be made: ' + (error && error.message ? error.message : String(error));
    } finally {
      exporter.dispose();
    }
  }
  charts && charts.dispose();
  hold.remove();
  // What the stage itself measures about this turn at rest (the same notes the brain is told): printed with the other notes, one line for each thing that did not land
  try {
    const { sightOf } = await import('/src/painter/sight.ts');
    const sight = sightOf(timeline, schedule, base, duration, false);
    for (const item of sight.items) if (item.notes.length > 0) notes.push('measure: ' + item.id + ' (' + item.kind + ') ' + item.notes.join(', '));
  } catch (error) { notes.push('measure failed: ' + String((error && error.message) || error)); }
  return { duration, times, strip, rest, svgText, svgPng, plainPng, webm, videoNote, notes, rejected, debug, spots };
}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// The command

interface Options {
  readonly data: string | null;
  readonly all: boolean;
  readonly log: string;
  readonly turn: string | null;
  readonly screen: { readonly width: number; readonly height: number };
  readonly screenName: string;
  readonly look: string | null;
  readonly shade: boolean;
  readonly lens: boolean;
  readonly svg: boolean;
  readonly plain: boolean;
  readonly out: string | null;
  readonly fps: number;
  readonly video: boolean;
  readonly web: string | null;
  readonly debug: boolean;
  readonly trace: number[] | null;
  readonly spots: boolean;
}

/** A log named by its path, or by its file name or session id, which is looked for in the data folder's logs (`--data <dir>`, `DATA_DIR`, else the default). */
function locate(log: string, data: string | null): string {
  if (existsSync(log) || log.includes('/')) return resolve(log);
  const dir = resolveLogDir(withDataFlag(data === null ? [] : ['--data', data], processEnvironment()));
  if (dir === null || !existsSync(dir)) return resolve(log);
  const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().reverse();
  const found = names.find((name) => name === log || name === `${log}.jsonl` || name.endsWith(`-${log}.jsonl`) || name.startsWith(log));
  return found === undefined ? resolve(log) : join(dir, found);
}

function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  let all = false;
  let screenName = '1280x720';
  let look: string | null = null;
  let shade = false;
  let lens = false;
  let svg = false;
  let plain = false;
  let out: string | null = null;
  let fps = 15;
  let video = true;
  let web: string | null = null;
  let data: string | null = null;
  let debug = false;
  let trace: number[] | null = null;
  let spots = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const value = (): string => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === '--all') all = true;
    else if (arg === '--screen') screenName = value();
    else if (arg === '--look') look = value();
    else if (arg === '--out') out = value();
    else if (arg === '--fps') fps = Math.max(1, Math.min(60, Number(value()) || 15));
    else if (arg === '--web') web = value();
    else if (arg === '--data') data = value();
    else if (arg === '--no-video') video = false;
    else if (arg === '--shade') shade = true;
    else if (arg === '--lens') lens = true;
    else if (arg === '--svg') svg = true;
    else if (arg === '--plain') plain = true;
    else if (arg === '--debug') debug = true;
    else if (arg === '--spots') spots = true;
    else if (arg === '--trace') trace = value().split(',').map(Number);
    else if (arg.startsWith('--')) usage(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  // the named screens, or any WxH (the stage under the prompt bar is shorter than the window: 1280x619, 390x743)
  const sized = /^(\d{3,4})x(\d{3,4})$/.exec(screenName);
  const screen = SCREENS[screenName] ?? (sized === null ? undefined : { width: Number(sized[1]), height: Number(sized[2]) });
  if (screen === undefined) usage(`--screen is WxH, like ${Object.keys(SCREENS).join(', ')}`);
  const log = positional[0];
  if (log === undefined) usage('which log?');
  if (!all && positional[1] === undefined) usage('which turn? (or --all)');
  return { data, all, log: locate(log, data), turn: all ? null : (positional[1] ?? null), screen, screenName, look, shade, lens, svg, plain, out, fps, video, web, debug, trace, spots };
}

interface Captured {
  readonly turn: string;
  readonly strip: string;
  readonly rest: string;
  readonly webm: string | null;
  readonly duration: number;
}

async function captureOne(page: Page, options: Options, turns: readonly LoggedTurn[], index: number, dir: string): Promise<Captured | null> {
  const turn = turns[index];
  if (turn === undefined) return null;
  if (turn.lines.length === 0) {
    process.stdout.write(`${turn.turn}: no lines were logged for it (a turn that drew nothing): skipped\n`);
    return null;
  }
  const job: Job = {
    language: `/@fs${repoRoot}/language/src/index.ts`,
    turn: turn.turn,
    asked: turn.asked,
    opened: turn.opened,
    base: baseOf(turns, index),
    lines: turn.lines,
    viewport: { ...options.screen, dpr: 1 },
    look: options.look,
    shade: options.shade,
    lens: options.lens,
    svg: options.svg,
    plain: options.plain,
    frames: STRIP_FRAMES,
    fps: options.fps,
    video: options.video,
    maxSeconds: 90,
    debug: options.debug,
    trace: options.trace,
    spots: options.spots,
    photos: photosOf(options, turn, baseOf(turns, index)),
  };
  const made = await page.evaluate<Made>(`(${PAGE_SCRIPT})(${JSON.stringify(job)})`);
  const stem = join(dir, `${basename(options.log, '.jsonl')}-${turn.turn}${options.look === null ? '' : `-${options.look}`}${options.shade ? '-shade' : ''}${options.lens ? '-lens' : ''}${options.screenName === '1280x720' ? '' : `-${options.screenName}`}`);
  await mkdir(dirname(stem), { recursive: true });
  const strip = `${stem}.strip.png`;
  const rest = `${stem}.rest.png`;
  if (made.debug !== null) await writeFile(`${stem}.debug.json`, JSON.stringify(made.debug, null, 1));
  await writeFile(strip, Buffer.from(made.strip, 'base64'));
  await writeFile(rest, Buffer.from(made.rest, 'base64'));
  const extras: string[] = [];
  if (made.svgText !== null) {
    await writeFile(`${stem}.rest.svg`, made.svgText);
    extras.push(`${stem}.rest.svg`);
  }
  if (made.svgPng !== null) {
    await writeFile(`${stem}.rest.svg.png`, Buffer.from(made.svgPng, 'base64'));
    extras.push(`${stem}.rest.svg.png`);
  }
  if (made.plainPng !== null) {
    await writeFile(`${stem}.rest.plain.png`, Buffer.from(made.plainPng, 'base64'));
    extras.push(`${stem}.rest.plain.png`);
  }
  let webm: string | null = null;
  if (made.webm !== null) {
    webm = `${stem}.webm`;
    await writeFile(webm, Buffer.from(made.webm, 'base64'));
  }
  process.stdout.write(`${turn.turn}: ${JSON.stringify(turn.asked.slice(0, 70))}  ${made.duration.toFixed(1)} s, ${turn.lines.length} lines${made.rejected > 0 ? `, ${made.rejected} would not read back` : ''}${baseOf(turns, index) === null ? '' : ', from the stage the log left'}\n  strip ${strip}\n  rest  ${rest}\n  film  ${webm ?? `none${made.videoNote === null ? ' (--no-video)' : ` (${made.videoNote})`}`}\n`);
  for (const extra of extras) process.stdout.write(`  extra ${extra}\n`);
  for (const note of made.notes) process.stdout.write(`  note: ${note}\n`);
  for (const spot of made.spots) process.stdout.write(`  spot ${spot.id} ${JSON.stringify(spot.words)}: ${spot.error === null ? 'no leader' : `leader ends ${spot.error.toFixed(2)}% of the photo's width from its spot`}\n`);
  if (made.spots.some((spot) => spot.error === null || spot.error > 1)) process.exitCode = 1;
  return { turn: turn.turn, strip, rest, webm, duration: made.duration };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.log)) usage(`no such log: ${options.log}`);
  const turns = await readLog(options.log);
  const dir = options.out === null ? dirname(options.log) : resolve(options.out);
  const wanted = options.all ? turns.map((_, index) => index) : [turns.findIndex((turn) => turn.turn === options.turn)];
  if (wanted.some((index) => index < 0)) usage(`the log has no turn ${options.turn ?? ''}: it has ${turns.map((turn) => turn.turn).join(', ')}`);
  const { page } = await openPage(options.web, options.shade ? '?shade=1' : '');
  try {
    for (const index of wanted) await captureOne(page, options, turns, index, dir);
  } finally {
    await page.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
