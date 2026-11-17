// Shared by the demo checks of `pnpm timeline` (reading-checks.ts, and the painter-side ones in web/src/painter/demo-checks.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMOS } from '../src/index';

export { cutScenes as scenesOf, playSource as play } from '../src/index';
export type { Played, SceneCut } from '../src/index';

/** The source of the demo `language/demos/<name>.series`. */
export function demoSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../demos/${name}.series`, import.meta.url)), 'utf8');
}

/** Every demo the language ships, in the order of `DEMOS`: its name and source. */
export function allDemos(): readonly { readonly name: string; readonly source: string }[] {
  return DEMOS.map((demo) => ({ name: demo.name, source: demoSource(demo.name) }));
}
