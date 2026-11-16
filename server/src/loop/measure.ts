// Measuring a branch through the battery's own `summary.json`, and pairing two arms into one comparison.
//
// Honesty rules kept here:
//   - baseline and candidate are run interleaved (A B B A ...), so a drift in the model, the judge or the
//     machine falls on both;
//   - both arms are measured by the BASE commit's harness, summary and counters (the runner puts them there; git.ts);
//   - each arm is given its own technique overlay, and the measurer asserts, before it spends anything, that the library
//     the battery will use did load exactly that overlay;
//   - the same judge instructions must have judged both (the rubric hash), or the runs are not compared;
//   - at least MIN_SAMPLES samples a prompt: fewer is a draw, not a measurement;
//   - the arms are PAIRED by prompt (rounds are the fallback when a harness gives no per-prompt number): the spread is
//     the spread of the differences, which is the noise that matters;
//   - a family in which nothing was judged is absent, never a zero.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExploreFamily, ExplorePool } from '@conduit/language';
import { readTechniqueDir } from '../library/files';
import { exec } from './proc';
import { MIN_SAMPLES } from './types';
import type { Comparison, Estimate, FamilyComparison, FamilyScore, Measure, MetricName, OwnMeasure, OwnName, PromptRow } from './types';

export interface MeasureOptions {
  readonly pool: ExplorePool;
  readonly samples: number;
  /** the most this one run may cost, passed to the battery as its own cap */
  readonly capUsd: number;
  readonly signal: AbortSignal;
  /** shown in logs only */
  readonly label: string;
  /** the folder, outside every tree, that holds the held-out set; null when there is none (then nothing but the tune set can be measured) */
  readonly sealedDir: string | null;
}

/** The seam: the real one runs `pnpm explore` in a tree; a stand-in answers from the tree's files. */
export interface Measurer {
  /** projected cost of one run, before it is started */
  estimate(tree: string, pool: ExplorePool, samples: number): Promise<number>;
  measure(tree: string, options: MeasureOptions): Promise<Measure | string>;
}

const FAMILY_NUMBERS: readonly string[] = ['n', 'coherence', 'correct', 'readable', 'asked', 'collisions', 'tokens', 'firstLineMs'];
const OWN_OF: Readonly<Partial<Record<ExploreFamily, OwnName>>> = { chart: 'chartQuality', explorable: 'responds', diagram: 'readable' };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** A measure the battery wrote as `bar.<name>`: `{ value, n }`. */
function barValue(bar: Record<string, unknown> | null, name: string): number | null {
  const found = record(bar?.[name]);
  return found !== null && finite(found['value']) && finite(found['n']) && found['n'] > 0 ? found['value'] : null;
}

/** Reads what the battery wrote. Refuses a file that does not carry every number the decision needs: a missing number is not a zero. */
export function readSummary(text: string, expectPool: ExplorePool): Measure | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'summary.json is not JSON';
  }
  const body = record(raw);
  if (body === null) return 'summary.json is not an object';
  const rubric = body['rubric'] ?? body['rubricHash'];
  if (typeof rubric !== 'string' || rubric === '') return 'summary.json carries no rubric hash: the judge cannot be told to be the same';
  const pool = body['pool'];
  if (pool !== expectPool) return `summary.json is for pool ${String(pool)}, not ${expectPool}`;
  const samples = body['samples'];
  if (!finite(samples)) return 'summary.json does not say how many samples a prompt had';
  if (samples < MIN_SAMPLES) return `summary.json has ${samples} sample(s) a prompt; fewer than ${MIN_SAMPLES} is a draw, not a measurement`;
  const families = record(body['families']);
  if (families === null) return 'summary.json has no families';
  const out: Partial<Record<ExploreFamily, FamilyScore>> = {};
  for (const [name, value] of Object.entries(families)) {
    const row = record(value);
    if (row === null) return `family ${name} is not an object`;
    for (const key of FAMILY_NUMBERS) {
      if (!finite(row[key])) return `family ${name} has no number for ${key}`;
    }
    const bar = record(row['bar']);
    // answers judged: the battery says so under `bar`; a summary that does not is read as "judged when it scored above nothing"
    const judged = bar !== null && finite(bar['judged']) ? bar['judged'] : (row['coherence'] as number) > 0 ? (row['n'] as number) : 0;
    // nothing judged is nothing known: the family is not in the measure, whatever zeros the summary printed
    if (judged <= 0) continue;
    const ownName = OWN_OF[name as ExploreFamily];
    const ownValue = ownName === undefined ? null : ownName === 'chartQuality' ? barValue(bar, 'chartQuality') : ownName === 'responds' ? barValue(bar, 'responds') : (row['readable'] as number);
    const own: OwnMeasure | null = ownName === undefined || ownValue === null ? null : { name: ownName, value: ownValue };
    const num = (key: string): number => (finite(row[key]) ? row[key] : 0);
    out[name as ExploreFamily] = { n: num('n'), coherence: num('coherence'), correct: num('correct'), readable: num('readable'), asked: num('asked'), collisions: num('collisions'), tokens: num('tokens'), firstLineMs: num('firstLineMs'), judged, own };
  }
  const prompts: PromptRow[] = [];
  const listed = body['prompts'];
  if (Array.isArray(listed)) {
    for (const item of listed) {
      const row = record(item);
      if (row === null || typeof row['id'] !== 'string' || typeof row['family'] !== 'string') continue;
      const number = (key: string): number | null => (finite(row[key]) ? row[key] : null);
      prompts.push({ id: row['id'], family: row['family'] as ExploreFamily, coherence: number('coherence'), correct: number('correct'), collisions: number('collisions'), tokens: number('tokens'), firstLineMs: number('firstLineMs'), own: number('own') });
    }
  }
  const usd = body['usd'] ?? body['costUsd'];
  return { run: typeof body['run'] === 'string' ? body['run'] : 'unnamed', pool: expectPool, rubric, samples, families: out, prompts, usd: typeof usd === 'number' ? usd : 0 };
}

