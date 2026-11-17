// A connector that goes round. The flow engine's folded rows draw a link between two rows straight down the gutter, which is
// right while nothing stands in the way; this finds a way when something does. The rule: a link never passes through a node's
// box or a link's words. It goes round on a lane between rows or columns, or along the outside edge, and it crosses other links as
// few times as the room allows. Orthogonal steps on a grid made of the edges of every box (and the middle of every free corridor),
// least cost first: length, a charge for each bend, a larger one for each crossing of another link, and a small one for leaving a
// node by the side that is not its own way out.

import type { Point } from '@conduit/language';
import type { Box } from '../../contracts/space';
import { simplify } from './geom';

export interface RouteLine {
  readonly points: readonly Point[];
  /** shares an end with the link being routed: crossing it is no fault, only untidy */
  readonly kin: boolean;
}

export interface RouteAsk {
  readonly from: Box;
  readonly to: Box;
  /** boxes the route may not enter: every node (the ends too: they are left and entered at the middle of a side) and the words already placed */
  readonly obstacles: readonly Box[];
  readonly lines: readonly RouteLine[];
  readonly room: Box;
  /** the straight run kept at each end for the arrowhead, and the clear space round every obstacle */
  readonly pad: number;
  readonly clear: number;
  /** the charge for a bend (the unit the others are scaled by) */
  readonly bend: number;
  /** two ends (arrowheads) on one side of a node, nearer than this, run into one another; a side offers ports this far apart (default: the middle only) */
  readonly portGap?: number;
  /** sides the route must not use: `from` or `to`, and which side of that box (right, left, bottom, top) */
  readonly avoid?: readonly { readonly end: 'from' | 'to'; readonly side: Dir }[];
}

export type Dir = 0 | 1 | 2 | 3; // right, left, down, up
const DX = [1, -1, 0, 0] as const;
const DY = [0, 0, 1, -1] as const;

interface Port {
  readonly at: Point;
  readonly out: Point;
  /** the way out of the node */
  readonly dir: Dir;
  /** extra charge for this side */
  readonly cost: number;
}

/**
 * The ports of a box: the middle of each side and, where a side is long enough to take them a `gap` apart, two more either side of it. `leaving`
 * prefers the foot of the node (the way a flow goes down), `entering` the head.
 */
function ports(b: Box, pad: number, bend: number, leaving: boolean, gap: number): Port[] {
  const out: Port[] = [];
  const spots = (len: number): number[] => (gap > 0 && len >= 3 * gap + 2 * bend * 0.2 ? [0.5, 0.5 - gap / len, 0.5 + gap / len] : [0.5]);
  for (const f of spots(b.width)) {
    const x = b.x + b.width * f;
    const off = f === 0.5 ? 0 : bend * 0.5;
    out.push({ at: { x, y: b.y + b.height }, out: { x, y: b.y + b.height + pad }, dir: 2, cost: (leaving ? 0 : bend * 5) + off });
    out.push({ at: { x, y: b.y }, out: { x, y: b.y - pad }, dir: 3, cost: (leaving ? bend * 5 : 0) + off });
  }
  for (const f of spots(b.height)) {
    const y = b.y + b.height * f;
    const off = f === 0.5 ? 0 : bend * 0.5;
    out.push({ at: { x: b.x + b.width, y }, out: { x: b.x + b.width + pad, y }, dir: 0, cost: bend * 2 + off });
    out.push({ at: { x: b.x, y }, out: { x: b.x - pad, y }, dir: 1, cost: bend * 2 + off });
  }
  return out;
}

class Heap {
  private readonly a: { k: number; v: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  push(k: number, v: number): void {
    const a = this.a;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as { k: number }).k <= (a[i] as { k: number }).k) break;
      [a[p], a[i]] = [a[i] as { k: number; v: number }, a[p] as { k: number; v: number }];
      i = p;
    }
  }
  pop(): { k: number; v: number } {
    const a = this.a;
    const top = a[0] as { k: number; v: number };
    const last = a.pop() as { k: number; v: number };
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && (a[l] as { k: number }).k < (a[m] as { k: number }).k) m = l;
        if (r < a.length && (a[r] as { k: number }).k < (a[m] as { k: number }).k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i] as { k: number; v: number }, a[m] as { k: number; v: number }];
        i = m;
      }
    }
    return top;
  }
}

const sortedUnique = (values: number[]): number[] => {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (out.length === 0 || v - (out[out.length - 1] as number) > 0.25) out.push(v);
  return out;
};

const indexOf = (arr: readonly number[], v: number): number => {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((arr[m] as number) < v - 0.25) lo = m + 1;
    else hi = m;
  }
  return lo;
};

