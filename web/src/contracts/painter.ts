import type {
  AssetStatus,
  BackEvent,
  ElementKind,
  Services,
  ClockState,
  Issue,
  Layer,
  Layout,
  Line,
  LookId,
  Mood,
  Pace,
  ScreenFacts,
  TurnEndReason,
  TurnInput,
  TurnReport,
} from '@conduit/language';
import type { Recording } from './film';
import type { Quality } from './frame';
import type { Renderer } from './renderer';
import type { Box, Viewport } from './space';

export interface PainterOptions {
  /** already mounted */
  readonly renderer: Renderer;
  readonly viewport: Viewport;
  /** when set, `look` lines are ignored and the stage stays in this look (the gallery) */
  readonly lockLook: LookId | null;
  /** overrides the OS setting; null follows `prefers-reduced-motion` */
  readonly reducedMotion: boolean | null;
  /** the primary pointer, read by the app from the media query; the painter reports it to the brain and reads nothing itself */
  readonly pointer: ScreenFacts['pointer'];
}

/** A picture the painter has made for someone else: the app sends it to the server. */
export type PainterUpload =
  /** the stage as a turn left it, for the brain's next brief */
  | { readonly kind: 'snapshot'; readonly turn: string; readonly blob: Blob }
  /** the sketch a picture element stands on, for the image model */
  | { readonly kind: 'sketch'; readonly key: string; readonly blob: Blob };

export type ElementPhase = 'entering' | 'on' | 'leaving' | 'struck';

/** One element as the test hook and the HUD see it. */
export interface StageElementView {
  readonly key: string;
  readonly id: string;
  readonly kind: ElementKind;
  /** the words, for text; a few words saying what it is, for anything drawn */
  readonly text: string;
  readonly layer: Layer;
  readonly phase: ElementPhase;
  /** where it is on screen now, host CSS pixels */
  readonly box: Box;
  /** font size on screen now, CSS pixels */
  readonly fontPx: number;
  readonly colour: string;
  /** WCAG contrast ratio of `colour` against what is actually behind it: the ground, or its plate when it sits on something drawn. For a drawn thing, against the ground. */
  readonly contrast: number;
  /** a picture element's painting: null for everything else */
  readonly painting: 'waiting' | 'developing' | 'painted' | 'unpainted' | null;
  readonly opacity: number;
  readonly tappable: boolean;
}

export interface LineView {
  readonly seq: number;
  readonly text: string;
  /** scheduled start and end on the turn clock; equal for lines that take no time */
  readonly start: number;
  readonly end: number;
  readonly issues: readonly Issue[];
}

/** Everything observable about the painter at one instant. */
export interface PainterSnapshot {
  /** the turn being played. Null before the first turn, once a turn has fully played, and while an interruption settles: the Stop button follows this. */
  readonly turn: string | null;
  /** `holding` also while the renderer cannot yet draw what the last frame holds (glyphs still being typeset) */
  readonly clock: ClockState;
  /** seconds on the turn clock. This is the painter's real clock, not an estimate. */
  readonly playhead: number;
  readonly pen: number;
  /** when everything scheduled so far will have finished, including the others easing into their new places after the last arrival or departure */
  readonly end: number;
  /** pen minus playhead */
  readonly lead: number;
  /** true while the browser has stopped the frame loop because the tab is hidden */
  readonly hidden: boolean;
  readonly look: LookId;
  readonly lookLocked: boolean;
  readonly scene: {
    readonly id: string;
    readonly layout: Layout;
    readonly mood: Mood;
    readonly pace: Pace;
    readonly expected: number | null;
    /** the fitted canvas on the reading plane, stage units: where canvas (0,0) is on screen and how big a canvas unit is there */
    readonly canvas: { readonly box: Box; readonly unit: number };
  };
  readonly elements: readonly StageElementView[];
  /** the lines of the open turn, oldest first */
  readonly lines: readonly LineView[];
  readonly renderer: string;
  readonly quality: Quality;
  /** frames per second, smoothed */
  readonly fps: number;
  readonly reducedMotion: boolean;
  readonly viewport: Viewport;
  readonly screen: ScreenFacts;
  /** true once the renderer has been unable to draw its text for more than 4 s: playback then goes on regardless (the HUD warns), and only what is drawn is reported shown */
  readonly glyphStall: boolean;
  /** the user has spoken or tapped and no turn has opened for it yet: the stage is already showing that it heard */
  readonly anticipating: boolean;
  /** the user asked to see all of the open turn at once; lines still arriving land settled */
  readonly showingAll: boolean;
  /**
   * Something threw while a frame was being made. The loop kept running and the offending element was left out; this says what and how often
   * (`3x TypeError: ... [circle@4]`). Null when no frame has ever failed.
   */
  readonly fault: string | null;
}

