// Quality bar, row 13: on a follow-up that keeps the scene, what the stage carried from the turn before must not re-enter or move at time zero.
// Compared as the painter draws them: the first frame of the new turn against the resting frame of the stage it began from.

import type { StageBase } from '@conduit/language';
import { TurnScore } from '@conduit/language';
import type { Frame } from '../contracts/frame';
import { pinnedWallTime } from '../painter/clock';
import { buildTimeline } from '../painter/timeline';
import type { Timeline, TimelineContext } from '../painter/timeline';

/** Every number inside a value, in order: enough to say whether two affine transforms are the same. */
function numbersOf(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersOf);
  return [];
}

/** What each thing in a frame is, as numbers: where it is and how visible. */
function stateOf(frame: Frame): Map<string, readonly number[]> {
  const out = new Map<string, readonly number[]>();
  for (const element of frame.elements) out.set(element.key, [element.x, element.y, element.opacity]);
  for (const figure of frame.figures) if (figure.kind === 'shape') out.set(figure.key, [...numbersOf(figure.transform), figure.opacity]);
  return out;
}

const TOLERANCE = 0.75;

/** The elements both the resting stage and the new turn's first frame hold, and how many of them differ by more than a pixel or a few per cent of opacity. */
export function carriedOf(timeline: Timeline, base: StageBase, context: TimelineContext): { readonly kept: number; readonly moved: number } {
  const was = buildTimeline(new TurnScore(base).schedule, base, context).frameAt({ time: 0, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' });
  const is = timeline.frameAt({ time: 0, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' });
  const before = stateOf(was);
  const after = stateOf(is);
  let kept = 0;
  let moved = 0;
  for (const [key, state] of before) {
    const next = after.get(key);
    if (next === undefined) continue;
    kept += 1;
    if (state.length !== next.length || state.some((value, at) => Math.abs(value - (next[at] ?? 0)) > (at === state.length - 1 ? 0.05 : TOLERANCE))) moved += 1;
  }
  return { kept, moved };
}
