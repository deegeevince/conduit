import type { AppStatus } from '@conduit/language';
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
  /** the steward's status for the brief's note about the app; read without waiting */
  readonly status: () => AppStatus | null;
  /** the changelog's newest section, for a turn that asks what is new; read without waiting */
  readonly news: () => string | null;
}
