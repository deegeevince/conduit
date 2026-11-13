// The only module that knows the OpenAI Images API. Nothing else names its
// URLs, its fields or its key.
//
// NOT TESTED AGAINST THE REAL SERVICE. The owner has not approved spending on
// it, so this adapter has only ever been run against a local stand-in. Once a
// key is approved: run acceptance item 9 of package S3 in PLAN-v1.md, then
// replace this paragraph with the date and what was confirmed.

import { MEDIUM } from '@conduit/language';
import { AppError, errors } from '../../errors';
import type { ImageModel, ImageRequest, ImageResult } from '../../domain/images';
import type { Logger } from '../../log';

export interface OpenAiImagesDeps {
  readonly log: Logger;
  readonly apiKey: string;
  /** default `gpt-image-1` */
  readonly model: string;
  readonly quality: 'low' | 'medium' | 'high';
  readonly timeoutMs: number;
  /** the API origin; overridden only to point at a stand-in */
  readonly baseUrl: string;
  /** injected so the adapter can be run against a stand-in without the network */
  readonly fetch: typeof fetch;
}

const SQUARE = '1024x1024';
const WIDE = '1536x1024';
const TALL = '1024x1536';

function sizeFor(aspect: number): string {
  if (!Number.isFinite(aspect) || aspect <= 0) return SQUARE;
  if (aspect >= 1.25) return WIDE;
  if (aspect <= 0.8) return TALL;
  return SQUARE;
}

function promptFor(request: ImageRequest): string {
  const parts = [request.prompt.trim()];
  if (request.medium !== null) parts.push(`Medium: ${MEDIUM[request.medium]}.`);
  if (request.palette.length > 0) parts.push(`Palette: ${request.palette.join(', ')}.`);
  parts.push('No text, no lettering, no border.');
  return parts.join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function providerMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  return fallback;
}

function costOf(body: Record<string, unknown>): number | null {
  const usage = body.usage;
  if (!isRecord(usage)) return null;
  for (const key of ['cost_usd', 'cost']) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function mimeOf(bytes: Uint8Array): ImageResult['mime'] {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  return 'image/png';
}

/**
 * Paints through OpenAI.
 *
 * - With a sketch: `POST {baseUrl}/v1/images/edits`, multipart, the sketch as
 *   the image and the words as the prompt, so the composition is kept.
 * - Without: `POST {baseUrl}/v1/images/generations`, JSON.
 * - The size is the nearest the model offers to the request's aspect
 *   (1024x1024, 1536x1024, 1024x1536). The answer's `b64_json` is decoded.
 * - The prompt sent is the brain's words, then the medium, then the palette as
 *   hex values, then "no text, no lettering, no border".
 * - A non-2xx answer, a refusal, or a timeout throws `image_failed` /
 *   `image_timeout` with the provider's message; nothing is retried.
 * - The key is sent in the Authorization header and appears nowhere else:
 *   not in a log line, not in an error message.
 */
export function createOpenAiImages(deps: OpenAiImagesDeps): ImageModel {
  const log = deps.log.child({ component: 'openai-images' });

  async function generate(request: ImageRequest, signal: AbortSignal): Promise<ImageResult> {
    const size = sizeFor(request.aspect);
    const prompt = promptFor(request);
    const withSketch = request.sketch !== null && request.sketch.length > 0;
    const endpoint = withSketch ? '/v1/images/edits' : '/v1/images/generations';
    const timeout = AbortSignal.timeout(deps.timeoutMs);
    const started = Date.now();

    const headers: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
    let body: string | FormData;
    if (withSketch && request.sketch !== null) {
      const form = new FormData();
      form.set('model', deps.model);
      form.set('prompt', prompt);
      form.set('size', size);
      form.set('quality', deps.quality);
      form.set('n', '1');
      form.set('image', new Blob([new Uint8Array(request.sketch)], { type: 'image/png' }), 'sketch.png');
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ model: deps.model, prompt, size, quality: deps.quality, n: 1 });
    }

    let response: Response;
    let parsed: unknown;
    try {
      response = await deps.fetch(`${deps.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.any([signal, timeout]),
      });
      const text = await response.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text.length > 0 ? { error: { message: text.slice(0, 200) } } : null;
      }
    } catch (cause) {
      if (timeout.aborted) throw errors.imageTimeout(`the image model did not answer within ${deps.timeoutMs} ms`);
      if (signal.aborted) throw errors.imageFailed('the painting was cancelled', cause);
      throw errors.imageFailed('the image model could not be reached', cause);
    }

    if (!response.ok) {
      const message = providerMessage(parsed, `the image model answered ${response.status}`);
      log.warn('image_rejected', { status: response.status, endpoint, size, message });
      throw errors.imageFailed(message);
    }

    const data = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data[0] : undefined;
    const encoded = isRecord(data) && typeof data.b64_json === 'string' ? data.b64_json : null;
    if (encoded === null || !isRecord(parsed)) {
      log.warn('image_malformed', { endpoint, size });
      throw errors.imageFailed('the image model answered without a picture');
    }
    const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (bytes.length === 0) throw errors.imageFailed('the image model answered with an empty picture');

    const costUsd = costOf(parsed);
    log.info('image_made', { endpoint, size, quality: deps.quality, bytes: bytes.length, ms: Date.now() - started, costUsd });
    return { bytes, mime: mimeOf(bytes), costUsd };
  }

  return {
    id: `openai:${deps.model}`,
    available: true,
    generate: async (request, signal) => {
      try {
        return await generate(request, signal);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw errors.imageFailed('the image model failed', error);
      }
    },
  };
}
