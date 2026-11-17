// How wide text is. The painter measures with this and nothing else; the
// renderer never measures at all. That is what keeps layout deterministic now
// that faces are proportional: one table, generated from the font files, read
// by one function.

import type { Face, Weight } from '@conduit/language';
import { FACES } from './faces';
import { hasDevice, isDevice, isWide } from './fold';
import type { FaceMetrics } from './faces';

const CACHE_LIMIT = 6000;
const cache = new Map<string, Float64Array>();

/** Forgets every running width made so far (a bench that changes a table has to). */
export function clearMeasureCache(): void {
  cache.clear();
}

/**
 * What the page measures a device-font run with: the width of the whole text in em, or null when it cannot yet (a face the canvas needs is still loading), in
 * which case the estimate below stands and is not remembered. The server has no browser and leaves it unset; the page sets it (fonts/device.ts).
 */
export type DeviceMeasure = (text: string, face: Face, weight: Weight) => number | null;
let deviceMeasure: DeviceMeasure | null = null;

/** Gives the page's real measure of device-font runs to every later width. */
export function setDeviceMeasure(measure: DeviceMeasure | null): void {
  deviceMeasure = measure;
  cache.clear();
}

/** Marks that do not advance the pen: combining marks (Mn) and enclosing marks, joiners, direction marks. */
const NO_ADVANCE = /[\p{Mn}\p{Me}\u200B-\u200F\u2060\u061C]/u;

/** A guess at the advance of one character of a script no shipped face has, in em: the average of the common system fonts, so layout on the server is close. */
function scriptEm(char: string, metrics: FaceMetrics | null, advance: number): number {
  if (NO_ADVANCE.test(char)) return 0;
  const code = char.charCodeAt(0);
  if (code < 0x0250 || (code >= 0x1e00 && code < 0x1f00) || (code >= 0x2c60 && code < 0x2c80) || (code >= 0xa720 && code < 0xa800)) {
    // Latin Extended: the width of its unaccented letter when the face has that
    const base = char.normalize('NFD').charAt(0);
    return metrics === null ? advance : (metrics.advance[base] ?? metrics.fallback);
  }
  if (code < 0x0400 || (code >= 0x1f00 && code < 0x2000)) return 0.6; // Greek
  if (code < 0x0590) return 0.62; // Cyrillic, Armenian
  if (code < 0x0600) return 0.5; // Hebrew
  if (code < 0x0900) return 0.48; // Arabic, Syriac, Thaana: letters join, so a letter is narrower than its form alone
  if (code >= 0x0e00 && code < 0x0e80) return 0.5; // Thai
  if (code >= 0xfb1d && code < 0xfb50) return 0.5; // Hebrew forms
  if (code >= 0xfb50) return 0.48; // Arabic forms
  return 0.62; // Devanagari and the other Indic scripts, Lao, Tibetan, Myanmar, Georgian, Khmer
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
    const width = isWide(char) ? 1 : isDevice(char) ? scriptEm(char, metrics, advance) : metrics === null ? advance : (metrics.advance[char] ?? metrics.fallback);
    running[i + 1] = (running[i] ?? 0) + width;
  }
  if (deviceMeasure !== null && hasDevice(text)) {
    // The estimate fixes the shape (which character is wide, which is a mark); the device's own width for the whole run fixes the total, so shaping and joining are counted.
    const real = deviceMeasure(text, face, weight);
    if (real === null) return running;
    const total = running[text.length] ?? 0;
    if (real > 0 && total > 0) {
      const k = real / total;
      for (let i = 1; i <= text.length; i += 1) running[i] = (running[i] ?? 0) * k;
    }
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
