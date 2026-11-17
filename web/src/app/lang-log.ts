// "Show the language": what the page was told, line by line, kept so a pane can show it and a film can replay it.
//
// The model writes Series; the page reads each line the moment its newline arrives and draws it. This log is that reading as data: for each
// line (or each thing dropped) the turn it belongs to, its words as they were handed over, what the normaliser had to say, and the playhead of
// the turn clock when it arrived (the same `floor` a recording keeps), so a film can show the pane's lines at the rhythm they came. It holds
// nothing the painter does not already hold, except what is dropped, which the painter never hears of.
//
// Token by token: the link carries whole lines (`line` events) and, for this pane alone, the unfinished line as far as it has got (`typing`,
// about 20 a second). The unfinished line is kept here as `live`, never as an entry: the painter hears nothing of it, a film does not
// record it, and the line event that ends it (or a reject, or the turn's end) takes it away.

import { parseLine } from '@conduit/language';
import type { Issue } from '@conduit/language';

export interface LangEntry {
  readonly turn: string;
  readonly seq: number;
  /** a line the page took and drew, or one it dropped (the words as the brain wrote them) */
  readonly kind: 'line' | 'dropped';
  readonly text: string;
  /** the verb and the id the line names (`say c1 …`), for the highlight between a line and what it made; null when it names none */
  readonly verb: string | null;
  readonly id: string | null;
  /** what the normaliser or the painter said of the line: shown quietly under it */
  readonly issues: readonly Issue[];
  /** unused by the page (0); a film takes each line's arrival from its recording */
  readonly playhead: number;
}

/** The turns kept; the log of a turn is a few hundred short lines. */
const KEPT_TURNS = 24;
const WORDS_LIMIT = 240;

export function entryNote(entry: LangEntry): string | null {
  const first = entry.issues[0];
  if (first === undefined) return null;
  const more = entry.issues.length > 1 ? ` (+${entry.issues.length - 1})` : '';
  return `${entry.kind === 'dropped' ? 'dropped' : 'repaired'}: ${first.message}${more}`;
}

/**
 * Whether a quiet note ("repaired: …", "dropped: …") is kept out of the pane, on the page and in a film alike: the owner reads the language, not the
 * page's housekeeping about it. The one predicate both ask.
 */
export function hiddenNote(note: string): boolean {
  return /^(repaired|dropped):/.test(note);
}

/** The note the pane shows under a line: `entryNote`, unless it is one the pane hides. */
export function shownNote(entry: LangEntry): string | null {
  const note = entryNote(entry);
  return note === null || hiddenNote(note) ? null : note;
}

export interface LangLog {
  /** whether the pane is shown: the one switch the [+] menu, `/lines` and the exporter read */
  readonly on: boolean;
  set(on: boolean): void;
  /** a turn opened: the pane starts over */
  openTurn(turn: string): void;
  line(turn: string, seq: number, text: string, issues: readonly Issue[], playhead: number): void;
  dropped(turn: string, raw: string, issues: readonly Issue[], playhead: number): void;
  /** the line being written right now, as far as it has got, or null */
  readonly live: { readonly turn: string; readonly text: string } | null;
  typing(turn: string, text: string): void;
  /** the turn is over: nothing is being written */
  settle(turn: string): void;
  /** the turn the pane is showing: the latest opened */
  readonly turn: string | null;
  entriesOf(turn: string): readonly LangEntry[];
  /** hears a change in the switch or in the entries; returns the way to stop hearing */
  onChange(listener: () => void): () => void;
}

export function createLangLog(start: boolean): LangLog {
  const turns = new Map<string, LangEntry[]>();
  const listeners = new Set<() => void>();
  let on = start;
  let current: string | null = null;
  let live: { readonly turn: string; readonly text: string } | null = null;
  const tell = (): void => {
    for (const listener of listeners) listener();
  };
  const listOf = (turn: string): LangEntry[] => {
    let list = turns.get(turn);
    if (list === undefined) {
      list = [];
      turns.set(turn, list);
      while (turns.size > KEPT_TURNS) turns.delete(turns.keys().next().value ?? '');
    }
    return list;
  };
  return {
    get on() {
      return on;
    },
    set(next) {
      if (next === on) return;
      on = next;
      tell();
    },
    get turn() {
      return current;
    },
    get live() {
      return live;
    },
    typing(turn, text) {
      if (current !== null && turn !== current) return;
      live = text === '' ? null : { turn, text };
      tell();
    },
    settle(turn) {
      if (live === null || live.turn !== turn) return;
      live = null;
      tell();
    },
    openTurn(turn) {
      live = null;
      current = turn;
      listOf(turn);
      tell();
    },
    line(turn, seq, text, issues, playhead) {
      const parsed = parseLine(text);
      const line = parsed.kind === 'line' ? parsed.line : null;
      const id = line !== null && 'id' in line && typeof line.id === 'string' ? line.id : null;
      if (current === null || turn !== current) current = turn;
      live = null;
      listOf(turn).push({ turn, seq, kind: 'line', text, verb: line?.verb ?? null, id, issues, playhead });
      tell();
    },
    dropped(turn, raw, issues, playhead) {
      if (current === null || turn !== current) current = turn;
      live = null;
      const text = raw.length > WORDS_LIMIT ? `${raw.slice(0, WORDS_LIMIT - 1)}…` : raw;
      listOf(turn).push({ turn, seq: -1, kind: 'dropped', text, verb: null, id: null, issues, playhead });
      tell();
    },
    entriesOf: (turn) => turns.get(turn) ?? [],
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
