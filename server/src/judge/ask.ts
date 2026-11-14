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

export interface Asked {
  readonly reply: string;
  readonly failure: string | null;
  readonly cost: number | null;
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
  let pending = '';
  const handle = (raw: string): void => {
    const event = parseStreamLine(raw);
    if (event === null || event.type !== 'result') return;
    failure = failureOf(event);
    cost = resultFactsOf(event)?.totalCostUsd ?? null;
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
  return { ...second, object: second.failure === null ? objectIn(second.reply) : null, cost: first.cost === null && second.cost === null ? null : (first.cost ?? 0) + (second.cost ?? 0), ms: first.ms + second.ms, tries: 2 };
}
