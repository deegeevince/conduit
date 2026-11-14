// An ask with `check=working`: the learner's working, transcribed from her ink (or typed), is checked by the step checker instead of a lone answer
// being compared. Her working is right when every step she wrote is right and it ends on an answer the ask accepts.
//
// `said` is safe to show her: it never holds an answer the ask accepts (that would be the answer, handed over before she has it). `detail` is
// for the brain and the parent's view: it says exactly what is wrong and what the step should have been.

import { agrees, parseAnswer } from './answer';
import type { Answer } from './answer';
import { checkSteps } from './steps';
import type { StepResult } from './steps';
import { show } from './value';

export interface WorkingAsk {
  readonly accepted: readonly string[];
  readonly unit?: string | null;
}

export type WorkingKind = 'right' | 'wrong-step' | 'wrong-answer' | 'unreadable' | 'empty';

export interface WorkingVerdict {
  readonly verdict: WorkingKind;
  /** every line of her working, checked */
  readonly steps: readonly StepResult[];
  /** the first step that is wrong, from 0 */
  readonly firstWrong: number | null;
  /** what her working ends on */
  readonly final: string | null;
  /** one sentence she can be shown */
  readonly said: string;
  /** one sentence for whoever is helping her, with the numbers */
  readonly detail: string;
  /** whether `detail` holds an answer the ask accepts */
  readonly leaks: boolean;
}

/** Lines of working from a block of text: one step to a line. */
export function workingLines(text: string): string[] {
  return text
    .split(/\r?\n|;\s*/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function checkWorking(ask: WorkingAsk, working: string | readonly string[]): WorkingVerdict {
  const lines = typeof working === 'string' ? workingLines(working) : working.map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) {
    return { verdict: 'empty', steps: [], firstWrong: null, final: null, said: 'There is no working to check yet.', detail: 'no working was written', leaks: false };
  }
  const result = checkSteps(lines);
  const matches = (answer: Answer): boolean => ask.accepted.some((accepted) => agrees(accepted, answer, ask.unit ?? null));
  const holdsAnswer = (text: string | null): boolean => {
    const parsed = text === null ? null : parseAnswer(text);
    return parsed !== null && matches(parsed);
  };
  if (result.firstWrong !== null) {
    const step = result.steps[result.firstWrong] as StepResult;
    const leaks = holdsAnswer(step.expected);
    const where = `step ${result.firstWrong + 1}`;
    const detail = `${where} is wrong: ${step.said}${step.clue === null ? '' : ` (${step.clue})`}`;
    return {
      verdict: 'wrong-step',
      steps: result.steps,
      firstWrong: result.firstWrong,
      final: result.last,
      said: leaks || step.sum === null ? `Look again at ${where}.` : `Look again at ${where}: ${step.sum} is not ${step.claimed ?? 'that'}.`,
      detail,
      leaks,
    };
  }
  const readable = result.steps.filter((s) => s.verdict !== 'unreadable');
  if (readable.length === 0) {
    return { verdict: 'unreadable', steps: result.steps, firstWrong: null, final: null, said: 'I could not read the working. Could you write it again, a step on each line?', detail: 'no line could be read as a sum', leaks: false };
  }
  const final = result.lastValue === null ? null : show(result.lastValue);
  const right = result.lastValue !== null && matches(result.lastValue);
  if (right) {
    return { verdict: 'right', steps: result.steps, firstWrong: null, final, said: 'Every step checks out.', detail: `every step is right and the working ends on ${final}`, leaks: false };
  }
  return {
    verdict: 'wrong-answer',
    steps: result.steps,
    firstWrong: null,
    final,
    said: final === null ? 'The working does not end on an answer yet.' : `Every step is right, but it ends on ${final}. Does that answer the question?`,
    detail: `every step is right, and the working ends on ${final ?? 'nothing'}, which the ask does not accept`,
    leaks: false,
  };
}
