// The ways a maths question is laid out under it (`problem`). The painter draws each one from the numbers of the sum; the brain never does. Pure:
// a form and a room go in, a list of pieces comes out, each one tagged with the step it appears at. The view shows the pieces up to the step a hand
// (or "Show me") has reached, so each step adds one piece, a label sits on the part it names, and the unknown is a "?" in every step: no way ever
// draws the answer, however many steps are shown.
//
//   groups   equal groups (bowls with dots, or a labelled block where the number is too big to count)
//   bar      a bar split into equal parts, parts shaded for a fraction
//   array    rows and columns of dots
//   column   tens and ones in a column, as it is written on paper, with the blocks beside the digits
//   line     a number line with jumps

import type { ProblemForm } from '@conduit/language';
import type { ProblemWay } from '@conduit/language';

export type Role = 'ink' | 'dim' | 'a' | 'b' | 'q';

export interface WayPiece {
  /** 1-based: visible once the step reached is at least this */
  readonly step: number;
  readonly tag: 'rect' | 'circle' | 'line' | 'path' | 'text';
  readonly attrs: Readonly<Record<string, string | number>>;
  readonly text?: string;
}

export interface WayDrawing {
  readonly width: number;
  readonly height: number;
  readonly pieces: readonly WayPiece[];
  /** one short line per step, said under the drawing */
  readonly steps: readonly string[];
}

export interface Room {
  readonly width: number;
  readonly height: number;
}

const COUNT_LIMIT = 48;

/** 1 000, as a person writes it */
export const spaced = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const show = (n: number | null): string => (n === null ? '?' : spaced(n));

class Sheet {
  readonly pieces: WayPiece[] = [];
  readonly steps: string[] = [];
  constructor(readonly width: number, readonly height: number) {}
  /** opens the next step and says it */
  step(words: string): number {
    this.steps.push(words);
    return this.steps.length;
  }
  add(step: number, tag: WayPiece['tag'], attrs: Record<string, string | number>, text?: string): void {
    this.pieces.push(text === undefined ? { step, tag, attrs } : { step, tag, attrs, text });
  }
  rect(step: number, x: number, y: number, w: number, h: number, cls: string, r = 6): void {
    this.add(step, 'rect', { x: round(x), y: round(y), width: round(w), height: round(h), rx: r, class: cls });
  }
  circle(step: number, cx: number, cy: number, r: number, cls: string): void {
    this.add(step, 'circle', { cx: round(cx), cy: round(cy), r: round(r), class: cls });
  }
  line(step: number, x1: number, y1: number, x2: number, y2: number, cls: string): void {
    this.add(step, 'line', { x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2), class: cls });
  }
  path(step: number, d: string, cls: string): void {
    this.add(step, 'path', { d, class: cls });
  }
  text(step: number, x: number, y: number, words: string, size: number, role: Role, anchor: 'start' | 'middle' | 'end' = 'middle'): void {
    this.add(step, 'text', { x: round(x), y: round(y), 'font-size': Math.round(size), 'text-anchor': anchor, class: `pw-t pw-t--${role}` }, words);
  }
  done(): WayDrawing {
    return { width: this.width, height: this.height, pieces: this.pieces, steps: this.steps };
  }
}

const round = (n: number): number => Math.round(n * 10) / 10;
const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);

/** the text size the labels take: readable on a phone, never huge */
const labelPx = (room: Room): number => Math.max(16, Math.min(34, Math.min(room.width / 14, room.height / 9)));

/** A bracket under `x1..x2` at `y` with `words` below: the "altogether" or "this many" of a part. */
function bracket(s: Sheet, step: number, x1: number, x2: number, y: number, words: string, size: number, role: Role = 'q'): void {
  const t = Math.min(10, size * 0.5);
  s.path(step, `M${round(x1)} ${round(y)} v${round(t)} H${round(x2)} v${round(-t)}`, `pw-brace pw-brace--${role}`);
  s.text(step, (x1 + x2) / 2, y + t + size + 2, words, size, role);
}

