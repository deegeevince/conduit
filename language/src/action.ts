// What a hand does, as one field on the turn: `you did <verb> to <anchors>`. Ink keeps its strokes; this is the
// reading of them, and of a selection, a tap, a drag's end, in the one shape the mind is told.
import { ANCHOR_LIMITS, guards, readAnchor, readAnchors } from './anchor';
import type { DocAnchor } from './anchor';

export const DIDS = ['select', 'highlight', 'underline', 'strike', 'circle', 'arrow', 'scribble', 'tap', 'drag', 'reorder', 'type'] as const;
export type Did = (typeof DIDS)[number];
export const RELS = ['before', 'after', 'into'] as const;
export type Rel = (typeof RELS)[number];

export interface Action {
  readonly did: Did;
  /** what it was done to */
  readonly anchors: readonly DocAnchor[];
  /** an arrow, a drag or a reorder: where it went */
  readonly to?: DocAnchor;
  readonly rel?: Rel;
  /** typed */
  readonly value?: string;
  /** ids in `marks.strokes`; the pen's colour by the toolbar's name ('red') */
  readonly strokes?: readonly string[];
  readonly colour?: string;
  /** wall-clock ms: when the hand did it */
  readonly at: readonly [from: number, to: number];
}

export const ACTION_LIMITS = { value: 2000, strokes: 64, stroke: 64, colour: 24, turn: ANCHOR_LIMITS.perTurn } as const;

export function isDid(value: unknown): value is Did {
  return (DIDS as readonly unknown[]).includes(value);
}

/** The wire's decoder for one action. */
export function readAction(raw: unknown): Action | null {
  if (!guards.rec(raw) || !isDid(raw.did)) return null;
  const anchors = readAnchors(raw.anchors);
  const at = guards.list(raw.at, 2);
  if (anchors === null || at === null || at.length !== 2) return null;
  const from = guards.num(at[0], 0, 1e15);
  const to = guards.num(at[1], 0, 1e15);
  if (from === null || to === null || to < from) return null;
  // taps, selections and the other did-words may name nothing the document holds, but an action over no anchors and no strokes says nothing
  const out: { -readonly [K in keyof Action]: Action[K] } = { did: raw.did, anchors, at: [from, to] };
  if (raw.to !== undefined) {
    const dest = readAnchor(raw.to);
    if (dest === null) return null;
    out.to = dest;
  }
  if (raw.rel !== undefined) {
    const rel = RELS.find((r) => r === raw.rel);
    if (rel === undefined) return null;
    out.rel = rel;
  }
  if (raw.value !== undefined) {
    const value = guards.str(raw.value, ACTION_LIMITS.value);
    if (value === null) return null;
    out.value = value;
  }
  if (raw.strokes !== undefined) {
    const list = guards.list(raw.strokes, ACTION_LIMITS.strokes);
    if (list === null) return null;
    const ids: string[] = [];
    for (const item of list) {
      const id = guards.str(item, ACTION_LIMITS.stroke, 1);
      if (id === null) return null;
      ids.push(id);
    }
    out.strokes = ids;
  }
  if (raw.colour !== undefined) {
    const colour = guards.str(raw.colour, ACTION_LIMITS.colour, 1);
    if (colour === null) return null;
    out.colour = colour;
  }
  if (anchors.length === 0 && out.to === undefined && out.value === undefined && out.strokes === undefined) return null;
  return out;
}

/** The actions of one turn, bounded by `perTurn` in all (their anchors counted); null when any one is bad. */
export function readActions(raw: unknown): readonly Action[] | null {
  const list = guards.list(raw, ACTION_LIMITS.turn);
  if (list === null) return null;
  const out: Action[] = [];
  let anchors = 0;
  for (const item of list) {
    const action = readAction(item);
    if (action === null) return null;
    anchors += action.anchors.length;
    if (anchors > ANCHOR_LIMITS.perTurn) return null;
    out.push(action);
  }
  return out;
}
