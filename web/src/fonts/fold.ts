// Brings any text into the set the faces can draw. Pure: no font files, no Vite, so the server can use it.

import { GLYPHS } from './glyphs';

const ALLOWED: ReadonlySet<string> = new Set(GLYPHS);

/**
 * Chinese, Japanese and Korean characters (Han, kana, Hangul, CJK punctuation and the full-width forms), in the Basic Multilingual Plane. No shipped face has them: they are kept by
 * `foldText`, measured as one em wide, and drawn by the WebGL renderer from the device's own CJK font (see render/three/text.ts), never downloaded.
 */
const WIDE = /[\u2E80-\u303F\u3040-\u30FF\u3100-\u312F\u3190-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

/** Whether this one character is CJK (one em wide, drawn from the device's own font). */
export function isWide(char: string): boolean {
  return WIDE.test(char);
}

/** Whether any character of the text is CJK. */
export function hasWide(text: string): boolean {
  return WIDE.test(text);
}

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
    if (WIDE.test(char)) {
      out += char;
      continue;
    }
    if (/\p{Extended_Pictographic}|\p{M}|\p{Cf}/u.test(char)) continue;
    out += '?';
  }
  return out.replace(/ {2,}/g, ' ');
}
