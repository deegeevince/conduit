// Whether what an ask accepts can be right for the sum its own words ask. An `ask` accepts the ways of writing ONE answer; a step of the working
// (the ones digit of a column sum, a carry) is no answer to `3486 + 2795 = __`, and an ask that accepts one makes a wrong answer right and
// a hint that names the step a spoiler. This reads the ask's words as the checker reads a lesson's (`solveQuestion`) and says which accepted
// answers are provably not the answer. Nothing is claimed of words that are not a plain sum.

import { answerText, isText, parseAnswer, sameAnswer, askUnit } from './answer';
import type { Answer } from './answer';
import { solveQuestion } from './solve';

export type Cmp = 'same' | 'different' | 'unknown';

export function compareAccepted(accepted: string, answers: readonly Answer[], unit: string | null): Cmp {
  const clockAnswer = answers.some((a) => !Array.isArray(a) && !isText(a) && (a as { t: string }).t === 'clock');
  // `9.20` for 9:20 is how a child writes a time
  const written = clockAnswer && /^\s*\d{1,2}\.\d{2}\s*$/.test(accepted) ? accepted.replace('.', ':') : accepted;
  const parsed = parseAnswer(written);
  if (parsed === null) return 'unknown';
  const u = askUnit(unit);
  if (answers.some((a) => sameAnswer(parsed, a, u))) return 'same';
  const parsedText = isText(parsed);
  if (parsedText !== answers.every(isText)) return 'unknown';
  return 'different';
}

export interface Contradicted {
  /** what the sum comes to, as text */
  readonly computed: string;
  /** the accepted answers that are not it */
  readonly wrong: readonly string[];
}

/**
 * The accepted answers that are not what the ask's own words come to, when those words are a plain sum (`3486 + 2795 = __`, `What is 12 x 7?`) read with no
 * doubt and the ask accepts that answer too; otherwise null. It never removes the only answer an ask has: a sum the brain got wrong is not this one's to mend.
 */
export function contradicted(prompt: string, accepted: readonly string[], unit: string | null): Contradicted | null {
  // `1 000` (a space for the thousands) is read by the sum reader as two numbers: it is not trusted with these
  if (/\d\s\d{3}\b/.test(prompt)) return null;
  const solved = solveQuestion(prompt);
  if (solved === null || !solved.sure || solved.kind !== 'sum') return null;
  const verdicts = accepted.map((answer) => compareAccepted(answer, solved.answers, unit));
  if (!verdicts.includes('same')) return null;
  const wrong = accepted.filter((_, index) => verdicts[index] === 'different');
  const first = solved.answers[0];
  return wrong.length === 0 || first === undefined ? null : { computed: answerText(first), wrong };
}
