// The exporter: films out of the browser as files. See contracts/export.ts.

import type { ExportJob, ExportProgress, ExportRequest, Exporter } from '../contracts/export';
import type { Film } from '../contracts/film';
import type { Frame } from '../contracts/frame';
import type { Renderer } from '../contracts/renderer';
import type { Viewport } from '../contracts/space';
import { chartBoxOf, clipQuad } from '../render/place';
import type { LookId } from '@conduit/language';
import { createZipSink } from './frames';
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
}

type Outcome = { readonly blob: Blob; readonly fileName: string };

/**
 * v2.1. A PDF with one page for each of these moments of the film, in order: a deck's slides, or any set of stills. Each page
 * is a JPEG of the stage at that time, at `width` x `height`. It is the exporter's own request until `contracts/export.ts`
 * carries it (a request to the integrator, with the exact line, is in the hand-back); `Exporter.start` already accepts it.
 */
export interface PdfRequest {
  readonly kind: 'pdf';
  readonly width: number;
  readonly height: number;
  /** film times, one page each */
  readonly at: readonly number[];
}

const MAX_PIXELS = 4096 * 2304;
/** A deck of this many slides is a book; a PDF held in memory stays well under a browser's limits. */
const PDF_MAX_PAGES = 200;

/** The longest a painting may take to load for a film; one that stalls is drawn as its waiting frame rather than holding the export. */
const PRELOAD_MS = 10000;
/** The longest a frame may wait for its text to be drawable. */
const TEXT_MS = 2000;
/** A zip names its entries with 16 bits and its size with 32. */
const ZIP_MAX_ENTRIES = 0xfffe;
const ZIP_MAX_BYTES = 0xffffffff;
/** The first frame stands for the rest; PNG sizes move a little, so the projection keeps a margin. */
const ZIP_MARGIN = 1.25;

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

function pad(index: number): string {
  return String(index).padStart(5, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function survey(film: Film, from: number, to: number): { urls: string[]; looks: LookId[] } {
  const urls = new Set<string>();
  const looks = new Set<LookId>([film.frameAt(from).look]);
  const samples = 24;
  for (let i = 0; i <= samples; i += 1) {
    const frame = film.frameAt(from + ((to - from) * i) / samples);
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

/** The exporter, with the PDF request it already accepts beyond `Exporter`'s own. Assignable to `Exporter`. */
export interface PdfExporter extends Exporter {
  start(film: Film, request: ExportRequest | PdfRequest): ExportJob;
}

export function createExporter(deps: ExporterDeps): PdfExporter {
  let running: { readonly controller: AbortController; readonly settled: Promise<unknown> } | null = null;
  let probe: Promise<{ video: readonly ('webm' | 'mp4')[]; frames: boolean; svg: boolean }> | null = null;
  let disposed = false;

  const findCanvas = (host: HTMLElement): CanvasImageSource => {
    const canvas = host.querySelector('canvas');
    if (canvas === null) throw new Error('This renderer has no canvas to make a video from.');
    return canvas;
  };

  const run = async (film: Film, request: ExportRequest | PdfRequest, signal: AbortSignal, report: (progress: ExportProgress) => void): Promise<Outcome> => {
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
    const viewport: Viewport = { width: film.viewport.width, height: film.viewport.height, dpr: width / film.viewport.width };

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
      guard();
      // Paintings load together, each with a limit: one stalled fetch leaves its picture on the waiting frame and nothing else.
      await wait(Promise.all(urls.map((url) => Promise.race([renderer.preload(url).catch(() => undefined), sleep(PRELOAD_MS)]))));
      guard();

      const maxSide = Math.max(width, height);
      /** A picture whose text was not all drawable is asked for again (the renderer has already waited for it); only then is it an error. */
      const picture = async (frame: Frame): Promise<Blob> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let incomplete = false;
          const blob = await wait(renderer.rasterise(frame, { maxSide, mime: 'image/png', onIncomplete: () => (incomplete = true), ...(deps.chartStill === undefined ? {} : { chartStill: (key: string) => deps.chartStill?.(frame, key) ?? null }) }));
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
            const taken = await wait(renderer.rasterise(frame, { maxSide, mime: 'image/jpeg', quality: 0.92, onIncomplete: () => (incomplete = true), ...(deps.chartStill === undefined ? {} : { chartStill: (key: string) => deps.chartStill?.(frame, key) ?? null }) }));
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

      if (request.kind === 'frames') {
        // A zip is built in memory and has hard limits: say so now, and again once the first frame shows what a frame weighs, not at frame 9,000.
        if (frames > ZIP_MAX_ENTRIES) throw new Error(`A zip holds at most ${ZIP_MAX_ENTRIES} pictures and this is ${frames}. Export a shorter range, or a lower frame rate.`);
        const zip = createZipSink();
        for (let index = 0; index < frames; index += 1) {
          guard();
          const blob = await picture(film.frameAt(timeOf(index)));
          if (index === 0 && blob.size * frames * ZIP_MARGIN > ZIP_MAX_BYTES) {
            throw new Error(`These pictures are about ${Math.round(blob.size / 1024)} KB each and ${frames} of them will not fit in one zip (4 GB). Export a shorter range, a smaller size or a lower frame rate.`);
          }
          zip.add(`frame-${pad(index + 1)}.png`, new Uint8Array(await wait(blob.arrayBuffer())));
          tick(index + 1);
          if (performance.now() - lastYield > 12) {
            await nextTurn();
            lastYield = performance.now();
          }
        }
        guard();
        return { blob: zip.finish(), fileName: `conduit-frames-${width}x${height}.zip` };
      }

      renderer.reset();
      const canvas = findCanvas(host);
      sink = await wait(createVideoSink(request.format, width, height, fps));
      guard();
      const draw = (frame: Frame): Frame => ({ ...frame, viewport });
      // The charts lie over the canvas, not in it: a frame that has any is put together on a canvas of its own, in the same task as the encode.
      let overlay: HTMLCanvasElement | null = null;
      const withCharts = (frame: Frame, canvas: CanvasImageSource, w: number, h: number): CanvasImageSource => {
        const charts = frame.charts;
        if (charts === undefined || charts.length === 0 || deps.chartStill === undefined) return canvas;
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
        for (const chart of [...charts].sort((a, b) => a.z - b.z)) {
          const still = chart.opacity <= 0.002 ? null : deps.chartStill(frame, chart.key);
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
        await wait(sink.add(withCharts(frame, canvas, width, height), index / fps));
        tick(index + 1);
        if (performance.now() - lastYield > 12) {
          await nextTurn();
          lastYield = performance.now();
        }
      }
      guard();
      const blob = await wait(sink.finish());
      sink = null;
      return { blob, fileName: `conduit-film-${width}x${height}.${request.format}` };
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
        return { video: capture ? await videoFormats() : [], frames: capture, svg: true };
      })();
      return probe;
    },

    start(film, request: ExportRequest | PdfRequest) {
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
