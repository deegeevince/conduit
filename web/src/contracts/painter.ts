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
import type { Squeeze } from './squeeze';
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
  /**
   * v3 (T1). A picture of a surface that covers the stage (the lesson view, a live app), handed over by the surface itself through its bridge; the painter never reads
   * into it. When it answers a picture, that is the snapshot (the stage under it is not what the person sees); null: nothing covers the stage.
   */
  readonly cover?: () => Promise<Blob | null>;
  /** PLAN-canvas step 2 (`?lens=1`). A scene that would be squeezed to fit the screen is laid out on a page as tall as its content needs instead. Absent: the screen is always the page. */
  readonly grow?: boolean;
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
  /** the painter's own boxes for the control and each part of it, host CSS pixels: `whole` (the control, as the painter's ring runs round it, 3 px out), `press`, `switch`, `track`, `knob`, `field`, `back`, `next`, `option:<n>` */
  readonly parts: readonly { readonly part: string; readonly box: Box }[];
  /** false while it is entering, leaving or covered: it is then drawn but cannot be worked */
  readonly enabled: boolean;
  /** a change the user commits becomes their next message */
  readonly send: boolean;
  /** true when at least one change on stage follows it: the battery checks that a slider drives something */
  readonly bound: boolean;
  /** HI1. It is an ask of the stage: its field is the part named `field`, Enter checks it, and leaving it checks nothing */
  readonly ask?: boolean;
  /** HI1. Where an ask stands: how it came out, what was tried, the hints open, and whether it still waits for the ask before it (what a test reads; the answers it accepts are not here) */
  readonly askState?: { readonly verdict: 'open' | 'wrong' | 'right' | 'shown'; readonly tries: number; readonly hints: number; readonly chosen: number; readonly locked: boolean };
  /** HI1. Every answer an ask accepts is a number: the keyboard that comes up has numbers */
  readonly numeric?: boolean;
}

/** One cell of a written method that a hand writes in (PLAN-maths M3): where it stands, what it holds, and how the last Check marked it. Host CSS pixels. */
export interface MathCellView {
  readonly part: string;
  /** "tens", "carry tens", "exchange ones": what a screen reader and the brain call it */
  readonly label: string;
  readonly box: Box;
  readonly value: string;
  readonly by: 'key' | 'pen' | 'fill' | 'shown' | '';
  readonly mark: 'right' | 'wrong' | 'empty' | 'shown' | '';
  /** a carry or an exchange the learner may leave empty */
  readonly optional: boolean;
  /** its place in working order (0 first); null for a box nobody is asked to write at a fixed point */
  readonly order: number | null;
  readonly maxLength: number;
  /** a hint has lit it, and the keyboard is in it */
  readonly lit: boolean;
  readonly active: boolean;
  /** what the reader made of the pen's writing: a digit, `?`, or '' */
  readonly read: string;
  readonly reading: boolean;
  /** there is pen ink in it, and where a finger takes it off (its ✕) */
  readonly ink: boolean;
  readonly dim: boolean;
  readonly clear: Box | null;
}

/** Check, Hint or Show me of a written method. */
export interface MathButtonView {
  readonly name: 'check' | 'hint' | 'show';
  readonly label: string;
  readonly box: Box;
}

/** A written method with cells to write in, as it stands on screen. */
/** A typeset formula on stage as the test hook sees it (PLAN-maths M7): the TeX, where it is on screen, whether KaTeX has set it, and its fault when it could not. */
export interface FormulaView {
  readonly key: string;
  readonly id: string;
  readonly tex: string;
  /** host CSS pixels */
  readonly box: Box;
  readonly opacity: number;
  /** the page has set it (its size is KaTeX's own, not the estimate held in its place) */
  readonly set: boolean;
  /** KaTeX's words for what it could not read; the TeX is then shown as text */
  readonly fault: string | null;
}

