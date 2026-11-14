// Expressions: the grammar, and evaluating it exactly.
//
//   sum   := lm  { (+|-) lm }
//   lm    := prod [ (less|more|fewer) than prod ]       `50 less than 200` is 200 - 50
//   prod  := unary { (*|/|of) unary }                   `2/3 of 96`, `half of 64`
//   unary := - unary | (half|double|twice|triple) [of] unary | (half|double) again | atom
//   atom  := number | quantity | time | gap | ( sum )

import { Fail, ONE, q, qDiv, qMod } from './rational';
import type { Q } from './rational';
import { lex } from './lex';
import type { LexOptions, Op, Tok } from './lex';
import { add, div, mul, neg, numOf, numScale, numSolve, numSub, NUM_X, quantity, scalar, scaleBy, sub } from './value';
import type { Num, Val } from './value';
import type { Unit } from './units';
import { kindName } from './units';

export interface Span {
  readonly at: number;
  readonly end: number;
}

export type Node =
  | { readonly k: 'lit'; readonly v: Val; readonly span: Span }
  | { readonly k: 'gap'; readonly unit: Unit | null; readonly span: Span }
  | { readonly k: 'bin'; readonly op: Op; readonly l: Node; readonly r: Node; readonly span: Span }
  | { readonly k: 'neg'; readonly e: Node; readonly span: Span }
  | { readonly k: 'scale'; readonly by: Q; readonly word: string; readonly e: Node; readonly span: Span }
  | { readonly k: 'cmp'; readonly dir: 'less' | 'more'; readonly a: Node; readonly b: Node; readonly span: Span }
  | { readonly k: 'prev'; readonly word: string; readonly by: Q | null; readonly span: Span };

const SCALES: Readonly<Record<string, Q>> = {
  half: q(1, 2), halve: q(1, 2), halved: q(1, 2), double: q(2), doubled: q(2), twice: q(2), triple: q(3), treble: q(3), tripled: q(3),
};

/** The word that stands for the last step's result in a step that goes on from it (`+ 12 = 34`). */
export const PREV = '__prev';

const spanOf = (a: Span, b: Span): Span => ({ at: Math.min(a.at, b.at), end: Math.max(a.end, b.end) });

function litOf(t: Tok): Val | null {
  switch (t.k) {
    case 'num':
      return t.pct ? { t: 'n', v: numOf(qDiv(t.q, q(100))), unit: null, pct: true } : scalar(t.q);
    case 'qty':
      return quantity(t.q, t.unit);
    case 'clock':
      return { t: 'clock', min: numOf(q(t.min)), resolved: t.resolved };
    default:
      return null;
  }
}

class Reader {
  pos = 0;
  depth = 0;
  constructor(
    readonly toks: readonly Tok[],
    readonly source: string,
  ) {}

  peek(n = 0): Tok | undefined {
    return this.toks[this.pos + n];
  }

  take(): Tok {
    const t = this.toks[this.pos];
    if (t === undefined) throw new Fail('unreadable', `"${this.source.trim()}" stops before it is finished`);
    this.pos += 1;
    return t;
  }

  isWord(w: string | readonly string[], n = 0): boolean {
    const t = this.peek(n);
    return t !== undefined && t.k === 'word' && (typeof w === 'string' ? t.w === w : w.includes(t.w));
  }

