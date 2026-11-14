// One long-lived claude process per conversation.
//
// `claude -p --input-format stream-json --output-format stream-json` keeps
// reading user messages from stdin for as long as stdin stays open, and keeps
// the conversation, so a turn after the first costs no start-up and reads its
// whole prefix from the provider's prompt cache. Measured on this machine with
// Claude Code 2.1.322 (see docs/technology.md, "The brains"):
//
//   stdin  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
//          an image is one more content block:
//          {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"..."}}
//          and so is a PDF, read natively (tried with haiku on this machine; the answer quoted the first page):
//          {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"..."}}
//   stdin  {"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}
//   stdout {"type":"control_response","response":{"subtype":"success","request_id":"r1",...}}
//          then the turn's {"type":"result","subtype":"error_during_execution","is_error":true,...}
//   stdout {"type":"result","subtype":"success","usage":{...},"total_cost_usd":...}   ends every turn
//
// `system init` is printed after each user message, not at start-up.

import { errors } from '../../errors';
import type { Snapshot } from '../../domain/brain';
import type { Logger } from '../../log';
import { spawnTracked, toolArguments } from './process';
import { parseStreamLine, resultFactsOf } from './stream-json';
import type { ClaudeStreamEvent } from './stream-json';

/** One user message: documents and a picture first, then the words. */
export interface WarmMessage {
  readonly text: string;
  readonly image: Snapshot | null;
  readonly pdfs: readonly Uint8Array[];
}

export interface WarmSettings {
  readonly bin: string;
  readonly model: string;
  /** passed to `--effort`; `low` is what keeps hidden planning off the stage's clock */
  readonly effort: 'low' | 'medium' | 'high';
  readonly systemPrompt: string;
  /** read-only web tools allowed without a prompt; empty is none */
  readonly tools: readonly string[];
}

/** Why a process stopped being usable. */
export type WarmEnd = 'closed' | 'crashed' | 'killed';

/**
 * A claude process that outlives a turn.
 *
 * Contract:
 * - `start` spawns at once and returns without waiting; a missing binary is
 *   reported by the first `ask`, as `brain_failed` naming CLAUDE_BIN.
 * - `ask` writes one user message and yields the process's stdout events until
 *   that turn's `result`, which is the last thing it yields. One `ask` at a
 *   time: a second while one is running throws.
 * - Aborting `signal` sends an interrupt request and waits up to `graceMs` for
 *   the turn's `result`; the process stays usable. If none comes, the process
 *   is killed (SIGTERM, then SIGKILL) and `alive` turns false.
 * - A process that exits by itself ends the running `ask` with `brain_failed`
 *   carrying the tail of stderr.
 * - `turns` counts completed asks; `contextTokens` is the last input size the
 *   process reported, so the owner can retire it before it grows too large.
 * - `stop` ends stdin and kills what does not leave; nothing outlives the server.
 */
export interface WarmProcess {
  readonly alive: boolean;
  readonly turns: number;
  readonly contextTokens: number;
  ask(message: WarmMessage, signal: AbortSignal): AsyncIterable<ClaudeStreamEvent>;
  stop(): Promise<void>;
}

const KILL_GRACE_MS = 2_000;
const STDERR_KEEP = 4_096;
const STOP_POLITE_MS = 500;

