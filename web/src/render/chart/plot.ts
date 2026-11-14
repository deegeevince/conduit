// What a chart state means as things to plot. Pure: a ChartState in, arrays out; no DOM and no library.
//
// The charting library spaces points by their place in the data, as trading charts do. Three of the things this
// stage needs are not that, so they are settled here, before the library sees anything:
//
//  1. TO SCALE. Time and number axes are laid on a grid of equal slots, and a point goes to its slot. Between
//     points a line is filled with the values it passes through (so it is the same line), a column leaves the
//     slot empty. Candles are the exception every trading chart makes: sessions sit side by side.
//  2. NAMES ALONG THE BOTTOM: one slot a row.
//  3. THE REVEAL: how many slots, or bars, of the final data are drawn, with the scale of the final data.

import { formatNumber } from '@conduit/language';
import type { ChartModel, ChartSeries, NumberFormat } from '@conduit/language';
import type { ChartState } from '../../contracts/chart';

/** 'time-grid' and 'number-grid': equal steps along the bottom. 'time-real': candles, real times, gaps closed. 'index': one slot a row. */
export type AxisMode = 'time-grid' | 'time-real' | 'number-grid' | 'index';

export interface Axis {
  readonly mode: AxisMode;
  /** the x (seconds, or the number) of slot 0, and the step between slots; for index and time-real the step is 1 and x0 is 0 */
  readonly x0: number;
  readonly step: number;
  /** how many slots there are along the whole bottom */
  readonly count: number;
  /** the slot of each point of the model, or -1 where it was dropped (out of order) */
  readonly slots: readonly number[];
  /** the ascending slots that hold a point */
  readonly kept: readonly number[];
  /** the point index of each kept slot */
  readonly keptPoint: readonly number[];
}

const MAX_SLOTS = 8000;
const SMOOTH_SLOTS = 240;

/**
 * The step that every gap between points is a whole number of, found by trying halves, thirds and so on of the
 * smallest gap. A line wants it exact (2%), because a point off its place is a lie in the picture; columns want
 * whole bars on a coarse grid, so a tenth is forgiven and, failing that, the smallest gap is the step.
 */
export function gridStep(xs: readonly number[], coarse: boolean): number {
  const diffs: number[] = [];
  for (let i = 1; i < xs.length; i += 1) {
    const d = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 1;
  let min = Infinity;
  for (const d of diffs) if (d < min) min = d;
  const tolerance = coarse ? 0.12 : 0.02;
  for (let k = 1; k <= (coarse ? 4 : 24); k += 1) {
    const s = min / k;
    if (
      diffs.every((d) => {
        const m = Math.max(1, Math.round(d / s));
        return Math.abs(d - m * s) <= tolerance * d;
      })
    )
      return s;
  }
  if (coarse) return min;
  const span = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);
  return span / Math.min(MAX_SLOTS, Math.max(600, xs.length * 2));
}

/** `fine` is true for a line or an area: they are given enough slots to reveal smoothly. */
export function axisOf(model: ChartModel, fine: boolean, coarse = false): Axis {
  const n = model.points.length;
  const sequential = (model.candles && model.draw !== 'line') || model.layout === 'even';
  if (sequential) {
    const keep: number[] = [];
    let last = Number.NEGATIVE_INFINITY;
    const slots = model.points.map((p, i) => {
      if (model.x !== 'name' && p.x <= last) return -1;
      last = p.x;
      keep.push(i);
      return keep.length - 1;
    });
    return { mode: model.x === 'time' && model.layout === 'scale' ? 'time-real' : 'index', x0: 0, step: 1, count: Math.max(1, keep.length), slots, kept: keep.map((_, s) => s), keptPoint: keep };
  }
  const xs = model.points.map((p) => p.x);
  const x0 = xs[0] ?? 0;
  const span = (xs[n - 1] ?? 0) - x0;
  let step = n < 2 || span <= 0 ? 1 : gridStep(xs, coarse);
  if (model.x === 'time') step = Math.max(1, Math.round(step));
  let count = n < 2 || span <= 0 ? 1 : Math.round(span / step + 0.4) + 1;
  if (fine && count < SMOOTH_SLOTS && count > 1) {
    const want = Math.ceil((SMOOTH_SLOTS - 1) / (count - 1));
    // a round division, so that slots fall on round numbers where the step is round
    const k = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((c) => c >= want) ?? want;
    step /= k;
    count = (count - 1) * k + 1;
  }
  const cap = Math.max(MAX_SLOTS, n * 2);
  if (count > cap) {
    step = span / (cap - 1);
    count = cap;
  }
  if (model.x === 'time' && step < 1) {
    step = 1;
    count = Math.round(span) + 1;
  }
  const kept: number[] = [];
  const keptPoint: number[] = [];
  const slots = xs.map((x, i) => {
    const s = Math.min(count - 1, Math.max(0, Math.round((x - x0) / step)));
    const previous = kept[kept.length - 1];
    if (previous !== undefined && s <= previous) {
      // two points in one slot: the later one wins
      if (s === previous) {
        keptPoint[keptPoint.length - 1] = i;
        return s;
      }
      return -1;
    }
    kept.push(s);
    keptPoint.push(i);
    return s;
  });
  return { mode: model.x === 'time' ? 'time-grid' : 'number-grid', x0, step, count, slots, kept, keptPoint };
}

