// Routes (PLAN-visuals 2(a), 2(f)): `route <id> via=<part>,<part>…`. The kit draws the path: along an open part's own line, through a closed
// part's centre; direction chevrons are always drawn (so a still shows the way too); dots ride it, placed from `Phase.ambient`, one crossing of
// a stretch in about three seconds. Motion carries only direction, order, cause or change of state: a dot is an ordinary shape at a place a
// function of the clock gives, so no renderer learns anything.
//
// Pure: no DOM, no clock (the clock is an argument).

import { centreOf, dist, frameAt, inside, pole, totalLength } from './geometry';
import type { Poly } from './geometry';
import type { FigureRoute, Pt } from './types';

/** A dot crosses the stretch it runs on in this many seconds. */
export const CROSSING_SECONDS = 3;

export interface LaidRoute {
  readonly id: string;
  readonly ink: string | undefined;
  readonly poly: Poly;
  readonly length: number;
  /** the part ids that were found, in order, and the stretch of the route each covers (arc length, px) */
  readonly items: readonly { readonly part: string; readonly from: number; readonly to: number }[];
}

/** A part as the route sees it: its id, shape in px. */
export interface RoutePart {
  readonly id: string;
  readonly poly: Poly;
}

const same = (a: Pt, b: Pt): boolean => dist(a, b) < 0.5;

export function buildRoute(route: FigureRoute, parts: ReadonlyMap<string, RoutePart>): LaidRoute | null {
  const found = route.via.map((id) => parts.get(id)).filter((p): p is RoutePart => p !== undefined && p.poly.pts.length > 0);
  if (found.length === 0) return null;
  const pts: Pt[] = [];
  const marks: { part: string; closed: boolean; startIndex: number; endIndex: number; centreIndex: number }[] = [];
  const push = (p: Pt): number => {
    const last = pts[pts.length - 1];
    if (last === undefined || !same(last, p)) pts.push(p);
    return pts.length - 1;
  };
  const centre = (p: RoutePart): Pt => {
    const c = centreOf(p.poly);
    return inside(c, p.poly.pts) ? c : pole(p.poly.pts).at;
  };
  found.forEach((part, k) => {
    if (part.poly.closed) {
      const at = push(centre(part));
      marks.push({ part: part.id, closed: true, startIndex: at, endIndex: at, centreIndex: at });
      return;
    }
    // an open part's own line, in the direction that leads on from where the route is (and toward where it goes next, at the start)
    let line = part.poly.pts;
    const from = pts[pts.length - 1];
    const next = found[k + 1];
    if (from !== undefined) {
      if (dist(from, line[line.length - 1] as Pt) < dist(from, line[0] as Pt)) line = [...line].reverse();
    } else if (next !== undefined) {
      const target = next.poly.closed ? centre(next) : centreOf(next.poly);
      if (dist(target, line[0] as Pt) < dist(target, line[line.length - 1] as Pt)) line = [...line].reverse();
    }
    const startIndex = push(line[0] as Pt);
    let endIndex = startIndex;
    for (let i = 1; i < line.length; i += 1) endIndex = push(line[i] as Pt);
    marks.push({ part: part.id, closed: false, startIndex, endIndex, centreIndex: startIndex });
  });
  const poly: Poly = { pts, closed: false };
  const arc: number[] = [0];
  for (let i = 1; i < pts.length; i += 1) arc.push((arc[i - 1] as number) + dist(pts[i - 1] as Pt, pts[i] as Pt));
  const length = totalLength(poly);
  const items = marks.map((m, i) => {
    if (!m.closed) return { part: m.part, from: arc[m.startIndex] as number, to: arc[m.endIndex] as number };
    // a closed part is a place on the way: its stretch is half the leg in and half the leg out
    const c = arc[m.centreIndex] as number;
    const before = marks[i - 1];
    const after = marks[i + 1];
    const prevEnd = before === undefined ? c : (arc[before.endIndex] as number);
    const nextStart = after === undefined ? c : (arc[after.startIndex] as number);
    return { part: m.part, from: (prevEnd + c) / 2, to: (c + nextStart) / 2 };
  });
  return { id: route.id, ink: route.ink, poly, length, items };
}

/** The stretch of a route a step runs: from the first of the named parts it passes to the last. Null: it passes none of them. No step: all of it. */
export function stretchOf(route: LaidRoute, show: ReadonlySet<string> | null): { readonly from: number; readonly to: number } | null {
  if (show === null) return { from: 0, to: route.length };
  const hit = route.items.filter((item) => show.has(item.part));
  if (hit.length === 0) return null;
  const from = Math.min(...hit.map((h) => h.from));
  const to = Math.max(...hit.map((h) => h.to));
  // a part met at a single place still has a stretch to run through
  return to - from < 1 ? { from: Math.max(0, from - 6), to: Math.min(route.length, to + 6) } : { from, to };
}

export interface Dot {
  readonly at: Pt;
  readonly dir: Pt;
}

/** The dots on a stretch at this second of the ambient clock: each starts at `from` and is at `to` three seconds later, then begins again. */
export function dotsOn(route: LaidRoute, stretch: { readonly from: number; readonly to: number }, ambient: number, spacing: number): Dot[] {
  const len = stretch.to - stretch.from;
  if (len < 2) return [];
  const count = Math.max(1, Math.min(3, Math.round(len / spacing)));
  const dots: Dot[] = [];
  for (let k = 0; k < count; k += 1) {
    const f = (((ambient / CROSSING_SECONDS + k / count) % 1) + 1) % 1;
    const at = frameAt(route.poly, stretch.from + f * len);
    dots.push({ at: at.at, dir: at.dir });
  }
  return dots;
}

export interface Chevron {
  readonly at: Pt;
  readonly dir: Pt;
  /** its place on the route, arc length */
  readonly arc: number;
}

/** Chevrons along the whole route, evenly, pointing the way it runs. At least two (a short route still shows its direction). */
export function chevronsOn(route: LaidRoute, spacing: number): Chevron[] {
  const count = Math.max(2, Math.floor(route.length / spacing));
  const out: Chevron[] = [];
  for (let k = 0; k < count; k += 1) {
    const arc = ((k + 0.5) / count) * route.length;
    const f = frameAt(route.poly, arc);
    out.push({ at: f.at, dir: f.dir, arc });
  }
  return out;
}

/** The three points of a chevron: its tip, and its two wings behind. */
export function chevronPoints(c: { readonly at: Pt; readonly dir: Pt }, size: number): [Pt, Pt, Pt] {
  const back = { x: c.at.x - c.dir.x * size, y: c.at.y - c.dir.y * size };
  const px = -c.dir.y * size * 0.8;
  const py = c.dir.x * size * 0.8;
  return [{ x: back.x + px, y: back.y + py }, { x: c.at.x + c.dir.x * size * 0.35, y: c.at.y + c.dir.y * size * 0.35 }, { x: back.x - px, y: back.y - py }];
}

