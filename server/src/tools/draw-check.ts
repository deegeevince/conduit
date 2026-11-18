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

/**
 * The screens the ink bar's dock is looked at: an iPad across (the column is the default), the same iPad upright and a phone upright (the row is), and a phone held across, where the column
 * is taller than the stage and has to scroll inside itself.
 */
export const DRAW_DOCK_SCREENS: readonly LensScreen[] = [
  { name: '1180x820', width: 1180, height: 820, dpr: 2 },
  { name: '820x1180', width: 820, height: 1180, dpr: 2 },
  { name: '390x844', width: 390, height: 844, dpr: 3 },
  { name: '719x356', width: 719, height: 356, dpr: 3 },
];

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface DockState {
  readonly dock: string;
  readonly stored: string | null;
  readonly stage: Box;
  readonly bar: Box;
  readonly composer: Box | null;
  readonly scroll: { readonly client: number; readonly total: number };
  readonly controls: readonly { readonly label: string; readonly x: number; readonly w: number; readonly h: number; readonly covered: boolean; readonly inBar: boolean }[];
}

/** what the dock looks like now, read from the page: the bar's place on the stage and every control in the column with its size and whether the thing at its centre is the control */
const DOCK_STATE = `(() => {
  const bar = document.querySelector('.ink-stage__bar');
  const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const stage = document.getElementById('stage');
  const composer = document.querySelector('.composer');
  const scroller = bar.querySelector('.ink-bar__scroll');
  const b = bar.getBoundingClientRect();
  const controls = [...bar.querySelectorAll('.ink-bar__scroll button')].filter((e) => !e.closest('.ink-bar__swatches') && e.getClientRects().length > 0).map((e) => {
    const r = e.getBoundingClientRect();
    const inBar = r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { label: e.getAttribute('aria-label') || e.title || e.className, x: r.left, w: r.width, h: r.height, covered: inBar && !(at && (at === e || e.contains(at))), inBar };
  });
  return { dock: bar.dataset.dock, stored: (() => { try { return localStorage.getItem('conduit.ink.dock'); } catch (e) { return 'unreadable'; } })(), stage: rect(stage), bar: rect(bar), composer: composer ? rect(composer) : null, scroll: { client: scroller.clientHeight, total: scroller.scrollHeight }, controls };
})()`;

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** the dock the bar starts in when nothing has been chosen: down the side on a landscape screen wider than 900 px that is tall enough for the column, across the top otherwise */
const expectedDock = (screen: LensScreen): string => (screen.width > 900 && screen.width > screen.height && screen.height >= 600 ? 'vertical' : 'horizontal');

/**
 * fb-106. The ink bar can be docked down the stage's right-hand edge, so that it does not take the stage's top. With no choice made, a wide landscape screen starts in the column and anything
 * else in the row; a choice is kept across a reload and wins over that; in the column the bar is within 24 px of the stage's right edge, at most 72 px wide, clear of the prompt bar and the
 * stage's edges, every control at least 44 x 44 and not covered by anything (or, where the stage is shorter than the column, reachable by scrolling the column); and Draw works in either dock:
 * the hand tool lets a tap work the page, the pen draws, a colour is chosen, words are typed (behind their button in the column), and Send sends them with the drawing.
 */
