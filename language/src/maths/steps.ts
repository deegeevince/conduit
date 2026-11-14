// The step checker: a learner's working, transcribed line by line ("61 - 50 = 11", "12 + 12 + 12 = 36", "half of 64 = 32"), checked with exact
// arithmetic. It says which step first goes wrong and how ("12 + 12 is 24, not 22").
//
// Two rules keep it fair. A line it cannot read is `unreadable`, never `wrong`: handwriting is read by a model, and a misread is not a mistake.
// And a step that goes on from the one before ("+ 12 = 34", "= 22", "half again") goes on from what she wrote, so one slip is one finding, not
// five.

import { Fail, q, qAbs, qDiv, qEq, qIsInt, qIsZero, qSub, qText } from './rational';
import { PREV, countGaps, evalNode, gapUnitOf, parseTokens, solveGap } from './ast';
import type { Node } from './ast';
import { lex } from './lex';
import type { Op, Tok } from './lex';
import { baseOf, dimOf, same, show, writtenOf } from './value';
import type { Val } from './value';

export type StepVerdict = 'right' | 'wrong' | 'unreadable' | 'unchecked';

export interface StepResult {
  /** where it is in the working, from 0 */
  readonly index: number;
  readonly text: string;
  readonly verdict: StepVerdict;
  /** one sentence about this step, for the one who reads it: "12 + 12 is 24, not 22" */
  readonly said: string;
  /** the side that was worked out, as written ("12 + 12") */
  readonly sum: string | null;
  /** what that works out to */
  readonly expected: string | null;
  /** what the line said it was */
  readonly claimed: string | null;
  /** the value the next step goes on from */
  readonly result: string | null;
  /** a gentle pointer at the likely slip, when there is a recognisable one: "out by one" */
  readonly clue: string | null;
  /** the kind of slip */
  readonly slip: Slip | null;
}

export type Slip = 'out-by-one' | 'out-by-ten' | 'place-value' | 'digits-swapped' | 'wrong-operation' | 'conversion' | 'units' | 'divide-by-zero';

export interface WorkingResult {
  readonly steps: readonly StepResult[];
  /** the first step that is wrong, from 0; null when none is */
  readonly firstWrong: number | null;
  /** no step is wrong (unreadable ones are not wrong) */
  readonly ok: boolean;
  /** steps that could not be read, from 0 */
  readonly unreadable: readonly number[];
  /** the value the working ends on, as text */
  readonly last: string | null;
  /** the value the working ends on */
  readonly lastValue: Val | null;
}

const LABEL = /^\s*(?:step\s*\d+\s*[:.)-]?\s*|\(?\d{1,2}[.)]\s+|\(?[a-z][.)]\s+)/i;
const LEAD_IN = /^\s*(?:so|then|now|next|and|therefore|thus|answer|working|total|that is|that's)\s*[:,-]?\s+/i;

/** A printed question without its number (`5.`, `(b)`, `Step 2:`). */
export function stripLabel(text: string): string {
  return text.trim().replace(LABEL, '').trim();
}

/** A line of working without its number or label (`5.`, `Step 2:`, `Answer:`). */
export function cleanLine(text: string): string {
  let out = text.trim().replace(LABEL, '').replace(LEAD_IN, '');
  out = out.replace(/^\s*[a-z ]{1,24}:\s*(?=\S)/i, '').trim();
  // a tick, a cross, an aside in brackets with no number in it: marks beside the working, not part of it
  out = out.replace(/[✓✔✗✘☑]+\s*$/u, '').replace(/\s*\([^()\d]*\)\s*$/, '');
  return out.replace(/[.!]+$/, '').trim();
}

const OP_WORD: Readonly<Record<Op, string>> = { '+': 'adding', '-': 'taking away', '*': 'multiplying', '/': 'dividing' };

/** A side of the line as it was written; a side that goes on from the step before reads as that step's number. */
function snippet(source: string, tokens: readonly Tok[], prevText: string | null = null): string {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first === undefined || last === undefined) return '';
  const written = source.slice(first.at, last.end).replace(/\s+/g, ' ').trim();
  return first.k === 'word' && first.w === PREV && prevText !== null ? `${prevText} ${written}`.trim() : written;
}

