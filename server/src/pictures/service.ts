// The pipeline behind an `image` line: cache, search, fetch, check, re-encode, keep.

import { PICTURE_LIMITS, normaliseWords, rankCandidates } from '../domain/pictures';
import type { Picture, PictureCandidate, PictureQuery, PictureService, PictureSource } from '../domain/pictures';
import type { Logger } from '../log';
import { KEY_PATTERN, pictureKey } from './cache';
import type { PictureStore } from './cache';
import { sniff } from './image';
import type { Reencoder } from './image';
import { getLimited } from './net';

export interface ServiceOptions {
  readonly source: PictureSource;
  readonly store: PictureStore;
  readonly reencoder: Reencoder;
  readonly log: Logger;
  readonly timeoutMs: number;
  readonly now?: () => number;
  /** how long a miss is remembered in memory, so a repeated line does not search again */
  readonly missMs?: number;
}

export function createPictureService(options: ServiceOptions): PictureService {
  const now = options.now ?? Date.now;
  const missMs = options.missMs ?? 600_000;
  const misses = new Map<string, number>();
  const inflight = new Map<string, Promise<Picture | null>>();

  const fetchOne = async (candidate: PictureCandidate, key: string, aspect: number | null, signal: AbortSignal): Promise<Picture | null> => {
    try {
      const { bytes } = await getLimited(candidate.url, PICTURE_LIMITS.maxDownloadBytes, 'image/jpeg,image/png,image/webp', AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]));
      const seen = sniff(bytes);
      if (seen === null) return skip('not_an_image', candidate);
      if (seen.width * seen.height > PICTURE_LIMITS.maxPixels) return skip('too_many_pixels', candidate);
      if (Math.max(seen.width, seen.height) < PICTURE_LIMITS.minSide) return skip('too_small', candidate);
      const clean = await options.reencoder.reencode(bytes, seen, aspect);
      const out = sniff(clean);
      if (out === null || out.format !== 'jpeg') return skip('reencode_failed', candidate);
      return { key, mime: 'image/jpeg', bytes: clean, width: out.width, height: out.height, credit: candidate.credit };
    } catch (error) {
      if (!signal.aborted) options.log.debug('pictures.candidate_failed', { id: candidate.id, error });
      return null;
    }
  };
  const skip = (reason: string, candidate: PictureCandidate): null => {
    options.log.debug('pictures.candidate_skipped', { id: candidate.id, reason });
    return null;
  };

  const make = async (query: PictureQuery, key: string, signal: AbortSignal): Promise<Picture | null> => {
    const found = await options.source.search(query, signal);
    for (const candidate of rankCandidates(found, query.aspect).slice(0, PICTURE_LIMITS.maxTries)) {
      if (signal.aborted) return null;
      const picture = await fetchOne(candidate, key, query.aspect, signal);
      if (picture !== null) {
        await options.store.write(picture);
        options.log.info('pictures.kept', { key, width: picture.width, height: picture.height, bytes: picture.bytes.length });
        return picture;
      }
    }
    return null;
  };

  return {
    id: options.source.id,
    available: options.source.available,
    async find(query, signal) {
      const words = normaliseWords(query.words);
      if (words === '' || !options.source.available) return null;
      const key = pictureKey(words, query.aspect);
      const stored = await options.store.read(key);
      if (stored !== null) return stored;
      if ((misses.get(key) ?? 0) > now()) return null;
      let running = inflight.get(key);
      if (running === undefined) {
        running = make({ words, aspect: query.aspect }, key, signal)
          .catch((error: unknown) => {
            options.log.warn('pictures.failed', { error });
            return null;
          })
          .then((picture) => {
            if (picture === null && !signal.aborted) misses.set(key, now() + missMs);
            return picture;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, running);
      }
      return running;
    },
    get: (key) => (KEY_PATTERN.test(key) ? options.store.read(key) : Promise.resolve(null)),
  };
}
