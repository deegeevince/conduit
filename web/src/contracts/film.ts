// A turn that can be performed again, anywhere, at any size, frame by frame.
// It exists because the timeline is a pure function of time: nothing about a
// performance lives anywhere except its lines and the stage it started from.
// The exporter, the review page of the exploration harness and "play a
// script" are all built on this and on nothing else.

import type { ControlValues, DataTable, Line, StageBase, TuneModel, TuneVoice } from '@conduit/language';
import type { Frame } from './frame';
import type { Box, Viewport } from './space';

/** Everything a turn was, as data. Safe to keep, to save, to send. */
export interface Recording {
  readonly turn: string;
  /** the stage the turn started from */
  readonly base: StageBase;
  /**
   * its lines in arrival order, already normalised (every id explicit), with the session `seq` each was scheduled under and, when the
   * recording is of a turn the painter played, `floor`: the playhead the line arrived at, as the painter was told it. A film that has
   * the floors is laid out in the same epochs the viewer saw; one that has none (an exploration card, a gallery) has everything arrive at 0.
   */
  readonly lines: readonly { readonly seq: number; readonly line: Line; readonly floor?: number }[];
  /**
   * How the turn was opened (`TurnInput.kind`): it decides whether the choices still on stage when the answer began leave with its first
   * line, so a film must be built with it or it keeps what the live answer retired. Absent: `none`, as before.
   */
  readonly opened?: 'prompt' | 'tap' | 'act' | 'refine' | 'demo' | 'script' | 'none';
  /** what the viewer did to open it, in a few words, for a title card: their prompt, `Tapped "60"`, `Played the demo overture`. Absent: not known. */
  readonly asked?: string;
  /** paintings that had arrived when the recording was taken, by element key: same-origin URLs */
  readonly paintings: Readonly<Record<string, string>>;
  /** the width over the height of each photo the user gave that is among `paintings`, by element key, so that a film fits it whole as the screen did; absent: none */
  readonly aspects?: Readonly<Record<string, number>>;
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
  /** this stage runs live apps: the film's frames name each app (`Frame.apps`), so an exporter that has the host's pictures of them can lay each where it rests. Absent: an app is only its placeholder. */
  readonly apps?: boolean;
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
  /**
   * Moments the exporter must look at when it surveys the film for the looks and paintings it will need, besides the evenly spaced ones it
   * takes: the start and the rest of each part of a film that is made of several. Absent: none.
   */
  readonly landmarks?: readonly number[];
  /** The music of the film, as the tunes the film's pictures keep time with, for the sound track. Absent: none. */
  readonly tunes?: readonly FilmTune[];
  readonly viewport: Viewport;
  /**
   * The picture is more than the stage (the language pane beside or above it): the whole picture's size, where the stage goes in it, and a
   * way to draw everything but the stage at `seconds`, a pure function of time like `frameAt`. `viewport` is then the stage's size, and the
   * exporter makes the whole picture at the size of its request. Absent: the stage is the whole picture.
   */
  readonly surround?: Surround;
  frameAt(seconds: number): Frame;
  /** the canonical text of the recording's lines, one per line: the source of this film */
  script(): string;
}

/** One tune that sounds in a film: when its first note is, in the film's own seconds, and until when it may ring (it left the stage, or it ended). */
export interface FilmTune {
  readonly key: string;
  readonly voice: TuneVoice;
  readonly model: TuneModel;
  readonly at: number;
  /** film seconds after which it is faded out: the film's end or the moment its picture left the stage */
  readonly until: number;
}

/** What a film is laid in besides its stage. Sizes are in the picture's own pixels (the size asked of the exporter); `draw` is given a context already scaled to them. */
export interface Surround {
  readonly width: number;
  readonly height: number;
  readonly stage: Box;
  draw(context: SurroundPen, seconds: number): void;
}

/** The part of a 2D canvas context a surround is drawn with (the contracts see no DOM; a `CanvasRenderingContext2D` is one). */
export interface SurroundPen {
  fillStyle: string | CanvasGradientLike;
  font: string;
  globalAlpha: number;
  textBaseline: 'alphabetic' | 'top' | 'middle' | 'bottom' | 'hanging' | 'ideographic';
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  clip(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
}

type CanvasGradientLike = object;
