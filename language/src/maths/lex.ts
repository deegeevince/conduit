// Reading a line of working, or the words of a question, into tokens. It is forgiving about how children and worksheets write things (`x` and `×`,
// `□` and `___`, `a.m.`, `forty two`, `2/3`, `1 1/2`, `$3.50`, `150p`, `1 m 25 cm`) and exact about what they mean: a number is made from its
// digits, never from a float.

import { Fail, q, qAdd, qDiv, qMul, qParse } from './rational';
import type { Q } from './rational';
import { isShortUnit, unitOf } from './units';
import type { Unit } from './units';

export type Op = '+' | '-' | '*' | '/';

export type Tok =
  | { readonly k: 'num'; readonly q: Q; readonly pct: boolean; readonly at: number; readonly end: number }
  | { readonly k: 'qty'; readonly q: Q; readonly unit: Unit; readonly at: number; readonly end: number }
  | { readonly k: 'clock'; readonly min: number; readonly resolved: boolean; readonly at: number; readonly end: number }
  | { readonly k: 'op'; readonly op: Op; readonly at: number; readonly end: number }
  | { readonly k: 'lp' | 'rp' | 'eq'; readonly at: number; readonly end: number }
  | { readonly k: 'gap'; readonly unit: Unit | null; readonly at: number; readonly end: number }
  | { readonly k: 'word'; readonly w: string; readonly at: number; readonly end: number }
  | { readonly k: 'punct'; readonly ch: string; readonly at: number; readonly end: number };

export interface LexOptions {
  /** `is`, `equals`, `makes` count as `=` (a learner's working: "half of 64 is 32") */
  readonly eqWords?: boolean;
}

const ONES: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Readonly<Record<string, bigint>> = { thousand: 1000n, million: 1_000_000n };

/** `forty two`, `a hundred and five`, `three thousand`: the longest run of number words at the start of `words`. */
function numberWords(words: readonly string[]): { readonly value: bigint; readonly used: number } | null {
  let i = 0;
  let total = 0n;
  let current = 0n;
  let any = false;
  const at = (n: number): string => words[i + n] ?? '';
  while (i < words.length) {
    const w = at(0);
    if (w === 'a' && (at(1) === 'hundred' || at(1) === 'thousand' || at(1) === 'million') && !any) {
      current = 1n;
      any = true;
      i += 1;
    } else if (Object.hasOwn(ONES, w)) {
      current += BigInt(ONES[w] ?? 0);
      any = true;
      i += 1;
    } else if (Object.hasOwn(TENS, w)) {
      current += BigInt(TENS[w] ?? 0);
      any = true;
      i += 1;
    } else if (w === 'hundred' && any) {
      current = (current === 0n ? 1n : current) * 100n;
      i += 1;
    } else if (Object.hasOwn(SCALES, w) && any) {
      total += (current === 0n ? 1n : current) * (SCALES[w] ?? 1n);
      current = 0n;
      i += 1;
    } else if (w === 'and' && any && (Object.hasOwn(ONES, at(1)) || Object.hasOwn(TENS, at(1)))) {
      i += 1;
    } else break;
  }
  return any ? { value: total + current, used: i } : null;
}

const FRACTION_WORDS: Readonly<Record<string, bigint>> = {
  half: 2n, halves: 2n, third: 3n, thirds: 3n, quarter: 4n, quarters: 4n, fifth: 5n, fifths: 5n, sixth: 6n, sixths: 6n, eighth: 8n, eighths: 8n, tenth: 10n, tenths: 10n,
};
const GLYPHS: Readonly<Record<string, readonly [number, number]>> = {
  '½': [1, 2], '⅓': [1, 3], '⅔': [2, 3], '¼': [1, 4], '¾': [3, 4], '⅕': [1, 5], '⅖': [2, 5], '⅗': [3, 5], '⅘': [4, 5], '⅙': [1, 6], '⅛': [1, 8], '⅜': [3, 8], '⅝': [5, 8], '⅞': [7, 8],
};
const EQ_WORDS: ReadonlySet<string> = new Set(['equals', 'is', 'makes', 'gives', 'leaves', 'equal']);

const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+/y;

