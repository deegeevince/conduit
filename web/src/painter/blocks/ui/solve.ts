// The auto-layout solver (PLAN-v2.2 E13): the useful subset of flexbox, solved as a pure function.
//
// Row and column; gap; padding; align (start, centre, end, stretch); justify (start, centre, end, between); grow and
// shrink; wrap on a row; hug, fill or a number for each side; least and most sizes. It follows CSS's own algorithm
// (css-flexbox-1: flex base size, hypothetical size, resolving flexible lengths with min and max violations, automatic
// minimum sizes, stretch, align-content: stretch), so the browser is its test oracle: `ui-bench` lays out generated
// trees in both and compares every box.
//
// No DOM, no clock, no fonts. Text is sized through the `fit` of a leaf, which the kit builds from the painter's measurer.
// The same input always gives the same boxes, on screen, in an export and under `tsx`.

export type Dim = number | 'hug' | 'fill';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'between';

export interface Fit {
  readonly w: number;
  readonly h: number;
}

export interface Leaf {
  /** the size it takes when it has at most `maxWidth` across (Infinity: all the room it wants) */
  readonly fit: (maxWidth: number) => Fit;
  /** the narrowest it can be set: the longest word, an icon's own width */
  readonly minW: number;
}

export interface Style {
  /** `hug` is CSS's `auto`; `fill` is `flex: 1 1 0` along a row and `100%` across a column */
  readonly width: Dim;
  readonly height: Dim;
  readonly minW?: number;
  readonly maxW?: number;
  readonly minH?: number;
  readonly maxH?: number;
  /** flex-grow, with the basis the item's own size */
  readonly grow?: number;
  /** flex-shrink; 1 when absent */
  readonly shrink?: number;
  /** `auto` takes the container's `align` */
  readonly self?: 'auto' | Align;
}

export interface Box {
  readonly dir: 'row' | 'col';
  readonly gap: number;
  /** top, right, bottom, left */
  readonly pad: readonly [number, number, number, number];
  readonly align: Align;
  readonly justify: Justify;
  readonly wrap: boolean;
}

export interface Node<P> {
  readonly style: Style;
  /** a container, or null for a leaf */
  readonly box: Box | null;
  readonly leaf: Leaf | null;
  readonly children: readonly Node<P>[];
  readonly payload: P;
}

export interface Placed<P> {
  /** relative to the parent's top-left */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly node: Node<P>;
  readonly children: readonly Placed<P>[];
}

const clamp = (v: number, lo: number | undefined, hi: number | undefined): number => Math.max(lo ?? 0, hi === undefined ? v : Math.min(v, hi));

/** a box is never narrower or lower than its own padding (border-box sizing) */
const floorW = <P>(n: Node<P>): number => (n.box === null ? 0 : n.box.pad[1] + n.box.pad[3]);
const floorH = <P>(n: Node<P>): number => (n.box === null ? 0 : n.box.pad[0] + n.box.pad[2]);
const cw = <P>(n: Node<P>, v: number): number => Math.max(clamp(v, n.style.minW, n.style.maxW), floorW(n));
const chh = <P>(n: Node<P>, v: number): number => Math.max(clamp(v, n.style.minH, n.style.maxH), floorH(n));

// ------------------------------------------------------------ intrinsic sizes

interface Caches {
  readonly max: Map<object, number>;
  readonly min: Map<object, number>;
  readonly height: Map<object, Map<number, number>>;
  readonly plan: Map<object, Map<string, Plan<unknown>>>;
}

function newCaches(): Caches {
  return { max: new Map(), min: new Map(), height: new Map(), plan: new Map() };
}

function padW(b: Box): number {
  return b.pad[1] + b.pad[3];
}
function padH(b: Box): number {
  return b.pad[0] + b.pad[2];
}

/** max-content width, border box, with the node's own least and most applied */
function maxContent<P>(n: Node<P>, c: Caches): number {
  return cw(n, maxContentRaw(n, c));
}

