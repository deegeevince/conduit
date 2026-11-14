// Drawing strokes: onto a canvas context already set to the strokes' own space (so replay, scale and export are the same code), and as SVG.
//
// Highlighters go under the pens (as a real marker lies under a pen's line) and are drawn opaque into a layer of their own, which is laid down once at
// a fixed opacity, so two overlapping highlighter strokes never go darker than one.

import type { InkStroke } from '@conduit/language';
import { centreLineData, outlinePolygon, penOptions, smoothPathData } from './outline';

export const HIGHLIGHTER_ALPHA = 0.38;

/** Fills a pen stroke. `complete` false is the stroke still being drawn: no end taper, the last point where the pen is. */
export function drawPen(ctx: CanvasRenderingContext2D, stroke: InkStroke, complete = true): void {
  const ring = outlinePolygon(stroke.points, penOptions(stroke, complete));
  if (ring.length === 0) return;
  ctx.fillStyle = stroke.color;
  ctx.fill(new Path2D(smoothPathData(ring, true)), 'nonzero');
}

/** Strokes a highlighter line (opaque; the caller sets the layer's opacity). */
export function drawHighlight(ctx: CanvasRenderingContext2D, stroke: InkStroke, complete = true): void {
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  if (stroke.points.length === 1) {
    const p = stroke.points[0]!;
    ctx.fillRect(p[0] - stroke.width / 2, p[1] - stroke.width / 2, stroke.width, stroke.width);
    return;
  }
  ctx.stroke(new Path2D(centreLineData(stroke.points, stroke.width, complete)));
}

/**
 * Draws every stroke in order of kind: highlighters under, pens over. `scratch` makes an offscreen canvas the size of the target when there are
 * highlighters (the caller keeps one to reuse); `transform` is the matrix the target is already set to.
 */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly InkStroke[], scratch: (() => { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D }) | null): void {
  const highlights = strokes.filter((stroke) => stroke.tool === 'highlighter');
  if (highlights.length > 0) {
    const layer = scratch?.() ?? null;
    if (layer !== null) {
      layer.ctx.save();
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      layer.ctx.setTransform(ctx.getTransform());
      for (const stroke of highlights) drawHighlight(layer.ctx, stroke);
      layer.ctx.restore();
      const was = ctx.getTransform();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = HIGHLIGHTER_ALPHA;
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.restore();
      ctx.setTransform(was);
    } else {
      ctx.save();
      ctx.globalAlpha = HIGHLIGHTER_ALPHA;
      for (const stroke of highlights) drawHighlight(ctx, stroke);
      ctx.restore();
    }
  }
  for (const stroke of strokes) if (stroke.tool === 'pen') drawPen(ctx, stroke);
}

/** One stroke as an SVG element's markup, in the strokes' own units. */
export function strokeSvg(stroke: InkStroke): string {
  if (stroke.tool === 'pen') {
    const ring = outlinePolygon(stroke.points, penOptions(stroke, true));
    return `<path d="${smoothPathData(ring, true)}" fill="${stroke.color}" fill-rule="nonzero"/>`;
  }
  const d = stroke.points.length === 1 ? `M${stroke.points[0]![0]} ${stroke.points[0]![1]}h0.01` : centreLineData(stroke.points, stroke.width, true);
  return `<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}" stroke-linejoin="round" stroke-linecap="butt" stroke-opacity="${HIGHLIGHTER_ALPHA}"/>`;
}
