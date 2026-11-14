// The exporter: films out of the browser as files. See contracts/export.ts.

import type { ExportJob, ExportProgress, ExportRequest, Exporter } from '../contracts/export';
import type { Film } from '../contracts/film';
import type { Frame } from '../contracts/frame';
import type { Renderer } from '../contracts/renderer';
import type { Viewport } from '../contracts/space';
import { chartBoxOf, clipQuad } from '../render/place';
import type { LookId } from '@conduit/language';
import { renderSound } from './audio';
import { createPdfSink } from './pdf';
import { frameToSvg } from './svg';
import { createVideoSink, videoFormats } from './video';
import type { VideoSink } from './video';

export interface ExporterDeps {
  /** makes a renderer the exporter can mount off screen; the same factory the stage uses */
  readonly createRenderer: () => Renderer;
  /**
   * The charting engine's picture of a chart as `frame` has it (`frame.charts`, by the chart's key), for a picture, a
   * film or a vector drawing of a stage that has charts. A chart is drawn by an engine into a surface over the stage,
   * so without this an export would have a hole where the chart is. It is asked once per frame that has charts, and
   * must give the chart as that frame shows it, not as the stage shows it now. Absent: charts are left out, and the
   * room they had is the look's ground.
   */
  readonly chartStill?: (frame: Frame, key: string) => HTMLCanvasElement | null;
  /** The host's picture of a live app (`Frame.apps`, by the app's key), laid where the app rests in a picture or a film. Absent: an app is its placeholder. */
  readonly appStill?: (key: string) => CanvasImageSource | null;
  /** Asked once before a picture or a film is made: each running app draws itself as it stands, so the stills are fresh. */
  readonly appsFresh?: () => Promise<void>;
}

type Outcome = { readonly blob: Blob; readonly fileName: string; readonly hasSound?: boolean };

const MAX_PIXELS = 4096 * 2304;
/** A deck of this many slides is a book; a PDF held in memory stays well under a browser's limits. */
const PDF_MAX_PAGES = 200;

/** The longest a painting may take to load for a film; one that stalls is drawn as its waiting frame rather than holding the export. */
const PRELOAD_MS = 10000;
/** The longest a frame may wait for its text to be drawable. */
const TEXT_MS = 2000;

const abortError = (): DOMException => new DOMException('The export was cancelled.', 'AbortError');