/** what the content asks for with nothing clamped: the flex base size of a hug item is this, whatever its `maxW` */
function maxContentRaw<P>(n: Node<P>, c: Caches): number {
  const hit = c.max.get(n);
  if (hit !== undefined) return hit;
  let w: number;
  if (typeof n.style.width === 'number') w = n.style.width;
  else if (n.leaf !== null) w = n.leaf.fit(Number.POSITIVE_INFINITY).w;
  else if (n.box !== null) {
    const kids = n.children.map((k) => maxContent(k, c));
    w = n.box.dir === 'row' ? kids.reduce((s, v) => s + v, 0) + Math.max(0, kids.length - 1) * n.box.gap + padW(n.box) : Math.max(0, ...kids) + padW(n.box);
  } else w = 0;
  c.max.set(n, w);
  return w;
}

/** the flex base size of an item along a row: the width it was given, nothing (but its own padding) if it fills, else all its words want */
function flexBase<P>(k: Node<P>, c: Caches): number {
  const w = k.style.width;
  return typeof w === 'number' ? Math.max(w, floorW(k)) : w === 'fill' ? floorW(k) : maxContentRaw(k, c);
}

/** min-content width, border box, with the node's own `minW` and `maxW` applied */
function minContent<P>(n: Node<P>, c: Caches): number {
  // an item with a width of its own contributes that width to its parent's minimum, though it may shrink below it as a flex item
  if (typeof n.style.width === 'number') return cw(n, n.style.width);
  return cw(n, minContentRaw(n, c));
}

/** the automatic minimum: what the content needs, before any `minW` the node was given (an explicit one replaces it) */
function minContentRaw<P>(n: Node<P>, c: Caches): number {
  const hit = c.min.get(n);
  if (hit !== undefined) return hit;
  let w: number;
  if (n.leaf !== null) w = n.leaf.minW;
  else if (n.box !== null) {
    // along a single row an item that cannot shrink asks for all of its width
    const alongRow = n.box.dir === 'row' && !n.box.wrap;
    const kids = n.children.map((k) => (alongRow && k.style.shrink === 0 && k.box?.wrap !== true ? Math.max(minContent(k, c), cw(k, flexBase(k, c))) : minContent(k, c)));
    w = alongRow ? kids.reduce((s, v) => s + v, 0) + Math.max(0, kids.length - 1) * n.box.gap + padW(n.box) : Math.max(0, ...kids) + padW(n.box);
  } else w = 0;
  // a specified width caps the automatic minimum
  if (typeof n.style.width === 'number') w = Math.min(w, n.style.width);
  c.min.set(n, w);
  return w;
}

/** width an item takes across a column (cross axis) given the room: stretch fills it, otherwise it is as wide as its words want */
function crossWidth<P>(n: Node<P>, room: number, alignOf: Align, c: Caches): number {
  const s = n.style;
  if (typeof s.width === 'number') return cw(n, s.width);
  if (s.width === 'fill') return cw(n, room);
  if (alignOf === 'stretch') return cw(n, room);
  return cw(n, Math.min(maxContent(n, c), Math.max(minContent(n, c), room)));
}

function selfAlign<P>(n: Node<P>, parent: Box): Align {
  const s = n.style.self;
  return s === undefined || s === 'auto' ? parent.align : s;
}

/** where a clamped fill sits across: at the start, as a stretched item does, unless it asked to be centred or ended */
function placeAlign<P>(n: Node<P>, parent: Box, across: 'width' | 'height'): Align {
  const s = n.style.self;
  const fill = n.style[across] === 'fill';
  if (fill && (s === undefined || s === 'auto' || s === 'stretch')) return 'start';
  return selfAlign(n, parent);
}

// ------------------------------------------------------------ one container, planned

interface Slot {
  readonly main: number;
  readonly cross: number;
  /** offset along the main axis from the inner start, and along the cross axis from the inner start */
  readonly mainAt: number;
  readonly crossAt: number;
}

interface Plan<P> {
  readonly w: number;
  readonly h: number;
  readonly slots: readonly Slot[];
  readonly node: Node<P>;
}

