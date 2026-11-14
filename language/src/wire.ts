// Everything that crosses a process boundary: the two one-way streams between
// server and painter, and the HTTP bodies around them. Both sides import these
// types, so a field cannot be renamed on one side only.

import type { StageBase } from './schedule';
import type { PlacedBox, Sight } from './sight';
import type { ShownItem } from './stage';
import type { LeadWindow } from './timing';
import type { ControlValue, ControlValues, Issue } from './types';
import {
  AMBIENT_KINDS,
  CAMERA_MOVES,
  CHART_KINDS,
  CONTROL_KINDS,
  ELEMENT_KINDS,
  ENTER_EFFECTS,
  EXIT_EFFECTS,
  FACES,
  FX_NAMES,
  LANGUAGE,
  LAYERS,
  LAYOUTS,
  LOOK_IDS,
  LOOPS,
  MARKS,
  PROCEDURAL_MEDIA,
  STROKES,
  STRUCTURE_KINDS,
  TEXTURES,
} from './vocabulary';
import type {
  AmbientKind,
  CameraMove,
  CanvasName,
  ChartKind,
  ControlKind,
  ElementKind,
  EnterEffect,
  ExitEffect,
  Face,
  FxName,
  Layer,
  Layout,
  LookId,
  Loop,
  Mark,
  Medium,
  StrokeCharacter,
  StructureKind,
  Texture,
} from './vocabulary';

/** What the painter can see and the brain cannot. */
export interface ScreenFacts {
  /** CSS pixels */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** characters that fit on one line at body size inside the safe frame; an average, once the look's face is proportional */
  readonly cols: number;
  /** lines that fit at body size inside the safe frame */
  readonly rows: number;
  /** the canvas that suits this screen's shape: what a brain should draw on unless it has a reason not to */
  readonly canvas: CanvasName;
  readonly reducedMotion: boolean;
  readonly pointer: 'fine' | 'coarse' | 'none';
}

/** The part of the vocabulary this painter can actually perform. The brain's prompt is generated from it. */
export interface Capabilities {
  /** the Series version the painter speaks */
  readonly language: number;
  readonly renderer: string;
  /** true when layers are real planes at different depths with a moving camera */
  readonly depth: boolean;
  readonly looks: readonly LookId[];
  readonly layers: readonly Layer[];
  readonly layouts: readonly Layout[];
  readonly camera: readonly CameraMove[];
  readonly enters: readonly EnterEffect[];
  readonly exits: readonly ExitEffect[];
  readonly loops: readonly Loop[];
  readonly marks: readonly Mark[];
  /** what it can put on stage. `text` is always there; a painter that cannot draw advertises nothing else. */
  readonly kinds: readonly ElementKind[];
  readonly faces: readonly Face[];
  readonly fx: readonly FxName[];
  readonly ambient: readonly AmbientKind[];
  /** what it can tell the brain about how a turn landed: nothing, the structured report, or the report and a picture */
  readonly sight: 'none' | 'report' | 'snapshot';
  /** the structures it can lay out. Empty until the painter can; the brain is taught only these. */
  readonly structures: readonly StructureKind[];
  /** the kinds of chart its charting engine draws; `chart` is in `structures` only when this is not empty */
  readonly charts: readonly ChartKind[];
  /** the controls it can draw and work, bindings included. Empty until the painter can. */
  readonly controls: readonly ControlKind[];
  /** the media it can render a sketch in by itself (`paint as=`), with no image model */
  readonly media: readonly Medium[];
  /** the fill textures it can draw (`tex=`); `flat` is always there */
  readonly textures: readonly Texture[];
  /** the line characters it can draw on one shape (`brush=`) */
  readonly brushes: readonly StrokeCharacter[];
  /** true when it can report on a draft before the turn has finished playing: what look-and-fix needs */
  readonly drafts: boolean;
}

/** What the server can do for a turn that the painter cannot. The brain's prompt is filtered by these too. */
export interface Services {
  /** an image model is configured, so `paint` can ask it for a painting; without one a painting is the painter's own rendering of the sketch */
  readonly paint: boolean;
  /** what the server wants back about how a turn landed: the report alone, or the report and a picture of the resting stage */
  readonly sight: 'report' | 'snapshot';
  /** the brain looks at its draft and fixes it within the turn: the painter is asked for a draft report (and picture) when a `pass` event says `drafted` */
  readonly review: boolean;
}

