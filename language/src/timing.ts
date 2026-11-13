// Every duration in Series comes from this file. Durations depend only on the
// text and on words of the language, never on pixels or fonts, so the server
// and the painter compute the same schedule from the same lines.

import { countWords, plainLength } from './text';
import { LIMITS } from './vocabulary';
import type { By, CameraMove, CameraSpeed, EnterEffect, ExitEffect, HitGesture, Pace } from './vocabulary';

export interface PaceTiming {
  /** seconds in one beat: the unit of `wait` */
  readonly beat: number;
  /** seconds per character for typed entrances */
  readonly char: number;
  /** seconds between words for word-by-word entrances */
  readonly word: number;
  /** words per second a reader is given */
  readonly wordsPerSecond: number;
  /** multiplier on every eased duration */
  readonly ease: number;
}

export const PACE_TIMING: Readonly<Record<Pace, PaceTiming>> = {
  slow: { beat: 0.8, char: 0.05, word: 0.3, wordsPerSecond: 2.5, ease: 1.25 },
  steady: { beat: 0.55, char: 0.032, word: 0.2, wordsPerSecond: 3.5, ease: 1 },
  brisk: { beat: 0.38, char: 0.02, word: 0.13, wordsPerSecond: 4.5, ease: 0.8 },
};

/** Seconds for the whole-element part of each entrance, at steady pace. */
export const ENTER_SECONDS: Readonly<Record<EnterEffect, number>> = {
  type: 0,
  fade: 0.6,
  rise: 0.6,
  slam: 0.3,
  wipe: 0.5,
  cut: 0,
  flicker: 0.6,
  // `draw` takes as long as the thing is long (see drawSeconds); this is only its floor.
  draw: 0.25,
  pop: 0.3,
};

// Exits are faster than the entrance of the same name, always.
export const EXIT_SECONDS: Readonly<Record<ExitEffect, number>> = {
  fade: 0.35,
  cut: 0,
  fall: 0.35,
  wipe: 0.3,
};

export const HIT_SECONDS: Readonly<Record<HitGesture, number>> = {
  pulse: 0.6,
  flash: 0.35,
  shake: 0.45,
};

export const CAMERA_SECONDS: Readonly<Record<CameraSpeed, number>> = {
  slow: 6,
  steady: 3,
  fast: 1.2,
};

/** Seconds for `move`, and for `set` when it is given a speed word. */
export const MOVE_SECONDS: Readonly<Record<CameraSpeed, number>> = {
  slow: 4,
  steady: 1.6,
  fast: 0.6,
};

/** Canvas units a drawn stroke covers per second. */
export const DRAW_SPEED: Readonly<Record<Pace, number>> = { slow: 70, steady: 120, brisk: 200 };
/** Seconds each row of a sprite takes to land. */
export const ROW_SECONDS: Readonly<Record<Pace, number>> = { slow: 0.07, steady: 0.045, brisk: 0.03 };
export const MIN_DRAW_SECONDS = 0.25;
export const MAX_SPRITE_SECONDS = 2.5;
/** Share of a drawn element's entrance the pen waits for: strokes overlap like a quick hand. */
export const DRAW_HOLD = 0.5;
/** A shape declared again under a live id changes into the new one over this long, times the pace's ease. */
export const MORPH_SECONDS = 0.8;
/** Atmosphere fades in and out over this long. */
export const AMBIENT_SECONDS = 1.2;
/** In `layout=page` the reader is reading, not listening: this many times faster than the pace's spoken rate. */
export const PAGE_READ_FACTOR = 1.6;
export const PAGE_MIN_TAIL = 0.3;

export const CAMERA_SHAKE_SECONDS = 0.45;
export const SET_SECONDS = 0.5;
export const STRIKE_SECONDS = 0.3;
export const LOOK_CHANGE_SECONDS = 0.6;
export const MIN_TYPED_SECONDS = 0.2;
export const MAX_READ_SECONDS = 6;
/** The longest quiet after a paragraph of page prose: a full 320-character paragraph at the brisk pace is read in this. */
export const MAX_PAGE_READ_SECONDS = 12;
/** Share of a scene's exit that the next scene waits for before starting. */
export const SCENE_OVERLAP = 0.8;
/** Share of the outgoing line's exit that a `solo` line waits for. */
export const SOLO_OVERLAP = 0.6;
/** Share of reading that happens while a progressive entrance is still running. */
export const READ_ALONG = 0.6;