// -------------------------------------------------------------------------------------------------------------------------------- groups

interface Bowl {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

/** Where `count` bowls go in the room: rows of as many as fit, each as big as the room allows. */
function bowlsIn(room: Room, count: number, top: number, bottom: number, extra = 0, wantRows?: number): Bowl[] {
  const m = 16;
  const availW = room.width - 2 * m;
  const availH = Math.max(40, bottom - top);
  let best: Bowl[] = [];
  let bestR = 0;
  for (let rows = wantRows ?? 1; rows <= (wantRows ?? count); rows += 1) {
    const perRow = ceilDiv(count, rows);
    const cell = Math.min(availW / perRow, availH / rows - extra);
    const r = Math.max(10, Math.min(cell / 2 - 6, 110));
    if (r <= bestR) continue;
    bestR = r;
    best = Array.from({ length: count }, (_, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, count - row * perRow);
      const col = i - row * perRow;
      const cw = availW / perRow;
      const x0 = m + (availW - cw * inRow) / 2;
      return { cx: x0 + cw * (col + 0.5), cy: top + (availH / rows) * (row + 0.5) - extra / 2, r };
    });
  }
  return best;
}

/** `n` dots inside a bowl, as a tidy grid; false when they would be too small to count. */
function dotsIn(s: Sheet, step: number, b: Bowl, n: number, cls: string): boolean {
  const cols = Math.ceil(Math.sqrt(n * 1.3));
  const rows = ceilDiv(n, cols);
  const r = (b.r * 1.3) / (2 * Math.max(cols, rows) * 1.25);
  if (r < 3.2) return false;
  const gap = r * 2.5;
  for (let i = 0; i < n; i += 1) {
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    const inRow = Math.min(cols, n - row * cols);
    s.circle(step, b.cx + (col - (inRow - 1) / 2) * gap, b.cy + (row - (rows - 1) / 2) * gap, r, cls);
  }
  return true;
}

