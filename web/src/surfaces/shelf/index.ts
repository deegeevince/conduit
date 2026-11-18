// The vetted library shelf, as the host sees it: which libraries an app asked for, and the text of each. The text is made at build time by
// web/scripts/build-shelf.mjs (self-contained `<style>`/`<script>` fragments, nothing fetched when an app runs) and loaded only when an app
// on stage asks for it: each library is its own lazy chunk, and once loaded it is kept.

import type { AppShelf } from '@conduit/language';

/** The library each shelf word names; `charts` and `graphs` are the one D3. `maps` is the land outlines (`World.land`), made from a data file at build time. */
const LIBRARY: Readonly<Record<AppShelf, 'matter' | 'tone' | 'katex' | 'd3' | 'fonts' | 'maps'>> = { physics: 'matter', sound: 'tone', maths: 'katex', charts: 'd3', graphs: 'd3', fonts: 'fonts', maps: 'maps' };
const ORDER = ['fonts', 'katex', 'matter', 'd3', 'tone', 'maps'] as const;
type Library = (typeof ORDER)[number];

const files = import.meta.glob('./built/*.html', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
const texts = new Map<Library, string>();
const loading = new Map<Library, Promise<string | null>>();

/** The distinct libraries a list of shelf words needs, in the order they are put in the page. */
export function librariesOf(uses: readonly AppShelf[] | undefined): readonly Library[] {
  const wanted = new Set((uses ?? []).map((word) => LIBRARY[word]));
  return ORDER.filter((name) => wanted.has(name));
}

/** What a document's fingerprint and its running frame are told apart by: the libraries it has, in a fixed order. */
export function shelfKey(uses: readonly AppShelf[] | undefined): string {
  return librariesOf(uses).join(',');
}

/** The fragment for these shelves when every library is already loaded; null while any is still coming (or is missing from the build). */
export function shelfText(uses: readonly AppShelf[] | undefined): string | null {
  const parts: string[] = [];
  for (const name of librariesOf(uses)) {
    const text = texts.get(name);
    if (text === undefined) return null;
    parts.push(text);
  }
  return parts.join('\n');
}

/** Loads what these shelves need. Resolves true when every library is in hand; false when one could not be loaded (not built, or the chunk failed). */
export async function loadShelf(uses: readonly AppShelf[] | undefined): Promise<boolean> {
  const results = await Promise.all(
    librariesOf(uses).map((name) => {
      if (texts.has(name)) return Promise.resolve('');
      let pending = loading.get(name);
      if (pending === undefined) {
        const load = files[`./built/${name}.html`];
        pending = load === undefined ? Promise.resolve(null) : load().then((text) => text, () => null);
        loading.set(name, pending);
      }
      return pending.then((text) => {
        if (text !== null) texts.set(name, text);
        else loading.delete(name);
        return text;
      });
    }),
  );
  return results.every((text) => text !== null);
}
