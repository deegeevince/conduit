// Pictures in and out: paintings to the painter, sketches and snapshots from it.

import { API } from '@conduit/language';
import type { Context, Hono } from 'hono';
import { ASSET_LIMITS } from '../domain/assets';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { param } from './json';

const KEY_CHARS = 128;

function mediaType(c: Context): string {
  return (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** The body of an upload, which must be exactly `mime` and no larger than the limit; the limit is also enforced as the body streams in, by the middleware. */
async function pictureBody(c: Context, mime: string): Promise<Uint8Array> {
  if (mediaType(c) !== mime) throw errors.unsupportedMedia(mime);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > ASSET_LIMITS.uploadBytes) throw errors.tooLarge(ASSET_LIMITS.uploadBytes);
  if (bytes.byteLength === 0) throw errors.badRequest('the body is empty');
  return bytes;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((value, at) => bytes[at] === value);
}

/** Width and height from a JPEG's first start-of-frame marker; null when the bytes are not a JPEG. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) return { height: ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0), width: ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0) };
    at += 2 + length;
  }
  return { width: 0, height: 0 };
}

/**
 * - `GET  API.asset(session, id)`: the bytes of a painting with its own
 *   Content-Type, `Cache-Control: private, max-age=31536000, immutable`.
 *   404 `not_found` once the session has dropped it.
 * - `POST API.sketch(session, key)`: body `image/png`, at most
 *   ASSET_LIMITS.uploadBytes. 204. The painter's rendering of the sketch a
 *   picture element stands on; handed to the image model if it arrives within
 *   ASSET_LIMITS.sketchWaitMs of the `paint` line, otherwise dropped.
 * - `POST API.snapshot(session, turn)`: body `image/jpeg`, same limit. 204.
 *   Kept for the next brief and saved beside the session log.
 * - `GET  API.snapshot(session, turn)`: that picture back; 404 if there is none.
 *
 * - `POST API.draft(session, turn, pass)`: body `image/jpeg`, same limit. 204.
 *   The stage as that pass of an open turn will leave it: what the brain is
 *   shown when it looks at its draft. Held for the look and the log, not for
 *   the next brief.
 * - `GET  API.data(session, id)`: the rows of a table the conversation holds,
 *   as a `DataTable`; 404 when there is none.
 *
 * Any other Content-Type on the POSTs is 415. Every route answers errors in
 * the usual `{ code, message, statusCode }` shape.
 */
export function registerAssetRoutes(app: Hono, deps: HttpDeps): void {
  const { conductor, assets } = deps;

  app.get(API.asset(':session', ':asset'), (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    const asset = assets.painting(session, param(c, 'asset'));
    if (asset === undefined) throw errors.notFound('painting');
    c.header('Content-Type', asset.mime);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(asset.bytes as Uint8Array<ArrayBuffer>);
  });

  app.post('/api/sessions/:session/sketches/:key', async (c) => {
    const session = param(c, 'session');
    const key = param(c, 'key');
    if (key.length > KEY_CHARS) throw errors.badRequest('the sketch key is too long');
    conductor.assertSession(session);
    const bytes = await pictureBody(c, 'image/png');
    if (!isPng(bytes)) throw errors.badRequest('the body is not a PNG');
    assets.putSketch(session, key, bytes);
    return c.body(null, 204);
  });

  app.post(API.snapshot(':session', ':turn'), async (c) => {
    const session = param(c, 'session');
    const turn = param(c, 'turn');
    conductor.assertSession(session);
    const bytes = await pictureBody(c, 'image/jpeg');
    const size = jpegSize(bytes);
    if (size === null) throw errors.badRequest('the body is not a JPEG');
    conductor.receiveSnapshot(session, turn, { mime: 'image/jpeg', bytes, ...size });
    return c.body(null, 204);
  });

  app.post('/api/sessions/:session/turns/:turn/drafts/:pass', async (c) => {
    const session = param(c, 'session');
    const turn = param(c, 'turn');
    const pass = Number(param(c, 'pass'));
    if (!Number.isInteger(pass) || pass < 1 || pass > 8) throw errors.badRequest('the pass is not a number from 1 to 8');
    conductor.assertSession(session);
    const bytes = await pictureBody(c, 'image/jpeg');
    const size = jpegSize(bytes);
    if (size === null) throw errors.badRequest('the body is not a JPEG');
    conductor.receiveDraftPicture(session, turn, pass, { mime: 'image/jpeg', bytes, ...size });
    return c.body(null, 204);
  });

  app.get(API.data(':session', ':id'), (c) => {
    const session = param(c, 'session');
    const table = conductor.dataFor(session, param(c, 'id'));
    if (table === undefined) throw errors.notFound('data');
    c.header('Cache-Control', 'no-store');
    return c.json(table);
  });

  app.get(API.snapshot(':session', ':turn'), (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    const snapshot = assets.snapshot(session, param(c, 'turn'));
    if (snapshot === undefined) throw errors.notFound('snapshot');
    c.header('Content-Type', snapshot.mime);
    c.header('Cache-Control', 'no-store');
    return c.body(snapshot.bytes as Uint8Array<ArrayBuffer>);
  });
}
