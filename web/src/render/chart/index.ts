// The charting engine. STUB: there is none yet (PLAN-v2.md, package K).
//
// What goes here:
//   lightweight.ts  the ONLY file that imports `lightweight-charts` (TradingView, Apache-2.0, added to web/package.json by
//                   package K at an exact version). It implements `ChartEngine` (contracts/chart.ts):
//                     - one `createChart` per handle; line, area, columns (its Histogram series), candles and ohlc (its Bar series);
//                       a second pane for volume; several series with a legend the adapter draws from the model's names;
//                     - `time` and `number` axes drawn TO SCALE (a numeric horizontal scale with tick formatters), `name` axes one
//                       slot a row, candles on its own session scale with the gaps closed;
//                     - ticks, the crosshair and marks written with `formatNumber` (language) and date formats chosen from the span;
//                     - marks as its series markers and price lines, events as a labelled vertical primitive;
//                     - the reveal driven from `ChartState.reveal` with the price range pinned to its final value;
//                     - theming from `ChartTheme` only: no colour, size or face of its own;
//                     - `still()` from its `takeScreenshot`;
//                     - its attribution mark left on, and `attribution` filled from its NOTICE.
//   NOTICE.txt      the library's attribution notice, shipped with the app.
//   theme.ts        ChartTheme from a LookSpec (package K; pure, no DOM).
//
// Each kind is added to CHARTS_READY only when the engine draws it: the
// painter advertises exactly this list, and the brain is taught `chart` only
// when the list is not empty.

import type { ChartKind } from '@conduit/language';
import type { ChartEngine } from '../../contracts/chart';

/** The kinds of chart this build can draw today. */
export const CHARTS_READY: readonly ChartKind[] = [];

/** The engine, or null when this build has none: a `chart` line then draws nothing and the brain is not taught it. */
export function createChartEngine(): ChartEngine | null {
  return null;
}
