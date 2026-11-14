// What keeps the improvement loop from improving its score instead of its
// answers. These are checks made by code on every experiment, not requests
// made of a model. Pure functions; the loop's runner calls them.

import type { ExploreFamily } from '@conduit/language';
import type { Comparison, Decision, Estimate, MetricName, OwnName, Proposal } from './types';

/**
 * Paths an experiment may not change, and that the measurer takes from the BASE commit whatever the candidate holds. A builder that
 * edits the test, the judge, the counters, the geometry the counters stand on, the rule that decides, or the record of what was
 * decided has not built anything. Everything the harness is made of is here: the battery runner and its checks, the summary it
 * writes, the sight and geometry modules that decide what is an overlap, the barrel that exports them, the judge, and the file
 * that says what was loaded.
 */
export const PROTECTED_PATHS: readonly string[] = [
  'explore/', // the batteries, the sealed sets, the owner's taste scores
  'loop/', // the changelog and the ledger
  'server/src/loop/', // the loop and this guard
  'server/src/tools/improve.ts',
  'server/src/tools/explore', // the battery runner, its checks and its judge (every file that starts so)
  'server/src/tools/taste.ts',
  'server/src/judge/', // the judge and its rubric
  'server/src/critic/',
  'server/src/library/', // what a technique is and whether the overlay was loaded
  'server/src/brains/', // the brain that is measured
  'server/src/env.ts',
  'language/src/explore.ts', // the summary, the bar, the counters' arithmetic
  'language/src/taste.ts',
  'language/src/review.ts', // when to look is policy: a change to it is the owner's, not an experiment's
  'language/src/sight.ts', // what is seen on the stage: the counters read it
  'language/src/geometry.ts', // what overlaps what
  'language/src/index.ts', // the barrel: a re-export here would swap a module for another
  'language/src/wire.ts',
  'language/src/context.ts',
  'web/src/explore/',
  'web/src/explore.ts',
  'web/explore.html',
  'web/src/taste/',
  'web/src/taste.ts',
  'web/src/contracts/', // the plan and the frames the counters are made from
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml', // no new dependency arrives through the loop
  '.npmrc',
  '.env',
  '.claude/',
];

/** Files protected wherever they are: what a command is, what it is checked by. A builder cannot change what `pnpm typecheck` or `pnpm explore` runs. */
const PROTECTED_NAMES: readonly RegExp[] = [/^package\.json$/, /^tsconfig[^/]*\.json$/, /^vite\.config\.[cm]?[jt]s$/, /^\.npmrc$/, /^\.env(\..*)?$/];

/** Paths a builder is not even shown: its tree is made without them, and the folder the held-out set lives in is outside every tree. */
export const SEALED_PATHS: readonly string[] = ['explore/sealed/', 'explore/taste/', 'explore/runs/'];

export const isProtected = (file: string): boolean => PROTECTED_PATHS.some((path) => file === path || file.startsWith(path)) || PROTECTED_NAMES.some((pattern) => pattern.test(file.slice(file.lastIndexOf('/') + 1)));

export function touchesProtected(files: readonly string[]): string[] {
  return files.filter(isProtected);
}

/**
 * Text from a battery found in source that is not a battery: an answer written
 * for the question instead of a capability built for the kind. `phrases` are
 * distinctive runs of words from every pool's prompts (the runner, which may
 * read the sealed sets, makes them); `added` is the text the diff adds.
 * The phrases found are COUNTED by the caller and never quoted: a refusal is read by the builder and kept in the changelog.
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
  /** the most a family's own measure may fall: `chartQuality` is a score out of five, the others are shares */
  readonly ownSlip: Readonly<Record<OwnName, number>>;
  /** the most collisions an answer may gain, painter-counted */
  readonly collisionRise: number;
  /** the most median output tokens may grow, as a share */
  readonly tokenGrowth: number;
  /** the most the median first line may slow, ms */
  readonly firstLineSlip: number;
  /** the fewest answers judged, in each arm, for a family's numbers to count */
  readonly minN: number;
}

export const KEEP_RULE: KeepRule = { gain: 0.3, slip: 0.2, correctSlip: 0.1, ownSlip: { chartQuality: 0.2, responds: 0.1, readable: 0.1 }, collisionRise: 0.1, tokenGrowth: 0.15, firstLineSlip: 400, minN: 6 };

/** One-sided 97.5% points of Student's t, by degrees of freedom: what a mean must be over its standard error to be told from chance. */
const T975: readonly (readonly [number, number])[] = [[1, 12.71], [2, 4.3], [3, 3.18], [4, 2.78], [5, 2.57], [6, 2.45], [7, 2.36], [8, 2.31], [9, 2.26], [10, 2.23], [15, 2.13], [20, 2.09], [30, 2.04], [60, 2.0]];

export function tCritical(df: number): number {
  if (!(df >= 1)) return Infinity;
  for (const [limit, value] of T975) if (df <= limit) return value;
  return 1.96;
}

/**
 * A difference is clear of chance when it is more than the t point times its own standard error. A run that could not estimate its error
 * clears nothing, and neither does one that had only two pairs, nor one paired by round: a spread read off two or three round totals
 * can be anything, and is sometimes zero (resample.ts counted the spurious vetoes that gave). Only a metric the harness reports per
 * prompt, for at least three prompts, can say it is not chance; the rest are said to be unresolved and never counted for or against.
 */
export function clearOfNoise(estimate: Estimate): boolean {
  if (!Number.isFinite(estimate.se) || estimate.df < 2 || estimate.paired !== 'prompts') return false;
  return Math.abs(estimate.delta) > tCritical(estimate.df) * estimate.se;
}

