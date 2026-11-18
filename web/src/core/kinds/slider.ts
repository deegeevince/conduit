// kinds/slider.ts: The `slider` control, the control engine of today (`painter/controls/engine.ts`) wrapped.

import { seal } from '../seal';
import { controlKind } from './adapt-control';

export const slider = seal(controlKind({ id: 'slider', fixtures: [['slider s1 0 10 4 step=1 unit=m | Height']] }));
