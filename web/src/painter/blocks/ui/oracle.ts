// The solver's oracle: the same random tree laid out by `solve` and by the browser's own flexbox, and
// every box compared. The subset is CSS's own, so the browser is the judge.
//
// `generate` is pure (a seeded stream), so the 2,000 trees are the same on every run. `inDom` builds one as real
// elements and `measureDom` reads their boxes back. Only `inDom` and `measureDom` touch the DOM, and only the bench page calls them.

import { solve } from './solve';
import type { Align, Box, Dim, Justify, Node, Placed, Style } from './solve';

/** What a generated leaf is: a box of fixed size, or words of fixed widths that wrap. */
export type OracleLeaf =
  | { readonly kind: 'box'; readonly w: number; readonly h: number }
  | { readonly kind: 'words'; readonly widths: readonly number[]; readonly gap: number; readonly line: number };

export interface OracleCase {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly tree: Node<OracleLeaf | null>;
}

class Stream {
  private s: number;
  constructor(seed: number) {
    this.s = (seed * 2654435761) >>> 0 || 1;
  }
  next(): number {
    // xorshift32
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const ALIGNS: readonly Align[] = ['start', 'center', 'end', 'stretch'];
const JUSTIFIES: readonly Justify[] = ['start', 'center', 'end', 'between'];

function leafNode(r: Stream, parentDir: 'row' | 'col'): Node<OracleLeaf | null> {
  const words = r.chance(0.35);
  const style = styleFor(r, parentDir, words);
  if (!words) {
    const fill = style.width === 'fill';
    // a box that fills has no width of its own to ask for; one with a width holds to it
    const w = fill ? 0 : r.int(2, 14) * 4;
    const h = r.int(2, 12) * 4;
    const minW = style.minW ?? (fill ? (r.chance(0.5) ? 8 * r.int(1, 8) : 0) : Math.min(w, style.maxW ?? w));
    return {
      style: { ...style, width: fill ? 'fill' : w, height: h, minW, minH: style.minH ?? Math.min(h, style.maxH ?? h) },
      box: null,
      leaf: { fit: () => ({ w, h }), minW: 0 },
      children: [],
      payload: { kind: 'box', w, h },
    };
  }
  const widths = Array.from({ length: r.int(2, 6) }, () => r.int(2, 9) * 4);
  const gap = 4;
  const line = 20;
  const natural = (max: number): { w: number; h: number } => {
    let lines = 1;
    let used = 0;
    let widest = 0;
    for (const word of widths) {
      const next = used === 0 ? word : used + gap + word;
      if (used > 0 && next > max + 1e-9) {
        lines += 1;
        widest = Math.max(widest, used);
        used = word;
      } else used = next;
    }
    widest = Math.max(widest, used);
    return { w: widest, h: lines * line };
  };
  return {
    style: { ...style, height: style.height === 'fill' ? 'hug' : style.height, minW: style.minW ?? Math.min(Math.max(...widths), style.maxW ?? Number.POSITIVE_INFINITY) },
    box: null,
    leaf: { fit: natural, minW: Math.max(...widths) },
    children: [],
    payload: { kind: 'words', widths, gap, line },
  };
}

function styleFor(r: Stream, parentDir: 'row' | 'col', leaf: boolean): Style {
  const dims: Dim[] = ['hug', 'hug', 'hug', 'fill', 8 * r.int(3, 16)];
  let width: Dim = r.pick(dims);
  let height: Dim = leaf ? 'hug' : r.pick(['hug', 'hug', 'hug', 'fill', 8 * r.int(2, 20)] as Dim[]);
  // a number on a words leaf would make it a fixed box; leave leaves hug or fill across
  if (leaf && typeof width === 'number') width = 'hug';
  if (parentDir === 'col' && height === 'fill') height = 'hug';
  const grow = r.chance(0.25) ? r.int(1, 3) : 0;
  const shrink = r.chance(0.15) ? 0 : 1;
  const self = r.chance(0.2) ? r.pick(ALIGNS) : 'auto';
  const style: Style = { width, height, grow, shrink, self };
  return {
    ...style,
    ...(r.chance(0.1) ? { maxW: 40 * r.int(2, 8) } : {}),
    ...(r.chance(0.08) ? { minW: 8 * r.int(1, 6) } : {}),
    ...(r.chance(0.06) ? { maxH: 40 * r.int(2, 8) } : {}),
    ...(r.chance(0.06) ? { minH: 8 * r.int(1, 6) } : {}),
  };
}

function containerNode(r: Stream, depth: number, parentDir: 'row' | 'col'): Node<OracleLeaf | null> {
  const dir = r.chance(0.5) ? 'row' : 'col';
  const box: Box = {
    dir,
    gap: r.pick([0, 4, 8, 16]),
    pad: [r.pick([0, 4, 8, 16]), r.pick([0, 4, 8, 16]), r.pick([0, 4, 8, 16]), r.pick([0, 4, 8, 16])],
    align: r.pick(ALIGNS),
    justify: r.pick(JUSTIFIES),
    wrap: dir === 'row' && r.chance(0.25),
  };
  const count = r.int(1, 4);
  const children: Node<OracleLeaf | null>[] = [];
  for (let i = 0; i < count; i++) children.push(depth >= 3 || r.chance(0.55) ? leafNode(r, dir) : containerNode(r, depth + 1, dir));
  const style = styleFor(r, parentDir, false);
  // a wrapping row has no known height to fill, and a percentage across it is the browser's to guess
  return { style: box.wrap ? { ...style, height: style.height === 'fill' ? 'hug' : style.height } : style, box, leaf: null, children, payload: null };
}

/** One generated tree and the room it is laid out in. */
export function generate(seed: number): OracleCase {
  const r = new Stream(seed + 7);
  const width = 60 * r.int(6, 14);
  const height = 60 * r.int(6, 14);
  const root = containerNode(r, 0, 'col');
  // the root fills its room
  const tree: Node<OracleLeaf | null> = { ...root, style: { width, height } };
  return { seed, width, height, tree };
}

// ------------------------------------------------------------------ in the browser

const justifyCss: Readonly<Record<Justify, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' };
const alignCss: Readonly<Record<Align, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };

function px(n: number): string {
  return `${n}px`;
}

/** The same tree as real elements. Each element is tagged `data-path` with its index path so boxes can be matched. */
export function inDom(root: Node<OracleLeaf | null>, width: number, height: number): HTMLElement {
  const build = (n: Node<OracleLeaf | null>, parentDir: 'row' | 'col' | null, path: string): HTMLElement => {
    const el = document.createElement('div');
    el.dataset['path'] = path;
    const st = el.style;
    st.boxSizing = 'border-box';
    st.position = 'relative';
    st.minWidth = '0';
    st.minHeight = '0';
    const s = n.style;
    // sizes
    if (parentDir === null) {
      st.width = px(width);
      st.height = px(height);
    } else {
      if (typeof s.width === 'number') st.width = px(s.width);
      else if (s.width === 'fill') {
        if (parentDir === 'row') st.width = 'auto';
        else if (s.self === 'center' || s.self === 'end') st.width = '100%';
        else st.alignSelf = 'stretch';
      }
      if (typeof s.height === 'number') st.height = px(s.height);
      else if (s.height === 'fill') {
        if (parentDir === 'col') st.height = 'auto';
        else st.alignSelf = 'stretch';
      }
      const fillMain = (parentDir === 'row' && s.width === 'fill') || (parentDir === 'col' && s.height === 'fill');
      const grow = fillMain ? Math.max(1, s.grow ?? 0) : (s.grow ?? 0);
      st.flex = fillMain ? `${grow} ${s.shrink ?? 1} 0%` : `${grow} ${s.shrink ?? 1} auto`;
      if (s.self !== undefined && s.self !== 'auto' && st.alignSelf === '') st.alignSelf = alignCss[s.self];
    }
    if (s.maxW !== undefined) st.maxWidth = px(s.maxW);
    if (s.maxH !== undefined) st.maxHeight = px(s.maxH);
    // the automatic minimum of a flex item is the browser's; an explicit one is ours
    if (s.minW !== undefined) st.minWidth = px(s.minW);
    if (s.minH !== undefined) st.minHeight = px(s.minH);
    if (n.box !== null) {
      st.display = 'flex';
      st.flexDirection = n.box.dir === 'row' ? 'row' : 'column';
      st.gap = px(n.box.gap);
      st.padding = n.box.pad.map(px).join(' ');
      st.alignItems = alignCss[n.box.align];
      st.justifyContent = justifyCss[n.box.justify];
      st.flexWrap = n.box.wrap ? 'wrap' : 'nowrap';
      if (n.box.wrap) st.alignContent = 'stretch';
      // automatic minimums are the browser's own for containers
      if (parentDir !== null) {
        st.minWidth = s.minW !== undefined ? px(s.minW) : 'auto';
        st.minHeight = s.minH !== undefined ? px(s.minH) : 'auto';
      }
      n.children.forEach((k, i) => el.append(build(k, n.box?.dir ?? 'row', `${path}.${i}`)));
    } else if (n.payload !== null) {
      const p = n.payload;
      if (p.kind === 'box') {
        // a fixed box has its size as its content: it cannot shrink below it, as the kit's icons and glyph runs cannot
        st.minWidth = px(s.minW ?? 0);
        st.minHeight = px(s.minH ?? Math.min(p.h, s.maxH ?? p.h));
      } else {
        st.display = 'flex';
        st.flexWrap = 'wrap';
        st.columnGap = px(p.gap);
        st.rowGap = '0';
        st.alignContent = 'flex-start';
        st.minWidth = px(s.minW ?? Math.min(Math.max(...p.widths), s.maxW ?? Number.POSITIVE_INFINITY));
        st.minHeight = s.minH !== undefined ? px(s.minH) : 'auto';
        for (const w of p.widths) {
          const word = document.createElement('div');
          word.style.width = px(w);
          word.style.height = px(p.line);
          word.style.flex = '0 0 auto';
          el.append(word);
        }
      }
    }
    return el;
  };
  return build(root, null, '0');
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Every element's border box relative to its parent, by path. */
export function measureDom(root: HTMLElement): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const visit = (el: HTMLElement, parent: HTMLElement | null): void => {
    const path = el.dataset['path'];
    if (path !== undefined) {
      const r = el.getBoundingClientRect();
      const p = parent === null ? { left: r.left, top: r.top } : parent.getBoundingClientRect();
      out.set(path, { x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height });
    }
    for (const child of Array.from(el.children)) if (child instanceof HTMLElement && child.dataset['path'] !== undefined) visit(child, el);
  };
  visit(root, null);
  return out;
}

/** Our boxes by the same paths, relative to the parent, with a container's padding left in (as the DOM reports). */
/** True when every box lies inside its parent's: nothing overflows, which is what a screen's own parts do. */
export function fits(placed: Placed<OracleLeaf | null>): boolean {
  const eps = 0.01;
  const inside = (p: Placed<OracleLeaf | null>): boolean => p.children.every((k) => k.x >= -eps && k.y >= -eps && k.x + k.w <= p.w + eps && k.y + k.h <= p.h + eps && inside(k));
  return inside(placed);
}

export function measureSolved(placed: Placed<OracleLeaf | null>): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const visit = (p: Placed<OracleLeaf | null>, path: string): void => {
    out.set(path, { x: p.x, y: p.y, w: p.w, h: p.h });
    p.children.forEach((k, i) => visit(k, `${path}.${i}`));
  };
  visit(placed, '0');
  return out;
}

