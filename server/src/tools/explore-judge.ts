// A judge that looks. For each answer, the final still (and, if asked, earlier stills) and the request go to
// `claude -p` as an image over stream-json, and it answers a fixed set of questions as JSON. Counting cannot see a
// wrong chart, a false scale or a label on the wrong thing; this can.
// The judge is a separate process from the brain (it never shares a conversation) with no tools, no settings, a
// pinned model and a pinned effort.

import { createHash } from 'node:crypto';
import type { ExploreJudgement } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { failureOf, parseStreamLine, resultFactsOf } from '../brains/claude-cli/stream-json';

export interface JudgeSettings {
  readonly bin: string;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly timeoutMs: number;
}

const SYSTEM = `You review one answer that an AI gave on a "stage": an animated canvas with a look (colours, type), shapes, text, small pictures and a camera, instead of a paragraph of chat. You are shown the user's request and one or more still pictures of the stage. The LAST picture is the stage as the answer left it; earlier pictures, if any, are the same answer part-way through. Judge only what you can see.

Answer these questions about the last picture, in the context of the request:
- asked: does it show what the user asked for (true or false)?
- textProblem: is any text unreadable (too small, too faint against what is behind it, cut off by the edge) or lying over other text or over a drawing so that it cannot be read? A short sentence naming the text and the problem, or null if every word can be read.
- wrongLabel: does any label, caption or arrow point at the wrong thing, or name something that is not what is drawn there? A short sentence, or null.
- correct: is the drawing right, both factually (the diagram, chart, scale, proportions, order, numbers, anatomy, geometry are true) and visually (it looks like what it claims to be)? true or false.
- mistake: when correct is false, the most important thing wrong, in one sentence; otherwise null.
- coherence: a whole number from 1 (does not hold together: pieces scattered, overlapping, unreadable) to 5 (one composed picture that reads at a glance).
- why: one sentence that says why you gave that coherence score.

Be strict and specific. A plain text answer with nothing drawn is fine when the request was a plain question; it is wrong when the request asked to see something. Do not reward length. If the stage is empty or nearly so, say so in why and score 1.

Reply with ONE JSON object and nothing else, with exactly the keys asked, textProblem, wrongLabel, correct, mistake, coherence, why.`;

// Two further questions, added to the instructions only when they apply. Neither names a brain, a prompt, a draft, a fix or an experiment:
// the judge is shown a request and pictures and nothing about which arm of a comparison they came from, so it cannot be flattered by it.
const CHART_ADDENDUM = `
This answer is a CHART. Also give:
- chartQuality: a whole number from 1 to 5 for how it stands against a professional charting product. 1: clip art, a picture of a chart. 3: correct and readable but plainly generated. 5: could be a screenshot of a trading terminal or a newspaper data desk. Look for: axes with sensibly formatted ticks (units, thousands, dates at a sensible grain), time and number axes drawn to scale, gridlines that recede, series told apart without relying on hue alone, a legend when there is more than one series, direct labels or units, nothing overlapping, nothing decorative, the data's story visible at a glance, honest baselines. Deduct for every thing a data editor would send back.
- chartWhy: one sentence naming what holds the score down.
Reply with those two keys as well as the others.`;

const RESPONDS_SYSTEM = `You review an interactive picture on a "stage". You are shown what the user asked for, a description of one control, and two stills of the stage: the first with the control at one end of its range (or off), the second with it at the other end (or on). Judge only what you can see.

Answer:
- responds: true when the picture changes between the two stills in the way the request needs: the right thing changes, in the right direction, by an amount a person would notice. false when nothing relevant changes, the wrong thing changes, or it changes in the wrong direction.
- respondsWhy: one sentence on what changes between the pictures, or what should have and did not.

Reply with ONE JSON object and nothing else, with exactly the keys responds, respondsWhy.`;

/**
 * A hash of everything that makes two scores comparable: the instructions in every form, the model, the effort. It is written on
 * every judgement and on the run; a comparison across two values of it is refused by the loop.
 */
export function rubricOf(settings: Pick<JudgeSettings, 'model' | 'effort'>): string {
  return createHash('sha256').update([SYSTEM, CHART_ADDENDUM, RESPONDS_SYSTEM, settings.model, settings.effort].join('\u0000')).digest('hex').slice(0, 12);
}

function neutral(model: string, failure: string, ms: number, costUsd: number | null, stills: readonly string[]): ExploreJudgement {
  return { model, asked: false, textProblem: null, wrongLabel: null, correct: false, mistake: null, coherence: 1, why: '', costUsd, ms, stills, failure };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || /^(none|null|no|n\/a)\.?$/i.test(trimmed) ? null : trimmed;
}

/** The first balanced JSON object in a model's reply, tolerating a fence or a sentence around it. */
function objectIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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