function groupsWay(form: ProblemForm, room: Room): WayDrawing | null {
  const s = new Sheet(room.width, room.height);
  const px = labelPx(room);
  let total: number | null;
  let groups: number | null;
  let each: number | null;
  if (form.op === 'div') {
    total = form.a;
    groups = form.b;
    each = form.c;
  } else if (form.op === 'mul') {
    groups = form.a;
    each = form.b;
    total = form.c;
  } else if (form.op === 'of' && form.frac !== null && form.b !== null) {
    return fractionGroups(form, room);
  } else return null;
  if (groups !== null && (groups < 2 || groups > 12)) return null;
  const unknownEach = each === null;
  const unknownTotal = total === null;
  const known = (n: number | null): n is number => n !== null;
  const bigPile = (n: number): boolean => n > COUNT_LIMIT;
  // the room: a strip on top for the whole, the bowls under it, a bracket below them
  const topStrip = known(total) && !unknownTotal && form.op === 'div' ? px * 2.4 : 0;
  const shown = groups ?? 2;
  const bowls = bowlsIn(room, shown, 16 + topStrip + (topStrip > 0 ? px * 1.2 : 0), room.height - px * 3.6, px * 1.4);
  const bottom = Math.max(...bowls.map((b) => b.cy + b.r)) + px * 0.9;
  const drawBowls = (step: number): void => {
    for (const b of bowls) s.circle(step, b.cx, b.cy, b.r, 'pw-bowl');
  };
  const labelEach = (step: number, text: string, role: Role): void => {
    for (const b of bowls) s.text(step, b.cx, b.cy + b.r + px + 2, text, px, role);
  };
  if (form.op === 'div' && known(total) && groups !== null) {
    // a ÷ b = ?   (share a into b equal groups) — or the divisor is what is asked (see below)
    const one = s.step(`Start with ${spaced(total)}.`);
    if (bigPile(total)) {
      s.rect(one, room.width / 2 - 70, 12, 140, px * 1.9, 'pw-block');
      s.text(one, room.width / 2, 12 + px * 1.35, spaced(total), px * 1.1, 'a');
    } else {
      const pile = Math.min(total, COUNT_LIMIT);
      const per = Math.min(pile, 24);
      for (let i = 0; i < pile; i += 1) s.circle(one, room.width / 2 + ((i % per) - (per - 1) / 2) * 11, 16 + Math.floor(i / per) * 12, 4, 'pw-dot');
    }
    const two = s.step(`Make ${groups} equal groups.`);
    drawBowls(two);
    if (!unknownEach) return null;
    const three = s.step('Share them out fairly.');
    if (!bigPile(total) && total % groups === 0 && total / groups <= 12) {
      const each2 = total / groups;
      // dots too small to count in a narrow room: say it in words rather than add nothing
      if (!bowls.map((b) => dotsIn(s, three, b, each2, 'pw-dot')).every(Boolean)) s.text(three, room.width / 2, 16 + topStrip + 4, 'share equally', px * 0.9, 'dim');
    } else {
      s.text(three, room.width / 2, 16 + topStrip + 4, 'share equally', px * 0.9, 'dim');
    }
    const four = s.step('How many in each group?');
    labelEach(four, '?', 'q');
    return s.done();
  }
  if (form.op === 'div' && known(total) && groups === null && known(each)) {
    // a ÷ ? = c: groups of c, and how many groups
    const one = s.step(`Start with ${spaced(total)}.`);
    s.rect(one, room.width / 2 - 70, 12, 140, px * 1.9, 'pw-block');
    s.text(one, room.width / 2, 12 + px * 1.35, spaced(total), px * 1.1, 'a');
    const two = s.step(`Make groups of ${spaced(each)}.`);
    const first = bowls.slice(0, 2);
    first.forEach((b) => {
      s.circle(two, b.cx, b.cy, b.r, 'pw-bowl');
      if (each <= 12 && !bigPile(each)) dotsIn(s, two, b, each, 'pw-dot');
      else s.text(two, b.cx, b.cy + px * 0.35, spaced(each), px, 'a');
    });
    const last = first[first.length - 1];
    if (last !== undefined) s.text(two, (last.cx + room.width) / 2 + 8, last.cy + px * 0.3, '…', px * 1.6, 'dim');
    const three = s.step('How many groups?');
    bracket(s, three, 16, room.width - 16, bottom, '? groups', px);
    return s.done();
  }
  if (groups === null) {
    // ? × b = c (or ? ÷ b … handled above): ? groups of b, c altogether
    if (!known(each)) return null;
    const one = s.step(`Groups of ${spaced(each)}.`);
    bowls.forEach((b) => {
      s.circle(one, b.cx, b.cy, b.r, 'pw-bowl');
      if (each <= 12 && !bigPile(each)) dotsIn(s, one, b, each, 'pw-dot');
      else s.text(one, b.cx, b.cy + px * 0.35, spaced(each), px, 'a');
    });
    const lastB = bowls[bowls.length - 1];
    if (lastB !== undefined) s.text(one, (lastB.cx + room.width) / 2 + 8, lastB.cy + px * 0.3, '…', px * 1.6, 'dim');
    if (known(total)) {
      const two = s.step(`${spaced(total)} altogether.`);
      bracket(s, two, 16, room.width - 16, bottom, spaced(total), px, 'a');
    }
    const three = s.step('How many groups?');
    s.text(three, room.width / 2, bottom + px * 3, '? groups', px, 'q');
    return s.done();
  }
  // groups known: a × b = ?, a × ? = c, ? ÷ b = c
  const one = s.step(`${groups} groups.`);
  drawBowls(one);
  const two = s.step(unknownEach ? 'Each group has the same.' : `${show(each)} in each group.`);
  if (known(each)) {
    bowls.forEach((b) => {
      if (each <= 12 && each * groups <= COUNT_LIMIT * 2 && dotsIn(s, two, b, each, 'pw-dot')) return;
      s.rect(two, b.cx - b.r * 0.55, b.cy - px * 0.8, b.r * 1.1, px * 1.6, 'pw-block');
      s.text(two, b.cx, b.cy + px * 0.35, spaced(each), px * 0.95, 'a');
    });
  } else labelEach(two, '?', 'q');
  if (known(total)) {
    const three = s.step(`${spaced(total)} altogether.`);
    bracket(s, three, bowls[0] !== undefined ? Math.min(...bowls.map((b) => b.cx - b.r)) : 16, Math.max(...bowls.map((b) => b.cx + b.r)), bottom, spaced(total), px, 'a');
  } else {
    const three = s.step('How many altogether?');
    bracket(s, three, Math.min(...bowls.map((b) => b.cx - b.r)), Math.max(...bowls.map((b) => b.cx + b.r)), bottom, '?', px * 1.2);
  }
  return s.done();
}

