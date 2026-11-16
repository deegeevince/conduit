// The library a turn talks to: an index in memory, read once from the seed and
// the overlay when it is made. `cardsFor` never waits and never fails.

import type { TechniqueCard } from '@conduit/language';
import { cardOf, isProposedTitle, selectTechniques, termsOf } from '../domain/techniques';
import type { LibraryStatus, Technique, TechniqueHit, TechniqueLibrary, TechniqueQuery, TechniqueSource } from '../domain/techniques';

/**
 * Later layers win by title, so that an overlay (an experiment's candidate)
 * replaces its seed copy. A proposed technique is not measured and is never
 * the brain's: it is left out here.
 */
function merge(layers: readonly (readonly Technique[])[]): Technique[] {
  const byTitle = new Map<string, Technique>();
  for (const layer of layers) for (const technique of layer) if (!isProposedTitle(technique.title)) byTitle.set(technique.title.trim().toLowerCase(), technique);
  return [...byTitle.values()];
}

/** `seed` first, then `overlay`: the overlay wins. */
export function createMemoryLibrary(seed: readonly Technique[], overlay: readonly Technique[]): TechniqueLibrary {
  const index = merge([seed, overlay]).map(termsOf);

  // One throwaway choice, so that the first real one does not pay for compiling the matcher: it is on a turn's path and has 1 ms.
  selectTechniques(index, { input: { kind: 'prompt', text: 'show me how a flowchart of a price over time compares' }, documents: false });

  const status = (): LibraryStatus => {
    const bySource: Record<TechniqueSource, number> = { seed: 0, overlay: 0 };
    for (const entry of index) bySource[entry.technique.source] += 1;
    return { techniques: index.length, bySource };
  };

  const match = (query: TechniqueQuery): readonly TechniqueHit[] => selectTechniques(index, query);

  return {
    cardsFor: (query): readonly TechniqueCard[] => match(query).map((hit) => cardOf(hit.technique)),
    match,
    status,
    close() {},
  };
}

export const NO_LIBRARY: TechniqueLibrary = {
  cardsFor: () => [],
  match: () => [],
  status: () => ({ techniques: 0, bySource: { seed: 0, overlay: 0 } }),
  close() {},
};
