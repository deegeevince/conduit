// kinds/button.ts: The `button` control, the control engine of today (`painter/controls/engine.ts`) wrapped.

import { seal } from '../seal';
import { controlKind } from './adapt-control';

export const button = seal(controlKind({ id: 'button', fixtures: [['button b1 | Show me']] }));
