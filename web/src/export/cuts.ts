// Long waits in a film: a stretch where nothing new is drawn, typed or played is cut to a moment, with a quiet "⏩ 20 s" marker saying how much
// real time went. The cuts are also written as data (`CutList`) so the editor can cut another recording of the same session by the same amounts.

import type { Cut, CutList } from '../contracts/export';
import type { Film, Surround, SurroundPen, SurroundScene } from '../contracts/film';

/** Where the cuts are made by default: a quiet stretch longer than this many seconds is cut, and what is left of it, in seconds. */
export const CUTS = { threshold: 4, keep: 1.2 } as const;

/** The quiet stretches of `activity` (the spans where something happens) that are longer than `threshold`, each as the cut that leaves `keep` seconds of it. */
export function cutsOf(activity: readonly (readonly [number, number])[], duration: number, threshold: number, keep: number): Cut[] {
  const cuts: Cut[] = [];
  let at = 0;
  const quiet = (from: number, to: number): void => {
    if (to - from > threshold && to - from > keep) cuts.push({ from: round(from + keep), to: round(to), removed: round(to - from - keep) });
  };
  for (const [from, to] of activity) {
    quiet(at, from);
    at = Math.max(at, to);
  }
  quiet(at, duration);
  return cuts;
}

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** The marker's words: the real seconds taken out, rounded. */
export const markerText = (removed: number): string => `⏩ ${Math.max(1, Math.round(removed))} s`;

/** `film` with its cuts taken out: its own seconds run on without them, `real(seconds)` gives where a moment of it was in real time. */
export interface Cutting {
  readonly film: Film;
  readonly list: CutList;
  /** real time for a moment of the cut film, and the other way round (a moment inside a cut is at the cut's start) */
  readonly real: (seconds: number) => number;
  readonly cut: (real: number) => number;
}

export function cutFilm(film: Film, cuts: readonly Cut[], settings: { readonly threshold: number; readonly keep: number }): Cutting {
  const removedBefore = (real: number): number => {
    let sum = 0;
    for (const cut of cuts) {
      if (real >= cut.to) sum += cut.removed;
      else if (real > cut.from) sum += real - cut.from;
    }
    return sum;
  };
  const cutTime = (real: number): number => real - removedBefore(real);
  const realTime = (seconds: number): number => {
    let real = seconds;
    for (const cut of cuts) {
      if (real >= cut.from) real += cut.removed;
      else break;
    }
    return real;
  };
  const total = removedBefore(film.duration);
  const duration = film.duration - total;
  const markerAt = (seconds: number): string | null => {
    // the marker is on for the whole of what is left of a cut: from the cut's start on the film's own clock to where the film goes on
    for (const cut of cuts) {
      const start = cutTime(cut.from);
      if (seconds >= start - settings.keep && seconds < start) return markerText(cut.removed);
    }
    return null;
  };
  const surround: Surround | undefined =
    film.surround === undefined
      ? undefined
      : {
          ...film.surround,
          draw: (context, seconds) => film.surround?.draw(context, realTime(seconds)),
          overlay: (context: SurroundPen, seconds: number) => {
            film.surround?.overlay?.(context, realTime(seconds));
            const marker = markerAt(seconds);
            if (marker !== null && film.surround !== undefined) drawMarker(context, film.surround, marker);
          },
          describe: (seconds): SurroundScene => {
            const scene = film.surround?.describe?.(realTime(seconds));
            if (scene === undefined) throw new Error('This film has no scene to describe.');
            return { ...scene, marker: markerAt(seconds) };
          },
        };
  const frameOf = (seconds: number): number => realTime(Math.max(0, seconds));
  const cut: Film = {
    ...film,
    duration,
    ...(film.landmarks === undefined ? {} : { landmarks: film.landmarks.map(cutTime) }),
    ...(film.tunes === undefined ? {} : { tunes: film.tunes.map((tune) => ({ ...tune, at: cutTime(tune.at), until: cutTime(tune.until) })) }),
    ...(film.activity === undefined ? {} : { activity: film.activity.map(([from, to]) => [cutTime(from), cutTime(to)] as const) }),
    ...(surround === undefined ? {} : { surround }),
    frameAt: (seconds) => film.frameAt(frameOf(seconds)),
    ...(film.framing === undefined ? {} : { framing: (seconds: number) => film.framing?.(frameOf(seconds)) ?? { zoom: 1, x: 0.5, y: 0.5 } }),
    ...(film.boxOf === undefined ? {} : { boxOf: (id: string, seconds: number) => film.boxOf?.(id, frameOf(seconds)) ?? null }),
    ...(film.controlsAt === undefined ? {} : { controlsAt: (seconds: number) => film.controlsAt?.(frameOf(seconds)) ?? [] }),
  };
  return { film: cut, list: { threshold: settings.threshold, keep: settings.keep, realSeconds: round(film.duration), filmSeconds: round(duration), cuts }, real: realTime, cut: cutTime };
}

/** A quiet pill at the foot of the stage: two small triangles and the seconds. */
function drawMarker(context: SurroundPen, surround: Surround, text: string): void {
  const stage = surround.stage;
  const size = Math.max(12, Math.round(Math.min(surround.width, surround.height) / 44));
  context.save();
  context.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  const words = text.replace('⏩ ', '');
  const width = context.measureText(words).width;
  const icon = size * 1.3;
  const total = icon + size * 0.5 + width;
  const height = size * 2.1;
  const x = stage.x + (stage.width - total) / 2 - size;
  const y = stage.y + stage.height - height - size * 1.2;
  context.globalAlpha = 0.72;
  context.fillStyle = '#16181d';
  context.beginPath();
  context.roundRect(x, y, total + size * 2, height, height / 2);
  context.fill();
  context.globalAlpha = 0.95;
  context.fillStyle = '#f2f3f6';
  const cy = y + height / 2;
  const left = x + size;
  for (const shift of [0, icon * 0.5]) {
    context.beginPath();
    context.moveTo(left + shift, cy - size * 0.5);
    context.lineTo(left + shift + icon * 0.5, cy);
    context.lineTo(left + shift, cy + size * 0.5);
    context.closePath();
    context.fill();
  }
  context.fillText(words, left + icon + size * 0.5, cy + size * 0.35);
  context.restore();
}
