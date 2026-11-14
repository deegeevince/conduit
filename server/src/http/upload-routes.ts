// The owner's photos: in (a camera, a paste, a drop, a picker), and back out for the painter to draw.

import { API } from '@conduit/language';
import type { UploadResponse } from '@conduit/language';
import type { Hono } from 'hono';
import type { StoredUpload, UploadCrop } from '../domain/uploads';
import { AppError, errors } from '../errors';
import type { HttpDeps } from './deps';
import { param } from './json';

/**
 * - `POST API.uploads(session)`: the body is the photo itself, whatever its Content-Type says; what it is is read from its bytes (JPEG, PNG,
 *   WebP or HEIC) and at most `UPLOAD_LIMITS.bytes`. It is converted and shrunk to a JPEG, every piece of metadata (the place it was taken among
 *   them) is dropped, and the JPEG is kept in the data folder. 201 `UploadResponse`; 413 too large, 415 not a picture it knows, 409 too many.
 *   Each one is in the audit trail (kind `upload`) and the session's log, by id and size.
 *   `?crop=x,y,w,h` (fractions of the upright photo from its top left) keeps only that part, as the answer's photo, and keeps the whole page beside
 *   it under its own id, given as `whole`.
 * - `POST /api/sessions/:session/uploads/:id/crop`, body `{ x, y, w, h }` (fractions of the photo as kept under `id`): a new photo that is that part, 201
 *   with its own id; `id` itself is left as it was, so a page can be framed again for another question.
 * - `GET  API.upload(session, id)`: the kept JPEG; 404 when this conversation has no such photo. What `pic u1` draws.
 */
/** `?crop=x,y,w,h`: fractions of the upright photo from its top left; absent: the whole photo. */
function cropOf(text: string | undefined): UploadCrop | undefined {
  if (text === undefined || text === '') return undefined;
  const parts = text.split(',').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) throw errors.badRequest('crop must be x,y,w,h: four fractions of the photo, from its top left');
  return { x: parts[0] ?? 0, y: parts[1] ?? 0, w: parts[2] ?? 0, h: parts[3] ?? 0 };
}

function said(stored: StoredUpload): UploadResponse & { readonly whole?: UploadResponse } {
  const answer = { id: stored.id, mime: stored.mime, width: stored.width, height: stored.height, bytes: stored.bytes };
  return stored.whole === undefined ? answer : { ...answer, whole: said(stored.whole) };
}

export function registerUploadRoutes(app: Hono, deps: HttpDeps): void {
  const { conductor, uploads, audit } = deps;

  /** Every photo taken is in the audit trail and the session's log, by id and size. */
  const noted = (session: string, stored: StoredUpload, how: string): void => {
    audit.record({ kind: 'upload', session, tool: 'upload', target: `${stored.id} ${stored.width}x${stored.height}, ${stored.bytes} bytes`, decision: 'allowed', decidedBy: 'policy', note: `${how}; kept as ${stored.file}; metadata removed` });
    conductor.noteUpload(session, stored);
    if (stored.whole !== undefined) noted(session, stored.whole, 'the whole page, kept beside its crop');
  };
  const refused = (session: string, cause: unknown, what: string): void => {
    if (cause instanceof AppError) audit.record({ kind: 'upload', session, tool: 'upload', target: what, decision: 'denied', decidedBy: 'policy', note: cause.message });
  };

  app.post(API.uploads(':session'), async (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    if (!uploads.available) throw errors.forbidden('photos are switched off on this server');
    const crop = cropOf(c.req.query('crop'));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      const stored = await uploads.put(session, bytes, crop);
      noted(session, stored, crop === undefined ? 'taken' : 'taken, cropped');
      return c.json(said(stored), 201);
    } catch (cause) {
      refused(session, cause, `${bytes.byteLength} bytes`);
      throw cause;
    }
  });

  app.post('/api/sessions/:session/uploads/:id/crop', async (c) => {
    const session = param(c, 'session');
    const id = param(c, 'id');
    conductor.assertSession(session);
    if (!uploads.available) throw errors.forbidden('photos are switched off on this server');
    const raw: unknown = await c.req.json().catch(() => null);
    const box = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    try {
      const stored = await uploads.recrop(session, id, { x: Number(box['x']), y: Number(box['y']), w: Number(box['w']), h: Number(box['h']) });
      noted(session, stored, `cut from ${id}`);
      return c.json(said(stored), 201);
    } catch (cause) {
      refused(session, cause, `crop of ${id}`);
      throw cause;
    }
  });

  app.get('/api/sessions/:session/uploads/:id', async (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    const photo = await uploads.load(session, param(c, 'id'));
    if (photo === null) throw errors.notFound('photo');
    c.header('Content-Type', photo.mime);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(photo.bytes as Uint8Array<ArrayBuffer>);
  });
}
