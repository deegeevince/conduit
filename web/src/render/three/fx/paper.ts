import type { Effect } from '.';
import type { FxShared } from './shared';

/** A fibre tooth and a lamp's falloff; ink multiplies onto it. The sheet in the scene draws the fibre (see sheet.ts). */
export function createPaper(shared: FxShared): Effect {
  return {
    name: 'paper',
    apply(_tools, _stage, _frame, amount) {
      shared.sheet.paper = amount;
    },
    dispose() {},
  };
}
