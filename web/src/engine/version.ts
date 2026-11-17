// Which engine this is: a hash of every advance table, GLYPHS and an engine constant. Two sides that disagree measure differently.
import { FACES } from '../fonts/faces';
import { GLYPHS } from '../fonts/glyphs';

/** Bump when the engine's own arithmetic changes in a way the tables do not show. */
export const ENGINE_CONSTANT = 3;

/** cyrb53: a 53-bit string hash, the same on every JavaScript engine; no crypto, no DOM. */
export function hashOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function tablesText(): string {
  const parts: string[] = [`engine${ENGINE_CONSTANT}`, GLYPHS];
  for (const face of Object.keys(FACES).sort()) {
    const spec = FACES[face as keyof typeof FACES];
    for (const metrics of [spec.metrics, spec.boldMetrics]) {
      if (metrics === null) {
        parts.push(`${face}:${spec.advance}`);
        continue;
      }
      parts.push(`${face}:${metrics.fallback}:${metrics.ascent}:${metrics.descent}:${metrics.xHeight}`);
      for (const char of Object.keys(metrics.advance).sort()) parts.push(`${char}${metrics.advance[char]}`);
    }
  }
  return parts.join('\n');
}

export const ENGINE_VERSION: string = hashOf(tablesText());
