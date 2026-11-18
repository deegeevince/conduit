// The lazy chunk: KaTeX, its stylesheet and its fonts, and what is read off a formula it set. Nothing in the main chunk imports this but `host.ts`,
// and only through `import('./typeset')`, so a page that never shows a formula never loads a byte of it.
//
//   html     KaTeX's own markup (the plain renderer puts it in the page as it is)
//   mathml   KaTeX's MathML (the text layer's, read by a screen reader and kept when the words are copied)
//   drawing  the same formula as a list of glyph boxes, rules and paths (`drawing.ts`), read off a hidden node KaTeX's HTML was put in: the WebGL renderer draws it
//            on a 2D canvas, as it does a run of CJK, and shows that as a texture. (Not a `foreignObject`: WebKit does not draw one reliably.)

import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { FormulaDrawing, FormulaItem } from './drawing';

/** The container font the formula is measured at, px. Large, so that a rule's thickness and a glyph's advance are read to a fraction of a hundredth of an em. */
const MEASURE_PX = 100;

export interface Typeset {
  readonly html: string;
  readonly mathml: string;
  readonly drawing: FormulaDrawing;
  /** where the formula's own top left stands inside what `html` makes, in ems of the container: so that the plain renderer can put it exactly where the box is */
  readonly origin: { readonly x: number; readonly y: number };
}

export type Typesetting = Typeset | { readonly fault: string };

const OPTIONS = { throwOnError: true, strict: 'ignore', trust: false, maxSize: 20, maxExpand: 400, errorColor: 'currentColor' } as const;

/** Sets a formula; the fault is KaTeX's own words when it cannot be read. */
export async function typesetFormula(tex: string, display: boolean): Promise<Typesetting> {
  let html: string;
  let mathml: string;
  try {
    html = katex.renderToString(tex, { ...OPTIONS, displayMode: display, output: 'html' });
    mathml = katex.renderToString(tex, { ...OPTIONS, displayMode: display, output: 'mathml' });
  } catch (error) {
    return { fault: (error instanceof Error ? error.message : String(error)).replace(/^KaTeX parse error:\s*/, '').slice(0, 200) };
  }
  injectStyle();
  const holder = document.createElement('div');
  holder.className = 'conduit-formula';
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = `position:absolute;left:-30000px;top:0;width:max-content;font-size:${MEASURE_PX}px;line-height:normal;opacity:0;pointer-events:none;white-space:nowrap;`;
  holder.innerHTML = html;
  document.body.append(holder);
  try {
    await fontsFor(holder);
    const read = readDrawing(holder);
    if (read === null) return { fault: 'the formula set nothing' };
    return { html, mathml, drawing: read.drawing, origin: read.origin };
  } finally {
    holder.remove();
  }
}

let styled = false;
/** A display formula has a margin of an em above and below it in KaTeX's stylesheet: the layout gives the room, so there is none, here and where the plain renderer sets it. */
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = '.conduit-formula .katex-display{margin:0}';
  document.head.append(style);
}

/** Waits for the KaTeX faces the formula uses: a glyph measured in a fallback face is the wrong width, and a canvas draws only the faces the document has loaded. */
async function fontsFor(root: HTMLElement): Promise<void> {
  const wanted = new Map<string, string>();
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || node.nodeValue === null || node.nodeValue.trim() === '') continue;
    const style = getComputedStyle(parent);
    const font = `${style.fontStyle} ${style.fontWeight} ${MEASURE_PX}px ${style.fontFamily}`;
    wanted.set(font, `${wanted.get(font) ?? ''}${node.nodeValue}`);
  }
  await Promise.all([...wanted].map(([font, text]) => document.fonts.load(font, text).catch(() => [])));
}

const em = (px: number): number => px / MEASURE_PX;
const ZERO_WIDTH = /[​⁠﻿]/g;

