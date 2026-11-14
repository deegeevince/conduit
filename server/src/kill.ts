// The kill switch's memory. `POST /api/kill` (and `/stop-all` in the app) stops everything at once; what must outlive the moment is that
// AGENT TOOLS STAY OFF until the owner switches them back on, including across a restart: a server that comes back up from launchd after
// a kill must not hand the model its tools again on its own. This file holds only that one fact.
//
//   <DATA_DIR>/state/agent-off.json   { at, by, reason }   present: agent tools are off. Absent: they are as `AGENT=on` configured them.
//
// What the switch does when pulled is in `Conductor.killAll` (turns, permissions), `killAllChildren` (every child process, however stuck)
// and the brain (`agentOn`); this module is only the switch itself.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KillState {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
}

export interface KillSwitch {
  /** true while agent tools are off */
  engaged(): boolean;
  state(): KillState | null;
  engage(by: string, reason: string): KillState;
  /** switches agent tools back on; false when they were not off */
  release(): boolean;
}

/** The switch for a server with no data folder to remember it in, and for brains built without one (the tools, the checks): never engaged. */
export const NEVER_ENGAGED: KillSwitch = {
  engaged: () => false,
  state: () => null,
  engage: (by, reason) => ({ at: new Date().toISOString(), by, reason }),
  release: () => false,
};

export function createKillSwitch(file: string, now: () => number): KillSwitch {
  let current: KillState | null = null;
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<KillState>;
      // A file that exists is a switch that is pulled, even if it is unreadable detail: fail closed.
      current = { at: typeof raw.at === 'string' ? raw.at : 'unknown', by: typeof raw.by === 'string' ? raw.by : 'unknown', reason: typeof raw.reason === 'string' ? raw.reason : 'unknown' };
    }
  } catch {
    current = { at: 'unknown', by: 'unknown', reason: 'the switch file could not be read; agent tools stay off' };
  }
  return {
    engaged: () => current !== null,
    state: () => current,
    engage(by, reason) {
      current = { at: new Date(now()).toISOString(), by, reason };
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(current)}\n`, { mode: 0o600 });
        renameSync(temp, file);
      } catch {
        // Off in memory is still off. The caller's report says nothing more than that it is engaged; a restart would forget it, which the boot log and the audit would show.
      }
      return current;
    },
    release() {
      const was = current !== null;
      current = null;
      try {
        rmSync(file, { force: true });
      } catch {
        // an unremovable file keeps the switch pulled at the next start, which is the safe way to fail
      }
      return was;
    },
  };
}
