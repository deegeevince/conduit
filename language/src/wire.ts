// Everything that crosses a process boundary: the two one-way streams between
// server and painter, and the HTTP bodies around them. Both sides import these
// types, so a field cannot be renamed on one side only.

import type { DocNode, DocState, Document, NodeId, NodeStatus, Seen, StateChange } from './document';
import type { InkDocument, InkMarks } from './ink';
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
  /**
   * v2.1. True when it can try a fix on a copy of the turn's score and report on it without showing any of it (`candidate`), then show
   * only the fix that was accepted: what true revision needs. False: the server falls back to no fix at all, never to a redraw.
   */
  readonly candidates: boolean;
  /** v2.1. True when a turn can be a deck: scenes that are slides, stepped through by the viewer (`deck`). */
  readonly decks: boolean;
  /** v2.1. True when it can put a picture the user gave on stage (`pic … from=u1`). */
  readonly uploads: boolean;
  /** v2.1. True when `say href=` is drawn as a link the viewer can follow. False: the brain is not taught it and names a source in words. */
  readonly links: boolean;
  /** SA2. The engine the page measures with (`ENGINE_VERSION`). The server measures a draft itself only when it is the server's own; absent or different: the draft gate. */
  readonly engine?: string;
}

/** What the server can do for a turn that the painter cannot. The brain's prompt is filtered by these too. */
export interface Services {
  /** an image model is configured, so `paint` can ask it for a painting; without one a painting is the painter's own rendering of the sketch */
  readonly paint: boolean;
  /** what the server wants back about how a turn landed: the report alone, or the report and a picture of the resting stage */
  readonly sight: 'report' | 'snapshot';
  /** the brain looks at its draft and fixes it within the turn: the painter is asked for a draft report (and picture) when a `pass` event says `drafted` */
  readonly review: boolean;
  /** v2.1. A critic looks at every real turn's resting picture in the background; what it finds is logged and queued for the loop. Absent: no. */
  readonly critic?: boolean;
  /** v2.1. The brain may ask for its picture to be made better pass by pass (`refine | what next`): the server runs it again at once, for as long as it keeps writing it. Absent: no. */
  readonly refine?: boolean;
  /** v2.1. The user may give pictures with a prompt (`TurnInput.images`), and the brain may put them on stage. Absent: no. */
  readonly uploads?: boolean;
  /** v3 art. The server holds a shelf of finished drawings, so `draw <subject>` can be answered. Absent: no. Taught only when on. */
  readonly art?: boolean;
  /** v2.1. What kind of mind is answering this conversation right now: it decides what the brain is told it can do. Absent: `plain`. */
  readonly mode?: BrainMode;
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
  candidates: true,
  decks: true,
  uploads: true,
  links: true,
};

/** What a painter that speaks Series 3 can do of Series 4: nothing. A `ready` that leaves the new lists out is read as this. */
export const NO_V4_CAPABILITIES = { structures: [], charts: [], controls: [], media: [], textures: ['flat'], brushes: [], drafts: false, candidates: false, decks: false, uploads: false, links: false } as const satisfies Pick<
  Capabilities,
  'structures' | 'charts' | 'controls' | 'media' | 'textures' | 'brushes' | 'drafts' | 'candidates' | 'decks' | 'uploads' | 'links'
>;

/** What a painter of v2 could do of v2.1: nothing. A `ready` that leaves these out is read as this. */
export const NO_V21_CAPABILITIES = { candidates: false, decks: false, uploads: false, links: false } as const satisfies Pick<Capabilities, 'candidates' | 'decks' | 'uploads' | 'links'>;

export const REFERENCE_SCREEN: ScreenFacts = { width: 1280, height: 720, dpr: 2, cols: 58, rows: 11, canvas: 'wide', reducedMotion: false, pointer: 'fine' };

/** The most characters in a prompt. */
export const PROMPT_MAX_CHARS = 20_000;

/** v3. A file the person gave whose words the page read: a PDF's text layer, page by page. `image` is the upload id of that page's picture, when it has one. */
export interface TurnSource {
  readonly name: string;
  readonly pages: readonly { readonly n: number; readonly text: string; readonly image?: string }[];
}

/** v3. What a turn may carry of its sources: the files, the pages of each, the characters of a page and of all of them together. */
export const SOURCE_LIMITS = { files: 4, pages: 10, pageChars: 10_000, chars: 40_000, name: 120 } as const;

/**
 * v3. Reads `TurnInput.sources` as it arrives. Lenient where cutting is harmless (a name, a page's text, the total) and strict about shape:
 * returns `null` when it is not a list of `{ name, pages: [{ n, text }] }`. Page text is cut to `pageChars`, and the whole to `chars` (later pages lose first).
 */
export function decodeSources(value: unknown): TurnSource[] | null {
  if (!Array.isArray(value) || value.length > SOURCE_LIMITS.files) return null;
  let left: number = SOURCE_LIMITS.chars;
  const out: TurnSource[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const { name, pages } = raw as { name?: unknown; pages?: unknown };
    if (typeof name !== 'string' || !Array.isArray(pages) || pages.length > SOURCE_LIMITS.pages) return null;
    const kept: { n: number; text: string; image?: string }[] = [];
    for (const item of pages as unknown[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
      const { n, text, image } = item as { n?: unknown; text?: unknown; image?: unknown };
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 99_999 || typeof text !== 'string') return null;
      if (image !== undefined && (typeof image !== 'string' || !/^u[1-9][0-9]{0,3}$/.test(image))) return null;
      // control characters other than line breaks and tabs are dropped; the cut is by what is left
      const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, Math.min(SOURCE_LIMITS.pageChars, Math.max(0, left)));
      left -= clean.length;
      kept.push({ n, text: clean, ...(image === undefined ? {} : { image }) });
    }
    out.push({ name: name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, SOURCE_LIMITS.name) || 'document', pages: kept });
  }
  return out;
}

