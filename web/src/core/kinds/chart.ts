// kinds/chart.ts: PLAN-v3-core 2.3, package PC1. A chart is not drawn from shapes: it is a surface the charting engine fills (`painter/charts.ts`
// builds its state from the schedule, `app/chart-host.ts` runs it). This adapter is the box and the surface's place in it, with no
// placeholder drawn; PC12 gives it the rest. Ready where there is a charting host, as `Capabilities.structures` has it today.

import { EMPTY_STRUCTURE_LAYOUT } from '../../contracts/blocks';
import type { StructureEngine } from '../../contracts/blocks';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

const boxOnly: StructureEngine = (input) => ({ ...EMPTY_STRUCTURE_LAYOUT, boxes: new Map([[input.structure.key, input.room]]) });

export const chart = seal(
  structureKind({
    id: 'chart',
    engine: boxOnly,
    fit: 'contain',
    status: { state: 'host', host: 'chart' },
    surface: 'chart',
    fixtures: [['chart ch line | Sales', '| 2021 | 4', '| 2022 | 7', '| 2023 | 11']],
  }),
);
