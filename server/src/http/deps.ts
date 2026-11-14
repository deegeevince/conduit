import type { AppStatus } from '@conduit/language';
import type { RelayHub } from '../brains/relay/relay-hub';
import type { AssetStore } from '../domain/assets';
import type { DocumentAssets } from '../documents/assets';
import type { Conductor } from '../domain/conductor';
import type { PictureService } from '../domain/pictures';
import type { UploadStore } from '../domain/uploads';
import type { VoiceNotes } from '../domain/voice';
import type { Audit } from '../audit';
import type { Env } from '../env';
import type { KillSwitch } from '../kill';
import type { UsageMeter } from '../usage';
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
  /** v2.1 ops. The usage meter: what `/api/usage` summarises */
  readonly usage: UsageMeter;
  readonly assets: AssetStore;
  /** v3. What a document keeps beside its words: the cut of the photo for each question, and her strokes */
  readonly docAssets: DocumentAssets;
  /** v2.2. Photographs found for the `image` parts of a mock-up: what `GET /api/pictures/:key` serves */
  readonly pictures: PictureService;
  /** v2.1. The user's photos: what `POST /api/sessions/:id/uploads` keeps and the painter draws */
  readonly uploads: UploadStore;
  /** v2.1. The user's voice notes: what `POST /api/sessions/:id/voice` reads on this Mac and gives back as words */
  readonly voice: VoiceNotes;
  /** the steward's status for the brief's note about the app; read without waiting */
  readonly status: () => AppStatus | null;
  /** the changelog's newest section, for a turn that asks what is new; read without waiting */
  readonly news: () => string | null;
}
