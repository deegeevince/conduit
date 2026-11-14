import type { ActionRisk, ActivityState, BrainChange, BrainChoice, BriefForm, Capabilities, CriticFinding, Issue, Line, LineProblem, PlacedBox, ReviewForm, ScreenFacts, Services, Sight, ToolChoice, TurnContext, TurnInput } from '@conduit/language';

export type BrainId = 'relay' | 'claude-cli' | 'replay';

/** A picture of the stage as an answer left it, as the painter captured it. */
export interface Snapshot {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface TurnRequest {
  readonly turn: string;
  readonly session: string;
  readonly input: TurnInput;
  /** screen facts, the stage as it stands, how earlier turns landed, and what was heard since */
  readonly context: TurnContext;
  /**
   * The stage as the previous answer left it, when the painter sent a picture
   * and SIGHT allows it. A brain that cannot take images ignores it; the
   * structured report in `context` says the same thing in words.
   */
  readonly snapshot: Snapshot | null;
  /** whether look-and-fix may run after this turn's draft (the policy and the turn's own choice) */
  readonly look?: boolean;
  /**
   * Every PDF this conversation holds, by the id the brief names it with. A brain that can hand a
   * document to its model attaches the ones the brief says are attached; others ignore this.
   */
  readonly pdfs?: readonly { readonly id: string; readonly bytes: Uint8Array }[];
}

/**
 * A second look at an answer the brain has just written: what the conductor
 * hands a brain for a fix pass of look-and-fix. It is the same turn, the same
 * conversation and the same stage; the brain is shown how its draft will land
 * and writes the lines that repair it.
 */
export interface ReviewRequest {
  readonly turn: string;
  readonly session: string;
  /** the pass about to be written: 2 for the first look */
  readonly pass: number;
  /** what the user asked, exactly as the turn's request had it */
  readonly input: TurnInput;
  /** how the lines so far will land, from the painter's `draft` event; null when it did not answer in time */
  readonly sight: Sight | null;
  /** the stage as the lines so far will leave it; null when there is no picture */
  readonly picture: Snapshot | null;
  /** lines of this turn so far that were dropped or repaired */
  readonly problems: readonly LineProblem[];
  /** the ids of styles the conversation has defined, so that `fear | …` still reads as speech in the fix */
  readonly styles: readonly string[];
  /** v2.1. `fix` (absent means this) or `refine`: which of `buildReviewBrief`'s two messages the brain is given */
  readonly form?: ReviewForm;
  /** v2.1. Where everything rests, by id, from the painter's draft report: the brief lists it so a fix can name what it moves */
  readonly placed?: readonly PlacedBox[];
  /** v2.1. What the critic made of the picture the brain is being shown, when it looked in time */
  readonly critic?: Pick<CriticFinding, 'problems' | 'suggestions'> | null;
  /** v2.1, `refine`: the passes asked for */
  readonly of?: number;
}

/** What a turn cost. Every field a brain cannot measure is null, never a guess. */
export interface BrainUsage {
  /** tokens read at full price */
  readonly inputTokens: number | null;
  /** tokens read from the provider's prompt cache */
  readonly cacheReadTokens: number | null;
  /** tokens written to the provider's prompt cache */
  readonly cacheWriteTokens: number | null;
  /** everything the model produced, hidden reasoning included */
  readonly outputTokens: number | null;
  /** the part of `outputTokens` that was hidden reasoning */
  readonly thinkingTokens: number | null;
  readonly costUsd: number | null;
  /** from the request being handed to the brain to its first character of text */
  readonly firstTextMs: number | null;
  /** from the request being handed to the brain to its last character */
  readonly totalMs: number;
  /** true when the brain answered from a process that already held the conversation */
  readonly warm: boolean;
}

export type BrainEvent =
  /** one complete, parsed line; `issues` are warnings about parts that were ignored */
  | { readonly type: 'line'; readonly line: Line; readonly issues: readonly Issue[] }
  /** something the brain wrote that is not a usable line */
  | { readonly type: 'reject'; readonly raw: string; readonly issues: readonly Issue[] }
  /**
   * What the brain was told for this turn, for the session log. Yielded once,
   * before any line. `system` is the system prompt and is set only on the
   * turn a process first hears it; `form` is `script` for the replay brain.
   */
  | { readonly type: 'brief'; readonly form: BriefForm | 'script'; readonly text: string; readonly system: string | null; readonly withSnapshot: boolean }
  /** Yielded once, after the last line, by a brain that can measure itself. */
  | { readonly type: 'usage'; readonly usage: BrainUsage }
  /**
   * v2.1, a brain with tools. One tool call as it happens: yielded when it starts (`running`) and again, with the same `id`, when it
   * ends. `summary` is a few plain words made by the brain adapter from the tool and its input, already passed through
   * `redactSecrets`: the conductor logs it and sends it to the chrome's activity strip as it is. A tool's result is never yielded.
   */
  | { readonly type: 'activity'; readonly id: string; readonly tool: string; readonly summary: string; readonly state: ActivityState; readonly ms: number | null }
  /**
   * v2.1, a brain with tools. The model wants to do something that needs the owner's yes (`askFirst`). The brain adapter holds the call
   * and yields this; the conductor shows it on stage and calls `Brain.permit` with the answer, or with `false` at `expiresMs`.
   */
  | { readonly type: 'permission'; readonly request: string; readonly tool: string; readonly summary: string; readonly risk: ActionRisk; readonly expiresMs: number }
  /**
   * The brain called a read-only web tool: its name and the query or URL, never what came back. This is the hotfix's form
   * (`BRAIN_TOOLS`); STUB(PLAN-v2.1 package G): `activity` takes its place, with a start, an end and a state for each call.
   */
  | { readonly type: 'tool'; readonly tool: string; readonly target: string | null };

/** What a brain needs to get ready for a conversation before its first turn. */
export interface BrainSession {
  readonly session: string;
  readonly capabilities: Capabilities;
  readonly screen: ScreenFacts;
  readonly services: Services;
}

/**
 * Anything that can write Series for a turn. The domain owns this interface;
 * a human-driven relay, a CLI child process and a fixture file all sit behind
 * it, and the rest of the server cannot tell them apart.
 */
export interface Brain {
  readonly id: BrainId;