interface Item {
  readonly index: number;
  readonly base: number;
  readonly min: number;
  readonly max: number | undefined;
  readonly grow: number;
  readonly shrink: number;
  /** padding along the main axis: the shrink factor is scaled by the base size inside it */
  readonly inset: number;
  /** hypothetical main size */
  readonly hyp: number;
  target: number;
  frozen: boolean;
}

/** CSS 9.7: resolves the flexible lengths of one line to `room` along the main axis. */
function resolveLine(items: Item[], room: number, gap: number): void {
  const gaps = Math.max(0, items.length - 1) * gap;
  const hypSum = items.reduce((s, i) => s + i.hyp, 0) + gaps;
  const growing = hypSum < room;
  for (const i of items) {
    i.frozen = false;
    i.target = i.base;
    const factor = growing ? i.grow : i.shrink;
    if (factor === 0 || (growing && i.base > i.hyp) || (!growing && i.base < i.hyp)) {
      i.frozen = true;
      i.target = i.hyp;
    }
  }
  const initial = room - gaps - items.reduce((s, i) => s + (i.frozen ? i.target : i.base), 0);
  for (let guard = 0; guard < items.length + 2; guard++) {
    const open = items.filter((i) => !i.frozen);
    if (open.length === 0) break;
    const used = items.reduce((s, i) => s + (i.frozen ? i.target : i.base), 0);
    let free = room - gaps - used;
    const factorSum = open.reduce((s, i) => s + (growing ? i.grow : i.shrink), 0);
    if (factorSum < 1) {
      const capped = initial * factorSum;
      if (Math.abs(capped) < Math.abs(free)) free = capped;
    }
    if (growing) {
      for (const i of open) i.target = factorSum === 0 ? i.base : i.base + (free * i.grow) / factorSum;
    } else {
      const scaled = open.reduce((s, i) => s + i.shrink * (i.base - i.inset), 0);
      for (const i of open) i.target = scaled === 0 ? i.base : i.base + (free * (i.shrink * (i.base - i.inset))) / scaled;
    }
    let violation = 0;
    const clamped = new Map<Item, number>();
    for (const i of open) {
      const v = clamp(i.target, i.min, i.max);
      clamped.set(i, v);
      violation += v - i.target;
    }
    for (const i of open) {
      const v = clamped.get(i) ?? i.target;
      if (violation === 0 || (violation > 0 && v > i.target) || (violation < 0 && v < i.target)) {
        i.target = v;
        i.frozen = true;
      }
    }
  }
}

/**
 * Plans a container given its border-box width `W` and height `H` (null: as tall as its content). Along a row the
 * children's widths come from flexing; across, from alignment. In a column the widths come first (stretch, fill, or what
 * the words want) and the heights follow from the widths.
 */
function plan<P>(n: Node<P>, W: number, H: number | null, c: Caches): Plan<P> {
  const key = `${W}|${H ?? 'x'}`;
  const byNode = c.plan.get(n);
  const known = byNode?.get(key);
  if (known !== undefined) return known as Plan<P>;
  const made = planUncached(n, W, H, c);
  if (byNode === undefined) c.plan.set(n, new Map([[key, made as Plan<unknown>]]));
  else byNode.set(key, made as Plan<unknown>);
  return made;
}

