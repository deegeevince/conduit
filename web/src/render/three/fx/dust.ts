import type { Effect } from '.';
import type { FxShared } from './shared';

/** Chalk haze where marks have been wiped; the compose pass lays it (see compose.ts). */
export function createDust(shared: FxShared): Effect {
  return {
    name: 'dust',
    apply(_tools, _stage, _frame, amount) {
      shared.dust = amount;
    },
    reset(tools) {
      tools.clearFeedback('dust');
    },
    dispose() {},
  };
}
