// The judge: the one place a judgement is asked of `claude`. The battery (`pnpm explore`, taste), the live critic and look-and-fix's
// comparison all come here, so one rubric (with one hash) stands behind every score. Moved out of `tools/explore-judge.ts`, whose
// callers (package H) now import from here.

import type { CriticFinding, ExploreJudgement } from '@conduit/language';
import { askObject } from './ask';
import { shareOf } from './ask';
import type { JudgeSettings, JudgeUsage, Picture } from './ask';
import { readGates, readProgress } from './gates';
import { CHART_ADDENDUM, COMPARE_SYSTEM, FOLLOW_UP_ADDENDUM, LIVE_SYSTEM, RESPONDS_SYSTEM, SYSTEM, WORST_CASE_ADDENDUM, rubricOf } from './rubric';

export type { JudgeSettings, Picture } from './ask';
export { rubricOf } from './rubric';

export interface JudgeInput {
  /** what the user asked, in words; for a later turn, with the conversation so far */
  readonly request: string;
  /** base64 PNGs, earlier ones first, the final still last */
  readonly images: readonly string[];
  /** small JPEGs (base64) kept with the verdict for the review page */
  readonly thumbs: readonly string[];
  /** the answer is a chart: ask `chartQuality` too */
  readonly chart?: boolean;
}

export interface RespondsInput {
  readonly request: string;
  /** what the control is and what its two ends are, in words */
  readonly control: string;
  /** base64 PNGs: one end, the other end */
  readonly images: readonly [string, string];
}

const png = (data: string): Picture => ({ data, mime: 'image/png' });

function neutral(model: string, failure: string, ms: number, costUsd: number | null, stills: readonly string[]): ExploreJudgement {
  return { model, asked: false, textProblem: null, wrongLabel: null, correct: false, mistake: null, coherence: 1, why: '', costUsd, ms, stills, failure };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || /^(none|null|no|n\/a)\.?$/i.test(trimmed) ? null : trimmed;
}

function scoreOf(value: unknown): number | null {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(1, Math.min(5, Math.round(score))) : null;
}

const describe = (failure: string | null, stderr: string, reply: string): string => (failure !== null ? `the judge failed: ${failure}` : `the judge did not answer in JSON${stderr === '' ? '' : ` (${stderr.trim()})`}: ${reply.slice(0, 160)}`);

export async function judge(input: JudgeInput, settings: JudgeSettings, signal: AbortSignal): Promise<ExploreJudgement> {
  const stills = input.thumbs.map((data) => `data:image/jpeg;base64,${data}`);
  const rubric = rubricOf(settings);
  const text = `The user's request:\n${input.request}\n\n${input.images.length > 1 ? `${input.images.length} pictures follow; the last is the stage as the answer left it.` : 'One picture follows: the stage as the answer left it.'}`;
  const got = await askObject(input.chart === true ? `${SYSTEM}\n${CHART_ADDENDUM}` : SYSTEM, text, input.images.map(png), settings, signal);
  const parsed = got.object;
  if (parsed === null) return { ...neutral(settings.model, describe(got.failure, got.stderr, got.reply), got.ms, got.cost, stills), rubric };
  return {
    model: settings.model,
    asked: parsed['asked'] === true,
    textProblem: textOrNull(parsed['textProblem']),
    wrongLabel: textOrNull(parsed['wrongLabel']),
    correct: parsed['correct'] === true,
    mistake: textOrNull(parsed['mistake']),
    coherence: scoreOf(parsed['coherence']) ?? 1,
    why: typeof parsed['why'] === 'string' ? parsed['why'].trim() : '',
    ...(input.chart === true ? { chartQuality: scoreOf(parsed['chartQuality']), chartWhy: typeof parsed['chartWhy'] === 'string' ? parsed['chartWhy'].trim() : null } : {}),
    rubric,
    costUsd: got.cost,
    ms: got.ms,
    stills,
    failure: null,
  };
}