/** Several runs of one arm as one measure for the record: each number is the mean of the rounds, weighted by the answers judged. The comparison is made from the rounds, not from this. */
export function pool(runs: readonly Measure[]): Measure | string {
  const first = runs[0];
  if (first === undefined) return 'nothing to pool';
  if (runs.some((run) => run.rubric !== first.rubric || run.pool !== first.pool)) return 'the rounds were judged by different instructions';
  const names = new Set<ExploreFamily>(runs.flatMap((run) => Object.keys(run.families) as ExploreFamily[]));
  const families: Partial<Record<ExploreFamily, FamilyScore>> = {};
  for (const name of names) {
    const rows = runs.map((run) => run.families[name]).filter((row): row is FamilyScore => row !== undefined);
    const judged = rows.reduce((sum, row) => sum + row.judged, 0);
    const n = rows.reduce((sum, row) => sum + row.n, 0);
    if (judged === 0) continue;
    const mean = (pick: (row: FamilyScore) => number): number => rows.reduce((sum, row) => sum + pick(row) * row.judged, 0) / judged;
    const owns = rows.flatMap((row) => (row.own === null ? [] : [row.own]));
    const first = owns[0];
    families[name] = {
      n,
      judged,
      coherence: mean((row) => row.coherence),
      correct: mean((row) => row.correct),
      readable: mean((row) => row.readable),
      asked: mean((row) => row.asked),
      collisions: mean((row) => row.collisions),
      tokens: mean((row) => row.tokens),
      firstLineMs: mean((row) => row.firstLineMs),
      own: first === undefined ? null : { name: first.name, value: owns.reduce((sum, own) => sum + own.value, 0) / owns.length },
    };
  }
  return { run: runs.map((run) => run.run).join('+'), pool: first.pool, rubric: first.rubric, samples: Math.min(...runs.map((run) => run.samples)), families, prompts: [], usd: runs.reduce((sum, run) => sum + run.usd, 0) };
}

// -- pairing ---------------------------------------------------------------------------------------------------------

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** The mean of paired differences and its standard error. Fewer than two pairs: the error is not known (Infinity), never zero. */
function estimateOf(before: readonly number[], after: readonly number[], paired: Estimate['paired']): Estimate | null {
  const k = Math.min(before.length, after.length);
  if (k === 0) return null;
  const diffs = Array.from({ length: k }, (_, i) => (after[i] as number) - (before[i] as number));
  const delta = mean(diffs);
  const variance = k < 2 ? Infinity : diffs.reduce((sum, d) => sum + (d - delta) ** 2, 0) / (k - 1);
  return { before: mean(before.slice(0, k)), after: mean(after.slice(0, k)), delta, se: Math.sqrt(variance / k), df: k - 1, paired };
}