function splitOnEquals(toks: readonly Tok[]): Tok[][] {
  const parts: Tok[][] = [[]];
  for (const t of toks) {
    if (t.k === 'eq') parts.push([]);
    else (parts[parts.length - 1] as Tok[]).push(t);
  }
  return parts;
}

const isSimple = (n: Node): boolean => n.k === 'lit' || (n.k === 'neg' && n.e.k === 'lit');

/** A recognisable slip: what the answer she wrote is a near miss of. */
function diagnose(node: Node, expected: Val, claimed: Val): { slip: Slip; clue: string } | null {
  if (expected.t !== 'n' || claimed.t !== 'n') return null;
  const e = baseOf(expected);
  const c = baseOf(claimed);
  if (e === null || c === null) return null;
  // a plain slip of the same kind of number: compare in the unit it is shown in
  const ew = writtenOf(expected) ?? e;
  const cw = writtenOf(claimed) ?? c;
  const gap = qAbs(qSub(ew, cw));
  if (qEq(gap, q(1)) && qIsInt(ew)) return { slip: 'out-by-one', clue: 'one out: count it again' };
  if ((qEq(gap, q(10)) || qEq(gap, q(100))) && qIsInt(ew)) return { slip: 'out-by-ten', clue: 'a ten is out: check the tens column' };
  if (!qIsZero(ew) && !qIsZero(cw)) {
    const ratio = qDiv(cw, ew);
    for (const factor of [10, 100, 1000]) {
      if (qEq(ratio, q(factor)) || qEq(ratio, q(1, factor))) {
        return expected.unit !== null || claimed.unit !== null
          ? { slip: 'conversion', clue: 'the size is out by a power of ten: check the conversion' }
          : { slip: 'place-value', clue: 'a zero looks missing or extra' };
      }
    }
  }
  if (qIsInt(ew) && qIsInt(cw) && ew.n > 9n && ew.n < 10n ** 6n && !ew.n.toString().endsWith('0')) {
    const reversed = BigInt([...ew.n.toString()].reverse().join(''));
    const swapped = swapAdjacent(ew.n.toString());
    if (cw.n === reversed || swapped.includes(cw.n.toString())) return { slip: 'digits-swapped', clue: 'the digits look swapped' };
  }
  if (node.k === 'bin') {
    for (const other of ['+', '-', '*', '/'] as const) {
      if (other === node.op) continue;
      try {
        const swappedNode: Node = { ...node, op: other };
        const value = evalNode(swappedNode, { gapUnit: null, prev: null });
        if (same(value, claimed)) return { slip: 'wrong-operation', clue: `that is what ${OP_WORD[other]} gives; the sum says ${OP_WORD[node.op]}` };
      } catch {
        // an operation that cannot be done is not the slip
      }
    }
  }
  return null;
}

function swapAdjacent(digits: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < digits.length; i += 1) {
    const chars = [...digits];
    [chars[i], chars[i + 1]] = [chars[i + 1] ?? '', chars[i] ?? ''];
    if (chars[0] !== '0') out.push(chars.join(''));
  }
  return out;
}

const blank = (index: number, text: string): StepResult => ({ index, text, verdict: 'unreadable', said: '', sum: null, expected: null, claimed: null, result: null, clue: null, slip: null });

/** Where two claims meet on one line: `25 + 25 = 50 → 50 + 50 = 100`, `7 + 7 = 14 so 14 + 1 = 15`. */
const JOIN = /\s*(?:→|->|=>|;|\band then\b|\bso\b|\bthen\b)\s*/i;

