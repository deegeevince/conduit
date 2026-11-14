// Callouts: boundary labelling, as a technical illustrator does it. Labels go
// in clear room round the drawing, in columns to its left and right (above and
// below when it is wide), sharing the edge next to the drawing, ordered along
// the column in the order of what they point at; each has one straight leader
// from its edge to the edge of the part, and no two leaders cross.

import type { Point, Polyline } from '@conduit/language';
import type { CalloutInput, CalloutLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, bottom, centreOf, contains, inflate, open, overlaps, packOrdered, polylineHitsBox, right, segmentsCross } from './geom';

type Side = 'left' | 'right' | 'above' | 'below';
type L = CalloutInput['labels'][number];

interface Solved {
  boxes: Box[];
  leaders: Point[][];
  cost: number;
  overlap: boolean[];
  crossedStroke: boolean[];
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
  const centreOfTarget = (l: L): Point => ('width' in l.target ? centreOf(l.target) : l.target);

  const available: Record<Side, number> = {
    left: fig.x - gap - room.x,
    right: right(room) - right(fig) - gap,
    above: fig.y - gap - room.y,
    below: bottom(room) - bottom(fig) - gap,
  };
  const maxW = Math.max(...labels.map((l) => l.size.width));
  const maxH = Math.max(...labels.map((l) => l.size.height));
  const open_: Record<Side, boolean> = {
    left: available.left >= maxW,
    right: available.right >= maxW,
    above: available.above >= maxH,
    below: available.below >= maxH,
  };
  const wide = fig.width > 1.8 * fig.height;

