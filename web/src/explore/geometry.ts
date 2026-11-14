// What the painter measured about a resting stage, with no model in the loop (quality bar, rows 4 and 5): text that
// overlaps text, connectors that pass through a node that is not one of their ends, labels a drawn line runs through,
// things outside the safe frame. Pure: boxes in, counts out, so the same answer always counts the same.

import type { ExploreGeometry, PlacedBox, Schedule, Sight, SightNote } from '@conduit/language';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Overlap of two boxes as a share of the smaller one. */
function overlapShare(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller <= 0 ? 0 : (w * h) / smaller;
}

/** Whether the segment p to q passes through the interior of the box (Liang-Barsky, the box shrunk a little so grazing an edge is not a hit). */
function segmentThrough(p: { x: number; y: number }, q: { x: number; y: number }, box: Box, shrink: number): boolean {
  const x0 = box.x + shrink;
  const y0 = box.y + shrink;
  const x1 = box.x + box.w - shrink;
  const y1 = box.y + box.h - shrink;
  if (x1 <= x0 || y1 <= y0) return false;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (direction: number, distance: number): boolean => {
    if (direction === 0) return distance >= 0;
    const t = distance / direction;
    if (direction < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, p.x - x0) && clip(dx, x1 - p.x) && clip(-dy, p.y - y0) && clip(dy, y1 - p.y) && t0 < t1;
}

const NOTE_COUNT = (sight: Sight, note: SightNote): number => sight.items.filter((item) => item.resting && item.notes.includes(note)).length;

/**
 * `placed` is the painter's own resolved boxes for the resting stage (`placedOf`), in canvas units. A link is judged as the straight
 * run between the centres of its two ends: a painter that routes a connector around a node can only do better than this, so a count of
 * zero means the connector is clear and a count above it means a straight run would cross. (The engine's own routed path is better:
 * this takes it when the placed box of a link carries one.)
 */
export function geometryOf(schedule: Schedule, placed: readonly (PlacedBox & { readonly key: string })[], sight: Sight): ExploreGeometry {
  const byKey = new Map(placed.map((box) => [box.key, box]));
  const alive = (key: string): boolean => {
    const element = schedule.elements.find((candidate) => candidate.key === key);
    return element !== undefined && element.exit === null;
  };
  const texts = placed.filter((box) => box.kind === 'text' && alive(box.key) && box.box.w > 0 && box.box.h > 0);
  let overlaps = 0;
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i] as PlacedBox;
      const b = texts[j] as PlacedBox;
      if (overlapShare(a.box, b.box) > 0.12) overlaps += 1;
    }
  }

  let through = 0;
  for (const element of schedule.elements) {
    const figure = element.figure;
    if (element.carried || element.exit !== null || figure?.kind !== 'link') continue;
    const from = byKey.get(figure.from);
    const to = byKey.get(figure.to);
    if (from === undefined || to === undefined) continue;
    const p = { x: from.box.x + from.box.w / 2, y: from.box.y + from.box.h / 2 };
    const q = { x: to.box.x + to.box.w / 2, y: to.box.y + to.box.h / 2 };
    const crossing = placed.some(
      (other) => other.kind === 'node' && other.key !== figure.from && other.key !== figure.to && alive(other.key) && other.parent === from.parent && segmentThrough(p, q, other.box, 1),
    );
    if (crossing) through += 1;
  }

  const notes: Partial<Record<SightNote, number>> = {};
  for (const item of sight.items) for (const note of item.notes) if (item.resting) notes[note] = (notes[note] ?? 0) + 1;
  return {
    textOverlaps: overlaps,
    crossedLabels: NOTE_COUNT(sight, 'crossed'),
    linksThroughNodes: through,
    clipped: NOTE_COUNT(sight, 'clipped'),
    notes,
  };
}