/** three quarters of 20, as groups: the whole shared into equal groups, some of them taken. */
function fractionGroups(form: ProblemForm, room: Room): WayDrawing | null {
  const frac = form.frac;
  if (frac === null || form.b === null) return null;
  const s = new Sheet(room.width, room.height);
  const px = labelPx(room);
  const whole = form.b;
  const bowls = bowlsIn(room, frac.den, 12 + px * 2.6, room.height - px * 3.6, px * 1.4);
  const bottom = Math.max(...bowls.map((b) => b.cy + b.r)) + px * 0.9;
  const one = s.step(`The whole is ${spaced(whole)}.`);
  s.rect(one, room.width / 2 - 70, 12, 140, px * 1.9, 'pw-block');
  s.text(one, room.width / 2, 12 + px * 1.35, spaced(whole), px * 1.1, 'a');
  const two = s.step(`Share it into ${frac.den} equal groups.`);
  bowls.forEach((b) => {
    s.circle(two, b.cx, b.cy, b.r, 'pw-bowl');
    s.text(two, b.cx, b.cy + b.r + px + 2, '?', px, 'q');
  });
  const three = s.step(`Take ${frac.num} of the ${frac.den} groups.`);
  bowls.slice(0, frac.num).forEach((b) => s.circle(three, b.cx, b.cy, b.r, 'pw-bowl pw-bowl--a'));
  const taken = bowls.slice(0, frac.num);
  const four = s.step('How many is that altogether?');
  bracket(s, four, Math.min(...taken.map((b) => b.cx - b.r)), Math.max(...taken.map((b) => b.cx + b.r)), bottom, '?', px * 1.2);
  return s.done();
}

// -------------------------------------------------------------------------------------------------------------------------------- bar

