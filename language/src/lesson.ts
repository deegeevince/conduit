// The lesson: what a worksheet question is made of, as data (PLAN-v3-core 2.6, 2.10, section 3).
//
// A lesson is the `step`s and `ask`s of one `part`. This file is the words of it (`part`, `step`, `ask`, `hint`, `reply`, `end`), the
// answer matcher, and the three layers of "an open ask seals its answer":
//   1. the reader (`LessonBook`) refuses an `ask`, or a `hint`, when what is already on the page holds an answer it accepts;
//   2. whatever draws asks `sealed(value, openAsks)` about every number, readout and `{expression}` it is about to show;
//   3. `lintLesson` reads a whole filled lesson, for the invariant that runs in the page and for the verifier.
// It touches no clock and no DOM, so the server and the page run the same code.

import { evalExpr, namesIn, parseExpr } from './expr';
import { plainText } from './text';
import type { Issue, IssueCode } from './types';
import { LESSON_LIMITS, LIMITS, RESERVED_IDS, TECHNIQUES, VISUAL } from './vocabulary';
import type { LessonVerb, TechniqueId, VisualKind, VisualParam } from './vocabulary';

// --- the lines ---------------------------------------------------------------------------------------------------------------------

/** A place in the document. `in` is absent for a child of the document's root, and written by the normaliser otherwise. */
export interface PartLine {
  readonly verb: 'part';
  readonly id: string;
  readonly in?: string;
  readonly tag?: TechniqueId;
  /** the question's box on the photo it was read from; the lesson page crops it */
  readonly crop?: Crop;
  readonly title: string;
}

/** Where a question sits on a photo: whole percents of the photo's width and height, from its top left. `from` names the photo (`u1`); absent, the conversation's first. */
export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly from?: string;
}

/** `crop=` as written: `x,y,w,h` in whole percents, inside the photo and with some area; null when it is not that. */
export function readCrop(value: string, from?: string): Crop | null {
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 100.5 || y + h > 100.5) return null;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return { x: round(x), y: round(y), w: round(Math.min(w, 100 - x)), h: round(Math.min(h, 100 - y)), ...(from === undefined ? {} : { from }) };
}

/** A crop as the line writes it: `crop=10,20,80,6` (and `from=u1`). */
export function cropTokens(crop: Crop): string[] {
  return [`crop=${crop.x},${crop.y},${crop.w},${crop.h}`, ...(crop.from === undefined ? [] : [`from=${crop.from}`])];
}

/** One picture for a step: which widget, its span if it takes one, and its parameters, each as the canonical text of its value. */
export interface ShowSpec {
  readonly visual: VisualKind;
  readonly range: readonly [number, number] | null;
  readonly args: Readonly<Record<string, string>>;
}

/** One reveal. `id` is `-` until the normaliser assigns one. */
export interface StepLine {
  readonly verb: 'step';
  readonly id: string;
  readonly in?: string;
  readonly show?: ShowSpec;
  /** may be empty when there is a picture to show */
  readonly text: string;
}

/** A try. `is` is every answer accepted, and nothing outside it is right. `id` is `-` until the normaliser assigns one. */
export interface AskLine {
  readonly verb: 'ask';
  readonly id: string;
  readonly in?: string;
  readonly is: readonly string[];
  readonly pick?: readonly string[];
  readonly unit?: string;
  readonly text: string;
}

/** What to say after a wrong try. `in` is the id of the ask it belongs to. */
export interface HintLine {
  readonly verb: 'hint';
  readonly in?: string;
  readonly text: string;
}

/** The answer as a sentence for the thread. It is never drawn on a stage. */
export interface ReplyLine {
  readonly verb: 'reply';
  readonly text: string;
}

/** Closes the part last opened. */
export interface EndLine {
  readonly verb: 'end';
}

export type LessonLine = PartLine | StepLine | AskLine | HintLine | ReplyLine | EndLine;

const LESSON_VERB_NAMES: readonly string[] = ['part', 'step', 'ask', 'hint', 'reply', 'end'] satisfies readonly LessonVerb[];

export function isLessonVerb(verb: string): verb is LessonVerb {
  return LESSON_VERB_NAMES.includes(verb);
}

// --- what a lesson holds -----------------------------------------------------------------------------------------------------------

export interface LessonReveal {
  readonly kind: 'step';
  readonly id: string;
  readonly show: ShowSpec | null;
  readonly words: string;
}

export interface LessonAsk {
  readonly kind: 'ask';
  readonly id: string;
  readonly prompt: string;
  readonly accepted: readonly string[];
  readonly pick: readonly string[] | null;
  readonly unit: string | null;
  readonly hints: readonly string[];
}

/** A stop of a lesson, in the order written. A reveal is passed by stepping; an ask opens when it holds an accepted answer. */
export type LessonStep = LessonReveal | LessonAsk;

/** An ask that is open: the answers that must not be on screen. */
export interface OpenAsk {
  readonly id: string;
  readonly accepted: readonly string[];
  readonly unit: string | null;
}

export function openAskOf(ask: LessonAsk): OpenAsk {
  return { id: ask.id, accepted: ask.accepted, unit: ask.unit };
}

// --- reading values ----------------------------------------------------------------------------------------------------------------

type Report = (code: IssueCode, message: string, token?: string) => void;

const NAME = /^[a-z][a-z0-9_-]*$/;

/** A part, step or ask id: the same shape as an element id. */
export function isLessonId(value: string): boolean {
  return NAME.test(value) && value.length <= LIMITS.name && !(RESERVED_IDS as readonly string[]).includes(value);
}

/** `a..b`: the span a number line is drawn over. */
const SPAN = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
const CLOCK_TIME = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;

export function isSpan(word: string): boolean {
  return SPAN.test(word);
}

function canonicalNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** A value as the brain writes it into a head: `_` stands for a space. */
export function decodeValue(raw: string): string {
  return raw.replaceAll('_', ' ').trim();
}