const FIELD: Readonly<Record<MetricName, string>> = { coherence: 'coherence', correct: 'correct answers', collisions: 'collisions per answer', tokens: 'tokens', firstLineMs: 'first line', own: 'own measure' };

function seNote(estimate: Estimate): string {
  return Number.isFinite(estimate.se) ? `${estimate.delta >= 0 ? '+' : ''}${estimate.delta.toFixed(2)} +/- ${estimate.se.toFixed(2)} (paired by ${estimate.paired}, ${estimate.df} df)` : 'its error could not be estimated';
}

/**
 * Whether an experiment is kept. The comparison is the held-out set measured on the baseline and on the candidate, interleaved,
 * by the base commit's harness and one judge, PAIRED by prompt. The gain and every veto must each clear their own standard error:
 * a rise is a gain only when its lower confidence bound (the mean less the t point times its standard error) still reaches the bar; a
 * fall is a veto only when it reaches its allowance and is told from chance. A tie is a discard, because every kept change is a
 * thing to maintain. What the run could not resolve is said, and never counted as a veto or as a gain.
 */
export function decide(proposal: Proposal, comparison: Comparison, rule: KeepRule = KEEP_RULE): Decision {
  const reasons: string[] = [];
  if (comparison.pool !== 'heldout') return { keep: false, reasons: ['it was not measured on the held-out set'] };
  let gained = false;
  let lost = false;
  for (const [name, family] of Object.entries(comparison.families) as [ExploreFamily, NonNullable<Comparison['families'][ExploreFamily]>][]) {
    if (family.judgedBefore < rule.minN || family.judgedAfter < rule.minN) {
      reasons.push(`${name}: only ${Math.min(family.judgedBefore, family.judgedAfter)} judged answers in an arm, fewer than ${rule.minN}: not counted`);
      continue;
    }
    const aimed = proposal.aims.includes(name);
    const note = (metric: MetricName, estimate: Estimate): string => `${name}: ${FIELD[metric]} ${estimate.before.toFixed(2)} to ${estimate.after.toFixed(2)}, ${seNote(estimate)}`;
    const coherence = family.metrics.coherence;
    if (coherence !== undefined) {
      if (aimed && coherence.delta >= rule.gain) {
        if (coherence.delta - tCritical(coherence.df) * coherence.se >= rule.gain) {
          gained = true;
          reasons.push(`${note('coherence', coherence)} (it aimed here; its lower bound still clears the bar)`);
        } else reasons.push(`${note('coherence', coherence)}: the rise it aimed for is not clear of chance: not a gain`);
      } else if (-coherence.delta >= rule.slip) {
        if (clearOfNoise(coherence)) {
          lost = true;
          reasons.push(`${note('coherence', coherence)}: a fall that is not chance`);
        } else reasons.push(`${note('coherence', coherence)}: a fall of the size that matters, but not clear of chance (not counted against it)`);
      }
    }
    const veto = (metric: MetricName, estimate: Estimate | undefined, harm: (e: Estimate) => number, allowance: number): void => {
      if (estimate === undefined || harm(estimate) < allowance) return;
      if (clearOfNoise(estimate)) {
        lost = true;
        reasons.push(`${note(metric, estimate)}: worse, and not chance`);
      } else reasons.push(`${note(metric, estimate)}: worse by the allowance or more, but not clear of chance, or not resolvable by this harness (not counted against it)`);
    };
    veto('correct', family.metrics.correct, (e) => -e.delta, rule.correctSlip);
    if (family.ownName !== null) veto('own', family.metrics.own, (e) => -e.delta, rule.ownSlip[family.ownName]);
    veto('collisions', family.metrics.collisions, (e) => e.delta, rule.collisionRise);
    const tokens = family.metrics.tokens;
    if (tokens !== undefined && tokens.before > 0) veto('tokens', tokens, (e) => e.delta / e.before, rule.tokenGrowth);
    veto('firstLineMs', family.metrics.firstLineMs, (e) => e.delta, rule.firstLineSlip);
  }
  if (!gained) reasons.push(`nothing it aimed at (${proposal.aims.join(', ')}) rose by ${rule.gain} or more beyond its standard error`);
  return { keep: gained && !lost, reasons };
}

/** Where each kind of experiment may change files. A technique that edits the painter, or a style that edits the prompt, is a different experiment under another name. */
export const KIND_ROOTS: Readonly<Record<'technique' | 'block' | 'style' | 'prompt', readonly string[]>> = {
  technique: ['techniques/'],
  block: ['web/src/painter/', 'web/src/render/', 'language/src/'],
  style: ['web/src/looks/', 'web/src/styles/', 'web/src/render/'],
  prompt: ['language/src/prompt.ts'],
};

export function outsideKind(kind: keyof typeof KIND_ROOTS, files: readonly string[]): string[] {
  const roots = KIND_ROOTS[kind];
  return files.filter((file) => !roots.some((root) => file === root || file.startsWith(root)));
}

/** Runs of six words from each prompt, to look for in a diff: the prompt itself, or a long piece of it, in source is a battery answered by rote. */
export function phrasesOf(prompts: readonly string[], words = 6): string[] {
  const out = new Set<string>();
  for (const prompt of prompts) {
    const tokens = prompt.toLowerCase().replace(/\s+/g, ' ').trim().split(' ');
    if (tokens.length <= words) out.add(tokens.join(' '));
    for (let i = 0; i + words <= tokens.length; i++) out.add(tokens.slice(i, i + words).join(' '));
  }
  return [...out].filter((phrase) => phrase.length >= 12);
}
