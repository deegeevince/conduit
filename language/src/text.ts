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

/** Units typeset as they are written on paper: `cm2` is cm², `m3` is m³, but only after a number ("6 cm2"): a name like "room m3" is left alone. Same length, so every range into the text still holds. */
export function typesetUnits(text: string): string {
  return text.replace(/(?<=\d\s?)(mm|cm|dm|km|m)([23])\b/g, (_whole, unit: string, power: string) => `${unit}${power === '2' ? '²' : '³'}`);
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
    return { plain: typesetUnits(`${before.plain}*${after}`), emphasis: before.emphasis };
  }
  return { plain: typesetUnits(plain), emphasis };
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

/**
 * The cells of a pick, a table row or a chart row: split on bars and trimmed.
 * A closing bar (`| a | b |`, as Markdown writes a row) adds no empty cell.
 */
export function splitCells(text: string): string[] {
  const cells = text.split('|').map((cell) => cell.trim());
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** A Markdown table's rule row (`---|:---:|---`): it says nothing and is skipped. */
export function isRuleRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}
