// The audit trail: an append-only JSONL file in the data folder that says, for everything the server did with the owner's browser, keys
// and services: who asked, what was done, aimed at what, whether it was allowed and who decided. It is written before the owner is told
// anything, never read by a turn, and never holds a secret: a target is a few words that have been through `redactSecrets`, with the
// query string of an address cut off.
//
//   kind                    what it records
//   tool                    a tool call the brain made (WebSearch, a page read, a file tool, a connected service's call): `allowed` or `denied`
//   permission_asked        a confirm control was put to the owner
//   permission_answered     the owner's answer, or the deadline's, or the kill switch's: who decided is in `decidedBy`
//   setting                 a setting changed: model, effort, mode, a tool switched, what is held for every reply
//   connector               a connected service or the owner's own data was used (a Remote read, an MCP service, a dataset)
//   kill                    the kill switch was pulled, or agent tools were switched back on
//   refused                 a request this server turned away on identity
//   upload                  a photo the owner gave: taken (id, size, where kept; never the bytes) or turned away and why
//   voice                   a voice note the owner gave: taken and read on this Mac (id, size, language, recogniser; never the audio or the words) or turned away and why
//   server                  the server started, or kept serving after an error it did not expect
//
// `decidedBy`: `policy` (the gate in domain/agent.ts), `owner` (their yes or no on the stage), `timeout` (no answer is a no),
// `turn` (the turn ended or was interrupted), `kill` (the kill switch), `system` (the server itself).

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from './domain/agent';
import { currentIdentity, labelOf } from './identity';
import type { Logger } from './log';

export type AuditKind = 'tool' | 'permission_asked' | 'permission_answered' | 'setting' | 'connector' | 'kill' | 'refused' | 'upload' | 'voice' | 'server';
export type AuditDecision = 'allowed' | 'denied' | 'asked' | 'done' | 'failed';
export type AuditDecider = 'policy' | 'owner' | 'timeout' | 'turn' | 'kill' | 'system';

export interface AuditEntry {
  readonly time: string;
  readonly kind: AuditKind;
  readonly session: string | null;
  readonly turn: string | null;
  /** the Tailscale login of whoever asked, or `local`; `system` for what the server did on its own */
  readonly login: string;
  readonly tool: string | null;
  /** what the call was aimed at, in a few words, secrets and query strings removed */
  readonly target: string | null;
  readonly decision: AuditDecision | null;
  readonly decidedBy: AuditDecider | null;
  /** anything else worth a line: the risk of a call, the old value of a setting; never a secret */
  readonly note?: string;
}

/** What a caller says; the time, the login and the redaction are the audit's. */
export interface AuditInput {
  readonly kind: AuditKind;
  readonly session?: string | null;
  readonly turn?: string | null;
  /** omitted: whoever is asking in this request (`currentIdentity`) */
  readonly login?: string;
  readonly tool?: string | null;
  readonly target?: string | null;
  readonly decision?: AuditDecision | null;
  readonly decidedBy?: AuditDecider | null;
  readonly note?: string;
}

export interface Audit {
  record(input: AuditInput): void;
}

export const NO_AUDIT: Audit = { record: () => undefined };

/** A target that is safe to keep: credentials replaced, the query string and fragment of any address cut off, one line, bounded. */
export function auditTarget(text: string | null | undefined, max = 200): string | null {
  if (text === undefined || text === null || text === '') return null;
  const bare = text.replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/gi, '$1?…');
  return redactSecrets(bare, max);
}

export function createAudit(file: string, now: () => number, log: Logger): Audit {
  let failed = false;
  let ready = false;
  return {
    record(input) {
      const entry: AuditEntry = {
        time: new Date(now()).toISOString(),
        kind: input.kind,
        session: input.session ?? null,
        turn: input.turn ?? null,
        login: input.login ?? labelOf(currentIdentity()),
        tool: input.tool ?? null,
        target: auditTarget(input.target),
        decision: input.decision ?? null,
        decidedBy: input.decidedBy ?? null,
        ...(input.note === undefined ? {} : { note: redactSecrets(input.note, 200) }),
      };
      try {
        if (!ready) {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          ready = true;
        }
        // Owner only: the trail says what was done with the owner's browser and accounts.
        appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        failed = false;
      } catch (error) {
        // An audit that cannot be written is said once, loudly, and never stops a turn: refusing to work would hand the owner a dead app, but the log says so.
        if (!failed) log.error('audit.write_failed', { file, error });
        failed = true;
      }
    },
  };
}

export interface AuditQuery {
  readonly limit?: number;
  readonly kind?: string;
  readonly session?: string;
  readonly login?: string;
  /** ISO time: entries from then on */
  readonly since?: string;
}

const TAIL_BYTES = 8 * 1024 * 1024;

/** The newest entries that match, newest first. Reads only the end of a large file; a torn line is skipped. */
export function readAudit(file: string, query: AuditQuery = {}): AuditEntry[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  const limit = Math.max(1, Math.min(query.limit ?? 100, 5000));
  const found: AuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && found.length < limit; i -= 1) {
    const raw = lines[i];
    if (raw === undefined || raw.trim() === '') continue;
    try {
      const entry = JSON.parse(raw) as AuditEntry;
      if (typeof entry.time !== 'string' || typeof entry.kind !== 'string') continue;
      if (query.kind !== undefined && entry.kind !== query.kind) continue;
      if (query.session !== undefined && entry.session !== query.session) continue;
      if (query.login !== undefined && entry.login !== query.login) continue;
      if (query.since !== undefined && entry.time < query.since) continue;
      found.push(entry);
    } catch {
      // a line cut short
    }
  }
  return found;
}
