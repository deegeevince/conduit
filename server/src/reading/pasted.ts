import { DOCUMENT_TEXT_CHARS } from '@conduit/language';
import { clampText } from './html-text';

/**
 * A long passage the user pasted, as the brain reads it: the whole of it up to
 * `DOCUMENT_TEXT_CHARS`, and when it is longer, cut at the end of a paragraph
 * with a line in the text itself that says where and how much is missing.
 * (A pasted 10-Q is the case: 100,000 characters, of which the brain reads
 * the first 40,000 and is told so.)
 */
export function readPasted(text: string, max: number = DOCUMENT_TEXT_CHARS): { readonly text: string; readonly truncated: boolean; readonly total: number } {
  const clamped = clampText(text.replace(/\r\n/g, '\n').trim(), max);
  return { text: clamped.text, truncated: clamped.truncated, total: clamped.total };
}
