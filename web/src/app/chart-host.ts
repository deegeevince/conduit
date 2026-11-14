// Where the charts of one stage live: a DOM surface per chart over the canvas, made by the chart engine and moved and
// scaled by the app (contracts/chart.ts). The painter says every frame which charts there are and what each should show;
// this keeps exactly those on screen, with the camera scaling a surface and never re-laying it out.

import type { ChartAction } from './access';
import type { AccessLayer } from './access';
import type { ChartEngine, ChartHandle, ChartHost, ChartProbe } from '../contracts/chart';
import type { ChartFrame } from '../contracts/frame';
import { FONTS } from '../fonts';

/**
 * The engine draws its text on its own canvas, so the faces must be in the document before its first `apply()`:
 * a chart drawn in the fallback face is measured in it, and its labels collide when the real one arrives. The
 * renderers load a face for themselves; this is the page's own copy for the engine.
 */
let fontsLoaded = false;
let fontsLoading: Promise<void> | null = null;
export function loadChartFonts(): Promise<void> {
  if (fontsLoaded || fontsLoading !== null) return fontsLoading ?? Promise.resolve();
  const loads = Object.values(FONTS).map((face) =>
    new FontFace(face.family, `url(${face.url}) format("${face.format}")`)
      .load()
      .then((loaded) => void document.fonts.add(loaded))
      .catch(() => undefined),
  );
  fontsLoading = Promise.all(loads).then(() => {
    fontsLoaded = true;
  });
  return fontsLoading;
}

interface Surface {
  readonly key: string;
  readonly wrapper: HTMLElement;
  readonly handle: ChartHandle;
  frame: ChartFrame;
  /** the last size handed to the engine, so a camera move that changes only the box does not make it draw again */
  sized: string;
  applied: ChartFrame['state'] | null;
  /** the pointer is over this surface or working it */
  pointing: boolean;
  off: () => void;
}

export interface ChartHostOptions {
  readonly engine: ChartEngine;
  /** the stage element: surfaces go inside it, in front of the canvas */
  readonly stage: HTMLElement;
  readonly access: AccessLayer;
  /** the chart was read (crosshair, pan, zoom): nothing here opens a turn; the app may want to know */
  readonly onRead?: (key: string) => void;
}

/**
 * Charts drawn off screen, for a picture of a stage whose charts are not on it (a draft computed ahead of the
 * playhead, an export). One surface per chart key, kept, so that a second picture does not make another.
 */
export function createOffscreenStills(engine: ChartEngine, ready: () => boolean): { stillOf(chart: ChartFrame): HTMLCanvasElement | null; dispose(): void } {
  const spares = new Map<string, { readonly wrapper: HTMLElement; readonly handle: ChartHandle; applied: ChartFrame['state'] | null; sized: string }>();
  let parking: HTMLElement | null = null;
  return {
    stillOf(chart) {
      if (!ready()) return null;
      if (parking === null) {
        parking = document.createElement('div');
        parking.setAttribute('aria-hidden', 'true');
        parking.style.cssText = 'position:fixed;left:-20000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden';
        document.body.append(parking);
      }
      let spare = spares.get(chart.key);
      if (spare === undefined) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:absolute;left:0;top:0';
        const handle = engine.mount(wrapper);
        wrapper.append(handle.element);
        parking.append(wrapper);
        spare = { wrapper, handle, applied: null, sized: '' };
        spares.set(chart.key, spare);
      }
      const { width, height } = chart.rest;
      const sized = `${width}x${height}`;
      spare.wrapper.style.width = `${width}px`;
      spare.wrapper.style.height = `${height}px`;
      if (spare.applied !== chart.state || spare.sized !== sized) {
        spare.handle.apply(chart.state, { width, height, dpr: 1 });
        spare.applied = chart.state;
        spare.sized = sized;
      }
      return spare.handle.still(false);
    },
    dispose() {
      for (const spare of spares.values()) spare.handle.dispose();
      spares.clear();
      parking?.remove();
      parking = null;
    },
  };
}

