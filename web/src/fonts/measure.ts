// How wide text is. The painter measures with this and nothing else; the
// renderer never measures at all. That is what keeps layout deterministic now
// that faces are proportional: one table, generated from the font files, read
// by one function.

import type { Face, Weight } from '@conduit/language';
import { FACES } from './faces';
import type { FaceMetrics } from './faces';

const CACHE_LIMIT = 6000;
const cache = new Map<string, Float64Array>();

/** Forgets every running width made so far (a bench that changes a table has to). */
export function clearMeasureCache(): void {
  cache.clear();
}

function metricsOf(face: Face, weight: Weight): FaceMetrics | null {
  const spec = FACES[face];
  return weight === 'bold' && spec.boldMetrics !== null ? spec.boldMetrics : spec.metrics;
}

/**
 * Running widths of `text` in em: element k is the width of its first k
 * characters, so element 0 is 0 and the last is the whole text. The shipped
 * files have no kerning and no ligatures, so a width is a sum and any piece of
 * the text is a difference of two elements. Shared by every caller for the
 * same (face, weight, text); do not modify it.
 */
export function prefixEm(text: string, face: Face, weight: Weight): Float64Array {
  const key = `${face}|${weight === 'bold' ? 'b' : 'n'}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const metrics = metricsOf(face, weight);
  const advance = FACES[face].advance;
  const running = new Float64Array(text.length + 1);
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    const width = metrics === null ? advance : (metrics.advance[char] ?? metrics.fallback);
    running[i + 1] = (running[i] ?? 0) + width;
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, running);
  return running;
}

/**
 * The width of `text` in em, set in `face` at `weight`, with no kerning and no
 * ligatures (the shipped files have neither). For a fixed-pitch face this is
 * `characters x advance`. `text` must already have been through `foldText`.
 */
export function measureEm(text: string, face: Face, weight: Weight): number {
  if (text.length === 0) return 0;
  return prefixEm(text, face, weight)[text.length] ?? 0;
}

/**
 * The share of `text`'s width taken by its first `characters` characters:
 * what turns "this many characters have been typed" into `RunFrame.reveal`.
 */
export function revealShare(text: string, characters: number, face: Face, weight: Weight): number {
  if (text.length === 0) return 1;
  const running = prefixEm(text, face, weight);
  const total = running[text.length] ?? 0;
  if (total <= 0) return characters >= text.length ? 1 : 0;
  const whole = Math.max(0, Math.min(text.length, Math.floor(characters)));
  return (running[whole] ?? 0) / total;
}
