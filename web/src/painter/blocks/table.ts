// Table: no box, no vertical rules; columns as wide as their content, names
// ranged left, numbers sharing a decimal place, a hairline under the header
// and the last row. `bars` draws the first column of numbers as bars from zero.

import type { MeasuredText, StructureInput, StructureLayout, TextSpec } from '../../contracts/blocks';
import type { BlockPart } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, open, union } from './geom';
import type { Draft } from './kit';
import { best, Env, fit } from './kit';
import { isRuleRow, splitCells, splitEmphasis } from '@conduit/language';
import type { Range } from '@conduit/language';

export function layoutTable(input: StructureInput): StructureLayout {
  // the table as columns; and, for a room too narrow to read it so, each row as a record: its name, then each column's label and value
  const records = (wrap: number) => (): StructureLayout => fit(input, input.look.stroke, (env) => buildRecords(env), undefined, wrap);
  const columns = (): StructureLayout => fit(input, input.look.stroke, (env) => buildTable(env));
  return best([columns, records(1)]);
}

const NUMBER = /^[-+−]?[$£€¥]?\s?\d[\d,]*(\.\d+)?\s?(%|[a-zA-Z]{1,3})?$/;

function numberValue(text: string): number {
  const m = /([\d,]+(?:\.\d+)?)\s?([KkMBbT])?/.exec(text);
  if (!m) return 0;
  const v = Number((m[1] as string).replace(/,/g, ''));
  const mult = { K: 1e3, k: 1e3, M: 1e6, B: 1e9, b: 1e9, T: 1e12 }[(m[2] ?? '') as 'K'] ?? 1;
  return v * mult;
}

interface Cell {
  text: string;
  emphasis: Range[];
  m: MeasuredText;
  /** numbers: the width of what comes before the decimal point */
  head: number;
}

interface Read {
  readonly parsed: { cells: { text: string; emphasis: Range[] }[]; index: number }[];
  readonly ncols: number;
  readonly H: number;
  readonly numeric: boolean[];
  readonly headerSpec: TextSpec;
  readonly specOf: (r: number) => TextSpec;
}

function readRows(env: Env): Read {
  const f = env.input.structure.figure;
  const rawRows = f?.kind === 'structure' ? f.rows : [];
  const parsed: { cells: { text: string; emphasis: Range[] }[]; index: number }[] = [];
  rawRows.forEach((row, index) => {
    const cells = splitCells(row.cells.join(' | '));
    if (cells.length === 0 || isRuleRow(cells)) return;
    parsed.push({ cells: row.cells.map((c) => {
        const s = splitEmphasis(c.trim());
        return { text: s.plain, emphasis: s.emphasis };
      }), index });
  });
  const ncols = Math.max(0, ...parsed.map((r) => r.cells.length));
  const headerSpec: TextSpec = env.small();
  // The first row is the header, unless it is plainly data: numbers in every column the rows below hold numbers in.
  const numericIn = (rows: typeof parsed, c: number): boolean => {
    const texts = rows.map((r) => r.cells[c]?.text.trim() ?? '').filter((t) => t !== '');
    return texts.length > 0 && texts.every((t) => NUMBER.test(t));
  };
  const numeric: boolean[] = [];
  for (let c = 0; c < ncols; c += 1) numeric.push(numericIn(parsed.slice(1), c));
  const first = parsed[0];
  const dataFirst = first !== undefined && parsed.length > 1 && numeric.some(Boolean) && numeric.every((isNum, c) => !isNum || NUMBER.test(first.cells[c]?.text.trim() ?? ''));
  const H = dataFirst ? 0 : 1;
  if (dataFirst) for (let c = 0; c < ncols; c += 1) numeric[c] = numericIn(parsed, c);
  const specOf = (r: number): TextSpec => (r < H ? headerSpec : env.spec);
  return { parsed, ncols, H, numeric, headerSpec, specOf };
}

