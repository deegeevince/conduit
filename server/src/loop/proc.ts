// Runs a command to its end, with a deadline, and returns what it said. Every child is started through the
// server's one tracked spawn, so none outlives the loop (it is killed on exit). Used by git.ts and agents.ts,
// which are the only places `git` and `claude -p` are named, and by the runner for `pnpm`.

import { spawnTracked } from '../brains/claude-cli/process';

export interface Exec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** written to stdin, then closed */
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** killed (SIGTERM, then SIGKILL) when this fires */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface Executed {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}

const KEEP = 8_000_000;

export function exec(run: Exec): Promise<Executed> {
  return new Promise((resolve) => {
    if (run.signal?.aborted === true) return resolve({ code: null, stdout: '', stderr: '', aborted: true });
    const child = spawnTracked(run.bin, run.args, undefined, { cwd: run.cwd, ...(run.env === undefined ? {} : { env: run.env }) });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let settled = false;
    const kill = (): void => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    };
    const timer = run.timeoutMs === undefined ? undefined : setTimeout(kill, run.timeoutMs);
    run.signal?.addEventListener('abort', kill, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-KEEP);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-KEEP);
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(run.stdin ?? '');
    const done = (code: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra, aborted });
    };
    child.once('close', (code) => done(code));
    child.once('error', (error) => done(null, String(error)));
  });
}
