// The document: a tree of parts a mind and a person build together and come back to (PLAN-v3-core 2.1).
//
// This file is the types of it, the fold that makes it from a conversation's log, and `advance`, the one function that writes what the person
// did. It is shared by the server (which keeps it) and the page (which shows it), so it touches no clock and no DOM and throws on nothing.
//
// A flat conversation is a document: the root is one part, every `scene` line opens a scene node under it, and a turn with no `scene` line adds a
// segment to the open scene. Lines of a lesson (`part`, `step`, `ask`, `hint`) build parts, and a part that has steps is a lesson. When a
// conversation has parts, its root is the first part written (a sheet), and what has no other home sits in it.

import { LessonBook, accepts, openAskOf } from './lesson';
import type { Crop, LessonAsk, LessonLine, LessonStep, OpenAsk } from './lesson';
import { LineNormalizer, LineReader } from './normalize';
import { parseLine } from './parse';
import { EMPTY_STAGE } from './schedule';
import type { StageBase } from './schedule';
import { TurnScore } from './score';
import { serializeLine } from './serialize';
import { settle } from './stage';
import type { Issue, Line } from './types';
import type { TurnEndReason, TurnInput } from './wire';

// --- the types -----------------------------------------------------------------------------------------------------------------------

/** A node's place in the document: the brain's ids, joined by `/` from the root part down (`w1/s2/q7/a2`). Scenes are `#1`, `#2`, …; with no part at all the root is `root`. */
export type NodeId = string;