function buildTable(env: Env): Draft {
  const input = env.input;
  const room = input.room;
  const body = env.body;
  const f = input.structure.figure;
  const wantBars = f?.kind === 'structure' && f.bars;
  const { parsed, ncols, H, numeric, specOf } = readRows(env);

  const decimalSplit = (text: string): [string, string] => {
    const i = text.indexOf('.');
    if (i >= 0) return [text.slice(0, i), text.slice(i)];
    const m = /^(.*?\d)([^\d,].*)?$/.exec(text);
    return [m?.[1] ?? text, m?.[2] ?? ''];
  };

  const barCol = wantBars ? numeric.findIndex((x, c) => x && c > 0) : -1;
  const colMax: number[] = new Array<number>(ncols).fill(1e9);
  const grid: Cell[][] = [];
  const measureCell = (r: number, c: number): Cell => {
    const src = parsed[r]?.cells[c] ?? { text: '', emphasis: [] };
    const text = src.text;
    const m = text === '' ? { width: 0, height: env.measure('n', 1e9, specOf(r)).height, lineHeight: 0, lines: [] } : env.measure(text, colMax[c] as number, specOf(r));
    let head = 0;
    if (numeric[c] && r >= H) head = env.measure(decimalSplit(text)[0], 1e9, specOf(r)).width;
    return { text, emphasis: src.emphasis, m, head };
  };
  const widthOf = (c: number): number => {
    if (numeric[c]) {
      let l = 0;
      let rr = 0;
      let hw = 0;
      for (let r = 0; r < parsed.length; r += 1) {
        const cell = (grid[r] as Cell[])[c] as Cell;
        if (r < H) hw = cell.m.width;
        else {
          l = Math.max(l, cell.head);
          rr = Math.max(rr, cell.m.width - cell.head);
        }
      }
      return env.up(Math.max(hw, l + rr), 'x');
    }
    return env.up(Math.max(0, ...parsed.map((_, r) => ((grid[r] as Cell[])[c] as Cell).m.width)), 'x');
  };
  for (let r = 0; r < parsed.length; r += 1) grid.push(Array.from({ length: ncols }, (_, c) => measureCell(r, c)));
  const colGap = env.up(1.5 * body * env.tight, 'x');
  const barMin = barCol >= 0 ? env.up(5 * body, 'x') : 0;
  const barGap = barCol >= 0 ? env.up(0.6 * body, 'x') : 0;
  const widths = Array.from({ length: ncols }, (_, c) => widthOf(c));
  const total = (): number => widths.reduce((s, w) => s + w, 0) + Math.max(0, ncols - 1) * colGap + barMin + barGap;
  const minWrap = env.measure('n'.repeat(10), 1e9).width;
  for (let guard = 0; guard < 8 && total() > room.width + 0.5; guard += 1) {
    let pick = -1;
    for (let c = 0; c < ncols; c += 1) if (!numeric[c] && (widths[c] as number) > minWrap + 1 && (pick < 0 || (widths[c] as number) > (widths[pick] as number))) pick = c;
    if (pick < 0) break;
    const target = Math.max(minWrap, (widths[pick] as number) - (total() - room.width));
    colMax[pick] = target;
    for (let r = 0; r < parsed.length; r += 1) (grid[r] as Cell[])[pick] = measureCell(r, pick);
    widths[pick] = widthOf(pick);
  }

  const line = env.body;
  const pitchMin = (env.tight < 1 ? 1.25 : 1.5) * line;
  const pitch = parsed.map((_, r) => env.up(Math.max(pitchMin, Math.max(...(grid[r] as Cell[]).map((x) => x.m.height)) + 0.5 * line), 'y'));
  const title = input.structure.text.trim();
  const titleM = title ? env.measure(title, room.width, { ...env.spec, size: 'l' }) : null;
  const titleH = titleM ? titleM.height + 0.8 * line : 0;
  const height = titleH + pitch.reduce((s, p) => s + p, 0);
  const W = total();

  const finish = (rm: Box): ReturnType<Draft['finish']> => {
    const key = input.structure.key;
    const parts: BlockPart[] = [];
    const extra = Math.max(0, rm.width - W - 2 * (env.grid?.width ?? 0));
    const barW = barCol >= 0 ? Math.min(barMin + extra, Math.max(barMin, rm.width * 0.4)) : 0;
    const used = W - barMin + barW;
    const x0 = env.within(rm.x + Math.max(0, (rm.width - used) / 2), rm.x, rm.x + rm.width - used, 'x');
    const colX: number[] = [];
    let x = x0;
    for (let c = 0; c < ncols; c += 1) {
      colX.push(x + (c === barCol ? barW + barGap : 0));
      x += (widths[c] as number) + colGap + (c === barCol ? barW + barGap : 0);
    }
    const left = x0;
    const rightEdge = x0 + used;
    let y = rm.y;
    if (titleM) {
      parts.push({ kind: 'text', owner: key, part: 'title', text: title, emphasis: [], box: box(rm.x, y, titleM.width, titleM.height), spec: { ...env.spec, size: 'l' }, align: 'left', role: 'title', plate: false });
      y += titleH;
    }
    const maxValue = barCol >= 0 ? Math.max(0, ...parsed.slice(H).map((_, i) => numberValue(((grid[i + H] as Cell[])[barCol] as Cell).text))) : 0;
    const rowsN = parsed.length - H;
    const bandTop: number[] = [];
    parsed.forEach((row, r) => {
      const top = y;
      bandTop.push(top);
      const p = pitch[r] as number;
      const starred = (grid[r] as Cell[]).some((cell) => cell.emphasis.length > 0);
      (grid[r] as Cell[]).forEach((cell, c) => {
        if (cell.text === '') return;
        const cw = widths[c] as number;
        const ty = top + (p - cell.m.height) / 2;
        let bx = colX[c] as number;
        let align: 'left' | 'right' = 'left';
        if (numeric[c]) {
          if (r < H) {
            bx = (colX[c] as number) + cw - cell.m.width;
            align = 'right';
          } else {
            let lw = 0;
            for (let rr = H; rr < parsed.length; rr += 1) lw = Math.max(lw, ((grid[rr] as Cell[])[c] as Cell).head);
            bx = (colX[c] as number) + lw - cell.head;
          }
        }
        parts.push({
          kind: 'text',
          owner: key,
          part: `cell:${r}:${c}`,
          text: cell.text,
          emphasis: cell.emphasis,
          box: box(env.snap(bx, 'x'), ty, cell.m.width, cell.m.height),
          spec: specOf(r),
          align,
          role: r < H ? 'header' : 'cell',
          row: row.index,
          plate: false,
        });
      });
      if (barCol >= 0 && r >= H && maxValue > 0) {
        const v = numberValue(((grid[r] as Cell[])[barCol] as Cell).text);
        const len = Math.max(0, (v / maxValue) * barW);
        const th = Math.max(4, 0.5 * line);
        const bx = (colX[barCol] as number) - barGap - barW;
        const b = box(bx, top + (p - th) / 2, Math.max(len, 1), th);
        parts.push({
          kind: 'shape',
          owner: key,
          part: starred ? `bar:${r}:star` : `bar:${r}`,
          outline: [{ points: [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }], closed: true }],
          role: 'bar',
          row: row.index,
        });
      }
      y += p;
    });
    // Hairlines: under the header and the last row; lighter between rows when there are many.
    parsed.forEach((row, r) => {
      const under = bandTop[r] as number + (pitch[r] as number);
      const last = r === parsed.length - 1;
      if ((r === 0 && H === 1) || last) parts.push({ kind: 'shape', owner: key, part: `rule:${r}`, outline: [open([{ x: left, y: under }, { x: rightEdge, y: under }])], role: 'line', row: row.index });
      else if (rowsN > 6) parts.push({ kind: 'shape', owner: key, part: `rule:${r}`, outline: [open([{ x: left, y: under }, { x: rightEdge, y: under }])], role: 'grid', row: row.index });
    });
    const boxes = new Map<string, Box>();
    const all = parts.map((p) => (p.kind === 'text' ? p.box : box(left, rm.y, used, 0)));
    boxes.set(key, all.length ? union([...all, box(left, rm.y, used, y - rm.y)]) : box(rm.x, rm.y, 0, 0));
    return { parts, boxes, routes: new Map(), notes: [] };
  };
  return { width: W, height, finish };
}

