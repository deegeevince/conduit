// The device's own fonts for every script the shipped faces lack, drawn and measured through the browser's 2D canvas. Browser only: the server never imports
// this, so `measure.ts` stays pure and answers with its per-script estimate there. Nothing is downloaded: the canvas takes the family the face already
// registered for its Latin letters and the system's own fonts for the rest.

import type { Face, Weight } from '@conduit/language';
import { FACES } from './faces';
import { hasWide } from './fold';
import { FONTS } from './index';
import { setDeviceMeasure } from './measure';

/** The system's own CJK fonts, in the order a phone, a Mac, a PC and a Linux box are likely to have them. */
export const WIDE_STACK = '"PingFang SC","Hiragino Sans","Hiragino Kaku Gothic ProN","Apple SD Gothic Neo","Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","Microsoft YaHei","Yu Gothic","Malgun Gothic",sans-serif';

/**
 * The system's fonts for Greek, Cyrillic, Arabic, Hebrew, Indic and Thai, nearest to the face's own style first. The browser picks a font for each glyph the list
 * lacks, so a device with none of these still shows its own fallback; the generic name at the end is what that fallback starts from.
 */
const SCRIPT_STACK = '"Helvetica Neue","Segoe UI","Noto Sans","Geeza Pro","Arial Hebrew","Kohinoor Devanagari","Thonburi","Nirmala UI","Leelawadee UI",system-ui,sans-serif';
const SCRIPT_SERIF = '"Times New Roman","Noto Serif","Geeza Pro","Arial Hebrew","Kohinoor Devanagari","Thonburi","Nirmala UI","Leelawadee UI",serif';
const SCRIPT_MONO = '"Menlo","Consolas","Noto Sans Mono","Geeza Pro","Arial Hebrew","Kohinoor Devanagari","Thonburi","Nirmala UI","Leelawadee UI",monospace';

/** Face files registered with the document for the 2D canvas (it can draw only what the document has loaded), by font key. */
const loads = new Map<string, 'loading' | 'done'>();

/** Starts registering this face file for the canvas; true once it is registered (or cannot be, which is as good: the stack falls through). */
export function ensureFace(key: string): boolean {
  const state = loads.get(key);
  if (state === 'done') return true;
  if (state === undefined) {
    loads.set(key, 'loading');
    const face = FONTS[key];
    if (face === undefined || typeof FontFace === 'undefined' || typeof document === 'undefined') {
      loads.set(key, 'done');
      return true;
    }
    void new FontFace(face.family, `url(${face.url}) format("${face.format}")`)
      .load()
      .then((ok) => document.fonts.add(ok))
      .catch(() => undefined)
      .finally(() => loads.set(key, 'done'));
  }
  return false;
}

/** The font key a face and weight are drawn in. */
export function fontKeyFor(face: Face, bold: boolean): string {
  const spec = FACES[face];
  return bold && spec.bold === 'face' && spec.boldFont !== null ? spec.boldFont : spec.font;
}

/** The canvas `font` for a run: the face's own family first (its Latin letters), then the system's fonts for the script, CJK ones too when the run has CJK. */
export function deviceFont(fontKey: string, bold: boolean, px: number, text: string): string {
  const family = FONTS[fontKey]?.family;
  const own = family === undefined ? '' : `"${family}",`;
  const system = hasWide(text) ? WIDE_STACK : fontKey.startsWith('source-serif') || fontKey.startsWith('caveat') ? SCRIPT_SERIF : /mono|vt323|bedstead|doto/.test(fontKey) ? SCRIPT_MONO : SCRIPT_STACK;
  return `${bold ? '700 ' : ''}${px}px ${own}${system}`;
}

/**
 * Sets `ctx.wordSpacing` so every space is the face's own space and returns the width of the text, in the pixels of the context's font. A space that follows a letter the
 * face lacks is drawn in the system font that supplied the letter, and some of those spaces are wide; the correction is the average over the run, found from the
 * letters that precede a space (one measure of the letter, one of the letter and a space). A browser without `wordSpacing` on the canvas is left as it is.
 */
export function fitSpaces(ctx: CanvasRenderingContext2D, text: string): number {
  if (!('wordSpacing' in ctx) || !text.includes(' ')) return ctx.measureText(text).width;
  ctx.wordSpacing = '0px';
  const own = ctx.measureText(' ').width;
  const seen = new Map<string, number>();
  let sum = 0;
  let count = 0;
  const chars = [...text];
  for (let i = 1; i < chars.length; i += 1) {
    const before = chars[i - 1];
    if (chars[i] !== ' ' || before === undefined || before === ' ') continue;
    let space = seen.get(before);
    if (space === undefined) {
      space = ctx.measureText(`${before} `).width - ctx.measureText(before).width;
      seen.set(before, space);
    }
    sum += own - space;
    count += 1;
  }
  if (count > 0 && Math.abs(sum / count) > own * 0.02) ctx.wordSpacing = `${sum / count}px`;
  return ctx.measureText(text).width;
}

let ruler: CanvasRenderingContext2D | null = null;

function measure(text: string, face: Face, weight: Weight): number | null {
  if (typeof document === 'undefined') return null;
  const bold = weight === 'bold';
  const key = fontKeyFor(face, bold);
  // Not waited for: a run in a script the faces lack is measured in the system's fonts alone, and only a Latin word inside it can differ, by a hair, until the face is in.
  ensureFace(key);
  ruler ??= document.createElement('canvas').getContext('2d');
  if (ruler === null) return null;
  ruler.font = deviceFont(key, bold, 100, text);
  ruler.fontKerning = 'normal';
  return fitSpaces(ruler, text) / 100;
}

// The page measures device-font runs with the device. Without a document (the server) nothing is set and the estimate stands.
if (typeof document !== 'undefined') setDeviceMeasure(measure);
