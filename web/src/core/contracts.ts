// The kind contract and the shapes the core is called with. Types and constants only: no behaviour.
//
// A kind is anything that takes a box. It is written as data in, data out:
//
//   model    its lines as data. No time, no room.
//   measure  how big it wants to be, and the least it can be read at.
//   layout   everything inside the box it is given, relative to the box's corner; nothing outside.
//   draw     figures and text, or one surface. The only place a `Phase` is read.
//   census   the words (with size and ink) and the regions a hand can work.
//   input    what a hand does to it: held value in, held value out, and what to tell the mind.
//
// What the shape rules out: a kind has no `rest` and no `carry` to get wrong (the core resolves time into a `Phase` that is 1 everywhere
// at rest); no clock (an entrance is `presence`, which is 1 for anything carried); no state (`held` comes in and goes out); no colour (it
// asks for a role, the core answers with ink that reads on what is behind it).
//
// The compiler's half: `Registry` is `{ [K in KindId]: Sealed<K> }`, so a kind left out of `KINDS` stops the build with its name
// (TS2741), a toggle filed under `slider` stops it, and a string held by a slider stops it. `pnpm kinds` checks what the compiler cannot.

import type { ElementSpan, InkRole, Line, LookId, StageBase, TurnEndReason, TurnInput } from '@conduit/language';
import type { BlockLook, BlockPart, DrawnFrames, TextSpec, TextMeasure } from '../contracts/blocks';
import type { Colour, Frame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import type { Box } from '../contracts/space';
import type { Census } from './census';
import type { Held, HeldBy, KindId } from '../../../language/src/kinds';

export type { ChartHeld, FigureHeld, Held, HeldBy, KindId, ScreenHeld } from '../../../language/src/kinds';
export type { Box };

// ---------------------------------------------------------------- the kind contract

export interface Size2 {
  readonly width: number;
  readonly height: number;
}

/**
 * Who the screen is for: a person preference, `adult` by default. It raises the two numbers the legibility
 * invariant enforces, for the stage and for the lesson view alike: the least a word may be set at (`floor`, em height) and the least a target
 * may be (`minTarget`), and the lesson view's type scale. Nothing else about the screen changes.
 */
export type Audience = 'adult' | 'young' | 'large-print';
export const AUDIENCES: readonly Audience[] = ['adult', 'young', 'large-print'];
export interface AudienceBar {
  readonly floor: { readonly phone: number; readonly desk: number };
  readonly minTarget: number;
  /** the least a target may be under a mouse or a trackpad (a pointer that is not coarse) */
  readonly deskTarget: number;
  /** the lesson view's type scale: 1 is the adult's */
  readonly scale: number;
  /** what the person is told it is */
  readonly name: string;
}
export const AUDIENCE_BARS: Readonly<Record<Audience, AudienceBar>> = {
  adult: { floor: { phone: 11, desk: 12 }, minTarget: 44, deskTarget: 32, scale: 1, name: 'Adult' },
  young: { floor: { phone: 16, desk: 18 }, minTarget: 56, deskTarget: 44, scale: 1.25, name: 'Young learner' },
  'large-print': { floor: { phone: 20, desk: 22 }, minTarget: 64, deskTarget: 52, scale: 1.5, name: 'Large print' },
};
export function isAudience(value: unknown): value is Audience {
  return typeof value === 'string' && Object.hasOwn(AUDIENCE_BARS, value);
}
/** The floor, target and scale for an audience on this screen. */
export function audienceBar(audience: Audience, phone: boolean): { readonly floor: number; readonly minTarget: number; readonly scale: number } {
  const bar = AUDIENCE_BARS[audience];
  return { floor: phone ? bar.floor.phone : bar.floor.desk, minTarget: bar.minTarget, scale: bar.scale };
}
/** The least a tappable thing may be, css px: the audience's `minTarget` under a finger (a coarse pointer, or none known), `deskTarget` under a mouse. */
export function targetFor(audience: Audience, pointer: 'fine' | 'coarse' | 'none'): number {
  const bar = AUDIENCE_BARS[audience];
  return pointer === 'fine' ? bar.deskTarget : bar.minTarget;
}
/** The one line the brain is told (the turn brief's SCREEN line carries it when the person is not the default). */
export function audienceLine(audience: Audience): string {
  return `AUDIENCE: ${audience}${audience === 'adult' ? '' : ` (type and targets are raised for it)`}. If the person says the learner is under 10, you may suggest switching the audience to young (the + menu, About); never switch it yourself.`;
}

/** What a look gives a kind, resolved for this screen, in the units of the box it is given (CSS points). */
export interface Tokens extends BlockLook {
  /** the smallest side a target may have for a finger: 44 */
  readonly minTarget: number;
  /** the least a word may be set at on this screen, em height (the legibility floor) */
  readonly floor: number;
}

export interface Env {
  readonly dpr: number;
  readonly pointer: 'fine' | 'coarse';
  readonly tokens: Tokens;
  /** sizes text exactly as the painter will set it */
  readonly measure: TextMeasure;
  /** the em height a text spec is set at, stage units: what the census reports and the floor is held against */
  readonly px: (spec: TextSpec) => number;
  /** a role and what it sits on, in; a colour that reads on it, out. The only way a kind gets a colour. */
  readonly ink: (role: InkRole, on?: Colour) => Colour;
  /** the ground a leaf is drawn on, for roles that are asked `on` it */
  readonly ground: Colour;
  /** the size of one canvas unit in this leaf, for what is written in canvas units (a map's pins) */
  readonly canvasUnit: number;
  /**
   * For the adapters that wrap an engine which reads the look itself (the mock-up kit does). A native kind never reads it: it takes
   * `tokens` and `ink`. It goes when the engines it serves do (PC9, PC16).
   */
  readonly legacy: { readonly look: LookSpec };
}

export interface Measured {
  readonly width: number;
  readonly height: number;
  /** below this it cannot be read: the core gives it room or scroll, and never less */
  readonly least: Size2;
  /** `reflow`: height follows width. `contain`: its content keeps its shape and is fitted inside the box. */
  readonly fit: 'reflow' | 'contain';
}

/** 0..1 each, and every one is 1 at rest. A kind never sees a clock. */
export interface Phase {
  readonly presence: number;
  /** how far a part has landed: a table's row, a screen's part. Keyed by the part's row, as `BlockPart.row` writes it. */
  readonly landed: (row: number) => number;
  /** seconds on the clock that never stops: for what breathes or blinks, never for an entrance */
  readonly ambient: number;
}

/** Everything at rest: nothing entering, nothing leaving. What `{ at: k }` means to a kind. */
export const AT_REST: Phase = { presence: 1, landed: () => 1, ambient: 0 };

/** One part to draw and how solid it is now (presence times how far its row has landed). The core turns roles into ink. */
export interface DrawnPart {
  readonly part: BlockPart;
  readonly opacity: number;
}

/** A surface leaf: the place a sandboxed or engine-drawn frame goes (a chart's engine, a live app). The kit's own DOM follows the box. */
export interface SurfaceSpec {
  readonly kind: 'chart' | 'app';
  readonly key: string;
  readonly box: Box;
}

export interface Drawn {
  /** shapes and text, back to front, in the leaf's own coordinates (relative to its corner) */
  readonly parts: readonly DrawnPart[];
  /** finished frames, for a leaf that draws itself (the screen kit); absent otherwise */
  readonly frames: DrawnFrames | null;
  readonly surface: SurfaceSpec | null;
}
export const NOTHING_DRAWN: Drawn = { parts: [], frames: null, surface: null };

export interface CensusWord {
  readonly part: string;
  readonly text: string;
  readonly box: Box;
  /** em height */
  readonly px: number;
  readonly colour: Colour;
  /** what it is set on */
  readonly on: Colour;
}

export interface Region {
  readonly part: string;
  readonly box: Box;
  readonly role: 'press' | 'switch' | 'drag' | 'type' | 'choose' | 'scroll';
  readonly label: string;
}

/** The data under one leaf's drawing: what the invariants (`W/core/invariants.ts`) are rules over. */
export interface LeafCensus {
  readonly words: readonly CensusWord[];
  readonly regions: readonly Region[];
}

/** What a hand does to a leaf, in the leaf's own coordinates (relative to its corner). */
export type LeafEvent =
  | { readonly type: 'press'; readonly part: string; readonly x: number; readonly y: number }
  | { readonly type: 'drag'; readonly part: string; readonly x: number; readonly y: number; readonly end: boolean }
  | { readonly type: 'text'; readonly part: string; readonly value: string; readonly commit: boolean }
  | { readonly type: 'key'; readonly part: string; readonly key: 'less' | 'more' | 'first' | 'last' | 'act' };

/** What to tell the mind: `send` makes it the user's next message. */
export interface Emit {
  readonly send: boolean;
  readonly text: string;
}

export interface InputResult<K extends KindId> {
  readonly held: Held<K>;
  readonly emit: Emit | null;
}

/** Whether the core may route a leaf to this kind. `host`: ready where a host exists (a charting engine, an app host). */
export type Status =
  | { readonly state: 'ready' }
  | { readonly state: 'host'; readonly host: 'chart' | 'app' }
  | { readonly state: 'not-yet'; readonly why: string };

export interface Kind<K extends KindId, M, L> {
  readonly id: K;
  readonly status: Status;
  readonly model: (element: ElementSpan, parts: readonly ElementSpan[], held: Held<K>, env: Env) => M;
  readonly measure: (model: M, constraint: { readonly maxWidth: number; readonly maxHeight: number }, env: Env) => Measured;
  readonly layout: (model: M, size: Size2, env: Env) => L;
  readonly draw: (layout: L, phase: Phase, env: Env) => Drawn;
  readonly census: (layout: L) => LeafCensus;
  /** null for a kind nobody can work */
  readonly input: null | ((layout: L, held: Held<K>, event: LeafEvent) => InputResult<K> | null);
  /** lines that exercise it: what `pnpm kinds` and the storm draw. One array a case, one line a string. */
  readonly fixtures: readonly (readonly string[])[];
}

declare const SEALED: unique symbol;
/** A kind's own model, seen from outside: it can be passed back to the same kind and to nothing else. */
export type SealedModel = { readonly [SEALED]: 'model' };
export type SealedLayout = { readonly [SEALED]: 'layout' };

/** What the registry holds: a kind with its `M` and `L` hidden, so there is no `any` to hide a wrong one. See `seal.ts`. */
export interface Sealed<K extends KindId> {
  readonly id: K;
  readonly status: Status;
  readonly model: (element: ElementSpan, parts: readonly ElementSpan[], held: Held<K>, env: Env) => SealedModel;
  readonly measure: (model: SealedModel, constraint: { readonly maxWidth: number; readonly maxHeight: number }, env: Env) => Measured;
  readonly layout: (model: SealedModel, size: Size2, env: Env) => SealedLayout;
  readonly draw: (layout: SealedLayout, phase: Phase, env: Env) => Drawn;
  readonly census: (layout: SealedLayout) => LeafCensus;
  readonly input: null | ((layout: SealedLayout, held: Held<K>, event: LeafEvent) => InputResult<K> | null);
  readonly fixtures: readonly (readonly string[])[];
}

/** The painter's half. A kind left out of it is a build error that names the kind. */
export type Registry = { readonly [K in KindId]: Sealed<K> };

// ---------------------------------------------------------------- what the core is called with (2.1)

export type NodeId = string;
/** Seconds on a leaf's clock, or resting at stop `at`. Rest is a stop on the same script, never a second script. */
export type Play = number | { readonly at: number };
export interface Cursor {
  readonly node: NodeId;
  readonly play: Play;
}

/** The value a hand left in a leaf, whichever kind it is: what `DocState.held` stores. */
export type HeldValue = HeldBy[keyof HeldBy];

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface View {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** where the shell is: the one box the stage is given by it */
  readonly insets: Insets;
  readonly pointer: 'fine' | 'coarse';
  readonly reducedMotion: boolean;
  readonly lockLook: LookId | null;
}

/** The media contract (review F7): paintings, photographs, data tables and uploads are one thing with four producers. */
export interface Asset {
  readonly key: string;
  readonly kind: 'image' | 'audio' | 'video' | 'data' | 'file';
  readonly status: 'waiting' | 'ready' | 'failed';
  /** same-origin URL once ready */
  readonly url: string | null;
  readonly mime: string | null;
  readonly credit: string | null;
  readonly source: 'painted' | 'picture-source' | 'upload' | 'tool';
}

/** What the person did and the ambient clock: everything `frame` reads that is not the script. Logged, so golden can replay a hand. */
export interface Inputs {
  /** this leaf's, from `DocState` */
  readonly held: Readonly<Record<string, HeldValue>>;
  /** the ambient second each last changed: an ease is a function of `ambient - since` */
  readonly since: Readonly<Record<string, number>>;
  readonly assets: Readonly<Record<string, Asset>>;
  readonly pointer: { readonly over: string | null; readonly pressed: string | null; readonly focus: string | null };
  /** the clock that never stops, and the pinned wall clock */
  readonly ambient: number;
  readonly wall: number;
}

/** What the log holds of one turn on one scene. */
export interface Script {
  readonly base: StageBase;
  readonly opened: TurnInput['kind'];
  readonly lines: readonly { readonly seq: number; readonly line: Line; readonly floor: number }[];
  /** where play holds; the last is the end */
  readonly stops: readonly number[];
  readonly closed: null | { readonly at: number; readonly reason: TurnEndReason };
}

/**
 * The one picture function. PC2 builds it; its signature is fixed here so that nothing is written against another. `D` is the document of
 * `L/document.ts` (WS3). Total: it never throws, a leaf that fails is drawn as its words. Pure: the same four arguments, the same frame.
 */
export type FrameFn<D> = (doc: D, cursor: Cursor, view: View, inputs: Inputs) => Frame;
/** The data under the frame at the same four arguments. */
export type CensusFn<D> = (doc: D, cursor: Cursor, view: View, inputs: Inputs) => Census;
