// The chat shell's thread, folded from a session log. Pure: records in, a view out. Nothing here reads a disk or writes one.

import { CONVERSATION_API } from '@conduit/language';
import type { ConversationReply, ConversationSummary, ConversationTurn, ConversationView, ShownItem, TurnInput } from '@conduit/language';
import type { SessionRecord } from './session-log';

type Of<T extends SessionRecord['type']> = Extract<SessionRecord, { type: T }>;

/** A log file's stem: `<YYYYMMDD-HHMMSS>-<session>`. The only shape of id the routes take. */
export const CONVERSATION_ID = /^\d{8}-\d{6}-[A-Za-z0-9_-]{1,64}$/;

const TITLE_CHARS = 80;
export const UNTITLED = 'New conversation';

/** `say x10 choice | make it stormy`: a line of words the stage offers as a tap. */
const CHOICE_LINE = /^say\b[^|]*\bchoice\b[^|]*\|\s*(.+)$/;
const SAY_LINE = /^say\b[^|]*\|\s*(.+)$/;

export function titleOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one === '') return UNTITLED;
  return one.length > TITLE_CHARS ? `${one.slice(0, TITLE_CHARS - 1).trimEnd()}…` : one;
}

function saidOf(input: TurnInput): string {
  switch (input.kind) {
    case 'prompt':
    case 'tap':
    case 'act':
      return input.text;
    case 'demo':
      return `Played the demo ${input.script}`;
    case 'script':
      return 'Played a script';
    case 'refine':
      return 'Keep making it better';
  }
}

/** What the person said first, which names the conversation. */
export function firstWords(records: readonly SessionRecord[]): string {
  for (const record of records) if (record.type === 'turn' && record.input.kind === 'prompt') return record.input.text;
  return '';
}

function replyOf(lines: readonly string[], shown: readonly ShownItem[] | null): ConversationReply {
  const choices = lines.flatMap((line) => {
    const found = CHOICE_LINE.exec(line);
    return found?.[1] === undefined ? [] : [found[1].trim()];
  });
  const offered = new Set(choices);
  const keep = (list: readonly string[]): string[] => [...new Set(list.map((text) => text.trim()).filter((text) => text !== '' && !offered.has(text)))];
  if (shown !== null) {
    const words = keep(shown.filter((item) => item.kind === 'text' && !item.struck && item.part !== true).map((item) => item.text));
    const drew = [...new Set(shown.filter((item) => item.kind !== 'text' && !item.struck && item.part !== true).map((item) => item.kind as string))];
    return { words, choices: [...offered], drew };
  }
  // The painter never reported (the page was closed mid-answer): what the brain wrote is the nearest thing to what was said.
  const words = keep(lines.flatMap((line) => (CHOICE_LINE.test(line) ? [] : [SAY_LINE.exec(line)?.[1] ?? ''])));
  return { words, choices: [...offered], drew: [] };
}

export function summaryOf(id: string, records: readonly SessionRecord[], updated: string): ConversationSummary {
  const opened = records.find((record): record is Of<'session'> => record.type === 'session');
  return {
    id,
    session: opened?.session ?? id.slice(16),
    started: opened?.started ?? updated,
    updated,
    title: titleOf(firstWords(records)),
    turns: records.filter((record) => record.type === 'turn').length,
  };
}

export function foldConversation(id: string, records: readonly SessionRecord[], updated: string): ConversationView {
  const turns = new Map<string, { open: Of<'turn'>; lines: string[]; report: Of<'report'> | null; snapshot: Of<'snapshot'> | null; end: Of<'end'> | null }>();
  for (const record of records) {
    if (record.type === 'turn') {
      turns.set(record.turn, { open: record, lines: [], report: null, snapshot: null, end: null });
      continue;
    }
    if (!('turn' in record) || record.turn === null) continue;
    const held = turns.get(record.turn);
    if (held === undefined) continue;
    if (record.type === 'line') held.lines.push(record.text);
    else if (record.type === 'report') held.report = record;
    else if (record.type === 'snapshot') held.snapshot = record;
    else if (record.type === 'end') held.end = record;
  }
  const folded: ConversationTurn[] = [...turns.values()].map(({ open, lines, report, snapshot, end }) => ({
    turn: open.turn,
    kind: open.input.kind,
    said: saidOf(open.input),
    photos: open.input.kind === 'prompt' ? (open.input.images ?? []).map((photo) => ({ id: photo, url: CONVERSATION_API.photo(id, photo) })) : [],
    reply: replyOf(lines, report?.report.shown ?? null),
    lines,
    still: snapshot === null ? null : CONVERSATION_API.still(id, open.turn),
    end: end?.reason ?? null,
    message: end?.message ?? null,
  }));
  return { summary: summaryOf(id, records, updated), turns: folded };
}