/** Each row of a table as a record, for a room too narrow for its columns: the name, then a label and its value on every line. */
function buildRecords(env: Env): Draft {
  const input = env.input;
  const body = env.body;
  const { parsed, ncols, H, specOf } = readRows(env);
  const line = body;
  const colGap = env.up(0.8 * body, 'x');
  const heads = H === 1 ? (parsed[0]?.cells ?? []) : [];
  const labelW = Math.max(0, ...heads.slice(1).map((h) => (h.text === '' ? 0 : env.measure(h.text, 1e9, specOf(0)).width)));
  const valueMax = Math.max(body * 4, input.room.width - labelW - colGap);
  interface Item {
    readonly c: number;
    readonly label: { text: string; m: MeasuredText } | null;
    readonly value: { text: string; emphasis: Range[]; m: MeasuredText };
    readonly h: number;
  }
  interface Card {
    readonly row: number;
    readonly items: Item[];
    readonly h: number;
  }
  const records: Card[] = [];
  for (let r = H; r < parsed.length; r += 1) {
    const row = parsed[r] as (typeof parsed)[number];
    const items: Item[] = [];
    for (let c = 0; c < ncols; c += 1) {
      const cell = row.cells[c];
      if (cell === undefined || cell.text === '') continue;
      const first = c === 0;
      const m = env.measure(cell.text, first ? input.room.width : valueMax, specOf(r));
      const head = heads[c];
      const label = !first && head !== undefined && head.text !== '' ? { text: head.text, m: env.measure(head.text, 1e9, specOf(0)) } : null;
      items.push({ c, label, value: { text: cell.text, emphasis: cell.emphasis, m }, h: Math.max(m.height, label?.m.height ?? 0) });
    }
    const h = items.reduce((sum, it) => sum + it.h, 0) + 0.45 * line * Math.max(0, items.length - 1);
    records.push({ row: row.index, items, h });
  }
  const gapR = env.up(0.9 * line, 'y');
  const title = env.title();
  const widest = Math.max(0, ...records.flatMap((rc) => rc.items.map((it) => (it.c === 0 ? it.value.m.width : labelW + colGap + it.value.m.width))));
  const total = records.reduce((sum, rc) => sum + rc.h, 0) + Math.max(0, records.length - 1) * gapR;
  const finish = (rm: Box): ReturnType<Draft['finish']> => {
    const key = input.structure.key;
    const parts: BlockPart[] = [];
    const tp = title.part(rm);
    if (tp !== null) parts.push(tp);
    const x0 = env.within(rm.x + Math.max(0, (rm.width - widest) / 2), rm.x, rm.x + Math.max(0, rm.width - widest), 'x');
    let y = env.after(rm.y + title.h, 'y');
    const top = y;
    const all: Box[] = [];
    records.forEach((rc, ri) => {
      rc.items.forEach((it) => {
        if (it.c === 0) {
          const b = box(env.snap(x0, 'x'), y, it.value.m.width, it.value.m.height);
          parts.push({ kind: 'text', owner: key, part: `cell:${ri}:0`, text: it.value.text, emphasis: it.value.emphasis.length > 0 ? it.value.emphasis : [{ start: 0, end: it.value.text.length }], box: b, spec: specOf(H), align: 'left', role: 'cell', row: rc.row, plate: false });
          all.push(b);
        } else {
          if (it.label !== null) {
            const lb = box(env.snap(x0, 'x'), y + (it.h - it.label.m.height) / 2, it.label.m.width, it.label.m.height);
            parts.push({ kind: 'text', owner: key, part: `head:${ri}:${it.c}`, text: it.label.text, emphasis: [], box: lb, spec: specOf(0), align: 'left', role: 'header', row: rc.row, plate: false });
            all.push(lb);
          }
          const vb = box(env.snap(x0 + labelW + colGap, 'x'), y + (it.h - it.value.m.height) / 2, it.value.m.width, it.value.m.height);
          parts.push({ kind: 'text', owner: key, part: `cell:${ri}:${it.c}`, text: it.value.text, emphasis: it.value.emphasis, box: vb, spec: specOf(H), align: 'left', role: 'cell', row: rc.row, plate: false });
          all.push(vb);
        }
        y += it.h + 0.45 * line;
      });
      y += -0.45 * line + gapR;
      if (ri + 1 < records.length) {
        const ry = y - gapR / 2;
        parts.push({ kind: 'shape', owner: key, part: `rule:${ri}`, outline: [open([{ x: x0, y: ry }, { x: x0 + widest, y: ry }])], role: 'grid', row: rc.row });
      }
    });
    const boxes = new Map<string, Box>();
    boxes.set(key, all.length > 0 ? union([...all, box(x0, top, widest, Math.max(0, y - gapR - top))]) : box(rm.x, rm.y, 0, 0));
    return { parts, boxes, routes: new Map(), notes: [] };
  };
  return { width: widest, height: total + title.h, finish };
}
