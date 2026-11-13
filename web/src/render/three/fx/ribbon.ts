import type { Effect } from '.';

/** Ink density varying along the line and per dot. It lives in the text shader; the pipeline hands the amount to the text pool through the style. */
export function createRibbon(): Effect {
  return {
    name: 'ribbon',
    apply() {},
    dispose() {},
  };
}
