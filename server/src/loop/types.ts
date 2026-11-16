// The improvement loop: what it is made of. The contracts are here and
// the loop is run by runner.ts.
//
// One command, one budget:
//
//   pnpm improve --budget 12 --experiments 3
//
//   1. MEASURE   Run the battery's tune set and the held-out set on the branch as it stands.
//   2. CRITIC    A planning model (fable, effort xhigh) is given the tune set's judgements, the worst stills,
//                the painter's geometry counts, the technique index and the language reference. It writes what
//                is missing and proposes experiments, cheapest kind first: a technique, then a building block,
//                then a style, then the prompt. It is never shown the held-out set.
//   3. BUILD     For each proposal, a coding model (sonnet, effort high, --restricted, no shell) works in an export of
//                the base commit outside the repository: no .git, no sealed path, the protected paths read-only.
//                A technique is built as an overlay file.
//   4. GUARD     The diff is read back by code: protected paths untouched, no battery text in the source. The runner
//                then makes a commit by plumbing and runs typecheck, timeline and the prompt budget on a detached
//                copy, from the base commit's scripts. A diff that fails is discarded unmeasured.
//   5. RE-MEASURE The held-out set is run on the candidate and, interleaved, again on the baseline, by the base
//                commit's harness and the same judge, each arm with its own technique overlay.
//   6. DECIDE    `decide` (guard.ts): kept only if better on what it aimed at and no worse anywhere else, paired by
//                prompt, the gain and every veto clearing their own standard error.
//   7. REVIEW    A reviewer (fable, effort xhigh) reads the kept diff and the numbers cold, looking for a gain
//                that is the test being gamed rather than the answer being better.
//   8. STEWARD   The steward (opus, effort medium) approves or refuses, merges an approved experiment into the
//                integration branch, and moves an approved technique from the overlay into the seed.
//                Merging to `main` is the owner's.
//   9. LOG       Every experiment, kept or not, is one entry in loop/CHANGELOG.md and one line in loop/ledger.jsonl.
//
// Everything a model does here goes through the `claude` CLI on the owner's login. No API key is read.

import type { ExploreFamily, ExplorePool, TasteAgreement } from '@conduit/language';

/** What a run of the loop may spend. On a subscription the dollars are the CLI's own estimate of usage, not a bill: they are the meter, because they are the one number every call reports. */
export interface LoopBudget {
  readonly usd: number;
  readonly experiments: number;
  readonly minutes: number;
}

