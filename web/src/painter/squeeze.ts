// The squeeze list: one pure function that names what a scene gave up to fit one screen, and why. It only reads facts that the
// layout already decided; it changes nothing on stage.

import type { Squeeze, SqueezeFact, SqueezeInput, SqueezeKind } from '../contracts/squeeze';

export const SQUEEZE = {
  /** Text below this share of the size its size word asks for has been shrunk (the same line sight draws for `shrunk`). */
  shrunkBelow: 0.85,
  /** A live app shown at under this share of its natural size has been scaled down. */
  appBelow: 0.99,
} as const;

const ORDER: readonly SqueezeKind[] = ['retired', 'shrunk', 'crowded', 'compacted', 'app-scaled'];

export const NO_SQUEEZE: Squeeze = { squeezed: false, kinds: [], facts: [] };

const percent = (share: number): string => `${Math.round(share * 100)}%`;

export function squeezeOf(input: SqueezeInput): Squeeze {
  const facts: SqueezeFact[] = [];
  for (const key of input.retired) facts.push({ kind: 'retired', key, why: 'the line was let go because the column was full' });
  for (const item of input.shrunk) if (item.share < SQUEEZE.shrunkBelow) facts.push({ kind: 'shrunk', key: item.key, why: `set at ${percent(item.share)} of its size` });
  for (const key of input.crowded) facts.push({ kind: 'crowded', key, why: 'it could not be given the least room it can be read in' });
  if (input.compact.scrolls) facts.push({ kind: 'compacted', key: null, why: 'the controls stand in an area of their own that scrolls' });
  else if (input.compact.level > 0) facts.push({ kind: 'compacted', key: null, why: `the controls were set tighter (level ${input.compact.level} of 3)` });
  for (const app of input.apps) if (app.scale < SQUEEZE.appBelow) facts.push({ kind: 'app-scaled', key: app.key, why: `the app is shown at ${percent(app.scale)} of its size` });
  if (facts.length === 0) return NO_SQUEEZE;
  const kinds = ORDER.filter((kind) => facts.some((fact) => fact.kind === kind));
  return { squeezed: true, kinds, facts };
}
