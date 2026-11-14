// Boundary labelling, as a technical illustrator does it: every label stands OUTSIDE the subject, on the side nearest the part it names,
// in the order of the parts along that side, with one straight leader to a point on the part's own shape. No label is ever on the figure, and
// no two leaders cross.
//
// This is a pure module with no knowledge of the figure kit: it takes label sizes, each part's polyline, the subject's box and the room, and
// returns boxes and leaders. The callout engine (`blocks/callouts.ts`, `v2.1-callout`'s boundary placement, c44e255) does the same job for
// `say callout near=`; that branch had not landed in the tree this was built on, so this is written to be shared: when it lands, the callout
// code can take `placeBoundary` (or this can be replaced by it) and the figure kit changes nowhere but `layout.ts`.
//
// How: each label is allowed the sides its part's centre is on (a part in the left half may be labelled on the left, one in the top half on
// the top), narrowed to the sides that have room for it, and the two nearest are tried. Every assignment of labels to sides (at most 2^7) is
// packed along its sides in order of the leaders' anchors, then scored: a label off the room or over another, a leader through a label, and
// leaders that cross are faults; what is left is leader length. A pass of swaps along each side then untangles what order alone did not.
//
// Pure: no DOM, no clock.

import { bounds, centreOf, dist, edgeDistance, frameAt, inside, pole, rectsOverlap, segmentHitsRect, segmentsCross, totalLength } from './geometry';
import type { Poly, Rect } from './geometry';
import type { Pt } from './types';

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface BoundaryLabel {
  readonly key: string;
  /** the text block's size, tried in order: the first that fits the gutter (one line, then two) */
  readonly sizes: readonly { readonly w: number; readonly h: number }[];
  /** the part's own shape */
  readonly poly: Poly;
  /** closed shapes drawn over or around it, which its anchor keeps out of (so a leader ends on THIS part, not on one that sits in it) */
  readonly covers: readonly (readonly Pt[])[];
}

export interface BoundaryInput {
  readonly labels: readonly BoundaryLabel[];
  /** the subject's box: labels go round it, never on it */
  readonly figure: Rect;
  /** where labels may go */
  readonly room: Rect;
  /** the space between a label and the subject, and between two labels */
  readonly gap: number;
  readonly sep: number;
  /** the space between two labels side by side (above or below the subject), where words need more air than lines do */
  readonly sepX?: number;
}

export interface PlacedLabel {
  readonly key: string;
  readonly side: Side;
  readonly box: Rect;
  readonly align: 'left' | 'right' | 'center';
  /** where the leader lands: a point on the part's own shape */
  readonly anchor: Pt;
  /** from the label's edge to the anchor */
  readonly leader: readonly [Pt, Pt];
}

export interface BoundaryResult {
  readonly placed: ReadonlyMap<string, PlacedLabel>;
  /** labels that could not be put anywhere clear: the caller drops these (optional parts first) and runs again */
  readonly bad: readonly string[];
  readonly crossings: number;
  readonly cost: number;
}

const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom'];
const horizontal = (side: Side): boolean => side === 'left' || side === 'right';

// ------------------------------------------------------------------ anchors

function anchorFor(label: BoundaryLabel, side: Side): Pt {
  const score = (p: Pt): number => (side === 'left' ? p.x : side === 'right' ? -p.x : side === 'top' ? p.y : -p.y);
  const { poly } = label;
  if (!poly.closed) {
    const length = totalLength(poly);
    const samples: Pt[] = [];
    for (let i = 0; i <= 40; i += 1) samples.push(frameAt(poly, length * (0.06 + 0.88 * (i / 40))).at);
    const free = samples.filter((p) => !label.covers.some((c) => inside(p, c)));
    const from = free.length > 0 ? free : samples;
    return from.reduce((best, p) => (score(p) < score(best) ? p : best), from[0] as Pt);
  }
  const middle = pole(poly.pts);
  const b = bounds(poly.pts);
  const cells = 26;
  const candidates: Pt[] = [];
  for (let i = 0; i <= cells; i += 1) {
    for (let j = 0; j <= cells; j += 1) {
      const p = { x: b.x + (b.width * i) / cells, y: b.y + (b.height * j) / cells };
      if (inside(p, poly.pts)) candidates.push(p);
    }
  }
  const clear = (p: Pt, margin: number): boolean => !label.covers.some((c) => inside(p, c) || edgeDistance(p, c) < margin);
  const deep = (p: Pt, share: number): boolean => edgeDistance(p, poly.pts) >= Math.max(1.5, middle.depth * share);
  for (const [share, margin] of [[0.45, 3], [0.25, 2], [0.1, 1]] as const) {
    const ok = candidates.filter((p) => deep(p, share) && clear(p, margin));
    if (ok.length > 0) return ok.reduce((best, p) => (score(p) < score(best) - 1e-9 ? p : best), ok[0] as Pt);
  }
  return clear(middle.at, 0) ? middle.at : middle.at;
}

