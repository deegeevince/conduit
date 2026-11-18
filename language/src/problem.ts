// A maths question the person answers herself. There is no verb and no screen of its own: the brain lays out how it is worked out (a column sum, a take-away or a
// times is a `math` line, PLAN-maths) and writes one `ask` for a question in words, like anything else on the canvas. An old `problem` line (logs, replays) still
// plays: the normalizer makes it an `ask` (`normalize.ts`). This file holds the cue (when the words are a maths question) and the short chapter the brief carries then.

/** Whether the words are a maths question a child would work out: a sum, a times table, a fraction of a number, "question 15", a worksheet. */
export function asksForMaths(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(maths?|arithmetic|homework|worksheet|times tables?|long division|division|divide|multiply|multiplication|fractions?|subtract|subtraction|addition|equation|sum)\b/.test(t)) return true;
  // "add two big numbers", "carry the one", "a column sum": the words of a written method, with no digit in them
  if (/\b(?:add|adding|subtract|subtracting|multiply|multiplying|divide|dividing)\s+(?:(?:up|together|two|three|four|some|a few|big|bigger|large|long|small|multi-digit|\d-digit|two-digit|three-digit|four-digit|whole|decimal)\s+){1,3}(?:numbers?|digits?|decimals?)\b/.test(t)) return true;
  if (/\b(?:big|large|long|multi-digit|\d-digit)\s+sums?\b|\bcarry(?:ing)?\s+the\s+(?:one|1|ten)\b|\bcolumn\s+(?:sums?|addition|subtraction|method)\b/.test(t)) return true;
  if (/\bquestion\s*(?:no\.?\s*|number\s*)?\d+\b|\bnumber\s*\d+\b|\bq\s?\d+\b/.test(t) && /\b(help|teach|show|work|solve|photo|page|sheet|she|he|my (?:kid|child|son|daughter)|year old)\b/.test(t)) return true;
  if (/\d\s*[+×÷*/x−-]\s*\d/.test(t) && /(?:help|teach|show|work out|what is|whats|how (?:do|much)|year old|kid|child|=|\?)/.test(t)) return true;
  return /\b(?:half|quarter|\d+\/\d+)\s+of\s+\d+/.test(t);
}


/**
 * The chapter the brief carries for a maths question (typed, or in a photo); short on purpose: the drawing and the `ask` are taught elsewhere. A column sum, a
 * take-away or a times is one `math` line, never digits the brain places by hand (PLAN-maths M5): the painter works every digit, so the carries line up and the
 * working cannot be wrong or hold the answer. `problem` and the old workspace are not taught; an old `problem` line still plays (normalize.ts).
 */
export const MATHS_CHAPTER = [
  'MATHS, BY WHO DOES THE WORKING. The learner will: coach, never a bare restating; lay it out as it is worked, each result blank, nothing that holds the answer, no step beyond what they said; a question in words is one `ask` (`is=` the one answer in every spelling, as digits and as words, never a step), its hint behind a tap a smaller question with a first example, never a fact. The person asks to SEE a calculation (explain it, show the maths, "his numbers in"): show it whole, every step and result on the stage, no `ask`, no blank cell.',
  'A column sum, take-away or times as on paper is ONE line, never digits you place with `say at=`: `math m1 column|times|split|bond [worked] [blank=all] | 3486 + 2795` in a `scene stack`. The painter computes every digit and carry and seals the answer (no `say` may state it); its empty boxes are theirs, with Check and Hint built in. `worked` fills it in (an example on other numbers, then their own); `blank=all` blanks every step. Above it a title and three short lines at most; a new sum is a new id (`m2`). Parts `m1.tens`, `m1.carry-tens`, `m1.ans-ones` work in `near=`, `hit`, `set … mark=box` and `fill m1 | 6281`.',
  'A PHOTO of the question: show it first (`scene layout=figure canvas=square`, `wide` if landscape; `pic p1 from=u1`), one `say c1 callout at=x,y in=p1 | 503 at the start` on each number it gives (at most four of its words, no step, no sum), `wait 3`, then `scene stack` for the working.',
  'Shown whole, a formula is typeset TeX in its own `scene stack`, symbols first and then the numbers in: `math f2 formula | c = \\frac{3.0\\times10^{8}\\,\\text{km}}{1320\\,\\text{s}} \\approx 2.3\\times10^{5}\\,\\text{km/s}`.',
  'A photo of several questions with none named: `say title | Which one first?` and a `say choice | <number>. <question>` each; a tap on one gives that question. A number named: go straight to it.',
  'A finished `math` block comes back as an act (`m1: all right, after 1 wrong check (tens 7) and 1 hint`): one line on what they did well, then ONE next small question or a sum like it, never the working again.',
  'An answer they give you by voice, by pen or in the chat: `fill <ask id> | <answer>`; it is the only way a blank is filled, so never say you filled one otherwise.',
].join('\n');
