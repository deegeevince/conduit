import type { Brain } from '../../domain/brain';
import type { RelayHub } from './relay-hub';

/**
 * The brain whose mind is somewhere else: an agent on the other side of the relay API (the steward's own Claude Code session, through
 * `pnpm relay`). It can look at its draft like any other: the look is offered to the same claimer as one more thing to answer.
 */
export function createRelayBrain(hub: RelayHub): Brain {
  return {
    id: 'relay',
    respond: (request, signal) => hub.offer(request, signal),
    review: (request, signal) => hub.offerReview(request, signal),
  };
}
