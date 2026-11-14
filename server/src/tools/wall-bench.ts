// pnpm wall-bench: the wall of PLAN-wall, proved in a real browser (WL0). Two commands.
//
//   pnpm wall-bench serve [--port 4990] [--logs <dir of saved snapshots>] [--data <DATA_DIR>] [--web <built web dir>]
//     Serves web/bench-wall.html (build it first: pnpm build) and a wall for it: `source=real` is the *.jpg snapshots of a log directory
//     (read, never written; thumbs and tints are made with sips into the data folder), `source=made` is 300 made-up stages, drawn here
//     as PNGs at the sizes the tiers want. Open  http://127.0.0.1:4990/bench-wall.html?source=made&hud=1  and drag, wheel, double-click a tile.
//
//   pnpm wall-bench tour [--port 4990] [--logs <dir>] [--data <DATA_DIR>] [--out <dir>] [--screens 390x844,1280x720] [--throttle 4] [--only tour,crowd,idle,reduced,laps,retake,shots] [--laps 3]
//     Starts the same server and a headless Chrome, and drives the page over DevTools with the CPU slowed (`Emulation.setCPUThrottlingRate`):
//     the ten-second tour, a crowd sweep, an idle wall, reduced motion, three laps of 300 tiles for the caps, the retake of a changed frame's
//     picture, and screenshots of the map, mid-glide and arrived. Prints the numbers and writes <out>/wall-bench.json.
//
// Ports 4990 to 4999 only. The data folder defaults to a throwaway one.

import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync, crc32 } from 'node:zlib';
import { spawnTracked } from '../brains/claude-cli/process';
import { Cdp, CHROME_CANDIDATES, stop, waitFor } from './explore-browser';

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

// ---------------------------------------------------------------------------------------------------------------------------------
// arguments

const argv = process.argv.slice(2);
const command = argv[0] ?? 'serve';
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? (argv[at + 1] as string) : fallback;
};

const port = Number(flag('port', '4990'));
if (!(port >= 4990 && port <= 4999)) throw new Error(`port ${port}: the wall bench uses 4990 to 4999 only`);

// ---------------------------------------------------------------------------------------------------------------------------------
// the wall's sources