export const NODE_STATUSES = ['outlined', 'filling', 'filled', 'verified', 'refused'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** What a leaf holds for the person: a control's value, a scroll offset, a surface's saved state. Plain data, so it can be logged and replayed. */
export type Held = null | boolean | number | string | readonly Held[] | { readonly [key: string]: Held };

export type { LessonStep } from './lesson';

/** One line of a segment as the log holds it. `floor` is the playhead it arrived at, when the log said (0 when it did not). */
export interface ScriptEntry {
  readonly seq: number;
  readonly line: Line;
  readonly floor: number;
}

/** What the log holds of one turn on one scene. */
export interface Script {
  /** the stage this segment begins from: `settle` of the last one */
  readonly base: StageBase;
  readonly opened: TurnInput['kind'];
  readonly lines: readonly ScriptEntry[];
  /** where play holds, in seconds on this segment's own clock; the last is the end */
  readonly stops: readonly number[];
  readonly closed: null | { readonly at: number; readonly reason: TurnEndReason };
}

export type DocBody =
  /** outlined, not yet written */
  | null
  /** painted: one segment a turn that touched it */
  | { readonly kind: 'scene'; readonly segments: readonly Script[] }
  /** described, drawn by the lesson view */
  | { readonly kind: 'lesson'; readonly steps: readonly LessonStep[] }
  /** programmed (2.6) */
  | { readonly kind: 'app'; readonly program: string; readonly code: string; readonly version: number };

export interface DocNode {
  readonly id: NodeId;
  readonly parent: NodeId | null;
  readonly title: string;
  /** a technique, for the catalogue */
  readonly tag: string | null;
  /** a question's box on the photo it was read from, for the lesson page to crop; absent when none was given */
  readonly crop?: Crop;
  /** a part holds nodes */
  readonly children: readonly NodeId[];
  readonly body: DocBody;
  readonly status: NodeStatus;
}

/** Components, for the day `define` and `use` are read. Always empty today. */
export type Defs = { readonly [name: string]: unknown };

export interface Document {
  readonly id: string;
  readonly title: string;
  readonly root: NodeId;
  readonly nodes: Readonly<Record<NodeId, DocNode>>;
  readonly defs: Defs;
}

/** Seconds on the leaf's clock, or resting at stop `at`. */
export type Play = number | { readonly at: number };

export interface Cursor {
  readonly node: NodeId;
  readonly play: Play;
}

export interface NodeProgress {
  /** how many stops she has reached: the furthest stop, counted from one */
  readonly seen: number;
  /** what she answered to each ask, in order */
  readonly tries: Readonly<Record<string, readonly string[]>>;
  readonly done: boolean;
}

/** What the person did: the one home for it. Logged, persisted, told to the mind. */
export interface DocState {
  readonly cursor: Cursor;
  /** per leaf: control values, scroll, a surface's saved state */
  readonly held: Readonly<Record<NodeId, Readonly<Record<string, Held>>>>;
  readonly progress: Readonly<Record<NodeId, NodeProgress>>;
}

/** What the page saw at the instant a hand acted: the cursor and every held value (2.5). Carried by `tap`, `control` and `act`. */
export interface Seen {
  readonly cursor: Cursor;
  readonly held: DocState['held'];
}

/** The limits on what a page may send up as state. Past them a value is refused, not cut. */
export const STATE_LIMITS = { nodeId: 200, key: 64, heldBytes: 4_096, tryChars: 600, triesPerAsk: 50, seenBytes: 16_384 } as const;

/** The clock moved on: `seconds` on the cursor's leaf. It never leaves the page and is never logged. */
export interface Tick {
  readonly kind: 'tick';
  readonly seconds: number;
}

/** Where the person is: a committed move, as it goes up and is logged. */
export type Nav = { readonly kind: 'cursor'; readonly cursor: Cursor };

/**
 * What a leaf did, committed: a control's value (a drag is local; only its end goes up), an answer tried (`right` is the page's own verdict and
 * is not trusted: `advance` decides it again from the ask), the furthest reveal reached, a node finished or reopened, and where the person stood
 * at an instant (`sync`, for a server that missed one of the others).
 */
export type LeafChange =
  | { readonly kind: 'held'; readonly node: NodeId; readonly key: string; readonly value: Held }
  | { readonly kind: 'try'; readonly node: NodeId; readonly ask: string; readonly value: string; readonly right?: boolean }
  | { readonly kind: 'seen'; readonly node: NodeId; readonly seen: number }
  | { readonly kind: 'done'; readonly node: NodeId; readonly done: boolean }
  | { readonly kind: 'sync'; readonly seen: Seen };

/** What goes up and is logged as a `state` record. */
export type StateChange = Nav | LeafChange;

/**
 * What the player asks for, relative to where the person is: the page runs these through `advance` and sends the committed results (the cursor,
 * the reveal reached) as `StateChange`s. Playing is navigation, so next, back, go to a node, seek and pause are one reducer with the rest.
 */
export type Intent =
  | { readonly kind: 'next' }
  | { readonly kind: 'back' }
  /** the host stops sending ticks; nothing moves. It is an event so that a log can say it. */
  | { readonly kind: 'pause' }
  /** go to a node: at `at`, or (`'resume'`) where she was; absent, a lesson resumes and a scene rests at its end */
  | { readonly kind: 'go'; readonly node: NodeId; readonly at?: Play | 'resume' }
  | { readonly kind: 'seek'; readonly seconds: number }
  /** go to stop `at` of the cursor's leaf */
  | { readonly kind: 'stop'; readonly at: number };

export type DocEvent = Tick | Intent | StateChange;

export const ROOT: NodeId = 'root';

/** Aliases: the plan's own names. */
export type Progress = NodeProgress;
export type NodeBody = DocBody;

// --- reading a document ----------------------------------------------------------------------------------------------------------------

export function emptyDocument(id = 'document', title = 'Untitled'): Document {
  return { id, title, root: ROOT, nodes: { [ROOT]: { id: ROOT, parent: null, title, tag: null, children: [], body: null, status: 'outlined' } }, defs: {} };
}

export function nodeOf(doc: Document, id: NodeId): DocNode | null {
  return Object.hasOwn(doc.nodes, id) ? (doc.nodes[id] ?? null) : null;
}

/** The node the brain's short id names (`q1a` for `w1/s1/q1/q1a`). Ids are unique in a document. */
export function findNode(doc: Document, short: string): DocNode | null {
  for (const node of Object.values(doc.nodes)) {
    if (node.id === short || node.id.endsWith(`/${short}`)) return node;
  }
  return null;
}

/** The nodes from the root's child down to `id`, the node itself last. */
export function pathOf(doc: Document, id: NodeId): readonly DocNode[] {
  const out: DocNode[] = [];
  let at = nodeOf(doc, id);
  while (at !== null && out.length < 64) {
    out.unshift(at);
    at = at.parent === null ? null : nodeOf(doc, at.parent);
  }
  return out;
}

/** The nodes a person can be at, in the order of the document: everything with a body, and every leaf still to be written. */
export function playableNodes(doc: Document): readonly NodeId[] {
  const out: NodeId[] = [];
  const visit = (id: NodeId, depth: number): void => {
    const node = nodeOf(doc, id);
    if (node === null || depth > 64) return;
    if (node.body !== null || node.children.length === 0) out.push(node.id);
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(doc.root, 0);
  return out.length === 0 ? [doc.root] : out;
}

/** Where the segments of a scene sit on its one clock: each begins where the last ended. */
export function sceneStops(node: DocNode): readonly number[] {
  if (node.body === null || node.body.kind !== 'scene') return [0];
  const stops: number[] = [];
  let offset = 0;
  for (const segment of node.body.segments) {
    for (const stop of segment.stops) stops.push(offset + stop);
    offset += segment.closed?.at ?? segment.stops[segment.stops.length - 1] ?? 0;
  }
  return stops.length === 0 ? [0] : stops;
}

/** How many stops a leaf has: a lesson's are its steps, a scene's are where its script holds, anything else one. */
export function stopCount(node: DocNode): number {
  if (node.body === null) return 1;
  if (node.body.kind === 'lesson') return Math.max(1, node.body.steps.length);
  if (node.body.kind === 'scene') return sceneStops(node).length;
  return 1;
}

function lessonOf(doc: Document, id: NodeId): readonly LessonStep[] | null {
  const body = nodeOf(doc, id)?.body ?? null;
  return body !== null && body.kind === 'lesson' ? body.steps : null;
}

const NO_PROGRESS: NodeProgress = { seen: 0, tries: {}, done: false };

export function progressOf(state: DocState, id: NodeId): NodeProgress {
  return Object.hasOwn(state.progress, id) ? (state.progress[id] ?? NO_PROGRESS) : NO_PROGRESS;
}

/** What she has tried and what it came to, for one ask. */
export interface AskView {
  readonly ask: LessonAsk;
  readonly tries: readonly string[];
  /** a try was accepted */
  readonly accepted: boolean;
  /** tries before the accepted one, or all of them, that were not accepted */
  readonly wrong: number;
  /** the hint to show now: the one for her latest wrong try; null before one, and when the ask has none */
  readonly hint: string | null;
  /** every hint is used and she is still not right: the next step works it through with her */
  readonly exhausted: boolean;
  /** the verifier disputed this way's answers: it is never checked, and the next step is let in */
  readonly refused: boolean;
  /** the next step may be shown */
  readonly open: boolean;
}

export function askView(doc: Document, state: DocState, node: NodeId, ask: string): AskView | null {
  const steps = lessonOf(doc, node);
  const found = steps?.find((step): step is LessonAsk => step.kind === 'ask' && step.id === ask);
  if (found === undefined) return null;
  const tries = Object.hasOwn(progressOf(state, node).tries, ask) ? (progressOf(state, node).tries[ask] ?? []) : [];
  const refused = nodeOf(doc, node)?.status === 'refused';
  const right = tries.findIndex((text) => accepts(found, text));
  const accepted = right >= 0;
  const wrong = accepted ? right : tries.length;
  const shown = Math.min(wrong, found.hints.length);
  const exhausted = !accepted && wrong > Math.max(found.hints.length, 1);
  return { ask: found, tries, accepted, wrong, hint: shown === 0 ? null : (found.hints[shown - 1] ?? null), exhausted, refused, open: accepted || exhausted || refused };
}

function gateOpen(doc: Document, state: DocState, node: NodeId, stop: number): boolean {
  const step = lessonOf(doc, node)?.[stop];
  if (step === undefined || step.kind !== 'ask') return true;
  return askView(doc, state, node, step.id)?.open ?? true;
}

/** The stop a cursor rests at, or null when it is playing. */
export function stopOf(cursor: Cursor): number | null {
  return typeof cursor.play === 'number' ? null : cursor.play.at;
}

/** The steps she can see at the cursor: everything up to and including its stop. Nothing written after an ask is among them until it is tried. */
export function revealed(doc: Document, state: DocState, node: NodeId = state.cursor.node): readonly LessonStep[] {
  const steps = lessonOf(doc, node);
  if (steps === null) return [];
  const at = state.cursor.node === node ? (stopOf(state.cursor) ?? 0) : Math.max(0, progressOf(state, node).seen - 1);
  return steps.slice(0, at + 1);
}

/** The asks that are open at the cursor: the answers that must not be on screen (2.6). What draws calls `sealed` with these. */
export function openAsks(doc: Document, state: DocState, node: NodeId = state.cursor.node): readonly OpenAsk[] {
  return revealed(doc, state, node).flatMap((step) => {
    if (step.kind !== 'ask') return [];
    const view = askView(doc, state, node, step.id);
    return view === null || view.open ? [] : [openAskOf(step)];
  });
}

// --- the one writer --------------------------------------------------------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function playOk(play: unknown): play is Play {
  if (typeof play === 'number') return Number.isFinite(play) && play >= 0;
  if (typeof play !== 'object' || play === null || !('at' in play)) return false;
  return typeof play.at === 'number' && Number.isInteger(play.at) && play.at >= 0;
}

function samePlay(a: Play, b: Play): boolean {
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  return a.at === b.at;
}

const EMPTY_NODE: DocNode = { id: '', parent: null, title: '', tag: null, children: [], body: null, status: 'outlined' };

/** Her progress through `node` once she has reached stop `stop`: what she has seen, and whether the leaf is done. */
function reached(doc: Document, state: DocState, node: NodeId, stop: number): NodeProgress {
  const before = progressOf(state, node);
  const n = stopCount(nodeOf(doc, node) ?? EMPTY_NODE);
  const seen = Math.max(before.seen, Math.min(n, stop + 1));
  const steps = lessonOf(doc, node);
  const asksDone = steps === null || steps.every((step) => step.kind !== 'ask' || (askView(doc, state, node, step.id)?.open ?? true));
  return { seen, tries: before.tries, done: before.done || (seen >= n && asksDone) };
}

function put(state: DocState, node: NodeId, progress: NodeProgress): DocState {
  const before = progressOf(state, node);
  if (before.seen === progress.seen && before.done === progress.done && before.tries === progress.tries) return state;
  return { ...state, progress: { ...state.progress, [node]: progress } };
}

function place(doc: Document, state: DocState, cursor: Cursor): DocState {
  const moved: DocState = state.cursor.node === cursor.node && samePlay(state.cursor.play, cursor.play) ? state : { ...state, cursor };
  const stop = stopOf(cursor);
  return stop === null ? moved : put(moved, cursor.node, reached(doc, moved, cursor.node, stop));
}

function tick(doc: Document, state: DocState, seconds: number): DocState {
  const node = nodeOf(doc, state.cursor.node);
  const play = state.cursor.play;
  if (node === null || node.body === null || node.body.kind !== 'scene' || typeof play !== 'number' || !(seconds > 0)) return state;
  const stops = sceneStops(node);
  const arrived = play + seconds;
  const next = stops.findIndex((stop) => stop >= play);
  const stop = next < 0 ? undefined : stops[next];
  if (stop !== undefined && arrived >= stop) return place(doc, state, { node: node.id, play: { at: next } });
  return { ...state, cursor: { node: node.id, play: arrived } };
}

function neighbour(doc: Document, node: NodeId, direction: 1 | -1): NodeId | null {
  const order = playableNodes(doc);
  const at = order.indexOf(node);
  return at < 0 ? null : (order[at + direction] ?? null);
}

function restAt(doc: Document, state: DocState, node: NodeId, how: Play | 'resume' | undefined): Play {
  const target = nodeOf(doc, node);
  if (target === null) return { at: 0 };
  const n = stopCount(target);
  if (how !== undefined && how !== 'resume') return how;
  if (how === undefined && target.body?.kind === 'scene') return { at: n - 1 };
  return { at: Math.max(0, Math.min(n - 1, progressOf(state, node).seen - 1)) };
}

function intend(doc: Document, state: DocState, intent: Intent): DocState {
  if (intent.kind === 'pause') return state;
  if (intent.kind === 'go') {
    if (nodeOf(doc, intent.node) === null) return state;
    return place(doc, state, { node: intent.node, play: restAt(doc, state, intent.node, intent.at) });
  }
  const here = nodeOf(doc, state.cursor.node);
  if (here === null) return state;
  const n = stopCount(here);
  const play = state.cursor.play;
  switch (intent.kind) {
    case 'seek': {
      if (here.body === null || here.body.kind !== 'scene') return state;
      const stops = sceneStops(here);
      const end = stops[stops.length - 1] ?? 0;
      const seconds = Math.max(0, Math.min(end, intent.seconds));
      return seconds >= end ? place(doc, state, { node: here.id, play: { at: stops.length - 1 } }) : { ...state, cursor: { node: here.id, play: seconds } };
    }
    case 'stop': {
      const target = Math.max(0, Math.min(n - 1, Math.floor(intent.at)));
      const from = stopOf(state.cursor) ?? 0;
      // back is free; forward goes through every gate it passes
      for (let at = from; at < target; at += 1) if (!gateOpen(doc, state, here.id, at)) return state;
      return place(doc, state, { node: here.id, play: { at: target } });
    }
    case 'next': {
      if (typeof play === 'number') {
        const next = sceneStops(here).findIndex((stop) => stop > play);
        return place(doc, state, { node: here.id, play: { at: next < 0 ? n - 1 : next } });
      }
      if (!gateOpen(doc, state, here.id, play.at)) return state;
      if (play.at < n - 1) return place(doc, state, { node: here.id, play: { at: play.at + 1 } });
      // the last stop: it is done, and the next leaf is where she goes
      const finished = put(state, here.id, reached(doc, state, here.id, play.at));
      const after = neighbour(doc, here.id, 1);
      return after === null ? finished : place(doc, finished, { node: after, play: restAt(doc, finished, after, 'resume') });
    }
    case 'back': {
      if (typeof play === 'number') {
        const stops = sceneStops(here);
        let before = -1;
        stops.forEach((stop, index) => {
          if (stop < play) before = index;
        });
        return before < 0 ? { ...state, cursor: { node: here.id, play: 0 } } : place(doc, state, { node: here.id, play: { at: before } });
      }
      if (play.at > 0) return place(doc, state, { node: here.id, play: { at: play.at - 1 } });
      const before = neighbour(doc, here.id, -1);
      if (before === null) return state;
      const target = nodeOf(doc, before);
      return place(doc, state, { node: before, play: { at: target === null ? 0 : Math.max(0, Math.min(stopCount(target) - 1, progressOf(state, before).seen - 1)) } });
    }
  }
}

function commit(doc: Document, state: DocState, change: StateChange): DocState {
  switch (change.kind) {
    case 'cursor': {
      const { cursor } = change;
      if (nodeOf(doc, cursor.node) === null || !playOk(cursor.play)) return state;
      return place(doc, state, cursor);
    }
    case 'held': {
      if (nodeOf(doc, change.node) === null || change.key === '' || change.key.length > STATE_LIMITS.key || JSON.stringify(change.value ?? null).length > STATE_LIMITS.heldBytes) return state;
      const there = Object.hasOwn(state.held, change.node) ? (state.held[change.node] ?? {}) : {};
      if (Object.hasOwn(there, change.key) && sameValue(there[change.key], change.value)) return state;
      return { ...state, held: { ...state.held, [change.node]: { ...there, [change.key]: change.value } } };
    }
    case 'try': {
      const view = askView(doc, state, change.node, change.ask);
      const text = change.value.trim().slice(0, STATE_LIMITS.tryChars);
      if (view === null || text === '' || view.accepted || view.refused || view.tries.length >= STATE_LIMITS.triesPerAsk) return state;
      const before = progressOf(state, change.node);
      const next: DocState = { ...state, progress: { ...state.progress, [change.node]: { ...before, tries: { ...before.tries, [change.ask]: [...view.tries, text] } } } };
      // she may be at the last stop and have just got it right: then the leaf is done
      const stop = state.cursor.node === change.node ? stopOf(state.cursor) : null;
      return stop === null ? next : put(next, change.node, reached(doc, next, change.node, stop));
    }
    case 'seen': {
      const node = nodeOf(doc, change.node);
      if (node === null || !Number.isFinite(change.seen)) return state;
      const seen = Math.min(Math.max(0, Math.round(change.seen)), stopCount(node));
      const before = progressOf(state, change.node);
      if (seen <= before.seen) return state;
      return put(state, change.node, reached(doc, state, change.node, seen - 1));
    }
    case 'done': {
      const before = progressOf(state, change.node);
      if (nodeOf(doc, change.node) === null || before.done === change.done) return state;
      return put(state, change.node, { ...before, done: change.done });
    }
    case 'sync': {
      const { cursor, held } = change.seen;
      let next = state;
      if (nodeOf(doc, cursor.node) !== null && playOk(cursor.play)) next = place(doc, next, cursor);
      const merged: Record<NodeId, Readonly<Record<string, Held>>> = { ...next.held };
      let moved = false;
      for (const [node, values] of Object.entries(held)) {
        if (nodeOf(doc, node) === null || JSON.stringify(values).length > STATE_LIMITS.heldBytes || sameValue(values, merged[node])) continue;
        merged[node] = values;
        moved = true;
      }
      return moved ? { ...next, held: merged } : next;
    }
  }
}

/**
 * The only writer of what the person did. It is pure: the same document, state and event give the same state, and a state it has nothing to
 * change comes back as the very same object (so a caller logs a change only when `next !== state`). A step that opens onto an `ask` is a gate:
 * `next` stays where it is until the ask holds an accepted answer (or is `refused`, or her hints are used up). Playing is navigation: a `tick`
 * moves play to the next stop and holds there.
 */
export function advance(doc: Document, state: DocState, event: DocEvent): DocState {
  switch (event.kind) {
    case 'tick':
      return tick(doc, state, event.seconds);
    case 'next':
    case 'back':
    case 'pause':
    case 'go':
    case 'seek':
    case 'stop':
      return intend(doc, state, event);
    case 'cursor':
    case 'held':
    case 'try':
    case 'seen':
    case 'done':
    case 'sync':
      return commit(doc, state, event);
  }
}

/**
 * Where a person begins. Given a document: on its first leaf, or at the end of the newest scene of a conversation that has only pictures. Given a
 * root id (or null before there is a document): at the top of it.
 */
export function initialState(from: Document | NodeId | null): DocState {
  if (from === null || typeof from === 'string') return { cursor: { node: from ?? '', play: 0 }, held: {}, progress: {} };
  const order = playableNodes(from);
  const lessons = order.some((id) => nodeOf(from, id)?.body?.kind === 'lesson' || nodeOf(from, id)?.body === null);
  const scenes = order.filter((id) => nodeOf(from, id)?.body?.kind === 'scene');
  const newest = scenes[scenes.length - 1];
  const node = !lessons && newest !== undefined ? newest : (order[0] ?? from.root);
  const target = nodeOf(from, node);
  const painted = !lessons && target?.body?.kind === 'scene';
  const stop = painted && target !== null ? stopCount(target) - 1 : 0;
  return { cursor: { node, play: { at: stop } }, held: {}, progress: painted ? { [node]: { seen: stop + 1, tries: {}, done: true } } : {} };
}

// --- the fold --------------------------------------------------------------------------------------------------------------------------

/** A record of a session's log, as far as the fold is concerned: it reads the ones it knows by `type` and lets the rest go by. */
export interface RecordLike {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface FoldIssue {
  readonly turn: string | null;
  readonly seq: number | null;
  /** the line, as it was written */
  readonly text: string;
  readonly issue: Issue;
}

export interface Folded {
  readonly document: Document;
  readonly state: DocState;
  /** `reply | …` of each turn: the sentence for the thread */
  readonly replies: Readonly<Record<string, string>>;
  /** what the fold had to refuse or could not read: lines a hand-written log should not hold */
  readonly issues: readonly FoldIssue[];
}

export interface FoldOptions {
  readonly id?: string;
  readonly title?: string;
}

/** What one record did to the document: the nodes that changed, whole, each once (a parent whose children changed is one). */
export interface FoldResult {
  readonly nodes: readonly DocNode[];
  readonly state: boolean;
  /** false: a record that changed nothing, which must not be logged */
  readonly applied: boolean;
  /** what this record made the fold refuse or warn of (a spoiler ask, a part that sits in nothing): the conductor tells the brain */
  readonly issues: readonly FoldIssue[];
}

type Opening = TurnInput['kind'];

const OPENINGS: readonly string[] = ['prompt', 'tap', 'act', 'refine', 'demo', 'script'];
const END_REASONS: readonly string[] = ['done', 'interrupted', 'failed', 'timeout'];

function isRecordObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHeld(value: unknown): value is Held {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true;
  if (Array.isArray(value)) return value.every(isHeld);
  return isRecordObject(value) && Object.values(value).every(isHeld);
}

function isOpening(value: unknown): value is Opening {
  return typeof value === 'string' && OPENINGS.includes(value);
}

function isEndReason(value: unknown): value is TurnEndReason {
  return typeof value === 'string' && END_REASONS.includes(value);
}

function isStatus(value: unknown): value is NodeStatus {
  return typeof value === 'string' && (NODE_STATUSES as readonly string[]).includes(value);
}

function isStageBase(value: unknown): value is StageBase {
  return isRecordObject(value) && isRecordObject(value['scene']) && Array.isArray(value['elements']) && typeof value['look'] === 'string' && isRecordObject(value['styles']);
}

function decodeCursor(value: unknown): Cursor | null {
  if (!isRecordObject(value) || typeof value['node'] !== 'string' || value['node'] === '' || value['node'].length > STATE_LIMITS.nodeId) return null;
  const { play } = value;
  return playOk(play) ? { node: value['node'], play } : null;
}

function decodeHeldMap(value: unknown): DocState['held'] | null {
  if (!isRecordObject(value)) return null;
  const out: Record<NodeId, Readonly<Record<string, Held>>> = {};
  for (const [node, values] of Object.entries(value)) {
    if (!isRecordObject(values) || !Object.values(values).every(isHeld)) return null;
    const entries: Record<string, Held> = {};
    for (const [key, item] of Object.entries(values)) if (isHeld(item)) entries[key] = item;
    out[node] = entries;
  }
  return out;
}

/** The change a `state` record holds: decoded, never trusted. Null when it is not one. */
export function decodeStateChange(value: unknown): StateChange | null {
  if (!isRecordObject(value)) return null;
  const { kind } = value;
  const node = value['node'];
  switch (kind) {
    case 'cursor': {
      const cursor = decodeCursor(value['cursor']);
      return cursor === null ? null : { kind, cursor };
    }
    case 'held':
      return typeof node === 'string' && typeof value['key'] === 'string' && isHeld(value['value']) ? { kind, node, key: value['key'], value: value['value'] } : null;
    case 'try':
      return typeof node === 'string' && typeof value['ask'] === 'string' && typeof value['value'] === 'string'
        ? { kind, node, ask: value['ask'], value: value['value'], ...(typeof value['right'] === 'boolean' ? { right: value['right'] } : {}) }
        : null;
    case 'seen':
      return typeof node === 'string' && typeof value['seen'] === 'number' ? { kind, node, seen: value['seen'] } : null;
    case 'done':
      return typeof node === 'string' && typeof value['done'] === 'boolean' ? { kind, node, done: value['done'] } : null;
    case 'sync': {
      const seen = value['seen'];
      if (!isRecordObject(seen)) return null;
      const cursor = decodeCursor(seen['cursor']);
      const held = decodeHeldMap(seen['held']);
      return cursor === null || held === null ? null : { kind, seen: { cursor, held } };
    }
    default:
      return null;
  }
}

interface Entry {
  readonly seq: number;
  readonly line: Line;
  readonly floor: number;
}

interface Group {
  readonly turn: string;
  readonly scene: NodeId;
  readonly entries: Entry[];
  base: StageBase | null;
  done: { readonly script: Script; readonly rest: StageBase } | null;
}

interface Turn {
  readonly id: string;
  readonly opened: Opening | 'none';
  /** the stage this turn begins from, once the turns before it have been settled */
  base: StageBase | null;
  readonly groups: Group[];
  /** painted definitions written before the scene they belong to is opened */
  preamble: Entry[];
  ended: TurnEndReason | null;
  reported: StageBase | null;
  settled: boolean;
  /** the parts it has written to */
  readonly touched: Set<string>;
}

interface SceneAcc {
  readonly node: NodeId;
  title: string;
  readonly groups: Group[];
}

const PREAMBLE: ReadonlySet<string> = new Set(['style', 'color', 'look', 'plan']);

function cut(text: string, most: number): string {
  const plain = text.trim();
  return plain.length > most ? `${plain.slice(0, most - 1)}…` : plain;
}

function isLessonLine(line: Line): line is LessonLine {
  switch (line.verb) {
    case 'part':
    case 'step':
    case 'ask':
    case 'hint':
    case 'reply':
    case 'end':
      return true;
    default:
      return false;
  }
}

/**
 * Makes a document from a conversation's log, one record at a time. `snapshot()` is the document so far; the live server keeps one of these and
 * folds each record as it is written, and `foldDocument` is the whole log at once. It reads the records `session`, `turn`, `line`, `end`,
 * `report`, `node` and `state`, and lets every other go by. The same records always give the same document.
 */
export class DocumentFolder {
  private readonly options: FoldOptions;
  private readonly book: LessonBook;
  private readonly turns = new Map<string, Turn>();
  private readonly turnOrder: string[] = [];
  private readonly scenes: SceneAcc[] = [];
  private readonly replies = new Map<string, string>();
  /** the status of every part and scene that has had one set: by what the turns did, or by `node` records */
  private readonly statuses = new Map<NodeId, NodeStatus>();
  private readonly problems: FoldIssue[] = [];
  private firstPrompt: string | null = null;
  private current: Turn | null = null;
  private person: DocState | null = null;
  private cached: Folded | null = null;
  private version = 0;
  private auto = 0;
  /** what the last `apply` left, to say what the next one changed */
  private previous: Folded | null = null;

  constructor(options: FoldOptions = {}) {
    this.options = options;
    this.book = new LessonBook(() => `f${(this.auto += 1)}`);
  }

  /** Folds one record and says what it changed. Cheaper to call `ingest` when nobody needs to know. */
  apply(record: RecordLike): FoldResult {
    const before = this.previous ?? this.snapshot();
    const problemsBefore = this.problems.length;
    const landed = this.ingest(record);
    const after = this.snapshot();
    this.previous = after;
    const nodes: DocNode[] = [];
    for (const node of Object.values(after.document.nodes)) {
      const was = Object.hasOwn(before.document.nodes, node.id) ? before.document.nodes[node.id] : undefined;
      if (was === undefined || !sameValue(was, node)) nodes.push(node);
    }
    const state = !sameValue(before.state, after.state);
    return { nodes, state, applied: landed || nodes.length > 0 || state, issues: this.problems.slice(problemsBefore) };
  }

  applyAll(records: Iterable<RecordLike>): void {
    for (const record of records) this.ingest(record);
  }

  /** Folds one record. True when it was one the document took in. */
  ingest(record: RecordLike): boolean {
    if (!isRecordObject(record)) return false;
    this.cached = null;
    const took = this.take(record);
    // some records read the document as it stood (a node's id, a state's document): what they changed is not in that snapshot
    this.cached = null;
    return took;
  }

  private take(record: RecordLike): boolean {
    switch (record.type) {
      case 'session':
        // An epoch: the server was started again, or the document was opened in a new session. What was being filled has no turn now.
        for (const turn of this.turns.values()) turn.touched.clear();
        return false;
      case 'turn':
        return this.onTurn(record);
      case 'line':
        return this.onLine(record);
      case 'end':
        return this.onEnd(record);
      case 'report':
        return this.onReport(record);
      case 'node':
        return this.onNode(record);
      case 'state':
        return this.onState(record);
      default:
        return false;
    }
  }

  // ---- what the server asks of a fold

  /** Whether any part has ever been named: a conversation without one is not a document of lessons. */
  isDocument(): boolean {
    return this.book.root() !== null;
  }

  /** A count that moves whenever a record changed something. */
  revision(): number {
    return this.version;
  }

  document(): Document {
    return this.snapshot().document;
  }

  state(): DocState {
    return this.snapshot().state;
  }

  node(id: NodeId): DocNode | undefined {
    const { nodes } = this.snapshot().document;
    return Object.hasOwn(nodes, id) ? nodes[id] : undefined;
  }

  /** The title and root, without the whole document: what a `doc` event carries beside its nodes. */
  heading(): { readonly title: string; readonly root: NodeId } {
    const { document } = this.snapshot();
    return { title: document.title, root: document.root };
  }

  /** The node this line text would land in, or null when it is not a lesson line or has no home. Reads, never writes. */
  place(text: string): NodeId | null {
    const parsed = parseLine(text);
    if (parsed.kind !== 'line' || !isLessonLine(parsed.line)) return null;
    const line = parsed.line;
    const part = this.book.where(line);
    if (part === null) return null;
    if (line.verb === 'part' && this.book.part(part) === null) {
      const parent = line.in ?? this.book.root();
      return parent === null ? part : `${this.book.path(parent).join('/')}/${part}`;
    }
    return this.book.path(part).join('/');
  }

  // ---- reading records

  private touch(turn: Turn, part: string): void {
    turn.touched.add(part);
    const id = this.idOf(part);
    const status = this.statuses.get(id) ?? 'outlined';
    if (status === 'outlined' || status === 'filled') this.statuses.set(id, 'filling');
  }

  private idOf(part: string): NodeId {
    return this.book.path(part).join('/');
  }

  private onTurn(record: Readonly<Record<string, unknown>>): boolean {
    const id = record['turn'];
    if (typeof id !== 'string' || this.turns.has(id)) return false;
    const input = record['input'];
    const kind = isRecordObject(input) ? input['kind'] : undefined;
    if (this.current !== null) this.settle(this.current);
    const turn: Turn = { id, opened: isOpening(kind) ? kind : 'none', base: null, groups: [], preamble: [], ended: null, reported: null, settled: false, touched: new Set() };
    this.turns.set(id, turn);
    this.turnOrder.push(id);
    this.current = turn;
    if (this.firstPrompt === null && isRecordObject(input) && input['kind'] === 'prompt' && typeof input['text'] === 'string') this.firstPrompt = cut(input['text'], 60);
    return true;
  }

  private turnOf(record: Readonly<Record<string, unknown>>): Turn | null {
    const id = record['turn'];
    if (typeof id !== 'string') return null;
    const known = this.turns.get(id);
    if (known !== undefined) return known;
    // a line whose turn record was not kept: it still belongs to a turn
    this.onTurn({ type: 'turn', turn: id, input: { kind: 'script' } });
    return this.turns.get(id) ?? null;
  }

  private note(turn: Turn, seq: number | null, text: string, issues: readonly Issue[]): void {
    for (const issue of issues) this.problems.push({ turn: turn.id, seq, text, issue });
  }

  private onLine(record: Readonly<Record<string, unknown>>): boolean {
    const turn = this.turnOf(record);
    const text = record['text'];
    const seq = record['seq'];
    if (turn === null || typeof text !== 'string' || typeof seq !== 'number') return false;
    const floor = typeof record['floor'] === 'number' ? record['floor'] : 0;
    const parsed = parseLine(text);
    if (parsed.kind !== 'line') {
      if (parsed.kind === 'reject') this.note(turn, seq, text, parsed.issues);
      return false;
    }
    this.note(turn, seq, text, parsed.issues);
    const { line } = parsed;
    if (isLessonLine(line)) return this.onLesson(turn, seq, text, line);
    if (line.verb === 'standing' || line.verb === 'refine') return false;
    const entry: Entry = { seq, line, floor };
    if (line.verb === 'scene' || line.verb === 'deck') {
      this.openScene(turn, line.verb === 'deck' ? line.title : null);
      this.pushEntry(turn, entry);
      return true;
    }
    if (turn.groups.length === 0 && PREAMBLE.has(line.verb)) {
      turn.preamble.push(entry);
      return true;
    }
    if (turn.groups.length === 0) this.continueScene(turn);
    this.pushEntry(turn, entry);
    return true;
  }

  private onLesson(turn: Turn, seq: number, text: string, line: LessonLine): boolean {
    const known = line.verb === 'part' ? this.book.part(line.id) !== null : true;
    const read = this.book.read(line);
    this.note(turn, seq, text, read.issues);
    const written = read.line;
    if (written === null) return false;
    switch (written.verb) {
      case 'reply':
        this.replies.set(turn.id, written.text);
        break;
      case 'part':
        if (!known) this.statuses.set(this.idOf(written.id), 'outlined');
        // a child written under a part is something landing in it, whether the child is new or is being written again (a part sent back and refilled)
        if (written.in !== undefined) this.touch(turn, written.in);
        break;
      case 'step':
      case 'ask':
        if (written.in !== undefined) this.touch(turn, written.in);
        break;
      case 'hint': {
        const owner = written.in === undefined ? null : this.book.partOfAsk(written.in);
        if (owner !== null) this.touch(turn, owner);
        break;
      }
      case 'end':
        break;
    }
    return true;
  }

  private openScene(turn: Turn, title: string | null): void {
    const index = this.scenes.length + 1;
    const scene: SceneAcc = { node: `#${index}`, title: title === null || title === '' ? '' : cut(title, 60), groups: [] };
    this.scenes.push(scene);
    this.openGroup(turn, scene);
  }

  private continueScene(turn: Turn): void {
    const last = this.scenes[this.scenes.length - 1];
    if (last === undefined) this.openScene(turn, null);
    else this.openGroup(turn, last);
  }

  private openGroup(turn: Turn, scene: SceneAcc): void {
    const before = turn.groups[turn.groups.length - 1];
    if (before !== undefined) this.run(turn, before);
    const group: Group = { turn: turn.id, scene: scene.node, entries: [...turn.preamble], base: null, done: null };
    turn.preamble = [];
    // the first segment of a turn begins from the stage the turns before it left; a later one from where the last rested
    group.base = before === undefined ? null : (before.done?.rest ?? null);
    turn.groups.push(group);
    scene.groups.push(group);
  }

  private pushEntry(turn: Turn, entry: Entry): void {
    const group = turn.groups[turn.groups.length - 1];
    if (group === undefined) return;
    group.entries.push(entry);
    group.done = null;
    const scene = this.scenes.find((candidate) => candidate.node === group.scene);
    if (scene !== undefined && scene.title === '' && entry.line.verb === 'say') scene.title = cut(entry.line.text, 60);
  }

  private onEnd(record: Readonly<Record<string, unknown>>): boolean {
    const turn = this.turnOf(record);
    if (turn === null || turn.ended !== null) return false;
    turn.ended = isEndReason(record['reason']) ? record['reason'] : 'done';
    // its segments were built while it was open: they say they are closed now
    for (const group of turn.groups) group.done = null;
    // what the turn was filling is filled when it finished; an interrupted turn leaves it as it was
    if (turn.ended === 'done') {
      for (const part of turn.touched) {
        const id = this.idOf(part);
        if (this.statuses.get(id) === 'filling') this.statuses.set(id, 'filled');
      }
    }
    turn.touched.clear();
    return true;
  }

  private onReport(record: Readonly<Record<string, unknown>>): boolean {
    const turn = this.turnOf(record);
    const report = record['report'];
    if (turn === null || !isRecordObject(report) || !isStageBase(report['stage'])) return false;
    turn.reported = report['stage'];
    return true;
  }

  /** A node's status set from outside the turn that wrote it: verified or refused, or (`reset`) sent back to be written again. */
  private onNode(record: Readonly<Record<string, unknown>>): boolean {
    const node = record['node'];
    const status = record['status'];
    if (typeof node !== 'string' || !isStatus(status)) return false;
    const { document } = this.snapshot();
    if (!Object.hasOwn(document.nodes, node)) return false;
    if (record['reset'] === true) {
      const part = node.split('/').pop() ?? '';
      if (this.book.part(part) !== null && this.idOf(part) === node) this.book.reset(part);
    } else if (this.statuses.get(node) === status) return false;
    this.statuses.set(node, status);
    return true;
  }

  private onState(record: Readonly<Record<string, unknown>>): boolean {
    const change = decodeStateChange(record['change']);
    if (change === null) return false;
    const { document, state } = this.snapshot();
    const next = advance(document, this.person ?? state, change);
    if (next === (this.person ?? state)) return false;
    this.person = next;
    return true;
  }

  // ---- the stages

  /** The stage the next turn begins from: the painter's own report when the log has one, else what `settle` makes of the lines. */
  private settle(turn: Turn): void {
    if (turn.settled) return;
    turn.settled = true;
    const last = turn.groups[turn.groups.length - 1];
    if (last !== undefined) this.run(turn, last);
  }

  private restOf(turn: Turn): StageBase | null {
    return turn.reported ?? turn.groups[turn.groups.length - 1]?.done?.rest ?? null;
  }

  private baseOf(turn: Turn): StageBase {
    if (turn.base !== null) return turn.base;
    const at = this.turnOrder.indexOf(turn.id);
    let stage: StageBase = EMPTY_STAGE;
    for (const id of this.turnOrder.slice(0, Math.max(0, at))) {
      const before = this.turns.get(id);
      if (before === undefined) continue;
      this.settle(before);
      stage = this.restOf(before) ?? stage;
    }
    turn.base = stage;
    return stage;
  }

  /** Builds the segment of a group: its schedule, and the stage it rests at. */
  private run(turn: Turn, group: Group): void {
    if (group.done !== null) return;
    const base = group.base ?? this.baseOf(turn);
    group.base = base;
    const score = new TurnScore(base, turn.opened);
    for (const entry of group.entries) score.push(entry.line, entry.seq, entry.floor);
    const { schedule } = score;
    const end = schedule.end;
    const script: Script = {
      base,
      opened: turn.opened === 'none' ? 'script' : turn.opened,
      lines: group.entries.map((entry) => ({ seq: entry.seq, line: entry.line, floor: entry.floor })),
      stops: [end],
      closed: turn.ended === null ? null : { at: end, reason: turn.ended },
    };
    group.done = { script, rest: settle(schedule, base, end) };
  }

  snapshot(): Folded {
    if (this.cached !== null) return this.cached;
    const nodes: Record<NodeId, DocNode> = {};
    const parts = this.book.parts();
    const rootPart = this.book.root();
    const rootId: NodeId = rootPart === null ? ROOT : this.idOf(rootPart);

    for (const part of parts) {
      const id = this.idOf(part.id);
      nodes[id] = {
        id,
        parent: part.parent === null ? null : this.idOf(part.parent),
        title: part.title,
        tag: part.tag,
        ...(part.crop === null ? {} : { crop: part.crop }),
        children: part.children.map((child) => this.idOf(child)),
        body: part.steps.length > 0 ? { kind: 'lesson', steps: part.steps } : null,
        status: this.statuses.get(id) ?? 'outlined',
      };
    }

    const sceneIds: NodeId[] = [];
    for (const scene of this.scenes) {
      const segments: Script[] = [];
      let open = false;
      for (const group of scene.groups) {
        const turn = this.turns.get(group.turn);
        if (turn === undefined) continue;
        this.run(turn, group);
        if (group.done !== null) segments.push(group.done.script);
        if (turn.ended === null) open = true;
      }
      sceneIds.push(scene.node);
      nodes[scene.node] = {
        id: scene.node,
        parent: rootId,
        title: scene.title === '' ? `Scene ${scene.node.slice(1)}` : scene.title,
        tag: null,
        children: [],
        body: { kind: 'scene', segments },
        status: this.statuses.get(scene.node) ?? (open ? 'filling' : 'filled'),
      };
    }

    const root = Object.hasOwn(nodes, rootId) ? nodes[rootId] : undefined;
    const title = this.options.title ?? (root !== undefined ? root.title : (this.firstPrompt ?? 'Untitled'));
    nodes[rootId] =
      root === undefined
        ? { id: rootId, parent: null, title, tag: null, children: sceneIds, body: null, status: sceneIds.length === 0 ? 'outlined' : 'filled' }
        : { ...root, children: [...root.children, ...sceneIds] };
    const document: Document = { id: this.options.id ?? 'document', title, root: rootId, nodes, defs: {} };

    const kept = this.person;
    const state = kept !== null && Object.hasOwn(nodes, kept.cursor.node) ? kept : initialState(document);
    this.version += 1;
    this.cached = { document, state, replies: Object.fromEntries(this.replies), issues: [...this.problems] };
    return this.cached;
  }
}

/** The document a whole log makes. The same records give the same document, whatever the order of the folds before it. */
export function foldDocument(records: Iterable<RecordLike>, options: FoldOptions = {}): Folded {
  const folder = new DocumentFolder(options);
  folder.applyAll(records);
  return folder.snapshot();
}

/**
 * The document a script written as the brain writes it makes, as one turn: the lines are read, made explicit and logged the way the server does
 * it. For the demos, the fixtures and tools; `opened` is how the turn began. What the normaliser refused is in `issues`.
 */
export function foldSource(source: string, opened: Opening = 'demo', options: FoldOptions = {}): Folded {
  const reader = new LineReader();
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  const records: RecordLike[] = [{ type: 'turn', turn: 't1', input: { kind: opened } }];
  let seq = 0;
  for (const raw of source.split('\n')) {
    const read = reader.read(raw);
    if (read.kind !== 'line') continue;
    const normalized = normalizer.normalize(read.line);
    if (normalized.line === null) continue;
    seq += 1;
    records.push({ type: 'line', turn: 't1', seq, text: serializeLine(normalized.line) });
  }
  records.push({ type: 'end', turn: 't1', reason: 'done' });
  return foldDocument(records, options);
}
