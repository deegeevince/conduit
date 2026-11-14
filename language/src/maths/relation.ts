// A small word-problem relation check. The brain's solution to a word problem is a relation between the quantities the question gives (a total, a
// change, a share, a time after a journey, a fraction of a number…). Given those quantities as the question states them, and the answer the brain
// says is right, `checkRelation` works the relation out exactly and says whether the answer agrees, with the arithmetic as lines a step could show.
//
// It never reads the question's words: the brain (or a person) hands over the quantities, so there is nothing to misread. Reading a question's
// words is `solveQuestion` (solve.ts), and it only answers when it is sure.

import { Fail, q, qAdd, qCmp, qDiv, qEq, qFloor, qIsInt, qMul, qSub, qText } from './rational';
import type { Q } from './rational';
import { answerText, parseAnswer, parseList, sameAnswer, textAnswer, valueOf } from './answer';
import type { Answer } from './answer';
import { add, baseOf, div, mul, same, scalar, scaleBy, show, sub } from './value';
import type { Val } from './value';
import { evalNode, parseExpression } from './ast';
import { unitOf } from './units';
import type { Unit } from './units';

export type Relation =
  /** a total: `3 + 4 + 5` */
  | { readonly kind: 'total'; readonly parts: readonly string[] }
  /** what is left: `start` take away each of `take` */
  | { readonly kind: 'left'; readonly start: string; readonly take: readonly string[] }
  /** equal groups: `groups` of `each` */
  | { readonly kind: 'groups'; readonly groups: string; readonly each: string }
  /** a total shared out into `groups` equal parts; `remainder` when it need not go exactly */
  | { readonly kind: 'share'; readonly total: string; readonly groups: string; readonly remainder?: boolean }
  /** how many containers of `size` hold `total`: a part-filled one still counts */
  | { readonly kind: 'fit'; readonly total: string; readonly size: string }
  /** a fraction, a percentage or a word (`half`) of an amount: `2/3` of `96` */
  | { readonly kind: 'fraction'; readonly fraction: string; readonly of: string }
  /** the same fraction again and again: halve 64 three times; `all` for every stop on the way */
  | { readonly kind: 'chain'; readonly start: string; readonly by: string; readonly times: number; readonly all?: boolean }
  /** how many more or fewer: the gap between two amounts */
  | { readonly kind: 'difference'; readonly a: string; readonly b: string }
  /** what a buyer gets back: `paid` less the cost of each item, a price times its count */
  | { readonly kind: 'change'; readonly paid: string; readonly items: readonly { readonly price: string; readonly count?: string }[] }
  /** a time of day moved by spans: `after` (the default) or `before` */
  | { readonly kind: 'time'; readonly start: string; readonly spans: readonly string[]; readonly direction?: 'after' | 'before' }
  /** the minutes from one time of day to the next */
  | { readonly kind: 'elapsed'; readonly from: string; readonly to: string }
  /** a measurement in another unit */
  | { readonly kind: 'convert'; readonly value: string; readonly to: string }
  /** an age in months: `8 years 3 months` */
  | { readonly kind: 'ageMonths'; readonly age: string }
  /** a month some months on from another: `April` and `3` */
  | { readonly kind: 'monthAfter'; readonly month: string; readonly months: number }
  /** numbers in order */
  | { readonly kind: 'order'; readonly values: readonly string[]; readonly direction: 'ascending' | 'descending' }
  /** the number after a run of them */
  | { readonly kind: 'sequence'; readonly values: readonly string[] }
  /** the fewest notes and coins that make an amount */
  | { readonly kind: 'leastCoins'; readonly amount: string; readonly denominations?: readonly string[] }
  /** any sum with no gap, as written: `20 - 4 x 4.60` */
  | { readonly kind: 'expression'; readonly expr: string };

export type Status = 'agree' | 'mismatch' | 'unchecked';

