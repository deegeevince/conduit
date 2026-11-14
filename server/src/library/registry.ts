import type { Logger } from '../log';
import type { DatasetLibrary, DatasetSettings } from '../domain/datasets';
import { NO_DATASETS } from '../domain/datasets';
import { createRemoteDatasets } from './remote/datasets-cli';
import type { LibrarySettings, Technique, TechniqueLibrary } from '../domain/techniques';
import { readCache, readTechniqueDir, writeCache } from './files';
import { readRemoteTechniques } from './remote/remote-cli';
import { createMemoryLibrary, NO_LIBRARY } from './memory-library';

/**
 * The library for these settings. What it can read at once (the seed, the
 * cache, an overlay) is read here, synchronously, at boot; Remote is read by
 * `refresh`, which the caller starts in the background and never awaits on a
 * turn's path.
 */
export function createLibrary(settings: LibrarySettings, log: Logger, now: () => number): TechniqueLibrary {
  if (settings.kind === 'none') return NO_LIBRARY;
  const seed = readTechniqueDir(settings.seedDir, 'seed');
  const overlay = readTechniqueDir(settings.overlayDir, 'overlay');
  if (settings.kind === 'seed') return createMemoryLibrary({ initial: [...seed, ...overlay], remote: null, remember: null, now });
  const cached = readCache(settings.cacheDir);
  const known = new Map<string, Technique>(cached.map((technique) => [technique.id, technique]));
  // Said once: that Remote cannot be read and what is served instead. The same failure again is silent; a different one, or a recovery, is said.
  let said: string | null = null;
  const serving = (): { cache: number; seed: number } => ({ cache: cached.length, seed: seed.length });
  return createMemoryLibrary({
    initial: [...seed, ...cached, ...overlay],
    remote: async (signal) => {
      try {
        const read = await readRemoteTechniques(settings, known, log, signal);
        if (said !== null) log.info('library.recovered', { techniques: read.length });
        said = null;
        return read;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== said) log.warn('library.serving_without_remote', { reason: message, ...serving(), from: cached.length > 0 ? 'cache and seed' : 'seed' });
        said = message;
        throw error;
      }
    },
    remember: (techniques) => {
      try {
        writeCache(settings.cacheDir, techniques);
      } catch (error) {
        log.warn('library.cache_unwritten', { error });
      }
    },
    now,
  });
}

/** The owner's datasets, or none (the default). Reads only. */
export function createDatasets(settings: DatasetSettings, log: Logger, cacheDir?: string): DatasetLibrary {
  return settings.kind === 'none' ? NO_DATASETS : createRemoteDatasets(settings, log, cacheDir);
}
