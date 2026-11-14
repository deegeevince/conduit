// Frames as pictures, off screen.

import type { Frame } from '../../contracts/frame';
import type { RasteriseOptions } from '../../contracts/renderer';
import { chartBoxOf, clipQuad } from '../place';

let tail: Promise<unknown> = Promise.resolve();

/** How long a still waits for its text to be drawable before it is taken as it is and marked incomplete. */
export const TEXT_WAIT_MS = 2000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pixel size of a picture of `frame` whose longer side is `maxSide`, keeping the frame's own aspect. */
export function sizeOf(frame: Frame, maxSide: number): { width: number; height: number } {
  const { width, height } = frame.viewport;
  const scale = Math.max(1, Math.round(maxSide)) / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * What is drawn into a picture after the stage, over it: the charts, which are not the renderer's to draw (a charting
 * engine draws each into a surface of its own that lies over the stage). Each is the engine's own still, at the box
 * the chart has on screen, scaled to the picture's size.
 */
export function chartsOver(frame: Frame, options: RasteriseOptions): ((context: Context2D, width: number, height: number) => void) | undefined {
  const charts = frame.charts;
  const still = options.chartStill;
  const apps = frame.apps;
  const appStill = options.appStill;
  const drawsCharts = charts !== undefined && charts.length > 0 && still !== undefined;
  const drawsApps = apps !== undefined && apps.length > 0 && appStill !== undefined;
  if (!drawsCharts && !drawsApps) return undefined;
  return (context, width, height) => {
    // a live app lies over the stage like a chart: the host's last picture of it goes where its room is
    if (drawsApps) {
      const appScale = Math.min(width / frame.viewport.width, height / frame.viewport.height);
      for (const app of [...apps].sort((a, b) => a.z - b.z)) {
        if (app.opacity <= 0.002) continue;
        const picture = appStill(app.key);
        if (picture === null) continue;
        const room = chartBoxOf(app, frame);
        context.save();
        context.globalAlpha = Math.max(0, Math.min(1, app.opacity));
        context.drawImage(picture, room.x * appScale, room.y * appScale, room.width * appScale, room.height * appScale);
        context.restore();
      }
    }
    if (!drawsCharts) return;
    const scale = Math.min(width / frame.viewport.width, height / frame.viewport.height);
    const ordered = [...charts].sort((a, b) => a.z - b.z);
    for (const chart of ordered) {
      if (chart.opacity <= 0.002) continue;
      const picture = still(chart.key);
      if (picture === null) continue;
      const box = chartBoxOf(chart, frame);
      context.save();
      if (chart.clip !== undefined) {
        // Kept inside its frame, as the stage's own things are: the frame as it lies through this picture's camera.
        const quad = clipQuad(chart.clip, chart.layer, frame.camera, frame.viewport);
        context.beginPath();
        quad.forEach((p, i) => (i === 0 ? context.moveTo(p.x * scale, p.y * scale) : context.lineTo(p.x * scale, p.y * scale)));
        context.closePath();
        context.clip();
      }
      context.globalAlpha = Math.max(0, Math.min(1, chart.opacity));
      context.drawImage(picture, box.x * scale, box.y * scale, box.width * scale, box.height * scale);
      context.restore();
    }
  };
}

function encode(pixels: Uint8Array, width: number, height: number, options: RasteriseOptions, compose?: (context: Context2D, width: number, height: number) => void): Promise<Blob | null> {
  // Rows come off the GPU bottom first.
  const flipped = new Uint8ClampedArray(width * height * 4);
  const stride = width * 4;
  for (let row = 0; row < height; row++) flipped.set(pixels.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
  if (options.mime !== 'image/png') for (let i = 3; i < flipped.length; i += 4) flipped[i] = 255;
  const image = new ImageData(flipped, width, height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) return Promise.resolve(null);
    context.putImageData(image, 0, 0);
    compose?.(context, width, height);
    return canvas.convertToBlob({ type: options.mime, quality: options.quality ?? 0.92 });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return Promise.resolve(null);
  context.putImageData(image, 0, 0);
  compose?.(context, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, options.mime, options.quality ?? 0.92));
}

/**
 * Draws `frame` into a render target of its own at the size `options` asks
 * (through a second, parked kit, exactly as looks are warmed in v0), reads
 * the pixels back, and encodes them. The visible canvas, its feedback
 * buffers and `isDrawable` are untouched. Requests are answered in order.
 * Persistence (`fx persistence`) is drawn as if the frame had been still for
 * a second: a picture must not depend on what was drawn before it.
 *
 * `draw` returns null while the frame's text is still being typeset; it is asked again until it has an answer, for at
 * most `TEXT_WAIT_MS`. After that the picture is taken as it stands (`force`) and `options.onIncomplete` is told, so a
 * still that is missing text is marked rather than silently shipped as whole.
 */
export function rasteriseFrame(
  draw: (frame: Frame, width: number, height: number, fx: boolean, force: boolean) => Uint8Array | null,
  frame: Frame,
  options: RasteriseOptions,
  ready: Promise<unknown> = Promise.resolve(),
): Promise<Blob | null> {
  const { width, height } = sizeOf(frame, options.maxSide);
  const job = tail.then(async () => {
    // The faces come first and are not counted against the cap: a face that is still loading is not a text that failed to typeset.
    await ready.catch(() => undefined);
    const deadline = performance.now() + TEXT_WAIT_MS;
    let pixels: Uint8Array | null = null;
    while (pixels === null && performance.now() < deadline) {
      pixels = draw(frame, width, height, options.fx !== false, false);
      if (pixels === null) await pause(8);
    }
    if (pixels === null) {
      pixels = draw(frame, width, height, options.fx !== false, true);
      options.onIncomplete?.();
    }
    if (pixels === null) return null;
    return encode(pixels, width, height, options, chartsOver(frame, options));
  });
  tail = job.catch(() => undefined);
  return job;
}