export function encodeValue(value: string): string {
  return value.trim().replace(/\s+/g, '_');
}

/** `a,b,c` as a list of decoded values; empty entries are dropped. */
export function splitValues(raw: string): string[] {
  return raw
    .split(',')
    .map(decodeValue)
    .filter((value) => value !== '');
}

function paramKinds(visual: VisualKind): Readonly<Record<string, VisualParam>> {
  return VISUAL[visual].keys;
}

function paramValue(kind: VisualParam, raw: string): string | null {
  switch (kind) {
    case 'number':
      return PLAIN_NUMBER.test(raw) ? canonicalNumber(Number(raw)) : null;
    case 'numbers': {
      const parts = raw.split(',');
      if (parts.length === 0 || parts.length > LESSON_LIMITS.numbers) return null;
      const out: string[] = [];
      for (const part of parts) {
        if (part === '?') out.push('?');
        else if (PLAIN_NUMBER.test(part)) out.push(canonicalNumber(Number(part)));
        else return null;
      }
      return out.join(',');
    }
    case 'word':
      return /^[a-z][a-z0-9_-]{0,23}$/.test(raw) ? raw : null;
    case 'time':
      return CLOCK_TIME.test(raw) ? raw : null;
  }
}

export interface HeadPair {
  readonly key: string;
  /** lower-cased */
  readonly value: string;
  readonly token: string;
}

/**
 * `show=<visual> [a..b] [key=value…]`. `visual` is the word after `show=`; `spans` the bare `a..b` words of the line; `pairs` every other
 * `key=value` of it (the caller has taken `in=`, `show=` and its own keys out). A word or a value this visual does not know is dropped with
 * a warning, and the picture is kept.
 */
export function readShow(visual: string, spans: readonly string[], pairs: readonly HeadPair[], report: Report): ShowSpec | null {
  const kind = VISUAL_KIND_NAMES.find((name) => name === visual);
  if (kind === undefined) {
    report('unknown-word', `"${visual}" is not a picture a step can show (${VISUAL_KIND_NAMES.join(', ')}); the step has no picture`, visual);
    return null;
  }
  const spec = VISUAL[kind];
  let range: readonly [number, number] | null = null;
  for (const word of spans) {
    const match = SPAN.exec(word);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (!spec.range) report('unknown-word', `a ${kind} has no span; "${word}" ignored`, word);
    else if (Number(match[1]) >= Number(match[2])) report('bad-value', `"${word}" is not a span that runs up from its first number; ignored`, word);
    else range = [Number(match[1]), Number(match[2])];
  }
  const args: Record<string, string> = {};
  const keys = paramKinds(kind);
  for (const pair of pairs) {
    const want = Object.hasOwn(keys, pair.key) ? keys[pair.key] : undefined;
    if (want === undefined) {
      report('unknown-key', `a ${kind} takes ${Object.keys(keys).join(', ')}; "${pair.key}" ignored`, pair.token);
      continue;
    }
    const value = paramValue(want, pair.value);
    if (value === null || value.length > LESSON_LIMITS.value) report('bad-value', `${pair.key}=${pair.value}: a ${want === 'numbers' ? 'comma list of numbers (? for a gap)' : want === 'time' ? 'time like 3:30' : want === 'word' ? 'single word' : 'number'} is wanted; ignored`, pair.token);
    else args[pair.key] = value;
  }
  return { visual: kind, range, args };
}

const VISUAL_KIND_NAMES = Object.keys(VISUAL).filter((name): name is VisualKind => Object.hasOwn(VISUAL, name));

/** The tokens that write a `show=` back, in one fixed order: the visual, its span, then its parameters in the table's order. */
export function showTokens(show: ShowSpec): string[] {
  const out = [`show=${show.visual}`];
  if (show.range !== null) out.push(`${canonicalNumber(show.range[0])}..${canonicalNumber(show.range[1])}`);
  for (const key of Object.keys(paramKinds(show.visual))) {
    const value = Object.hasOwn(show.args, key) ? show.args[key] : undefined;
    if (value !== undefined) out.push(`${key}=${value}`);
  }
  return out;
}

/** A `numbers` parameter as numbers, a gap (`?`) as null. */
export function numbersOf(value: string | undefined): readonly (number | null)[] {
  if (value === undefined || value === '') return [];
  return value.split(',').map((part) => (part === '?' ? null : Number(part)));
}

export function technique(word: string): TechniqueId | null {
  return TECHNIQUES.find((id) => id === word) ?? null;
}

// --- the answer matcher ------------------------------------------------------------------------------------------------------------

type UnitDim = 'none' | 'length' | 'mass' | 'volume' | 'time' | 'gbp' | 'usd' | 'eur' | 'percent';

