// A `problem`: a maths question for a child to work out. The brain says the question exactly as given and its answer; everything else is the
// painter's (docs/language.md, "the brain sends intent, the painter holds the skill"). This file is the pure half of that: it reads the question
// into tokens the painter sets large, finds the form of the sum (which number is the blank, which sign), names the ways the sum can be laid out,
// writes the hints from what it read, and decides whether an answer is right. It never throws: a question it cannot read is a plain one, and the
// painter then draws the question, the blank and the pen, nothing more.
//
//   problem p1 answer=3000,3_000 | 1 000 = ___ ÷ 3
//
// Nothing here draws. The painter (`web/src/painter/problem`) draws the ways from the numbers of the form.

import { accepts } from './lesson';
import { parseLine } from './parse';
import { PROBLEM_WAYS } from './vocabulary';
import type { ProblemWay } from './vocabulary';

export type ProblemSign = 'add' | 'sub' | 'mul' | 'div';

/** One piece of the question, as the painter sets it: numbers, signs, words and the blank. `text` is what is shown. */
export type ProblemToken = { readonly gap: boolean } & (
  | { readonly kind: 'num'; readonly text: string; readonly value: number }
  | { readonly kind: 'frac'; readonly text: string; readonly num: number; readonly den: number }
  | { readonly kind: 'sign'; readonly text: string; readonly sign: ProblemSign }
  | { readonly kind: 'eq'; readonly text: '=' }
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'blank'; readonly text: '___' }
);
/** a token as the reader builds it, before it knows whether a space came before it */
type Piece = ProblemToken extends infer T ? (T extends unknown ? Omit<T, 'gap'> : never) : never;

export type ProblemOp = ProblemSign | 'of';

/** What the sum is: `a <op> b = c`, one of the three the blank. For `of` (`3/4 of 20 = ___`) `a` is 1 (unused), `frac` is the fraction, `b` the whole. */
export interface ProblemForm {
  readonly op: ProblemOp;
  readonly a: number | null;
  readonly b: number | null;
  readonly c: number | null;
  readonly unknown: 'a' | 'b' | 'c';
  readonly frac: { readonly num: number; readonly den: number } | null;
  /** the token each part is, so a hint can light it; -1 when the question has no such token */
  readonly at: { readonly a: number; readonly b: number; readonly c: number; readonly sign: number; readonly eq: number };
}

export interface ProblemRead {
  /** every piece of the question, in order; always holds exactly one blank (one is added when the question has none) */
  readonly tokens: readonly ProblemToken[];
  /** where the blank is in `tokens` */
  readonly blank: number;
  /** the sum it makes, or null when it is not one the painter knows (a word problem, several signs): the plain workspace */
  readonly form: ProblemForm | null;
  /** the blank was not written: it was put after the question */
  readonly added: boolean;
  /** where the sum ends: what follows (a remark in brackets, a second sentence) is shown small under it; `tokens.length` when the whole question is the sum or no sum was read */
  readonly sumEnd: number;
}

/** What `readProblemLine` returns for a `problem` line the page holds: the question, what is accepted, and the ways the brain asked for. */
export interface ProblemSpec {
  readonly id: string;
  readonly question: string;
  readonly answer: readonly string[];
  readonly ways: readonly ProblemWay[] | null;
  readonly for: string;
}

const FRACTION_WORDS: Readonly<Record<string, readonly [number, number]>> = { half: [1, 2], quarter: [1, 4], third: [1, 3], fifth: [1, 5], tenth: [1, 10], halves: [1, 2] };
const SIGN_WORDS: Readonly<Record<string, ProblemSign>> = { plus: 'add', add: 'add', minus: 'sub', times: 'mul', multiplied: 'mul', divided: 'div' };
const SIGN_TEXT: Readonly<Record<ProblemSign, string>> = { add: '+', sub: '−', mul: '×', div: '÷' };
const LEAD = new Set(['what', 'is', "what's", 'whats', 'work', 'out', 'find', 'calculate', 'solve', 'how', 'much', 'many', 'does', 'make', 'the', 'answer', 'to', 'sum', 'a', 'question']);

