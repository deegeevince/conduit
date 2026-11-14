// The only place `claude -p` is run with tools. Three roles, each confined by the CLI's own flags rather than by a request in a prompt,
// and all of them under `--restricted`: the CLI removes every tool that runs a command or code, ignores user, project and local
// settings, and confines the file tools to the working directory.
//   critic    reads a briefing folder (never the held-out set) and answers in words: it can only read
//   builder   edits files in a folder that is an EXPORT of the base commit, outside the repository, with no `.git` and no sealed path in it,
//             and has no shell at all: the three commands it used to be allowed (typecheck, timeline, prompt count) are run for it by the
//             runner, from the base commit's scripts, on a copy (deps.ts). Code a builder wrote is never run by a builder.
//   reviewer  reads a folder holding a diff and numbers, and answers in words
// Every call is on the owner's login through the `claude` CLI: ANTHROPIC_API_KEY is blanked in the child so that
// no key can be used, and the call is given its own dollar cap by the meter.

import { PROTECTED_PATHS } from './guard';
import { exec } from './proc';
import type { Reservation } from './budget';
import type { AgentRole } from './types';

export type AgentKind = 'critic' | 'builder' | 'reviewer';

export interface AgentCall {
  readonly kind: AgentKind;
  readonly role: AgentRole;
  readonly prompt: string;
  /** the folder the agent works in and may read: a briefing folder, a review folder, or the builder's export of the base commit */
  readonly cwd: string;
  readonly reservation: Reservation;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface AgentReply {
  readonly text: string;
  /** what the CLI says the call cost; null when it said nothing */
  readonly usd: number | null;
  readonly failed: string | null;
}

/** The seam: the runner is given one of these, the real one below or a stand-in. */
export interface Agents {
  run(call: AgentCall): Promise<AgentReply>;
}

/** The three commands a build is checked by. A builder cannot run them: the runner does, from the base commit's scripts, on a copy of what the builder wrote. */
export const RUNNER_COMMANDS: readonly (readonly string[])[] = [['typecheck'], ['timeline'], ['prompt', 'count']];

/** The argument list for a role. Exported so that `pnpm improve --dry-run` can print exactly what each is confined by. */
export function agentArguments(call: Pick<AgentCall, 'kind' | 'role' | 'reservation'>): string[] {
  const base = [
    '-p',
    '--output-format',
    'json',
    '--model',
    call.role.model,
    '--effort',
    call.role.effort,
    '--max-budget-usd',
    call.reservation.cap.toFixed(4),
    '--no-session-persistence',
    '--strict-mcp-config',
    '--restricted',
    '--permission-mode',
    'dontAsk',
  ];
  if (call.kind !== 'builder') {
    return [...base, '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read', 'Grep', 'Glob'];
  }
  const edits = PROTECTED_PATHS.flatMap((path) => {
    const glob = path.endsWith('/') ? `${path}**` : `${path}*`;
    return [`Edit(${glob})`, `Write(${glob})`, `Edit(/${glob})`, `Write(/${glob})`];
  });
  return [...base, '--tools', 'Read,Grep,Glob,Edit,Write', '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', '--disallowedTools', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Task', ...edits];
}

function interpret(stdout: string): AgentReply {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; total_cost_usd?: unknown; is_error?: unknown; subtype?: unknown };
    const text = typeof parsed.result === 'string' ? parsed.result : '';
    const usd = typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd) ? parsed.total_cost_usd : null;
    const failed = parsed.is_error === true ? (text !== '' ? text : String(parsed.subtype ?? 'error')) : null;
    return { text, usd, failed };
  } catch {
    return { text: stdout, usd: null, failed: stdout.trim() === '' ? 'the CLI said nothing' : null };
  }
}

export function claudeAgents(bin = 'claude'): Agents {
  return {
    async run(call) {
      const run = await exec({
        bin,
        args: agentArguments(call),
        cwd: call.cwd,
        stdin: call.prompt,
        // the subscription's own login is used: a key in the environment must not be, and the loop's write identity is not lent to a model
        env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', REMOTE_AGENT: '', REMOTE_SESSION_ID: '', BATTERY_SEALED_DIR: '' },
        signal: call.signal,
        timeoutMs: call.timeoutMs,
      });
      if (run.aborted) return { text: '', usd: null, failed: 'stopped (deadline or interrupt)' };
      const said = interpret(run.stdout);
      if (run.code !== 0 && said.failed === null) return { ...said, failed: `claude exited ${String(run.code)}: ${run.stderr.trim().slice(-400)}` };
      return said;
    },
  };
}
