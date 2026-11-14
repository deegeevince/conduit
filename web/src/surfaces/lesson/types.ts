// The lesson view's types: what it draws (WS3's document and lesson types, from `@conduit/language`), what the widgets are given, and the
// surface protocol (PLAN-v3-core 2.6) the page and the lesson speak. Nothing here imports the DOM.

import { VISUAL_KINDS } from '@conduit/language';
import type { DocState, Document, NodeId, NodeStatus, TechniqueId, VisualKind } from '@conduit/language';

export type { DocState, Document, Held, NodeId, StateChange, VisualKind, LessonStep, LessonAsk, LessonReveal, ShowSpec, OpenAsk } from '@conduit/language';
export type Technique = TechniqueId;

export function isVisualKind(kind: string | null): kind is VisualKind {
  return kind !== null && (VISUAL_KINDS as readonly string[]).includes(kind);
}
export function isTechnique(tag: string | null): tag is TechniqueId {
  return tag !== null && Object.hasOwn(TECHNIQUE_NAMES, tag);
}

/** The human names of the ways of going at a question: what a way's card and tab say. (WS3's `TECHNIQUE` holds the words the brain is taught.) */
export const TECHNIQUE_NAMES: Readonly<Record<TechniqueId, string>> = {
  'draw-it': 'Draw it',
  'share-it-out': 'Share it out',
  'count-on-a-line': 'Count on a line',
  'make-ten': 'Make ten',
  'break-it-apart': 'Break it apart',
  'find-the-pattern': 'Find the pattern',
  'read-the-question': 'Read the question',
  'work-backwards': 'Work backwards',
};

/** What a widget is given: a step's `show=` read into numbers (`visual.ts`). */
export type VisualSpec =
  | { readonly kind: 'numberline'; readonly from: number; readonly to: number; readonly tick: number; readonly mark: number | null; readonly hops: readonly number[] }
  | { readonly kind: 'groups'; readonly count: number; readonly each: number; readonly parts: readonly number[]; readonly label: string }
  | { readonly kind: 'blocks'; readonly tens: number; readonly ones: number }
  | { readonly kind: 'bar'; readonly parts: readonly (number | null)[]; readonly total: number | null }
  | { readonly kind: 'coins'; readonly coins: readonly number[]; readonly target: number | null }
  | { readonly kind: 'clock'; readonly minutes: number }
  | { readonly kind: 'ruler'; readonly mm: readonly number[] };

export type Status = NodeStatus;

/** STUB (WS4, `language/src/wire.ts`): one line of a document's outline, and the catalogue's summary of a document, as `GET /api/documents` gives them. */
export interface OutlineItem {
  readonly id: NodeId;
  readonly title: string;
  readonly depth: number;
  readonly status: Status;
  readonly ways: number;
  readonly tags: readonly string[];
  readonly done: boolean;
}
export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly updated: string;
  readonly cursor: NodeId;
  readonly outline: readonly OutlineItem[];
}


export interface LessonTokens {
  readonly ground: string;
  /** what a card or a plate is drawn on */
  readonly card: string;
  /** passes 4.5:1 on ground */
  readonly ink: string;
  readonly dim: string;
  readonly accent: string;
  readonly onAccent: string;
  readonly soft: string;
  readonly line: string;
  readonly good: string;
  readonly goodSoft: string;
  readonly nudge: string;
  readonly nudgeSoft: string;
  readonly font: string;
  readonly dark: boolean;
}

/** One sheet, as the catalogue lists it (the server's index, WS4, read into this). */
export interface CatalogueEntry {
  readonly id: string;
  readonly title: string;
  readonly updated: number;
  readonly current: boolean;
  readonly questions: readonly { readonly id: NodeId; readonly title: string; readonly done: boolean; readonly techniques: readonly TechniqueId[] }[];
}

/** What the page gives the lesson to draw. */
export interface LessonInput {
  readonly doc: Document;
  readonly state: DocState;
  /** a question's own crop of the photo it came from, as a picture the sandbox may show (a data: address) */
  readonly crops: Readonly<Record<NodeId, string>>;
  /** a painted scene's still, or an app's: what the page has drawn of it, as a data: address */
  readonly stills: Readonly<Record<NodeId, string>>;
  readonly catalogue: readonly CatalogueEntry[];
  /** the page has a picture under the document: the view offers a way back to it */
  readonly picture?: boolean;
  /** the page lays an ink area over the writing slot (`data-ink-slot`) of an open ask: the lesson draws a blank paper there and a Check that asks the page to read it, with the typed field one tap away */
  readonly ink?: boolean;
  /** what her hand wrote for each try of an ask (`node`, a NUL, `ask`): a small picture of the strokes and the words read from them; shown with the ask */
  readonly working?: Readonly<Record<string, readonly { readonly n: number; readonly text: string; readonly src: string }[]>>;
}

/** What the page read from her hand: `text` is her working as lines (a try); null says it could not be read, with a sentence for her. `seq` counts, so it is taken once. */
export interface WriteResult {
  readonly seq: number;
  readonly node: NodeId;
  readonly ask: string;
  readonly text: string | null;
  readonly said?: string;
}

/**
 * What the page gives the lesson, riding the host's `data` message (the look's tokens object carries it: the host forwards the whole object).
 * `rev` counts: the lesson takes only a payload newer than the last. `replace` says the state in `input` is the truth (a document opened again);
 * otherwise the lesson keeps its own. `census` counts the page's requests for the summary of what is on screen.
 */
export interface LessonPayload {
  readonly rev: number;
  readonly tokens: LessonTokens;
  readonly input: LessonInput;
  readonly replace: boolean;
  readonly census: number;
  /** the page has read what she wrote by hand in an ask (or could not): the lesson tries it as her answer */
  readonly write?: WriteResult;
}

// ---------------------------------------------------------------- the census (2.8): what is on screen, as data

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface CensusWord {
  readonly text: string;
  readonly px: number;
  readonly contrast: number;
  readonly where: string;
}
export interface CensusTarget extends Rect {
  /** the `data-act` the lesson put on it: what a driver presses */
  readonly act: string;
  readonly label: string;
  readonly kind: 'choice' | 'button' | 'tap' | 'field';
}
export interface LessonCensus {
  readonly view: 'map' | 'part' | 'catalogue';
  readonly node: NodeId;
  readonly viewport: { readonly w: number; readonly h: number; readonly scrollW: number };
  readonly question: { readonly text: string; readonly px: number; readonly box: Rect; readonly onScreen: boolean } | null;
  /** steps on the page against steps she has been shown */
  readonly steps: { readonly shown: number; readonly drawn: number };
  readonly figures: readonly { readonly kind: VisualKind; readonly box: Rect; readonly share: number; readonly least: number | null }[];
  readonly words: readonly CensusWord[];
  readonly targets: readonly CensusTarget[];
  /** answers of open asks, and any place one is on screen */
  readonly sealed: { readonly open: readonly string[]; readonly leaks: readonly string[] };
  /** how long the last try took from the key to the hint on screen, ms */
  readonly tryMs: number | null;
  /** elements that reach past the right edge of the screen (the page must never scroll sideways) */
  readonly wide: readonly string[];
  readonly here: string;
}
