// The chat shell's read-only view of the session logs: a list of conversations, and one conversation as a thread of turns.
// Nothing here writes. The server folds the logs it already keeps (`<DATA_DIR>/logs/*.jsonl`) into these shapes (server/src/domain/conversations.ts).

import type { TurnTrace } from './trace';
import type { TurnEndReason } from './wire';

/** The routes the shell reads. `id` is a log file's stem, `20261114-172146-c1`. */
export const CONVERSATION_API = {
  list: '/api/conversations',
  one: (id: string): string => `/api/conversations/${id}`,
  /** GET: the resting picture kept for a turn (a JPEG); 404 when none was kept */
  still: (id: string, turn: string): string => `/api/conversations/${id}/turns/${turn}/still`,
  /** GET: a photo the person gave in this conversation (a JPEG, as the server kept it); 404 when it is not this conversation's */
  photo: (id: string, photo: string): string => `/api/conversations/${id}/photos/${photo}`,
  /** POST `{ session }`: this page's (still empty) session takes up the conversation: its next turns are appended to the same log and the brain is given a short account of it */
  continue: (id: string): string => `/api/conversations/${id}/continue`,
} as const;

/** The body of the continue request: the page's own session, which must have no turn yet. */
export interface ContinueRequest {
  readonly session: string;
}

export interface ContinueResponse {
  /** the conversation's id, unchanged: the same log goes on */
  readonly id: string;
  /** the session that now writes to it */
  readonly session: string;
}

export interface ConversationSummary {
  readonly id: string;
  /** the session's own id (`c3`); a server that has been restarted hands the same ids out again, so the id above is the one to hold */
  readonly session: string;
  /** ISO time the conversation began */
  readonly started: string;
  /** ISO time the log was last written */
  readonly updated: string;
  /** the first thing the person said, cut to a line; `New conversation` when nothing has been said */
  readonly title: string;
  readonly turns: number;
}

/** What a reply said: the words left standing, the choices it offered, and what kinds of thing it drew (empty: words only). */
export interface ConversationReply {
  readonly words: readonly string[];
  readonly choices: readonly string[];
  readonly drew: readonly string[];
}

export interface ConversationTurn {
  readonly turn: string;
  /** the conversation was picked up again at this turn: a new session began writing to the same log here */
  readonly continued?: true;
  /** how the turn was opened: `prompt` is the person typing; the others are taps, a played script, a pressed control */
  readonly kind: 'prompt' | 'tap' | 'act' | 'demo' | 'script' | 'refine';
  /** the person's words, or a short account of what they did */
  readonly said: string;
  /** photos the person gave with these words, in order */
  readonly photos: readonly { readonly id: string; readonly url: string }[];
  /** the words came from a voice note */
  readonly voice: boolean;
  /** the person drew on the canvas and sent the marks with these words */
  readonly inked: boolean;
  readonly reply: ConversationReply;
  /** the lines of Series the brain wrote, in order: what the canvas plays to show this turn */
  readonly lines: readonly string[];
  /** the resting picture, when one was kept */
  readonly still: string | null;
  readonly end: TurnEndReason | null;
  readonly message: string | null;
  /** how it was made: the timeline the shell opens under the reply */
  readonly trace: TurnTrace;
}

export interface ConversationView {
  readonly summary: ConversationSummary;
  readonly turns: readonly ConversationTurn[];
}