export interface OracleResult {
  /** trees whose boxes all sit inside their parents: the kit's own trees are of this kind */
  readonly fitting: number;
  /** of those, the trees any box of which differs by more than the tolerance */
  readonly fittingFailing: number;
  /** the largest difference over the fitting trees, points */
  readonly worstFitting: number;
  /** the share of those boxes within the tolerance */
  readonly fittingBoxes: number;
  readonly fittingBoxesWithin: number;
  readonly trees: number;
  readonly boxes: number;
  /** the largest difference of any edge or size, points */
  readonly worst: number;
  /** trees in which any box differs by more than the tolerance */
  readonly failing: number;
  readonly fittingFailures: readonly number[];
  readonly firstFittingFailure: { readonly seed: number; readonly path: string; readonly ours: Rect; readonly theirs: Rect } | null;
  readonly firstFailure: { readonly seed: number; readonly path: string; readonly ours: Rect; readonly theirs: Rect } | null;
}

/** Lays out `count` generated trees both ways and says how far apart they are. Browser only. */
export function runOracle(count: number, tolerance = 0.5): OracleResult {
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;left:-10000px;top:0;';
  document.body.append(stage);
  let boxes = 0;
  let worst = 0;
  let failing = 0;
  let fitting = 0;
  let fittingFailing = 0;
  let worstFitting = 0;
  let fittingBoxes = 0;
  let fittingBoxesWithin = 0;
  let firstFailure: OracleResult['firstFailure'] = null;
  let firstFittingFailure: OracleResult['firstFailure'] = null;
  const fittingFailures: number[] = [];
  for (let seed = 1; seed <= count; seed++) {
    const c = generate(seed);
    const solved = solve(c.tree, c.width, c.height);
    const ours = measureSolved(solved);
    const nothingOverflows = fits(solved);
    const dom = inDom(c.tree, c.width, c.height);
    stage.replaceChildren(dom);
    const theirs = measureDom(dom);
    let bad = false;
    for (const [path, a] of ours) {
      const b = theirs.get(path);
      if (b === undefined) continue;
      boxes += 1;
      const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
      worst = Math.max(worst, d);
      if (nothingOverflows) {
        worstFitting = Math.max(worstFitting, d);
        fittingBoxes += 1;
        if (d <= tolerance) fittingBoxesWithin += 1;
      }
      if (d > tolerance) {
        bad = true;
        if (firstFailure === null) firstFailure = { seed, path, ours: a, theirs: b };
        if (nothingOverflows && firstFittingFailure === null) firstFittingFailure = { seed, path, ours: a, theirs: b };
      }
    }
    if (bad) failing += 1;
    if (nothingOverflows) {
      fitting += 1;
      if (bad) {
        fittingFailing += 1;
        fittingFailures.push(seed);
      }
    }
  }
  stage.remove();
  return { fitting, fittingFailing, worstFitting, fittingBoxes, fittingBoxesWithin, trees: count, boxes, worst, failing, firstFailure, fittingFailures, firstFittingFailure };
}

/** One generated tree, node by node, with our box and the browser's: what to read when a tree fails. Browser only. */
export function describeCase(seed: number): string {
  const c = generate(seed);
  const ours = measureSolved(solve(c.tree, c.width, c.height));
  const dom = inDom(c.tree, c.width, c.height);
  document.body.append(dom);
  const theirs = measureDom(dom);
  dom.remove();
  const rows: string[] = [];
  const visit = (node: Node<OracleLeaf | null>, path: string): void => {
    const box = node.box === null ? null : { ...node.box, pad: node.box.pad.join(',') };
    rows.push(`${path} ${JSON.stringify({ style: node.style, box, payload: node.payload })} ours=${JSON.stringify(ours.get(path))} dom=${JSON.stringify(theirs.get(path))}`);
    node.children.forEach((k, i) => visit(k, `${path}.${i}`));
  };
  visit(c.tree, '0');
  return rows.join('\n');
}
