// kinds/words.ts: Words: `say`, a heading, a caption. Today the timeline sets them (`painter/timeline.ts`), which
// this package must not touch; PC6 builds the `reflow` leaf and the stage that holds it.

import { notYet } from './not-yet';

export const words = notYet('words', 'set by the old timeline until PC6 (the stage and its words)', [['say | A sentence that wraps when the stage is narrow, and one more after it.']]);
