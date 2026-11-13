import type { RelayHub } from '../brains/relay/relay-hub';
import type { AssetStore } from '../domain/assets';
import type { Conductor } from '../domain/conductor';
import type { Env } from '../env';
import type { Logger } from '../log';

/** What the HTTP edge is allowed to reach. */
export interface HttpDeps {
  readonly env: Env;
  readonly log: Logger;
  readonly conductor: Conductor;
  readonly relayHub: RelayHub;
  readonly assets: AssetStore;
}
