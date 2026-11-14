// Chooses the critic and the queue its findings wait in. The rest of the server is handed a `Critic` and cannot tell which it has.

import { NO_CRITIC, NO_FINDING_QUEUE } from '../domain/critic';
import type { Critic, CriticPolicy, FindingQueue } from '../domain/critic';
import type { Logger } from '../log';
import type { Throttle, UsageMeter } from '../usage';
import { createLiveCritic } from './live';
import { createFileQueue } from './queue';

export interface CriticDeps {
  readonly policy: CriticPolicy;
  /** the `claude` binary the judge is run with: the brain's own, so one login serves both */
  readonly bin: string;
  readonly log: Logger;
  readonly now: () => number;
  /** v2.1 ops. Every judge call is metered here, and the critic stands down when the throttle says `near` or `over` */
  readonly meter?: UsageMeter;
  readonly throttle?: Throttle;
}

export function createCritic(deps: CriticDeps): Critic {
  return deps.policy.enabled ? createLiveCritic(deps) : NO_CRITIC;
}

/** `dir` is the repository's `loop/queue` folder; null (no log folder, or the critic off) queues nothing. */
export function createFindingQueue(dir: string | null, log: Logger): FindingQueue {
  return dir === null ? NO_FINDING_QUEUE : createFileQueue(dir, log);
}
