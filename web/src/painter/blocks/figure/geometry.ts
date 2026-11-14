// The small geometry the figure engine needs: shapes to polylines (with `smooth`), polygon tests, an interior pole, hatch lines, arc length.
// Pure.

import { outlineOf, parsePathData } from '@conduit/language';
import type { FigureShape, Pt } from './types';

export interface Poly {
  readonly pts: readonly Pt[];
  readonly closed: boolean;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const pt = (x: number, y: number): Pt => ({ x, y });
export const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

// ------------------------------------------------------------------ shapes to polylines

/** A curve through the points: Catmull-Rom, `steps` samples a span; a closed curve comes back on itself. */
export function smoothThrough(points: readonly Pt[], closed: boolean, steps = 8): Pt[] {
  const n = points.length;
  if (n < 3) return [...points];
  const at = (i: number): Pt => {
    if (closed) return points[((i % n) + n) % n] as Pt;
    return points[Math.max(0, Math.min(n - 1, i))] as Pt;
  };
  const out: Pt[] = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  if (!closed) out.push(points[n - 1] as Pt);
  return out;
}

/** A shape as one polyline: the first sub-path of path data that has two points or more. `extra` counts the sub-paths left out. */
export function flatten(shape: FigureShape, smooth: boolean): { readonly poly: Poly; readonly extra: number } {
  switch (shape.kind) {
    case 'path': {
      const lines = outlineOf({ shape: 'path', d: shape.d, commands: parsePathData(shape.d).commands }).filter((l) => l.points.length > 1);
      const first = lines[0];
      if (first === undefined) return { poly: { pts: [], closed: false }, extra: 0 };
      const pts = first.points.map((p) => pt(p.x, p.y));
      // a closed path with its last point on its first: drop the repeat
      if (first.closed && pts.length > 2 && dist(pts[0] as Pt, pts[pts.length - 1] as Pt) < 1e-6) pts.pop();
      return { poly: { pts, closed: first.closed }, extra: lines.length - 1 };
    }
    case 'poly':
      return { poly: { pts: smooth ? smoothThrough(shape.points, true) : [...shape.points], closed: true }, extra: 0 };
    case 'line':
      return { poly: { pts: smooth ? smoothThrough(shape.points, false) : [...shape.points], closed: false }, extra: 0 };
    case 'ellipse': {
      const n = 48;
      return { poly: { pts: Array.from({ length: n }, (_, i) => pt(shape.cx + shape.rx * Math.cos((i / n) * Math.PI * 2 - Math.PI / 2), shape.cy + shape.ry * Math.sin((i / n) * Math.PI * 2 - Math.PI / 2))), closed: true }, extra: 0 };
    }
    case 'rect': {
      const r = Math.max(0, Math.min(shape.r ?? 0, shape.w / 2, shape.h / 2));
      if (r === 0) return { poly: { pts: [pt(shape.x, shape.y), pt(shape.x + shape.w, shape.y), pt(shape.x + shape.w, shape.y + shape.h), pt(shape.x, shape.y + shape.h)], closed: true }, extra: 0 };
      const pts: Pt[] = [];
      const corner = (cx: number, cy: number, from: number): void => {
        for (let i = 0; i <= 6; i += 1) pts.push(pt(cx + r * Math.cos(from + (i / 6) * (Math.PI / 2)), cy + r * Math.sin(from + (i / 6) * (Math.PI / 2))));
      };
      corner(shape.x + shape.w - r, shape.y + r, -Math.PI / 2);
      corner(shape.x + shape.w - r, shape.y + shape.h - r, 0);
      corner(shape.x + r, shape.y + shape.h - r, Math.PI / 2);
      corner(shape.x + r, shape.y + r, Math.PI);
      return { poly: { pts, closed: true }, extra: 0 };
    }
  }
}

// ------------------------------------------------------------------ measures

export function bounds(pts: readonly Pt[]): Rect {
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
  return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}

export function unionOf(rects: readonly Rect[]): Rect {
  return bounds(rects.flatMap((r) => [pt(r.x, r.y), pt(r.x + r.width, r.y + r.height)]));
}

export function signedArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i] as Pt;
    const q = pts[(i + 1) % pts.length] as Pt;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** The centre of a closed shape's area; of an open one, the middle of its length. */
export function centreOf(poly: Poly): Pt {
  if (poly.pts.length === 0) return pt(0, 0);
  if (!poly.closed) return pointAtLength(poly, totalLength(poly) / 2);
  const a = signedArea(poly.pts);
  if (Math.abs(a) < 1e-9) {
    const b = bounds(poly.pts);
    return pt(b.x + b.width / 2, b.y + b.height / 2);
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.pts.length; i += 1) {
    const p = poly.pts[i] as Pt;
    const q = poly.pts[(i + 1) % poly.pts.length] as Pt;
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return pt(cx / (6 * a), cy / (6 * a));
}

export function inside(p: Pt, pts: readonly Pt[]): boolean {
  let yes = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i] as Pt;
    const b = pts[j] as Pt;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) yes = !yes;
  }
  return yes;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** How far a point is from the nearest edge of a closed shape. */
export function edgeDistance(p: Pt, pts: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i += 1) best = Math.min(best, distToSegment(p, pts[i] as Pt, pts[(i + 1) % pts.length] as Pt));
  return best;
}

