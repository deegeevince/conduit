// Icons, as outlines: the data in `icon-paths.ts` (Lucide, ISC) read by the language's own path reader, so an icon is
// a path like any other the brain draws. Cached by name. Unknown names fall back to a plain ring, so a word the set does
// not have is a visible mistake and not a hole.

import { outlineOf, parsePathData } from '@conduit/language';
import type { Polyline } from '@conduit/language';
import { ICON_GRID, ICON_PATHS } from './icon-paths';

const cache = new Map<string, readonly Polyline[]>();

export function hasIcon(name: string): boolean {
  return ICON_PATHS[name] !== undefined;
}

export const ICON_NAMES: readonly string[] = Object.keys(ICON_PATHS);

/** The outline of an icon on its own 24 x 24 grid. */
export function iconOutline(name: string): readonly Polyline[] {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const d = ICON_PATHS[name] ?? ICON_PATHS['info'] ?? '';
  const { commands } = parsePathData(d);
  const lines = outlineOf({ shape: 'path', d, commands });
  cache.set(name, lines);
  return lines;
}

/** An icon placed at (x, y) in a box `size` square: its polylines in the caller's units. */
export function placeIcon(name: string, x: number, y: number, size: number): Polyline[] {
  const k = size / ICON_GRID;
  return iconOutline(name).map((line) => ({ closed: line.closed, points: line.points.map((p) => ({ x: x + p.x * k, y: y + p.y * k })) }));
}