/** Checks one line of working. `prev` is what the step before it ended on, for a line that goes on from it. */
export function checkStep(raw: string, index = 0, prev: Val | null = null): { result: StepResult; carry: Val | null } {
  const base = blank(index, raw);
  const text = cleanLine(raw);
  if (text === '') return { result: { ...base, said: 'this line is empty' }, carry: prev };
  const pieces = text.split(JOIN).filter((piece) => piece.trim() !== '');
  if (pieces.length > 1) {
    // several claims on one line: each is checked, and the line is as wrong as the first that is
    let carry = prev;
    const results: StepResult[] = [];
    for (const piece of pieces) {
      const one = checkStep(piece, index, carry);
      results.push({ ...one.result, text: raw });
      carry = one.carry;
    }
    const picked = results.find((r) => r.verdict === 'wrong') ?? results.find((r) => r.verdict === 'unreadable') ?? (results[results.length - 1] as StepResult);
    return { result: picked, carry };
  }
  try {
    let toks = lex(text, { eqWords: true });
    const first = toks[0];
    // a line that goes on from the last: `= 22`, `+ 12 = 34`, `- 5`, `half again`
    if (first !== undefined && prev !== null) {
      const spaced = first.k === 'op' && first.op === '-' && /^\s/.test(text.slice(first.end));
      if (first.k === 'eq') toks = [{ k: 'word', w: PREV, at: first.at, end: first.at }, ...toks];
      else if (first.k === 'op' && (first.op !== '-' || spaced)) toks = [{ k: 'word', w: PREV, at: first.at, end: first.at }, ...toks];
    }
    const parts = splitOnEquals(toks).filter((part, i, all) => part.length > 0 || i < all.length - 1 || all.length === 1);
    const nodes: Node[] = [];
    for (const part of parts) {
      if (part.length === 0) throw new Fail('unreadable', 'a side of the = is empty');
      nodes.push(parseTokens(part, text, { trailingWords: true }));
    }
    const prevText = prev === null ? null : show(prev);
    const snip = (i: number): string => snippet(text, parts[i] ?? [], prevText);
    const env = { gapUnit: gapUnitOf(nodes), prev };
    const gaps = countGaps(nodes);
    if (gaps > 0) return withGap(index, raw, text, parts, nodes, prev);

    const values = nodes.map((n) => evalNode(n, env));
    const shown = values.map((v) => show(v) ?? '?');
    const lastValue = values[values.length - 1] ?? null;
    if (nodes.length === 1) {
      return { result: { ...base, verdict: 'unchecked', said: `${snip(0)} is ${shown[0] ?? '?'}; nothing is claimed to check`, sum: snip(0), expected: shown[0] ?? null, result: shown[0] ?? null }, carry: values[0] ?? null };
    }
    for (let i = 0; i + 1 < nodes.length; i += 1) {
      const left = nodes[i] as Node;
      const right = nodes[i + 1] as Node;
      const lv = values[i] as Val;
      const rv = values[i + 1] as Val;
      if (same(lv, rv)) continue;
      const leftText = snip(i);
      const rightText = snip(i + 1);
      const [workedNode, workedVal, workedText, claimedVal, claimedText] = isSimple(left) && !isSimple(right) ? [right, rv, rightText, lv, leftText] : [left, lv, leftText, rv, rightText];
      let said: string;
      let slip: { slip: Slip; clue: string } | null = null;
      if (left.k === 'prev' && left.by === null && isSimple(right)) {
        said = `the step before ended on ${shown[i]}, but this line says ${shown[i + 1]}`;
      } else if (isSimple(left) && isSimple(right)) {
        // the same kind of measurement in two units (`3 weeks = 20 days`): say what the first is in the second's unit
        said =
          lv.t === 'n' && rv.t === 'n' && lv.unit !== null && rv.unit !== null && lv.unit.dim === rv.unit.dim && lv.unit.name !== rv.unit.name
            ? `${leftText} is ${show({ ...lv, unit: rv.unit }) ?? '?'}, not ${rightText}`
            : `${shown[i]} is not ${shown[i + 1]}`;
      } else if (isSimple(left) !== isSimple(right)) {
        said = `${workedText} is ${show(workedVal) ?? '?'}, not ${claimedText}`;
        slip = diagnose(workedNode, workedVal, claimedVal);
      } else {
        said = `${leftText} is ${shown[i]}, but ${rightText} is ${shown[i + 1]}`;
      }
      const unitMismatch = dimOf(lv) !== dimOf(rv) && dimOf(lv) !== null && dimOf(rv) !== null;
      return {
        result: {
          ...base,
          verdict: 'wrong',
          said: unitMismatch ? `${said}: they are not the same kind of thing` : said,
          sum: workedText,
          expected: show(workedVal),
          claimed: show(claimedVal),
          result: show(rv),
          clue: slip?.clue ?? null,
          slip: slip?.slip ?? null,
        },
        carry: rv,
      };
    }
    const claimedText = shown[shown.length - 1] ?? null;
    return { result: { ...base, verdict: 'right', said: `${snip(0)} is ${shown[0] ?? '?'}`, sum: snip(0), expected: shown[0] ?? null, claimed: claimedText, result: claimedText }, carry: lastValue };
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    if (error.code === 'unit' || error.code === 'zero') {
      return { result: { ...base, verdict: 'wrong', said: error.message, slip: error.code === 'zero' ? 'divide-by-zero' : 'units', clue: null }, carry: prev };
    }
    return { result: { ...base, verdict: 'unreadable', said: `could not read this line as a sum (${error.message})` }, carry: prev };
  }
}

