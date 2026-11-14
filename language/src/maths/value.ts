// Values: what an expression comes to. A number is a rational function of one unknown (so `60 + □ = 100` can be solved exactly, and `24 ÷ □ = 6`
// too); most of the time it is a constant. A quantity carries its unit; a time of day is minutes past midnight, taken round the clock only when
// it is compared or shown.

import { Fail, ONE, ZERO, q, qAbs, qAdd, qCmp, qDecimal, qDiv, qEq, qFraction, qIsInt, qIsZero, qMod, qMul, qNeg, qSub, qText } from './rational';
import type { Q } from './rational';
import { isMoney, kindName, majorUnit, unitLabel } from './units';
import type { Dim, Unit } from './units';

// ---------------------------------------------------------------------------------------------------------------------------------
// numbers with one unknown

/** `c0 + c1·x + c2·x² …`, no trailing zeros. */
export type Poly = readonly Q[];

export interface Num {
  readonly n: Poly;
  readonly d: Poly;
}

const MAX_DEGREE = 6;

function trim(p: readonly Q[]): Poly {
  let end = p.length;
  while (end > 0 && qIsZero(p[end - 1] ?? ZERO)) end -= 1;
  return p.slice(0, end);
}

const polyAdd = (a: Poly, b: Poly): Poly => trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => qAdd(a[i] ?? ZERO, b[i] ?? ZERO)));
const polySub = (a: Poly, b: Poly): Poly => trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => qSub(a[i] ?? ZERO, b[i] ?? ZERO)));
function polyMul(a: Poly, b: Poly): Poly {
  if (a.length === 0 || b.length === 0) return [];
  const out: Q[] = Array.from({ length: a.length + b.length - 1 }, () => ZERO);
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] = qAdd(out[i + j] ?? ZERO, qMul(x, y)))));
  if (out.length - 1 > MAX_DEGREE) throw new Fail('unsupported', 'that has the unknown in too many places to solve');
  return trim(out);
}

const UNIT_POLY: Poly = [ONE];

export function numOf(value: Q): Num {
  return { n: qIsZero(value) ? [] : [value], d: UNIT_POLY };
}

export const NUM_X: Num = { n: [ZERO, ONE], d: UNIT_POLY };

/** Folds a constant denominator into the numerator, so constants stay one number. */
function tidy(n: Poly, d: Poly): Num {
  if (d.length === 0) throw new Fail('zero', 'dividing by zero');
  if (d.length === 1) {
    const only = d[0] ?? ONE;
    return { n: trim(n.map((c) => qDiv(c, only))), d: UNIT_POLY };
  }
  return { n, d };
}

/** The number, when there is no unknown in it. */
export function constOf(a: Num): Q | null {
  if (a.d.length !== 1 || !qEq(a.d[0] ?? ONE, ONE)) return null;
  if (a.n.length === 0) return ZERO;
  return a.n.length === 1 ? (a.n[0] ?? ZERO) : null;
}

export const numAdd = (a: Num, b: Num): Num => tidy(polyAdd(polyMul(a.n, b.d), polyMul(b.n, a.d)), polyMul(a.d, b.d));
export const numSub = (a: Num, b: Num): Num => tidy(polySub(polyMul(a.n, b.d), polyMul(b.n, a.d)), polyMul(a.d, b.d));
export const numMul = (a: Num, b: Num): Num => tidy(polyMul(a.n, b.n), polyMul(a.d, b.d));
export function numDiv(a: Num, b: Num): Num {
  if (b.n.length === 0) throw new Fail('zero', 'dividing by zero');
  return tidy(polyMul(a.n, b.d), polyMul(a.d, b.n));
}
export const numNeg = (a: Num): Num => ({ n: a.n.map(qNeg), d: a.d });
export const numScale = (a: Num, by: Q): Num => numMul(a, numOf(by));

function polyAt(p: Poly, x: Q): Q {
  return p.reduceRight((acc, c) => qAdd(qMul(acc, x), c), ZERO);
}

