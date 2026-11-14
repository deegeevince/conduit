// The chat shell's thread, folded from a session log. Pure: records in, a view out. Nothing here reads a disk or writes one.

import { CONVERSATION_API } from '@conduit/language';
import type { ConversationReply, ConversationSummary, ConversationTurn, ConversationView, ShownItem, TraceTool, TurnInput, TurnTrace } from '@conduit/language';
import { EMPTY_TRACE } from '@conduit/language';
import { redactSecrets } from './agent';
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
  // A conversation taken up again is written by a later session: that is the one a page holding it is asked about.
  const resumed = records.findLast((record): record is Of<'continued'> => record.type === 'continued');
  return {
    id,
    session: resumed?.session ?? opened?.session ?? id.slice(16),
    started: opened?.started ?? updated,
    updated,
    title: titleOf(firstWords(records)),
    turns: records.filter((record) => record.type === 'turn').length,
  };
}

/** How a turn was made, from the records it left. A brief is told by its form and size only: its text holds the system prompt. */
export function traceOf(open: Of<'turn'>, records: readonly SessionRecord[]): TurnTrace {
  const at = (record: SessionRecord): number => Math.max(0, record.at - open.at);
  const tools = new Map<string, TraceTool>();
  let trace: TurnTrace = { ...EMPTY_TRACE, brain: { id: open.brain, model: open.model ?? null, effort: open.effort ?? null } };
  const add = <K extends keyof TurnTrace>(key: K, value: TurnTrace[K] extends readonly (infer T)[] ? T : never): void => {
    trace = { ...trace, [key]: [...(trace[key] as readonly unknown[]), value] };
  };
  for (const record of records) {
    if (!('turn' in record) || record.turn !== open.turn) continue;
    switch (record.type) {
      case 'brief':
        add('briefs', { at: at(record), pass: record.pass ?? 1, form: record.form, chars: record.text.length });
        break;
      case 'line':
        add('lines', { at: at(record), text: record.text, pass: record.pass ?? 1 });
        break;
      case 'reject':
        add('rejects', { at: at(record), raw: redactSecrets(record.raw, 400), why: record.issues.map((issue) => issue.message) });
        break;
      case 'tool':
        add('tools', { id: `tool-${trace.tools.length}`, at: at(record), tool: record.tool, summary: redactSecrets(record.target ?? '', 160), state: 'done', ms: null });
        break;
      case 'activity': {
        const held = tools.get(record.id);
        const next: TraceTool = { id: record.id, at: held?.at ?? at(record), tool: record.tool, summary: redactSecrets(record.summary, 160), state: record.state, ms: record.ms ?? held?.ms ?? null };
        tools.set(record.id, next);
        trace = { ...trace, tools: [...trace.tools.filter((tool) => tool.id !== record.id), next].sort((a, b) => a.at - b.at) };
        break;
      }
      case 'fetch':
        add('readings', { at: at(record), label: safeHost(record.finalUrl ?? record.url), state: record.outcome === 'ok' ? 'done' : 'failed', message: record.reason === null ? null : redactSecrets(record.reason, 160) });
        break;
      case 'pass':
        add('passes', { at: at(record), pass: record.pass, state: record.state, reason: record.reason });
        break;
      case 'fix':
        add('fixes', { at: at(record), pass: record.pass, form: record.form, lines: record.lines, shown: record.shown, why: record.why });
        break;
      case 'permission':
        add('asks', { at: at(record), tool: record.tool, summary: redactSecrets(record.summary, 160), risk: record.risk, allow: record.allow });
        break;
      case 'critic':
        trace = {
          ...trace,
          critic: {
            at: at(record),
            coherence: record.finding.coherence,
            readable: record.finding.readable,
            asked: record.finding.asked,
            problems: record.finding.problems.map((problem) => ({ what: problem.what, weight: problem.weight })),
            suggestions: record.finding.suggestions,
            model: record.finding.model,
            costUsd: record.finding.costUsd,
          },
        };
        break;
      case 'usage':
        add('usage', {
          pass: record.pass ?? 1,
          inputTokens: record.usage.inputTokens,
          cacheReadTokens: record.usage.cacheReadTokens,
          cacheWriteTokens: record.usage.cacheWriteTokens,
          outputTokens: record.usage.outputTokens,
          thinkingTokens: record.usage.thinkingTokens,
          costUsd: record.usage.costUsd,
          firstTextMs: record.usage.firstTextMs,
          totalMs: record.usage.totalMs,
        });
        break;
      case 'review':
        trace = { ...trace, review: { result: record.outcome.result, passes: record.outcome.passes, why: record.outcome.why } };
        break;
      case 'end':
        trace = { ...trace, end: { at: at(record), reason: record.reason, message: record.message === null ? null : redactSecrets(record.message, 300) } };
        break;
      default:
        break;
    }
  }
  return trace;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'a page';
  }
}