/** The model's x at a (fractional) slot. For the sequential modes, the point's own x by interpolation. */
export function xAtSlot(axis: Axis, model: ChartModel, slot: number): number {
  if (axis.mode === 'time-grid' || axis.mode === 'number-grid') return axis.x0 + slot * axis.step;
  const i = Math.max(0, Math.min(axis.keptPoint.length - 1, slot));
  if (model.x === 'name') return i;
  const lo = Math.floor(i);
  const hi = Math.min(axis.keptPoint.length - 1, lo + 1);
  const a = model.points[axis.keptPoint[lo] ?? 0]?.x ?? 0;
  const b = model.points[axis.keptPoint[hi] ?? 0]?.x ?? a;
  return a + (b - a) * (i - lo);
}

/** The (fractional) slot at a model x. */
export function slotAtX(axis: Axis, model: ChartModel, x: number): number {
  if (axis.mode === 'time-grid' || axis.mode === 'number-grid') return (x - axis.x0) / axis.step;
  if (model.x === 'name') return x;
  const xs = axis.keptPoint.map((p) => model.points[p]?.x ?? 0);
  if (xs.length === 0) return 0;
  if (x <= (xs[0] ?? 0)) return 0;
  for (let i = 1; i < xs.length; i += 1) {
    const b = xs[i] ?? 0;
    if (x <= b) {
      const a = xs[i - 1] ?? 0;
      return i - 1 + (b > a ? (x - a) / (b - a) : 0);
    }
  }
  return xs.length - 1;
}

/** The kept index nearest a slot, by binary search; -1 when there is none. */
export function nearestKept(axis: Axis, slot: number): number {
  const kept = axis.kept;
  if (kept.length === 0) return -1;
  let lo = 0;
  let hi = kept.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((kept[mid] ?? 0) < slot) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs((kept[lo - 1] ?? 0) - slot) <= Math.abs((kept[lo] ?? 0) - slot)) return lo - 1;
  return lo;
}

export type DrawKind = 'line' | 'area' | 'columns' | 'candles' | 'ohlc' | 'volume';

export interface PlotSeries {
  readonly key: string;
  readonly name: string;
  readonly draw: DrawKind;
  /** index into theme.series; -1 for volume */
  readonly colour: number;
  readonly format: NumberFormat;
  /** per model point; the values as shown (indexed to 100 when asked) */
  readonly values: readonly (number | null)[];
  /** candles and bars: the four prices per point */
  readonly ohlc: readonly (readonly [number, number, number, number] | null)[] | null;
  /** per model point, whether the close was at or above the open (to tint volume) */
  readonly up: readonly boolean[] | null;
}

export interface Plot {
  readonly axis: Axis;
  readonly series: readonly PlotSeries[];
  /** the final range of the value scale: pinned from the first frame */
  readonly range: { readonly lo: number; readonly hi: number };
  readonly log: boolean;
  /** columns drawn grouped (two or more series) */
  readonly grouped: boolean;
}

const INDEXED: NumberFormat = { prefix: '', suffix: '', decimals: 1, short: false };
/** an index written as whole numbers (the base year 100, the others as the data gave them) stays whole; anything else gets a decimal */
const indexedFormat = (values: readonly (number | null)[]): NumberFormat => (values.every((v) => v === null || Math.abs(v - Math.round(v)) < 1e-9) ? { ...INDEXED, decimals: 0 } : INDEXED);