/** The way from one box to another round everything in `obstacles`, or null when there is none. Orthogonal, from the middle of a side to the middle of a side. */
export function routeAround(ask: RouteAsk): Point[] | null {
  const { pad, clear, bend, room } = ask;
  const solid = ask.obstacles.map((o) => ({ x0: o.x - clear, y0: o.y - clear, x1: o.x + o.width + clear, y1: o.y + o.height + clear }));
  const gap = ask.portGap ?? 0;
  const outs = ports(ask.from, pad, bend, true, gap);
  const ins = ports(ask.to, pad, bend, false, gap);
  // a side where another link's arrowhead stands is not a way out, and a side where another link leaves is not a way in; two ends of a kind
  // a head's width apart or less are worse still (they would lie on one another)
  const reach = Math.max(1, gap * 0.9);
  const crowds = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < reach && Math.abs(a.y - b.y) < reach;
  const busy = (list: Port[], arrivals: boolean): Port[] =>
    list.map((p) => {
      let extra = 0;
      for (const l of ask.lines) {
        const first = l.points[0] as Point;
        const last = l.points[l.points.length - 1] as Point;
        if (crowds(arrivals ? last : first, p.at)) extra = Math.max(extra, bend * 8);
        if (crowds(arrivals ? first : last, p.at)) extra = Math.max(extra, bend * 12);
      }
      const barred = (ask.avoid ?? []).some((a) => a.end === (arrivals ? 'from' : 'to') && a.side === p.dir);
      return extra === 0 && !barred ? p : { ...p, cost: p.cost + extra + (barred ? bend * 1000 : 0) };
    });
  const outPorts = busy(outs, true);
  const inPorts = busy(ins, false);
  // the grid: the sides of every box and the middle of every free corridor between them, the room's margins, the ports, the bends of the lines already drawn
  const xv: number[] = [room.x + clear * 1.5, room.x + room.width - clear * 1.5];
  const yv: number[] = [room.y + clear * 1.5, room.y + room.height - clear * 1.5];
  const edgesX: number[] = [];
  const edgesY: number[] = [];
  for (const o of ask.obstacles) {
    edgesX.push(o.x, o.x + o.width);
    edgesY.push(o.y, o.y + o.height);
    xv.push(o.x + o.width / 2, o.x - pad, o.x + o.width + pad);
    yv.push(o.y + o.height / 2, o.y - pad, o.y + o.height + pad);
  }
  const corridors = (edges: number[], into: number[], lo: number, hi: number): void => {
    const s = sortedUnique([...edges, lo, hi]);
    for (let i = 0; i + 1 < s.length; i += 1) {
      const a = s[i] as number;
      const b = s[i + 1] as number;
      if (b - a < 2 * clear + 2) continue;
      const mid = (a + b) / 2;
      into.push(mid);
      // a wide corridor takes more than one line, side by side, so that links through it do not lie on one another
      const step = Math.max(clear * 2.5, 5);
      if (b - a >= 2 * step + 2 * clear + 2) into.push(mid - step, mid + step);
      if (b - a >= 4 * step + 2 * clear + 2) into.push(mid - 2 * step, mid + 2 * step);
    }
  };
  corridors(edgesX, xv, room.x, room.x + room.width);
  corridors(edgesY, yv, room.y, room.y + room.height);
  for (const p of [...outPorts, ...inPorts]) {
    xv.push(p.at.x, p.out.x);
    yv.push(p.at.y, p.out.y);
  }
  for (const l of ask.lines) for (const p of l.points) {
    xv.push(p.x);
    yv.push(p.y);
  }
  const xs = sortedUnique(xv.filter((v) => v >= room.x - 0.5 && v <= room.x + room.width + 0.5));
  const ys = sortedUnique(yv.filter((v) => v >= room.y - 0.5 && v <= room.y + room.height + 0.5));
  const W = xs.length;
  const H = ys.length;
  if (W * H > 60000) return null;
  const at = (ix: number, iy: number): number => iy * W + ix;
  const free = (x: number, y: number): boolean => {
    for (const s of solid) if (x > s.x0 && x < s.x1 && y > s.y0 && y < s.y1) return false;
    return true;
  };
  const freeNode: boolean[] = new Array<boolean>(W * H);
  for (let iy = 0; iy < H; iy += 1) for (let ix = 0; ix < W; ix += 1) freeNode[at(ix, iy)] = free(xs[ix] as number, ys[iy] as number);
  const clearEdge = (x0: number, y0: number, x1: number, y1: number): boolean => {
    for (const s of solid) {
      if (y0 === y1) {
        if (y0 > s.y0 && y0 < s.y1 && Math.max(x0, x1) > s.x0 && Math.min(x0, x1) < s.x1) return false;
      } else if (x0 > s.x0 && x0 < s.x1 && Math.max(y0, y1) > s.y0 && Math.min(y0, y1) < s.y1) return false;
    }
    return true;
  };
  // the charge for a step along an edge: crossing a line, or lying along one
  const segs: { a: Point; b: Point; kin: boolean }[] = [];
  for (const l of ask.lines) for (let i = 0; i + 1 < l.points.length; i += 1) segs.push({ a: l.points[i] as Point, b: l.points[i + 1] as Point, kin: l.kin });
  // lines nearer than this read as one line
  const near = Math.max(3, clear * 1.5);
  const edgeCost = (x0: number, y0: number, x1: number, y1: number): number => {
    const len = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    let c = len;
    for (const s of segs) {
      const sx0 = Math.min(s.a.x, s.b.x);
      const sx1 = Math.max(s.a.x, s.b.x);
      const sy0 = Math.min(s.a.y, s.b.y);
      const sy1 = Math.max(s.a.y, s.b.y);
      if (y0 === y1) {
        if (Math.abs(s.a.y - s.b.y) < 0.25) {
          if (Math.abs(s.a.y - y0) < near) {
            const over = Math.min(sx1, Math.max(x0, x1)) - Math.max(sx0, Math.min(x0, x1));
            if (over > 0) c += over * (s.kin ? 0.5 : 6) + (s.kin ? 0 : bend * 20);
          }
        } else if (s.a.x > Math.min(x0, x1) + 0.25 && s.a.x <= Math.max(x0, x1) + 0.25 && y0 > sy0 + 0.25 && y0 < sy1 - 0.25) c += bend * (s.kin ? 3 : 40);
      } else if (Math.abs(s.a.x - s.b.x) < 0.25) {
        if (Math.abs(s.a.x - x0) < near) {
          const over = Math.min(sy1, Math.max(y0, y1)) - Math.max(sy0, Math.min(y0, y1));
          if (over > 0) c += over * (s.kin ? 0.5 : 6) + (s.kin ? 0 : bend * 20);
        }
      } else if (s.a.y > Math.min(y0, y1) + 0.25 && s.a.y <= Math.max(y0, y1) + 0.25 && x0 > sx0 + 0.25 && x0 < sx1 - 0.25) c += bend * (s.kin ? 3 : 40);
    }
    return c;
  };
  // least cost first over (place, heading)
  const N = W * H * 4;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = new Heap();
  const state = (ix: number, iy: number, d: number): number => at(ix, iy) * 4 + d;
  for (const p of outPorts) {
    const ix = indexOf(xs, p.out.x);
    const iy = indexOf(ys, p.out.y);
    if (!freeNode[at(ix, iy)]) continue;
    const s = state(ix, iy, p.dir);
    const c = p.cost + pad;
    if (c < dist[s]!) {
      dist[s] = c;
      heap.push(c, s);
    }
  }
  const stepCache = new Map<number, number>();
  while (heap.size > 0) {
    const { k, v } = heap.pop();
    if (k > (dist[v] as number)) continue;
    const d = v % 4;
    const cell = (v - d) / 4;
    const ix = cell % W;
    const iy = (cell - ix) / W;
    for (let nd = 0; nd < 4; nd += 1) {
      if (nd === (d ^ 1)) continue; // no turning back on itself
      const jx = ix + DX[nd]!;
      const jy = iy + DY[nd]!;
      if (jx < 0 || jy < 0 || jx >= W || jy >= H || !freeNode[at(jx, jy)]) continue;
      const x0 = xs[ix] as number;
      const y0 = ys[iy] as number;
      const x1 = xs[jx] as number;
      const y1 = ys[jy] as number;
      if (!clearEdge(x0, y0, x1, y1)) continue;
      const key = nd < 2 ? (iy * W + Math.min(ix, jx)) * 2 : (ix * H + Math.min(iy, jy)) * 2 + 1;
      let step = stepCache.get(key);
      if (step === undefined) {
        step = edgeCost(x0, y0, x1, y1);
        stepCache.set(key, step);
      }
      const c = k + step + (nd === d ? 0 : bend);
      const s = state(jx, jy, nd);
      if (c < (dist[s] as number)) {
        dist[s] = c;
        prev[s] = v;
        heap.push(c, s);
      }
    }
  }
  // the best way in: arriving at a port's offset point, then straight into the node
  const inward = (dir: Dir): Dir => (dir ^ 1) as Dir;
  let bestCost = Infinity;
  let bestState = -1;
  let bestPort: Port | null = null;
  for (const p of inPorts) {
    const ix = indexOf(xs, p.out.x);
    const iy = indexOf(ys, p.out.y);
    for (let d = 0; d < 4; d += 1) {
      const s = state(ix, iy, d);
      const base = dist[s] as number;
      if (!Number.isFinite(base)) continue;
      const total = base + p.cost + pad + (d === inward(p.dir) ? 0 : bend);
      if (total < bestCost - 1e-9) {
        bestCost = total;
        bestState = s;
        bestPort = p;
      }
    }
  }
  if (bestPort === null) return null;
  const rev: Point[] = [bestPort.at];
  for (let s = bestState; s >= 0; s = prev[s] as number) {
    const d = s % 4;
    const cell = (s - d) / 4;
    const ix = cell % W;
    rev.push({ x: xs[ix] as number, y: ys[(cell - ix) / W] as number });
  }
  const pts = rev.reverse();
  // the port the route began at: the first point stands at its offset, the node's side is one pad back
  const first = pts[0] as Point;
  const start = outPorts.find((p) => Math.abs(p.out.x - first.x) < 0.5 && Math.abs(p.out.y - first.y) < 0.5);
  if (start === undefined) return null;
  return simplify([start.at, ...pts]);
}
