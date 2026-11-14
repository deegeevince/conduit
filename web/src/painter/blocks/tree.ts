// Tree: a tidy tree. A parent is centred over its children, subtrees sit as
// close as they can without touching (contours compared level by level),
// siblings share a line, connectors are elbows through a shared bar.

import type { Point, Polyline } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, boxOfPoints, simplify, union } from './geom';
import type { Draft, LinkSpec, NodeBox, Note } from './kit';
import { best, connectorParts, Env, fit, labelPart, linkSpecs, nodeParts, placeBeside, sizeNode, WRAPS } from './kit';

type Grow = 'right' | 'down';

interface T {
  readonly n: NodeBox | null;
  readonly kids: T[];
  depth: number;
  /** centre across, relative to the parent's frame while laying out, absolute afterwards */
  x: number;
  c: number;
  link: LinkSpec | null;
}

const pairsOf = (pts: readonly Point[]): (readonly [Point, Point])[] => pts.slice(0, -1).map((q, i) => [q, pts[i + 1] as Point] as const);

export function layoutTree(input: StructureInput): StructureLayout {
  const f = input.structure.figure;
  const forced = f?.kind === 'structure' ? f.grow : null;
  const preferred: Grow = forced ?? 'down';
  const other: Grow = preferred === 'right' ? 'down' : 'right';
  const attempts: (() => StructureLayout)[] = [];
  for (const wrap of WRAPS) for (const grow of [preferred, other]) attempts.push(() => fit(input, input.look.stroke, (env) => buildTree(env, grow), undefined, wrap));
  return best(attempts);
}

