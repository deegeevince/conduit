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
//   pnpm wall-bench hands [--port 4990] [--logs <dir>] [--data <DATA_DIR>] [--out <dir>] [--screens 390x844,1280x720] [--throttle 4] [--sources made,real]
//     (WL2) Drives web/bench-wall-hands.html with REAL input over DevTools (Input.dispatchTouchEvent, mouse wheel, key events), the CPU slowed:
//     pinch out, two-finger pan, tap a tile and arrive; a flick that coasts; wheel pan and ctrl+wheel zoom; arrows, 0 and Escape; ten idle
//     seconds; reduced motion; a tap where a far frame's slider is. The numbers come from the page's per-frame trace of the lens.
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

  hands<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`window.__hands.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`);
  }

  async openHands(config: Config, source: string, extra = ''): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width: config.width, height: config.height, deviceScaleFactor: 2, mobile: config.screen === 'phone' });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await this.send('Page.navigate', { url: `http://127.0.0.1:${port}/bench-wall-hands.html?source=${source}&screen=${config.screen}${extra}` });
    await waitFor('the hands page', 60_000, async () => {
      const failed = await this.eval<string | null>('window.__wallError ?? null').catch(() => null);
      if (failed !== null) throw new Error(`the hands page failed: ${failed}`);
      return (await this.eval<boolean>('Boolean(window.__hands && window.__hands.ready)').catch(() => false)) ? true : null;
    });
  }

  // ----- real input
  async touch(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: { x: number; y: number; id: number }[]): Promise<void> {
    await this.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 4, radiusY: 4, force: 0.5 })) });
  }

  /** a tap: finger down, a short hold, up */
  async tap(x: number, y: number, holdMs = 50): Promise<void> {
    await this.touch('touchStart', [{ x, y, id: 1 }]);
    await sleep(holdMs);
    await this.touch('touchEnd', []);
  }

  /** two fingers about (cx, cy): their distance goes from d0 to d1 and the middle by (dx, dy), over ms, a move every ~16 ms; `hold` leaves them down */
  async twoFingers(cx: number, cy: number, d0: number, d1: number, dx: number, dy: number, ms: number, hold = false): Promise<void> {
    const at = (k: number): { x: number; y: number; id: number }[] => {
      const d = d0 + (d1 - d0) * k;
      const mx = cx + dx * k;
      const my = cy + dy * k;
      return [
        { x: mx - d / 2, y: my, id: 1 },
        { x: mx + d / 2, y: my, id: 2 },
      ];
    };
    const first = at(0);
    await this.touch('touchStart', [first[0] as { x: number; y: number; id: number }]);
    await this.touch('touchStart', first);
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i += 1) {
      await sleep(ms / steps);
      await this.touch('touchMove', at(i / steps));
    }
    if (!hold) await this.touchesUp(at(1));
  }

  async touchesUp(points: { x: number; y: number; id: number }[]): Promise<void> {
    await this.touch('touchEnd', points.slice(1));
    await this.touch('touchEnd', []);
  }

  /** one finger: down at (x0, y0), moves to (x1, y1) over ms, and lifts at once (a flick) */
  async drag(x0: number, y0: number, x1: number, y1: number, ms: number): Promise<void> {
    await this.touch('touchStart', [{ x: x0, y: y0, id: 1 }]);
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i += 1) {
      await sleep(ms / steps);
      await this.touch('touchMove', [{ x: x0 + (x1 - x0) * (i / steps), y: y0 + (y1 - y0) * (i / steps), id: 1 }]);
    }
    await this.touch('touchEnd', []);
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number, ctrl = false): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: ctrl ? 2 : 0 });
  }

  async key(key: string, code: string, vk: number): Promise<void> {
    const text = key.length === 1 ? key : undefined;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
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

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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
    ['--headless=new', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'],
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


// ---------------------------------------------------------------------------------------------------------------------------------
// hands: the lens under real input (WL2)

interface HandsTrace {
  readonly marks: number[][];
  readonly events: { kind: string; t: number; tile: number | null }[];
  readonly drawn: number;
  readonly kinds: string[];
}

interface LensNow {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly kind: string;
  readonly focus: number | null;
  readonly live: number | null;
}

/** Numbers from a per-frame lens trace. */
function analyse(trace: HandsTrace): { frames: number; drawn: number; peakZoom: number; peakSpeed: number; distinct: number; fadeFrames: number } {
  let peakZoom = 0;
  let peakSpeed = 0;
  const seen = new Set<string>();
  const m = trace.marks;
  for (let i = 0; i < m.length; i += 1) {
    const cur = m[i] as number[];
    seen.add(`${cur[1]}|${cur[2]}|${cur[3]}`);
    if (i === 0) continue;
    const prev = m[i - 1] as number[];
    const dt = ((cur[0] as number) - (prev[0] as number)) / 1000;
    if (dt <= 0) continue;
    peakZoom = Math.max(peakZoom, Math.abs(Math.log((cur[3] as number) / (prev[3] as number))) / dt);
    peakSpeed = Math.max(peakSpeed, (Math.hypot((cur[1] as number) - (prev[1] as number), (cur[2] as number) - (prev[2] as number)) * (cur[3] as number)) / dt);
  }
  return { frames: m.length, drawn: trace.drawn, peakZoom, peakSpeed, distinct: seen.size, fadeFrames: m.filter((x) => (x[4] as number) >= 0).length };
}

/** From the frame where the lens leaves `start` to the end: does it ever go past `end` along the line, or zoom past both ends' scales? */
function overshootOf(trace: HandsTrace, start: { x: number; y: number; scale: number }, end: { x: number; y: number; scale: number }): { overshoot: number; changedAfterArrival: number } {
  const ax = end.x - start.x;
  const ay = end.y - start.y;
  const len2 = ax * ax + ay * ay;
  let over = 0;
  let after = 0;
  let arrived = false;
  for (const row of trace.marks) {
    const x = row[1] as number;
    const y = row[2] as number;
    const k = row[3] as number;
    if (len2 > 1e-6) {
      const along = ((x - start.x) * ax + (y - start.y) * ay) / len2;
      over = Math.max(over, along - 1, -along);
    }
    over = Math.max(over, k / Math.max(start.scale, end.scale) - 1);
    if (arrived && (Math.abs(x - end.x) > 1e-6 || Math.abs(y - end.y) > 1e-6 || Math.abs(k - end.scale) > 1e-9)) after += 1;
    if (Math.abs(x - end.x) < 1e-6 && Math.abs(y - end.y) < 1e-6 && Math.abs(k - end.scale) < 1e-9) arrived = true;
  }
  return { overshoot: Math.max(0, over), changedAfterArrival: after };
}

const lastEvent = (t: HandsTrace, kind: string, from = 0): { t: number; tile: number | null } | undefined => [...t.events].reverse().find((e) => e.kind === kind && e.t >= from);

async function handsCommand(): Promise<void> {
  const out = resolve(flag('out', join(tmpdir(), 'wall-hands-out')));
  await mkdir(out, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const rate = Number(flag('throttle', '4'));
  const configs: Config[] = flag('screens', '390x844,1280x720').split(',').map((s) => {
    const [w, h] = s.split('x').map(Number);
    return { name: s, width: w ?? 390, height: h ?? 844, screen: (w ?? 0) < 700 ? 'phone' : 'desk' };
  });
  const sources = flag('sources', logsDir === '' ? 'made' : 'real,made').split(',');
  const server = await listen();
  const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN');
  const profile = await mkdtemp(join(tmpdir(), 'conduit-wall-hands-'));
  const child: ChildProcess = spawnTracked(chrome, ['--headless=new', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], undefined, { quiet: true });
  const results: Record<string, unknown> = { rate, when: new Date().toISOString() };
  const say = (text: string): void => void process.stdout.write(`${text}\n`);
  const f2 = (v: number): string => v.toFixed(2);
  try {
    const endpoint = await waitFor('Chrome', 20_000, async () => {
      const [p, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      return p !== undefined && path !== undefined ? `ws://127.0.0.1:${p}${path}` : null;
    });
    const browser = await Cdp.open(endpoint);
    say(`${(await browser.send<{ product: string }>('Browser.getVersion')).product}, CPU slowed ${rate}x, real touch, wheel and key events`);
    for (const config of configs) {
      for (const source of sources) {
        const key = `${config.name}/${source}`;
        const res: Record<string, unknown> = {};
        results[key] = res;
        const tab = await Tab.open(browser);
        await tab.openHands(config, source);
        const info = await tab.hands<Record<string, unknown>>('info');
        say(`\n=== ${key}: ${String(info['tiles'])} tiles, touch-action "${String(info['touchAction'])}"`);
        res['info'] = info;
        await tab.hands('warm');
        await tab.throttle(rate);
        const W = config.width;
        const H = config.height;
        const where = (): Promise<LensNow> => tab.hands<LensNow>('lens');
        const waitRest = async (limit = 4000): Promise<void> => {
          const until = performance.now() + limit;
          while (performance.now() < until) {
            if ((await where()).kind === 'rest') return;
            await sleep(40);
          }
        };

        // ---- 1. pinch out, pan, tap a tile, arrive
        const taps: Record<string, unknown>[] = [];
        for (const target of ['visible', 'far'] as const) {
          await tab.hands('place', 'map');
          await sleep(200);
          await tab.hands('traceStart');
          // about a tile that is on the map's screen (the middle of a sparse wall may be bare ground)
          const atMap = (await tab.hands<{ index: number; x: number; y: number }[]>('onScreen')).filter((t) => t.x > 4 && t.y > 4 && t.x < W - 4 && t.y < H - 4).sort((a, b) => Math.hypot(a.x - W / 2, a.y - H / 2) - Math.hypot(b.x - W / 2, b.y - H / 2))[0];
          const cx = atMap?.x ?? W / 2;
          const cy = atMap?.y ?? H / 2;
          // spread: fingers apart (zoom in about the middle), a two-finger pan, then pinch back a little so a tile fills a good part of the view
          await tab.twoFingers(cx, cy, W * 0.12, W * 0.42, 0, 0, 800);
          await sleep(120);
          await tab.twoFingers(W / 2, H / 2, W * 0.3, W * 0.3, (cx - W / 2) * -0.15, (cy - H / 2) * -0.15, 500);
          await sleep(150);
          const before = await where();
          // a tile on screen that is not the one at the centre; or, for "far", the last tile (the map is first reached by a pinch in)
          let index: number;
          let point: { x: number; y: number };
          if (target === 'visible') {
            const seen = await tab.hands<{ index: number; x: number; y: number; w: number }[]>('onScreen');
            const pick = seen.filter((t) => t.x > 12 && t.y > 12 && t.x < W - 12 && t.y < H - 12).sort((a, b) => Math.hypot(b.x - W / 2, b.y - H / 2) - Math.hypot(a.x - W / 2, a.y - H / 2))[0] ?? seen[0];
            if (pick === undefined) throw new Error(`no tile on screen to tap: lens ${JSON.stringify(await where())}, seen ${JSON.stringify(seen)}, pinched about ${cx},${cy} (${String(atMap?.index)})`);
            index = pick.index;
            point = { x: Math.min(W - 6, Math.max(6, pick.x)), y: Math.min(H - 6, Math.max(6, pick.y)) };
          } else {
            // pinch back in to the map, then tap the farthest tile that is on the screen
            await tab.twoFingers(cx, cy, W * 0.45, W * 0.1, 0, 0, 700);
            await sleep(150);
            const seen = await tab.hands<{ index: number; x: number; y: number; w: number }[]>('onScreen');
            const here = (await where()).focus ?? 0;
            const pick = seen.filter((t) => t.x > 12 && t.y > 12 && t.x < W - 12 && t.y < H - 12).sort((a, b) => Math.abs(b.index - here) - Math.abs(a.index - here))[0];
            if (pick === undefined) throw new Error('no far tile on screen');
            index = pick.index;
            point = { x: pick.x, y: pick.y };
          }
          const from = await where();
          await tab.tap(point.x, point.y);
          await waitRest(3000);
          await sleep(300);
          const trace = await tab.hands<HandsTrace>('traceStop');
          const a = analyse(trace);
          const arrive = lastEvent(trace, 'arrive');
          const up = [...trace.events].reverse().find((e) => e.kind === 'up:touch');
          const end = await where();
          const tp = await tab.hands<{ x: number; y: number } | null>('tilePoint', index);
          // the glide's own marks: from the tap
          const glideMarks = { ...trace, marks: trace.marks.filter((m) => (up === undefined ? true : (m[0] as number) >= up.t - 1)) };
          const target1 = { x: end.x, y: end.y, scale: end.scale };
          const o = overshootOf(glideMarks, from, target1);
          const arrivalMs = arrive !== undefined && up !== undefined ? arrive.t - up.t : -1;
          const row = { target, tile: index, focus: end.focus, live: end.live, arrivalMs: Math.round(arrivalMs), overshoot: Number(o.overshoot.toFixed(4)), changedAfterArrival: o.changedAfterArrival, zoomPeak: Number(a.peakZoom.toFixed(2)), frames: a.frames, kinds: trace.kinds, startScale: before.scale, endScale: end.scale, centred: tp !== null && Math.hypot(tp.x - W / 2, tp.y - H / 2) < 1.5 };
          taps.push(row);
          say(`pinch out, pan, tap ${target} tile ${index}: arrived in ${arrivalMs.toFixed(0)} ms (limit 1300), overshoot ${o.overshoot.toFixed(4)}, changed after arrival ${o.changedAfterArrival}, zoom peak over the whole trace ${f2(a.peakZoom)} e-folds/s, ${a.frames} frames, live tile ${String(end.live)}, lens kinds ${trace.kinds.join('/')}`);
          if (target === 'visible') {
            await tab.shot(join(out, `${config.screen}-${source}-arrived.png`));
          }
        }
        res['taps'] = taps;

        // ---- screenshots mid-pinch and mid-glide
        await tab.hands('place', 'map');
        await sleep(200);
        await tab.shot(join(out, `${config.screen}-${source}-map.png`));
        const shotTile = (await tab.hands<{ index: number; x: number; y: number }[]>('onScreen')).filter((t) => t.x > 4 && t.y > 4 && t.x < W - 4 && t.y < H - 4).sort((a, b) => Math.hypot(a.x - W / 2, a.y - H / 2) - Math.hypot(b.x - W / 2, b.y - H / 2))[0];
        const sx = shotTile?.x ?? W / 2;
        const sy = shotTile?.y ?? H / 2;
        await tab.twoFingers(sx, sy, W * 0.12, W * 0.4, 0, 0, 500, true);
        await sleep(100);
        await tab.shot(join(out, `${config.screen}-${source}-pinch.png`));
        await tab.touchesUp([
          { x: sx - W * 0.2, y: sy, id: 1 },
          { x: sx + W * 0.2, y: sy, id: 2 },
        ]);
        await waitRest();
        await tab.hands('place', 'map');
        await sleep(150);
        {
          const seen = await tab.hands<{ index: number; x: number; y: number }[]>('onScreen');
          const pick = seen.filter((t) => t.x > 12 && t.y > 12 && t.x < W - 12 && t.y < H - 12)[Math.floor(seen.length / 2)];
          if (pick !== undefined) {
            await tab.tap(pick.x, pick.y);
            await sleep(170);
            await tab.shot(join(out, `${config.screen}-${source}-glide.png`));
            await waitRest();
          }
        }
        say(`pictures: ${join(out, `${config.screen}-${source}-{map,pinch,glide,arrived}.png`)}`);

        if (source !== 'made') {
          await tab.throttle(1);
          await browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
          continue;
        }

        // ---- 2. a flick that coasts
        await tab.hands('place', 'map');
        await sleep(200);
        await tab.hands('traceStart');
        const start = await where();
        await tab.drag(W * 0.8, H * 0.5, W * 0.3, H * 0.5, 110);
        await sleep(60);
        const mid = await where();
        await waitRest(4000);
        await sleep(300);
        const flick = await tab.hands<HandsTrace>('traceStop');
        const fa = analyse(flick);
        // monotone: the lens keeps moving the way the finger threw it (x only grows) and ends still
        let reversed = 0;
        for (let i = 1; i < flick.marks.length; i += 1) if ((flick.marks[i]?.[1] as number) < (flick.marks[i - 1]?.[1] as number) - 1e-9) reversed += 1;
        const coastFrames = flick.marks.filter((m) => (m[0] as number) > 0).length;
        const endNow = await where();
        const lastDraw = flick.marks.length;
        res['flick'] = { frames: lastDraw, coastFrames, reversed, moved: endNow.x - start.x, kinds: flick.kinds, endKind: endNow.kind, distinct: fa.distinct };
        say(`flick: the lens went ${(endNow.x - start.x).toFixed(0)} world units (${(((endNow.x - start.x) * start.scale)).toFixed(0)} px at the map), kinds ${flick.kinds.join('/')}, reversals ${reversed}, ended ${endNow.kind}; in coast ${mid.kind}`);

        // ---- 3. wheel: pan, ctrl+wheel zoom
        await tab.hands('place', 'map');
        await sleep(200);
        await tab.hands('traceStart');
        const w0 = await where();
        for (let i = 0; i < 8; i += 1) {
          await tab.wheel(W / 2, H / 2, 20, 40, false);
          await sleep(24);
        }
        await sleep(300);
        const w1 = await where();
        for (let i = 0; i < 14; i += 1) {
          await tab.wheel(W * 0.4, H * 0.45, 0, -50, true);
          await sleep(24);
        }
        await sleep(400);
        const w2 = await where();
        for (let i = 0; i < 10; i += 1) {
          await tab.wheel(W / 2, H / 2, 0, 160, true);
          await sleep(18);
        }
        await waitRest();
        await sleep(300);
        const wheel = await tab.hands<HandsTrace>('traceStop');
        const wa = analyse(wheel);
        res['wheel'] = { panned: { dx: w1.x - w0.x, dy: w1.y - w0.y }, zoomed: w2.scale / w1.scale, zoomPeak: wa.peakZoom };
        say(`wheel: pan moved the lens by (${(w1.x - w0.x).toFixed(0)}, ${(w1.y - w0.y).toFixed(0)}) world units; ctrl+wheel zoomed x${f2(w2.scale / w1.scale)} then out; zoom peak ${f2(wa.peakZoom)} e-folds/s (limit 4.5)`);

        // ---- 4. keys
        await tab.hands('place', 0);
        await sleep(200);
        const keyRows: Record<string, unknown>[] = [];
        const press = async (label: string, k: string, code: string, vk: number): Promise<void> => {
          await tab.hands('traceStart');
          const b = await where();
          await tab.key(k, code, vk);
          await sleep(100);
          await waitRest(3000);
          await sleep(150);
          const t = await tab.hands<HandsTrace>('traceStop');
          const e = await where();
          const arrive = lastEvent(t, 'arrive');
          const go = lastEvent(t, 'go');
          const an = analyse(t);
          const ov = overshootOf(t, b, e);
          const ms = arrive !== undefined && go !== undefined ? Math.round(arrive.t - go.t) : -1;
          keyRows.push({ label, ms, focus: e.focus, scale: e.scale, overshoot: ov.overshoot, zoomPeak: an.peakZoom });
          say(`key ${label}: ${ms} ms, focus ${String(e.focus)}, scale ${e.scale.toFixed(3)}, overshoot ${ov.overshoot.toFixed(4)}, zoom peak ${f2(an.peakZoom)}`);
        };
        const forward = config.screen === 'phone' ? ['ArrowDown', 'ArrowDown', 40] : ['ArrowRight', 'ArrowRight', 39];
        const back = config.screen === 'phone' ? ['ArrowUp', 'ArrowUp', 38] : ['ArrowLeft', 'ArrowLeft', 37];
        await press('next', forward[0] as string, forward[1] as string, forward[2] as number);
        await press('previous', back[0] as string, back[1] as string, back[2] as number);
        await press('0 (the map)', '0', 'Digit0', 48);
        await press('0 (back)', '0', 'Digit0', 48);
        await press('Escape (the map)', 'Escape', 'Escape', 27);
        await press('Escape (back)', 'Escape', 'Escape', 27);
        res['keys'] = keyRows;

        // ---- 5. ten idle seconds, at the map and at a frame
        const idles: Record<string, unknown> = {};
        for (const at of ['map', 3] as const) {
          await tab.hands('place', at);
          await sleep(500);
          await tab.hands('traceStart');
          const s0 = await tab.hands<{ planCalls: number }>('stats');
          await sleep(10_000);
          const s1 = await tab.hands<{ planCalls: number }>('stats');
          const t = await tab.hands<HandsTrace>('traceStop');
          const ia = analyse(t);
          idles[String(at)] = { frames: ia.frames, distinct: ia.distinct, drawn: ia.drawn, planCalls: s1.planCalls - s0.planCalls };
          say(`idle 10 s at ${at === 'map' ? 'the map' : 'a frame'}: ${ia.frames} frames, ${ia.distinct} distinct lens value(s), ${ia.drawn} frames drawn, plan calls ${s1.planCalls - s0.planCalls}`);
        }
        res['idle'] = idles;

        // ---- 6. reduced motion, emulated
        await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await tab.openHands(config, source);
        await tab.hands('warm');
        await tab.throttle(rate);
        const reduced: Record<string, unknown>[] = [];
        await tab.hands('place', 'map');
        await sleep(200);
        const mapSeen = (await tab.hands<{ index: number; x: number; y: number }[]>('onScreen')).filter((t) => t.x > 8 && t.y > 8 && t.x < W - 8 && t.y < H - 8);
        const picks = [mapSeen[1], mapSeen[Math.floor(mapSeen.length / 2)], mapSeen[mapSeen.length - 1]].filter((t): t is { index: number; x: number; y: number } => t !== undefined);
        for (const pick of picks) {
          await tab.hands('place', 'map');
          await sleep(200);
          await tab.hands('traceStart');
          const from0 = await where();
          await tab.tap(pick.x, pick.y);
          await waitRest(2000);
          await sleep(500);
          const t = await tab.hands<HandsTrace>('traceStop');
          const e = await where();
          const a = analyse(t);
          const same = (m: number[], l: { x: number; y: number; scale: number }): boolean => Math.abs((m[1] as number) - l.x) < 1e-6 && Math.abs((m[2] as number) - l.y) < 1e-6 && Math.abs((m[3] as number) - l.scale) < 1e-9;
          const travel = t.marks.filter((m) => !same(m, from0) && !same(m, e)).length;
          const arrive = lastEvent(t, 'arrive');
          const up = [...t.events].reverse().find((x) => x.kind === 'up:touch');
          reduced.push({ to: pick.index, travelFrames: travel, fadeFrames: a.fadeFrames, arrivalMs: arrive !== undefined && up !== undefined ? Math.round(arrive.t - up.t) : -1, motion: ((await tab.hands<Record<string, unknown>>('info'))['motion']) });
        }
        res['reduced'] = reduced;
        say(`reduced motion (emulated): ${reduced.map((r) => `to ${String(r['to'])}: ${String(r['travelFrames'])} frames of travel, ${String(r['fadeFrames'])} cross-fade frames, ${String(r['arrivalMs'])} ms`).join('; ')}`);
        await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        await tab.openHands(config, source);
        await tab.hands('warm');
        await tab.throttle(rate);

        // ---- 7. the far slider
        const slider: Record<string, unknown> = {};
        // a positive control: at full size and at rest the live slider answers a touch
        await tab.hands('place', 0);
        await tab.hands('setSlider', 0, 40);
        await sleep(300);
        const rect0 = await tab.hands<{ x: number; y: number } | null>('sliderRectNow');
        if (rect0 === null) throw new Error('the live frame is not showing at full size');
        await tab.tap(rect0.x + W * 0.25, rect0.y, 60);
        await sleep(200);
        const live0 = await tab.hands<Record<string, number>>('values');
        slider['liveControl'] = { before: 40, after: live0['0'] };
        say(`far slider: positive control, a touch on the live slider at full size moves its value 40 -> ${String(live0['0'])}`);
        // held values on the frames that are on screen at the map: each tap goes where one of their sliders would be
        await tab.hands('place', 'map');
        await sleep(200);
        const onMap = (await tab.hands<{ index: number; x: number; y: number }[]>('onScreen')).filter((t) => t.x > 8 && t.y > 8 && t.x < W - 8 && t.y < H - 8);
        const chosen = [onMap[2], onMap[Math.floor(onMap.length / 2)], onMap[onMap.length - 2]].filter((t): t is { index: number; x: number; y: number } => t !== undefined);
        const heldValues = [25, 70, 10];
        for (const [i, t] of chosen.entries()) await tab.hands('setSlider', t.index, heldValues[i] ?? 33);
        const held = await tab.hands<Record<string, number>>('values');
        const attempts: Record<string, unknown>[] = [];
        const tapFar = async (index: number, via: 'touch' | 'mouse', scale: 'map' | 'part'): Promise<void> => {
          await tab.hands('place', 'map');
          await sleep(250);
          if (scale === 'part') {
            // zoom in a little with a real pinch so the far frame is bigger, still not at full size
            await tab.twoFingers(W / 2, H / 2, W * 0.12, W * 0.24, 0, 0, 400);
            await sleep(200);
          }
          const sp = await tab.hands<{ x: number; y: number; inside: boolean; element: string } | null>('sliderPoint', index);
          if (sp === null || !sp.inside) {
            attempts.push({ index, via, scale, skipped: 'the far slider is off screen' });
            return;
          }
          const before = await tab.hands<Record<string, number>>('values');
          const lensBefore = await where();
          if (via === 'touch') await tab.tap(sp.x, sp.y, 60);
          else {
            await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x, y: sp.y, button: 'left', clickCount: 1, buttons: 1 });
            await sleep(40);
            await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.x, y: sp.y, button: 'left', clickCount: 1 });
          }
          await sleep(100);
          const during = await where();
          await waitRest(3000);
          await sleep(300);
          const after = await tab.hands<Record<string, number>>('values');
          const liveNow = await tab.hands<{ liveIndex: number | null; value: string }>('liveState');
          const sameValues = JSON.stringify(before) === JSON.stringify(after);
          attempts.push({ index, via, scale, elementAtPoint: sp.element, startedAtScale: Number(lensBefore.scale.toFixed(3)), wentThere: during.focus === index, arrivedLive: liveNow.liveIndex === index, valuesBefore: before, valuesAfter: after, unchanged: sameValues, liveSliderShows: liveNow.value });
        };
        await tapFar(chosen[0]?.index ?? 0, 'touch', 'map');
        await tapFar(chosen[1]?.index ?? 0, 'touch', 'part');
        await tapFar(0, 'touch', 'map');
        await tapFar(chosen[2]?.index ?? 0, 'mouse', 'map');
        slider['attempts'] = attempts;
        slider['valuesStart'] = held;
        res['farSlider'] = slider;
        for (const a of attempts) {
          if (a['skipped'] !== undefined) say(`far slider: tile ${String(a['index'])} (${String(a['via'])}, ${String(a['scale'])}): skipped, ${String(a['skipped'])}`);
          else say(`far slider: tapped where tile ${String(a['index'])}'s slider is (${String(a['via'])}, from ${String(a['scale'])}, scale ${String(a['startedAtScale'])}, the element there is ${String(a['elementAtPoint'])}): went there ${String(a['wentThere'])}, arrived live ${String(a['arrivedLive'])}, no value changed ${String(a['unchanged'])}, its live slider shows ${String(a['liveSliderShows'])}`);
        }
        await tab.throttle(1);
        await browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
      }
    }
    browser.close();
  } finally {
    await stop(child);
    await rm(profile, { recursive: true, force: true });
    server.close();
    await writeFile(join(out, 'wall-hands.json'), JSON.stringify(results, null, 1));
    say(`\nnumbers: ${join(out, 'wall-hands.json')}`);
  }
}

if (command === 'hands') {
  await handsCommand();
} else if (command === 'tour') {
  await tourCommand();
} else {
  await mkdir(workDir, { recursive: true });
  await listen();
  process.stdout.write(`wall bench on http://127.0.0.1:${port}/bench-wall.html?source=${logsDir === '' ? 'made' : 'real'}&hud=1  (web ${webDir})\n`);
}
