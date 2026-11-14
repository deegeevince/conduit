// Critic v2: reading a judge's gates and holding them to the rules that are not the judge's to bend.
//
// The judge says pass or fail per gate, with evidence and an owner. What is decided here, in code, not by the judge:
// - the lowest failing tier is the one that is raised; the notes of every higher tier are kept (logged) but are not alarms;
// - a failing tier caps the coherence, so the number a listener reads agrees with the gates;
// - a gate the judge did not answer is not a pass (it is left out, never counted as passed);
// - the worst-case note of a mock-up is never an alarm and never counts toward a tier.

import type { CriticGate, CriticOwner, CriticProblem, CriticTier } from '@conduit/language';
import { GATES, WORST_CASE_GATE } from './rubric';

const OWNERS: readonly CriticOwner[] = ['brain', 'painter', 'kit', 'host', 'prompt'];
const WEIGHTS = ['blocks', 'hurts', 'polish'] as const;
type Weight = (typeof WEIGHTS)[number];

/** Who is likely to own a gate's fix when the judge did not say. */
const DEFAULT_OWNER: Record<string, CriticOwner> = {
  'on-stage': 'painter',
  readable: 'painter',
  'no-overlap': 'painter',
  'answers-ask': 'brain',
  hierarchy: 'brain',
  composition: 'painter',
  polish: 'painter',
  taste: 'brain',
  'worst-case': 'brain',
};

const tierOf = new Map<string, CriticTier>([...GATES.map((g) => [g.gate, g.tier as CriticTier] as const), [WORST_CASE_GATE.gate, WORST_CASE_GATE.tier as CriticTier]]);

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || /^(none|null|n\/a)\.?$/i.test(trimmed) ? null : trimmed;
};

export interface GateReading {
  readonly gates: readonly CriticGate[];
  readonly problems: readonly CriticProblem[];
  readonly failedTier: CriticTier | null;
  readonly coherence: number;
  readonly judgedCoherence: number | undefined;
}