interface TilePicture {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

interface TileOut {
  readonly id: string;
  readonly lane: string;
  readonly seq: number;
  readonly title: string;
  readonly aspect: number;
  readonly tint: string;
  readonly still: TilePicture;
  readonly thumb: TilePicture;
}

interface Screen {
  readonly name: 'phone' | 'desk';
  readonly width: number;
  readonly height: number;
  readonly stillSide: number;
  readonly thumbSide: number;
}

const SCREENS: Record<string, Screen> = {
  phone: { name: 'phone', width: 390, height: 844, stillSide: 768, thumbSide: 128 },
  desk: { name: 'desk', width: 1280, height: 720, stillSide: 1024, thumbSide: 256 },
};

const fit = (w: number, h: number, side: number): { width: number; height: number } => {
  const k = side / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
};

const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

// ----- made-up stages, as PNGs

function pngOf(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(rgb.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

const rand = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

function madeColours(index: number): { ground: [number, number, number]; ink: [number, number, number]; accent: [number, number, number] } {
  const r = rand(index * 7919 + 13);
  const light = r() < 0.55;
  const hue = r() * 360;
  const hsl = (h: number, s: number, l: number): [number, number, number] => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number): number => {
      const k = (n + h / 30) % 12;
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  return light
    ? { ground: hsl(hue, 0.25, 0.93), ink: hsl(hue, 0.3, 0.15), accent: hsl((hue + 160) % 360, 0.7, 0.45) }
    : { ground: hsl(hue, 0.3, 0.12), ink: hsl(hue, 0.15, 0.9), accent: hsl((hue + 40) % 360, 0.8, 0.6) };
}

const madeCache = new Map<string, Buffer>();

function madePicture(index: number, width: number, height: number): Buffer {
  const key = `${index}:${width}x${height}`;
  const have = madeCache.get(key);
  if (have !== undefined) return have;
  const { ground, ink, accent } = madeColours(index);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = ground[0];
    rgb[i * 3 + 1] = ground[1];
    rgb[i * 3 + 2] = ground[2];
  }
  const rect = (x0: number, y0: number, w: number, h: number, c: readonly number[]): void => {
    const xa = Math.max(0, Math.round(x0));
    const ya = Math.max(0, Math.round(y0));
    const xb = Math.min(width, Math.round(x0 + w));
    const yb = Math.min(height, Math.round(y0 + h));
    for (let y = ya; y < yb; y += 1) for (let x = xa; x < xb; x += 1) {
      const o = (y * width + x) * 3;
      rgb[o] = c[0] ?? 0;
      rgb[o + 1] = c[1] ?? 0;
      rgb[o + 2] = c[2] ?? 0;
    }
  };
  const r = rand(index * 104729 + 7);
  const m = Math.min(width, height) * 0.07;
  // a title, a few lines of text, and either bars or a disc: the shape of a stage
  rect(m, m, width * (0.35 + r() * 0.35), height * 0.07, ink);
  const lines = 3 + Math.floor(r() * 5);
  for (let i = 0; i < lines; i += 1) rect(m, m * 2 + height * 0.1 + i * height * 0.055, width * (0.3 + r() * 0.5), height * 0.022, [ink[0] * 0.5 + ground[0] * 0.5, ink[1] * 0.5 + ground[1] * 0.5, ink[2] * 0.5 + ground[2] * 0.5]);
  if (r() < 0.5) {
    const bars = 4 + Math.floor(r() * 5);
    for (let i = 0; i < bars; i += 1) {
      const h = height * (0.1 + r() * 0.3);
      rect(width * 0.12 + (i * width * 0.76) / bars, height * 0.9 - h, (width * 0.76) / bars - 4, h, accent);
    }
  } else {
    const cx = width * (0.3 + r() * 0.4);
    const cy = height * 0.7;
    const radius = Math.min(width, height) * (0.12 + r() * 0.12);
    for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(height, Math.ceil(cy + radius)); y += 1) for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(width, Math.ceil(cx + radius)); x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) {
        const o = (y * width + x) * 3;
        rgb[o] = accent[0];
        rgb[o + 1] = accent[1];
        rgb[o + 2] = accent[2];
      }
    }
  }
  const out = pngOf(width, height, rgb);
  madeCache.set(key, out);
  return out;
}

function madeTiles(count: number, screen: Screen): TileOut[] {
  const r = rand(4242);
  const tiles: TileOut[] = [];
  let lane = 0;
  let seq = 0;
  while (tiles.length < count) {
    const length = 2 + Math.floor(r() * 11);
    for (let slot = 0; slot < length && tiles.length < count; slot += 1) {
      const i = tiles.length;
      const still = fit(screen.width, screen.height, screen.stillSide);
      const thumb = fit(screen.width, screen.height, screen.thumbSide);
      const { ground } = madeColours(i);
      tiles.push({
        id: `m${i}`,
        lane: `topic-${lane}`,
        seq: (seq += 1),
        title: `Made-up frame ${i}`,
        aspect: screen.width / screen.height,
        tint: hex(...ground),
        still: { url: `/api/wall/pic/made/${i}/still-${still.width}x${still.height}.png`, ...still },
        thumb: { url: `/api/wall/pic/made/${i}/thumb-${thumb.width}x${thumb.height}.png`, ...thumb },
      });
    }
    lane += 1;
  }
  return tiles;
}

// ----- the owner's saved snapshots (read only; thumbs are made into the data folder)

const dataDir = resolve(flag('data', process.env['DATA_DIR'] ?? ''));
const workDir = flag('data', process.env['DATA_DIR'] ?? '') === '' ? join(tmpdir(), 'conduit-wall-bench') : join(dataDir, 'wall-bench');
const logsDir = flag('logs', '');

