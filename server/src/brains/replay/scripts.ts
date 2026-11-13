import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEMOS } from '@conduit/language';
import type { DemoInfo } from '@conduit/language';
import { errors } from '../../errors';

const cache = new Map<string, string>();

/** The fixture scripts the replay brain can play, from `@conduit/language/demos`. */
export function listScripts(): readonly DemoInfo[] {
  return DEMOS;
}

/** The raw text of a fixture script. Throws `not_found` for an unknown name; never reads outside the demos folder. */
export async function loadScript(name: string): Promise<string> {
  // Only names from DEMOS reach the file system, so no request can choose a path.
  const known = DEMOS.find((demo) => demo.name === name);
  if (known === undefined) throw errors.notFound(`script ${name}`);
  const cached = cache.get(known.name);
  if (cached !== undefined) return cached;
  const path = fileURLToPath(import.meta.resolve(`@conduit/language/demos/${known.name}.series`));
  const source = await readFile(path, 'utf8');
  cache.set(known.name, source);
  return source;
}
