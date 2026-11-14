// Callouts: boundary labelling, as a technical illustrator does it. Labels go
// outside the drawing, in columns to its left and right (above and below when
// it is wide), sharing the edge next to the drawing. Each label stands on the
// side nearest the point it names, in the order of those points along that
// side, so the leaders do not cross; each has one straight leader from the edge
// of the label to a point on the part's own shape (never another part), chosen
// so it runs through as little of the drawing as it can.
//
// When the room beside the drawing is too narrow for the words, the type is
// made smaller, down to a floor, and then the labels stack on the two sides
// close to the drawing's outline (clear of every stroke and fill, though inside
// its box) before any label is put over it.

import type { Point, Polyline } from '@conduit/language';
import type { CalloutInput, CalloutLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, bottom, centreOf, contains, inflate, open, overlaps, packOrdered, polylineHitsBox, right, segmentsCross } from './geom';

type Side = 'left' | 'right' | 'above' | 'below';
type Mode = 'outer' | 'hug';
type L = CalloutInput['labels'][number];

const SIDES: readonly Side[] = ['left', 'right', 'above', 'below'];

/** The part a label names: its own shape, as the leader sees it. */
interface Part {
  readonly pts: readonly Point[];
  readonly closed: boolean;
  readonly filled: boolean;
  /** points of its own outline a leader may land on */
  readonly samples: readonly Point[];
  /** the point the side is chosen by: the middle of a closed shape, the middle along an open one */
  readonly anchor: Point;
}

interface Solved {
  boxes: Box[];
  leaders: Point[][];
  cost: number;
  /** how many things that cannot stand: a label off the room, on the drawing or on another label, or a leader through a label */
  fatal: number;
  /** leaders that cross one another or another labelled part */
  crossings: number;
  overlap: boolean[];
  crossed: boolean[];
}

interface Plan {
  solved: Solved;
  scale: number;
}

const SAMPLES = 28;

function edgesOf(pts: readonly Point[], closed: boolean): [Point, Point][] {
  const out: [Point, Point][] = [];
  const m = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < m; i += 1) out.push([pts[i] as Point, pts[(i + 1) % pts.length] as Point]);
  return out;
}

function lengthAlong(pts: readonly Point[], closed: boolean): number {
  let total = 0;
  for (const [a, b] of edgesOf(pts, closed)) total += Math.hypot(b.x - a.x, b.y - a.y);
  return total;
}

/** The point at distance `d` along the line. */
function pointAt(pts: readonly Point[], closed: boolean, d: number): Point {
  let left = d;
  for (const [a, b] of edgesOf(pts, closed)) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || len === 0) {
      const t = len === 0 ? 0 : left / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= len;
  }
  return pts[pts.length - 1] as Point;
}

