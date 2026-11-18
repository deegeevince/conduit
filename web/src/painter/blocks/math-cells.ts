// What a hand has done to a written method's blank cells (PLAN-maths M3, M4): the digits typed, written with the pen, filled by a line or shown, the verdict of
// the last Check, the hint that is lit. It is the painter's whole knowledge of it, as `controls/ask-state.ts` is of an ask: the layout (`math.ts`) draws from it,
// and the painter and the access layer work it. Checked on a press, never live: a hand cannot wiggle a cell until it turns green.
//
// A cell holds a value, who wrote it (key, pen, fill or shown) and a mark. Every cell has a place in the working order the arithmetic gives it (`Cell.order`):
// a digit moves the keyboard to the next empty cell in that order, Backspace goes back, Tab follows it. Required cells are the blanks of the answer; a carry, or an
// exchange, may be left empty (a carry held in the head is not marked down), but a wrong one is.

import { maths } from '@conduit/language';
import type { MathFigure } from '@conduit/language';

export type Hand = 'key' | 'pen' | 'fill' | 'shown';
/** `right` and `wrong`: a Check marked it; `empty`: a required cell Check found empty (ringed); `shown`: Show me wrote it */
export type Mark = '' | 'right' | 'wrong' | 'empty' | 'shown';

export interface CellState {
  /** what counts: the digits the cell holds ('' for none) */
  value: string;
  by: Hand | '';
  mark: Mark;
  /** the pen's writing was read as this ('?' for a smudge), shown small beside the ink */
  read: string;
  /** the pen's writing is being read now: the cell shimmers */
  reading: boolean;
  /** there is pen ink in the cell */
  ink: boolean;
  /** the ink was written over by a typed digit: it is shown faint */
  dim: boolean;
  /** when the value was last written by a key, and when the pen last lifted in the cell (the later one wins) */
  keyAt: number;
  inkAt: number;
}

export type BlockVerdict = 'open' | 'wrong' | 'right' | 'shown';

export interface MathRun {
  readonly key: string;
  readonly id: string;
  readonly grid: maths.Grid;
  readonly math: MathFigure;
  readonly cells: Map<string, CellState>;
  /** the fill text last put in each cell, so a fill is taken once and a person's later hand wins */
  readonly fillSeen: Map<string, string>;
  /** the cell the keyboard is in */
  active: string | null;
  /** the cell a hint has lit, and what it said */
  hint: string | null;
  hintText: string;
  hints: number;
  tries: number;
  /** checks that found a wrong cell */
  wrongs: number;
  /** what those checks found wrong, once each, as `tens 7`: the brain is told them when the sum is done */
  readonly slips: string[];
  verdict: BlockVerdict;
  /** bumped at every change: what the layout is remembered by */
  rev: number;
}

/** What a hand did, as the brain is told it (a short fragment the server joins into one line), and whether it ended the sum. */
export interface MathAct {
  readonly text: string;
  readonly value: string;
}

const RUNS = new Map<string, MathRun>();
const LATEST = new Map<string, string>();
let forgotten = 0;

const signatureOf = (key: string, math: MathFigure): string => `${key}|${math.method}|${math.sum}|${math.worked ? 1 : 0}|${math.blank ?? ''}|${math.carry ?? ''}`;

export const emptyCell = (): CellState => ({ value: '', by: '', mark: '', read: '', reading: false, ink: false, dim: false, keyAt: 0, inkAt: 0 });

/** The run of a block: made on first sight, kept for as long as the page lives; a block whose sum is written again, the same, keeps its work. */
export function runOf(key: string, id: string, math: MathFigure, grid: maths.Grid): MathRun {
  const signature = signatureOf(key, math);
  let run = RUNS.get(signature);
  if (run === undefined) {
    run = { key, id, grid, math, cells: new Map(), fillSeen: new Map(), active: null, hint: null, hintText: '', hints: 0, tries: 0, wrongs: 0, slips: [], verdict: 'open', rev: 0 };
    RUNS.set(signature, run);
  }
  LATEST.set(key, signature);
  return run;
}

/** The run a block key is working now, when it has been laid out. */
export function runNamed(key: string): MathRun | null {
  const signature = LATEST.get(key);
  return signature === undefined ? null : (RUNS.get(signature) ?? null);
}