export interface MathBlockView {
  readonly key: string;
  readonly id: string;
  /** the sum it is working, as the line wrote it: a later sum under the same id is a new block with none of the old one's pen ink (fb-097) */
  readonly sum: string;
  /** how Check last found it */
  readonly verdict: 'open' | 'wrong' | 'right' | 'shown';
  readonly box: Box;
  readonly cells: readonly MathCellView[];
  readonly buttons: readonly MathButtonView[];
  /** the hint that is open, in words */
  readonly hint: string;
}

/** What is under a point of a written method: a cell to write in, one of its buttons, or the cross that takes the pen's ink off a cell. */
export type MathHit = { readonly kind: 'cell'; readonly key: string; readonly part: string } | { readonly kind: 'button'; readonly key: string; readonly name: 'check' | 'hint' | 'show' } | { readonly kind: 'clear'; readonly key: string; readonly part: string };

/** A pointer, as the app hands it to the painter. `x`, `y` are host CSS pixels. */
export interface PointerInput {
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly x: number;
  readonly y: number;
  /** the browser's pointer id, so two fingers on two sliders do not fight */
  readonly pointer: number;
}

/** Where a label's leader line ends and how that end stands to the parts that have labels, as the catalogue and the test hook read it. */
export interface LeaderView {
  /** the label's id */
  readonly label: string;
  /** the id of the part the label names (`near=`) */
  readonly part: string;
  /** the far end of the leader, host CSS pixels */
  readonly end: { readonly x: number; readonly y: number };
  /** how far the end is from the outline of its own part, px (0: it touches) */
  readonly distance: number;
  /** the other labelled part the end reaches nearer than its own, or null */
  readonly nearer: { readonly id: string; readonly distance: number } | null;
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

/** What the hand has bound to one element, as it stands now: the words a bound `correct` gives it, the table marks and the `set` values that hold. For the test hook. */
export interface BindingView {
  readonly id: string;
  /** the words a bound `correct` gives it now, with the emphasis marks taken out; null: its own */
  readonly words: string | null;
  /** the rows and cells of a table that a control's value has marked, as `row2:box` */
  readonly marks: readonly string[];
  /** the `set` values that hold, as `fill=gg` */
  readonly sets: readonly string[];
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

/** Something on stage that keeps moving at this instant: a `loop=`, a `move` in progress, or a live `bind`. `seq` is the line that began it, `since` when (turn clock). */
export interface MotionView {
  readonly id: string;
  readonly kind: 'loop' | 'move' | 'bind';
  readonly seq: number;
  readonly since: number;
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
  /** what keeps moving now (loops, moves in progress, live binds); absent when nothing does */
  readonly motions?: readonly MotionView[];
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
  /** PLAN-canvas step 0. What the scene on stage gave up to fit the screen (words let go or set smaller, blocks short of room, controls set tighter, an app scaled down), and why. Facts only. */
  readonly squeeze: Squeeze;
  /** PLAN-canvas step 2. The page the scene is laid out on, host CSS pixels from the screen's top-left, when it has grown past the screen; absent while the screen is the page. */
  readonly page?: Box;
  /** PLAN-canvas step 2. Where the newest line of a grown page stands, host CSS pixels of the page (what a lens that follows keeps in view); absent otherwise. */
  readonly follow?: Box;
  /** v2.1. The deck on stage and the slide it stands at, from 1; null or absent when what is on stage is not a deck. */
  readonly deck?: { readonly slide: number; readonly slides: number; readonly title: string } | null;
}

/** Words as they become visible, for the transcript and the live region. */
export type TranscriptEvent =
  | { readonly kind: 'turn'; readonly turn: string; readonly input: TurnInput }
  | { readonly kind: 'shown'; readonly key: string; readonly id: string; readonly text: string; readonly tappable: boolean; readonly replaces: string | null }
  /**
   * Read aloud. A line of words, or an ask, as it begins to show: told for words that stand in a card as well (the transcript tells the card once). Not told for
   * a drawing's parts, a table's cells, code, a chart or a mock-up: none of those is a line of words to be read.
   */
  | {
      readonly kind: 'said';
      readonly key: string;
      readonly text: string;
      readonly tappable: boolean;
      /** the words label a part of a drawing (`near=`): shown, not read */
      readonly near: boolean;
      /** an ask of the stage: its question is `text`, and a pick has these choices */
      readonly ask?: { readonly options: readonly string[] };
    }
  /** a hint the person opened on an ask of the stage */
  | { readonly kind: 'hint'; readonly key: string; readonly text: string }
  /** a diagram's words changed (its cells follow a control): what the line of `shown` for it now says */
  | { readonly kind: 'told'; readonly key: string; readonly text: string }
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
  /** the written methods with cells to write in changed: a cell arrived, moved, took a digit or a mark (PLAN-maths M3) */
  readonly math: readonly MathBlockView[];
  /**
   * v2.1, text out. The words on stage and where they are, for the chrome's text layer. Sent when words arrive, leave, change or come
   * to rest in a new place, and when the camera comes to rest; never on every frame of a move (the layer is hidden while things move).
   */
  readonly text: readonly TextSpanView[];
  /**
   * The lines the layout let go of to make room, which are not on the stage at rest: oldest first, with the box of the words' column (host CSS pixels)
   * the chrome stands a control on, so that what the answer said is never only gone. Empty `lines` when nothing is held back or the stage is moving.
   */
  readonly retired: RetiredView;
}

export interface RetiredView {
  readonly lines: readonly { readonly key: string; readonly text: string }[];
  readonly column: Box | null;
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