export function foldConversation(id: string, records: readonly SessionRecord[], updated: string): ConversationView {
  const turns = new Map<string, { open: Of<'turn'>; lines: string[]; report: Of<'report'> | null; snapshot: Of<'snapshot'> | null; end: Of<'end'> | null; continued: boolean }>();
  let resumed = false;
  for (const record of records) {
    if (record.type === 'continued') {
      resumed = true;
      continue;
    }
    if (record.type === 'turn') {
      turns.set(record.turn, { open: record, lines: [], report: null, snapshot: null, end: null, continued: resumed });
      resumed = false;
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
  const folded: ConversationTurn[] = [...turns.values()].map(({ open, lines, report, snapshot, end, continued }) => ({
    turn: open.turn,
    ...(continued ? { continued: true as const } : {}),
    kind: open.input.kind,
    said: saidOf(open.input),
    photos: open.input.kind === 'prompt' ? (open.input.images ?? []).map((photo) => ({ id: photo, url: CONVERSATION_API.photo(id, photo) })) : [],
    voice: open.input.kind === 'prompt' && (open.input.voice?.length ?? 0) > 0,
    inked: open.input.kind === 'prompt' && open.input.marks !== undefined,
    reply: replyOf(lines, report?.report.shown ?? null),
    lines,
    still: snapshot === null ? null : CONVERSATION_API.still(id, open.turn),
    end: end?.reason ?? null,
    message: end?.message ?? null,
    trace: traceOf(open, records),
  }));
  return { summary: summaryOf(id, records, updated), turns: folded };
}

/** The most the brain is told of an older conversation: about 3,000 tokens, counted at four characters to the token. */
export const EARLIER_BUDGET_CHARS = 12_000;
const SAID_CHARS = 600;
const REPLY_CHARS = 900;

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/**
 * What the brain is told of a conversation it did not have: each turn's words and the reply's words, oldest first, newest kept when
 * the budget is short. Only what the person and the reply said: never the system prompt, a brief, a line of Series or a trace.
 */
export function earlierText(view: ConversationView, budget = EARLIER_BUDGET_CHARS): string {
  const entries = view.turns.flatMap((turn) => {
    if (turn.kind === 'demo' || turn.kind === 'script') return [];
    const said = clip(turn.said, SAID_CHARS);
    const words = clip(turn.reply.words.join(' '), REPLY_CHARS);
    const drew = turn.reply.drew.length === 0 ? '' : ` [it also drew: ${turn.reply.drew.join(', ')}]`;
    return [`The user: ${said}\nYou: ${words === '' ? '(a picture, no words)' : words}${drew}`];
  });
  const kept: string[] = [];
  let used = 0;
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at] as string;
    if (used + entry.length + 2 > budget) break;
    kept.unshift(entry);
    used += entry.length + 2;
  }
  const left = entries.length - kept.length;
  return `${left > 0 ? `(${left} earlier ${left === 1 ? 'turn' : 'turns'} left out)\n\n` : ''}${kept.join('\n\n')}`;
}

/** The highest photo number a log holds (`u4` is 4): the photos of a conversation taken up again are named above it, so no id is two photos. */
export function highestPhoto(records: readonly SessionRecord[]): number {
  let top = 0;
  for (const record of records) if (record.type === 'upload') top = Math.max(top, Number(/^u(\d+)$/.exec(record.id)?.[1] ?? 0));
  return top;
}

/** The highest turn number a log holds (`t12` is 12), so that a session writing on keeps its ids above it. */
export function highestTurn(records: readonly SessionRecord[]): number {
  let top = 0;
  for (const record of records) if (record.type === 'turn') top = Math.max(top, Number(/^t(\d+)$/.exec(record.turn)?.[1] ?? 0));
  return top;
}