export type TurnInput =
  /**
   * `images` (v2.1): ids of pictures the user gave with these words (`API.uploads`), in the order they were added; absent means none.
   * `marks` (v2.1): what the user wrote or drew on the stage with these words.
   * `voice` (v2.1): ids of voice notes (`API.voice`) these words came from or go with (`n1`, `n2`, ...). `spoken` is what the server heard in
   * them, filled by the server for the brain and never read from a request.
   * `sources` (v3): the text layer of each page of a PDF the person gave (its pages arrive as `images`); quoted data for the brain, never instructions.
   * `skills` (SK1): the ids (`user:pdf`) of the skills the person held for this message, at most `SKILL_HOLD.held`. The server reads and adds their text to the brief; the page never sends text.
   */
  | { readonly kind: 'prompt'; readonly text: string; readonly images?: readonly string[]; readonly marks?: InkMarks; readonly voice?: readonly string[]; readonly spoken?: readonly string[]; readonly sources?: readonly TurnSource[]; readonly skills?: readonly string[] }
  /** the user tapped a choice; `text` is what the choice said */
  /** v3. `seen`: where the person stood in the document when they tapped (2.5) */
  | { readonly kind: 'tap'; readonly id: string; readonly text: string; readonly seen?: Seen }
  /** play a named fixture script; always answered by the replay brain */
  | { readonly kind: 'demo'; readonly script: string }
  /** play these lines of Series: a script copied from an earlier answer, edited or not. Always answered by the replay brain. */
  | { readonly kind: 'script'; readonly text: string }
  /**
   * The user worked a control whose change is meant for the brain: a button
   * pressed, or a control marked `send` committed. `text` is the control's
   * label (a pick: the option chosen); `values` is every live control's value.
   * A button of a mock-up (`screen`) says which screen it is on, and `values` is what that screen's parts hold, by their labels (a password only as
   * `filled`).
   */
  | { readonly kind: 'act'; readonly id: string; readonly text: string; readonly values: ControlValues; readonly screen?: string; readonly seen?: Seen }
  /**
   * The brain went on: it ended its answer with `refine | <what it will do next>`, and the server runs it again at once, as a turn of its own, for as
   * long as it keeps writing that. `note` is its own words. Opened by the server and never by a client; no count, no clock: the brain, the person
   * (any message takes over), Stop and the usage cap end it.
   */
  | { readonly kind: 'refine'; readonly note: string }
  /**
   * v3. The server's own repair of the answer at rest (`of`: that turn): the critic found something the brain can mend, and the brain wrote fix
   * lines that were tried on the server first and kept. Opened by the server and never by a client; it carries no words of the person's. The
   * lines are an in-place edit of what is on stage: nothing is cleared, no choice leaves.
   */
  | { readonly kind: 'repair'; readonly of: string };

/** How many passes "keep making it better" runs when nobody says, and the most it may be asked for. */
export const REFINE_LIMITS = { passes: 4, max: 8 } as const;

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
export type PassState =
  | 'drafted'
  | 'looking'
  | 'fixing'
  | 'kept'
  | 'skipped'
  /**
   * v2.1. The brain has written a fix and none of it is on stage: its lines went to the painter as a `candidate`, and the server is
   * deciding whether they are better than the draft. The draft goes on playing.
   */
  | 'staged'
  /** v2.1. The fix was tried and thrown away (`reason` says why: it removed something, it landed worse, the critic preferred the draft). The draft stands. */
  | 'refused'
  /** v2.1. "Keep making it better": pass `pass` of `of` is being looked at and added to. The chrome says so and offers Stop. */
  | 'refining'
  /** v3. A repair of the answer at rest is going on (shown quietly: "Tidying up the last answer…"); only a kept repair is ever shown */
  | 'repairing'
  /** v3. The repair's lines are all on stage ("Tidied") */
  | 'repaired';

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
  /**
   * The line the brain is writing right now, as far as it has got (no newline yet). For the "Show the language" pane only: the painter never
   * acts on it, it is not part of the turn's score, a reconnecting stream is not given it again, and at most about 20 a second are sent. The
   * `line` event that follows is the line itself; a pane that has a `line`, a `reject` or an `end` for the turn drops what it was typing.
   */
  | { readonly type: 'typing'; readonly turn: string; readonly text: string }
  /** something the brain wrote that was dropped; for the debug HUD only */
  | { readonly type: 'reject'; readonly turn: string; readonly raw: string; readonly issues: readonly Issue[] }
  | { readonly type: 'end'; readonly turn: string; readonly reason: TurnEndReason; readonly message: string | null }
  /** look-and-fix: `pass` is the pass that has just been drafted, or is being looked at or fixed (the draft is pass 1) */
  | { readonly type: 'pass'; readonly turn: string; readonly pass: number; readonly state: PassState; readonly reason: string | null; readonly of?: number }
  /**
   * v2.1, true revision. The lines of a fix the brain has written for pass `pass`, in order, already normalised. The painter does NOT
   * show them: it applies them to a copy of the open turn's score, works out how that copy would land, and answers with a `draft` back
   * event for this `pass` (and its picture, `API.draft`), exactly as it does for `pass … drafted`. The lines it is to show arrive
   * afterwards as ordinary `line` events, or never (`pass … refused`).
   */
  | { readonly type: 'candidate'; readonly turn: string; readonly pass: number; readonly lines: readonly string[] }
  /** v2.1. What the critic made of a turn's resting picture. Not on the turn clock: it comes seconds after the turn has ended. For the HUD and the transcript; the stage does nothing with it. */
  | { readonly type: 'critic'; readonly turn: string; readonly finding: CriticFinding }
  /** v2.1, agent mode. A tool the brain is using, as it happens: the chrome's activity strip. `summary` never holds a secret (`redactSecrets`). */
  | { readonly type: 'activity'; readonly turn: string; readonly id: string; readonly tool: string; readonly summary: string; readonly state: ActivityState; readonly ms: number | null; readonly permit?: 'auto' }
  /**
   * v2.1, agent mode. The brain wants to do something that needs the owner's yes. The chrome shows a confirm control on the stage and
   * answers with a `permit` back event; with no answer by `expiresMs` it is denied. Nothing that sends, buys, deletes, publishes or signs
   * in is ever allowed without this (`askFirst`). `detail` is the whole call, pretty-printed and redacted, for the confirm control and nowhere else:
   * the owner cannot consent to what a 160-character summary cuts off. It is never logged.
   */
  | { readonly type: 'permission'; readonly turn: string; readonly request: string; readonly tool: string; readonly summary: string; readonly risk: ActionRisk; readonly expiresMs: number; readonly detail?: string }
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
  | { readonly type: 'data'; readonly turn: string; readonly id: string; readonly status: 'ready' | 'failed'; readonly url: string | null; readonly reason: string | null }
  /**
   * v2.2. A photograph the server found, off the turn clock, for an `image … | words` part of a mock-up (`id` is the part's id, as the
   * normaliser wrote it). Only a picture that was found is announced: with none, nothing is said and the placeholder stays. `url` is same
   * origin (`API.picture`); `credit` is the line drawn at its foot and `landing` the page it is credited to.
   */
  | { readonly type: 'picture'; readonly turn: string; readonly id: string; readonly url: string; readonly credit: string; readonly landing: string }
  /**
   * v3 (2.10, 2.11). A node of the conversation's document changed: a part was named, a step, an `ask` or a `hint` landed in it, or its
   * status moved (`outlined` to `filling` to `filled`, then `verified` or `refused`). `nodes` are whole nodes, the changed ones and any
   * parent whose children changed, so the page replaces by id and never has to merge; a later event for the same node is newer. `turn` is
   * null for a change made off the turn clock (an answer verified ahead). Not transient: a reconnecting stream is given it again.
   */
  | { readonly type: 'doc'; readonly turn: string | null; readonly document: string; readonly title: string; readonly root: NodeId; readonly nodes: readonly DocNode[] }
  /**
   * SA4. The brain asked for a picture of the stage as it stands (`canvas_look`). The page answers by uploading a JPEG to `API.look(session, request)`
   * within `deadlineMs`, or says nothing; the server stops waiting then. Not part of the turn's score: a reconnecting stream is not given it again.
   */
  | { readonly type: 'want'; readonly turn: string; readonly request: string; readonly what: 'picture'; readonly target: string | null; readonly deadlineMs: number };

