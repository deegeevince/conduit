// kinds/map.ts: The `map` engine (pins where the brain put them) wrapped; its code stays in `painter/blocks/map.ts`.

import { layoutMap } from '../../painter/blocks/map';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const map = seal(
  structureKind({
    id: 'map',
    engine: layoutMap,
    fit: 'contain',
    fixtures: [
    ['map m1 | The trip', 'node 40,30 | Home', 'node 110,60 | The coast', 'node 80,20 | The hills'],
    ],
  }),
);
