// A judge that looks. For each answer, the final still (and, if asked, earlier stills) and the request go to
// `claude -p` as an image over stream-json, and it answers a fixed set of questions as JSON. Counting cannot see a
// wrong chart, a false scale or a label on the wrong thing; this can.
// The judge is a separate process from the brain (it never shares a conversation) with no tools, no settings, a
// pinned model and a pinned effort.

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
}

export async function judge(input: JudgeInput, settings: JudgeSettings, signal: AbortSignal): Promise<ExploreJudgement> {
  const started = Date.now();
  const stills = input.thumbs.map((data) => `data:image/jpeg;base64,${data}`);
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', settings.model, '--effort', settings.effort, '--system-prompt', SYSTEM,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
  ];
  const child = spawnTracked(settings.bin, args, settings.effort);
  const content = [
    { type: 'text', text: `The user's request:\n${input.request}\n\n${input.images.length > 1 ? `${input.images.length} pictures follow; the last is the stage as the answer left it.` : 'One picture follows: the stage as the answer left it.'}` },
    ...input.images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
  ];
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
    const text = (event as { result?: unknown }).result;
    if (typeof text === 'string') reply = text;
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
  const ms = Date.now() - started;

  if (failure !== null) return neutral(settings.model, `the judge failed: ${String(failure)}`, ms, cost, stills);
  const parsed = objectIn(reply);
  if (parsed === null) return neutral(settings.model, `the judge did not answer in JSON${stderr === '' ? '' : ` (${stderr.trim()})`}: ${reply.slice(0, 160)}`, ms, cost, stills);
  const score = Number(parsed['coherence']);
  return {
    model: settings.model,
    asked: parsed['asked'] === true,
    textProblem: textOrNull(parsed['textProblem']),
    wrongLabel: textOrNull(parsed['wrongLabel']),
    correct: parsed['correct'] === true,
    mistake: textOrNull(parsed['mistake']),
    coherence: Number.isFinite(score) ? Math.max(1, Math.min(5, Math.round(score))) : 1,
    why: typeof parsed['why'] === 'string' ? parsed['why'].trim() : '',
    costUsd: cost,
    ms,
    stills,
    failure: null,
  };
}