/** What a unit is, and how many of its dimension's base unit it is (metre, kilogram, litre, second, pound, dollar, euro). */
const UNITS: Readonly<Record<string, { readonly dim: UnitDim; readonly factor: number }>> = {
  mm: { dim: 'length', factor: 0.001 },
  millimetre: { dim: 'length', factor: 0.001 },
  millimetres: { dim: 'length', factor: 0.001 },
  millimeter: { dim: 'length', factor: 0.001 },
  millimeters: { dim: 'length', factor: 0.001 },
  cm: { dim: 'length', factor: 0.01 },
  centimetre: { dim: 'length', factor: 0.01 },
  centimetres: { dim: 'length', factor: 0.01 },
  centimeter: { dim: 'length', factor: 0.01 },
  centimeters: { dim: 'length', factor: 0.01 },
  m: { dim: 'length', factor: 1 },
  metre: { dim: 'length', factor: 1 },
  metres: { dim: 'length', factor: 1 },
  meter: { dim: 'length', factor: 1 },
  meters: { dim: 'length', factor: 1 },
  km: { dim: 'length', factor: 1000 },
  kilometre: { dim: 'length', factor: 1000 },
  kilometres: { dim: 'length', factor: 1000 },
  kilometer: { dim: 'length', factor: 1000 },
  kilometers: { dim: 'length', factor: 1000 },
  g: { dim: 'mass', factor: 0.001 },
  gram: { dim: 'mass', factor: 0.001 },
  grams: { dim: 'mass', factor: 0.001 },
  kg: { dim: 'mass', factor: 1 },
  kilo: { dim: 'mass', factor: 1 },
  kilos: { dim: 'mass', factor: 1 },
  kilogram: { dim: 'mass', factor: 1 },
  kilograms: { dim: 'mass', factor: 1 },
  ml: { dim: 'volume', factor: 0.001 },
  millilitre: { dim: 'volume', factor: 0.001 },
  millilitres: { dim: 'volume', factor: 0.001 },
  milliliter: { dim: 'volume', factor: 0.001 },
  milliliters: { dim: 'volume', factor: 0.001 },
  cl: { dim: 'volume', factor: 0.01 },
  centilitre: { dim: 'volume', factor: 0.01 },
  centilitres: { dim: 'volume', factor: 0.01 },
  l: { dim: 'volume', factor: 1 },
  litre: { dim: 'volume', factor: 1 },
  litres: { dim: 'volume', factor: 1 },
  liter: { dim: 'volume', factor: 1 },
  liters: { dim: 'volume', factor: 1 },
  s: { dim: 'time', factor: 1 },
  sec: { dim: 'time', factor: 1 },
  secs: { dim: 'time', factor: 1 },
  second: { dim: 'time', factor: 1 },
  seconds: { dim: 'time', factor: 1 },
  min: { dim: 'time', factor: 60 },
  mins: { dim: 'time', factor: 60 },
  minute: { dim: 'time', factor: 60 },
  minutes: { dim: 'time', factor: 60 },
  h: { dim: 'time', factor: 3600 },
  hr: { dim: 'time', factor: 3600 },
  hrs: { dim: 'time', factor: 3600 },
  hour: { dim: 'time', factor: 3600 },
  hours: { dim: 'time', factor: 3600 },
  '£': { dim: 'gbp', factor: 1 },
  pound: { dim: 'gbp', factor: 1 },
  pounds: { dim: 'gbp', factor: 1 },
  p: { dim: 'gbp', factor: 0.01 },
  pence: { dim: 'gbp', factor: 0.01 },
  penny: { dim: 'gbp', factor: 0.01 },
  pennies: { dim: 'gbp', factor: 0.01 },
  $: { dim: 'usd', factor: 1 },
  dollar: { dim: 'usd', factor: 1 },
  dollars: { dim: 'usd', factor: 1 },
  cent: { dim: 'usd', factor: 0.01 },
  cents: { dim: 'usd', factor: 0.01 },
  '€': { dim: 'eur', factor: 1 },
  euro: { dim: 'eur', factor: 1 },
  euros: { dim: 'eur', factor: 1 },
  '%': { dim: 'percent', factor: 1 },
  percent: { dim: 'percent', factor: 1 },
};

const UNIT_SYMBOLS = ['£', '$', '€'] as const;

const SMALL_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS_WORDS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

interface Quantity {
  /** the number as it was written */
  readonly written: number;
  /** the number in its dimension's base unit */
  readonly base: number;
  readonly dim: UnitDim;
}

/**
 * Number words at the start of `tokens`: `forty two`, `a hundred and five`, `one and a half`, `half`, `three quarters`. Up to 9,999.
 * `used` is how many tokens were read.
 */
function numberWords(tokens: readonly string[]): { value: number; used: number } | null {
  let index = 0;
  let total = 0;
  let any = false;
  let current = 0;
  let last: 'small' | 'tens' | 'hundred' | 'thousand' | 'and' | null = null;
  const at = (offset: number): string => tokens[index + offset] ?? '';
  const take = (): boolean => {
    const word = at(0);
    if (word === 'a' && (at(1) === 'hundred' || at(1) === 'thousand')) {
      current = 1;
      index += 1;
      any = true;
      return true;
    }
    const small = Object.hasOwn(SMALL_WORDS, word) ? SMALL_WORDS[word] : undefined;
    // `one ten` is two numbers (a child counting, "one ten at a time"), not eleven: a number word may only follow a tens word (`forty two`) or a hundred
    if (small !== undefined && any && (current % 100 === 0 ? false : !(last === 'tens' && small >= 1 && small <= 9)) && last !== 'and' && last !== 'hundred') return false;
    if (Object.hasOwn(TENS_WORDS, word) && any && last !== 'and' && last !== 'hundred' && last !== 'thousand' && current % 100 !== 0) return false;
    if (small !== undefined) {
      last = 'small';
      current += small;
      index += 1;
      any = true;
      return true;
    }
    const tens = Object.hasOwn(TENS_WORDS, word) ? TENS_WORDS[word] : undefined;
    if (tens !== undefined) {
      last = 'tens';
      current += tens;
      index += 1;
      any = true;
      return true;
    }
    if (word === 'hundred' && any) {
      last = 'hundred';
      current = (current === 0 ? 1 : current) * 100;
      index += 1;
      return true;
    }
    if (word === 'thousand' && any) {
      last = 'thousand';
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      index += 1;
      return true;
    }
    if (word === 'and' && any && (Object.hasOwn(SMALL_WORDS, at(1)) || Object.hasOwn(TENS_WORDS, at(1)))) {
      last = 'and';
      index += 1;
      return true;
    }
    return false;
  };
  while (index < tokens.length && take()) {
    // keep reading
  }
  if (!any) {
    if (at(0) === 'half') return { value: 0.5, used: 1 };
    if (at(0) === 'quarter') return { value: 0.25, used: 1 };
    return null;
  }
  let value = total + current;
  // `one and a half`, `two and a quarter`, `three quarters`
  if (at(0) === 'and' && at(1) === 'a' && (at(2) === 'half' || at(2) === 'quarter')) {
    value += at(2) === 'half' ? 0.5 : 0.25;
    index += 3;
  } else if (at(0) === 'quarters' && value === 3) {
    value = 0.75;
    index += 1;
  } else if (at(0) === 'half' && value === 0) {
    index += 1;
  }
  return { value, used: index };
}

