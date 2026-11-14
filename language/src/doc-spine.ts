// THE TYPES OF PLAN-v3-core 2.1, as package WS4 needed them before WS3's `L/document.ts` had landed.
//
// This file is a stand-in with the names and shapes of section 2.1. When WS3 merges: delete this file and its line in `index.ts`, make
// `L/document.ts` export the same names, and the rest of WS4 compiles unchanged. Where section 2.1 was silent, the guess is marked
// GUESS; each is repeated in WS4's hand-back.
//
// Nothing here is read from the learner's photos, and nothing here names the learner.

import type { StageBase } from './schedule';
import type { Line } from './types';
import type { TurnEndReason, TurnInput } from './wire';

/** 'w1/s2/q7/a2': the brain's ids, joined by the normaliser (2.1). Each segment is the brain's own id, which never holds a `/`. */
export type NodeId = string;

export const NODE_STATUSES = ['outlined', 'filling', 'filled', 'verified', 'refused'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** What a leaf's controls hold: plain JSON, so it can be logged, persisted and told to the mind. GUESS: 2.1 leaves `Held` open. */
export type Held = string | number | boolean | null | readonly Held[] | { readonly [key: string]: Held };

/**
 * GUESS. 2.1 names `LessonStep` and gives its lines (2.10) but not its shape. A `step` is one reveal; an `ask` is a try, with its
 * accepted answers, the choices when it is picked, a unit, the prompt, and the hints that followed it (`hint in=<ask id>`).
 */
export type LessonStep =
  | { readonly kind: 'step'; readonly id: string; readonly show: string | null; readonly words: string }
  | { readonly kind: 'ask'; readonly id: string; readonly accepted: readonly string[]; readonly pick: readonly string[] | null; readonly unit: string | null; readonly prompt: string; readonly hints: readonly string[] };

/** 2.1 puts `Script` in `W/core/contracts.ts` and uses it in `L/document.ts`, which cannot import from the page: it is here so the types close. */
export interface Script {
  readonly base: StageBase;
  readonly opened: TurnInput['kind'];
  readonly lines: readonly { readonly seq: number; readonly line: Line; readonly floor: number }[];
  readonly stops: readonly number[];
  readonly closed: null | { readonly at: number; readonly reason: TurnEndReason };
}

export type DocBody =
  | null
  | { readonly kind: 'scene'; readonly segments: readonly Script[] }
  | { readonly kind: 'lesson'; readonly steps: readonly LessonStep[] }
  | { readonly kind: 'app'; readonly program: string; readonly code: string; readonly version: number };

export interface DocNode {
  readonly id: NodeId;
  readonly parent: NodeId | null;
  readonly title: string;
  readonly tag: string | null;
  readonly children: readonly NodeId[];
  readonly body: DocBody;
  readonly status: NodeStatus;
}

/** GUESS: `define`/`use` come after the flow (2.10); until then no definitions exist. */
export type Defs = { readonly [name: string]: unknown };

export interface Document {
  readonly id: string;
  readonly title: string;
  readonly root: NodeId;
  readonly nodes: Readonly<Record<NodeId, DocNode>>;
  readonly defs: Defs;
}

export type Play = number | { readonly at: number };
export interface Cursor {
  readonly node: NodeId;
  readonly play: Play;
}

export interface NodeProgress {
  readonly seen: number;
  readonly tries: Readonly<Record<string, readonly string[]>>;
  readonly done: boolean;
}

export interface DocState {
  readonly cursor: Cursor;
  readonly held: Readonly<Record<NodeId, Readonly<Record<string, Held>>>>;
  readonly progress: Readonly<Record<NodeId, NodeProgress>>;
}

/**
 * GUESS. 2.1's `advance(doc, state, event: Tick | Nav | LeafChange)` does not say what the last two are. A `Tick` is the page's own clock
 * and never leaves it. What does go up, and is logged as a `state` record, is a committed `Nav` or `LeafChange`:
 *  - `cursor`: the person moved (a node, and where in it).
 *  - `held`: a control in a leaf was committed (a drag is local; only its end goes up).
 *  - `try`: an answer was tried on an `ask`. `right` is the page's verdict, checked there with no round trip.
 *  - `seen`: the furthest reveal reached in a node.
 *  - `done`: a node was finished (or reopened).
 *  - `sync`: the page says where it stood at an instant (`seen` on `tap`, `control` and `act`), for a server that missed one of the above.
 */
export type Nav = { readonly kind: 'cursor'; readonly cursor: Cursor };
export type LeafChange =
  | { readonly kind: 'held'; readonly node: NodeId; readonly key: string; readonly value: Held }
  | { readonly kind: 'try'; readonly node: NodeId; readonly ask: string; readonly value: string; readonly right: boolean }
  | { readonly kind: 'seen'; readonly node: NodeId; readonly seen: number }
  | { readonly kind: 'done'; readonly node: NodeId; readonly done: boolean }
  | { readonly kind: 'sync'; readonly seen: Seen };
export type StateChange = Nav | LeafChange;

/** What the page saw at the instant a hand acted: the cursor and every held value (2.5). Carried by `tap`, `control` and `act`. */
export interface Seen {
  readonly cursor: Cursor;
  readonly held: DocState['held'];
}

/** The limits on what a page may send up as state. Past them a value is refused, not cut. */
export const STATE_LIMITS = { nodeId: 200, key: 64, heldBytes: 4_096, tryChars: 200, triesPerAsk: 50, seenBytes: 16_384 } as const;