export type Solution = { readonly kind: 'one'; readonly x: Q } | { readonly kind: 'any' } | { readonly kind: 'none' } | { readonly kind: 'unsupported' };

/** The unknown that makes `a` equal `b`, exactly, when the equation is a straight line (or becomes one: `24 ÷ x = 6`). */
export function numSolve(a: Num, b: Num): Solution {
  const top = polySub(polyMul(a.n, b.d), polyMul(b.n, a.d));
  if (top.length === 0) return { kind: 'any' };
  if (top.length === 1) return { kind: 'none' };
  if (top.length > 2) return { kind: 'unsupported' };
  const x = qDiv(qNeg(top[0] ?? ZERO), top[1] ?? ONE);
  // a root that empties a denominator is no root: `24 ÷ x = 6` has no answer at 0
  if (qIsZero(polyAt(a.d, x)) || qIsZero(polyAt(b.d, x))) return { kind: 'none' };
  return { kind: 'one', x };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// values

export type Val =
  /** a number, or a quantity held in its base unit and shown in `unit`; `pct` for a percentage written as one */
  | { readonly t: 'n'; readonly v: Num; readonly unit: Unit | null; readonly pct: boolean }
  /** minutes past midnight, not yet taken round the clock; `resolved` when am/pm or a 24-hour time said which half of the day */
  | { readonly t: 'clock'; readonly min: Num; readonly resolved: boolean };

export const scalar = (value: Q): Val => ({ t: 'n', v: numOf(value), unit: null, pct: false });
export const quantity = (written: Q, unit: Unit): Val => ({ t: 'n', v: numOf(qMul(written, unit.factor)), unit, pct: false });

/** Brings a bare number into a unit: `25 + 75 cm` reads the 25 as centimetres. */
function lift(value: Num, unit: Unit): Num {
  return numScale(value, unit.factor);
}

function needNumber(a: Val, what: string): Extract<Val, { t: 'n' }> {
  if (a.t !== 'n') throw new Fail('shape', `a time of day cannot be ${what}`);
  return a;
}

/** The unit a sum of two quantities is shown in: money in the first one's (`£1.50 + 75p` is `£2.25`), anything else in the smaller (`3 weeks + 2 days` is `23 days`). */
function shownUnit(a: Unit, b: Unit): Unit {
  if (isMoney(a)) return a;
  return qCmp(b.factor, a.factor) < 0 ? b : a;
}

function sameKind(a: Unit, b: Unit): void {
  if (a.dim !== b.dim) throw new Fail('unit', `${kindName(a.dim)} and ${kindName(b.dim)} cannot be put together`);
}

/** Whether a unit measures minutes, hours, days (a span a clock can move by). */
export const isSpan = (unit: Unit | null): boolean => unit !== null && unit.dim === 'time';

function minutesOf(a: Extract<Val, { t: 'n' }>): Num {
  if (a.unit === null) return a.v;
  if (a.unit.dim !== 'time') throw new Fail('unit', `${kindName(a.unit.dim)} cannot move a time of day`);
  return numScale(a.v, q(1, 60));
}

export function add(a: Val, b: Val): Val {
  if (a.t === 'clock') {
    if (b.t === 'clock') throw new Fail('shape', 'two times of day cannot be added');
    return { t: 'clock', min: numAdd(a.min, minutesOf(b)), resolved: a.resolved };
  }
  if (b.t === 'clock') return { t: 'clock', min: numAdd(b.min, minutesOf(a)), resolved: b.resolved };
  if (a.unit !== null && b.unit !== null) {
    sameKind(a.unit, b.unit);
    return { t: 'n', v: numAdd(a.v, b.v), unit: shownUnit(a.unit, b.unit), pct: false };
  }
  if (a.unit !== null) return { t: 'n', v: numAdd(a.v, lift(b.v, a.unit)), unit: a.unit, pct: false };
  if (b.unit !== null) return { t: 'n', v: numAdd(lift(a.v, b.unit), b.v), unit: b.unit, pct: false };
  return { t: 'n', v: numAdd(a.v, b.v), unit: null, pct: a.pct && b.pct };
}

export function sub(a: Val, b: Val): Val {
  if (a.t === 'clock') {
    if (b.t === 'clock') {
      // the span between two times of day, going forward round the clock from `b` to `a`
      const day = a.resolved || b.resolved ? 1440 : 720;
      const gap = numSub(a.min, b.min);
      const whole = constOf(gap);
      const minutes = whole === null ? gap : numOf(q(qMod(whole, BigInt(day))));
      return { t: 'n', v: numScale(minutes, q(60)), unit: SPAN_MIN, pct: false };
    }
    return { t: 'clock', min: numSub(a.min, minutesOf(b)), resolved: a.resolved };
  }
  if (b.t === 'clock') throw new Fail('shape', 'a time of day cannot be taken away from a number');
  if (a.unit !== null && b.unit !== null) {
    sameKind(a.unit, b.unit);
    return { t: 'n', v: numSub(a.v, b.v), unit: shownUnit(a.unit, b.unit), pct: false };
  }
  if (a.unit !== null) return { t: 'n', v: numSub(a.v, lift(b.v, a.unit)), unit: a.unit, pct: false };
  if (b.unit !== null) return { t: 'n', v: numSub(lift(a.v, b.unit), b.v), unit: b.unit, pct: false };
  return { t: 'n', v: numSub(a.v, b.v), unit: null, pct: a.pct && b.pct };
}

/** The minute, for a span a clock difference gives. */
const SPAN_MIN: Unit = { name: 'min', dim: 'time', factor: q(60) };

export function mul(a: Val, b: Val): Val {
  const x = needNumber(a, 'multiplied');
  const y = needNumber(b, 'multiplied');
  if (x.unit !== null && y.unit !== null) throw new Fail('unit', 'two measurements cannot be multiplied');
  return { t: 'n', v: numMul(x.v, y.v), unit: x.unit ?? y.unit, pct: false };
}

export function div(a: Val, b: Val): Val {
  const x = needNumber(a, 'divided');
  const y = needNumber(b, 'divided');
  if (x.unit !== null && y.unit !== null) {
    sameKind(x.unit, y.unit);
    return { t: 'n', v: numDiv(x.v, y.v), unit: null, pct: false };
  }
  if (y.unit !== null) throw new Fail('unit', 'a number cannot be divided by a measurement');
  return { t: 'n', v: numDiv(x.v, y.v), unit: x.unit, pct: false };
}

export function neg(a: Val): Val {
  if (a.t === 'clock') throw new Fail('shape', 'a time of day has no minus');
  return { ...a, v: numNeg(a.v) };
}

export function scaleBy(a: Val, by: Q): Val {
  const x = needNumber(a, 'scaled');
  return { t: 'n', v: numScale(x.v, by), unit: x.unit, pct: false };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// reading a value back

/** The number a quantity is, in the unit it is shown in (`125` for 125 cm). Null while there is an unknown in it. */
export function writtenOf(a: Extract<Val, { t: 'n' }>): Q | null {
  const base = constOf(a.v);
  if (base === null) return null;
  return a.unit === null ? base : qDiv(base, a.unit.factor);
}

/** The number in the base unit (metres, grams, dollars…), or the plain number. */
export const baseOf = (a: Extract<Val, { t: 'n' }>): Q | null => constOf(a.v);

export function clockMinutes(a: Extract<Val, { t: 'clock' }>): Q | null {
  return constOf(a.min);
}

/** How a time of day reads: `9:20 am` when it said which half of the day, `9:20` when it did not. */
export function clockText(minutes: Q, resolved: boolean): string {
  const total = qMod(minutes, resolved ? 1440n : 720n);
  const hour24 = Number(total / 60n);
  const minute = Number(total % 60n);
  const pad = String(minute).padStart(2, '0');
  if (!resolved) return `${hour24 === 0 ? 12 : hour24}:${pad}`;
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour}:${pad} ${hour24 < 12 ? 'am' : 'pm'}`;
}

function moneyText(unit: Unit, written: Q, base: Q): string {
  const major = majorUnit(unit.dim);
  const symbol = major?.symbol ?? '$';
  if (unit.symbol !== undefined && unit.name.length === 1 && unit.factor.d !== 1n) {
    // cents and pence, as the coin they are
    const text = qDecimal(written);
    return `${text ?? qFraction(written)}${unit.name}`;
  }
  const sign = base.n < 0n ? '-' : '';
  const abs = qAbs(base);
  const cents = qMul(abs, q(100));
  if (qIsInt(cents)) {
    const whole = cents.n / 100n;
    const rest = String(cents.n % 100n).padStart(2, '0');
    return `${sign}${symbol}${whole}.${rest}`;
  }
  return `${sign}${symbol}${qText(abs)}`;
}

/** A value as it reads in a sentence: `24`, `$6.50`, `125 cm`, `2/3`, `25%`, `9:20 am`. Null while there is an unknown in it. */
export function show(a: Val): string | null {
  if (a.t === 'clock') {
    const minutes = clockMinutes(a);
    return minutes === null ? null : clockText(minutes, a.resolved);
  }
  const base = baseOf(a);
  if (base === null) return null;
  if (a.pct) return `${qText(qMul(base, q(100)))}%`;
  if (a.unit === null) return qText(base);
  const written = qDiv(base, a.unit.factor);
  if (isMoney(a.unit)) return moneyText(a.unit, written, base);
  return `${qText(written)} ${unitLabel(a.unit, qEq(written, ONE))}`;
}

/** What a measurement is, or `null` for a plain number: for telling two values apart by kind. */
export function dimOf(a: Val): Dim | 'clock' | null {
  return a.t === 'clock' ? 'clock' : (a.unit?.dim ?? null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// are two values the same

/**
 * Whether two values are the same answer. A bare number and a quantity meet when the number is what the quantity is in its own unit, or in
 * `askUnit` (the unit the ask itself names); a percentage and a bare number meet when the number is the percent. Two quantities of different kinds
 * never meet. Times of day meet round the clock: with no am or pm on one side, round twelve hours.
 */
export function same(a: Val, b: Val, askUnit: Unit | null = null): boolean {
  if (a.t === 'clock' || b.t === 'clock') {
    if (a.t !== 'clock' || b.t !== 'clock') return false;
    const x = clockMinutes(a);
    const y = clockMinutes(b);
    if (x === null || y === null) return false;
    const day = a.resolved && b.resolved ? 1440n : 720n;
    return qMod(x, day) === qMod(y, day);
  }
  const x = baseOf(a);
  const y = baseOf(b);
  if (x === null || y === null) return false;
  if (a.unit !== null && b.unit !== null) return a.unit.dim === b.unit.dim && qEq(x, y);
  if (a.unit === null && b.unit === null) {
    if (a.pct === b.pct) return qEq(x, y);
    // `25%` and `0.25`: the same share; `25%` and a bare 25: the percent
    const [p, other] = a.pct ? [x, y] : [y, x];
    return qEq(p, other) || qEq(qMul(p, q(100)), other);
  }
  const [measured, bare] = a.unit !== null ? [a, b] : [b, a];
  const unit = measured.unit;
  const m = baseOf(measured);
  const n = baseOf(bare);
  if (unit === null || m === null || n === null) return false;
  if (qEq(qDiv(m, unit.factor), n)) return true;
  return askUnit !== null && askUnit.dim === unit.dim && qEq(qDiv(m, askUnit.factor), n);
}

/** Orders two plain numbers or two quantities of one kind: `-1`, `0`, `1`; null when they cannot be compared. */
export function compare(a: Val, b: Val): -1 | 0 | 1 | null {
  if (a.t !== 'n' || b.t !== 'n') return null;
  if (a.unit !== null && b.unit !== null && a.unit.dim !== b.unit.dim) return null;
  const x = baseOf(a);
  const y = baseOf(b);
  if (x === null || y === null) return null;
  return qCmp(x, y);
}