async function dimsOf(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const w = /pixelWidth: (\d+)/.exec(stdout)?.[1];
  const h = /pixelHeight: (\d+)/.exec(stdout)?.[1];
  return { width: Number(w), height: Number(h) };
}

async function tintOf(file: string, scratch: string): Promise<string> {
  const out = join(scratch, `tint-${Math.abs(hashOf(file))}.bmp`);
  await run('sips', ['-z', '1', '1', '-s', 'format', 'bmp', file, '--out', out]);
  const bmp = await readFile(out);
  const offset = bmp.readUInt32LE(10);
  const bytes = bmp.readUInt16LE(28) / 8;
  const b = bmp[offset] ?? 200;
  const g = bmp[offset + 1] ?? 200;
  const r = bmp[offset + 2] ?? 200;
  void bytes;
  return hex(r, g, b);
}

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h;
}

const realCache = new Map<string, TileOut[]>();

async function realTiles(screen: Screen): Promise<TileOut[]> {
  const have = realCache.get(screen.name);
  if (have !== undefined) return have;
  if (logsDir === '') throw new Error('no --logs directory: source=real needs one');
  const scratch = join(workDir, 'real');
  await mkdir(join(scratch, 'thumb'), { recursive: true });
  const names = (await readdir(logsDir)).filter((n) => n.endsWith('.jpg') && !n.includes('-draft')).sort();
  const tiles: TileOut[] = [];
  let seq = 0;
  for (const name of names) {
    const file = join(logsDir, name);
    const { width, height } = await dimsOf(file);
    const stem = name.replace(/\.jpg$/, '');
    const lane = stem.replace(/-t\d+.*$/, '');
    const thumbSize = fit(width, height, screen.thumbSide);
    const thumbFile = join(scratch, 'thumb', `${screen.thumbSide}-${name}`);
    if (!existsSync(thumbFile)) await run('sips', ['-Z', String(screen.thumbSide), file, '--out', thumbFile]);
    // the saved snapshot is the still: they were made at 768 px, so a desk's 1024 is not upscaled
    tiles.push({
      id: stem,
      lane,
      seq: (seq += 1),
      title: stem,
      aspect: width / height,
      tint: await tintOf(file, scratch),
      still: { url: `/api/wall/pic/real/${name}`, width, height },
      thumb: { url: `/api/wall/pic/real/thumb-${screen.thumbSide}/${name}`, ...thumbSize },
    });
  }
  realCache.set(screen.name, tiles);
  return tiles;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the server

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const webDir = resolve(flag('web', join(repoRoot, 'web', 'dist')));

function listen(): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const send = (status: number, type: string, body: Buffer | string): void => {
        response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        response.end(body);
      };
      try {
        if (url.pathname === '/api/wall/manifest') {
          const screen = SCREENS[url.searchParams.get('screen') ?? 'desk'] ?? (SCREENS['desk'] as Screen);
          const source = url.searchParams.get('source') ?? 'made';
          const asked = Number(url.searchParams.get('n') ?? '');
          const tiles = source === 'real' ? await realTiles(screen) : madeTiles(Number.isFinite(asked) && asked > 0 ? asked : 300, screen);
          send(200, 'application/json', JSON.stringify({ source, screen: screen.name, cell: { width: screen.width, height: screen.height }, tiles }));
          return;
        }
        const made = /^\/api\/wall\/pic\/made\/(\d+)\/(?:still|thumb)-(\d+)x(\d+)\.png$/.exec(url.pathname);
        if (made !== null) {
          send(200, 'image/png', madePicture(Number(made[1]), Number(made[2]), Number(made[3])));
          return;
        }
        const real = /^\/api\/wall\/pic\/real\/(?:thumb-(\d+)\/)?([\w.-]+\.jpg)$/.exec(url.pathname);
        if (real !== null) {
          const file = real[1] === undefined ? join(logsDir, real[2] ?? '') : join(workDir, 'real', 'thumb', `${real[1]}-${real[2]}`);
          send(200, 'image/jpeg', await readFile(file));
          return;
        }
        const rel = url.pathname === '/' ? '/bench-wall.html' : url.pathname;
        const file = resolve(join(webDir, rel));
        if (!file.startsWith(webDir) || !existsSync(file) || !(await stat(file)).isFile()) {
          send(404, 'text/plain', 'not found');
          return;
        }
        send(200, MIME[extname(file)] ?? 'application/octet-stream', await readFile(file));
      } catch (error) {
        send(500, 'text/plain', error instanceof Error ? error.message : String(error));
      }
    })();
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the driver

