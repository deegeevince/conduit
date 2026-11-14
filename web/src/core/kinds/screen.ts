// kinds/screen.ts: PLAN-v3-core 2.3, package PC1. The interface kit's mock-up (`painter/ui-stage.ts` `layoutUi`) wrapped: the same lines laid out
// on a board and drawn as finished frames, which the leaf hands on as `Drawn.frames`. It reads the look itself (`Env.legacy.look`) until
// PC9 gives the kit its tokens by `Env`.
//
// `layoutUi` keeps what a finger did to a block in a module map keyed by the block's key (review F1). An adapter must be pure, so it
// forgets the block after every layout: a leaf here is always a mock-up at rest and untouched. A hand's taps reach it by PC9, as `held`.

import { forgetUi, layoutUi } from '../../painter/ui-stage';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const screen = seal(
  structureKind({
    id: 'screen',
    engine: (input, env) => {
      const made = layoutUi({ structure: input.structure, room: input.room, spec: env.legacy.look, dpr: env.dpr });
      forgetUi(input.structure.key);
      return made;
    },
    fit: 'contain',
    fill: true,
    fixtures: [
      [
        'screen s1 phone | Sign in',
        'nav close | Sign in',
        'col pad=l gap=m grow',
        'heading | Welcome back',
        'field | Email | you@example.com',
        'row spread',
        'toggle | Remember me',
        'note | Forgot password?',
        'end',
        'space grow',
        'button primary wide | Sign in',
        'end',
      ],
    ],
  }),
);
