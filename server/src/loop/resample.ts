// How the keep rule behaves on noise. The rule (guard.ts `decide`, over measure.ts `compare`) is run on made-up held-out measurements
// whose truth is known: two arms with the SAME truth, which it must never keep, and two arms where one family truly rose by 1.0, which it
// should keep most of the time. Each trial draws every answer afresh (a judge's noise on each, a share of correct, a count of collisions,
// tokens, a first line), builds the summaries the battery would write, and sends them through the same functions a real run uses.
// A seeded generator makes it the same every time. `pnpm improve --resample`.

import type { ExploreFamily } from '@conduit/language';
import { decide } from './guard';
import { compare } from './measure';
import type { Measure, OwnMeasure, OwnName, PromptRow, Proposal } from './types';
import type { FamilyScore } from './types';

/** The held-out set as the plan lays it out: thirty prompts across the families. */
export const SHAPE: Readonly<Record<ExploreFamily, number>> = { diagram: 6, chart: 4, explorable: 3, mechanism: 3, scene: 3, type: 2, plain: 3, pixels: 2, paint: 2, motion: 1, open: 1 };

export interface Spec {
  readonly trials: number;
  readonly samples: number;
  readonly rounds: number;
  /** the judge's noise on one answer, in points of coherence */
  readonly judgeSd: number;
  /** how far prompts differ from each other in what they truly score (this cancels in a paired comparison) */
  readonly promptSd: number;
  /** the family the experiment aims at and how far it truly rose */
  readonly aim: ExploreFamily;
  readonly rise: number;
  /** whether the harness gives each metric per prompt (the pairing is then by prompt for all of them), or only the family's number per round */
  readonly perPrompt: boolean;
  readonly seed: number;
}

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWN: Readonly<Partial<Record<ExploreFamily, OwnName>>> = { chart: 'chartQuality', explorable: 'responds', diagram: 'readable' };

class Draw {
  constructor(private readonly next: () => number) {}
  normal(mean = 0, sd = 1): number {
    return mean + sd * Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next());
  }
  chance(p: number): number {
    return this.next() < p ? 1 : 0;
  }
  poisson(mean: number): number {
    const limit = Math.exp(-mean);
    let count = 0;
    for (let product = this.next(); product > limit; product *= this.next()) count += 1;
    return count;
  }
}

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
const middle = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? (sorted[at] as number) : ((sorted[at - 1] as number) + (sorted[at] as number)) / 2;
};

interface World {
  /** what each prompt truly scores, by family */
  readonly truth: Readonly<Record<string, readonly number[]>>;
}

function world(draw: Draw, spec: Spec): World {
  const truth: Record<string, number[]> = {};
  for (const [family, count] of Object.entries(SHAPE)) truth[family] = Array.from({ length: count }, () => 3.4 + draw.normal(0, spec.promptSd));
  return { truth };
}

/** One round of the battery on one arm: every answer drawn, then the summary the battery would write. */
function round(draw: Draw, spec: Spec, base: World, rise: number, label: string): Measure {
  const families: Partial<Record<ExploreFamily, FamilyScore>> = {};
  const prompts: PromptRow[] = [];
  for (const [name, truths] of Object.entries(base.truth)) {
    const family = name as ExploreFamily;
    const lift = family === spec.aim ? rise : 0;
    const all = { coherence: [] as number[], correct: [] as number[], readable: [] as number[], collisions: [] as number[], tokens: [] as number[], first: [] as number[], own: [] as number[] };
    truths.forEach((truth, index) => {
      const each = { coherence: [] as number[], correct: [] as number[], collisions: [] as number[], tokens: [] as number[], first: [] as number[], own: [] as number[] };
      for (let sample = 0; sample < spec.samples; sample++) {
        each.coherence.push(truth + lift + draw.normal(0, spec.judgeSd));
        each.correct.push(draw.chance(0.6));
        all.readable.push(draw.chance(0.8));
        each.collisions.push(draw.poisson(0.2));
        each.tokens.push(900 * Math.exp(draw.normal(0, 0.25)));
        each.first.push(2300 * Math.exp(draw.normal(0, 0.3)));
        each.own.push(OWN[family] === 'chartQuality' ? draw.normal(3.5, 0.8) : draw.chance(0.8));
      }
      all.coherence.push(...each.coherence);
      all.correct.push(...each.correct);
      all.collisions.push(...each.collisions);
      all.tokens.push(...each.tokens);
      all.first.push(...each.first);
      all.own.push(...each.own);
      prompts.push({
        id: `${family}-${index}`,
        family,
        coherence: mean(each.coherence),
        ...(spec.perPrompt ? { correct: mean(each.correct), collisions: mean(each.collisions), tokens: middle(each.tokens), firstLineMs: middle(each.first), own: OWN[family] === undefined ? null : mean(each.own) } : {}),
      });
    });
    const ownName = OWN[family];
    const own: OwnMeasure | null = ownName === undefined ? null : { name: ownName, value: mean(all.own) };
    families[family] = { n: all.coherence.length, judged: all.coherence.length, coherence: mean(all.coherence), correct: mean(all.correct), readable: mean(all.readable), asked: 0.9, collisions: mean(all.collisions), tokens: middle(all.tokens), firstLineMs: middle(all.first), own };
  }
  return { run: label, pool: 'heldout', rubric: 'simulated', samples: spec.samples, families, prompts, usd: 0 };
}