export interface AgentRole {
  /** passed to `claude --model` */
  readonly model: string;
  /** passed to `claude --effort` */
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Who does what. The builder never reviews its own work, and the model that steers is not the model that is steered. */
export interface LoopRoles {
  /** writes the answers that are measured: the product's own brain */
  readonly brain: AgentRole;
  readonly judge: AgentRole;
  /** reads the judgements and proposes what is missing */
  readonly critic: AgentRole;
  /** builds a proposal in its own worktree */
  readonly builder: AgentRole;
  /** reads a kept diff cold */
  readonly reviewer: AgentRole;
  /** approves, merges into the integration branch, writes techniques, keeps the root block true */
  readonly steward: AgentRole;
}

export const LOOP_ROLES: LoopRoles = {
  brain: { model: 'sonnet', effort: 'low' },
  judge: { model: 'sonnet', effort: 'medium' },
  critic: { model: 'fable', effort: 'xhigh' },
  builder: { model: 'sonnet', effort: 'high' },
  reviewer: { model: 'fable', effort: 'xhigh' },
  steward: { model: 'opus', effort: 'medium' },
};

/** The kinds of change, in the order they are tried: the cheapest to build, to undo and to trust comes first. */
export type ExperimentKind = 'technique' | 'block' | 'style' | 'prompt';
export const EXPERIMENT_ORDER: readonly ExperimentKind[] = ['technique', 'block', 'style', 'prompt'];

/** What the critic asks for. */
export interface Proposal {
  readonly id: string;
  readonly kind: ExperimentKind;
  readonly title: string;
  /** what is missing, and why this would supply it, in two or three sentences */
  readonly hypothesis: string;
  /** the families it is meant to raise */
  readonly aims: readonly ExploreFamily[];
  /** the tune-set answers that show the need, by file stem */
  readonly evidence: readonly string[];
  /** what to build, as a brief for the builder */
  readonly brief: string;
}

/** A family's numbers in one run of one pool. */
export interface FamilyScore {
  readonly n: number;
  /** mean judge coherence, 1 to 5 */
  readonly coherence: number;
  /** share of answers the judge found correct, readable, and what was asked */
  readonly correct: number;
  readonly readable: number;
  readonly asked: number;
  /** measured by the painter, per answer: text overlaps, crossed labels, links through nodes */
  readonly collisions: number;
  /** median output tokens, and median ms to the first visible line */
  readonly tokens: number;
  readonly firstLineMs: number;
  /** answers the judge actually judged: a family with none is not in a measure at all (nothing judged is not a zero) */
  readonly judged: number;
  /** the family's own measure, when it has one: charts' `chartQuality`, explorables' `responds`, diagrams' readable text; null when nothing was judged on it */
  readonly own: OwnMeasure | null;
}

export type OwnName = 'chartQuality' | 'responds' | 'readable';
export interface OwnMeasure {
  readonly name: OwnName;
  /** `chartQuality` is a score from 1 to 5; the others are shares from 0 to 1 */
  readonly value: number;
}

/** One prompt's numbers over its samples. Only `coherence` is required of a harness; the rest sharpen the pairing when it gives them. */
export interface PromptRow {
  readonly id: string;
  readonly family: ExploreFamily;
  readonly coherence: number | null;
  readonly correct?: number | null;
  readonly collisions?: number | null;
  readonly tokens?: number | null;
  readonly firstLineMs?: number | null;
  readonly own?: number | null;
}

/** The three samples a prompt needs for a number to be about the prompt and not about one draw. */
export const MIN_SAMPLES = 3;

export interface Measure {
  readonly run: string;
  readonly pool: ExplorePool;
  /** the judge's rubric hash: two measures are comparable only when it is the same */
  readonly rubric: string;
  /** samples per prompt in this run; never fewer than MIN_SAMPLES */
  readonly samples: number;
  readonly families: Readonly<Partial<Record<ExploreFamily, FamilyScore>>>;
  /** per prompt, so that two arms can be paired by prompt; empty in a pooled measure */
  readonly prompts: readonly PromptRow[];
  readonly usd: number;
}

export type MetricName = 'coherence' | 'correct' | 'collisions' | 'tokens' | 'firstLineMs' | 'own';

/** What one metric did between the arms, and how sure the run can be of it. */
export interface Estimate {
  readonly before: number;
  readonly after: number;
  /** after less before: the mean of the paired differences */
  readonly delta: number;
  /** standard error of that mean; Infinity when there are too few pairs to say */
  readonly se: number;
  /** degrees of freedom (pairs less one); 0 when it cannot be estimated */
  readonly df: number;
  /** what was paired: the same prompt in both arms (best), or the same round (when the harness reports no per-prompt number for this) */
  readonly paired: 'prompts' | 'rounds';
}

export interface FamilyComparison {
  /** answers judged in each arm, summed over its rounds */
  readonly judgedBefore: number;
  readonly judgedAfter: number;
  readonly ownName: OwnName | null;
  readonly metrics: Readonly<Partial<Record<MetricName, Estimate>>>;
}

/** Baseline and candidate, paired. A family is in it only when something was judged in it in every round of both arms. */
export interface Comparison {
  readonly pool: ExplorePool;
  readonly rubric: string;
  readonly samples: number;
  readonly rounds: { readonly baseline: number; readonly candidate: number };
  readonly families: Readonly<Partial<Record<ExploreFamily, FamilyComparison>>>;
}

export interface Decision {
  readonly keep: boolean;
  /** every reason, for and against, in plain words: this is what the changelog prints */
  readonly reasons: readonly string[];
}

export type Verdict = { readonly by: 'reviewer' | 'steward'; readonly approve: boolean; readonly why: string };

/** One experiment, from proposal to verdict. One line of loop/ledger.jsonl. */
export interface ExperimentRecord {
  readonly id: string;
  readonly started: string;
  readonly proposal: Proposal;
  readonly branch: string;
  /** files the build changed, with lines added and removed */
  readonly diff: readonly { readonly file: string; readonly added: number; readonly removed: number }[];
  /** why the guard refused the diff before measuring; empty when it did not */
  readonly refused: readonly string[];
  readonly before: Measure | null;
  readonly after: Measure | null;
  readonly decision: Decision | null;
  readonly verdicts: readonly Verdict[];
  /** how far the judge agreed with the owner when this was decided */
  readonly taste: TasteAgreement | null;
  /** no sheet of the owner's scores exists for this rubric: the run proposed and built nothing (outcome `proposed`) */
  readonly uncalibrated?: boolean;
  readonly usd: number;
  readonly outcome: 'kept' | 'discarded' | 'refused' | 'failed' | 'awaiting-steward' | 'proposed';
}