// ------------------------------------------------------------------ one assignment, packed

interface Candidate {
  readonly label: BoundaryLabel;
  readonly centre: Pt;
  /** the sides it may stand on, nearest first */
  readonly sides: readonly Side[];
}

interface Solved {
  readonly placed: Map<string, PlacedLabel>;
  readonly bad: Set<string>;
  readonly crossings: number;
  readonly faults: number;
  readonly length: number;
}

const better = (a: Solved, b: Solved): boolean => a.faults < b.faults || (a.faults === b.faults && (a.crossings < b.crossings || (a.crossings === b.crossings && a.length < b.length - 1e-6)));

export function placeBoundary(input: BoundaryInput): BoundaryResult {
  const { figure, room, gap, sep } = input;
  const sepX = input.sepX ?? sep;
  const gutter: Record<Side, number> = {
    left: figure.x - room.x - gap,
    right: room.x + room.width - (figure.x + figure.width) - gap,
    top: figure.y - room.y - gap,
    bottom: room.y + room.height - (figure.y + figure.height) - gap,
  };
  const fig = { x: figure.x + figure.width / 2, y: figure.y + figure.height / 2 };
  const slack = 0.04 * Math.max(figure.width, figure.height);
  const sizeAt = (label: BoundaryLabel, side: Side): { w: number; h: number } | null =>
    label.sizes.find((s) => (horizontal(side) ? s.w <= gutter[side] + 1e-6 && s.h <= room.height : s.h <= gutter[side] + 1e-6 && s.w <= room.width)) ?? null;

  const candidates: Candidate[] = input.labels.map((label) => {
    const centre = centreOf(label.poly);
    const depth: Record<Side, number> = { left: centre.x - figure.x, right: figure.x + figure.width - centre.x, top: centre.y - figure.y, bottom: figure.y + figure.height - centre.y };
    const allowed = (side: Side): boolean => (side === 'left' ? centre.x <= fig.x + slack : side === 'right' ? centre.x >= fig.x - slack : side === 'top' ? centre.y <= fig.y + slack : centre.y >= fig.y - slack);
    const usable = SIDES.filter((side) => sizeAt(label, side) !== null);
    const near = (list: readonly Side[]): Side[] => [...list].sort((a, b) => depth[a] - depth[b] || gutter[b] - gutter[a]);
    const own = near(usable.filter(allowed));
    // a side on the far half of the figure is the last resort: the leader crosses the subject
    const sides = own.length > 0 ? own.slice(0, 2) : near(usable).slice(0, 1);
    return { label, centre, sides };
  });
  const stranded = candidates.filter((c) => c.sides.length === 0).map((c) => c.label.key);
  const live = candidates.filter((c) => c.sides.length > 0);
  const anchors = new Map<string, Pt>();
  const anchor = (label: BoundaryLabel, side: Side): Pt => {
    const key = `${label.key}|${side}`;
    const hit = anchors.get(key);
    if (hit !== undefined) return hit;
    const made = anchorFor(label, side);
    anchors.set(key, made);
    return made;
  };

  function solve(assign: ReadonlyMap<string, Side>, orders: ReadonlyMap<Side, readonly string[]> | null): { solved: Solved; orders: Map<Side, string[]> } {
    const placed = new Map<string, PlacedLabel>();
    const bad = new Set<string>();
    const used = new Map<Side, string[]>();
    for (const c of live) {
      const side = assign.get(c.label.key) as Side;
      used.set(side, [...(used.get(side) ?? []), c.label.key]);
    }
    const byKey = new Map(live.map((c) => [c.label.key, c]));
    const outOrders = new Map<Side, string[]>();
    for (const [side, keys] of used) {
      const along = (key: string): number => {
        const p = anchor((byKey.get(key) as Candidate).label, side);
        return horizontal(side) ? p.y : p.x;
      };
      const given = orders?.get(side);
      const order = given !== undefined && given.length === keys.length && keys.every((k) => given.includes(k)) ? [...given] : [...keys].sort((a, b) => along(a) - along(b) || a.localeCompare(b));
      outOrders.set(side, order);
      const sized = order.map((key) => ({ key, size: sizeAt((byKey.get(key) as Candidate).label, side) as { w: number; h: number } }));
      const extent = (s: { w: number; h: number }): number => (horizontal(side) ? s.h : s.w);
      const space = horizontal(side) ? sep : sepX;
      const start = horizontal(side) ? room.y : room.x;
      const end = horizontal(side) ? room.y + room.height : room.x + room.width;
      const want = sized.map((s) => along(s.key) - extent(s.size) / 2);
      const pos: number[] = [];
      sized.forEach((s, i) => {
        const prev = i === 0 ? start : (pos[i - 1] as number) + extent((sized[i - 1] as (typeof sized)[number]).size) + space;
        pos.push(Math.max(prev, want[i] as number));
      });
      // too far along: push back toward the start, keeping order
      for (let i = sized.length - 1; i >= 0; i -= 1) {
        const limit = i === sized.length - 1 ? end : (pos[i + 1] as number) - space;
        pos[i] = Math.min(pos[i] as number, limit - extent((sized[i] as (typeof sized)[number]).size));
      }
      sized.forEach((s, i) => {
        const at = pos[i] as number;
        if (at < start - 1e-6) bad.add(s.key);
        const { w, h } = s.size;
        const box: Rect =
          side === 'left' ? { x: figure.x - gap - w, y: at, width: w, height: h }
          : side === 'right' ? { x: figure.x + figure.width + gap, y: at, width: w, height: h }
          : side === 'top' ? { x: at, y: figure.y - gap - h, width: w, height: h }
          : { x: at, y: figure.y + figure.height + gap, width: w, height: h };
        const a = anchor((byKey.get(s.key) as Candidate).label, side);
        const from: Pt =
          side === 'left' ? { x: box.x + box.width, y: box.y + box.height / 2 }
          : side === 'right' ? { x: box.x, y: box.y + box.height / 2 }
          : side === 'top' ? { x: box.x + box.width / 2, y: box.y + box.height }
          : { x: box.x + box.width / 2, y: box.y };
        placed.set(s.key, { key: s.key, side, box, align: side === 'left' ? 'right' : side === 'right' ? 'left' : 'center', anchor: a, leader: [from, a] });
      });
    }
    // what cannot stand: off the room, over another label, a leader through one
    const list = [...placed.values()];
    for (const p of list) {
      const b = p.box;
      if (b.x < room.x - 1e-6 || b.y < room.y - 1e-6 || b.x + b.width > room.x + room.width + 1e-6 || b.y + b.height > room.y + room.height + 1e-6) bad.add(p.key);
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i] as PlacedLabel;
        const b = list[j] as PlacedLabel;
        if (rectsOverlap(a.box, b.box, 0.5)) {
          bad.add(a.key);
          bad.add(b.key);
        }
      }
      for (const other of list) if (other.key !== (list[i] as PlacedLabel).key && segmentHitsRect((list[i] as PlacedLabel).leader[0], (list[i] as PlacedLabel).leader[1], other.box)) bad.add((list[i] as PlacedLabel).key);
    }
    let crossings = 0;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = (list[i] as PlacedLabel).leader;
        const b = (list[j] as PlacedLabel).leader;
        if (segmentsCross(a[0], a[1], b[0], b[1])) crossings += 1;
      }
    }
    const length = list.reduce((sum, p) => sum + dist(p.leader[0], p.leader[1]), 0);
    return { solved: { placed, bad, crossings, faults: bad.size, length }, orders: outOrders };
  }

  // every assignment of labels to their candidate sides
  let best: { solved: Solved; orders: Map<Side, string[]>; assign: Map<string, Side> } | null = null;
  const total = live.reduce((n, c) => n * c.sides.length, 1);
  for (let code = 0; code < total; code += 1) {
    let rest = code;
    const assign = new Map<string, Side>();
    for (const c of live) {
      assign.set(c.label.key, c.sides[rest % c.sides.length] as Side);
      rest = Math.floor(rest / c.sides.length);
    }
    const made = solve(assign, null);
    if (best === null || better(made.solved, best.solved)) best = { ...made, assign };
  }
  // swaps along a side untangle what the order of the anchors did not
  if (best !== null && (best.solved.crossings > 0 || best.solved.faults > 0)) {
    for (let pass = 0; pass < 6; pass += 1) {
      let improved = false;
      for (const [side, order] of best.orders) {
        for (let i = 0; i + 1 < order.length; i += 1) {
          const swapped = [...order];
          [swapped[i], swapped[i + 1]] = [swapped[i + 1] as string, swapped[i] as string];
          const trial = new Map(best.orders);
          trial.set(side, swapped);
          const made = solve(best.assign, trial);
          if (better(made.solved, best.solved)) {
            best = { ...made, assign: best.assign };
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (!improved) break;
    }
  }
  const solved = best?.solved;
  return {
    placed: solved?.placed ?? new Map(),
    bad: [...stranded, ...(solved === undefined ? [] : [...solved.bad])],
    crossings: solved?.crossings ?? 0,
    cost: solved === undefined ? 0 : solved.faults * 1e7 + solved.crossings * 1e5 + solved.length,
  };
}
