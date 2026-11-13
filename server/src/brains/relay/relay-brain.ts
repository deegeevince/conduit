import type { Brain } from '../../domain/brain';
import type { RelayHub } from './relay-hub';

/** The brain whose mind is somewhere else: an agent on the other side of the relay API. */
export function createRelayBrain(hub: RelayHub): Brain {
  return {
    id: 'relay',
    respond: (request, signal) => hub.offer(request, signal),
  };
}