function nextTurn(): Promise<void> {
  if (document.visibilityState === 'visible') {
    // One frame of the visible stage between ours keeps it at full rate.
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 60);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

function range(film: Film, from: number | undefined, to: number | undefined): { from: number; to: number } {
  const start = Math.max(0, Math.min(from ?? 0, film.duration));
  const end = Math.max(start, Math.min(to ?? film.duration, film.duration));
  return { from: start, to: end };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function survey(film: Film, from: number, to: number): { urls: string[]; looks: LookId[] } {
  const urls = new Set<string>();
  const looks = new Set<LookId>([film.frameAt(from).look]);
  // A film of several turns is looked at at least once every two seconds, and at each of its landmarks: a look worn for one short turn must be found.
  const samples = Math.min(600, Math.max(24, Math.ceil((to - from) / 2)));
  const moments = [...Array.from({ length: samples + 1 }, (_, i) => from + ((to - from) * i) / samples), ...(film.landmarks ?? []).filter((at) => at >= from && at <= to)];
  for (const at of moments) {
    const frame = film.frameAt(at);
    looks.add(frame.look);
    if (frame.lookChange !== null) {
      looks.add(frame.lookChange.from);
      looks.add(frame.lookChange.to);
    }
    for (const figure of frame.figures) {
      if (figure.kind === 'picture' && figure.src !== null) urls.add(figure.src);
    }
  }
  return { urls: [...urls], looks: [...looks] };
}

export function createExporter(deps: ExporterDeps): Exporter {
  let running: { readonly controller: AbortController; readonly settled: Promise<unknown> } | null = null;
  let probe: Promise<{ video: readonly ('webm' | 'mp4')[]; svg: boolean; pdf: boolean }> | null = null;
  let disposed = false;

  const findCanvas = (host: HTMLElement): CanvasImageSource => {
    const canvas = host.querySelector('canvas');
    if (canvas === null) throw new Error('This renderer has no canvas to make a video from.');
    return canvas;
  };

  const run = async (film: Film, request: ExportRequest, signal: AbortSignal, report: (progress: ExportProgress) => void): Promise<Outcome> => {
    const guard = (): void => {
      if (signal.aborted) throw abortError();
    };
    // Cancel must be heard while something is being waited for, not only between awaits: a stalled fetch or a stuck mount cannot hold it.
    const stopped = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(abortError());
      else signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    stopped.catch(() => undefined);
    const wait = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stopped]);

    if (request.kind === 'script') {
      return { blob: new Blob([film.script() + '\n'], { type: 'text/plain;charset=utf-8' }), fileName: 'conduit.series' };
    }
    if (request.kind === 'still' && request.format === 'svg') {
      const frame = film.frameAt(Math.max(0, Math.min(request.at, film.duration)));
      const probe = deps.createRenderer();
      const fonts = probe.fontFile;
      probe.dispose();
      const svg = await wait(frameToSvg(frame, { width: request.width, height: request.height }, fonts, deps.chartStill === undefined ? undefined : (key) => deps.chartStill?.(frame, key) ?? null));
      guard();
      report({ done: 1, frame: 1, frames: 1 });
      return { blob: new Blob([svg], { type: 'image/svg+xml' }), fileName: 'conduit-still.svg' };
    }

    const width = Math.max(2, Math.round(request.width));
    const height = Math.max(2, Math.round(request.height));
    if (request.kind === 'pdf' && request.at.length > PDF_MAX_PAGES) throw new Error(`A PDF made here holds at most ${PDF_MAX_PAGES} pages and this is ${request.at.length}.`);
    if (width * height > MAX_PIXELS) throw new Error('That size is larger than this exporter will draw. Try 3840 by 2160 or smaller.');
    // A film with a surround (the language pane) is the stage inside a bigger picture: the stage is drawn at its own size, the rest is drawn around it.
    const surround = request.kind === 'video' ? film.surround : undefined;
    const viewport: Viewport = { width: film.viewport.width, height: film.viewport.height, dpr: surround === undefined ? width / film.viewport.width : width / surround.width };
    const stageWidth = surround === undefined ? width : Math.round(film.viewport.width * viewport.dpr);
    const stageHeight = surround === undefined ? height : Math.round(film.viewport.height * viewport.dpr);

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = `position:fixed;left:-20000px;top:0;width:${viewport.width}px;height:${viewport.height}px;overflow:hidden;pointer-events:none;`;
    document.body.append(host);
    const renderer = deps.createRenderer();
    let sink: VideoSink | null = null;
    try {
      if (!renderer.capabilities.capture) throw new Error('This browser draws the stage without a way to capture it, so it cannot be exported as pictures.');
      const times = request.kind === 'pdf' ? request.at.map((at) => Math.max(0, Math.min(at, film.duration))) : [];
      const span = request.kind === 'pdf' ? { from: Math.min(0, ...times), to: Math.max(0, ...times) } : request.kind === 'still' ? { from: request.at, to: request.at } : range(film, request.from, request.to);
      const { urls, looks } = survey(film, span.from, Math.max(span.from, span.to));
      // A deck's slides are far apart in time: the paintings and looks of every page are found from the page's own moment, not the span between.
      for (const at of times) {
        const frame = film.frameAt(at);
        if (!looks.includes(frame.look)) looks.push(frame.look);
        for (const figure of frame.figures) if (figure.kind === 'picture' && figure.src !== null && !urls.includes(figure.src)) urls.push(figure.src);
      }
      await wait(renderer.mount(host, viewport, looks[0] ?? film.frameAt(span.from).look, { looks }));
      // Each running app draws itself as it stands, so the stills laid in the picture or the film are fresh.
      if (deps.appsFresh !== undefined) await wait(deps.appsFresh().catch(() => undefined));
      guard();
      // Paintings load together, each with a limit: one stalled fetch leaves its picture on the waiting frame and nothing else.
      await wait(Promise.all(urls.map((url) => Promise.race([renderer.preload(url).catch(() => undefined), sleep(PRELOAD_MS)]))));
      guard();

      const maxSide = Math.max(width, height);
      /** A picture whose text was not all drawable is asked for again (the renderer has already waited for it); only then is it an error. */
      const picture = async (frame: Frame): Promise<Blob> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let incomplete = false;
          const blob = await wait(renderer.rasterise(frame, { maxSide, mime: 'image/png', onIncomplete: () => (incomplete = true), ...(deps.chartStill === undefined ? {} : { chartStill: (key: string) => deps.chartStill?.(frame, key) ?? null }), ...(deps.appStill === undefined ? {} : { appStill: deps.appStill }) }));
          guard();
          if (blob === null) throw new Error('This renderer could not capture the picture.');
          if (!incomplete) return blob;
        }
        throw new Error('The text of this picture would not finish drawing. Try again, or export a shorter range.');
      };

      if (request.kind === 'pdf') {
        const pdf = createPdfSink();
        for (let index = 0; index < times.length; index += 1) {
          guard();
          // A page is a JPEG: the renderer flattens it on its ground, and a slide has no use for transparency.
          const frame = film.frameAt(times[index] ?? 0);
          let jpeg: Blob | null = null;
          for (let attempt = 0; attempt < 3 && jpeg === null; attempt += 1) {
            let incomplete = false;
            const taken = await wait(renderer.rasterise(frame, { maxSide, mime: 'image/jpeg', quality: 0.92, onIncomplete: () => (incomplete = true), ...(deps.chartStill === undefined ? {} : { chartStill: (key: string) => deps.chartStill?.(frame, key) ?? null }), ...(deps.appStill === undefined ? {} : { appStill: deps.appStill }) }));
            guard();
            if (taken === null) throw new Error('This renderer could not capture the picture.');
            if (!incomplete) jpeg = taken;
          }
          if (jpeg === null) throw new Error('The text of a page would not finish drawing. Try again, or export fewer pages.');
          pdf.add(new Uint8Array(await wait(jpeg.arrayBuffer())));
          report({ done: (index + 1) / times.length, frame: index + 1, frames: times.length });
        }
        return { blob: pdf.finish(), fileName: `conduit-${times.length}-pages.pdf` };
      }

      if (request.kind === 'still') {
        const blob = await picture(film.frameAt(Math.max(0, Math.min(request.at, film.duration))));
        report({ done: 1, frame: 1, frames: 1 });
        return { blob, fileName: 'conduit-still.png' };
      }

      const fps = Math.max(1, Math.min(120, request.fps));
      const frames = Math.max(1, Math.round((span.to - span.from) * fps));
      const timeOf = (index: number): number => Math.min(film.duration, span.from + index / fps);
      let incompleteFrames = 0;
      const tick = (index: number): void => report({ done: index / frames, frame: index, frames, ...(incompleteFrames > 0 ? { incompleteFrames } : {}) });
      let lastYield = performance.now();

      // The music is rendered first, faster than it plays, and then given to the encoder a little ahead of the pictures.
      const shifted = (film.tunes ?? []).map((tune) => ({ ...tune, at: tune.at - span.from, until: tune.until - span.from }));
      const sound = await wait(renderSound(shifted, span.to - span.from).catch(() => null));
      guard();
      renderer.reset();
      const canvas = findCanvas(host);
      sink = await wait(createVideoSink(request.format, width, height, fps, sound));
      guard();
      const draw = (frame: Frame): Frame => ({ ...frame, viewport });
      // The charts lie over the canvas, not in it: a frame that has any is put together on a canvas of its own, in the same task as the encode.
      let overlay: HTMLCanvasElement | null = null;
      const withCharts = (frame: Frame, canvas: CanvasImageSource, w: number, h: number): CanvasImageSource => {
        const charts = frame.charts ?? [];
        const apps = frame.apps ?? [];
        const drawsCharts = charts.length > 0 && deps.chartStill !== undefined;
        const appStill = deps.appStill;
        const drawsApps = apps.length > 0 && appStill !== undefined;
        if (!drawsCharts && !drawsApps) return canvas;
        overlay ??= document.createElement('canvas');
        if (overlay.width !== w || overlay.height !== h) {
          overlay.width = w;
          overlay.height = h;
        }
        const context = overlay.getContext('2d');
        if (context === null) return canvas;
        context.globalAlpha = 1;
        context.drawImage(canvas, 0, 0, w, h);
        const scale = Math.min(w / frame.viewport.width, h / frame.viewport.height);
        // A live app lies over the stage like a chart: the host's last picture of it goes where its room is, at the room's width and never stretched (as `chartsOver` lays it in a still).
        if (appStill !== undefined) {
          for (const app of [...apps].sort((a, b) => a.z - b.z)) {
            if (app.opacity <= 0.002) continue;
            const picture = appStill(app.key);
            if (picture === null) continue;
            const room = chartBoxOf(app, frame);
            const natural = picture as { width?: number; height?: number };
            const pw = typeof natural.width === 'number' && natural.width > 0 ? natural.width : room.width;
            const ph = typeof natural.height === 'number' && natural.height > 0 ? natural.height : room.height;
            const fitScale = room.width / pw;
            const shownH = Math.min(ph, room.height / fitScale);
            context.globalAlpha = Math.max(0, Math.min(1, app.opacity));
            context.drawImage(picture, 0, 0, pw, shownH, room.x * scale, room.y * scale, room.width * scale, shownH * fitScale * scale);
          }
          context.globalAlpha = 1;
        }
        for (const chart of drawsCharts ? [...charts].sort((a, b) => a.z - b.z) : []) {
          const still = chart.opacity <= 0.002 ? null : (deps.chartStill?.(frame, chart.key) ?? null);
          if (still === null) continue;
          const box = chartBoxOf(chart, frame);
          context.save();
          if (chart.clip !== undefined) {
            context.beginPath();
            clipQuad(chart.clip, chart.layer, frame.camera, frame.viewport).forEach((p, i) => (i === 0 ? context.moveTo(p.x * scale, p.y * scale) : context.lineTo(p.x * scale, p.y * scale)));
            context.closePath();
            context.clip();
          }
          context.globalAlpha = Math.max(0, Math.min(1, chart.opacity));
          context.drawImage(still, box.x * scale, box.y * scale, box.width * scale, box.height * scale);
          context.restore();
        }
        context.globalAlpha = 1;
        return overlay;
      };
      let sheet: HTMLCanvasElement | null = null;
      /** The stage laid in the picture that surrounds it, drawn at `seconds` of the film. */
      const surrounded = (stage: CanvasImageSource, seconds: number): CanvasImageSource => {
        if (surround === undefined) return stage;
        sheet ??= document.createElement('canvas');
        if (sheet.width !== width || sheet.height !== height) {
          sheet.width = width;
          sheet.height = height;
        }
        const context = sheet.getContext('2d');
        if (context === null) return stage;
        const scale = width / surround.width;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        context.fillStyle = '#000';
        context.fillRect(0, 0, width, height);
        context.save();
        context.scale(scale, scale);
        surround.draw(context, seconds);
        context.restore();
        context.drawImage(stage, Math.round(surround.stage.x * scale), Math.round(surround.stage.y * scale), stageWidth, stageHeight);
        return sheet;
      };
      for (let index = 0; index < frames; index += 1) {
        guard();
        const frame = draw(film.frameAt(timeOf(index)));
        renderer.render(frame);
        // Text is typeset a moment after it is first asked for: draw again until it is all there, within a limit.
        const until = performance.now() + TEXT_MS;
        while (!renderer.isDrawable() && performance.now() < until) {
          await wait(sleep(4));
          renderer.render(frame);
        }
        if (!renderer.isDrawable()) incompleteFrames += 1;
        await wait(sink.add(surrounded(withCharts(frame, canvas, stageWidth, stageHeight), timeOf(index)), index / fps));
        tick(index + 1);
        if (performance.now() - lastYield > 12) {
          await nextTurn();
          lastYield = performance.now();
        }
      }
      guard();
      const hasSound = sink.hasSound;
      const blob = await wait(sink.finish());
      sink = null;
      return { blob, hasSound, fileName: `conduit-${request.scope === 'conversation' ? 'conversation' : 'film'}${surround === undefined ? '' : '-lines'}-${width}x${height}.${request.format}` };
    } catch (error) {
      if (signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) throw abortError();
      throw error;
    } finally {
      sink?.abort();
      renderer.dispose();
      host.remove();
    }
  };

  return {
    formats() {
      probe ??= (async () => {
        const probeRenderer = deps.createRenderer();
        const capture = probeRenderer.capabilities.capture;
        probeRenderer.dispose();
        return { video: capture ? await videoFormats() : [], svg: true, pdf: capture };
      })();
      return probe;
    },

    start(film, request: ExportRequest) {
      if (disposed) throw new Error('The exporter has been disposed.');
      const controller = new AbortController();
      const listeners = new Set<(progress: ExportProgress) => void>();
      const report = (progress: ExportProgress): void => {
        for (const listener of listeners) listener(progress);
      };
      // Making the script and a vector drawing touch no renderer: they run beside a film without disturbing it.
      const light = request.kind === 'script' || (request.kind === 'still' && request.format === 'svg');
      const previous = light ? null : running;
      // A job that is running is not cancelled by another one starting: Save picture during Save film must not lose the film.
      // One that has been cancelled is waited for, so the new job finds its renderer let go.
      const busy = previous !== null && !previous.controller.signal.aborted;
      let entry: { readonly controller: AbortController; readonly settled: Promise<unknown> } | null = null;
      const done = (async (): Promise<Outcome> => {
        try {
          if (busy) throw new Error('Another export is still running. Wait for it to finish, or cancel it first.');
          await previous?.settled.catch(() => undefined);
          if (controller.signal.aborted) throw abortError();
          return await run(film, request, controller.signal, report);
        } finally {
          // Let go before the result reaches the caller, so a job started the moment this one resolves is not refused.
          if (entry !== null && running === entry) running = null;
        }
      })();
      entry = { controller, settled: done.catch(() => undefined) };
      if (!light && !busy) running = entry;
      return {
        done,
        onProgress(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        cancel() {
          controller.abort();
        },
      } satisfies ExportJob;
    },

    dispose() {
      disposed = true;
      running?.controller.abort();
      running = null;
    },
  };
}
