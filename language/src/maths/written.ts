// The digit algorithms of a written method: a sum and the options of a `math` line in, a grid of cells out. Pure: no clock, no DOM, no
// randomness. The painter lays the grid out (M2) and the page's cells are these cells; the brain writes none of it, so the working cannot be wrong.
//
// A cell is one stretch of paper: a digit (or, in an exchange, the new value of a digit, or in expanded form a place's whole value), a sign, or a rule.
// `value` is always the true value of the cell; `blank` says the learner is the one to write it, so a painter must not draw or speak it (see `visibleText`).
//
// The algorithms are the school ones, fixed: carries above the column; subtraction by crossing out and exchanging, the new value
// written above; short multiplication with its carries above; decimals aligned on the point.
import type { MathBlank, MathCarry, MathMethod } from '../vocabulary';
import { addDec, placeName, readDec, readSum, showDec } from './sum';
import type { Dec, MathSum } from './sum';

export type CellRole = 'given' | 'sign' | 'rule' | 'carry' | 'answer' | 'working';

export interface Cell {
  /** what a line names it by: `r2-tens` (a given digit), `carry-tens`, `ex-tens`, `ans-ones`, `sign`, `rule` (`m1.<part>`) */
  readonly part: string;
  readonly role: CellRole;
  /** the row of the sheet, from the top, and the column, from the left (column 0 is the sign's) */
  readonly row: number;
  readonly col: number;
  /** how many columns it spans: a rule runs the whole width */
  readonly span: number;
  /** the power of ten of the digit it belongs to (0 is the ones, -1 the tenths); null for a sign and a rule, and for the numbers of a bond */
  readonly place: number | null;
  /** what belongs here, true: a digit, `13` for an exchanged digit, `300` for an expanded place, a sign, ''. '' means nothing is written (no carry) */
  readonly value: string;
  /** the learner writes it: the painter shows an empty cell and must not draw or speak `value` */
  readonly blank: boolean;
  /** a blank the learner may leave (a carry held in the head is not marked down); a wrong one is */
  readonly optional: boolean;
  /** a given digit that was exchanged away: struck through once the working above it is written */
  readonly crossed: boolean;
  /** the step that writes it (the stepper's n); 0 is what is there from the start */
  readonly step: number;
  /** its place in working order (0 is first); null for a cell nobody writes (a given, a sign, a rule, a carry of nothing) */
  readonly order: number | null;
}

export interface Grid {
  readonly method: 'column' | 'times' | 'split' | 'bond';
  readonly rows: number;
  readonly cols: number;
  /** the decimal point sits between the column of this place and the one of the place after it; null when there is none */
  readonly pointAfter: number | null;
  readonly cells: readonly Cell[];
  /** the steps there are (the stepper's last n) */
  readonly steps: number;
  /** indexes into `cells`, in working order: right to left for a column, left to right for expanded form */
  readonly order: readonly number[];
  /** the answer as the sum comes to it, in the same digits as the answer cells (`4.0`, not `4`): sealed, never drawn unless the cells are */
  readonly answer: string;
  readonly worked: boolean;
}

export interface WrittenOptions {
  readonly worked?: boolean;
  readonly blank?: MathBlank;
  readonly carry?: MathCarry;
}

/** What `worked` and `blank=` and `carry=` come to for each kind of cell. */
interface Modes {
  readonly worked: boolean;
  readonly carry: MathCarry;
  readonly required: boolean;
}

function modesOf(options: WrittenOptions): Modes {
  return { worked: options.worked === true, carry: options.carry ?? 'write', required: options.blank === 'all' };
}

/** Builds a sheet cell by cell, and the working order as the cells that are written are added. */
class Sheet {
  readonly cells: Cell[] = [];
  readonly order: number[] = [];

  add(cell: Omit<Cell, 'order' | 'span' | 'optional' | 'crossed'> & { readonly span?: number; readonly optional?: boolean; readonly crossed?: boolean }, written: boolean): number {
    const at = this.cells.length;
    this.cells.push({ span: 1, optional: false, crossed: false, ...cell, order: written ? this.order.length : null });
    if (written) this.order.push(at);
    return at;
  }

