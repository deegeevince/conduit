import type { Effect } from '.';
import type { FxShared } from './shared';

/** Green-bar fanfold: the sheet in the scene draws it (see sheet.ts). */
export function createBars(shared: FxShared): Effect {
  return {
    name: 'bars',
    apply(_tools, _stage, _frame, amount) {
      shared.sheet.bars = amount;
    },
    dispose() {},
  };
}
