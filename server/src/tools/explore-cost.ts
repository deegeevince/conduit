// What a run will cost, before it begins. The call counts are exact; the dollars per call come from the last run
// on the same model that recorded them (ExploreRun.measured) and otherwise from a rough table.

import type { ExploreRun } from '@conduit/language';

export interface Plan {
  /** brain turns that start a conversation (a cold process: the system prompt is written to the cache) */
  readonly firstTurns: number;
  /** brain turns that continue one (warm) */
  readonly laterTurns: number;
  readonly judgeCalls: number;
  /** extra pictures the judge is shown beyond the first, over all calls */
  readonly extraImages: number;
  readonly baselines: number;
}

export interface PerCall {
  readonly firstTurnUsd: number;
  readonly laterTurnUsd: number;
  readonly judgeUsd: number;
  readonly extraImageUsd: number;
  readonly baselineUsd: number;
  /** where these numbers came from */
  readonly source: string;
}

/** Rough, for a model nobody has run yet: a cold turn is mostly the 8,000-token prompt written to the cache. */
const ROUGH: Readonly<Record<string, PerCall>> = {
  haiku: { firstTurnUsd: 0.015, laterTurnUsd: 0.006, judgeUsd: 0.006, extraImageUsd: 0.002, baselineUsd: 0.002, source: 'a rough table (haiku)' },
  sonnet: { firstTurnUsd: 0.045, laterTurnUsd: 0.02, judgeUsd: 0.02, extraImageUsd: 0.005, baselineUsd: 0.005, source: 'a rough table (sonnet)' },
  opus: { firstTurnUsd: 0.2, laterTurnUsd: 0.09, judgeUsd: 0.09, extraImageUsd: 0.02, baselineUsd: 0.02, source: 'a rough table (opus)' },
};

export function perCallFor(model: string | null, runs: readonly ExploreRun[], judgeModel: string | null): PerCall {
  const family = (name: string | null): string => (name ?? 'sonnet').toLowerCase().match(/haiku|opus|sonnet/)?.[0] ?? 'sonnet';
  const table = ROUGH[family(model)] ?? ROUGH['sonnet'];
  const judgeTable = ROUGH[family(judgeModel ?? model)] ?? ROUGH['sonnet'];
  const base = table as PerCall;
  const judge = judgeTable as PerCall;
  const last = runs.find((run) => run.model === model && run.measured !== undefined && run.measured !== null && run.judgeModel === judgeModel);
  const measured = last?.measured ?? null;
  return {
    firstTurnUsd: measured?.firstTurnUsd ?? base.firstTurnUsd,
    laterTurnUsd: measured?.laterTurnUsd ?? base.laterTurnUsd,
    judgeUsd: measured?.judgeUsd ?? judge.judgeUsd,
    extraImageUsd: judge.extraImageUsd,
    baselineUsd: measured?.baselineUsd ?? base.baselineUsd,
    source: measured === null ? `${base.source}; the judge from ${judge.source}` : `the measurements of run ${last?.id ?? ''}`,
  };
}

export function projectUsd(plan: Plan, per: PerCall): number {
  return plan.firstTurns * per.firstTurnUsd + plan.laterTurns * per.laterTurnUsd + plan.judgeCalls * per.judgeUsd + plan.extraImages * per.extraImageUsd + plan.baselines * per.baselineUsd;
}

export function callsOf(plan: Plan): number {
  return plan.firstTurns + plan.laterTurns + plan.judgeCalls + plan.baselines;
}