interface Asked {
  readonly reply: string;
  readonly failure: string | null;
  readonly cost: number | null;
  readonly stderr: string;
  readonly ms: number;
}

/** One call of the judge's process: a system prompt, a text and pictures in; the reply out. No tools, no settings, no conversation. */
async function ask(system: string, text: string, images: readonly string[], settings: JudgeSettings, signal: AbortSignal): Promise<Asked> {
  const started = Date.now();
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', settings.model, '--effort', settings.effort, '--system-prompt', system,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
  ];
  const child = spawnTracked(settings.bin, args, settings.effort);
  const content = [{ type: 'text', text }, ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }))];
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-1_000);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), settings.timeoutMs);
  const onAbort = (): void => void child.kill('SIGKILL');
  signal.addEventListener('abort', onAbort, { once: true });

  let reply = '';
  let failure: string | null = null;
  let cost: number | null = null;
  let pending = '';
  const handle = (raw: string): void => {
    const event = parseStreamLine(raw);
    if (event === null || event.type !== 'result') return;
    failure = failureOf(event);
    const facts = resultFactsOf(event);
    cost = facts?.totalCostUsd ?? null;
    const result = (event as { result?: unknown }).result;
    if (typeof result === 'string') reply = result;
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let at = pending.indexOf('\n');
    while (at >= 0) {
      handle(pending.slice(0, at));
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
    }
  });
  await new Promise<void>((done) => {
    child.once('close', () => done());
    child.once('error', () => done());
  });
  clearTimeout(timer);
  signal.removeEventListener('abort', onAbort);
  if (pending.trim() !== '') handle(pending);
  return { reply, failure, cost, stderr, ms: Date.now() - started };
}

function scoreOf(value: unknown): number | null {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(1, Math.min(5, Math.round(score))) : null;
}

export async function judge(input: JudgeInput, settings: JudgeSettings, signal: AbortSignal): Promise<ExploreJudgement> {
  const stills = input.thumbs.map((data) => `data:image/jpeg;base64,${data}`);
  const rubric = rubricOf(settings);
  const text = `The user's request:\n${input.request}\n\n${input.images.length > 1 ? `${input.images.length} pictures follow; the last is the stage as the answer left it.` : 'One picture follows: the stage as the answer left it.'}`;
  const got = await ask(input.chart === true ? `${SYSTEM}\n${CHART_ADDENDUM}` : SYSTEM, text, input.images, settings, signal);
  const { ms, cost, stderr, reply } = got;
  if (got.failure !== null) return { ...neutral(settings.model, `the judge failed: ${String(got.failure)}`, ms, cost, stills), rubric };
  const parsed = objectIn(reply);
  if (parsed === null) return { ...neutral(settings.model, `the judge did not answer in JSON${stderr === '' ? '' : ` (${stderr.trim()})`}: ${reply.slice(0, 160)}`, ms, cost, stills), rubric };
  const chartQuality = input.chart === true ? scoreOf(parsed['chartQuality']) : null;
  return {
    model: settings.model,
    asked: parsed['asked'] === true,
    textProblem: textOrNull(parsed['textProblem']),
    wrongLabel: textOrNull(parsed['wrongLabel']),
    correct: parsed['correct'] === true,
    mistake: textOrNull(parsed['mistake']),
    coherence: scoreOf(parsed['coherence']) ?? 1,
    why: typeof parsed['why'] === 'string' ? parsed['why'].trim() : '',
    ...(input.chart === true ? { chartQuality, chartWhy: typeof parsed['chartWhy'] === 'string' ? parsed['chartWhy'].trim() : null } : {}),
    rubric,
    costUsd: cost,
    ms,
    stills,
    failure: null,
  };
}

/** Does the picture change between a control's two ends as the request needs? A separate, small call: it sees only the two stills. */
export async function judgeResponds(input: RespondsInput, settings: JudgeSettings, signal: AbortSignal): Promise<{ responds: boolean | null; why: string | null; costUsd: number | null; failure: string | null }> {
  const text = `The user's request:\n${input.request}\n\nThe control: ${input.control}\n\nTwo pictures follow: the control at one end, then at the other.`;
  const got = await ask(RESPONDS_SYSTEM, text, input.images, settings, signal);
  if (got.failure !== null) return { responds: null, why: null, costUsd: got.cost, failure: String(got.failure) };
  const parsed = objectIn(got.reply);
  if (parsed === null || typeof parsed['responds'] !== 'boolean') return { responds: null, why: null, costUsd: got.cost, failure: `the judge did not answer in JSON: ${got.reply.slice(0, 120)}` };
  return { responds: parsed['responds'], why: typeof parsed['respondsWhy'] === 'string' ? parsed['respondsWhy'].trim() : null, costUsd: got.cost, failure: null };
}
