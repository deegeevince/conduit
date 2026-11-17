// Where the canvas goes. A scene's drawing space is a fixed rectangle of
// square units (160 x 90, 100 x 100 or 90 x 160); this file fits it to a
// real screen and says which part of the stage is for pictures and which for
// flowing text. It is pure geometry: no time, no state.

import { CANVAS } from '@conduit/language';
import type { CanvasName, Layer, Layout } from '@conduit/language';
import type { LookSpec } from '../contracts/look';
import type { StageBlock } from '../contracts/stage-plan';
import { safeFrame } from './layout/metrics';
import { planStage } from './layout/plan';
import { planeScale } from '../contracts/space';
import type { Box, Viewport } from '../contracts/space';

export interface CanvasFit {
  /** where the canvas sits on the reading plane, stage units */
  readonly box: Box;
  /** stage units per canvas unit on the reading plane */
  readonly unit: number;
  /** the room the stage plan gave flowing words, stage units */
  readonly flow: Box;
  /** the picture's region of the stage plan (what the canvas is fitted in, and what everything drawn on it is clipped by), stage units */
  readonly region: Box;
  /** the share of the viewport's area the canvas covers, 0..1 */
  readonly coverage: number;
}

/**
 * Fits a canvas into the picture's region of the stage plan, centred, whole (never cropped, never stretched). The region is the plan's
 * (`planStage` makes it; nothing here reads the safe frame): the canvas is as large as the region allows and `flow` is the plan's, so the
 * words and the picture are laid out from one division of the stage.
 *
 * The same canvas point lands on the same screen point on every layer with the camera at rest: `canvasToStage` divides by the layer's
 * `planeScale`. `grown` is the scene's drawing space when what was drawn runs past the declared canvas (`sceneCanvasOf`): its origin is the canvas's, so
 * every point keeps its coordinates and the whole drawing is in view.
 */
export function fitIn(canvas: CanvasName, region: Box, flow: Box, viewport: Viewport, grown?: { readonly width: number; readonly height: number }): CanvasFit {
  const size = grown ?? CANVAS[canvas];
  const unit = Math.max(1e-6, Math.min(region.width / size.width, region.height / size.height));
  const width = size.width * unit;
  const height = size.height * unit;
  const box: Box = { x: region.x + (region.width - width) / 2, y: region.y + (region.height - height) / 2, width, height };
  return { box, unit, flow, region, coverage: Math.min(1, (width * height) / Math.max(1, viewport.width * viewport.height)) };
}

/**
 * The fit of a stage that has a picture and nothing else on it, for what has no stage to ask (a fixture, a bench): the plan's division with
 * no words, no choices and no blocks.
 */
export function fitCanvas(canvas: CanvasName, layout: Layout, viewport: Viewport, look: LookSpec): CanvasFit {
  const picture: StageBlock = { key: 'canvas', kind: 'picture', order: 0, natural: { width: 1600, height: 900 }, least: { width: 160, height: 90 }, aspect: null, pinned: null };
  const plan = planStage({ viewport, look, layout, blocks: [picture], flowHeight: () => 0, flowOrder: null, footHeight: () => 0 });
  return fitIn(canvas, plan.picture ?? safeFrame(viewport, look), plan.flow, viewport);
}

/** A fit part of the way (0..1) from one to another: the picture's region changing between layout epochs, eased. */
export function lerpFit(from: CanvasFit, to: CanvasFit, t: number): CanvasFit {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const mix = (a: number, b: number): number => a + (b - a) * t;
  const box = (a: Box, b: Box): Box => ({ x: mix(a.x, b.x), y: mix(a.y, b.y), width: mix(a.width, b.width), height: mix(a.height, b.height) });
  return { box: box(from.box, to.box), unit: mix(from.unit, to.unit), flow: box(from.flow, to.flow), region: box(from.region, to.region), coverage: mix(from.coverage, to.coverage) };
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
