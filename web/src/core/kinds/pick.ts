// kinds/pick.ts: PLAN-v3-core 2.3, package PC1. The `pick` control, the control engine of today (`painter/controls/engine.ts`) wrapped.

import { seal } from '../seal';
import { controlKind } from './adapt-control';

export const pick = seal(controlKind({ id: 'pick', fixtures: [['pick p1 | Cat | Dog | Bird']] }));
