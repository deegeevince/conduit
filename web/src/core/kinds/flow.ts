// kinds/flow.ts: The `flow` engine (steps joined by arrows) wrapped; its code stays in `painter/blocks/flow.ts`.

import { layoutFlow } from '../../painter/blocks/flow';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const flow = seal(
  structureKind({
    id: 'flow',
    engine: layoutFlow,
    fit: 'contain',
    fixtures: [
    ['flow f1 | Signing in', 'node a | Enter your email', 'node b from=a | Check the password', 'node c from=b:yes | Open the app', 'node d from=b:no | Show an error'],
    ],
  }),
);
