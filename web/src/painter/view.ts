// The lens as pure geometry (PLAN-canvas). A lens is the page point at the centre of the screen and the screen pixels one page unit takes; the
// screen is a window of fixed size. Nothing here draws, measures or reads the DOM: the same numbers go to the renderer, the DOM layers and the
// pointer mapping, so what is drawn, what is hit and what is inked cannot disagree.

import type { Box, LensView } from '../contracts/space';
export { cssOf, isRest, toPage, toScreen } from '../contracts/space';
import { VIEW } from '../core/invariants';
import type { Lens, Screen } from '../wall/view';

export type { Lens, Screen };

/** The share of the page's own size a person may zoom out to when the page already fits: never under one. */
export const FIT_MAX = 1;

/** The smallest scale a person may be taken to by Fit: the body text is never fitted under its legible share. */
export function floorOf(screen: Screen): number {
  return Math.min(screen.width, screen.height) <= 600 ? VIEW.floor.phone : VIEW.floor.desk;
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
