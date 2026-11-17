// pnpm webkit-check: the bugs that only Safari had. `pnpm check` drives headless Chrome; three real bugs were WebKit-only and so were invisible to it. This pass drives
// Playwright's WebKit (desktop WebKit with a phone's emulation: isMobile, touch, three pixels to the point) at an iPhone in landscape (719x356), an iPhone upright
// (390x844) and an iPad (820x971 at two), and judges, from the page's own pixels:
//
//   welcome   the stage holds real ink (a share of its pixels unlike the background, spread over its height), not one stray mark
//   scripts   the `scripts` demo plus Japanese and Korean: each line's box has ink, and the characters of the Han, Japanese and Korean lines are distinct glyphs
//             (a "?" or a missing-glyph box is the same picture in every cell)
//   draw      the + menu, Draw: the stage is not dark afterwards (mean luminance and ink share before and after), and one stroke is written and shows
//   ask       a touch tap on an `ask` blank has its input focused inside the gesture (iOS's own keyboard cannot appear in desktop WebKit: the focus is what raises it)
//
// Not run by CI yet (it needs the WebKit browser: `pnpm exec playwright-core install webkit`, about 100 MB). It skips with a message when the browser is not installed.
// Run by `pnpm check --webkit` and standalone: `pnpm webkit-check [--url <server>] [--out <dir>] [--only welcome,scripts,draw,ask] [--screens 719x356x3,390x844x3,820x971x2]`.
// Standalone it starts its own server from the build (BRAIN=replay, a throwaway DATA_DIR under WEBKIT_CHECK_TMP or the system's temp folder, WEBKIT_PORT or a free port).

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { spawnTracked } from '../brains/claude-cli/process';
import { sleep, stop, waitFor } from './explore-browser';
import type { CheckResult } from './smoke';

export interface WebkitScreen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** an iPhone in landscape, an iPhone upright, an iPad */
export const WEBKIT_SCREENS: readonly WebkitScreen[] = [
  { name: '719x356', width: 719, height: 356, dpr: 3 },
  { name: '390x844', width: 390, height: 844, dpr: 3 },
  { name: '820x971', width: 820, height: 971, dpr: 2 },
];

export interface WebkitScene {
  readonly name: string;
  readonly picture: string;
  readonly results: readonly CheckResult[];
  readonly seconds: number;
}

