// kinds/table.ts: The `table` engine (columns by content) wrapped; its code stays in `painter/blocks/table.ts`.

import { layoutTable } from '../../painter/blocks/table';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const table = seal(
  structureKind({
    id: 'table',
    engine: layoutTable,
    fit: 'reflow',
    fixtures: [
    ['table tb | Fruit', '| fruit | price | stock', '| apple | 2 | 40', '| *pear* | 3 | 12', '| plum | 4 | 7'],
    ],
  }),
);
