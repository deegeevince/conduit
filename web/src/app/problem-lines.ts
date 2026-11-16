// The problems on stage, read from the lines of the turn the stage holds: each `problem` line, and the `hint` lines written after it (what the plain
// workspace of a question the painter cannot read says when Hint is tapped).

import { parseLine, problemOfLine } from '@conduit/language';
import type { ProblemSpec } from '@conduit/language';

export interface OnStage {
  readonly spec: ProblemSpec;
  readonly said: readonly string[];
}

/** What may stand in a turn beside a problem for the problem to take the screen: the turn is the question and nothing else */
const ALONE = new Set(['scene', 'look', 'problem', 'hint', 'style', 'color', 'standing', 'reply', 'refine', 'end', 'wait']);

export function problemsOf(lines: readonly { readonly text: string }[]): OnStage[] {
  // a problem that is one part of a longer answer (a tour with a sum in it) is drawn where it stands; only a turn that is the question takes the whole screen
  if (lines.some((entry) => !ALONE.has((/^\s*([a-z]+)/i.exec(entry.text)?.[1] ?? '').toLowerCase()) && !/^\s*(#|$)/.test(entry.text))) return [];
  const found: { spec: ProblemSpec; said: string[] }[] = [];
  for (const entry of lines) {
    const spec = problemOfLine(entry.text);
    if (spec !== null) {
      found.push({ spec, said: [] });
      continue;
    }
    const last = found[found.length - 1];
    if (last === undefined || !/^\s*hint\b/.test(entry.text)) continue;
    const read = parseLine(entry.text);
    if (read.kind === 'line' && read.line.verb === 'hint' && (read.line.in === undefined || read.line.in === last.spec.id)) last.said.push(read.line.text);
  }
  return found;
}
