// The one place `claude` is asked to judge: the argument list, the stdin protocol, the reply, and one retry on an answer that is not JSON.
// A separate process from the brain: it never shares a conversation, and it has no tools, no settings, a pinned model and a pinned effort.

import { spawnTracked } from '../brains/claude-cli/process';
import { failureOf, parseStreamLine, resultFactsOf } from '../brains/claude-cli/stream-json';

export interface JudgeSettings {
  readonly bin: string;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly timeoutMs: number;
}

/** A picture, base64 (no prefix). */
export interface Picture {
  readonly data: string;
  readonly mime: 'image/png' | 'image/jpeg';
}

/** What one judge call used, as the CLI's `result` event reports it. Absent counts are 0; `thinkingTokens` and `costUsd` are null when not reported. */
export interface JudgeUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number | null;
  readonly costUsd: number | null;
  readonly ms: number;
}

const addNullable = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

export function addUsage(a: JudgeUsage, b: JudgeUsage): JudgeUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: addNullable(a.thinkingTokens, b.thinkingTokens),
    costUsd: addNullable(a.costUsd, b.costUsd),
    ms: a.ms + b.ms,
  };
}

/** A share of a usage (a call that judged two pictures is split between them). */
export function shareOf(u: JudgeUsage, share: number): JudgeUsage {
  const part = (n: number): number => Math.round(n * share);
  return { inputTokens: part(u.inputTokens), cacheReadTokens: part(u.cacheReadTokens), cacheWriteTokens: part(u.cacheWriteTokens), outputTokens: part(u.outputTokens), thinkingTokens: u.thinkingTokens === null ? null : part(u.thinkingTokens), costUsd: u.costUsd === null ? null : u.costUsd * share, ms: u.ms * share };
}

export interface Asked {
  readonly reply: string;
  readonly failure: string | null;
  readonly cost: number | null;
  readonly usage: JudgeUsage;
  readonly stderr: string;
  readonly ms: number;
}

/** One call of the judge's process: a system prompt, a text and pictures in; the reply out. */
export async function ask(system: string, text: string, pictures: readonly Picture[], settings: JudgeSettings, signal: AbortSignal): Promise<Asked> {
  const started = Date.now();
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', settings.model, '--effort', settings.effort, '--system-prompt', system,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
  ];
  const child = spawnTracked(settings.bin, args, settings.effort);
  const content = [{ type: 'text', text }, ...pictures.map((picture) => ({ type: 'image', source: { type: 'base64', media_type: picture.mime, data: picture.data } }))];
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
  if (signal.aborted) onAbort();

  let reply = '';
  let failure: string | null = null;
  let cost: number | null = null;
  const got: { facts: ReturnType<typeof resultFactsOf> } = { facts: null };
  let pending = '';
  const handle = (raw: string): void => {
    const event = parseStreamLine(raw);
    if (event === null || event.type !== 'result') return;
    failure = failureOf(event);
    got.facts = resultFactsOf(event);
    cost = got.facts?.totalCostUsd ?? null;
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
  const ms = Date.now() - started;
  const facts = got.facts;
  const usage: JudgeUsage = { inputTokens: facts?.inputTokens ?? 0, cacheReadTokens: facts?.cacheReadTokens ?? 0, cacheWriteTokens: facts?.cacheWriteTokens ?? 0, outputTokens: facts?.outputTokens ?? 0, thinkingTokens: facts?.thinkingTokens ?? null, costUsd: cost, ms };
  return { reply, failure, cost, usage, stderr, ms };
}

/** The first balanced JSON object in a model's reply, tolerating a fence or a sentence around it. */
export function objectIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface AskedObject extends Asked {
  /** null when the judge failed, or answered twice without a JSON object */
  readonly object: Record<string, unknown> | null;
  /** ms and cost across both tries */
  readonly tries: number;
}

/** `ask`, and once more when the reply is not a JSON object (a failure of the process is not retried: that is the login or the clock). */
export async function askObject(system: string, text: string, pictures: readonly Picture[], settings: JudgeSettings, signal: AbortSignal): Promise<AskedObject> {
  const first = await ask(system, text, pictures, settings, signal);
  const object = first.failure === null ? objectIn(first.reply) : null;
  if (object !== null || first.failure !== null || signal.aborted) return { ...first, object, tries: 1 };
  const second = await ask(system, text, pictures, settings, signal);
  return { ...second, object: second.failure === null ? objectIn(second.reply) : null, cost: first.cost === null && second.cost === null ? null : (first.cost ?? 0) + (second.cost ?? 0), usage: addUsage(first.usage, second.usage), ms: first.ms + second.ms, tries: 2 };
}
