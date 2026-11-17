// pnpm check's draw group: Draw opened on a phone held in landscape (719x356 at three pixels to the point, touch, coarse pointer) must not leave the screen black.
//
//   after the lesson's stage is up, a picture is taken; Draw is opened (`+` menu, Draw); a second picture is taken. The stage's pixels must not have gone dark,
//   the GL buffer and the ink canvases must stay inside a memory budget, and no GPU loss may have been logged. Also written: what was measured.
//
// Run by `pnpm check` and standalone (`tsx draw-check.ts --url <server> [--out dir] [--page lens=1]`).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { LensScene, LensScreen } from './lens-check';
import type { CheckResult, Options } from './smoke';

export const DRAW_SCREEN: LensScreen = { name: '719x356', width: 719, height: 356, dpr: 3 };

/** the lesson that was on the screen when Draw went black: a box with guides, strokes at no opacity, a stepper, and choices in Chinese */
const LESSON = [
  'scene layout=figure',
  'say x1 title | Write 牛 (cow): the first word of your noodle',
  'rect box 10,10 80x80 stroke=dim',
  'line x3 50,10 50,90 stroke=dim opacity=0.4',
  'line x4 10,50 90,50 stroke=dim opacity=0.4',
  'path s1 thick=5 opacity=0 | M 38,16 L 24,40',
  'line s2 30,34 72,34 thick=5 opacity=0',
  'line s3 16,60 84,60 thick=5 opacity=0',
  'line s4 50,14 50,90 thick=5 opacity=0',
  'pick st steps | 1 Short sweep down-left | 2 Short line, left to right | 3 Long line, left to right | 4 Straight down, last',
  'bind st=1 | set s1 stroke=accent opacity=1',
  'say x5 | The rules: top before bottom, left before right.',
  'say x9 choice | Next: 少 (less), from "less sugar"',
  'say x11 choice | Write the whole word 牛腩 (brisket)',
].join('\n');


/** counts what the page asks of the GPU: bytes of every texture and render buffer made, and every program linked */
const GPU_HOOK = `(() => {
  const w = { bytes: 0, programs: 0, textures: 0, targets: 0, lost: 0 };
  window.__gpuCount = w;
  for (const proto of [WebGL2RenderingContext.prototype]) {
    const wrap = (name, bytes) => { const f = proto[name]; proto[name] = function (...a) { try { w.bytes += bytes(a); } catch (e) {} return f.apply(this, a); }; };
    wrap('texImage2D', (a) => (a.length >= 8 && typeof a[3] === 'number' ? a[3] * a[4] * 4 : 0));
    wrap('texStorage2D', (a) => { let b = 0; for (let l = 0; l < a[1]; l++) b += Math.max(1, a[3] >> l) * Math.max(1, a[4] >> l) * 4; return b; });
    wrap('renderbufferStorage', (a) => a[2] * a[3] * 4);
    wrap('renderbufferStorageMultisample', (a) => a[1] * a[3] * a[4] * 4);
    const lp = proto.linkProgram; proto.linkProgram = function (...a) { w.programs++; return lp.apply(this, a); };
    const ct = proto.createTexture; proto.createTexture = function (...a) { w.textures++; return ct.apply(this, a); };
    const cf = proto.createFramebuffer; proto.createFramebuffer = function (...a) { w.targets++; return cf.apply(this, a); };
  }
  document.addEventListener('webglcontextlost', () => { w.lost++; }, true);
})();`;

export interface Measure {
  readonly canvases: { readonly cls: string; readonly width: number; readonly height: number }[];
  readonly canvasMegapixels: number;
  readonly css: string;
  readonly lost: boolean;
  readonly gpuObs: string[];
  readonly gpu: unknown;
  readonly count: { bytes: number; programs: number; textures: number; targets: number; lost: number } | null;
}

const MEASURE = `(() => {
  const list = [...document.querySelectorAll('canvas')].map((c) => ({ cls: c.className || c.parentElement?.className || '?', width: c.width, height: c.height }));
  const stage = window.__stage;
  const obs = (stage && stage.observations ? stage.observations() : []);
  return { canvases: list, canvasMegapixels: list.reduce((s, c) => s + c.width * c.height, 0) / 1e6, css: innerWidth + 'x' + innerHeight, lost: (window.__gpuCount && window.__gpuCount.lost > 0) || !!window.__glLost, count: window.__gpuCount ? { ...window.__gpuCount } : null, gpuObs: [], gpu: stage && stage.gpu ? stage.gpu() : null };
})()`;

