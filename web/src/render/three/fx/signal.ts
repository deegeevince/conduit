import type { Effect } from '.';
import type { FxShared } from './shared';

/** Jitter, snow and hum scaled by the mood's agitation; done in the screen pass (see screen.ts). */
export function createSignal(shared: FxShared): Effect {
  return {
    name: 'signal',
    apply(_tools, _stage, _frame, amount) {
      shared.screen.signal = amount;
    },
    dispose() {},
  };
}
