// The charting engine: TradingView's `lightweight-charts` behind `ChartEngine`. This is the ONLY file that imports it.
//
// What the library does by itself (and this file leaves to it): the price scale and its ticks, the crosshair, pan,
// zoom, touch, the volume pane, candles and bars. What this file adds, because the library does not:
//   - TO SCALE time and number axes, NAMES along the bottom, and the REVEAL: decided in `plot.ts` and fed in as data;
//   - the header (title, legend, credit, readout: `header.ts`), marks, the empty and failed states and the frame of a
//     machine look's panel (`overlay.ts`): one pane primitive, drawn on the chart's own canvas, so that `still()` carries
//     them and a film frame of a chart is a pure function of its state;
//   - grouped columns for two or more series (the library's histogram overlaps them).
// All colour, size and face come from `ChartTheme`. Nothing is fetched. The ground is the stage's own (transparent)
// except in the looks that are machines, where the chart is a framed panel.

import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createChartEx,
  customSeriesDefaultOptions,
  defaultHorzScaleBehavior,
} from 'lightweight-charts';
import type {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  CustomSeriesWhitespaceData,
  DeepPartial,
  IChartApi,
  IChartApiBase,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  InternalHorzScaleItem,
  IPanePrimitive,
  IPrimitivePaneRenderer,
  IPriceScaleApi,
  ChartOptionsImpl,
  Logical,
  Mutable,
  MouseEventParams,
  PaneRendererCustomData,
  PriceFormatCustom,
  PriceToCoordinateConverter,
  TickMark,
  TickMarkWeightValue,
  Time,
  TimeScalePoint,
  UTCTimestamp,
} from 'lightweight-charts';
import { formatNumber, readNumber } from '@conduit/language';
import type { ChartKind, NumberFormat } from '@conduit/language';
import type { ChartEngine, ChartHandle, ChartProbe, ChartState, ChartTheme } from '../../contracts/chart';
import { familyOf, fontOf, headerOf, measure, NO_HEADER } from './header';
import { LEAST_LABEL_PX } from './theme';
import type { Header, LegendItem, Readout } from './header';
import { paintOverlay } from './overlay';
import type { Geometry, Scene } from './overlay';
import { drawnOf, grain, lineAt, nearestKept, plotOf, roundness, slotAtX, tickLabels, tickWhen, whenLabel, xAtSlot } from './plot';
import type { Drawn, Plot, PlotSeries } from './plot';
import { rgba } from './tint';

const KINDS: readonly ChartKind[] = ['line', 'area', 'columns', 'candles', 'ohlc'];

/** The text the library's licence asks the app to show, and where it links. The text is NOTICE.txt. The chart carries its own credit line (`header.ts`); this is what the app's About shows while a chart is on stage. */
const ATTRIBUTION = { text: 'Charts by TradingView Lightweight Charts™, Copyright © 2025 TradingView, Inc.', href: 'https://www.tradingview.com/' } as const;

type Chart = IChartApiBase<Time>;
type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Action = { readonly hover: number } | { readonly zoom: number } | { readonly pan: number } | { readonly reset: true };

/** Below this the chart is a spark: no header, no axes, no crosshair. A picture too small to read a label on is a line. */
const SPARK_WIDTH = 200;
const SPARK_HEIGHT = 100;

const at = (n: number): UTCTimestamp => n as UTCTimestamp;
const logical = (n: number): Logical => n as Logical;
const seconds = (time: Time): number => (typeof time === 'number' ? time : 0);
const nextFrame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

// ---- the bottom axis for numbers and names: one whole slot a step ------------------------------------------------

interface SlotLabels {
  /** the weight of a tick at a slot: rounder numbers are chosen first */
  weight(slot: number, previous: number | null): number;
  /** the label of a tick, and of the crosshair, at a slot */
  tick(slot: number): string;
  cross(slot: number): string;
}

/**
 * The library keeps a time as an object whose one key holds the seconds. The key's name differs between its builds (the production
 * build renames it), so the number is read by what it is: the object's one numeric value.
 */
function slotOf(item: InternalHorzScaleItem): number {
  if (typeof item !== 'object' || item === null) return 0;
  for (const value of Object.values(item as Record<string, unknown>)) if (typeof value === 'number') return value;
  return 0;
}

const TimeBehaviour = defaultHorzScaleBehavior();

/** The library's own time scale, with the weights and labels of this module: the items are whole slot numbers. */
class SlotScale extends TimeBehaviour {
  labels: SlotLabels = { weight: () => 1, tick: () => '', cross: () => '' };
  readonly seen = new Map<number, string>();
  /** told the words of the crosshair's tag on the bottom axis whenever one is made (the probe reports them) */
  onTag: (label: string) => void = () => undefined;
  override formatHorzItem(item: InternalHorzScaleItem): string {
    const label = this.labels.cross(slotOf(item));
    this.onTag(label);
    return label;
  }
  override formatTickmark(mark: TickMark): string {
    const slot = slotOf(mark.time);
    const label = this.labels.tick(slot);
    this.seen.set(slot, label);
    return label;
  }
  override fillWeightsForPoints(points: readonly Mutable<TimeScalePoint>[], start: number): void {
    for (let i = start; i < points.length; i += 1) {
      const point = points[i];
      if (point === undefined) continue;
      const before = points[i - 1];
      point.timeWeight = this.labels.weight(slotOf(point.time), before === undefined ? null : slotOf(before.time)) as TickMarkWeightValue;
    }
  }
  override shouldResetTickmarkLabels(): boolean {
    return true;
  }
}

// ---- grouped columns ------------------------------------------------------------------------------------------------

interface GroupedData extends CustomData<Time> {
  readonly values: readonly number[];
  /** one series, one row marked with stars: that bar in this colour */
  readonly colour?: string;
}
interface GroupedOptions extends CustomSeriesOptions {
  colours: readonly string[];
}

