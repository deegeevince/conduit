// Reading a question's words and working out its answer, when the words are one of the shapes a primary-maths worksheet uses and the reading is
// certain: a sum (`61 − 50 =`, `What is 50 less than 200?`, `100 − □ = 50`, `2/3 of 96`), a conversion (`How many cm in 2.86 m?`), a time after a
// journey, a change from a note, a fraction as much as, a number pattern, putting numbers in order, a month some months on.
//
// Not sure means no answer: a question this does not understand returns null, and a lesson that says something else about it is left alone.
// Only a recognised shape whose arithmetic disagrees is a finding.

import { Fail, q, qCmp, qDiv, qFloor } from './rational';
import type { Q } from './rational';
import { evalNode, parsePrefix, solveGap } from './ast';
import type { Node } from './ast';
import { lex } from './lex';
import type { Tok } from './lex';
import { textAnswer } from './answer';
import type { Answer } from './answer';
import { monthAfter, monthIndex, nextInSequence } from './relation';
import { add, baseOf, compare, mul as mulVal, quantity, scalar, show, sub } from './value';
import type { Val } from './value';
import { checkStep, stripLabel } from './steps';
import { unitOf as unitFromWord } from './units';
import type { StepResult } from './steps';

export type SolvedKind = 'share' | 'sum' | 'gap' | 'convert' | 'clock' | 'elapsed' | 'late' | 'change' | 'fraction' | 'sequence' | 'order' | 'compare' | 'month';

export interface Solved {
  readonly kind: SolvedKind;
  /** what was worked out, in the question's own terms: `64 - 30` */
  readonly sum: string;
  /** every answer that would be right (a chain of halves has each stop; a number pattern each rule that fits) */
  readonly answers: readonly Answer[];
  /** the arithmetic, a line each */
  readonly working: readonly string[];
  /** one reading, no doubt: false when more than one answer is possible */
  readonly sure: boolean;
}

const NO_ENV = { gapUnit: null, prev: null } as const;
const shown = (v: Val): string => show(v) ?? '?';

// ---------------------------------------------------------------------------------------------------------------------------------
// sums in a sentence

export interface Fragment {
  /** a sum with `=` and a `?` or `□`, or a lead-in (`What is …?`): asks for its value; `gap`: asks for the missing number; `statement`: says it is so */
  readonly kind: 'question' | 'gap' | 'statement';
  readonly source: string;
  readonly sides: readonly Node[];
}

const LEAD = new Set(['what', 'time', 'is', "what's", 'work', 'out', 'calculate', 'find', 'how', 'much', 'many', 'the', 'answer', 'to', 'solve', 'write', 'down', 'now', 'so', 'then', 'try', 'and', 'it', 'value', 'of', 'total']);
const FILLER = 3;

const isLit = (n: Node): boolean => n.k === 'lit' || n.k === 'gap' || (n.k === 'neg' && n.e.k === 'lit');

function hasGap(n: Node): boolean {
  switch (n.k) {
    case 'gap':
      return true;
    case 'bin':
      return hasGap(n.l) || hasGap(n.r);
    case 'neg':
    case 'scale':
      return hasGap(n.e);
    case 'cmp':
      return hasGap(n.a) || hasGap(n.b);
    default:
      return false;
  }
}

