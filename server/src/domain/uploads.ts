// The user's own photos: taken once, made safe, kept in the data folder, and handed to the brain with the turn that names them.
//
// The domain owns this port; `uploads/store.ts` is the disk behind it. Ids are `u1`, `u2`, ... within a session, and a photo is its session's:
// no other session can name it, load it or draw it.

import type { UploadCrop, UploadResponse } from '@conduit/language';
import type { Snapshot } from './brain';

/** What a taken photo is, and where it was kept (relative to the data folder, for the session log and the audit trail; never the bytes). */
export interface StoredUpload extends UploadResponse {
  readonly file: string;
  /** a photo given with a crop: the whole page as it was kept beside the cropped part, for framing again */
  readonly whole?: StoredUpload;
}

export type { UploadCrop };

export interface UploadStore {
  /** False when uploads are switched off (`UPLOADS=off`) or there is nowhere safe to keep a photo. */
  readonly available: boolean;
  /**
   * Checks the bytes by their content (JPEG, PNG, WebP or HEIC, nothing else), converts and shrinks them, drops every piece of
   * metadata (EXIF, so the place it was taken is gone), keeps the JPEG that is left and names it. Throws an `AppError` that says why when it
   * will not: too large, not a picture it knows, too many already. With `crop`, only that part of the upright photo is kept.
   */
  put(session: string, bytes: Uint8Array, crop?: UploadCrop): Promise<StoredUpload>;
  /**
   * Frames a part of a photo this session holds, as a new photo with its own id; the one it came from is kept as it was, so a crop can be
   * done again from the full page: send the whole page's id again with another rectangle. The rectangle is of the photo as kept under `id` (upright, no metadata). Throws an `AppError` when the photo or the rectangle is not right.
   */
  recrop(session: string, id: string, crop: UploadCrop): Promise<StoredUpload>;
  /** The photo as it was kept; null when this session has no such photo. */
  load(session: string, id: string): Promise<Snapshot | null>;
  /** Whether this session holds a photo with this id (the one it was given by `put`). */
  has(session: string, id: string): boolean;
}

export const NO_UPLOADS: UploadStore = {
  available: false,
  put: () => Promise.reject(new Error('uploads are off')),
  recrop: () => Promise.reject(new Error('uploads are off')),
  load: () => Promise.resolve(null),
  has: () => false,
};
