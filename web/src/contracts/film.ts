// A turn that can be performed again, anywhere, at any size, frame by frame.
// It exists because the timeline is a pure function of time: nothing about a
// performance lives anywhere except its lines and the stage it started from.
// The exporter, the review page of the exploration harness and "play a
// script" are all built on this and on nothing else.

import type { ControlValue, ControlValues, DataTable, Line, StageBase, TuneModel, TuneVoice } from '@conduit/language';
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
  readonly opened?: 'prompt' | 'tap' | 'act' | 'refine' | 'repair' | 'demo' | 'script' | 'none';
  /** what the viewer did to open it, in a few words, for a title card: their prompt, `Tapped "60"`, `Played the demo overture`. Absent: not known. */
  readonly asked?: string;
  /** the words the viewer typed and sent, whole, when the turn was opened by a prompt: a film types them into the input box. Absent: none. */
  readonly typed?: string;
  /** the choice or control the viewer touched to open the turn (`TurnInput` `tap` or `act`): its element id and its words, so a film can ripple where it was. Absent: not a touch. */
  readonly touched?: { readonly id: string; readonly text: string };
  /** what the viewer's controls held when the turn began (an `act` carries them): the film shows them from the turn's first moment, and every other turn as written. Absent: as written. */
  readonly controls?: ControlValues;
  /** real seconds from the turn being sent to its first line arriving: the thinking, which a film may hold or cut. Absent: not known (0). */
  readonly waited?: number;
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
  /**
   * The stretches of the film in which something new is drawn or typed or played, in order, in seconds. What lies between them is a wait
   * (the model thinking, a held answer) that an export may cut short. Absent: not known, so nothing is cut.
   */
  readonly activity?: readonly (readonly [number, number])[];
  /** what each control on stage holds at `seconds`, by id: the surest way to know a film begins with every control at its written value */
  controlsAt?(seconds: number): readonly { readonly id: string; readonly value: ControlValue | null }[];
  /**
   * Where the painter has the element `id` on the stage at `seconds` (the stage's own pixels), or null when it is not there. What a film that follows
   * what is drawn looks at.
   */
  boxOf?(id: string, seconds: number): Box | null;
  /**
   * The framing of the stage at `seconds`, when the film follows what is being drawn: the whole stage (`zoom` 1, the middle) between lines and at rest,
   * eased toward the element being drawn while a line is performed. Absent: the whole stage always.
   */
  framing?(seconds: number): Framing;
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

/** How much of the stage the picture shows: `zoom` times in, centred on (`x`, `y`) as fractions of the stage. */
export interface Framing {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

/** What a film is laid in besides its stage. Sizes are in the picture's own pixels (the size asked of the exporter); `draw` is given a context already scaled to them. */
export interface Surround {
  readonly width: number;
  readonly height: number;
  readonly stage: Box;
  draw(context: SurroundPen, seconds: number): void;
  /** Drawn over the stage (a tap's ripple, a marker for a cut wait), after the stage is laid in. Absent: nothing. */
  overlay?(context: SurroundPen, seconds: number): void;
  /** What `draw` and `overlay` put in the picture at `seconds`, as data: the same layout they read, so it can be checked without pixels. */
  describe?(seconds: number): SurroundScene;
}

/** What a surround shows at one moment. Boxes are in the picture's own pixels. */
export interface SurroundScene {
  /** the window the language panel's rows show through */
  readonly panel: Box;
  /** the rows of the panel that are in the picture at all (not scrolled out of the window), top to bottom */
  readonly rows: readonly { readonly text: string; readonly top: number; readonly bottom: number; readonly lit: boolean; /** the width of its widest visual row in picture pixels, and how many visual rows it has */ readonly width: number; readonly lines: number }[];
  /** the lit row's extent (picture y), or null when no line is being drawn */
  readonly lit: { readonly top: number; readonly bottom: number } | null;
  /** the input box along the bottom */
  readonly input: { readonly box: Box; readonly text: string; readonly sending: boolean };
  /** a tap ripple over the stage: where (stage-relative fraction 0..1 of the stage box) and how far it has spread 0..1; null: none */
  readonly ripple: { readonly x: number; readonly y: number; readonly spread: number } | null;
  /** the cut marker, in words (`⏩ 20 s`), or null */
  readonly marker: string | null;
}

/** The part of a 2D canvas context a surround is drawn with (the contracts see no DOM; a `CanvasRenderingContext2D` is one). */
export interface SurroundPen {
  fillStyle: string | CanvasGradientLike;
  strokeStyle: string | CanvasGradientLike;
  lineWidth: number;
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
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
  measureText(text: string): { readonly width: number };
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, from: number, to: number): void;
  roundRect(x: number, y: number, width: number, height: number, radius: number): void;
  fill(): void;
  stroke(): void;
}

type CanvasGradientLike = object;