  sum(): Node {
    let left = this.lessMore();
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.k !== 'op' || (t.op !== '+' && t.op !== '-')) return left;
      this.pos += 1;
      const right = this.lessMore();
      left = { k: 'bin', op: t.op, l: left, r: right, span: spanOf(left.span, right.span) };
    }
  }

  lessMore(): Node {
    const a = this.prod();
    if (this.isWord(['less', 'fewer', 'more', 'greater', 'bigger']) && this.isWord('than', 1)) {
      const dir = this.isWord(['less', 'fewer']) ? 'less' : 'more';
      this.pos += 2;
      const b = this.prod();
      return { k: 'cmp', dir, a, b, span: spanOf(a.span, b.span) };
    }
    return a;
  }

  prod(): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      let op: Op | null = null;
      if (t !== undefined && t.k === 'op' && (t.op === '*' || t.op === '/')) op = t.op;
      else if (this.isWord('of')) op = '*';
      if (op === null) return left;
      this.pos += 1;
      const right = this.unary();
      left = { k: 'bin', op, l: left, r: right, span: spanOf(left.span, right.span) };
    }
  }

  unary(): Node {
    const t = this.peek();
    if (t === undefined) throw new Fail('unreadable', `"${this.source.trim()}" stops before it is finished`);
    if (t.k === 'op' && t.op === '-') {
      this.pos += 1;
      const e = this.unary();
      return { k: 'neg', e, span: spanOf(t, e.span) };
    }
    if (t.k === 'word' && Object.hasOwn(SCALES, t.w)) {
      const by = SCALES[t.w] ?? ONE;
      this.pos += 1;
      if (this.isWord('again')) {
        const again = this.take();
        return { k: 'prev', word: t.w, by, span: spanOf(t, again) };
      }
      if (this.isWord('of')) this.pos += 1;
      const e = this.unary();
      return { k: 'scale', by, word: t.w, e, span: spanOf(t, e.span) };
    }
    return this.atom();
  }

  atom(): Node {
    const t = this.take();
    const v = litOf(t);
    if (v !== null) return { k: 'lit', v, span: t };
    if (t.k === 'word' && t.w === PREV) return { k: 'prev', word: 'the last answer', by: null, span: t };
    if (t.k === 'gap') return { k: 'gap', unit: t.unit, span: t };
    if (t.k === 'lp') {
      this.depth += 1;
      if (this.depth > 40) throw new Fail('too-big', 'brackets inside brackets too many times');
      const e = this.sum();
      this.depth -= 1;
      const close = this.peek();
      if (close === undefined || close.k !== 'rp') throw new Fail('unreadable', `a bracket in "${this.source.trim()}" is never closed`);
      this.pos += 1;
      return { ...e, span: spanOf(t, close) };
    }
    const shown = this.source.slice(t.at, t.end);
    throw new Fail('unreadable', `"${shown}" is not a number or a sum I can read`);
  }
}

export interface ParseOptions extends LexOptions {
  /** words after the last number are let go (`60 flowers`) */
  readonly trailingWords?: boolean;
}

/** The whole of `source` as one expression. Throws `Fail('unreadable')` when it is not one. */
export function parseExpression(source: string, options: ParseOptions = {}): Node {
  const toks = lex(source, options);
  return parseTokens(toks, source, options);
}

export function parseTokens(toks: readonly Tok[], source: string, options: ParseOptions = {}): Node {
  const reader = new Reader(toks, source);
  const node = reader.sum();
  while (reader.pos < toks.length) {
    const t = reader.peek();
    if (t !== undefined && (t.k === 'punct' && ['.', '!', ',', ';', ':'].includes(t.ch))) {
      reader.pos += 1;
      continue;
    }
    if (t !== undefined && t.k === 'word' && options.trailingWords === true) {
      reader.pos += 1;
      continue;
    }
    const shown = t === undefined ? '' : source.slice(t.at, t.end);
    throw new Fail('unreadable', `I could not read "${shown}" in "${source.trim()}"`);
  }
  return node;
}

/** Reads one expression from the front of `toks`; returns it and how many tokens it used. For finding a sum inside a sentence. */
export function parsePrefix(toks: readonly Tok[], source: string): { node: Node; used: number } {
  const reader = new Reader(toks, source);
  const node = reader.sum();
  return { node, used: reader.pos };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// evaluating

export interface Env {
  /** the unit an unwritten gap is in */
  readonly gapUnit: Unit | null;
  /** what `half again` is half of: the last step's result */
  readonly prev: Val | null;
}

export function evalNode(node: Node, env: Env): Val {
  switch (node.k) {
    case 'lit':
      return node.v;
    case 'gap': {
      const unit = node.unit ?? env.gapUnit;
      return { t: 'n', v: unit === null ? NUM_X : numScale(NUM_X, unit.factor), unit, pct: false };
    }
    case 'bin': {
      const l = evalNode(node.l, env);
      const r = evalNode(node.r, env);
      return node.op === '+' ? add(l, r) : node.op === '-' ? sub(l, r) : node.op === '*' ? mul(l, r) : div(l, r);
    }
    case 'neg':
      return neg(evalNode(node.e, env));
    case 'scale':
      return scaleBy(evalNode(node.e, env), node.by);
    case 'cmp': {
      const a = evalNode(node.a, env);
      const b = evalNode(node.b, env);
      return node.dir === 'less' ? sub(b, a) : add(b, a);
    }
    case 'prev':
      if (env.prev === null) throw new Fail('shape', `"${node.word} again" needs an earlier step to go on from`);
      return node.by === null ? env.prev : scaleBy(env.prev, node.by);
  }
}

/** The nodes of a tree, depth first, left to right. */
export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  switch (node.k) {
    case 'bin':
      walk(node.l, visit);
      walk(node.r, visit);
      break;
    case 'neg':
    case 'scale':
      walk(node.e, visit);
      break;
    case 'cmp':
      walk(node.a, visit);
      walk(node.b, visit);
      break;
    default:
      break;
  }
}

