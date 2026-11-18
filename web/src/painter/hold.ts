// How the drawings on stage rest when a turn ends, for the next turn to keep them by: the room the stage plan gave each labelled drawing (a `figure`) and the way the figure kit set it in
// that room (`FigureHold`, language/src/schedule.ts). The report that closes the turn carries it with the stage, so the page and the server's own engine start the next turn of the scene from
// the same drawing in the same place, and what is round it changing does not move it.

import type { ElementSpan, FigureHold, Schedule } from '@conduit/language';
import { planeScale } from '../contracts/space';
import { figureHoldOf, isFigureBlock } from './figure-stage';
import type { Timeline } from './timeline';

/** The hold of each figure of `schedule` whose key is asked for, as it rests once the turn has come to rest at `playhead`. */
export function heldOf(timeline: Timeline, schedule: Schedule, playhead: number, keys: ReadonlySet<string>): Map<string, FigureHold> {
  const out = new Map<string, FigureHold>();
  const restAt = Math.max(playhead, schedule.end) + 0.5;
  for (const element of schedule.elements as readonly ElementSpan[]) {
    if (!keys.has(element.key) || !isFigureBlock(element)) continue;
    const room = timeline.roomAt(element, restAt);
    if (room === null) continue;
    const hold = figureHoldOf({ structure: element, room, planeScale: planeScale(element.style.layer, timeline.viewport), spec: timeline.specAt(restAt), viewport: timeline.viewport });
    if (hold !== null) out.set(element.key, hold);
  }
  return out;
}
