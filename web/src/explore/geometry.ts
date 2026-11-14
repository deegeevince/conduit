// What the battery counts about a resting stage, with no model in the loop and no word from the painter about its own work (quality bar,
// rows 4 and 5). v2 let the painter mark its own homework: it compared free text with free text only, and judged a connector as the straight
// run between its ends. This audit is the battery's:
//
//  - every box that holds words (free text, a node or row, a control, a chart's room) is set against every other box that holds words or is
//    a chart, except the boxes it belongs to (its own structure and the parts of it), and against the room the stage plan gave it, when the
//    painter publishes a plan;
//  - a connector is its drawn route, as the structure engine reports it: through a node that is not one of its ends, or through a label;
//  - nothing may stand outside the screen.
//
// Pure: boxes in, counts out, so the same answer always counts the same. Boxes are in canvas units, the unit `placedOf` and the sight report speak.

import type { CanvasBox, ExploreGeometry, LookId, PlacedBox, Schedule, Sight, SightNote } from '@conduit/language';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Placed = PlacedBox & { readonly key: string };

/** What the painter, running the answer as the app does, said about the composed stage, converted to canvas units. Absent: only the placed boxes are audited. */
export interface Composed {
  /** where each control really is on screen (the painter's own boxes: a control card is laid out by the controls, not by `placedOf`) */
  readonly controls: readonly { readonly id: string; readonly box: CanvasBox }[];
  /** each chart's room */
  readonly charts: readonly { readonly id: string; readonly box: CanvasBox }[];
  /** the stage plan, when the painter publishes one */
  readonly plan: {
    readonly rooms: readonly { readonly key: string; readonly kind: string; readonly box: CanvasBox }[];
    readonly flow: CanvasBox;
    readonly foot: CanvasBox | null;
    readonly picture: CanvasBox | null;
  } | null;
}

export interface AuditInput {
  readonly schedule: Schedule;
  readonly placed: readonly Placed[];
  readonly sight: Sight;
  /** every run of words the resting frame holds: free text, a structure's title, the label of each of its nodes and rows. Where the words really are */
  readonly texts: readonly { readonly id: string; readonly key: string; readonly box: CanvasBox }[];
  /** the viewport, as a rectangle in canvas units */
  readonly screen: CanvasBox;
  readonly composed: Composed | null;
  /** How much of a box (canvas units) is drawn ink in the stage with its words taken away; absent when no picture could be taken */
  readonly inkUnder?: (box: CanvasBox) => number;
  readonly look: LookId | null;
  readonly screenName: string;
}

/** Overlap of two boxes as a share of the smaller one. */
export function overlapShare(a: CanvasBox, b: CanvasBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller <= 0 ? 0 : (w * h) / smaller;
}