function barWay(form: ProblemForm, room: Room): WayDrawing | null {
  const s = new Sheet(room.width, room.height);
  const px = labelPx(room);
  let total: number | null;
  let parts: number | null;
  let each: number | null;
  let shaded = 0;
  let ofWhole = false;
  if (form.op === 'div') {
    total = form.a;
    parts = form.b;
    each = form.c;
  } else if (form.op === 'mul') {
    parts = form.a;
    each = form.b;
    total = form.c;
  } else if (form.op === 'of' && form.frac !== null) {
    total = form.b;
    parts = form.frac.den;
    each = null;
    shaded = form.frac.num;
    ofWhole = true;
  } else return null;
  if (parts === null) {
    // a ÷ ? = c or ? × b = c: a bar of known total, cut into parts of c: how many parts?
    if (total === null || each === null) return null;
    parts = 0;
  }
  if (parts > 12) return null;
  const x = 24;
  const w = room.width - 2 * x;
  const y = Math.max(px * 3.4, room.height * 0.28);
  const h = Math.max(46, Math.min(90, room.height * 0.22));
  if (parts === 0) {
    const one = s.step(`The whole bar is ${spaced(total ?? 0)}.`);
    s.rect(one, x, y, w, h, 'pw-bar');
    bracket(s, one, x, x + w, y + h + 6, spaced(total ?? 0), px, 'a');
    const two = s.step(`Cut it into parts of ${spaced(each ?? 0)}.`);
    const cuts = 3;
    for (let i = 1; i <= cuts; i += 1) s.line(two, x + (w * i) / (cuts + 1), y, x + (w * i) / (cuts + 1), y + h, 'pw-cut');
    s.text(two, x + w * 0.375, y + h / 2 + px * 0.35, spaced(each ?? 0), px, 'a');
    const three = s.step('How many parts?');
    s.text(three, x + w * 0.875, y + h / 2 + px * 0.35, '?', px * 1.3, 'q');
    return s.done();
  }
  const unknownTotal = total === null;
  const one = s.step(unknownTotal ? 'A bar for the whole.' : `The whole bar is ${show(total)}.`);
  s.rect(one, x, y, w, h, 'pw-bar');
  if (!unknownTotal) {
    s.path(one, `M${x} ${round(y - 8)} v-8 H${x + w} v8`, 'pw-brace pw-brace--a');
    s.text(one, x + w / 2, y - 22, show(total), px * 1.1, 'a');
  }
  const two = s.step(`${parts} equal parts.`);
  for (let i = 1; i < parts; i += 1) s.line(two, x + (w * i) / parts, y, x + (w * i) / parts, y + h, 'pw-cut');
  if (shaded > 0) {
    const three = s.step(`Colour in ${shaded} of the ${parts} parts.`);
    s.rect(three, x, y, (w * shaded) / parts, h, 'pw-shade', 4);
  }
  const partLabel = (step: number): void => {
    for (let i = 0; i < parts; i += 1) {
      const cx = x + (w * (i + 0.5)) / parts;
      if (each !== null && !ofWhole) s.text(step, cx, y + h / 2 + px * 0.35, spaced(each), Math.min(px, (w / parts) / 3), 'a');
      else s.text(step, cx, y + h / 2 + px * 0.35, '?', Math.min(px * 1.2, (w / parts) / 2.2), 'q');
    }
  };
  if (form.op === 'mul') {
    const three = s.step(each === null ? 'Each part is the same.' : `Each part is ${spaced(each)}.`);
    partLabel(three);
    const four = s.step(unknownTotal ? 'How many altogether?' : `${show(total)} altogether.`);
    if (unknownTotal) bracket(s, four, x, x + w, y + h + 8, '?', px * 1.2);
    else s.text(four, x + w / 2, y + h + px * 2, `${show(total)} altogether`, px, 'dim');
  } else if (ofWhole) {
    const four = s.step('How much is each part?');
    partLabel(four);
    const five = s.step(`How much are the ${shaded} coloured parts?`);
    bracket(s, five, x, x + (w * shaded) / parts, y + h + 8, '?', px * 1.2);
  } else {
    const three = s.step(unknownTotal ? `Each part is ${spaced(each ?? 0)}.` : 'How much is each part?');
    partLabel(three);
    if (unknownTotal) {
      const four = s.step('How big is the whole bar?');
      s.path(four, `M${x} ${round(y - 8)} v-8 H${x + w} v8`, 'pw-brace pw-brace--q');
      s.text(four, x + w / 2, y - 22, '?', px * 1.2, 'q');
    }
  }
  return s.done();
}

// -------------------------------------------------------------------------------------------------------------------------------- array

function arrayWay(form: ProblemForm, room: Room): WayDrawing | null {
  if (form.op !== 'mul' || form.a === null || form.b === null || form.c !== null) return null;
  const rows = form.a;
  const cols = form.b;
  if (rows < 1 || cols < 1 || rows > 12 || cols > 12) return null;
  const s = new Sheet(room.width, room.height);
  const px = labelPx(room);
  const left = 40;
  const top = px * 2 + 8;
  const availW = room.width - left - 24;
  const availH = room.height - top - px * 3.4;
  const gap = Math.min(availW / cols, availH / rows, 44);
  const r = gap * 0.34;
  const x0 = left + (availW - gap * cols) / 2;
  const dot = (step: number, row: number, col: number): void => s.circle(step, x0 + gap * (col + 0.5), top + gap * (row + 0.5), r, 'pw-dot');
  const one = s.step(`One row has ${cols}.`);
  for (let c = 0; c < cols; c += 1) dot(one, 0, c);
  s.text(one, x0 + (gap * cols) / 2, top - 10, `${cols} in a row`, px * 0.9, 'dim');
  const two = s.step(`${rows} rows.`);
  for (let row = 1; row < rows; row += 1) for (let c = 0; c < cols; c += 1) dot(two, row, c);
  s.text(two, x0 - 10, top + (gap * rows) / 2 + px * 0.3, `${rows}`, px, 'dim', 'end');
  const three = s.step('How many altogether?');
  bracket(s, three, x0, x0 + gap * cols, top + gap * rows + 6, '?', px * 1.2);
  return s.done();
}

