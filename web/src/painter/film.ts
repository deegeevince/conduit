// A recording laid out as a film: the same engine the live painter uses, with
// no clock, no renderer and no server. See contracts/film.ts.

import { DEFAULT_TUNE_VOICE, cachedTune, serializeLine, TurnScore, tuneRowsOf } from '@conduit/language';
import type { Film, FilmOptions, FilmTune, Recording } from '../contracts/film';
import { noteArrivals } from './arrivals';
import { pinnedWallTime } from './clock';
import type { Painting } from './figures';
import { CHARTS_READY } from '../render/chart';
import { controlSpecOf, createRuntime } from './bound';
import { createControlStore } from './controls';
import type { ChartData } from './charts';
import { holdControl } from '@conduit/language';
import { buildTimeline, settledEnd } from './timeline';
import { tuneStartOf } from './structures';

/**
 * Builds the schedule from the recording's lines, each pushed at the playhead it arrived at (0 for a recording that has none), as a turn
 * opened the way the recording says it was (the live painter's own `TurnScore`), builds the timeline for the given viewport, and answers
 * `frameAt` from it. `duration` is the settled end of the turn, as the live painter computes it, or the end of its last tune if later.
 * Nothing here touches the DOM, so a film can be made for a viewport that is not on screen.
 */
export function createFilm(recording: Recording, options: FilmOptions): Film {
  const score = new TurnScore(recording.base, recording.opened ?? 'none');
  const arrivals = new Map<string, number>();
  for (const { seq, line, floor } of recording.lines) {
    const result = score.push(line, seq, floor ?? 0);
    // What the live painter noted as each line arrived: structures lay out in the epochs the viewer saw, not in one.
    noteArrivals(arrivals, result.schedule, Math.max(0, floor ?? 0));
  }
  const schedule = score.schedule;
  // In a film a painting that came grows over its sketch from the moment its picture appears, as it would for someone who had been watching.
  const paintings = new Map<string, Painting>();
  for (const element of schedule.elements) {
    const url = recording.paintings[element.key];
    if (element.figure?.kind === 'picture') {
      paintings.set(element.key, url === undefined ? { status: 'unpainted', url: null, since: 0 } : { status: 'ready', url, since: element.enter?.start ?? 0, ...(recording.aspects?.[element.key] === undefined ? {} : { aspect: recording.aspects[element.key] }) });
    }
  }
  // What the hand held, and the data that came: a film is a pure function of these as of everything else.
  const store = createControlStore();
  for (const element of schedule.elements) {
    const spec = controlSpecOf(element);
    if (spec === null) continue;
    store.declare(element.key, element.id, spec);
    const held = holdControl(spec, options.controls?.[element.id]);
    if (held !== null) store.set(element.key, held);
  }
  const data = new Map<string, ChartData>();
  for (const [id, table] of Object.entries(options.data ?? {})) data.set(id, { table, since: -10 });
  const timeline = buildTimeline(schedule, recording.base, { viewport: options.viewport, reducedMotion: options.reducedMotion, lockLook: null, paintings, arrivals, controls: createRuntime(store), charts: { kinds: CHARTS_READY, data }, ...(options.apps === true ? { apps: true } : {}) });
  const settled = settledEnd(timeline, null, recording.base.scene.mood);
  // The music of the film: each tune of this turn sounds from where the picture's roll starts keeping time with it, until it ends or leaves.
  const tunes: FilmTune[] = [];
  for (const element of schedule.elements) {
    const figure = element.figure;
    const at = tuneStartOf(element);
    if (element.carried || at === null || figure === null || figure.kind !== 'structure') continue;
    const model = cachedTune(tuneRowsOf(figure.rows), { tempo: figure.tempo ?? null, title: element.text === '' ? null : element.text });
    if (model.notes.length === 0) continue;
    tunes.push({ key: element.key, voice: figure.voice ?? DEFAULT_TUNE_VOICE, model, at, until: element.exit === null ? Number.POSITIVE_INFINITY : element.exit.end });
  }
  const duration = tunes.reduce((end, tune) => Math.max(end, Math.min(tune.at + tune.model.seconds + 0.4, tune.until)), settled);
  const script = recording.lines.map((entry) => serializeLine(entry.line)).join('\n');
  return {
    duration,
    viewport: options.viewport,
    ...(tunes.length === 0 ? {} : { tunes: tunes.map((tune) => ({ ...tune, until: Math.min(tune.until, duration) })) }),
    frameAt: (seconds) => {
      const time = Math.max(0, seconds);
      return timeline.frameAt({ time, ambient: time, wallTime: pinnedWallTime(time), clock: 'paused' });
    },
    script: () => script,
  };
}
