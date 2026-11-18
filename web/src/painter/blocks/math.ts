// Math: a written method laid out as on paper (PLAN-maths M2). The words of the line hold a sum and its options, never a digit: the grid of cells comes from
// `maths/written.ts` (language), the same cells the server seals the answer against, and this file only says where each stands.
//
//   digits         right-aligned in place-value columns, in a mono face at the look's headline size, every digit of one place on one x
//   the sign       in a column of its own, on the last number's row
//   the rule       one line across every column, above the answer row
//   carries        small dashed boxes above the top row (written, shown or none: `carry=`); an exchange is a new value above a struck digit
//   blanks         a box at least 44 stage units on a side, empty; the learner writes there (input is M3)
//   the point      a column of its own, so every row's decimal point stands on the same x
//   steps          cells appear by their `step`: the stepper (a tap), or `step=<n>`, or a `pick` that follows it
//   the pictures   `bar`, `groups`, `array` and `line` (math-ways.ts), drawn in the same room, each step adding a piece, the unknown always `?`
//
// Never squeezed: the block keeps its size and asks the stage for the room (`crowded` when the room is less); it only shrinks, a little and last, so that a nine-digit
// sum still fits a phone. Parts a line can name (`near=m1.tens`, `hit m1.r3`, `set m1.ans-ones mark=box`) are boxes under `<key>.<part>`.

import { maths } from '@conduit/language';
import type { MathFigure, Polyline, Range, Scope, Size } from '@conduit/language';
import { EMPTY_STRUCTURE_LAYOUT } from '../../contracts/blocks';
import type { BlockPart, StructureInput, StructureLayout, TextSpec } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, closedLine, dashes, inflate, open, roundedRect, union } from './geom';
import { drawWay, formOf } from './math-ways';
import type { WayDrawing, WayName, WayPiece } from './math-ways';
import { canShow, hintFor, inputCells, mathRev, runOf, stateOf, takeFills } from './math-cells';

/** The least a thing the learner writes in is, on a side: a fingertip. */
const MIN_TARGET = 44;
/** The unit a block is sized by before the look's own type is known: what the stage plan reserves. */
const NATURAL_UNIT = 56;
/** What a block with cells to write in keeps under its digits, in units: a row of Check, Hint and Show me, and the line a hint is said in. */
const ROWS_BELOW = 2.1;
/** The most words of a hint that stand under the block, in stage units of width. */
const HINT_WIDTH = 480;

// ---------------------------------------------------------------------------------------------------------------------------------
// The stepper held on the block: a tap advances it. The state of a hand, kept here and not in the schedule, as a control's value is.

const HELD = new Map<string, number>();

/** The step a block's own stepper stands at (0: the start). */
export const mathHeld = (key: string): number => HELD.get(key) ?? 0;

/** What the layout must be asked again for, when the stepper moved. */
export const mathKey = (key: string): string => `m${mathHeld(key)}.${mathRev(key)}`;

/** Moves the block's own stepper on by one step, round to the start after the last; returns the new step. */
export function advanceMath(key: string, steps: number): number {
  const next = mathHeld(key) >= steps ? 0 : mathHeld(key) + 1;
  HELD.set(key, next);
  return next;
}

/** The method's grid, or null for a picture. */
export function gridOfMath(math: MathFigure): maths.Grid | null {
  return maths.gridOf({ method: math.method, sum: math.sum, worked: math.worked, ...(math.blank === null ? {} : { blank: math.blank }), ...(math.carry === null ? {} : { carry: math.carry }) });
}

/** How many steps the stepper has: the grid's, or the picture's captions. */
export function mathSteps(math: MathFigure): number {
  const grid = gridOfMath(math);
  if (grid !== null) return grid.steps;
  const form = formOf(math.sum);
  return form === null ? 0 : (drawWay(form, math.method as WayName, { width: 600, height: 380 })?.steps.length ?? 0);
}

/** Whether a tap on the block moves a stepper of its own (`steps`, with no `step=` to follow). */
export const hasOwnStepper = (math: MathFigure): boolean => math.steps && math.step === null;

/** The step to show: everything (Infinity), a step written, the one a pick holds (its option, counted from 1), or the block's own stepper. */
function shownStep(math: MathFigure, key: string, scope: Scope): number {
  if (typeof math.step === 'number') return math.step;
  if (typeof math.step === 'string') return Math.max(0, Math.round(scope[math.step] ?? 0));
  return math.steps ? mathHeld(key) : Number.POSITIVE_INFINITY;
}

