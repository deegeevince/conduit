// What the shell holds: messages, and the few pure rules that turn a conversation into what the canvas plays. No DOM here.

import type { ConversationTurn } from '@conduit/language';

export interface ReplyChoice {
  readonly text: string;
  /** the transcript's key for a live choice (tapping it taps the stage); null for a past reply, where a choice is a new message */
  readonly key: string | null;
  readonly open: boolean;
}

export interface Reply {
  readonly words: readonly string[];
  readonly choices: readonly ReplyChoice[];
  /** what kinds of thing it drew, in a word each (`drawing`, `diagram`); empty: words only */
  readonly drew: readonly string[];
}

export interface Photo {
  readonly url: string;
  readonly alt: string;
}

export interface UserMessage {
  readonly role: 'user';
  readonly id: string;
  readonly turn: string | null;
  readonly said: string;
  readonly photos: readonly Photo[];
  readonly voice: boolean;
  readonly inked: boolean;
  /** a tap, a played script or a pressed control: shown quietly, not as the person's own words */
  readonly quiet: boolean;
}

export type ReplyState = 'working' | 'done' | 'stopped' | 'failed';

export interface ReplyMessage {
  readonly role: 'reply';
  readonly id: string;
  readonly turn: string | null;
  readonly reply: Reply;
  readonly state: ReplyState;
  /** a sentence a person can read when the reply did not finish well */
  readonly note: string | null;
  /** the resting picture: a data address for a reply made on this page, a route for a past one */
  readonly still: string | null;
}

export type Message = UserMessage | ReplyMessage;

export const NO_REPLY: Reply = { words: [], choices: [], drew: [] };

/** What a reply drew, in a word: the element kinds the log holds, and the transcript's own labels, both come to these. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  structure: 'diagram',
  diagram: 'diagram',
  chart: 'chart',
  control: 'control',
  picture: 'picture',
  painting: 'picture',
  screen: 'mock-up',
  field: 'weather',
  weather: 'weather',
  app: 'app',
  drawn: 'drawing',
  shape: 'drawing',
  circle: 'drawing',
  rect: 'drawing',
  poly: 'drawing',
  path: 'drawing',
  sprite: 'drawing',
  group: 'drawing',
  ellipse: 'drawing',
  line: 'drawing',
};

/** Words for the kinds a reply drew; a kind this list does not know is called a drawing. Parts of a diagram are not listed apart from it. */
export function drewWords(kinds: readonly string[]): string[] {
  const out: string[] = [];
  for (const kind of kinds) {
    const key = kind.toLowerCase();
    if (key === 'node' || key === 'link' || key === 'part') continue;
    const word = KIND_WORDS[key] ?? 'drawing';
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/** The transcript's lines of what was drawn (`Drawn: a, b.`, `Diagram: Flow, 5 nodes`, `Control: Pace`) as the words above. */
export function drewFromTranscript(lines: readonly string[]): string[] {
  return drewWords(lines.map((line) => /^([A-Za-z-]+):/.exec(line)?.[1] ?? (/^painting\b/i.test(line) ? 'picture' : 'drawn')));
}

export function replyFromTurn(turn: ConversationTurn): Reply {
  return { words: turn.reply.words, choices: turn.reply.choices.map((text) => ({ text, key: null, open: true })), drew: drewWords(turn.reply.drew) };
}

/** The two messages a past turn made. */
export function messagesOfTurn(turn: ConversationTurn): [UserMessage, ReplyMessage] {
  const failed = turn.end === 'failed' || turn.end === 'timeout';
  const note = failed ? (turn.message ?? 'The reply did not finish.') : turn.end === 'interrupted' ? 'Stopped before it finished.' : null;
  return [
    {
      role: 'user',
      id: `u-${turn.turn}`,
      turn: turn.turn,
      said: turn.said,
      photos: turn.photos.map((photo, index) => ({ url: photo.url, alt: `Photo ${index + 1} you gave` })),
      voice: turn.voice,
      inked: turn.inked,
      quiet: turn.kind !== 'prompt',
    },
    { role: 'reply', id: `r-${turn.turn}`, turn: turn.turn, reply: replyFromTurn(turn), state: failed ? 'failed' : turn.end === 'interrupted' ? 'stopped' : 'done', note, still: turn.still },
  ];
}

/** A turn as the canvas needs it: how it was opened and the lines it was told in. */
export interface AnswerTurn {
  readonly turn: string;
  readonly kind: string;
  readonly lines: readonly string[];
}

/**
 * The lines that put the answer ending at `turn` on a clear stage: from the turn that began it afresh (a prompt, a demo, a played script) through
 * the taps and controls that carried it on. The same rule as `lastAnswer` in the painter's reel. Null when the turn is not in the list.
 */
export function answerScript(turns: readonly AnswerTurn[], turn: string): string | null {
  const at = turns.findIndex((candidate) => candidate.turn === turn);
  if (at < 0) return null;
  let from = 0;
  for (let i = at; i >= 0; i -= 1) {
    const kind = turns[i]?.kind;
    if (kind === 'prompt' || kind === 'demo' || kind === 'script') {
      from = i;
      break;
    }
  }
  return turns
    .slice(from, at + 1)
    .flatMap((candidate) => candidate.lines)
    .join('\n');
}

/** "Today", "Yesterday", or the date: how the list says when. */
export function whenWords(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const day = (date: Date): number => Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86_400_000);
  const apart = day(now) - day(then);
  const clock = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (apart <= 0) return `Today, ${clock}`;
  if (apart === 1) return `Yesterday, ${clock}`;
  return then.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** A line short enough for a heading. */
export function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
