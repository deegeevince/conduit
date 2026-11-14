// The only place `claude -p` is run with tools. Three roles, each confined by the CLI's own permission flags
// rather than by a request in a prompt:
//   critic    reads a briefing folder (never the held-out set) and answers in words: no tool can write or run
//   builder   edits files in its own worktree, with the sealed paths absent and the protected paths denied
//             to the edit tools, and may run only the checks it is allowed to (typecheck, timeline, lint, prompt count)
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
  /** the folder the agent works in and may read: a briefing folder, a review folder, or the builder's worktree */
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

/** Checks a builder may run. Anything else the shell could do is not allowed. */
export const BUILDER_COMMANDS: readonly string[] = ['pnpm typecheck', 'pnpm timeline', 'pnpm prompt count', 'pnpm library lint', 'pnpm library match', 'pnpm library check'];

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
    '--setting-sources',
    'user',
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
  return [
    ...base,
    '--tools',
    'Read,Grep,Glob,Edit,Write,Bash',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    ...BUILDER_COMMANDS.map((command) => `Bash(${command}:*)`),
    '--disallowedTools',
    ...edits,
  ];
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
        env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', REMOTE_AGENT: '', REMOTE_SESSION_ID: '' },
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