/** Every sum a text holds, in order: the ones that ask, and the ones that claim. */
export function fragments(text: string): Fragment[] {
  let toks: Tok[];
  try {
    toks = lex(text);
  } catch (error) {
    if (error instanceof Fail) return [];
    throw error;
  }
  const out: Fragment[] = [];
  let i = 0;
  while (i < toks.length) {
    let first: { node: Node; used: number };
    try {
      first = parsePrefix(toks.slice(i), text);
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      i += 1;
      continue;
    }
    let j = i + first.used;
    const sides: Node[] = [first.node];
    while (toks[j]?.k === 'eq') {
      const restToks = toks.slice(j + 1);
      if (restToks.every((t) => t.k === 'punct')) {
        // `61 - 50 =` with nothing after it: the answer is what is asked for
        const eq = toks[j] as Tok;
        sides.push({ k: 'gap', unit: null, span: { at: eq.end, end: eq.end } });
        j = toks.length;
        break;
      }
      try {
        const next = parsePrefix(toks.slice(j + 1), text);
        sides.push(next.node);
        j += 1 + next.used;
      } catch (error) {
        if (!(error instanceof Fail)) throw error;
        break;
      }
    }
    const a = toks[i];
    const b = toks[Math.min(j, toks.length) - 1];
    const source = a === undefined || b === undefined ? '' : text.slice(a.at, b.end);
    if (sides.length === 1) {
      const only = sides[0] as Node;
      if (!isLit(only)) {
        const before = toks.slice(0, i);
        const after = toks.slice(j);
        const leadOk = before.every((t) => t.k === 'punct' || (t.k === 'word' && LEAD.has(t.w)));
        const trail = after.filter((t) => !(t.k === 'punct' || t.k === 'gap'));
        const trailOk = trail.every((t) => t.k === 'word') && trail.length <= FILLER;
        if (leadOk && trailOk) out.push({ kind: 'question', source, sides });
      }
      i = Math.max(j, i + 1);
      continue;
    }
    const gaps = sides.filter(hasGap).length;
    if (gaps === 0) out.push({ kind: 'statement', source, sides });
    else if (sides.length === 2 && (sides[1] as Node).k === 'gap' && (sides[1] as Extract<Node, { k: 'gap' }>).unit === null && !hasGap(sides[0] as Node)) out.push({ kind: 'question', source, sides });
    else if (sides.length === 2 && gaps === 1) out.push({ kind: 'gap', source, sides });
    i = Math.max(j, i + 1);
  }
  return out;
}

function solveFragment(f: Fragment): Solved | null {
  try {
    if (f.kind === 'question') {
      const v = evalNode(f.sides[0] as Node, NO_ENV);
      const text = show(v);
      if (text === null) return null;
      const sum = f.source.replace(/\s*=\s*[?□_]*\s*$/, '').trim();
      return { kind: 'sum', sum, answers: [v], working: [`${sum} = ${text}`], sure: true };
    }
    if (f.kind === 'gap') {
      const found = solveGap(f.sides[0] as Node, f.sides[1] as Node);
      const v = found.unit === null ? scalar(found.x) : quantity(found.x, found.unit);
      return { kind: 'gap', sum: f.source, answers: [v], working: [`${f.source} gives ${shown(v)}`], sure: true };
    }
    return null;
  } catch {
    return null;
  }
}

export interface StatementCheck {
  /** the claim as written: `5 x 12 = 60` */
  readonly source: string;
  readonly result: StepResult;
}