interface Config {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly screen: 'phone' | 'desk';
}

class Tab {
  private constructor(
    readonly browser: Cdp,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  static async open(browser: Cdp): Promise<Tab> {
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(browser, sessionId, targetId);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Performance.enable');
    await tab.send('HeapProfiler.enable');
    return tab;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async eval<T>(expression: string): Promise<T> {
    const out = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result.value as T;
  }

  call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`window.__wall.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`);
  }

  async metrics(): Promise<Record<string, number>> {
    const { metrics } = await this.send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }

  async open(config: Config, source: string, extra = ''): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width: config.width, height: config.height, deviceScaleFactor: 2, mobile: config.screen === 'phone' });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: config.screen === 'phone' });
    await this.send('Page.navigate', { url: `http://127.0.0.1:${port}/bench-wall.html?source=${source}&screen=${config.screen}${extra}` });
    await waitFor('the wall page', 60_000, async () => {
      const failed = await this.eval<string | null>('window.__wallError ?? null').catch(() => null);
      if (failed !== null) throw new Error(`the wall page failed: ${failed}`);
      return (await this.eval<boolean>('Boolean(window.__wall && window.__wall.ready)').catch(() => false)) ? true : null;
    });
  }

  async throttle(rate: number): Promise<void> {
    await this.send('Emulation.setCPUThrottlingRate', { rate });
  }

  async gc(): Promise<number> {
    await this.send('HeapProfiler.collectGarbage');
    return (await this.metrics())['JSHeapUsedSize'] ?? -1;
  }

  async shot(path: string): Promise<void> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(data, 'base64'));
  }
}

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

async function gpuRss(profile: string): Promise<number> {
  try {
    const { stdout } = await run('ps', ['-axo', 'rss=,command=']);
    let best = 0;
    for (const line of stdout.split('\n')) {
      if (line.includes(profile) && line.includes('--type=gpu-process')) best = Math.max(best, Number(line.trim().split(/\s+/)[0]) * 1024);
    }
    return best;
  } catch {
    return -1;
  }
}

