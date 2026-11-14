// Photos on disk: `<DATA_DIR>/uploads/<run>-<session>/u1.jpg`, owner-only, one JPEG each. The run's start time is in the folder's name because
// session ids restart at c1 with the server, and one run's photo must never be overwritten by the next run's.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_LIMITS } from '@conduit/language';
import { AppError, errors } from '../errors';
import type { Logger } from '../log';
import { cropJpeg, heicToJpeg, isHeic, sipsReencoderFor, sniff } from '../pictures/image';
import type { Reencoder } from '../pictures/image';
import type { StoredUpload, UploadCrop, UploadStore } from '../domain/uploads';

/** A file declaring more pixels than this is not decoded. */
const MAX_PIXELS = 100_000_000;
const JPEG_QUALITY = 85;
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID_NAME = /^u[1-9][0-9]{0,3}$/;

export interface UploadStoreDeps {
  readonly dir: string;
  readonly log: Logger;
  readonly now: () => number;
  /** the machine's decoder; the default is `sips` */
  readonly reencoder?: Reencoder;
}

interface Held {
  readonly folder: string;
  next: number;
  /** a photo being made counts, so two at once cannot take the same id */
  readonly ids: Set<string>;
}

/** The smallest part of a photo that may be framed: a thumbnail's worth, in each direction. */
const LEAST_CROP = 0.02;

/** Checks a rectangle of fractions; throws the sentence a person can act on. */
function checked(crop: UploadCrop): UploadCrop {
  const ok = [crop.x, crop.y, crop.w, crop.h].every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!ok || crop.x < 0 || crop.y < 0 || crop.w < LEAST_CROP || crop.h < LEAST_CROP || crop.x + crop.w > 1.0001 || crop.y + crop.h > 1.0001) {
    throw errors.badRequest('the crop must be x, y, w, h as fractions of the photo (0 to 1, from the top left), staying inside it and at least 2% wide and tall');
  }
  return crop;
}

const TYPES_SAID = 'JPEG, PNG, WebP or HEIC';

