// What the rows of a chart mean.
//
// A chart is written as a table: one row a point, `| when | value…`. This
// module turns those rows into a model a charting engine can draw: what kind
// of thing runs along the bottom (time, a number, names), which series there
// are, how their numbers are written (so the axis can be written the same
// way), and what is wrong with the data, if anything is.
//
// It is here, in the shared package, because three programs must read a chart
// the same way: the painter (which hands the model to its charting engine),
// the server (which says in the next brief what was wrong with the rows) and
// the battery (which checks a chart without looking at it). It is pure: rows
// in, model out.

import { evalExpr, parseExpr } from './expr';
import type { Scope } from './expr';
import type { StructureRow } from './schedule';
import { splitEmphasis } from './text';
import type { ChartKind } from './vocabulary';

/** How a series writes its numbers, read off the cells: the axis and the crosshair write them the same way. */
export interface NumberFormat {
  /** a currency sign written before the number, or '' */
  readonly prefix: string;
  /** `%`, or a unit written after the number, or '' */
  readonly suffix: string;
  /** the most decimals any cell of the series carries, at most 4 */
  readonly decimals: number;
  /** true when cells use k, M, B: large numbers are then written short on the axis too */
  readonly short: boolean;
}

const MAGNITUDE: Readonly<Record<string, number>> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, mn: 1e6, b: 1e9, B: 1e9, bn: 1e9, t: 1e12, T: 1e12, tn: 1e12 };
// A magnitude letter is written against the number (`8.2B`, `12k`); a unit may stand apart from it (`72 kg`, `5 m`).
const NUMBER = /^([-+−]?)\s*([$£€¥]?)\s*(\d[\d,]*\.?\d*|\.\d+)(?:(k|K|mn|m|M|bn|b|B|tn|t|T)(?![a-zA-Z]))?\s*(%|[a-zA-Z°/]{1,6})?$/;

export interface ReadNumber {
  readonly value: number;
  readonly prefix: string;
  readonly suffix: string;
  readonly decimals: number;
  readonly short: boolean;
}

