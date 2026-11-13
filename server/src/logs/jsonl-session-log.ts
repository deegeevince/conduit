// The only module that writes session logs to disk.

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEntry, SessionLog } from '../domain/session-log';
import type { Logger } from '../log';

export interface JsonlSessionLogDeps {
  readonly log: Logger;
  /** absolute path of the folder; created if missing */
  readonly dir: string;
  /** milliseconds; injected so nothing here reads the wall clock directly */
  readonly now: () => number;
}

interface Open {
  readonly stem: string;
  readonly startedAt: number;
  /** lines not yet handed to the file system, flushed together */
  pending: string[];
  /** everything written so far, in order; nothing is ever awaited by a caller */
  chain: Promise<void>;
  scheduled: boolean;
  gaveUp: boolean;
}

function stampOf(ms: number): string {
  const date = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/**
 * One file per conversation: `<dir>/<YYYYMMDD-HHMMSS>-<session>.jsonl`, one
 * SessionRecord per line, appended as things happen, so a file is readable
 * while its conversation is still going and after the server has been killed.
 * Snapshots go beside it as `<same stem>-<turn>.jpg`.
 *
 * - Writes are queued per session and never awaited by the caller.
 * - The first failure for a session is logged at `warn` and that session's
 *   log is given up; the conversation goes on.
 * - Nothing is ever read back by the server: the files are for people and for
 *   `pnpm sessions`.
 */
export function createJsonlSessionLog(deps: JsonlSessionLogDeps): SessionLog {
  const open = new Map<string, Open>();
  // A closed session never gets a second file: late records (a painting that finishes after the drop) are ignored.
  const closed = new Set<string>();
  // Logs closed a moment ago may still be writing; shutdown waits for them too.
  const finishing = new Set<Promise<void>>();
  let folder: Promise<void> | null = null;

  const ensureFolder = (): Promise<void> => {
    folder ??= mkdir(deps.dir, { recursive: true }).then(() => undefined);
    return folder;
  };

  const stateFor = (session: string): Open | null => {
    if (closed.has(session)) return null;
    let state = open.get(session);
    if (state === undefined) {
      const startedAt = deps.now();
      state = { stem: `${stampOf(startedAt)}-${session}`, startedAt, pending: [], chain: Promise.resolve(), scheduled: false, gaveUp: false };
      open.set(session, state);
    }
    return state;
  };

  const giveUp = (session: string, state: Open, error: unknown): void => {
    if (state.gaveUp) return;
    state.gaveUp = true;
    state.pending = [];
    // The folder may have been fixed since; the next session tries again.
    folder = null;
    deps.log.warn('sessionlog.gave_up', { session, file: `${state.stem}.jsonl`, error });
  };

  const flush = (session: string, state: Open): void => {
    state.scheduled = false;
    if (state.pending.length === 0) return;
    const text = state.pending.join('');
    state.pending = [];
    state.chain = state.chain.then(async () => {
      if (state.gaveUp) return;
      try {
        await ensureFolder();
        await appendFile(join(deps.dir, `${state.stem}.jsonl`), text);
      } catch (error) {
        giveUp(session, state, error);
      }
    });
  };

  const schedule = (session: string, state: Open): void => {
    if (state.scheduled) return;
    state.scheduled = true;
    setImmediate(() => flush(session, state));
  };

  return {
    write: (session, entry: SessionEntry) => {
      const state = stateFor(session);
      if (state === null || state.gaveUp) return;
      try {
        const { type, ...rest } = entry;
        state.pending.push(`${JSON.stringify({ type, at: Math.max(0, deps.now() - state.startedAt), ...rest })}\n`);
        schedule(session, state);
      } catch (error) {
        giveUp(session, state, error);
      }
    },
    saveSnapshot: (session, turn, mime, bytes) => {
      const state = stateFor(session);
      if (state === null || state.gaveUp) return '';
      const name = `${state.stem}-${turn}.${mime === 'image/png' ? 'png' : 'jpg'}`;
      flush(session, state);
      state.chain = state.chain.then(async () => {
        if (state.gaveUp) return;
        try {
          await ensureFolder();
          await writeFile(join(deps.dir, name), bytes);
        } catch (error) {
          giveUp(session, state, error);
        }
      });
      return name;
    },
    close: (session) => {
      const state = open.get(session);
      closed.add(session);
      if (state === undefined) return;
      open.delete(session);
      flush(session, state);
      const last = state.chain;
      finishing.add(last);
      void last.finally(() => finishing.delete(last));
    },
    closeAll: async () => {
      const states = [...open.entries()];
      for (const [session, state] of states) {
        closed.add(session);
        flush(session, state);
      }
      open.clear();
      await Promise.all([...states.map(([, state]) => state.chain), ...finishing]);
    },
  };
}
