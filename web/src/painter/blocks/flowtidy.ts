// Connectors that share a corridor. A flow's routes are found one at a time, and two of them can end up on the same track: one
// segment lying on, or a hair from, another's, so that they read as one line, the words of the one stand on the other, and a dashed
// line looks solid. This takes the routes as they stand and gives each segment that lies along another its own lane: the segment is
// moved sideways (an offset per route in the shared channel), the least that clears every other route and every node. The ends of a
// route (the ports, and the short run into each) never move; only the segments between them do.

import type { Point } from '@conduit/language';
import type { Box } from '../../contracts/space';
import { inflate, polylineHitsBox, polylinesCross, simplify } from './geom';

export interface TidyAsk {
  /** every node's box: a lane never enters one */
  readonly nodes: readonly Box[];
  /** routes nearer than this, side by side, read as one line */
  readonly gap: number;
  /** the least run left at each end of a route (the arrowhead stands there) */
  readonly stub: number;
  /** routes already drawn that do not move: the others make way for them */
  readonly fixed?: ReadonlySet<number>;
  /** a lane stays inside this (the room the routes were laid in) */
  readonly bounds?: Box;
  /** a lane that would cross a line its route did not cross is refused (else it is only charged for) */
  readonly keepCrossings?: boolean;
}

interface Seg {
  readonly route: number;
  readonly index: number;
  readonly a: Point;
  readonly b: Point;
  readonly horizontal: boolean;
  /** a route's first or last stretch: it stands on a port */
  readonly end: boolean;
}

const EPS = 0.5;

function segmentsOf(route: readonly Point[], r: number): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i + 1 < route.length; i += 1) {
    const a = route[i] as Point;
    const b = route[i + 1] as Point;
    const horizontal = Math.abs(a.y - b.y) < EPS;
    const vertical = Math.abs(a.x - b.x) < EPS;
    if (!horizontal && !vertical) continue;
    out.push({ route: r, index: i, a, b, horizontal, end: i === 0 || i + 2 === route.length });
  }
  return out;
}

/** How far two segments lie along one another (0 when they do not, or are not within `gap` of one another side by side). */
function along(s: Seg, t: Seg, gap: number): number {
  if (s.horizontal !== t.horizontal) return 0;
  if (s.horizontal) {
    if (Math.abs(s.a.y - t.a.y) >= gap) return 0;
    return Math.max(0, Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) - Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x)));
  }
  if (Math.abs(s.a.x - t.a.x) >= gap) return 0;
  return Math.max(0, Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y)) - Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y)));
}

/** Two end stretches that touch the same node side are the ports' business (they are spread along the side), not a shared lane. */
function sameNode(s: Seg, t: Seg, routes: readonly (readonly Point[])[], nodes: readonly Box[]): boolean {
  const touching = (p: Point): number => nodes.findIndex((b) => p.x >= b.x - 1 && p.x <= b.x + b.width + 1 && p.y >= b.y - 1 && p.y <= b.y + b.height + 1);
  const ends = (x: Seg): number[] => {
    const route = routes[x.route] as readonly Point[];
    const out: number[] = [];
    if (x.index === 0) out.push(touching(route[0] as Point));
    if (x.index + 2 === route.length) out.push(touching(route[route.length - 1] as Point));
    return out.filter((n) => n >= 0);
  };
  const mine = ends(s);
  return ends(t).some((n) => mine.includes(n));
}

/** The segments of `routes[r]` that lie along a segment of another route. */
function clashes(routes: readonly (readonly Point[])[], r: number, ask: TidyAsk): { mine: Seg; theirs: Seg; by: number }[] {
  const found: { mine: Seg; theirs: Seg; by: number }[] = [];
  const own = segmentsOf(routes[r] as readonly Point[], r);
  for (let q = 0; q < routes.length; q += 1) {
    if (q === r) continue;
    const other = segmentsOf(routes[q] as readonly Point[], q);
    for (const s of own)
      for (const t of other) {
        const by = along(s, t, ask.gap);
        if (by <= 1.5) continue;
        if (s.end && t.end && sameNode(s, t, routes, ask.nodes)) continue;
        found.push({ mine: s, theirs: t, by });
      }
  }
  return found;
}

