import type { ActionRisk, ActivityState, BriefForm, Capabilities, ContentCount, ControlValue, CriticFinding, Issue, NodeId, NodeStatus, PassState, ReviewDecision, ReviewForm, ReviewOutcome, ScreenFacts, Services, StateChange, TurnEndReason, TurnInput, TurnReport } from '@conduit/language';
import type { Observation } from '@conduit/language';
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
  | { readonly type: 'session'; readonly at: 0; readonly session: string; readonly started: string; readonly brain: BrainId; readonly language: number; readonly screen: ScreenFacts; readonly capabilities: Capabilities; readonly services: Services; /** v3. The document this session opens again (`API.documentOpen`): its id is the stem of the file that began it. The document is the fold of that file and every file that says this. */ readonly resumes?: string }
  /** the user typed, tapped a choice, or played a demo or a script */
  | { readonly type: 'turn'; readonly at: number; readonly turn: string; readonly input: TurnInput; readonly brain: BrainId; readonly login?: string; readonly model?: string; readonly effort?: string }
  /** what the brain was told; `system` only when a process first hears it */
  | { readonly type: 'brief'; readonly at: number; readonly turn: string; readonly form: BriefForm | 'script'; readonly text: string; readonly system: string | null; readonly withSnapshot: boolean; readonly pass?: number }
  /** one accepted line, as it was forwarded; `raw` is what the brain wrote when that differs */
  | { readonly type: 'line'; readonly at: number; readonly turn: string; readonly seq: number; readonly text: string; readonly start: number; readonly issues: readonly Issue[]; readonly pass?: number; /** v3. The document node the line landed in: a `part`'s own, a step's, an ask's or a hint's. Absent for every other line. */ readonly node?: NodeId }
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
  | { readonly type: 'control'; readonly at: number; readonly turn: string | null; readonly id: string; readonly value: ControlValue; readonly text: string; readonly send: boolean; readonly app?: boolean; readonly ask?: boolean }
  | { readonly type: 'tap'; readonly at: number; readonly turn: string | null; readonly id: string; readonly text: string; readonly choice: boolean }
  /** v2.1. A fix or a refine pass that was tried out of sight, and what became of it: shown, or refused and why. `lines` are what the brain wrote, shown or not. */
  | { readonly type: 'fix'; readonly at: number; readonly turn: string; readonly pass: number; readonly form: ReviewForm; readonly lines: readonly string[]; readonly shown: boolean; readonly why: string | null; readonly draft: ContentCount | null; readonly candidate: ContentCount | null; readonly file: string | null; readonly retried?: boolean }
  /** v2.1. What the critic made of a turn's resting picture, seconds after the turn ended; `queued` when it was passed to the loop as evidence */
  | { readonly type: 'critic'; readonly at: number; readonly turn: string; readonly finding: CriticFinding; readonly queued: boolean }
  /** v2.1, a brain with tools. One tool call, at its start and again at its end: what it was in a few safe words (`redactSecrets`), never its input or its result. Takes the place of `tool`, which older logs still hold. */
  | { readonly type: 'activity'; readonly at: number; readonly turn: string; readonly id: string; readonly tool: string; readonly summary: string; readonly state: ActivityState; readonly ms: number | null; readonly permit?: 'auto' }
  /** v2.1. The owner was asked for a yes, and what they said; `allow` null: no answer in time, which is a no */
  | { readonly type: 'permission'; readonly at: number; readonly turn: string; readonly request: string; readonly tool: string; readonly summary: string; readonly risk: ActionRisk; readonly allow: boolean | null; readonly ms: number }
  /** v2.1. A picture the user gave: its id, kind and size, and the file it was saved as beside the log. Never the bytes. */
  | { readonly type: 'upload'; readonly at: number; readonly turn: string | null; readonly id: string; readonly mime: string; readonly bytes: number; readonly width: number; readonly height: number; readonly file: string | null }
  /** v2.1. This session took up an older conversation: its records from here on are appended to that log (`from` is its first session's id) */
  | { readonly type: 'continued'; readonly at: number; readonly session: string; readonly from: string; readonly started: string }
  /** v2.1. A setting the user changed with a command or the picker (`/model`, `/effort`, `/brain`, `/tools`, `/review`) */
  | { readonly type: 'setting'; readonly at: number; readonly name: string; readonly value: string }
  /**
   * v3 (2.11). A node's status was set from outside the turn that wrote it: verified or refused by the verifier, or sent back to be
   * written again (`reset`: the body goes, the children stay). Its filling and filled are not logged: they follow from lines and `end`.
   */
  | { readonly type: 'node'; readonly at: number; readonly turn: string | null; readonly node: NodeId; readonly status: NodeStatus; readonly reset?: true; readonly why: string | null }
  /** v3 (2.5). Something the person did that `advance` committed: where they are, what a control holds, an answer tried, a reveal reached, a node finished. Logged only when it changed something. */
  | { readonly type: 'state'; readonly at: number; readonly turn: string | null; readonly change: StateChange }
  /**
   * v3. A repair of an answer, after the critic judged it broken: what the critic found (`gates`, the finding's coherence), what the brain
   * wrote, what the stage measured with it tried (`blockingBefore`, `blockingAfter`), and what became of it. `state`: `kept` (`repair` is the turn
   * that showed it), `refused` (nothing changed; `why`), `nothing` (the brain wrote nothing), `failed`, `cancelled` (a new turn came), `skipped` (a
   * limit held it back before the brain was asked). `ms` is the whole repair from the critic's verdict; `sinceEndMs` from the answer's `end`.
   */
  /** The critic found these ids broken in `turn` and nothing mended them: they ride in the brief of the next turns (`why`: what held the repair back) */
  | { readonly type: 'owed'; readonly at: number; readonly turn: string; readonly ids: readonly (string | null)[]; readonly why: string }
  /** The brain ended turn `turn` with `refine | note` and the server ran it again at once (`note` is its own words) */
  | { readonly type: 'continue'; readonly at: number; readonly turn: string; readonly note: string }
  | {
      readonly type: 'repair';
      readonly at: number;
      readonly turn: string;
      readonly repair: string | null;
      readonly state: 'kept' | 'refused' | 'nothing' | 'failed' | 'cancelled' | 'skipped';
      readonly gates: readonly string[];
      readonly why: string | null;
      readonly lines: readonly string[];
      readonly coherenceBefore: number;
      readonly blockingBefore: number | null;
      readonly blockingAfter: number | null;
      readonly costUsd: number | null;
      readonly ms: number;
      readonly tryMs: number | null;
      readonly firstLineMs: number | null;
      readonly sinceEndMs: number;
    }
  /** v3. The critic's second look at a repaired answer: the score before and after, and its own account of the progress (`fixed`, `stillFailing`, `newFailures`). */
  | {
      readonly type: 'repair-judged';
      readonly at: number;
      readonly turn: string;
      readonly repair: string;
      readonly coherenceBefore: number;
      readonly coherenceAfter: number;
      readonly trend: string | null;
      readonly fixed: readonly string[];
      readonly stillFailing: readonly string[];
      readonly newFailures: readonly string[];
      readonly note: string;
      readonly ms: number;
    }
  /** SA2. The server measured a pass's draft itself: how long it took, the digest of its boxes and the number of things it noted */
  | { readonly type: 'measure'; readonly at: number; readonly turn: string; readonly pass: number; readonly ms: number; readonly boxes: string; readonly noted: number }
  /** SA2. The page and the server do not measure alike (`where`: `engine` the version, `draft` or `report` a digest). From then on this session's drafts go through the page's gate. */
  | { readonly type: 'drift'; readonly at: number; readonly turn: string | null; readonly where: 'engine' | 'draft' | 'report'; readonly page: string | null; readonly server: string | null; readonly why: string }
  /** SA3. One observation: the person's input, what only the page's eyes know, a refusal, a drift. Engine lint is derived from the report and not logged. */
  | { readonly type: 'obs'; readonly at: number; readonly turn: string | null; readonly obs: Observation }
  /** SA3. What the brain was shown of what was observed before a turn, what it pulled (SA4), and what stood open or cleared. Each list holds fingerprints. */
  | {
      readonly type: 'attention';
      readonly at: number;
      readonly turn: string;
      readonly rev: readonly [number, number];
      readonly digest: { readonly counts: Readonly<Record<string, number>>; readonly urgent: number; readonly lines: number; readonly tokens: number };
      readonly shown: readonly string[];
      readonly pulled: readonly { readonly tool: string; readonly kind: string; readonly since: number; readonly n: number; readonly ms: number }[];
      readonly watch: readonly string[];
      readonly ignore: readonly string[];
      readonly refusedIgnore: readonly string[];
      readonly cleared: readonly string[];
      readonly open: readonly string[];
      readonly calls: number;
      readonly toolMs: number;
    };

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
  /** Saves a snapshot (or, for `/capture`, a `video/webm` film) beside the session's log and returns the file name to record; empty when nothing is written. */
  saveSnapshot(session: string, turn: string, mime: string, bytes: Uint8Array): string;
  /** v2.1. The name of the session's log file, as the critic's queue records it; empty when nothing is written. */
  fileOf(session: string): string;
  /** v2.1. From now on this session's records go to the existing log `stem` (a conversation's id), not a file of its own. Nothing written before is moved. */
  adopt(session: string, stem: string): void;
  /** The session is over: flush and close its file. */
  close(session: string): void;
  /** Flushes and closes everything, at shutdown. */
  closeAll(): Promise<void>;
}

/** The log that is used when LOG_DIR is set to `off`. */
export const NO_SESSION_LOG: SessionLog = {
  write: () => undefined,
  saveSnapshot: () => '',
  fileOf: () => '',
  adopt: () => undefined,
  close: () => undefined,
  closeAll: async () => undefined,
};
