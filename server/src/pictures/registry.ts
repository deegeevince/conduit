import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PictureService, PictureSettings } from '../domain/pictures';
import type { Logger } from '../log';
import { createDiskStore } from './cache';
import { NO_REENCODER, sipsReencoder } from './image';
import { NO_PICTURES } from './none';
import { createOpenverse } from './openverse';
import { createPictureService } from './service';

/**
 * Settings from the environment (`env.ts` hands in `process.env`'s values). Off unless `PICTURES=openverse`:
 * the owner switches it on, and the placeholder is what there is until then.
 */
export function readPictureSettings(read: (name: string) => string | undefined): { settings: PictureSettings; problems: string[] } {
  const problems: string[] = [];
  const kind = read('PICTURES') ?? 'none';
  if (kind !== 'none' && kind !== 'openverse') problems.push(`PICTURES must be none | openverse, got "${kind}"`);
  return {
    settings: {
      kind: kind === 'openverse' ? 'openverse' : 'none',
      cacheDir: read('PICTURES_DIR') ?? join(homedir(), '.cache', 'conduit', 'pictures'),
      minIntervalMs: 3_200,
      timeoutMs: 20_000,
    },
    problems,
  };
}

export function createPictures(settings: PictureSettings, log: Logger): PictureService {
  if (settings.kind === 'none') return NO_PICTURES;
  const reencoder = process.platform === 'darwin' ? sipsReencoder : NO_REENCODER;
  if (reencoder === NO_REENCODER) log.warn('pictures.no_reencoder', { platform: process.platform });
  return createPictureService({
    source: createOpenverse({ log, minIntervalMs: settings.minIntervalMs, timeoutMs: settings.timeoutMs }),
    store: createDiskStore(settings.cacheDir),
    reencoder,
    log,
    timeoutMs: settings.timeoutMs,
  });
}
