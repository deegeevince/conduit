// A recording laid out as a film: the same engine the live painter uses, with
// no clock, no renderer and no server. See contracts/film.ts.

import { serializeLine, TurnScore } from '@conduit/language';
import type { Film, FilmOptions, Recording } from '../contracts/film';
import { pinnedWallTime } from './clock';
import type { Painting } from './figures';
import { buildTimeline, settledEnd } from './timeline';

/**
 * Builds the schedule from the recording's lines (every line pushed at
 * playhead 0), builds the timeline for the given viewport, and answers
 * `frameAt` from it. `duration` is the settled end of the turn, as the live
 * painter computes it. Nothing here touches the DOM, so a film can be made
 * for a viewport that is not on screen.
 */
export function createFilm(recording: Recording, options: FilmOptions): Film {
  const score = new TurnScore(recording.base);
  for (const { seq, line } of recording.lines) score.push(line, seq, 0);
  const schedule = score.schedule;
  // In a film a painting that came grows over its sketch from the moment its picture appears, as it would for someone who had been watching.
  const paintings = new Map<string, Painting>();
  for (const element of schedule.elements) {
    const url = recording.paintings[element.key];
    if (element.figure?.kind === 'picture') {
      paintings.set(element.key, url === undefined ? { status: 'unpainted', url: null, since: 0 } : { status: 'ready', url, since: element.enter?.start ?? 0 });
    }
  }
  const timeline = buildTimeline(schedule, recording.base, { viewport: options.viewport, reducedMotion: options.reducedMotion, lockLook: null, paintings });
  const duration = settledEnd(timeline, null, recording.base.scene.mood);
  const script = recording.lines.map((entry) => serializeLine(entry.line)).join('\n');
  return {
    duration,
    viewport: options.viewport,
    frameAt: (seconds) => {
      const time = Math.max(0, seconds);
      return timeline.frameAt({ time, ambient: time, wallTime: pinnedWallTime(time), clock: 'paused' });
    },
    script: () => script,
  };
}
