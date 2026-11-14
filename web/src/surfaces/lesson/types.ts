// The lesson view's types. Two halves:
//
//  1. STUB (WS3, PLAN-v3-core 2.1 and 2.10): the document types as the plan writes them, and the lesson's steps and visuals. Until `L/document.ts` and
//     `L/lesson.ts` land, this file is where they live; moving onto WS3's file is a change of import paths and nothing else. Every shape here is
//     the plan's, narrowed to what a lesson needs (`scene` and `app` bodies are carried but never read).
//  2. The surface protocol (2.6) and the lesson's own messages: what the page tells the lesson and what the lesson tells the page.
//
// Nothing here imports the DOM, so the model, the matcher and the widgets' maths can run under `tsx`.

export type NodeId = string;

// ---------------------------------------------------------------- STUB (WS3): visuals, techniques, steps

export const VISUAL_KINDS = ['numberline', 'groups', 'blocks', 'bar', 'coins', 'clock'] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];
export function isVisualKind(kind: string | null): kind is VisualKind {
  return kind !== null && (VISUAL_KINDS as readonly string[]).includes(kind);
}

/** Written `show=numberline 0..70 mark=64 hops=-10,-10,-10`; read by WS3's parser, built by hand here. */
export type VisualSpec =
  | { readonly kind: 'numberline'; readonly from: number; readonly to: number; readonly tick: number; readonly mark: number | null; readonly hops: readonly number[] }
  | { readonly kind: 'groups'; readonly groups: number; readonly of: number; readonly parts: readonly number[]; readonly start: number; readonly noun: string; readonly thing: string }
  | { readonly kind: 'blocks'; readonly tens: number; readonly ones: number }
  | { readonly kind: 'bar'; readonly of: number; readonly n: number; readonly parts: readonly number[] }
  | { readonly kind: 'coins'; readonly coins: readonly number[] }
  | { readonly kind: 'clock'; readonly minutes: number };

export const TECHNIQUES = ['draw-it', 'share-it-out', 'count-on-a-line', 'make-ten', 'break-it-apart', 'find-the-pattern', 'read-the-question', 'work-backwards'] as const;
export type Technique = (typeof TECHNIQUES)[number];
export const TECHNIQUE_NAMES: Readonly<Record<Technique, string>> = {
  'draw-it': 'Draw it',
  'share-it-out': 'Share it out',
  'count-on-a-line': 'Count on a line',
  'make-ten': 'Make ten',
  'break-it-apart': 'Break it apart',
  'find-the-pattern': 'Find the pattern',
  'read-the-question': 'Read the question',
  'work-backwards': 'Work backwards',
};
export function isTechnique(tag: string | null): tag is Technique {
  return tag !== null && (TECHNIQUES as readonly string[]).includes(tag);
}

/** What the server keeps of a step (WS4's `LessonStep`, in `language/src/doc-spine.ts`): `show` is the line's own words, read by `parseShow`. */
export type DocStep =
  | { readonly kind: 'step'; readonly id: string; readonly show: string | null; readonly words: string }
  | { readonly kind: 'ask'; readonly id: string; readonly accepted: readonly string[]; readonly pick: readonly string[] | null; readonly unit: string | null; readonly prompt: string; readonly hints: readonly string[] };

/** The lesson's own reading of a step: the picture parsed, and whether the verifier disputes the ask (the way's node is `refused`, 2.9). */
export interface Reveal {
  readonly kind: 'step';
  readonly id: string;
  readonly words: string;
  readonly show: VisualSpec | null;
}
export interface Ask {
  readonly kind: 'ask';
  readonly id: string;
  readonly prompt: string;
  /** every answer that is right, as written ("34", "thirty four", "34 cm"): the matcher reads them */
  readonly accepted: readonly string[];
  /** large choices instead of a field */
  readonly pick: readonly string[] | null;
  readonly unit: string | null;
  /** one is shown a wrong try */
  readonly hints: readonly string[];
  /** the verifier disputes the answer: it is never checked, only worked through */
  readonly refused: boolean;
}
export type ViewStep = Reveal | Ask;

// ---------------------------------------------------------------- STUB (WS3): the document (2.1)

export type Status = 'outlined' | 'filling' | 'filled' | 'verified' | 'refused';
export type Body = null | { readonly kind: 'scene'; readonly segments: readonly unknown[] } | { readonly kind: 'lesson'; readonly steps: readonly DocStep[] } | { readonly kind: 'app'; readonly program: string; readonly code: string; readonly version: number };