/** Whether the segment p to q passes through the interior of the box (Liang-Barsky, the box shrunk by `shrink` so grazing an edge is not a hit). */
export function segmentThrough(p: Point, q: Point, box: CanvasBox, shrink: number): boolean {
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

/** Whether any segment of the polyline passes through the box. */
export function routeThrough(route: readonly Point[], box: CanvasBox, shrink: number): boolean {
  for (let i = 1; i < route.length; i += 1) {
    const p = route[i - 1];
    const q = route[i];
    if (p !== undefined && q !== undefined && segmentThrough(p, q, box, shrink)) return true;
  }
  return false;
}

const NOTE_COUNT = (sight: Sight, note: SightNote): number => sight.items.filter((item) => item.resting && item.notes.includes(note)).length;

/** Two boxes overlap by more than this share of the smaller one: a graze of an edge is not a collision. */
const OVERLAP = 0.12;
/** How far past the screen's edge a box may stand, canvas units, before it counts as outside. */
const EDGE = 0.75;
/** How far past its room a box may stand, canvas units. */
const ROOM = 1.5;
/** How much a node is shrunk before a route is said to go through it. */
const NODE_SHRINK = 1;
const LABEL_SHRINK = 0.4;
const PAIRS_KEPT = 12;
/** Words with more than this share of drawn ink under them, that are not a label for what they stand on, are over the drawing. */
const INK = 0.18;

const holdsWords = (kind: string): boolean => kind === 'text' || kind === 'node' || kind === 'control';

function inside(inner: CanvasBox, room: CanvasBox, slack: number): boolean {
  return inner.x >= room.x - slack && inner.y >= room.y - slack && inner.x + inner.w <= room.x + room.w + slack && inner.y + inner.h <= room.y + room.h + slack;
}

/**
 * Counts what is wrong on the resting stage. `textOverlaps` is the number of pairs of boxes, one of which holds words, that overlap and are not
 * parts of each other; `linksThroughNodes` and `crossedLabels` follow each connector's drawn route (a connector the engine did not route is not
 * audited: it is counted in `unrouted`, never guessed at from a straight line).
 */
export function geometryOf(input: AuditInput): ExploreGeometry {
  const { schedule, placed, sight, screen, composed } = input;
  const aliveKeys = new Set(schedule.elements.filter((element) => element.exit === null).map((element) => element.key));
  const figureOf = new Map(schedule.elements.map((element) => [element.key, element.figure] as const));
  const live = placed.filter((box) => aliveKeys.has(box.key) && box.box.w > 0 && box.box.h > 0);
  const byId = new Map(live.map((box) => [box.id, box] as const));
  const ancestors = (box: Placed): Set<string> => {
    const chain = new Set<string>();
    let at = box.parent === null ? undefined : byId.get(box.parent);
    while (at !== undefined && !chain.has(at.id)) {
      chain.add(at.id);
      at = at.parent === null ? undefined : byId.get(at.parent);
    }
    return chain;
  };

  // The things that hold words, and the things words must not stand on.
  const structureKeys = new Set(live.filter((box) => box.kind === 'structure').map((box) => box.key));
  /** words that are set against a part of something on purpose: a label near what it names, a callout with its leader. They may stand inside the thing they label. */
  const labelling = new Set(schedule.elements.filter((element) => element.kind === 'text' && (element.style.near !== null || element.style.leader || element.style.group !== null)).map((element) => element.id));
  interface Candidate {
    readonly name: string;
    readonly key: string;
    /** the element it is, for telling what belongs to what */
    readonly id: string;
    readonly box: CanvasBox;
    readonly words: boolean;
  }
  const items: Candidate[] = [];
  // Words are where the frame set them: a structure's title and the label of each node are runs of text the placed boxes of nodes do not show.
  for (const text of input.texts) if (text.box.w > 0 && text.box.h > 0) items.push({ name: text.key, key: text.key, id: text.id, box: text.box, words: true });
  for (const box of live) if (structureKeys.has(box.key)) items.push({ name: box.id, key: box.key, id: box.id, box: box.box, words: false });
  // A control is where the painter says it is: its card is laid out by the controls and not by `placedOf`.
  const controlIds = new Set(composed?.controls.map((control) => control.id) ?? []);
  for (const control of composed?.controls ?? []) items.push({ name: control.id, key: `control:${control.id}`, id: control.id, box: control.box, words: true });
  for (const box of live) if (box.kind === 'control' && !controlIds.has(box.id)) items.push({ name: box.id, key: box.key, id: box.id, box: box.box, words: true });
  for (const chart of composed?.charts ?? []) if (!items.some((item) => item.id === chart.id && !item.words)) items.push({ name: chart.id, key: `chart:${chart.id}`, id: chart.id, box: chart.box, words: false });

  /** Whether the element `inner` is the element `outer` or a part of it. */
  const partOf = (inner: string, outer: string): boolean => {
    if (inner === outer) return true;
    const chain = ancestors(byId.get(inner) ?? { id: inner, kind: 'text', parent: null, box: { x: 0, y: 0, w: 0, h: 0 }, key: inner });
    return chain.has(outer);
  };

  const pairs: string[] = [];
  let overlaps = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i] as Candidate;
      const b = items[j] as Candidate;
      if (!a.words && !b.words) continue;
      // What is part of a thing may stand inside it (a node's label, a structure's own title) and so may a label set against it on purpose.
      if (!a.words && b.words ? partOf(b.id, a.id) || labelling.has(b.id) : a.words && !b.words ? partOf(a.id, b.id) || labelling.has(a.id) : false) continue;
      if (a.id === b.id && a.words && b.words && a.key !== b.key) continue;
      if (overlapShare(a.box, b.box) > OVERLAP) {
        overlaps += 1;
        if (pairs.length < PAIRS_KEPT) pairs.push(`${a.name} | ${b.name}`);
      }
    }
  }

  // Free words over a drawing: read from the pixels. A label set against a part of the drawing may stand on it; a caption may not.
  if (input.inkUnder !== undefined) {
    const free = new Set(schedule.elements.filter((element) => element.kind === 'text' && element.parent === null && !labelling.has(element.id) && element.style.at === null).map((element) => element.id));
    const seen = new Set<string>(pairs.flatMap((pair) => pair.split(' | ')));
    for (const text of input.texts) {
      if (!free.has(text.id) || seen.has(text.key)) continue;
      if (input.inkUnder(text.box) > INK) {
        overlaps += 1;
        if (pairs.length < PAIRS_KEPT) pairs.push(`${text.key} | drawing`);
      }
    }
  }

  // A connector is its drawn route.
  let through = 0;
  let crossed = 0;
  let unrouted = 0;
  for (const link of live) {
    if (link.kind !== 'link') continue;
    const figure = figureOf.get(link.key);
    if (figure === null || figure === undefined || figure.kind !== 'link') continue;
    const route = link.route;
    if (route === undefined || route.length < 2) {
      unrouted += 1;
      continue;
    }
    const ends = new Set([figure.from, figure.to]);
    const from = live.find((box) => box.key === figure.from);
    let hitNode = false;
    for (const other of live) {
      if (ends.has(other.key)) continue;
      if (other.kind === 'node' && other.parent === (from?.parent ?? null) && routeThrough(route, other.box, NODE_SHRINK)) hitNode = true;
      else if (other.kind === 'text' && routeThrough(route, other.box, LABEL_SHRINK)) {
        crossed += 1;
        if (pairs.length < PAIRS_KEPT) pairs.push(`${link.id} crosses ${other.id}`);
      }
    }
    if (hitNode) through += 1;
  }

  // Nothing stands outside the screen, or outside the room the plan gave it.
  let outside = 0;
  let outsideRoom = 0;
  const plan = composed?.plan ?? null;
  for (const item of items) {
    if (inside(item.box, screen, EDGE)) continue;
    outside += 1;
    if (pairs.length < PAIRS_KEPT) pairs.push(`${item.name} outside the screen ${JSON.stringify(item.box)} in ${JSON.stringify(screen)}`);
  }
  if (plan !== null) {
    for (const box of live) {
      if (!holdsWords(box.kind) && !structureKeys.has(box.key)) continue;
      const room = plan.rooms.find((candidate) => candidate.key === box.key);
      if (room !== undefined && !inside(box.box, room.box, ROOM)) outsideRoom += 1;
    }
    for (const control of composed?.controls ?? []) {
      const room = plan.rooms.find((candidate) => candidate.key === control.id) ?? null;
      const within = (room !== null && inside(control.box, room.box, ROOM)) || (plan.foot !== null && inside(control.box, plan.foot, ROOM));
      if (!within) outsideRoom += 1;
    }
  }

  const notes: Partial<Record<SightNote, number>> = {};
  for (const item of sight.items) for (const note of item.notes) if (item.resting) notes[note] = (notes[note] ?? 0) + 1;
  return {
    textOverlaps: overlaps,
    crossedLabels: crossed,
    linksThroughNodes: through,
    clipped: NOTE_COUNT(sight, 'clipped'),
    notes,
    outside,
    outsideRoom,
    planned: plan !== null,
    pairs,
    ...(input.look === null ? {} : { look: input.look }),
    screen: input.screenName,
    unrouted,
  };
}
