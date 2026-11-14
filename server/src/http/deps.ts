import type { AppStatus } from '@conduit/language';
import type { RelayHub } from '../brains/relay/relay-hub';
import type { AssetStore } from '../domain/assets';
import type { Conductor } from '../domain/conductor';
import type { Audit } from '../audit';
import type { Env } from '../env';
import type { KillSwitch } from '../kill';
import type { Logger } from '../log';

/** What the HTTP edge is allowed to reach. */
export interface HttpDeps {
  readonly env: Env;
  readonly log: Logger;
  readonly conductor: Conductor;
  readonly relayHub: RelayHub;
  /** v2.1 ops. The audit trail: what refused requests and the owner's own routes (kill, settings) write to, and what `/api/audit` reads */
  readonly audit: Audit;
  /** v2.1 ops. The kill switch's memory: agent tools are off while it is engaged */
  readonly kill: KillSwitch;
  readonly assets: AssetStore;
  /** the steward's status for the brief's note about the app; read without waiting */
  readonly status: () => AppStatus | null;
  /** the changelog's newest section, for a turn that asks what is new; read without waiting */
  readonly news: () => string | null;
}
