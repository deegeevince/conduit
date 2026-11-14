// The only module that starts a child process (the claude process, and the browser and dev server the exploration tool drives). Nothing else imports node:child_process.
// `runClaude` is the one-shot form (one message in, stdout lines out), exported for callers
// that want a plain answer from the model without a conversation, such as the exploration runner.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { childEnvironment } from '../../env';
import { errors } from '../../errors';

/** The tool flags: exactly the listed read-only web tools, allowed without a prompt, and every other tool denied. */
export function toolArguments(tools: readonly string[]): string[] {
  if (tools.length === 0) return ['--tools', ''];
  return ['--tools', tools.join(','), '--allowedTools', ...tools, '--disallowedTools', ...DENIED_TOOLS];
}

const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'Task', 'Agent', 'PowerShell'];

export interface ClaudeRun {
  /** the read-only web tools to allow; none when empty or unset */
  readonly tools?: readonly string[];
  readonly bin: string;
  readonly model: string;
  readonly systemPrompt: string;
  /** passed to `--effort` when set */
  readonly effort?: 'low' | 'medium' | 'high';
  /** written to stdin, then stdin is closed */
  readonly userMessage: string;
}

const KILL_GRACE_MS = 2_000;
const STDERR_KEEP = 4_096;

/** Other processes the exploration tool starts (a dev server, a headless Chrome) are tracked the same way, so none outlives it. */
export interface ToolProcess {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** no pipes: nothing is read from it */
  readonly quiet?: boolean;
}

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Spawns and tracks a child so that it cannot outlive the server. The only call to `spawn` in the server. */
export function spawnTracked(bin: string, args: readonly string[], effort?: 'low' | 'medium' | 'high', tool?: ToolProcess): ChildProcess {
  installExitHook();
  // The owner's shell may export CLAUDE_EFFORT; the brain's effort is its own setting. `childEnvironment` keeps every credential out,
  // whatever the effort: the brain, the judge and the loop's agents run on the owner's login, never on an API key.
  const env = childEnvironment({ ...(effort === undefined ? {} : { CLAUDE_EFFORT: effort }), ...tool?.env });
  const child = spawn(bin, [...args], { cwd: tool?.cwd ?? tmpdir(), stdio: tool?.quiet === true ? ['ignore', 'ignore', 'ignore'] : ['pipe', 'pipe', 'pipe'], shell: false, env });
  live.add(child);
  const forget = (): void => {
    live.delete(child);
  };
  child.once('close', forget);
  child.once('error', forget);
  return child;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // The exit event is synchronous-only; SIGKILL is the one thing that can be done there.
  process.on('exit', () => {
    for (const child of live) child.kill('SIGKILL');
  });
}

/**
 * Starts Claude Code headless with no tools, no MCP servers, no settings and
 * no saved session, and yields its stdout one line at a time.
 *
 * Contract:
 * - Aborting `signal` kills the child (SIGTERM, then SIGKILL after a grace
 *   period) and ends the iteration without throwing. This is also how the
 *   brain enforces its timeouts: it aborts.
 * - A non-zero exit that was not caused by an abort throws `brain_failed`
 *   carrying the tail of stderr.
 * - A missing binary throws `brain_failed` naming CLAUDE_BIN.
 * - The child never outlives the server: it is killed on process exit.
 */
export async function* runClaude(run: ClaudeRun, signal: AbortSignal): AsyncGenerator<string> {
  if (signal.aborted) return;

  const child = spawnTracked(run.bin, claudeArguments(run), run.effort);

  let stderrTail = '';
  let spawnError: Error | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let killTimer: NodeJS.Timeout | undefined;

  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      resolve();
    });
    child.once('error', (error) => {
      spawnError = error;
      exited = true;
      resolve();
    });
  });

  const kill = (): void => {
    if (exited) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    killTimer.unref();
  };
  signal.addEventListener('abort', kill, { once: true });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP);
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(run.userMessage);

  try {
    child.stdout?.setEncoding('utf8');
    let pending = '';
    if (child.stdout) {
      // Raced against the abort so a timeout surfaces at once instead of when the killed child's pipe finally closes.
      const aborted = new Promise<'aborted'>((resolve) => signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
      const chunks = (child.stdout as AsyncIterable<string>)[Symbol.asyncIterator]();
      while (!signal.aborted) {
        const next = await Promise.race([chunks.next(), aborted]);
        if (next === 'aborted' || next.done === true) break;
        pending += next.value;
        let at = pending.indexOf('\n');
        while (at >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (line !== '') yield line;
          if (signal.aborted) break;
          at = pending.indexOf('\n');
        }
      }
      void chunks.return?.();
      if (!signal.aborted && pending !== '') yield pending;
    }
    if (signal.aborted) return;

    await closed;
    const failure = spawnError as (NodeJS.ErrnoException | null);
    if (failure !== null) {
      if (failure.code === 'ENOENT') throw errors.brainFailed(`cannot start "${run.bin}": no such program. Install Claude Code or set CLAUDE_BIN to its path`, failure);
      throw errors.brainFailed(`cannot start "${run.bin}" (check CLAUDE_BIN): ${failure.message}`, failure);
    }
    if (signal.aborted) return;
    if (exitCode !== 0) {
      const tail = stderrTail.trim();
      const how = exitSignal !== null ? `was killed by ${exitSignal}` : `exited with status ${String(exitCode)}`;
      throw errors.brainFailed(`claude ${how}${tail === '' ? '' : `: ${tail.slice(-1_000)}`}`);
    }
  } finally {
    signal.removeEventListener('abort', kill);
    if (!exited) {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref();
      void closed.then(() => {
        clearTimeout(killTimer);
        live.delete(child);
      });
    } else {
      clearTimeout(killTimer);
      live.delete(child);
    }
  }
}

/** The exact argument list, exported so the probe can print it. */
export function claudeArguments(run: Pick<ClaudeRun, 'model' | 'systemPrompt' | 'effort' | 'tools'>): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model', run.model,
    ...(run.effort === undefined ? [] : ['--effort', run.effort]),
    '--system-prompt', run.systemPrompt,
    ...toolArguments(run.tools ?? []),
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
  ];
}
