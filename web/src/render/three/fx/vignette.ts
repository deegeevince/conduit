import type { Effect } from '.';
import type { FxShared } from './shared';

/** The corners fall off by 35%; done in the screen pass (see screen.ts). */
export function createVignette(shared: FxShared): Effect {
  return {
    name: 'vignette',
    apply(_tools, _stage, _frame, amount) {
      shared.screen.vignette = amount;
    },
    dispose() {},
  };
}
