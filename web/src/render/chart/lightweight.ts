// The charting engine: TradingView's `lightweight-charts` behind `ChartEngine`. This is the ONLY file that imports it.
//
// What the library does by itself (and this file leaves to it): the price scale and its ticks, the crosshair, pan,
// zoom, touch, the volume pane, candles and bars, the attribution mark. What this file adds, because the library
// does not:
//   - TO SCALE time and number axes, NAMES along the bottom, and the REVEAL: decided in `plot.ts` and fed in as data;
//   - the title, the legend, marks (events, levels, points), the empty and failed states: one pane primitive, drawn
//     on the chart's own canvas, so that `still()` carries them and a film frame of a chart is a pure function of
//     its state;
//   - grouped columns for two or more series (the library's histogram overlaps them).
// All colour, size and face come from `ChartTheme`. Nothing is fetched.

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
} from 'lightweight-charts';
import type {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesWhitespaceData,
  DeepPartial,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  IChartApiBase,
  IHorzScaleBehavior,
  IPanePrimitive,
  ISeriesApi,
  MouseEventParams,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { formatNumber, readNumber } from '@conduit/language';
import type { ChartKind, NumberFormat } from '@conduit/language';
import type { ChartEngine, ChartHandle, ChartMark, ChartProbe, ChartState, ChartTheme } from '../../contracts/chart';
import { parse } from '../../looks/colour-math';
import { drawnOf, grain, lineAt, nearestKept, plotOf, roundness, slotAtX, tickLabels, tickWhen, whenLabel, xAtSlot } from './plot';
import type { Drawn, Plot, PlotSeries } from './plot';

const KINDS: readonly ChartKind[] = ['line', 'area', 'columns', 'candles', 'ohlc'];

/** The text the library's licence asks the app to show, and where it links. The text is NOTICE.txt. */
const ATTRIBUTION = { text: 'Charts by TradingView Lightweight Charts™, Copyright © 2025 TradingView, Inc.', href: 'https://www.tradingview.com/' } as const;

/** The library's chart type is generic in what runs along the bottom; this file uses two (seconds, and whole slots). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chart = IChartApiBase<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = ISeriesApi<SeriesType, any>;

type Target = Parameters<ICustomSeriesPaneRenderer['draw']>[0];

type Action = { readonly hover: number } | { readonly zoom: number } | { readonly pan: number } | { readonly reset: true };

const rgba = (colour: string, alpha: number): string => {
  const [r, g, b] = parse(colour);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
};

const nextFrame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

// ---- the bottom axis for numbers and names: one whole slot a step ------------------------------------------------

interface SlotLabels {
  /** the weight of a tick at a slot: rounder numbers are chosen first */
  weight(slot: number, previous: number | null): number;
  /** the label of a tick, and of the crosshair, at a slot */
  tick(slot: number): string;
  cross(slot: number): string;
}

/** An `IHorzScaleBehavior` whose items are slot numbers. The library's own price-axis behaviour is not exported; this is the same shape with this module's weights and labels. */
class SlotScale {
  private opts: unknown = {};
  labels: SlotLabels = { weight: () => 1, tick: () => '', cross: () => '' };
  seen = new Map<number, string>();
  options(): unknown {
    return this.opts;
  }
  setOptions(options: unknown): void {
    this.opts = options;
  }
  preprocessData(): void {}
  updateFormatter(): void {}
  createConverterToInternalObj(): (item: number) => number {
    return (item) => item;
  }
  key(item: number): number {
    return item;
  }
  cacheKey(item: number): number {
    return item;
  }
  convertHorzItemToInternal(item: number): number {
    return item;
  }
  formatHorzItem(item: number): string {
    return this.labels.cross(item);
  }
  formatTickmark(mark: { time: number }): string {
    const label = this.labels.tick(mark.time);
    this.seen.set(mark.time, label);
    return label;
  }
  maxTickMarkWeight(marks: readonly { weight: number }[]): number {
    return marks.reduce((most, mark) => Math.max(most, mark.weight), 0);
  }
  fillWeightsForPoints(points: { time: number; timeWeight: number }[], start: number): void {
    for (let i = start; i < points.length; i += 1) {
      const point = points[i];
      if (point !== undefined) point.timeWeight = this.labels.weight(point.time, i > 0 ? (points[i - 1]?.time ?? null) : null);
    }
  }
  shouldResetTickmarkLabels(): boolean {
    return true;
  }
}

// ---- grouped columns ------------------------------------------------------------------------------------------------

