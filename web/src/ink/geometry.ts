// Plain geometry for ink: bounds, distances, and which box a stroke landed in. No DOM.

import type { InkBox, InkPoint, InkRegionDef, InkRegionHit, InkStroke } from '@conduit/language';

export function strokeBounds(stroke: InkStroke): InkBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const pad = stroke.width * 0.5;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

export function unionBox(a: InkBox | null, b: InkBox): InkBox {
  if (a === null) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function inflate(box: InkBox, by: number): InkBox {
  return { x: box.x - by, y: box.y - by, w: box.w + by * 2, h: box.h + by * 2 };
}

export function clampBox(box: InkBox, w: number, h: number): InkBox {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(w, box.x + box.w);
  const y1 = Math.min(h, box.y + box.h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export function inside(box: InkBox, x: number, y: number): boolean {
  return x >= box.x && y >= box.y && x <= box.x + box.w && y <= box.y + box.h;
}

export function boxesOverlap(a: InkBox, b: InkBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The distance from a point to the segment a-b. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a disc at (x, y) touches the stroke's line (its width counted). */
export function strokeTouches(stroke: InkStroke, x: number, y: number, radius: number): boolean {
  const reach = radius + stroke.width * 0.5;
  const pts: readonly InkPoint[] = stroke.points;
  if (pts.length === 1) return Math.hypot(x - pts[0]![0], y - pts[0]![1]) <= reach;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (segmentDistance(x, y, a[0], a[1], b[0], b[1]) <= reach) return true;
  }
  return false;
}

/**
 * The box a stroke landed in: the one holding the most of its points, if that is at least half of them; otherwise null. A tie goes to the smaller
 * box (an answer box inside a scratch area). A stroke that is mostly outside every box is "outside".
 */
export function regionOf(stroke: InkStroke, regions: readonly InkRegionDef[]): string | null {
  let best: { id: string; count: number; area: number } | null = null;
  for (const region of regions) {
    let count = 0;
    for (const [x, y] of stroke.points) if (inside(region.box, x, y)) count += 1;
    const area = region.box.w * region.box.h;
    if (count * 2 < stroke.points.length || count === 0) continue;
    if (best === null || count > best.count || (count === best.count && area < best.area)) best = { id: region.id, count, area };
  }
  return best === null ? null : best.id;
}

/** Every box with the ids of the strokes that landed in it, and the strokes that landed in none. */
export function reportRegions(strokes: readonly InkStroke[], regions: readonly InkRegionDef[]): { readonly regions: InkRegionHit[]; readonly outside: string[] } {
  const hits = new Map<string, string[]>(regions.map((region) => [region.id, []]));
  const outside: string[] = [];
  for (const stroke of strokes) {
    const id = regionOf(stroke, regions);
    if (id === null) outside.push(stroke.id);
    else hits.get(id)?.push(stroke.id);
  }
  return { regions: regions.map((region) => ({ ...region, strokes: hits.get(region.id) ?? [] })), outside };
}