function sticky(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

const CLOCK_COLON = /(\d{1,2}):(\d{2})(?!\d)/y;
const CLOCK_DOT = /(\d{1,2})\.(\d{2})\s*(?=a\.?m\b|p\.?m\b)/y;
const MERIDIEM = /\s*([ap])\.?m\b\.?/y;
const HOUR_MERIDIEM = /(\d{1,2})\s*([ap])\.?m\b\.?/y;
const OCLOCK = /(\d{1,2})\s*o'?clock\b/y;

function clockTok(hour: number, minute: number, mer: string | null, at: number, end: number): Tok {
  if (minute > 59) throw new Fail('unreadable', `${hour}:${String(minute).padStart(2, '0')} is not a time`);
  if (mer !== null) {
    if (hour < 1 || hour > 12) throw new Fail('unreadable', `${hour}:${String(minute).padStart(2, '0')} ${mer}m is not a time`);
    return { k: 'clock', min: ((hour % 12) + (mer === 'p' ? 12 : 0)) * 60 + minute, resolved: true, at, end };
  }
  if (hour > 23) throw new Fail('unreadable', `${hour}:${String(minute).padStart(2, '0')} is not a time`);
  // 13:05 and 00:30 can only be the 24-hour clock; 9:15 could be either half of the day
  if (hour >= 13 || hour === 0) return { k: 'clock', min: hour * 60 + minute, resolved: true, at, end };
  return { k: 'clock', min: (hour % 12) * 60 + minute, resolved: false, at, end };
}

/** The longest line it will read as working or as a question's words. */
export const MAX_LINE = 1500;

const isValue = (t: Tok | undefined): boolean => t !== undefined && (t.k === 'num' || t.k === 'qty' || t.k === 'clock' || t.k === 'gap' || t.k === 'rp');

export function lex(source: string, options: LexOptions = {}): Tok[] {
  if (source.length > MAX_LINE) throw new Fail('too-big', `a line of more than ${MAX_LINE} characters is not a sum`);
  const text = source.replace(/[−–—‐‑]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const lower = text.toLowerCase();
  const out: Tok[] = [];
  let i = 0;
  const push = (t: Tok): void => void out.push(t);
  const last = (): Tok | undefined => out[out.length - 1];

  while (i < text.length) {
    const c = lower[i] ?? '';
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    // money in front of the number: $3.50, £ 2, €10, ¢50
    if (c === '$' || c === '£' || c === '€' || c === '¢') {
      const unit = unitOf(c);
      const num = sticky(NUMBER, lower, skip(lower, i + 1));
      if (unit !== null && num !== null) {
        const value = qParse(num[0]);
        if (value !== null) {
          push({ k: 'qty', q: value, unit, at: i, end: num.index + num[0].length });
          i = num.index + num[0].length;
          continue;
        }
      }
      if (unit !== null) push({ k: 'word', w: c, at: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (/\d/.test(c) || (c === '.' && /\d/.test(lower[i + 1] ?? ''))) {
      const start = i;
      // times: 9:15, 9:15 a.m., 9.15am, 5 pm, 3 o'clock
      const colon = sticky(CLOCK_COLON, lower, i);
      if (colon !== null) {
        const mer = sticky(MERIDIEM, lower, colon.index + colon[0].length);
        const end = mer === null ? colon.index + colon[0].length : mer.index + mer[0].length;
        push(clockTok(Number(colon[1]), Number(colon[2]), mer === null ? null : (mer[1] ?? null), start, end));
        i = end;
        continue;
      }
      const dot = sticky(CLOCK_DOT, lower, i);
      if (dot !== null) {
        const mer = sticky(MERIDIEM, lower, dot.index + dot[0].length);
        if (mer !== null) {
          const end = mer.index + mer[0].length;
          push(clockTok(Number(dot[1]), Number(dot[2]), mer[1] ?? null, start, end));
          i = end;
          continue;
        }
      }
      const hourMer = sticky(HOUR_MERIDIEM, lower, i);
      if (hourMer !== null) {
        const end = hourMer.index + hourMer[0].length;
        push(clockTok(Number(hourMer[1]), 0, hourMer[2] ?? null, start, end));
        i = end;
        continue;
      }
      const oclock = sticky(OCLOCK, lower, i);
      if (oclock !== null) {
        const end = oclock.index + oclock[0].length;
        push(clockTok(Number(oclock[1]), 0, null, start, end));
        i = end;
        continue;
      }

      const num = sticky(NUMBER, lower, i);
      if (num === null) {
        i += 1;
        continue;
      }
      let value = qParse(num[0]);
      if (value === null) throw new Fail('unreadable', `"${num[0]}" is not a number`);
      let end = num.index + num[0].length;
      const whole = /^\d+$/.test(num[0]);
      const slash = whole ? sticky(/\/(\d+)(?!\d)/y, lower, end) : null;
      if (slash !== null) {
        const bottom = BigInt(slash[1] ?? '1');
        if (bottom === 0n) throw new Fail('zero', `${num[0]}/0 is dividing by zero`);
        value = q(BigInt(num[0]), bottom);
        end = slash.index + slash[0].length;
      } else if (whole) {
        const mixed = sticky(/\s+(\d+)\/(\d+)(?!\d)/y, lower, end);
        if (mixed !== null && BigInt(mixed[1] ?? '0') < BigInt(mixed[2] ?? '1') && BigInt(mixed[2] ?? '0') !== 0n) {
          value = qAdd(value, q(BigInt(mixed[1] ?? '0'), BigInt(mixed[2] ?? '1')));
          end = mixed.index + mixed[0].length;
        } else {
          const glyph = sticky(/\s?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅛⅜⅝⅞])/y, lower, end);
          if (glyph !== null) {
            const [n, d] = GLYPHS[glyph[1] ?? ''] ?? [0, 1];
            value = qAdd(value, q(n, d));
            end = glyph.index + glyph[0].length;
          }
        }
      }
      const parts = whole ? sticky(/\s+(halves|thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)(?![a-z])/y, lower, end) : null;
      if (parts !== null && Object.hasOwn(FRACTION_WORDS, parts[1] ?? '')) {
        value = qDiv(value, q(FRACTION_WORDS[parts[1] ?? ''] ?? 1n));
        end = parts.index + parts[0].length;
      }
      const percent = sticky(/\s?%/y, lower, end);
      if (percent !== null) {
        push({ k: 'num', q: value, pct: true, at: start, end: percent.index + percent[0].length });
        i = percent.index + percent[0].length;
        continue;
      }
      // a unit straight after: `30 cm`, `150p`, `2 hours`, `3 weeks`
      const word = sticky(/ ?([a-z£$€¢]+)(?![a-z0-9])/y, lower, end);
      if (word !== null) {
        const unit = unitOf(word[1] ?? '');
        if (unit !== null) {
          const after = word.index + word[0].length;
          push({ k: 'qty', q: value, unit, at: start, end: after });
          i = after;
          continue;
        }
      }
      push({ k: 'num', q: value, pct: false, at: start, end });
      i = end;
      continue;
    }

    if (c in GLYPHS) {
      const [n, d] = GLYPHS[c] ?? [0, 1];
      push({ k: 'num', q: q(n, d), pct: false, at: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (/[a-z]/.test(c)) {
      const match = sticky(/[a-z]+(?:'[a-z]+)?/y, lower, i);
      const w = match?.[0] ?? c;
      const start = i;

      // half past three, quarter to 4
      if ((w === 'half' || w === 'quarter') && /^\s+(past|to)\s+/.test(lower.slice(i + w.length))) {
        const rest = sticky(/\s+(past|to)\s+/y, lower, i + w.length);
        if (rest !== null) {
          const hourStart = rest.index + rest[0].length;
          const digits = sticky(/\d{1,2}(?!\d)/y, lower, hourStart);
          let hour: number | null = null;
          let hourEnd = hourStart;
          if (digits !== null) {
            hour = Number(digits[0]);
            hourEnd = hourStart + digits[0].length;
          } else {
            const words = collectWords(lower, hourStart);
            const read = numberWords(words.map((x) => x.w));
            if (read !== null && read.value >= 1n && read.value <= 12n) {
              hour = Number(read.value);
              hourEnd = words[read.used - 1]?.end ?? hourStart;
            }
          }
          if (hour !== null && hour >= 1 && hour <= 12) {
            const minutes = w === 'half' ? 30 : rest[1] === 'past' ? 15 : 45;
            const base = rest[1] === 'to' ? ((hour + 10) % 12) * 60 + minutes : (hour % 12) * 60 + minutes;
            push({ k: 'clock', min: base, resolved: false, at: start, end: hourEnd });
            i = hourEnd;
            continue;
          }
        }
      }
      if (w === 'noon' || w === 'midday') {
        push({ k: 'clock', min: 720, resolved: true, at: i, end: i + w.length });
        i += w.length;
        continue;
      }
      if (w === 'midnight') {
        push({ k: 'clock', min: 0, resolved: true, at: i, end: i + w.length });
        i += w.length;
        continue;
      }

      // number words: forty two, a hundred and five
      const startsNumber = Object.hasOwn(ONES, w) || Object.hasOwn(TENS, w) || (w === 'a' && /^\s+(hundred|thousand|million)\b/.test(lower.slice(i + 1)));
      if (startsNumber) {
        const words = collectWords(lower, i);
        const read = numberWords(words.map((x) => x.w));
        if (read !== null) {
          const end = words[read.used - 1]?.end ?? i + w.length;
          let value = q(read.value);
          let stop = end;
          // `nine o'clock`
          const oclock = value.n >= 1n && value.n <= 12n ? sticky(/\s+o'?clock\b/y, lower, end) : null;
          if (oclock !== null) {
            const stopAt = oclock.index + oclock[0].length;
            push({ k: 'clock', min: (Number(value.n) % 12) * 60, resolved: false, at: start, end: stopAt });
            i = stopAt;
            continue;
          }
          // `two thirds`, `three quarters`, `one half`
          const next = sticky(/\s+(halves|half|thirds?|quarters?|fifths?|sixths?|eighths?|tenths?)(?![a-z])/y, lower, end);
          if (next !== null && Object.hasOwn(FRACTION_WORDS, next[1] ?? '')) {
            value = qDiv(value, q(FRACTION_WORDS[next[1] ?? ''] ?? 1n));
            stop = next.index + next[0].length;
          }
          push({ k: 'num', q: value, pct: false, at: start, end: stop });
          i = stop;
          continue;
        }
      }

      i += w.length;

      // `a quarter`, `a third`, `quarter`: a fraction on its own (`half` is left for the reader: `half of`, `half a litre`)
      if (Object.hasOwn(FRACTION_WORDS, w) && w !== 'half' && w !== 'halves') {
        const before = last();
        let at = start;
        if (before !== undefined && before.k === 'word' && (before.w === 'a' || before.w === 'an')) {
          out.pop();
          at = before.at;
        }
        push({ k: 'num', q: q(1, FRACTION_WORDS[w] ?? 1n), pct: false, at, end: i });
        continue;
      }
      if (w === 'half') {
        // half a litre, half an hour
        const a = sticky(/\s+(?:a|an)\s+([a-z]+)(?![a-z])/y, lower, i);
        const unit = a === null ? null : unitOf(a[1] ?? '');
        if (a !== null && unit !== null) {
          push({ k: 'qty', q: q(1, 2), unit, at: start, end: a.index + a[0].length });
          i = a.index + a[0].length;
          continue;
        }
        push({ k: 'word', w, at: start, end: i });
        continue;
      }

      const prev = last();
      if ((w === 'a' || w === 'an') && prev !== undefined && prev.k === 'word' && ['of', 'half', 'in', 'is', 'are', 'make', 'per'].includes(prev.w)) {
        const unitWord = sticky(/\s+([a-z]+)(?![a-z])/y, lower, i);
        const unit = unitWord === null ? null : unitOf(unitWord[1] ?? '');
        if (unitWord !== null && unit !== null && !isShortUnit(unitWord[1] ?? '')) {
          push({ k: 'qty', q: q(1), unit, at: start, end: unitWord.index + unitWord[0].length });
          i = unitWord.index + unitWord[0].length;
          continue;
        }
      }

      if (w === 'x' && isValue(last())) {
        push({ k: 'op', op: '*', at: start, end: i });
        continue;
      }
      if (w === 'plus') {
        push({ k: 'op', op: '+', at: start, end: i });
        continue;
      }
      if (w === 'minus') {
        push({ k: 'op', op: '-', at: start, end: i });
        continue;
      }
      if (w === 'times') {
        push({ k: 'op', op: '*', at: start, end: i });
        continue;
      }
      if (w === 'multiplied' || w === 'divided') {
        const by = sticky(/\s+by(?![a-z])/y, lower, i);
        if (by !== null) {
          push({ k: 'op', op: w === 'multiplied' ? '*' : '/', at: start, end: by.index + by[0].length });
          i = by.index + by[0].length;
          continue;
        }
      }
      if (w === 'take') {
        const away = sticky(/\s+away(?![a-z])/y, lower, i);
        if (away !== null) {
          push({ k: 'op', op: '-', at: start, end: away.index + away[0].length });
          i = away.index + away[0].length;
          continue;
        }
      }
      if (w === 'lots' || w === 'groups' || w === 'sets') {
        const of = sticky(/\s+of(?![a-z])/y, lower, i);
        if (of !== null) {
          push({ k: 'op', op: '*', at: start, end: of.index + of[0].length });
          i = of.index + of[0].length;
          continue;
        }
      }
      if (options.eqWords === true && EQ_WORDS.has(w) && last() !== undefined) {
        push({ k: 'eq', at: start, end: i });
        continue;
      }
      push({ k: 'word', w, at: start, end: i });
      continue;
    }

    switch (c) {
      case '+':
        push({ k: 'op', op: '+', at: i, end: i + 1 });
        break;
      case '-':
        push({ k: 'op', op: '-', at: i, end: i + 1 });
        break;
      case '*':
      case '×':
      case '✕':
      case '✖':
      case '⋅':
        push({ k: 'op', op: '*', at: i, end: i + 1 });
        break;
      case '/':
      case '÷':
        push({ k: 'op', op: '/', at: i, end: i + 1 });
        break;
      case '(': {
        const empty = sticky(/\(\s*\)/y, lower, i);
        if (empty !== null) {
          i = gapAt(text, lower, out, i, empty.index + empty[0].length);
          continue;
        }
        push({ k: 'lp', at: i, end: i + 1 });
        break;
      }
      case ')':
        push({ k: 'rp', at: i, end: i + 1 });
        break;
      case '=':
      case '＝':
        push({ k: 'eq', at: i, end: i + 1 });
        break;
      case '□':
      case '▢':
      case '◻':
      case '☐':
      case '⬜':
      case '?':
        i = gapAt(text, lower, out, i, i + 1);
        continue;
      case '_': {
        const run = sticky(/_+/y, lower, i);
        i = gapAt(text, lower, out, i, i + (run?.[0].length ?? 1));
        continue;
      }
      case '[': {
        const box = sticky(/\[\s*\]/y, lower, i);
        if (box !== null) {
          i = gapAt(text, lower, out, i, box.index + box[0].length);
          continue;
        }
        push({ k: 'punct', ch: c, at: i, end: i + 1 });
        break;
      }
      default:
        push({ k: 'punct', ch: c, at: i, end: i + 1 });
    }
    i += 1;
  }
  return merge(out);
}

function skip(text: string, from: number): number {
  let at = from;
  while (at < text.length && text[at] === ' ') at += 1;
  return at;
}

/** A gap `□ ___ ? [ ] ( )`, with the unit written after it (`□ cm`). Returns where reading goes on. */
function gapAt(_text: string, lower: string, out: Tok[], at: number, end: number): number {
  const unit = sticky(/ ?([a-z]+)(?![a-z0-9])/y, lower, end);
  const found = unit === null ? null : unitOf(unit[1] ?? '');
  if (unit !== null && found !== null) {
    out.push({ k: 'gap', unit: found, at, end: unit.index + unit[0].length });
    return unit.index + unit[0].length;
  }
  out.push({ k: 'gap', unit: null, at, end });
  return end;
}

/** Consecutive alphabetic words from `at`, joined by spaces or hyphens, with where each ends. */
function collectWords(lower: string, at: number): { w: string; end: number }[] {
  const words: { w: string; end: number }[] = [];
  let i = at;
  while (words.length < 12) {
    const match = sticky(/[a-z]+/y, lower, i);
    if (match === null) break;
    words.push({ w: match[0], end: match.index + match[0].length });
    const sep = sticky(/[\s-]+(?=[a-z])/y, lower, match.index + match[0].length);
    if (sep === null) break;
    i = sep.index + sep[0].length;
  }
  return words;
}

/** `1 m 25 cm` and `7 years and 3 months` are one quantity, in the smaller unit. */
function merge(tokens: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const token of tokens) {
    let previous = out[out.length - 1];
    let joiner: Tok | undefined;
    if (previous !== undefined && previous.k === 'word' && previous.w === 'and') {
      joiner = previous;
      previous = out[out.length - 2];
    }
    if (token.k === 'qty' && previous !== undefined && previous.k === 'qty' && previous.unit.dim === token.unit.dim && smaller(token.unit, previous.unit)) {
      const bigger = qMul(previous.q, qDiv(previous.unit.factor, token.unit.factor));
      out.length -= joiner === undefined ? 1 : 2;
      out.push({ k: 'qty', q: qAdd(bigger, token.q), unit: token.unit, at: previous.at, end: token.end });
      continue;
    }
    out.push(token);
  }
  return out;
}

function smaller(small: Unit, big: Unit): boolean {
  return small.factor.n * big.factor.d < big.factor.n * small.factor.d;
}