// -------------------------------------------------------------------------------------------------------------------------------- column

const PLACES = ['Hundreds', 'Tens', 'Ones'] as const;

function digitsOf(n: number, places: number): number[] {
  const text = String(n).padStart(places, '0');
  return [...text].map(Number);
}

function columnWay(form: ProblemForm, room: Room): WayDrawing | null {
  if (form.op !== 'add' && form.op !== 'sub') return null;
  const nums = [form.a, form.b, form.c];
  if (nums.some((n) => n !== null && (n > 999 || !Number.isInteger(n)))) return null;
  const s = new Sheet(room.width, room.height);
  const px = labelPx(room);
  const need = Math.max(...nums.map((n) => (n === null ? 1 : String(n).length)));
  const places = Math.max(2, need);
  const names = PLACES.slice(3 - places);
  // the table: a sign column, then one column per place
  const signW = 38;
  const colW = Math.min(220, (room.width - signW - 32) / places);
  const x0 = (room.width - signW - colW * places) / 2 + signW;
  const rowH = Math.max(30, Math.min(130, (room.height - px * 3.2) / 3.8));
  const top = px * 2;
  const dpx = Math.min(px * 1.5, rowH * 0.62);
  const rowY = (row: number): number => top + rowH * row;
  const cell = (c: number): number => x0 + colW * (c + 0.5);
  // headers sit with the first row
  const header = (step: number): void => {
    names.forEach((name, c) => s.text(step, cell(c), px * 1.3, name, px * 0.85, 'dim'));
  };
  const pictureOf = (step: number, row: number, c: number, digit: number, place: number, role: 'a' | 'b'): void => {
    const cx = cell(c) + colW * 0.14;
    const cy = rowY(row) + rowH / 2;
    const unit = Math.min(rowH * 0.5, colW / 7);
    if (place === 1) {
      // tens: tall rods
      for (let i = 0; i < digit; i += 1) s.rect(step, cx + (i - (digit - 1) / 2) * unit * 0.95 + 0, cy - rowH * 0.2 + 0 - rowH * 0.0, unit * 0.55, rowH * 0.62, `pw-rod pw-rod--${role}`, 2);
    } else if (place === 2) {
      // ones: dots in two short rows
      const per = Math.min(5, Math.max(1, digit));
      for (let i = 0; i < digit; i += 1) s.circle(step, cx + ((i % per) - (per - 1) / 2) * unit * 0.8, cy + (Math.floor(i / per) - 0.2) * unit * 0.8, unit * 0.28, `pw-dot pw-dot--${role}`);
    } else {
      for (let i = 0; i < digit; i += 1) s.rect(step, cx + (i - (digit - 1) / 2) * unit * 1.25 - unit * 0.5, cy - unit * 0.5, unit, unit, `pw-block pw-block--${role}`, 3);
    }
  };
  const writeRow = (step: number, row: number, n: number | null, sign: string | null, role: 'a' | 'b'): void => {
    if (sign !== null) s.text(step, x0 - 22, rowY(row) + rowH / 2 + px * 0.4, sign, px * 1.4, 'dim');
    if (n === null) {
      names.forEach((_, c) => s.text(step, cell(c), rowY(row) + rowH / 2 + px * 0.45, '?', dpx, 'q'));
      return;
    }
    const ds = digitsOf(n, places);
    ds.forEach((d, c) => {
      const place = c + (3 - places);
      if (c < places - String(n).length) return;
      s.text(step, cell(c) - colW * 0.4, rowY(row) + rowH / 2 + px * 0.45, String(d), dpx, role === 'a' ? 'a' : 'b', 'middle');
      pictureOf(step, row, c, d, place, role);
    });
  };
  const sign = form.op === 'add' ? '+' : '−';
  // the three rows of the sum as it is written: a, b, c (the unknown a "?")
  const rowsOf = form.unknown === 'c' ? [form.a, form.b, null] : form.unknown === 'b' ? [form.a, null, form.c] : [null, form.b, form.c];
  const [ra = null, rb = null, rc = null] = rowsOf;
  const one = s.step(ra === null ? 'The part we do not know.' : `Start with ${spaced(ra)}.`);
  header(one);
  writeRow(one, 0, ra, null, 'a');
  const two = s.step(rb === null ? 'The missing number goes here.' : form.op === 'add' ? `Add ${spaced(rb)}.` : `Take away ${spaced(rb)}.`);
  writeRow(two, 1, rb, sign, 'b');
  const three = s.step(form.unknown === 'c' ? (form.op === 'add' ? 'Ones first, then tens.' : 'Take away the ones first, then the tens.') : 'What is left to make the whole?');
  s.line(three, x0 - 6, rowY(2) - 4, x0 + colW * places + 6, rowY(2) - 4, 'pw-rule');
  if (rc === null) names.forEach((_, c) => s.text(three, cell(c), rowY(2) + rowH / 2 + px * 0.45, '?', dpx, 'q'));
  else {
    const ds = digitsOf(rc, places);
    ds.forEach((d, c) => {
      if (c < places - String(rc).length) return;
      s.text(three, cell(c) - colW * 0.4, rowY(2) + rowH / 2 + px * 0.45, String(d), dpx, 'a', 'middle');
    });
  }
  return s.done();
}

