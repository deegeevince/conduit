// The top of a chart: its title, the word "approximate", the legend, the credit the engine's licence asks for, and the
// crosshair's readout. Pure canvas work, no library: `headerOf` decides what goes on which line at this width (and how
// tall the whole header is, which the engine reserves above the plot), `paintHeader` draws it.
//
// The rules: the title is the stage's `s` and bold, everything else its `xs`; the title and the legend
// share one line where they fit and take a second only where they do not; the credit is on the chart, at the right of
// the first line; nothing is ever drawn over anything else, and a title that cannot fit is cut with an ellipsis.

import type { ChartTheme } from '../../contracts/chart';
import { FONTS } from '../../fonts';
import { rgba } from './tint';
import { LEAST_LABEL_PX, TITLE_OVER_LABEL } from './theme';

/** The legend's marks: a short line in the series' colour, dashed in the looks whose machine had one colour. */
export interface LegendItem {
  /** null: no swatch (a candle's four prices, a volume) */
  readonly colour: string | null;
  readonly text: string;
  /** 0 solid; 1 and up, a dash pattern (the looks without colour tell their series apart by it) */
  readonly style: number;
}

/** What the crosshair is on: the point's label and each series' value as written. */
export interface Readout {
  readonly point: number;
  readonly label: string;
  readonly items: readonly { readonly colour: string | null; readonly text: string }[];
}

export interface Row {
  readonly y: number;
  readonly h: number;
}

export interface Header {
  /** the space reserved above the plot, CSS pixels; 0 when there is no header (the spark form) */
  readonly height: number;
  /** the title as it will be written: one line, or two where it is too long for one (a phone), the last cut with an ellipsis if it must be */
  readonly titleLines: readonly string[];
  readonly titlePx: number;
  readonly labelPx: number;
  readonly approx: boolean;
  /** the line "approximate" is on: the title's first, or the second where the title takes two lines */
  readonly approxRow: 1 | 2;
  /** where the legend goes: on the title's line, on the next line, on a third, or nowhere (no legend) */
  readonly legendRow: 0 | 1 | 2 | 3;
  readonly legend: readonly LegendItem[];
  readonly credit: string;
  /** the credit is set smaller than the labels: it is a notice, not a reading */
  readonly creditPx: number;
  /** the line the credit is on */
  readonly creditRow: 1 | 2;
  /** the title's lines together, and the lines under them that exist */
  readonly row1: Row;
  readonly row2: Row | null;
  readonly row3: Row | null;
  readonly width: number;
}

const SIDE = 8;
const TOP = 6;
const BOTTOM = 6;
const GAP = 14;
const SWATCH = 20;
const DASHES: readonly (readonly number[])[] = [[6, 6], [2, 4], [10, 4], [2, 8]];

export const NO_HEADER: Header = { height: 0, titleLines: [], titlePx: 0, labelPx: 0, approx: false, approxRow: 1, legendRow: 0, legend: [], credit: '', creditPx: 0, creditRow: 1, row1: { y: 0, h: 0 }, row2: null, row3: null, width: 0 };

/** A CSS font for the chart's text: the look's face, bold only where the face is not a machine's. */
export function fontOf(theme: ChartTheme, px: number, bold = false): string {
  return `${px}px ${familyOf(theme, bold)}`;
}

const REGISTERED: ReadonlySet<string> = new Set(Object.values(FONTS).map((face) => face.family));

/** The CSS family list for the chart's text. A family with a digit in its name must be quoted, or the whole font declaration is dropped and the canvas keeps its 10 pixel default. The bold is the face's own 700 file where the look has one. */
export function familyOf(theme: ChartTheme, bold = false): string {
  const own = theme.fontFamily;
  const heavy = bold ? own.replace(/ 400$/, ' 700') : own;
  const family = REGISTERED.has(heavy) ? heavy : own;
  return `"${family}", ui-sans-serif, system-ui, sans-serif`;
}

let ruler: CanvasRenderingContext2D | null = null;
export function measure(font: string, text: string): number {
  if (ruler === null) {
    ruler = document.createElement('canvas').getContext('2d');
    if (ruler === null) throw new Error('This browser gives no 2d canvas to measure a chart title with.');
  }
  ruler.font = font;
  return ruler.measureText(text).width;
}