export type StageEventType = StageEvent['type'];

/**
 * The stream's liveness. The server writes a `heartbeat` event (and a comment) every `everyMs` while a stream is open; a page that has
 * heard nothing at all for `silentMs` takes the stream for half-open, says so, and reconnects. (An EventSource never shows comments, so
 * the beat is a named event the page reads but does not pass on as a stage event.)
 */
export const STREAM_HEARTBEAT = { eventName: 'heartbeat', everyMs: 15_000, silentMs: 40_000 } as const;
export const STAGE_EVENT_TYPES: readonly StageEventType[] = ['hello', 'turn', 'reading', 'line', 'typing', 'reject', 'end', 'pass', 'asset', 'data', 'picture', 'candidate', 'critic', 'activity', 'permission', 'doc', 'want'];

/** What the page keeps of one ask (HI1): the hand's tries, the choice held, the hints open and how it came out. */
export interface AskRunFacts {
  readonly tries: readonly string[];
  readonly chosen: number;
  readonly hints: number;
  readonly verdict: 'open' | 'wrong' | 'right' | 'shown';
  readonly ringed: boolean;
}

/**
 * What the page measured a stage with that the lines alone do not say (SA2). Everything a stage's boxes depend on besides the score, the
 * look, the screen and the data: the server measures with exactly these, so that its boxes and the page's are the same boxes. Sent with a
 * `draft` and a `report`.
 */
export interface PageFacts {
  /** the screen it measured on: the page's own viewport when it measured, which a resize may have moved from the last `ready` */
  readonly view: { readonly width: number; readonly height: number; readonly dpr: number };
  /** the playhead each line of the turn was scheduled at, by `seq`: a revision or a cancel is quiet or visible by it */
  readonly floors: readonly (readonly [number, number])[];
  /** the least a tappable thing measures, css px (the pointer in use and the audience) */
  readonly target: number;
  /** what the hand has done to the asks on the stage, by the key of each ask and the ask's id to the key it is working now */
  readonly asks: { readonly runs: readonly (readonly [string, AskRunFacts])[]; readonly latest: readonly (readonly [string, string])[] };
  /** what every control on the stage holds, by id: whole, though it is empty (a new question clears what the hand left) */
  readonly controls: ControlValues;
}

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
      /** v3. Where the person stood in the document, and what every leaf held, at this instant */
      readonly seen?: Seen;
    }
  /** `boxes` (SA2): the digest of the boxes in `report.placed` (`digestOf`), for the server to hold against its own */
  | { readonly type: 'report'; readonly report: TurnReport; readonly boxes?: string; readonly facts?: PageFacts }
  /**
   * The user committed a change to a control (released a slider, flipped a
   * toggle, chose an option, pressed Enter in an input). Not sent while
   * dragging: local bindings need no round trip. `send` is true when the
   * change is also the next turn's input, as a choice's tap is.
   */
  | {
      readonly type: 'control';
      readonly turn: string | null;
      readonly id: string;
      readonly value: ControlValue;
      readonly text: string;
      readonly playhead: number;
      readonly send: boolean;
      readonly seen?: Seen;
      /** a button of a mock-up: the screen it is on, and what the screen's live parts hold (the turn it opens carries them) */
      readonly screen?: string;
      readonly values?: ControlValues;
      /** an app's own press (the app block), not a control of the stage */
      readonly app?: boolean;
      /** HI1. An act on an ask of the stage (a try, a hint, giving up): `text` is what the person did in a few words, for the one line the brain is told */
      readonly ask?: boolean;
    }
  /**
   * How pass `pass` of an open turn will land: sight for the stage as the
   * lines so far will leave it, computed without waiting for the playhead.
   * Sent in answer to `pass … drafted`. `snapshot` is true when a picture of
   * that stage was uploaded beside it (`API.draft`).
   */
  | { readonly type: 'draft'; readonly turn: string; readonly pass: number; readonly sight: Sight; readonly placed?: readonly PlacedBox[]; readonly snapshot: boolean; readonly content?: ContentCount; readonly boxes?: string; readonly facts?: PageFacts }
  /** v2.1, agent mode. The owner's answer to a `permission` event. `allow: true` lets that one action happen once; there is no "always". */
  | { readonly type: 'permit'; readonly turn: string; readonly request: string; readonly allow: boolean }
  /**
   * v3 (2.5). The person's state moved, committed in the page by `advance`: a place reached, a control committed, an answer tried, a
   * node finished. The server logs it (a `state` record), applies it to its copy of the document's state, and tells the mind where the
   * person is. Not sent while dragging and never a tick. `turn` is the open turn, or null.
   */
  | { readonly type: 'state'; readonly turn: string | null; readonly document: string; readonly change: StateChange }
  /** SA3. What only the eyes know, at any moment: at most one a second, `OBSERVE_LIMITS.items` items and `OBSERVE_LIMITS.bytes` bytes. */
  | { readonly type: 'observe'; readonly items: readonly ObserveItem[] }
  /**
   * v3. What the server cannot see of the person: whether they are typing now (the field holds words, or a key went down within the last few
   * seconds), and whether they allow the server to tidy an answer after the critic has judged it (`/review repair on|off`, default on).
   * Sent when either changes. A `typing` that is not renewed lapses on the server after `PRESENCE_TYPING_MS`.
   */
  | { readonly type: 'presence'; readonly typing: boolean; readonly repair: boolean; /** `/stop` or the Stop button: it ends the brain's own continuation, which runs between turns */ readonly stop?: true };

