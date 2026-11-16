import type { TechniqueLibrary, LibrarySettings } from '../domain/techniques';
import { readTechniqueDir } from './files';
import { createMemoryLibrary, NO_LIBRARY } from './memory-library';

/** The library for these settings: the seed and the overlay, read now, synchronously. */
export function createLibrary(settings: LibrarySettings): TechniqueLibrary {
  if (settings.kind === 'none') return NO_LIBRARY;
  return createMemoryLibrary(readTechniqueDir(settings.seedDir, 'seed'), readTechniqueDir(settings.overlayDir, 'overlay'));
}
