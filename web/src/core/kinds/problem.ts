// kinds/problem.ts: the old maths question. A `problem` line is an ordinary `ask` now (the language turns it into one before the stage sees it), so
// the stage never holds one and the painter does not advertise the word. It is in the vocabulary so that old logs parse, and typed "not yet" here.

import { notYet } from './not-yet';

export const problem = notYet('problem', 'no longer drawn: a `problem` line plays as an `ask` (normalize.ts), so the painter does not advertise it', [['problem p1 answer=12 | 48 ÷ 4 = ___']]);
