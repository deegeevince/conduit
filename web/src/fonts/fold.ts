// Brings any text into the set the faces can draw. Pure: no font files, no Vite, so the server can use it.

import { GLYPHS } from './glyphs';

const ALLOWED: ReadonlySet<string> = new Set(GLYPHS);

const SUBSTITUTES: Readonly<Record<string, string>> = {
  ' ': ' ',
  '\t': ' ',
  '→': '->',
  '←': '<-',
  '↑': '^',
  '↓': 'v',
  '⇒': '=>',
  '✓': 'v',
  '✔': 'v',
  '✗': 'x',
  '−': '-',
  '‐': '-',
  '‑': '-',
  '™': '(tm)',
  '±': '+/-',
  '½': '1/2',
  '¼': '1/4',
  '¾': '3/4',
  '²': '2',
  '³': '3',
  'µ': 'u',
  '′': "'",
  '″': '"',
  '≠': '!=',
  '≤': '<=',
  '≥': '>=',
  '≈': '~',
};

/**
 * Brings any text into the set the faces can draw. Known symbols become
 * their ASCII spelling, accented letters outside Latin-1 lose the accent,
 * pictographs are dropped, and anything else becomes `?`. The transcript
 * keeps the original text; only what is drawn is folded.
 */
export function foldText(text: string): string {
  let out = '';
  for (const char of text) {
    if (ALLOWED.has(char)) {
      out += char;
      continue;
    }
    const substitute = SUBSTITUTES[char];
    if (substitute !== undefined) {
      out += substitute;
      continue;
    }
    const base = char.normalize('NFKD').replace(/\p{M}/gu, '');
    if (base !== char && [...base].every((part) => ALLOWED.has(part))) {
      out += base;
      continue;
    }
    if (/\p{Extended_Pictographic}|\p{M}|\p{Cf}/u.test(char)) continue;
    out += '?';
  }
  return out.replace(/ {2,}/g, ' ');
}
