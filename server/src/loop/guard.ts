// What keeps the improvement loop from improving its score instead of its
// answers. These are checks made by code on every experiment, not requests
// made of a model. Pure functions; the loop's runner calls them.

import type { ExploreFamily } from '@conduit/language';
import type { Decision, FamilyScore, Measure, Proposal } from './types';

/**
 * Paths an experiment may not change. A builder that edits the test, the
 * judge, the rule that decides, or the record of what was decided has not
 * built anything.
 */
export const PROTECTED_PATHS: readonly string[] = [
  'explore/', // the batteries, the sealed sets, the owner's taste scores
  'loop/', // the changelog and the ledger
  'server/src/loop/', // the loop and this guard
  'server/src/tools/improve.ts',
  'server/src/tools/explore', // the battery runner, its checks and its judge (every file that starts so)
  'server/src/tools/taste.ts',
  'language/src/explore.ts',
  'language/src/taste.ts',
  'language/src/review.ts', // when to look is policy: a change to it is the owner's, not an experiment's
  'web/src/explore/',
  'web/src/taste/',
  'package.json',
  'pnpm-lock.yaml', // no new dependency arrives through the loop
  '.env',
  '.claude/',
];

/** Paths a builder is not even shown: its worktree is made without them. */
export const SEALED_PATHS: readonly string[] = ['explore/sealed/', 'explore/taste/', 'explore/runs/'];

export function touchesProtected(files: readonly string[]): string[] {
  return files.filter((file) => PROTECTED_PATHS.some((path) => file === path || file.startsWith(path)));
}

/**
 * Text from a battery found in source that is not a battery: an answer written
 * for the question instead of a capability built for the kind. `phrases` are
 * distinctive runs of words from every pool's prompts (the runner, which may
 * read the sealed sets, makes them); `added` is the text the diff adds.
 */
export function leaksBattery(added: string, phrases: readonly string[]): string[] {
  const text = added.toLowerCase().replace(/\s+/g, ' ');
  return phrases.filter((phrase) => phrase.length >= 12 && text.includes(phrase.toLowerCase()));
}

export interface KeepRule {
  /** the least rise in mean coherence, on the held-out set, in a family the experiment aimed at */
  readonly gain: number;
  /** the most any other family's mean coherence may fall */
  readonly slip: number;
  /** the most the share of correct answers may fall, in any family */
  readonly correctSlip: number;
  /** the most median output tokens may grow, as a share */
  readonly tokenGrowth: number;
  /** the most the median first line may slow, ms */
  readonly firstLineSlip: number;
  /** the fewest held-out answers a family needs for its numbers to count */
  readonly minN: number;
}

export const KEEP_RULE: KeepRule = { gain: 0.3, slip: 0.2, correctSlip: 0.1, tokenGrowth: 0.15, firstLineSlip: 400, minN: 6 };

/**
 * Whether an experiment is kept. `before` and `after` are the held-out set on
 * the baseline and on the candidate, run interleaved in the same session by
 * the same judge. Kept only when it is better on something it aimed at and no
 * worse, beyond noise, on anything else; a tie is a discard, because every
 * kept change is a thing to maintain.
 */
export function decide(proposal: Proposal, before: Measure, after: Measure, rule: KeepRule = KEEP_RULE): Decision {
  const reasons: string[] = [];
  if (before.pool !== 'heldout' || after.pool !== 'heldout') return { keep: false, reasons: ['it was not measured on the held-out set'] };
  if (before.rubric !== after.rubric) return { keep: false, reasons: ['the judge changed between the two runs: the scores cannot be compared'] };
  let gained = false;
  let lost = false;
  const families = new Set<ExploreFamily>([...(Object.keys(before.families) as ExploreFamily[]), ...(Object.keys(after.families) as ExploreFamily[])]);
  for (const family of families) {
    const was: FamilyScore | undefined = before.families[family];
    const is: FamilyScore | undefined = after.families[family];
    if (was === undefined || is === undefined || was.n < rule.minN || is.n < rule.minN) continue;
    const delta = is.coherence - was.coherence;
    const aimed = proposal.aims.includes(family);
    if (aimed && delta >= rule.gain) {
      gained = true;
      reasons.push(`${family}: coherence ${was.coherence.toFixed(2)} to ${is.coherence.toFixed(2)} (it aimed here)`);
    } else if (delta <= -rule.slip) {
      lost = true;
      reasons.push(`${family}: coherence fell ${was.coherence.toFixed(2)} to ${is.coherence.toFixed(2)}`);
    }
    if (is.correct < was.correct - rule.correctSlip) {
      lost = true;
      reasons.push(`${family}: fewer correct answers, ${Math.round(was.correct * 100)}% to ${Math.round(is.correct * 100)}%`);
    }
    if (is.collisions > was.collisions) {
      lost = true;
      reasons.push(`${family}: more collisions measured by the painter, ${was.collisions.toFixed(2)} to ${is.collisions.toFixed(2)} an answer`);
    }
    if (was.tokens > 0 && is.tokens > was.tokens * (1 + rule.tokenGrowth)) {
      lost = true;
      reasons.push(`${family}: answers grew from ${Math.round(was.tokens)} to ${Math.round(is.tokens)} tokens`);
    }
    if (is.firstLineMs > was.firstLineMs + rule.firstLineSlip) {
      lost = true;
      reasons.push(`${family}: the first line slowed from ${Math.round(was.firstLineMs)} to ${Math.round(is.firstLineMs)} ms`);
    }
  }
  if (!gained) reasons.push(`nothing it aimed at (${proposal.aims.join(', ')}) rose by ${rule.gain} or more`);
  return { keep: gained && !lost, reasons };
}