/** Every claim a text makes in arithmetic (`6 + 2 = 8`), checked. */
export function statementsIn(text: string): readonly StatementCheck[] {
  return fragments(text)
    .filter((f) => f.kind === 'statement')
    .map((f) => ({ source: f.source, result: checkStep(f.source).result }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// shapes

const lit = (t: Tok): Val | null => (t.k === 'qty' ? quantity(t.q, t.unit) : t.k === 'num' ? scalar(t.pct ? q(t.q.n, t.q.d * 100n) : t.q) : null);

function monthQuestion(text: string, toks: readonly Tok[]): Solved | null {
  if (!/\b(what|which) month\b/i.test(text)) return null;
  let birth: string | null = null;
  toks.forEach((t, i) => {
    const before = toks[i - 1];
    if (birth === null && t.k === 'word' && monthIndex(t.w) !== null && before !== undefined && before.k === 'word' && ['in', 'on', 'is'].includes(before.w)) birth = t.w;
  });
  const spans = toks.flatMap((t, i) => (t.k === 'qty' && t.unit.dim === 'month' ? [{ t, i }] : []));
  if (birth === null || spans.length === 0) return null;
  const another = spans.find(({ i }) => toks[i - 1]?.k === 'word' && ['another', 'further', 'next'].includes((toks[i - 1] as { w: string }).w));
  const age = spans.find((s) => s !== another);
  if (age === undefined && another === undefined) return null;
  const monthsOf = (t: Tok | undefined): number => {
    const v = t !== undefined && t.k === 'qty' ? baseOf(quantity(t.q, t.unit) as Extract<Val, { t: 'n' }>) : null;
    if (v === null || v.d !== 1n) throw new Fail('shape', 'whole months are needed');
    return Number(v.n);
  };
  const since = age === undefined ? 0 : monthsOf(age.t);
  const ahead = another === undefined ? 0 : monthsOf(another.t);
  const now = monthAfter(birth, since % 12);
  const then = now === null ? null : monthAfter(now, ahead);
  if (now === null || then === null) return null;
  return {
    kind: 'month',
    sum: `${birth} and ${since} months on, then ${ahead} more`,
    answers: [textAnswer(then.toLowerCase())],
    working: [`${birth} and ${since % 12} month${since % 12 === 1 ? '' : 's'} on is ${now}`, `${now} and ${ahead} more month${ahead === 1 ? '' : 's'} is ${then}`],
    sure: true,
  };
}

const LEAVE = /\b(leave|leaves|leaving|depart|departs|set off|set out|start out|go out|wake up)\b/;
const ARRIVE = /\b(arrive|arrives|arrived|arrival|get there|get to|reach|reaches|reached|finish|finishes|end|ends|get home|home|back)\b/;

function clockQuestion(text: string, toks: readonly Tok[]): Solved | null {
  const clocks = toks.flatMap((t) => (t.k === 'clock' ? [{ min: t.min, resolved: t.resolved }] : []));
  const spans = toks.flatMap((t) => (t.k === 'qty' && t.unit.dim === 'time' ? [quantity(t.q, t.unit)] : []));
  if (clocks.length === 0) return null;
  // a.m. and p.m. have full stops: a sentence ends at one only when a capital letter follows
  const sentences = text.split(/(?<=[.?!])\s+(?=[A-Z])/);
  const asking = [...sentences].reverse().find((s) => s.includes('?')) ?? sentences[sentences.length - 1] ?? '';
  const ask = asking.toLowerCase();
  const clockVal = (c: { min: number; resolved: boolean }): Val => ({ t: 'clock', min: { n: c.min === 0 ? [] : [q(c.min)], d: [q(1)] }, resolved: c.resolved });
  if (clocks.length === 2 && spans.length === 0 && /\bhow (long|many minutes|many hours)\b/.test(ask)) {
    const out = sub(clockVal(clocks[1] as (typeof clocks)[0]), clockVal(clocks[0] as (typeof clocks)[0]));
    return { kind: 'elapsed', sum: `${shown(clockVal(clocks[0] as (typeof clocks)[0]))} to ${shown(clockVal(clocks[1] as (typeof clocks)[0]))}`, answers: [out], working: [`from ${shown(clockVal(clocks[0] as (typeof clocks)[0]))} to ${shown(clockVal(clocks[1] as (typeof clocks)[0]))} is ${shown(out)}`], sure: true };
  }
  if (spans.length === 0) return null;
  const total = spans.reduce((sum, s) => add(sum, s));
  if (clocks.length === 2 && /\bhow (late|early|many minutes late|many minutes early)\b/.test(ask)) {
    const start = clockVal(clocks[0] as (typeof clocks)[0]);
    const deadline = clockVal(clocks[1] as (typeof clocks)[0]);
    const arrival = add(start, total);
    const late = sub(arrival, deadline);
    const early = sub(deadline, arrival);
    const wantsEarly = /\bearly\b/.test(ask);
    const lateMin = baseOf(late as Extract<Val, { t: 'n' }>);
    const earlyMin = baseOf(early as Extract<Val, { t: 'n' }>);
    // round the clock a small gap the wrong way round is a big one: only a gap under three hours is a lateness
    if (lateMin === null || earlyMin === null) return null;
    const limit = q(3 * 3600);
    const out = wantsEarly ? (qCmp(earlyMin, limit) < 0 ? early : null) : qCmp(lateMin, limit) < 0 ? late : null;
    if (out === null) return null;
    return { kind: 'late', sum: `${shown(start)} and ${shown(total)}, against ${shown(deadline)}`, answers: [out], working: [`${shown(start)} + ${shown(total)} = ${shown(arrival)}`, `${shown(arrival)} against ${shown(deadline)} is ${shown(out)}`], sure: true };
  }
  if (clocks.length !== 1 || !/\b(what time|when)\b/.test(ask)) return null;
  const start = clockVal(clocks[0] as (typeof clocks)[0]);
  const wantsLeave = LEAVE.test(ask);
  const wantsArrive = ARRIVE.test(ask);
  let backward: boolean | null = null;
  if (wantsLeave && !wantsArrive) backward = true;
  else if (wantsArrive && !wantsLeave) backward = false;
  const clockSentence = (sentences.find((s) => /\d\s*:\s*\d{2}|\b[ap]\.?m\b/i.test(s)) ?? '').toLowerCase();
  // a clock that is itself the leaving time cannot be what is asked for backwards from
  if (backward === true && /\b(left|leaves|woke|wake|set off|started)\b/.test(clockSentence) && !/\b(get to|be at|arrive|needed to|need to|by)\b/.test(clockSentence)) backward = null;
  if (backward === null) {
    if (/\b(before|earlier|ago)\b/.test(ask + clockSentence) && !/\b(after|later)\b/.test(ask + clockSentence)) backward = true;
    else if (/\b(after|later)\b/.test(ask + clockSentence) && !/\b(before|earlier|ago)\b/.test(ask + clockSentence)) backward = false;
  }
  if (backward === null) return null;
  const out = backward ? sub(start, total) : add(start, total);
  return { kind: 'clock', sum: `${shown(start)} ${backward ? '-' : '+'} ${shown(total)}`, answers: [out], working: [`${shown(start)} ${backward ? '−' : '+'} ${shown(total)} = ${shown(out)}`], sure: true };
}

function convertQuestion(toks: readonly Tok[]): Solved | null {
  const at = toks.findIndex((t, i) => t.k === 'word' && t.w === 'how' && toks[i + 1]?.k === 'word' && ['many', 'much'].includes((toks[i + 1] as { w: string }).w));
  if (at < 0) return null;
  let target: { unit: NonNullable<ReturnType<typeof unitFromWord>>; at: number } | null = null;
  for (let k = at + 2; k < Math.min(toks.length, at + 5) && target === null; k += 1) {
    const t = toks[k];
    const unit = t !== undefined && t.k === 'word' ? unitFromWord(t.w) : null;
    if (unit !== null) target = { unit, at: k };
  }
  if (target === null) return null;
  const source = toks.slice(target.at + 1).find((t) => t.k === 'qty');
  if (source === undefined || source.k !== 'qty') return null;
  if (source.unit.dim !== target.unit.dim) return null;
  const from = quantity(source.q, source.unit);
  const out: Val = { ...(from as Extract<Val, { t: 'n' }>), unit: target.unit };
  return { kind: 'convert', sum: `${shown(from)} in ${target.unit.name}`, answers: [out], working: [`${shown(from)} = ${shown(out)}`], sure: true };
}


const PAY = new Set(['from', 'with', 'paid', 'pays', 'pay', 'gave', 'gives', 'give', 'had', 'has', 'have', 'handed', 'note', 'using', 'uses']);
const MONEY = new Set(['dollar', 'pound', 'euro']);

function changeQuestion(text: string, toks: readonly Tok[]): Solved | null {
  if (!/\bchange\b/i.test(text)) return null;
  const moneys = toks.flatMap((t, i) => (t.k === 'qty' && MONEY.has(t.unit.dim) ? [{ t, i }] : []));
  if (moneys.length < 2) return null;
  const payer = moneys.filter(({ i }) => [1, 2, 3].some((back) => {
    const w = toks[i - back];
    return w !== undefined && w.k === 'word' && PAY.has(w.w);
  }));
  if (payer.length !== 1) return null;
  const paidTok = payer[0] as (typeof moneys)[0];
  const costs = moneys.filter((m) => m !== paidTok);
  const counted = (i: number): Val | null => {
    // `3 pens at $1.20 each`, `4 bags for $4.60 each`: a whole number a few words back, with `at`/`each` to show the price is for one
    const each = toks.slice(i + 1, i + 3).some((t) => t.k === 'word' && (t.w === 'each' || t.w === 'every'));
    for (let back = 1; back <= 4; back += 1) {
      const t = toks[i - back];
      if (t === undefined || t.k === 'qty' || t.k === 'punct') break;
      if (t.k === 'num' && t.q.d === 1n) {
        const atWord = toks[i - 1];
        const priced = each || (atWord !== undefined && atWord.k === 'word' && (atWord.w === 'at' || atWord.w === '@'));
        return priced ? scalar(t.q) : null;
      }
    }
    return null;
  };
  const lines: string[] = [];
  let spent: Val | null = null;
  let boughtN: Val | null = null;
  const bought = toks.findIndex((t, i) => t.k === 'word' && ['bought', 'buy', 'buys', 'buying', 'purchased', 'get', 'got', 'ordered'].includes(t.w) && toks[i + 1]?.k === 'num');
  if (bought >= 0) {
    const n = toks[bought + 1];
    if (n !== undefined && n.k === 'num' && n.q.d === 1n) boughtN = scalar(n.q);
  }
  for (const { t, i } of costs) {
    const price = quantity((t as Extract<Tok, { k: 'qty' }>).q, (t as Extract<Tok, { k: 'qty' }>).unit);
    let n = counted(i);
    if (n === null && costs.length === 1) n = boughtN;
    let cost = price;
    if (n !== null) {
      cost = mulVal(n, price);
      lines.push(`${shown(n)} × ${shown(price)} = ${shown(cost)}`);
    }
    spent = spent === null ? cost : add(spent, cost);
    if (spent !== cost) lines.push(`total spent ${shown(spent)}`);
  }
  if (spent === null) return null;
  const paid = quantity((paidTok.t as Extract<Tok, { k: 'qty' }>).q, (paidTok.t as Extract<Tok, { k: 'qty' }>).unit);
  const c = compare(paid, spent);
  if (c === null || c < 0) return null;
  const out = sub(paid, spent);
  lines.push(`${shown(paid)} − ${shown(spent)} = ${shown(out)}`);
  return { kind: 'change', sum: `${shown(paid)} less ${shown(spent)}`, answers: [out], working: lines, sure: true };
}


const CONTAINERS = new Set(['box', 'boxes', 'bag', 'bags', 'pack', 'packs', 'tray', 'trays', 'basket', 'baskets', 'table', 'tables', 'row', 'rows', 'team', 'teams', 'group', 'groups', 'crate', 'crates', 'car', 'cars', 'bus', 'buses', 'bundle', 'bundles', 'jar', 'jars', 'plate', 'plates', 'shelf', 'shelves', 'pot', 'pots', 'carton', 'cartons']);

/** `360 oranges, each box holds 12: how many boxes?`: how many containers of a size hold a total; a part-filled one still counts. */
function containersQuestion(toks: readonly Tok[]): Solved | null {
  const at = toks.findIndex((t, i) => t.k === 'word' && t.w === 'how' && toks[i + 1]?.k === 'word' && (toks[i + 1] as { w: string }).w === 'many');
  if (at < 0) return null;
  const noun = toks[at + 2];
  if (noun === undefined || noun.k !== 'word' || !CONTAINERS.has(noun.w)) return null;
  if (!toks.some((t) => t.k === 'word' && ['each', 'every', 'per'].includes(t.w))) return null;
  const numbers = toks.flatMap((t) => (t.k === 'num' && !t.pct && t.q.d === 1n ? [t.q] : []));
  if (numbers.length !== 2 || toks.some((t) => t.k === 'qty' || t.k === 'clock')) return null;
  const [a, b] = numbers as [Q, Q];
  const total = qCmp(a, b) >= 0 ? a : b;
  const size = total === a ? b : a;
  if (size.n === 0n) return null;
  const exact = qDiv(total, size);
  const whole = exact.d === 1n ? exact : q(qFloor(exact) + 1n);
  const lines = [`${shown(scalar(total))} ÷ ${shown(scalar(size))} = ${shown(scalar(exact))}`];
  if (exact.d !== 1n) lines.push(`a part-filled one still counts: ${shown(scalar(whole))}`);
  return { kind: 'share', sum: `${shown(scalar(total))} in ${noun.w} of ${shown(scalar(size))}`, answers: [scalar(whole)], working: lines, sure: exact.d === 1n };
}

const MUCH = new Set(['much', 'many', 'big', 'long', 'heavy', 'old', 'tall', 'wide']);

function asMuchQuestion(toks: readonly Tok[]): Solved | null {
  const factors: Q[] = [];
  const used = new Set<number>();
  toks.forEach((t, i) => {
    const as = toks[i + 1];
    const much = toks[i + 2];
    const isAsMuch = as !== undefined && as.k === 'word' && as.w === 'as' && much !== undefined && much.k === 'word' && MUCH.has(much.w);
    if (!isAsMuch) return;
    if (t.k === 'word' && (t.w === 'half' || t.w === 'twice' || t.w === 'double')) {
      factors.push(t.w === 'half' ? q(1, 2) : q(2));
      used.add(i);
    } else if (t.k === 'num' && !t.pct && t.q.d !== 1n && t.q.n > 0n) {
      factors.push(t.q);
      used.add(i);
    } else if (t.k === 'num' && t.pct) {
      factors.push(q(t.q.n, t.q.d * 100n));
      used.add(i);
    }
    const before = toks[i - 1];
    const op = toks[i];
    if (op !== undefined && op.k === 'op' && op.op === '*' && before !== undefined && before.k === 'num') {
      factors.push(before.q);
      used.add(i - 1);
    }
  });
  if (factors.length === 0) return null;
  const bases = toks.flatMap((t, i) => (!used.has(i) && (t.k === 'qty' || (t.k === 'num' && !t.pct)) ? [t] : []));
  if (bases.length !== 1) return null;
  const base = lit(bases[0] as Tok);
  if (base === null) return null;
  const stops: Val[] = [];
  let at = base;
  const lines: string[] = [];
  for (const f of factors) {
    const next = mulVal(scalar(f), at);
    lines.push(`${show(scalar(f)) ?? '?'} of ${shown(at)} = ${shown(next)}`);
    stops.push(next);
    at = next;
  }
  return { kind: 'fraction', sum: `${shown(base)} scaled by ${factors.map((f) => shown(scalar(f))).join(', then ')}`, answers: factors.length === 1 ? [at] : stops, working: lines, sure: factors.length === 1 };
}

/** The longest run of plain numbers separated by commas (and `and`): a list in a question. */
function numberRun(toks: readonly Tok[]): { values: Q[]; at: number } | null {
  let best: { values: Q[]; at: number } | null = null;
  let current: { values: Q[]; at: number } | null = null;
  toks.forEach((t, i) => {
    if (t.k === 'num' && !t.pct) {
      current = current === null ? { values: [t.q], at: i } : { values: [...current.values, t.q], at: current.at };
    } else if (t.k === 'punct' && [',', ';'].includes(t.ch)) {
      // a comma goes on with the run
    } else if (t.k === 'word' && (t.w === 'and' || t.w === 'then')) {
      // so does `and`
    } else {
      current = null;
    }
    if (current !== null && (best === null || current.values.length > best.values.length)) best = current;
  });
  return best;
}

function sequenceQuestion(text: string, toks: readonly Tok[]): Solved | null {
  if (!/\b(next|missing|continue|sequence|pattern|series)\b/i.test(text)) return null;
  const run = numberRun(toks);
  if (run === null || run.values.length < 3) return null;
  const found = nextInSequence(run.values);
  if (found.length === 0) return null;
  const distinct = new Set(found.map((f) => `${f.next.n}/${f.next.d}`));
  return {
    kind: 'sequence',
    sum: run.values.map((v) => shown(scalar(v))).join(', '),
    answers: found.map((f) => scalar(f.next)),
    working: found.map((f) => `${f.rule}: next is ${shown(scalar(f.next))}`),
    sure: distinct.size === 1,
  };
}

function orderQuestion(text: string, toks: readonly Tok[]): Solved | null {
  const run = numberRun(toks);
  if (run === null || run.values.length < 2) return null;
  const vals = run.values.map(scalar);
  const asc = [...vals].sort((a, b) => compare(a, b) ?? 0);
  const desc = [...asc].reverse();
  const t = text.toLowerCase();
  if (/\b(order|arrange|sort|put)\b/.test(t) && !/\bwhich\b/.test(t)) {
    const firstSmall = /\b(smallest|least|lowest|fewest)\b[^.?!]*\b(to|first)\b|\bascending\b|\bincreasing\b|\bsmall(est)? to (big|large|great)/.test(t);
    const firstBig = /\b(largest|biggest|greatest|highest|most)\b[^.?!]*\b(to|first)\b|\bdescending\b|\bdecreasing\b|\bbig(gest)? to small(est)?/.test(t);
    if (firstSmall && !firstBig) return { kind: 'order', sum: `${asc.map(shown).join(', ')} smallest first`, answers: [asc], working: [`smallest first: ${asc.map(shown).join(', ')}`], sure: true };
    if (firstBig && !firstSmall) return { kind: 'order', sum: `${desc.map(shown).join(', ')} largest first`, answers: [desc], working: [`largest first: ${desc.map(shown).join(', ')}`], sure: true };
    return { kind: 'order', sum: 'in order', answers: [asc, desc], working: [`smallest first: ${asc.map(shown).join(', ')}`, `largest first: ${desc.map(shown).join(', ')}`], sure: false };
  }
  if (/\b(which|circle|find|what)\b/.test(t) && /\b(largest|biggest|greatest|highest|smallest|least|lowest)\b/.test(t) && /\b(number|numbers)\b/.test(t)) {
    const big = /\b(largest|biggest|greatest|highest)\b/.test(t);
    const pick = big ? desc[0] : asc[0];
    if (pick === undefined) return null;
    return { kind: 'order', sum: `the ${big ? 'largest' : 'smallest'} of ${asc.map(shown).join(', ')}`, answers: [pick], working: [`${big ? 'largest' : 'smallest'}: ${shown(pick)}`], sure: true };
  }
  return null;
}

function signQuestion(text: string, toks: readonly Tok[]): Solved | null {
  if (!/[<>]|\b(greater|bigger|less|smaller|sign|symbol|compare)\b/i.test(text)) return null;
  const at = toks.findIndex((t, i) => (t.k === 'gap' || (t.k === 'punct' && ['○', '◯', 'o'].includes(t.ch))) && lit(toks[i - 1] as Tok) !== null && toks[i + 1] !== undefined && lit(toks[i + 1] as Tok) !== null);
  if (at < 1) return null;
  const a = lit(toks[at - 1] as Tok);
  const b = lit(toks[at + 1] as Tok);
  if (a === null || b === null) return null;
  const c = compare(a, b);
  if (c === null) return null;
  const sign = c < 0 ? '<' : c > 0 ? '>' : '=';
  return { kind: 'compare', sum: `${shown(a)} and ${shown(b)}`, answers: [textAnswer(sign)], working: [`${shown(a)} ${sign} ${shown(b)}`], sure: true };
}

/** What a question's words come to, when they are a shape this reads and the reading is certain; otherwise null. */
export function solveQuestion(text: string): Solved | null {
  const plain = stripLabel(text);
  if (plain === '') return null;
  try {
    const toks = lex(plain);
    const shapes: ((text: string, toks: readonly Tok[]) => Solved | null)[] = [
      monthQuestion,
      clockQuestion,
      (_t, k) => convertQuestion(k),
      changeQuestion,
      (_t, k) => asMuchQuestion(k),
      (_t, k) => containersQuestion(k),
      sequenceQuestion,
      signQuestion,
      orderQuestion,
    ];
    for (const shape of shapes) {
      const found = shape(plain, toks);
      if (found !== null) return found;
    }
    const sums = fragments(plain).filter((f) => f.kind !== 'statement');
    const last = sums[sums.length - 1];
    return last === undefined ? null : solveFragment(last);
  } catch {
    // words this cannot read are not a question it can answer; nothing a person typed may break the check
    return null;
  }
}