const PATTERN = /_{2,}|□|\[\s*\]|\d{1,3}(?:[   ]\d{3})+(?![\d])(?:\.\d+)?|\d+\s?\/\s?\d+|\d+(?:\.\d+)?|[÷×+−–—=*/:]|-|\p{L}[\p{L}'’]*|\S/gu;

const digits = (text: string): number => Number(text.replace(/[   ,]/g, ''));

/** The question as pieces. Total: any string gives a list (an empty one for nothing). */
export function tokenizeProblem(question: string): ProblemToken[] {
  const text = question.replace(/\s+/g, ' ').trim();
  const found = [...text.matchAll(PATTERN)];
  const raw = found.map((match) => match[0]);
  const gaps = found.map((match) => (match.index ?? 0) > 0 && text[(match.index ?? 0) - 1] === ' ');
  const out: ProblemToken[] = [];
  let at = 0;
  const push = (token: Piece): void => {
    out.push({ ...token, gap: gaps[at] ?? true } as ProblemToken);
  };
  for (let i = 0; i < raw.length; i += 1) {
    at = i;
    const piece = raw[i] as string;
    const next = raw[i + 1];
    if (/^_{2,}$/.test(piece) || piece === '□' || /^\[\s*\]$/.test(piece)) push({ kind: 'blank', text: '___' });
    else if (/^\d{1,3}(?:[   ]\d{3})+(?:\.\d+)?$/.test(piece)) push({ kind: 'num', text: piece.replace(/[  ]/g, ' '), value: digits(piece) });
    else if (/^\d+\s?\/\s?\d+$/.test(piece)) {
      const [n, d] = piece.split('/').map((part) => Number(part.trim())) as [number, number];
      push({ kind: 'frac', text: `${n}/${d}`, num: n, den: d });
    } else if (/^\d+(?:\.\d+)?$/.test(piece)) push({ kind: 'num', text: piece, value: Number(piece) });
    else if (piece === '÷' || piece === '/' || piece === ':') push({ kind: 'sign', text: '÷', sign: 'div' });
    else if (piece === '×' || piece === '*') push({ kind: 'sign', text: '×', sign: 'mul' });
    else if ((piece === 'x' || piece === 'X') && out.length > 0 && next !== undefined && /^[\d_□\[]/.test(next)) push({ kind: 'sign', text: '×', sign: 'mul' });
    else if (piece === '+') push({ kind: 'sign', text: '+', sign: 'add' });
    else if (piece === '−' || piece === '–' || piece === '—' || piece === '-') {
      // a minus between two things; at the start of the question it is a dash and means nothing
      push(out.length > 0 ? { kind: 'sign', text: '−', sign: 'sub' } : { kind: 'word', text: piece });
    } else if (piece === '=') push({ kind: 'eq', text: '=' });
    else if (piece === '?' && out.length > 0 && (out[out.length - 1]?.kind === 'eq' || out[out.length - 1]?.kind === 'sign')) push({ kind: 'blank', text: '___' });
    else if (/^\p{L}/u.test(piece)) {
      const lower = piece.toLowerCase();
      const fraction = FRACTION_WORDS[lower];
      const sign = SIGN_WORDS[lower];
      if (fraction !== undefined && (next?.toLowerCase() === 'of' || (out[out.length - 1]?.kind === 'word' && /^an?$/i.test(out[out.length - 1]?.text ?? '')))) {
        // "a quarter of": the "a" goes with it
        if (out[out.length - 1]?.kind === 'word' && /^an?$/i.test(out[out.length - 1]?.text ?? '')) out.pop();
        push({ kind: 'frac', text: lower === 'halves' ? 'half' : lower, num: fraction[0], den: fraction[1] });
      } else if (lower === 'take' && next?.toLowerCase() === 'away') {
        push({ kind: 'sign', text: '−', sign: 'sub' });
        i += 1;
      } else if (sign !== undefined && (lower !== 'divided' && lower !== 'multiplied' ? true : next?.toLowerCase() === 'by')) {
        push({ kind: 'sign', text: SIGN_TEXT[sign], sign });
        if (lower === 'divided' || lower === 'multiplied') i += 1;
      } else push({ kind: 'word', text: piece });
    } else push({ kind: 'word', text: piece });
  }
  return out;
}

const isOperand = (token: ProblemToken | undefined): boolean => token !== undefined && (token.kind === 'num' || token.kind === 'frac' || token.kind === 'blank');
const isOf = (token: ProblemToken | undefined): boolean => token?.kind === 'word' && token.text.toLowerCase() === 'of';

const wholeNumber = (token: ProblemToken | undefined): number | null | undefined => (token?.kind === 'blank' ? null : token?.kind === 'num' && Number.isInteger(token.value) && token.value >= 0 && token.value <= 1_000_000 ? token.value : undefined);

/** The sum a run of tokens makes, or null. `indexes` maps the run back to the whole question. */
function formOf(tokens: readonly ProblemToken[], indexes: readonly number[]): ProblemForm | null {
  const kinds = tokens.map((token, i) => (isOf(token) ? 'of' : token.kind === 'sign' ? 'sign' : token.kind === 'eq' ? 'eq' : isOperand(token) ? 'x' : `w${i}`));
  const shape = kinds.join(' ');
  const at = (i: number): number => indexes[i] ?? -1;
  const blanks = tokens.filter((token) => token.kind === 'blank').length;
  if (blanks !== 1) return null;
  const sum = (a: number, sign: number, b: number, c: number, eq: number): ProblemForm | null => {
    const ta = tokens[a];
    const tb = tokens[b];
    const tc = tokens[c];
    const ts = tokens[sign];
    if (ts?.kind !== 'sign') return null;
    const va = wholeNumber(ta);
    const vb = wholeNumber(tb);
    const vc = wholeNumber(tc);
    if (va === undefined || vb === undefined || vc === undefined) return null;
    const unknown = va === null ? 'a' : vb === null ? 'b' : 'c';
    return { op: ts.sign, a: va, b: vb, c: vc, unknown, frac: null, at: { a: at(a), b: at(b), c: at(c), sign: at(sign), eq: at(eq) } };
  };
  const of = (f: number, w: number, c: number, eq: number): ProblemForm | null => {
    const tf = tokens[f];
    const vw = wholeNumber(tokens[w]);
    const vc = wholeNumber(tokens[c]);
    if (tf?.kind !== 'frac' || vw === undefined || vw === null || vc === undefined || tf.den < 2 || tf.den > 12 || tf.num < 1 || tf.num >= tf.den) return null;
    return { op: 'of', a: null, b: vw, c: vc, unknown: vc === null ? 'c' : 'b', frac: { num: tf.num, den: tf.den }, at: { a: at(f), b: at(w), c: at(c), sign: at(f + 1), eq: at(eq) } };
  };
  switch (shape) {
    case 'x sign x eq x':
      return sum(0, 1, 2, 4, 3);
    case 'x eq x sign x':
      return sum(2, 3, 4, 0, 1);
    case 'x of x eq x': {
      const form = of(0, 2, 4, 3);
      return form !== null && form.unknown === 'c' ? form : null;
    }
    case 'x eq x of x': {
      const form = of(2, 4, 0, 1);
      return form !== null && form.unknown === 'c' ? form : null;
    }
    default:
      return null;
  }
}

/**
 * Reads a question. A blank is always found: `___`, `□`, `[ ]`, or a `?` after a sign; a question with none gets `= ___` after an expression
 * ("46 + 37", "half of 20") and a blank for the answer after anything else (a sentence).
 */
export function readProblem(question: string): ProblemRead {
  let tokens = tokenizeProblem(question);
  // a question mark at the end is punctuation, not a blank
  while (tokens.length > 0 && tokens[tokens.length - 1]?.kind === 'word' && /^[?.!]+$/.test(tokens[tokens.length - 1]?.text ?? '')) tokens = tokens.slice(0, -1);
  let blank = tokens.findIndex((token) => token.kind === 'blank');
  let added = false;
  if (blank < 0) {
    added = true;
    const last = tokens[tokens.length - 1];
    const sums = tokens.some((token) => token.kind === 'sign') || tokens.some((token) => isOf(token));
    if (sums && last?.kind !== 'eq') tokens = [...tokens, { kind: 'eq', text: '=', gap: true }];
    tokens = [...tokens, { kind: 'blank', text: '___', gap: true }];
    blank = tokens.length - 1;
  }
  // the sum itself: leading words ("What is", "Work out") and a closing "?" are not part of it
  let from = 0;
  while (from < tokens.length && tokens[from]?.kind === 'word' && LEAD.has((tokens[from]?.text ?? '').toLowerCase())) from += 1;
  const run = tokens.slice(from);
  // the sum is the longest run from the start that reads as one: a remark after it ("(share 1000 sweets…)", a second sentence) is shown but is not the sum
  let form: ProblemForm | null = null;
  let sumEnd = tokens.length;
  for (let end = run.length; end >= 3 && form === null; end -= 1) {
    if (end < run.length && !(run[end]?.kind === 'word' || run[end]?.kind === 'blank')) continue;
    const cut = run.slice(0, end);
    if (cut.filter((token) => token.kind === 'blank').length === 1) form = formOf(cut, cut.map((_, i) => i + from));
    if (form !== null) sumEnd = end + from;
  }
  return { tokens, blank, form, added, sumEnd };
}

// -------------------------------------------------------------------------------------------------------------------------------- ways

export interface ProblemWayInfo {
  readonly way: ProblemWay;
  /** the chip's words */
  readonly name: string;
}

const WAY_NAME: Readonly<Record<ProblemWay, string>> = { groups: 'Groups', bar: 'Bar', array: 'Array', column: 'Tens and ones', line: 'Number line' };

/** The ways this sum can be laid out, the one to start with first; `wanted` (the brain's `ways=`) chooses and limits among them. */
export function problemWays(form: ProblemForm | null, wanted: readonly ProblemWay[] | null = null): ProblemWayInfo[] {
  if (form === null) return [];
  const big = Math.max(form.a ?? 0, form.b ?? 0, form.c ?? 0);
  let ways: ProblemWay[];
  switch (form.op) {
    case 'div':
      ways = ['groups', 'bar'];
      break;
    case 'mul': {
      const small = (form.a ?? 1) <= 12 && (form.b ?? 1) <= 12 && (form.a ?? 1) * (form.b ?? 1) <= 144;
      ways = small && form.unknown === 'c' ? ['groups', 'array', 'bar'] : ['groups', 'bar'];
      break;
    }
    case 'add':
    case 'sub':
      ways = big < 10_000 ? ['column', 'line'] : ['line'];
      break;
    case 'of':
      ways = ['bar', 'groups'];
      break;
  }
  const chosen = wanted === null ? [] : wanted.filter((way) => ways.includes(way));
  return (chosen.length > 0 ? chosen : ways).map((way) => ({ way, name: WAY_NAME[way] }));
}

// -------------------------------------------------------------------------------------------------------------------------------- hints

export interface ProblemHint {
  readonly id: 'know' | 'find' | 'picture';
  /** the tap's own words */
  readonly label: string;
  /** the one short line it says on the question */
  readonly line: string;
  /** the tokens it lights */
  readonly lights: readonly number[];
}

const listed = (words: readonly string[]): string => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * The three hints the painter offers, written from what the question says: what we know, what we are finding, a picture. Never the answer:
 * they name only pieces of the question and the blank.
 */
export function problemHints(read: ProblemRead, who = 'child'): ProblemHint[] {
  const known = read.tokens.flatMap((token, index) => (token.kind === 'num' || token.kind === 'frac' || token.kind === 'sign' || isOf(token) ? [{ token, index }] : []));
  const knownLights = known.map((entry) => entry.index);
  const numbers = known.filter((entry) => entry.token.kind === 'num' || entry.token.kind === 'frac').map((entry) => entry.token.text);
  const signs = known.filter((entry) => entry.token.kind === 'sign' || entry.token.kind === 'word').map((entry) => entry.token.text);
  const adult = who === 'adult' || who === 'teacher' || who === 'parent';
  const said = `${listed(numbers)}${signs.length === 0 ? '' : `, and the ${signs[0] === 'of' ? 'word' : 'sign'} ${signs[0]}`}`;
  return [
    { id: 'know', label: 'What do we know?', line: numbers.length === 0 ? 'Read the question slowly.' : adult ? `Given: ${said}.` : `We know ${said}.`, lights: knownLights },
    { id: 'find', label: 'What are we finding?', line: adult ? 'To find: the number that goes in the blank.' : 'We are finding the number that goes in the box.', lights: [read.blank] },
    { id: 'picture', label: 'Try a picture', line: adult ? 'Choose a way to lay it out.' : 'Pick a picture to try.', lights: [] },
  ];
}

// -------------------------------------------------------------------------------------------------------------------------------- answers

/** What an answer is compared as: no spaces or commas inside a number, one kind of minus, no closing full stop, no leading "=". */
export function normalizeAnswer(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/^\s*(?:answer\s*)?[:=]?\s*/, '')
    .replace(/(?<=\d)[ , ](?=\d{3}(?!\d))/g, '')
    .replace(/(?<=\d)[ , ](?=\d{3}(?!\d))/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!\s]+$/, '')
    .trim();
}

