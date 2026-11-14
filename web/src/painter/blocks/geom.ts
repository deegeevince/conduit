// Small plane geometry shared by the structure engines. Pure, no allocation
// beyond what it returns. Boxes are top-left x, y and a size, in stage units.

import type { Point, Polyline } from '@conduit/language';
import type { Box } from '../../contracts/space';

export const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });

export const right = (b: Box): number => b.x + b.width;
export const bottom = (b: Box): number => b.y + b.height;
export const centreOf = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

export function inflate(b: Box, d: number): Box {
  return { x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d };
}

export function union(boxes: readonly Box[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, right(b));
    y1 = Math.max(y1, bottom(b));
  }
  return x0 > x1 ? box(0, 0, 0, 0) : box(x0, y0, x1 - x0, y1 - y0);
}

export function translateBox(b: Box, dx: number, dy: number): Box {
  return { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
}

/** Two boxes overlap when they share area; `gap` demands that much clear space between them as well. */
export function overlaps(a: Box, b: Box, gap = 0): boolean {
  return a.x < right(b) + gap && b.x < right(a) + gap && a.y < bottom(b) + gap && b.y < bottom(a) + gap;
}

export function contains(outer: Box, inner: Box, slack = 0): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && right(inner) <= right(outer) + slack && bottom(inner) <= bottom(outer) + slack;
}

// The clipping state of one `segmentHitsBox` call. Module-level and the clip a plain function, not a closure made per call: this is the
// hot loop of every routed diagram, and a closure per call cost most of a phone-width flowchart's measuring under tsx's `keepNames`.
let clipT0 = 0;
let clipT1 = 1;
const CLIP_EPS = 1e-6;

function clip(p: number, q: number): boolean {
  if (Math.abs(p) < CLIP_EPS) return q > CLIP_EPS;
  const t = q / p;
  if (p < 0) {
    if (t > clipT1) return false;
    if (t > clipT0) clipT0 = t;
  } else {
    if (t < clipT0) return false;
    if (t < clipT1) clipT1 = t;
  }
  return true;
}

/** Whether the segment ab passes through the interior of the box (touching an edge does not count). */
export function segmentHitsBox(a: Point, b: Point, r: Box): boolean {
  const eps = CLIP_EPS;
  clipT0 = 0;
  clipT1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return (
    clip(-dx, a.x - r.x - eps) &&
    clip(dx, right(r) - a.x - eps) &&
    clip(-dy, a.y - r.y - eps) &&
    clip(dy, bottom(r) - a.y - eps) &&
    clipT1 - clipT0 > eps / Math.max(1, Math.hypot(dx, dy))
  );
}

export function polylineHitsBox(line: Polyline, r: Box): boolean {
  const pts = line.points;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a && b && segmentHitsBox(a, b, r)) return true;
  }
  if (line.closed && pts.length > 2) {
    const a = pts[pts.length - 1];
    const b = pts[0];
    if (a && b && segmentHitsBox(a, b, r)) return true;
  }
  return false;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** A proper crossing of two segments (shared endpoints and touching do not count). */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const e = 1e-9;
  return ((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) && ((o3 > e && o4 < -e) || (o3 < -e && o4 > e));
}

export function polylinesCross(p: Polyline, q: Polyline): number {
  let n = 0;
  const a = p.points;
  const b = q.points;
  for (let i = 0; i + 1 < a.length; i += 1) {
    for (let j = 0; j + 1 < b.length; j += 1) {
      const a0 = a[i];
      const a1 = a[i + 1];
      const b0 = b[j];
      const b1 = b[j + 1];
      if (a0 && a1 && b0 && b1 && segmentsCross(a0, a1, b0, b1)) n += 1;
    }
  }
  return n;
}

export const open = (points: readonly Point[]): Polyline => ({ points, closed: false });
export const closedLine = (points: readonly Point[]): Polyline => ({ points, closed: true });

export function lengthOf(points: readonly Point[]): number {
  let n = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a && b) n += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return n;
}

/** Drops points that sit on a straight run, and repeats. */
export function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
    while (out.length >= 3) {
      const c = out[out.length - 1] as Point;
      const b = out[out.length - 2] as Point;
      const a = out[out.length - 3] as Point;
      if (Math.abs(orient(a, b, c)) < 1e-6 && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) >= 0) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}

/** The point `d` along the polyline, and the unit direction there. */
export function atDistance(points: readonly Point[], d: number): { point: Point; dir: Point } {
  let left = Math.max(0, d);
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 0 && (left <= len || i + 2 === points.length)) {
      const t = Math.min(1, left / len);
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
    }
    left -= len;
  }
  const p = points[0] ?? { x: 0, y: 0 };
  return { point: p, dir: { x: 1, y: 0 } };
}

/** The polyline with `from` removed at its start and `to` at its end. */
export function trim(points: readonly Point[], from: number, to: number): Point[] {
  const total = lengthOf(points);
  if (total <= from + to) return points.length > 0 ? [points[0] as Point] : [];
  const out: Point[] = [atDistance(points, from).point];
  let run = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run += Math.hypot(b.x - a.x, b.y - a.y);
    if (run > from + 1e-6 && run < total - to - 1e-6) out.push(b);
  }
  out.push(atDistance(points, total - to).point);
  return out;
}

/** Cuts a polyline into dashes. */
export function dashes(points: readonly Point[], on: number, off: number): Polyline[] {
  const total = lengthOf(points);
  const out: Polyline[] = [];
  for (let d = 0; d < total; d += on + off) {
    const end = Math.min(total, d + on);
    const seg: Point[] = [atDistance(points, d).point];
    let run = 0;
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      run += Math.hypot(b.x - a.x, b.y - a.y);
      if (run > d + 1e-6 && run < end - 1e-6) seg.push(b);
    }
    seg.push(atDistance(points, end).point);
    if (seg.length >= 2) out.push(open(seg));
  }
  return out;
}

