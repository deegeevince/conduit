// Following what is being drawn: while a line is performed the film's framing eases toward the element it draws, and between lines and at rest it eases back to the
// whole stage. A pure function of time and of the painter's own element boxes at that time, so a film is the same wherever and however fast it is made.
//
//   panning   the view stays inside the stage (no blank margin); an element near an edge is off the middle of the view but in it
//   zoom      1 (the whole stage) to 1.6, chosen so the element takes up about half the view, never more than the stage and never less than the whole of it
//   easing    cubic-bezier(0.16, 1, 0.3, 1) over half a second
//   holding   a framing stays at least 1.2 s; lines that begin within 0.8 s of each other (or inside that hold) share one framing, the union of their elements

import type { Framing } from '../contracts/film';
import type { Box } from '../contracts/space';

export const FRAMING = { zoomMax: 1.6, ease: 0.5, hold: 1.2, together: 0.8, fill: 0.5 } as const;

/** a line being drawn that has an element to look at: its id, and when it is drawn on the film's clock */
export interface Shot {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

const FULL: Framing = { zoom: 1, x: 0.5, y: 0.5 };

/** cubic-bezier(0.16, 1, 0.3, 1): progress 0..1 in, eased progress out */
export function easeOut(progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const [x1, y1, x2, y2] = [0.16, 1, 0.3, 1];
  const at = (t: number, a: number, b: number): number => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let t = p;
  for (let i = 0; i < 8; i += 1) {
    const x = at(t, x1, x2) - p;
    const slope = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(x) < 1e-6 || Math.abs(slope) < 1e-6) break;
    t -= x / slope;
  }
  t = Math.max(0, Math.min(1, t));
  return at(t, y1, y2);
}

interface Group {
  readonly start: number;
  readonly end: number;
  readonly ids: readonly string[];
}

/** The shots joined into framings: each lasts until its lines are done and at least `hold` seconds. */
export function groupShots(shots: readonly Shot[]): Group[] {
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  const groups: { start: number; end: number; last: number; ids: string[] }[] = [];
  for (const shot of sorted) {
    const group = groups[groups.length - 1];
    if (group !== undefined && (shot.start - group.last < FRAMING.together || shot.start < group.start + FRAMING.hold)) {
      group.last = Math.max(group.last, shot.start);
      group.end = Math.max(group.end, shot.end);
      if (!group.ids.includes(shot.id)) group.ids.push(shot.id);
    } else groups.push({ start: shot.start, end: shot.end, last: shot.start, ids: [shot.id] });
  }
  return groups.map((group) => ({ start: group.start, end: Math.max(group.end, group.start + FRAMING.hold), ids: group.ids }));
}

/** Where the framing is at `t` (the whole stage when nothing is being drawn): `boxOf` is the painter's box of an element on the stage at a moment, in the stage's own pixels. */
export function framingOf(shots: readonly Shot[], boxOf: (id: string, seconds: number) => Box | null, stage: { readonly width: number; readonly height: number }): (seconds: number) => Framing {
  const groups = groupShots(shots);
  if (groups.length === 0) return () => FULL;
  interface Move {
    readonly at: number;
    readonly group: Group | null;
  }
  const moves: Move[] = [];
  groups.forEach((group, index) => {
    moves.push({ at: group.start, group });
    const next = groups[index + 1];
    if (next === undefined || group.end < next.start) moves.push({ at: group.end, group: null });
  });
  const focusOf = (group: Group, seconds: number): Framing => {
    const at = Math.max(group.start, Math.min(group.end, seconds));
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const id of group.ids) {
      const box = boxOf(id, at);
      if (box === null || box.width <= 0 || box.height <= 0) continue;
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }
    if (right < left) return FULL;
    const zoom = Math.max(1, Math.min(FRAMING.zoomMax, FRAMING.fill * Math.min(stage.width / (right - left), stage.height / (bottom - top))));
    // the view never leaves the stage: near an edge the element sits off the middle of the view, still inside it
    const centre = (at: number): number => Math.max(0.5 / zoom, Math.min(1 - 0.5 / zoom, at));
    return { zoom, x: centre((left + right) / 2 / stage.width), y: centre((top + bottom) / 2 / stage.height) };
  };
  const mix = (a: Framing, b: Framing, p: number): Framing => ({ zoom: a.zoom + (b.zoom - a.zoom) * p, x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p });
  const targetOf = (move: Move, seconds: number): Framing => (move.group === null ? FULL : focusOf(move.group, seconds));
  const starts: Framing[] = [];
  const startOf = (index: number): Framing => {
    if (index === 0) return FULL;
    let found = starts[index];
    if (found === undefined) {
      const previous = moves[index - 1] as Move;
      const move = moves[index] as Move;
      found = mix(startOf(index - 1), targetOf(previous, move.at), easeOut((move.at - previous.at) / FRAMING.ease));
      starts[index] = found;
    }
    return found;
  };
  return (seconds) => {
    let index = -1;
    for (let i = 0; i < moves.length; i += 1) {
      if ((moves[i] as Move).at <= seconds) index = i;
      else break;
    }
    if (index < 0) return FULL;
    const move = moves[index] as Move;
    return mix(startOf(index), targetOf(move, seconds), easeOut((seconds - move.at) / FRAMING.ease));
  };
}
