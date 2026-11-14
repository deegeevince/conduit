import type { Logger } from '../log';
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
  return createMemoryLibrary({
    initial: [...seed, ...cached, ...overlay],
    remote: (signal) => readRemoteTechniques(settings, known, log, signal),
    remember: (techniques) => writeCache(settings.cacheDir, techniques),
    now,
  });
}