export function createUploadStore(deps: UploadStoreDeps): UploadStore {
  const reencoder = deps.reencoder ?? sipsReencoderFor({ maxSide: UPLOAD_LIMITS.storedSide, quality: JPEG_QUALITY });
  const run = new Date(deps.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const sessions = new Map<string, Held>();

  const heldFor = (session: string): Held => {
    if (!SESSION_NAME.test(session)) throw errors.badRequest('that is not a session');
    let held = sessions.get(session);
    if (held === undefined) {
      held = { folder: join(deps.dir, `${run}-${session}`), next: 1, ids: new Set() };
      sessions.set(session, held);
    }
    return held;
  };

  async function made(bytes: Uint8Array): Promise<{ readonly jpeg: Uint8Array; readonly width: number; readonly height: number }> {
    if (bytes.byteLength === 0) throw errors.badRequest('the photo is empty');
    if (bytes.byteLength > UPLOAD_LIMITS.bytes) throw new AppError('payload_too_large', 413, `a photo may be at most ${UPLOAD_LIMITS.bytes / 1_000_000} MB`);
    let source = bytes;
    let seen = sniff(source);
    if (seen === null && isHeic(source)) {
      try {
        source = await heicToJpeg(source);
      } catch (cause) {
        deps.log.warn('uploads.heic_failed', { error: cause });
        throw new AppError('unsupported_picture', 415, 'that HEIC photo could not be opened; try sending it as a JPEG');
      }
      seen = sniff(source);
    }
    if (seen === null) throw new AppError('unsupported_picture', 415, `only ${TYPES_SAID} photos can be sent; this file is something else`);
    if (seen.width * seen.height > MAX_PIXELS || Math.max(seen.width, seen.height) > UPLOAD_LIMITS.maxSide) throw new AppError('unsupported_picture', 415, `that photo is too large to open (${seen.width} by ${seen.height} pixels); send a smaller one`);
    let jpeg: Uint8Array;
    try {
      jpeg = await reencoder.reencode(source, seen, null);
    } catch (cause) {
      deps.log.warn('uploads.reencode_failed', { error: cause });
      throw new AppError('unsupported_picture', 415, 'that photo could not be opened; it may be damaged');
    }
    const after = sniff(jpeg);
    if (after === null || after.format !== 'jpeg') throw new AppError('unsupported_picture', 415, 'that photo could not be opened; it may be damaged');
    return { jpeg, width: after.width, height: after.height };
  }

  /** A cropped photo: the part, as a JPEG with no metadata. */
  async function framed(jpeg: Uint8Array, crop: UploadCrop): Promise<{ readonly jpeg: Uint8Array; readonly width: number; readonly height: number }> {
    let part: Uint8Array;
    try {
      part = await cropJpeg(jpeg, crop);
    } catch (cause) {
      deps.log.warn('uploads.crop_failed', { error: cause });
      throw new AppError('unsupported_picture', 415, 'that part of the photo could not be cut out');
    }
    const seen = sniff(part);
    if (seen === null) throw new AppError('unsupported_picture', 415, 'that part of the photo could not be cut out');
    return { jpeg: part, width: seen.width, height: seen.height };
  }

  /** The id is taken only once there is a photo to name, with nothing awaited between taking it and holding it: a refusal leaves no gap (u1, u2, u3), and two at once never share one. */
  async function keep(session: string, held: Held, photo: { readonly jpeg: Uint8Array; readonly width: number; readonly height: number }): Promise<StoredUpload> {
    if (held.ids.size >= UPLOAD_LIMITS.perSession) throw errors.conflict(`this conversation already holds ${UPLOAD_LIMITS.perSession} photos`);
    const id = `u${held.next}`;
    held.next += 1;
    held.ids.add(id);
    try {
      await mkdir(held.folder, { recursive: true, mode: 0o700 });
      await writeFile(join(held.folder, `${id}.jpg`), photo.jpeg, { mode: 0o600 });
      return { id, mime: 'image/jpeg', width: photo.width, height: photo.height, bytes: photo.jpeg.byteLength, file: `uploads/${run}-${session}/${id}.jpg` };
    } catch (cause) {
      held.ids.delete(id);
      throw cause;
    }
  }

  return {
    available: true,

    async put(session, bytes, crop): Promise<StoredUpload> {
      const held = heldFor(session);
      if (held.ids.size >= UPLOAD_LIMITS.perSession) throw errors.conflict(`this conversation already holds ${UPLOAD_LIMITS.perSession} photos`);
      const wanted = crop === undefined ? undefined : checked(crop);
      const whole = await made(bytes);
      if (wanted === undefined) return keep(session, held, whole);
      // The whole page is kept too, under its own id, so the same page can be framed again (`recrop`) without sending it again.
      const part = await framed(whole.jpeg, wanted);
      const page = await keep(session, held, whole);
      return { ...(await keep(session, held, part)), whole: page };
    },

    async recrop(session, id, crop): Promise<StoredUpload> {
      const held = heldFor(session);
      const wanted = checked(crop);
      const was = await this.load(session, id);
      if (was === null) throw errors.notFound('photo');
      if (held.ids.size >= UPLOAD_LIMITS.perSession) throw errors.conflict(`this conversation already holds ${UPLOAD_LIMITS.perSession} photos`);
      return keep(session, held, await framed(was.bytes, wanted));
    },

    async load(session, id) {
      if (!ID_NAME.test(id) || !SESSION_NAME.test(session)) return null;
      const held = sessions.get(session);
      if (held === undefined || !held.ids.has(id)) return null;
      try {
        const bytes = new Uint8Array(await readFile(join(held.folder, `${id}.jpg`)));
        const seen = sniff(bytes);
        return seen === null ? null : { mime: 'image/jpeg', bytes, width: seen.width, height: seen.height };
      } catch {
        return null;
      }
    },

    has: (session, id) => sessions.get(session)?.ids.has(id) === true,
  };
}
