// What can be said about an answer by counting, and by the judge: the verdicts the card shows, failed ones first.
// The rules themselves live in language/src/explore.ts, where the runner uses them too, so a card and a pass rate cannot disagree.

import type { ExploreResult } from '@conduit/language';
import { parseLine, verdictsOf } from '@conduit/language';

export { verdictsOf };
export type { ExploreVerdict as Verdict } from '@conduit/language';

export function failedCount(result: ExploreResult): number {
  return (result.verdicts ?? verdictsOf(result)).filter((verdict) => !verdict.ok).length;
}

export function wordsOf(result: ExploreResult): string[] {
  const words: string[] = [];
  for (const line of result.lines) {
    const parsed = parseLine(line.text);
    if (parsed.kind === 'line' && parsed.line.verb === 'say') words.push(parsed.line.text.replace(/\*/g, ''));
  }
  return words;
}

export function drewSomething(result: ExploreResult): boolean {
  return Object.entries(result.checks.kinds).some(([kind, amount]) => kind !== 'text' && (amount ?? 0) > 0);
}