/** why the WebKit pass cannot run here, or null when it can */
export function webkitMissing(): string | null {
  let path = '';
  try {
    path = webkit.executablePath();
  } catch (error) {
    return `Playwright could not say where WebKit is (${error instanceof Error ? error.message : String(error)})`;
  }
  return path !== '' && existsSync(path) ? null : 'the WebKit browser is not installed: run "pnpm --filter @conduit/server exec playwright-core install webkit" (about 100 MB, once)';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What is read from pictures (decoded in a blank page of the same browser: no image library)

interface Cells {
  readonly lum: number;
  readonly ink: number;
  readonly bands: number;
  readonly cells: number[][];
  readonly width: number;
  readonly height: number;
}

/** In the page: the picture's mean luminance (0..1), the share of pixels unlike its most common colour, how many of eight horizontal bands hold ink, and `n` cells across its ink, each as a 10x10 grey signature */
const PIXELS = `async ({ png, n }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const w = c.width, h = c.height, d = x.getImageData(0, 0, w, h).data;
  const votes = new Map();
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  let best = 0, bk = 0;
  for (const [k, v] of votes) if (v > best) { best = v; bk = k; }
  const br = ((bk >> 8) & 15) * 16 + 8, bg = ((bk >> 4) & 15) * 16 + 8, bb = (bk & 15) * 16 + 8;
  let ink = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
  const bandHit = new Array(8).fill(0);
  const isInk = (i) => Math.max(Math.abs(d[i] - br), Math.abs(d[i + 1] - bg), Math.abs(d[i + 2] - bb)) > 56;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    if (!isInk((yy * w + xx) * 4)) continue;
    ink++; bandHit[Math.min(7, Math.floor((yy * 8) / h))] = 1;
    if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
  }
  const cells = [];
  if (ink > 0 && n > 0) {
    const cw = (x1 - x0 + 1) / n, ch = y1 - y0 + 1;
    for (let k = 0; k < n; k++) {
      const sig = [];
      for (let gy = 0; gy < 10; gy++) for (let gx = 0; gx < 10; gx++) {
        let s = 0, m = 0;
        const sx0 = Math.floor(x0 + k * cw + (gx * cw) / 10), sx1 = Math.max(sx0 + 1, Math.floor(x0 + k * cw + ((gx + 1) * cw) / 10));
        const sy0 = Math.floor(y0 + (gy * ch) / 10), sy1 = Math.max(sy0 + 1, Math.floor(y0 + ((gy + 1) * ch) / 10));
        for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { const i = (yy * w + xx) * 4; if (isInk(i)) s++; m++; }
        sig.push(m === 0 ? 0 : s / m);
      }
      cells.push(sig);
    }
  }
  return { lum: sum / (w * h) / 255, ink: ink / (w * h), bands: bandHit.reduce((a, b) => a + b, 0), cells, width: w, height: h };
}`;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

class Eyes {
  constructor(private readonly util: Page) {}

  async look(page: Page, clip: Box | null, file: string | null, cells = 0): Promise<Cells> {
    const buffer = await page.screenshot(clip === null ? {} : { clip });
    if (file !== null) await writeFile(file, buffer);
    return this.util.evaluate(`(${PIXELS})(${JSON.stringify({ png: buffer.toString('base64'), n: cells })})`) as Promise<Cells>;
  }
}

/** the least difference between any two cells' signatures, 0 (the same picture) to 1 */
function leastDifference(cells: readonly number[][]): number {
  let least = 1;
  for (let a = 0; a < cells.length; a += 1) {
    for (let b = a + 1; b < cells.length; b += 1) {
      const x = cells[a] as number[];
      const y = cells[b] as number[];
      let diff = 0;
      for (let i = 0; i < x.length; i += 1) diff += Math.abs((x[i] as number) - (y[i] as number));
      least = Math.min(least, diff / x.length);
    }
  }
  return least;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The page

interface Seen {
  readonly id: string;
  readonly text: string;
  readonly box: Box;
  readonly phase: string;
}

/** waits for the stage to be mounted and its frame to come to rest: no turn open, no glyphs still being typeset, the elements unchanged for a while */
async function rest(page: Page, what: string, ms = 60_000): Promise<void> {
  await page.evaluate('window.__stage.ready');
  let last = '';
  let since = Date.now();
  const until = Date.now() + ms;
  for (;;) {
    await sleep(250);
    const sig = (await page.evaluate(`(() => { const s = window.__stage.state(); return JSON.stringify([s.turn, s.clock, s.elements.map((e) => [e.id, e.phase, Math.round(e.box.x), Math.round(e.box.y)])]); })()`)) as string;
    const quiet = JSON.parse(sig)[0] === null && JSON.parse(sig)[1] !== 'holding';
    if (sig !== last || !quiet) {
      last = sig;
      since = Date.now();
    }
    if (quiet && Date.now() - since > 1500) return;
    if (Date.now() > until) throw new Error(`${what}: the stage did not come to rest in ${(ms / 1000).toFixed(0)} s`);
  }
}

const play = (page: Page, script: string): Promise<string | null> =>
  page.evaluate(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`) as Promise<string | null>;

const stageRect = (page: Page): Promise<Box> =>
  page.evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`) as Promise<Box>;

const elementsOf = (page: Page): Promise<Seen[]> => page.evaluate(`window.__stage.elements().map((e) => ({ id: e.id, text: e.text, box: e.box, phase: e.phase }))`) as Promise<Seen[]>;

/** the ink the stage's own element boxes are in client pixels from the stage's origin, clipped to what the screen shows */
function clipTo(box: Box, origin: Box, screen: WebkitScreen, pad = 3): Box | null {
  const x = Math.max(0, origin.x + box.x - pad);
  const y = Math.max(0, origin.y + box.y - pad);
  const right = Math.min(screen.width, origin.x + box.x + box.width + pad);
  const bottom = Math.min(screen.height, origin.y + box.y + box.height + pad);
  return right - x < 4 || bottom - y < 4 ? null : { x, y, width: right - x, height: bottom - y };
}

const result = (check: string, problems: readonly string[], good: string): CheckResult => ({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });

// ---------------------------------------------------------------------------------------------------------------------------------
// The scenes

const SCRIPTS_DEMO = (): string => readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/scripts.series')), 'utf8');

/** the lines of the scripts demo that must have ink, and the ones whose characters must be distinct glyphs (id -> how many characters) */
const SCRIPT_LINES = ['pl', 'vi', 'el', 'ru', 'ar', 'he', 'hi', 'th', 'zh', 'mix'];
const GLYPH_LINES: Readonly<Record<string, number>> = { zh: 4, ja: 5, ko: 5 };
const CJK = ['scene stack lines=4 calm steady', 'say ja | こんにちは世界', 'say ko | 안녕하세요'].join('\n');

/** a lesson with a drawn figure on it: Draw is opened over this */
const LESSON = [
  'scene layout=figure',
  'say x1 title | Write 牛 (cow): the first word of your noodle',
  'rect box 10,10 80x80 stroke=dim',
  'line x3 50,10 50,90 stroke=dim opacity=0.4',
  'line x4 10,50 90,50 stroke=dim opacity=0.4',
  'say x5 | The rules: top before bottom, left before right.',
  'say x9 choice | Next: 少 (less), from "less sugar"',
].join('\n');

/** a chain of asks, as ask-check.ts plays it */
const CHAIN = [
  'scene layout=stack mood=calm',
  'say x1 | 4x + 3 = 23',
  'say x2 | take 3 from both sides',
  'ask w1 is=20,4x=20 stage=1 | 4x = __',
  'hint in=w1 stage=yes | What is 23 take away 3?',
].join('\n');

interface Run {
  readonly base: string;
  readonly screen: WebkitScreen;
  readonly dir: string;
  readonly context: BrowserContext;
  readonly eyes: Eyes;
  readonly timeoutMs: number;
}

async function open(run: Run, query: string): Promise<{ page: Page; faults: string[] }> {
  const page = await run.context.newPage();
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(`error: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && faults.push(`console: ${message.text()}`));
  await page.goto(`${run.base}/${query}`, { waitUntil: 'load', timeout: 60_000 });
  await waitFor('the stage', 60_000, async () => ((await page.evaluate('!!window.__stage && !!document.getElementById("stage")')) === true ? true : null));
  return { page, faults };
}

async function welcome(run: Run): Promise<WebkitScene> {
  const began = Date.now();
  const problems: string[] = [];
  const picture = `${run.screen.name}-welcome.png`;
  const { page } = await open(run, '');
  try {
    await rest(page, 'the welcome', run.timeoutMs);
    const rect = await stageRect(page);
    const look = await run.eyes.look(page, rect, join(run.dir, picture));
    const words = (await elementsOf(page)).filter((e) => e.text !== '').length;
    if (look.ink < 0.008) problems.push(`the welcome's stage is nearly empty: ${(look.ink * 100).toFixed(2)}% of its pixels differ from the background`);
    if (look.bands < 3) problems.push(`the welcome's ink reaches only ${look.bands} of 8 bands down the stage`);
    if (words < 3) problems.push(`only ${words} words on stage`);
    return { name: `welcome-${run.screen.name}`, picture, seconds: (Date.now() - began) / 1000, results: [result('webkit-welcome', problems, `the welcome has ink on its stage (${(look.ink * 100).toFixed(1)}% of pixels, ${look.bands} of 8 bands, ${words} words)`)] };
  } finally {
    await page.close();
  }
}

async function scripts(run: Run): Promise<WebkitScene> {
  const began = Date.now();
  const problems: string[] = [];
  const picture = `${run.screen.name}-scripts.png`;
  const notes: string[] = [];
  let judged = 0;
  let skipped = 0;
  const { page } = await open(run, '?demo=none');
  try {
    const judge = async (ids: readonly string[], tag: string, file: string | null): Promise<void> => {
      const rect = await stageRect(page);
      if (file !== null) await page.screenshot({ path: join(run.dir, file), clip: rect });
      const seen = await elementsOf(page);
      for (const id of ids) {
        const element = seen.find((e) => e.id === id);
        // on a short screen the stack scrolls its first lines away ("earlier (3)"): a line that is not in view is not judged, but the Han line must be
        const clip = element === undefined ? null : clipTo(element.box, rect, run.screen);
        if (element === undefined || clip === null) {
          if (id in GLYPH_LINES) problems.push(`${tag}: the line "${id}" is not on the screen`);
          else skipped += 1;
          continue;
        }
        judged += 1;
        const n = GLYPH_LINES[id] ?? 0;
        const look = await run.eyes.look(page, clip, null, n);
        // a line of words has ink in a box this size: a missing script is blank, a missing glyph a faint box or nothing
        if (look.ink < 0.004) problems.push(`${tag}: "${id}" (${element.text}) has no ink in its box (${(look.ink * 100).toFixed(2)}%)`);
        if (n > 0) {
          if (look.cells.length !== n) problems.push(`${tag}: "${id}" gave no cells to compare`);
          else {
            const least = leastDifference(look.cells);
            notes.push(`${id} ${least.toFixed(2)}`);
            if (least < 0.02) problems.push(`${tag}: the characters of "${id}" (${element.text}) are all the same picture (least difference ${least.toFixed(3)}): "?" or missing-glyph boxes`);
          }
        }
      }
    };
    const played = await play(page, SCRIPTS_DEMO());
    if (played !== null) problems.push(`the scripts demo would not play: ${played}`);
    await rest(page, 'the scripts demo', run.timeoutMs);
    await judge(SCRIPT_LINES, 'scripts', picture);
    const jp = await play(page, CJK);
    if (jp !== null) problems.push(`the Japanese and Korean lines would not play: ${jp}`);
    await rest(page, 'the Japanese and Korean lines', run.timeoutMs);
    await judge(['ja', 'ko'], 'cjk', `${run.screen.name}-scripts-cjk.png`);
    if (judged < 6) problems.push(`only ${judged} lines were in view to judge`);
    return { name: `scripts-${run.screen.name}`, picture, seconds: (Date.now() - began) / 1000, results: [result('webkit-scripts', problems, `every script line in view has ink (${judged} judged, ${skipped} scrolled away) and the Han, Japanese and Korean characters are distinct glyphs (least difference per line: ${notes.join(', ')})`)] };
  } finally {
    await page.close();
  }
}

async function draw(run: Run): Promise<WebkitScene> {
  const began = Date.now();
  const problems: string[] = [];
  const picture = `${run.screen.name}-draw-after.png`;
  const { page } = await open(run, '?demo=none');
  let after: Cells | null = null;
  try {
    const played = await play(page, LESSON);
    if (played !== null) problems.push(`the lesson would not play: ${played}`);
    await rest(page, 'the lesson', run.timeoutMs);
    const rect = await stageRect(page);
    const before = await run.eyes.look(page, rect, join(run.dir, `${run.screen.name}-draw-before.png`));
    await page.evaluate(`document.querySelector('.composer__plus').click()`);
    await sleep(300);
    await page.evaluate(`[...document.querySelectorAll('.composer__item')].find((n) => /^Draw/.test(n.textContent.trim())).click()`);
    await sleep(1500);
    after = await run.eyes.look(page, rect, join(run.dir, picture));
    const gpu = (await page.evaluate(`JSON.stringify(window.__stage.gpu())`)) as string;
    const lumNote = `renderer ${(JSON.parse(gpu) as { renderer?: string } | null)?.renderer ?? 'none (no GPU)'}, luminance ${before.lum.toFixed(2)} -> ${after.lum.toFixed(2)}, ink ${(before.ink * 100).toFixed(1)}% -> ${(after.ink * 100).toFixed(1)}%`;
    // a black screen is uniform: its ink share goes to nothing, and (on a light stage) its luminance falls away
    if (before.ink < 0.005) problems.push(`the lesson showed nothing before Draw (${lumNote})`);
    if (after.lum < before.lum * 0.5 && after.lum < 0.15) problems.push(`the stage went dark when Draw opened (${lumNote})`);
    if (after.ink < before.ink * 0.5) problems.push(`the stage lost its ink when Draw opened (${lumNote})`);
    const open = (await page.evaluate(`!!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden && !document.querySelector('.ink-stage').classList.contains('ink-stage--through')`)) as boolean;
    if (!open) problems.push('Draw did not open');
    // one stroke, a diagonal across the middle third of the stage: it is in the document and in the picture
    const strokes = (): Promise<number> => page.evaluate(`(window.__inkDoc ? window.__inkDoc() : { strokes: [] }).strokes.length`) as Promise<number>;
    const n0 = await strokes();
    const a = { x: rect.x + rect.width * 0.3, y: rect.y + rect.height * 0.35 };
    const b = { x: rect.x + rect.width * 0.7, y: rect.y + rect.height * 0.65 };
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 16; i += 1) {
      await page.mouse.move(a.x + ((b.x - a.x) * i) / 16, a.y + ((b.y - a.y) * i) / 16);
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(500);
    const n1 = await strokes();
    const written = await run.eyes.look(page, rect, join(run.dir, `${run.screen.name}-draw-stroke.png`));
    if (n1 !== n0 + 1) problems.push(`one stroke was drawn and the ink document holds ${n1 - n0} new`);
    if (written.ink <= after.ink * 1.002 && written.ink - after.ink < 0.001) problems.push(`the stroke does not show: ink ${(after.ink * 100).toFixed(2)}% before it, ${(written.ink * 100).toFixed(2)}% after`);
    return { name: `draw-${run.screen.name}`, picture, seconds: (Date.now() - began) / 1000, results: [result('webkit-draw', problems, `Draw opens and the stage stays lit (${lumNote}), and a stroke shows (ink ${(after.ink * 100).toFixed(1)}% -> ${(written.ink * 100).toFixed(1)}%)`)] };
  } finally {
    await page.close();
  }
}

async function ask(run: Run): Promise<WebkitScene> {
  const began = Date.now();
  const problems: string[] = [];
  const picture = `${run.screen.name}-ask.png`;
  const { page } = await open(run, '?demo=none');
  try {
    const played = await play(page, CHAIN);
    if (played !== null) problems.push(`the chain would not play: ${played}`);
    await rest(page, 'the ask', run.timeoutMs);
    const field = (await page.evaluate(`(() => { const c = window.__stage.controls().find((k) => k.id === 'w1'); const f = c && c.parts.find((p) => p.part === 'field'); return f ? f.box : null; })()`)) as Box | null;
    if (field === null) throw new Error('no blank for w1 on stage');
    const rect = await stageRect(page);
    const at = { x: rect.x + field.x + field.width / 2, y: rect.y + field.y + field.height / 2 };
    // what was focused when each end of the gesture had been handled: a phone raises its keyboard only for a focus made inside the gesture
    await page.evaluate(`window.__upFocus = []; for (const type of ['pointerup', 'touchend', 'click']) document.addEventListener(type, () => { const a = document.activeElement; const h = a && a.tagName === 'INPUT' ? a.closest('[data-control]') : null; window.__upFocus.push(type + ':' + (h ? h.dataset.control : '')); }, true);`);
    await page.touchscreen.tap(at.x, at.y);
    await sleep(400);
    const seen = (await page.evaluate('window.__upFocus')) as string[];
    const now = (await page.evaluate(`(() => { const a = document.activeElement; if (!a || a.tagName !== 'INPUT') return ''; const h = a.closest('[data-control]'); return h ? h.dataset.control : 'other-input'; })()`)) as string;
    await page.screenshot({ path: join(run.dir, picture), clip: rect });
    if (now !== 'w1') problems.push(`a touch tap on the blank focused "${now || 'nothing'}": no keyboard would open`);
    else if (!seen.some((s) => s.endsWith(':w1') && !s.startsWith('click:'))) problems.push(`the focus came after the tap, not inside it (focus at each event: ${seen.join(', ') || 'no event seen'})`);
    return { name: `ask-${run.screen.name}`, picture, seconds: (Date.now() - began) / 1000, results: [result('webkit-ask', problems, `a touch tap on the blank focused its input inside the gesture (${seen.join(', ')})`)] };
  } finally {
    await page.close();
  }
}

const SCENES = { welcome, scripts, draw, ask } as const;
type SceneName = keyof typeof SCENES;

/** Runs the WebKit scenes at every screen. A failure is a `FAIL` result, never a throw (except that WebKit could not start at all). */
export async function webkitGroup(base: string, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined, screens: readonly WebkitScreen[] = WEBKIT_SCREENS, only: readonly SceneName[] = ['welcome', 'scripts', 'draw', 'ask']): Promise<WebkitScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: WebkitScene[] = [];
  const browser: Browser = await webkit.launch({ headless: true });
  try {
    for (const screen of screens) {
      const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.dpr, isMobile: true, hasTouch: true });
      const util = await context.newPage();
      await util.goto('about:blank');
      const run: Run = { base, screen, dir, context, eyes: new Eyes(util), timeoutMs };
      try {
        for (const name of only) {
          note(`webkit: ${name} at ${screen.name}`);
          const began = Date.now();
          try {
            scenes.push(await SCENES[name](run));
          } catch (error) {
            scenes.push({ name: `${name}-${screen.name}`, picture: '', seconds: (Date.now() - began) / 1000, results: [{ turn: 0, check: `webkit-${name}`, verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? error.message : String(error)}` }] });
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return scenes;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Standalone

async function freePort(): Promise<number> {
  const wanted = Number(process.env['WEBKIT_PORT'] ?? 0);
  return new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(wanted, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

/** the server from the current build, as `pnpm check` starts it: BRAIN=replay, a data folder of its own, stopped by the handle */
async function startServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('there is no build to check: run "pnpm build" first (or pass --url of a running server)');
  const base = process.env['WEBKIT_CHECK_TMP'] ?? tmpdir();
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'conduit-webkit-'));
  await mkdir(join(scratch, 'skills'), { recursive: true });
  const port = await freePort();
  let log = '';
  const child = spawnTracked(process.execPath, ['--import', 'tsx', 'src/main.ts'], undefined, {
    cwd: join(root, 'server'),
    env: { NODE_ENV: 'production', BRAIN: 'replay', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: join(scratch, 'data'), SKILL_ROOTS: join(scratch, 'skills'), LIBRARY: 'seed', READ_LINKS: 'off', LOG_LEVEL: 'warn', REPLAY_CPS: '3000' },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => (log = (log + chunk.toString()).slice(-4000)));
  const url = `http://127.0.0.1:${port}`;
  const stopAll = async (): Promise<void> => {
    await stop(child);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitFor('the server', 60_000, async () => {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}:\n${log}`);
      return (await fetch(`${url}/api/health`)).ok ? true : null;
    });
  } catch (error) {
    await stopAll();
    throw new Error(`the server did not start: ${error instanceof Error ? error.message : String(error)}\n${log}`);
  }
  return { url, stop: stopAll };
}

/** prints a group's results the way `pnpm check` does; returns how many failed */
export function printWebkit(scenes: readonly WebkitScene[], write: (text: string) => void): number {
  let failed = 0;
  for (const scene of scenes) {
    for (const r of scene.results) {
      write(`  ${r.verdict === 'PASS' ? 'ok  ' : r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
  }
  return failed;
}

if (process.argv[1] !== undefined && /webkit-check\.ts$/.test(process.argv[1])) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  void (async () => {
    const missing = webkitMissing();
    if (missing !== null) {
      process.stdout.write(`webkit-check: SKIPPED, ${missing}\n`);
      process.exit(0);
    }
    const out = resolve(arg('--out') ?? join(tmpdir(), 'conduit-webkit', new Date().toISOString().replace(/[:.]/g, '-')));
    const screens = arg('--screens') === undefined ? WEBKIT_SCREENS : (arg('--screens') as string).split(',').map((text) => {
      const [width = 0, height = 0, dpr = 2] = text.split('x').map(Number);
      return { name: `${width}x${height}`, width, height, dpr };
    });
    const only = (arg('--only')?.split(',') ?? ['welcome', 'scripts', 'draw', 'ask']) as SceneName[];
    const given = arg('--url');
    let server: { url: string; stop: () => Promise<void> } | null = null;
    let failed = 0;
    const done = async (): Promise<void> => {
      const running = server;
      server = null;
      await running?.stop();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void done().finally(() => process.exit(2)));
    try {
      server = given === undefined ? await startServer() : null;
      const base = (given ?? (server as { url: string } | null)?.url ?? '').replace(/\/+$/, '');
      process.stdout.write(`webkit-check: ${base}${given === undefined ? ' (started here, BRAIN=replay)' : ''}, pictures in ${out}\n`);
      const scenes = await webkitGroup(base, out, 90_000, (text) => process.stdout.write(`[${text}]\n`), screens, only);
      failed = printWebkit(scenes, (text) => process.stdout.write(text));
    } catch (error) {
      failed += 1;
      process.stdout.write(`webkit-check: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      await done();
    }
    process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${failed === 0 ? 'WebKit shows the welcome, every script, Draw and the ask blank' : `${failed} problem${failed === 1 ? '' : 's'}`} (pictures in ${out})\n`);
    process.exit(failed === 0 ? 0 : 1);
  })();
}