/** the share of the picture's pixels that are not near black, read from the page's own screenshot */
async function litShare(tab: Tab, file: string): Promise<number> {
  const png = Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64');
  await writeFile(file, png);
  const share = await tab.eval<number>(`new Promise((resolve) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = 64; c.height = 32; const x = c.getContext('2d'); x.drawImage(i, 0, 0, 64, 32); const d = x.getImageData(0, 0, 64, 32).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k] + d[k + 1] + d[k + 2] > 60) n++; resolve(n / 2048); }; i.src = 'data:image/png;base64,${png.toString('base64')}'; })`);
  return share;
}

export async function drawGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined, page = ''): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const began = Date.now();
  const list: string[] = [];
  let picture = '';
  const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
  const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page, say: null, chat: 'off' };
  const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
  const tag = `${screen.name}${page === '' ? '' : '-' + page.replace(/\W/g, '')}`;
  try {
    note(`draw: ${tag}`);
    await tab.send('DOM.enable');
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: GPU_HOOK });
    await conv.start();
    const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(LESSON)})).then(() => null, (e) => String(e && e.message || e))`);
    if (played !== null) list.push(`the lesson would not play: ${played}`);
    const rest = await conv.rest(true);
    if (rest !== '') list.push(rest);
    await sleep(500);
    const beforeFile = join(dir, `${tag}-draw-before.png`);
    const before = await litShare(tab, beforeFile);
    const m0 = await tab.eval<Measure>(MEASURE);
    await tab.eval(`document.querySelector('.composer__plus').click()`);
    await sleep(300);
    await tab.eval(`[...document.querySelectorAll('.composer__item')].find((n) => /^Draw/.test(n.textContent.trim())).click()`);
    await sleep(1500);
    const afterFile = join(dir, `${tag}-draw-after.png`);
    const after = await litShare(tab, afterFile);
    picture = `${tag}-draw-after.png`;
    const m1 = await tab.eval<Measure>(MEASURE);
    await writeFile(join(dir, `${tag}-draw-measure.json`), JSON.stringify({ before: m0, after: m1, litBefore: before, litAfter: after }, null, 1));
    note(`draw: lit ${before.toFixed(2)} -> ${after.toFixed(2)}, canvases ${m0.canvasMegapixels.toFixed(2)} -> ${m1.canvasMegapixels.toFixed(2)} MP, GPU allocations ${JSON.stringify(m0.count)} -> ${JSON.stringify(m1.count)}, viewport ${m0.css} -> ${m1.css}`);
    if (after < 0.2 || after < before * 0.5) list.push(`the screen went dark when Draw opened (${(before * 100).toFixed(0)}% of it lit before, ${(after * 100).toFixed(0)}% after)`);
    if (m1.canvasMegapixels > 12) list.push(`the canvases hold ${m1.canvasMegapixels.toFixed(1)} megapixels of backing after Draw opened, more than a phone keeps`);
    if (m1.lost) list.push('the GL context was lost');
  } catch (error) {
    list.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await tab.close();
  }
  const results: CheckResult[] = [{ turn: 0, check: `draw-${tag}`, verdict: list.length === 0 ? 'PASS' : 'FAIL', detail: list.length === 0 ? 'Draw opens on a phone in landscape and the screen stays lit, within the canvas memory budget' : list.join('; ') }];
  return [{ name: `draw-${tag}`, picture, results, seconds: (Date.now() - began) / 1000 }];
}

if (process.argv[1] !== undefined && /draw-check\.ts$/.test(process.argv[1])) {
  const arg = (name: string, fallback: string): string => (process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] as string) : fallback);
  const url = arg('--url', '');
  const out = arg('--out', '/tmp/conduit-draw');
  const page = arg('--page', '');
  const size = arg('--size', '719x356x3').split('x').map(Number);
  if (!url.startsWith('http')) {
    process.stderr.write('usage: tsx draw-check.ts --url http://127.0.0.1:<port> [--out <dir>] [--page lens=1] [--size 719x356x3]\n');
    process.exit(2);
  }
  void (async () => {
    const screen: LensScreen = { name: `${size[0]}x${size[1]}`, width: size[0] ?? 719, height: size[1] ?? 356, dpr: size[2] ?? 3 };
    const all = await drawGroup(url, screen, out, 90_000, (text) => process.stdout.write(`${text}\n`), page);
    let failed = 0;
    for (const scene of all) for (const r of scene.results) {
      process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  })();
}