class GroupedView implements ICustomSeriesPaneView<Time, GroupedData, GroupedOptions> {
  private data: PaneRendererCustomData<Time, GroupedData> | null = null;
  private opts: GroupedOptions | null = null;
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: Target, converter: PriceToCoordinateConverter): void => {
        target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          const data = this.data;
          const opts = this.opts;
          if (data === null || opts === null || data.visibleRange === null) return;
          const zero = converter(0);
          if (zero === null) return;
          for (let i = data.visibleRange.from; i <= data.visibleRange.to; i += 1) {
            const bar = data.bars[i];
            if (bar === undefined) continue;
            const values = bar.originalData.values;
            const group = Math.max(2, data.barSpacing * 0.7);
            const each = group / Math.max(1, values.length);
            values.forEach((value, index) => {
              const y = converter(value);
              if (y === null) return;
              context.fillStyle = (values.length === 1 ? bar.originalData.colour : undefined) ?? opts.colours[index % opts.colours.length] ?? '#888';
              const left = bar.x - group / 2 + index * each;
              const top = Math.min(y, zero);
              context.fillRect(Math.round(left * hr), Math.round(top * vr), Math.max(1, Math.round((each - Math.min(1.5, each * 0.12)) * hr)), Math.max(1, Math.round(Math.abs(zero - y) * vr)));
            });
          }
        });
      },
    };
  }
  update(data: PaneRendererCustomData<Time, GroupedData>, options: GroupedOptions): void {
    this.data = data;
    this.opts = options;
  }
  priceValueBuilder(row: GroupedData): CustomSeriesPricePlotValues {
    const values = row.values;
    return [Math.min(0, ...values), Math.max(0, ...values), values[values.length - 1] ?? 0];
  }
  isWhitespace(data: GroupedData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
    return !('values' in data);
  }
  defaultOptions(): GroupedOptions {
    return { ...customSeriesDefaultOptions, colours: [] };
  }
}

// ---- one series on the chart -------------------------------------------------------------------------------------------

/** What a slot holds for a series: nothing (the series is not there yet), or the numbers the kind draws. */
interface Cell {
  readonly time: number;
  readonly blank: boolean;
  readonly value?: number;
  readonly colour?: string;
  readonly four?: readonly [number, number, number, number];
  readonly values?: readonly number[];
}

/** A series made on the chart, behind what this file does to it: put its cells, ask a price's place, set how it writes numbers. */
interface Layer {
  readonly ps: PlotSeries;
  put(cells: readonly Cell[]): void;
  toY(price: number): number | null;
  hover(price: number, time: number): void;
  scale(): IPriceScaleApi;
  write(format: PriceFormatCustom): void;
  remove(): void;
}

const QUIET = { lastValueVisible: false, priceLineVisible: false } as const;

// ---- the handle ---------------------------------------------------------------------------------------------------------

interface Slotter {
  /** library item at a slot (padded slots are negative or past the end) */
  time(slot: number): number;
}

const PAD_BARS = 1;
/** The label size is at most the chart's height over this. */
export const LABELS_PER_HEIGHT = 8;

/** What a test (and the battery) can ask of a mounted chart beyond its probe: the numbers behind the chart rules. */
export interface ChartMeasure {
  /** the size the labels and ticks are set at, and the title's, CSS pixels */
  readonly labelPx: number;
  readonly titlePx: number;
  /** the share of the chart's box that is plot: below the header, above the time axis, left of the price axis, volume pane left out */
  readonly plotFraction: number;
  /** the price axis: each tick's value and what is written for it */
  readonly yTicks: readonly { readonly price: number; readonly label: string }[];
  readonly headerHeight: number;
  /** one of 'spark', 'full' */
  readonly form: 'spark' | 'full';
  /** the chart is a framed panel (a machine's look) and not on the stage's own ground */
  readonly framed: boolean;
  readonly width: number;
  readonly height: number;
}

const measures = new WeakMap<HTMLElement, () => ChartMeasure | null>();

/** What a mounted chart measures: null for a handle this engine did not make, or one not drawn yet. */
export function measureChart(handle: ChartHandle): ChartMeasure | null {
  return measures.get(handle.element)?.() ?? null;
}

const legendOf = (plot: Plot, theme: ChartTheme): LegendItem[] => {
  const named = plot.series.filter((s) => s.name !== '' && s.draw !== 'volume');
  return named.length < 2 ? [] : named.map((s) => ({ colour: theme.series[s.colour % theme.series.length] ?? theme.accent, text: s.name, style: theme.hard ? s.colour : 0 }));
};

class LightweightHandle implements ChartHandle {
  readonly element: HTMLDivElement;
  private chart: Chart | null = null;
  private timeChart: IChartApi | null = null;
  private chartMode: 'time' | 'slot' | null = null;
  private slotScale: SlotScale | null = null;
  /** the words of the tag the crosshair last put on the bottom axis (fb-005: on a slot-scaled chart it once read "1970" over "2005") */
  private tagSeen: string | null = null;
  private state: ChartState | null = null;
  private plot: Plot | null = null;
  private lastModel: unknown = null;
  private lastSignature = '';
  private structure = '';
  private optionsKey = '';
  private drawnKey = '';
  private size = { width: 0, height: 0 };
  private layers: Layer[] = [];
  private pad = 0;
  private time: Slotter = { time: (slot) => slot };
  private readout: Readout | null = null;
  private listeners = new Set<() => void>();
  private programmatic = 0;
  private overlay: Overlay | null = null;
  private yTicks: { price: number; label: string }[] = [];
  private xSeen = new Map<number, string>();
  private spanDays = 0;
  private realTimes: [number, number] | null = null;
  private grainOf: ReturnType<typeof grain> = 'day';
  private header: Header = NO_HEADER;
  /** the width of the pane the header is drawn in (the chart less its price axis), known once the library has laid out */
  private paneWidth = 0;
  private relaying = false;
  private maxTickChars = 8;
  /** what is written under each kept point on a name axis */
  private tickWords: readonly string[] = [];
  private pulse = 0;
  private disposed = false;
  /** the picture last taken and what it was a picture of: the same state is not drawn twice (P2-39) */
  private version = 0;
  private source: ChartState | null = null;
  private fitted: ChartState | null = null;
  private fittedFor = '';
  private picture: { readonly version: number; readonly canvas: HTMLCanvasElement } | null = null;

  constructor(host: HTMLElement) {
    this.element = document.createElement('div');
    this.element.style.cssText = 'position:absolute;left:0;top:0;overflow:hidden;touch-action:pan-y;';
    host.appendChild(this.element);
    measures.set(this.element, () => this.measured());
  }

  /** The state with its text no larger than the room can carry: labels at the stage's `xs` where they fit, and at a sixteenth of the chart's height where that would let the words eat the plot (a poster face at a desk). */
  private fit(input: ChartState, width: number, height: number): ChartState {
    const key = `${width}x${height}`;
    if (input === this.source && key === this.fittedFor && this.fitted !== null) return this.fitted;
    const px = Math.min(input.theme.fontPx, Math.max(LEAST_LABEL_PX, Math.floor(height / LABELS_PER_HEIGHT)));
    const fitted = px === input.theme.fontPx ? input : { ...input, theme: { ...input.theme, fontPx: px } };
    this.source = input;
    this.fittedFor = key;
    this.fitted = fitted;
    return fitted;
  }

