// `seal(kind)`: a kind with its own model and layout types hidden. Inside its file a kind is `Kind<K, M, L>` and every
// function is checked against its own `M` and `L`. In the registry it is `Sealed<K>`, whose model and layout are opaque tokens that only
// the same kind's functions accept; so the registry needs no `any`, and a model of one kind cannot be handed to another kind's `layout`
// by the types (at run time they are the same objects, unchanged).
//
// The one cast in the core's contracts is here, and it is a brand: nothing is converted, only named.

import type { KindId } from '../../../language/src/kinds';
import type { Kind, Sealed } from './contracts';

export function seal<K extends KindId, M, L>(kind: Kind<K, M, L>): Sealed<K> {
  return kind as unknown as Sealed<K>;
}