const PROMPT_FIELD: Readonly<Record<MetricName, keyof PromptRow>> = { coherence: 'coherence', correct: 'correct', collisions: 'collisions', tokens: 'tokens', firstLineMs: 'firstLineMs', own: 'own' };

/** A prompt's number averaged over an arm's rounds, by prompt id. */
function byPrompt(rounds: readonly Measure[], family: ExploreFamily, metric: MetricName): Map<string, number> {
  const field = PROMPT_FIELD[metric];
  const sums = new Map<string, number[]>();
  for (const round of rounds) {
    for (const row of round.prompts) {
      const value = row[field];
      if (row.family !== family || typeof value !== 'number') continue;
      sums.set(row.id, [...(sums.get(row.id) ?? []), value]);
    }
  }
  return new Map([...sums].map(([id, values]) => [id, mean(values)]));
}

function roundValue(round: Measure, family: ExploreFamily, metric: MetricName): number | null {
  const row = round.families[family];
  if (row === undefined) return null;
  return metric === 'own' ? (row.own?.value ?? null) : row[metric];
}

/**
 * Baseline rounds against candidate rounds. A metric is paired by prompt when the harness gives that number per prompt in both
 * arms (each prompt's mean over the rounds); otherwise round i of one arm is paired with round i of the other, which the
 * interleaving made neighbours in time. The first needs at least two prompts, the second at least two rounds, and with fewer the
 * error is Infinity and the metric clears nothing.
 */
export function compare(baseline: readonly Measure[], candidate: readonly Measure[]): Comparison | string {
  const first = baseline[0];
  if (first === undefined || candidate[0] === undefined) return 'one arm has no rounds';
  const all = [...baseline, ...candidate];
  if (all.some((round) => round.rubric !== first.rubric)) return 'the judge changed between the rounds: the scores cannot be compared';
  if (all.some((round) => round.pool !== first.pool)) return 'the rounds are of different pools';
  const names = new Set<ExploreFamily>(all.flatMap((round) => Object.keys(round.families) as ExploreFamily[]));
  const families: Partial<Record<ExploreFamily, FamilyComparison>> = {};
  for (const name of names) {
    // absent in any round of either arm (nothing judged there): absent, not a zero
    if (all.some((round) => round.families[name] === undefined)) continue;
    const metrics: Partial<Record<MetricName, Estimate>> = {};
    for (const metric of ['coherence', 'correct', 'collisions', 'tokens', 'firstLineMs', 'own'] as const) {
      const was = byPrompt(baseline, name, metric);
      const is = byPrompt(candidate, name, metric);
      const ids = [...was.keys()].filter((id) => is.has(id));
      let estimate = ids.length >= 2 ? estimateOf(ids.map((id) => was.get(id) as number), ids.map((id) => is.get(id) as number), 'prompts') : null;
      if (estimate === null) {
        const pairs = Math.min(baseline.length, candidate.length);
        const a: number[] = [];
        const b: number[] = [];
        for (let i = 0; i < pairs; i++) {
          const x = roundValue(baseline[i] as Measure, name, metric);
          const y = roundValue(candidate[i] as Measure, name, metric);
          if (x !== null && y !== null) {
            a.push(x);
            b.push(y);
          }
        }
        estimate = estimateOf(a, b, 'rounds');
      }
      if (estimate !== null) metrics[metric] = estimate;
    }
    const owns = all.flatMap((round) => (round.families[name]?.own === null || round.families[name]?.own === undefined ? [] : [round.families[name]?.own as OwnMeasure]));
    const sum = (arm: readonly Measure[]): number => arm.reduce((total, round) => total + (round.families[name]?.judged ?? 0), 0);
    families[name] = { judgedBefore: sum(baseline), judgedAfter: sum(candidate), ownName: owns[0]?.name ?? null, metrics };
  }
  return { pool: first.pool, rubric: first.rubric, samples: Math.min(...all.map((round) => round.samples)), rounds: { baseline: baseline.length, candidate: candidate.length }, families };
}

/** A, B, B, A, A, B ... for the number of rounds each arm gets. */
export function interleave(rounds: number): readonly ('baseline' | 'candidate')[] {
  const order: ('baseline' | 'candidate')[] = [];
  for (let i = 0; i < rounds; i++) order.push(...(i % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)));
  return order;
}

