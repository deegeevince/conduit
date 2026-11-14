// Runs the `remote` command once and returns what it printed. The only place
// in the library that starts it, so that "REMOTE_BIN names nothing", "signed
// out", "offline" and "too slow" are each one sentence, said here.

import { spawnTracked } from '../../brains/claude-cli/process';

export interface RemoteCall {
  readonly bin: string;
  readonly args: readonly string[];
  /** written to stdin, then closed: the body of a block */
  readonly stdin?: string;
  /** `REMOTE_SESSION_ID` and `REMOTE_AGENT`: set on every call, read or write */
  readonly identity: { readonly session: string; readonly agent: string };
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

const TAIL = 600;

function tail(text: string): string {
  const one = text.trim().replace(/\s+/g, ' ');
  return one.length > TAIL ? `…${one.slice(-TAIL)}` : one;
}

/** Resolves with stdout on exit 0. Rejects with a sentence that says what went wrong; never hangs past `timeoutMs`. */
export function runRemote(call: RemoteCall): Promise<string> {
  return new Promise((resolve, reject) => {
    const limit = AbortSignal.any([call.signal, AbortSignal.timeout(call.timeoutMs)]);
    if (limit.aborted) {
      reject(new Error('remote: not started, the call was already cancelled'));
      return;
    }
    const child = spawnTracked(call.bin, call.args, undefined, { env: { REMOTE_SESSION_ID: call.identity.session, REMOTE_AGENT: call.identity.agent } });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      limit.removeEventListener('abort', onAbort);
      done();
    };
    const onAbort = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      finish(() => reject(new Error(call.signal.aborted ? 'remote: cancelled' : `remote: no answer in ${call.timeoutMs} ms`)));
    };
    limit.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      err = (err + chunk).slice(-4_096);
    });
    child.stdin?.on('error', () => {
      // the child exited before it read its input: its exit code says why
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new Error(error.code === 'ENOENT' ? `remote: "${call.bin}" cannot be started (REMOTE_BIN)` : `remote: ${error.message}`)));
    });
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolve(out);
        else reject(new Error(`remote exited ${code ?? 'abnormally'}: ${tail(err === '' ? out : err)}`));
      });
    });
    if (call.stdin !== undefined) child.stdin?.end(call.stdin);
    else child.stdin?.end();
  });
}

/** The JSON a read prints. The CLI may print a line of notice before it; the first `{` or `[` starts the document. */
export function parseJson(text: string, what: string): unknown {
  const start = text.search(/[{[]/);
  if (start < 0) throw new Error(`remote printed no JSON for ${what}`);
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw new Error(`remote printed JSON this library cannot read for ${what}`);
  }
}
