// What a hand changed in a lesson, as the wire's `StateChange`s, and how one crosses the surface bridge. The lesson commits with WS3's `advance`
// and tells the page only what advance committed (a cursor moved, an answer tried, a control held); the page runs the same `advance` on its copy,
// so the two cannot disagree. Pure: no DOM.

import { accepts } from '@conduit/language';
import type { DocState, Document, Held, StateChange } from './types';

function sameJson(a: Held | undefined, b: Held | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** What changed between two states, as changes the server understands. A `try` carries the lesson's own verdict, checked with no round trip. */
export function changesBetween(doc: Document, before: DocState, after: DocState): readonly StateChange[] {
  const out: StateChange[] = [];
  if (JSON.stringify(before.cursor) !== JSON.stringify(after.cursor)) out.push({ kind: 'cursor', cursor: after.cursor });
  for (const [node, held] of Object.entries(after.held)) {
    for (const [key, value] of Object.entries(held)) if (!sameJson(before.held[node]?.[key], value)) out.push({ kind: 'held', node, key, value });
  }
  for (const [node, progress] of Object.entries(after.progress)) {
    const was = before.progress[node];
    for (const [ask, tries] of Object.entries(progress.tries)) {
      const body = doc.nodes[node]?.body;
      const step = body?.kind === 'lesson' ? body.steps.find((s) => s.kind === 'ask' && s.id === ask) : undefined;
      for (const value of tries.slice(was?.tries[ask]?.length ?? 0)) out.push({ kind: 'try', node, ask, value, right: step?.kind === 'ask' && accepts(step, value) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- over the bridge: `conduit.send(name, value)`

/** The bridge takes a name of 32 characters and a value of 300 and drops what is longer: a change is written compactly, or not sent. */
export const BRIDGE_VALUE_MAX = 290;

export interface Wire {
  readonly name: string;
  readonly value: string;
}

export function encode(change: StateChange): Wire | null {
  let value: string;
  switch (change.kind) {
    case 'cursor':
      value = JSON.stringify([change.cursor.node, change.cursor.play]);
      break;
    case 'try':
      value = JSON.stringify([change.node, change.ask, change.value]);
      break;
    case 'held':
      value = JSON.stringify([change.node, change.key, change.value]);
      break;
    case 'seen':
      value = JSON.stringify([change.node, change.seen]);
      break;
    case 'done':
      value = JSON.stringify([change.node, change.done]);
      break;
    case 'sync':
      return null;
  }
  return value.length > BRIDGE_VALUE_MAX ? null : { name: change.kind, value };
}

function parts(value: string): readonly unknown[] | null {
  try {
    const read: unknown = JSON.parse(value);
    return Array.isArray(read) ? read : null;
  } catch {
    return null;
  }
}

/** The page's reading of what came over the bridge. Anything that is not exactly a change is null. */
export function decode(name: string, value: string | number | boolean): StateChange | null {
  if (typeof value !== 'string') return null;
  const p = parts(value);
  if (p === null) return null;
  if (name === 'cursor' && typeof p[0] === 'string') {
    const play = p[1];
    if (typeof play === 'number') return { kind: 'cursor', cursor: { node: p[0], play } };
    if (typeof play === 'object' && play !== null && 'at' in play && typeof play.at === 'number') return { kind: 'cursor', cursor: { node: p[0], play: { at: play.at } } };
    return null;
  }
  if (name === 'try' && typeof p[0] === 'string' && typeof p[1] === 'string' && typeof p[2] === 'string') return { kind: 'try', node: p[0], ask: p[1], value: p[2] };
  if (name === 'held' && typeof p[0] === 'string' && typeof p[1] === 'string') return { kind: 'held', node: p[0], key: p[1], value: p[2] as Held };
  if (name === 'seen' && typeof p[0] === 'string' && typeof p[1] === 'number') return { kind: 'seen', node: p[0], seen: p[1] };
  if (name === 'done' && typeof p[0] === 'string' && typeof p[1] === 'boolean') return { kind: 'done', node: p[0], done: p[1] };
  return null;
}