function insidePolygon(p: Point, pts: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i] as Point;
    const b = pts[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function boundsOf(pts: readonly Point[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return box(x0, y0, x1 - x0, y1 - y0);
}

export function layoutCallouts(input: CalloutInput): CalloutLayout {
  const labels = input.labels;
  const n = labels.length;
  if (n === 0) return { boxes: new Map(), leaders: new Map(), notes: [] };
  const body = input.look.body;
  const gap = 1.1 * body;
  const sep = 0.35 * body;
  const room = input.room;
  const fig = input.figure;
  const stroke = Math.max(1, input.look.stroke);
  const wide = fig.width > 1.8 * fig.height;
  const fills = input.fills ?? [];
  const hugGap = Math.max(0.5 * body, stroke * 2 + 4);

  // The parts ------------------------------------------------------------
  const parts: Part[] = labels.map((l) => {
    const t = l.target;
    let pts: Point[];
    let closed: boolean;
    let filled = false;
    if (l.outline !== undefined && l.outline.points.length >= 2) {
      pts = [...l.outline.points];
      closed = l.outline.closed;
      filled = closed && l.filled === true;
    } else if ('width' in t) {
      pts = [{ x: t.x, y: t.y }, { x: t.x + t.width, y: t.y }, { x: t.x + t.width, y: t.y + t.height }, { x: t.x, y: t.y + t.height }];
      closed = true;
    } else {
      return { pts: [t], closed: false, filled: false, samples: [t], anchor: t };
    }
    const total = lengthAlong(pts, closed);
    const count = Math.max(8, SAMPLES);
    const samples: Point[] = [];
    for (let k = 0; k < count; k += 1) samples.push(pointAt(pts, closed, (total * (closed ? k : k / (count - 1))) / (closed ? count : 1)));
    // the corners of a short outline are as good a landing as any
    if (pts.length <= 8) samples.push(...pts);
    const b = boundsOf(pts);
    const anchor = closed ? centreOf(b) : pointAt(pts, false, total / 2);
    return { pts, closed, filled, samples, anchor };
  });

  // Ink: what a label must not sit on ----------------------------------------
  const inkHits = (b: Box): boolean => {
    const g = inflate(b, 1);
    for (const s of input.strokes) if (polylineHitsBox(s, g)) return true;
    const c = centreOf(b);
    for (const f of fills) {
      if (f.points.length < 3) continue;
      if (insidePolygon(c, f.points) || insidePolygon({ x: b.x, y: b.y }, f.points) || insidePolygon({ x: right(b), y: b.y }, f.points) || insidePolygon({ x: b.x, y: bottom(b) }, f.points) || insidePolygon({ x: right(b), y: bottom(b) }, f.points)) return true;
    }
    return false;
  };
  /** the nearest and farthest x of ink in a band of y: the silhouette a label stacks against */
  const inkBand = (y0: number, y1: number): { min: number; max: number } | null => {
    let mn = Infinity;
    let mx = -Infinity;
    const take = (a: Point, b: Point): void => {
      if (Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1) return;
      const dy = b.y - a.y;
      let ta = 0;
      let tb = 1;
      if (dy !== 0) {
        const t0 = (y0 - a.y) / dy;
        const t1 = (y1 - a.y) / dy;
        ta = Math.max(0, Math.min(t0, t1));
        tb = Math.min(1, Math.max(t0, t1));
      }
      const xa = a.x + (b.x - a.x) * ta;
      const xb = a.x + (b.x - a.x) * tb;
      mn = Math.min(mn, xa, xb);
      mx = Math.max(mx, xa, xb);
    };
    for (const s of input.strokes) for (const [a, b] of edgesOf(s.points, s.closed)) take(a, b);
    return mn === Infinity ? null : { min: mn, max: mx };
  };

  // Leaders --------------------------------------------------------------------
  const nearOnOutline = (i: number, from: Point): Point => {
    const part = parts[i] as Part;
    let best = part.samples[0] as Point;
    let bd = Infinity;
    for (const [a, b] of edgesOf(part.pts, part.closed)) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((from.x - a.x) * dx + (from.y - a.y) * dy) / len2));
      const p = { x: a.x + t * dx, y: a.y + t * dy };
      const d = Math.hypot(p.x - from.x, p.y - from.y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  /** what a leader along `path` costs by what it runs through before it lands (the last few widths are where it lands) */
  const leaderCost = (i: number, path: readonly Point[]): number => {
    const segs: [Point, Point][] = [];
    let len = 0;
    for (let k = 0; k + 1 < path.length; k += 1) {
      const a = path[k] as Point;
      let e = path[k + 1] as Point;
      const l = Math.hypot(e.x - a.x, e.y - a.y);
      len += l;
      if (k + 2 === path.length) {
        const cut = Math.min(l, stroke * 3 + 2);
        const f = l === 0 ? 0 : (l - cut) / l;
        e = { x: a.x + (e.x - a.x) * f, y: a.y + (e.y - a.y) * f };
      }
      segs.push([a, e]);
    }
    let c = 0;
    for (let j = 0; j < n; j += 1) {
      const part = parts[j] as Part;
      let hits = 0;
      for (const [p, q] of edgesOf(part.pts, part.closed)) for (const [a, e] of segs) if (segmentsCross(a, e, p, q)) hits += 1;
      if (j !== i) {
        if (hits > 0) c += 250;
      } else c += 80 * hits;
    }
    for (const s of input.strokes) {
      let hit = false;
      for (const [p, q] of edgesOf(s.points, s.closed)) {
        for (const [a, e] of segs) if (segmentsCross(a, e, p, q)) hit = true;
        if (hit) break;
      }
      if (hit) c += 12;
    }
    return c + len * 0.02 + (path.length > 2 ? 15 : 0);
  };
  const endMemo = new Map<string, { path: Point[]; cost: number }[]>();
  /** the ways from `a` to the part's own outline, cheapest first: straight, or with one bend, to each of the points it may land on */
  const endsFor = (i: number, a: Point): { path: Point[]; cost: number }[] => {
    const key = `${i}|${Math.round(a.x / 3)}|${Math.round(a.y / 3)}`;
    const memo = endMemo.get(key);
    if (memo !== undefined) return memo;
    const part = parts[i] as Part;
    const all: { path: Point[]; cost: number }[] = [];
    for (const p of [...part.samples, nearOnOutline(i, a)]) {
      const options: Point[][] = [[a, p]];
      if (Math.abs(p.x - a.x) > stroke * 4 && Math.abs(p.y - a.y) > stroke * 4) options.push([a, { x: p.x, y: a.y }, p], [a, { x: a.x, y: p.y }, p]);
      for (const path of options) all.push({ path, cost: leaderCost(i, path) });
    }
    all.sort((x, y) => x.cost - y.cost);
    const out = all.slice(0, 24);
    endMemo.set(key, out);
    return out;
  };
  /** the cheapest way from `a` that runs through none of the other labels */
  const endFor = (i: number, a: Point, others: readonly (Box | undefined)[] = []): { path: Point[]; cost: number } => {
    const ways = endsFor(i, a);
    let best = ways[0] as { path: Point[]; cost: number };
    let bestC = Infinity;
    for (const way of ways) {
      let hits = 0;
      others.forEach((o, j) => {
        if (j !== i && o !== undefined && polylineHitsBox({ points: way.path, closed: false }, inflate(o, 1))) hits += 1;
      });
      const c = way.cost + hits * 1000;
      if (c < bestC - 1e-9) {
        bestC = c;
        best = way;
      }
      if (hits === 0) break;
    }
    return best;
  };
  const pathsCross = (p: readonly Point[], q: readonly Point[]): boolean => {
    for (let i = 0; i + 1 < p.length; i += 1) for (let j = 0; j + 1 < q.length; j += 1) if (segmentsCross(p[i] as Point, p[i + 1] as Point, q[j] as Point, q[j + 1] as Point)) return true;
    return false;
  };

  const nearEdge = (b: Box, side: Side): Point =>
    side === 'left' ? { x: right(b), y: b.y + b.height / 2 } : side === 'right' ? { x: b.x, y: b.y + b.height / 2 } : side === 'above' ? { x: b.x + b.width / 2, y: bottom(b) } : { x: b.x + b.width / 2, y: b.y };

  // One placement ----------------------------------------------------------------
  const solve = (s: number, mode: Mode, g: number, assign: (Side | 'free')[], orders: Map<Side, number[]>): Solved => {
    const boxes: Box[] = new Array<Box>(n);
    const dims = labels.map((l) => ({ w: l.size.width * s, h: l.size.height * s }));
    for (const side of SIDES) {
      const list = orders.get(side) ?? [];
      if (list.length === 0) continue;
      const vertical = side === 'left' || side === 'right';
      const sizes = list.map((i) => (vertical ? (dims[i] as { h: number }).h : (dims[i] as { w: number }).w));
      const desired = list.map((i) => {
        const a = (parts[i] as Part).anchor;
        return vertical ? a.y : a.x;
      });
      // a side that is too narrow for its labels in a line has them in more rows, every other label in the next row out, so a leader from the far row runs between the near row's labels
      const along = vertical ? room.height : room.width;
      const total = sizes.reduce((a, b) => a + b, 0) + (list.length - 1) * sep;
      const rows = vertical ? 1 : Math.max(1, Math.min(4, Math.ceil(total / along)));
      const rowOf = list.map((_, k) => k % rows);
      const thick: number[] = [];
      for (let r = 0; r < rows; r += 1) thick.push(Math.max(0, ...list.filter((_, k) => rowOf[k] === r).map((i) => (vertical ? (dims[i] as { w: number }).w : (dims[i] as { h: number }).h))));
      for (let r = 0; r < rows; r += 1) {
        const members = list.map((i, k) => ({ i, k })).filter((m) => rowOf[m.k] === r);
        if (members.length === 0) continue;
        const rs = members.map((m) => sizes[m.k] as number);
        const rd = members.map((m) => desired[m.k] as number);
        const min = members.slice(1).map((_, k) => (rs[k] as number) / 2 + (rs[k + 1] as number) / 2 + sep);
        let pos = packOrdered(rd, min, rd.map(() => 1));
        const lo = (vertical ? room.y : room.x) + (rs[0] as number) / 2;
        const hi = (vertical ? bottom(room) : right(room)) - (rs[rs.length - 1] as number) / 2;
        const first = pos[0] as number;
        if (first < lo) pos = pos.map((p) => p + (lo - first));
        const last = pos[pos.length - 1] as number;
        if (last > hi) {
          const back = Math.min(last - hi, Math.max(0, (pos[0] as number) - lo));
          pos = pos.map((p) => p - back);
        }
        const out = thick.slice(0, r).reduce((a, b) => a + b + sep, 0);
        members.forEach((m, q) => {
          const { w, h } = dims[m.i] as { w: number; h: number };
          const c = pos[q] as number;
          if (side === 'above') boxes[m.i] = box(c - w / 2, fig.y - g - out - h, w, h);
          else if (side === 'below') boxes[m.i] = box(c - w / 2, bottom(fig) + g + out, w, h);
          else if (mode === 'outer') boxes[m.i] = side === 'left' ? box(fig.x - g - w, c - h / 2, w, h) : box(right(fig) + g, c - h / 2, w, h);
          else {
            // stacked against the outline: as near the ink as is clear of it, at this label's own height
            const hugAt = (cy: number): Box => {
              const ink = inkBand(cy - h / 2 - hugGap, cy + h / 2 + hugGap);
              if (side === 'left') return box((ink === null ? fig.x + fig.width / 2 - hugGap : ink.min - hugGap) - w, cy - h / 2, w, h);
              return box(ink === null ? fig.x + fig.width / 2 + hugGap : ink.max + hugGap, cy - h / 2, w, h);
            };
            let placed = hugAt(c);
            // where the drawing is widest there is no room for the words at that height: slide along the column to the nearest height where the label stands inside the room, clear of ink and of the labels already set
            if (!contains(room, placed, 0.5)) {
              const stepY = Math.max(1, h * 0.5);
              slide: for (let k = 1; k * stepY <= room.height; k += 1) {
                for (const dir of [1, -1]) {
                  const trial = hugAt(c + dir * k * stepY);
                  if (!contains(room, trial, 0.5) || inkHits(trial)) continue;
                  if (boxes.some((other, j) => j !== m.i && other !== undefined && overlaps(inflate(trial, 1), other))) continue;
                  placed = trial;
                  break slide;
                }
              }
            }
            boxes[m.i] = placed;
          }
        });
      }
    }
    // a label with no column goes to the first clear place round its part
    assign.forEach((a, i) => {
      if (a !== 'free') return;
      const l = labels[i] as L;
      const t = (parts[i] as Part).anchor;
      const { w, h } = dims[i] as { w: number; h: number };
      let bestB: Box | null = null;
      let bestC = Infinity;
      const midX = fig.x + fig.width / 2;
      for (let k = 1; k <= 10 && bestC > 0; k += 1) {
        const d = k * 0.9 * body;
        const cands = [box(t.x + d, t.y - h / 2, w, h), box(t.x - d - w, t.y - h / 2, w, h), box(t.x - w / 2, t.y - d - h, w, h), box(t.x - w / 2, t.y + d, w, h), box(t.x + d, t.y - d - h, w, h), box(t.x - d - w, t.y - d - h, w, h), box(t.x + d, t.y + d, w, h), box(t.x - d - w, t.y + d, w, h)];
        for (const b of cands) {
          let c = 0;
          const g2 = inflate(b, 2);
          if (!contains(room, b, 0.5)) c += 5;
          for (const o of input.obstacles) if (overlaps(g2, o)) c += 2;
          if (inkHits(b)) c += 2;
          boxes.forEach((p, j) => {
            if (j !== i && p && overlaps(g2, p)) c += 2;
          });
          // on the side of the drawing its part is on
          if ((t.x - midX) * (centreOf(b).x - midX) < 0 && Math.abs(t.x - midX) > fig.width * 0.1) c += 1;
          if (c < bestC) {
            bestC = c;
            bestB = b;
          }
        }
      }
      void l;
      boxes[i] = bestB ?? box(t.x, t.y, w, h);
    });

    const leaders: Point[][] = [];
    const landedCost: number[] = [];
    labels.forEach((_, i) => {
      const b = boxes[i] as Box;
      const side = assign[i] as Side | 'free';
      let a: Point;
      if (side === 'free') {
        const path = endFor(i, centreOf(b)).path;
        const t = path[path.length - 1] as Point;
        a = { x: Math.max(b.x, Math.min(t.x, right(b))), y: Math.max(b.y, Math.min(t.y, bottom(b))) };
      } else a = nearEdge(b, side);
      const way = endFor(i, a, boxes);
      leaders.push(way.path);
      landedCost.push(way.cost);
    });

    let cost = 0;
    let fatal = 0;
    let crossings = 0;
    const overlap = new Array<boolean>(n).fill(false);
    const crossed = new Array<boolean>(n).fill(false);
    const bad = (i: number, amount = 1000): void => {
      cost += amount;
      fatal += 1;
      overlap[i] = true;
    };
    for (let i = 0; i < n; i += 1) {
      const bi = boxes[i] as Box;
      const li = leaders[i] as Point[];
      if (!contains(room, bi, 0.5)) bad(i, 1000);
      if (assign[i] !== 'free' && mode === 'outer' && overlaps(bi, fig)) bad(i, 1000);
      if ((mode === 'hug' || assign[i] === 'free') && inkHits(bi)) bad(i, 1000);
      for (const o of input.obstacles) if (overlaps(inflate(bi, 1), o)) bad(i, 800);
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        const bj = boxes[j] as Box;
        if (j > i && overlaps(bi, bj, sep * 0.5)) {
          bad(i, 1000);
          overlap[j] = true;
        }
        const lj = leaders[j] as Point[];
        if (j > i && pathsCross(li, lj)) {
          cost += 600;
          crossings += 1;
          crossed[i] = true;
          crossed[j] = true;
        }
        if (polylineHitsBox({ points: li, closed: false }, inflate(bj, 1))) bad(i, 1000);
      }
      for (const o of input.obstacles) if (polylineHitsBox({ points: li, closed: false }, o)) cost += 120;
      // a label stands on the side of the drawing its part is on: a part on the left has its label to the left, not across the drawing
      const midX = fig.x + fig.width / 2;
      const ax = (parts[i] as Part).anchor.x;
      const lx = centreOf(bi).x;
      if ((ax - midX) * (lx - midX) < 0 && Math.abs(ax - midX) > fig.width * 0.1) cost += 300;
      // a label stays level with its part (or above or below it, in line): the farther it is slid along its side, the less it reads as naming that part
      if (assign[i] !== 'free') {
        const part = (parts[i] as Part).anchor;
        const along = assign[i] === 'left' || assign[i] === 'right' ? Math.abs(centreOf(bi).y - part.y) - bi.height : Math.abs(centreOf(bi).x - part.x) - bi.width / 2;
        cost += 1.2 * Math.max(0, along);
      }
      const landed = (landedCost[i] as number) - (li.length > 2 ? 15 : 0);
      if (landed >= 250) {
        crossed[i] = true;
        crossings += 1;
      }
      cost += landed;
    }
    return { boxes, leaders, cost, fatal, crossings, overlap, crossed };
  };

  const worseSolved = (a: Solved, b: Solved): boolean => a.fatal > b.fatal || (a.fatal === b.fatal && (a.crossings > b.crossings || (a.crossings === b.crossings && a.cost > b.cost)));

  // Which side each label takes --------------------------------------------------
  const optimise = (s: number, mode: Mode, g: number): Plan => {
    const widthOf = (l: L): number => l.size.width * s;
    const heightOf = (l: L): number => l.size.height * s;
    const fits = (l: L, side: Side): boolean => {
      if (mode === 'outer') {
        return side === 'left' ? fig.x - g - room.x >= widthOf(l) : side === 'right' ? right(room) - right(fig) - g >= widthOf(l) : side === 'above' ? fig.y - g - room.y >= heightOf(l) : bottom(room) - bottom(fig) - g >= heightOf(l);
      }
      return side === 'left' ? fig.x + fig.width / 2 - room.x >= widthOf(l) : side === 'right' ? right(room) - (fig.x + fig.width / 2) >= widthOf(l) : side === 'above' ? fig.y - g - room.y >= heightOf(l) : bottom(room) - bottom(fig) - g >= heightOf(l);
    };
    const allowed = (l: L): Side[] => {
      if (l.side !== 'auto') return [l.side];
      const lr = (['left', 'right'] as Side[]).filter((x) => fits(l, x));
      const ab = (['above', 'below'] as Side[]).filter((x) => fits(l, x));
      return wide ? [...ab, ...lr] : [...lr, ...ab];
    };
    const sideCost = (i: number, side: Side): number => {
      const c = (parts[i] as Part).anchor;
      return side === 'left' ? Math.abs(c.x - fig.x) : side === 'right' ? Math.abs(right(fig) - c.x) : side === 'above' ? Math.abs(c.y - fig.y) : Math.abs(bottom(fig) - c.y);
    };
    const startWith = (rule: 'near' | 'halves-x' | 'halves-y'): (Side | 'free')[] =>
      labels.map((l, i) => {
        const opts = allowed(l);
        if (opts.length === 0) return 'free';
        if (rule !== 'near' && l.side === 'auto') {
          const c = (parts[i] as Part).anchor;
          const want: Side = rule === 'halves-x' ? (c.x < fig.x + fig.width / 2 ? 'left' : 'right') : c.y < fig.y + fig.height / 2 ? 'above' : 'below';
          if (opts.includes(want)) return want;
        }
        let best = opts[0] as Side;
        for (const side of opts) if (sideCost(i, side) < sideCost(i, best) - 1e-6) best = side;
        return best;
      });
    const maxH = Math.max(...labels.map(heightOf));
    const capacity = (side: Side): number => {
      if (side === 'left' || side === 'right') return room.height;
      const space = side === 'above' ? fig.y - g - room.y : bottom(room) - bottom(fig) - g;
      return room.width * Math.max(0, Math.min(3, Math.floor((space + sep) / (maxH + sep))));
    };
    const orderBy = (a: (Side | 'free')[]): Map<Side, number[]> => {
      const m = new Map<Side, number[]>();
      for (const side of SIDES) {
        const list: number[] = [];
        labels.forEach((_, i) => {
          if (a[i] === side) list.push(i);
        });
        const v = side === 'left' || side === 'right';
        list.sort((x, y) => {
          const cx = (parts[x] as Part).anchor;
          const cy = (parts[y] as Part).anchor;
          return (v ? cx.y - cy.y : cx.x - cy.x) || x - y;
        });
        m.set(side, list);
      }
      return m;
    };
    const climb = (assign: (Side | 'free')[]): Solved => {
      const used = (side: Side): number => labels.reduce((sum, l, i) => (assign[i] === side ? sum + (side === 'left' || side === 'right' ? heightOf(l) : widthOf(l)) + sep : sum), 0);
      for (const side of SIDES) {
        while (used(side) > capacity(side)) {
          let move = -1;
          let md = -1;
          labels.forEach((l, i) => {
            if (assign[i] !== side) return;
            const alt = allowed(l).filter((a) => a !== side && used(a) + 1 < capacity(a));
            if (alt.length === 0) return;
            const d = sideCost(i, alt[0] as Side) - sideCost(i, side);
            if (move < 0 || d < md) {
              move = i;
              md = d;
            }
          });
          if (move < 0) break;
          const alt = allowed(labels[move] as L).filter((a) => a !== side && used(a) < capacity(a));
          assign[move] = (alt[0] as Side) ?? 'free';
        }
      }
      let orders = orderBy(assign);
      let best = solve(s, mode, g, assign, orders);
      // Move a label to another side, or swap neighbours in a column, while that lowers the cost.
      for (let pass = 0; pass < 3 && best.cost > 0; pass += 1) {
        let improved = false;
        for (let i = 0; i < n; i += 1) {
          const l = labels[i] as L;
          if (l.side !== 'auto') continue;
          for (const side of [...allowed(l), 'free' as const]) {
            if (side === assign[i]) continue;
            const trial = assign.slice();
            trial[i] = side;
            const o = orderBy(trial);
            const r = solve(s, mode, g, trial, o);
            if (r.cost < best.cost - 1e-6) {
              assign[i] = side;
              orders = o;
              best = r;
              improved = true;
            }
          }
        }
        for (const [side, list] of orders) {
          for (let k = 0; k + 1 < list.length; k += 1) {
            const swapped = list.slice();
            const t = swapped[k] as number;
            swapped[k] = swapped[k + 1] as number;
            swapped[k + 1] = t;
            const o = new Map(orders);
            o.set(side, swapped);
            const r = solve(s, mode, g, assign, o);
            if (r.cost < best.cost - 1e-6) {
              orders = o;
              best = r;
              improved = true;
              list.splice(0, list.length, ...swapped);
            }
          }
        }
        if (!improved) break;
      }
      return best;
    };
    let best = climb(startWith('near'));
    // other starting places where the nearest side did not give a clean answer (a narrow room, a figure that is long)
    if (best.fatal > 0 || best.crossings > 0) {
      for (const rule of ['halves-x', 'halves-y'] as const) {
        const r = climb(startWith(rule));
        if (worseSolved(best, r)) best = r;
      }
    }
    return { solved: best, scale: s };
  };

  // Full size beside the drawing; then smaller type there; then stacked against its outline, again full size and then smaller.
  const floor = Math.max(0.3, Math.min(1, input.floorScale ?? 1));
  const scales = [1];
  for (const step of [0.9, 0.8, 0.7, 0.6, 0.5]) if (step > floor + 1e-6) scales.push(step);
  if (floor < 1 - 1e-6) scales.push(floor);
  let chosen: Plan | null = null;
  const tiers: { mode: Mode; g: number }[] = [
    { mode: 'outer', g: gap },
    { mode: 'outer', g: 0.45 * body },
    { mode: 'hug', g: 0.45 * body },
  ];
  outerLoop: for (const tier of tiers) {
    for (const s of scales) {
      const plan = optimise(s, tier.mode, tier.g);
      if (chosen === null || worseSolved(chosen.solved, plan.solved)) chosen = plan;
      if (plan.solved.fatal === 0 && plan.solved.crossings === 0) break outerLoop;
    }
  }
  const best = (chosen as Plan).solved;
  const scale = (chosen as Plan).scale;

  const boxes = new Map<string, Box>();
  const leaders = new Map<string, Polyline>();
  const scales2 = new Map<string, number>();
  const notes: CalloutLayout['notes'][number][] = [];
  labels.forEach((l, i) => {
    boxes.set(l.key, best.boxes[i] as Box);
    leaders.set(l.key, open(best.leaders[i] as Point[]));
    if (scale < 1 - 1e-6) scales2.set(l.key, scale);
    if (best.overlap[i]) notes.push({ key: l.key, note: 'collides' });
    else if (best.crossed[i]) notes.push({ key: l.key, note: 'crossed' });
  });
  return { boxes, leaders, notes, scales: scales2 };
}