export interface RelationResult {
  readonly status: Status;
  /** the answer the relation gives, as text; null when it could not be worked out */
  readonly expected: string | null;
  readonly claimed: string;
  /** one sentence: what was worked out, and how it differs when it does */
  readonly reason: string;
  /** the arithmetic, a line each, that a step could show */
  readonly working: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// pieces that stand alone

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** The month a word names (`apr`, `April`, `sept`), 0 to 11; null when it is not one. */
export function monthIndex(word: string): number | null {
  const w = word.trim().toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return null;
  const at = MONTH_NAMES.findIndex((name) => name.toLowerCase() === w || (w.length >= 3 && name.toLowerCase().startsWith(w) && (w.length === 3 || w === 'sept')));
  return at < 0 ? null : at;
}

export const monthName = (index: number): string => MONTH_NAMES[((index % 12) + 12) % 12] ?? 'January';

/** The month `months` after (or, if negative, before) `month`, round the year. */
export function monthAfter(month: string, months: number): string | null {
  const at = monthIndex(month);
  return at === null ? null : monthName(at + months);
}

/** The values a run of numbers go on with: every rule that fits, and what it says comes next. Needs three numbers (four for the rules that use more). */
export function nextInSequence(values: readonly Q[]): readonly { readonly rule: string; readonly next: Q }[] {
  const out: { rule: string; next: Q }[] = [];
  const n = values.length;
  if (n < 3) return out;
  const at = (i: number): Q => values[i] as Q;
  const last = at(n - 1);
  const gaps = (xs: readonly Q[]): Q[] => xs.slice(1).map((x, i) => qSub(x, xs[i] as Q));
  const constant = (xs: readonly Q[]): Q | null => (xs.length >= 2 && xs.every((x) => qEq(x, xs[0] as Q)) ? (xs[0] as Q) : null);
  const diffs = gaps(values);
  const d = constant(diffs);
  if (d !== null) out.push({ rule: `add ${qText(d)} each time`, next: qAdd(last, d) });
  if (values.every((x) => x.n !== 0n)) {
    const r = constant(values.slice(1).map((x, i) => qDiv(x, at(i))));
    if (r !== null && !qEq(r, q(1))) out.push({ rule: `multiply by ${qText(r)} each time`, next: qMul(last, r) });
  }
  if (n >= 4 && values.slice(2).every((x, i) => qEq(x, qAdd(at(i + 1), at(i))))) {
    out.push({ rule: 'add the last two numbers', next: qAdd(last, at(n - 2)) });
  }
  if (n >= 4 && d === null) {
    const lastStep = diffs[diffs.length - 1] as Q;
    const grow = constant(gaps(diffs));
    if (grow !== null) out.push({ rule: `the jumps grow by ${qText(grow)} each time`, next: qAdd(last, qAdd(lastStep, grow)) });
    if (diffs.every((x) => x.n !== 0n)) {
      const factor = constant(diffs.slice(1).map((x, i) => qDiv(x, diffs[i] as Q)));
      if (factor !== null && !qEq(factor, q(1))) out.push({ rule: `the jumps multiply by ${qText(factor)} each time`, next: qAdd(last, qMul(lastStep, factor)) });
    }
  }
  if (n >= 5) {
    const evens = values.filter((_, i) => i % 2 === 0);
    const odds = values.filter((_, i) => i % 2 === 1);
    // a run of two has one jump: enough, so long as the other run shows the pattern
    const pattern = (xs: readonly Q[]): Q | null => (xs.length === 2 ? qSub(xs[1] as Q, xs[0] as Q) : constant(gaps(xs)));
    const stepEven = pattern(evens);
    const stepOdd = pattern(odds);
    if (stepEven !== null && stepOdd !== null) {
      const evenNext = n % 2 === 0;
      const run = evenNext ? evens : odds;
      out.push({ rule: 'two patterns woven together', next: qAdd(run[run.length - 1] as Q, evenNext ? stepEven : stepOdd) });
    }
  }
  return out;
}

export interface Denominations {
  readonly name: string;
  /** values in the smallest coin (cents), largest last */
  readonly values: readonly bigint[];
}

export const AUD_COINS: readonly string[] = ['5c', '10c', '20c', '50c', '$1', '$2', '$5', '$10', '$20', '$50', '$100'];
export const GBP_COINS: readonly string[] = ['1p', '2p', '5p', '10p', '20p', '50p', '£1', '£2', '£5', '£10', '£20', '£50'];

/** The fewest notes and coins that make `amount`, as a list of values, largest first. Null when they cannot make it. Money is held in the smallest coin: whole numbers. */
export function leastCoins(amount: Val, denominations: readonly Val[]): readonly Val[] | null {
  if (amount.t !== 'n') return null;
  const total = baseOf(amount);
  if (total === null) return null;
  const cents = qMul(total, q(100));
  if (!qIsInt(cents) || cents.n < 0n || cents.n > 1_000_000n) return null;
  const goal = Number(cents.n);
  const coins = denominations.flatMap((d) => {
    const base = d.t === 'n' ? baseOf(d) : null;
    const c = base === null ? null : qMul(base, q(100));
    return c !== null && qIsInt(c) && c.n > 0n ? [{ value: d, cents: Number(c.n) }] : [];
  });
  const best: number[] = Array.from({ length: goal + 1 }, () => Number.POSITIVE_INFINITY);
  const pick: number[] = Array.from({ length: goal + 1 }, () => -1);
  best[0] = 0;
  for (let amountNow = 1; amountNow <= goal; amountNow += 1) {
    coins.forEach((coin, i) => {
      const before = amountNow - coin.cents;
      if (before >= 0 && (best[before] ?? Infinity) + 1 < (best[amountNow] ?? Infinity)) {
        best[amountNow] = (best[before] ?? Infinity) + 1;
        pick[amountNow] = i;
      }
    });
  }
  if (!Number.isFinite(best[goal] ?? Infinity)) return null;
  const out: Val[] = [];
  for (let rest = goal; rest > 0; rest -= coins[pick[rest] as number]?.cents ?? rest) out.push((coins[pick[rest] as number] as { value: Val }).value);
  return out.sort((a, b) => (qCmp(baseOf(b as Extract<Val, { t: 'n' }>) ?? q(0), baseOf(a as Extract<Val, { t: 'n' }>) ?? q(0))));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the check

const SIGN = { '+': '+', '-': '−', '*': '×', '/': '÷' } as const;

class Pad {
  readonly lines: string[] = [];
  run(a: Val, op: keyof typeof SIGN, b: Val): Val {
    const out = op === '+' ? add(a, b) : op === '-' ? sub(a, b) : op === '*' ? mul(a, b) : div(a, b);
    this.lines.push(`${show(a) ?? '?'} ${SIGN[op]} ${show(b) ?? '?'} = ${show(out) ?? '?'}`);
    return out;
  }
  scale(a: Val, by: Q, word: string): Val {
    const out = scaleBy(a, by);
    this.lines.push(`${word} of ${show(a) ?? '?'} = ${show(out) ?? '?'}`);
    return out;
  }
}

function unitFor(word: string): Unit {
  const unit = unitOf(word.trim().toLowerCase());
  if (unit === null) throw new Fail('unreadable', `"${word}" is not a unit I know`);
  return unit;
}

/** The answers a relation makes right (a chain with `all` has every stop), and the arithmetic that got there. */
function work(rel: Relation, pad: Pad): readonly Answer[] {
  switch (rel.kind) {
    case 'total': {
      if (rel.parts.length < 2) throw new Fail('shape', 'a total needs at least two parts');
      return [rel.parts.map(valueOf).reduce((sum, part) => pad.run(sum, '+', part))];
    }
    case 'left': {
      const from = valueOf(rel.start);
      return [rel.take.map(valueOf).reduce((rest, part) => pad.run(rest, '-', part), from)];
    }
    case 'groups':
      return [pad.run(valueOf(rel.groups), '*', valueOf(rel.each))];
    case 'share': {
      const total = valueOf(rel.total);
      const groups = valueOf(rel.groups);
      const out = pad.run(total, '/', groups);
      const t = baseOf(total as Extract<Val, { t: 'n' }>);
      const g = baseOf(groups as Extract<Val, { t: 'n' }>);
      if (rel.remainder !== true && t !== null && g !== null && !qIsInt(qDiv(t, g)) && (total as Extract<Val, { t: 'n' }>).unit === null) {
        throw new Fail('shape', `${show(total)} does not share into ${show(groups)} equal parts`);
      }
      return [out];
    }
    case 'fit': {
      const total = valueOf(rel.total);
      const size = valueOf(rel.size);
      const exact = pad.run(total, '/', size);
      const e = baseOf(exact as Extract<Val, { t: 'n' }>);
      if (e === null) throw new Fail('shape', 'cannot count containers');
      const whole = qIsInt(e) ? e : q(qFloor(e) + 1n);
      if (!qIsInt(e)) pad.lines.push(`a part-filled one still counts: ${qText(whole)}`);
      return [scalar(whole)];
    }
    case 'fraction': {
      const f = valueOf(rel.fraction);
      const of = valueOf(rel.of);
      return [pad.run(f, '*', of)];
    }
    case 'chain': {
      const by = valueOf(rel.by);
      let at = valueOf(rel.start);
      const stops: Val[] = [];
      if (!Number.isInteger(rel.times) || rel.times < 1 || rel.times > 40) throw new Fail('shape', 'a chain goes round between one and forty times');
      for (let i = 0; i < rel.times; i += 1) {
        at = pad.run(at, '*', by);
        stops.push(at);
      }
      return rel.all === true ? [stops, stops[stops.length - 1] as Val] : [at];
    }
    case 'difference': {
      const a = valueOf(rel.a);
      const b = valueOf(rel.b);
      const c = compareBase(a, b);
      return [c >= 0 ? pad.run(a, '-', b) : pad.run(b, '-', a)];
    }
    case 'change': {
      if (rel.items.length === 0) throw new Fail('shape', 'change needs at least one thing bought');
      let spent: Val | null = null;
      for (const item of rel.items) {
        const price = valueOf(item.price);
        const cost = item.count === undefined ? price : pad.run(valueOf(item.count), '*', price);
        spent = spent === null ? cost : pad.run(spent, '+', cost);
      }
      const paid = valueOf(rel.paid);
      if (compareBase(paid, spent as Val) < 0) throw new Fail('shape', `${show(paid)} does not cover ${show(spent as Val)}`);
      return [pad.run(paid, '-', spent as Val)];
    }
    case 'time': {
      const start = valueOf(rel.start);
      if (start.t !== 'clock') throw new Fail('shape', `${rel.start} is not a time of day`);
      if (rel.spans.length === 0) throw new Fail('shape', 'a time needs a span to move by');
      let at: Val = start;
      for (const span of rel.spans) at = pad.run(at, rel.direction === 'before' ? '-' : '+', valueOf(span));
      return [at];
    }
    case 'elapsed': {
      const a = valueOf(rel.from);
      const b = valueOf(rel.to);
      if (a.t !== 'clock' || b.t !== 'clock') throw new Fail('shape', 'two times of day are needed');
      return [pad.run(b, '-', a)];
    }
    case 'convert': {
      const v = valueOf(rel.value);
      if (v.t !== 'n' || v.unit === null) throw new Fail('shape', `${rel.value} is not a measurement`);
      const to = unitFor(rel.to);
      if (to.dim !== v.unit.dim) throw new Fail('unit', `${rel.value} cannot be written in ${to.name}`);
      const out: Val = { t: 'n', v: v.v, unit: to, pct: false };
      pad.lines.push(`${show(v) ?? '?'} = ${show(out) ?? '?'}`);
      return [out];
    }
    case 'ageMonths': {
      const v = valueOf(rel.age);
      if (v.t !== 'n' || v.unit === null || v.unit.dim !== 'month') throw new Fail('shape', `${rel.age} is not an age in years and months`);
      const months = unitFor('months');
      const out: Val = { t: 'n', v: v.v, unit: months, pct: false };
      pad.lines.push(`${show(v) ?? '?'} = ${show(out) ?? '?'}`);
      return [out];
    }
    case 'monthAfter': {
      const out = monthAfter(rel.month, rel.months);
      if (out === null) throw new Fail('shape', `${rel.month} is not a month`);
      pad.lines.push(`${rel.month} and ${rel.months} month${rel.months === 1 ? '' : 's'} on is ${out}`);
      return [textAnswer(out.toLowerCase())];
    }
    case 'order': {
      const vs = rel.values.map(valueOf);
      const sorted = [...vs].sort((a, b) => compareBase(a, b) * (rel.direction === 'ascending' ? 1 : -1));
      pad.lines.push(`${rel.direction}: ${sorted.map((v) => show(v) ?? '?').join(', ')}`);
      return [sorted];
    }
    case 'sequence': {
      const vs = rel.values.map(valueOf);
      const raw = vs.map((v) => (v.t === 'n' ? baseOf(v) : null));
      if (raw.some((x) => x === null)) throw new Fail('shape', 'a sequence is made of plain numbers');
      const found = nextInSequence(raw as Q[]);
      if (found.length === 0) throw new Fail('unsupported', 'no pattern I know fits those numbers');
      for (const f of found) pad.lines.push(`${f.rule}: next is ${qText(f.next)}`);
      return found.map((f) => scalar(f.next));
    }
    case 'leastCoins': {
      const amount = valueOf(rel.amount);
      const denoms = (rel.denominations ?? AUD_COINS).map(valueOf);
      const coins = leastCoins(amount, denoms);
      if (coins === null) throw new Fail('shape', `${rel.amount} cannot be made from those notes and coins`);
      pad.lines.push(`least: ${coins.map((c) => show(c) ?? '?').join(' + ')} = ${show(amount) ?? '?'}`);
      return coins.length === 1 ? [coins, coins[0] as Val] : [coins];
    }
    case 'expression': {
      const lines = pad.lines;
      const v = evaluateConstant(rel.expr);
      lines.push(`${rel.expr.trim()} = ${show(v) ?? '?'}`);
      return [v];
    }
  }
}

function compareBase(a: Val, b: Val): number {
  if (a.t !== 'n' || b.t !== 'n') throw new Fail('shape', 'those cannot be put in order');
  if (a.unit !== null && b.unit !== null && a.unit.dim !== b.unit.dim) throw new Fail('unit', 'those are not the same kind of thing');
  const x = baseOf(a);
  const y = baseOf(b);
  if (x === null || y === null) throw new Fail('shape', 'those cannot be put in order');
  return qCmp(x, y);
}


/** The value of a sum with no unknown in it. Throws `Fail`. */
export function evaluateConstant(expr: string): Val {
  const v = evalNode(parseExpression(expr, { trailingWords: true }), { gapUnit: null, prev: null });
  if (show(v) === null) throw new Fail('shape', 'that has an unknown in it');
  return v;
}

/** What a relation works out to, every answer that would be right, and the arithmetic. Throws `Fail` when it cannot be worked out. */
export function workRelation(rel: Relation): { readonly answers: readonly Answer[]; readonly working: readonly string[] } {
  const pad = new Pad();
  const answers = work(rel, pad);
  return { answers, working: pad.lines };
}

/** Whether `claimed` is the answer the relation gives. */
export function checkRelation(rel: Relation, claimed: string, unit: string | null = null): RelationResult {
  try {
    const { answers, working } = workRelation(rel);
    const first = answers[0];
    const expected = first === undefined ? null : answerText(first);
    const given = rel.kind === 'leastCoins' || rel.kind === 'order' || rel.kind === 'sequence' ? (parseList(claimed) ?? parseAnswer(claimed)) : parseAnswer(claimed);
    if (given === null) return { status: 'unchecked', expected, claimed, reason: `"${claimed}" is not an answer I can read`, working };
    const ok = answers.some((a) => sameAnswer(a, given, unitOrNull(unit)));
    if (ok) return { status: 'agree', expected, claimed, reason: `${working[working.length - 1] ?? expected ?? ''}`, working };
    const reason = `the quantities give ${expected ?? '?'}, not ${claimed.trim()}`;
    const note = rel.kind === 'leastCoins' ? leastCoinsNote(rel, given) : '';
    return { status: 'mismatch', expected, claimed, reason: `${reason}${note}`, working };
  } catch (error) {
    return { status: 'unchecked', expected: null, claimed, reason: error instanceof Fail ? error.message : 'that could not be worked out', working: [] };
  }
}

function unitOrNull(name: string | null): Unit | null {
  return name === null ? null : unitOf(name.trim().toLowerCase());
}

function leastCoinsNote(rel: Extract<Relation, { kind: 'leastCoins' }>, given: Answer): string {
  const list = Array.isArray(given) ? (given as readonly Val[]) : [given as Val];
  try {
    const amount = valueOf(rel.amount);
    const best = leastCoins(amount, (rel.denominations ?? AUD_COINS).map(valueOf));
    if (best === null) return '';
    const total = list.reduce<Val | null>((sum, v) => (sum === null ? v : add(sum, v)), null);
    if (total !== null && same(total, amount)) return `: those make it, but ${best.length} is the fewest and that is ${list.length}`;
    return '';
  } catch {
    return '';
  }
}

