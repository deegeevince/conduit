// kinds/tree.ts: PLAN-v3-core 2.3, package PC1. The `tree` engine (a tidy tree) wrapped; its code stays in `painter/blocks/tree.ts`.

import { layoutTree } from '../../painter/blocks/tree';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const tree = seal(
  structureKind({
    id: 'tree',
    engine: layoutTree,
    fit: 'contain',
    fixtures: [
    ['tree t1 | The family', 'node g | Grandma', 'node m from=g | Mum', 'node u from=g | Uncle Joe', 'node k from=m | Kit'],
    ],
  }),
);
