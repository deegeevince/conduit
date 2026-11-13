import type { BriefForm, Capabilities, Issue, ScreenFacts, Services, TurnEndReason, TurnInput, TurnReport } from '@conduit/language';
import type { BrainId, BrainUsage } from './brain';
import type { FetchOutcome } from './documents';

/**
 * One line of a session's log file. A session is one file of these, in the
 * order things happened, so a conversation can be read back after a restart:
 * what the user did, what the brain was told, every line it wrote (dropped
 * ones included), and what the painter says was actually shown.
 *
 * `at` is milliseconds since the session's first record.
 */
export type SessionRecord =
  | { readonly type: 'session'; readonly at: 0; readonly session: string; readonly started: string; readonly brain: BrainId; readonly language: number; readonly screen: ScreenFacts; readonly capabilities: Capabilities; readonly services: Services }
  /** the user typed, tapped a choice, or played a demo or a script */
  | { readonly type: 'turn'; readonly at: number; readonly turn: string; readonly input: TurnInput; readonly brain: BrainId }
  /** what the brain was told; `system` only when a process first hears it */
  | { readonly type: 'brief'; readonly at: number; readonly turn: string; readonly form: BriefForm | 'script'; readonly text: string; readonly system: string | null; readonly withSnapshot: boolean }
  /** one accepted line, as it was forwarded; `raw` is what the brain wrote when that differs */
  | { readonly type: 'line'; readonly at: number; readonly turn: string; readonly seq: number; readonly text: string; readonly start: number; readonly issues: readonly Issue[] }
  | { readonly type: 'reject'; readonly at: number; readonly turn: string; readonly raw: string; readonly issues: readonly Issue[] }
  | { readonly type: 'end'; readonly at: number; readonly turn: string; readonly reason: TurnEndReason; readonly message: string | null; readonly lines: number }
  | { readonly type: 'usage'; readonly at: number; readonly turn: string; readonly usage: BrainUsage }
  /** the painter's first line of this turn began to play: the user saw something */
  | { readonly type: 'started'; readonly at: number; readonly turn: string }
  /** what was shown, and how it landed. The stage it left behind is in the report. */
  | { readonly type: 'report'; readonly at: number; readonly turn: string; readonly report: TurnReport }
  /** a picture of the resting stage was saved beside the log under this file name */
  | { readonly type: 'snapshot'; readonly at: number; readonly turn: string; readonly file: string }
  /** a painting was asked for, and what became of it */
  | { readonly type: 'paint'; readonly at: number; readonly turn: string; readonly key: string; readonly prompt: string; readonly status: 'ready' | 'skipped' | 'failed'; readonly ms: number; readonly costUsd: number | null; readonly reason: string | null }
  /** a link the user gave was fetched, or refused, or failed */
  | { readonly type: 'fetch'; readonly at: number; readonly turn: string; readonly url: string; readonly finalUrl: string | null; readonly status: number | null; readonly contentType: string | null; readonly bytes: number; readonly ms: number; readonly outcome: FetchOutcome; readonly reason: string | null }
  | { readonly type: 'tap'; readonly at: number; readonly turn: string | null; readonly id: string; readonly text: string; readonly choice: boolean };

/** Fields of a record without the time, which the log stamps. */
export type SessionEntry = SessionRecord extends infer R ? (R extends { readonly at: number } ? Omit<R, 'at'> : never) : never;

/**
 * Where sessions are written down. The domain owns this interface; the file
 * system sits behind it.
 *
 * Contract:
 * - `write` never throws and never blocks a turn: a record that cannot be
 *   written is dropped and the failure is logged once per session.
 * - Records of one session reach the file in the order `write` was called.
 * - A picture is written beside the log, never inside it.
 */
export interface SessionLog {
  write(session: string, entry: SessionEntry): void;
  /** Saves a snapshot beside the session's log and returns the file name to record. */
  saveSnapshot(session: string, turn: string, mime: string, bytes: Uint8Array): string;
  /** The session is over: flush and close its file. */
  close(session: string): void;
  /** Flushes and closes everything, at shutdown. */
  closeAll(): Promise<void>;
}

/** The log that is used when LOG_DIR is set to `off`. */
export const NO_SESSION_LOG: SessionLog = {
  write: () => undefined,
  saveSnapshot: () => '',
  close: () => undefined,
  closeAll: async () => undefined,
};