  cross(at: number): void {
    const cell = this.cells[at];
    if (cell !== undefined) this.cells[at] = { ...cell, crossed: true };
  }
}

/** The digits of a canonical number by place: `12.75` is { 1: 1, 0: 2, -1: 7, -2: 5 }. */
function digitsOf(number: string): Map<number, number> {
  const [whole = '', fraction = ''] = number.split('.');
  const out = new Map<number, number>();
  [...whole].forEach((digit, at) => out.set(whole.length - 1 - at, Number(digit)));
  [...fraction].forEach((digit, at) => out.set(-(at + 1), Number(digit)));
  return out;
}

const topOf = (number: string): number => (number.split('.')[0] ?? '').length - 1;
const lowOf = (number: string): number => -(number.split('.')[1] ?? '').length;
const named = (place: number): string => placeName(place) ?? `p${place}`;

/** The grid of `sum` under `options`; null for a picture (bar, groups, array, line), which the painter draws from the numbers. */
export function written(sum: MathSum, options: WrittenOptions = {}): Grid | null {
  const modes = modesOf(options);
  switch (sum.method) {
    case 'column':
      return sum.op === '+' ? columnAdd(sum.operands, modes) : columnSubtract(sum.operands[0] ?? '0', sum.operands[1] ?? '0', modes);
    case 'times':
      return times(sum.operands[0], sum.operands[1], modes);
    case 'split':
      return split(sum.operands[0], modes);
    case 'bond':
      return bond(sum.whole, sum.parts[0], sum.parts[1], modes);
    default:
      return null;
  }
}

/** The grid of the sum a `math` line writes, from its words; null when the sum cannot be read or the method is a picture. */
export function gridOf(line: { readonly method: MathMethod; readonly sum: string; readonly worked?: boolean; readonly blank?: MathBlank; readonly carry?: MathCarry }): Grid | null {
  const read = readSum(line.method, line.sum);
  return read.ok ? written(read.sum, { worked: line.worked, blank: line.blank, carry: line.carry }) : null;
}

/** What is on the page for the learner: every cell that is not blank, row by row, left to right. Never a blank cell's value. */
export function visibleText(grid: Grid): string {
  const rows: string[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    const cells = grid.cells.filter((cell) => cell.row === row && !cell.blank && cell.value !== '').sort((a, b) => a.col - b.col);
    if (cells.length > 0) rows.push(cells.map((cell) => cell.value).join(' '));
  }
  return rows.join('\n');
}

/**
 * How a carry is drawn. A carry above the leading digit of the answer IS that digit, so even when carries are shown (`carry=shown`) it stays for the
 * learner to write (`leaks`): the answer's digits are never among what is given. Only `worked` shows it.
 */
function carryCell(modes: Modes, value: number, leaks: boolean): { readonly shown: boolean; readonly blank: boolean; readonly optional: boolean } {
  const present = value > 0;
  const shown = modes.worked || (modes.carry === 'shown' && !leaks);
  return { shown, blank: present && !shown, optional: present && !shown && !modes.required };
}

// --- a column: addition of any number of rows, decimals aligned on the point --------------------------------------------------------