interface GroupedData extends CustomData<number> {
  readonly values: readonly number[];
}
interface GroupedOptions extends CustomSeriesOptions {
  colours: readonly string[];
}

class GroupedView implements ICustomSeriesPaneView<number, GroupedData, GroupedOptions> {
  private data: PaneRendererCustomData<number, GroupedData> | null = null;
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
            const group = Math.max(2, data.barSpacing * 0.78);
            const each = group / Math.max(1, values.length);
            values.forEach((value, index) => {
              const y = converter(value);
              if (y === null) return;
              context.fillStyle = opts.colours[index % opts.colours.length] ?? '#888';
              const left = bar.x - group / 2 + index * each;
              const top = Math.min(y, zero);
              context.fillRect(Math.round(left * hr), Math.round(top * vr), Math.max(1, Math.round((each - Math.min(1.5, each * 0.12)) * hr)), Math.max(1, Math.round(Math.abs(zero - y) * vr)));
            });
          }
        });
      },
    };
  }
  update(data: PaneRendererCustomData<number, GroupedData>, options: GroupedOptions): void {
    this.data = data;
    this.opts = options;
  }
  priceValueBuilder(row: GroupedData): number[] {
    const values = row.values;
    return [Math.min(0, ...values), Math.max(0, ...values), values[values.length - 1] ?? 0];
  }
  isWhitespace(data: GroupedData | CustomSeriesWhitespaceData<number>): data is CustomSeriesWhitespaceData<number> {
    return (data as Partial<GroupedData>).values === undefined;
  }
  defaultOptions(): GroupedOptions {
    return { colours: [], color: '#888', lastValueVisible: false, priceLineVisible: false } as unknown as GroupedOptions;
  }
}

// ---- the handle ---------------------------------------------------------------------------------------------------------

interface Readout {
  readonly point: number;
  readonly label: string;
  readonly items: readonly { readonly colour: string | null; readonly text: string }[];
}

interface Slotter {
  /** library item at a slot (padded slots are negative or past the end) */
  time(slot: number): number;
}

const PAD_BARS = 1;