  /** For a test: leaves the elements with these keys undrawn (none: all drawn again) and draws the frame now, so a picture taken with and without an element shows what it really paints. A figure has a key too (a callout's leader is `<its key>/leader`). Returns which of the keys the frame held. */
  hide(keys: readonly string[]): readonly string[];

  /** The leader lines on stage as they rest: where each ends and how that end stands to its own part and to the other labelled parts (what the catalogue's label check reads). */
  leaders(): readonly LeaderView[];

  /** Everything the controls bind on the elements on stage, as it holds now (settled: the way a picture of the stage at rest has it). */
  bindings(): readonly BindingView[];

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
  /** A wheel turned over the stage at a point (host CSS pixels), `dy` pixels down. True when a scrolling controls area took it (the app then does not scroll the page). */
  wheel(x: number, y: number, dy: number): boolean;
  /** Scrolls the controls area the control with this id stands in so that the control shows whole: the keyboard has come to it. */
  reveal(id: string): void;
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
  /** the pen has written something, or nothing now (`controls/pen.ts`): an ask's Check is drawn ready or not */
  penChanged(): void;

  /** The written methods with cells to write in, as they stand now (host CSS pixels). */
  mathViews(): readonly MathBlockView[];
  /** The typeset formulas on stage now. */
  formulaViews(): readonly FormulaView[];
  /** What a point is on, among the cells, buttons and ✕ marks of the written methods; null when it is on none (or the cell is settled). */
  mathAt(x: number, y: number): MathHit | null;
  /** A hand wrote in a cell (`key`: the digits typed; `pen`: what the pen's writing was read as). Returns false when the cell takes nothing now. */
  mathWrite(key: string, part: string, text: string, by: 'key' | 'pen'): boolean;
  /** The keyboard is in this cell, or in none. */
  mathActive(key: string, part: string | null): void;
  /** Where the keyboard goes from a cell: the next empty one in working order, the one before or after it, or along the grid. Null: nowhere. */
  mathMove(key: string, part: string, move: 'empty' | 'back' | 'next' | 'left' | 'right' | 'up' | 'down'): string | null;
  /** Check, Hint or Show me. The act of Check and Show me is told to the brain as one short line. */
  mathPress(key: string, name: 'check' | 'hint' | 'show'): void;
  /** The pen's ink in a cell: there is some now (the reader is waiting), or none (cleared, erased). */
  mathInk(key: string, part: string, on: boolean): void;
  /** What the reader made of a cell's ink: digits, '' for none, `?` for a smudge. */
  mathRead(key: string, part: string, digits: string): void;

  resize(viewport: Viewport): void;
  snapshot(): PainterSnapshot;
  on<K extends keyof PainterEvents>(type: K, listener: (event: PainterEvents[K]) => void): () => void;
  dispose(): void;
}
