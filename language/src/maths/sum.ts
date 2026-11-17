// The sum of a `math` line: what is written after the bar, read exactly, and what it comes to. The painter computes every digit and the brain writes none,
// so the answer exists only here, on the server's side of the line: `answerOf` is what the spoiler guard seals, like an ask's `is=`.
//
// Numbers are exact decimals (a whole number scaled by a power of ten), never floats, so 0.1 + 0.2 is 0.3.
import { MATH_LIMITS, MATH_PLACES } from '../vocabulary';
import type { MathMethod, MathPlace } from '../vocabulary';

/** An exact decimal: `n` ten-to-the-minus-`scale`ths. */
export interface Dec {
  readonly n: bigint;
  readonly scale: number;
}

const NUMBER = /^\d+(?:\.\d+)?$/;

/** `12.50` as a decimal; null when it is not a plain non-negative number within the digit limit. Commas as thousands are accepted and dropped. */
export function readDec(text: string): Dec | null {
  const bare = text.trim().replace(/,(?=\d{3}(\D|$))/g, '');
  if (!NUMBER.test(bare)) return null;
  const [whole = '', fraction = ''] = bare.split('.');
  if (whole.replace(/^0+(?=\d)/, '').length > MATH_LIMITS.digits || fraction.length > MATH_LIMITS.digits) return null;
  return { n: BigInt(whole + fraction), scale: fraction.length };
}

/** Whole digits and fraction digits of a decimal, in the shortest honest form (no leading zeros but one, no trailing fraction zeros). */
export function showDec(value: Dec): string {
  let { n, scale } = value;
  while (scale > 0 && n % 10n === 0n) {
    n /= 10n;
    scale -= 1;
  }
  const digits = n.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function lift(value: Dec, scale: number): bigint {
  return value.n * 10n ** BigInt(scale - value.scale);
}

export function addDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { n: lift(a, scale) + lift(b, scale), scale };
}

export function subDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { n: lift(a, scale) - lift(b, scale), scale };
}

export function mulDec(a: Dec, b: Dec): Dec {
  return { n: a.n * b.n, scale: a.scale + b.scale };
}

