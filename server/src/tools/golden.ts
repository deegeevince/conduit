// pnpm golden: hold a refactor to "identical bytes", by the real product in a real browser.
//
//   CAPTURE_WEB_PORT=4901 CAPTURE_CHROME_PORT=4910 pnpm golden take <dir>      (GOLDEN_JOBS=4: Chrome on 4910-4913)
//   pnpm golden take <dir> --only scene-steam,table-nvidia --screens 1280x720      a quick look at a few (a partial take)
//   pnpm golden diff <dirA> <dirB> [--tolerance 2]
//
// `take` replays the owner's turns (golden-turns.ts, from the logs copied to server/golden/logs/) with `pnpm capture --debug --no-video`
// at 1280x720, 390x844 and 1920x825, and also writes `pnpm timeline` (every demo and the whole check), `pnpm prompt` (every variant) and
// the `pnpm explore --replay` battery over a logged run, all into <dir>, with a manifest.json of SHA-256 hashes. No model is called.
// `diff` compares two folders by their manifests and says, per artefact, identical or changed; for a changed picture it counts the
// pixels that differ and writes a diff image into <dirB>/diff/.
//
// Ports: capture's defaults collide when two builders run it, so this refuses to run without CAPTURE_WEB_PORT and CAPTURE_CHROME_PORT,
// both inside 4900-4999. The web dev server is started once here and handed to every capture and to the replay battery.
//
// The noise floor, measured. The page script already pins the clock (`pinnedWallTime`) and nothing in it is random. Even so, the same
// frame drawn in two Chrome sessions on this machine differs in a few dozen pixels, by one or two levels of 255, in about a tenth of the
// pictures: the renderer's own arithmetic (the Metal path and SwiftShader, the software one, were both measured; the software path
// is no steadier and four times slower). It never reaches the layout dump (`.debug.json`), the schedule, the prompt or the battery,
// which are identical to the byte. So a picture is `identical` when its bytes are, `noise` when every pixel is within `--tolerance`
// (default 2) of the other's, and `changed` otherwise; only `changed` fails the diff. `--tolerance 0` is strict bytes.
// `GOLDEN_SOFTWARE=1` runs Chrome on SwiftShader through a wrapper handed over as CHROME_BIN; `GOLDEN_JOBS=n` runs n captures at once,
// each with a Chrome on its own port (CAPTURE_CHROME_PORT and the ones after it). Two warm-up captures run first so the dev server
// has transformed every module before the first picture.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ChildProcess } from 'node:child_process';
import { DEMOS } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { processEnvironment } from '../env';
import { GOLDEN_PROMPTS, GOLDEN_REPLAY, GOLDEN_SCREENS, GOLDEN_TURNS } from './golden-turns';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const goldenRoot = join(repoRoot, 'server', 'golden');
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function usage(message: string): never {
  process.stderr.write(`golden: ${message}\n`);
  process.stderr.write('usage: CAPTURE_WEB_PORT=49xx CAPTURE_CHROME_PORT=49yy pnpm golden take <dir>\n       pnpm golden diff <dirA> <dirB>\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Ports

function portsFromEnvironment(): { web: number; chrome: number } {
  const env = processEnvironment();
  const read = (name: string): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') usage(`${name} is not set: pick a port from 4900-4999 (capture's own defaults collide between builders)`);
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 4900 || port > 4999) usage(`${name}=${raw} is outside 4900-4999`);
    return port;
  };
  const web = read('CAPTURE_WEB_PORT');
  const chrome = read('CAPTURE_CHROME_PORT');
  if (web === chrome) usage('CAPTURE_WEB_PORT and CAPTURE_CHROME_PORT are the same port');
  return { web, chrome };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Running things

interface Ran {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function run(args: readonly string[], extraEnv: Readonly<Record<string, string>>, bin = 'pnpm'): Promise<Ran> {
  return new Promise((done) => {
    const child = spawnTracked(bin, args, undefined, { cwd: repoRoot, env: extraEnv });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.once('error', (error) => done({ code: null, out, err: `${err}${error.message}` }));
    child.once('close', (code) => done({ code, out, err }));
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('close', () => done());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  });
}

/** Text that goes into a manifest must not carry this machine's folders. */
function normalise(text: string, dirs: readonly string[]): string {
  let out = text.replaceAll('\r\n', '\n');
  for (const dir of [...dirs, repoRoot].sort((a, b) => b.length - a.length)) out = out.replaceAll(dir, '<dir>');
  return out;
}

/** A script that runs the real Chrome with software rendering (opt-in: it is no steadier than the GPU and four times slower). */
function softwareChrome(scratch: string): { bin: string; real: string } | null {
  const env = processEnvironment();
  const candidates = [env['CHROME_BIN'], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const real = candidates.find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path));
  if (real === undefined) return null;
  const bin = join(scratch, 'chrome-software.sh');
  const flags = '--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --disable-gpu-rasterization --force-color-profile=srgb --disable-lcd-text';
  writeFileSync(bin, `#!/bin/sh\nexec "${real}" "$@" ${flags}\n`, { mode: 0o755 });
  return { bin, real };
}

async function startWeb(port: number): Promise<ChildProcess> {
  const url = `http://127.0.0.1:${port}/explore.html`;
  if (await fetch(url).then((reply) => reply.ok).catch(() => false)) usage(`something already answers on port ${port}: pick another CAPTURE_WEB_PORT`);
  const child = spawnTracked('pnpm', ['--filter', '@conduit/web', 'exec', 'vite'], undefined, { cwd: repoRoot, env: { VITE_PORT: String(port), VITE_API: 'http://127.0.0.1:1' }, quiet: true });
  const until = Date.now() + 90_000;
  for (;;) {
    if (await fetch(url).then((reply) => reply.ok).catch(() => false)) return child;
    if (Date.now() > until) {
      await stop(child);
      throw new Error('timed out waiting for the web dev server');
    }
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// take

interface Entry {
  readonly sha256: string;
  readonly bytes: number;
  /** how a diff reads it: a picture is compared by pixels, the rest by lines */
  readonly kind: 'png' | 'json' | 'text';
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

interface TakeOptions {
  /** only these turn ids (and nothing but the pictures: no timeline, prompt or battery); null is everything */
  readonly only: readonly string[] | null;
  readonly screens: readonly string[];
}

async function take(outDir: string, options: TakeOptions): Promise<void> {
  const ports = portsFromEnvironment();
  const dir = resolve(outDir);
  if (existsSync(dir) && readdirSync(dir).length > 0) usage(`${dir} is not empty: a take goes in a new folder`);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const note = (text: string): void => void process.stdout.write(`${text}\n`);
  const entries: Record<string, Entry> = {};
  const put = (name: string, data: Buffer | string): void => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    const kind = name.endsWith('.png') ? 'png' : name.endsWith('.json') ? 'json' : 'text';
    entries[name] = { sha256: sha(data), bytes: Buffer.byteLength(data), kind };
  };
  const scratch = mkdtempSync(join(tmpdir(), 'conduit-golden-'));
  const web = await startWeb(ports.web);
  const workers = Math.max(1, Math.min(8, Number(processEnvironment()['GOLDEN_JOBS'] ?? 1) || 1, 4999 - ports.chrome + 1));
  if (ports.web >= ports.chrome && ports.web < ports.chrome + workers) usage(`CAPTURE_WEB_PORT ${ports.web} is among the Chrome ports ${ports.chrome}-${ports.chrome + workers - 1}`);
  const webUrl = `http://127.0.0.1:${ports.web}`;
  const soft = processEnvironment()['GOLDEN_SOFTWARE'] === '1' ? softwareChrome(scratch) : null;
  const chromeEnv: Record<string, string> = soft === null ? {} : { CHROME_BIN: soft.bin };
  const captureEnv = { CAPTURE_WEB_PORT: String(ports.web), CAPTURE_CHROME_PORT: String(ports.chrome), ...chromeEnv };
  const chromeVersion = soft === null ? 'gpu' : `software (${(await run(['--version'], {}, soft.real).catch(() => null))?.out.trim() ?? 'unknown'})`;
  try {
    note(`web server on ${ports.web}, Chrome on ${ports.chrome}${workers > 1 ? `-${ports.chrome + workers - 1}` : ''}; ${chromeVersion}`);
    let failures = 0;
    const jobs: { turn: (typeof GOLDEN_TURNS)[number]; screen: string }[] = [];
    for (const turn of GOLDEN_TURNS.filter((candidate) => options.only === null || options.only.includes(candidate.id))) {
      if (!existsSync(join(goldenRoot, 'logs', turn.log))) usage(`fixture missing: ${join(goldenRoot, 'logs', turn.log)} (the golden logs are the owner's own sessions and are not published: copy a session log of yours there and name its turns in golden-turns.ts)`);
      for (const screen of options.screens) jobs.push({ turn, screen });
    }
    // One capture at a time by default; `GOLDEN_JOBS=n` runs n at once, each with a Chrome of its own on its own port.
    const work = async (slot: number): Promise<void> => {
      for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
        const { turn, screen } = job;
        const log = join(goldenRoot, 'logs', turn.log);
        const into = join(scratch, `${turn.id}@${screen}`);
        const result = await run(['capture', log, turn.turn, '--screen', screen, '--debug', '--no-video', '--web', webUrl, '--out', into], { ...captureEnv, CAPTURE_CHROME_PORT: String(ports.chrome + slot) });
        const files = existsSync(into) ? readdirSync(into).sort() : [];
        const stem = `${turn.log.replace(/\.jsonl$/, '')}-${turn.turn}${screen === '1280x720' ? '' : `-${screen}`}`;
        let got = 0;
        for (const kind of ['strip.png', 'rest.png', 'debug.json']) {
          const file = files.find((name) => name === `${stem}.${kind}`);
          if (file === undefined) continue;
          put(`capture/${turn.id}@${screen}.${kind}`, readFileSync(join(into, file)));
          got += 1;
        }
        put(`capture/${turn.id}@${screen}.txt`, `${normalise(result.out, [into, scratch])}${result.code === 0 ? '' : `\n[exit ${String(result.code)}]\n${normalise(result.err, [into, scratch])}`}`);
        if (got !== 3 || result.code !== 0) {
          failures += 1;
          note(`  ${turn.id}@${screen}: FAILED (exit ${String(result.code)}, ${got}/3 files) ${result.err.trim().split('\n').slice(-1)[0] ?? ''}`);
        } else note(`  ${turn.id}@${screen}`);
      }
    }
    // One throwaway pair of captures first warms the dev server (modules transformed, fonts fetched), so that the first real picture
    // is drawn under the same conditions as the last.
    const first = jobs[0];
    if (first !== undefined) {
      for (let again = 0; again < 2; again += 1) await run(['capture', join(goldenRoot, 'logs', first.turn.log), first.turn.turn, '--debug', '--no-video', '--web', webUrl, '--out', join(scratch, 'warm')], captureEnv);
    }
    await Promise.all(Array.from({ length: workers }, (_, slot) => work(slot)));
    const partial = options.only !== null || options.screens.length !== GOLDEN_SCREENS.length;
    if (!partial) {

    // 2. The schedule: the language's own check over every example, demo and technique, then each demo as text.
    for (const [name, args] of [['all', ['timeline']], ...DEMOS.map((demo) => [demo.name, ['timeline', demo.name]] as const)] as readonly (readonly [string, readonly string[]])[]) {
      const result = await run(args, {});
      put(`timeline/${name}.txt`, `${normalise(result.out, [scratch])}[exit ${String(result.code)}]\n${normalise(result.err, [scratch])}`);
    }
    note(`  timeline: all + ${DEMOS.length} demos`);

    // 3. The brain's prompt, as bytes.
    for (const variant of GOLDEN_PROMPTS) {
      const result = await run(variant === '' ? ['prompt'] : ['prompt', variant], {});
      put(`prompt/${variant === '' ? 'full' : variant}.txt`, `${result.out}[exit ${String(result.code)}]\n${result.err}`);
    }
    note(`  prompt: ${GOLDEN_PROMPTS.length} variants`);

    // 4. The replay battery: a logged run laid out in every look, no model. It writes into the run folder, so it works on a copy.
    const runCopy = join(scratch, 'run');
    cpSync(join(goldenRoot, 'run'), runCopy, { recursive: true });
    const replay = await run(['explore', '--replay', runCopy, '--looks', GOLDEN_REPLAY.looks, '--screen', GOLDEN_REPLAY.screen, '--web', webUrl], chromeEnv);
    put('replay/stdout.txt', `${normalise(replay.out, [runCopy, scratch])}[exit ${String(replay.code)}]\n${normalise(replay.err, [runCopy, scratch])}`);
    for (const name of readdirSync(runCopy).filter((file) => file.startsWith('replay-') && file.endsWith('.json')).sort()) {
      put(`replay/${name}`, normalise(readFileSync(join(runCopy, name), 'utf8'), [runCopy, scratch]));
    }
    note(`  replay battery: exit ${String(replay.code)}`);
    if (replay.code !== 0) failures += 1;
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    const manifest = { version: 1, partial, commit: (await gitHead()) ?? 'unknown', seconds, chrome: chromeVersion, artefacts: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))) };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    note(`wrote ${Object.keys(entries).length} artefacts and manifest.json to ${dir} in ${seconds} s${failures > 0 ? `; ${failures} step(s) FAILED` : ''}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await stop(web);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function gitHead(): Promise<string | null> {
  const result = await run(['rev-parse', 'HEAD'], {}, 'git').catch(() => null);
  return result === null || result.code !== 0 ? null : result.out.trim();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// PNG: enough of the format to count differing pixels and write a picture (8-bit, not interlaced, which is all Chrome writes)

interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA */
  readonly data: Uint8Array;
}

function decodePng(file: Buffer): Raster {
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  const parts: Buffer[] = [];
  let palette: Buffer | null = null;
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body.readUInt8(8);
      colour = body.readUInt8(9);
      interlace = body.readUInt8(12);
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 0 ? 1 : colour === 4 ? 2 : colour === 3 ? 1 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${colour}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (row[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      const value = line[x] ?? 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[x] = (value + predicted) & 255;
    }
    previous = row;
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const p = i * channels;
    if (colour === 6) data.set(pixels.subarray(p, p + 4), i * 4);
    else if (colour === 2) data.set([pixels[p] ?? 0, pixels[p + 1] ?? 0, pixels[p + 2] ?? 0, 255], i * 4);
    else if (colour === 0) data.set([pixels[p] ?? 0, pixels[p] ?? 0, pixels[p] ?? 0, 255], i * 4);
    else if (colour === 4) data.set([pixels[p] ?? 0, pixels[p] ?? 0, pixels[p] ?? 0, pixels[p + 1] ?? 255], i * 4);
    else {
      const index = (pixels[p] ?? 0) * 3;
      data.set([palette?.[index] ?? 0, palette?.[index + 1] ?? 0, palette?.[index + 2] ?? 0, 255], i * 4);
    }
  }
  return { width, height, data };
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface PictureDiff {
  /** pixels that differ at all */
  readonly differing: number;
  /** pixels that differ by more than the tolerance in any channel */
  readonly over: number;
  /** the largest difference in any channel */
  readonly maxDelta: number;
  readonly total: number;
  readonly sizeA: string;
  readonly sizeB: string;
  /** the box that holds every differing pixel, when the sizes agree */
  readonly box: { x: number; y: number; width: number; height: number } | null;
  readonly image: Buffer | null;
}

function comparePictures(a: Buffer, b: Buffer, tolerance: number): PictureDiff {
  const one = decodePng(a);
  const two = decodePng(b);
  const sizeA = `${one.width}x${one.height}`;
  const sizeB = `${two.width}x${two.height}`;
  if (one.width !== two.width || one.height !== two.height) return { differing: Math.max(one.width * one.height, two.width * two.height), over: Math.max(one.width * one.height, two.width * two.height), maxDelta: 255, total: Math.max(one.width * one.height, two.width * two.height), sizeA, sizeB, box: null, image: null };
  const out = new Uint8Array(one.width * one.height * 4);
  let differing = 0;
  let over = 0;
  let maxDelta = 0;
  let x0 = one.width;
  let y0 = one.height;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < one.width * one.height; i += 1) {
    const p = i * 4;
    const same = one.data[p] === two.data[p] && one.data[p + 1] === two.data[p + 1] && one.data[p + 2] === two.data[p + 2] && one.data[p + 3] === two.data[p + 3];
    if (same) {
      // a washed-out copy of the picture, so the red shows where
      const grey = Math.round(((one.data[p] ?? 0) + (one.data[p + 1] ?? 0) + (one.data[p + 2] ?? 0)) / 3);
      const wash = Math.round(grey * 0.35 + 255 * 0.65);
      out.set([wash, wash, wash, 255], p);
    } else {
      differing += 1;
      const delta = Math.max(Math.abs((one.data[p] ?? 0) - (two.data[p] ?? 0)), Math.abs((one.data[p + 1] ?? 0) - (two.data[p + 1] ?? 0)), Math.abs((one.data[p + 2] ?? 0) - (two.data[p + 2] ?? 0)), Math.abs((one.data[p + 3] ?? 0) - (two.data[p + 3] ?? 0)));
      maxDelta = Math.max(maxDelta, delta);
      if (delta <= tolerance) {
        out.set([255, 200, 0, 255], p);
        continue;
      }
      over += 1;
      out.set([255, 0, 0, 255], p);
      const x = i % one.width;
      const y = Math.floor(i / one.width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { differing, over, maxDelta, total: one.width * one.height, sizeA, sizeB, box: differing === 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, image: differing === 0 ? null : encodePng({ width: one.width, height: one.height, data: out }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// diff

interface Manifest {
  readonly partial?: boolean;
  readonly commit: string;
  readonly chrome?: string;
  readonly artefacts: Readonly<Record<string, Entry>>;
}

function readManifest(dir: string): Manifest {
  const file = join(resolve(dir), 'manifest.json');
  if (!existsSync(file)) usage(`no manifest.json in ${dir}: is it a golden take?`);
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

/** The first line at which two texts differ, with a little of each. */
function firstTextDifference(a: string, b: string): string {
  const one = a.split('\n');
  const two = b.split('\n');
  const count = Math.max(one.length, two.length);
  for (let i = 0; i < count; i += 1) {
    if (one[i] !== two[i]) return `line ${i + 1}: ${JSON.stringify((one[i] ?? '<missing>').slice(0, 100))} became ${JSON.stringify((two[i] ?? '<missing>').slice(0, 100))}`;
  }
  return 'same lines';
}

function diff(dirA: string, dirB: string, tolerance: number): void {
  const a = readManifest(dirA);
  const b = readManifest(dirB);
  if (a.chrome !== b.chrome) process.stdout.write(`note: the takes used different Chrome: ${a.chrome ?? '?'} against ${b.chrome ?? '?'}; every picture may differ\n`);
  const names = [...new Set([...Object.keys(a.artefacts), ...Object.keys(b.artefacts)])].sort();
  const diffDir = join(resolve(dirB), 'diff');
  rmSync(diffDir, { recursive: true, force: true });
  let identical = 0;
  let noise = 0;
  let changed = 0;
  const lines: string[] = [];
  for (const name of names) {
    const was = a.artefacts[name];
    const is = b.artefacts[name];
    if ((was === undefined || is === undefined) && (a.partial === true || b.partial === true)) continue;
    if (was === undefined || is === undefined) {
      changed += 1;
      lines.push(`only in ${was === undefined ? 'B' : 'A'}  ${name}`);
      continue;
    }
    if (was.sha256 === is.sha256) {
      identical += 1;
      continue;
    }
    if (was.kind === 'png') {
      const result = comparePictures(readFileSync(join(resolve(dirA), name)), readFileSync(join(resolve(dirB), name)), tolerance);
      const where = result.box === null ? '' : `, in a box ${result.box.width}x${result.box.height} at ${result.box.x},${result.box.y}`;
      const shape = result.sizeA === result.sizeB ? '' : `, size ${result.sizeA} became ${result.sizeB}`;
      if (result.over === 0 && shape === '') {
        noise += 1;
        lines.push(`noise      ${name}: ${result.differing} of ${result.total} pixels differ, by at most ${result.maxDelta} of 255`);
        continue;
      }
      changed += 1;
      let image = '';
      if (result.image !== null) {
        const target = join(diffDir, name.replace(/\.png$/, '.diff.png'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, result.image);
        image = `  -> ${target}`;
      }
      lines.push(`changed    ${name}: ${result.over} of ${result.total} pixels differ by more than ${tolerance} (${((100 * result.over) / result.total).toFixed(3)}%; largest ${result.maxDelta})${where}${shape}${image}`);
    } else {
      changed += 1;
      lines.push(`changed    ${name}: ${firstTextDifference(readFileSync(join(resolve(dirA), name), 'utf8'), readFileSync(join(resolve(dirB), name), 'utf8'))}`);
    }
  }
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(`${identical} identical, ${noise} noise (within ${tolerance} of 255), ${changed} changed, of ${names.length} artefacts (A ${a.commit.slice(0, 7)}, B ${b.commit.slice(0, 7)})\n`);
  if (changed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------------------------------------------

try {
  const [command, one, two] = process.argv.slice(2);
  if (command === 'take' && one !== undefined) {
    const flags = process.argv.slice(2);
    const value = (name: string): string | null => {
      const at = flags.indexOf(name);
      return at < 0 ? null : (flags[at + 1] ?? usage(`${name} needs a value`));
    };
    const only = value('--only')?.split(',').filter((id) => id !== '') ?? null;
    const screens = value('--screens')?.split(',').filter((name) => name !== '') ?? GOLDEN_SCREENS;
    for (const id of only ?? []) if (!GOLDEN_TURNS.some((turn) => turn.id === id)) usage(`no turn ${id}: they are ${GOLDEN_TURNS.map((turn) => turn.id).join(', ')}`);
    for (const name of screens) if (!GOLDEN_SCREENS.includes(name)) usage(`no screen ${name}: they are ${GOLDEN_SCREENS.join(', ')}`);
    await take(one, { only, screens });
  }
  else if (command === 'diff' && one !== undefined && two !== undefined) {
    const at = process.argv.indexOf('--tolerance');
    const tolerance = at < 0 ? 2 : Number(process.argv[at + 1]);
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) usage('--tolerance is a whole number of levels, 0 to 255');
    diff(one, two, tolerance);
  }
  else usage('take <dir> [--only id,id] [--screens WxH,WxH] | diff <dirA> <dirB> [--tolerance n]');
} catch (error) {
  process.stderr.write(`golden: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