export interface Rates {
  readonly kept: number;
  readonly trials: number;
  /** why the others were not kept: the reason's family and verdict, with the numbers taken out, and how many trials gave it */
  readonly why: ReadonlyMap<string, number>;
}

/** How often the rule keeps, when the candidate's truth is the baseline's plus `rise` on the aimed family. */
export function keepRate(spec: Spec, rise: number): Rates {
  const next = generator(spec.seed + Math.round(rise * 1000));
  const draw = new Draw(next);
  const proposal: Proposal = { id: 'simulated', kind: 'technique', title: 'simulated', hypothesis: '', aims: [spec.aim], evidence: [], brief: '' };
  let kept = 0;
  const why = new Map<string, number>();
  for (let trial = 0; trial < spec.trials; trial++) {
    const truth = world(draw, spec);
    const baseline = Array.from({ length: spec.rounds }, (_, i) => round(draw, spec, truth, 0, `b${i}`));
    const candidate = Array.from({ length: spec.rounds }, (_, i) => round(draw, spec, truth, rise, `c${i}`));
    const comparison = compare(baseline, candidate);
    if (typeof comparison === 'string') continue;
    const decision = decide(proposal, comparison);
    if (decision.keep) kept += 1;
    else {
      for (const reason of decision.reasons) {
        if (reason.includes('not counted against') || reason.includes('only ')) continue;
        const key = reason.replace(/[-+]?\d+(\.\d+)?/g, '#').replace(/\(paired by[^)]*\)/, '').slice(0, 90);
        why.set(key, (why.get(key) ?? 0) + 1);
      }
    }
  }
  return { kept, trials: spec.trials, why };
}

const percent = (rates: Rates): string => `${((100 * rates.kept) / rates.trials).toFixed(1)}% (${rates.kept} of ${rates.trials})`;

export const DEFAULT_SPEC: Spec = { trials: 2000, samples: 3, rounds: 2, judgeSd: 0.9, promptSd: 0.7, aim: 'diagram', rise: 1, perPrompt: false, seed: 20261114 };

/** The report `pnpm improve --resample` prints. */
export function resampleReport(trials: number): string {
  const lines = ['The keep rule on made-up held-out runs (seeded; the same every time).', ''];
  lines.push(`Shape: ${Object.entries(SHAPE).map(([family, count]) => `${family} ${count}`).join(', ')} prompts; samples ${DEFAULT_SPEC.samples}, rounds ${DEFAULT_SPEC.rounds} an arm; judge noise ${DEFAULT_SPEC.judgeSd} a answer, prompts differ by ${DEFAULT_SPEC.promptSd}; the aimed family is ${DEFAULT_SPEC.aim} (${SHAPE[DEFAULT_SPEC.aim]} prompts).`, '');
  for (const perPrompt of [false, true]) {
    const spec: Spec = { ...DEFAULT_SPEC, trials, perPrompt };
    lines.push(`${perPrompt ? 'The harness gives every metric per prompt' : 'The harness as it is today: coherence per prompt, the other metrics per round'}:`);
    lines.push(`  two identical runs (truth the same, ${trials} trials):      kept ${percent(keepRate(spec, 0))}`);
    lines.push(`  a true +1.0 on ${spec.aim} (${trials} trials):                kept ${percent(keepRate(spec, 1))}`);
    lines.push(`  a true +0.5 on ${spec.aim}:                                kept ${percent(keepRate(spec, 0.5))}`);
    lines.push('');
  }
  const three: Spec = { ...DEFAULT_SPEC, trials, rounds: 3 };
  lines.push(`With three rounds an arm instead of two (today's harness):  two identical runs kept ${percent(keepRate(three, 0))}; a true +1.0 kept ${percent(keepRate(three, 1))}.`, '');
  const thin: Spec = { ...DEFAULT_SPEC, trials, aim: 'scene' };
  lines.push(`A family the set cannot resolve (${thin.aim}, ${SHAPE[thin.aim]} prompts), a true +1.0:  kept ${percent(keepRate(thin, 1))}: three prompts give too little to tell a rise from chance, and the rule says so by keeping rarely.`);
  return lines.join('\n');
}