// -- the real measurer -----------------------------------------------------------------------------------------------

const EXPLORE = ['--filter', '@conduit/server', 'exec', 'tsx', '--env-file-if-exists=../.env', 'src/tools/explore.ts'];

/** What an arm is measured under: the seed library (the same in both arms, with no network and no cache between), its own overlay (the techniques folder of its own tree), the model the loop compares at, and the folder the held-out set is in. */
export function measurementEnvironment(tree: string, pool: ExplorePool, sealedDir: string | null): Record<string, string> {
  return { LIBRARY: 'seed', LIBRARY_OVERLAY: join(tree, 'techniques', 'overlay'), CLAUDE_MODEL: 'sonnet', BATTERY_SEALED_DIR: pool !== 'heldout' || sealedDir === null ? '' : sealedDir };
}

/**
 * Asks the library, loaded from the environment the battery will be started with, what it loaded from the overlay, and compares that with
 * the folder itself. A measurement of a technique that was never in the library measures the baseline twice; this is why it is refused
 * before it spends.
 */
export async function assertOverlayLoaded(tree: string, env: Readonly<Record<string, string>>): Promise<string | null> {
  const overlayDir = env['LIBRARY_OVERLAY'] ?? '';
  const expected = readTechniqueDir(overlayDir, 'overlay').length;
  const run = await exec({ bin: 'pnpm', args: ['--filter', '@conduit/server', 'exec', 'tsx', '--env-file-if-exists=../.env', 'src/loop/overlay-probe.ts'], cwd: tree, env, timeoutMs: 120_000 });
  const line = run.stdout.split('\n').find((text) => text.startsWith('OVERLAY '));
  if (run.code !== 0 || line === undefined) return `the library could not be asked what it loaded: ${(run.stderr || run.stdout).trim().slice(-200)}`;
  const loaded = Number(line.slice('OVERLAY '.length));
  if (!Number.isInteger(loaded)) return `the library answered "${line}", not a number`;
  if (loaded !== expected) return `the overlay was not loaded as laid: ${overlayDir} holds ${expected} technique(s) and the library loaded ${loaded}`;
  return null;
}

/** The real measurer: `pnpm explore --pool <pool>` run in the tree, and the summary it says it wrote read back. */
export function exploreMeasurer(): Measurer {
  return {
    async estimate(tree, pool, samples) {
      const run = await exec({ bin: 'pnpm', args: [...EXPLORE, '--dry-run', '--pool', pool, '--samples', String(samples)], cwd: tree, timeoutMs: 120_000 });
      const found = /(?:estimated|projected|about)[^$\n]*\$\s*([0-9]+(?:\.[0-9]+)?)/i.exec(run.stdout);
      // when the battery's plan cannot be read, a deliberately high figure: it is a reservation, and the real cost is what is charged
      return found?.[1] === undefined ? 3 : Number(found[1]);
    },
    async measure(tree, options) {
      if (options.samples < MIN_SAMPLES) return `${options.samples} sample(s) a prompt is fewer than ${MIN_SAMPLES}: not measured`;
      if (options.pool === 'heldout' && options.sealedDir === null) return 'BATTERY_SEALED_DIR is not set: the held-out set is not where the loop can use it, and there is no held-out set in any tree';
      const env = measurementEnvironment(tree, options.pool, options.sealedDir);
      const missing = await assertOverlayLoaded(tree, env);
      if (missing !== null) return missing;
      const run = await exec({
        bin: 'pnpm',
        args: [...EXPLORE, '--pool', options.pool, '--samples', String(options.samples), '--yes', '--max-usd', options.capUsd.toFixed(2), '--brain', 'claude-cli', '--model', 'sonnet'],
        cwd: tree,
        env,
        signal: options.signal,
      });
      if (run.aborted) return 'stopped';
      const written = /written to\s+(\S+)/.exec(run.stdout);
      if (run.code !== 0 || written?.[1] === undefined) return `the battery failed (${options.label}): ${(run.stderr || run.stdout).trim().slice(-300)}`;
      const dir = written[1].startsWith('/') ? written[1] : join(tree, written[1]);
      const file = (await readdir(dir).catch((): string[] => [])).includes('summary.json') ? join(dir, 'summary.json') : null;
      if (file === null) return `the battery wrote no summary.json in ${dir}`;
      return readSummary(await readFile(file, 'utf8'), options.pool);
    },
  };
}