/** A closed outline of a box with rounded corners (r = 0: square). */
export function roundedRect(b: Box, r: number): Polyline {
  const rr = Math.min(r, b.width / 2, b.height / 2);
  if (rr <= 0.5) return closedLine([{ x: b.x, y: b.y }, { x: right(b), y: b.y }, { x: right(b), y: bottom(b) }, { x: b.x, y: bottom(b) }]);
  const pts: Point[] = [];
  const corner = (cx: number, cy: number, from: number): void => {
    const steps = Math.max(2, Math.ceil(rr / 3));
    for (let i = 0; i <= steps; i += 1) {
      const a = from + (Math.PI / 2) * (i / steps);
      pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
    }
  };
  corner(right(b) - rr, b.y + rr, -Math.PI / 2);
  corner(right(b) - rr, bottom(b) - rr, 0);
  corner(b.x + rr, bottom(b) - rr, Math.PI / 2);
  corner(b.x + rr, b.y + rr, Math.PI);
  return closedLine(pts);
}

/** A box with its four corners clipped: a decision. */
export function clippedRect(b: Box, c: number): Polyline {
  const k = Math.min(c, b.width / 3, b.height / 2);
  return closedLine([
    { x: b.x + k, y: b.y },
    { x: right(b) - k, y: b.y },
    { x: right(b), y: b.y + k },
    { x: right(b), y: bottom(b) - k },
    { x: right(b) - k, y: bottom(b) },
    { x: b.x + k, y: bottom(b) },
    { x: b.x, y: bottom(b) - k },
    { x: b.x, y: b.y + k },
  ]);
}

/** The four midpoints of a box's sides: a diamond. */
export function diamond(b: Box): Polyline {
  return closedLine([
    { x: b.x + b.width / 2, y: b.y },
    { x: right(b), y: b.y + b.height / 2 },
    { x: b.x + b.width / 2, y: bottom(b) },
    { x: b.x, y: b.y + b.height / 2 },
  ]);
}

export function rectOutline(b: Box): Polyline {
  return roundedRect(b, 0);
}

export function circle(cx: number, cy: number, r: number): Polyline {
  const n = Math.max(8, Math.min(24, Math.ceil(r * 1.2)));
  const pts: Point[] = [];
  for (let i = 0; i < n; i += 1) pts.push({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) });
  return closedLine(pts);
}

/** A filled triangle whose tip is at `tip`, pointing along `dir`. */
export function arrowhead(tip: Point, dir: Point, length: number, halfWidth: number): Polyline {
  const bx = tip.x - dir.x * length;
  const by = tip.y - dir.y * length;
  return closedLine([tip, { x: bx - dir.y * halfWidth, y: by + dir.x * halfWidth }, { x: bx + dir.y * halfWidth, y: by - dir.x * halfWidth }]);
}

export function boxOfPoints(points: readonly Point[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return x0 > x1 ? box(0, 0, 0, 0) : box(x0, y0, x1 - x0, y1 - y0);
}

/**
 * Least-squares positions for items in a fixed order that keep a minimum
 * distance between neighbours (isotonic regression by pooling adjacent
 * violators). `min[i]` is the least distance from item i to item i+1.
 */
export function packOrdered(desired: readonly number[], min: readonly number[], weight: readonly number[]): number[] {
  const n = desired.length;
  const offset: number[] = [0];
  for (let i = 1; i < n; i += 1) offset.push((offset[i - 1] as number) + (min[i - 1] as number));
  type Block = { sum: number; w: number; count: number };
  const blocks: Block[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = weight[i] ?? 1;
    blocks.push({ sum: w * ((desired[i] as number) - (offset[i] as number)), w, count: 1 });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1] as Block;
      const a = blocks[blocks.length - 2] as Block;
      if (a.sum / a.w <= b.sum / b.w) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, w: a.w + b.w, count: a.count + b.count });
    }
  }
  const out: number[] = [];
  let i = 0;
  for (const block of blocks) {
    const value = block.sum / block.w;
    for (let k = 0; k < block.count; k += 1) {
      out.push(value + (offset[i] as number));
      i += 1;
    }
  }
  return out;
}

/** An open polyline with the stretch inside `r` taken out: what is left is one or more open pieces (the line visibly breaks round a word set in `r`). */
export function cutOutBox(line: Polyline, r: Box): Polyline[] {
  if (line.closed || line.points.length < 2) return [line];
  const pieces: Polyline[] = [];
  let run: Point[] = [];
  const flush = (): void => {
    if (run.length >= 2) pieces.push({ points: run, closed: false });
    run = [];
  };
  const x0 = r.x;
  const x1 = r.x + r.width;
  const y0 = r.y;
  const y1 = r.y + r.height;
  const pts = line.points;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i] as Point;
    const b = pts[i + 1] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // the parameter range of the segment inside the box (Liang-Barsky)
    let t0 = 0;
    let t1 = 1;
    let hit = true;
    for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
      if (Math.abs(p) < 1e-9) {
        if (q < 0) hit = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (!hit || t0 >= t1) {
      if (run.length === 0) run.push(a);
      run.push(b);
      continue;
    }
    const at = (t: number): Point => ({ x: a.x + dx * t, y: a.y + dy * t });
    if (t0 > 1e-9) {
      if (run.length === 0) run.push(a);
      run.push(at(t0));
    }
    flush();
    if (t1 < 1 - 1e-9) run.push(at(t1), b);
  }
  flush();
  return pieces;
}