/** Reads a number as a person writes one in a table: `1,204.5`, `$3.50`, `-4.1%`, `8.2B`, `31.2M`, `12k`, `72 kg`. Null when the cell is not a number. */
export function readNumber(cell: string): ReadNumber | null {
  const match = NUMBER.exec(cell.trim());
  if (match === null) return null;
  const [, sign = '', prefix = '', digits = '', magnitude, unit = ''] = match;
  const plain = digits.replace(/,/g, '');
  const scaled = Number((Number(plain) * (magnitude === undefined ? 1 : (MAGNITUDE[magnitude] ?? 1))).toPrecision(12));
  if (!Number.isFinite(scaled)) return null;
  const point = plain.indexOf('.');
  return { value: sign === '-' || sign === '−' ? -scaled : scaled, prefix, suffix: unit, decimals: point < 0 ? 0 : Math.min(4, plain.length - point - 1), short: magnitude !== undefined };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Reads a moment as a person writes one on an axis, as seconds since 1970 in
 * UTC: `2026`, `2026-03`, `2026-03-09`, `2026-03-09T14:30`, `Mar 2026`,
 * `9 Mar 2026`, `Q1 2026`, `2026 Q1`. Null when the cell is not a moment. A
 * bare year counts only from 1000 to 2999, so that `42` is a number.
 */
export function readWhen(cell: string): number | null {
  const text = cell.trim();
  const utc = (year: number, month = 1, day = 1, hour = 0, minute = 0): number | null => {
    if (year < 1000 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    return Date.UTC(year, month - 1, day, hour, minute) / 1000;
  };
  let match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?)?)?$/.exec(text);
  if (match !== null) return utc(Number(match[1]), match[2] === undefined ? 1 : Number(match[2]), match[3] === undefined ? 1 : Number(match[3]), match[4] === undefined ? 0 : Number(match[4]), match[5] === undefined ? 0 : Number(match[5]));
  match = /^(?:(\d{1,2})\s+)?([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(text);
  if (match !== null) {
    const month = MONTHS.indexOf((match[2] ?? '').toLowerCase());
    return month < 0 ? null : utc(Number(match[3]), month + 1, match[1] === undefined ? 1 : Number(match[1]));
  }
  match = /^(?:Q([1-4])\s+(\d{4})|(\d{4})\s+Q([1-4]))$/i.exec(text);
  if (match !== null) return utc(Number(match[2] ?? match[3]), (Number(match[1] ?? match[4]) - 1) * 3 + 1);
  return null;
}

/** What a column of a chart is. The four prices of a candle and its volume are told apart by name or, with no header, by place. */
export type SeriesRole = 'value' | 'open' | 'high' | 'low' | 'close' | 'volume';

const ROLE_NAMES: Readonly<Record<string, SeriesRole>> = { open: 'open', o: 'open', high: 'high', h: 'high', low: 'low', l: 'low', close: 'close', c: 'close', volume: 'volume', vol: 'volume', v: 'volume' };

export interface ChartSeries {
  /** as the header named it; '' for a single unnamed series */
  readonly name: string;
  readonly role: SeriesRole;
  /** one value per point; null where the row had none */
  readonly values: readonly (number | null)[];
  readonly format: NumberFormat;
}

export interface ChartPoint {
  /** seconds since 1970 for time, the number itself for a number, the row's place (0, 1, 2 …) for a name */
  readonly x: number;
  /** the first cell as written, emphasis marks removed: what the axis and the crosshair say */
  readonly label: string;
  /** the row was starred (`| *2025* | 8.2`): it is the one that matters */
  readonly starred: boolean;
  /** when the row lands, on the clock of the turn that wrote it */
  readonly at: number;
}

export interface ChartModel {
  readonly kind: ChartKind;
  /**
   * What runs along the bottom. `time` and `number` are drawn TO SCALE: equal
   * steps are equal distances however unevenly the points are spaced. `name`
   * is one slot a row. Candles and OHLC bars are the exception every trading
   * chart makes: sessions sit side by side and the gaps between them are closed.
   */
  readonly x: 'time' | 'number' | 'name';
  readonly points: readonly ChartPoint[];
  readonly series: readonly ChartSeries[];
  /** true when the series are the prices of one instrument (and perhaps its volume) */
  readonly candles: boolean;
  /** what is wrong with the rows, a sentence each, for the brain's next brief; empty when nothing is */
  readonly problems: readonly string[];
}

function valueOf(cell: string, scope: Scope): ReadNumber | null {
  const braces = /^\{(.+)\}$/.exec(cell.trim());
  if (braces === null) return readNumber(cell);
  const expr = parseExpr(braces[1] ?? '');
  if (expr === null) return null;
  const value = evalExpr(expr, scope);
  return Number.isFinite(value) ? { value, prefix: '', suffix: '', decimals: 2, short: false } : null;
}

/** The value cells of a row: cells may be separated by bars or, within a cell, by spaces (`| 3 Mar | 100 104 99 103 1.2M`). A `{…}` is one value whatever it holds. */
function valueCells(cells: readonly string[]): string[] {
  return cells.slice(1).flatMap((cell) => (/^\{.*\}$/.test(cell.trim()) ? [cell.trim()] : cell.trim().split(/\s+/).filter((part) => part !== '')));
}

/**
 * Reads the rows of a chart. `scope` gives the controls' values, for cells
 * written `{…}`: a chart whose cells follow a slider is read again whenever
 * the slider moves.
 */
export function chartModelOf(kind: ChartKind, rows: readonly StructureRow[], scope: Scope = {}): ChartModel {
  const problems: string[] = [];
  const price = kind === 'candles' || kind === 'ohlc';
  let names: string[] = [];
  let body = rows;
  const first = rows[0];
  // The first row is a header when none of its value cells is a number.
  if (first !== undefined && valueCells(first.cells).length > 0 && valueCells(first.cells).every((cell) => valueOf(cell, scope) === null)) {
    names = first.cells.slice(1).map((cell) => splitEmphasis(cell).plain.trim());
    body = rows.slice(1);
  }
  const width = body.reduce((most, row) => Math.max(most, valueCells(row.cells).length), 0);
  const roles: SeriesRole[] = [];
  for (let index = 0; index < width; index += 1) {
    const named = ROLE_NAMES[(names[index] ?? '').toLowerCase()];
    if (named !== undefined) roles.push(named);
    else if (price && names.length === 0) roles.push((['open', 'high', 'low', 'close', 'volume'] as const)[index] ?? 'value');
    else roles.push('value');
  }
  const whens = body.map((row) => readWhen(splitEmphasis(row.cells[0] ?? '').plain));
  const numbers = body.map((row) => readNumber(splitEmphasis(row.cells[0] ?? '').plain));
  const x: ChartModel['x'] = body.length > 0 && whens.every((when) => when !== null) ? 'time' : body.length > 0 && numbers.every((number) => number !== null) ? 'number' : 'name';

  const points: ChartPoint[] = [];
  const columns: (number | null)[][] = roles.map(() => []);
  const formats: ReadNumber[][] = roles.map(() => []);
  body.forEach((row, index) => {
    const head = splitEmphasis(row.cells[0] ?? '');
    points.push({ x: x === 'time' ? (whens[index] ?? 0) : x === 'number' ? (numbers[index]?.value ?? 0) : index, label: head.plain.trim(), starred: head.emphasis.length > 0, at: row.at });
    const cells = valueCells(row.cells);
    roles.forEach((_, column) => {
      const read = cells[column] === undefined ? null : valueOf(cells[column] ?? '', scope);
      columns[column]?.push(read === null ? null : read.value);
      if (read !== null) formats[column]?.push(read);
    });
    if (cells.length > 0 && cells.every((cell) => valueOf(cell, scope) === null)) problems.push(`row ${index + 1} ("${head.plain.trim()}") has no number in it`);
  });

  const series: ChartSeries[] = roles.map((role, column) => {
    const read = formats[column] ?? [];
    return {
      name: role === 'value' ? (names[column] ?? (roles.filter((other) => other === 'value').length > 1 ? `series ${column + 1}` : '')) : role,
      role,
      values: columns[column] ?? [],
      format: { prefix: read[0]?.prefix ?? '', suffix: read[0]?.suffix ?? '', decimals: read.reduce((most, one) => Math.max(most, one.decimals), 0), short: read.some((one) => one.short) },
    };
  });

  const of = (role: SeriesRole): readonly (number | null)[] | undefined => series.find((one) => one.role === role)?.values;
  const [open, high, low, close] = [of('open'), of('high'), of('low'), of('close')];
  const candles = open !== undefined && high !== undefined && low !== undefined && close !== undefined;
  if (price && !candles) problems.push(`a ${kind} chart needs four prices a row: open, high, low, close`);
  if (candles) {
    points.forEach((point, index) => {
      const [o, h, l, c] = [open[index], high[index], low[index], close[index]];
      if (o === null || h === null || l === null || c === null || o === undefined || h === undefined || l === undefined || c === undefined) return;
      if (h < Math.max(o, c) || l > Math.min(o, c)) problems.push(`row ${index + 1} ("${point.label}"): the high must be the highest of the four prices and the low the lowest`);
    });
  }
  if ((x === 'time' || x === 'number') && points.some((point, index) => index > 0 && point.x <= (points[index - 1]?.x ?? Number.NEGATIVE_INFINITY))) {
    problems.push('the rows are not in order along the bottom axis; write them from first to last');
  }
  return { kind, x, points, series, candles, problems: problems.slice(0, 6) };
}

/** A number written as its series writes numbers: what an axis tick, a crosshair label and a mark's value say. */
export function formatNumber(value: number, format: NumberFormat): string {
  if (!Number.isFinite(value)) return '-';
  const size = Math.abs(value);
  let scaled = value;
  let letter = '';
  if (format.short || size >= 1e6) {
    if (size >= 1e12) [scaled, letter] = [value / 1e12, 'T'];
    else if (size >= 1e9) [scaled, letter] = [value / 1e9, 'B'];
    else if (size >= 1e6) [scaled, letter] = [value / 1e6, 'M'];
    else if (size >= 1e4 && format.short) [scaled, letter] = [value / 1e3, 'k'];
  }
  const decimals = letter === '' ? format.decimals : Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  const body = Math.abs(scaled).toLocaleString('en-US', { minimumFractionDigits: letter === '' ? decimals : 0, maximumFractionDigits: decimals });
  const unit = format.suffix === '%' || format.suffix === '' ? format.suffix : ` ${format.suffix}`;
  return `${scaled < 0 ? '-' : ''}${format.prefix}${body}${letter}${unit}`;
}