export function compareDec(a: Dec, b: Dec): number {
  const scale = Math.max(a.scale, b.scale);
  const x = lift(a, scale);
  const y = lift(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A number as it is written in a sum: no commas, no needless zeros after the point (`12.50` is `12.5`; `007` is `7`). */
function canonical(text: string): string | null {
  const dec = readDec(text);
  return dec === null ? null : showDec(dec);
}

/** What a sum is made of, read. Every number is canonical text. */
export type MathSum =
  | { readonly method: 'column'; readonly op: '+' | '-'; readonly operands: readonly string[] }
  | { readonly method: 'times'; readonly operands: readonly [string, string] }
  | { readonly method: 'split'; readonly operands: readonly [string] }
  /** `whole = a + b`; the blank part is `?` */
  | { readonly method: 'bond'; readonly whole: string; readonly parts: readonly [string, string] }
  | { readonly method: 'bar' | 'groups' | 'array' | 'line'; readonly text: string };

export type SumRead = { readonly ok: true; readonly sum: MathSum; readonly text: string } | { readonly ok: false; readonly why: string };

const fail = (why: string): SumRead => ({ ok: false, why });

/** `×`, `x`, `*` and `X` between numbers, and `÷`, `/` and `:`, are one sign each. */
function tidySigns(text: string): string {
  return text
    .replace(/(\d)\s*[x*X]\s*(?=[\d.])/g, '$1 × ')
    .replace(/\s*×\s*/g, ' × ')
    .replace(/\s*[÷]\s*/g, ' ÷ ')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reads the sum written after the bar of a `math` line. `column`: `12 + 12 + 12`, `503 - 278`, `3.4 + 12.75`. `times`: `47 × 6`. `split`: `347`. `bond`: `10 = 4 + ?`. */
export function readSum(method: MathMethod, written: string): SumRead {
  const text = tidySigns(written);
  if (text === '') return fail('a math line needs its sum after the bar: math m1 column | 12 + 12');
  switch (method) {
    case 'column': {
      const subtract = /\d\s*-\s*[\d.]/.test(text.replace(/^-/, ''));
      const parts = text.split(subtract ? /\s*-\s*/ : /\s*\+\s*/);
      if (text.includes('+') && subtract) return fail('a column sum is all additions or one subtraction; not both');
      if (text.includes('×') || text.includes('÷')) return fail('a column sum adds or subtracts; use `times` to multiply');
      const operands: string[] = [];
      for (const part of parts) {
        const value = canonical(part);
        if (value === null) return fail(`"${part}" is not a number a column sum can hold (digits, a point, up to ${MATH_LIMITS.digits} places)`);
        operands.push(value);
      }
      if (subtract) {
        if (operands.length !== 2) return fail('a subtraction takes two numbers: 503 - 278');
        if (compareDec(readDec(operands[0] as string) as Dec, readDec(operands[1] as string) as Dec) < 0) return fail('the first number of a subtraction cannot be smaller than the second');
        return { ok: true, sum: { method, op: '-', operands }, text: `${operands[0]} - ${operands[1]}` };
      }
      if (operands.length < 2) return fail('a column sum needs at least two numbers');
      if (operands.length > MATH_LIMITS.rows) return fail(`a column sum holds at most ${MATH_LIMITS.rows} rows`);
      return { ok: true, sum: { method, op: '+', operands }, text: operands.join(' + ') };
    }
    case 'times': {
      const parts = text.split(/\s*×\s*/);
      if (parts.length !== 2) return fail('times takes two numbers: 47 × 6');
      const [a, b] = [canonical(parts[0] ?? ''), canonical(parts[1] ?? '')];
      if (a === null || b === null || a.includes('.') || b.includes('.')) return fail('short multiplication takes whole numbers: 47 × 6');
      if (b.length !== 1) return fail('short multiplication multiplies by a single digit: 47 × 6');
      return { ok: true, sum: { method, operands: [a, b] }, text: `${a} × ${b}` };
    }
    case 'split': {
      const value = canonical(text);
      if (value === null) return fail('split takes one number: 347');
      return { ok: true, sum: { method, operands: [value] }, text: value };
    }
    case 'bond': {
      const found = /^([^=+\s]+)=([^=+\s]+)\+([^=+\s]+)$/.exec(text.replace(/\s+/g, ''));
      const [whole, left, right] = [found?.[1], found?.[2], found?.[3]];
      if (whole === undefined || left === undefined || right === undefined) return fail('a bond is a whole and its two parts: 10 = 4 + ?');
      const w = canonical(whole);
      const a = left === '?' ? '?' : canonical(left);
      const b = right === '?' ? '?' : canonical(right);
      if (w === null || a === null || b === null) return fail('a bond is made of numbers, and `?` for the part to find: 10 = 4 + ?');
      if (a === '?' && b === '?') return fail('a bond leaves one part to find, not both');
      const known = [a, b].filter((part) => part !== '?').map((part) => readDec(part) as Dec);
      const total = readDec(w) as Dec;
      if (known.some((part) => compareDec(part, total) > 0) || (known.length === 2 && compareDec(addDec(known[0] as Dec, known[1] as Dec), total) !== 0)) return fail('the parts of a bond must make its whole');
      return { ok: true, sum: { method, whole: w, parts: [a, b] }, text: `${w} = ${a} + ${b}` };
    }
    default: {
      // the pictures: `3/4`, `12 ÷ 3`, `3 × 4`, `7 + 5`. Held as written; the painter draws them from the numbers
      if (text.length > 40 || !/^[\d.,+\-×÷/=? ]+$/.test(text) || !/\d/.test(text)) return fail(`${method} takes the question's own numbers: 12 ÷ 3`);
      return { ok: true, sum: { method, text }, text };
    }
  }
}

/** The place name of the digit `at` places left of the point (0 is ones), or of `-at` places right of it. */
export function placeName(at: number): MathPlace | null {
  const names: Record<number, MathPlace> = { 0: 'ones', 1: 'tens', 2: 'hundreds', 3: 'thousands', 4: 'tenthousands', [-1]: 'tenths', [-2]: 'hundredths', [-3]: 'thousandths' };
  return names[at] ?? null;
}

/** The power of ten a place name stands for (`tens` is 1, `tenths` is -1); null for anything else. */
export function placeOf(name: string): number | null {
  const at = (MATH_PLACES as readonly string[]).indexOf(name);
  if (at < 0) return null;
  return [0, 1, 2, 3, 4, -1, -2, -3][at] ?? null;
}

const PART_WORD = MATH_PLACES.join('|');
const PART = new RegExp(`^(?:r[1-9]\\d?|rule|ans|sign|s[1-9]\\d?|(?:${PART_WORD})|(?:carry|ans|ex|top|b)-(?:${PART_WORD}))$`);

/**
 * Whether `part` names a part of a written method: a row (`r3`), a place (`tens`), the carry above a place (`carry-tens`), an answer cell (`ans-ones`; `ans`
 * is the whole answer row), the exchanged digits of a subtraction (`ex-tens`), the number on top (`top-tens`), a part of a bond (`b-ones` is not one: bonds
 * use `r1`, `r2`), the rule under the sum (`rule`), the sign (`sign`) and what a step adds (`s2`).
 */
export function isMathPart(part: string): boolean {
  return PART.test(part);
}

/** `m1.r3` as `{ id: 'm1', part: 'r3' }`; null when it is not a block's part. The id is the text before the first dot. */
export function splitMathPart(word: string): { readonly id: string; readonly part: string } | null {
  const dot = word.indexOf('.');
  if (dot <= 0) return null;
  const part = word.slice(dot + 1);
  return isMathPart(part) ? { id: word.slice(0, dot), part } : null;
}

/**
 * What the sum comes to, as the words the learner would write: the answer of a `column` or `times`, the missing part of a bond, the value of each place
 * of a `split`. These are what the spoiler guard seals, as an ask's `is=` is. A picture's answer is a binary sum worked out; none when it is not one.
 * Anything the sum itself shows (the number a `split` splits, a given) is no secret, and is left out.
 */
export function answerOf(sum: MathSum): readonly string[] {
  const out: string[] = [];
  switch (sum.method) {
    case 'column': {
      const values = sum.operands.map((operand) => readDec(operand) as Dec);
      const first = values[0] as Dec;
      out.push(showDec(sum.op === '+' ? values.slice(1).reduce(addDec, first) : subDec(first, values[1] as Dec)));
      break;
    }
    case 'times':
      out.push(showDec(mulDec(readDec(sum.operands[0]) as Dec, readDec(sum.operands[1]) as Dec)));
      break;
    case 'split': {
      const [number = ''] = sum.operands;
      const [whole = '', fraction = ''] = number.split('.');
      const digits = [...whole].map((digit, at) => ({ digit, place: whole.length - 1 - at })).concat([...fraction].map((digit, at) => ({ digit, place: -(at + 1) })));
      for (const { digit, place } of digits) {
        if (digit === '0') continue;
        out.push(place >= 0 ? digit + '0'.repeat(place) : `0.${'0'.repeat(-place - 1)}${digit}`);
      }
      break;
    }
    case 'bond': {
      const [a, b] = sum.parts;
      const whole = readDec(sum.whole) as Dec;
      out.push(a === '?' ? showDec(subDec(whole, readDec(b) as Dec)) : b === '?' ? showDec(subDec(whole, readDec(a) as Dec)) : b);
      break;
    }
    default: {
      const found = /^(\d+(?:\.\d+)?) ?([+\-×÷]) ?(\d+(?:\.\d+)?)$/.exec(sum.text);
      if (found?.[1] === undefined || found[3] === undefined) break;
      const [a, b] = [readDec(found[1]) as Dec, readDec(found[3]) as Dec];
      if (found[2] === '+') out.push(showDec(addDec(a, b)));
      else if (found[2] === '-' && compareDec(a, b) >= 0) out.push(showDec(subDec(a, b)));
      else if (found[2] === '×') out.push(showDec(mulDec(a, b)));
      else if (found[2] === '÷' && a.scale === 0 && b.scale === 0 && b.n !== 0n && a.n % b.n === 0n) out.push((a.n / b.n).toString());
      break;
    }
  }
  const given = new Set(sumNumbers(sum));
  return out.filter((answer) => answer !== '' && !given.has(answer));
}

/** The numbers a sum shows on its face. */
export function sumNumbers(sum: MathSum): readonly string[] {
  switch (sum.method) {
    case 'column':
    case 'times':
    case 'split':
      return sum.operands;
    case 'bond':
      return [sum.whole, ...sum.parts.filter((part) => part !== '?')];
    default:
      return sum.text.match(/\d+(?:\.\d+)?/g) ?? [];
  }
}