  apply(input: ChartState, size: { readonly width: number; readonly height: number; readonly dpr: number }): void {
    if (this.disposed) return;
    const width = Math.max(40, Math.floor(size.width));
    const height = Math.max(40, Math.floor(size.height));
    const state = this.fit(input, width, height);
    const previous = this.state;
    if (previous !== state) this.version += 1;
    this.state = state;
    let rebuilt = false;
    if (state.model !== this.lastModel || previous === null || previous.kind !== state.kind || previous.words.join() !== state.words.join()) {
      const signature = `${state.model.draw}|${state.words.join()}|${modelSignature(state)}`;
      if (signature !== this.lastSignature || this.plot === null) {
        this.plot = plotOf(state);
        this.lastSignature = signature;
        this.grainOf = grain(state.model);
        const pts = state.model.points;
        this.spanDays = pts.length > 1 ? Math.abs((pts[pts.length - 1]?.x ?? 0) - (pts[0]?.x ?? 0)) / 86400 : 0;
        this.realTimes = this.plot.axis.mode === 'time-real' ? [state.model.points[this.plot.axis.keptPoint[0] ?? 0]?.x ?? 0, state.model.points[this.plot.axis.keptPoint[this.plot.axis.keptPoint.length - 1] ?? 0]?.x ?? 0] : null;
        rebuilt = true;
      }
      this.lastModel = state.model;
    }
    const plot = this.plot;
    if (plot === null) return;
    const mode: 'time' | 'slot' = plot.axis.mode === 'time-real' ? 'time' : 'slot';
    if (this.chart === null || this.chartMode !== mode) {
      this.makeChart(mode, width, height);
      rebuilt = true;
    }
    const chart = this.chart;
    if (chart === null) return;
    if (width !== this.size.width || height !== this.size.height) {
      this.size = { width, height };
      this.element.style.width = `${width}px`;
      this.element.style.height = `${height}px`;
      chart.resize(width, height, true);
      this.version += 1;
    }

    const structure = `${plot.series.map((s) => `${s.key}:${s.draw}:${s.colour}`).join()}|${plot.grouped}|${plot.axis.mode}|${plot.axis.count}|${plot.log}`;
    const optionsKey = `${themeKey(state.theme)}|${state.words.join()}|${state.interactive}|${width}x${height}|${state.waiting}|${state.failed}|${state.title}|${plot.series.length}|${this.lastSignature}|${state.marks.length}`;
    let fullRange = rebuilt;
    if (structure !== this.structure) {
      this.buildSeries(chart, plot, state);
      this.structure = structure;
      this.drawnKey = '';
      this.optionsKey = '';
      fullRange = true;
    }
    if (optionsKey !== this.optionsKey) {
      this.optionsKey = optionsKey;
      this.applyOptions(chart, plot, state, width, height);
    }
    const drawn = drawnOf(plot, state.landed, state.reveal);
    const key = `${drawn.landed}|${drawn.toSlot}|${drawn.whole}|${drawn.part.toFixed(4)}|${this.lastSignature}|${state.theme.accent}`;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      this.setData(plot, drawn, state);
      this.pulse = drawn.toSlot;
    }
    if (fullRange || !state.interactive) this.pin(chart, plot);
    this.overlay?.set(state);
    this.overlay?.requestUpdate();
  }

  // -- construction

  private makeChart(mode: 'time' | 'slot', width: number, height: number): void {
    this.chart?.remove();
    this.layers = [];
    this.structure = '';
    this.optionsKey = '';
    this.drawnKey = '';
    this.size = { width, height };
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    const base = { width, height, autoSize: false } as const;
    if (mode === 'time') {
      const made = createChart(this.element, base);
      this.chart = made;
      this.timeChart = made;
      this.slotScale = null;
    } else {
      const scale = new SlotScale();
      scale.onTag = (label) => (this.tagSeen = label);
      this.chart = createChartEx<Time, SlotScale>(this.element, scale, base);
      this.timeChart = null;
      this.slotScale = scale;
    }
    this.chartMode = mode;
    const chart = this.chart;
    chart.subscribeCrosshairMove((param) => this.onCrosshair(param));
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      this.version += 1;
      if (this.programmatic !== 0) return;
      const plot = this.plot;
      if (plot !== null && range !== null) {
        const last = plot.axis.count + this.pad * 2 - 1;
        const wide = Math.min(last, range.to - range.from);
        const from = Math.max(0, Math.min(last - wide, range.from));
        if (Math.abs(from - range.from) > 1e-6 || Math.abs(from + wide - range.to) > 1e-6) {
          this.programmatic += 1;
          try {
            chart.timeScale().setVisibleLogicalRange({ from: logical(from), to: logical(from + wide) });
          } finally {
            this.programmatic -= 1;
          }
        }
      }
      this.notify();
    });
    this.overlay = new Overlay(() => this.scene());
    chart.panes()[0]?.attachPrimitive(this.overlay);
  }

  private buildSeries(chart: Chart, plot: Plot, state: ChartState): void {
    for (const layer of this.layers) layer.remove();
    this.layers = [];
    const theme = state.theme;
    const volume = plot.series.find((s) => s.draw === 'volume');
    const columns = plot.series.filter((s) => s.draw === 'columns');
    let groupedMade = false;
    for (const ps of plot.series) {
      const colour = ps.colour >= 0 ? (theme.series[ps.colour % theme.series.length] ?? theme.accent) : theme.crosshair;
      const fixed = {
        autoscaleInfoProvider: () => ({ priceRange: { minValue: this.plot?.range.lo ?? 0, maxValue: this.plot?.range.hi ?? 1 } }),
      };
      const dash = theme.hard && ps.colour > 0 ? [LineStyle.Dashed, LineStyle.Dotted, LineStyle.LargeDashed, LineStyle.SparseDotted][(ps.colour - 1) % 4] : LineStyle.Solid;
      let layer: Layer;
      switch (ps.draw) {
        case 'line': {
          const api = chart.addSeries(LineSeries, { color: colour, lineWidth: 2, lineStyle: dash, ...QUIET, crosshairMarkerRadius: 4, crosshairMarkerBackgroundColor: colour, crosshairMarkerBorderColor: theme.ground, ...fixed }, 0);
          layer = {
            ps,
            put: (cells) => api.setData(cells.map((c) => (c.blank || c.value === undefined ? { time: at(c.time) } : { time: at(c.time), value: c.value }))),
            toY: (price) => numberOrNull(api.priceToCoordinate(price)),
            hover: (price, time) => chart.setCrosshairPosition(price, at(time), api),
            scale: () => api.priceScale(),
            write: (priceFormat) => api.applyOptions({ priceFormat }),
            remove: () => chart.removeSeries(api),
          };
          break;
        }
        case 'area': {
          const api = chart.addSeries(AreaSeries, { lineColor: colour, topColor: rgba(colour, theme.hard ? 0.2 : 0.3), bottomColor: rgba(colour, 0), lineWidth: 2, lineStyle: dash, ...QUIET, crosshairMarkerRadius: 4, ...fixed }, 0);
          layer = {
            ps,
            put: (cells) => api.setData(cells.map((c) => (c.blank || c.value === undefined ? { time: at(c.time) } : { time: at(c.time), value: c.value }))),
            toY: (price) => numberOrNull(api.priceToCoordinate(price)),
            hover: (price, time) => chart.setCrosshairPosition(price, at(time), api),
            scale: () => api.priceScale(),
            write: (priceFormat) => api.applyOptions({ priceFormat }),
            remove: () => chart.removeSeries(api),
          };
          break;
        }
        case 'columns': {
          if (plot.grouped) {
            if (groupedMade) continue;
            groupedMade = true;
            const api = chart.addCustomSeries(new GroupedView(), { colours: columns.map((c) => theme.series[c.colour % theme.series.length] ?? theme.accent), ...QUIET, ...fixed }, 0);
            layer = {
              ps,
              put: (cells) => api.setData(cells.map((c) => (c.blank || c.values === undefined ? { time: at(c.time) } : { time: at(c.time), values: c.values, ...(c.colour === undefined ? {} : { colour: c.colour }) }))),
              toY: (price) => numberOrNull(api.priceToCoordinate(price)),
              hover: (price, time) => chart.setCrosshairPosition(price, at(time), api),
              scale: () => api.priceScale(),
              write: (priceFormat) => api.applyOptions({ priceFormat }),
              remove: () => chart.removeSeries(api),
            };
          } else {
            const api = chart.addSeries(HistogramSeries, { color: colour, base: 0, ...QUIET, ...fixed }, 0);
            layer = {
              ps,
              put: (cells) => api.setData(cells.map((c) => (c.blank || c.value === undefined ? { time: at(c.time) } : { time: at(c.time), value: c.value, ...(c.colour === undefined ? {} : { color: c.colour }) }))),
              toY: (price) => numberOrNull(api.priceToCoordinate(price)),
              hover: (price, time) => chart.setCrosshairPosition(price, at(time), api),
              scale: () => api.priceScale(),
              write: (priceFormat) => api.applyOptions({ priceFormat }),
              remove: () => chart.removeSeries(api),
            };
          }
          break;
        }
        case 'candles': {
          const api = chart.addSeries(CandlestickSeries, { upColor: theme.ground, downColor: theme.down, borderUpColor: theme.up, borderDownColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down, borderVisible: true, ...QUIET, ...fixed }, 0);
          layer = {
            ps,
            put: (cells) => api.setData(cells.map((c) => (c.blank || c.four === undefined ? { time: at(c.time) } : { time: at(c.time), open: c.four[0], high: c.four[1], low: c.four[2], close: c.four[3] }))),
            toY: (price) => numberOrNull(api.priceToCoordinate(price)),
            hover: (price, time) => chart.setCrosshairPosition(price, at(time), api),
            scale: () => api.priceScale(),
            write: (priceFormat) => api.applyOptions({ priceFormat }),
            remove: () => chart.removeSeries(api),
          };
          break;
        }
        case 'ohlc': {
          const api = chart.addSeries(BarSeries, { upColor: theme.up, downColor: theme.down, thinBars: false, openVisible: true, ...QUIET, ...fixed }, 0);
          layer = {
            ps,
            put: (cells) => api.setData(cells.map((c) => (c.blank || c.four === undefined ? { time: at(c.time) } : { time: at(c.time), open: c.four[0], high: c.four[1], low: c.four[2], close: c.four[3] }))),
            toY: (price) => numberOrNull(api.priceToCoordinate(price)),
            hover: (price, time) => chart.setCrosshairPosition(price, at(time), api),
            scale: () => api.priceScale(),
            write: (priceFormat) => api.applyOptions({ priceFormat }),
            remove: () => chart.removeSeries(api),
          };
          break;
        }
        case 'volume': {
          const api = chart.addSeries(HistogramSeries, { color: rgba(theme.crosshair, 0.55), ...QUIET }, 1);
          layer = {
            ps,
            put: (cells) => api.setData(cells.map((c) => (c.blank || c.value === undefined ? { time: at(c.time) } : { time: at(c.time), value: c.value, ...(c.colour === undefined ? {} : { color: c.colour }) }))),
            toY: (price) => numberOrNull(api.priceToCoordinate(price)),
            hover: (price, time) => chart.setCrosshairPosition(price, at(time), api),
            scale: () => api.priceScale(),
            write: (priceFormat) => api.applyOptions({ priceFormat }),
            remove: () => chart.removeSeries(api),
          };
          break;
        }
      }
      this.layers.push(layer);
    }
    const panes = chart.panes();
    if (volume !== undefined && panes.length > 1) {
      panes[0]?.setStretchFactor(4);
      panes[1]?.setStretchFactor(1);
    }
    this.pad = plot.series.some((s) => s.draw === 'line' || s.draw === 'area') ? Math.max(2, Math.ceil(plot.axis.count * 0.06)) : PAD_BARS;
    this.time = timeScaleOf(plot, state, this.pad);
    this.attachLabels(plot, state);
  }

  private attachLabels(plot: Plot, state: ChartState): void {
    const model = state.model;
    const scale = this.slotScale;
    const axis = plot.axis;
    // The words under the bars: as written; where they do not fit side by side, their first word if that tells the bars apart ("Q1" for "Q1 Dec"); else every nth.
    const tickFont = fontOf(state.theme, state.theme.fontPx);
    const written0 = axis.keptPoint.map((p) => model.points[p]?.label ?? '');
    // the pane is the chart's width less the price scale's, which is not yet known here; its room is split over the bars and the pad on either side
    const pane = this.size.width - measure(tickFont, '000.0') - 24;
    const pitch = Math.max(1, pane / Math.max(1, written0.length + 2 * this.pad));
    const widest = (words: readonly string[]): number => Math.max(1, ...words.map((word) => measure(tickFont, word))) + 10;
    const heads = written0.map((word) => word.trim().split(/\s+/)[0] ?? word);
    const useFirst = axis.mode === 'index' && widest(written0) > pitch * 0.9 && new Set(heads).size === heads.length && widest(heads) < widest(written0);
    this.tickWords = useFirst ? heads : written0;
    const perChar = ((state.theme.fontPx + 4) * 5) / 8;
    // The library keeps tick words apart by assuming a width per character; the words are measured here, so the room it keeps is the room they take.
    this.maxTickChars = axis.mode === 'index' ? Math.max(2, Math.ceil((widest(this.tickWords) - 10) / perChar)) : 8;
    if (scale === null) return;
    const first = model.points[0]?.label ?? '';
    const read = readNumber(first);
    const decimals = read?.decimals ?? 0;
    const format: NumberFormat = { prefix: read?.prefix ?? '', suffix: read?.suffix ?? '', decimals, short: read?.short ?? false };
    const timeOf = (item: number): number => axis.x0 + (item - this.pad) * axis.step;
    const written = (v: number): string => {
      const rounded = Number(v.toPrecision(10));
      const own = Math.min(4, (String(rounded).split('.')[1] ?? '').length);
      return formatNumber(v, { ...format, decimals: Math.max(format.decimals, own) });
    };
    const inside = (item: number): boolean => item - this.pad >= 0 && item - this.pad < axis.count;
    const barsOnly = plot.series.every((s) => s.draw === 'columns' || s.draw === 'volume') && axis.kept.length <= 40;
    if (barsOnly && axis.mode !== 'index') {
      // columns to scale: a tick under each bar, in the words the row was written with
      const under = new Map<number, string>();
      axis.kept.forEach((slot, j) => under.set(slot + this.pad, model.points[axis.keptPoint[j] ?? 0]?.label ?? ''));
      scale.labels = { weight: (item) => (under.has(item) ? 10 : 0), tick: (item) => under.get(item) ?? '', cross: (item) => (axis.mode === 'time-grid' ? this.timeLabel(timeOf(item)) : written(timeOf(item))) };
      return;
    }
    if (axis.mode === 'time-grid') {
      // A tick goes on the first slot after a boundary of the calendar: a year, then a month, a day, an hour. Which
      // boundary decides its weight and what it says, so years are chosen before months and a round year before a plain one.
      const said = new Map<number, string>();
      // With few points (twelve or fewer) the ticks stand under the points: a year that holds none is not a place on the axis, and the last point always has its tick (fb-038)
      const held = axis.kept.length <= 12 ? new Map(axis.kept.map((slot, j) => [slot + this.pad, model.points[axis.keptPoint[j] ?? 0]?.label ?? ''] as const)) : null;
      const lastHeld = held === null ? -1 : Math.max(...held.keys());
      scale.labels = {
        weight: (item, previous) => {
          if (!inside(item)) return 0;
          if (held !== null) {
            if (!held.has(item)) return 0;
            if (!said.has(item)) said.set(item, held.get(item) ?? '');
          }
          const t = new Date(timeOf(item) * 1000);
          const p = new Date((previous === null ? timeOf(item) - axis.step : timeOf(previous)) * 1000);
          let type = -1;
          let weight = 0;
          if (t.getUTCFullYear() !== p.getUTCFullYear()) [type, weight] = [0, 100 + roundness(t.getUTCFullYear())];
          else if (t.getUTCMonth() !== p.getUTCMonth() && this.spanDays <= 800) [type, weight] = [1, 60 + (t.getUTCMonth() % 3 === 0 ? 4 : 0)];
          else if (t.getUTCDate() !== p.getUTCDate() && this.spanDays <= 45) [type, weight] = [2, 40 + (t.getUTCDate() === 1 || t.getUTCDate() === 15 ? 4 : 0)];
          else if (t.getUTCHours() !== p.getUTCHours() && this.spanDays <= 6) [type, weight] = [3, 20 + (t.getUTCHours() % 6 === 0 ? 4 : 0)];
          else if (t.getUTCMinutes() !== p.getUTCMinutes() && this.spanDays <= 0.5) [type, weight] = [3, 10];
          if (type >= 0) said.set(item, tickWhen(timeOf(item), type, this.spanDays));
          if (held !== null) return item === lastHeld ? Math.max(weight, 1000) : Math.max(weight, 1);
          return weight;
        },
        tick: (item) => said.get(item) ?? '',
        cross: (item) => this.timeLabel(timeOf(item)),
      };
      return;
    }
    // Names (and columns on uneven times): a tick under every bar while the words fit, else every nth, never one that is not a bar.
    const labels = axis.keptPoint.map((p) => model.points[p]?.label ?? '');
    const said = axis.mode === 'index' ? this.tickWords : labels;
    // a word under every bar while the longest of them, as set, fits in a bar's width; else under every nth
    const room = Math.max(60, pane - 2 * pitch);
    const wide = Math.max(1, ...said.map((label) => measure(fontOf(state.theme, state.theme.fontPx), label))) + 10;
    const each = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(room / wide))));
    scale.labels = {
      weight: (item) => {
        if (!inside(item)) return 0;
        if (axis.mode === 'number-grid') return roundness(axis.x0 + (item - this.pad) * axis.step);
        return (item - this.pad) % each === 0 ? 10 : 0;
      },
      tick: (item) => {
        if (!inside(item)) return '';
        if (axis.mode === 'index') return (item - this.pad) % each === 0 ? (said[item - this.pad] ?? '') : '';
        return written(timeOf(item));
      },
      cross: (item) => {
        const slot = item - this.pad;
        if (axis.mode === 'index') return labels[Math.max(0, Math.min(axis.count - 1, slot))] ?? '';
        return written(axis.x0 + slot * axis.step);
      },
    };
  }

  private applyOptions(chart: Chart, plot: Plot, state: ChartState, width: number, height: number): void {
    const theme = state.theme;
    const spark = state.words.includes('spark') || width < SPARK_WIDTH || height < SPARK_HEIGHT;
    const empty = state.waiting || state.failed || plot.series.length === 0;
    this.header = spark ? NO_HEADER : headerOf({ theme, width: this.paneWidth > 0 ? this.paneWidth : width - 60, title: state.title, approx: state.words.includes('approx'), legend: legendOf(plot, theme) });
    const hasVolume = plot.series.some((s) => s.draw === 'volume');
    const axisH = theme.fontPx + 14;
    const paneH = Math.max(60, (height - axisH) * (hasVolume ? 0.8 : 1));
    // events write their words in a row under the header, over the top of the plot: that room is kept clear of data
    const eventRows = spark ? 0 : Math.min(2, state.marks.filter((m) => m.x !== null && m.y === null).length);
    const clear = this.header.height + (eventRows === 0 ? 0 : eventRows * (theme.fontPx + 4) + 4);
    const top = spark ? 0.1 : Math.min(0.55, clear / paneH);
    const interactive = state.interactive && !spark;
    const column = plot.series.some((s) => s.draw === 'columns');
    const framed = theme.hard;
    const options: DeepPartial<ChartOptionsImpl<Time>> = {
      width,
      height,
      layout: {
        background: { type: ColorType.Solid, color: framed ? theme.ground : rgba(theme.ground, 0) },
        textColor: theme.ink,
        fontFamily: familyOf(theme),
        fontSize: theme.fontPx,
        attributionLogo: false,
        panes: { separatorColor: theme.grid, separatorHoverColor: theme.grid, enableResize: false },
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: !spark, color: theme.grid } },
      crosshair: {
        mode: interactive ? CrosshairMode.Magnet : CrosshairMode.Hidden,
        vertLine: { color: theme.crosshair, width: 1, style: LineStyle.Solid, labelVisible: !spark, labelBackgroundColor: theme.ink },
        horzLine: { color: theme.crosshair, width: 1, style: LineStyle.Solid, labelVisible: !spark, labelBackgroundColor: theme.ink },
      },
      rightPriceScale: {
        visible: !spark,
        borderVisible: false,
        mode: plot.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        scaleMargins: { top, bottom: column ? 0.02 : 0.04 },
        textColor: empty ? rgba(theme.ink, 0) : theme.ink,
        entireTextOnly: true,
      },
      leftPriceScale: { visible: false },
      timeScale: {
        visible: !spark,
        borderVisible: false,
        ticksVisible: false,
        timeVisible: this.grainOf === 'minute',
        secondsVisible: false,
        rightOffset: 0,
        lockVisibleTimeRangeOnResize: true,
        minBarSpacing: 0.02,
        tickMarkMaxCharacterLength: this.maxTickChars,
      },
      localization: {
        // On a slot-scaled chart (names, numbers, an evenly spaced time grid) the library hands over the slot number, not a time: it is read by the scale that knows the slots,
        // not as seconds after 1970 (fb-005)
        timeFormatter: (time: Time) => {
          const said = this.slotScale !== null ? this.slotScale.labels.cross(seconds(time)) : this.timeLabel(seconds(time));
          this.tagSeen = said;
          return said;
        },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: interactive, horzTouchDrag: interactive, vertTouchDrag: false },
      handleScale: { mouseWheel: interactive, pinch: interactive, axisPressedMouseMove: interactive, axisDoubleClickReset: interactive },
      kineticScroll: { mouse: false, touch: false },
    };
    chart.applyOptions(options);
    this.timeChart?.applyOptions({
      timeScale: {
        tickMarkFormatter: (time: Time, type: number) => {
          const stamp = seconds(time);
          const real = this.realTimes;
          if (real !== null && (stamp < real[0] || stamp > real[1])) return '';
          const label = tickWhen(stamp, type, this.spanDays);
          this.xSeen.set(stamp, label);
          return label;
        },
      },
    });
    // the volume pane's scale: a few ticks, in dim
    const volumeLayer = this.layers.find((l) => l.ps.draw === 'volume');
    volumeLayer?.scale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0 }, borderVisible: false, textColor: theme.crosshair });
    for (const layer of this.layers) {
      const f = layer.ps.format;
      const volume = layer.ps.draw === 'volume';
      layer.write({
        type: 'custom',
        formatter: (v: number) => formatNumber(v, f),
        tickmarksFormatter: (prices: readonly number[]) => {
          const labels = tickLabels(prices, f);
          if (!volume) this.yTicks = prices.map((price, i) => ({ price, label: labels[i] ?? '' }));
          return labels;
        },
        minMove: Math.max(1e-6, 10 ** -(f.decimals + 2)),
      });
    }
    this.version += 1;
  }

  private timeLabel(time: number): string {
    const state = this.state;
    const plot = this.plot;
    if (state === null || plot === null) return '';
    const axis = plot.axis;
    const model = state.model;
    if (axis.mode === 'time-real') {
      const i = this.exactIndexByTime(time);
      return i >= 0 ? (model.points[axis.keptPoint[i] ?? 0]?.label ?? whenLabel(time, this.grainOf)) : whenLabel(time, this.grainOf);
    }
    const slot = (time - axis.x0) / axis.step;
    const k = nearestKept(axis, slot);
    if (k >= 0 && Math.abs((axis.kept[k] ?? -9) - slot) < 0.51) return model.points[axis.keptPoint[k] ?? 0]?.label ?? whenLabel(time, this.grainOf);
    return whenLabel(time, this.grainOf);
  }

  private exactIndexByTime(time: number): number {
    const plot = this.plot;
    const state = this.state;
    if (plot === null || state === null) return -1;
    return plot.axis.keptPoint.findIndex((p) => state.model.points[p]?.x === time);
  }

  private setData(plot: Plot, drawn: Drawn, state: ChartState): void {
    const axis = plot.axis;
    const pad = this.pad;
    const theme = state.theme;
    const model = state.model;
    const cursors = new Map<string, { i: number }>();
    const groupedSeries = plot.series.filter((s) => s.draw === 'columns');
    const blank = (slot: number): Cell => ({ time: this.time.time(slot), blank: true });
    for (const layer of this.layers) {
      const ps = layer.ps;
      const cells: Cell[] = [];
      if (ps.draw === 'line' || ps.draw === 'area') {
        const cursor = cursors.get(ps.key) ?? { i: 0 };
        cursors.set(ps.key, cursor);
        for (let slot = -pad; slot < axis.count + pad; slot += 1) {
          const v = slot >= 0 && slot < axis.count && slot <= drawn.toSlot ? lineAt(axis, ps.values, slot, cursor) : null;
          cells.push(v === null ? blank(slot) : { time: this.time.time(slot), blank: false, value: v });
        }
      } else {
        const place = new Map<number, number>();
        axis.kept.forEach((slot, j) => place.set(slot, j));
        for (let slot = -pad; slot < axis.count + pad; slot += 1) {
          const j = place.get(slot);
          if (j === undefined || j > drawn.whole || j >= drawn.landed || (j === drawn.whole && drawn.part <= 0)) {
            cells.push(blank(slot));
            continue;
          }
          const grow = j === drawn.whole ? drawn.part : 1;
          const p = axis.keptPoint[j] ?? 0;
          const time = this.time.time(slot);
          if (ps.draw === 'columns' && plot.grouped) {
            cells.push({ time, blank: false, values: groupedSeries.map((g) => (g.values[p] ?? 0) * grow), ...(groupedSeries.length === 1 && model.points[p]?.starred === true ? { colour: theme.accent } : {}) });
          } else if (ps.draw === 'columns') {
            const v = ps.values[p];
            cells.push(v === null || v === undefined ? blank(slot) : { time, blank: false, value: v * grow, ...(model.points[p]?.starred === true ? { colour: theme.accent } : {}) });
          } else if (ps.draw === 'volume') {
            const v = ps.values[p];
            cells.push(v === null || v === undefined ? blank(slot) : { time, blank: false, value: v * grow, colour: rgba(ps.up?.[p] === false ? theme.down : theme.up, 0.4) });
          } else {
            const q = ps.ohlc?.[p];
            if (q === null || q === undefined) cells.push(blank(slot));
            else {
              const [o, h, l, c] = q;
              cells.push({ time, blank: false, four: [o, o + (h - o) * grow, o + (l - o) * grow, o + (c - o) * grow] });
            }
          }
        }
      }
      layer.put(cells);
    }
    this.version += 1;
  }

  /** Shows all of the data's width (and the pad), the user's pan and zoom put back to start. */
  private pin(chart: Chart, plot: Plot): void {
    this.programmatic += 1;
    try {
      chart.timeScale().setVisibleLogicalRange({ from: logical(0), to: logical(plot.axis.count + this.pad * 2 - 1) });
    } finally {
      this.programmatic -= 1;
    }
  }

  // -- the crosshair

  private onCrosshair(param: MouseEventParams<Time>): void {
    const where = param.logical;
    if (param.point === undefined || where === undefined || param.time === undefined) {
      this.setReadout(null);
    } else {
      this.setReadout(this.readoutAt(Number(where) - this.pad));
    }
    if (this.programmatic === 0) this.notify();
  }

  private setReadout(readout: Readout | null): void {
    this.readout = readout;
    this.overlay?.requestUpdate();
  }

  private readoutAt(slot: number): Readout | null {
    const plot = this.plot;
    const state = this.state;
    if (plot === null || state === null) return null;
    const axis = plot.axis;
    const k = nearestKept(axis, slot);
    if (k < 0) return null;
    const drawn = drawnOf(plot, state.landed, state.reveal);
    if (k >= drawn.landed) return null;
    const p = axis.keptPoint[k] ?? 0;
    const items: { colour: string | null; text: string }[] = [];
    for (const s of plot.series) {
      if (s.ohlc !== null) {
        const q = s.ohlc[p];
        if (q === null || q === undefined) continue;
        for (const [name, v] of [['O', q[0]], ['H', q[1]], ['L', q[2]], ['C', q[3]]] as const) items.push({ colour: null, text: `${name} ${formatNumber(v, s.format)}` });
      } else {
        const v = s.values[p];
        if (v === null || v === undefined) continue;
        const colour = s.colour >= 0 ? (state.theme.series[s.colour % state.theme.series.length] ?? null) : null;
        items.push({ colour: s.draw === 'volume' ? null : colour, text: `${s.name === '' ? '' : `${s.name} `}${formatNumber(v, s.format)}` });
      }
    }
    return { point: p, label: state.model.points[p]?.label ?? '', items };
  }

  // -- the picture the overlay draws

  private scene(): Scene | null {
    const state = this.state;
    const plot = this.plot;
    const chart = this.chart;
    if (state === null || plot === null || chart === null) return null;
    const pad = this.pad;
    const scale = chart.timeScale();
    const paneWidth = chart.paneSize(0).width;
    if (Math.abs(paneWidth - this.paneWidth) > 1 && !this.relaying && paneWidth > 0) {
      // the header was laid out for a guess of the pane's width; now it is known, lay it out again
      this.paneWidth = paneWidth;
      this.relaying = true;
      queueMicrotask(() => {
        this.relaying = false;
        const again = this.plot;
        const now = this.state;
        const c = this.chart;
        if (again !== null && now !== null && c !== null && !this.disposed) this.applyOptions(c, again, now, this.size.width, this.size.height);
      });
    }
    const main = this.layers.find((l) => l.ps.draw !== 'volume') ?? null;
    const geometry: Geometry = {
      xOf: (x) => {
        // the library answers for whole logical indices only, so a fraction is laid between its neighbours
        const place = slotAtX(plot.axis, state.model, x) + pad;
        const lo = Math.floor(place);
        const a = scale.logicalToCoordinate(logical(lo));
        const b = scale.logicalToCoordinate(logical(lo + 1));
        return a === null || b === null ? null : Number(a) + (Number(b) - Number(a)) * (place - lo);
      },
      slotX: (slot) => numberOrNull(scale.logicalToCoordinate(logical(slot + pad))),
      yOf: (price) => main?.toY(price) ?? null,
    };
    return {
      state,
      plot,
      drawn: drawnOf(plot, state.landed, state.reveal),
      header: this.header,
      readout: this.readout,
      geometry,
      axisBottom: chart.paneSize(0).height,
      hasScale: main !== null,
      now: performance.now(),
    };
  }

  // -- the rest of the port

  still(withCrosshair = false): HTMLCanvasElement | null {
    const chart = this.chart;
    if (chart === null || this.state === null) return null;
    if (withCrosshair) return chart.takeScreenshot(true, true);
    // the same state is not drawn twice: a picture is kept until something it shows has changed
    if (this.picture !== null && this.picture.version === this.version) return this.picture.canvas;
    const canvas = chart.takeScreenshot(true, false);
    this.picture = { version: this.version, canvas };
    return canvas;
  }

  private measured(): ChartMeasure | null {
    const state = this.state;
    const chart = this.chart;
    const plot = this.plot;
    if (state === null || chart === null || plot === null) return null;
    const { width, height } = this.size;
    const pane = chart.paneSize(0);
    const axisW = chart.priceScale('right').width();
    const spark = this.header.height === 0;
    const hasVolume = plot.series.some((s) => s.draw === 'volume');
    // the volume pane is the plot's too: it is data. What is not plot: the header, the time axis, the price axis.
    const body = Math.max(0, pane.height - this.header.height) + (hasVolume ? Math.max(0, height - pane.height - (state.theme.fontPx + 14)) : 0);
    return {
      labelPx: state.theme.fontPx,
      titlePx: this.header.titlePx,
      plotFraction: width <= 0 || height <= 0 ? 0 : (Math.max(0, width - axisW) * body) / (width * height),
      yTicks: [...this.yTicks],
      headerHeight: this.header.height,
      form: spark ? 'spark' : 'full',
      framed: state.theme.hard,
      width,
      height,
    };
  }

  probe(): ChartProbe {
    const plot = this.plot;
    const state = this.state;
    const chart = this.chart;
    if (plot === null || state === null || chart === null) {
      return { from: 0, to: 0, crosshair: null, points: 0, ticks: { x: [], y: [] }, type: { label: 0, title: 0, credit: 0, small: 0 }, frameMs: { median: 0, worst: 0 } };
    }
    const range = chart.timeScale().getVisibleLogicalRange();
    const slotFrom = range === null ? 0 : Math.max(0, range.from - this.pad);
    const slotTo = range === null ? plot.axis.count - 1 : Math.min(plot.axis.count - 1, range.to - this.pad);
    const model = state.model;
    const xs: string[] = [];
    if (this.slotScale !== null) {
      const seen = [...this.slotScale.seen.entries()].filter(([item, label]) => label !== '' && item - this.pad >= slotFrom - 1e-6 && item - this.pad <= slotTo + 1e-6).sort((a, b) => a[0] - b[0]);
      for (const [, label] of seen) xs.push(label);
    } else {
      const lo = this.time.time(Math.ceil(slotFrom));
      const hi = this.time.time(Math.floor(slotTo));
      const seen = [...this.xSeen.entries()].filter(([t, label]) => label !== '' && t >= lo && t <= hi).sort((a, b) => a[0] - b[0]);
      for (const [, label] of seen) xs.push(label);
    }
    const drawn = drawnOf(plot, state.landed, state.reveal);
    const r = this.readout;
    const frame = this.overlay?.frameMs() ?? { median: 0, worst: 0 };
    return {
      from: xAtSlot(plot.axis, model, slotFrom),
      to: xAtSlot(plot.axis, model, slotTo),
      crosshair: r === null ? null : { label: r.label, values: r.items.map((i) => i.text), axis: this.tagSeen },
      points: Math.min(drawn.landed, plot.axis.kept.length),
      ticks: { x: xs, y: this.yTicks.map((t) => t.label) },
      type: { label: state.theme.fontPx, title: this.header.titlePx, credit: this.header.creditPx, small: (this.source ?? state).theme.fontPx },
      frameMs: frame,
    };
  }

  async act(action: Action): Promise<ChartProbe> {
    const chart = this.chart;
    const plot = this.plot;
    const state = this.state;
    if (chart === null || plot === null || state === null) return this.probe();
    const axis = plot.axis;
    const scale = chart.timeScale();
    this.programmatic += 1;
    try {
      if ('hover' in action) {
        const slot = Math.max(0, Math.min(axis.count - 1, Math.round(slotAtX(axis, state.model, action.hover))));
        const main = this.layers.find((l) => l.ps.draw !== 'volume');
        if (main !== undefined) {
          const k = nearestKept(axis, slot);
          const p = k < 0 ? 0 : (axis.keptPoint[k] ?? 0);
          main.hover(main.ps.values[p] ?? plot.range.lo, this.time.time(slot));
        }
        this.setReadout(this.readoutAt(slot));
      } else if ('zoom' in action) {
        const range = scale.getVisibleLogicalRange();
        if (range !== null && action.zoom > 0) {
          const mid = (range.from + range.to) / 2;
          const half = Math.max(1, (range.to - range.from) / 2 / action.zoom);
          scale.setVisibleLogicalRange({ from: logical(mid - half), to: logical(mid + half) });
        }
      } else if ('pan' in action) {
        const range = scale.getVisibleLogicalRange();
        if (range !== null) {
          const shift = (range.to - range.from) * action.pan;
          scale.setVisibleLogicalRange({ from: logical(range.from + shift), to: logical(range.to + shift) });
        }
      } else {
        chart.clearCrosshairPosition();
        this.setReadout(null);
        this.pin(chart, plot);
      }
    } finally {
      await nextFrame();
      this.programmatic -= 1;
    }
    return this.probe();
  }

  onInteract(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** the slot the live pulse is at; for the overlay */
  pulseSlot(): number {
    return this.pulse;
  }

  dispose(): void {
    this.disposed = true;
    this.overlay?.stop();
    this.chart?.remove();
    this.chart = null;
    this.timeChart = null;
    this.picture = null;
    this.element.remove();
    this.listeners.clear();
    measures.delete(this.element);
  }
}

