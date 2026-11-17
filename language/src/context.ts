import type { DocState, Document } from './document';
import type { StageBase } from './schedule';
import type { Sight } from './sight';
import type { ShownItem } from './stage';
import type { LeadWindow } from './timing';
import type { Issue } from './types';
import type { BackEventRecord, Capabilities, ClockState, ScreenFacts, Services, TurnInput } from './wire';

/** A line of an earlier turn that did not do what the brain meant, as the brain should hear about it. */
export interface LineProblem {
  /** the line as the brain wrote it, cut to 120 characters */
  readonly raw: string;
  /** `rejected`: nothing of it happened. `repaired`: it happened without the part named in `why`. */
  readonly kind: 'rejected' | 'repaired';
  readonly why: string;
}

/** A blocking finding of the critic that nothing has acted on, kept to be told to the brain at its next turn. */
export interface OwedFinding {
  /** the turn the critic looked at */
  readonly turn: string;
  /** the element it names; null when it names no one */
  readonly id: string | null;
  readonly gate: string | null;
  readonly what: string;
}

/** One earlier turn as the brain should remember it: what the user said and what they actually SAW. */
export interface TurnMemory {
  readonly turn: string;
  readonly input: TurnInput;
  readonly outcome:
    | 'finished'
    | 'interrupted'
    /** the painter never reported; nothing can be assumed seen */
    | 'unseen'
    | 'failed';
  /** where the playhead stopped, when known */
  readonly playhead: number | null;
  readonly shown: readonly ShownItem[];
  /** how it landed, from the painter's report; null when the painter never reported */
  readonly sight: Sight | null;
  /** where the user asked to see it all at once, if they did: they did not watch what came after */
  readonly skippedAt: number | null;
  /** lines the brain wrote that were dropped or repaired, at most 8, so it can stop making the same mistake */
  readonly problems: readonly LineProblem[];
  /** true when a picture of the resting stage is held for this turn */
  readonly snapshot: boolean;
  /** how look-and-fix went for this turn; absent when the turn was never considered for it */
  readonly review?: ReviewOutcome;
}

/** What became of look-and-fix in one turn. `why` is the reason it was skipped, in a few words. */
export interface ReviewOutcome {
  readonly result: 'fixed' | 'kept' | 'skipped';
  /** passes the brain wrote, the draft included */
  readonly passes: number;
  readonly why: string | null;
}

/**
 * A technique as the brain is handed it: a recipe that judged well on answers
 * like the one being asked for. Techniques are chosen per turn and ride in the
 * turn's brief. They are never part of the system prompt, which is fixed for a
 * conversation so that the warm process and the prompt cache hold.
 */
export interface TechniqueCard {
  /** the library's id for it, for the session log and the usage count */
  readonly id: string;
  readonly title: string;
  /** when to use it, and when not, in a sentence or two */
  readonly when: string;
  /** a short worked example in Series; each line parses */
  readonly example: readonly string[];
}

/**
 * Rows the server holds for this conversation and a chart can draw by
 * reference: a table the user pasted, or a CSV behind a link. The brain is
 * told what is in it and never retypes it.
 */
export interface DataTable {
  /** `d1`, `d2`, …: what `chart … data=` names */
  readonly id: string;
  /** where it came from, in a few words: `pasted by the user`, `a CSV at a link` */
  readonly source: string;
  /** the column names, the first being what runs along the bottom */
  readonly columns: readonly string[];
  /** every row, cells as text, in order */
  readonly rows: readonly (readonly string[])[];
}

/** What the brain is told about a `DataTable`: enough to say true things about it and to draw it, never the whole of it. */
export interface DataFacts {
  readonly id: string;
  readonly source: string;
  readonly columns: readonly string[];
  readonly count: number;
  /** the first two and the last two rows, as written */
  readonly sample: readonly (readonly string[])[];
  /** per numeric column: its least, its most, its first and its last value, as written */
  readonly range: Readonly<Record<string, { readonly min: string; readonly max: string; readonly first: string; readonly last: string }>>;
  /** it arrived with this turn's message */
  readonly fresh: boolean;
}