function columnAdd(operands: readonly string[], modes: Modes): Grid {
  const rowsOf = operands.map(digitsOf);
  const low = Math.min(...operands.map(lowOf));
  const high = Math.max(...operands.map(topOf));
  // the digits the sum is made of, right to left, with what is carried
  const answer = new Map<number, number>();
  const carryIn = new Map<number, number>();
  let carry = 0;
  let place = low;
  let top = low;
  while (place <= high || carry > 0) {
    carryIn.set(place, carry);
    const total = rowsOf.reduce((sum, row) => sum + (row.get(place) ?? 0), 0) + carry;
    answer.set(place, total % 10);
    carry = Math.floor(total / 10);
    top = place;
    place += 1;
  }
  const left = Math.max(top, 0);
  const cols = left - low + 2;
  const colOf = (at: number): number => 1 + (left - at);
  const stepOf = (at: number): number => at - low + 1;
  const sheet = new Sheet();
  const n = operands.length;
  // the carry row, then the rows, the rule, the answer; filled in working order
  const rule = n + 1;
  const answerRow = n + 2;
  // given cells and signs (nothing to write)
  operands.forEach((operand, at) => {
    const row = at + 1;
    rowsOf[at]?.forEach((digit, where) => {
      sheet.add({ part: `r${row}-${named(where)}`, role: 'given', row, col: colOf(where), place: where, value: String(digit), blank: false, step: 0 }, false);
    });
    if (at === n - 1) sheet.add({ part: 'sign', role: 'sign', row, col: 0, place: null, value: '+', blank: false, step: 0 }, false);
  });
  sheet.add({ part: 'rule', role: 'rule', row: rule, col: 0, span: cols, place: null, value: '', blank: false, step: 0 }, false);
  for (let at = low; at <= top; at += 1) {
    sheet.add({ part: `ans-${named(at)}`, role: 'answer', row: answerRow, col: colOf(at), place: at, value: String(answer.get(at) ?? 0), blank: !modes.worked, step: stepOf(at) }, true);
    // the carry out of this place is written above the next
    if (at < top && carryIn.has(at + 1)) {
      const value = carryIn.get(at + 1) ?? 0;
      if (modes.carry !== 'none') {
        const kind = carryCell(modes, value, at + 1 > high);
        sheet.add({ part: `carry-${named(at + 1)}`, role: 'carry', row: 0, col: colOf(at + 1), place: at + 1, value: value > 0 ? String(value) : '', blank: kind.blank, optional: kind.optional, step: stepOf(at) }, value > 0);
      }
    }
  }
  return finish('column', sheet, answerRow + 1, cols, low < 0 ? 0 : null, top - low + 1, answerText(answer, low, top), modes);
}

// --- subtraction by exchange ------------------------------------------------------------------------------------------------------

function columnSubtract(minuend: string, subtrahend: string, modes: Modes): Grid {
  const a = digitsOf(minuend);
  const b = digitsOf(subtrahend);
  const low = Math.min(lowOf(minuend), lowOf(subtrahend));
  const high = topOf(minuend);
  // the top number, padded with the zeros a decimal's shorter end is written with
  const now = new Map<number, number>();
  for (let at = low; at <= high; at += 1) now.set(at, a.get(at) ?? 0);
  const answer = new Map<number, number>();
  /** which places were exchanged, with the value written above them, and the step that wrote it */
  const exchanged = new Map<number, { value: number; step: number }>();
  for (let at = low; at <= high; at += 1) {
    const need = b.get(at) ?? 0;
    if ((now.get(at) ?? 0) < need) {
      // take one from the nearest place to the left that has one; every zero passed becomes a nine
      let from = at + 1;
      while ((now.get(from) ?? 0) === 0) from += 1;
      for (let between = from - 1; between > at; between -= 1) now.set(between, 9);
      now.set(from, (now.get(from) ?? 0) - 1);
      now.set(at, (now.get(at) ?? 0) + 10);
      for (let touched = at; touched <= from; touched += 1) exchanged.set(touched, { value: now.get(touched) ?? 0, step: at - low + 1 });
    }
    answer.set(at, (now.get(at) ?? 0) - need);
  }
  // the answer is written from its first digit; leading zeros are no cells
  let top = high;
  while (top > 0 && (answer.get(top) ?? 0) === 0) top -= 1;
  const left = Math.max(high, 0);
  const cols = left - low + 2;
  const colOf = (at: number): number => 1 + (left - at);
  const stepOf = (at: number): number => at - low + 1;
  const sheet = new Sheet();
  const givens = new Map<number, number>();
  for (let at = low; at <= high; at += 1) {
    givens.set(at, sheet.add({ part: `r1-${named(at)}`, role: 'given', row: 1, col: colOf(at), place: at, value: String(a.get(at) ?? 0), blank: false, step: 0 }, false));
  }
  b.forEach((digit, at) => sheet.add({ part: `r2-${named(at)}`, role: 'given', row: 2, col: colOf(at), place: at, value: String(digit), blank: false, step: 0 }, false));
  sheet.add({ part: 'sign', role: 'sign', row: 2, col: 0, place: null, value: '-', blank: false, step: 0 }, false);
  sheet.add({ part: 'rule', role: 'rule', row: 3, col: 0, span: cols, place: null, value: '', blank: false, step: 0 }, false);
  for (let at = low; at <= top; at += 1) {
    // the exchange is written in the step of the place that needed it, the lender first and the borrower last, then the answer digit of the place
    for (const [place, change] of [...exchanged].filter(([, change]) => change.step === stepOf(at)).sort(([x], [y]) => y - x)) {
      if (modes.carry === 'none') continue;
      // an exchange that leaves exactly the answer's digit in its place (nothing under it to take away) would give that digit: it is held back unless worked
      const shown = modes.worked || (modes.carry === 'shown' && change.value !== answer.get(place));
      const cross = givens.get(place);
      if (cross !== undefined) sheet.cross(cross);
      sheet.add({ part: `ex-${named(place)}`, role: 'working', row: 0, col: colOf(place), place, value: String(change.value), blank: !shown, optional: !shown && !modes.required, step: change.step }, true);
    }
    sheet.add({ part: `ans-${named(at)}`, role: 'answer', row: 4, col: colOf(at), place: at, value: String(answer.get(at) ?? 0), blank: !modes.worked, step: stepOf(at) }, true);
  }
  // with no exchange cells nothing is crossed on the page, but the digits that were exchanged away are still known to the model
  if (modes.carry === 'none') for (const place of exchanged.keys()) sheet.cross(givens.get(place) ?? -1);
  return finish('column', sheet, 5, cols, low < 0 ? 0 : null, top - low + 1, answerText(answer, low, top), modes);
}

