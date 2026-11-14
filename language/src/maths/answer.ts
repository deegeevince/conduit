// Answers: what a person types, or a lesson accepts, read as the value it stands for, and compared exactly.
//
// An answer is one value (`60`, `$6.50`, `125 cm`, `2 1/2`, `9:20 am`, `25%`), a list of them in order (`45, 54, 405`), or plain words (`April`, `<`).
// An expression is not an answer: `3 + 31` is a sum, not what the question asked for.

import { Fail } from './rational';
import { lex } from './lex';
import type { Tok } from './lex';
import { parseTokens } from './ast';
import type { Node } from './ast';
import { evalNode } from './ast';
import { same, show } from './value';
import type { Val } from './value';
import { unitOf } from './units';
import type { Unit } from './units';

export type Answer = Val | readonly Val[] | { readonly t: 'text'; readonly text: string };

export const isList = (a: Answer): a is readonly Val[] => Array.isArray(a);
export const isText = (a: Answer): a is { readonly t: 'text'; readonly text: string } => !Array.isArray(a) && (a as { t: string }).t === 'text';
export const textAnswer = (text: string): Answer => ({ t: 'text', text });

const isLiteral = (n: Node): boolean => n.k === 'lit' || (n.k === 'neg' && n.e.k === 'lit');

/** One value from words that are just that value (a number, a quantity, a time). Null when they are anything else, an expression included. */
export function parseValue(text: string): Val | null {
  try {
    const node = parseTokens(lex(text.trim().replace(/^=\s*/, '')), text, { trailingWords: true });
    if (!isLiteral(node)) return null;
    return evalNode(node, { gapUnit: null, prev: null });
  } catch (error) {
    if (error instanceof Fail) return null;
    throw error;
  }
}

/** Like `parseValue`, and throws `Fail` with the reason when it is not one value. */
export function valueOf(text: string): Val {
  const v = parseValue(text);
  if (v === null) throw new Fail('unreadable', `"${text.trim()}" is not a number or a quantity`);
  return v;
}

const LITERAL_TOKS: ReadonlySet<string> = new Set(['num', 'qty', 'clock']);

/** Several values in a row (`45, 54, 405`, `45 < 54 < 405`, `4 then 5`): in the order written. Null when it is not a list of two or more. */
export function parseList(text: string): readonly Val[] | null {
  let toks: Tok[];
  try {
    toks = lex(text.trim());
  } catch (error) {
    if (error instanceof Fail) return null;
    throw error;
  }
  const values: Val[] = [];
  for (const t of toks) {
    if (LITERAL_TOKS.has(t.k)) {
      const v = parseValue(text.slice(t.at, t.end));
      if (v === null) return null;
      values.push(v);
    } else if (t.k === 'punct' && [',', ';', '<', '>', '.', ' '].includes(t.ch)) continue;
    else if (t.k === 'word' && ['then', 'and', 'or'].includes(t.w)) continue;
    else return null;
  }
  return values.length >= 2 ? values : null;
}

/** What `text` stands for as an answer. */
export function parseAnswer(text: string): Answer | null {
  const single = parseValue(text);
  if (single !== null) return single;
  const list = parseList(text);
  if (list !== null) return list;
  const plain = text.trim().replace(/[.!?]+$/, '').trim().toLowerCase();
  return plain === '' ? null : textAnswer(plain);
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}<>=\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w !== '' && w !== 'a' && w !== 'an' && w !== 'the')
      .join(' ');
  return norm(a) === norm(b);
}

/** Whether two answers are the same. Lists must agree in order; a list never equals a lone value. */
export function sameAnswer(a: Answer, b: Answer, unit: Unit | null = null): boolean {
  if (isText(a) || isText(b)) return isText(a) && isText(b) && sameText(a.text, b.text);
  if (isList(a) || isList(b)) return isList(a) && isList(b) && a.length === b.length && a.every((x, i) => same(x, b[i] as Val, unit));
  return same(a, b, unit);
}

/** The unit an ask names (`unit=cm`), or null. */
export function askUnit(name: string | null | undefined): Unit | null {
  return name === null || name === undefined ? null : unitOf(name.trim().toLowerCase());
}

/** An answer as it reads, for a reason: `64`, `$1.60`, `9:20 am`, `45, 54, 405`. */
export function answerText(a: Answer): string {
  if (isText(a)) return a.text;
  if (isList(a)) return a.map((v) => show(v) ?? '?').join(', ');
  return show(a) ?? '?';
}

/** Whether what was typed (or accepted by a lesson) says the same as `answer`. Words that are not an answer at all are never the same as a number. */
export function agrees(accepted: string, answer: Answer, unit: string | null = null): boolean {
  const parsed = parseAnswer(accepted);
  return parsed !== null && sameAnswer(parsed, answer, askUnit(unit));
}