export function createChartHost(options: ChartHostOptions): ChartHost {
  const { engine, stage, access } = options;
  const layer = document.createElement('div');
  layer.className = 'stage__charts';
  stage.append(layer);
  const surfaces = new Map<string, Surface>();
  let disposed = false;
  void loadChartFonts();
  const spare = createOffscreenStills(engine, () => fontsLoaded);

  function surfaceFor(frame: ChartFrame): Surface {
    const found = surfaces.get(frame.key);
    if (found !== undefined) return found;
    const wrapper = document.createElement('div');
    wrapper.className = 'stage__chart';
    wrapper.dataset['chart'] = frame.id;
    // The surface is a picture of data for sighted eyes; the access layer's region is what an assistive technology reads.
    wrapper.setAttribute('aria-hidden', 'true');
    const handle = engine.mount(wrapper);
    wrapper.append(handle.element);
    layer.append(wrapper);
    const surface: Surface = { key: frame.key, wrapper, handle, frame, sized: '', applied: null, pointing: false, off: () => undefined };
    const enter = (): void => {
      surface.pointing = true;
    };
    const leave = (): void => {
      surface.pointing = false;
    };
    wrapper.addEventListener('pointerenter', enter);
    wrapper.addEventListener('pointerleave', leave);
    wrapper.addEventListener('pointerdown', enter);
    const offInteract = handle.onInteract(() => options.onRead?.(frame.key));
    surface.off = () => {
      wrapper.removeEventListener('pointerenter', enter);
      wrapper.removeEventListener('pointerleave', leave);
      wrapper.removeEventListener('pointerdown', enter);
      offInteract();
    };
    surfaces.set(frame.key, surface);
    return surface;
  }

  return {
    kinds: engine.kinds,
    sync(charts, dpr) {
      if (disposed) return;
      // Fonts first: nothing is mounted or drawn until the faces are there (the painter calls again next frame).
      if (!fontsLoaded) return;
      const wanted = new Set(charts.map((chart) => chart.key));
      for (const [key, surface] of [...surfaces]) {
        if (wanted.has(key)) continue;
        surface.off();
        surface.handle.dispose();
        surface.wrapper.remove();
        surfaces.delete(key);
      }
      for (const frame of charts) {
        const surface = surfaceFor(frame);
        surface.frame = frame;
        const rest = frame.rest;
        const style = surface.wrapper.style;
        // The surface is laid out at the size it has at rest and moved by the camera: a transform, never a new layout.
        const scaleX = rest.width > 0 ? frame.box.width / rest.width : 1;
        const scaleY = rest.height > 0 ? frame.box.height / rest.height : 1;
        style.width = `${rest.width}px`;
        style.height = `${rest.height}px`;
        style.transform = `translate(${frame.box.x}px, ${frame.box.y}px) scale(${scaleX}, ${scaleY})`;
        style.opacity = String(frame.opacity);
        style.zIndex = String(Math.round(frame.z));
        // While it arrives, leaves or is being exported it takes no pointer, so a stray touch is the stage's.
        style.pointerEvents = frame.state.interactive && frame.opacity > 0.5 ? 'auto' : 'none';
        const sized = `${rest.width}x${rest.height}@${dpr}`;
        if (surface.applied !== frame.state || surface.sized !== sized) {
          surface.handle.apply(frame.state, { width: rest.width, height: rest.height, dpr });
          surface.applied = frame.state;
          surface.sized = sized;
        }
      }
      access.charts(charts);
    },
    still(key) {
      return surfaces.get(key)?.handle.still(false) ?? null;
    },
    stillOf: (chart) => (disposed ? null : spare.stillOf(chart)),
    probe(key) {
      return surfaces.get(key)?.handle.probe() ?? null;
    },
    act(key, action: ChartAction): Promise<ChartProbe> {
      const surface = surfaces.get(key);
      if (surface === undefined) return Promise.reject(new Error('That chart is not on stage.'));
      return surface.handle.act(action);
    },
    owns(x, y) {
      for (const surface of surfaces.values()) {
        if (surface.pointing) return true;
        const box = surface.frame.box;
        if (surface.frame.state.interactive && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return true;
      }
      return false;
    },
    dispose() {
      disposed = true;
      for (const surface of surfaces.values()) {
        surface.off();
        surface.handle.dispose();
      }
      surfaces.clear();
      spare.dispose();
      layer.remove();
      access.charts([]);
    },
  };
}
