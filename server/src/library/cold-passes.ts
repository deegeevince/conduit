// The two cold passes a technique goes through before it is written to the
// library. "Cold" means a fresh model session that has seen nothing of the
// conversation or the repository: it has only the technique's text, which is
// all a reader of the library will ever have.
//
//   1. The edit pass reads it against the tree's rules (what is true now, no
//      history, no dates or change numbers, one thing per block, a summary
//      that says when it applies) and names what breaks them.
//   2. The reader pass is asked to say, from the text alone, when it would use
//      the technique, when not, and what its example teaches; what it cannot
//      say is a confusion a real reader will have too.
//
// Neither pass rewrites anything. A pass that finds problems stops the push and
// says what they are; the author changes the file. Both are small: sonnet, low
// effort, one prompt each, on the owner's subscription (no API key).

import { runClaude } from '../brains/claude-cli/process';
import { failureOf, parseStreamLine, textDeltaOf } from '../brains/claude-cli/stream-json';

export interface ColdAnswer {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Asks a cold session one question; the answer is its text. Replaceable so that a run can be rehearsed with no model. */
export type Ask = (system: string, user: string, signal: AbortSignal) => Promise<string>;

export function claudeAsk(bin: string, model: string): Ask {
  return async (systemPrompt, userMessage, signal) => {
    let text = '';
    let result = '';
    for await (const raw of runClaude({ bin, model, effort: 'low', systemPrompt, userMessage }, signal)) {
      const event = parseStreamLine(raw);
      if (event === null) continue;
      const delta = textDeltaOf(event);
      if (delta !== null) text += delta;
      if (event.type === 'result') {
        const failure = failureOf(event);
        if (failure !== null) throw new Error(failure);
        const finished = (event as unknown as Record<string, unknown>)['result'];
        if (typeof finished === 'string') result = finished;
      }
    }
    if (signal.aborted) throw new Error('the pass was cancelled or timed out');
    return (text === '' ? result : text).trim();
  };
}

const EDIT_SYSTEM = `You check one technique block for a library, as a strict editor. A technique is a short recipe a drawing assistant reads before answering. Judge only the text you are given.

Rules a block must keep:
- It says what is true now, in the present tense. No history ("previously", "used to", "no longer", "we changed"), no dates, no change or issue numbers.
- It holds one technique. If it is really two, say so.
- Its summary is written as the words a user would use, so that a message can be matched to it.
- "Use it when" and "Not when" do not contradict each other or the example.
- The example is a short worked case; it does not depend on facts outside the text.
- No secret, key or personal detail.

Answer with one JSON object and nothing else: {"problems": ["one sentence each, quoting the words at fault"]}. An empty list means it may be written.`;

const READER_SYSTEM = `You are a cold reader of a technique block from a library: you know nothing but the text. Say, from the text alone, three things: when you would use it, when you would not, and what its example teaches. Then list anything you could not tell, or that could be read two ways.

Answer with one JSON object and nothing else: {"use": "...", "not": "...", "teaches": "...", "confusions": ["one sentence each"]}. An empty confusions list means the text stood on its own.`;

function jsonOf(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

export async function editPass(ask: Ask, text: string, signal: AbortSignal): Promise<ColdAnswer> {
  const answer = jsonOf(await ask(EDIT_SYSTEM, text, signal));
  if (answer === null) return { ok: false, problems: ['the edit pass did not answer in the form asked for'] };
  const problems = listOf(answer['problems']);
  return { ok: problems.length === 0, problems };
}

export async function readerPass(ask: Ask, text: string, signal: AbortSignal): Promise<ColdAnswer & { readonly understood: string }> {
  const answer = jsonOf(await ask(READER_SYSTEM, text, signal));
  if (answer === null) return { ok: false, problems: ['the reader pass did not answer in the form asked for'], understood: '' };
  const confusions = listOf(answer['confusions']);
  const understood = [answer['use'], answer['not'], answer['teaches']].filter((part): part is string => typeof part === 'string').join(' | ');
  return { ok: confusions.length === 0, problems: confusions, understood };
}
