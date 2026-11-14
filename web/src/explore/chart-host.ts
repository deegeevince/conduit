// A ChartHost for the battery's page: the same contract the app's host fulfils, on a fixed layer over the page, so that a chart is
// really mounted, really drawn and really worked (hover, zoom) with no app around it. With no engine in this build there is no host
// and a stage has no charts, exactly as in the app.

import type { ChartKind } from '@conduit/language';
import type { ChartEngine, ChartHandle, ChartHost, ChartProbe } from '../contracts/chart';
import type { ChartFrame } from '../contracts/frame';
import { createOffscreenStills } from '../app/chart-host';

export function createHarnessChartHost(engine: ChartEngine, parent: HTMLElement): ChartHost {
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
  parent.append(layer);
  const mounted = new Map<string, ChartHandle>();
  const kinds: readonly ChartKind[] = engine.kinds;
  const spare = createOffscreenStills(engine, () => true);
  return {
    kinds,
    sync(charts: readonly ChartFrame[], dpr: number): void {
      const keep = new Set<string>();
      for (const chart of charts) {
        keep.add(chart.key);
        let handle = mounted.get(chart.key);
        if (handle === undefined) {
          handle = engine.mount(layer);
          mounted.set(chart.key, handle);
          handle.element.style.position = 'absolute';
          layer.append(handle.element);
        }
        const style = handle.element.style;
        style.left = `${chart.rest.x}px`;
        style.top = `${chart.rest.y}px`;
        style.width = `${chart.rest.width}px`;
        style.height = `${chart.rest.height}px`;
        style.opacity = String(chart.opacity);
        style.pointerEvents = chart.state.interactive ? 'auto' : 'none';
        handle.apply(chart.state, { width: chart.rest.width, height: chart.rest.height, dpr });
      }
      for (const [key, handle] of mounted) {
        if (keep.has(key)) continue;
        handle.dispose();
        handle.element.remove();
        mounted.delete(key);
      }
    },
    still: (key: string): HTMLCanvasElement | null => mounted.get(key)?.still() ?? null,
    stillOf: (chart) => spare.stillOf(chart),
    probe: (key: string): ChartProbe | null => mounted.get(key)?.probe() ?? null,
    act: (key: string, action) => {
      const handle = mounted.get(key);
      return handle === undefined ? Promise.reject(new Error(`no chart ${key}`)) : handle.act(action);
    },
    owns: () => false,
    dispose(): void {
      for (const handle of mounted.values()) handle.dispose();
      mounted.clear();
      spare.dispose();
      layer.remove();
    },
  };
}
