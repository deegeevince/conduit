// STUB (WS3, `L/lesson.ts`): the answer matcher and `sealed`, as the plan describes them (2.6, WS3's "an answer matcher (numbers, money, units, the
// words listed) as a table; the spoiler lint and `sealed(value, openAsks)`, which every drawer calls"). The lesson view calls these through this
// file only, so WS3's own replace it by changing the import. Pure, no DOM.

import type { Ask } from './types';

/** What a sealed value is drawn as. */
export const MASK = '?';

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** "thirty four", "thirty-four", "one hundred and five" to a number; null when it is not one. Up to 999. */
export function wordsToNumber(text: string): number | null {
  const parts = text
    .toLowerCase()
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && word !== 'and');
  if (parts.length === 0) return null;
  let total = 0;
  let current = 0;
  for (const word of parts) {
    const small = SMALL.indexOf(word);
    const tens = TENS.indexOf(word);
    if (small >= 0) current += small;
    else if (tens >= 2) current += tens * 10;
    else if (word === 'hundred') current = (current === 0 ? 1 : current) * 100;
    else return null;
  }
  total += current;
  return total;
}

const UNITS: Readonly<Record<string, string>> = { c: 'c', cent: 'c', cents: 'c', cm: 'cm', centimetres: 'cm', centimeters: 'cm', m: 'm', metres: 'm', meters: 'm', mm: 'mm', kg: 'kg', g: 'g', l: 'l', ml: 'ml' };

interface Reading {
  readonly number: number | null;
  readonly unit: string | null;
  readonly text: string;
}

function read(raw: string, unit: string | null): Reading {
  let text = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
  text = text.replace(/(\d),(\d{3})/g, '$1$2');
  let money = false;
  if (text.startsWith('$')) {
    money = true;
    text = text.slice(1).trim();
  }
  const timed = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (timed !== null) return { number: null, unit: null, text: `${Number(timed[1])}:${timed[2]}` };
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(text);
  if (m !== null) {
    const value = Number(m[1]);
    const written = m[2] === '' ? null : (UNITS[m[2] ?? ''] ?? m[2] ?? null);
    if (money) return { number: Math.round(value * 100), unit: 'c', text };
    return { number: value, unit: written, text };
  }
  const spoken = wordsToNumber(text);
  if (spoken !== null) return { number: spoken, unit: null, text };
  const withUnit = unit === null ? null : new RegExp(`^(.*?)\\s*${unit.toLowerCase()}$`).exec(text);
  const bare = withUnit?.[1];
  if (bare !== undefined && bare !== '') {
    const inner = wordsToNumber(bare);
    if (inner !== null) return { number: inner, unit: UNITS[unit?.toLowerCase() ?? ''] ?? unit, text };
  }
  return { number: null, unit: null, text };
}

/** Does what she typed (or picked) say one of the accepted answers? Numbers, money, units and the words listed. */
export function matches(input: string, accepted: readonly string[], unit: string | null): boolean {
  const got = read(input, unit);
  if (got.text === '') return false;
  const ownUnit = unit === null ? null : (UNITS[unit.toLowerCase()] ?? unit.toLowerCase());
  for (const answer of accepted) {
    const want = read(answer, unit);
    if (got.number !== null && want.number !== null) {
      if (got.number !== want.number) continue;
      const a = got.unit;
      const b = want.unit ?? ownUnit;
      if (a === null || b === null || a === b) return true;
      continue;
    }
    if (got.text === want.text) return true;
  }
  return false;
}

/** The answers of the asks that are open, as numbers and as words, for the sealing and the lint. */
function sealedSet(open: readonly Ask[]): { readonly numbers: ReadonlySet<number>; readonly words: readonly string[] } {
  const numbers = new Set<number>();
  const words: string[] = [];
  for (const ask of open) {
    for (const answer of ask.accepted) {
      const r = read(answer, ask.unit);
      if (r.number !== null && r.unit === null) numbers.add(r.number);
      else if (r.number !== null) numbers.add(r.number);
      if (r.number === null || /[a-z]{3,}/.test(answer.toLowerCase())) words.push(answer.toLowerCase().trim());
    }
  }
  return { numbers, words };
}

/** A value a drawer is about to show (a readout, a label, a computed word): the mask when it says an answer of an open ask. */
export function sealed(value: string | number, open: readonly Ask[]): string {
  const { numbers, words } = sealedSet(open);
  const text = String(value).trim();
  const r = read(text, null);
  if (r.number !== null && numbers.has(r.number)) return MASK;
  if (words.includes(text.toLowerCase())) return MASK;
  return text;
}

/**
 * Prose with every number or word that says an open answer masked, except what the question itself says (a question may hold the number
 * it asks about: "100 - [] = 50" asks for 50). The lint (WS3) refuses such prose at the reader; this is the drawer's own guard.
 */
export function sealText(text: string, open: readonly Ask[], question: string): string {
  if (open.length === 0) return text;
  const { numbers, words } = sealedSet(open);
  const own = new Set((question.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  let out = text.replace(/\d[\d,]*(?:\.\d+)?/g, (token) => {
    const n = Number(token.replace(/,/g, ''));
    return numbers.has(n) && !own.has(n) ? MASK : token;
  });
  for (const word of words) {
    if (word === '' || /^[\d.]+$/.test(word)) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), MASK);
  }
  return out;
}

/** Every open answer, as written: what the census looks for on screen. */
export function openAnswers(open: readonly Ask[]): readonly string[] {
  return open.flatMap((ask) => ask.accepted);
}

/** Does `text` say an open answer outside the question's own numbers? The census's leak test, the same reading as `sealText`. */
export function saysAnswer(text: string, open: readonly Ask[], question: string): boolean {
  return sealText(text, open, question) !== text;
}