  /** how many strokes a leader from `a` to `e` crosses before it lands (the last few widths are where it lands) */
  const crossings = (a: Point, e: Point): number => {
    const len = Math.hypot(e.x - a.x, e.y - a.y);
    const cut = Math.min(len, stroke * 3 + 2);
    const f = len === 0 ? 0 : (len - cut) / len;
    const e2 = { x: a.x + (e.x - a.x) * f, y: a.y + (e.y - a.y) * f };
    let n = 0;
    for (const s of input.strokes) {
      const pts = s.points;
      const m = s.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < m; k += 1) {
        if (segmentsCross(a, e2, pts[k] as Point, pts[(k + 1) % pts.length] as Point)) {
          n += 1;
          break;
        }
      }
    }
    return n;
  };

  /** where a leader from `from` lands: for a part, the point of its strokes with the clearest straight way in */
  const endFor = (l: L, from: Point): Point => {
    if (!('width' in l.target)) return l.target;
    const zone = inflate(l.target, stroke * 2);
    let best: Point | null = null;
    let bc = Infinity;
    let bd = Infinity;
    const consider = (p: Point): void => {
      if (p.x < zone.x || p.x > right(zone) || p.y < zone.y || p.y > bottom(zone)) return;
      const d = Math.hypot(p.x - from.x, p.y - from.y);
      const c = crossings(from, p);
      if (c < bc || (c === bc && d < bd)) {
        bc = c;
        bd = d;
        best = p;
      }
    };
    for (const s of input.strokes) {
      const pts = s.points;
      const m = s.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < m; i += 1) {
        const a = pts[i] as Point;
        const b = pts[(i + 1) % pts.length] as Point;
        if (Math.max(a.x, b.x) < zone.x || Math.min(a.x, b.x) > right(zone) || Math.max(a.y, b.y) < zone.y || Math.min(a.y, b.y) > bottom(zone)) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((from.x - a.x) * dx + (from.y - a.y) * dy) / len2));
        consider({ x: a.x + t * dx, y: a.y + t * dy });
        for (const u of [0.15, 0.5, 0.85]) consider({ x: a.x + u * dx, y: a.y + u * dy });
      }
    }
    if (best) return best;
    const t = l.target;
    return { x: Math.max(t.x, Math.min(from.x, right(t))), y: Math.max(t.y, Math.min(from.y, bottom(t))) };
  };

  const nearEdge = (b: Box, side: Side): Point =>
    side === 'left' ? { x: right(b), y: b.y + b.height / 2 } : side === 'right' ? { x: b.x, y: b.y + b.height / 2 } : side === 'above' ? { x: b.x + b.width / 2, y: bottom(b) } : { x: b.x + b.width / 2, y: b.y };

  /** places each side's labels in the order given, packed round their targets */
  const solve = (assign: (Side | 'free')[], orders: Map<Side, number[]>): Solved => {
    const boxes: Box[] = new Array<Box>(n);
    for (const side of ['left', 'right', 'above', 'below'] as Side[]) {
      const list = orders.get(side) ?? [];
      if (list.length === 0) continue;
      const vertical = side === 'left' || side === 'right';
      const sizes = list.map((i) => (vertical ? (labels[i] as L).size.height : (labels[i] as L).size.width));
      const desired = list.map((i) => {
        const l = labels[i] as L;
        const c = centreOfTarget(l);
        return vertical ? c.y : c.x;
      });
      const min = list.slice(1).map((_, k) => (sizes[k] as number) / 2 + (sizes[k + 1] as number) / 2 + sep);
      let pos = packOrdered(desired, min, desired.map(() => 1));
      const lo = (vertical ? room.y : room.x) + (sizes[0] as number) / 2;
      const hi = (vertical ? bottom(room) : right(room)) - (sizes[sizes.length - 1] as number) / 2;
      const first = pos[0] as number;
      if (first < lo) pos = pos.map((p) => p + (lo - first));
      const last = pos[pos.length - 1] as number;
      if (last > hi) {
        const back = Math.min(last - hi, Math.max(0, (pos[0] as number) - lo));
        pos = pos.map((p) => p - back);
      }
      list.forEach((i, k) => {
        const l = labels[i] as L;
        const c = pos[k] as number;
        const { width: w, height: h } = l.size;
        boxes[i] = side === 'left' ? box(fig.x - gap - w, c - h / 2, w, h) : side === 'right' ? box(right(fig) + gap, c - h / 2, w, h) : side === 'above' ? box(c - w / 2, fig.y - gap - h, w, h) : box(c - w / 2, bottom(fig) + gap, w, h);
      });
    }
    // labels with no column go to the first clear place round their target
    assign.forEach((a, i) => {
      if (a !== 'free') return;
      const l = labels[i] as L;
      const t = centreOfTarget(l);
      let bestB: Box | null = null;
      let bestC = Infinity;
      for (let k = 1; k <= 6 && bestC > 0; k += 1) {
        const d = k * 0.9 * body + (('width' in l.target ? Math.min(l.target.width, l.target.height) : 0) / 2);
        const w = l.size.width;
        const h = l.size.height;
        const cands = [box(t.x + d, t.y - h / 2, w, h), box(t.x - d - w, t.y - h / 2, w, h), box(t.x - w / 2, t.y - d - h, w, h), box(t.x - w / 2, t.y + d, w, h), box(t.x + d, t.y - d - h, w, h), box(t.x - d - w, t.y - d - h, w, h), box(t.x + d, t.y + d, w, h), box(t.x - d - w, t.y + d, w, h)];
        for (const b of cands) {
          let c = 0;
          const g = inflate(b, 2);
          if (!contains(room, b, 0.5)) c += 5;
          for (const o of input.obstacles) if (overlaps(g, o)) c += 2;
          for (const s of input.strokes) if (polylineHitsBox(s, g)) c += 2;
          boxes.forEach((p, j) => {
            if (j !== i && p && overlaps(g, p)) c += 2;
          });
          if (c < bestC) {
            bestC = c;
            bestB = b;
          }
        }
      }
      boxes[i] = bestB ?? box(t.x, t.y, l.size.width, l.size.height);
    });

    const leaders: Point[][] = [];
    labels.forEach((l, i) => {
      const b = boxes[i] as Box;
      const side = assign[i] as Side | 'free';
      let a: Point;
      if (side === 'free') {
        const t = endFor(l, centreOf(b));
        const nx = Math.max(b.x, Math.min(t.x, right(b)));
        const ny = Math.max(b.y, Math.min(t.y, bottom(b)));
        a = { x: nx, y: ny };
      } else a = nearEdge(b, side);
      leaders.push([a, endFor(l, a)]);
    });

    let cost = 0;
    const overlap = new Array<boolean>(n).fill(false);
    const crossedStroke = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i += 1) {
      const bi = boxes[i] as Box;
      const li = leaders[i] as Point[];
      if (!contains(room, bi, 0.5)) {
        cost += 1000;
        overlap[i] = true;
      }
      if (overlaps(bi, fig) && assign[i] !== 'free') {
        cost += 500;
        overlap[i] = true;
      }
      for (const o of input.obstacles) if (overlaps(inflate(bi, 1), o)) {
        cost += 800;
        overlap[i] = true;
      }
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        const bj = boxes[j] as Box;
        if (j > i && overlaps(bi, bj)) {
          cost += 1000;
          overlap[i] = true;
          overlap[j] = true;
        }
        const lj = leaders[j] as Point[];
        if (j > i && segmentsCross(li[0] as Point, li[1] as Point, lj[0] as Point, lj[1] as Point)) cost += 1000;
        if (polylineHitsBox({ points: li, closed: false }, inflate(bj, 1))) {
          cost += 1000;
          overlap[i] = true;
        }
      }
      for (const o of input.obstacles) if (polylineHitsBox({ points: li, closed: false }, o)) cost += 300;
      // strokes: only where the leader lands is allowed
      const a = li[0] as Point;
      const e = li[1] as Point;
      const len = Math.hypot(e.x - a.x, e.y - a.y);
      const cut = Math.min(len, stroke * 3 + 2);
      const f = len === 0 ? 0 : (len - cut) / len;
      const e2 = { x: a.x + (e.x - a.x) * f, y: a.y + (e.y - a.y) * f };
      outer: for (const s of input.strokes) {
        const pts = s.points;
        const m = s.closed ? pts.length : pts.length - 1;
        for (let k = 0; k < m; k += 1) {
          if (segmentsCross(a, e2, pts[k] as Point, pts[(k + 1) % pts.length] as Point)) {
            cost += 300;
            crossedStroke[i] = true;
            break outer;
          }
        }
      }
      cost += len * 0.01;
    }
    return { boxes, leaders, cost, overlap, crossedStroke };
  };

  // Which side each label takes.
  const allowed = (l: L): Side[] => {
    if (l.side !== 'auto') return [l.side === 'above' ? 'above' : l.side === 'below' ? 'below' : l.side];
    const lr: Side[] = (['left', 'right'] as Side[]).filter((s) => open_[s]);
    const ab: Side[] = (['above', 'below'] as Side[]).filter((s) => open_[s]);
    return wide ? [...ab, ...lr] : [...lr, ...ab];
  };
  const sideCost = (l: L, s: Side): number => {
    const c = centreOfTarget(l);
    return s === 'left' ? Math.abs(c.x - fig.x) : s === 'right' ? Math.abs(right(fig) - c.x) : s === 'above' ? Math.abs(c.y - fig.y) : Math.abs(bottom(fig) - c.y);
  };
  const assign: (Side | 'free')[] = labels.map((l) => {
    const opts = allowed(l);
    if (opts.length === 0) return 'free';
    let best = opts[0] as Side;
    for (const s of opts) if (sideCost(l, s) < sideCost(l, best) - 1e-6) best = s;
    // a wide drawing prefers its long sides unless a column is much nearer
    return best;
  });
  const capacity = (s: Side): number => (s === 'left' || s === 'right' ? room.height : room.width);
  const used = (s: Side): number => labels.reduce((sum, l, i) => (assign[i] === s ? sum + (s === 'left' || s === 'right' ? l.size.height : l.size.width) + sep : sum), 0);
  for (const s of ['left', 'right', 'above', 'below'] as Side[]) {
    while (used(s) > capacity(s)) {
      let move = -1;
      let md = -1;
      labels.forEach((l, i) => {
        if (assign[i] !== s) return;
        const alt = allowed(l).filter((a) => a !== s && used(a) + 1 < capacity(a));
        if (alt.length === 0) return;
        const d = sideCost(l, alt[0] as Side) - sideCost(l, s);
        if (move < 0 || d < md) {
          move = i;
          md = d;
        }
      });
      if (move < 0) break;
      const alt = allowed(labels[move] as L).filter((a) => a !== s && used(a) < capacity(a));
      assign[move] = (alt[0] as Side) ?? 'free';
    }
  }
  const orderBy = (a: (Side | 'free')[]): Map<Side, number[]> => {
    const m = new Map<Side, number[]>();
    for (const s of ['left', 'right', 'above', 'below'] as Side[]) {
      const list: number[] = [];
      labels.forEach((l, i) => {
        if (a[i] === s) list.push(i);
      });
      const v = s === 'left' || s === 'right';
      list.sort((x, y) => {
        const cx = centreOfTarget(labels[x] as L);
        const cy = centreOfTarget(labels[y] as L);
        return (v ? cx.y - cy.y : cx.x - cy.x) || x - y;
      });
      m.set(s, list);
    }
    return m;
  };
  let orders = orderBy(assign);
  let best = solve(assign, orders);
  // Move a label to another side, or swap neighbours in a column, while that lowers the cost.
  for (let pass = 0; pass < 3; pass += 1) {
    let improved = false;
    for (let i = 0; i < n; i += 1) {
      const l = labels[i] as L;
      if (l.side !== 'auto') continue;
      for (const s of [...allowed(l), 'free' as const]) {
        if (s === assign[i]) continue;
        const trial = assign.slice();
        trial[i] = s;
        const o = orderBy(trial);
        const r = solve(trial, o);
        if (r.cost < best.cost - 1e-6) {
          assign[i] = s;
          orders = o;
          best = r;
          improved = true;
        }
      }
    }
    for (const [s, list] of orders) {
      for (let k = 0; k + 1 < list.length; k += 1) {
        const swapped = list.slice();
        const t = swapped[k] as number;
        swapped[k] = swapped[k + 1] as number;
        swapped[k + 1] = t;
        const o = new Map(orders);
        o.set(s, swapped);
        const r = solve(assign, o);
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

  const boxes = new Map<string, Box>();
  const leaders = new Map<string, Polyline>();
  const notes: CalloutLayout['notes'][number][] = [];
  labels.forEach((l, i) => {
    boxes.set(l.key, best.boxes[i] as Box);
    leaders.set(l.key, open(best.leaders[i] as Point[]));
    if (best.overlap[i]) notes.push({ key: l.key, note: 'collides' });
    else if (best.crossedStroke[i]) notes.push({ key: l.key, note: 'crossed' });
  });
  return { boxes, leaders, notes };
}
