// The library a turn talks to: an index in memory, filled from whatever
// sources there are. `cardsFor` never waits and never fails.

import type { TechniqueCard } from '@conduit/language';
import { cardOf, isProposedTitle, selectTechniques, termsOf } from '../domain/techniques';
import type { LibraryStatus, Technique, TechniqueHit, TechniqueLibrary, TechniqueQuery, TechniqueSource, TechniqueTerms } from '../domain/techniques';

export interface LibrarySources {
  /** read at once, when the library is made: the seed and the file cache. Synchronous on purpose: the first turn after boot is served from these. */
  readonly initial: readonly Technique[];
  /** read in the background: Remote. Resolves with what it holds; rejects when it cannot be reached. Null: there is no such source. */
  readonly remote: ((signal: AbortSignal) => Promise<readonly Technique[]>) | null;
  /** told what a refresh read, to keep for the next boot. Never awaited by a turn. */
  readonly remember: ((techniques: readonly Technique[]) => void) | null;
  readonly now: () => number;
}

/**
 * Later sources win by title, so that the truth (Remote) replaces its own
 * seed copy and an overlay (an experiment's candidate) replaces both. Titles
 * are the join because a seed has no block id until it has been written.
 */
function merge(layers: readonly (readonly Technique[])[]): Technique[] {
  const byTitle = new Map<string, Technique>();
  for (const layer of layers) // A proposed technique is not measured and is never the brain's: whichever source it came from (Remote, the cache, a file), it is left out here.
    for (const technique of layer) if (!isProposedTitle(technique.title)) byTitle.set(technique.title.trim().toLowerCase(), technique);
  return [...byTitle.values()];
}

export function createMemoryLibrary(sources: LibrarySources): TechniqueLibrary {
  let remote: readonly Technique[] = [];
  let index: readonly TechniqueTerms[] = merge([sources.initial]).map(termsOf);
  let refreshedAt: string | null = null;
  let failure: string | null = null;
  let closed = false;

  /** One throwaway choice, so that the first real one does not pay for compiling the matcher: it is on a turn's path and has 1 ms. */
  const warm = (): void => {
    selectTechniques(index, { input: { kind: 'prompt', text: 'show me how a flowchart of a price over time compares' }, documents: false });
  };
  warm();

  const rebuild = (): void => {
    // The overlay is last in `initial`, so it is laid over the remote layer again here.
    const overlay = sources.initial.filter((technique) => technique.source === 'overlay');
    // The file cache is the last good read of the remote; once there is a newer one it is no longer a layer, so a technique deleted from Remote goes.
    const rest = sources.initial.filter((technique) => technique.source !== 'overlay' && technique.source !== 'cache');
    index = merge([rest, remote, overlay]).map(termsOf);
    warm();
  };

  const status = (): LibraryStatus => {
    const bySource: Record<TechniqueSource, number> = { remote: 0, cache: 0, seed: 0, overlay: 0 };
    for (const entry of index) bySource[entry.technique.source] += 1;
    return { techniques: index.length, bySource, refreshedAt, failure };
  };

  const match = (query: TechniqueQuery): readonly TechniqueHit[] => selectTechniques(index, query);

  return {
    cardsFor: (query): readonly TechniqueCard[] => match(query).map((hit) => cardOf(hit.technique)),
    match,
    async refresh(signal) {
      if (closed || sources.remote === null) return status();
      try {
        const read = await sources.remote(signal);
        if (closed) return status();
        remote = read;
        refreshedAt = new Date(sources.now()).toISOString();
        failure = null;
        rebuild();
        sources.remember?.(read);
      } catch (error) {
        // What was known stays known. A turn cannot tell that this happened.
        failure = error instanceof Error ? error.message : String(error);
      }
      return status();
    },
    status,
    close() {
      closed = true;
    },
  };
}

export const NO_LIBRARY: TechniqueLibrary = {
  cardsFor: () => [],
  match: () => [],
  refresh: () => Promise.resolve({ techniques: 0, bySource: { remote: 0, cache: 0, seed: 0, overlay: 0 }, refreshedAt: null, failure: null }),
  status: () => ({ techniques: 0, bySource: { remote: 0, cache: 0, seed: 0, overlay: 0 }, refreshedAt: null, failure: null }),
  close() {},
};