/** Whether what she typed or wrote is one of the answers the problem accepts. The page's own matcher: no model. */
export function problemAnswerRight(answer: readonly string[], given: string): boolean {
  if (answer.length === 0 || given.trim() === '') return false;
  const tidy = normalizeAnswer(given);
  const wanted = answer.map(normalizeAnswer);
  if (wanted.includes(tidy)) return true;
  return [given, tidy].some((candidate) => accepts({ accepted: [...answer, ...wanted], unit: null }, candidate));
}

// -------------------------------------------------------------------------------------------------------------------------------- the line, and the cue

/** Whether the words are a maths question a child would work out: a sum, a times table, a fraction of a number, "question 15", a worksheet. */
export function asksForMaths(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(maths?|arithmetic|homework|worksheet|times tables?|long division|division|divide|multiply|multiplication|fractions?|subtract|subtraction|addition|equation|sum)\b/.test(t)) return true;
  if (/\bquestion\s*(?:no\.?\s*|number\s*)?\d+\b|\bnumber\s*\d+\b|\bq\s?\d+\b/.test(t) && /\b(help|teach|show|work|solve|photo|page|sheet|she|he|my (?:kid|child|son|daughter)|year old)\b/.test(t)) return true;
  if (/\d\s*[+×÷*/x−-]\s*\d/.test(t) && /(?:help|teach|show|work out|what is|whats|how (?:do|much)|year old|kid|child|=|\?)/.test(t)) return true;
  return /\b(?:half|quarter|\d+\/\d+)\s+of\s+\d+/.test(t);
}

