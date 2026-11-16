// kinds/problem.ts: a maths question to work out. The stage draws nothing for it: the page's problem workspace (`app/problem-view.ts`, drawn by
// `painter/problem`) takes the whole screen while one is on stage, as work mode does for an ask. The kind is here so the registry is complete and the
// painter advertises the word; every function is total and draws nothing.

import { NOTHING_DRAWN } from '../contracts';
import type { Kind } from '../contracts';
import { seal } from '../seal';

const kind: Kind<'problem', null, null> = {
  id: 'problem',
  status: { state: 'ready' },
  model: () => null,
  measure: () => ({ width: 0, height: 0, least: { width: 0, height: 0 }, fit: 'reflow' }),
  layout: () => null,
  draw: () => NOTHING_DRAWN,
  census: () => ({ words: [], regions: [] }),
  input: null,
  fixtures: [],
};

export const problem = seal(kind);
