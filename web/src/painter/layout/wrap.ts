export interface Span {
  /** half-open character range in the wrapped text */
  readonly start: number;
  readonly end: number;
}

export interface Wrapped {
  readonly spans: readonly Span[];
  /** a word was longer than the line and had to be cut */
  readonly broken: boolean;
}

interface Token {
  readonly start: number;
  readonly end: number;
}

/** What a line may be. `widthOf(a, b)` is the width of characters a..b of the text, in any unit, as long as `maxWidth` is in the same one. */
interface Rule {
  readonly widthOf: (start: number, end: number) => number;
  readonly maxWidth: number;
  /** no line has more characters than this, whatever their width */
  readonly maxChars: number;
  /** widths are whole numbers (columns of a fixed-pitch face): the balancing search steps by one */
  readonly whole: boolean;
}

const SLACK = 1e-9;

function fits(rule: Rule, start: number, end: number, width: number): boolean {
  return end - start <= rule.maxChars && rule.widthOf(start, end) <= width + SLACK;
}

function tokenise(text: string, rule: Rule): { tokens: Token[]; broken: boolean } {
  const tokens: Token[] = [];
  let broken = false;
  const words = /\S+/g;
  for (let match = words.exec(text); match !== null; match = words.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (fits(rule, start, end, rule.maxWidth)) {
      tokens.push({ start, end });
      continue;
    }
    broken = true;
    for (let at = start; at < end; ) {
      let to = at + 1;
      while (to < end && fits(rule, at, to + 1, rule.maxWidth)) to += 1;
      tokens.push({ start: at, end: to });
      at = to;
    }
  }
  return { tokens, broken };
}

function greedyCount(tokens: readonly Token[], rule: Rule, width: number): number {
  let lines = 0;
  let lineStart = -1;
  for (const token of tokens) {
    if (lineStart < 0) {
      lineStart = token.start;
      lines += 1;
    } else if (!fits(rule, lineStart, token.end, width)) {
      lineStart = token.start;
      lines += 1;
    }
  }
  return lines;
}

function greedySpans(tokens: readonly Token[], rule: Rule, width: number): Span[] {
  const spans: Span[] = [];
  let first: Token | null = null;
  let last: Token | null = null;
  for (const token of tokens) {
    if (first === null || last === null) {
      first = token;
      last = token;
    } else if (!fits(rule, first.start, token.end, width)) {
      spans.push({ start: first.start, end: last.end });
      first = token;
      last = token;
    } else {
      last = token;
    }
  }
  if (first !== null && last !== null) spans.push({ start: first.start, end: last.end });
  return spans;
}

function wrapWith(text: string, rule: Rule): Wrapped {
  const { tokens, broken } = tokenise(text, rule);
  if (tokens.length === 0) return { spans: [{ start: 0, end: 0 }], broken: false };
  const lineCount = greedyCount(tokens, rule, rule.maxWidth);
  if (broken || lineCount === 1) return { spans: greedySpans(tokens, rule, rule.maxWidth), broken };

  // Narrowest width that still fits in the minimum number of lines: the longest line is as short as it can be.
  let low = 0;
  for (const token of tokens) low = Math.max(low, rule.widthOf(token.start, token.end));
  let high = rule.maxWidth;
  if (rule.whole) {
    low = Math.max(1, Math.ceil(low - SLACK));
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (greedyCount(tokens, rule, mid) <= lineCount) high = mid;
      else low = mid + 1;
    }
  } else {
    for (let i = 0; i < 48 && high - low > SLACK; i += 1) {
      const mid = (low + high) / 2;
      if (greedyCount(tokens, rule, mid) <= lineCount) high = mid;
      else low = mid;
    }
  }
  const width = high;

  // Among the arrangements in that width, even the lines out (squared slack, last line included, so no orphan).
  const n = tokens.length;
  const cost: number[][] = Array.from({ length: lineCount + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: lineCount + 1 }, () => new Array<number>(n + 1).fill(-1));
  const row0 = cost[0];
  if (row0 !== undefined) row0[0] = 0;
  for (let k = 1; k <= lineCount; k += 1) {
    const row = cost[k];
    const previous = cost[k - 1];
    const origin = from[k];
    if (row === undefined || previous === undefined || origin === undefined) continue;
    for (let j = k; j <= n; j += 1) {
      const lastToken = tokens[j - 1];
      if (lastToken === undefined) continue;
      for (let i = j - 1; i >= k - 1; i -= 1) {
        const firstToken = tokens[i];
        const before = previous[i];
        if (firstToken === undefined || before === undefined) continue;
        if (!fits(rule, firstToken.start, lastToken.end, width)) break;
        const length = rule.widthOf(firstToken.start, lastToken.end);
        const total = before + (width - length) ** 2;
        if (total < (row[j] ?? Infinity)) {
          row[j] = total;
          origin[j] = i;
        }
      }
    }
  }
  const spans: Span[] = [];
  let j = n;
  for (let k = lineCount; k >= 1; k -= 1) {
    const i = from[k]?.[j] ?? -1;
    const firstToken = tokens[i];
    const lastToken = tokens[j - 1];
    if (i < 0 || firstToken === undefined || lastToken === undefined) return { spans: greedySpans(tokens, rule, rule.maxWidth), broken };
    spans.unshift({ start: firstToken.start, end: lastToken.end });
    j = i;
  }
  return { spans, broken };
}

/** Like `wrapText`, but returns where each line lies in `text`, so callers can keep offsets. Fixed pitch: a character is one column. */
export function wrapSpans(text: string, maxCols: number): Wrapped {
  const cols = Math.max(1, Math.floor(maxCols));
  return wrapWith(text, { widthOf: (start, end) => end - start, maxWidth: cols, maxChars: Infinity, whole: true });
}

/**
 * Wraps text set in a proportional face. `prefix[k]` is the width of the first
 * k characters (see `prefixEm`), `maxWidth` is in the same unit, and no line
 * has more than `maxChars` characters whatever their width. Lines are broken at
 * words and balanced exactly as `wrapSpans` balances them.
 */
export function wrapMeasured(text: string, prefix: ArrayLike<number>, maxWidth: number, maxChars: number): Wrapped {
  const at = (index: number): number => prefix[index] ?? 0;
  return wrapWith(text, { widthOf: (start, end) => at(end) - at(start), maxWidth: Math.max(maxWidth, 0), maxChars: Math.max(1, Math.floor(maxChars)), whole: false });
}

/**
 * Breaks text into lines of at most `maxCols` characters at word boundaries,
 * balancing line lengths so a two-line heading is not one long line and an
 * orphan. A single word longer than `maxCols` is broken hard.
 */
export function wrapText(text: string, maxCols: number): string[] {
  return wrapSpans(text, maxCols).spans.map((span) => text.slice(span.start, span.end));
}
