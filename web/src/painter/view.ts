// The lens as pure geometry. A lens is the page point at the centre of the screen and the screen pixels one page unit takes; the
// screen is a window of fixed size. Nothing here draws, measures or reads the DOM: the same numbers go to the renderer, the DOM layers and the
// pointer mapping, so what is drawn, what is hit and what is inked cannot disagree.

import type { Frame } from '../contracts/frame';
import type { Box, LensView } from '../contracts/space';
export { cssOf, isRest, toPage, toScreen } from '../contracts/space';
import { LEGIBLE, VIEW } from '../core/invariants';
import type { Lens, Screen } from '../wall/view';

export type { Lens, Screen };

/** The share of the page's own size a person may zoom out to when the page already fits: never under one. */
export const FIT_MAX = 1;

/** The smallest scale a person may be taken to by Fit: the body text is never fitted under its legible share. */
export function floorOf(screen: Screen): number {
  return Math.min(screen.width, screen.height) <= 600 ? VIEW.floor.phone : VIEW.floor.desk;
}

/** The smallest scale a page is fitted to: the view's floor, and never so small that body text of `bodyPx` falls under the legible size. At most one to one. */
export function legibleFloor(screen: Screen, bodyPx: number): number {
  const phone = Math.min(screen.width, screen.height) <= 600;
  return Math.min(FIT_MAX, Math.max(floorOf(screen), (phone ? LEGIBLE.floor.phone : LEGIBLE.floor.desk) / Math.max(1, bodyPx)));
}

/**
 * Where a lens arrives on a page: the whole page when it fits, down to `floor`, else start-aligned at the top and left on an axis that does
 * not fit and centred on one that does. Never larger than one to one.
 */
export function fitLens(page: Box, screen: Screen, floor: number = floorOf(screen)): Lens {
  const whole = Math.min(screen.width / page.width, screen.height / page.height);
  const scale = Math.min(FIT_MAX, Math.max(whole, floor));
  const spanX = screen.width / scale;
  const spanY = screen.height / scale;
  const x = spanX >= page.width ? page.x + page.width / 2 : page.x + spanX / 2;
  const y = spanY >= page.height ? page.y + page.height / 2 : page.y + spanY / 2;
  return { x, y, scale };
}

/** The lens as the frame carries it: the page point at the screen's top-left. */
export function viewOf(lens: Lens, screen: Screen): LensView {
  return { x: lens.x - screen.width / 2 / lens.scale, y: lens.y - screen.height / 2 / lens.scale, scale: lens.scale, width: screen.width, height: screen.height };
}

/** The longest side a picture of a whole grown page is taken at. */
export const PAGE_STILL_SIDE = 1568;

/** Whether a frame is of a page taller than its screen. */
export function isGrown(frame: Pick<Frame, 'page' | 'viewport'>): boolean {
  return frame.page !== undefined && frame.page.height > frame.viewport.height + 1;
}

/**
 * The frame as a still of the whole page, for sight, the snapshot and the critic: a screen as tall as the page with the camera trucked down to the page's middle, so every
 * unit lies where the lens would have it at one to one. A frame that is not grown is returned as it is.
 */
export function wholePage(frame: Frame): Frame {
  if (!isGrown(frame)) return frame;
  const page = frame.page as Box;
  const { page: _page, view: _view, ...rest } = frame;
  return { ...rest, viewport: { ...frame.viewport, height: page.height }, camera: { ...frame.camera, y: frame.camera.y + (page.height - frame.viewport.height) / 2 } };
}

/** The long side a still of `frame` is taken at: the given side for a screen, and as much more for a tall page as keeps its type readable, to the cap. */
export function stillSide(frame: Frame, side: number): number {
  if (!isGrown(frame)) return side;
  const tall = (frame.page as Box).height / frame.viewport.height;
  return Math.min(PAGE_STILL_SIDE, Math.round(side * Math.max(1, tall)));
}
