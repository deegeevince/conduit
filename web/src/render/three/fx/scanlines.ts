import type { Effect } from '.';
import type { FxShared } from './shared';

/** One line pair per tenth of body size, off below 3 device pixels a line; done in the screen pass (see screen.ts). */
export function createScanlines(shared: FxShared): Effect {
  return {
    name: 'scanlines',
    apply(_tools, _stage, _frame, amount) {
      shared.screen.scanlines = amount;
    },
    dispose() {},
  };
}
