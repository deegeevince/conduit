// kinds/tune.ts: PLAN-v3-core 2.3, package PC1. The `tune` engine (a piano roll for ABC rows) wrapped; its code stays in `painter/blocks/tune.ts`.

import { layoutTune } from '../../painter/blocks/tune';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const tune = seal(
  structureKind({
    id: 'tune',
    engine: layoutTune,
    fit: 'contain',
    fixtures: [
    ['tune ode tempo=104 | Ode to joy', '| M:4/4', '| L:1/4', '| K:C', '| E E F G | G F E D | C C D E | E3/2 D/2 D2 |]'],
    ],
  }),
);