function planUncached<P>(n: Node<P>, W: number, H: number | null, c: Caches): Plan<P> {
  const box = n.box;
  if (box === null) return { w: W, h: H ?? 0, slots: [], node: n };
  const innerW = Math.max(0, W - padW(box));
  const innerH = H === null ? null : Math.max(0, H - padH(box));
  const row = box.dir === 'row';
  const kids = n.children;
  const slots: Slot[] = new Array<Slot>(kids.length);

  if (row) {
    // ---- along the row: flex base sizes, then lines, then resolved widths
    const items: Item[] = kids.map((k, index) => {
      const s = k.style;
      const fill = s.width === 'fill';
      const grow = fill ? Math.max(1, s.grow ?? 0) : (s.grow ?? 0);
      const base = flexBase(k, c);
      const min = Math.max(s.minW ?? Math.min(minContentRaw(k, c), s.maxW ?? Number.POSITIVE_INFINITY), floorW(k));
      const hyp = clamp(base, min, s.maxW);
      return { index, base, min, max: s.maxW, grow, shrink: s.shrink ?? 1, inset: floorW(k), hyp, target: hyp, frozen: false };
    });
    const lines: Item[][] = [];
    if (box.wrap) {
      let line: Item[] = [];
      let used = 0;
      for (const it of items) {
        const next = used + (line.length > 0 ? box.gap : 0) + it.hyp;
        if (line.length > 0 && next > innerW + 1e-9) {
          lines.push(line);
          line = [it];
          used = it.hyp;
        } else {
          line.push(it);
          used = next;
        }
      }
      if (line.length > 0) lines.push(line);
    } else if (items.length > 0) lines.push(items);
    for (const line of lines) resolveLine(line, innerW, box.gap);

    // ---- across: each item's cross size, line cross sizes, alignment
    const crossOf = (it: Item): number => {
      const k = kids[it.index];
      if (k === undefined) return 0;
      const s = k.style;
      if (typeof s.height === 'number') return chh(k, s.height);
      return chh(k, heightOf(k, it.target, c));
    };
    const lineCross = lines.map((line) => Math.max(0, ...line.map(crossOf)));
    let linesTotal = lineCross.reduce((s, v) => s + v, 0) + Math.max(0, lines.length - 1) * box.gap;
    let contentH: number;
    if (!box.wrap && innerH !== null) {
      // a single line in a box of known height takes all of it
      if (lineCross.length > 0) lineCross[0] = innerH;
      linesTotal = innerH;
      contentH = innerH;
    } else if (innerH !== null) {
      const free = innerH - linesTotal;
      if (free > 0 && lineCross.length > 0) for (let i = 0; i < lineCross.length; i++) lineCross[i] = (lineCross[i] ?? 0) + free / lineCross.length;
      contentH = innerH;
    } else contentH = linesTotal;
    let y = 0;
    lines.forEach((line, li) => {
      const crossRoom = lineCross[li] ?? 0;
      const gaps = Math.max(0, line.length - 1) * box.gap;
      const used = line.reduce((s, i) => s + i.target, 0) + gaps;
      const free = innerW - used;
      let x = 0;
      let between = 0;
      if (box.justify === 'center') x = free / 2;
      else if (box.justify === 'end') x = free;
      else if (box.justify === 'between' && line.length > 1 && free > 0) between = free / (line.length - 1);
      for (const it of line) {
        const k = kids[it.index];
        if (k === undefined) continue;
        const s = k.style;
        const a = selfAlign(k, box);
        const placeA = placeAlign(k, box, 'height');
        const given = typeof s.height === 'number' ? chh(k, s.height) : s.height === 'fill' ? chh(k, crossRoom) : null;
        const own = crossOf(it);
        const size = given ?? (a === 'stretch' ? chh(k, crossRoom) : own);
        const at = placeA === 'center' ? (crossRoom - size) / 2 : placeA === 'end' ? crossRoom - size : 0;
        slots[it.index] = { main: it.target, cross: size, mainAt: x, crossAt: y + at };
        x += it.target + box.gap + between;
      }
      y += crossRoom + box.gap;
    });
    for (let i = 0; i < kids.length; i++) if (slots[i] === undefined) slots[i] = { main: 0, cross: 0, mainAt: 0, crossAt: 0 };
    const h = H ?? contentH + padH(box);
    return { w: W, h: clamp(h, n.style.minH, undefined), slots, node: n };
  }

  // ---- column: widths first, then heights from the widths
  const widths = kids.map((k) => crossWidth(k, innerW, selfAlign(k, box), c));
  const items: Item[] = kids.map((k, index) => {
    const s = k.style;
    const fill = s.height === 'fill';
    const grow = fill ? Math.max(1, s.grow ?? 0) : (s.grow ?? 0);
    const content = heightOf(k, widths[index] ?? 0, c, true);
    const natural = chh(k, content);
    const base = typeof s.height === 'number' ? Math.max(s.height, floorH(k)) : fill && innerH !== null ? floorH(k) : natural;
    const autoMin = typeof s.height === 'number' ? Math.min(s.height, content) : content;
    const min = Math.max(s.minH ?? Math.min(autoMin, s.maxH ?? Number.POSITIVE_INFINITY), floorH(k));
    const hyp = clamp(base, min, s.maxH);
    return { index, base, min, max: s.maxH, grow, shrink: s.shrink ?? 1, inset: floorH(k), hyp, target: hyp, frozen: false };
  });
  const line = items;
  const gaps = Math.max(0, line.length - 1) * box.gap;
  if (innerH !== null) resolveLine(line, innerH, box.gap);
  const used = line.reduce((s, i) => s + i.target, 0) + gaps;
  const contentH = innerH ?? used;
  const free = (innerH ?? used) - used;
  let y = 0;
  let between = 0;
  if (box.justify === 'center') y = free / 2;
  else if (box.justify === 'end') y = free;
  else if (box.justify === 'between' && line.length > 1 && free > 0) between = free / (line.length - 1);
  for (const it of line) {
    const k = kids[it.index];
    if (k === undefined) continue;
    const w = widths[it.index] ?? 0;
    const a = placeAlign(k, box, 'width');
    const at = a === 'center' ? (innerW - w) / 2 : a === 'end' ? innerW - w : 0;
    slots[it.index] = { main: it.target, cross: w, mainAt: y, crossAt: at };
    y += it.target + box.gap + between;
  }
  const h = H ?? contentH + padH(box);
  return { w: W, h: clamp(h, n.style.minH, undefined), slots, node: n };
}