// -------------------------------------------------------------------------------------------------------------------------------- number line

/** The jumps a number is cut into: its hundreds, its tens, its ones (30 and 7 for 37; a single jump for a number under 10 or a round one). */
function jumpsOf(n: number): number[] {
  if (n < 10) return [n];
  const out: number[] = [];
  let rest = n;
  for (const place of [100, 10]) {
    const part = Math.floor(rest / place) * place;
    if (part > 0) out.push(part);
    rest -= part;
  }
  if (rest > 0) out.push(rest);
  return out;
}

function lineWay(form: ProblemForm, room: Room): WayDrawing | null {
  if (form.op !== 'add' && form.op !== 'sub') return null;
  const s = new Sheet(room.width, room.height);
  const px = labelPx(room);
  const add = form.op === 'add';
  const m = 34;
  const y = room.height * 0.62;
  const sign = add ? '+' : '−';
  // the line's two ends and the jumps between them
  type Plan = { readonly from: number | null; readonly to: number | null; readonly jumps: readonly number[] | null };
  let plan: Plan;
  if (form.unknown === 'c') plan = { from: form.a, to: null, jumps: form.b === null ? null : jumpsOf(form.b) };
  else if (form.unknown === 'b') plan = { from: form.a, to: form.c, jumps: null };
  else plan = { from: null, to: form.c, jumps: form.b === null ? null : jumpsOf(form.b) };
  // the scale: what the line shows, from its lowest to its highest known value
  const values: number[] = [];
  if (plan.from !== null) values.push(plan.from);
  if (plan.to !== null) values.push(plan.to);
  const known = plan.from ?? plan.to ?? 0;
  const span = plan.jumps === null ? 0 : plan.jumps.reduce((a, b) => a + b, 0);
  const lo = plan.from !== null && plan.to !== null ? Math.min(plan.from, plan.to) : add ? known : known - span;
  const hi = plan.from !== null && plan.to !== null ? Math.max(plan.from, plan.to) : add ? known + span : known;
  const pad = Math.max(1, (hi - lo) * 0.08);
  const scale = (v: number): number => m + ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (room.width - 2 * m);
  s.line(1, m - 12, y, room.width - m + 12, y, 'pw-rule');
  const tick = (step: number, v: number | null, at: number, label: string, role: Role): void => {
    s.line(step, at, y - 9, at, y + 9, `pw-tick pw-tick--${role}`);
    s.text(step, at, y + px * 1.7, label, px, role);
    void v;
  };
  const arc = (step: number, x1: number, x2: number, label: string, role: Role): void => {
    const mid = (x1 + x2) / 2;
    const lift = Math.max(18, Math.min(70, Math.abs(x2 - x1) * 0.5, y - px * 1.6 - 14));
    s.path(step, `M${round(x1)} ${round(y - 4)} Q${round(mid)} ${round(y - 4 - lift * 2)} ${round(x2)} ${round(y - 4)}`, `pw-arc pw-arc--${role}`);
    s.text(step, mid, y - lift - 12, label, px, role);
  };
  if (plan.jumps !== null && plan.from !== null) {
    // a ± b = ?  from a, jump by the parts of b; the last landing is the "?"
    const first = s.step(`Start at ${spaced(plan.from)}.`);
    tick(first, plan.from, scale(plan.from), spaced(plan.from), 'a');
    let at = plan.from;
    plan.jumps.forEach((j, i) => {
      const last = i === (plan.jumps?.length ?? 0) - 1;
      const next = add ? at + j : at - j;
      const step = s.step(`Jump ${sign}${spaced(j)}.`);
      arc(step, scale(at), scale(next), `${sign}${spaced(j)}`, 'b');
      tick(step, next, scale(next), last ? '?' : spaced(next), last ? 'q' : 'a');
      at = next;
    });
    return s.done();
  }
  if (plan.from !== null && plan.to !== null) {
    // a ± ? = c: from a to c, the jump is the "?"
    const one = s.step(`Start at ${spaced(plan.from)}.`);
    tick(one, plan.from, scale(plan.from), spaced(plan.from), 'a');
    const two = s.step(`We want to get to ${spaced(plan.to)}.`);
    tick(two, plan.to, scale(plan.to), spaced(plan.to), 'a');
    const three = s.step('How big is the jump?');
    arc(three, scale(plan.from), scale(plan.to), '?', 'q');
    return s.done();
  }
  if (plan.jumps !== null && plan.to !== null) {
    // ? ± b = c: end at c, the start is the "?"
    const one = s.step(`We end at ${spaced(plan.to)}.`);
    tick(one, plan.to, scale(plan.to), spaced(plan.to), 'a');
    let at = plan.to;
    const back: number[] = [];
    plan.jumps.forEach((j) => {
      const next = add ? at - j : at + j;
      back.push(next);
      at = next;
    });
    const two = s.step(`We jumped ${sign}${spaced(span)} to get there.`);
    const startX = scale(back[back.length - 1] ?? plan.to);
    arc(two, startX, scale(plan.to), `${sign}${spaced(span)}`, 'b');
    const three = s.step('Where did we start?');
    tick(three, null, startX, '?', 'q');
    return s.done();
  }
  return null;
}

// -------------------------------------------------------------------------------------------------------------------------------- the entry

/** Draws one way of a sum in a room, or null when this way does not fit the sum (the chip is then not offered). */
export function drawWay(form: ProblemForm, way: ProblemWay, room: Room): WayDrawing | null {
  const safe = { width: Math.max(220, Math.round(room.width)), height: Math.max(150, Math.round(room.height)) };
  try {
    switch (way) {
      case 'groups':
        return groupsWay(form, safe);
      case 'bar':
        return barWay(form, safe);
      case 'array':
        return arrayWay(form, safe);
      case 'column':
        return columnWay(form, safe);
      case 'line':
        return lineWay(form, safe);
    }
  } catch {
    return null;
  }
}

/** The number of steps a way has for a sum, in a room of a nominal size: what the check reads against. */
export const stepsOf = (form: ProblemForm, way: ProblemWay): number => drawWay(form, way, { width: 600, height: 380 })?.steps.length ?? 0;

export { show as showNumber };
