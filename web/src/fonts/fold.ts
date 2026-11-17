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

/**
 * Every other script the device can draw and the shipped faces cannot: Latin Extended (Polish, Czech, Turkish, Romanian, Vietnamese), Greek, Cyrillic, Armenian,
 * Hebrew, Arabic, Indic, Thai, Lao, Tibetan, Myanmar, Georgian, Khmer and the rest of U+0100-U+1FFF, the combining marks, the zero-width non-joiner and direction marks
 * that shaping needs (the zero-width joiner is dropped: it is what glues emoji together), other currency signs, and the Hebrew and Arabic presentation forms. `foldText` keeps them; they are measured by a per-script estimate (or the
 * device, on the page) and drawn from the device's own fonts as whole runs (see render/three/text.ts and fonts/device.ts). Nothing is downloaded.
 */
const DEVICE = /[\u0100-\u1FFF\u200C\u200E\u200F\u20A0-\u20CF\u2C60-\u2C7F\uA720-\uA7FF\uA8E0-\uA8FF\uAB30-\uAB6F\uFB1D-\uFDFF\uFE70-\uFEFE]/;

/** Scripts written right to left: Hebrew, Arabic, Syriac, Thaana, N'Ko, their presentation forms, and the right-to-left mark. */
const RTL = /[\u0590-\u08FF\u200F\uFB1D-\uFDFF\uFE70-\uFEFE]/;

/** Whether this one character comes from the device's own fonts (any script above), not from a shipped face. */
export function isDevice(char: string): boolean {
  return DEVICE.test(char);
}

/** Whether any character of the text comes from the device's fonts (CJK excluded): such a run is drawn whole. */
export function hasDevice(text: string): boolean {
  return DEVICE.test(text);
}

/**
 * Whether the run reads right to left: most of its letters are in a right-to-left script. A line is drawn on its own after the text is wrapped, so the first letter is
 * no guide (the second line of an English sentence can open with an Arabic word and still sit in a left-to-right paragraph); the letters in the majority are.
 */
export function startsRtl(text: string): boolean {
  let rtl = 0;
  let other = 0;
  for (const char of text) {
    if (RTL.test(char)) rtl += /\p{L}/u.test(char) ? 1 : 0;
    else if (/\p{L}/u.test(char)) other += 1;
  }
  return rtl > other;
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
 * Brings any text into the set the page can draw. Known symbols become
 * their ASCII spelling; CJK and every script of `DEVICE` is kept whole, accents
 * and all (the device's own fonts draw it); pictographs are dropped, and
 * anything else becomes `?`. The transcript
 * keeps the original text; only what is drawn is folded.
 */
export function foldText(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
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
    if (DEVICE.test(char)) {
      out += char;
      continue;
    }
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