/** A line with a missing number in it (`8 + □ = 20`, `100 − ? = 50`): the number that fits, which is no mistake of hers. */
function withGap(index: number, raw: string, text: string, parts: readonly (readonly Tok[])[], nodes: readonly Node[], prev: Val | null): { result: StepResult; carry: Val | null } {
  const base = blank(index, raw);
  const prevText = prev === null ? null : show(prev);
  const shown = (i: number): string => snippet(text, parts[i] ?? [], prevText);
  if (nodes.length === 2) {
    const left = nodes[0] as Node;
    const right = nodes[1] as Node;
    const gapSide = countGaps([left]) > 0 ? left : right;
    const other = gapSide === left ? right : left;
    // a bare `?` after the = is what the question asks, not a gap to solve
    if (gapSide.k === 'gap' && gapSide === right) {
      const env = { gapUnit: gapUnitOf(nodes), prev };
      const value = evalNode(other, env);
      return { result: { ...base, verdict: 'unchecked', said: `${shown(0)} is ${show(value) ?? '?'}`, sum: shown(0), expected: show(value), result: show(value) }, carry: value };
    }
    const found = solveGap(left, right, prev);
    const text2 = found.unit === null ? qText(found.x) : `${qText(found.x)} ${found.unit.name}`;
    return { result: { ...base, verdict: 'unchecked', said: `the missing number in ${shown(0)} = ${shown(1)} is ${text2}`, sum: `${shown(0)} = ${shown(1)}`, expected: text2, result: null }, carry: prev };
  }
  return { result: { ...base, verdict: 'unchecked', said: 'a line with a gap and more than one =', sum: null }, carry: prev };
}

/** Checks a whole working, in order. Each line goes on from what the one before it ended on. */
export function checkSteps(lines: readonly string[]): WorkingResult {
  const steps: StepResult[] = [];
  let carry: Val | null = null;
  lines.forEach((line, index) => {
    let outcome: ReturnType<typeof checkStep>;
    try {
      outcome = checkStep(line, index, carry);
    } catch (error) {
      // a line is never allowed to break the check of the rest: whatever went wrong, it is a line that could not be read
      outcome = { result: { ...blank(index, line), said: error instanceof Fail ? error.message : 'could not read this line as a sum' }, carry };
    }
    steps.push(outcome.result);
    carry = outcome.carry;
  });
  const firstWrong = steps.findIndex((s) => s.verdict === 'wrong');
  const lastVal: Val | null = carry;
  return {
    steps,
    firstWrong: firstWrong < 0 ? null : firstWrong,
    ok: firstWrong < 0,
    unreadable: steps.flatMap((s) => (s.verdict === 'unreadable' ? [s.index] : [])),
    last: lastVal === null ? null : show(lastVal),
    lastValue: lastVal,
  };
}