// --- short multiplication ---------------------------------------------------------------------------------------------------------

function times(number: string, digit: string, modes: Modes): Grid {
  const d = digitsOf(number);
  const m = Number(digit);
  const high = topOf(number);
  const product = (BigInt(number) * BigInt(digit)).toString();
  const top = product.length - 1;
  const answer = new Map<number, number>();
  const carryIn = new Map<number, number>();
  let carry = 0;
  for (let at = 0; at <= top; at += 1) {
    carryIn.set(at, carry);
    const total = (d.get(at) ?? 0) * m + carry;
    answer.set(at, total % 10);
    carry = Math.floor(total / 10);
  }
  // a multiplicand wider than the product (47 × 0) still needs its own columns
  const left = Math.max(top, high);
  const cols = left + 2;
  const colOf = (at: number): number => 1 + (left - at);
  const sheet = new Sheet();
  for (let at = 0; at <= high; at += 1) sheet.add({ part: `r1-${named(at)}`, role: 'given', row: 1, col: colOf(at), place: at, value: String(d.get(at) ?? 0), blank: false, step: 0 }, false);
  sheet.add({ part: 'r2-ones', role: 'given', row: 2, col: colOf(0), place: 0, value: digit, blank: false, step: 0 }, false);
  sheet.add({ part: 'sign', role: 'sign', row: 2, col: 0, place: null, value: '×', blank: false, step: 0 }, false);
  sheet.add({ part: 'rule', role: 'rule', row: 3, col: 0, span: cols, place: null, value: '', blank: false, step: 0 }, false);
  for (let at = 0; at <= top; at += 1) {
    sheet.add({ part: `ans-${named(at)}`, role: 'answer', row: 4, col: colOf(at), place: at, value: String(answer.get(at) ?? 0), blank: !modes.worked, step: at + 1 }, true);
    if (at < top && modes.carry !== 'none') {
      const value = carryIn.get(at + 1) ?? 0;
      const kind = carryCell(modes, value, at + 1 > high);
      sheet.add({ part: `carry-${named(at + 1)}`, role: 'carry', row: 0, col: colOf(at + 1), place: at + 1, value: value > 0 ? String(value) : '', blank: kind.blank, optional: kind.optional, step: at + 1 }, value > 0);
    }
  }
  return finish('times', sheet, 5, cols, null, top + 1, product, modes);
}