export function beatSeconds(pace: Pace): number {
  return PACE_TIMING[pace].beat;
}

export function enterSeconds(effect: EnterEffect, by: By, text: string, pace: Pace, exact: number | null): number {
  if (exact !== null) return Math.min(exact, LIMITS.enter);
  const timing = PACE_TIMING[pace];
  if (effect === 'cut' && by === 'all') return 0;
  const base = ENTER_SECONDS[effect] * timing.ease;
  if (effect === 'type' || by === 'char') {
    const typed = Math.max(MIN_TYPED_SECONDS, plainLength(text) * timing.char);
    return Math.min(LIMITS.enter, base * 0.5 + typed);
  }
  if (by === 'word') return Math.min(LIMITS.enter, base + Math.max(0, countWords(text) - 1) * timing.word);
  return base;
}

/** How long a stroke of `length` canvas units takes to draw itself. */
export function drawSeconds(length: number, pace: Pace, exact: number | null): number {
  if (exact !== null) return Math.min(exact, LIMITS.enter);
  return Math.min(LIMITS.enter, Math.max(MIN_DRAW_SECONDS, length / DRAW_SPEED[pace]));
}

/** How long a sprite of `rows` rows takes to land, row by row. */
export function spriteSeconds(rows: number, pace: Pace, exact: number | null): number {
  if (exact !== null) return Math.min(exact, LIMITS.enter);
  return Math.min(MAX_SPRITE_SECONDS, Math.max(MIN_DRAW_SECONDS, rows * ROW_SECONDS[pace]));
}

/** The entrance of anything that is not text and does not draw itself: a fade, a pop, a cut. */
export function figureEnterSeconds(effect: EnterEffect, pace: Pace, exact: number | null): number {
  if (exact !== null) return Math.min(exact, LIMITS.enter);
  if (effect === 'cut') return 0;
  return ENTER_SECONDS[effect === 'type' ? 'wipe' : effect] * PACE_TIMING[pace].ease;
}

export function moveSeconds(speed: CameraSpeed | undefined, exact: number | undefined, fallback: number): number {
  if (exact !== undefined) return exact;
  return speed === undefined ? fallback : MOVE_SECONDS[speed];
}

/** The quiet after a paragraph of `layout=page` prose before the next one arrives. */
export function pageTailSeconds(text: string, pace: Pace): number {
  const timing = PACE_TIMING[pace];
  return Math.min(MAX_PAGE_READ_SECONDS, Math.max(PAGE_MIN_TAIL, countWords(text) / (timing.wordsPerSecond * PAGE_READ_FACTOR)));
}

export function exitSeconds(effect: ExitEffect, pace: Pace): number {
  return EXIT_SECONDS[effect] * PACE_TIMING[pace].ease;
}

export function readSeconds(text: string, pace: Pace): number {
  const timing = PACE_TIMING[pace];
  return Math.min(MAX_READ_SECONDS, Math.max(timing.beat, countWords(text) / timing.wordsPerSecond));
}

/**
 * The quiet after an entrance before the pen moves on. A line that arrived
 * progressively was partly read while it arrived, so it needs less.
 */
export function tailSeconds(enter: number, by: By, text: string, pace: Pace): number {
  const read = readSeconds(text, pace);
  const beat = PACE_TIMING[pace].beat;
  if (by === 'all') return read;
  return Math.max(beat * 0.5, read - enter * READ_ALONG);
}

export function cameraSeconds(move: CameraMove, speed: CameraSpeed, exact: number | undefined): number {
  if (exact !== undefined) return exact;
  if (move === 'shake') return CAMERA_SHAKE_SECONDS;
  return CAMERA_SECONDS[speed];
}

export function waitSeconds(beats: number | undefined, seconds: number | undefined, pace: Pace): number {
  if (seconds !== undefined) return Math.min(seconds, LIMITS.wait);
  return Math.min((beats ?? 1) * PACE_TIMING[pace].beat, LIMITS.wait);
}

/**
 * How far ahead of the playhead a brain should try to keep the pen, in
 * seconds. Below `low` the stage is about to run dry; above `high` the brain
 * is committing to a future the user may interrupt.
 */
export interface LeadWindow {
  readonly low: number;
  readonly high: number;
}

export const LEAD_WINDOW: LeadWindow = { low: 2, high: 12 };
