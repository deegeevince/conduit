// Exact numbers: a rational is a pair of BigInts in lowest terms. Nothing in `maths/` ever touches a float, so 0.1 + 0.2 is 0.3 here and 2/3 of 96
// is 64 exactly. The one thing that can go wrong is size, so every product is bounded (`Fail('too-big')`) and a sum is never trusted to be small.

/** What stops a calculation: the reason is words a person can read. It is thrown inside `maths/` and caught at every public edge, never past it. */
export class Fail extends Error {
  readonly code: 'unreadable' | 'unit' | 'zero' | 'too-big' | 'unsupported' | 'shape';
  constructor(code: Fail['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface Q {
  /** the sign is here */
  readonly n: bigint;
  /** always positive */
  readonly d: bigint;
}

/** Past this many bits a number is refused, not computed: a typed line must not be able to ask for an hour of arithmetic. */
const MAX_BITS = 2048;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function bits(n: bigint): number {
  return (n < 0n ? -n : n).toString(2).length;
}

/** `n / d` in lowest terms. */
export function q(n: bigint | number, d: bigint | number = 1n): Q {
  const top = BigInt(n);
  const bottom = BigInt(d);
  if (bottom === 0n) throw new Fail('zero', 'dividing by zero');
  const g = gcd(top, bottom) || 1n;
  const sign = bottom < 0n ? -1n : 1n;
  const out = { n: (sign * top) / g, d: (sign * bottom) / g };
  if (bits(out.n) > MAX_BITS || bits(out.d) > MAX_BITS) throw new Fail('too-big', 'that number is too big to work with');
  return out;
}

export const ZERO: Q = { n: 0n, d: 1n };
export const ONE: Q = { n: 1n, d: 1n };

export const qAdd = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const qSub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const qMul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const qDiv = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
export const qNeg = (a: Q): Q => ({ n: -a.n, d: a.d });
export const qCmp = (a: Q, b: Q): -1 | 0 | 1 => {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
};
export const qEq = (a: Q, b: Q): boolean => a.n === b.n && a.d === b.d;
export const qIsZero = (a: Q): boolean => a.n === 0n;
export const qIsInt = (a: Q): boolean => a.d === 1n;
export const qSign = (a: Q): -1 | 0 | 1 => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0);
export const qAbs = (a: Q): Q => (a.n < 0n ? qNeg(a) : a);

/** The whole part, rounding down (`-1/2` is `-1`). */
export function qFloor(a: Q): bigint {
  const whole = a.n / a.d;
  return a.n % a.d !== 0n && a.n < 0n ? whole - 1n : whole;
}

/** `q mod m` for a positive integer `m`, as a non-negative whole number. Only for whole `a` and `m`. */
export function qMod(a: Q, m: bigint): bigint {
  const r = qFloor(a) % m;
  return r < 0n ? r + m : r;
}

/** `12`, `0.25`, `.5`, `1,000` as the exact number written. Null for anything else. Never goes through a float. */
export function qParse(text: string): Q | null {
  const match = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = (match[1] ?? '').replaceAll(',', '');
  const frac = match[2] ?? '';
  if (whole === '' && frac === '') return null;
  if (whole.length + frac.length > 40) throw new Fail('too-big', 'that number has too many digits');
  return q(BigInt(`${whole === '' ? '0' : whole}${frac}`), 10n ** BigInt(frac.length));
}

/** The decimal a number is, when it ends (`1/4` is `0.25`); null when it goes on for ever (`1/3`) or past `places`. */
export function qDecimal(a: Q, places = 12): string | null {
  let d = a.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos += 1;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives += 1;
  }
  if (d !== 1n) return null;
  const scale = Math.max(twos, fives);
  if (scale > places) return null;
  const scaled = (a.n < 0n ? -a.n : a.n) * 10n ** BigInt(scale) / a.d;
  const digits = scaled.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${a.n < 0n ? '-' : ''}${whole}${scale === 0 ? '' : `.${frac}`}`;
}

/** `2/3`, `7/3` as written, or `2 1/3` mixed: how a child writes a fraction. */
export function qFraction(a: Q, mixed = false): string {
  if (a.d === 1n) return a.n.toString();
  if (mixed && (a.n > a.d || -a.n > a.d)) {
    const sign = a.n < 0n ? '-' : '';
    const top = a.n < 0n ? -a.n : a.n;
    return `${sign}${top / a.d} ${top % a.d}/${a.d}`;
  }
  return `${a.n}/${a.d}`;
}

/** A number for a sentence: a decimal when it ends, otherwise a fraction. */
export function qText(a: Q): string {
  return qDecimal(a) ?? qFraction(a, true);
}

/** A whole number as a JS number, for places that need a small count (a clock's minutes); null when it is not whole or not small. */
export function qSmall(a: Q): number | null {
  if (!qIsInt(a) || bits(a.n) > 50) return null;
  return Number(a.n);
}
