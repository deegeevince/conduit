import type { Effect } from '.';
import type { FxShared } from './shared';

/** Drafting squares every 10 canvas units, heavier every 50: part of the sheet (see sheet.ts). */
export function createGrid(shared: FxShared): Effect {
  return {
    name: 'grid',
    apply(_tools, _stage, _frame, amount) {
      shared.sheet.grid = amount;
    },
    dispose() {},
  };
}