/** How long the server takes a `presence … typing` to hold with no word from the page: a lost "stopped typing" never blocks a repair for long. */
export const PRESENCE_TYPING_MS = 6000;

/** SA3. What the page may report in an `observe` event. (`present` and `legible` are the raster's, and come with the picture checks.) */
export const OBSERVE_KINDS = ['viewport', 'scroll', 'fonts', 'surface', 'present', 'legible'] as const;
export type ObserveKind = (typeof OBSERVE_KINDS)[number];
export const OBSERVE_SEVERITIES = ['info', 'note', 'blocking', 'fault'] as const;
export type ObserveSeverity = (typeof OBSERVE_SEVERITIES)[number];

export interface ObserveItem {
  readonly kind: ObserveKind;
  /** an element, a scroll host or a surface; null when it is about the page */
  readonly on: string | null;
  /** 160 characters at most; words of the page's own, never instructions */
  readonly note: string;
  readonly severity: ObserveSeverity;
}

export const OBSERVE_LIMITS = { everyMs: 1000, items: 20, bytes: 8192, note: 160, on: 64 } as const;

/**
 * Reads the items of an `observe` event: unknown kinds and malformed items are dropped, not refused (the page keeps reporting), the list is cut
 * at `OBSERVE_LIMITS.items` and again until its JSON is within `OBSERVE_LIMITS.bytes`. Never throws.
 */
export function decodeObserveItems(value: unknown): ObserveItem[] {
  if (!Array.isArray(value)) return [];
  const out: ObserveItem[] = [];
  for (const raw of value) {
    if (out.length >= OBSERVE_LIMITS.items) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const kind = OBSERVE_KINDS.find((one) => one === item['kind']);
    if (kind === undefined || typeof item['note'] !== 'string') continue;
    const severity = OBSERVE_SEVERITIES.find((one) => one === item['severity']) ?? 'info';
    const on = typeof item['on'] === 'string' && item['on'] !== '' ? item['on'].slice(0, OBSERVE_LIMITS.on) : null;
    out.push({ kind, on, note: item['note'].replace(/\s+/g, ' ').trim().slice(0, OBSERVE_LIMITS.note), severity });
  }
  while (out.length > 0 && JSON.stringify(out).length > OBSERVE_LIMITS.bytes) out.pop();
  return out;
}

export type BackEventType = BackEvent['type'];
export const BACK_EVENT_TYPES: readonly BackEventType[] = ['ready', 'started', 'progress', 'tap', 'report', 'control', 'draft', 'permit', 'state', 'observe', 'presence'];

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

/** The models the owner may choose from the prompt bar (`/model`). The server's own default may be any model the CLI knows; only a choice is held to this list. */
export const BRAIN_MODELS = ['sonnet', 'opus', 'fable', 'haiku'] as const;
export type BrainModel = (typeof BRAIN_MODELS)[number];

export const BRAIN_EFFORTS = ['low', 'medium', 'high'] as const;
export type BrainEffort = (typeof BRAIN_EFFORTS)[number];

/**
 * v2.1. What kind of mind answers a conversation. It is one brain in three settings, never a second chat beside the canvas:
 * - `plain`: the model with no tools. It writes Series and can do nothing else.
 * - `agent`: the same model with tools (`claude` with an allowlist). What it does is shown as it happens and asked for first when it matters.
 * - `steward`: the turn is held for the steward's own session to claim over the relay and answer.
 */
export const BRAIN_MODES = ['plain', 'agent', 'steward'] as const;
export type BrainMode = (typeof BRAIN_MODES)[number];

/** v2.1, agent mode. How a call that needs a yes is answered: `ask` puts every one to the owner on stage; `auto` lets the browser's read, write and run calls (in its own tabs) through, and still asks for the rest. */
export const AGENT_PERMITS = ['ask', 'auto'] as const;
export type AgentPermits = (typeof AGENT_PERMITS)[number];

/** A change to one session's brain; what is left out stays as it is. */
export interface BrainChange {
  /** v2.1; `/tools auto`, `/tools ask`. Takes effect at once, with no fresh process. */
  readonly permits?: AgentPermits;
  readonly model?: BrainModel;
  readonly effort?: BrainEffort;
  /** v2.1; refused unless the server offers it (`BrainChoice.modes`) */
  readonly mode?: BrainMode;
}

