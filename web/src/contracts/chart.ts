// Charts: the port between the painter and a charting engine.
//
// A chart on this stage is an instrument, not a drawing. The owner's bar for
// it is a trading terminal's: formatted axes, gridlines, a crosshair with the
// value under it, pan and zoom, several series with a legend, marks, a volume
// pane, tens of thousands of points at sixty frames a second. That is years
// of someone else's work, and it exists: TradingView's `lightweight-charts`
// (Apache-2.0, free). So the painter does not draw charts from shapes. It
// reads the brain's rows into a model (`chartModelOf`, language), themes it
// from the look, and hands it to an engine behind this port.
//
// ONE ADAPTER. `web/src/render/chart/lightweight.ts` is the only file that
// imports the library. Everything else sees this file. Replacing the engine,
// or writing our own, is a change to one place.
//
// WHAT THE ENGINE IS NOT PART OF. It draws with canvas 2D in a DOM surface of
// its own, so that surface sits over the WebGL stage rather than in it: the
// look's paper, grain and scanlines do not lie on a live chart, and the
// camera scales its surface instead of moving through it. That is the price
// of the quality, and it is the right way round: a chart is read, not
// admired. Every picture taken of the stage (the brain's look at its draft,
// the snapshot, an exported film) still shows the chart, because the engine
// gives a still of itself and the renderer draws it into the frame.

import type { ChartKind, ChartModel, ChartWord, Face } from '@conduit/language';
import type { Colour } from './frame';
import type { Box } from './space';

/** The look, as a chart wears it. Every colour here has already been through the look's gamut and the contrast rule. */
export interface ChartTheme {
  /** behind the chart: the look's ground, so the chart sits on the stage and not in a panel */
  readonly ground: Colour;
  /** axis labels, the legend, the title: passes 4.5:1 on `ground` */
  readonly ink: Colour;
  /** gridlines and axis rules: a hairline, never louder than a quarter of the way from ground to ink */
  readonly grid: Colour;
  /** the crosshair and its labels */
  readonly crosshair: Colour;
  /** one colour a series, in order: the look's accent first, then alt, then steps round the hue from them. All pass 3:1 on `ground`. */
  readonly series: readonly Colour[];
  /** a candle that closed up, and one that closed down. Told apart by more than hue: an up candle is hollow or lighter, so the chart reads in one phosphor and to a colour-blind eye. */
  readonly up: Colour;
  readonly down: Colour;
  /** the starred point or bar: the look's accent */
  readonly accent: Colour;
  /** the face its text is set in, and the CSS family that names the same font file the stage uses */
  readonly face: Face;
  readonly fontFamily: string;
  /** label size, CSS pixels: the look's `xs`, never under 11 */
  readonly fontPx: number;
  /** true in the looks whose machine had no antialiasing or no curves: lines are drawn straight between points and one device pixel wide steps */
  readonly hard: boolean;
}

/** A mark on a chart: an event (a labelled vertical line), a level (a labelled horizontal line) or a point (a marker on a series). */
export interface ChartMark {
  readonly key: string;
  /** where along the bottom, in the model's own x; null for a level */
  readonly x: number | null;
  /** where up the side; null for an event */
  readonly y: number | null;
  readonly label: string;
  /** 0..1: how far it has arrived; a mark fades in where it will rest */
  readonly arrived: number;
}

/**
 * Everything an engine needs to draw one chart at one instant. It is a value:
 * handing the same state twice changes nothing, and any state can follow any
 * other, which is what lets a chart be seeked, replayed and exported.
 */
export interface ChartState {
  readonly kind: ChartKind;
  readonly words: readonly ChartWord[];
  readonly title: string;
  readonly model: ChartModel;
  readonly marks: readonly ChartMark[];
  readonly theme: ChartTheme;
  /**
   * 0..1: how much of the data is drawn. The reveal is the engine's own
   * idiom: a line runs from left to right, columns and candles rise in order.
   * The scale is fixed at its final range from the first frame, so nothing
   * rescales while the chart arrives.
   */
  readonly reveal: number;
  /** how many of the model's points have landed (rows written so far that the playhead has reached); the rest are not drawn */
  readonly landed: number;
  /** false while it is arriving, leaving or being exported: no crosshair, no pan, no zoom */
  readonly interactive: boolean;
  /** true when the data was asked for by reference and has not come: axes and a quiet empty state, never a spinner */
  readonly waiting: boolean;
  /** true when the data could not be had: the chart says so in one line where the series would be */
  readonly failed: boolean;
  readonly reducedMotion: boolean;
}

