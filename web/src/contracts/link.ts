import type { BackEvent, BrainChange, BrainChoice, CreateSessionRequest, DemoInfo, StageEvent, TurnInput } from '@conduit/language';
import type { PainterUpload } from './painter';

export type LinkStatus =
  | 'connecting'
  | 'open'
  /** the stream dropped and is being retried */
  | 'reconnecting'
  | 'closed';

/**
 * The browser's view of whatever is on the other end. It carries the two
 * one-way streams and nothing else; it does not know which brain is answering.
 */
export interface StageLink {
  readonly status: LinkStatus;

  /** Creates the session from the painter's first `ready` and opens the stream. */
  connect(ready: CreateSessionRequest): Promise<void>;

  onEvent(listener: (event: StageEvent) => void): () => void;
  onStatus(listener: (status: LinkStatus) => void): () => void;

  /** Starts a turn. Everything queued with `send`, including what the painter emits in the same tick (the interruption report), travels inside the turn request, so the server applies it before it opens the turn. If the request fails the events stay queued. */
  startTurn(input: TurnInput): Promise<string>;

  /** Queues a back-channel event. Events are delivered in order, batched, and never block the frame loop. */
  send(event: BackEvent): void;

  /** Sends one of the painter's pictures to the server. Best effort: a failed upload is dropped with a note for the HUD and nothing waits for it. */
  upload(upload: PainterUpload): void;

  /** What this session's brain is set to (`/model`, `/effort`). */
  brain(): Promise<BrainChoice>;

  /** Sets the model and/or effort for this session only. Rejects with the server's sentence when the value is refused. */
  setBrain(change: BrainChange): Promise<BrainChoice>;

  flush(): Promise<void>;
  listDemos(): Promise<readonly DemoInfo[]>;
  close(): void;
}