/** What one session's brain is set to. `configurable` is false for a brain that has neither (the relay, a replay): `model` and `effort` are then null. */
export interface BrainChoice {
  readonly configurable: boolean;
  readonly model: string | null;
  readonly effort: BrainEffort | null;
  /** v2.1; absent from a server that has one mode */
  readonly mode?: BrainMode;
  /** v2.1. How this session's permit prompts are answered; absent from a server with no agent mode */
  readonly permits?: AgentPermits;
  /** v2.1. The modes this server offers this session, for the picker; absent or one entry: nothing to choose */
  readonly modes?: readonly BrainMode[];
}

/** v2.1, agent mode. What an action would do in the world, worst first where two apply. The owner is asked for every kind in `ASK_FIRST`. */
export const ACTION_RISKS = ['read', 'write', 'run', 'send', 'buy', 'delete', 'publish', 'signin'] as const;
export type ActionRisk = (typeof ACTION_RISKS)[number];

/** Never allowed by a rule or a setting: only by the owner's own yes, once, on the stage. */
export const ASK_FIRST: readonly ActionRisk[] = ['write', 'run', 'send', 'buy', 'delete', 'publish', 'signin'];

/** Whether an action of this risk needs the owner's yes. Only `read` does not, and only for a tool on the server's allowlist. */
export function askFirst(risk: ActionRisk): boolean {
  return ASK_FIRST.includes(risk);
}

/**
 * v2.1. One thing the brain may use in agent mode: a tool of the CLI's own (`WebSearch`, `WebFetch`, `Read`, …) or a connected service
 * (an MCP server from the owner's allowlist). Nothing is on that the owner's configuration did not offer; `on` is this
 * session's choice (`/tools`). `reads` is true when everything it does only reads: such a tool runs without asking.
 */
export interface ToolChoice {
  readonly name: string;
  readonly kind: 'tool' | 'service';
  readonly gist: string;
  readonly on: boolean;
  readonly reads: boolean;
}

/** v2.1. The steward's own account of where the product stands, short and in the present tense. Each list is lines of plain words. */
export interface AppStatus {
  readonly live: readonly string[];
  readonly building: readonly string[];
  readonly waiting: readonly string[];
  /** ISO time the file was last changed; null when there is no file */
  readonly updated: string | null;
}

/** `waiting`: it needs the owner's yes, or the owner's own hands (a sign-in, a code). `denied`: the owner said no, or did not answer. */
export type ActivityState = 'running' | 'done' | 'failed' | 'waiting' | 'denied';

/**
 * v2.1, the live critic. What a judge that can see made of one resting picture. The same rubric the battery's judge is asked
 * (`rubric` is its hash), so a finding in real use and a score in a measured run mean the same thing.
 */
export interface CriticFinding {
  readonly turn: string;
  /** the pass it looked at: the turn's last */
  readonly pass: number;
  /** 1 (it does not read) to 5 (it could not be clearer) */
  readonly coherence: number;
  readonly readable: boolean;
  /** what was drawn is what was asked for */
  readonly asked: boolean;
  /** what is wrong, worst first (raised ones before held-back ones), each in one sentence a builder could act on; `id` when it is about one thing on stage */
  readonly problems: readonly CriticProblem[];
  /** what would most improve the picture, at most three, each one thing to add or change; empty: nothing worth a pass */
  readonly suggestions: readonly string[];
  readonly rubric: string;
  readonly model: string;
  readonly ms: number;
  readonly costUsd: number | null;
  /** what the look used, from the CLI's result event; absent on findings logged before it was recorded */
  readonly usage?: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly thinkingTokens: number | null;
    readonly costUsd: number | null;
    readonly ms: number;
  };
  /** critic v2: every gate the judge was asked, each pass or fail with the evidence for it. Absent on findings logged before the gates. */
  readonly gates?: readonly CriticGate[];
  /** critic v2: the lowest tier with a failing gate (1 on stage and readable, 2 answers the ask, 3 polish and taste); null when every gate of every tier passed */
  readonly failedTier?: CriticTier | null;
  /** critic v2: the answer is a mock-up, so the worst-case gate was asked */
  readonly mockup?: boolean;
  /** critic v2: the coherence the judge gave, when the gates moved it (a tier that fails caps it; a failure of polish alone does not take it under 3) */
  readonly judgedCoherence?: number;
  /** critic v2: for an in-place follow-up on the answer the critic had already judged: how this picture stands against that verdict */
  readonly previous?: { readonly turn: string; readonly coherence: number; readonly failedTier: CriticTier | null; readonly failed: readonly string[] } | null;
  readonly progress?: { readonly trend: 'better' | 'worse' | 'same' | 'mixed'; readonly fixed: readonly string[]; readonly stillFailing: readonly string[]; readonly newFailures: readonly string[]; readonly note: string } | null;
  /** critic v2: gates that failed here and in earlier turns of the session, counted by the server, never by the judge */
  readonly repeats?: readonly { readonly gate: string; readonly count: number; readonly turns: readonly string[] }[];
}

export type CriticTier = 1 | 2 | 3;
/** who owns the fix: the brain's content, the painter's layout, the kit (shapes, structures, type), the app host (web app, page, device) or the prompt */
export type CriticOwner = 'brain' | 'painter' | 'kit' | 'host' | 'prompt';

export interface CriticGate {
  /** a fixed id, never reworded: on-stage, readable, no-overlap (tier 1); answers-ask, hierarchy, composition (tier 2); polish, taste (tier 3); worst-case (a mock-up's note, never an alarm) */
  readonly gate: string;
  readonly tier: CriticTier;
  readonly pass: boolean;
  /** what and where in the picture (an element id when the stage report gives one) */
  readonly evidence: string;
}

