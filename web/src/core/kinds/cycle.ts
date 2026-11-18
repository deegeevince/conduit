// kinds/cycle.ts: The `cycle` engine (nodes round a ring) wrapped; its code stays in `painter/blocks/cycle.ts`.

import { layoutCycle } from '../../painter/blocks/cycle';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const cycle = seal(
  structureKind({
    id: 'cycle',
    engine: layoutCycle,
    fit: 'contain',
    fixtures: [
    ['cycle c1 | Water', 'node e | Evaporates', 'node d | Condenses', 'node r | Rains'],
    ],
  }),
);
