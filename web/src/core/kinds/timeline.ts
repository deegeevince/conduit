// kinds/timeline.ts: PLAN-v3-core 2.3, package PC1. The `timeline` engine (nodes on an axis, to scale) wrapped; its code stays in `painter/blocks/timeline.ts`.

import { layoutTimeline } from '../../painter/blocks/timeline';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const timeline = seal(
  structureKind({
    id: 'timeline',
    engine: layoutTimeline,
    fit: 'contain',
    fixtures: [
    ['timeline tl | The space race', 'node 1957 | Sputnik', 'node 1961 | Gagarin', 'node 1969 | Apollo 11'],
    ],
  }),
);
