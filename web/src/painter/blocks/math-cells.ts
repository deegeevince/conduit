// What a hand has done to a written method's blank cells (PLAN-maths M3): the digits typed, or filled by a line, and whether the pen has ink in the cell. It is the
// painter's whole knowledge of it, as `controls/ask-state.ts` is of an ask: the layout (`math.ts`) draws from it, and the painter and the access layer work it.
// Nothing here marks a cell right or wrong, gives a hint or reads the pen's writing: the person writes and sends, and the model, shown the picture of the sum
// with their writing on it, decides what comes next (owner: write, then send; fb-104).
//
// A cell holds a value and who wrote it (key or fill). Every cell has a place in the working order the arithmetic gives it (`Cell.order`): a digit moves the keyboard
// to the next empty cell in that order, Backspace goes back, Tab follows it. Required cells are the blanks of the answer; a carry, or an exchange, may be left empty.

import { maths } from '@conduit/language';
import type { MathFigure } from '@conduit/language';

export type Hand = 'key' | 'fill';

export interface CellState {
  /** the digits the cell holds ('' for none) */
  value: string;
  by: Hand | '';
  /** there is pen ink in the cell */
  ink: boolean;
  /** the ink was written over by a typed digit: it is shown faint */
  dim: boolean;
}

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
  /** bumped at every change: what the layout is remembered by */
  rev: number;
}


const RUNS = new Map<string, MathRun>();
const LATEST = new Map<string, string>();
let forgotten = 0;

const signatureOf = (key: string, math: MathFigure): string => `${key}|${math.method}|${math.sum}|${math.worked ? 1 : 0}|${math.blank ?? ''}|${math.carry ?? ''}`;

export const emptyCell = (): CellState => ({ value: '', by: '', ink: false, dim: false });

/** The run of a block: made on first sight, kept for as long as the page lives; a block whose sum is written again, the same, keeps its work. */
export function runOf(key: string, id: string, math: MathFigure, grid: maths.Grid): MathRun {
  const signature = signatureOf(key, math);
  let run = RUNS.get(signature);
  if (run === undefined) {
    run = { key, id, grid, math, cells: new Map(), fillSeen: new Map(), active: null, rev: 0 };
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

/** Whether the cell is one of the answer's blanks (required), or one that may be left empty (a carry or an exchange held in the head). */
export const required = (cell: maths.Cell): boolean => cell.blank && !cell.optional && cell.role === 'answer';

/** How many characters a cell takes: one digit for a digit, as many as the true value has for an exchanged digit or an expanded place. */
export const maxLengthOf = (cell: maths.Cell): number => (cell.role === 'carry' ? 1 : cell.role === 'working' ? Math.max(2, cell.value.length) : Math.max(1, cell.value.length));

/** The cells in working order, then the ones nobody is asked to write at a fixed point (an empty carry box), as the keyboard walks them. */
export function walkOf(grid: maths.Grid): maths.Cell[] {
  const mine = new Set(inputCells(grid));
  return grid.order.map((at) => grid.cells[at]).filter((cell): cell is maths.Cell => cell !== undefined && mine.has(cell));
}

const placeWord = (place: number | null): string => (place === null ? '' : (maths.placeName(place) ?? `place ${place}`));

/** A cell as it is said to a screen reader. */
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

/** The cell a hand wrote in: the last writer wins, and a typed digit over the pen's ink dims the ink. */
export function writeCell(run: MathRun, part: string, text: string, by: Hand): boolean {
  const cell = run.grid.cells.find((candidate) => candidate.part === part);
  if (cell === undefined) return false;
  const state = stateOf(run, part);
  const value = cleanDigits(text, cell);
  if (state.value === value && state.by === by) return false;
  state.value = value;
  state.by = by;
  if (by === 'key') state.dim = state.ink;
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

/** Puts the digits a line filled into the cells, once each. A person's later hand wins over a fill written before it. */
export function takeFills(run: MathRun, fills: ReadonlyMap<maths.Cell, string>): void {
  for (const [cell, text] of fills) {
    if (run.fillSeen.get(cell.part) === text) continue;
    run.fillSeen.set(cell.part, text);
    const state = stateOf(run, cell.part);
    state.value = cleanDigits(text, cell);
    state.by = 'fill';
    state.dim = state.ink;
    bump(run);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The pen

/** The pen has ink in the cell, or none now. False when that is how the cell already stood (a second stroke in a cell asks the layout for nothing). */
export function inkIn(run: MathRun, part: string, on: boolean): boolean {
  const state = stateOf(run, part);
  if (state.ink === on && !state.dim) return false;
  state.ink = on;
  state.dim = false;
  bump(run);
  return true;
}
