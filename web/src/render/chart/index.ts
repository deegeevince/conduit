// The charting engine of this build: `lightweight-charts` (TradingView, Apache-2.0) behind `ChartEngine`
// (contracts/chart.ts). `lightweight.ts` is the only file that imports it; `NOTICE.txt` is the notice its
// licence asks to be shipped; `plot.ts` and `theme.ts` are pure.

import type { ChartKind } from '@conduit/language';
import type { ChartEngine } from '../../contracts/chart';
import { createLightweightEngine } from './lightweight';

/** The kinds of chart this build can draw today. */
export const CHARTS_READY: readonly ChartKind[] = ['line', 'area', 'columns', 'candles', 'ohlc'];

/** The engine, or null when this build has none: a `chart` line then draws nothing and the brain is not taught it. */
export function createChartEngine(): ChartEngine | null {
  return createLightweightEngine();
}

export { chartThemeOf } from './theme';