/** a node's height at a border-box width. `content` ignores a height it was given (the automatic minimum is the content's). */
function heightOf<P>(n: Node<P>, w: number, c: Caches, content = false): number {
  if (!content && typeof n.style.height === 'number') return n.style.height;
  let byW = c.height.get(n);
  if (byW === undefined) {
    byW = new Map();
    c.height.set(n, byW);
  }
  const hit = byW.get(w);
  if (hit !== undefined) return hit;
  const h = n.leaf !== null ? n.leaf.fit(w).h : plan(n, w, null, c).h;
  byW.set(w, h);
  return h;
}

// ------------------------------------------------------------ placing

function place<P>(n: Node<P>, W: number, H: number, c: Caches): Placed<P> {
  const box = n.box;
  if (box === null) return { x: 0, y: 0, w: W, h: H, node: n, children: [] };
  const p = plan(n, W, H, c);
  const row = box.dir === 'row';
  const children = n.children.map((k, i) => {
    const slot = p.slots[i];
    if (slot === undefined) return place(k, 0, 0, c);
    const cw = row ? slot.main : slot.cross;
    const ch = row ? slot.cross : slot.main;
    const placed = place(k, cw, ch, c);
    const x = (row ? slot.mainAt : slot.crossAt) + box.pad[3];
    const y = (row ? slot.crossAt : slot.mainAt) + box.pad[0];
    return { ...placed, x, y };
  });
  return { x: 0, y: 0, w: W, h: H, node: n, children };
}

/**
 * Lays a tree out in a room of exactly `width` by `height` (a screen's own size). The root fills it. Returns every
 * node's box, each relative to its parent.
 */
export function solve<P>(root: Node<P>, width: number, height: number): Placed<P> {
  return place(root, width, height, newCaches());
}

/** The height a tree takes at a given width, when its height is not given: a page's length. */
export function contentHeight<P>(root: Node<P>, width: number): number {
  return plan(root, width, null, newCaches()).h;
}

/** Visits every placed node with its absolute position. */
export function walk<P>(root: Placed<P>, visit: (p: Placed<P>, x: number, y: number, depth: number) => void, ox = 0, oy = 0, depth = 0): void {
  const x = ox + root.x;
  const y = oy + root.y;
  visit(root, x, y, depth);
  for (const k of root.children) walk(k, visit, x, y, depth + 1);
}
