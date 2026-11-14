// Where a frame's things are on the picture, for everything that draws outside the renderer's own scene: the charts a
// charting engine draws over the stage and the frames (`Clip`) things are kept inside. Pure; shared by the renderers,
// the picture-taker and the vector exporter, so that all of them put a chart and a frame in the same place.

import type { Layer } from '@conduit/language';
import type { ChartFrame, Clip, Frame } from '../contracts/frame';
import { layerZ, planeScale, projectToScreen } from '../contracts/space';
import type { Box, CameraPose, Viewport } from '../contracts/space';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A rectangle of a layer's plane (stage units, camera at rest) as it lies on the screen through `camera`: four corners, clockwise from the top left. */
export function planeQuad(box: Box, layer: Layer, camera: CameraPose, viewport: Viewport): readonly Point[] {
  const z = layerZ(layer, viewport);
  const corner = (x: number, y: number): Point => {
    const at = projectToScreen({ x, y, z }, camera, viewport);
    return { x: at.x, y: at.y };
  };
  return [corner(box.x, box.y), corner(box.x + box.width, box.y), corner(box.x + box.width, box.y + box.height), corner(box.x, box.y + box.height)];
}

/** The screen outline of a thing's frame. */
export function clipQuad(clip: Clip, layer: Layer, camera: CameraPose, viewport: Viewport): readonly Point[] {
  return planeQuad(clip, layer, camera, viewport);
}

function boundsOf(points: readonly Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Where a chart is on this picture: the room it was given with the camera at rest (`ChartFrame.rest`), seen through THIS
 * frame's camera. A picture taken with a camera other than the one the painter scheduled the chart for (a draft is
 * always taken at rest; a film frame has its own) then has the chart where the stage under it has its room, not where the
 * scheduled camera had put it.
 */
export function chartBoxOf(chart: Pick<ChartFrame, 'layer' | 'rest'>, frame: Frame): Box {
  const { viewport } = frame;
  const scale = planeScale(chart.layer, viewport);
  const rest = chart.rest;
  const plane: Box = { x: (rest.x - viewport.width / 2) / scale, y: (rest.y - viewport.height / 2) / scale, width: rest.width / scale, height: rest.height / scale };
  return boundsOf(planeQuad(plane, chart.layer, frame.camera, viewport));
}
