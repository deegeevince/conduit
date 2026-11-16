// The problems on stage, read from the lines of the turn the stage holds: each `problem` line, and the `hint` lines written after it (what the plain
// workspace of a question the painter cannot read says when Hint is tapped).

import { parseLine, problemOfLine } from '@conduit/language';
import type { ProblemSpec } from '@conduit/language';
import type { LineView, StageElementView } from '../contracts/painter';

export interface OnStage {
  readonly spec: ProblemSpec;
  readonly said: readonly string[];
  /** answers the brain put in the blank (`fill p1 | 12`), each with a key that says which line it was */
  readonly fills: readonly { readonly key: string; readonly text: string }[];
}

/** What may stand in a turn beside a problem for the problem to take the screen: the turn is the question and nothing else */
const ALONE = new Set(['scene', 'look', 'problem', 'fill', 'hint', 'style', 'color', 'standing', 'reply', 'refine', 'end', 'wait']);

export function problemsOf(lines: readonly { readonly text: string }[]): OnStage[] {
  // a problem that is one part of a longer answer (a tour with a sum in it) is drawn where it stands; only a turn that is the question takes the whole screen
  if (lines.some((entry) => !ALONE.has((/^\s*([a-z]+)/i.exec(entry.text)?.[1] ?? '').toLowerCase()) && !/^\s*(#|$)/.test(entry.text))) return [];
  const found: { spec: ProblemSpec; said: string[]; fills: { key: string; text: string }[] }[] = [];
  for (const entry of lines) {
    const spec = problemOfLine(entry.text);
    if (spec !== null) {
      found.push({ spec, said: [], fills: [] });
      continue;
    }
    const last = found[found.length - 1];
    if (last === undefined || !/^\s*hint\b/.test(entry.text)) continue;
    const read = parseLine(entry.text);
    if (read.kind === 'line' && read.line.verb === 'hint' && (read.line.in === undefined || read.line.in === last.spec.id)) last.said.push(read.line.text);
  }
  return found;
}

/** The answers the brain put in the blank of a problem in these lines (`fill <id> | <answer>`), by problem id. */
export function fillsOf(lines: readonly { readonly seq: number; readonly text: string }[]): { readonly id: string; readonly key: string; readonly text: string }[] {
  const out: { id: string; key: string; text: string }[] = [];
  for (const entry of lines) {
    if (!/^\s*fill\b/i.test(entry.text)) continue;
    const read = parseLine(entry.text);
    if (read.kind === 'line' && read.line.verb === 'fill') out.push({ id: read.line.id, key: `${entry.seq}|${read.line.text}`, text: read.line.text });
  }
  return out;
}

/**
 * The problem the person is working, kept across turns: a follow-up turn (the brain answering "it is 12", or saying a word) holds no `problem` line,
 * but the problem is still on stage, so it stays up until the stage no longer holds it. A problem found in a turn takes its place.
 */
export function trackProblems(hook: { lines(): readonly LineView[]; elements(): readonly StageElementView[] }): () => readonly OnStage[] {
  let current: { spec: ProblemSpec; said: readonly string[]; fills: { key: string; text: string }[] } | null = null;
  const seen = new Set<string>();
  return () => {
    const lines = hook.lines();
    const found = problemsOf(lines)[0];
    if (found !== undefined) {
      const same = current !== null && current.spec.id === found.spec.id && current.spec.question === found.spec.question;
      current = { spec: found.spec, said: found.said, fills: same && current !== null ? current.fills : [] };
    } else if (current !== null) {
      const id = current.spec.id;
      if (!hook.elements().some((element) => element.id === id && element.text.startsWith('maths question'))) current = null;
    }
    if (current !== null) {
      for (const fill of fillsOf(lines)) {
        if (fill.id !== current.spec.id || seen.has(fill.key)) continue;
        seen.add(fill.key);
        current.fills.push({ key: fill.key, text: fill.text });
      }
    }
    return current === null ? [] : [current];
  };
}
