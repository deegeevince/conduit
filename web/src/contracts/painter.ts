import type {
  AssetStatus,
  BackEvent,
  ControlKind,
  ControlValue,
  DataTable,
  ElementKind,
  PassState,
  PickForm,
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
import type { AppHost } from './app';
import type { ChartHost, ChartView } from './chart';
import type { Recording } from './film';
import type { Quality } from './frame';
import type { Renderer } from './renderer';
import type { Box, Viewport } from './space';
import type { StagePlanView } from './stage-plan';
import type { TunePlayer } from './tune';
import type { TextSpanView } from './text-layer';

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
  /** where this stage's charts live; absent or null: the stage has none, and the painter advertises none */
  readonly charts?: ChartHost | null;
  /** v2.1. Where this stage's music is made; absent or null: the stage is silent, and a tune on it is drawn and its playhead kept by the painter's own clock */
  readonly tunes?: TunePlayer | null;
  /** v2.3. Where this stage's live apps run; absent or null: the stage has none, and the painter does not offer `app` */
  readonly apps?: AppHost | null;
  /** v2.1. Where a picture the user gave is fetched from, by its id (`pic … from=u1`); null when the id is not this conversation's. Absent: the painter draws no uploads. */
  readonly uploadUrl?: (id: string) => string | null;
}

/** A picture the painter has made for someone else: the app sends it to the server. */
export type PainterUpload =
  /** the stage as a turn left it, for the brain's next brief */
  | { readonly kind: 'snapshot'; readonly turn: string; readonly blob: Blob }
  /** the sketch a picture element stands on, for the image model */
  | { readonly kind: 'sketch'; readonly key: string; readonly blob: Blob }
  /** the stage as pass `pass` of an open turn will leave it, for the brain to look at before the turn ends */
  | { readonly kind: 'draft'; readonly turn: string; readonly pass: number; readonly blob: Blob }
  /** SA4. The stage as it stands, for the brain that asked for a picture with `canvas_look` (a `want` event) */
  | { readonly kind: 'look'; readonly turn: string; readonly request: string; readonly blob: Blob };

/**
 * A control as the app sees it: enough to lay a real, invisible form control
 * over it for the keyboard and for a screen reader, and for the test hook to
 * work it. The painter draws the control; the app never does.
 */
export interface ControlView {
  readonly key: string;
  readonly id: string;
  readonly control: ControlKind;
  /** how a pick shows its options; null for every other control */
  readonly form: PickForm | null;
  /** its label; a pick has none of its own */
  readonly label: string;
  readonly options: readonly string[];
  readonly min: number;
  readonly max: number;
  readonly step: number | null;
  readonly unit: string | null;
  readonly value: ControlValue | null;
  /** its value as words, as `{name}` shows it */
  readonly valueText: string;
  /** where it is on screen now, host CSS pixels; never smaller than 44 px on its shorter side */
  readonly box: Box;
  /** false while it is entering, leaving or covered: it is then drawn but cannot be worked */
  readonly enabled: boolean;
  /** a change the user commits becomes their next message */
  readonly send: boolean;
  /** true when at least one change on stage follows it: the battery checks that a slider drives something */
  readonly bound: boolean;
}

/** A pointer, as the app hands it to the painter. `x`, `y` are host CSS pixels. */
export interface PointerInput {
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly x: number;
  readonly y: number;
  /** the browser's pointer id, so two fingers on two sliders do not fight */
  readonly pointer: number;
}

