// kinds/toggle.ts: PLAN-v3-core 2.3, package PC1. The `toggle` control, the control engine of today (`painter/controls/engine.ts`) wrapped.

import { seal } from '../seal';
import { controlKind } from './adapt-control';

export const toggle = seal(controlKind({ id: 'toggle', fixtures: [['toggle t1 on | Sound']] }));