/** What the stage plan reserves for a block before it is laid out, css px. */
export function mathNatural(math: MathFigure): { readonly width: number; readonly height: number } {
  const grid = gridOfMath(math);
  const stepper = math.steps && math.step === null ? NATURAL_UNIT * 0.7 : 0;
  if (grid === null) return { width: 640, height: 400 + stepper };
  const unit = NATURAL_UNIT;
  const carries = grid.method === 'column' || grid.method === 'times';
  const used = (row: number): boolean => grid.cells.some((cell) => cell.row === row);
  let height = stepper + (inputCells(grid).length > 0 ? unit * ROWS_BELOW : 0);
  for (let row = 0; row < grid.rows; row += 1) {
    if (!used(row)) continue;
    height += grid.cells.some((cell) => cell.row === row && cell.role === 'rule') ? unit * 0.34 : carries && row === 0 ? unit * 0.8 : grid.method === 'bond' ? unit * 1.6 : unit;
  }
  const width = grid.method === 'bond' ? unit * 5.5 : grid.method === 'split' ? Math.max(unit * 4, grid.cols * unit * 1.3) : grid.cols * unit + (grid.pointAfter === null ? 0 : unit * 0.45);
  return { width, height };
}

/** The least a block can be read at: a written method is never squeezed, so it is its natural size; a picture may be smaller. */
export function mathLeast(math: MathFigure): { readonly width: number; readonly height: number } {
  const natural = mathNatural(math);
  return gridOfMath(math) === null ? { width: 260, height: 200 } : natural;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Parts

/** The cells a name picks out: a row (`r2`), a place (`tens`), a cell (`carry-tens`), the answer (`ans`), the rule, the sign, a step (`s3`). */
export function cellsOfPart(grid: maths.Grid, name: string): maths.Cell[] {
  const cells = grid.cells;
  if (grid.method === 'bond') {
    const row = /^r([1-3])$/.exec(name);
    if (row?.[1] !== undefined) return cells.slice(Number(row[1]) - 1, Number(row[1]));
    return name === 'ans' ? cells.filter((cell) => cell.role === 'answer') : [];
  }
  const row = /^r(\d+)$/.exec(name);
  if (row?.[1] !== undefined) return cells.filter((cell) => cell.role === 'given' && cell.part.startsWith(`r${row[1]}-`));
  if (name === 'ans') return cells.filter((cell) => cell.role === 'answer');
  if (name === 'sign') return cells.filter((cell) => cell.role === 'sign');
  const step = /^s(\d+)$/.exec(name);
  if (step?.[1] !== undefined) return cells.filter((cell) => cell.step === Number(step[1]));
  const top = /^top-(.+)$/.exec(name);
  if (top?.[1] !== undefined) return cells.filter((cell) => cell.part === `r1-${top[1]}`);
  const place = maths.placeOf(name);
  if (place !== null) return cells.filter((cell) => cell.place === place && cell.role !== 'sign' && cell.role !== 'rule');
  return cells.filter((cell) => cell.part === name);
}

/** The digits a person's `fill` puts in the blank cells, by cell: `fill m1 | 72` by place from the right, `fill m1.ans-ones | 2` in that cell. */
function fillsOf(grid: maths.Grid, math: MathFigure): Map<maths.Cell, string> {
  const out = new Map<maths.Cell, string>();
  for (const fill of math.fills) {
    if (fill.part !== null) {
      for (const cell of cellsOfPart(grid, fill.part)) if (cell.blank) out.set(cell, fill.text.trim());
      continue;
    }
    const blanks = grid.cells.filter((cell) => cell.blank && cell.role === 'answer');
    if (grid.method === 'split') {
      const tokens = fill.text.match(/\d+(?:\.\d+)?/g) ?? [];
      [...blanks].sort((a, b) => a.col - b.col).forEach((cell, at) => {
        const token = tokens[at];
        if (token !== undefined) out.set(cell, token);
      });
    } else if (grid.method === 'bond') {
      const cell = blanks[0];
      if (cell !== undefined) out.set(cell, fill.text.trim());
    } else {
      const digits = [...fill.text.replace(/[^\d]/g, '')].reverse();
      [...blanks].sort((a, b) => (a.place ?? 0) - (b.place ?? 0)).forEach((cell, at) => {
        const digit = digits[at];
        if (digit !== undefined) out.set(cell, digit);
      });
    }
  }
  return out;
}

const SIGNS: Readonly<Record<string, string>> = { '-': '−' };

/** The sizes digits are set at, largest first: a young learner's page is the headline size, and a screen whose body type is large takes a smaller step. */
const DIGIT_SIZES: readonly Size[] = ['xl', 'l', 'm'];
/** The tallest a line of digits is, stage units: past it the size below is used. */
const DIGIT_LINE_MAX = 80;
/** What a carry or an exchange is set at, against the digits. */
const SMALLER: Readonly<Record<string, Size>> = { xl: 'l', l: 'm', m: 's' };

function spec(size: Size, shrink: number): TextSpec {
  return { size, weight: 'normal', face: 'mono', letterCase: 'asis', shrink };
}

const SIZE_LADDER: readonly Size[] = ['xs', 's', 'm', 'l', 'xl', 'xxl'];

/** A text spec whose line is about `px` tall: the smallest size of the ladder that is tall enough, shrunk to it. */
function specAtPx(input: StructureInput, px: number): TextSpec {
  const target = px * 1.3;
  for (const size of SIZE_LADDER) {
    const base: TextSpec = { size, weight: 'normal', face: null, letterCase: 'asis', shrink: 1 };
    const height = input.measure('Mg', base, 1e9).height;
    if (height >= target || size === 'xxl') return { ...base, shrink: Math.min(1, target / Math.max(1, height)) };
  }
  return { size: 'm', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 };
}

const plain = (key: string, part: string, text: string, at: Box, spec: TextSpec, role: 'cell' | 'value' = 'cell', emphasis: readonly Range[] = []): BlockPart => ({ kind: 'text', owner: key, part, text, emphasis, box: at, spec, align: 'center', role, plate: false });

function circleOutline(cx: number, cy: number, r: number): Polyline {
  return closedLine(Array.from({ length: 28 }, (_, i) => ({ x: cx + r * Math.cos((i / 28) * 2 * Math.PI), y: cy + r * Math.sin((i / 28) * 2 * Math.PI) })));
}

/** A ring of dashes round a box with rounded corners (a required cell left empty). */
function dashedRound(at: Box): Polyline[] {
  return dashedBox(at, 5, 4);
}

function dashedBox(at: Box, on: number, off: number): Polyline[] {
  const right = at.x + at.width;
  const bottom = at.y + at.height;
  return dashes([{ x: at.x, y: at.y }, { x: right, y: at.y }, { x: right, y: bottom }, { x: at.x, y: bottom }, { x: at.x, y: at.y }], on, off);
}

/** The block's parts, and the boxes parts and names stand in. */
interface Built {
  /** the line height of the digits as set: what a digit's size is judged by */
  readonly lineHeight: number;
  readonly parts: BlockPart[];
  readonly boxes: Map<string, Box>;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The layout

export function layoutMath(input: StructureInput): StructureLayout {
  const figure = input.structure.figure;
  const math = figure?.kind === 'structure' ? (figure.math ?? null) : null;
  if (math === null) return EMPTY_STRUCTURE_LAYOUT;
  const key = input.structure.key;
  const shown = shownStep(math, key, input.scope);
  const grid = gridOfMath(math);
  const room = input.room;
  // Never squeezed: the headline size of the look when a digit is no taller than it should be (a screen with a large body type takes the next size down), and a little
  // less, last, only when a wide or tall sum would not stand in the room otherwise.
  let built: Built | null = null;
  let used = 1;
  if (grid === null) built = pictureOf(input, math, shown);
  else {
    search: for (const size of DIGIT_SIZES) {
      for (const shrink of [1, 0.88, 0.76]) {
        built = gridBlock(input, math, grid, shown, size, shrink);
        used = shrink;
        const tallest = built.lineHeight > DIGIT_LINE_MAX && size !== 'm';
        if (!tallest && built.width <= room.width + 0.5 && built.height <= room.height + 0.5) break search;
      }
    }
  }
  if (built === null) return EMPTY_STRUCTURE_LAYOUT;
  const wide = Math.max(0, built.width / Math.max(1, room.width) - 1);
  const tall = Math.max(0, built.height / Math.max(1, room.height) - 1);
  const crowded = wide > 0.005 || tall > 0.005;
  const whole = built.boxes.get(key) ?? box(room.x, room.y, built.width, built.height);
  const boxes = new Map(built.boxes);
  boxes.set(key, whole);
  return {
    boxes,
    parts: built.parts,
    routes: new Map(),
    notes: crowded ? [{ key, note: 'crowded' }] : [],
    shrink: used,
    ...(crowded ? { overflows: wide + tall } : {}),
  };
}

// --- a grid of cells ---------------------------------------------------------------------------------------------------------------

function gridBlock(input: StructureInput, math: MathFigure, grid: maths.Grid, shown: number, size: Size, shrink: number): Built {
  const key = input.structure.key;
  const room = input.room;
  const bond = grid.method === 'bond';
  const split = grid.method === 'split';
  const carries = grid.method === 'column' || grid.method === 'times';
  const big = spec(size, shrink);
  const small = spec(SMALLER[size] ?? 's', shrink);
  const dm = input.measure('0', big, 1e9);
  // a cell is at least a fingertip and a gap wider than the box the learner writes in, so that boxes never touch
  const gapBetween = shrink === 1 ? 12 : shrink > 0.8 ? 8 : 4;
  const floor = MIN_TARGET + gapBetween;
  const unitX = Math.max(floor, dm.width * 1.45);
  const unitY = Math.max(floor, dm.height * 0.85);
  const run = runOf(key, input.structure.id, math, grid);
  takeFills(run, fillsOf(grid, math));
  const inputs = new Set(inputCells(grid));
  const radius = Math.max(input.look.radius, unitY * 0.12);

  // how many characters the cell will hold: from the sum, never from what the learner is to write
  const charsOf = (cell: maths.Cell): number => {
    if (cell.role === 'working') return 2;
    if (cell.role === 'carry') return 1;
    if (bond) return cell.blank ? 2 : cell.value.length;
    if (split && cell.role === 'answer') return cell.place === null ? 1 : cell.place >= 0 ? cell.place + 1 : 2 - cell.place;
    return cell.blank ? 1 : cell.value.length;
  };
  const textW = (chars: number, at: TextSpec): number => (chars <= 0 ? 0 : input.measure('0'.repeat(chars), at, 1e9).width);

  // columns: as wide as the widest thing in them; a column of signs is narrow; a decimal point has a column of its own between two places
  const signOnly = new Set<number>();
  for (let col = 0; col < grid.cols; col += 1) {
    const here = grid.cells.filter((cell) => cell.col === col);
    if (here.length > 0 && here.every((cell) => cell.role === 'sign')) signOnly.add(col);
  }
  const colW: number[] = [];
  for (let col = 0; col < grid.cols; col += 1) {
    let need = 0;
    for (const cell of grid.cells) {
      if (cell.col !== col || cell.role === 'rule' || cell.role === 'sign') continue;
      const small_ = cell.role === 'carry' || cell.role === 'working';
      need = Math.max(need, textW(charsOf(cell), small_ ? small : big) + (small_ ? unitX * 0.2 : unitX * (bond ? 0.7 : 0.45)));
    }
    colW.push(signOnly.has(col) ? unitX * 0.8 : Math.max(bond ? unitX * 1.2 : unitX, need));
  }
  let pointCol: number | null = null;
  if (grid.pointAfter !== null && !split && !bond) {
    const at = grid.cells.find((cell) => cell.place === grid.pointAfter && (cell.role === 'given' || cell.role === 'answer'));
    if (at !== undefined) pointCol = at.col;
  }
  const gap = pointCol === null ? 0 : unitX * 0.45;
  const colX: number[] = [];
  let x = 0;
  for (let col = 0; col < grid.cols; col += 1) {
    colX.push(x);
    x += colW[col] ?? unitX;
    if (col === pointCol) x += gap;
  }
  const width = x;

  // rows: the carry row is short, the rule row a hairline, a row nothing stands in takes nothing
  const rowH: number[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    const here = grid.cells.filter((cell) => cell.row === row);
    rowH.push(here.length === 0 ? 0 : here.some((cell) => cell.role === 'rule') ? unitY * 0.34 : carries && row === 0 ? unitY * 0.8 : bond ? unitY * 1.6 : unitY);
  }
  const rowY: number[] = [];
  let y = 0;
  for (const h of rowH) {
    rowY.push(y);
    y += h;
  }
  const stepper = hasOwnStepper(math) ? unitY * 0.7 : 0;
  // a block with cells to write in keeps a row for Check, Hint and Show me under its digits, and a line for a hint: always, so that nothing moves when they are used
  const buttonsH = inputs.size > 0 ? MIN_TARGET + 14 : 0;
  // fb-081. The line a hint is said in is as tall as the longest hint of this sum needs at the width it is said in (an exchange takes several lines), so that the words stand
  // under the buttons, never over them, and still nothing moves when a hint is used
  const hintBoxW = Math.min(Math.max(room.width, width), Math.max(width, HINT_WIDTH));
  const hintTall = inputs.size > 0 ? Math.max(...inputCells(grid).map((cell) => input.measure(hintFor(grid, cell), spec('s' as Size, shrink), hintBoxW).height)) : 0;
  const hintH = inputs.size > 0 ? Math.max(unitY * 0.9, 56, hintTall + 8) : 0;
  const height = y + stepper + buttonsH + hintH;
  const left = room.x + Math.max(0, (room.width - width) / 2);
  const top = room.y;

  const rectOf = (cell: maths.Cell): Box => {
    const first = colX[cell.col] ?? 0;
    const last = colX[Math.min(grid.cols - 1, cell.col + cell.span - 1)] ?? first;
    const end = last + (colW[Math.min(grid.cols - 1, cell.col + cell.span - 1)] ?? unitX);
    return box(left + first, top + (rowY[cell.row] ?? 0), end - first, rowH[cell.row] ?? unitY);
  };

  const visible = (cell: maths.Cell): boolean => cell.step <= shown;
  const exchangeShown = (cell: maths.Cell): boolean => grid.cells.some((other) => other.role === 'working' && other.place === cell.place && !other.blank && other.value !== '' && visible(other));

  const marksBack: BlockPart[] = [];
  const frames: BlockPart[] = [];
  const lines: BlockPart[] = [];
  const texts: BlockPart[] = [];
  const cellBox = new Map<maths.Cell, Box>();
  /** where each cell the learner writes in takes a finger, and its clear mark: for the access layer and the stage's taps */
  const writing = new Map<string, Box>();
  const clearing = new Map<string, Box>();
  const noted = spec('xs' as Size, shrink);

  /** The box a cell the learner writes in is drawn as, and the (never smaller than a fingertip) box a finger or a pen finds it by. */
  const writeIn = (cell: maths.Cell, at: Box): void => {
    const name = cell.part;
    const state = stateOf(run, name);
    const small_ = cell.role === 'carry' || cell.role === 'working';
    let drawn: Box;
    if (small_) {
      const side = Math.min(at.width * 0.7, at.height * 0.82);
      drawn = box(at.x + (at.width - side) / 2, at.y + (at.height - side) / 2, side, side);
      frames.push({ kind: 'shape', owner: key, part: `d:${name}`, outline: dashedBox(drawn, 4, 3), role: 'grid' });
    } else {
      // the learner's own cell: a box to write in, at least a fingertip on each side, and empty
      const inset = Math.max(0, Math.min(gapBetween / 2, (Math.min(at.width, at.height) - MIN_TARGET) / 2));
      drawn = box(at.x + inset, at.y + inset, at.width - 2 * inset, at.height - 2 * inset);
      frames.push({ kind: 'shape', owner: key, part: `f:${name}`, outline: [roundedRect(drawn, radius)], role: 'frame' });
    }
    const tap = Math.min(at.width, Math.max(MIN_TARGET, drawn.width));
    const tapH = Math.min(at.height, Math.max(MIN_TARGET, drawn.height));
    writing.set(name, box(drawn.x + drawn.width / 2 - tap / 2, drawn.y + drawn.height / 2 - tapH / 2, tap, tapH));
    // what stands in it: the digits typed, filled or shown, set in the cell; what the pen wrote is the learner's own, and the digit read from it is small beside it
    // what the learner wrote is in pencil: the ink of the givens, never the accent (a red digit reads as wrong before anything is checked). A digit Show me wrote is dim:
    // it is not the learner's.
    const typeset = state.by === 'key' || state.by === 'fill' || state.by === 'shown';
    if (typeset && state.value !== '') texts.push(plain(key, `c:${name}`, state.value, at, small_ ? small : big, state.by === 'shown' ? 'value' : 'cell'));
    const corner = Math.min(drawn.width * 0.42, 22);
    if (state.by === 'pen' && state.read !== '') {
      texts.push(plain(key, `r:${name}`, state.read, box(drawn.x + drawn.width - corner - 2, drawn.y + 1, corner, corner), small_ ? noted : small, 'value'));
    } else if (state.reading) texts.push(plain(key, `r:${name}`, '…', box(drawn.x + drawn.width - corner - 2, drawn.y + 1, corner, corner), small_ ? noted : small, 'value'));
    // marks of the last Check, the hint, the cell the keyboard is in
    const tint = (kind: string): void => void marksBack.push({ kind: 'shape', owner: key, part: `mark:${kind}-${name}`, outline: [roundedRect(inflate(drawn, 1), radius)], role: 'fill' });
    if (state.reading) tint('reading');
    if (run.hint === name) tint('hint');
    if (state.mark === 'wrong') tint('wrong');
    if (run.active === name) frames.push({ kind: 'shape', owner: key, part: `act:${name}`, outline: [roundedRect(inflate(drawn, 3), radius + 2)], role: 'frame' });
    if (state.mark === 'empty') frames.push({ kind: 'shape', owner: key, part: `bad:ring-${name}`, outline: dashedRound(inflate(drawn, 4)), role: 'frame' });
    // the teacher's red pen: a tick or a cross, outside the cell's top-right corner, never on the digit
    const s = 11;
    const bx = drawn.x + drawn.width + 1;
    const by = drawn.y - s + 3;
    if (state.mark === 'right') lines.push({ kind: 'shape', owner: key, part: `ok:${name}`, outline: [open([{ x: bx, y: by + s * 0.55 }, { x: bx + s * 0.38, y: by + s * 0.95 }, { x: bx + s, y: by + s * 0.1 }])], role: 'line' });
    if (state.mark === 'wrong') lines.push({ kind: 'shape', owner: key, part: `bad:${name}`, outline: [open([{ x: bx + s * 0.1, y: by + s * 0.1 }, { x: bx + s * 0.9, y: by + s * 0.9 }]), open([{ x: bx + s * 0.9, y: by + s * 0.1 }, { x: bx + s * 0.1, y: by + s * 0.9 }])], role: 'line' });
    // the pen's ink can be taken off a cell: a small cross at its corner. A finger or a pen finds it in a box that reaches only 20 into the cell, so that the middle of
    // the cell (where a tap opens the keyboard) is never the cross's
    if (state.ink) {
      const r = Math.max(6, Math.min(8, drawn.width * 0.16));
      const cx = drawn.x + 2 + r;
      const cy = drawn.y + 2 + r;
      lines.push({ kind: 'shape', owner: key, part: `clr:${name}`, outline: [circleOutline(cx, cy, r), open([{ x: cx - r * 0.45, y: cy - r * 0.45 }, { x: cx + r * 0.45, y: cy + r * 0.45 }]), open([{ x: cx + r * 0.45, y: cy - r * 0.45 }, { x: cx - r * 0.45, y: cy + r * 0.45 }])], role: 'grid' });
      clearing.set(name, box(drawn.x - 8, drawn.y - 8, 28, 28));
    }
  };

  for (const cell of grid.cells) {
    const at = rectOf(cell);
    cellBox.set(cell, at);
    if (!visible(cell)) continue;
    const name = cell.part;
    if (cell.role === 'rule') {
      const mid = at.y + at.height / 2;
      lines.push({ kind: 'shape', owner: key, part: 'rule', outline: [open([{ x: at.x, y: mid }, { x: at.x + at.width, y: mid }])], role: 'line' });
      continue;
    }
    if (cell.role === 'sign') {
      texts.push(plain(key, `c:${name}`, SIGNS[cell.value] ?? cell.value, at, big));
      continue;
    }
    if (inputs.has(cell)) {
      writeIn(cell, at);
      continue;
    }
    if (cell.role === 'carry' || cell.role === 'working') {
      if (cell.value !== '') texts.push(plain(key, `c:${name}`, cell.value, at, small));
      continue;
    }
    if (cell.value === '') continue;
    if (bond) {
      const ring = box(at.x + 3, at.y + at.height * 0.12, at.width - 6, at.height * 0.76);
      frames.push({ kind: 'shape', owner: key, part: `ring:${name}`, outline: [roundedRect(ring, ring.height / 2)], role: 'grid' });
    }
    const struck = cell.crossed && exchangeShown(cell);
    texts.push(plain(key, `c:${name}`, cell.value, at, big, struck ? 'value' : 'cell'));
    if (struck) {
      const cx = at.x + at.width / 2;
      const cy = at.y + at.height / 2;
      lines.push({ kind: 'shape', owner: key, part: `x:${name}`, outline: [open([{ x: cx - dm.width * 0.62, y: cy + dm.height * 0.3 }, { x: cx + dm.width * 0.62, y: cy - dm.height * 0.3 }])], role: 'line' });
    }
  }

  if (bond) {
    // the whole above, its two parts below, joined: the picture of a part-whole bond
    const [whole, a, b] = grid.cells;
    if (whole !== undefined && a !== undefined && b !== undefined) {
      const top_ = cellBox.get(whole);
      const l = cellBox.get(a);
      const r = cellBox.get(b);
      if (top_ !== undefined && l !== undefined && r !== undefined) {
        const from = { x: top_.x + top_.width / 2, y: top_.y + top_.height * 0.88 };
        for (const [name, to] of [['bond:1', l], ['bond:2', r]] as const) {
          lines.unshift({ kind: 'shape', owner: key, part: name, outline: [open([from, { x: to.x + to.width / 2, y: to.y + to.height * 0.12 }])], role: 'grid' });
        }
      }
    }
  }

  // the decimal point: a dot in every row that has digits, on one x; in expanded form it stands in the sign's column after the ones
  const pointRows = new Set(grid.cells.filter((cell) => cell.role === 'given' || cell.role === 'answer').map((cell) => cell.row));
  if (pointCol !== null) {
    for (const row of pointRows) {
      const at = box(left + (colX[pointCol] ?? 0) + (colW[pointCol] ?? unitX), top + (rowY[row] ?? 0), gap, rowH[row] ?? unitY);
      texts.push(plain(key, `point:${row}`, '.', at, big));
    }
  } else if (split && grid.pointAfter !== null) {
    const ones = grid.cells.find((cell) => cell.role === 'given' && cell.place === grid.pointAfter);
    if (ones !== undefined) {
      const at = rectOf({ ...ones, col: ones.col + 1 });
      texts.push(plain(key, 'point:0', '.', at, big));
    }
  }

  // Check, Hint and Show me, in a row under the digits; the line a hint is said in is under that
  const buttonBoxes = new Map<string, Box>();
  let shortened = false;
  if (inputs.size > 0 && run.verdict !== 'right' && run.verdict !== 'shown') {
    const label = (name: string): string => (name === 'check' ? 'Check' : name === 'hint' ? 'Hint' : 'Show me');
    const names = ['check', 'hint', ...(canShow(run) ? ['show'] : [])];
    const labelSpec: TextSpec = { size: 'm', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 };
    // the row is as wide as its words ask, and no wider than the room: a narrow room takes less padding, then shorter words
    const shortLabel = (name: string): string => (name === 'show' ? 'Show' : label(name));
    let gapB = 10;
    let widths: number[] = [];
    for (const [pad, words] of [[28, label], [16, label], [8, shortLabel], [4, shortLabel]] as const) {
      gapB = pad > 8 ? 10 : 6;
      widths = names.map((name) => Math.max(MIN_TARGET, input.measure(words(name), labelSpec, 1e9).width + pad));
      if (widths.reduce((a, b) => a + b, 0) + (names.length - 1) * gapB <= room.width + 0.5) {
        shortened = words === shortLabel;
        break;
      }
    }
    const total = widths.reduce((a, b) => a + b, 0) + (names.length - 1) * gapB;
    let bxAt = left + width / 2 - total / 2;
    const rowTop = top + y + stepper + 7;
    names.forEach((name, i) => {
      const w = widths[i] as number;
      const at = box(bxAt, rowTop, w, MIN_TARGET);
      buttonBoxes.set(name, at);
      frames.push({ kind: 'shape', owner: key, part: `btn:${name}`, outline: [roundedRect(at, at.height / 2)], role: 'frame' });
      texts.push(plain(key, `bt:${name}`, shortened && name === 'show' ? 'Show' : label(name), at, labelSpec, 'cell'));
      bxAt += w + gapB;
    });
  }
  let hintWidth = width;
  if (inputs.size > 0 && run.hintText !== '' && run.verdict !== 'right' && run.verdict !== 'shown') {
    hintWidth = hintBoxW;
    const at = box(left + width / 2 - hintWidth / 2, top + y + stepper + buttonsH + 2, hintWidth, hintH - 4);
    texts.push(plain(key, 'hint', run.hintText, at, spec('s' as Size, shrink), 'value'));
  }

  // marks put on parts by later lines, under everything else
  const partBoxes = new Map<string, Box>();
  const names = new Set<string>(['rule']);
  for (const cell of grid.cells) {
    names.add(cell.part);
    if (cell.role === 'given') names.add(cell.part.split('-')[0] ?? '');
    if (cell.role === 'answer') names.add('ans');
    if (cell.place !== null && cell.role !== 'sign' && cell.role !== 'rule') {
      const place = maths.placeName(cell.place);
      if (place !== null) names.add(place);
    }
  }
  for (let step = 1; step <= grid.steps; step += 1) names.add(`s${step}`);
  if (grid.cells.some((cell) => cell.role === 'sign')) names.add('sign');
  for (const name of names) {
    if (name === '' || !maths.isMathPart(name)) continue;
    const found = cellsOfPart(grid, name).map((cell) => cellBox.get(cell)).filter((at): at is Box => at !== undefined);
    if (found.length > 0) partBoxes.set(name, union(found));
  }
  for (const mark of math.marks) {
    const at = partBoxes.get(mark.part);
    if (at === undefined) continue;
    const around = inflate(at, 2);
    if (mark.mark === 'underline') marksBack.push({ kind: 'shape', owner: key, part: `mark:${mark.part}`, outline: [open([{ x: around.x, y: around.y + around.height }, { x: around.x + around.width, y: around.y + around.height }])], role: 'line' });
    else if (mark.mark === 'strike') marksBack.push({ kind: 'shape', owner: key, part: `mark:${mark.part}`, outline: [open([{ x: around.x, y: around.y + around.height / 2 }, { x: around.x + around.width, y: around.y + around.height / 2 }])], role: 'line' });
    else marksBack.push({ kind: 'shape', owner: key, part: `mark:${mark.part}`, outline: [roundedRect(around, radius)], role: 'fill' });
  }

  const parts: BlockPart[] = [...marksBack, ...frames, ...lines, ...texts];
  if (hasOwnStepper(math)) {
    const at = box(left, top + y, width, stepper);
    const words = shown >= grid.steps ? 'tap to start again' : shown === 0 ? 'tap for the first step' : `step ${shown} of ${grid.steps}: tap for the next`;
    parts.push(plain(key, 'stepper', words, at, spec('s', shrink), 'value'));
  }
  const boxes = new Map<string, Box>();
  for (const [name, at] of partBoxes) boxes.set(`${key}.${name}`, at);
  for (const [name, at] of writing) boxes.set(`${key}@cell:${name}`, at);
  for (const [name, at] of clearing) boxes.set(`${key}@clear:${name}`, at);
  for (const [name, at] of buttonBoxes) boxes.set(`${key}@btn:${name}`, at);
  boxes.set(key, box(left, top, Math.max(width, hintWidth), height));
  return { lineHeight: dm.height, parts, boxes, width: Math.max(width, hintWidth), height };
}

// --- a picture ----------------------------------------------------------------------------------------------------------------------

function pictureOf(input: StructureInput, math: MathFigure, shown: number): Built {
  const key = input.structure.key;
  const room = input.room;
  const form = formOf(math.sum);
  const picW = Math.max(240, Math.min(room.width, 640));
  const picH = Math.max(180, Math.min(room.height - 40, 420));
  const drawing: WayDrawing | null = form === null ? null : drawWay(form, math.method as WayName, { width: picW, height: picH });
  const ox = room.x + Math.max(0, (room.width - picW) / 2);
  const oy = room.y;
  const parts: BlockPart[] = [];
  const captionSpec = specAtPx(input, 18);
  const capH = input.measure('Mg', captionSpec, 1e9).height * 1.5;
  const stepped = math.steps || math.step !== null;
  if (drawing === null) {
    // no picture draws this sum: it is said, with its unknown as it was written
    const at = box(ox, oy, picW, picH * 0.4);
    parts.push(plain(key, 'sum', math.sum.replace(/\s*=\s*\?$/, '') + ' = ?', at, specAtPx(input, 34)));
    return { lineHeight: 0, parts, boxes: new Map([[key, at]]), width: picW, height: picH * 0.4 };
  }
  const lineHeight = (spec_: TextSpec): number => input.measure('Mg', spec_, 1e9).height;
  drawing.pieces.forEach((piece, at) => {
    if (piece.step > shown) return;
    for (const part of partsOfPiece(input, key, piece, at, ox, oy, lineHeight)) parts.push(part);
  });
  // what the picture says of the step it is at
  let height = picH;
  if (stepped) {
    const total = drawing.steps.length;
    const now = Math.min(Math.max(shown, 0), total);
    const words = now === 0 ? (hasOwnStepper(math) ? 'tap for the first step' : '') : `${drawing.steps[now - 1] ?? ''}`;
    if (words !== '') parts.push(plain(key, 'caption', words, box(ox, oy + picH, picW, capH), captionSpec, 'value'));
    height = picH + capH;
  }
  return { lineHeight: 0, parts, boxes: new Map([[key, box(ox, oy, picW, height)]]), width: picW, height };
}

/** One piece of a picture as the parts of the block: shapes in the look's colours, words in a size that reads. */
function partsOfPiece(input: StructureInput, key: string, piece: WayPiece, index: number, ox: number, oy: number, lineHeight: (spec: TextSpec) => number): BlockPart[] {
  const n = piece.n;
  const name = `p${index}`;
  const at = (v: number | undefined, base: number): number => base + (v ?? 0);
  if (piece.tag === 'rect') {
    const r = box(at(n.x, ox), at(n.y, oy), n.w ?? 0, n.h ?? 0);
    const outline = roundedRect(r, Math.min(n.r ?? 0, r.height / 2, r.width / 2));
    if (piece.cls.includes('pw-shade') || piece.cls.includes('pw-rod')) return [{ kind: 'shape', owner: key, part: name, outline: [outline], role: 'bar' }];
    return [
      { kind: 'shape', owner: key, part: `${name}f`, outline: [outline], role: 'fill' },
      { kind: 'shape', owner: key, part: name, outline: [outline], role: 'frame' },
    ];
  }
  if (piece.tag === 'circle') {
    const outline = circleOutline(at(n.cx, ox), at(n.cy, oy), n.r ?? 4);
    if (piece.cls.includes('pw-dot')) return [{ kind: 'shape', owner: key, part: name, outline: [outline], role: 'marker' }];
    if (piece.cls.includes('pw-bowl--a')) return [{ kind: 'shape', owner: key, part: `${name}f`, outline: [outline], role: 'bar' }, { kind: 'shape', owner: key, part: name, outline: [outline], role: 'frame' }];
    return [{ kind: 'shape', owner: key, part: name, outline: [outline], role: 'frame' }];
  }
  if (piece.tag === 'line') {
    const faint = piece.cls.includes('pw-cut');
    return [{ kind: 'shape', owner: key, part: name, outline: [open([{ x: at(n.x1, ox), y: at(n.y1, oy) }, { x: at(n.x2, ox), y: at(n.y2, oy) }])], role: faint ? 'grid' : 'line' }];
  }
  if (piece.tag === 'path') {
    const points = (piece.points ?? []).map((p) => ({ x: p.x + ox, y: p.y + oy }));
    return [{ kind: 'shape', owner: key, part: name, outline: [open(points)], role: 'line' }];
  }
  const px = n.size ?? 16;
  const textSpec = specAtPx(input, px);
  const words = piece.text ?? '';
  const measured = input.measure(words, textSpec, 1e9);
  const h = Math.max(measured.height, lineHeight(textSpec));
  const w = measured.width + 2;
  const anchor = piece.anchor ?? 'middle';
  const x = anchor === 'start' ? at(n.x, ox) : anchor === 'end' ? at(n.x, ox) - w : at(n.x, ox) - w / 2;
  const cy = at(n.y, oy) - px * 0.33;
  const emphasis: Range[] = piece.role === 'q' || piece.role === 'a' ? [{ start: 0, end: words.length }] : [];
  return [plain(key, name, words, box(x, cy - h / 2, w, h), textSpec, piece.role === 'dim' ? 'value' : 'cell', emphasis)];
}