/** One screen of a mock-up, where it rests on screen now, host CSS pixels. */
export interface UiMockup {
  readonly screen: string;
  /** what a finger works: `part` is what it is drawn as (`field`, `toggle`, `button`...), `action` what working it does */
  readonly hits: readonly { readonly id: string; readonly part: string; readonly action: 'tab' | 'pick' | 'toggle' | 'field' | 'slider' | 'press' | 'scroll'; readonly box: Box;
    /** a press: whether the brain hears it, and the screen it goes to */
    readonly send?: boolean;
    readonly to?: string }[];
  /** one box per line of words, where its ink is; `owner` is the part they belong to */
  readonly words: readonly { readonly owner: string; readonly text: string; readonly box: Box }[];
  /** what the kit's own lint says of the screen (overlap, lost words, words outside...) */
  readonly notes: readonly { readonly kind: string; readonly id: string; readonly message: string }[];
}

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
  /** the controls on stage, in drawing order */
  readonly controls: readonly ControlView[];
  /** the charts on stage, with what their engine says of them */
  readonly charts: readonly ChartView[];
  /** where look-and-fix stands in the open turn; null when the turn has had no pass event */
  readonly pass: { readonly pass: number; readonly state: PassState } | null;
  /** v2.1. How the stage is divided right now (`StagePlan`), camera at rest. Absent until the painter plans its stage as one layout. */
  readonly plan?: StagePlanView;
  /** v2.1. The deck on stage and the slide it stands at, from 1; null or absent when what is on stage is not a deck. */
  readonly deck?: { readonly slide: number; readonly slides: number; readonly title: string } | null;
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
  /** a picture for the server: a snapshot shortly after a turn's report, a sketch shortly after a `paint` line, a draft when the server says a pass has been drafted */
  readonly upload: PainterUpload;
  /** the controls on stage changed: one arrived, left, moved or took a new value. Not sent on every frame of a drag. */
  readonly controls: readonly ControlView[];
  /**
   * v2.1, text out. The words on stage and where they are, for the chrome's text layer. Sent when words arrive, leave, change or come
   * to rest in a new place, and when the camera comes to rest; never on every frame of a move (the layer is hidden while things move).
   */
  readonly text: readonly TextSpanView[];
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
   * `page`: a page of the app's own (`/help`, `/status`) that the server never hears of. It is shown over the stage, not instead of it:
   * the stage under it is kept, and the next turn that is not a page opens on that stage again, so the painter and the server agree on
   * what the brain is told is there (v2.1 review, W-5).
   */
  openTurn(turn: string, input: TurnInput, options?: { readonly page?: boolean }): void;

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
   * v2.2. A photograph the server found for an `image` part of a mock-up, by the part's id. Not on the turn clock: it may arrive after the
   * turn has ended. It is drawn in the placeholder's place once the renderer has it, with `credit` at its foot; failing, the placeholder stays.
   */
  pictureArrived(partId: string, picture: { readonly url: string; readonly credit: string; readonly landing: string } | null): void;

  /**
   * News of DATA a chart draws by reference (`chart … data=d1`). `rows` is the table when it is ready, null when it could
   * not be had. Like a painting it is not on the turn clock: the chart reveals itself over `CHART_REVEAL_SECONDS` on the
   * ambient clock from the moment the rows are there, and nothing scheduled moves.
   */
  dataArrived(id: string, rows: DataTable | null): void;

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
   * Every turn that can still be performed again, oldest first (the last `KEPT_RECORDINGS`, 64), each with the playhead its lines arrived
   * at and how it was opened: the conversation as this page has seen it. A turn that is still playing is not among them.
   */
  recordings(): readonly Recording[];

  /**
   * Schedules one line of the open turn at the pen and returns any semantic
   * issues with it. The turn clock leaves zero when the first line arrives.
   */
  ingest(turn: string, seq: number, line: Line): readonly Issue[];

  /**
   * The brain has stopped writing: every pass of the turn is over. The playhead
   * may now run past the pen to the end. A turn that is looked at and fixed
   * stays open between its passes, so until this is called the playhead holds
   * at the pen as it does for any slow brain.
   */
  closeTurn(turn: string, reason: TurnEndReason): void;

  /**
   * Where look-and-fix stands in the open turn (a `pass` event from the
   * server). On `drafted` the painter works out how the lines so far WILL
   * land, without waiting for the playhead: it settles a copy of the
   * schedule to its end, computes sight for it, emits a `draft` back event,
   * and, when the renderer can capture and the server wants pictures, emits
   * an `upload` of kind `draft` first. Nothing on stage moves because of it.
   * The other states only change what `snapshot().pass` says, which the
   * chrome reads. A pass event for a turn that is not open is dropped.
   */
  notePass(turn: string, pass: number, state: PassState): void;

  /**
   * v2.1, true revision (a `candidate` event). Tries the lines of a fix on a COPY of the open turn's score: it settles the copy to its
   * end, computes sight, the placed boxes and `contentOf` for it, emits a `draft` back event for `pass` with all three, and, when the
   * server wants pictures, an `upload` of kind `draft` first. Nothing on stage moves and the turn's own score is not touched: the lines
   * that are to be shown arrive afterwards through `ingest`, like any others, or never. Lines the copy rejects are counted in the
   * report's sight as they would be live. A candidate for a turn that is not open is dropped.
   */
  tryCandidate(turn: string, pass: number, lines: readonly Line[]): void;

  /**
   * SA4 (a `want` event). Takes a picture of the open turn as the lines so far will leave it and emits it as an `upload` of kind `look` for
   * `request`. Does nothing, and says nothing, when the turn is not the open one, is settling, or the renderer cannot capture.
   */
  lookNow(turn: string, request: string): void;

  /**
   * v2.1, decks. Steps a deck to a slide: a number from 1, or the one after or before the slide on stage. The stage plays that slide
   * from its start and stops at its end. Does nothing when what is on stage is not a deck, or the slide does not exist.
   */
  slide(to: number | 'next' | 'previous'): void;

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

  /**
   * v2.2. The mock-ups on stage as they rest: the live parts a finger works (a field, a toggle, a button, a tab), the words as drawn and the
   * kit's own lint notes, in host CSS pixels. For the test hook: a tester taps where a person would and judges the words as they stand.
   * Empty when no mock-up is on stage.
   */
  mockups(): readonly UiMockup[];

  /** A pointer came down at a point in host CSS pixels. Emits `tap` if it hit an element. */
  tapAt(x: number, y: number): void;

  /** The same as tapping the element with this key; for keyboard users of the transcript. */
  tapElement(key: string): void;

  /**
   * A pointer went down, moved or came up. Returns true when a control took
   * it (the app then leaves it alone: no tap, no text selection, no scroll).
   * A drag changes the control's value and everything bound to it in the
   * same frame, with no word to the server; the commit on `up` emits one
   * `control` back event. `tapAt` stays the way a plain tap is reported.
   */
  pointer(input: PointerInput): boolean;
  /** whether a field of a mock-up on stage has the keyboard (the app then keeps a real input focused, for a phone's keyboard) */
  typing(): boolean;
  /** a key (a character, `Backspace`, `Enter`, `Escape`) for the mock-up field that has the keyboard; true when it was taken */
  key(key: string): boolean;

  /**
   * Sets a control's value: what the invisible form control laid over it,
   * the keyboard and the test hook call. `commit` false is a drag in
   * progress (bindings follow, nothing is sent); true is the user letting go
   * (a `control` back event is emitted, and for a control marked `send`, or a
   * button, the event says so and the app opens a turn). A value outside the
   * control's range is clamped; an id that is not a live control does nothing.
   */
  setControl(id: string, value: ControlValue | null, commit: boolean): void;

  resize(viewport: Viewport): void;
  snapshot(): PainterSnapshot;
  on<K extends keyof PainterEvents>(type: K, listener: (event: PainterEvents[K]) => void): () => void;
  dispose(): void;
}
