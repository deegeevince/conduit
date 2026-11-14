// The only module that starts a child process (the claude process, and the browser and dev server the exploration tool drives). Nothing else imports node:child_process.
// `runClaude` is the one-shot form (one message in, stdout lines out), exported for callers
// that want a plain answer from the model without a conversation, such as the exploration runner.

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { childEnvironment } from '../../env';
import { errors } from '../../errors';
import { CHROME_REMOVED, CHROME_SERVER } from '../../domain/browser';

/** SA4. The canvas tools' server name: `--allowedTools mcp__canvas` allows every tool of it, with no question put to the host. */
export const CANVAS_ALLOWED = 'mcp__canvas';

/** The tool flags: exactly the listed read-only web tools, allowed without a prompt, and every other tool denied. `canvas` is the 0600 file that configures the canvas server (SA4). */
export function toolArguments(tools: readonly string[], canvas?: string): string[] {
  const mcp = canvas === undefined ? [] : ['--mcp-config', canvas];
  if (tools.length === 0) return ['--tools', '', ...(canvas === undefined ? [] : ['--allowedTools', CANVAS_ALLOWED]), ...mcp];
  return ['--tools', tools.join(','), '--allowedTools', ...tools, ...(canvas === undefined ? [] : [CANVAS_ALLOWED]), '--disallowedTools', ...DENIED_TOOLS, ...mcp];
}

/**
 * Agent mode's flags (v2.1, package G). The CLI's own tools are exactly `builtIns` and nothing else; the permission mode is `manual`, so
 * nothing runs on a rule; and `--permission-prompt-tool stdio` makes the CLI ask this process, on its stdin and stdout, before every call
 * that has not been settled, which is every call that is not a plain read inside the working folder (see the notes at the top of warm.ts).
 * `--restricted` takes away the tools that run code and confines the file tools to the working folder. Connected services come only from
 * `mcpConfigs`, with `--strict-mcp-config` (added by the caller). Never `--dangerously-skip-permissions`, `bypassPermissions`,
 * `acceptEdits` or `--bare`: `agentArguments` cannot produce them.
 */
export interface AgentRun {
  readonly builtIns: readonly string[];
  readonly mcpConfigs: readonly string[];
  /**
   * The web tools are allowed by the CLI itself, with no round trip to this process. Set only when nothing else is on (no folder, no service,
   * no browser): then a search and a page read are free in every case, which is all `gateCall` would say, and the brain behaves as it did
   * without an agent. Measured: when WebSearch was asked about instead, the same model searched for a plain drawing in about one turn in four
   * (15 to 45 s to the first line, against 2). With anything else on, the web tools are asked about so that a fetch cannot carry out what the
   * other tools read (`gateCall`'s strict fetch).
   */
  readonly freeReads?: boolean;
  /** the owner's Chrome, through Claude in Chrome (`--chrome`), with the tools that cannot be gated removed */
  readonly chrome?: boolean;
  /** the folder the process starts in and that file tools are confined to; an empty temporary one when the owner named none */
  readonly cwd: string;
}

export function agentArguments(run: AgentRun, canvas?: string): string[] {
  const allowed = [...(run.freeReads === true ? run.builtIns.filter((name) => name === 'WebSearch' || name === 'WebFetch') : []), ...(canvas === undefined ? [] : [CANVAS_ALLOWED])];
  const configs = [...run.mcpConfigs, ...(canvas === undefined ? [] : [canvas])];
  return [
    '--tools', run.builtIns.join(','),
    ...(allowed.length > 0 ? ['--allowedTools', ...allowed] : []),
    '--permission-mode', 'manual',
    '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
    '--restricted',
    // `--chrome` brings its own MCP server whatever `--strict-mcp-config` says, and `--tools` does not govern it (see warm.ts); what is not
    // offered is removed here, and every call that is left is gated in `domain/browser.ts`. Off, it is off by name.
    ...(run.chrome === true ? ['--chrome', '--disallowedTools', ...CHROME_REMOVED.map((name) => `mcp__${CHROME_SERVER}__${name}`)] : ['--no-chrome']),
    ...(configs.length === 0 ? [] : ['--mcp-config', ...configs]),
  ];
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

/** Every process below `pid` (children, their children), by one look at the process table. Empty when the table cannot be read. */
function descendantsOf(roots: readonly number[]): number[] {
  let table = '';
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 1_500, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const row of table.split('\n')) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const child of children.get(next) ?? []) {
      if (child === process.pid || found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface KillReport {
  /** processes this server started that were running */
  readonly children: number;
  /** processes below them (a connected service's server, a browser helper) */
  readonly descendants: number;
  /** pids still there after the wait: a process stuck in the kernel, which nothing from here can end */
  readonly survivors: readonly number[];
  readonly ms: number;
}

/**
 * The kill switch's hand: SIGKILL, at once, to every process this server started and to everything below them, with no polite
 * request first. It does not wait for a process's `close`, which a stuck child, or a grandchild holding its pipes, would never give; it
 * looks, for up to `waitMs`, at whether the pids are gone, and says which are not. A child that ignores SIGTERM, an interrupt and
 * its own stdin is the case this exists for. Nothing here throws.
 */
export async function killAllChildren(waitMs = 1_500): Promise<KillReport> {
  const started = Date.now();
  const direct = [...live].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
  const below = descendantsOf(direct);
  for (const pid of [...below, ...direct]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const child of live) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  const all = [...direct, ...below];
  let left = all.filter(alive);
  while (left.length > 0 && Date.now() - started < waitMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    left = left.filter(alive);
  }
  return { children: direct.length, descendants: below.length, survivors: left, ms: Date.now() - started };
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
    '--no-chrome',
    '--setting-sources', '',
    '--no-session-persistence',
  ];
}