export interface CriticProblem {
  readonly id: string | null;
  readonly what: string;
  readonly weight: 'blocks' | 'hurts' | 'polish';
  /** critic v2: the gate it fails */
  readonly gate?: string;
  readonly tier?: CriticTier;
  /** critic v2: what and where in the picture */
  readonly evidence?: string;
  readonly owner?: CriticOwner;
  /** critic v2: false when a lower tier fails (or it is a worst-case note): logged, never an alarm; its weight is then `polish` */
  readonly raised?: boolean;
  /** critic v2: the weight the judge gave it before the gates held it back or lifted it */
  readonly judgedWeight?: 'blocks' | 'hurts' | 'polish';
}

/**
 * v2.1. What an answer puts on stage, counted from its schedule at rest: what a fix may not take away. Counted by `contentOf`
 * (language) on both sides, so the server's refusal and the painter's report agree.
 */
export interface ContentCount {
  readonly structures: number;
  /** nodes, links and rows of every structure, charts' rows included */
  readonly parts: number;
  readonly drawn: number;
  readonly controls: number;
  /** characters of text a viewer can read, choices left out */
  readonly words: number;
  /** the words of every choice (a tap element) on stage, in the order they were written: a fix may not drop or reword one. Absent from a painter of v2.1 before this; read as none. */
  readonly choices?: readonly string[];
  /** how many words on stage say what other words on stage already say (two labels "your turn"): a fix may not add one. Absent from a painter before this; read as none. */
  readonly dupes?: number;
  /** the first words said twice, for the refusal to name */
  readonly dupeOf?: string;
}

/**
 * v2.1. Pictures the user gives with a prompt: what is taken, and how much. `types` are checked by the file's own bytes, never by the name or
 * the Content-Type; a HEIC (an iPhone's) is converted. Whatever is taken is stored as a JPEG with no metadata, `storedSide` pixels on its longest side at most.
 */
export const UPLOAD_LIMITS = { bytes: 12_000_000, perTurn: 10, perSession: 60, maxSide: 8192, storedSide: 2048, types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] } as const;

/** v2.1. Voice notes: recorded in the page (at most `seconds` long), read on the owner's Mac, on the device, and never sent anywhere. */
export const VOICE_LIMITS = { bytes: 8_000_000, seconds: 120, perTurn: 4, perSession: 40, types: ['audio/wav', 'audio/mp4', 'audio/x-caf', 'audio/mpeg'] } as const;

/** v2.1. What the server says of a voice note it has read. `id` (`n1`, `n2`, ...) is what `TurnInput.voice` names. The audio is deleted unless `kept`. */
export interface VoiceResponse {
  readonly id: string;
  readonly text: string;
  readonly seconds: number;
  /** which recogniser read it: only ever `on-device` */
  readonly recogniser: 'on-device';
  readonly locale: string;
  readonly kept: boolean;
}

/** v2.1. Whether voice notes can be read here, without asking for anything. `problem` is a sentence a person can act on. */
export interface VoiceStatus {
  readonly available: boolean;
  /** `ready`; or why not: `off` (VOICE=off), `unsupported` (no Swift or no Speech here), `permission_not_determined`, `permission_denied`, `permission_restricted`, `on_device_unsupported`, `recogniser_unavailable` */
  readonly state: string;
  readonly problem: string | null;
  readonly locale: string | null;
}

/** v2.1. What the server says of a picture it has taken. `id` (`u1`, `u2`, …) is what `TurnInput.images` and `pic … from=` name. */
export interface UploadResponse {
  readonly id: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** a photo given with a crop (`?crop=x,y,w,h`): the whole page, kept beside the cropped part this response is about, for framing again */
  readonly whole?: UploadResponse;
}

/**
 * v2.1. A part of a photo, as fractions (0 to 1) of its width and height from the top left of the photo as it stands upright: `x`, `y` the corner, `w`, `h`
 * the size, at least 0.02 each. A parent framing one question from a whole page gives this, with the upload (`?crop=x,y,w,h`) or later by id (`API.uploadCrop`).
 */
