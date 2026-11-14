// Chooses the critic and the queue its findings wait in. The rest of the server is handed a `Critic` and cannot tell which it has.
// STUB(PLAN-v2.1 package S3): build the real one behind `domain/critic.ts` (the judge in `server/src/judge/`, on the owner's login)
// and the queue file in `loop/queue/`. Until then every server has the critic that looks at nothing.

import { NO_CRITIC, NO_FINDING_QUEUE } from '../domain/critic';
import type { Critic, CriticPolicy, FindingQueue } from '../domain/critic';
import type { Logger } from '../log';

export interface CriticDeps {
  readonly policy: CriticPolicy;
  /** the `claude` binary the judge is run with: the brain's own, so one login serves both */
  readonly bin: string;
  readonly log: Logger;
  readonly now: () => number;
}

export function createCritic(_deps: CriticDeps): Critic {
  return NO_CRITIC;
}

/** `dir` is the repository's `loop/queue` folder; null (no log folder, or the critic off) queues nothing. */
export function createFindingQueue(_dir: string | null, _log: Logger): FindingQueue {
  return NO_FINDING_QUEUE;
}
