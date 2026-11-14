// kinds/input.ts: PLAN-v3-core 2.3, package PC1. The `input` control, the control engine of today (`painter/controls/engine.ts`) wrapped.

import { seal } from '../seal';
import { controlKind } from './adapt-control';

export const input = seal(controlKind({ id: 'input', fixtures: [['input i1 | Your name']] }));