export function startWarmProcess(settings: WarmSettings, log: Logger, graceMs = 1000): WarmProcess {
  const child = spawnTracked(settings.bin, warmArguments(settings), settings.effort);

  let alive = true;
  let busy = false;
  let turns = 0;
  let contextTokens = 0;
  let exited = false;
  let exitNote = '';
  let spawnError: NodeJS.ErrnoException | null = null;
  let stderrTail = '';
  let killTimer: NodeJS.Timeout | undefined;
  const queue: ClaudeStreamEvent[] = [];
  let waker: (() => void) | null = null;

  const wake = (): void => {
    const w = waker;
    waker = null;
    w?.();
  };

  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, sig) => {
      exited = true;
      alive = false;
      exitNote = sig !== null ? `was killed by ${sig}` : `exited with status ${String(code)}`;
      clearTimeout(killTimer);
      wake();
      resolve();
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
      exited = true;
      alive = false;
      wake();
      resolve();
    });
  });

  const kill = (): void => {
    alive = false;
    if (exited) return;
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    killTimer.unref();
  };

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP);
  });
  child.stdin?.on('error', () => undefined);

  child.stdout?.setEncoding('utf8');
  let pending = '';
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let at = pending.indexOf('\n');
    while (at >= 0) {
      const raw = pending.slice(0, at);
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
      if (raw.trim() === '') continue;
      const event = parseStreamLine(raw);
      if (event === null) log.debug('claude_unparsed_line', { raw: raw.slice(0, 200) });
      else queue.push(event);
    }
    wake();
  });

  const gone = (): Error => {
    if (spawnError !== null) {
      if (spawnError.code === 'ENOENT') return errors.brainFailed(`cannot start "${settings.bin}": no such program. Install Claude Code or set CLAUDE_BIN to its path`, spawnError);
      return errors.brainFailed(`cannot start "${settings.bin}" (check CLAUDE_BIN): ${spawnError.message}`, spawnError);
    }
    const tail = stderrTail.trim();
    return errors.brainFailed(`claude ${exitNote === '' ? 'stopped' : exitNote} before the turn finished${tail === '' ? '' : `: ${tail.slice(-1_000)}`}`);
  };

  const noteResult = (event: ClaudeStreamEvent): void => {
    turns += 1;
    const facts = resultFactsOf(event);
    if (facts === null) return;
    const size = facts.inputTokens + facts.cacheReadTokens + facts.cacheWriteTokens;
    if (size > 0) contextTokens = size;
  };

  const send = (value: unknown): void => {
    child.stdin?.write(`${JSON.stringify(value)}\n`);
  };

  async function* ask(message: WarmMessage, signal: AbortSignal): AsyncGenerator<ClaudeStreamEvent> {
    if (busy) throw errors.brainFailed('internal error: the claude process was asked two things at once');
    if (signal.aborted) return;
    if (!alive) throw gone();
    busy = true;
    queue.length = 0;

    let done = false;
    let interrupted = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const interrupt = (): void => {
      if (interrupted || done) return;
      interrupted = true;
      send({ type: 'control_request', request_id: `i${turns}`, request: { subtype: 'interrupt' } });
      graceTimer = setTimeout(() => {
        log.warn('claude_interrupt_unanswered', { graceMs });
        kill();
        wake();
      }, graceMs);
      graceTimer.unref();
    };
    signal.addEventListener('abort', interrupt, { once: true });

    try {
      const content: unknown[] = [];
      for (const pdf of message.pdfs) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdf).toString('base64') } });
      if (message.image !== null) {
        content.push({ type: 'image', source: { type: 'base64', media_type: message.image.mime, data: Buffer.from(message.image.bytes).toString('base64') } });
      }
      content.push({ type: 'text', text: message.text });
      send({ type: 'user', message: { role: 'user', content } });
      if (signal.aborted) interrupt();

      for (;;) {
        const event = queue.shift();
        if (event !== undefined) {
          if (event.type === 'control_response') continue;
          if (event.type === 'result') {
            done = true;
            noteResult(event);
            yield event;
            return;
          }
          yield event;
          continue;
        }
        if (!alive) {
          if (signal.aborted) return;
          throw gone();
        }
        await new Promise<void>((resolve) => {
          waker = resolve;
        });
      }
    } finally {
      signal.removeEventListener('abort', interrupt);
      // A consumer that walks away mid-turn is interrupted and the turn is read to its result, so the
      // process, which still holds the conversation and the cache, goes on. Only silence for graceMs kills it.
      if (!done && alive) {
        interrupt();
        while (alive) {
          const event = queue.shift();
          if (event === undefined) {
            await new Promise<void>((resolve) => {
              waker = resolve;
            });
            continue;
          }
          if (event.type === 'result') {
            done = true;
            noteResult(event);
            break;
          }
        }
      }
      clearTimeout(graceTimer);
      busy = false;
      if (!done) kill();
    }
  }

  return {
    get alive() {
      return alive && !exited;
    },
    get turns() {
      return turns;
    },
    get contextTokens() {
      return contextTokens;
    },
    ask,
    async stop() {
      alive = false;
      if (exited) return;
      child.stdin?.end();
      const polite = setTimeout(kill, STOP_POLITE_MS);
      polite.unref();
      await closed;
      clearTimeout(polite);
    },
  };
}

/** The exact argument list of a warm process, exported so the probe can print it. */
export function warmArguments(settings: WarmSettings): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model', settings.model,
    '--effort', settings.effort,
    '--system-prompt', settings.systemPrompt,
    ...toolArguments(settings.tools),
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
  ];
}
