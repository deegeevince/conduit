import type { Range } from './types';

/**
 * Whether the `*` at `i` is an emphasis marker rather than a plain asterisk.
 * An opener hugs the word that follows and does not follow a letter or digit;
 * a closer hugs the word before it and is not followed by one. So the
 * asterisks of `3 * 4 * 5` and `2*3` stay what they are.
 */
function isMarker(text: string, i: number, opening: boolean): boolean {
  const before = text.charAt(i - 1);
  const after = text.charAt(i + 1);
  const wordy = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);
  if (opening) return after !== '' && !/\s/.test(after) && after !== '*' && !wordy(before);
  return before !== '' && !/\s/.test(before) && before !== '*' && !wordy(after);
}

/**
 * Splits `*emphasis*` markers out of element text. `\*` is a literal asterisk.
 * An unclosed `*` is kept as a literal so a stray asterisk never eats the line.
 */
export function splitEmphasis(source: string): { plain: string; emphasis: Range[] } {
  // Markdown's **bold** is a model's habit: it means the same as *emphasis* here.
  const text = source.replace(/(?<!\\)\*\*(?=[^\s*])(.+?)(?<=[^\s*\\])\*\*/g, '*$1*');
  let plain = '';
  const emphasis: Range[] = [];
  let open: number | null = null;
  let openedAtSource = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === '\\' && text.charAt(i + 1) === '*') {
      plain += '*';
      i += 1;
      continue;
    }
    if (char !== '*' || !isMarker(text, i, open === null)) {
      plain += char;
      continue;
    }
    if (open === null) {
      open = plain.length;
      openedAtSource = i;
    } else {
      if (plain.length > open) emphasis.push({ start: open, end: plain.length });
      open = null;
    }
  }
  if (open !== null) {
    const before = splitEmphasis(text.slice(0, openedAtSource));
    const after = text.slice(openedAtSource + 1).replace(/\\\*/g, '*');
    return { plain: `${before.plain}*${after}`, emphasis: before.emphasis };
  }
  return { plain, emphasis };
}

export function plainText(text: string): string {
  return splitEmphasis(text).plain;
}

export function countWords(text: string): number {
  const words = plainText(text).trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}

export function plainLength(text: string): number {
  return plainText(text).length;
}