function show(series: ChartSeries, indexed: boolean): (number | null)[] {
  if (!indexed) return [...series.values];
  const first = series.values.find((v): v is number => v !== null && v !== 0);
  return first === undefined ? [...series.values] : series.values.map((v) => (v === null ? null : (v / first) * 100));
}

export function plotOf(state: ChartState): Plot {
  const { model, words } = state;
  const kind = model.draw;
  const indexed = words.includes('indexed');
  const pricey = kind === 'candles' || kind === 'ohlc';
  const price = pricey && model.candles;
  const drawKind: DrawKind = pricey ? (price ? kind : 'line') : kind;
  const axis = axisOf(model, drawKind === 'line' || drawKind === 'area', drawKind === 'columns');
  const series: PlotSeries[] = [];
  const roleOf = (role: string): ChartSeries | undefined => model.series.find((s) => s.role === role);
  if (price) {
    const [o, h, l, c] = [roleOf('open'), roleOf('high'), roleOf('low'), roleOf('close')];
    const scale = indexed ? (c?.values.find((v): v is number => v !== null && v !== 0) ?? 100) / 100 : 1;
    const ohlc = model.points.map((_, i) => {
      const four = [o?.values[i], h?.values[i], l?.values[i], c?.values[i]];
      return four.every((v) => typeof v === 'number') ? (four.map((v) => (v as number) / scale) as [number, number, number, number]) : null;
    });
    series.push({ key: 'price', name: '', draw: drawKind, colour: 0, format: indexed ? indexedFormat(ohlc.map((q) => q?.[3] ?? null)) : (c?.format ?? INDEXED), values: ohlc.map((q) => q?.[3] ?? null), ohlc, up: null });
    const volume = roleOf('volume');
    if (volume !== undefined) series.push({ key: 'volume', name: 'volume', draw: 'volume', colour: -1, format: volume.format, values: [...volume.values], ohlc: null, up: ohlc.map((q) => q === null || q[3] >= q[0]) });
  } else {
    // rows that carry four prices but are drawn as a line (too few for candles) show the close alone
    const plain = model.series.filter((s) => (model.candles ? s.role === 'close' : s.role !== 'volume'));
    plain.forEach((s, colour) => {
      series.push({ key: `s${colour}`, name: s.name, draw: drawKind === 'candles' || drawKind === 'ohlc' ? 'line' : drawKind, colour, format: indexed ? indexedFormat(show(s, indexed)) : s.format, values: show(s, indexed), ohlc: null, up: null });
    });
    const volume = roleOf('volume');
    if (volume !== undefined && plain.length > 0) series.push({ key: 'volume', name: 'volume', draw: 'volume', colour: -1, format: volume.format, values: [...volume.values], ohlc: null, up: null });
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    if (s.key === 'volume') continue;
    if (s.ohlc !== null) {
      for (const q of s.ohlc) {
        if (q === null) continue;
        lo = Math.min(lo, q[2], q[0], q[3]);
        hi = Math.max(hi, q[1], q[0], q[3]);
      }
    } else {
      for (const v of s.values) {
        if (v === null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
  const log = words.includes('log') && lo > 0;
  const columns = series.some((s) => s.draw === 'columns');
  if (columns) [lo, hi] = [Math.min(lo, 0), Math.max(hi, 0)];
  const span = hi - lo || Math.abs(hi) * 0.2 || 1;
  if (log) {
    lo /= 1.04;
    hi *= 1.04;
  } else {
    if (!(columns && lo >= 0)) lo -= span * 0.04;
    if (!(columns && hi <= 0)) hi += span * 0.04;
  }
  return { axis, series, range: { lo, hi }, log, grouped: series.filter((s) => s.draw === 'columns').length > 1 };
}

/** What of the final data is drawn: for a line, slots up to a point; for the rest, whole bars and a part of one. */
export interface Drawn {
  /** points that have landed */
  readonly landed: number;
  /** a line is drawn to this slot (inclusive); -1 for none */
  readonly toSlot: number;
  /** bars: how many are whole, and how far the next has risen, 0..1 */
  readonly whole: number;
  readonly part: number;
}

export function drawnOf(plot: Plot, landedPoints: number, reveal: number): Drawn {
  const axis = plot.axis;
  const landed = Math.max(0, Math.min(axis.kept.length, landedPoints));
  const r = Math.max(0, Math.min(1, reveal));
  if (landed === 0) return { landed, toSlot: -1, whole: 0, part: 0 };
  const last = axis.kept[landed - 1] ?? 0;
  const first = axis.kept[0] ?? 0;
  const toSlot = r >= 1 ? last : first + Math.floor(r * (last - first));
  const bars = r * landed;
  const whole = Math.min(landed, Math.floor(bars));
  return { landed, toSlot, whole, part: whole >= landed ? 0 : bars - whole };
}

/** The value of a series along a line at a slot, interpolated between the points either side. Null outside the points. `cursor` makes a walk along the slots linear. */
export function lineAt(axis: Axis, values: readonly (number | null)[], slot: number, cursor: { i: number }): number | null {
  const k = axis.kept;
  while (cursor.i < k.length - 1 && (k[cursor.i + 1] ?? 0) <= slot) cursor.i += 1;
  const a = k[cursor.i];
  const va = values[axis.keptPoint[cursor.i] ?? 0];
  if (a === undefined || va === null || va === undefined || slot < a) return null;
  if (slot === a) return va;
  let j = cursor.i + 1;
  while (j < k.length && (values[axis.keptPoint[j] ?? 0] ?? null) === null) j += 1;
  if (j >= k.length) return null;
  const b = k[j] ?? a;
  const vb = values[axis.keptPoint[j] ?? 0] ?? va;
  return va + ((vb - va) * (slot - a)) / (b - a);
}

/** How finely a moment was written, from the points: tells the crosshair what to say. */
export function grain(model: ChartModel): 'year' | 'month' | 'day' | 'minute' {
  if (model.x !== 'time') return 'day';
  let g: 'year' | 'month' | 'day' | 'minute' = 'year';
  for (const p of model.points) {
    const d = new Date(p.x * 1000);
    if (d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0) return 'minute';
    if (d.getUTCDate() !== 1) g = 'day';
    else if (d.getUTCMonth() !== 0 && g === 'year') g = 'month';
  }
  return g;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A moment as the crosshair says it. */
export function whenLabel(seconds: number, g: ReturnType<typeof grain>): string {
  const d = new Date(seconds * 1000);
  const year = d.getUTCFullYear();
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (g === 'year') return `${year}`;
  if (g === 'month') return `${MONTH[d.getUTCMonth()]} ${year}`;
  if (g === 'day') return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${year}`;
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${time}`;
}

/** A tick on the time axis: years, then months, then days, then times, from what the library says the tick is (0 year, 1 month, 2 day, 3 and 4 time). */
export function tickWhen(seconds: number, type: number, spanDays: number): string {
  const d = new Date(seconds * 1000);
  if (type === 0) return `${d.getUTCFullYear()}`;
  if (type === 1) return spanDays < 800 ? (MONTH[d.getUTCMonth()] ?? '') : `${MONTH[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  if (type === 2) return spanDays < 400 ? `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}` : `${d.getUTCDate()}`;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}${type === 4 ? `:${String(d.getUTCSeconds()).padStart(2, '0')}` : ''}`;
}

/** How round a number is: higher for 1000 than for 500 than for 200 than for 100. Gives the library's tick picking its preference on a numeric axis. */
export function roundness(value: number): number {
  const v = Math.abs(value);
  if (v === 0) return 60;
  let weight = 50;
  for (let e = 8; e >= -6; e -= 1) {
    for (const m of [1, 0.5, 0.2]) {
      const q = v / (m * 10 ** e);
      if (Math.abs(q - Math.round(q)) < 1e-7 * Math.max(1, q)) return weight;
      weight -= 1;
    }
  }
  return 0;
}

/** Writes numbers up the side: the data's own style, enough decimals that neighbouring ticks differ, no trailing zeros on a short form. */
export function tickLabels(prices: readonly number[], format: NumberFormat): string[] {
  const sorted = [...prices].sort((a, b) => a - b);
  let smallest = Infinity;
  for (let i = 1; i < sorted.length; i += 1) smallest = Math.min(smallest, (sorted[i] ?? 0) - (sorted[i - 1] ?? 0));
  const big = sorted.some((p) => Math.abs(p) >= 1e6) || format.short;
  const needed = Number.isFinite(smallest) && smallest > 0 && !big ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(smallest) - 1e-9))) : 0;
  const f: NumberFormat = { ...format, decimals: Math.max(format.decimals, needed) };
  return prices.map((p) => {
    const text = formatNumber(p, f);
    return big ? text.replace(/\.(\d*?)0+(?=[kMBT%]|$)/, (_m, d: string) => (d === '' ? '' : `.${d}`)) : text;
  });
}