// --- expanded form -----------------------------------------------------------------------------------------------------------------

function split(number: string, modes: Modes): Grid {
  const d = digitsOf(number);
  const high = topOf(number);
  const low = lowOf(number);
  const places = [] as number[];
  for (let at = high; at >= low; at -= 1) places.push(at);
  // each digit has two columns: its own, and the sign that follows it; the equals sign sits after the number
  const sheet = new Sheet();
  const colOf = (at: number): number => 2 * (high - at);
  places.forEach((at) => sheet.add({ part: `r1-${named(at)}`, role: 'given', row: 0, col: colOf(at), place: at, value: String(d.get(at) ?? 0), blank: false, step: 0 }, false));
  const nonzero = places.filter((at) => (d.get(at) ?? 0) !== 0);
  let step = 0;
  const parts: string[] = [];
  nonzero.forEach((at, index) => {
    step += 1;
    const digit = String(d.get(at) ?? 0);
    const value = at >= 0 ? digit + '0'.repeat(at) : `0.${'0'.repeat(-at - 1)}${digit}`;
    parts.push(value);
    sheet.add({ part: `ans-${named(at)}`, role: 'answer', row: 1, col: colOf(at), place: at, value, blank: !modes.worked, step }, true);
    if (index < nonzero.length - 1) sheet.add({ part: `sign${index + 1}`, role: 'sign', row: 1, col: colOf(at) + 1, place: null, value: '+', blank: false, step: 0 }, false);
  });
  return finish('split', sheet, 2, 2 * (high - low) + 1, low < 0 ? 0 : null, step, parts.join(' + '), modes);
}

// --- a part-whole bond -------------------------------------------------------------------------------------------------------------

function bond(whole: string, left: string, right: string, modes: Modes): Grid {
  const total = whole === '?' ? showDec(addDec(readDec(left) as Dec, readDec(right) as Dec)) : whole;
  const first = left === '?' ? showDec(subtract(total, right)) : left;
  const second = right === '?' ? showDec(subtract(total, left)) : right;
  const sheet = new Sheet();
  const put = (part: string, row: number, col: number, value: string, unknown: boolean): void => {
    sheet.add({ part: unknown ? 'ans' : part, role: unknown ? 'answer' : 'given', row, col, place: null, value, blank: unknown && !modes.worked, step: unknown ? 1 : 0 }, unknown);
  };
  put('r1', 0, 1, total, whole === '?');
  put('r2', 1, 0, first, left === '?');
  put('r3', 1, 2, second, right === '?');
  return finish('bond', sheet, 2, 3, null, 1, whole === '?' ? total : left === '?' ? first : second, modes);
}

function subtract(whole: string, part: string): Dec {
  const a = readDec(whole) as Dec;
  const b = readDec(part) as Dec;
  const scale = Math.max(a.scale, b.scale);
  return { n: a.n * 10n ** BigInt(scale - a.scale) - b.n * 10n ** BigInt(scale - b.scale), scale };
}

// --- the end of each ---------------------------------------------------------------------------------------------------------------

/** The digits of the answer cells, left to right, with the point where a decimal has one (`4.0`, as the column wrote it). */
function answerText(answer: ReadonlyMap<number, number>, low: number, top: number): string {
  let text = '';
  for (let at = top; at >= low; at -= 1) {
    text += String(answer.get(at) ?? 0);
    if (at === 0 && low < 0) text += '.';
  }
  return text;
}

function finish(method: Grid['method'], sheet: Sheet, rows: number, cols: number, pointAfter: number | null, steps: number, answer: string, modes: Modes): Grid {
  return { method, rows, cols, pointAfter, cells: sheet.cells, steps, order: sheet.order, answer, worked: modes.worked };
}
