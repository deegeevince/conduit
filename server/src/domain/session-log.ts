import type { ActionRisk, ActivityState, BriefForm, Capabilities, ContentCount, ControlValue, CriticFinding, Issue, PassState, ReviewDecision, ReviewForm, ReviewOutcome, ScreenFacts, Services, TurnEndReason, TurnInput, TurnReport } from '@conduit/language';
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
  | { readonly type: 'brief'; readonly at: number; readonly turn: string; readonly form: BriefForm | 'script'; readonly text: string; readonly system: string | null; readonly withSnapshot: boolean; readonly pass?: number }
  /** one accepted line, as it was forwarded; `raw` is what the brain wrote when that differs */
  | { readonly type: 'line'; readonly at: number; readonly turn: string; readonly seq: number; readonly text: string; readonly start: number; readonly issues: readonly Issue[]; readonly pass?: number }
  | { readonly type: 'reject'; readonly at: number; readonly turn: string; readonly raw: string; readonly issues: readonly Issue[] }
  | { readonly type: 'end'; readonly at: number; readonly turn: string; readonly reason: TurnEndReason; readonly message: string | null; readonly lines: number }
  /** the brain searched the web or read a page: tool name and query or URL only */
  | { readonly type: 'tool'; readonly at: number; readonly turn: string; readonly tool: string; readonly target: string | null; readonly pass?: number }
  | { readonly type: 'usage'; readonly at: number; readonly turn: string; readonly usage: BrainUsage; readonly pass?: number }
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
  /** the techniques the turn's brief carried, best first (library ids), so that a technique's use can be counted from the logs */
  | { readonly type: 'techniques'; readonly at: number; readonly turn: string; readonly ids: readonly string[] }
  /** look and fix: where a turn's passes stood, in order */
  | { readonly type: 'pass'; readonly at: number; readonly turn: string; readonly pass: number; readonly state: PassState; readonly reason: string | null }
  /** the painter's report on a draft: how many things did not land, and whether a picture came with it */
  | { readonly type: 'draft'; readonly at: number; readonly turn: string; readonly pass: number; readonly noted: number; readonly picture: boolean; readonly file: string | null }
  /** what look and fix came to for a turn: the decisions, the times and the cost */
  | { readonly type: 'review'; readonly at: number; readonly turn: string; readonly outcome: ReviewOutcome; readonly decisions: readonly ReviewDecision[]; readonly firstLineMs: number | null; readonly totalMs: number; readonly costUsd: number | null }
  /** a table the conversation holds, and what became of sending it to the painter (`ready` when a chart asked for it) */
  | { readonly type: 'data'; readonly at: number; readonly turn: string; readonly id: string; readonly source: string; readonly rows: number; readonly status: 'held' | 'ready' | 'failed'; readonly reason: string | null }
  /** a control the user worked */
  | { readonly type: 'control'; readonly at: number; readonly turn: string | null; readonly id: string; readonly value: ControlValue; readonly text: string; readonly send: boolean }
  | { readonly type: 'tap'; readonly at: number; readonly turn: string | null; readonly id: string; readonly text: string; readonly choice: boolean }
  /** v2.1. A fix or a refine pass that was tried out of sight, and what became of it: shown, or refused and why. `lines` are what the brain wrote, shown or not. */
  | { readonly type: 'fix'; readonly at: number; readonly turn: string; readonly pass: number; readonly form: ReviewForm; readonly lines: readonly string[]; readonly shown: boolean; readonly why: string | null; readonly draft: ContentCount | null; readonly candidate: ContentCount | null; readonly file: string | null }
  /** v2.1. What the critic made of a turn's resting picture, seconds after the turn ended; `queued` when it was passed to the loop as evidence */
  | { readonly type: 'critic'; readonly at: number; readonly turn: string; readonly finding: CriticFinding; readonly queued: boolean }
  /** v2.1, a brain with tools. One tool call, at its start and again at its end: what it was in a few safe words (`redactSecrets`), never its input or its result. Takes the place of `tool`, which older logs still hold. */
  | { readonly type: 'activity'; readonly at: number; readonly turn: string; readonly id: string; readonly tool: string; readonly summary: string; readonly state: ActivityState; readonly ms: number | null }
  /** v2.1. The owner was asked for a yes, and what they said; `allow` null: no answer in time, which is a no */
  | { readonly type: 'permission'; readonly at: number; readonly turn: string; readonly request: string; readonly tool: string; readonly summary: string; readonly risk: ActionRisk; readonly allow: boolean | null; readonly ms: number }
  /** v2.1. A picture the user gave: its id, kind and size, and the file it was saved as beside the log. Never the bytes. */
  | { readonly type: 'upload'; readonly at: number; readonly turn: string | null; readonly id: string; readonly mime: string; readonly bytes: number; readonly width: number; readonly height: number; readonly file: string | null }
  /** v2.1. A setting the user changed with a command or the picker (`/model`, `/effort`, `/brain`, `/tools`, `/review`) */
  | { readonly type: 'setting'; readonly at: number; readonly name: string; readonly value: string };

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
