import type { Effect } from '.';
import type { FxShared } from './shared';

/** Things on fg cast a soft contact shadow on the sheet; the compose pass lays it (see compose.ts). */
export function createShadow(shared: FxShared): Effect {
  return {
    name: 'shadow',
    apply(_tools, _stage, _frame, amount) {
      shared.shadow = amount;
    },
    dispose() {},
  };
}