export async function drawDockGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
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
  const shot = (name: string): Promise<void> => snap(tab, dir, `${screen.name}-${name}.png`, pictures);
  const state = (): Promise<DockState> => tab.eval<DockState>(DOCK_STATE);
  const dockOf = (): Promise<string | null> => tab.eval<string | null>(`(document.querySelector('.ink-stage__bar') || {dataset: {}}).dataset.dock || null`);
  const play = async (): Promise<void> => {
    const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(CHOICES)})).then(() => null, (e) => String(e && e.message || e))`);
    if (played !== null) throw new Error(`the choices would not play: ${played}`);
    const rest = await conv.rest(true);
    if (rest !== '') throw new Error(rest);
    await sleep(400);
  };
  const drawOn = (): Promise<boolean> => tab.eval<boolean>(`!!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden`);
  const openDraw = async (): Promise<void> => {
    if (await drawOn()) return;
    await tab.eval(`document.querySelector('.composer__plus').click()`);
    await sleep(300);
    await tab.eval(`[...document.querySelectorAll('.composer__item')].find((n) => /^Draw/.test(n.textContent.trim())).click()`);
    await sleep(600);
    // the bar open (it starts folded on a phone and on a short screen)
    await tab.eval(`(() => { const pill = document.querySelector('.ink-stage .ink-btn--pill'); if (pill && !pill.hidden) pill.click(); })()`);
    await sleep(250);
  };
  /** a real tap on a control of the bar, scrolled into view first as a person would scroll the column */
  const tapOn = async (selector: string): Promise<boolean> => {
    await tab.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e) e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); })()`);
    await sleep(120);
    const at = await tab.eval<Box | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.getClientRects().length === 0) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    if (at === null || at.w === 0) return false;
    await tab.tap(at.x + at.w / 2, at.y + at.h / 2);
    return true;
  };
  const choice = async (id: string): Promise<{ x: number; y: number }> => {
    const box = await tab.eval<{ x: number; y: number; width: number; height: number } | null>(`(() => { const e = window.__stage.elements().find((n) => n.id === ${JSON.stringify(id)}); return e ? e.box : null; })()`);
    if (box === null) throw new Error(`no element ${id} on the stage`);
    return hands.onScreen({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  };

  /** the column is where the owner asked for it, and every control is there to be pressed */
  const judgeColumn = async (where: string): Promise<void> => {
    const s = await state();
    if (s.dock !== 'vertical') return void list.push(`${where}: the bar says it is docked ${s.dock}, wanted vertical`);
    const gap = s.stage.x + s.stage.w - (s.bar.x + s.bar.w);
    if (gap < 0 || gap > 24) list.push(`${where}: the bar's right edge is ${gap.toFixed(0)} px from the stage's, wanted 0 to 24`);
    if (s.bar.w > 72) list.push(`${where}: the bar is ${s.bar.w.toFixed(0)} px wide, wanted at most 72`);
    if (s.composer !== null && overlaps(s.bar, s.composer)) list.push(`${where}: the bar covers the prompt bar`);
    if (s.bar.y < s.stage.y - 0.5 || s.bar.y + s.bar.h > s.stage.y + s.stage.h + 0.5) list.push(`${where}: the bar runs off the stage (top ${s.bar.y.toFixed(0)}, bottom ${(s.bar.y + s.bar.h).toFixed(0)}, the stage is ${s.stage.y.toFixed(0)} to ${(s.stage.y + s.stage.h).toFixed(0)})`);
    const middle = s.bar.y + s.bar.h / 2 - (s.stage.y + s.stage.h / 2);
    if (Math.abs(middle) > 3) list.push(`${where}: the bar is ${middle.toFixed(0)} px off the stage's middle, wanted centred`);
    const wanted = ['Hide drawing tools', 'Dock the tools across the top', 'Hand', 'Pen', 'Highlighter', 'Eraser', 'Colours', 'Undo', 'Redo', 'Clear everything', 'Add words', 'Send drawing'];
    for (const label of wanted) if (!s.controls.some((c) => c.label.startsWith(label))) list.push(`${where}: the column has no "${label}" button`);
    for (const c of s.controls) {
      if (c.w < 43.5 || c.h < 43.5) list.push(`${where}: "${c.label}" is ${c.w.toFixed(0)} x ${c.h.toFixed(0)}, wanted at least 44 x 44`);
      if (c.covered) list.push(`${where}: something else is over the middle of "${c.label}"`);
    }
    const tall = s.scroll.total > s.scroll.client + 1;
    const needed = s.scroll.total + 12 > s.stage.h - 20;
    if (tall && !needed) list.push(`${where}: the column scrolls (${s.scroll.total} px of buttons in ${s.scroll.client}) on a stage that has room (${s.stage.h.toFixed(0)} px)`);
    if (needed) {
      // taller than the stage: the column holds itself inside the stage and scrolls, down to Send
      if (!tall) list.push(`${where}: the buttons take ${s.scroll.total} px and the stage ${s.stage.h.toFixed(0)}, and the column does not scroll`);
      await tab.eval(`document.querySelector('.ink-bar__scroll').scrollTop = 1e6`);
      await sleep(100);
      const after = await state();
      const send = after.controls.find((c) => c.label.startsWith('Send drawing'));
      if (send === undefined || after.controls.length === 0 || send.covered) list.push(`${where}: scrolled to its end the column does not show Send`);
      await tab.eval(`document.querySelector('.ink-bar__scroll').scrollTop = 0`);
      await sleep(100);
    }
  };
  /** the row is a row: across the top, not the column's width, inside the stage */
  const judgeRow = async (where: string): Promise<void> => {
    const s = await state();
    if (s.dock !== 'horizontal') return void list.push(`${where}: the bar says it is docked ${s.dock}, wanted horizontal`);
    if (s.bar.w <= 72) list.push(`${where}: the row is only ${s.bar.w.toFixed(0)} px wide`);
    if (s.bar.y > s.stage.y + 24) list.push(`${where}: the row is ${(s.bar.y - s.stage.y).toFixed(0)} px down the stage, wanted across its top`);
    if (s.bar.x < s.stage.x - 0.5 || s.bar.x + s.bar.w > s.stage.x + s.stage.w + 0.5) list.push(`${where}: the row runs off the stage's sides`);
    if (s.composer !== null && overlaps(s.bar, s.composer)) list.push(`${where}: the row covers the prompt bar`);
    // nothing in the row is pushed out of it or off the screen (a short screen has no room to spare: the dock button must not cost Send its place)
    for (const c of s.controls) if (c.x < s.bar.x - 0.5 || c.x + c.w > s.bar.x + s.bar.w + 0.5 || c.x + c.w > s.stage.x + s.stage.w + 0.5) list.push(`${where}: "${c.label}" sticks out of the row (${c.x.toFixed(0)} to ${(c.x + c.w).toFixed(0)}, the row is ${s.bar.x.toFixed(0)} to ${(s.bar.x + s.bar.w).toFixed(0)})`);
  };
  const judge = (dock: string, where: string): Promise<void> => (dock === 'vertical' ? judgeColumn(where) : judgeRow(where));

  /** the same work in either dock: a stroke, the hand tool (a tap works the page), the pen again, a colour, words, and Send, whose turn carries the words and the stroke */
  const work = async (dock: string): Promise<void> => {
    const where = `in the ${dock === 'vertical' ? 'column' : 'row'}`;
    await play();
    await openDraw();
    const stage = (await state()).stage;
    const empty = { x: Math.round(stage.x + stage.w * 0.4), y: Math.round(stage.y + stage.h * 0.72) };
    const n0 = await strokes();
    await hands.pen(line({ x: empty.x - 50, y: empty.y }, { x: empty.x + 50, y: empty.y - 16 }, 10));
    if ((await strokes()) !== n0 + 1) list.push(`${where}: the Pencil's stroke left ${(await strokes()) - n0} stroke(s), wanted 1`);
    // the hand tool: pressed by a tap on its button; a finger tap on a choice then works the page; the pen button brings drawing back
    if (!(await tapOn('.ink-stage .ink-btn--hand'))) list.push(`${where}: the hand tool cannot be tapped`);
    else {
      const pressed = await tab.eval<string | null>(`document.querySelector('.ink-stage .ink-btn--hand').getAttribute('aria-pressed')`);
      if (pressed !== 'true') list.push(`${where}: the hand tool was tapped and is not pressed`);
      const before = taps();
      await hands.finger([await choice('x2')]);
      await sleep(500);
      if (taps() !== before + 1) list.push(`${where}: with the hand tool a tap on a choice sent ${taps() - before} tap turn(s), wanted 1`);
      await conv.rest(null, false).catch(() => '');
      await play();
      if ((await strokes()) !== n0 + 1) list.push(`${where}: the hand tool's tap changed the ink to ${await strokes()} stroke(s), wanted the 1 kept`);
      if (!(await tapOn('.ink-stage .ink-btn[data-tool="pen"]'))) list.push(`${where}: the pen button cannot be tapped`);
      else if ((await tab.eval<string | null>(`document.querySelector('.ink-stage .ink-btn--hand').getAttribute('aria-pressed')`)) !== 'false') list.push(`${where}: the pen button was tapped and the hand tool is still pressed`);
    }
    // a colour: in the column it is chosen from the popover the one swatch opens
    if (dock === 'vertical') {
      if (!(await tapOn('.ink-stage .ink-swatch--current'))) list.push(`${where}: the colour button cannot be tapped`);
      else {
        const open = await tab.eval<boolean>(`(() => { const p = document.querySelector('.ink-stage .ink-bar__swatches'); return !!p && p.getClientRects().length > 0; })()`);
        if (!open) list.push(`${where}: the colour button was tapped and no colours opened`);
        await shot('vertical-colours');
      }
    }
    if (!(await tapOn('.ink-stage .ink-swatch[data-color]:nth-of-type(2)'))) list.push(`${where}: the second colour cannot be tapped`);
    const second = await tab.eval<{ on: boolean; shown: boolean }>(`(() => { const e = document.querySelector('.ink-stage .ink-swatch[data-color]:nth-of-type(2)'); const p = document.querySelector('.ink-stage .ink-bar__swatches'); return { on: e.getAttribute('aria-pressed') === 'true', shown: ${dock === 'vertical'} ? p.getClientRects().length > 0 && getComputedStyle(p).display !== 'contents' : false }; })()`);
    if (!second.on) list.push(`${where}: the second colour was tapped and is not the one in use`);
    if (second.shown) list.push(`${where}: the colours stayed open after one was chosen`);
    // words: in the column behind their button, in the row in the field
    const words = `dock ${dock} ${screen.name}`;
    if (dock === 'vertical') {
      if (!(await tapOn('.ink-stage .ink-btn--words'))) list.push(`${where}: the words button cannot be tapped`);
      const shown = await tab.eval<boolean>(`(() => { const f = document.querySelector('.ink-stage .ink-bar__words'); return !!f && f.getClientRects().length > 0 && document.activeElement === f; })()`);
      if (!shown) list.push(`${where}: the words button was tapped and the field is not open and focused`);
      await shot('vertical-words');
    } else if (!(await tapOn('.ink-stage .ink-bar__words'))) list.push(`${where}: the words field cannot be tapped`);
    await tab.type(words);
    const typed = await tab.eval<string>(`document.querySelector('.ink-stage .ink-bar__words').value`);
    if (typed !== words) list.push(`${where}: the words typed read "${typed}", wanted "${words}"`);
    // Send
    const mark = tab.posted.length;
    if (!(await tapOn('.ink-stage .ink-btn--send'))) list.push(`${where}: Send cannot be tapped`);
    let sent: (typeof tab.posted)[number] | undefined;
    for (let waited = 0; waited < 8000 && sent === undefined; waited += 250) {
      sent = tab.posted.slice(mark).find((turn) => turn.kind === 'prompt');
      if (sent === undefined) await sleep(250);
    }
    if (sent === undefined) {
      list.push(`${where}: Send opened no turn`);
      await shot(`send-failed-${dock}`);
    } else {
      let marks: { strokes?: unknown[] } = {};
      try {
        marks = (JSON.parse(sent.body) as { input?: { marks?: typeof marks } }).input?.marks ?? {};
      } catch {
        // an unreadable body is reported below
      }
      if (sent.text !== words) list.push(`${where}: Send went up with the words "${sent.text ?? ''}", wanted "${words}"`);
      if ((marks.strokes ?? []).length < 1) list.push(`${where}: Send went up with no strokes`);
    }
    await conv.rest(null, false).catch(() => '');
    if (await drawOn()) list.push(`${where}: Draw is still open after Send`);
  };

  try {
    note(`draw dock: ${screen.name}`);
    await tab.send('DOM.enable');
    await conv.start();
    // ----------------------------------------------------------------------------------------------------- with no choice made: the screen suggests the dock
    const first = expectedDock(screen);
    const other = first === 'vertical' ? 'horizontal' : 'vertical';
    const start = await dockOf();
    if (start !== first) list.push(`with no choice made the bar starts ${start}, wanted ${first} on a ${screen.name} screen`);
    await play();
    await openDraw();
    await judge(first, `${first} dock (the default)`);
    await shot(`dock-${first}`);
    // ----------------------------------------------------------------------------------------------------- the button on the bar switches it, and the choice is kept
    if (!(await tapOn('.ink-stage .ink-btn--dock'))) list.push('the bar has no dock button to tap');
    await sleep(250);
    await judge(other, `${other} dock (after the toggle)`);
    await shot(`dock-${other}`);
    const kept = (await state()).stored;
    if (kept !== other) list.push(`the dock was switched to ${other} and this browser remembers ${kept}`);
    // a reload: the choice wins over what the screen would suggest
    await conv.start();
    const reloaded = await dockOf();
    if (reloaded !== other) list.push(`after a reload the bar is ${reloaded}, wanted the ${other} dock that was chosen`);
    await play();
    await openDraw();
    await judge(other, `${other} dock (after a reload)`);
    // back to the first, and that choice is kept too
    if (!(await tapOn('.ink-stage .ink-btn--dock'))) list.push('after the reload the bar has no dock button to tap');
    await sleep(250);
    await conv.start();
    const back = await dockOf();
    if (back !== first) list.push(`switched back to ${first}, and after a reload the bar is ${back}`);
    // ----------------------------------------------------------------------------------------------------- Draw works the same in either dock
    await work(first);
    await openDraw();
    if (!(await tapOn('.ink-stage .ink-btn--dock'))) list.push('the bar has no dock button to tap before the second round of work');
    await sleep(250);
    await work(other);
  } catch (error) {
    list.push(`stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await tab.close();
  }
  const results: CheckResult[] = [
    {
      turn: 0,
      check: `fb-106-draw-dock-${screen.name}`,
      verdict: list.length === 0 ? 'PASS' : 'FAIL',
      detail:
        list.length === 0
          ? 'the ink bar starts in the dock the screen suggests, switches with its dock button, keeps the choice over a reload, and in the column sits within 24 px of the stage\'s right edge, at most 72 px wide, clear of the prompt bar, every control 44 x 44 and uncovered (or reachable by scrolling); the hand tool, a colour, words and Send work in both docks'
          : list.join('; '),
    },
  ];
  return [{ name: `draw-dock-${screen.name}`, picture: pictures[0] ?? '', results, seconds: (Date.now() - began) / 1000 }];
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
    process.stderr.write('usage: tsx draw-check.ts --url http://127.0.0.1:<port> [--out <dir>] [--page lens=1] [--size 719x356x3] [--dock]\n');
    process.exit(2);
  }
  void (async () => {
    const screen: LensScreen = { name: `${size[0]}x${size[1]}`, width: size[0] ?? 719, height: size[1] ?? 356, dpr: size[2] ?? 3 };
    const all = process.argv.includes('--dock') ? await drawDockGroup(url, screen, out, 90_000, (text) => process.stdout.write(`${text}\n`)) : await drawGroup(url, screen, out, 90_000, (text) => process.stdout.write(`${text}\n`), page);
    let failed = 0;
    for (const scene of all) for (const r of scene.results) {
      process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  })();
}