export interface UploadCrop {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * v2.1. What the app itself answers to, typed with a leading `/`. One list: the prompt bar's `/help` prints it and the brief's "this
 * app" note is made from it, so the brain can point at a command and can never invent one. A command is handled by the app and never
 * reaches the brain.
 */
export const APP_COMMANDS = [
  { name: 'help', args: '', gist: 'what you can type here' },
  { name: 'model', args: `<${BRAIN_MODELS.join('|')}>`, gist: 'the model that answers, for this conversation; bare shows it' },
  { name: 'effort', args: `<${BRAIN_EFFORTS.join('|')}>`, gist: 'how hard it thinks before it writes; bare shows it' },
  // Hidden from /help, the picker and the brain's note: the brain always has its tools and always asks first; `steward` is the developer's own mode (STEWARD=on).
  { name: 'brain', args: `<${BRAIN_MODES.join('|')}>`, gist: 'agent: the brain can act, and asks first (always). steward: the steward answers' },
  { name: 'tools', args: '[name on|off | auto | ask]', gist: 'what the brain may use in agent mode (web search, connected services); bare lists them; auto lets its browser reads, writes and runs go without asking (sending, buying, deleting, posting and sign-in pages still ask), ask brings every prompt back' },
  { name: 'new', args: '', gist: "what is new in this app, shown live" },
  { name: 'status', args: '', gist: 'what is live, what is being built and what is waiting on you' },
  { name: 'asks', args: '[clear]', gist: 'what you asked to hold for every reply; clear forgets them' },
  { name: 'look', args: '<name>', gist: 'the look of the stage; bare lists them' },
  { name: 'review', args: '<on|off|repair on|repair off>', gist: 'whether a drawing is checked and fixed after its first draft; "repair" whether an answer the critic found broken is tidied after it is shown (on by default)' },
  { name: 'undo', args: '', gist: 'put the drawing back as it was before the last change that touched it; again goes back one more' },
  { name: 'stop', args: '', gist: 'stop what is being written or made better' },
  { name: 'usage', args: '', gist: 'what the model calls have used, per hour and per day, and where the hour stands against the cap you set' },
  { name: 'stop-all', args: '[resume]', gist: 'stop everything now, in every conversation: answers, questions waiting for you, helper processes. Agent tools stay off until "/stop-all resume"' },
  { name: 'show-all', args: '', gist: 'show the whole answer at once' },
  { name: 'copy', args: '[script]', gist: 'copy the answer as text, or its Series script' },
  { name: 'export', args: '<png|svg|film|conversation|pdf|script>', gist: 'save the answer as a picture, a film, its slides or its script, or the whole conversation as a film' },
  { name: 'lines', args: '[on|off]', gist: 'show the lines of Series as they arrive, beside the stage; a film then has them too' },
  { name: 'capture', args: '', gist: 'film the last answer for the steward to watch' },
] as const satisfies readonly { readonly name: string; readonly args: string; readonly gist: string; readonly needs?: 'refine' }[];
export type AppCommandName = (typeof APP_COMMANDS)[number]['name'];

/**
 * The commands this app can really do right now. Every command is the app's own today; the services are the place to leave one out until the server
 * says it has what it needs (an app that advertises what it cannot do sends the user into an error).
 */
export function commandsFor(_services?: Pick<Services, 'refine'>): readonly (typeof APP_COMMANDS)[number][] {
  return APP_COMMANDS.filter((command) => !HIDDEN_COMMANDS.includes(command.name));
}

/** Commands that work but are not listed: not in `/help`, not in the brain's note of the app (which is held to a token budget). `/brain` is the developer's (`/brain steward`); `/lines` is for whoever is watching, and the [+] menu says it. */
export const HIDDEN_COMMANDS: readonly AppCommandName[] = ['brain', 'lines'];

/** SK1. Where a skill was found; the first holder of a name wins. */
export type SkillSource = 'user' | 'synced';
/** SK1. `on` can be held; the rest say why not: switched off in Claude Code, another of that name comes first, or unreadable. */
export type SkillState = 'on' | 'off-claude' | 'shadowed' | 'unreadable';
export const SKILL_HOLD = { held: 2, idChars: 90 } as const;

/** SK1. One skill as the page lists it. Never carries a path, a hash or any of the skill's text. */
export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly source: SkillSource;
  /** the whole description, for the person */
  readonly description: string;
  /** 90 characters at most, cut at a word */
  readonly brief: string;
  readonly size: number;
  readonly tokens: number;
  readonly state: SkillState;
  /** a sentence on why it cannot be held, when it cannot */
  readonly note?: string;
  readonly hasScripts: boolean;
  /** its text leans on shell commands, which the brain cannot run here */
  readonly knowHowOnly: boolean;
  /** it names tools this app does not have */
  readonly needsApp: boolean;
}

export interface SkillsView {
  readonly skills: readonly SkillSummary[];
  /** said instead of a list when this server's brain cannot use the owner's skills (the Codex brain); the list is then empty */
  readonly note?: string;
}

export interface StartTurnResponse {
  readonly turn: string;
  /** v2.1 ops. Said when the hour's model spending is near, or past, the cap the owner set (`USAGE_HOURLY_CAP`); the turn goes ahead whatever it says. */
  readonly warning?: string;
}

/** v3. One line of a document's outline in the catalogue: a node that is not itself a lesson way, with what is under it. */
export interface OutlineItem {
  readonly id: NodeId;
  readonly title: string;
  readonly depth: number;
  readonly status: NodeStatus;
  /** children that hold a lesson: the ways written for it */
  readonly ways: number;
  readonly tags: readonly string[];
  readonly done: boolean;
}

/** v3 (2.11). A document as the catalogue lists it. Held in `<DATA_DIR>/documents/index.json`; never holds a photo or anything read from one beyond the question's own words. */
export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
  /** ISO time the conversation began; null when it is not known */
  readonly created: string | null;
  /** ISO time the document last changed */
  readonly updated: string;
  /** the session logs the document is folded from, oldest first: a document opened again continues in a later file */
  readonly files: readonly string[];
  readonly nodes: number;
  /** nodes whose body is a lesson */
  readonly lessons: number;
  /** named and not written: nothing under them yet */
  readonly outlined: number;
  readonly done: number;
  readonly cursor: NodeId;
  readonly outline: readonly OutlineItem[];
  /** by technique: the nodes tagged with each, for the catalogue's second listing */
  readonly techniques: readonly { readonly tag: string; readonly nodes: readonly NodeId[] }[];
  /** a picture of the furthest place reached; null until the page has made one */
  readonly thumbnail: string | null;
  /** a session is making it now */
  readonly live: boolean;
}

/** v3. What her hand wrote for one ask of a document: the paper as it stands (`n` 0) or the strokes of a try (`n` 1…), and the lines the reader made of them. */
export interface DocumentInk {
  readonly node: string;
  readonly ask: string;
  readonly n: number;
  readonly at: number;
  readonly text: string;
  readonly doc: InkDocument;
}

/** v3. A document with the person's place, tries and answers in it. */
export interface DocumentView {
  readonly document: Document;
  readonly state: DocState;
  readonly summary: DocumentSummary;
}

