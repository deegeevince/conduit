import type { HexColor, Medium } from '@conduit/language';

/** What the domain asks an image model for. It knows nothing of any provider. */
export interface ImageRequest {
  /** what to paint, in the brain's words */
  readonly prompt: string;
  readonly medium: Medium | null;
  /** the look's ground, ink, accent and alt, so the painting belongs on the stage it lands on */
  readonly palette: readonly HexColor[];
  /** width over height of the box the picture will fill */
  readonly aspect: number;
  /**
   * The painter's rendering of the sketch the picture stands on, PNG, when one
   * arrived in time. A model that can paint over an image keeps the
   * composition; one that cannot paints from the words alone.
   */
  readonly sketch: Uint8Array | null;
}

export interface ImageResult {
  readonly bytes: Uint8Array;
  readonly mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** what the provider says it cost, when it says */
  readonly costUsd: number | null;
}

/**
 * An image model behind a port. The domain owns this interface; a provider's
 * HTTP API sits behind it in exactly one file.
 *
 * Contract:
 * - `available` is false for the adapter that stands in when no provider is
 *   configured; `generate` is then never called.
 * - `generate` resolves with the picture or throws `AppError` (`image_failed`,
 *   `image_timeout`). It honours `signal` and never retries by itself: a
 *   painting that fails is skipped, the sketch stays, and nothing waits.
 * - It never logs the key, the prompt at `info`, or the picture.
 */
export interface ImageModel {
  readonly id: string;
  readonly available: boolean;
  generate(request: ImageRequest, signal: AbortSignal): Promise<ImageResult>;
}