/** Words as they become visible, for the transcript and the live region. */
export type TranscriptEvent =
  | { readonly kind: 'turn'; readonly turn: string; readonly input: TurnInput }
  | { readonly kind: 'shown'; readonly key: string; readonly id: string; readonly text: string; readonly tappable: boolean; readonly replaces: string | null }
  | { readonly kind: 'struck'; readonly key: string }
  | { readonly kind: 'gone'; readonly key: string };

export interface PainterEvents {
  /** everything the server should hear: ready (at creation, and when the viewport or the look changes), started, progress, tap, report */
  readonly back: BackEvent;
  readonly transcript: TranscriptEvent;
  readonly clock: ClockState;
  /** a picture for the server: a snapshot shortly after a turn's report, a sketch shortly after a `paint` line */
  readonly upload: PainterUpload;
}

/**
 * The painter: takes Series lines in, keeps the clock, and decides every
 * pixel-level thing the brain cannot see. It draws through a Renderer and
 * knows nothing about HTTP.
 *
 * Events are never emitted synchronously from inside the call that caused
 * them, so a listener attached straight after `createPainter` still receives
 * the first `ready`.
 */
export interface Painter {
  /**
   * A turn is open; lines will follow. A turn still playing is interrupted
   * first. Opening an id already opened (the one playing, settling or played)
   * does nothing: a replayed `turn` event must not cut an answer off.
   */
  openTurn(turn: string, input: TurnInput): void;

  /**
   * The user has just spoken or tapped; a turn will open. The stage shows it
   * within one frame, before the server has answered: a tapped choice takes a
   * pressed look and the other choices recede, the waiting signal starts
   * where the answer will begin, and the clock reads `waiting`. A turn still
   * playing is interrupted first, exactly as `interrupt()` would.
   * `openTurn` adopts the anticipation; `cancelAnticipation` undoes it when
   * the request fails. While anticipating, `tapAt` and `tapElement` on a
   * choice do nothing: a second tap is not a second message.
   */
  anticipate(input: TurnInput, tappedKey: string | null): void;
  cancelAnticipation(): void;

  /** What the server can do for this conversation, from `hello`. Without `paint` the painter makes no sketch pictures and marks every picture element `unpainted` at once. */
  setServices(services: Services): void;

  /**
   * News of a painting. `ready`: the painter preloads `url` and, once it can
   * be drawn, grows it over the sketch on the ambient clock (the turn clock
   * is not touched, so nothing scheduled moves). `skipped` or `failed`: the
   * sketch stays and the element is `unpainted`. News for an element that has
   * left, or of a turn that is not on stage, is dropped.
   */
  assetArrived(key: string, status: AssetStatus, url: string | null): void;

  /**
   * "Show all now". Settles the open or playing turn to its final state at
   * once: the playhead jumps to the end of everything scheduled, and while
   * the brain is still writing, every further line lands already settled.
   * When the turn ends it is reported `finished`, everything in it counts as
   * shown, and `skippedAt` is where the playhead was. Does nothing when no
   * turn is open or playing.
   */
  showAll(): void;

  /**
   * Everything needed to perform a turn again somewhere else, exactly: the
   * stage it started from and its lines. The last finished or interrupted
   * turn by default. Null before the first turn has ended.
   */
  recording(turn?: string): Recording | null;

  /**
   * Schedules one line of the open turn at the pen and returns any semantic
   * issues with it. The turn clock leaves zero when the first line arrives.
   */
  ingest(turn: string, seq: number, line: Line): readonly Issue[];

  /** The brain has stopped writing. The playhead may now run past the pen to the end. */
  closeTurn(turn: string, reason: TurnEndReason): void;

  /**
   * Stops the turn where the playhead is: the unplayed future is discarded,
   * entrances already in flight are completed, and the stage comes to rest.
   * Returns what was shown, which is also emitted as a `report`. Null when no
   * turn is open or playing.
   */
  interrupt(): TurnReport | null;

  play(): void;
  pause(): void;

  /**
   * Pauses, moves the playhead to `seconds` on the turn clock (clamped to
   * what is scheduled), and draws that frame synchronously. Works on the open
   * turn and on the last finished or interrupted one; with neither it only
   * redraws. The clock then reads `paused`. Ambient time is
   * pinned to the same value, so the same seek always draws the same picture.
   * Reports already sent on the back channel are never retracted.
   */
  seek(seconds: number): void;

  /** Pauses and advances the playhead by `seconds`, drawing one frame. */
  step(seconds: number): void;

  /** A pointer came down at a point in host CSS pixels. Emits `tap` if it hit an element. */
  tapAt(x: number, y: number): void;

  /** The same as tapping the element with this key; for keyboard users of the transcript. */
  tapElement(key: string): void;

  resize(viewport: Viewport): void;
  snapshot(): PainterSnapshot;
  on<K extends keyof PainterEvents>(type: K, listener: (event: PainterEvents[K]) => void): () => void;
  dispose(): void;
}
