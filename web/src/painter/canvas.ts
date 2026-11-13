// Where the canvas goes. A scene's drawing space is a fixed rectangle of
// square units (160 x 90, 100 x 100 or 90 x 160); this file fits it to a
// real screen and says which part of the stage is for pictures and which for
// flowing text. It is pure geometry: no time, no state.

import { CANVAS } from '@conduit/language';
import type { CanvasName, Layer, Layout } from '@conduit/language';
import type { LookSpec } from '../contracts/look';
import { planeScale } from '../contracts/space';
import type { Box, Viewport } from '../contracts/space';
import { cellOf, marginOf, safeFrame } from './layout/metrics';

export interface CanvasFit {
  /** where the canvas sits on the reading plane, stage units */
  readonly box: Box;
  /** stage units per canvas unit on the reading plane */
  readonly unit: number;
  /** the part of the safe frame left to flowing text, stage units; for layouts where text shares the stage with the picture this is the whole safe frame */
  readonly flow: Box;
  /** the share of the viewport's area the canvas covers, 0..1 */
  readonly coverage: number;
}

/** Share of the safe frame's width a landscape `figure` gives the picture. */
const FIGURE_PICTURE_SHARE = 0.58;
/** Share of the safe frame's height a portrait `figure` gives the picture. */
const FIGURE_PORTRAIT_SHARE = 0.55;

/**
 * Fits a canvas into the room its layout gives pictures, centred, whole
 * (never cropped, never stretched).
 *
 * - `caption`: the picture has the safe frame less a band at the bottom tall
 *   enough for two lines of body text and their margin; the flow is that band.
 * - `figure`: on a landscape viewport the picture has the left 58% and the
 *   flow the right 42%, less one gutter; on a portrait one the picture has
 *   the top 55% and the flow the rest.
 * - every other layout: the picture has the whole safe frame, and so does the flow.
 *
 * The same canvas point lands on the same screen point on every layer with
 * the camera at rest: `canvasToStage` divides by the layer's `planeScale`.
 */
export function fitCanvas(canvas: CanvasName, layout: Layout, viewport: Viewport, look: LookSpec): CanvasFit {
  const safe = safeFrame(viewport, look);
  const body = cellOf('m', viewport, look);
  const margin = marginOf(viewport, look);
  let picture: Box = safe;
  let flow: Box = safe;
  if (layout === 'caption') {
    const band = Math.min(safe.height * 0.4, body.height * 2 + margin * 0.5);
    picture = { x: safe.x, y: safe.y, width: safe.width, height: safe.height - band };
    flow = { x: safe.x, y: safe.y + safe.height - band, width: safe.width, height: band };
  } else if (layout === 'figure') {
    const gutter = Math.max(16, margin * 0.75);
    if (viewport.width >= viewport.height) {
      const pictureWidth = safe.width * FIGURE_PICTURE_SHARE - gutter / 2;
      picture = { x: safe.x, y: safe.y, width: pictureWidth, height: safe.height };
      flow = { x: safe.x + safe.width * FIGURE_PICTURE_SHARE + gutter / 2, y: safe.y, width: safe.width * (1 - FIGURE_PICTURE_SHARE) - gutter / 2, height: safe.height };
    } else {
      const pictureHeight = safe.height * FIGURE_PORTRAIT_SHARE - gutter / 2;
      picture = { x: safe.x, y: safe.y, width: safe.width, height: pictureHeight };
      flow = { x: safe.x, y: safe.y + safe.height * FIGURE_PORTRAIT_SHARE + gutter / 2, width: safe.width, height: safe.height * (1 - FIGURE_PORTRAIT_SHARE) - gutter / 2 };
    }
  }
  const size = CANVAS[canvas];
  const unit = Math.max(1e-6, Math.min(picture.width / size.width, picture.height / size.height));
  const width = size.width * unit;
  const height = size.height * unit;
  const box: Box = { x: picture.x + (picture.width - width) / 2, y: picture.y + (picture.height - height) / 2, width, height };
  return { box, unit, flow, coverage: Math.min(1, (width * height) / Math.max(1, viewport.width * viewport.height)) };
}

/** A canvas point as a point on a layer's plane, stage units. */
export function canvasToStage(point: { readonly x: number; readonly y: number }, fit: CanvasFit, layer: Layer, viewport: Viewport): { x: number; y: number } {
  const scale = planeScale(layer, viewport);
  return { x: (fit.box.x + point.x * fit.unit) / scale, y: (fit.box.y + point.y * fit.unit) / scale };
}

/** A point on the reading plane as a canvas point: what the sight report and picking speak in. */
export function stageToCanvas(point: { readonly x: number; readonly y: number }, fit: CanvasFit): { x: number; y: number } {
  return { x: (point.x - fit.box.x) / fit.unit, y: (point.y - fit.box.y) / fit.unit };
}