/** The point of a closed shape furthest from its edge, and how far: where a dot or a label's leader can land in the thick of it. */
export function pole(pts: readonly Pt[], cells = 28): { readonly at: Pt; readonly depth: number } {
  const b = bounds(pts);
  let best = { at: centreOf({ pts, closed: true }), depth: -1 };
  const consider = (p: Pt): void => {
    if (!inside(p, pts)) return;
    const d = edgeDistance(p, pts);
    if (d > best.depth) best = { at: p, depth: d };
  };
  for (let i = 0; i <= cells; i += 1) for (let j = 0; j <= cells; j += 1) consider(pt(b.x + (b.width * i) / cells, b.y + (b.height * j) / cells));
  // one finer pass around the winner
  const step = Math.max(b.width, b.height) / cells;
  const c = best.at;
  for (let i = -4; i <= 4; i += 1) for (let j = -4; j <= 4; j += 1) consider(pt(c.x + (i * step) / 4, c.y + (j * step) / 4));
  return best.depth < 0 ? { at: c, depth: 0 } : best;
}

export function totalLength(poly: Poly): number {
  let total = 0;
  const n = poly.pts.length;
  for (let i = 1; i < n; i += 1) total += dist(poly.pts[i - 1] as Pt, poly.pts[i] as Pt);
  if (poly.closed && n > 1) total += dist(poly.pts[n - 1] as Pt, poly.pts[0] as Pt);
  return total;
}

/** The point `d` along a polyline by length, and the direction there (a unit vector). */
export function frameAt(poly: Poly, d: number): { readonly at: Pt; readonly dir: Pt } {
  const pts = poly.closed && poly.pts[0] !== undefined ? [...poly.pts, poly.pts[0]] : poly.pts;
  if (pts.length === 0) return { at: pt(0, 0), dir: pt(1, 0) };
  if (pts.length === 1) return { at: pts[0] as Pt, dir: pt(1, 0) };
  let left = Math.max(0, d);
  let last = { at: pts[0] as Pt, dir: pt(1, 0) };
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const len = dist(a, b);
    if (len === 0) continue;
    const dir = pt((b.x - a.x) / len, (b.y - a.y) / len);
    last = { at: b, dir };
    if (left <= len) return { at: pt(a.x + dir.x * left, a.y + dir.y * left), dir };
    left -= len;
  }
  return last;
}

export const pointAtLength = (poly: Poly, d: number): Pt => frameAt(poly, d).at;

/** A sub-line between two arc lengths. */
export function slice(poly: Poly, from: number, to: number): Pt[] {
  const pts = poly.pts;
  const out: Pt[] = [frameAt(poly, from).at];
  let run = 0;
  for (let i = 1; i < pts.length; i += 1) {
    run += dist(pts[i - 1] as Pt, pts[i] as Pt);
    if (run > from + 1e-9 && run < to - 1e-9) out.push(pts[i] as Pt);
  }
  out.push(frameAt(poly, to).at);
  return out;
}

export function scaleAbout(pts: readonly Pt[], c: Pt, f: number): Pt[] {
  return pts.map((p) => pt(c.x + (p.x - c.x) * f, c.y + (p.y - c.y) * f));
}

export const shift = (pts: readonly Pt[], dx: number, dy: number): Pt[] => pts.map((p) => pt(p.x + dx, p.y + dy));

/** Whether two segments cross at a point that is not an end of both (touching ends do not count). */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

export function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  const inRect = (p: Pt): boolean => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
  if (inRect(a) || inRect(b)) return true;
  const c = [pt(r.x, r.y), pt(r.x + r.width, r.y), pt(r.x + r.width, r.y + r.height), pt(r.x, r.y + r.height)];
  for (let i = 0; i < 4; i += 1) if (segmentsCross(a, b, c[i] as Pt, c[(i + 1) % 4] as Pt)) return true;
  return false;
}

export function rectsOverlap(a: Rect, b: Rect, slack = 0): boolean {
  return a.x < b.x + b.width - slack && b.x < a.x + a.width - slack && a.y < b.y + b.height - slack && b.y < a.y + a.height - slack;
}

/** Hatch lines at 45 degrees across a closed shape, cut to it: the face a cutaway shows. */
export function hatch(pts: readonly Pt[], spacing: number): [Pt, Pt][] {
  const b = bounds(pts);
  const out: [Pt, Pt][] = [];
  // lines x - y = k (down and to the right), through the bounds
  const lo = b.x - (b.y + b.height);
  const hi = b.x + b.width - b.y;
  for (let k = lo + spacing / 2; k < hi; k += spacing) {
    // intersections of the line y = x - k with the polygon's edges, as x values
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i] as Pt;
      const q = pts[(i + 1) % pts.length] as Pt;
      const fp = p.x - p.y - k;
      const fq = q.x - q.y - k;
      if (fp > 0 === fq > 0) continue;
      const t = fp / (fp - fq);
      xs.push(p.x + (q.x - p.x) * t);
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i] as number;
      const x1 = xs[i + 1] as number;
      if (x1 - x0 > 1) out.push([pt(x0, x0 - k), pt(x1, x1 - k)]);
    }
  }
  return out;
}