export const problemWayList: readonly ProblemWay[] = PROBLEM_WAYS;

/** The `problem` a line of a script says, or null when it is no such line. The page reads the lines of the turn it holds with this. */
export function problemOfLine(text: string): ProblemSpec | null {
  const read = parseLine(text);
  if (read.kind !== 'line' || read.line.verb !== 'problem') return null;
  const line = read.line;
  return { id: line.id, question: line.title ?? '', answer: line.answer ?? [], ways: (line.ways ?? null) as readonly ProblemWay[] | null, for: line.for ?? 'child' };
}

/**
 * The chapter the brief carries for a maths question to work out. The brain says the question and its answer; the stage draws the workspace
 * (`painter/problem`). Short on purpose: nothing in it describes a layout.
 */
export const PROBLEM_CHAPTER = [
  'A MATHS QUESTION TO WORK OUT (typed, or in a photo): write ONE line and nothing else: `problem <id> answer=<every form you accept, _ for a space> | <the question exactly as given, ___ for the blank: no word of yours, no story, no brackets>`, for example `problem p1 answer=12,twelve | 48 ÷ 4 = ___`.',
  'It is NOT a drawing and no other recipe applies to it: the stage draws the whole workspace itself (the question large, a blank for the pen, hints, pictures from its numbers, steps, checking). So never write a `scene`, `say`, `rect`, `pick`, `bind`, `slider`, `ask` or `hint`, never a title, a caption, a choice or the answer in words, even when they ask for visuals, step by step, interactive or the pen. `ways=groups,bar,array,column,line` only to limit the pictures.',
  'A photo of several questions with none named: `say title | Which one first?` and a `say choice | <number>. <question>` each; a tap on one gives that question\'s `problem`. A number named: go straight to it.',
].join('\n');
