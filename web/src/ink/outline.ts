// From strokes to shapes, from first principles (the idea of "perfect freehand", written here, no dependency).
//
// 1. Streamline: each raw point eases toward the pen's real position, which irons out the jitter of a hand and of a digitiser.
// 2. Pressure becomes a radius: harder is wider, with a taper at the ends, so a stroke has a start and a finish like ink on paper. A device with no
//    pressure (a mouse, a finger) gets a pressure made from speed (slow is wide), which is what a real pen does.
// 3. The line is walked once, offsetting each point to its left and its right along the (averaged) normal; the two sides plus a round cap at each
//    end are one polygon, filled non-zero so a tight turn that folds the outline over itself still fills.
// 4. The polygon is drawn through the midpoints of its points with quadratic curves, so it has no corners.
//
// All pure and deterministic: replaying saved points gives the same shape.

import type { InkPoint, InkStroke } from '@conduit/language';

export interface OutlineOptions {
  /** the stroke's nominal width in the same units as the points */
  readonly size: number;
  /** 0..1: how much pressure changes the width (0 is a constant-width line) */
  readonly thinning: number;
  /** 0..1: how much the line is eased toward the pen */
  readonly streamline: number;
  /** distance over which the start / the end narrow, in `size`s */
  readonly taperStart: number;
  readonly taperEnd: number;
  /** pressure comes from speed rather than from the points' `p` */
  readonly simulatePressure: boolean;
  /** the stroke is finished: the last point lands exactly where the pen lifted, and the end tapers */
  readonly complete: boolean;
}

export const PEN: Omit<OutlineOptions, 'size' | 'simulatePressure' | 'complete'> = { thinning: 0.55, streamline: 0.5, taperStart: 0.6, taperEnd: 1.4 };

type Pair = readonly [number, number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The points after streamlining and thinning out the ones nearly on top of each other: x, y, pressure, running length. */
export function streamline(points: readonly InkPoint[], size: number, amount: number, complete: boolean): { x: number; y: number; p: number; len: number }[] {
  if (points.length === 0) return [];
  const t = 0.15 + (1 - amount) * 0.85;
  const first = points[0]!;
  const out: { x: number; y: number; p: number; len: number }[] = [{ x: first[0], y: first[1], p: first[2], len: 0 }];
  const minGap = size * 0.06;
  let sx = first[0];
  let sy = first[1];
  let len = 0;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    const last = i === points.length - 1;
    // the last point of a finished stroke is taken whole
    sx = last && complete ? point[0] : lerp(sx, point[0], t);
    sy = last && complete ? point[1] : lerp(sy, point[1], t);
    const before = out[out.length - 1]!;
    const gap = Math.hypot(sx - before.x, sy - before.y);
    if (gap < minGap && !(last && complete && gap > 0)) continue;
    len += gap;
    out.push({ x: sx, y: sy, p: point[2], len });
  }
  return out;
}

/** The radius at each streamlined point. */
function radii(pts: readonly { p: number; len: number; x: number; y: number }[], o: OutlineOptions): number[] {
  const total = pts.length === 0 ? 0 : pts[pts.length - 1]!.len;
  const out: number[] = [];
  let pressure = pts[0]?.p ?? 0.5;
  for (let i = 0; i < pts.length; i += 1) {
    const point = pts[i]!;
    if (o.simulatePressure) {
      const gap = i === 0 ? 0 : point.len - pts[i - 1]!.len;
      // slow is wide: a gap of a whole `size` or more per sample is fast
      const target = 1 - Math.min(1, gap / o.size) * 0.9;
      pressure = pressure + (target - pressure) * 0.28;
    } else {
      pressure = pressure + (point.p - pressure) * 0.5;
    }
    let r = o.size * (0.5 - o.thinning * (0.5 - pressure)) ;
    if (o.taperStart > 0) r *= 0.35 + 0.65 * Math.min(1, point.len / (o.size * o.taperStart));
    if (o.complete && o.taperEnd > 0) r *= 0.3 + 0.7 * Math.min(1, (total - point.len) / (o.size * o.taperEnd));
    out.push(Math.max(o.size * 0.08, r));
  }
  return out;
}

/** The polygon around a stroke, as a ring of points (a dot is a circle). */
export function outlinePolygon(points: readonly InkPoint[], o: OutlineOptions): Pair[] {
  const pts = streamline(points, o.size, o.streamline, o.complete);
  if (pts.length === 0) return [];
  const rs = radii(pts, o);
  if (pts.length === 1) return arc(pts[0]!.x, pts[0]!.y, rs[0]! * (o.complete ? 1 : 1), 0, Math.PI * 2, 14);
  const left: Pair[] = [];
  const right: Pair[] = [];
  const normals: Pair[] = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    normals.push([-dy, dx]);
  }
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]!;
    const n = normals[i]!;
    left.push([p.x + n[0] * rs[i]!, p.y + n[1] * rs[i]!]);
    right.push([p.x - n[0] * rs[i]!, p.y - n[1] * rs[i]!]);
  }
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const startAngle = Math.atan2(normals[0]![1], normals[0]![0]);
  const endAngle = Math.atan2(normals[normals.length - 1]![1], normals[normals.length - 1]![0]);
  // end cap: from the left side round the front to the right side; start cap: round the back
  const endCap = arc(last.x, last.y, rs[rs.length - 1]!, endAngle, endAngle - Math.PI, 7);
  const startCap = arc(first.x, first.y, rs[0]!, startAngle + Math.PI, startAngle, 7);
  return [...left, ...endCap, ...right.reverse(), ...startCap];
}

function arc(cx: number, cy: number, r: number, from: number, to: number, steps: number): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = lerp(from, to, i / steps);
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** A closed path through the polygon's midpoints with quadratic curves (for a Path2D or an SVG `d`). */
export function smoothPathData(ring: readonly Pair[], closed: boolean): string {
  if (ring.length === 0) return '';
  const f = (n: number): string => (Math.round(n * 100) / 100).toString();
  if (ring.length < 3) return `M${f(ring[0]![0])} ${f(ring[0]![1])}${ring.slice(1).map((p) => `L${f(p[0])} ${f(p[1])}`).join('')}`;
  const mid = (a: Pair, b: Pair): Pair => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const startMid = closed ? mid(ring[ring.length - 1]!, ring[0]!) : ring[0]!;
  let d = `M${f(startMid[0])} ${f(startMid[1])}`;
  for (let i = closed ? 0 : 1; i < ring.length; i += 1) {
    const p = ring[i]!;
    const next = closed ? ring[(i + 1) % ring.length]! : ring[i + 1];
    if (next === undefined) {
      d += `L${f(p[0])} ${f(p[1])}`;
      break;
    }
    const m = mid(p, next);
    d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return closed ? `${d}Z` : d;
}

/** The streamlined centre line of a stroke (for a highlighter, which has a constant width), as path data. */
export function centreLineData(points: readonly InkPoint[], size: number, complete: boolean): string {
  const pts = streamline(points, size, 0.6, complete);
  return smoothPathData(pts.map((p): Pair => [p.x, p.y]), false);
}

/** The options a saved stroke is drawn with. */
export function penOptions(stroke: InkStroke, complete: boolean): OutlineOptions {
  // a stroke whose pressure never moves (a mouse, a finger) had its pressure made from speed when it was drawn; it is drawn from the points as saved
  return { ...PEN, size: stroke.width, simulatePressure: false, complete };
}