function unitOf(word: string): { readonly dim: UnitDim; readonly factor: number } | null {
  return Object.hasOwn(UNITS, word) ? (UNITS[word] ?? null) : null;
}

const DIGITS = /^(-?\d+(?:,\d{3})*(?:\.\d+)?|-?\.\d+)/;

/**
 * What a typed answer or an accepted answer is, as a number: `34`, `£1.50`, `150p`, `1,000`, `2 1/2`, `30 cm`, `60 flowers`, `forty two`,
 * `half`. A unit it knows gives it a dimension; a word it does not know after the number is a noun (`flowers`) and is let go. Anything with
 * an operator in it, or anything that is not a number, is null.
 */
export function parseQuantity(input: string): Quantity | null {
  let text = input.toLowerCase().replace(/[“”"]/g, '').trim().replace(/^=\s*/, '').replace(/[.!?]+$/, '').trim();
  if (text === '') return null;
  text = text.replace(/\s+/g, ' ');
  let unit: { readonly dim: UnitDim; readonly factor: number } | null = null;
  for (const symbol of UNIT_SYMBOLS) {
    if (text.startsWith(symbol)) {
      unit = unitOf(symbol);
      text = text.slice(symbol.length).trim();
      break;
    }
  }
  let value: number | null = null;
  let rest = '';
  const mixed = /^(\d+) (\d+)\/(\d+)(.*)$/.exec(text);
  const fraction = /^(-?\d+)\s*\/\s*(\d+)(.*)$/.exec(text);
  const digits = DIGITS.exec(text);
  if (mixed?.[1] !== undefined && mixed[2] !== undefined && mixed[3] !== undefined && Number(mixed[3]) !== 0) {
    value = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
    rest = mixed[4] ?? '';
  } else if (fraction?.[1] !== undefined && fraction[2] !== undefined && Number(fraction[2]) !== 0) {
    value = Number(fraction[1]) / Number(fraction[2]);
    rest = fraction[3] ?? '';
  } else if (digits?.[1] !== undefined) {
    value = Number(digits[1].replaceAll(',', ''));
    rest = text.slice(digits[1].length);
  } else {
    const tokens = text.split(/[\s-]+/).filter((token) => token !== '');
    const read = numberWords(tokens);
    if (read === null) return null;
    value = read.value;
    rest = tokens.slice(read.used).join(' ');
  }
  if (!Number.isFinite(value)) return null;
  rest = rest.trim();
  if (rest !== '') {
    // `30cm`, `30 cm`, `150p`, `60 flowers`, `half a litre`: one unit and then nouns; an operator or a digit means this is a sum, not an answer.
    if (!/^[a-z%£$€][a-z%£$€ '-]*$/.test(rest)) return null;
    const words = rest.split(' ');
    if (words.length > 4) return null;
    const first = words[0] ?? '';
    const found = unitOf(first);
    if (found !== null) {
      if (unit === null) unit = found;
    }
  }
  const dim = unit?.dim ?? 'none';
  return { written: value, base: value * (unit?.factor ?? 1), dim };
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** A time of day, in minutes past twelve: `3:30`, `3.30` (when `loose`), `half past three`, `quarter to 4`, `5 o'clock`. */
function clockOf(input: string, loose: boolean): number | null {
  const text = input.toLowerCase().replace(/[.!?]+$/, '').trim();
  const digital = (loose ? /^(\d{1,2})[:.](\d{2})$/ : /^(\d{1,2}):(\d{2})$/).exec(text);
  if (digital?.[1] !== undefined && digital[2] !== undefined) {
    const hour = Number(digital[1]);
    const minute = Number(digital[2]);
    return hour > 23 || minute > 59 ? null : (hour % 12) * 60 + minute;
  }
  const spoken = /^(half|quarter) (past|to) (.+)$/.exec(text);
  const oclock = /^(.+?) o'?clock$/.exec(text);
  const hourWord = (word: string): number | null => {
    if (/^\d{1,2}$/.test(word)) return Number(word);
    const read = numberWords(word.split(/\s+/));
    return read === null ? null : read.value;
  };
  if (spoken?.[1] !== undefined && spoken[2] !== undefined && spoken[3] !== undefined) {
    const hour = hourWord(spoken[3]);
    if (hour === null || hour < 1 || hour > 12) return null;
    const minutes = spoken[1] === 'half' ? 30 : spoken[2] === 'past' ? 15 : 45;
    return spoken[2] === 'to' ? ((hour - 1 + 12) % 12) * 60 + minutes : (hour % 12) * 60 + minutes;
  }
  if (oclock?.[1] !== undefined) {
    const hour = hourWord(oclock[1]);
    return hour === null || hour < 1 || hour > 12 ? null : (hour % 12) * 60;
  }
  return null;
}

function normalWords(input: string): string {
  const words = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  while (words.length > 1 && (words[0] === 'a' || words[0] === 'an' || words[0] === 'the')) words.shift();
  return words.map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)).join(' ');
}

/**
 * Whether `given` is the answer `accepted` says. Numbers are compared as numbers (`60`, `60.0`, `sixty`, `60 flowers`), money and units as
 * what they measure (`£1.50`, `1.5`, `150p`; `30 cm`, `0.3 m`), a time of day as a time, and anything else as the same words once case,
 * punctuation, a leading `a`/`the` and a plural `s` are let go. A bare number is right for an answer with a unit, and the other way round;
 * a unit of another kind is wrong. `unit` is the ask's own unit, which a typed unit is read against.
 */
export function matchAnswer(accepted: string, given: string, unit: string | null = null): boolean {
  const wanted = clockOf(accepted, false);
  if (wanted !== null) {
    const typed = clockOf(given, true);
    return typed !== null && typed === wanted;
  }
  const a = parseQuantity(accepted);
  const g = parseQuantity(given);
  if (a !== null && g !== null) {
    if (a.dim === 'none' && g.dim === 'none') return sameNumber(a.written, g.written);
    if (a.dim === g.dim) return sameNumber(a.base, g.base);
    if (a.dim === 'none') {
      const asked = unit === null ? null : unitOf(unit.toLowerCase());
      if (asked !== null && asked.dim === g.dim) return sameNumber(g.base / asked.factor, a.written);
      return asked === null && sameNumber(a.written, g.written);
    }
    if (g.dim === 'none') {
      // a bare number is in the ask's own unit when it has one: `1` is a centimetre, not the `1m` an ask for centimetres also accepts
      const asked = unit === null ? null : unitOf(unit.toLowerCase());
      if (asked !== null && asked.dim === a.dim) return sameNumber(g.written * asked.factor, a.base);
      return sameNumber(g.written, a.written) || sameNumber(g.written, a.base);
    }
    return false;
  }
  if (a !== null || g !== null) return false;
  const left = normalWords(accepted);
  return left !== '' && left === normalWords(given);
}

/** Whether the typed or chosen `text` is accepted by any answer of `ask`. */
export function accepts(ask: Pick<LessonAsk, 'accepted' | 'unit'>, text: string): boolean {
  const given = text.trim();
  return given !== '' && ask.accepted.some((answer) => matchAnswer(answer, given, ask.unit));
}

// --- the spoiler -------------------------------------------------------------------------------------------------------------------

const NUMERIC_G = /[£$€]?-?\d[\d,]*(?:\.\d+)?(?:\s?\/\s?\d+)?(?:\s?(?:%|[a-z]{1,14}))?/gi;
const TIME_G = /\b\d{1,2}[:.]\d{2}\b|\b(?:half|quarter) (?:past|to) \w+\b|\b\w+ o'?clock\b/gi;

/** Every stretch of `text` that could be a number or a quantity, with each written as it could be matched. */
function numericCandidates(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(NUMERIC_G)) {
    const found = match[0].trim();
    out.push(found);
    // `10-20` reads as 10 and -20; either way the 20 is there
    if (found.startsWith('-')) out.push(found.slice(1));
    // the number alone, without the word after it
    const bare = /^([£$€]?-?\d[\d,]*(?:\.\d+)?)/.exec(found);
    if (bare?.[1] !== undefined && bare[1] !== found) out.push(bare[1]);
  }
  const tokens = text.toLowerCase().split(/[^a-z']+/).filter((token) => token !== '');
  for (let index = 0; index < tokens.length; index += 1) {
    const read = numberWords(tokens.slice(index));
    if (read !== null && read.used > 0) {
      out.push(String(read.value));
      index += read.used - 1;
    }
  }
  return out;
}

/** The numbers of the `{…}` expressions in `text` that need no control to be known: `{5*12}` is 60. */
function constantExpressions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
    const expr = parseExpr(match[1] ?? '');
    if (expr !== null && namesIn(expr).length === 0) {
      const value = evalExpr(expr, {});
      if (Number.isFinite(value)) out.push(canonicalNumber(value));
    }
  }
  return out;
}

/** Whether `text` holds `accepted`: a number or a quantity anywhere in it, a time of day, a constant expression, or the words as a phrase. */
export function textHolds(text: string, accepted: string, unit: string | null = null): boolean {
  const plain = plainText(text);
  if (clockOf(accepted, false) !== null) return [...plain.matchAll(TIME_G)].some((match) => matchAnswer(accepted, match[0], unit));
  if (parseQuantity(accepted) !== null) {
    return [...numericCandidates(plain), ...constantExpressions(plain)].some((candidate) => matchAnswer(accepted, candidate, unit));
  }
  const phrase = normalWords(accepted);
  return phrase !== '' && ` ${normalWords(plain)} `.includes(` ${phrase} `);
}

/**
 * Whether `value`, a number or a string a drawer is about to show (a word, a readout, a computed `{expression}`, a widget's label), is an answer
 * an open ask accepts. Whatever draws calls this, and draws a gap in its place: a readout may show partial work ("2 vases: 12 + 12") and never
 * the total.
 */
export function sealed(value: number | string, openAsks: readonly OpenAsk[]): boolean {
  if (openAsks.length === 0) return false;
  const text = typeof value === 'number' ? (Number.isFinite(value) ? canonicalNumber(value) : '') : value.trim();
  if (text === '') return false;
  return openAsks.some((ask) => ask.accepted.some((answer) => matchAnswer(answer, text, ask.unit)));
}

/** `text` with every number, quantity or phrase that an open ask accepts replaced by `mask`. For words the drawer cannot ask about one at a time. */
export function maskSealed(text: string, openAsks: readonly OpenAsk[], mask = '?'): string {
  if (openAsks.length === 0) return text;
  let out = text.replace(/\{([^{}]+)\}/g, (whole, source: string) => {
    const expr = parseExpr(source);
    if (expr === null || namesIn(expr).length > 0) return whole;
    return sealed(evalExpr(expr, {}), openAsks) ? mask : whole;
  });
  out = out.replace(NUMERIC_G, (found) => {
    const bare = /^[£$€]?-?\d[\d,]*(?:\.\d+)?/.exec(found)?.[0] ?? found;
    return sealed(found.trim(), openAsks) || sealed(bare, openAsks) ? found.replace(bare, mask) : found;
  });
  for (const ask of openAsks) {
    for (const answer of ask.accepted) {
      if (parseQuantity(answer) !== null || clockOf(answer, false) !== null) continue;
      const phrase = answer.trim();
      if (phrase === '') continue;
      out = out.replace(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), mask);
    }
  }
  return out;
}

/** Where an accepted answer was found on a page that would show it. */
export interface Spoiler {
  /** the step or hint it was in (a title has none) */
  readonly in: string | null;
  readonly where: 'step' | 'picture' | 'hint' | 'prompt' | 'title';
  /** the accepted answer */
  readonly answer: string;
  /** the words, or the picture's parameter, that held it */
  readonly text: string;
}

/** The words a question is written in, and the words of the way it is being done in: what is on every page of a lesson, before any step. */
export interface LessonContext {
  /** the question as it was set: its answers may be in it (`64 − 30 = ?` and an answer of 30 is no secret) */
  readonly question: readonly string[];
  /** the title of the way, which is the brain's and is on screen the whole time */
  readonly way: string | null;
}

function stepTexts(step: LessonReveal): { readonly where: 'step' | 'picture'; readonly text: string }[] {
  const out: { where: 'step' | 'picture'; text: string }[] = [];
  if (step.words !== '') out.push({ where: 'step', text: step.words });
  if (step.show !== null) {
    // The span's ends are the ruler's: they say how far it goes, not where to land. Everything else a picture is told is on it.
    for (const [key, value] of Object.entries(step.show.args)) {
      const kind = paramKinds(step.show.visual)[key];
      if (kind === 'number' || kind === 'numbers') out.push({ where: 'picture', text: value.split(',').filter((part) => part !== '?').join(' ; ') });
      else if (kind === 'word' && key !== 'mode') out.push({ where: 'picture', text: value.replaceAll('_', ' ') });
    }
  }
  return out;
}

/** What each accepted answer of `ask` is found in, among what is on the page when the ask opens: the way's title, every step before it, its own words and its hints. */
function spoilersBefore(ask: LessonAsk, before: readonly LessonStep[], context: LessonContext): Spoiler[] {
  const found: Spoiler[] = [];
  for (const answer of ask.accepted) {
    // a number the question itself is made of is no secret, so a step may use it
    if (context.question.some((words) => textHolds(words, answer, ask.unit))) continue;
    if (context.way !== null && textHolds(context.way, answer, ask.unit)) found.push({ in: null, where: 'title', answer, text: context.way });
    for (const step of before) {
      if (step.kind === 'step') {
        for (const item of stepTexts(step)) if (textHolds(item.text, answer, ask.unit)) found.push({ in: step.id, where: item.where, answer, text: item.text });
      } else if (textHolds(step.prompt, answer, ask.unit)) {
        found.push({ in: step.id, where: 'prompt', answer, text: step.prompt });
      } else {
        for (const hint of step.hints) if (textHolds(hint, answer, ask.unit)) found.push({ in: step.id, where: 'hint', answer, text: hint });
      }
    }
    if (textHolds(ask.prompt, answer, ask.unit)) found.push({ in: ask.id, where: 'prompt', answer, text: ask.prompt });
    for (const hint of ask.hints) if (textHolds(hint, answer, ask.unit)) found.push({ in: ask.id, where: 'hint', answer, text: hint });
  }
  return found;
}

/**
 * Every answer of every ask of a whole lesson that is on the page while it is open (2.8 `no spoiler`, the layer that reads the whole). What
 * follows an ask is not on the page while it is open, so it is not read against it.
 */
export function lintLesson(steps: readonly LessonStep[], context: LessonContext): Spoiler[] {
  const found: Spoiler[] = [];
  steps.forEach((step, index) => {
    if (step.kind === 'ask') found.push(...spoilersBefore(step, steps.slice(0, index), context));
  });
  return found;
}

function quoted(text: string): string {
  const cut = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return `"${cut}"`;
}

/** What the brain is told when a lesson is refused, naming the line to write again. */
export function spoilerMessage(ask: string, found: readonly Spoiler[]): string {
  const first = found[0];
  if (first === undefined) return '';
  const where =
    first.where === 'title'
      ? 'the title of its part'
      : first.where === 'hint'
        ? `hint of ${first.in ?? ask}`
        : first.where === 'prompt'
          ? `the words of ask ${first.in ?? ask}`
          : first.where === 'picture'
            ? `the picture of step ${first.in ?? '?'}`
            : `step ${first.in ?? '?'}`;
  const again = first.where === 'step' || first.where === 'picture' ? `; write step ${first.in ?? '?'} again (the same id replaces it) without ${first.answer}, then the ask` : '; write it again without it, then the ask';
  const others = found.length > 1 ? `, and ${found.length - 1} more place${found.length === 2 ? '' : 's'}` : '';
  return `ask ${ask} is refused: ${where} (${quoted(first.text)}) already shows ${first.answer}, which the ask accepts${others}. The learner would see the answer before trying${again}`;
}

// --- the book: parts, steps and asks as they are written ---------------------------------------------------------------------------

interface PartRecord {
  readonly id: string;
  readonly parent: string | null;
  title: string;
  tag: TechniqueId | null;
  crop: Crop | null;
  readonly children: string[];
  steps: LessonStep[];
}

export interface LessonRead {
  /** the line made explicit, or null when it was refused */
  readonly line: LessonLine | null;
  readonly issues: readonly Issue[];
}

function issue(code: IssueCode, severity: 'error' | 'warn', message: string, token?: string): Issue {
  return token === undefined ? { code, severity, message } : { code, severity, message, token };
}

/** A part as the book holds it, for whoever builds the document. */
export interface BookPart {
  readonly id: string;
  readonly parent: string | null;
  readonly title: string;
  readonly tag: TechniqueId | null;
  readonly crop: Crop | null;
  readonly children: readonly string[];
  readonly steps: readonly LessonStep[];
}

/**
 * Reads the lesson lines of one conversation in order and makes each explicit: the part it sits in (`in=`), an id where none was written,
 * the ask a hint belongs to. It also refuses what cannot be taught: a part that sits in nothing, a step with no part, an ask no one can answer,
 * and an ask or a hint that would put an accepted answer on the page before it is tried. A refused line is `null` with the reason, which is
 * what the brain is told. Reading a line that is already explicit gives the same line, so the document's fold uses it too.
 */
export class LessonBook {
  private readonly records = new Map<string, PartRecord>();
  private readonly order: string[] = [];
  /** an ask's id, which is unique in the document, to the part it is in */
  private readonly asks = new Map<string, string>();
  /** the id an ask was written with in a part, to its unique id: the brain reuses `a1` in every way */
  private readonly written = new Map<string, string>();
  private open: readonly string[] = [];
  private readonly makeId: () => string;

  constructor(makeId: () => string) {
    this.makeId = makeId;
  }

  part(id: string): BookPart | null {
    return this.records.get(id) ?? null;
  }

  /** The parts in the order they were first written. */
  parts(): readonly BookPart[] {
    return this.order.flatMap((id) => {
      const record = this.records.get(id);
      return record === undefined ? [] : [record];
    });
  }

  /** The first part written: the root of the document. */
  root(): string | null {
    return this.order[0] ?? null;
  }

  /** The part a lesson line would land in, without reading it: null for a line that lands in no part. */
  where(line: LessonLine): string | null {
    switch (line.verb) {
      case 'part':
        return line.id;
      case 'step':
      case 'ask':
        return line.in ?? this.current();
      case 'hint':
        return line.in === undefined ? null : (this.asks.get(line.in) ?? this.askFor(line.in)?.part.id ?? null);
      default:
        return null;
    }
  }

  /** Sends a part back to be written again: its steps and asks go, its children stay. */
  reset(id: string): void {
    const part = this.records.get(id);
    if (part === undefined) return;
    for (const step of part.steps) {
      if (step.kind !== 'ask') continue;
      this.asks.delete(step.id);
      for (const key of [...this.written.keys()]) if (this.written.get(key) === step.id) this.written.delete(key);
    }
    part.steps = [];
  }

  /** The part an ask is in. */
  partOfAsk(ask: string): string | null {
    return this.asks.get(ask) ?? null;
  }

  /** The ids from the first part down to `id`. */
  path(id: string): readonly string[] {
    const out: string[] = [];
    let at: string | null = id;
    while (at !== null && out.length <= LESSON_LIMITS.depth + 1) {
      out.unshift(at);
      at = this.records.get(at)?.parent ?? null;
    }
    return out;
  }

  /** What the page of a lesson is made of before any step: the words the question was set in, and the way's own title. */
  contextOf(id: string): LessonContext {
    const chain = this.path(id).flatMap((part) => {
      const record = this.records.get(part);
      return record === undefined ? [] : [record];
    });
    const firstWay = chain.findIndex((record) => record.tag !== null);
    if (firstWay < 0) return { question: chain.map((record) => record.title), way: null };
    const way = chain.slice(firstWay).map((record) => record.title).join(' · ');
    return { question: chain.slice(0, firstWay).map((record) => record.title), way };
  }

  read(line: LessonLine): LessonRead {
    switch (line.verb) {
      case 'part':
        return this.readPart(line);
      case 'step':
        return this.readStep(line);
      case 'ask':
        return this.readAsk(line);
      case 'hint':
        return this.readHint(line);
      case 'reply':
        return { line, issues: [] };
      case 'end': {
        if (this.open.length === 0) return { line, issues: [issue('nothing-to-do', 'warn', 'end closes a part, and none is open')] };
        this.open = this.open.slice(0, -1);
        return { line, issues: [] };
      }
    }
  }

  private refuse(code: IssueCode, message: string, token?: string): LessonRead {
    return { line: null, issues: [issue(code, 'error', message, token)] };
  }

  private current(): string | null {
    return this.open[this.open.length - 1] ?? null;
  }

  private readPart(line: PartLine): LessonRead {
    const issues: Issue[] = [];
    const known = this.records.get(line.id);
    // The first part written is the document's root; a part that sits in nothing else is a child of it.
    const parent = line.in ?? (known === undefined ? (this.current() ?? this.order[0] ?? null) : known.parent);
    if (line.in !== undefined && !this.records.has(line.in)) {
      return this.refuse('unknown-id', `part ${line.id} sits in "${line.in}", and no part is called that; write the part it sits in first`, line.in);
    }
    if (known !== undefined) {
      if (line.in !== undefined && line.in !== known.parent) issues.push(issue('bad-value', 'warn', `part ${line.id} already sits in ${known.parent ?? 'the document'}; it stays there`, line.in));
      known.title = line.title;
      if (line.tag !== undefined) known.tag = line.tag;
      if (line.crop !== undefined) known.crop = line.crop;
    } else {
      if (this.records.size >= LESSON_LIMITS.parts) return this.refuse('element-limit', `at most ${LESSON_LIMITS.parts} parts in one document`);
      const depth = parent === null ? 1 : this.path(parent).length + 1;
      if (depth > LESSON_LIMITS.depth) return this.refuse('structure-limit', `parts sit at most ${LESSON_LIMITS.depth} deep; ${line.id} would be ${depth}`);
      this.records.set(line.id, { id: line.id, parent, title: line.title, tag: line.tag ?? null, crop: line.crop ?? null, children: [], steps: [] });
      this.order.push(line.id);
      if (parent !== null) this.records.get(parent)?.children.push(line.id);
    }
    const at = known === undefined ? parent : known.parent;
    this.open = [...(at === null ? [] : this.path(at)), line.id];
    const record = this.records.get(line.id);
    const tag = record?.tag ?? null;
    const crop = record?.crop ?? null;
    return { line: { verb: 'part', id: line.id, ...(at === null ? {} : { in: at }), ...(tag === null ? {} : { tag }), ...(crop === null ? {} : { crop }), title: line.title }, issues };
  }

  /** The part a step or an ask goes in: the one it names, else the one last written. */
  private target(named: string | undefined, verb: string): { part: PartRecord } | { refused: LessonRead } {
    const id = named ?? this.current();
    if (id === null) return { refused: this.refuse('no-part', `${verb} has no part to belong to; write a part first, or say in=<part>`) };
    const part = this.records.get(id);
    if (part === undefined) return { refused: this.refuse('unknown-id', `${verb} sits in "${id}", and no part is called that; write the part first`, id) };
    return { part };
  }

  private readStep(line: StepLine): LessonRead {
    const target = this.target(line.in, 'step');
    if ('refused' in target) return target.refused;
    const { part } = target;
    const id = line.id === '-' ? this.makeId() : line.id;
    const step: LessonReveal = { kind: 'step', id, show: line.show ?? null, words: line.text };
    const at = part.steps.findIndex((existing) => existing.id === id);
    if (at >= 0) {
      if (part.steps[at]?.kind !== 'step') return this.refuse('bad-id', `${id} is an ask in ${part.id}; a step needs an id of its own`, id);
      part.steps[at] = step;
    } else {
      if (part.steps.length >= LESSON_LIMITS.steps) return this.refuse('element-limit', `at most ${LESSON_LIMITS.steps} steps and asks in one part`);
      part.steps.push(step);
    }
    this.open = this.path(part.id);
    return { line: { verb: 'step', id, in: part.id, ...(line.show === undefined ? {} : { show: line.show }), text: line.text }, issues: [] };
  }

  private readAsk(line: AskLine): LessonRead {
    const target = this.target(line.in, 'ask');
    if ('refused' in target) return target.refused;
    const { part } = target;
    const accepted = line.is.slice(0, LESSON_LIMITS.accepted);
    if (accepted.length === 0) return this.refuse('bad-ask', 'an ask needs is=<answer>');
    const pick = line.pick ?? null;
    if (pick !== null) {
      if (pick.length < 2) return this.refuse('bad-ask', `pick= needs at least two choices; ask ${line.id} has ${pick.length}`);
      if (!accepted.some((answer) => pick.some((choice) => matchAnswer(answer, choice, line.unit ?? null)))) {
        return this.refuse('bad-ask', `none of the choices in pick=${pick.join(',')} is an answer the ask accepts (${accepted.join(', ')}); the learner could not get it right`);
      }
    }
    const requested = line.id === '-' ? this.makeId() : line.id;
    const existing = this.written.get(`${part.id}\n${requested}`);
    let id = existing ?? requested;
    if (existing === undefined) {
      // an id taken by another part's ask is not the brain's to reuse: this one gets one of its own, and its hints are found by the part
      let n = 1;
      while (this.asks.has(id) || part.steps.some((step) => step.id === id)) {
        n += 1;
        id = `${requested.slice(0, LIMITS.name - 3)}-${n}`;
      }
    }
    const old = part.steps.findIndex((step) => step.id === id);
    if (old >= 0 && part.steps[old]?.kind !== 'ask') return this.refuse('bad-id', `${id} is a step in ${part.id}; an ask needs an id of its own`, id);
    const previous = old >= 0 ? part.steps[old] : undefined;
    const ask: LessonAsk = { kind: 'ask', id, prompt: line.text, accepted, pick, unit: line.unit ?? null, hints: previous?.kind === 'ask' ? previous.hints : [] };
    const before = old >= 0 ? part.steps.slice(0, old) : part.steps;
    const found = spoilersBefore(ask, before, this.contextOf(part.id));
    if (found.length > 0) return this.refuse('spoiler', spoilerMessage(id, found), found[0]?.answer);
    if (old >= 0) part.steps[old] = ask;
    else {
      if (part.steps.length >= LESSON_LIMITS.steps) return this.refuse('element-limit', `at most ${LESSON_LIMITS.steps} steps and asks in one part`);
      part.steps.push(ask);
    }
    this.asks.set(id, part.id);
    this.written.set(`${part.id}\n${requested}`, id);
    this.open = this.path(part.id);
    return {
      line: { verb: 'ask', id, in: part.id, is: accepted, ...(pick === null ? {} : { pick }), ...(line.unit === undefined ? {} : { unit: line.unit }), text: line.text },
      issues: [],
    };
  }

  /** The ask a hint is for: the one it names (by what it was written as in the open part, then by its own id), else the last ask of the open part. */
  private askFor(named: string | undefined): { part: PartRecord; index: number; ask: LessonAsk } | null {
    const here = this.current();
    let id: string | null = null;
    if (named !== undefined) {
      for (const part of here === null ? [] : [...this.path(here)].reverse()) {
        const local = this.written.get(`${part}\n${named}`);
        if (local !== undefined) {
          id = local;
          break;
        }
      }
      if (id === null && this.asks.has(named)) id = named;
    } else if (here !== null) {
      const steps = this.records.get(here)?.steps ?? [];
      id = [...steps].reverse().find((step) => step.kind === 'ask')?.id ?? null;
    }
    if (id === null) return null;
    const owner = this.asks.get(id);
    const part = owner === undefined ? undefined : this.records.get(owner);
    if (part === undefined) return null;
    const index = part.steps.findIndex((step) => step.id === id);
    const ask = part.steps[index];
    return ask?.kind === 'ask' ? { part, index, ask } : null;
  }

  private readHint(line: HintLine): LessonRead {
    const found = this.askFor(line.in);
    if (found === null) {
      return this.refuse('unknown-id', line.in === undefined ? 'hint has no ask to belong to; write the ask first' : `hint is for "${line.in}", and no ask is called that; write the ask first`, line.in);
    }
    const { part, index, ask } = found;
    const context = this.contextOf(part.id);
    const held = ask.accepted.filter((answer) => !context.question.some((words) => textHolds(words, answer, ask.unit)) && textHolds(line.text, answer, ask.unit));
    const first = held[0];
    if (first !== undefined) {
      return this.refuse('spoiler', `hint of ask ${ask.id} (${quoted(line.text)}) shows ${first}, which the ask accepts; a hint helps and never answers: say what to try, and write it again`, first);
    }
    if (ask.hints.length >= LESSON_LIMITS.hints) return this.refuse('element-limit', `at most ${LESSON_LIMITS.hints} hints on one ask`);
    part.steps[index] = { ...ask, hints: [...ask.hints, line.text] };
    return { line: { verb: 'hint', in: ask.id, text: line.text }, issues: [] };
  }
}