/** `object` is the judge's reply, `coherence` its score (1..5), `ids` what is on the stage, `mockup` whether the worst-case gate was asked. Null when it gave no gates at all. */
export function readGates(object: Record<string, unknown>, coherence: number, ids: ReadonlySet<string>, mockup: boolean, extra: readonly CriticProblem[]): GateReading | null {
  const rawGates = Array.isArray(object['gates']) ? (object['gates'] as unknown[]) : [];
  const gates: CriticGate[] = [];
  for (const item of rawGates) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const gate = typeof entry['gate'] === 'string' ? entry['gate'].trim() : '';
    const tier = tierOf.get(gate);
    if (tier === undefined || typeof entry['pass'] !== 'boolean') continue;
    if (gate === WORST_CASE_GATE.gate && !mockup) continue;
    if (gates.some((g) => g.gate === gate)) continue;
    gates.push({ gate, tier, pass: entry['pass'], evidence: text(entry['evidence']) ?? '' });
  }
  if (gates.length === 0) return null;

  const rawProblems = Array.isArray(object['problems']) ? (object['problems'] as unknown[]) : [];
  const found: CriticProblem[] = [];
  for (const item of rawProblems.slice(0, 10)) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const what = text(entry['what']);
    if (what === null) continue;
    const gate = typeof entry['gate'] === 'string' && tierOf.has(entry['gate'].trim()) ? entry['gate'].trim() : null;
    if (gate === WORST_CASE_GATE.gate && !mockup) continue;
    const weight: Weight = WEIGHTS.find((w) => w === entry['weight']) ?? 'hurts';
    const owner = OWNERS.find((o) => o === entry['owner']);
    const id = typeof entry['id'] === 'string' && ids.has(entry['id']) ? entry['id'] : null;
    const evidence = text(entry['evidence']);
    // a problem that names no gate falls under the tier its weight suggests; the gates it could be argued under are not guessed
    const tier: CriticTier = gate !== null ? (tierOf.get(gate) as CriticTier) : weight === 'polish' ? 3 : 2;
    found.push({ id, what, weight, ...(gate === null ? {} : { gate }), tier, ...(evidence === null ? {} : { evidence }), ...(owner === undefined ? {} : { owner }) });
  }
  // a failed gate with no problem written for it still gets one, from the judge's own evidence
  for (const gate of gates) {
    if (gate.pass || found.some((p) => p.gate === gate.gate)) continue;
    found.push({ id: null, what: gate.evidence === '' ? `fails the ${gate.gate} gate` : gate.evidence, weight: gate.tier === 1 ? 'blocks' : gate.tier === 2 ? 'hurts' : 'polish', gate: gate.gate, tier: gate.tier, ...(gate.evidence === '' ? {} : { evidence: gate.evidence }) });
  }
  // what the battery's own questions found (an unreadable word, a wrong label, a mistake) counts, under the gate it belongs to, unless the judge already wrote a problem for that gate; the gate is then a fail
  for (const problem of extra) {
    if (found.some((p) => p.what === problem.what || (problem.gate !== undefined && p.gate === problem.gate))) continue;
    found.push(problem);
    const at = gates.findIndex((g) => g.gate === problem.gate);
    if (at >= 0 && gates[at]?.pass === true) gates[at] = { ...(gates[at] as CriticGate), pass: false, evidence: problem.what };
  }

  // the lowest tier that fails: from the gates, and from any problem filed under a gate the judge marked as passed (it is not let off)
  const failing = [...gates.filter((g) => !g.pass && g.gate !== WORST_CASE_GATE.gate).map((g) => g.tier), ...found.filter((p) => p.gate !== WORST_CASE_GATE.gate && p.gate !== undefined && p.weight !== 'polish').map((p) => p.tier as CriticTier)];
  const failedTier = failing.length === 0 ? null : (Math.min(...failing) as CriticTier);

  const problems: CriticProblem[] = found.map((problem) => {
    const note = problem.gate === WORST_CASE_GATE.gate;
    const tier = problem.tier ?? 2;
    const raised = !note && (failedTier === null || tier <= failedTier);
    let weight: Weight = problem.weight;
    if (!raised) weight = 'polish';
    else if (tier === 1) weight = 'blocks';
    else if (tier === 2 && weight === 'polish') weight = 'hurts';
    else if (tier === 3 && weight === 'blocks') weight = 'hurts';
    return { ...problem, owner: problem.owner ?? DEFAULT_OWNER[problem.gate ?? ''] ?? 'brain', weight, raised, ...(weight === problem.weight ? {} : { judgedWeight: problem.weight }) };
  });
  // raised before held back; then by weight; then by tier
  problems.sort((a, b) => Number(b.raised === true) - Number(a.raised === true) || WEIGHTS.indexOf(a.weight) - WEIGHTS.indexOf(b.weight) || (a.tier ?? 3) - (b.tier ?? 3));

  let capped = coherence;
  if (failedTier === 1) capped = Math.min(capped, 2);
  else if (failedTier === 2) capped = Math.min(capped, 3);
  else capped = Math.max(capped, 3);
  return { gates, problems, failedTier, coherence: capped, judgedCoherence: capped === coherence ? undefined : coherence };
}

/** The `progress` a judge gave for a follow-up, cleaned: only known gate ids, and a trend it was one of. */
export function readProgress(value: unknown): { trend: 'better' | 'worse' | 'same' | 'mixed'; fixed: string[]; stillFailing: string[]; newFailures: string[]; note: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const trend = (['better', 'worse', 'same', 'mixed'] as const).find((t) => t === entry['trend']);
  if (trend === undefined) return null;
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string' && tierOf.has(g)) : []);
  return { trend, fixed: ids(entry['fixed']), stillFailing: ids(entry['stillFailing']), newFailures: ids(entry['newFailures']), note: text(entry['note']) ?? '' };
}

/** The gates that failed in a finding: what the server counts across a session's turns (a worst-case note counts too, so the loop can see it recur). */
export function failedGatesOf(finding: { readonly gates?: readonly CriticGate[] }): readonly string[] {
  return (finding.gates ?? []).filter((g) => !g.pass).map((g) => g.gate);
}
