import type { Effect } from '.';
import type { FxShared } from './shared';

/** Corner displacement of the glass is 2 x this x amount (about 5% at amount 1). */
export const CURVE = 0.025;

/** A 5% barrel curve with rounded corners; done in the screen pass (see screen.ts). */
export function createCurve(shared: FxShared): Effect {
  return {
    name: 'curve',
    apply(_tools, _stage, _frame, amount) {
      shared.screen.curve = amount;
    },
    toPicture(x, y, viewport, amount) {
      const px = (x / viewport.width) * 2 - 1;
      const py = (y / viewport.height) * 2 - 1;
      const k = 1 + CURVE * amount * (px * px + py * py);
      return { x: (px * k * 0.5 + 0.5) * viewport.width, y: (py * k * 0.5 + 0.5) * viewport.height };
    },
    dispose() {},
  };
}
