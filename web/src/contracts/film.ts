// A turn that can be performed again, anywhere, at any size, frame by frame.
// It exists because the timeline is a pure function of time: nothing about a
// performance lives anywhere except its lines and the stage it started from.
// The exporter, the review page of the exploration harness and "play a
// script" are all built on this and on nothing else.

import type { ControlValues, DataTable, Line, StageBase } from '@conduit/language';
import type { Frame } from './frame';
import type { Viewport } from './space';

/** Everything a turn was, as data. Safe to keep, to save, to send. */
export interface Recording {
  readonly turn: string;
  /** the stage the turn started from */
  readonly base: StageBase;
  /** its lines in arrival order, already normalised (every id explicit), with the session `seq` each was scheduled under */
  readonly lines: readonly { readonly seq: number; readonly line: Line }[];
  /** paintings that had arrived when the recording was taken, by element key: same-origin URLs */
  readonly paintings: Readonly<Record<string, string>>;
}

export interface FilmOptions {
  readonly viewport: Viewport;
  /** null: as the recording was first played */
  readonly reducedMotion: boolean;
  /**
   * How lines arrive. `at-once`: the whole score is known from time zero,
   * which is how a finished answer deserves to be seen and what an export
   * uses. Holds a slow brain caused are not reproduced.
   */
  readonly arrival: 'at-once';
  /** what the user's hand held, by control id: a film of an explorable shows the picture as they left it. Absent: every control shows what was written. */
  readonly controls?: ControlValues;
  /** the rows of DATA that charts drew by reference, by id; null: it could not be had. Absent: such charts are waiting. */
  readonly data?: Readonly<Record<string, DataTable | null>>;
}

/**
 * A recording laid out for one viewport. It has no clock: `frameAt` is a pure
 * function, so frame 1200 can be drawn before frame 3, or twice, and is the
 * same picture each time. Ambient time is taken to be the same as time, so
 * weather and loops are as deterministic as everything else.
 */
export interface Film {
  /** seconds: when everything scheduled has finished and come to rest */
  readonly duration: number;
  readonly viewport: Viewport;
  frameAt(seconds: number): Frame;
  /** the canonical text of the recording's lines, one per line: the source of this film */
  script(): string;
}