/** What a chart is showing, as the test hook and the battery read it. */
export interface ChartProbe {
  /** the part of the bottom axis in view, in the model's x */
  readonly from: number;
  readonly to: number;
  /** what the crosshair is on: the point's label and each series' value as written on the chart; null when it is not showing */
  readonly crosshair: { readonly label: string; readonly values: readonly string[] } | null;
  /** how many points are drawn */
  readonly points: number;
  /** the axis ticks as written, bottom then side: what "properly formatted" is checked against */
  readonly ticks: { readonly x: readonly string[]; readonly y: readonly string[] };
  /** median and worst frame time over the engine's last second of drawing, ms */
  readonly frameMs: { readonly median: number; readonly worst: number };
}

export interface ChartView {
  readonly key: string;
  readonly id: string;
  readonly kind: ChartKind;
  readonly box: Box;
  readonly series: readonly string[];
  readonly points: number;
  readonly waiting: boolean;
}

/** One mounted chart. The app owns its element's place in the page; the engine owns everything inside it. */
export interface ChartHandle {
  /** the surface: the app positions it over the stage at the chart's box and scales it with the camera */
  readonly element: HTMLElement;
  /** Shows exactly this state. Cheap when little changed: an engine diffs against what it last showed. */
  apply(state: ChartState, size: { readonly width: number; readonly height: number; readonly dpr: number }): void;
  /**
   * A picture of the chart as it now stands, for the renderer to draw into a
   * frame it is rasterising. Without the crosshair unless asked. Null before
   * the first `apply`.
   */
  still(withCrosshair?: boolean): HTMLCanvasElement | null;
  /** Works the chart as a pointer would; resolves when the engine has drawn the result. For the test hook. */
  act(action: { readonly hover: number } | { readonly zoom: number } | { readonly pan: number } | { readonly reset: true }): Promise<ChartProbe>;
  probe(): ChartProbe;
  /** Told when the user pans, zooms or moves the crosshair: the app uses it to know the chart is being read, and for nothing else. */
  onInteract(listener: () => void): () => void;
  dispose(): void;
}

/**
 * Where the charts of a stage live. The app makes one per stage (it owns the
 * DOM over the canvas) and hands it to the painter, which tells it every frame
 * which charts there are and what each should show, and asks it for stills
 * when it takes a picture of the stage. With none, a stage has no charts: the
 * painter advertises none and draws none.
 */
export interface ChartHost {
  /** the kinds the engine behind it draws */
  readonly kinds: readonly ChartKind[];
  /** Makes, moves, updates and removes surfaces so that exactly these charts are showing. Called once a frame; cheap when nothing changed. */
  sync(charts: readonly import('./frame').ChartFrame[], dpr: number): void;
  still(key: string): HTMLCanvasElement | null;
  /**
   * A picture of `chart` exactly as that frame shows it, drawn off screen: for a draft, a snapshot or an export of a
   * stage whose charts are not (or no longer) on screen. Null while the engine's fonts are still loading.
   */
  stillOf(chart: import('./frame').ChartFrame): HTMLCanvasElement | null;
  probe(key: string): ChartProbe | null;
  act(key: string, action: { readonly hover: number } | { readonly zoom: number } | { readonly pan: number } | { readonly reset: true }): Promise<ChartProbe>;
  /** true while a pointer is over a chart or working it: the stage then leaves the pointer to the chart */
  owns(x: number, y: number): boolean;
  dispose(): void;
}

export interface ChartEngine {
  readonly id: string;
  /** the kinds it draws */
  readonly kinds: readonly ChartKind[];
  /** Makes a chart inside `host`. Loads nothing from the network: the engine is bundled with the app. */
  mount(host: HTMLElement): ChartHandle;
  /**
   * The attribution the engine's licence asks for, as the app must show it:
   * the engine's own mark on each chart, and a line with a link in the app's
   * About. Null for an engine that asks for none.
   */
  readonly attribution: { readonly text: string; readonly href: string } | null;
}