/** Does the picture change between a control's two ends as the request needs? A separate, small call: it sees only the two stills. */
export async function judgeResponds(input: RespondsInput, settings: JudgeSettings, signal: AbortSignal): Promise<{ responds: boolean | null; why: string | null; costUsd: number | null; failure: string | null }> {
  const text = `The user's request:\n${input.request}\n\nThe control: ${input.control}\n\nTwo pictures follow: the control at one end, then at the other.`;
  const got = await askObject(RESPONDS_SYSTEM, text, input.images.map(png), settings, signal);
  const parsed = got.object;
  if (parsed === null) return { responds: null, why: null, costUsd: got.cost, failure: describe(got.failure, got.stderr, got.reply) };
  if (typeof parsed['responds'] !== 'boolean') return { responds: null, why: null, costUsd: got.cost, failure: `the judge did not say: ${got.reply.slice(0, 120)}` };
  return { responds: parsed['responds'], why: typeof parsed['respondsWhy'] === 'string' ? parsed['respondsWhy'].trim() : null, costUsd: got.cost, failure: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Findings: what the critic and the comparison read out of an answer

export interface FindingInput {
  readonly turn: string;
  readonly pass: number;
  readonly asked: string;
  /** the ids on the stage, so that a problem can name its thing */
  readonly ids: readonly string[];
  /** critic v2: what the painter measured, one short line per element that landed badly (its id first); evidence, not a verdict */
  readonly measured?: readonly string[];
  /** critic v2: the answer is a mock-up, so the worst-case gate is asked (as a note) */
  readonly mockup?: boolean;
  /** critic v2: the same answer revised in place: the picture it had and the verdict it was given */
  readonly previous?: { readonly picture: Picture; readonly finding: CriticFinding } | null;
}

const WEIGHTS = ['blocks', 'hurts', 'polish'] as const;

/** One judged picture, read as a `CriticFinding`; null when the object has no coherence (it was not an answer to the rubric). */
function findingOf(object: Record<string, unknown>, input: FindingInput, settings: JudgeSettings, ms: number, costUsd: number | null, usage: JudgeUsage): CriticFinding | null {
  const coherence = scoreOf(object['coherence']);
  if (coherence === null) return null;
  const ids = new Set(input.ids);
  const raw = Array.isArray(object['problems']) ? (object['problems'] as unknown[]) : [];
  const problems: CriticFinding['problems'][number][] = [];
  for (const item of raw.slice(0, 8)) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const what = textOrNull(entry['what']);
    if (what === null) continue;
    const id = typeof entry['id'] === 'string' && ids.has(entry['id']) ? entry['id'] : null;
    const weight = WEIGHTS.find((candidate) => candidate === entry['weight']) ?? 'hurts';
    problems.push({ id, what, weight });
  }
  // The battery's own questions are problems too, so that nothing the rubric found is lost between its two readings.
  const textProblem = textOrNull(object['textProblem']);
  const wrongLabel = textOrNull(object['wrongLabel']);
  const mistake = textOrNull(object['mistake']);
  if (textProblem !== null && !problems.some((p) => p.what === textProblem)) problems.push({ id: null, what: textProblem, weight: 'blocks' });
  if (wrongLabel !== null && !problems.some((p) => p.what === wrongLabel)) problems.push({ id: null, what: wrongLabel, weight: 'blocks' });
  if (mistake !== null && object['correct'] !== true && !problems.some((p) => p.what === mistake)) problems.push({ id: null, what: mistake, weight: 'hurts' });
  problems.sort((a, b) => WEIGHTS.indexOf(a.weight) - WEIGHTS.indexOf(b.weight));
  const suggestions = (Array.isArray(object['suggestions']) ? (object['suggestions'] as unknown[]) : []).map(textOrNull).filter((s): s is string => s !== null).slice(0, 3);
  return { turn: input.turn, pass: input.pass, coherence, readable: textProblem === null, asked: object['asked'] === true, problems, suggestions, rubric: rubricOf(settings), model: settings.model, ms, costUsd, usage };
}

function requestText(input: FindingInput, pictures: string): string {
  return `The user's request:\n${input.asked}\n\n${pictures}\n\nThe ids of what is on the stage: ${input.ids.length === 0 ? '(none given)' : input.ids.join(', ')}.`;
}

/** What the live critic is told of an earlier verdict: its numbers and what failed, never anything the author thought. */
function earlierVerdict(finding: CriticFinding): string {
  const failed = (finding.gates ?? []).filter((g) => !g.pass).map((g) => `  - ${g.gate} (tier ${g.tier}): ${g.evidence}`);
  const raised = finding.problems.filter((p) => p.raised !== false).slice(0, 5).map((p) => `  - ${p.gate ?? 'problem'}${p.id === null ? '' : ` [${p.id}]`}: ${p.what}`);
  return `coherence ${finding.coherence}; lowest failing tier: ${finding.failedTier ?? 'none'}.\n${failed.length === 0 ? '  (every gate passed)' : failed.join('\n')}${raised.length === 0 ? '' : `\nWhat you raised:\n${raised.join('\n')}`}`;
}

/** The live critic's question (critic v2): fresh context, gates by tier, and when the answer was revised in place, the picture and verdict from before. */
function lookText(input: FindingInput): string {
  const pictures = input.previous === undefined || input.previous === null
    ? 'One picture follows: the stage as the answer left it.'
    : `Two pictures follow. The FIRST is the stage as the previous answer left it, and the verdict you gave it is below; it is for reference, do not judge it again. The SECOND is the stage as this answer left it: judge that one, by every gate.\n\nYour earlier verdict on the FIRST:\n${earlierVerdict(input.previous.finding)}`;
  const measured = input.measured === undefined || input.measured.length === 0 ? '' : `\n\nWhat the painter measured on the stage (measurements, not opinions; trust the picture over them): \n${input.measured.map((line) => `- ${line}`).join('\n')}`;
  const extra = `${input.mockup === true ? `\n\n${WORST_CASE_ADDENDUM}` : ''}${input.previous === undefined || input.previous === null ? '' : `\n\n${FOLLOW_UP_ADDENDUM}`}`;
  return `${requestText(input, pictures)}${measured}${extra}`;
}

/** One resting picture, as the live critic looks at it. Null when the judge could not be read twice or failed. */
export async function judgeFinding(input: FindingInput, picture: Picture, settings: JudgeSettings, signal: AbortSignal): Promise<{ finding: CriticFinding | null; failure: string | null }> {
  const mockup = input.mockup === true;
  const previous = input.previous ?? null;
  const got = await askObject(LIVE_SYSTEM, lookText(input), previous === null ? [picture] : [previous.picture, picture], settings, signal);
  if (got.object === null) return { finding: null, failure: describe(got.failure, got.stderr, got.reply) };
  const base = findingOf(got.object, input, settings, got.ms, got.cost, got.usage);
  if (base === null) return { finding: null, failure: 'the judge answered without a coherence score' };
  const read = readGates(got.object, base.coherence, new Set(input.ids), mockup);
  // a judge that sent no gates is read as before: its problems stand as it weighed them
  if (read === null) return { finding: base, failure: null };
  const progress = previous === null ? null : readProgress(got.object['progress']);
  const finding: CriticFinding = {
    ...base,
    coherence: read.coherence,
    readable: read.gates.find((g) => g.gate === 'readable')?.pass !== false,
    problems: read.problems,
    gates: read.gates,
    failedTier: read.failedTier,
    mockup,
    ...(read.judgedCoherence === undefined ? {} : { judgedCoherence: read.judgedCoherence }),
    ...(previous === null
      ? {}
      : { previous: { turn: previous.finding.turn, coherence: previous.finding.coherence, failedTier: previous.finding.failedTier ?? null, failed: (previous.finding.gates ?? []).filter((g) => !g.pass).map((g) => g.gate) }, progress }),
  };
  return { finding, failure: null };
}

/**
 * Two pictures of the same stage in one message, each judged on its own by the same rubric. Which is which is not told: the order is
 * `firstIsA` (the caller shuffles) and the judge is only ever told FIRST and SECOND.
 */
export async function judgePair(input: FindingInput, a: Picture, b: Picture, firstIsA: boolean, settings: JudgeSettings, signal: AbortSignal): Promise<{ a: CriticFinding; b: CriticFinding } | { failure: string }> {
  const pictures = firstIsA ? [a, b] : [b, a];
  const got = await askObject(COMPARE_SYSTEM, requestText(input, 'Two pictures follow: the FIRST, then the SECOND.'), pictures, settings, signal);
  if (got.object === null) return { failure: describe(got.failure, got.stderr, got.reply) };
  const first = got.object['first'];
  const second = got.object['second'];
  if (typeof first !== 'object' || first === null || typeof second !== 'object' || second === null) return { failure: 'the judge did not give both pictures a verdict' };
  const half = got.ms / 2;
  const cost = got.cost === null ? null : got.cost / 2;
  const one = findingOf(first as Record<string, unknown>, input, settings, half, cost, shareOf(got.usage, 0.5));
  const two = findingOf(second as Record<string, unknown>, input, settings, half, cost, shareOf(got.usage, 0.5));
  if (one === null || two === null) return { failure: 'a verdict had no coherence score' };
  return firstIsA ? { a: one, b: two } : { a: two, b: one };
}