/** What the layout of a block is remembered by, apart from its words: any change of its cells. */
export const mathRev = (key: string): string => `${forgotten}.${runNamed(key)?.rev ?? 0}`;

/** A new question begins: nothing of an earlier sum's work is kept. */
export function forgetMaths(): void {
  RUNS.clear();
  LATEST.clear();
  forgotten += 1;
}

const bump = (run: MathRun): void => {
  run.rev += 1;
};

export function stateOf(run: MathRun, part: string): CellState {
  let state = run.cells.get(part);
  if (state === undefined) {
    state = emptyCell();
    run.cells.set(part, state);
  }
  return state;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Which cells the learner writes in

/** Whether the grid asks for carries to be written (their boxes are drawn, empty, even where nothing is carried). */
export const writesCarries = (grid: maths.Grid): boolean => grid.cells.some((cell) => cell.role === 'carry' && cell.blank);

/** The cells a hand writes in: the blanks, and the empty carry boxes of a column that writes its carries. */
export function inputCells(grid: maths.Grid): maths.Cell[] {
  const carries = writesCarries(grid);
  return grid.cells.filter((cell) => (cell.blank && cell.role !== 'given' && cell.role !== 'sign' && cell.role !== 'rule') || (cell.role === 'carry' && carries && cell.value === ''));
}

/** Whether a Check marks this cell when it is empty (the answer's blanks), or lets it be (a carry or an exchange held in the head). */
export const required = (cell: maths.Cell): boolean => cell.blank && !cell.optional && cell.role === 'answer';

/** How many characters a cell takes: one digit for a digit, as many as the true value has for an exchanged digit or an expanded place. */
export const maxLengthOf = (cell: maths.Cell): number => (cell.role === 'carry' ? 1 : cell.role === 'working' ? Math.max(2, cell.value.length) : Math.max(1, cell.value.length));

/** The cells in working order, then the ones nobody is asked to write at a fixed point (an empty carry box), as the keyboard walks them. */
export function walkOf(grid: maths.Grid): maths.Cell[] {
  const mine = new Set(inputCells(grid));
  return grid.order.map((at) => grid.cells[at]).filter((cell): cell is maths.Cell => cell !== undefined && mine.has(cell));
}

const placeWord = (place: number | null): string => (place === null ? '' : (maths.placeName(place) ?? `place ${place}`));

/** A cell as it is said to the brain and to a screen reader. */
export function labelOf(cell: maths.Cell): string {
  const place = placeWord(cell.place);
  if (cell.role === 'carry') return `carry ${place}`.trim();
  if (cell.role === 'working') return `exchange ${place}`.trim();
  if (cell.role === 'answer') return place === '' ? 'answer' : place;
  return cell.part;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What a hand does to a cell

/** The digits of a hand's writing: only digits, and a point where the answer has one, as many as the cell takes. */
export const cleanDigits = (text: string, cell: maths.Cell): string => text.replace(/[^\d.]/g, '').slice(0, maxLengthOf(cell));

/** How the block stands once its cells are marked: wrong while any is wrong or left empty, right when every required cell is right (or shown), else still open. */
function settle(run: MathRun): void {
  const cells = inputCells(run.grid);
  const marks = cells.map((cell) => stateOf(run, cell.part).mark);
  if (marks.includes('wrong')) {
    run.verdict = 'wrong';
    run.wrongs += 1;
  } else if (marks.includes('empty')) run.verdict = 'wrong';
  else if (cells.filter(required).every((cell) => ['right', 'shown'].includes(stateOf(run, cell.part).mark))) run.verdict = marks.includes('shown') ? 'shown' : 'right';
}

/** The cell a hand wrote in: the last writer wins, the mark of an earlier Check is gone, a typed digit over the pen's writing dims it. */
export function writeCell(run: MathRun, part: string, text: string, by: Hand, now = Date.now()): boolean {
  const cell = run.grid.cells.find((candidate) => candidate.part === part);
  if (cell === undefined) return false;
  if (run.verdict === 'right' || run.verdict === 'shown') return false;
  const state = stateOf(run, part);
  const value = cleanDigits(text, cell);
  if (state.value === value && state.by === by) return false;
  state.value = value;
  state.by = by;
  state.mark = '';
  state.keyAt = now;
  if (by === 'key') {
    state.dim = state.ink;
    state.reading = false;
  }
  if (by === 'pen') state.read = value;
  if (run.hint === part) {
    run.hint = null;
    run.hintText = '';
  }
  if (run.verdict === 'wrong') run.verdict = 'open';
  bump(run);
  return true;
}

/** A hand clears a cell. */
export const clearCell = (run: MathRun, part: string): boolean => writeCell(run, part, '', 'key');

/** The keyboard went into a cell (or out of every one: null). */
export function activate(run: MathRun, part: string | null): void {
  if (run.active === part) return;
  run.active = part;
  bump(run);
}

/** The next cell in working order after `part` that holds nothing (an optional carry counts: the keyboard goes to it, and Tab leaves it). `from` null: from the start. */
export function nextEmpty(run: MathRun, from: string | null): string | null {
  const walk = walkOf(run.grid);
  const at = from === null ? -1 : walk.findIndex((cell) => cell.part === from);
  for (let i = at + 1; i < walk.length; i += 1) {
    const cell = walk[i] as maths.Cell;
    if (stateOf(run, cell.part).value === '' && cell.step <= 1e9) return cell.part;
  }
  return null;
}

/** The cell before `part` in working order (wrapping nowhere), or null at the first. */
export function previous(run: MathRun, part: string): string | null {
  const walk = walkOf(run.grid);
  const at = walk.findIndex((cell) => cell.part === part);
  return at > 0 ? (walk[at - 1] as maths.Cell).part : null;
}

/** The cell after `part` in working order, empty or not, or null at the last. */
export function following(run: MathRun, part: string): string | null {
  const walk = walkOf(run.grid);
  const at = walk.findIndex((cell) => cell.part === part);
  return at >= 0 && at < walk.length - 1 ? (walk[at + 1] as maths.Cell).part : null;
}

/** The cell the arrow keys reach from `part`: along the grid, not the working order. */
export function neighbour(run: MathRun, part: string, direction: 'left' | 'right' | 'up' | 'down'): string | null {
  const from = run.grid.cells.find((cell) => cell.part === part);
  if (from === undefined) return null;
  const others = inputCells(run.grid).filter((cell) => cell.part !== part);
  let best: maths.Cell | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const cell of others) {
    const dRow = cell.row - from.row;
    const dCol = cell.col - from.col;
    const ahead = direction === 'left' ? dCol < 0 && dRow === 0 : direction === 'right' ? dCol > 0 && dRow === 0 : direction === 'up' ? dRow < 0 : dRow > 0;
    if (!ahead) continue;
    // along the arrow first, then the least sideways
    const score = direction === 'left' || direction === 'right' ? Math.abs(dCol) : Math.abs(dRow) * 100 + Math.abs(dCol);
    if (score < bestScore) {
      best = cell;
      bestScore = score;
    }
  }
  return best === null ? null : best.part;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fills (`fill m1 | 72`, `fill m1.ans-ones | 2`)

/** Puts the digits a line filled into the cells, once each, and marks them as a Check would. A person's later hand wins over a fill written before it. */
export function takeFills(run: MathRun, fills: ReadonlyMap<maths.Cell, string>): void {
  for (const [cell, text] of fills) {
    if (run.fillSeen.get(cell.part) === text) continue;
    run.fillSeen.set(cell.part, text);
    const state = stateOf(run, cell.part);
    state.value = cleanDigits(text, cell);
    state.by = 'fill';
    state.mark = state.value === cell.value ? 'right' : 'wrong';
    state.dim = state.ink;
    bump(run);
  }
  if (fills.size > 0) settle(run);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Check, Hint, Show me

const SAME = (a: string, b: string): boolean => a === b;

/** Marks every cell against the sealed value, and says what it found as the brain is told it. Null when there is nothing to check yet. */
export function check(run: MathRun): MathAct | null {
  if (run.verdict === 'right' || run.verdict === 'shown') return null;
  const walk = walkOf(run.grid);
  const rest = inputCells(run.grid).filter((cell) => !walk.includes(cell));
  const parts: string[] = [];
  let wrong = 0;
  let touched = false;
  for (const cell of [...walk, ...rest]) {
    const state = stateOf(run, cell.part);
    const mine = state.by === 'pen' && state.read === '?' ? '' : state.value;
    const was = state.mark;
    const label = labelOf(cell);
    if (state.mark === 'shown') continue;
    if (mine === '') {
      if (required(cell)) {
        state.mark = 'empty';
        parts.push(state.by === 'pen' && state.read === '?' ? `${label} unclear` : `${label} empty`);
        wrong += 1;
      } else state.mark = '';
    } else if (SAME(mine, cell.value)) {
      state.mark = 'right';
      parts.push(`${label} right`);
      touched = true;
    } else {
      state.mark = 'wrong';
      parts.push(`${label} wrong (${mine})`);
      if (!run.slips.includes(`${label} ${mine}`)) run.slips.push(`${label} ${mine}`);
      wrong += 1;
      touched = true;
    }
    if (state.mark !== was) bump(run);
  }
  if (!touched && wrong === 0) return null;
  run.tries += 1;
  if (parts.some((part) => /wrong/.test(part))) run.wrongs += 1;
  run.hint = null;
  run.hintText = '';
  run.verdict = wrong === 0 ? 'right' : 'wrong';
  bump(run);
  // fb-091. A sum that is done is told to the brain with how she got there: the wrong checks (and what was wrong), and the hints
  const finished = wrong === 0 ? [...(run.wrongs > 0 ? [`${run.wrongs} wrong check${run.wrongs === 1 ? '' : 's'} (${run.slips.join(', ')})`] : []), ...(run.hints > 0 ? [`${run.hints} hint${run.hints === 1 ? '' : 's'}`] : [])] : [];
  const after = finished.length > 0 ? `, after ${finished.join(' and ')}` : '';
  return { text: wrong === 0 && !parts.some((part) => /wrong/.test(part)) ? `${run.id}: all right${after}` : `${run.id}: ${parts.join(', ')}`, value: wrong === 0 ? 'right' : 'wrong' };
}

/** The words of a cell's step, never its digit. */
export function hintFor(grid: maths.Grid, cell: maths.Cell): string {
  const place = placeWord(cell.place);
  const lower = cell.place === null ? '' : placeWord(cell.place - 1);
  const given = (at: number | null): string[] => grid.cells.filter((c) => c.role === 'given' && c.place === at && c.value !== '').map((c) => c.value);
  const sign = grid.cells.find((c) => c.role === 'sign')?.value ?? '+';
  if (grid.method === 'bond') {
    const known = grid.cells.filter((c) => !c.blank && c.value !== '').map((c) => c.value);
    return `the whole and one part are written: ${known.join(' and ')}. What is left to make the whole?`;
  }
  if (grid.method === 'split') {
    const whole = grid.cells.filter((c) => c.role === 'given' && c.place !== null).sort((a, b) => (b.place ?? 0) - (a.place ?? 0)).map((c) => c.value).join('');
    return `write the value of the ${place} digit in ${whole}: how much is it worth?`;
  }
  if (cell.role === 'carry') return `if the ${lower} total came to ten or more, write the extra ${place} above the ${place} column`;
  if (cell.role === 'working') return `exchange in the ${place} column: write its new number above, where a ten was taken from the next column`;
  const digits = given(cell.place);
  if (grid.method === 'times') {
    const multiplier = grid.cells.filter((c) => c.role === 'given' && c.part.startsWith('r2-')).map((c) => c.value).join('');
    const top = grid.cells.find((c) => c.role === 'given' && c.part.startsWith('r1-') && c.place === cell.place)?.value;
    return top === undefined ? `multiply the ${place}, then add any carry` : `multiply the ${place}: ${top} × ${multiplier}, then add any carry`;
  }
  if (sign === '-' || sign === '−') return `take away in the ${place} column: ${digits.join(' take away ')}${grid.cells.some((c) => c.role === 'working' && c.place === cell.place) ? ', using the exchanged number if you made one' : ''}`;
  return `add the ${place}: ${digits.join('+')}${grid.cells.some((c) => c.role === 'carry' && c.place === cell.place) ? ', and the carry from the ' + lower : ''}`;
}

/** The cell a hint lights: the first in working order that is not right yet (an empty carry that is not needed is passed over). */
function nextToDo(run: MathRun): maths.Cell | null {
  for (const cell of walkOf(run.grid)) {
    const state = stateOf(run, cell.part);
    if (state.mark === 'right' || state.mark === 'shown') continue;
    if (cell.value === '' && state.value === '') continue;
    if (state.value === cell.value && state.value !== '') continue;
    return cell;
  }
  return null;
}

/** Hint: the next cell in working order is lit and its step said in words. Never its digit. */
export function hint(run: MathRun): { readonly act: MathAct; readonly text: string } | null {
  if (run.verdict === 'right' || run.verdict === 'shown') return null;
  const cell = nextToDo(run);
  if (cell === null) return null;
  run.hint = cell.part;
  run.hintText = hintFor(run.grid, cell);
  run.hints += 1;
  bump(run);
  return { act: { text: `${run.id}: took hint ${run.hints} (${labelOf(cell)})`, value: String(run.hints) }, text: run.hintText };
}

/** Whether Show me is offered: after a try that found a wrong cell, and while something is left to show. */
export const canShow = (run: MathRun): boolean => run.wrongs > 0 && run.verdict !== 'right' && run.verdict !== 'shown' && nextToShow(run) !== null;

function nextToShow(run: MathRun): maths.Cell | null {
  const walk = walkOf(run.grid);
  for (const cell of walk) {
    if (!required(cell)) continue;
    const state = stateOf(run, cell.part);
    if (state.mark === 'shown' || (state.mark === 'right' && state.value === cell.value)) continue;
    if (state.value !== cell.value || state.mark === 'wrong' || state.mark === 'empty') return cell;
  }
  // a wrong optional cell (a carry) is shown last
  for (const cell of walk) {
    const state = stateOf(run, cell.part);
    if (!required(cell) && state.value !== '' && state.value !== cell.value) return cell;
  }
  return null;
}

/** Show me: one cell is filled, in working order, and marked as shown (never recorded as right). */
export function show(run: MathRun): MathAct | null {
  if (!canShow(run)) return null;
  const cell = nextToShow(run);
  if (cell === null) return null;
  const state = stateOf(run, cell.part);
  state.value = cell.value;
  state.by = 'shown';
  state.mark = 'shown';
  state.read = '';
  state.dim = state.ink;
  state.reading = false;
  run.hint = null;
  run.hintText = '';
  settleAfterShow(run);
  bump(run);
  return { text: `${run.id}: was shown the ${labelOf(cell)}`, value: 'shown' };
}

function settleAfterShow(run: MathRun): void {
  const cells = inputCells(run.grid);
  const done = cells.filter(required).every((cell) => ['right', 'shown'].includes(stateOf(run, cell.part).mark));
  const bad = cells.some((cell) => !required(cell) && stateOf(run, cell.part).mark === 'wrong');
  if (done && !bad) run.verdict = 'shown';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The pen (M4)

/** The pen has ink in the cell, or none now. A new stroke is the last writer: the reading it is waiting for will decide the value. */
export function inkIn(run: MathRun, part: string, on: boolean, now = Date.now()): void {
  const state = stateOf(run, part);
  if (on) {
    state.ink = true;
    state.inkAt = now;
    state.dim = false;
    state.reading = true;
    state.mark = '';
    if (run.verdict === 'wrong') run.verdict = 'open';
  } else {
    state.ink = false;
    state.dim = false;
    state.reading = false;
    if (state.by === 'pen') {
      state.value = '';
      state.by = '';
      state.read = '';
    }
    state.mark = '';
  }
  bump(run);
}

/** The reader's answer for a cell: a digit (or digits), '' for nothing written, or '?'. A key that was pressed after the pen lifted wins over it. */
export function readIn(run: MathRun, part: string, digits: string): void {
  const cell = run.grid.cells.find((candidate) => candidate.part === part);
  if (cell === undefined) return;
  const state = stateOf(run, part);
  state.reading = false;
  if (!state.ink) {
    bump(run);
    return;
  }
  if (state.by === 'key' && state.keyAt > state.inkAt) {
    state.dim = true;
    bump(run);
    return;
  }
  const clean = digits === '?' ? '?' : cleanDigits(digits, cell);
  state.read = clean;
  state.value = clean === '?' ? '' : clean;
  state.by = 'pen';
  state.mark = '';
  if (clean === '') {
    state.ink = true;
  }
  bump(run);
}

/** A cell the pen is reading shimmers; one the read did not come back for stops. */
export function readingNow(run: MathRun, part: string, on: boolean): void {
  const state = stateOf(run, part);
  if (state.reading === on) return;
  state.reading = on;
  bump(run);
}
