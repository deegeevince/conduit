// A maths question the person answers herself. There is no verb and no screen of its own: the brain lays out how it is worked out (a column sum, a take-away or a
// times is a `math` line, PLAN-maths) and writes one `ask` for a question in words, like anything else on the canvas. An old `problem` line (logs, replays) still
// plays: the normalizer makes it an `ask` (`normalize.ts`). This file holds the cue (when the words are a maths question), when the brief carries the short chapter
// (`carriesMaths`) and the chapter itself.

import type { TurnContext, TurnMemory } from './context';
import type { ShownItem } from './stage';
import type { TurnInput } from './wire';

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


/** The words of a turn as a cue reads them: what was typed (or what the page made of a voice note) and what the speech recogniser first heard. */
function wordsOf(input: TurnInput): string {
  return input.kind === 'prompt' || input.kind === 'tap' ? [input.text, ...(input.kind === 'prompt' ? (input.spoken ?? []) : [])].join(' ') : '';
}

/** A photo or the person's own writing and drawing comes with the turn: the sheet she is working on, most likely, whatever her words are. */
function bringsPicture(input: TurnInput): boolean {
  return input.kind === 'prompt' && ((input.images?.length ?? 0) > 0 || input.marks !== undefined);
}

/**
 * fb-101. How many of the latest turns keep a thread of sums warm: the chapter rides again when one of them was about a calculation worked by hand.
 * A turn that brings a photo or the person's own drawing keeps it warm longer, because a picture in a thread of sums is her sheet again (the pen's
 * "Please look at what I drew" says nothing a cue could read); a turn of plain words only for a while, so "now draw a cat" some turns on is left alone.
 */
export const MATHS_WARM = { words: 8, picture: 20 } as const;

/**
 * Whether THIS turn is itself about a calculation worked by hand, from what it carries and the stage and nothing before it: its words, the library's maths card
 * (which reads them better than a pattern does), the choices of a photo's questions, or a written method already on stage. These start a thread of sums: the
 * conductor remembers them (`TurnMemory.maths`), and a turn that carried the chapter only because the thread was warm does not keep it warm in its turn.
 */
export function aboutMaths(context: Pick<TurnContext, 'stage' | 'techniques'>, input: TurnInput): boolean {
  const { elements } = context.stage;
  if (elements.some((element) => element.figure?.kind === 'structure' && element.figure.structure === 'math')) return true;
  if (elements.some((element) => element.text.toLowerCase().includes('which one first'))) return true;
  if (input.kind !== 'prompt' && input.kind !== 'tap') return false;
  return (context.techniques ?? []).some((card) => card.id === 'seed:teach-young-learner') || asksForMaths(wordsOf(input));
}

/** A written method or a typeset formula the person was shown: the brain used the method itself, so the thread is one of sums whatever was asked. */
export function shownMaths(shown: readonly Pick<ShownItem, 'text'>[]): boolean {
  return shown.some((item) => /^(?:written method|typeset formula)\b/.test(item.text));
}

/** Whether a thread of sums is warm for this turn (see `MATHS_WARM`). */
export function mathsWarm(history: readonly Pick<TurnMemory, 'maths'>[], input: TurnInput): boolean {
  // only the person's own turns: the server's own (a repair, a carry-on) and a played script do not need it
  if (input.kind !== 'prompt' && input.kind !== 'tap' && input.kind !== 'act') return false;
  return history.slice(-(bringsPicture(input) ? MATHS_WARM.picture : MATHS_WARM.words)).some((memory) => memory.maths === true);
}

/** Whether the brief carries the maths chapter: this turn is about maths, or the thread of sums is warm. A live app on stage or asked for takes the stage instead (the caller's rule). */
export function carriesMaths(context: Pick<TurnContext, 'stage' | 'techniques' | 'history'>, input: TurnInput): boolean {
  return aboutMaths(context, input) || mathsWarm(context.history, input);
}


/**
 * The chapter the brief carries for a maths question (typed, or in a photo); short on purpose: the drawing and the `ask` are taught elsewhere. A column sum, a
 * take-away or a times is one `math` line, never digits the brain places by hand (PLAN-maths M5): the painter works every digit, so the carries line up and the
 * working cannot be wrong or hold the answer. `problem` and the old workspace are not taught; an old `problem` line still plays (normalize.ts).
 */
export const MATHS_CHAPTER = [
  'MATHS, BY WHO DOES THE WORKING. The learner will: coach, never a bare restating; lay it out as it is worked, each result blank, nothing that holds the answer, no step beyond what they said; a question in words is one `ask` (`is=` the one answer in every spelling, as digits and as words, never a step), its hint behind a tap a smaller question with a first example, never a fact. The person asks to SEE a calculation (explain it, show the maths, "his numbers in"): show it whole, every step and result on the stage, no `ask`, no blank cell.',
  'A column sum, take-away or times as on paper is ONE line, never digits you place with `say at=`: `math m1 column|times|split|bond [worked] [blank=all] | 3486 + 2795` in a `scene stack`. The painter computes every digit and carry and seals the answer (no `say` may state it); its empty boxes are theirs: they write in them with the pen and send, you see the picture of their writing on the sum and decide what is next (`fill` a box, mark it, a hint, the next sum). `worked` fills it in (an example on other numbers, then their own); `blank=all` blanks every step. Above it a title and three short lines at most; a new sum is a new id (`m2`). Parts `m1.tens`, `m1.carry-tens`, `m1.ans-ones` work in `near=`, `hit`, `set … mark=box` and `fill m1 | 6281`.',
  'A PHOTO of the question: show it first (`scene layout=figure canvas=square`, `wide` if landscape; `pic p1 from=u1`), one `say c1 callout at=x,y in=p1 | 503 at the start` on each number it gives (at most four of its words, no step, no sum), `wait 3`, then `scene stack` for the working.',
  'Shown whole, a formula is typeset TeX in its own `scene stack`, symbols first and then the numbers in: `math f2 formula | c = \\frac{3.0\\times10^{8}\\,\\text{km}}{1320\\,\\text{s}} \\approx 2.3\\times10^{5}\\,\\text{km/s}`.',
  'A photo of several questions with none named: `say title | Which one first?` and a `say choice | <number>. <question>` each; a tap on one gives that question. A number named: go straight to it.',
  'An answer they give you by voice, by pen or in the chat: `fill <ask id> | <answer>`; it is the only way a blank is filled, so never say you filled one otherwise.',
].join('\n');