function numberOrNull(coordinate: number | null): number | null {
  return coordinate === null ? null : Number(coordinate);
}

function modelSignature(state: ChartState): string {
  const total = (m: ChartState['model']): number => {
    let sum = 0;
    for (const s of m.series) for (const v of s.values) sum += v ?? 0;
    return sum;
  };
  const m = state.model;
  const last = m.points[m.points.length - 1];
  // (the models the scale also holds are part of what the plot is)
  return `${m.points.length}|${m.series.length}|${total(m).toPrecision(12)}|${last?.label ?? ''}|${m.x}|${m.layout}|${(state.reach ?? []).map((other) => total(other).toPrecision(12)).join(',')}`;
}

function themeKey(t: ChartTheme): string {
  return [t.ground, t.ink, t.grid, t.crosshair, t.series.join(), t.up, t.down, t.accent, t.fontFamily, t.fontPx, t.hard].join('|');
}

/** The item the library is given for each slot, padded at both ends so that bars at the edge are whole. */
function timeScaleOf(plot: Plot, state: ChartState, pad: number): Slotter {
  const axis = plot.axis;
  if (axis.mode === 'time-real') {
    const xs = axis.keptPoint.map((p) => state.model.points[p]?.x ?? 0);
    const dt = xs.length > 1 ? Math.max(1, Math.round(((xs[xs.length - 1] ?? 0) - (xs[0] ?? 0)) / (xs.length - 1))) : 86400;
    return {
      time: (slot) => {
        if (slot < 0) return Math.round((xs[0] ?? 0) + slot * dt);
        if (slot >= xs.length) return Math.round((xs[xs.length - 1] ?? 0) + (slot - xs.length + 1) * dt);
        return xs[slot] ?? 0;
      },
    };
  }
  // slot items are shifted by the pad so that every item is a whole number from 0
  return { time: (slot) => slot + pad };
}