/** The glyph boxes, rules and paths of a formula KaTeX's HTML has been set in, measured by the browser. Null when nothing was set. */
function readDrawing(holder: HTMLElement): { readonly drawing: FormulaDrawing; readonly origin: { readonly x: number; readonly y: number } } | null {
  const html = holder.querySelector<HTMLElement>('.katex-html');
  if (html === null) return null;
  // the formula's box: what its `.base` boxes (a formula KaTeX breaks into several, side by side, has several) hold between them
  const bases = [...html.querySelectorAll<HTMLElement>('.base')].map((base) => base.getBoundingClientRect()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (bases.length === 0) return null;
  const left = Math.min(...bases.map((rect) => rect.left));
  const top = Math.min(...bases.map((rect) => rect.top));
  const right = Math.max(...bases.map((rect) => rect.right));
  const bottom = Math.max(...bases.map((rect) => rect.bottom));
  const strut = html.querySelector<HTMLElement>('.strut');
  const strutPx = strut === null ? MEASURE_PX * 1.21 : Number.parseFloat(getComputedStyle(strut).fontSize);
  const drop = strut === null ? 0 : Number.parseFloat(strut.style.verticalAlign || '0');
  const depth = Number.isFinite(drop) ? em(-drop * strutPx) : 0;
  const held = holder.getBoundingClientRect();
  const items: FormulaItem[] = [];
  const ruler = document.createElement('canvas').getContext('2d');

  // glyphs: every run of text, in the font it was set in, at the place the browser put it
  const walk = document.createTreeWalker(html, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
    const text = (node.nodeValue ?? '').replace(ZERO_WIDTH, '');
    const parent = node.parentElement;
    if (parent === null || text.trim() === '') continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    const style = getComputedStyle(parent);
    const size = Number.parseFloat(style.fontSize);
    let ascent = size * 0.8;
    if (ruler !== null) {
      ruler.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
      const measured = ruler.measureText(text);
      // the browser's box for a run of text is its font's ascent and descent: the baseline is the ascent below the top
      if (typeof measured.fontBoundingBoxAscent === 'number' && measured.fontBoundingBoxAscent > 0) ascent = measured.fontBoundingBoxAscent;
    }
    items.push({
      t: 'g',
      x: em(rect.left - left),
      y: em(rect.top + ascent - top),
      text,
      style: style.fontStyle,
      weight: style.fontWeight,
      family: style.fontFamily,
      size: em(size),
      width: em(rect.width),
    });
  }

  // rules: the borders the browser drew (a fraction bar, an overline, a box, a rule)
  for (const element of html.querySelectorAll<HTMLElement>('*')) {
    if (element.closest('svg') !== null) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    const side = (name: 'Top' | 'Right' | 'Bottom' | 'Left'): number => (style.getPropertyValue(`border-${name.toLowerCase()}-style`) === 'none' || style.getPropertyValue(`border-${name.toLowerCase()}-style`) === 'hidden' ? 0 : Number.parseFloat(style.getPropertyValue(`border-${name.toLowerCase()}-width`)) || 0);
    const [t, r, b, l] = [side('Top'), side('Right'), side('Bottom'), side('Left')];
    const rule = (x: number, y: number, w: number, h: number): void => void items.push({ t: 'r', x: em(x - left), y: em(y - top), w: em(w), h: em(h) });
    if (t > 0) rule(rect.left, rect.top, rect.width, t);
    if (b > 0) rule(rect.left, rect.bottom - b, rect.width, b);
    if (l > 0) rule(rect.left, rect.top, l, rect.height);
    if (r > 0) rule(rect.right - r, rect.top, r, rect.height);
  }

  // paths: a radical, a tall brace, a stretched arrow are an inline <svg>, cut to the box that holds it
  for (const svg of html.querySelectorAll<SVGSVGElement>('svg')) {
    const rect = svg.getBoundingClientRect();
    const box = svg.viewBox.baseVal;
    if (rect.width <= 0 || rect.height <= 0 || box.width <= 0 || box.height <= 0) continue;
    const align = /^(x(?:Min|Mid|Max))(Y(?:Min|Mid|Max))\s*(meet|slice)?/.exec(svg.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet');
    const slice = align?.[3] === 'slice';
    const scale = slice ? Math.max(rect.width / box.width, rect.height / box.height) : Math.min(rect.width / box.width, rect.height / box.height);
    const shift = (kind: string | undefined, room: number): number => (kind === undefined || kind.endsWith('Min') ? 0 : kind.endsWith('Mid') ? room / 2 : room);
    const ox = rect.left + shift(align?.[1], rect.width - box.width * scale);
    const oy = rect.top + shift(align?.[2], rect.height - box.height * scale);
    // the box the picture is cut to: its own, and that of every ancestor that cuts what is past it
    let [x0, y0, x1, y1] = [rect.left, rect.top, rect.right, rect.bottom];
    for (let parent = svg.parentElement; parent !== null && parent !== holder; parent = parent.parentElement) {
      const cuts = getComputedStyle(parent);
      if (cuts.overflowX === 'visible' && cuts.overflowY === 'visible') continue;
      const around = parent.getBoundingClientRect();
      x0 = Math.max(x0, around.left);
      y0 = Math.max(y0, around.top);
      x1 = Math.min(x1, around.right);
      y1 = Math.min(y1, around.bottom);
    }
    if (x1 <= x0 || y1 <= y0) continue;
    const m = [em(scale), 0, 0, em(scale), em(ox - left - box.x * scale), em(oy - top - box.y * scale)] as const;
    const clip = [em(x0 - left), em(y0 - top), em(x1 - x0), em(y1 - y0)] as const;
    for (const path of svg.querySelectorAll('path')) {
      const d = path.getAttribute('d');
      if (d !== null && d !== '') items.push({ t: 'p', d, m, clip });
    }
  }

  return { drawing: { width: em(right - left), height: em(bottom - top), depth, items }, origin: { x: em(left - held.left), y: em(top - held.top) } };
}