/** The text cut with an ellipsis until it is no wider than `room`. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, room: number): string {
  if (room <= 0) return '';
  if (ctx.measureText(text).width <= room) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const legendWidth = (font: string, items: readonly LegendItem[]): number => items.reduce((sum, item) => sum + measure(font, item.text) + (item.colour === null ? 0 : SWATCH) + GAP, 0) - (items.length > 0 ? GAP : 0);

export interface HeaderInput {
  readonly theme: ChartTheme;
  readonly width: number;
  readonly title: string;
  readonly approx: boolean;
  readonly legend: readonly LegendItem[];
}

/** The title broken at a space into at most two lines no wider than `room`, the second cut with an ellipsis when the rest will not fit. */
function wrapTitle(font: string, title: string, room: number): string[] {
  const words = title.split(/\s+/);
  // the split that leaves the two lines most alike, so that a line is never a lone word
  let best: string[] | null = null;
  let widest = Number.POSITIVE_INFINITY;
  for (let at = 1; at < words.length; at += 1) {
    const [first, rest] = [words.slice(0, at).join(' '), words.slice(at).join(' ')];
    const wide = Math.max(measure(font, first), measure(font, rest));
    if (wide < widest && measure(font, first) <= room) {
      widest = wide;
      best = [first, rest];
    }
  }
  const [first = '', rest = ''] = best ?? [title, ''];
  return rest === '' ? [cutTitle(font, first, room)] : [cutTitle(font, first, room), cutTitle(font, rest, room)];
}

/** Lays the header out at this width. */
export function headerOf(input: HeaderInput): Header {
  const { theme, width, approx, legend } = input;
  const labelPx = theme.fontPx;
  const titlePx = Math.round(labelPx * TITLE_OVER_LABEL);
  const labelFont = fontOf(theme, labelPx);
  const titleFont = fontOf(theme, titlePx, true);
  const creditPx = Math.max(LEAST_LABEL_PX, Math.round(labelPx * 0.72));
  const creditFont = fontOf(theme, creditPx);
  const smallH = Math.round(labelPx * 1.35);
  const inner = width - 2 * SIDE;
  const approxW = approx ? measure(labelFont, 'approximate') + GAP : 0;
  const titleW = input.title === '' ? 0 : measure(titleFont, input.title);
  const legendW = legend.length === 0 ? 0 : legendWidth(labelFont, legend);
  const together = titleW + approxW + (legendW === 0 ? 0 : GAP + legendW);
  const oneLineH = input.title === '' ? Math.round(labelPx * 1.45) : Math.round(titlePx * 1.3);

  // The credit goes at the right of the first line, in full if the title is whole beside it, else short; failing both, on the second line.
  const long = width >= 320 ? 'Charts by TradingView' : 'TradingView';
  const attempts: { credit: string; row: 1 | 2 }[] = [{ credit: long, row: 1 }, { credit: 'TradingView', row: 1 }, { credit: long, row: 2 }];
  const fitting = attempts.find((attempt) => input.title === '' || titleW + approxW <= (attempt.row === 1 ? inner - measure(creditFont, attempt.credit) - GAP : inner));

  let titleLines: string[];
  let creditRow: 1 | 2;
  let credit: string;
  let approxRow: 1 | 2 = 1;
  let legendRow: Header['legendRow'] = 0;
  let row1H = oneLineH;
  if (fitting !== undefined) {
    credit = fitting.credit;
    creditRow = fitting.row;
    const room1 = creditRow === 1 ? inner - measure(creditFont, credit) - GAP : inner;
    legendRow = legend.length === 0 ? 0 : together <= room1 ? 1 : 2;
    titleLines = input.title === '' ? [] : [input.title];
  } else {
    // a title too long for a line: two lines for it, and "approximate", the legend and the credit under them
    titleLines = wrapTitle(titleFont, input.title, inner);
    row1H = titleLines.length * Math.round(titlePx * 1.2) + 2;
    credit = 'TradingView';
    creditRow = 2;
    approxRow = 2;
    legendRow = legend.length === 0 ? 0 : approxW + legendW + measure(creditFont, credit) + 2 * GAP <= inner ? 2 : 3;
  }
  const row1 = { y: TOP, h: row1H };
  const second = legendRow === 2 || creditRow === 2 || approxRow === 2;
  const row2 = second ? { y: TOP + row1H, h: smallH } : null;
  const row3 = legendRow === 3 ? { y: TOP + row1H + smallH, h: smallH } : null;
  return {
    height: TOP + row1H + (row2 === null ? 0 : smallH) + (row3 === null ? 0 : smallH) + BOTTOM,
    titleLines,
    titlePx,
    labelPx,
    approx,
    approxRow,
    legendRow,
    legend,
    credit,
    creditPx,
    creditRow,
    row1,
    row2,
    row3,
    width,
  };
}