// ---- the overlay: a pane primitive that hands what it draws to `overlay.ts` ------------------------------------------

class Overlay implements IPanePrimitive<Time> {
  private update: (() => void) | null = null;
  private stamps: number[] = [];
  private raf = 0;
  private readonly views = [
    {
      zOrder: () => 'top' as const,
      renderer: (): IPrimitivePaneRenderer => ({
        draw: (target: Target): void => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize.width, mediaSize.height)),
      }),
    },
  ];

  constructor(private readonly sceneOf: () => Scene | null) {}

  attached(param: { readonly requestUpdate: () => void }): void {
    this.update = param.requestUpdate;
  }
  detached(): void {
    this.update = null;
  }
  paneViews(): typeof this.views {
    return this.views;
  }
  updateAllViews(): void {}
  set(state: ChartState): void {
    const live = state.words.includes('live') && state.interactive && !state.reducedMotion;
    if (live && this.raf === 0) {
      const tick = (): void => {
        this.update?.();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    } else if (!live && this.raf !== 0) this.stop();
  }
  requestUpdate(): void {
    this.update?.();
  }
  stop(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  frameMs(): { median: number; worst: number } {
    const now = performance.now();
    const recent = this.stamps.filter((t) => now - t < 1000);
    const gaps: number[] = [];
    for (let i = 1; i < recent.length; i += 1) {
      const gap = (recent[i] ?? 0) - (recent[i - 1] ?? 0);
      if (gap < 250) gaps.push(gap);
    }
    if (gaps.length === 0) return { median: 0, worst: 0 };
    gaps.sort((a, b) => a - b);
    return { median: gaps[Math.floor(gaps.length / 2)] ?? 0, worst: gaps[gaps.length - 1] ?? 0 };
  }

  private paint(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const now = performance.now();
    this.stamps.push(now);
    if (this.stamps.length > 400) this.stamps.splice(0, this.stamps.length - 300);
    const scene = this.sceneOf();
    if (scene === null) return;
    paintOverlay(ctx, width, height, scene, scene.state.theme.hard);
  }
}

export function createLightweightEngine(): ChartEngine {
  return {
    id: 'lightweight-charts',
    kinds: KINDS,
    mount: (host) => new LightweightHandle(host),
    attribution: ATTRIBUTION,
  };
}
