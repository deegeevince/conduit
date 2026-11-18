// A kind the registry knows by name and the new core cannot draw yet: a typed "not yet". It keeps the registry complete, so a scene that holds
// it routes to the old core, and it keeps its fixtures for the builder who makes it ready. Every
// function is total and draws nothing; `status` says why, by name.

import type { KindId } from '../../../../language/src/kinds';
import { NOTHING_DRAWN } from '../contracts';
import type { Kind } from '../contracts';
import { seal } from '../seal';

export function notYet<K extends KindId>(id: K, why: string, fixtures: readonly (readonly string[])[]) {
  const kind: Kind<K, null, null> = {
    id,
    status: { state: 'not-yet', why },
    model: () => null,
    measure: () => ({ width: 0, height: 0, least: { width: 0, height: 0 }, fit: 'reflow' }),
    layout: () => null,
    draw: () => NOTHING_DRAWN,
    census: () => ({ words: [], regions: [] }),
    input: null,
    fixtures,
  };
  return seal(kind);
}