export const NO_SERVICES: Services = { paint: false, sight: 'report', review: false };

export const FULL_CAPABILITIES: Capabilities = {
  language: LANGUAGE.version,
  renderer: 'reference',
  depth: true,
  looks: LOOK_IDS,
  layers: LAYERS,
  layouts: LAYOUTS,
  camera: CAMERA_MOVES,
  enters: ENTER_EFFECTS,
  exits: EXIT_EFFECTS,
  loops: LOOPS,
  marks: MARKS,
  kinds: ELEMENT_KINDS,
  faces: FACES,
  fx: FX_NAMES,
  ambient: AMBIENT_KINDS,
  sight: 'snapshot',
  structures: STRUCTURE_KINDS,
  charts: CHART_KINDS,
  controls: CONTROL_KINDS,
  media: PROCEDURAL_MEDIA,
  textures: TEXTURES,
  brushes: STROKES,
  drafts: true,
};

/** What a painter that speaks Series 3 can do of Series 4: nothing. A `ready` that leaves the new lists out is read as this. */
export const NO_V4_CAPABILITIES = { structures: [], charts: [], controls: [], media: [], textures: ['flat'], brushes: [], drafts: false } as const satisfies Pick<
  Capabilities,
  'structures' | 'charts' | 'controls' | 'media' | 'textures' | 'brushes' | 'drafts'
>;

export const REFERENCE_SCREEN: ScreenFacts = { width: 1280, height: 720, dpr: 2, cols: 58, rows: 11, canvas: 'wide', reducedMotion: false, pointer: 'fine' };

/** The most characters in a prompt. */
export const PROMPT_MAX_CHARS = 20_000;

export type TurnInput =
  | { readonly kind: 'prompt'; readonly text: string }
  /** the user tapped a choice; `text` is what the choice said */
  | { readonly kind: 'tap'; readonly id: string; readonly text: string }
  /** play a named fixture script; always answered by the replay brain */
  | { readonly kind: 'demo'; readonly script: string }
  /** play these lines of Series: a script copied from an earlier answer, edited or not. Always answered by the replay brain. */
  | { readonly kind: 'script'; readonly text: string }
  /**
   * The user worked a control whose change is meant for the brain: a button
   * pressed, or a control marked `send` committed. `text` is the control's
   * label (a pick: the option chosen); `values` is every live control's value.
   */
  | { readonly kind: 'act'; readonly id: string; readonly text: string; readonly values: ControlValues };

export type ClockState =
  /** no turn is open and nothing is left to play */
  | 'idle'
  /** a turn is open but no line has arrived yet */
  | 'waiting'
  | 'playing'
  /** the playhead has caught the pen and the turn is still being written */
  | 'holding'
  /** stopped by the user or the test hook */
  | 'paused'
  /** the tab is hidden; the browser has stopped the frame loop */
  | 'hidden';

export type TurnEndReason =
  /** the brain finished writing */
  | 'done'
  /** the user spoke or tapped before the brain finished */
  | 'interrupted'
  /** the brain threw */
  | 'failed'
  /** the brain went quiet for too long */
  | 'timeout';

export interface TurnReport {
  readonly turn: string;
  readonly outcome: 'finished' | 'interrupted';
  /** where the playhead was when the turn stopped */
  readonly playhead: number;
  readonly shown: readonly ShownItem[];
  /** the stage as it now rests; the next turn starts from this */
  readonly stage: StageBase;
  /** how it landed: what the brain is told so that it stops writing blind */
  readonly sight: Sight;
  /** where the playhead was when the user asked to see all of it at once; null when they watched it play */
  readonly skippedAt: number | null;
  /** the real, resolved world box of everything left on the stage (see `PlacedBox`); the brief's positions come from here, not from the lines as written */
  readonly placed?: readonly PlacedBox[];
  /** what every control left on the stage holds, by element id. Absent means there are none. The same values are written into `stage`. */
  readonly controls?: ControlValues;
}

/**
 * Where look-and-fix stands within a turn. A turn has one or more passes: the
 * draft the brain writes first, then, when the server decides it is worth it,
 * a pass in which the brain is shown its draft and fixes it. All of a turn's
 * passes share its clock, its ids and its `seq` numbering.
 *
 * - `drafted`: the brain has finished pass `pass`. The painter answers with a `draft` back event (and a picture, when it can) for the stage as the lines so far will leave it, without waiting for the playhead.
 * - `looking`: the brain has been shown the draft and has not written yet. The stage holds at the pen as usual; the chrome may say so.
 * - `fixing`: the first line of the fix has arrived.
 * - `kept`: the brain looked and changed nothing.
 * - `skipped`: the server decided not to look, or gave up waiting; `reason` says why. The turn ends as it stands.
 */