const clashCount = (routes: readonly (readonly Point[])[], r: number, ask: TidyAsk): number => clashes(routes, r, ask).length;

/** The route with segment `index` moved sideways by `by`; null when that leaves an end stretch too short, or goes into a node. */
function moved(route: readonly Point[], index: number, by: number, ask: TidyAsk): Point[] | null {
  const a = route[index] as Point;
  const b = route[index + 1] as Point;
  const horizontal = Math.abs(a.y - b.y) < EPS;
  const next = route.map((p, i) => (i === index || i === index + 1 ? (horizontal ? { x: p.x, y: p.y + by } : { x: p.x + by, y: p.y }) : p));
  const first = next[0] as Point;
  const second = next[1] as Point;
  const last = next[next.length - 1] as Point;
  const before = next[next.length - 2] as Point;
  if (Math.hypot(second.x - first.x, second.y - first.y) < ask.stub || Math.hypot(last.x - before.x, last.y - before.y) < ask.stub) return null;
  const keep = ask.bounds;
  if (keep !== undefined && next.some((p) => p.x < keep.x - 0.5 || p.y < keep.y - 0.5 || p.x > keep.x + keep.width + 0.5 || p.y > keep.y + keep.height + 0.5)) return null;
  const line = { points: next, closed: false };
  for (const n of ask.nodes) if (polylineHitsBox(line, inflate(n, -1))) return null;
  return simplify(next);
}

const crossings = (routes: readonly (readonly Point[])[], r: number, route: readonly Point[]): number => {
  let n = 0;
  for (let q = 0; q < routes.length; q += 1) if (q !== r) n += polylinesCross({ points: route, closed: false }, { points: routes[q] as readonly Point[], closed: false });
  return n;
};

/**
 * Gives every route its own lane. Routes are changed in place; a route none of whose segments could be moved clear stays as it was.
 * Returns how many segments still lie along another's.
 */
export function separateRoutes(routes: Point[][], ask: TidyAsk): number {
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    for (let r = 0; r < routes.length; r += 1) {
      const route = routes[r] as Point[];
      if (route.length < 4 || ask.fixed?.has(r) === true) continue;
      const found = clashes(routes, r, ask);
      if (found.length === 0) continue;
      // the route that moves is the one with the segment that can: the later route yields (what was drawn first holds its track)
      const clash = found.find((c) => !c.mine.end && (c.mine.route > c.theirs.route || c.theirs.end || ask.fixed?.has(c.theirs.route) === true));
      if (clash === undefined) continue;
      const before = clashCount(routes, r, ask);
      const cross0 = crossings(routes, r, route);
      let bestRoute: Point[] | null = null;
      let bestScore = Infinity;
      for (let step = 1; step <= 8; step += 1)
        for (const sign of [1, -1]) {
          const candidate = moved(route, clash.mine.index, sign * step * ask.gap, ask);
          if (candidate === null) continue;
          const test = routes.slice();
          test[r] = candidate;
          // a lane that crosses a line the route did not cross is no gain
          const more = Math.max(0, crossings(test, r, candidate) - cross0);
          if (more > 0 && ask.keepCrossings === true) continue;
          const left = clashCount(test, r, ask);
          const score = left * 1000 + more * 100 + step;
          if (score < bestScore) {
            bestScore = score;
            bestRoute = candidate;
          }
        }
      if (bestRoute !== null && bestScore < before * 1000) {
        routes[r] = bestRoute;
        changed = true;
      }
    }
    if (!changed) break;
  }
  let left = 0;
  for (let r = 0; r < routes.length; r += 1) left += clashCount(routes, r, ask);
  return left / 2;
}