export const countGaps = (nodes: readonly Node[]): number => {
  let n = 0;
  for (const node of nodes) walk(node, (x) => void (x.k === 'gap' && (n += 1)));
  return n;
};

const unitOfLit = (n: Node): Unit | null => (n.k === 'lit' && n.v.t === 'n' ? n.v.unit : null);

function firstUnit(node: Node): Unit | null {
  let found: Unit | null = null;
  walk(node, (n) => {
    if (found === null) found = unitOfLit(n);
  });
  return found;
}

/** The unit a gap with none written is in: that of what it is added to or taken from, else the first measurement in the equation. */
export function gapUnitOf(nodes: readonly Node[]): Unit | null {
  let written: Unit | null = null;
  for (const root of nodes) walk(root, (n) => void (n.k === 'gap' && n.unit !== null && written === null && (written = n.unit)));
  if (written !== null) return written;
  let sibling: Unit | null = null;
  for (const root of nodes) {
    walk(root, (n) => {
      if (sibling !== null) return;
      if (n.k === 'bin' && (n.op === '+' || n.op === '-')) {
        if (n.l.k === 'gap') sibling = firstUnit(n.r);
        else if (n.r.k === 'gap') sibling = firstUnit(n.l);
      } else if (n.k === 'cmp') {
        if (n.a.k === 'gap') sibling = firstUnit(n.b);
        else if (n.b.k === 'gap') sibling = firstUnit(n.a);
      }
    });
  }
  if (sibling !== null) return sibling;
  for (const root of nodes) {
    const unit = firstUnit(root);
    if (unit !== null) return unit;
  }
  return null;
}

export interface Found {
  /** the amount in `unit` (a plain number when `unit` is null); for a time of day gap, minutes */
  readonly x: Q;
  readonly unit: Unit | null;
}

/** The gap that makes `left` equal `right`, exactly. Throws `Fail` with the reason when there is none, or more than one. */
export function solveGap(left: Node, right: Node, prev: Val | null = null): Found {
  if (countGaps([left, right]) !== 1) throw new Fail('unsupported', 'a sum with one missing number is the one I can solve');
  const unit = gapUnitOf([left, right]);
  const env: Env = { gapUnit: unit, prev };
  const a = evalNode(left, env);
  const b = evalNode(right, env);
  let lv: Num;
  let rv: Num;
  let modulus: bigint | null = null;
  if (a.t === 'clock' || b.t === 'clock') {
    if (a.t !== 'clock' || b.t !== 'clock') throw new Fail('shape', 'a time of day cannot equal a plain number');
    lv = a.min;
    rv = b.min;
    modulus = a.resolved && b.resolved ? 1440n : 720n;
  } else {
    if (a.unit !== null && b.unit !== null && a.unit.dim !== b.unit.dim) throw new Fail('unit', `${kindName(a.unit.dim)} and ${kindName(b.unit.dim)} cannot be equal`);
    lv = b.unit !== null && a.unit === null ? numScale(a.v, b.unit.factor) : a.v;
    rv = a.unit !== null && b.unit === null ? numScale(b.v, a.unit.factor) : b.v;
  }
  if (modulus !== null) {
    // time round the clock: the span that fits, least first
    const diff = numSub(lv, rv);
    const solved = numSolve(diff, numOf(q(0)));
    if (solved.kind !== 'one') throw new Fail('unsupported', 'that time sum has no single answer');
    return { x: q(qMod(solved.x, modulus)), unit };
  }
  const solved = numSolve(lv, rv);
  if (solved.kind === 'none') throw new Fail('shape', 'no number makes that true');
  if (solved.kind === 'any') throw new Fail('shape', 'any number makes that true');
  if (solved.kind === 'unsupported') throw new Fail('unsupported', 'that has the unknown in too many places to solve');
  return { x: solved.x, unit };
}