export interface DocNode {
  readonly id: NodeId;
  readonly parent: NodeId | null;
  readonly title: string;
  readonly tag: string | null;
  readonly children: readonly NodeId[];
  readonly body: Body;
  readonly status: Status;
}
export interface Document {
  readonly id: string;
  readonly title: string;
  readonly root: NodeId;
  readonly nodes: Readonly<Record<NodeId, DocNode>>;
  readonly defs: Readonly<Record<string, never>>;
}

export type Play = number | { readonly at: number };
export interface Cursor {
  readonly node: NodeId;
  readonly play: Play;
}
/** What a hand holds in a leaf: plain JSON, as WS4 keeps it. */
export type Held = string | number | boolean | null | readonly Held[] | { readonly [key: string]: Held };
export interface NodeProgress {
  /** the furthest stop shown */
  readonly seen: number;
  /** every answer tried, in order, per ask; the sentinel WORKED is a try she took the worked-through step on */
  readonly tries: Readonly<Record<string, readonly string[]>>;
  readonly done: boolean;
}
export type Progress = NodeProgress;
export interface DocState {
  readonly cursor: Cursor;
  readonly held: Readonly<Record<NodeId, Readonly<Record<string, Held>>>>;
  readonly progress: Readonly<Record<NodeId, NodeProgress>>;
}

/** A try that is no answer: she asked to be shown the next step (hints used up, or the ask is refused). */
export const WORKED = '~worked';

/** What a hand can change in a lesson (WS3's `LeafChange` and `Nav`, narrowed). */
export type LessonChange =
  | { readonly kind: 'goto'; readonly node: NodeId; readonly at: number }
  | { readonly kind: 'try'; readonly node: NodeId; readonly ask: string; readonly text: string }
  | { readonly kind: 'hold'; readonly node: NodeId; readonly key: string; readonly value: Held };

/** STUB (WS4, `language/src/doc-spine.ts` and `wire.ts`): what the page sends up as state, and the catalogue's summaries, as the server defines them. */
export type StateChange =
  | { readonly kind: 'cursor'; readonly cursor: Cursor }
  | { readonly kind: 'held'; readonly node: NodeId; readonly key: string; readonly value: Held }
  | { readonly kind: 'try'; readonly node: NodeId; readonly ask: string; readonly value: string; readonly right: boolean }
  | { readonly kind: 'seen'; readonly node: NodeId; readonly seen: number }
  | { readonly kind: 'done'; readonly node: NodeId; readonly done: boolean }
  | { readonly kind: 'sync'; readonly seen: { readonly cursor: Cursor; readonly held: DocState['held'] } };
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

// ---------------------------------------------------------------- the surface protocol (2.6), as the lesson speaks it

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
  readonly questions: readonly { readonly id: NodeId; readonly title: string; readonly done: boolean; readonly techniques: readonly Technique[] }[];
}

/** What the page gives the lesson to draw. */
export interface LessonInput {
  readonly doc: Document;
  readonly state: DocState;
  /** a question's own crop of the photo it came from, as a picture the sandbox may show (a data: address) */
  readonly crops: Readonly<Record<NodeId, string>>;
  readonly catalogue: readonly CatalogueEntry[];
}

/** What the lesson tells the page happened: each becomes a back event with `seen` (2.5). */
export type LessonEvent =
  | { readonly kind: 'open'; readonly node: NodeId }
  | { readonly kind: 'step'; readonly node: NodeId; readonly at: number }
  | { readonly kind: 'try'; readonly node: NodeId; readonly ask: string; readonly text: string; readonly right: boolean; readonly hint: number }
  | { readonly kind: 'worked'; readonly node: NodeId; readonly ask: string }
  | { readonly kind: 'done'; readonly node: NodeId }
  | { readonly kind: 'hold'; readonly node: NodeId; readonly key: string; readonly value: Held }
  | { readonly kind: 'document'; readonly id: string };

export type LessonDown =
  | { readonly type: 'init'; readonly tokens: LessonTokens; readonly input: LessonInput }
  | { readonly type: 'data'; readonly input: LessonInput }
  | { readonly type: 'theme'; readonly tokens: LessonTokens }
  | { readonly type: 'ping' }
  | { readonly type: 'shoot'; readonly id: number };

export type LessonUp =
  | { readonly type: 'ready' }
  | { readonly type: 'pong' }
  | { readonly type: 'save'; readonly state: DocState }
  | { readonly type: 'emit'; readonly event: LessonEvent }
  | { readonly type: 'size'; readonly height: number }
  | { readonly type: 'fault'; readonly message: string }
  | { readonly type: 'census'; readonly census: LessonCensus }
  | { readonly type: 'still'; readonly id: number; readonly width: number; readonly height: number; readonly data: string | null };

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
  readonly view: 'outline' | 'question' | 'play' | 'catalogue';
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