function buildTree(env: Env, grow: Grow): Draft {
  const body = env.body;
  const down = grow === 'down';
  const nodes = env.input.nodes.map((el) => sizeNode(env, el));
  const links = linkSpecs(env.input);
  const parentOf = new Map<string, LinkSpec>();
  const isAbove = (anc: string, key: string): boolean => {
    for (let k: string | undefined = key, i = 0; k !== undefined && i < 64; i += 1) {
      if (k === anc) return true;
      k = parentOf.get(k)?.from;
    }
    return false;
  };
  for (const l of links) if (!parentOf.has(l.to) && !isAbove(l.to, l.from)) parentOf.set(l.to, l);

  const trees = new Map<string, T>();
  for (const n of nodes) trees.set(n.el.key, { n, kids: [], depth: 0, x: 0, c: down ? n.width : n.height, link: null });
  const roots: T[] = [];
  for (const n of nodes) {
    const t = trees.get(n.el.key) as T;
    const p = parentOf.get(n.el.key);
    if (p) {
      (trees.get(p.from) as T).kids.push(t);
      t.link = p;
    } else roots.push(t);
  }
  const aOf = (n: NodeBox): number => (down ? n.height : n.width);
  const sibling = env.up(0.8 * body * env.tight, down ? 'x' : 'y');
  const forest: T = { n: null, kids: roots, depth: -1, x: 0, c: 0, link: null };

  // Contours: for each depth below, the leftmost and rightmost extent across, relative to this node's centre.
  interface Contour { left: number[]; right: number[] }
  const place = (t: T): Contour => {
    const own: Contour = { left: [-t.c / 2], right: [t.c / 2] };
    if (t.kids.length === 0) return own;
    const subs = t.kids.map(place);
    const offsets: number[] = [0];
    let accL = subs[0]!.left.slice();
    let accR = subs[0]!.right.slice();
    for (let i = 1; i < subs.length; i += 1) {
      const s = subs[i] as Contour;
      let shift = -Infinity;
      for (let d = 0; d < Math.min(accR.length, s.left.length); d += 1) shift = Math.max(shift, (accR[d] as number) - (s.left[d] as number) + sibling);
      if (t.n === null) shift = Math.max(shift, 0);
      offsets.push(shift);
      for (let d = 0; d < s.left.length; d += 1) {
        const l = (s.left[d] as number) + shift;
        const r = (s.right[d] as number) + shift;
        if (d < accL.length) {
          accL[d] = Math.min(accL[d] as number, l);
          accR[d] = Math.max(accR[d] as number, r);
        } else {
          accL.push(l);
          accR.push(r);
        }
      }
    }
    const mid = ((offsets[0] as number) + (offsets[offsets.length - 1] as number)) / 2;
    t.kids.forEach((k, i) => (k.x = (offsets[i] as number) - mid));
    return { left: [own.left[0] as number, ...accL.map((v) => v - mid)], right: [own.right[0] as number, ...accR.map((v) => v - mid)] };
  };
  const contour = place(forest);
  // Absolute cross positions, and depths.
  const levels: T[][] = [];
  const settle = (t: T, x: number, depth: number): void => {
    t.x = env.centre(x, t.c, down ? 'x' : 'y');
    t.depth = depth;
    if (t.n) (levels[depth] ??= []).push(t);
    for (const k of t.kids) settle(k, x + k.x, depth + 1);
  };
  forest.kids.forEach((k) => settle(k, k.x, 0));
  const small = env.label();
  const labelM = new Map<T, { width: number; height: number }>();
  for (const t of trees.values()) if (t.link?.label) labelM.set(t, env.measure(t.link.label, env.wrapWidth, small));

  const thick = levels.map((l) => Math.max(...l.map((t) => aOf(t.n as NodeBox))));
  const head = env.headLength;
  const start: number[] = [];
  const gap: number[] = [];
  let cur = 0;
  levels.forEach((l, d) => {
    start.push(cur);
    let lab = 0;
    for (const t of levels[d + 1] ?? []) {
      const m = labelM.get(t);
      if (m) lab = Math.max(lab, down ? m.height : m.width);
    }
    const g = env.up(Math.max(2.4 * body * env.tight, lab ? 2 * (lab + head + 0.5 * body) : 0, 2 * head + body), down ? 'y' : 'x');
    gap.push(g);
    cur += (thick[d] as number) + g;
  });
  const total = levels.length ? cur - (gap[gap.length - 1] as number) : 0;
  let cMin = Infinity;
  let cMax = -Infinity;
  for (const l of levels) for (const t of l) {
    cMin = Math.min(cMin, t.x - t.c / 2);
    cMax = Math.max(cMax, t.x + t.c / 2);
  }
  if (!(cMin <= cMax)) {
    cMin = 0;
    cMax = 0;
  }
  void contour;
  const title = env.title();
  const T2 = (a: number, c: number): Point => (down ? { x: c, y: a } : { x: a, y: c });

  const finish = (room: Box): ReturnType<Draft['finish']> => {
    const lo = down ? room.x : room.y + title.h;
    const hi = down ? room.x + room.width : room.y + room.height;
    let dc0 = (lo + hi) / 2 - (roots[0]?.x ?? 0);
    const fitsAcross = cMax - cMin <= hi - lo;
    if (fitsAcross) dc0 = Math.max(lo - cMin, Math.min(hi - cMax, dc0));
    else dc0 = (lo + hi) / 2 - (cMin + cMax) / 2;
    const dc = fitsAcross ? env.within(dc0, lo - cMin, hi - cMax, down ? 'x' : 'y') : env.snap(dc0, down ? 'x' : 'y');
    const da = env.after(down ? room.y + title.h : room.x, down ? 'y' : 'x');
    const P = (a: number, c: number): Point => T2(a + da, c + dc);
    const boxes = new Map<string, Box>();
    const routes = new Map<string, Polyline>();
    const notes: Note[] = [];
    const fills: BlockPart[] = [];
    const frames: BlockPart[] = [];
    const words: BlockPart[] = [];
    const lines: BlockPart[] = [];
    const heads: BlockPart[] = [];
    const labels: BlockPart[] = [];
    const nodeBoxes: Box[] = [];
    levels.forEach((l, d) => {
      for (const t of l) {
        const n = t.n as NodeBox;
        const a = thick[d] as number;
        const tl = P(start[d] as number, t.x - t.c / 2);
        const w = down ? t.c : a;
        const h = down ? a : t.c;
        const at = box(tl.x, tl.y, w, h);
        n.width = w;
        n.height = h;
        boxes.set(n.el.key, at);
        nodeBoxes.push(at);
        nodeParts(env, n, at, fills, frames, words);
      }
    });
    const placed: { t: T; pts: Point[]; stem: Point[] }[] = [];
    for (const l of levels) for (const t of l) {
      if (!t.link) continue;
      const parent = trees.get(t.link.from) as T;
      const d = parent.depth;
      const aOut = (start[d] as number) + (thick[d] as number);
      const aIn = start[d + 1] as number;
      const mid = aOut + ((aIn - aOut) / 2);
      const midS = env.snap(mid + da, down ? 'y' : 'x') - da;
      const pts = simplify([P(aOut, parent.x), P(midS, parent.x), P(midS, t.x), P(aIn, t.x)]);
      routes.set(t.link.el.key, { points: pts, closed: false });
      placed.push({ t, pts, stem: [P(midS, t.x), P(aIn, t.x)] });
      connectorParts(env, t.link, pts, lines, heads);
    }
    const taken: Box[] = [];
    const allLines = [...routes.values()];
    for (const p of placed) {
      const m = labelM.get(p.t);
      if (!m || !p.t.link) continue;
      const a = p.stem[0] as Point;
      const b = p.stem[1] as Point;
      const pick = placeBeside([[a, b], ...pairsOf(p.pts)], m.width, m.height, env.stroke * 1.5 + 3, { boxes: [...nodeBoxes, ...taken], lines: allLines }, null);
      if (!pick) continue;
      if (pick.penalty > 0) notes.push({ key: p.t.link.el.key, note: 'crossed' });
      taken.push(pick.box);
      labels.push(labelPart(env, p.t.link.el.key, p.t.link.label, pick.box, m, pick.penalty > 0));
    }
    for (const p of placed) {
      const key = (p.t.link as LinkSpec).el.key;
      const lb = labels.find((x) => x.owner === key);
      const rb = boxOfPoints(p.pts);
      boxes.set(key, lb && lb.kind === 'text' ? union([lb.box, rb]) : rb);
    }
    const tp = title.part(room);
    return { parts: [...(tp ? [tp] : []), ...fills, ...lines, ...heads, ...frames, ...words, ...labels], boxes, routes, notes };
  };
  return { width: down ? cMax - cMin : total, height: (down ? total : cMax - cMin) + title.h, finish };
}