class LightweightHandle implements ChartHandle {
  readonly element: HTMLDivElement;
  private chart: Chart | null = null;
  private chartMode: 'time' | 'slot' | null = null;
  private slotScale: SlotScale | null = null;
  private state: ChartState | null = null;
  private plot: Plot | null = null;
  private lastModel: unknown = null;
  private lastSignature = '';
  private structure = '';
  private optionsKey = '';
  private drawnKey = '';
  private size = { width: 0, height: 0 };
  private apis: { readonly ps: PlotSeries; readonly api: Api }[] = [];
  private pad = 0;
  private time: Slotter = { time: (slot) => slot };
  private readout: Readout | null = null;
  private listeners = new Set<() => void>();
  private programmatic = 0;
  private overlay: Overlay | null = null;
  private yTicks: string[] = [];
  private xSeen = new Map<number, string>();
  private spanDays = 0;
  private realTimes: [number, number] | null = null;
  private grainOf: ReturnType<typeof grain> = 'day';
  private topPx = 0;
  private pulse = 0;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.element = document.createElement('div');
    this.element.style.cssText = 'position:absolute;left:0;top:0;overflow:hidden;touch-action:pan-y;';
    host.appendChild(this.element);
  }

  apply(state: ChartState, size: { readonly width: number; readonly height: number; readonly dpr: number }): void {
    if (this.disposed) return;
    const width = Math.max(40, Math.floor(size.width));
    const height = Math.max(40, Math.floor(size.height));
    const previous = this.state;
    this.state = state;
    let rebuilt = false;
    if (state.model !== this.lastModel || previous === null || previous.kind !== state.kind || previous.words.join() !== state.words.join()) {
      const signature = `${state.kind}|${state.words.join()}|${modelSignature(state)}`;
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
    }

    const structure = `${plot.series.map((s) => `${s.key}:${s.draw}:${s.colour}`).join()}|${plot.grouped}|${plot.axis.mode}|${plot.axis.count}|${plot.log}`;
    const optionsKey = `${themeKey(state.theme)}|${state.words.join()}|${state.interactive}|${width}x${height}|${state.waiting}|${state.failed}|${state.title}|${plot.series.length}`;
    let fullRange = rebuilt;
    if (structure !== this.structure) {
      this.buildSeries(chart, plot, state);
      this.structure = structure;
      this.drawnKey = '';
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
    this.overlay?.set(state, plot, drawn);
    if (this.overlay !== null) this.overlay.requestUpdate();
  }

  // -- construction

  private makeChart(mode: 'time' | 'slot', width: number, height: number): void {
    this.chart?.remove();
    this.apis = [];
    this.structure = '';
    this.optionsKey = '';
    this.drawnKey = '';
    this.size = { width, height };
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    const base = { width, height, autoSize: false } as const;
    if (mode === 'time') {
      this.chart = createChart(this.element, base);
      this.slotScale = null;
    } else {
      this.slotScale = new SlotScale();
      this.chart = createChartEx(this.element, this.slotScale as unknown as IHorzScaleBehavior<number>, base as DeepPartial<unknown> as never);
    }
    this.chartMode = mode;
    const chart = this.chart;
    chart.subscribeCrosshairMove((param) => this.onCrosshair(param));
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (this.programmatic !== 0) return;
      const plot = this.plot;
      if (plot !== null && range !== null) {
        const last = plot.axis.count + this.pad * 2 - 1;
        const width = Math.min(last, range.to - range.from);
        const from = Math.max(0, Math.min(last - width, range.from));
        if (Math.abs(from - range.from) > 1e-6 || Math.abs(from + width - range.to) > 1e-6) {
          this.programmatic += 1;
          try {
            chart.timeScale().setVisibleLogicalRange({ from, to: from + width });
          } finally {
            this.programmatic -= 1;
          }
        }
      }
      this.notify();
    });
    this.overlay = new Overlay(this);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    chart.panes()[0]?.attachPrimitive(this.overlay as unknown as IPanePrimitive<any>);
  }

  private buildSeries(chart: Chart, plot: Plot, state: ChartState): void {
    for (const { api } of this.apis) chart.removeSeries(api);
    this.apis = [];
    const theme = state.theme;
    const volume = plot.series.find((s) => s.draw === 'volume');
    const upper = chart.panes()[0];
    void upper;
    const columns = plot.series.filter((s) => s.draw === 'columns');
    let groupedMade = false;
    for (const ps of plot.series) {
      const colour = ps.colour >= 0 ? (theme.series[ps.colour % theme.series.length] ?? theme.accent) : theme.crosshair;
      const fixed = (): { autoscaleInfoProvider: () => { priceRange: { minValue: number; maxValue: number } } } => ({
        autoscaleInfoProvider: () => ({ priceRange: { minValue: this.plot?.range.lo ?? 0, maxValue: this.plot?.range.hi ?? 1 } }),
      });
      const format = priceFormat(ps.format);
      const dash = theme.hard && ps.colour > 0 ? [LineStyle.Dashed, LineStyle.Dotted, LineStyle.LargeDashed, LineStyle.SparseDotted][(ps.colour - 1) % 4] : LineStyle.Solid;
      let api: Api;
      switch (ps.draw) {
        case 'line':
          api = chart.addSeries(LineSeries, { color: colour, lineWidth: 2, lineStyle: dash, priceFormat: format, lastValueVisible: false, priceLineVisible: false, crosshairMarkerRadius: 4, crosshairMarkerBackgroundColor: colour, crosshairMarkerBorderColor: theme.ground, ...fixed() }, 0) as unknown as Api;
          break;
        case 'area':
          api = chart.addSeries(AreaSeries, { lineColor: colour, topColor: rgba(colour, theme.hard ? 0.2 : 0.3), bottomColor: rgba(colour, 0), lineWidth: 2, lineStyle: dash, priceFormat: format, lastValueVisible: false, priceLineVisible: false, crosshairMarkerRadius: 4, ...fixed() }, 0) as unknown as Api;
          break;
        case 'columns':
          if (plot.grouped) {
            if (groupedMade) continue;
            groupedMade = true;
            api = chart.addCustomSeries(new GroupedView(), { colours: columns.map((c) => theme.series[c.colour % theme.series.length] ?? theme.accent), priceFormat: format, lastValueVisible: false, priceLineVisible: false, ...fixed() } as never, 0) as unknown as Api;
          } else {
            api = chart.addSeries(HistogramSeries, { color: colour, base: 0, priceFormat: format, lastValueVisible: false, priceLineVisible: false, ...fixed() }, 0) as unknown as Api;
          }
          break;
        case 'candles':
          api = chart.addSeries(CandlestickSeries, { upColor: theme.ground, downColor: theme.down, borderUpColor: theme.up, borderDownColor: theme.down, wickUpColor: theme.up, wickDownColor: theme.down, borderVisible: true, priceFormat: format, lastValueVisible: false, priceLineVisible: false, ...fixed() }, 0) as unknown as Api;
          break;
        case 'ohlc':
          api = chart.addSeries(BarSeries, { upColor: theme.up, downColor: theme.down, thinBars: false, openVisible: true, priceFormat: format, lastValueVisible: false, priceLineVisible: false, ...fixed() }, 0) as unknown as Api;
          break;
        case 'volume':
          api = chart.addSeries(HistogramSeries, { color: rgba(theme.crosshair, 0.55), priceFormat: format, lastValueVisible: false, priceLineVisible: false }, 1) as unknown as Api;
          break;
      }
      this.apis.push({ ps, api });
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
    if (scale === null) return;
    const axis = plot.axis;
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
      // columns: a tick under each bar, in the words the row was written with
      const at = new Map<number, string>();
      axis.kept.forEach((slot, j) => at.set(slot + this.pad, model.points[axis.keptPoint[j] ?? 0]?.label ?? ''));
      scale.labels = { weight: (item) => (at.has(item) ? 10 : 0), tick: (item) => at.get(item) ?? '', cross: (item) => (axis.mode === 'time-grid' ? this.timeLabel(timeOf(item)) : written(timeOf(item))) };
      return;
    }
    if (axis.mode === 'time-grid') {
      // A tick goes on the first slot after a boundary of the calendar: a year, then a month, a day, an hour. Which
      // boundary decides its weight and what it says, so years are chosen before months and a round year before a plain one.
      const said = new Map<number, string>();
      scale.labels = {
        weight: (item, previous) => {
          if (!inside(item)) return 0;
          const t = new Date(timeOf(item) * 1000);
          const p = new Date((previous === null ? timeOf(item) - axis.step : timeOf(previous)) * 1000);
          let type = -1;
          let weight = 0;
          if (t.getUTCFullYear() !== p.getUTCFullYear()) [type, weight] = [0, 100 + roundness(t.getUTCFullYear())];
          else if (t.getUTCMonth() !== p.getUTCMonth() && this.spanDays <= 800) [type, weight] = [1, 60 + (t.getUTCMonth() % 3 === 0 ? 4 : 0)];
          else if (t.getUTCDate() !== p.getUTCDate() && this.spanDays <= 90) [type, weight] = [2, 40 + (t.getUTCDate() === 1 || t.getUTCDate() === 15 ? 4 : 0)];
          else if (t.getUTCHours() !== p.getUTCHours() && this.spanDays <= 6) [type, weight] = [3, 20 + (t.getUTCHours() % 6 === 0 ? 4 : 0)];
          else if (t.getUTCMinutes() !== p.getUTCMinutes() && this.spanDays <= 0.5) [type, weight] = [3, 10];
          if (type >= 0) said.set(item, tickWhen(timeOf(item), type, this.spanDays));
          return weight;
        },
        tick: (item) => said.get(item) ?? '',
        cross: (item) => this.timeLabel(timeOf(item)),
      };
      return;
    }
    scale.labels = {
      weight: (item) => {
        if (!inside(item)) return 0;
        return axis.mode === 'number-grid' ? roundness(axis.x0 + (item - this.pad) * axis.step) : 10;
      },
      tick: (item) => {
        if (!inside(item)) return '';
        if (axis.mode === 'index') return model.points[axis.keptPoint[item - this.pad] ?? 0]?.label ?? '';
        return written(timeOf(item));
      },
      cross: (item) => {
        const slot = item - this.pad;
        if (axis.mode === 'index') return model.points[axis.keptPoint[Math.max(0, Math.min(axis.count - 1, slot))] ?? 0]?.label ?? '';
        return written(axis.x0 + slot * axis.step);
      },
    };
  }

  private applyOptions(chart: Chart, plot: Plot, state: ChartState, width: number, height: number): void {
    const theme = state.theme;
    const spark = state.words.includes('spark');
    const empty = state.waiting || state.failed || plot.series.length === 0;
    const rows = spark ? 0 : 2;
    const lineH = Math.round(theme.fontPx * 1.45);
    this.topPx = rows === 0 ? 0 : 8 + rows * lineH;
    const paneH = Math.max(60, (height - theme.fontPx - 14) * (plot.series.some((s) => s.draw === 'volume') ? 0.8 : 1));
    const top = spark ? 0.1 : Math.min(0.45, (this.topPx + 8) / paneH);
    const interactive = state.interactive && !spark;
    const column = plot.series.some((s) => s.draw === 'columns');
    chart.applyOptions({
      width,
      height,
      layout: {
        background: { type: ColorType.Solid, color: theme.ground },
        textColor: theme.ink,
        fontFamily: `${theme.fontFamily}, ui-sans-serif, system-ui, sans-serif`,
        fontSize: theme.fontPx,
        attributionLogo: true,
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
        tickMarkMaxCharacterLength: plot.axis.mode === 'index' ? 2 : 8,
        tickMarkFormatter: (time: Time, type: number) => {
          const real = this.realTimes;
          if (real !== null && (Number(time) < real[0] || Number(time) > real[1])) return '';
          const label = tickWhen(Number(time), type, this.spanDays);
          this.xSeen.set(Number(time), label);
          return label;
        },
      },
      localization: {
        timeFormatter: (time: Time) => this.timeLabel(Number(time)),
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: interactive, horzTouchDrag: interactive, vertTouchDrag: false },
      handleScale: { mouseWheel: interactive, pinch: interactive, axisPressedMouseMove: interactive, axisDoubleClickReset: interactive },
      kineticScroll: { mouse: false, touch: false },
    } as DeepPartial<unknown> as never);
    // the volume pane's scale: a few ticks, in dim
    const volumeApi = this.apis.find((a) => a.ps.draw === 'volume');
    if (volumeApi !== undefined) volumeApi.api.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0 }, borderVisible: false, textColor: theme.crosshair });
    for (const { ps, api } of this.apis) {
      const f = ps.format;
      api.applyOptions({
        priceFormat: {
          type: 'custom',
          formatter: (v: number) => formatNumber(v, f),
          tickmarksFormatter: (prices: readonly number[]) => {
            const labels = tickLabels(prices, f);
            if (ps.draw !== 'volume') this.yTicks = labels;
            return labels;
          },
          minMove: Math.max(1e-6, 10 ** -f.decimals),
        },
      } as never);
    }
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
    const emptyAt = (slot: number): { time: number } => ({ time: this.time.time(slot) });
    const cursors = new Map<string, { i: number }>();
    const groupedSeries = plot.series.filter((s) => s.draw === 'columns');
    for (const { ps, api } of this.apis) {
      const items: unknown[] = [];
      if (ps.draw === 'line' || ps.draw === 'area') {
        const cursor = cursors.get(ps.key) ?? { i: 0 };
        cursors.set(ps.key, cursor);
        for (let slot = -pad; slot < axis.count + pad; slot += 1) {
          const v = slot >= 0 && slot < axis.count && slot <= drawn.toSlot ? lineAt(axis, ps.values, slot, cursor) : null;
          items.push(v === null ? emptyAt(slot) : { time: this.time.time(slot), value: v });
        }
      } else {
        const at = new Map<number, number>();
        axis.kept.forEach((slot, j) => at.set(slot, j));
        for (let slot = -pad; slot < axis.count + pad; slot += 1) {
          const j = at.get(slot);
          if (j === undefined || j > drawn.whole || j >= drawn.landed || (j === drawn.whole && drawn.part <= 0)) {
            items.push(emptyAt(slot));
            continue;
          }
          const grow = j === drawn.whole ? drawn.part : 1;
          const p = axis.keptPoint[j] ?? 0;
          const time = this.time.time(slot);
          if (ps.draw === 'columns' && plot.grouped) {
            const values = groupedSeries.map((g) => (g.values[p] ?? 0) * grow);
            items.push({ time, values });
          } else if (ps.draw === 'columns') {
            const v = ps.values[p];
            if (v === null || v === undefined) items.push({ time });
            else items.push({ time, value: v * grow, color: model.points[p]?.starred === true ? theme.accent : undefined });
          } else if (ps.draw === 'volume') {
            const v = ps.values[p];
            if (v === null || v === undefined) items.push({ time });
            else items.push({ time, value: v * grow, color: rgba(ps.up?.[p] === false ? theme.down : theme.up, 0.4) });
          } else {
            const q = ps.ohlc?.[p];
            if (q === null || q === undefined) items.push({ time });
            else {
              const [o, h, l, c] = q;
              items.push({ time, open: o, high: o + (h - o) * grow, low: o + (l - o) * grow, close: o + (c - o) * grow });
            }
          }
        }
      }
      api.setData(items as never);
    }
  }

  /** Shows all of the data's width (and the pad), the user's pan and zoom put back to start. */
  private pin(chart: Chart, plot: Plot): void {
    this.programmatic += 1;
    try {
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: plot.axis.count + this.pad * 2 - 1 });
    } finally {
      this.programmatic -= 1;
    }
  }

  // -- the crosshair

  private onCrosshair(param: MouseEventParams<any>): void {
    const logical = param.logical;
    if (param.point === undefined || logical === undefined || param.time === undefined) {
      this.setReadout(null);
    } else {
      this.setReadout(this.readoutAt(Number(logical) - this.pad));
    }
    if (this.programmatic === 0) this.notify();
  }

  private setReadout(readout: Readout | null): void {
    this.readout = readout;
    this.overlay?.requestUpdate();
  }

  readoutOf(): Readout | null {
    return this.readout;
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

  // -- the rest of the port

  still(withCrosshair = false): HTMLCanvasElement | null {
    const chart = this.chart;
    if (chart === null || this.state === null) return null;
    return chart.takeScreenshot(true, withCrosshair);
  }

  probe(): ChartProbe {
    const plot = this.plot;
    const state = this.state;
    const chart = this.chart;
    if (plot === null || state === null || chart === null) {
      return { from: 0, to: 0, crosshair: null, points: 0, ticks: { x: [], y: [] }, frameMs: { median: 0, worst: 0 } };
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
      crosshair: r === null ? null : { label: r.label, values: r.items.map((i) => i.text) },
      points: Math.min(drawn.landed, drawn.part > 0 || drawn.whole > 0 || plot.axis.mode !== 'index' ? plot.axis.kept.length : 0) === 0 ? 0 : Math.min(drawn.landed, plot.axis.kept.length),
      ticks: { x: xs, y: [...this.yTicks] },
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
        const main = this.apis.find((a) => a.ps.draw !== 'volume');
        if (main !== undefined) {
          const k = nearestKept(axis, slot);
          const p = k < 0 ? 0 : (axis.keptPoint[k] ?? 0);
          const price = main.ps.values[p] ?? plot.range.lo;
          chart.setCrosshairPosition(price, this.time.time(slot) as never, main.api);
        }
        this.setReadout(this.readoutAt(slot));
      } else if ('zoom' in action) {
        const range = scale.getVisibleLogicalRange();
        if (range !== null && action.zoom > 0) {
          const mid = (range.from + range.to) / 2;
          const half = Math.max(1, (range.to - range.from) / 2 / action.zoom);
          scale.setVisibleLogicalRange({ from: mid - half, to: mid + half });
        }
      } else if ('pan' in action) {
        const range = scale.getVisibleLogicalRange();
        if (range !== null) {
          const shift = (range.to - range.from) * action.pan;
          scale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
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

  // -- for the overlay

  topRows(): number {
    return this.topPx;
  }
  padSlots(): number {
    return this.pad;
  }
  mainApi(): Api | null {
    return this.apis.find((a) => a.ps.draw !== 'volume')?.api ?? null;
  }
  chartApi(): Chart | null {
    return this.chart;
  }
  pulseSlot(): number {
    return this.pulse;
  }

  dispose(): void {
    this.disposed = true;
    this.overlay?.stop();
    this.chart?.remove();
    this.chart = null;
    this.element.remove();
    this.listeners.clear();
  }
}

function modelSignature(state: ChartState): string {
  const m = state.model;
  let sum = 0;
  for (const s of m.series) for (const v of s.values) sum += v ?? 0;
  const last = m.points[m.points.length - 1];
  return `${m.points.length}|${m.series.length}|${sum.toPrecision(12)}|${last?.label ?? ''}|${m.x}`;
}

function themeKey(t: ChartTheme): string {
  return [t.ground, t.ink, t.grid, t.crosshair, t.series.join(), t.up, t.down, t.accent, t.fontFamily, t.fontPx, t.hard].join('|');
}

function priceFormat(f: NumberFormat): { type: 'custom'; formatter: (v: number) => string; minMove: number } {
  return { type: 'custom', formatter: (v) => formatNumber(v, f), minMove: Math.max(1e-6, 10 ** -f.decimals) };
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

// ---- the overlay: title, legend, marks, empty and failed states -----------------------------------------------------

class Overlay {
  private state: ChartState | null = null;
  private plot: Plot | null = null;
  private drawn: Drawn | null = null;
  private update: (() => void) | null = null;
  private stamps: number[] = [];
  private raf = 0;
  private readonly views = [{ zOrder: () => 'top' as const, renderer: () => ({ draw: (target: Target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize.width, mediaSize.height)) }) }];

  constructor(private readonly handle: LightweightHandle) {}

  attached(param: { requestUpdate: () => void }): void {
    this.update = param.requestUpdate;
  }
  detached(): void {
    this.update = null;
  }
  paneViews(): typeof this.views {
    return this.views;
  }
  updateAllViews(): void {}
  set(state: ChartState, plot: Plot, drawn: Drawn): void {
    this.state = state;
    this.plot = plot;
    this.drawn = drawn;
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
    const state = this.state;
    const plot = this.plot;
    const chart = this.handle.chartApi();
    if (state === null || plot === null || chart === null) return;
    const theme = state.theme;
    const spark = state.words.includes('spark');
    const pad = this.handle.padSlots();
    const font = `${theme.fontPx}px ${theme.fontFamily}, ui-sans-serif, system-ui, sans-serif`;
    ctx.save();
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lineH = Math.round(theme.fontPx * 1.45);
    const left = 8;
    const right = width - 8;
    const plotTop = this.handle.topRows();
    const scale = chart.timeScale();
    const xOf = (x: number): number | null => {
      // the library answers for whole logical indices only, so a fraction is laid between its neighbours
      const logical = slotAtX(plot.axis, state.model, x) + pad;
      const lo = Math.floor(logical);
      const a = scale.logicalToCoordinate(lo as never);
      const b = scale.logicalToCoordinate((lo + 1) as never);
      return a === null || b === null ? null : Number(a) + (Number(b) - Number(a)) * (logical - lo);
    };
    const main = this.handle.mainApi();
    const yOf = (price: number): number | null => {
      const c = main?.priceToCoordinate(price) ?? null;
      return c === null ? null : Number(c);
    };

    // title, "approximate", and the legend row
    if (!spark) {
      let x = left;
      if (state.title !== '') {
        ctx.fillStyle = theme.ink;
        const text = fit(ctx, state.title, right - left - (state.words.includes('approx') ? 90 : 0));
        ctx.fillText(text, x, 6);
        x += ctx.measureText(text).width + 12;
      }
      if (state.words.includes('approx')) {
        ctx.fillStyle = theme.crosshair;
        ctx.fillText('approximate', x, 6);
      }
      const readout = this.handle.readoutOf();
      const y = 6 + lineH;
      let lx = left;
      if (readout !== null) {
        ctx.fillStyle = theme.ink;
        ctx.fillText(readout.label, lx, y);
        lx += ctx.measureText(readout.label).width + 14;
        for (const item of readout.items) {
          lx = legendItem(ctx, theme, item.colour, item.text, lx, y, right);
        }
      } else {
        const named = plot.series.filter((s) => s.name !== '' && s.draw !== 'volume');
        if (named.length >= 2) {
          for (const s of named) lx = legendItem(ctx, theme, theme.series[s.colour % theme.series.length] ?? theme.accent, s.name, lx, y, right, theme.hard ? s.colour : 0);
        }
      }
    }

    // the empty and failed states
    if (state.failed || state.waiting || plot.series.length === 0) {
      ctx.fillStyle = theme.crosshair;
      ctx.textBaseline = 'middle';
      ctx.fillText(state.failed ? 'the data could not be had' : 'waiting for the rows', left, plotTop + (height - plotTop) / 2);
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i += 1) {
        const gy = Math.round(plotTop + ((height - plotTop - 30) * i) / 5) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    // marks
    const drawnTo = this.drawn;
    ctx.textBaseline = 'alphabetic';
    for (const mark of state.marks) this.mark(ctx, theme, mark, xOf, yOf, width, height, plotTop, main !== null);

    // starred points on a line
    if (drawnTo !== null) {
      const first = plot.series.find((s) => s.draw === 'line' || s.draw === 'area');
      if (first !== undefined) {
        const axis = plot.axis;
        axis.kept.forEach((slot, j) => {
          const p = axis.keptPoint[j] ?? 0;
          if (spark || state.model.points[p]?.starred !== true || slot > drawnTo.toSlot) return;
          const x = scale.logicalToCoordinate((slot + pad) as never);
          const v = first.values[p];
          const y = v === null || v === undefined ? null : yOf(v);
          if (x === null || y === null) return;
          ctx.fillStyle = theme.accent;
          ctx.beginPath();
          ctx.arc(Number(x), y, 4.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      // the live point: one soft pulse, still in reduced motion
      if (state.words.includes('live') && first !== undefined && drawnTo.landed > 0) {
        const axis = plot.axis;
        const j = drawnTo.landed - 1;
        const p = axis.keptPoint[j] ?? 0;
        const v = first.values[p];
        const x = scale.logicalToCoordinate(((axis.kept[j] ?? 0) + pad) as never);
        const y = v === null || v === undefined ? null : yOf(v);
        if (x !== null && y !== null && drawnTo.toSlot >= (axis.kept[j] ?? 0)) {
          const colour = theme.series[0] ?? theme.accent;
          const phase = state.reducedMotion || !state.interactive ? 0 : (now % 1800) / 1800;
          if (phase > 0) {
            ctx.strokeStyle = rgba(colour, 0.5 * (1 - phase));
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(Number(x), y, 4 + phase * 10, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = colour;
          ctx.beginPath();
          ctx.arc(Number(x), y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  private mark(ctx: CanvasRenderingContext2D, theme: ChartTheme, mark: ChartMark, xOf: (x: number) => number | null, yOf: (price: number) => number | null, width: number, height: number, plotTop: number, hasY: boolean): void {
    const alpha = mark.arrived;
    if (alpha <= 0) return;
    const axisBottom = height - theme.fontPx - 16;
    ctx.lineWidth = 1;
    ctx.font = `${theme.fontPx}px ${theme.fontFamily}, ui-sans-serif, system-ui, sans-serif`;
    if (mark.x !== null && mark.y === null) {
      const x = xOf(mark.x);
      if (x === null || x < 0 || x > width) return;
      const px = Math.round(x) + 0.5;
      ctx.strokeStyle = rgba(theme.crosshair, 0.9 * alpha);
      ctx.beginPath();
      ctx.moveTo(px, plotTop);
      ctx.lineTo(px, axisBottom);
      ctx.stroke();
      ctx.fillStyle = rgba(theme.ink, alpha);
      const w = ctx.measureText(mark.label).width;
      const flip = px + 6 + w > width - 4;
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.fillText(mark.label, flip ? px - 5 : px + 5, plotTop + theme.fontPx + 2);
      ctx.textAlign = 'left';
    } else if (mark.x === null && mark.y !== null && hasY) {
      const y = yOf(mark.y);
      if (y === null || y < plotTop || y > axisBottom) return;
      const py = Math.round(y) + 0.5;
      ctx.strokeStyle = rgba(theme.crosshair, 0.9 * alpha);
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(width, py);
      ctx.stroke();
      ctx.fillStyle = rgba(theme.ink, alpha);
      ctx.textAlign = 'right';
      ctx.fillText(mark.label, width - 6, py - 4);
      ctx.textAlign = 'left';
    } else if (mark.x !== null && mark.y !== null && hasY) {
      const x = xOf(mark.x);
      const y = yOf(mark.y);
      if (x === null || y === null) return;
      ctx.fillStyle = rgba(theme.accent, alpha);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(theme.ink, alpha);
      const w = ctx.measureText(mark.label).width;
      const flip = x + 8 + w > width - 4;
      const below = y - 12 < plotTop + 4;
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.fillText(mark.label, flip ? x - 8 : x + 8, below ? y + theme.fontPx + 4 : y - 8);
      ctx.textAlign = 'left';
    }
  }
}

function fit(ctx: CanvasRenderingContext2D, text: string, room: number): string {
  if (ctx.measureText(text).width <= room) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function legendItem(ctx: CanvasRenderingContext2D, theme: ChartTheme, colour: string | null, text: string, x: number, y: number, right: number, style = 0): number {
  const w = ctx.measureText(text).width + (colour === null ? 0 : 20);
  if (x + w > right) return x;
  let tx = x;
  if (colour !== null) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.setLineDash(style === 0 ? [] : [[6, 6], [2, 4], [10, 4], [2, 8]][(style - 1) % 4] ?? []);
    ctx.beginPath();
    ctx.moveTo(x, y + theme.fontPx * 0.55);
    ctx.lineTo(x + 14, y + theme.fontPx * 0.55);
    ctx.stroke();
    ctx.setLineDash([]);
    tx += 20;
  }
  ctx.fillStyle = theme.ink;
  ctx.fillText(text, tx, y);
  return x + w + 14;
}

export function createLightweightEngine(): ChartEngine {
  return {
    id: 'lightweight-charts',
    kinds: KINDS,
    mount: (host) => new LightweightHandle(host),
    attribution: ATTRIBUTION,
  };
}
