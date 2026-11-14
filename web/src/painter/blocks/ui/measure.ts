// The kit's measurer. A mock-up is typeset in points, not in the size words of a drawing, so the kit asks for a size in
// points and a weight; the answer comes from the same advance tables the painter measures every word with
// (`fonts/measure.ts`, generated from the font files), so a box here is as wide as the glyphs the renderer sets in it.
// The solver imports no fonts: it is handed this.

import { foldText } from '../../../fonts/fold';
import { measureEm, prefixEm } from '../../../fonts/measure';
import { wrapMeasured } from '../../layout/wrap';

export type UiWeight = 'normal' | 'bold';

export interface UiLine {
  readonly text: string;
  readonly width: number;
}

export interface UiMeasure {
  /** the width of one line of text, points */
  width(text: string, size: number, weight: UiWeight): number;
  /** the text broken to fit `maxWidth`: lines, and the widest of them */
  wrap(text: string, size: number, weight: UiWeight, maxWidth: number): { readonly lines: readonly UiLine[]; readonly widest: number };
  /** the longest word: the least the text can be set across */
  longestWord(text: string, size: number, weight: UiWeight): number;
}

/** The painter's own advance tables, for the sans face the kit is set in. */
export function paintersMeasure(): UiMeasure {
  const width = (text: string, size: number, weight: UiWeight): number => measureEm(foldText(text), 'sans', weight) * size;
  return {
    width,
    wrap(text, size, weight, maxWidth) {
      const folded = foldText(text);
      if (folded === '') return { lines: [{ text: '', width: 0 }], widest: 0 };
      const prefix = prefixEm(folded, 'sans', weight);
      const wrapped = wrapMeasured(folded, prefix, maxWidth / size, Number.POSITIVE_INFINITY);
      const lines = wrapped.spans.map((span) => ({ text: folded.slice(span.start, span.end), width: ((prefix[span.end] ?? 0) - (prefix[span.start] ?? 0)) * size }));
      return { lines, widest: Math.max(0, ...lines.map((l) => l.width)) };
    },
    longestWord(text, size, weight) {
      return Math.max(0, ...foldText(text).split(/\s+/).map((word) => width(word, size, weight)));
    },
  };
}