export type PassState = 'drafted' | 'looking' | 'fixing' | 'kept' | 'skipped';

/** What became of a painting. `ready`: fetch `url`. `skipped`: no image model is configured. `failed`: one is, and it did not deliver. */
export type AssetStatus = 'ready' | 'skipped' | 'failed';

/** Server to painter, over Server-Sent Events. The SSE event name is `type`; the data is the JSON of the rest. */
export type StageEvent =
  | { readonly type: 'hello'; readonly session: string; readonly lead: LeadWindow; readonly services: Services }
  | { readonly type: 'turn'; readonly turn: string; readonly input: TurnInput }
  /** the server is fetching something the user gave: `label` is a site name or "your text"; `message` says why when it failed */
  | { readonly type: 'reading'; readonly turn: string; readonly label: string; readonly state: 'start' | 'done' | 'failed'; readonly message: string | null }
  /** one normalised line of Series; `seq` increases over the whole session */
  | { readonly type: 'line'; readonly turn: string; readonly seq: number; readonly text: string; readonly issues: readonly Issue[] }
  /** something the brain wrote that was dropped; for the debug HUD only */
  | { readonly type: 'reject'; readonly turn: string; readonly raw: string; readonly issues: readonly Issue[] }
  | { readonly type: 'end'; readonly turn: string; readonly reason: TurnEndReason; readonly message: string | null }
  /** look-and-fix: `pass` is the pass that has just been drafted, or is being looked at or fixed (the draft is pass 1) */
  | { readonly type: 'pass'; readonly turn: string; readonly pass: number; readonly state: PassState; readonly reason: string | null }
  /**
   * News of a painting, whenever it comes: it is not on the turn clock and may
   * arrive after the turn has ended. `key` is the picture element's key
   * (`<id>@<seq>`); `url` is same-origin and set only when `status` is `ready`.
   */
  | { readonly type: 'asset'; readonly turn: string; readonly key: string; readonly status: AssetStatus; readonly url: string | null; readonly reason: string | null }
  /**
   * News of DATA a chart draws by reference (`chart … data=d1`). Like a
   * painting it is not on the turn clock: `ready` says where to fetch the
   * rows (same origin, JSON: a `DataTable`), and the chart reveals itself
   * when they are there. `failed`: the chart shows that it has no data.
   */
  | { readonly type: 'data'; readonly turn: string; readonly id: string; readonly status: 'ready' | 'failed'; readonly url: string | null; readonly reason: string | null };

export type StageEventType = StageEvent['type'];
export const STAGE_EVENT_TYPES: readonly StageEventType[] = ['hello', 'turn', 'reading', 'line', 'reject', 'end', 'pass', 'asset', 'data'];

/** Painter to server: the back channel. */
export type BackEvent =
  /** sent when the session is created and again whenever the screen changes */
  | { readonly type: 'ready'; readonly screen: ScreenFacts; readonly capabilities: Capabilities; readonly look: LookId }
  /** the turn clock left zero */
  | { readonly type: 'started'; readonly turn: string }
  | {
      readonly type: 'progress';
      readonly turn: string;
      readonly playhead: number;
      readonly pen: number;
      readonly clock: ClockState;
      /** the highest line `seq` the painter has scheduled */
      readonly ackSeq: number;
      /** ids whose entrance began since the last progress event */
      readonly shown: readonly string[];
      /** ids that left since the last progress event */
      readonly gone: readonly string[];
    }
  | {
      readonly type: 'tap';
      readonly turn: string | null;
      readonly id: string;
      readonly text: string;
      readonly playhead: number;
      /** true when the element was a choice, so this tap is also the next turn's input */
      readonly choice: boolean;
    }
  | { readonly type: 'report'; readonly report: TurnReport }
  /**
   * The user committed a change to a control (released a slider, flipped a
   * toggle, chose an option, pressed Enter in an input). Not sent while
   * dragging: local bindings need no round trip. `send` is true when the
   * change is also the next turn's input, as a choice's tap is.
   */
  | { readonly type: 'control'; readonly turn: string | null; readonly id: string; readonly value: ControlValue; readonly text: string; readonly playhead: number; readonly send: boolean }
  /**
   * How pass `pass` of an open turn will land: sight for the stage as the
   * lines so far will leave it, computed without waiting for the playhead.
   * Sent in answer to `pass … drafted`. `snapshot` is true when a picture of
   * that stage was uploaded beside it (`API.draft`).
   */
  | { readonly type: 'draft'; readonly turn: string; readonly pass: number; readonly sight: Sight; readonly placed?: readonly PlacedBox[]; readonly snapshot: boolean };