/** The most rows of DATA the server holds for one table, and the most tables a conversation holds. */
export const DATA_LIMITS = { rows: 20_000, tables: 4 } as const;

/** The most a turn's techniques may add to its brief, in characters, and how many a turn is given. */
/** `documentChars`: a card that writes a document of parts carries the rules of its audience, so it is allowed more room than a recipe for a picture. */
export const TECHNIQUE_LIMITS = { cards: 3, chars: 1650, documentChars: 4400 } as const;

/**
 * `full` is for a brain that remembers nothing: a fresh process, or a relay
 * agent. `since` is for a brain that still holds the conversation (a warm
 * process): it is told only what it cannot know, which is what the stage did
 * with its last answer and what the user did next.
 */
export type BriefForm = 'full' | 'since';

/** A prompt this long is handed to the brain as a document, not as a line of speech. */
export const PASTE_AS_DOCUMENT_CHARS = 1500;

/** The most characters of a web page or pasted text a brain is given; a PDF goes whole. */
export const DOCUMENT_TEXT_CHARS = 40_000;

/** Something the user gave the brain to read: a PDF, a web page, or a long pasted passage. */
export interface DocumentFacts {
  readonly id: string;
  /** `pdf` travels as an attachment to the message; the others as text in the brief */
  readonly kind: 'pdf' | 'text' | 'pasted';
  /** the site it came from, or `pasted` */
  readonly source: string;
  readonly url: string | null;
  readonly title: string | null;
  /** characters of `text` that were kept; 0 for a PDF */
  readonly chars: number;
  /** the text was cut at `DOCUMENT_TEXT_CHARS` and the end is missing */
  readonly truncated: boolean;
  readonly text: string | null;
  /** it arrived with this turn's message */
  readonly fresh: boolean;
}

/** A link the user gave that could not be read, and why in plain words. */
export interface UnreadFacts {
  readonly url: string;
  readonly why: string;
}

/** Everything a brain is told at the start of a turn. */
/** SK1. A skill the person picked, already read, cut and put under its lines by the server; the brief carries `text` as it is. */
export interface SkillBlockFacts {
  readonly id: string;
  readonly name: string;
  /** changes when the skill's files do: a skill the process has already read is not sent again until it changes */
  readonly hash: string;
  readonly text: string;
}

export interface TurnContext {
  readonly screen: ScreenFacts;
  readonly capabilities: Capabilities;
  readonly services: Services;
  readonly lead: LeadWindow;
  /** what is on stage right now, with the look, the open scene and the styles defined so far */
  readonly stage: StageBase;
  /** earlier turns, oldest first */
  readonly history: readonly TurnMemory[];
  /** taps the painter reported since the previous turn began */
  readonly heard: readonly BackEventRecord[];
  /** documents the brain is to be given with this message; absent means none */
  readonly documents?: readonly DocumentFacts[];
  /** links in this turn's message that could not be read */
  readonly unread?: readonly UnreadFacts[];
  /** the few techniques that fit this turn's message, best first; absent or empty means none fitted, or the library had nothing */
  readonly techniques?: readonly TechniqueCard[];
  /** SK1. The skills the person held for this message, as blocks the server made (the lines that say draw it, and the text); absent or empty: none */
  readonly skills?: readonly SkillBlockFacts[];
  /** tables a chart can draw by reference; absent means none */
  readonly data?: readonly DataFacts[];
  /**
   * v2.1. What the user asked to hold from now on ("add a visual to every reply"), in their words, oldest first. The brain records
   * one with a `standing | …` line; the conductor keeps it for the conversation and gives it back in every later brief, and the
   * look checks the draft against it. Absent or empty: none.
   */
  readonly standing?: readonly string[];
  /**
   * v3 (2.11). The conversation's document and where the person is in it, folded from the log. The brief makes its DOCUMENT and HERE
   * blocks from it (`L/teach.ts`), so a fresh process knows the sheet, which questions are written, and her place and tries. Absent: the
   * conversation has no document.
   */
  readonly document?: DocumentContext;
  /** v2.1. A returning conversation: a short account of what was said and answered before this page's session began (words only, within a budget). Absent: none. */
  readonly earlier?: string;
  /**
   * SA3. The `EYES` block (`digestOf`): what the eyes saw and the person did since the brain last wrote, urgent first, in six lines. When it is
   * given it takes the place of the sight lines under HOW YOUR LAST ANSWER LANDED. Absent: the older sight lines are printed as before.
   */
  readonly eyes?: string | null;
  /** SA4. The canvas tools are on for this conversation: the brief says so in one line */
  readonly canvas?: boolean;
  /** The drawing memory's index: a row for each of the newest versions of the drawing (the turn, what was asked, what stood in it). Absent: nothing is remembered. */
  readonly drawingMemory?: readonly MemoryRow[];
  /** What the critic found broken in an answer that no repair could mend (a newer turn had come, or the repair failed), and that is still on stage: the brief names the ids so the brain mends them when it next touches the drawing. Absent: none. */
  readonly owed?: readonly OwedFinding[];
}