/** v3. The answer to opening a document again: a new session, bound to it, and what to draw. */
export interface OpenDocumentResponse extends CreateSessionResponse {
  readonly view: DocumentView;
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
  /** SK1. GET: the owner's skills as a `SkillsView`; `?refresh=1` reads the folders again. Read only. */
  skills: '/api/skills',
  demos: '/api/demos',
  sessions: '/api/sessions',
  stream: (session: string): string => `/api/sessions/${session}/stream`,
  turns: (session: string): string => `/api/sessions/${session}/turns`,
  events: (session: string): string => `/api/sessions/${session}/events`,
  /** GET: this session's `BrainChoice`. PUT a `BrainChange`: sets it for this session only and answers the new `BrainChoice`; the next turn starts a fresh process. */
  brain: (session: string): string => `/api/sessions/${session}/brain`,
  /** GET: the bytes of a painting. The id is in the `asset` event's url; nothing builds this path by hand. */
  asset: (session: string, asset: string): string => `/api/sessions/${session}/assets/${asset}`,
  /** POST image/png: the painter's rendering of the sketch a picture element stands on. `key` is the element key. */
  sketch: (session: string, key: string): string => `/api/sessions/${session}/sketches/${encodeURIComponent(key)}`,
  /** POST image/jpeg: what the stage looked like when a turn came to rest. GET: the same picture back. */
  snapshot: (session: string, turn: string): string => `/api/sessions/${session}/turns/${turn}/snapshot`,
  /** POST image/jpeg: the stage as pass `pass` of an open turn will leave it: what the brain is shown when it looks at its draft. */
  draft: (session: string, turn: string, pass: number): string => `/api/sessions/${session}/turns/${turn}/drafts/${pass}`,
  /** SA4. POST image/jpeg: the picture of the stage the brain asked for with a `want` event (`request` is the event's). 204. */
  look: (session: string, request: string): string => `/api/sessions/${session}/looks/${request}`,
  /** v2.1. GET `VoiceStatus` (no permission is asked for); POST (`/voice/:session`) a recording (WAV, M4A, CAF or MP3, `VOICE_LIMITS`): 201 `VoiceResponse`, the words as read on this Mac. */
  voiceStatus: '/api/voice',
  voice: (session: string): string => `/api/sessions/${session}/voice`,
  /** v2.1. POST an image (`UPLOAD_LIMITS`): 201 `UploadResponse`. The picture is the session's and goes nowhere else. */
  uploads: (session: string): string => `/api/sessions/${session}/uploads`,
  /** v2.1. GET: the bytes of a picture the user gave, by its id. Same origin; what `pic … from=` draws. */
  upload: (session: string, id: string): string => `/api/sessions/${session}/uploads/${encodeURIComponent(id)}`,
  /** v2.1. POST `UploadCrop` as JSON: a new photo that is that part of this one (201 `UploadResponse`, with its own id); this one is left as it was, so the page can be framed again. */
  uploadCrop: (session: string, id: string): string => `/api/sessions/${session}/uploads/${encodeURIComponent(id)}/crop`,
  /** v2.1. POST video/webm: a film of a turn made in the page (`/capture`), saved beside the session's log for the steward to watch. 204. */
  capture: (session: string, turn: string): string => `/api/sessions/${session}/turns/${turn}/capture`,
  /** v2.2. GET: the bytes of a photograph the server found for an `image` part (a JPEG, re-encoded, cached). The key is in the `picture` event's url. */
  picture: (key: string): string => `/api/pictures/${key}`,
  /** v2.2. GET `?q=<words>&aspect=<w over h>`: a photograph for a live app's `conduit.picture`. `{ found: false }` when the picture service is off or found nothing, else `{ found: true, url, credit, landing }` with `url` as `API.picture`. */
  pictureSearch: '/api/picture-search',
  /** v2.1. GET: `AppStatus`, read from the steward's `STATUS.md`. What `/status` shows and what the brief's "this app" note is made from. */
  status: '/api/status',
  /** v2.1 ops. POST: the kill switch (`/stop-all`): every turn ended, every question waiting for the owner refused, every helper process killed, agent tools off. GET: whether they are off. DELETE: switches them back on. */
  kill: '/api/kill',
  /** v2.1 ops. GET: what the server's model calls have used, per hour and per day, and where the hour stands against the cap (`UsageSummary`). What `/usage` shows. */
  usage: '/api/usage',
  /** v2.1. GET: this session's `ToolChoice[]`. PUT `{ name, on }`: switches one tool or connected service for this session; answers the list. */
  tools: (session: string): string => `/api/sessions/${session}/tools`,
  /** v2.1. GET: `{ asks: string[] }`, what the user asked to hold on every reply. DELETE `{}` forgets them all, `{ drop: n }` the nth (from 1); answers the same. */
  asks: (session: string): string => `/api/sessions/${session}/asks`,
  /** v2.1. GET: what the critic made of a turn (`CriticFinding`), 404 until it has looked. */
  critic: (session: string, turn: string): string => `/api/sessions/${session}/turns/${turn}/critic`,
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
  /** v3. GET: the catalogue, `DocumentSummary[]`, newest first: every conversation that made a document, from the index in the data folder. */
  documents: '/api/documents',
  /** v3. GET: one document and the person's state in it as `DocumentView`, folded from the log if it is not live. 404 for one that is not in the catalogue. */
  document: (id: string): string => `/api/documents/${id}`,
  /** v3. POST a `CreateSessionRequest`: opens the document again in a new session (after a restart, or from the catalogue). 201 `OpenDocumentResponse`. */
  documentOpen: (id: string): string => `/api/documents/${id}/open`,
  /** v3. POST `{ image, node, ask }` (the upload id of the picture of the ink): reads what a hand wrote in an ask's answer area. 200 `{ text, lines, unclear }`. */
  readInk: (session: string): string => `/api/sessions/${session}/read-ink`,
  /** v3. POST `{ node, ask, n, text, doc }` (an `InkDocument`): keeps her strokes with the session's document (`n` 0: the paper as it stands; 1…: that try). 204. */
  keepInk: (session: string): string => `/api/sessions/${session}/ink`,
  /** v3. GET: every stroke kept with a document, latest of each (node, ask, n), as `DocumentInk[]`. */
  documentInk: (id: string): string => `/api/documents/${id}/ink`,
  /** v3. GET: the cut of the photo a question sits on, kept with the document (a JPEG); 404 when none was cut. `node` is the question's id, encoded. */
  documentCrop: (id: string, node: string): string => `/api/documents/${id}/crop?node=${encodeURIComponent(node)}`,
  /** v3. GET: the document this session is making or has reopened, as `DocumentView`; 404 until it has one. */
  sessionDocument: (session: string): string => `/api/sessions/${session}/document`,
  relayNext: '/api/relay/next',
  relayGuide: '/api/relay/guide',
  relayStatus: '/api/relay/status',
  relayLines: (turn: string): string => `/api/relay/turns/${turn}/lines`,
  relayEnd: (turn: string): string => `/api/relay/turns/${turn}/end`,
  relayEvents: (turn: string): string => `/api/relay/turns/${turn}/events`,
} as const;