  /**
   * A conversation has started, or its screen or capabilities have changed.
   * A brain that is slow to start gets ready now (the claude-cli brain starts
   * its process), so that the first turn does not pay for it. Returns at
   * once; never throws. Calling it again for the same session replaces what
   * was prepared if the facts differ.
   */
  open?(session: BrainSession): void;

  /**
   * Writes one turn. Yields each line as soon as it is complete and returns
   * when the brain has nothing more to say.
   *
   * Contract:
   * - Never buffers: a line is yielded the moment its newline arrives.
   * - Stops promptly when `signal` aborts, releases whatever the turn holds
   *   (not what the conversation holds), and returns without throwing.
   * - Throws `AppError` (`brain_failed`, `brain_timeout`) when it cannot go on.
   * - Works for a session it has never seen `open` for.
   */
  respond(request: TurnRequest, signal: AbortSignal): AsyncIterable<BrainEvent>;

  /**
   * Shows the brain its own draft and yields the lines of the fix: look and
   * fix. Called by the conductor after `respond` has returned for the same
   * turn and before the turn ends, at most `ReviewPolicy.passes` times. The
   * brain must still hold the conversation of that `respond` (the claude-cli
   * brain: the same warm process); a brain that cannot, or that has no eyes,
   * leaves this out and the turn ends as drafted.
   *
   * Contract, beyond `respond`'s:
   * - The message it sends its model is `buildReviewBrief` (language), with
   *   the picture attached when there is one. Nothing else is added: the
   *   wording is the same for every turn so that a measured gain belongs to
   *   the mechanism.
   * - A reply that is the one line `ok` (`isKeep`) yields nothing: the draft is kept.
   * - Yields a `brief` (form `since`) before any line and a `usage` after the
   *   last, like `respond`, so that the log and the bill show the pass.
   * - Aborting `signal` interrupts the model and leaves the conversation
   *   usable: an abandoned look must not cost the warm process.
   */
  review?(request: ReviewRequest, signal: AbortSignal): AsyncIterable<BrainEvent>;

  /** What this conversation's brain is set to. A brain with no model or effort leaves this out. */
  choice?(session: string): BrainChoice;

  /** Sets the model and/or effort for this conversation only. Whatever process the conversation holds is let go, so the next turn starts with the new settings. */
  choose?(session: string, change: BrainChange): BrainChoice;

  /**
   * v2.1, a brain with tools. The owner's answer to a `permission` event of this conversation. `false` denies it and the model is told
   * so; a request that is unknown or already answered is ignored. Never called with `true` except from the owner's own `permit` event.
   */
  permit?(session: string, request: string, allow: boolean): void;

  /** v2.1. What this conversation's brain may use, and what is switched on (`/tools`). A brain with no tools leaves this out. */
  tools?(session: string): readonly ToolChoice[];

  /** v2.1. Switches one tool or connected service on or off for this conversation. Only what the server's own allowlist offers can be switched on. */
  setTool?(session: string, name: string, on: boolean): readonly ToolChoice[];

  /** The conversation is over: let go of whatever was kept for it. */
  release?(session: string): void;

  /** Releases long-lived resources at shutdown. */
  close?(): Promise<void>;
}

/** Chooses the brain for a turn. Demo and script input always go to replay; everything else to the configured brain. */
export interface BrainRegistry {
  readonly configured: Brain;
  forInput(input: TurnInput): Brain;
  close(): Promise<void>;
}