async function tourCommand(): Promise<void> {
  const out = resolve(flag('out', join(tmpdir(), 'wall-bench-out')));
  await mkdir(out, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const rate = Number(flag('throttle', '4'));
  const only = new Set(flag('only', 'tour,crowd,idle,reduced,laps,retake,shots').split(','));
  const laps = Number(flag('laps', '3'));
  const configs: Config[] = flag('screens', '390x844,1280x720').split(',').map((s) => {
    const [w, h] = s.split('x').map(Number);
    return { name: s, width: w ?? 390, height: h ?? 844, screen: (w ?? 0) < 700 ? 'phone' : 'desk' };
  });
  const sources = flag('sources', logsDir === '' ? 'made' : 'real,made').split(',');

  const server = await listen();
  const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN');
  const profile = await mkdtemp(join(tmpdir(), 'conduit-wall-'));
  const child: ChildProcess = spawnTracked(
    chrome,
    ['--headless=new', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'],
    undefined,
    { quiet: true },
  );
  const results: Record<string, unknown> = { rate, when: new Date().toISOString(), chrome: chrome };
  const say = (text: string): void => void process.stdout.write(`${text}\n`);
  try {
    const endpoint = await waitFor('Chrome', 20_000, async () => {
      const [p, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      return p !== undefined && path !== undefined ? `ws://127.0.0.1:${p}${path}` : null;
    });
    const browser = await Cdp.open(endpoint);
    const version = await browser.send<{ product: string }>('Browser.getVersion');
    results['product'] = version.product;
    say(`${version.product}, CPU slowed ${rate}x`);

    for (const config of configs) {
      for (const source of sources) {
        const key = `${config.name}/${source}`;
        const res: Record<string, unknown> = {};
        results[key] = res;
        const tab = await Tab.open(browser);
        await tab.open(config, source);
        const info = await tab.call<Record<string, unknown>>('info');
        res['info'] = info;
        say(`\n=== ${key}: ${String(info['tiles'])} tiles in ${String(info['lanes'])} lanes, plan ${String(info['digest'])}, dpr ${String(info['dpr'])}`);
        const warm = await tab.call<{ held: number; bytes: number }>('warm');
        say(`warm: ${warm.held} thumbs held, ${mb(warm.bytes)} MB`);
        res['warm'] = warm;

        if (only.has('tour')) {
          const runs: Record<string, unknown>[] = [];
          await tab.throttle(1);
          const free = await tab.call<Record<string, unknown>>('tour');
          res['tourUnthrottled'] = free;
          await tab.throttle(rate);
          for (let i = 0; i < 3; i += 1) {
            const before = await tab.metrics();
            const result = await tab.call<Record<string, unknown>>('tour');
            const after = await tab.metrics();
            const delta = (name: string): number => (after[name] ?? 0) - (before[name] ?? 0);
            runs.push({ ...result, layoutCount: delta('LayoutCount'), recalcStyleCount: delta('RecalcStyleCount'), scriptDurationS: delta('ScriptDuration'), taskDurationS: delta('TaskDuration') });
          }
          res['tour'] = runs;
          const row = (label: string, r: Record<string, unknown>): void => {
            const iv = r['intervalMs'] as Record<string, number>;
            const sm = r['scriptMs'] as Record<string, number>;
            const dr = r['draws'] as Record<string, number>;
            say(`${label}: ${String(r['seconds'])} s, ${String(r['frames'])} frames, interval p50 ${iv['p50']?.toFixed(1)} p95 ${iv['p95']?.toFixed(1)} max ${iv['max']?.toFixed(1)} ms, over 33 ms ${String(r['over33'])}, script p95 ${sm['p95']?.toFixed(2)} max ${sm['max']?.toFixed(2)} ms, draws p50 ${dr['p50']} max ${dr['max']}, plan calls ${String(r['planCalls'])}, peak ${String(r['peakScreensPerSecond'])} screens/s, zoom ${String(r['peakZoomEfoldsPerSecond'])} e-folds/s`);
          };
          row('tour 1x ', free);
          runs.forEach((r, i) => {
            row(`tour ${rate}x #${i + 1}`, r);
            say(`          layout events ${String(r['layoutCount'])}, style recalcs ${String(r['recalcStyleCount'])}, script ${(Number(r['scriptDurationS']) * 1000).toFixed(0)} ms of ${(Number(r['taskDurationS']) * 1000).toFixed(0)} ms task`);
          });
          await tab.throttle(1);
        }

        if (only.has('crowd')) {
          await tab.throttle(rate);
          const sweep: Record<string, unknown>[] = [];
          const counts = (info['tiles'] as number) >= 250 ? [1, 4, 9, 25, 60, 126, 300] : [1, 4, 9, 25, 60, 126];
          for (const n of counts) {
            if (n > (info['tiles'] as number)) continue;
            const r = await tab.call<Record<string, unknown>>('crowd', n, 3);
            sweep.push(r);
            const iv = r['intervalMs'] as Record<string, number>;
            const sm = r['scriptMs'] as Record<string, number>;
            const dr = r['draws'] as Record<string, number>;
            const tc = r['tierCounts'] as Record<string, unknown>;
            say(`crowd ${String(n).padStart(3)} asked, ${String(r['inView']).padStart(3)} in view, ${JSON.stringify({ still: tc['still'], thumb: tc['thumb'], card: tc['card'] })}: interval p50 ${iv['p50']?.toFixed(1)} p95 ${iv['p95']?.toFixed(1)} max ${iv['max']?.toFixed(1)}, over 33 ${String(r['over33'])}, script p95 ${sm['p95']?.toFixed(2)} ms, draws ${dr['p50']}`);
          }
          res['crowd'] = sweep;
          await tab.throttle(1);
        }

        if (only.has('idle')) {
          await tab.throttle(rate);
          await tab.call('stage', 'map');
          const atMap = await tab.call<Record<string, unknown>>('idle', 10_000);
          await tab.call('stage', 'arrived', 0, 1);
          const atFrame = await tab.call<Record<string, unknown>>('idle', 10_000);
          res['idle'] = { atMap, atFrame, tiers: await tab.call('tiers') };
          say(`idle 10 s at the map: ${JSON.stringify(atMap)}`);
          say(`idle 10 s at a frame: ${JSON.stringify(atFrame)}`);
          await tab.throttle(1);
        }

        if (only.has('shots')) {
          const stem = `${config.screen}-${source}`;
          for (const what of ['map', 'mid', 'arrived'] as const) {
            await tab.call('stage', what, 3, 6);
            await tab.shot(join(out, `${stem}-${what}.png`));
          }
          say(`pictures: ${join(out, `${stem}-{map,mid,arrived}.png`)}`);
        }

        if (only.has('glides')) {
          // the glides themselves, in normal motion: time, speed across the screen, zoom, overshoot
          await tab.call('warm');
          await tab.throttle(rate);
          const n = (info['tiles'] as number) - 1;
          const pairs: number[][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 40 % n], [40 % n, 41 % n], [41 % n, 5], [5, n]];
          const g = await tab.call<{ motion: string; moves: Record<string, number>[] }>('glides', pairs);
          res['glides'] = g;
          for (const m of g.moves) say(`glide ${m['from']}->${m['to']}: ${m['travelSeconds']} s, peak ${m['peakScreensPerSecond']} longer-sides/s, zoom ${m['peakZoomEfoldsPerSecond']} e-folds/s, overshoot ${m['overshoot']}`);
          await tab.throttle(1);
        }

        if (only.has('stress') && source === 'made') {
          // PictureFrames against the bar with every tile a thumb in view (the 96 px floor and the 6% threshold lifted)
          await tab.open(config, source, '&floor=0.02&thumbShare=0');
          await tab.call('warm');
          await tab.throttle(rate);
          const sweep: Record<string, unknown>[] = [];
          for (const k of [25, 60, 126, 300]) {
            const r = await tab.call<Record<string, unknown>>('crowd', k, 3);
            sweep.push(r);
            const iv = r['intervalMs'] as Record<string, number>;
            const sm = r['scriptMs'] as Record<string, number>;
            const dr = r['draws'] as Record<string, number>;
            say(`stress ${String(k).padStart(3)} asked, ${String(r['inView']).padStart(3)} in view, all PictureFrames: interval p50 ${iv['p50']?.toFixed(1)} p95 ${iv['p95']?.toFixed(1)} max ${iv['max']?.toFixed(1)}, over 33 ${String(r['over33'])}, script p50 ${sm['p50']?.toFixed(2)} p95 ${sm['p95']?.toFixed(2)} max ${sm['max']?.toFixed(2)} ms, draws ${dr['p50']}`);
          }
          res['stress'] = sweep;
          await tab.throttle(1);
          await tab.open(config, source);
        }

        if (only.has('reduced')) {
          await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
          await tab.open(config, source);
          await tab.call('warm');
          await tab.throttle(rate);
          const mode = (await tab.call<Record<string, unknown>>('info'))['motion'];
          const n = (info['tiles'] as number) - 1;
          const pairs: number[][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 40 % n], [40 % n, 41 % n], [41 % n, 5], [5, n]];
          const fades = await tab.call<{ motion: string; moves: { travelFrames: number; fadeFrames: number; seconds: number; frames: number }[] }>('glides', pairs);
          const tourReduced = await tab.call<Record<string, unknown>>('tour');
          const travel = fades.moves.reduce((sum, m) => sum + m.travelFrames, 0);
          res['reduced'] = { mode, fades, tourReduced };
          const secs = fades.moves.map((m) => m.seconds);
          say(`reduced motion (emulated, page sees ${String(mode)}): ${fades.moves.length} moves, frames of travel ${travel}, cross-fade frames/move ${fades.moves.map((m) => m.fadeFrames).join(',')}, fade seconds ${secs.join(',')}`);
          const iv = tourReduced['intervalMs'] as Record<string, number>;
          say(`reduced-motion tour ${rate}x: interval p95 ${iv['p95']?.toFixed(1)} max ${iv['max']?.toFixed(1)}, over 33 ${String(tourReduced['over33'])}`);
          await tab.throttle(1);
          await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        }

        if (only.has('laps') && source === 'made') {
          await tab.open(config, source);
          await tab.call('warm');
          const heap0 = await tab.gc();
          const gpu0 = await gpuRss(profile);
          const rows: Record<string, unknown>[] = [];
          for (let lap = 1; lap <= laps; lap += 1) {
            const r = await tab.call<Record<string, unknown>>('lap', 0);
            const heap = await tab.gc();
            const mem = await tab.call<Record<string, number>>('memory');
            const gpu = await gpuRss(profile);
            rows.push({ lap, ...r, heapAfterGc: heap, memory: mem, gpuRss: gpu });
            const fr = r['frames'] as Record<string, unknown>;
            const iv = fr['intervalMs'] as Record<string, number>;
            say(`lap ${lap}: ${String(r['seconds'])} s, peak pool ${mb(Number(r['peakPoolBytes']))} MB (cache ${mb(Number(r['peakCacheBytes']))} MB), peak textures ${String(r['peakTextures'])}, end pool ${mb(Number(r['endPoolBytes']))} MB / ${String(r['endPoolTextures'])} textures, JS heap ${mb(heap)} MB, GPU process RSS ${mb(gpu)} MB, interval p95 ${iv['p95']?.toFixed(1)} max ${iv['max']?.toFixed(1)}, evicted ${String((r['stats'] as Record<string, number>)['evicted'])}, waited ${String((r['stats'] as Record<string, number>)['waited'])}`);
          }
          res['laps'] = { heap0, gpu0, rows };
          say(`cap for this screen: ${mb((info['caps'] as { bytes: number }).bytes)} MB`);
        }

        if (only.has('retake') && source === 'made') {
          await tab.open(config, source);
          await tab.call('warm');
          await tab.throttle(rate);
          const side = config.screen === 'phone' ? 768 : 1024;
          const still = await tab.call<Record<string, unknown>>('retake', 12, false, side);
          const moving = await tab.call<Record<string, unknown>>('retake', 12, true, side);
          res['retake'] = { still, moving };
          say(`retake (rasterise, ${side} px) idle: ${JSON.stringify(still)}`);
          say(`retake (rasterise, ${side} px) with the wall moving: ${JSON.stringify(moving)}`);
          await tab.throttle(1);
        }
        await browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
      }
    }
    browser.close();
  } finally {
    await stop(child);
    await rm(profile, { recursive: true, force: true });
    server.close();
    await writeFile(join(out, 'wall-bench.json'), JSON.stringify(results, null, 1));
    say(`\nnumbers: ${join(out, 'wall-bench.json')}`);
  }
}

if (command === 'tour') {
  await tourCommand();
} else {
  await mkdir(workDir, { recursive: true });
  await listen();
  process.stdout.write(`wall bench on http://127.0.0.1:${port}/bench-wall.html?source=${logsDir === '' ? 'made' : 'real'}&hud=1  (web ${webDir})\n`);
}
