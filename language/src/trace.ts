// How one reply was made, as the chat shell shows it ("how it was made"). One shape for both sources: the server folds it from a session log
// (server/src/domain/conversations.ts) and the page builds it from the stage events as they come (web/src/shell/trace-live.ts).
// Times (`at`) are milliseconds from the turn's opening. Nothing here holds a brief's text (it holds the system prompt): a brief is a kind and a size.

import type { ActionRisk, ActivityState, PassState, TurnEndReason } from './wire';

export interface TraceLine {
  readonly at: number;
  readonly text: string;
  /** 1 is the draft; a fix is 2 */
  readonly pass: number;
}

export interface TraceReject {
  readonly at: number;
  readonly raw: string;
  readonly why: readonly string[];
}

/** One tool call, as it ended (or as it stands): any tool name, canvas tools and the browser's included. `summary` has been through `redactSecrets`. */
export interface TraceTool {
  readonly id: string;
  readonly at: number;
  readonly tool: string;
  readonly summary: string;
  readonly state: ActivityState;
  readonly ms: number | null;
}

export interface TracePass {
  readonly at: number;
  readonly pass: number;
  readonly state: PassState;
  readonly reason: string | null;
}

/** A fix the brain wrote out of sight (or a refine pass): its lines, and whether any of it was shown. */
export interface TraceFix {
  readonly at: number;
  readonly pass: number;
  readonly form: 'fix' | 'refine' | 'repair';
  readonly lines: readonly string[];
  readonly shown: boolean | null;
  readonly why: string | null;
}

export interface TraceCritic {
  readonly at: number;
  readonly coherence: number;
  readonly readable: boolean;
  readonly asked: boolean;
  readonly problems: readonly { readonly what: string; readonly weight: 'blocks' | 'hurts' | 'polish' }[];
  readonly suggestions: readonly string[];
  readonly model: string | null;
  readonly costUsd: number | null;
}

export interface TraceAsk {
  readonly at: number;
  readonly tool: string;
  readonly summary: string;
  readonly risk: ActionRisk;
  /** null: no answer in time (a no), or still waiting */
  readonly allow: boolean | null;
}

export interface TraceReading {
  readonly at: number;
  readonly label: string;
  readonly state: 'start' | 'done' | 'failed';
  readonly message: string | null;
}

export interface TraceUsage {
  readonly pass: number;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly costUsd: number | null;
  readonly firstTextMs: number | null;
  readonly totalMs: number;
}

/** What the brain was told, never the words: `chars` is the text's length. */
export interface TraceBrief {
  readonly at: number;
  readonly pass: number;
  readonly form: string;
  readonly chars: number;
}

export interface TurnTrace {
  /** `model` and `effort` are null where the log did not hold them (a log older than this) */
  readonly brain: { readonly id: string; readonly model: string | null; readonly effort: string | null } | null;
  readonly readings: readonly TraceReading[];
  readonly lines: readonly TraceLine[];
  readonly rejects: readonly TraceReject[];
  readonly tools: readonly TraceTool[];
  readonly passes: readonly TracePass[];
  readonly fixes: readonly TraceFix[];
  readonly asks: readonly TraceAsk[];
  readonly critic: TraceCritic | null;
  readonly usage: readonly TraceUsage[];
  readonly briefs: readonly TraceBrief[];
  /** what look and fix came to */
  readonly review: { readonly result: 'fixed' | 'kept' | 'skipped'; readonly passes: number; readonly why: string | null } | null;
  readonly end: { readonly at: number; readonly reason: TurnEndReason; readonly message: string | null } | null;
}

export const EMPTY_TRACE: TurnTrace = { brain: null, readings: [], lines: [], rejects: [], tools: [], passes: [], fixes: [], asks: [], critic: null, usage: [], briefs: [], review: null, end: null };
