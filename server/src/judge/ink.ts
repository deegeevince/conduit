// What a hand wrote, read back as words (the writing area of an ask): a cheap model is shown the picture of the ink and asked only to
// TRANSCRIBE it, line by line, exactly as written. It is not asked whether it is right: the document's own matcher (`accepts`, and for
// `check=working` the exact maths checker) decides that, so a wrong answer is never helped to look right and a right one is never read as wrong by a
// model's opinion. A child's numbers may be big and unjoined, a seven may have a bar, a nought may not close; the reader says `unclear` rather than guess.

import { matchAnswer } from '@conduit/language';
import { askObject } from './ask';
import type { JudgeSettings, JudgeUsage, Picture } from './ask';

export const INK_SYSTEM = `You read a young child's handwriting, from one picture of a page area where she wrote her answer or her working with a pen. Transcribe exactly what is written, and nothing else.

- One entry in "lines" for each written line, top to bottom, left to right, as she wrote it: digits, signs (+ - × ÷ =), units, and words. Write × for a times sign and ÷ for a divide sign. Keep her own mistakes: if she wrote 14 - 5 = 8, write that, never the right sum.
- A picture she drew (circles, ticks, dots, a number line, groups) is not a line of writing: do not describe it, but still read any numbers she wrote beside it.
- Do not solve anything and do not correct anything in "lines". You are given the question only so that a smudge can be read in its light (a number that looks like 1 or 7); never copy numbers from the question into "lines" unless she wrote them. For "sees" only, you are also told the answers the page accepts.
- If you cannot read the writing with confidence, or nothing is written, set "unclear": true and put your best reading in "lines" (an empty list for nothing).

- "sees": ONE short kind sentence for her, at most 14 words, about what she did (for example "You counted back five tens, so you are nearly there."). Say what you see in her working or where she could look, never that it is wrong. Never say the answer, never write any number that is the answer, and never hint at it ("it is bigger than 8"). If her working is right, or you cannot tell what she did, or only the answer is written with no working, use "".

Reply with JSON only, no other text: {"lines":["..."],"unclear":false,"sees":""}`;

export interface InkReading {
  /** each written line, as she wrote it */
  readonly lines: readonly string[];
  /** the model could not read it with confidence (or nothing was written) */
  readonly unclear: boolean;
  /** one kind sentence about what she did, as the reader wrote it; the caller checks it holds no answer before it is shown */
  readonly sees: string | null;
  readonly usage: JudgeUsage;
  readonly failure: string | null;
}

export async function readInk(input: { readonly picture: Picture; readonly question: string; readonly ask: string; readonly accepted: readonly string[] }, settings: JudgeSettings, signal: AbortSignal): Promise<InkReading> {
  const text = `The question she is answering: ${input.question === '' ? '(not given)' : input.question}\nWhat is asked of her: ${input.ask}\nThe answers the page accepts (for \"sees\" only, never to be said): ${input.accepted.join(' | ')}\n\nThe picture is what she wrote. Transcribe it.`;
  const got = await askObject(INK_SYSTEM, text, [input.picture], settings, signal);
  if (got.object === null) return { lines: [], unclear: true, sees: null, usage: got.usage, failure: got.failure !== null ? `the reader failed: ${got.failure}` : `the reader did not answer in JSON: ${got.reply.slice(0, 120)}` };
  const raw = got.object['lines'];
  const lines = (Array.isArray(raw) ? raw : [])
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter((line) => line !== '')
    .slice(0, 12);
  const said = typeof got.object['sees'] === 'string' ? got.object['sees'].replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return { lines, unclear: got.object['unclear'] === true || lines.length === 0, sees: said === '' ? null : said, usage: got.usage, failure: null };
}

/**
 * Whether a sentence for her holds an answer the ask accepts: any number or word in it that the matcher takes for one (`11`, `eleven`, `£1.50`), or two
 * words together (`one hundred`). The reader is told not to say it; this is the check that does not trust the reader. A sentence that fails is not shown.
 */
export function holdsAnswer(sentence: string, accepted: readonly string[], unit: string | null): boolean {
  const tokens = sentence.match(/[£$€]?\d[\d,]*(?:\.\d+)?|[A-Za-z]+/g) ?? [];
  const candidates = [...tokens, ...tokens.slice(1).map((token, i) => `${tokens[i]} ${token}`)];
  return accepted.some((answer) => candidates.some((candidate) => matchAnswer(answer, candidate, unit)));
}
