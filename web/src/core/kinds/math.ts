// kinds/math.ts: a written method, laid out as on paper. The engine is `painter/blocks/math.ts`; the grid it lays out is the language's (`maths/written.ts`).

import { layoutMath } from '../../painter/blocks/math';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const math = seal(
  structureKind({
    id: 'math',
    engine: layoutMath,
    fit: 'reflow',
    fixtures: [['math m1 column | 12+12+12+12+12+12'], ['math m2 column | 503 - 278'], ['math m3 times | 47 × 6'], ['math m4 split | 347'], ['math m5 bond | 10 = 4 + ?']],
  }),
);