export type BackEventType = BackEvent['type'];
export const BACK_EVENT_TYPES: readonly BackEventType[] = ['ready', 'started', 'progress', 'tap', 'report', 'control', 'draft'];

/** A back-channel event as the server keeps it. `cursor` increases over the session. */
export interface BackEventRecord {
  readonly cursor: number;
  /** ISO time the server received it */
  readonly at: string;
  readonly event: BackEvent;
}

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
}

/** The painter's first `ready`: what it can see, what it can do, and the look its empty stage starts in. */
export interface CreateSessionRequest {
  readonly screen: ScreenFacts;
  readonly capabilities: Capabilities;
  readonly look: LookId;
}

export interface CreateSessionResponse {
  readonly session: string;
  readonly lead: LeadWindow;
}

export interface StartTurnRequest {
  readonly input: TurnInput;
  /**
   * Back events still queued in the painter, in order. The server applies them
   * exactly as `POST …/events` would, before it interrupts and opens the turn,
   * so an interruption report always reaches the server ahead of the turn that
   * caused it.
   */
  readonly events?: readonly BackEvent[];
}

export interface StartTurnResponse {
  readonly turn: string;
}

export interface PostEventsRequest {
  readonly events: readonly BackEvent[];
}

export interface DemoInfo {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
}

export interface HealthResponse {
  readonly ok: true;
  readonly language: number;
  readonly brain: string;
}

/** Paths under the same-origin `/api` prefix. Both sides build URLs from here. */
export const API = {
  health: '/api/health',
  demos: '/api/demos',
  sessions: '/api/sessions',
  stream: (session: string): string => `/api/sessions/${session}/stream`,
  turns: (session: string): string => `/api/sessions/${session}/turns`,
  events: (session: string): string => `/api/sessions/${session}/events`,
  /** GET: the bytes of a painting. The id is in the `asset` event's url; nothing builds this path by hand. */
  asset: (session: string, asset: string): string => `/api/sessions/${session}/assets/${asset}`,
  /** POST image/png: the painter's rendering of the sketch a picture element stands on. `key` is the element key. */
  sketch: (session: string, key: string): string => `/api/sessions/${session}/sketches/${encodeURIComponent(key)}`,
  /** POST image/jpeg: what the stage looked like when a turn came to rest. GET: the same picture back. */
  snapshot: (session: string, turn: string): string => `/api/sessions/${session}/turns/${turn}/snapshot`,
  /** POST image/jpeg: the stage as pass `pass` of an open turn will leave it: what the brain is shown when it looks at its draft. */
  draft: (session: string, turn: string, pass: number): string => `/api/sessions/${session}/turns/${turn}/drafts/${pass}`,
  /** GET: the rows of DATA a chart draws by reference, as a `DataTable` */
  data: (session: string, id: string): string => `/api/sessions/${session}/data/${encodeURIComponent(id)}`,
  /** GET: the answers set out for the owner to score. POST: one score. */
  taste: '/api/taste',
  /** GET: the runs of the exploration battery on disk, newest first */
  exploreRuns: '/api/explore/runs',
  /** GET: one run's index */
  exploreRun: (run: string): string => `/api/explore/runs/${run}`,
  /** GET: one prompt's result in a run */
  exploreResult: (run: string, prompt: string): string => `/api/explore/runs/${run}/${prompt}`,
  relayNext: '/api/relay/next',
  relayGuide: '/api/relay/guide',
  relayStatus: '/api/relay/status',
  relayLines: (turn: string): string => `/api/relay/turns/${turn}/lines`,
  relayEnd: (turn: string): string => `/api/relay/turns/${turn}/end`,
  relayEvents: (turn: string): string => `/api/relay/turns/${turn}/events`,
} as const;