/** One version of the drawing the conversation remembers: the turn that made it, the words that asked, how many parts, and the ones at the top. */
export interface MemoryRow {
  readonly turn: string;
  readonly said: string;
  readonly parts: number;
  readonly roots: readonly string[];
  /** the ids inside its groups, in the order they were made */
  readonly inside: readonly string[];
  /** it is the one on the canvas now */
  readonly current: boolean;
}

/** The document a conversation has made, and what the person has done in it. */
export interface DocumentContext {
  readonly document: Document;
  readonly state: DocState;
}

/** v2.1. The most standing asks a conversation holds, and the most characters of each; the oldest goes when a seventh comes. */
export const STANDING_LIMITS = { asks: 6, chars: 140 } as const;

/** What a relay agent can know about the two clocks between its calls. */
export interface RelayClock {
  /** where the next line will start; computed by the server from the lines accepted so far */
  readonly pen: number;
  /** the last playhead the painter reported, or null before the first report */
  readonly playhead: number | null;
  /** pen minus playhead: how far ahead of the audience the brain is */
  readonly lead: number | null;
  readonly state: ClockState | null;
  /** milliseconds since the painter last reported */
  readonly reportedMsAgo: number | null;
}

export interface RelayClaim {
  readonly turn: string;
  readonly session: string;
  readonly input: TurnInput;
  readonly context: TurnContext;
  /** `context` and `input` rendered as the text an LLM brain would be given */
  readonly brief: string;
  /** where to POST lines, end the turn, read events, read the language guide, and (when there is one) GET a picture of how the previous turn landed */
  readonly links: { readonly lines: string; readonly end: string; readonly events: string; readonly guide: string; readonly snapshot: string | null };
}

export interface RelayRejected {
  /** 1-based line number within the posted body */
  readonly lineNumber: number;
  readonly raw: string;
  readonly issues: readonly Issue[];
}

export interface RelayAppendResponse {
  readonly accepted: number;
  /** lines that were dropped, and lines that were kept with a repair */
  readonly rejected: readonly RelayRejected[];
  readonly warnings: readonly RelayRejected[];
  readonly clock: RelayClock;
  /** back-channel events since the cursor this turn last saw */
  readonly events: readonly BackEventRecord[];
  readonly cursor: number;
  readonly ended: boolean;
}

export interface RelayEventsResponse {
  readonly events: readonly BackEventRecord[];
  readonly cursor: number;
  readonly clock: RelayClock;
  /** false once the user has interrupted or the turn has ended; stop writing */
  readonly open: boolean;
}

export interface RelayStatus {
  readonly pending: readonly { readonly turn: string; readonly session: string; readonly input: TurnInput; readonly waitingMs: number }[];
  readonly claimed: readonly { readonly turn: string; readonly session: string; readonly idleMs: number }[];
}
