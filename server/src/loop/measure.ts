// Measuring a branch through the battery's own `summary.json`, and pooling several runs into one number.
//
// Honesty rules kept here:
//   - baseline and candidate are run interleaved (A B B A ...), so a drift in the model, the judge or the
//     machine falls on both;
//   - the same judge instructions must have judged both (the rubric hash), or the runs are not compared;
//   - the spread between the baseline's own rounds is the noise: a gain no larger than it is not a gain.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExploreFamily, ExplorePool } from '@conduit/language';
import { exec } from './proc';
import type { FamilyScore, Measure } from './types';

export interface MeasureOptions {
  readonly pool: ExplorePool;
  readonly samples: number;
  /** the most this one run may cost, passed to the battery as its own cap */
  readonly capUsd: number;
  readonly signal: AbortSignal;
  /** shown in logs only */
  readonly label: string;
}

/** The seam: the real one runs `pnpm explore` in a tree; a stand-in answers from the tree's files. */
export interface Measurer {
  /** projected cost of one run, before it is started */
  estimate(tree: string, pool: ExplorePool, samples: number): Promise<number>;
  measure(tree: string, options: MeasureOptions): Promise<Measure | string>;
}

const NUMBER_KEYS: readonly (keyof FamilyScore)[] = ['n', 'coherence', 'correct', 'readable', 'asked', 'collisions', 'tokens', 'firstLineMs'];

/** Reads what the battery wrote. Refuses a file that does not carry every number the decision needs: a missing number is not a zero. */
export function readSummary(text: string, expectPool: ExplorePool): Measure | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'summary.json is not JSON';
  }
  if (typeof raw !== 'object' || raw === null) return 'summary.json is not an object';
  const body = raw as Record<string, unknown>;
  const rubric = body['rubric'] ?? body['rubricHash'];
  if (typeof rubric !== 'string' || rubric === '') return 'summary.json carries no rubric hash: the judge cannot be told to be the same';
  const pool = body['pool'];
  if (pool !== expectPool) return `summary.json is for pool ${String(pool)}, not ${expectPool}`;
  const families = body['families'];
  if (typeof families !== 'object' || families === null) return 'summary.json has no families';
  const out: Partial<Record<ExploreFamily, FamilyScore>> = {};
  for (const [name, value] of Object.entries(families)) {
    if (typeof value !== 'object' || value === null) return `family ${name} is not an object`;
    const row = value as Record<string, unknown>;
    for (const key of NUMBER_KEYS) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) return `family ${name} has no number for ${key}`;
    }
    out[name as ExploreFamily] = Object.fromEntries(NUMBER_KEYS.map((key) => [key, row[key] as number])) as unknown as FamilyScore;
  }
  const usd = body['usd'] ?? body['costUsd'];
  return { run: typeof body['run'] === 'string' ? body['run'] : 'unnamed', pool: expectPool, rubric, families: out, usd: typeof usd === 'number' ? usd : 0 };
}

/** Several runs of one arm as one measure: each number is the mean of the rounds, weighted by how many answers each had. */
export function pool(runs: readonly Measure[]): Measure | string {
  const first = runs[0];
  if (first === undefined) return 'nothing to pool';
  if (runs.some((run) => run.rubric !== first.rubric || run.pool !== first.pool)) return 'the rounds were judged by different instructions';
  const names = new Set<ExploreFamily>(runs.flatMap((run) => Object.keys(run.families) as ExploreFamily[]));
  const families: Partial<Record<ExploreFamily, FamilyScore>> = {};
  for (const name of names) {
    const rows = runs.map((run) => run.families[name]).filter((row): row is FamilyScore => row !== undefined);
    const n = rows.reduce((sum, row) => sum + row.n, 0);
    const mean = (key: keyof FamilyScore): number => (n === 0 ? 0 : rows.reduce((sum, row) => sum + row[key] * row.n, 0) / n);
    families[name] = { n, coherence: mean('coherence'), correct: mean('correct'), readable: mean('readable'), asked: mean('asked'), collisions: mean('collisions'), tokens: mean('tokens'), firstLineMs: mean('firstLineMs') };
  }
  return { run: runs.map((run) => run.run).join('+'), pool: first.pool, rubric: first.rubric, families, usd: runs.reduce((sum, run) => sum + run.usd, 0) };
}

/** The largest difference between two rounds of the same arm in any family's mean coherence: what chance alone moved. */
export function noiseOf(rounds: readonly Measure[]): number {
  let widest = 0;
  const names = new Set<ExploreFamily>(rounds.flatMap((run) => Object.keys(run.families) as ExploreFamily[]));
  for (const name of names) {
    const scores = rounds.map((run) => run.families[name]).filter((row): row is FamilyScore => row !== undefined && row.n > 0).map((row) => row.coherence);
    if (scores.length > 1) widest = Math.max(widest, Math.max(...scores) - Math.min(...scores));
  }
  return widest;
}

/** A, B, B, A, A, B ... for the number of rounds each arm gets. */
export function interleave(rounds: number): readonly ('baseline' | 'candidate')[] {
  const order: ('baseline' | 'candidate')[] = [];
  for (let i = 0; i < rounds; i++) order.push(...(i % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)));
  return order;
}

/** The real measurer: `pnpm explore --pool <pool>` run in the tree, and the summary it says it wrote read back. */
export function exploreMeasurer(): Measurer {
  const fixed = ['--filter', '@conduit/server', 'exec', 'tsx', '--env-file-if-exists=../.env', 'src/tools/explore.ts'];
  return {
    async estimate(tree, pool, samples) {
      const run = await exec({ bin: 'pnpm', args: [...fixed, '--dry-run', '--pool', pool, '--samples', String(samples)], cwd: tree, timeoutMs: 120_000 });
      const found = /(?:estimated|projected|about)[^$\n]*\$\s*([0-9]+(?:\.[0-9]+)?)/i.exec(run.stdout);
      // when the battery's plan cannot be read, a deliberately high figure: it is a reservation, and the real cost is what is charged
      return found?.[1] === undefined ? 3 : Number(found[1]);
    },
    async measure(tree, options) {
      const run = await exec({
        bin: 'pnpm',
        args: [...fixed, '--pool', options.pool, '--samples', String(options.samples), '--yes', '--max-usd', options.capUsd.toFixed(2), '--brain', 'claude-cli', '--model', 'sonnet'],
        cwd: tree,
        env: { ANTHROPIC_API_KEY: '', CLAUDE_MODEL: 'sonnet', REMOTE_AGENT: '', REMOTE_SESSION_ID: '' },
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
