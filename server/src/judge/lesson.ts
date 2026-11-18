// The second check of what was written ahead: a cheap model, asked cold, whether a part's answers are right and its words
// are right for a young learner. It is the judge's own ask (`ask.ts`): a separate process, no tools, no settings, a pinned model and effort,
// and it is shown only the part (its words, its choices, its accepted answers), never how it was written. It is the net under the exact
// checks of `domain/verify.ts`, not instead of them: where the solver recomputed a sum, the solver has the last word.

import { askObject } from './ask';
import type { JudgeSettings, JudgeUsage } from './ask';
import type { ModelProblem, ModelVerdict } from '../domain/verify';

export const LESSON_SYSTEM = `You check pages of a children's lesson before a child of about six to eight sees them. Each page is one question with several ways of working it: small steps, and asks (a question with its accepted answers, and sometimes three choices to tap). You have not seen how it was written, and you must not trust the accepted answers.

For every page:
1. Work the whole question out yourself first, in your head, from its own words.
2. For every ask, work out what a child should answer from the words, the numbers in the picture lines, and what came before it. Compare with ACCEPTED: every accepted answer must be right, and a pick must hold exactly one right choice.
3. Read every step and hint as the child will: is anything said untrue? Is the wording right for her: short, plain, words she knows, never "wrong"?

Report problems only:
- "answer": an accepted answer is wrong, the choices have no right one or two, or the ask cannot be answered from what is on the page before it.
- "fact": a step or a hint says something untrue about the maths.
- "wording": a child of that age would not follow it. blocking is true only when she would be misled or lost, not for a style you would change.

Reply with JSON only, no other text:
{"questions":[{"id":"<the question's id>","answer":"<your own answer to the whole question, short>","problems":[{"way":"<way id>","ask":"<ask id>"|null,"kind":"answer"|"fact"|"wording","blocking":true|false,"right":"<what you say the answer is>"|null,"why":"<one short sentence>"}]}]}
A page with nothing wrong has "problems":[]. Include every question given, in order.`;

export interface LessonCheckInput {
  /** each question as `lessonText` makes it */
  readonly pages: readonly { readonly id: string; readonly text: string }[];
}

export interface LessonCheckResult {
  /** a verdict for each question the model answered, by id */
  readonly verdicts: ReadonlyMap<string, ModelVerdict>;
  readonly usage: JudgeUsage;
  readonly failure: string | null;
}

const KINDS = ['answer', 'fact', 'wording'] as const;

function text(value: unknown, most = 240): string | null {
  if (typeof value !== 'string') return null;
  const plain = value.trim().replace(/\s+/g, ' ');
  return plain === '' || /^(none|null|n\/a)$/i.test(plain) ? null : plain.slice(0, most);
}

function problemOf(value: unknown): ModelProblem | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const kind = KINDS.find((candidate) => candidate === item['kind']);
  if (kind === undefined) return null;
  return {
    way: text(item['way'], 80),
    ask: text(item['ask'], 80),
    kind,
    // an answer or a fact that is wrong always blocks; a wording problem blocks only when it says so
    blocking: kind === 'wording' ? item['blocking'] === true : true,
    right: text(item['right'], 80),
    why: text(item['why']) ?? 'no reason given',
  };
}

/** Parses the model's reply: a verdict for each question it named. A question it left out has none, and is not verified by it. */
export function verdictsOf(object: Record<string, unknown>): Map<string, ModelVerdict> {
  const out = new Map<string, ModelVerdict>();
  const questions = object['questions'];
  if (!Array.isArray(questions)) return out;
  for (const question of questions as unknown[]) {
    if (typeof question !== 'object' || question === null) continue;
    const item = question as Record<string, unknown>;
    const id = text(item['id'], 120);
    if (id === null) continue;
    const problems = Array.isArray(item['problems']) ? (item['problems'] as unknown[]).flatMap((problem) => problemOf(problem) ?? []) : [];
    out.set(id, { answer: text(item['answer'], 120), problems });
  }
  return out;
}

export async function checkLessons(input: LessonCheckInput, settings: JudgeSettings, signal: AbortSignal): Promise<LessonCheckResult> {
  const body = input.pages.map((page) => page.text).join('\n\n');
  const got = await askObject(LESSON_SYSTEM, `${input.pages.length} page${input.pages.length === 1 ? '' : 's'} to check:\n\n${body}`, [], settings, signal);
  if (got.object === null) {
    const why = got.failure !== null ? `the check failed: ${got.failure}` : `the check did not answer in JSON${got.stderr === '' ? '' : ` (${got.stderr.trim()})`}: ${got.reply.slice(0, 120)}`;
    return { verdicts: new Map(), usage: got.usage, failure: why };
  }
  return { verdicts: verdictsOf(got.object), usage: got.usage, failure: null };
}
