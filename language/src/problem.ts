// A maths question the person answers herself. There is no verb and no screen of its own: the brain draws the question and, when it is asked how it is
// worked out, the method, and writes one `ask` for her answer, like anything else on the canvas. An old `problem` line (logs, replays) still plays:
// the normalizer makes it an `ask` (`normalize.ts`). This file holds the cue (when the words are a maths question) and the short chapter the brief carries then.

/** Whether the words are a maths question a child would work out: a sum, a times table, a fraction of a number, "question 15", a worksheet. */
export function asksForMaths(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(maths?|arithmetic|homework|worksheet|times tables?|long division|division|divide|multiply|multiplication|fractions?|subtract|subtraction|addition|equation|sum)\b/.test(t)) return true;
  if (/\bquestion\s*(?:no\.?\s*|number\s*)?\d+\b|\bnumber\s*\d+\b|\bq\s?\d+\b/.test(t) && /\b(help|teach|show|work|solve|photo|page|sheet|she|he|my (?:kid|child|son|daughter)|year old)\b/.test(t)) return true;
  if (/\d\s*[+×÷*/x−-]\s*\d/.test(t) && /(?:help|teach|show|work out|what is|whats|how (?:do|much)|year old|kid|child|=|\?)/.test(t)) return true;
  return /\b(?:half|quarter|\d+\/\d+)\s+of\s+\d+/.test(t);
}


/** The chapter the brief carries for a maths question (typed, or in a photo); short on purpose: the drawing and the `ask` are taught elsewhere. */
export const MATHS_CHAPTER = [
  'A MATHS QUESTION THE PERSON WILL ANSWER THEMSELVES (typed, or in a photo): never a bare restating of it. Draw how it is worked out: the question as given and the breakdown laid out whole, each step saying what to do with its result left blank, never the answer; one `ask` for the final answer (`is=` every form you accept, a number as digits and as words) with a hint behind a tap. They write it with the pen or type it.',
  'Working as on paper (a column sum, take-away or times): `scene layout=free canvas=square`, one `say` per number with `at=x,y align=right face=mono`, no `size` (the same x for a column, a row every 10 from y=20), the sign on the last row just left of them, a `path` rule under them, and the `ask` for the answer below, which flows there: keep the digits above y=75 and the words out of the column.',
  'A photo of several questions with none named: `say title | Which one first?` and a `say choice | <number>. <question>` each; a tap on one gives that question. A number named: go straight to it.',
  'An answer they give you by voice, by pen or in the chat to put in the blank: `fill <ask id> | <answer>`; that is the only way a blank is filled, so never say you filled one any other way.',
].join('\n');