function cutTitle(font: string, title: string, room: number): string {
  if (room <= 0) return '';
  if (measure(font, title) <= room) return title;
  let cut = title;
  while (cut.length > 1 && measure(font, `${cut}…`) > room) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Words on the first lines of a chart are set with a halo in the ground: a gridline that runs behind the header does not strike through them. */
function shade(ctx: CanvasRenderingContext2D, theme: ChartTheme, text: string, x: number, y: number): void {
  const fill = ctx.fillStyle;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = theme.ground;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function legendItem(ctx: CanvasRenderingContext2D, theme: ChartTheme, item: { readonly colour: string | null; readonly text: string; readonly style?: number }, x: number, y: number, right: number): number {
  const w = ctx.measureText(item.text).width + (item.colour === null ? 0 : SWATCH);
  if (x + w > right) return x;
  let at = x;
  if (item.colour !== null) {
    ctx.strokeStyle = item.colour;
    ctx.lineWidth = 2;
    const style = item.style ?? 0;
    ctx.setLineDash(style === 0 ? [] : [...(DASHES[(style - 1) % DASHES.length] ?? [])]);
    ctx.beginPath();
    ctx.moveTo(x, y + theme.fontPx * 0.55);
    ctx.lineTo(x + 14, y + theme.fontPx * 0.55);
    ctx.stroke();
    ctx.setLineDash([]);
    at += SWATCH;
  }
  ctx.fillStyle = theme.ink;
  shade(ctx, theme, item.text, at, y);
  return x + w + GAP;
}

/** Draws the header, and the readout where the crosshair is. The context is in CSS pixels. */
export function paintHeader(ctx: CanvasRenderingContext2D, header: Header, theme: ChartTheme, readout: Readout | null): void {
  if (header.height === 0) return;
  const right = header.width - SIDE;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const labelFont = fontOf(theme, header.labelPx);
  const titleFont = fontOf(theme, header.titlePx, true);
  const centred = (row: Row): number => row.y + Math.round((row.h - header.labelPx) / 2);

  // the title: a line or two
  let x = SIDE;
  const lineH = header.titleLines.length <= 1 ? header.row1.h : Math.round(header.titlePx * 1.2);
  const titleY = header.row1.y + (header.titleLines.length <= 1 ? Math.round((header.row1.h - header.titlePx) / 2) - 1 : 1);
  ctx.font = titleFont;
  ctx.fillStyle = theme.ink;
  header.titleLines.forEach((line, index) => shade(ctx, theme, line, SIDE, titleY + index * lineH));
  if (header.titleLines.length === 1) x += ctx.measureText(header.titleLines[0] ?? '').width + GAP;

  // the small words: "approximate", the legend, the credit
  ctx.font = labelFont;
  const labelRow1 = header.titleLines.length === 0 ? centred(header.row1) : titleY + Math.round((header.titlePx - header.labelPx) * 0.8);
  const row2 = header.row2;
  const rowY = (row: 1 | 2 | 3): number => (row === 1 ? labelRow1 : row === 2 ? (row2 === null ? labelRow1 : centred(row2)) : header.row3 === null ? labelRow1 : centred(header.row3));
  ctx.font = fontOf(theme, header.creditPx);
  const creditW = ctx.measureText(header.credit).width;
  ctx.fillStyle = theme.crosshair;
  shade(ctx, theme, header.credit, right - creditW, rowY(header.creditRow) + Math.round((header.labelPx - header.creditPx) / 2));
  ctx.font = labelFont;
  let lineX = header.approxRow === 1 ? x : SIDE;
  if (header.approx) {
    ctx.fillStyle = theme.crosshair;
    shade(ctx, theme, 'approximate', lineX, rowY(header.approxRow));
    lineX += ctx.measureText('approximate').width + GAP;
  }

  const readoutRow = header.legendRow >= 2 ? (header.legendRow === 2 ? header.row2 : header.row3) : null;
  if (readout === null && header.legend.length > 0) {
    const row = header.legendRow === 0 ? 1 : header.legendRow;
    const limit = row === header.creditRow ? right - creditW - GAP : right;
    let lx = row === 1 ? x + (header.approx && header.approxRow === 1 ? lineX - x : 0) : row === header.approxRow && header.approx ? lineX : SIDE;
    for (const item of header.legend) lx = legendItem(ctx, theme, item, lx, rowY(row), limit);
  }

  if (readout !== null) {
    const parts: { colour: string | null; text: string }[] = [{ colour: null, text: readout.label }, ...readout.items];
    ctx.font = labelFont;
    const widths = parts.reduce((sum, part) => sum + ctx.measureText(part.text).width + (part.colour === null ? 0 : SWATCH) + GAP, 0);
    // on the legend's own line when it has one, else over the top of the plot on a backing in the ground, so a gridline does not strike through the words
    const last = header.row3 ?? header.row2 ?? header.row1;
    const row = readoutRow ?? { y: last.y + last.h, h: Math.round(header.labelPx * 1.5) };
    if (readoutRow === null) {
      ctx.fillStyle = rgba(theme.ground, 0.92);
      ctx.fillRect(SIDE - 4, row.y, Math.min(widths + 4, right - SIDE + 8), row.h);
    }
    let rx = SIDE;
    const ty = row.y + Math.round((row.h - header.labelPx) / 2);
    const limit = readoutRow !== null && header.creditRow === (header.legendRow === 2 ? 2 : 3) ? right - creditW - GAP : right;
    for (const [index, part] of parts.entries()) {
      if (index === 0) {
        ctx.fillStyle = theme.ink;
        ctx.fillText(part.text, rx, ty);
        rx += ctx.measureText(part.text).width + GAP;
      } else rx = legendItem(ctx, theme, part, rx, ty, limit);
    }
  }
  ctx.restore();
}
