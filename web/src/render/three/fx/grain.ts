import type { Effect } from '.';
import type { FxShared } from './shared';

/** Fine film grain; done in the screen pass (see screen.ts). */
export function createGrain(shared: FxShared): Effect {
  return {
    name: 'grain',
    apply(_tools, _stage, _frame, amount) {
      shared.screen.grain = amount;
    },
    dispose() {},
  };
}
