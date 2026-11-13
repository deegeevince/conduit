import type { BriefForm, Capabilities, Issue, Line, ScreenFacts, Services, TurnContext, TurnInput } from '@conduit/language';

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
  /**
   * Every PDF this conversation holds, by the id the brief names it with. A brain that can hand a
   * document to its model attaches the ones the brief says are attached; others ignore this.
   */
  readonly pdfs?: readonly { readonly id: string; readonly bytes: Uint8Array }[];
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
  | { readonly type: 'usage'; readonly usage: BrainUsage };

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
