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
import { Hands, line } from './lens-check';
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
    // the bar opened from its pen button (it starts folded on a short screen): how much of the stage it takes is what this picture is for
    const opened = await tab.eval<boolean>(`(() => { const pill = document.querySelector('.ink-btn--pill'); if (!pill || pill.hidden) return false; pill.click(); return true; })()`);
    if (opened) {
      await sleep(400);
      await writeFile(join(dir, `${tag}-draw-open.png`), Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64'));
    }
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


/** The two screens the taps in Draw are looked at: an iPad held across (a Pencil and a finger), and a phone upright (a finger and a mouse only). */
export const DRAW_TAP_SCREENS: readonly LensScreen[] = [
  { name: '1180x820', width: 1180, height: 820, dpr: 2 },
  { name: '390x844', width: 390, height: 844, dpr: 3 },
];

const CHOICES = ['scene layout=stack mood=calm', 'say x1 title | Pick one', 'say x2 choice | The first', 'say x3 choice | The second'].join('\n');

/**
 * fb-103. In Draw the page under the ink can still be used. With a Pencil seen: the Pencil draws and a finger taps through (a choice's tap is sent, no stroke is added); a Pencil tap on
 * a choice presses it, and a Pencil tap on nothing is a dot. With a finger or a mouse only: the hand tool in the ink bar pauses drawing, a mouse click on a choice works and the
 * ink is kept; a pen tool brings drawing back.
 */
export async function drawTapGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const began = Date.now();
  const list: string[] = [];
  const pictures: string[] = [];
  const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
  const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
  const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
  const hands = new Hands(tab);
  const taps = (): number => tab.posted.filter((turn) => turn.kind === 'tap').length;
  const strokes = async (): Promise<number> => (await hands.strokes())?.strokes.length ?? 0;
  const shot = (name: string): Promise<void> => snap(tab, dir, name, pictures);
  const choice = async (id: string): Promise<{ x: number; y: number }> => {
    const box = await tab.eval<{ x: number; y: number; width: number; height: number } | null>(`(() => { const e = window.__stage.elements().find((n) => n.id === ${JSON.stringify(id)}); return e ? e.box : null; })()`);
    if (box === null) throw new Error(`no element ${id} on the stage`);
    return hands.onScreen({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  };
  const play = async (): Promise<void> => {
    const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(CHOICES)})).then(() => null, (e) => String(e && e.message || e))`);
    if (played !== null) throw new Error(`the choices would not play: ${played}`);
    const rest = await conv.rest(true);
    if (rest !== '') throw new Error(rest);
    await sleep(400);
  };
  const openDraw = async (): Promise<void> => {
    await tab.eval(`document.querySelector('.composer__plus').click()`);
    await sleep(300);
    await tab.eval(`[...document.querySelectorAll('.composer__item')].find((n) => /^Draw/.test(n.textContent.trim())).click()`);
    await sleep(600);
  };
  /** the bar open (it starts folded on a phone) */
  const barOpen = async (): Promise<void> => {
    await tab.eval(`(() => { const pill = document.querySelector('.ink-stage .ink-btn--pill'); if (pill && !pill.hidden) pill.click(); })()`);
    await sleep(200);
  };
  try {
    note(`draw taps: ${screen.name}`);
    await tab.send('DOM.enable');
    await conv.start();
    // ------------------------------------------------------------------------------------------------ a Pencil seen: it draws, a finger taps through, a Pencil tap presses
    await play();
    await openDraw();
    const empty = { x: Math.round(screen.width * 0.5), y: Math.round(screen.height * 0.82) };
    const drawn0 = await strokes();
    await hands.pen(line({ x: empty.x - 60, y: empty.y }, { x: empty.x + 60, y: empty.y - 20 }, 10));
    if ((await strokes()) !== drawn0 + 1) list.push(`the Pencil's stroke in Draw left ${(await strokes()) - drawn0} stroke(s), wanted 1`);
    await sleep(600);
    await barOpen();
    await shot(`${screen.name}-draw-pen-seen.png`);
    const before = taps();
    await hands.finger([await choice('x2')]);
    await sleep(500);
    if (taps() !== before + 1) list.push(`in Draw, with a Pencil seen, a finger tap on a choice sent ${taps() - before} tap turn(s), wanted 1`);
    if ((await strokes()) !== drawn0 + 1) list.push(`a finger tap on a choice in Draw added ${(await strokes()) - drawn0 - 1} stroke(s), wanted none`);
    await conv.rest(null, false).catch(() => '');
    await play();
    const drawing = await tab.eval<boolean>(`!!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden`);
    if (!drawing) list.push('the ink layer is not on screen after a choice was tapped');
    const kept = await strokes();
    const penBefore = taps();
    await hands.pen([await choice('x3'), await choice('x3')]);
    await sleep(500);
    if (taps() !== penBefore + 1) list.push(`in Draw a Pencil tap on a choice sent ${taps() - penBefore} tap turn(s), wanted 1 (it presses)`);
    if ((await strokes()) !== kept) list.push(`a Pencil tap on a choice left ${(await strokes()) - kept} stroke(s), wanted no dot`);
    await conv.rest(null, false).catch(() => '');
    // a Pencil tap on nothing is a dot (a mark like any other)
    const dotAt = { x: empty.x, y: Math.round(screen.height * 0.9) };
    const dots = await strokes();
    await hands.pen([dotAt, dotAt]);
    if ((await strokes()) !== dots + 1) list.push(`a Pencil tap on empty stage in Draw left ${(await strokes()) - dots} stroke(s), wanted a dot`);
    // leaving Draw keeps the ink on screen, not sent, with the bar's Send and Clear still there (that already existed; this holds it)
    const total = await strokes();
    await openDraw();
    const left = await tab.eval<{ layer: boolean; bar: boolean; draw: boolean }>(`(() => { const l = document.querySelector('.ink-stage'); const b = document.querySelector('.ink-stage .ink-bar'); return { layer: !!l && !l.hidden, bar: !!b && !b.hidden, draw: !!l && !l.hidden && !l.classList.contains('ink-stage--through') }; })()`);
    if (!left.layer || !left.bar) list.push(`after leaving Draw the ink layer is ${left.layer ? 'on' : 'off'} the screen and its bar ${left.bar ? 'shown' : 'hidden'}: the ink waiting to be sent is not kept in view`);
    if ((await strokes()) !== total) list.push(`leaving Draw changed the ink from ${total} to ${await strokes()} stroke(s)`);
    await shot(`${screen.name}-draw-left.png`);
  } catch (error) {
    list.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await tab.close();
  }
  // ---------------------------------------------------------------------------------------------------------------------------- no Pencil: the hand tool
  const hand = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
  try {
    const handOptions: Options = { ...options };
    const handConv = new Conversation(hand, handOptions, { name: screen.name, width: screen.width, height: screen.height }, dir);
    const mhands = new Hands(hand);
    await hand.send('DOM.enable');
    await handConv.start();
    const count = (): number => hand.posted.filter((turn) => turn.kind === 'tap').length;
    const strokesNow = async (): Promise<number> => (await mhands.strokes())?.strokes.length ?? 0;
    const played = await hand.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(CHOICES)})).then(() => null, (e) => String(e && e.message || e))`);
    if (played !== null) throw new Error(`the choices would not play: ${played}`);
    await handConv.rest(true);
    await sleep(400);
    await hand.eval(`document.querySelector('.composer__plus').click()`);
    await sleep(300);
    await hand.eval(`[...document.querySelectorAll('.composer__item')].find((n) => /^Draw/.test(n.textContent.trim())).click()`);
    await sleep(600);
    await hand.eval(`(() => { const pill = document.querySelector('.ink-stage .ink-btn--pill'); if (pill && !pill.hidden) pill.click(); })()`);
    await sleep(200);
    const box = await hand.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const e = window.__stage.elements().find((n) => n.id === 'x2'); return e.box; })()`);
    const at = await mhands.onScreen({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const low = { x: Math.round(screen.width * 0.4), y: Math.round(screen.height * 0.85) };
    // a mouse draws until the hand is chosen
    const start = async (): Promise<void> => {
      await hand.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: low.x, y: low.y });
      await hand.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: low.x, y: low.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 10; i += 1) {
        await hand.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: low.x + i * 8, y: low.y - i * 2, button: 'left', buttons: 1 });
        await sleep(14);
      }
      await hand.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: low.x + 80, y: low.y - 20, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(250);
    };
    await start();
    if ((await strokesNow()) !== 1) list.push(`a mouse stroke in Draw left ${await strokesNow()} stroke(s), wanted 1`);
    const hasHand = await hand.eval<boolean>(`!!document.querySelector('.ink-stage .ink-btn--hand')`);
    if (!hasHand) list.push('the ink bar has no hand tool');
    else {
      await hand.eval(`document.querySelector('.ink-stage .ink-btn--hand').click()`);
      await sleep(300);
      await snap(hand, dir, `${screen.name}-draw-hand-on.png`, pictures);
      const ahead = count();
      await hand.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await hand.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
      await hand.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(500);
      if (count() !== ahead + 1) list.push(`with the hand tool a mouse click on a choice sent ${count() - ahead} tap turn(s), wanted 1`);
      if ((await strokesNow()) !== 1) list.push(`with the hand tool the ink holds ${await strokesNow()} stroke(s), wanted the 1 kept`);
      const shown = await hand.eval<boolean>(`!!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden`);
      if (!shown) list.push('the ink was not kept on screen with the hand tool');
      await handConv.rest(null, false).catch(() => '');
      await hand.eval(`document.querySelector('.ink-stage .ink-btn[data-tool="pen"]').click()`);
      await sleep(300);
      await start();
      if ((await strokesNow()) !== 2) list.push(`after the pen tool a mouse stroke left ${await strokesNow()} stroke(s) in all, wanted 2`);
    }
  } catch (error) {
    list.push(`stopped (hand): ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await hand.close();
  }
  const results: CheckResult[] = [{ turn: 0, check: `fb-103-draw-taps-${screen.name}`, verdict: list.length === 0 ? 'PASS' : 'FAIL', detail: list.length === 0 ? 'in Draw with a Pencil seen it draws and a finger taps through to a choice, a Pencil tap presses a choice and a tap on nothing is a dot; with a mouse only the hand tool lets a click work a choice and keeps the ink, and the pen tool draws again' : list.join('; ') }];
  return [{ name: `draw-taps-${screen.name}`, picture: pictures[0] ?? '', results, seconds: (Date.now() - began) / 1000 }];
}

async function snap(tab: Tab, dir: string, name: string, pictures: string[]): Promise<void> {
  await writeFile(join(dir, name), Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64'));
  pictures.push(name);
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
