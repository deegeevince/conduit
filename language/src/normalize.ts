// Two things a brain may leave implicit, settled before a line is scheduled
// or forwarded: which sprite a `| row` belongs to, and the id of anything it
// did not name. After this every line stands alone, which is what lets the
// schedule be a pure function of the lines and lets the wire carry them one
// at a time.

import { parseLine } from './parse';
import type { Issue, Line, ParseResult } from './types';
import { LIMITS } from './vocabulary';

/** Lines that do not end a sprite being written: its next row may follow them. */
const KEEPS_SPRITE_OPEN: ReadonlySet<string> = new Set(['wait', 'plan', 'color', 'style', 'look', 'cam', 'hit']);

const ROW_ALPHABET = '.#0123456789abcdefABCDEF';

/**
 * Reads raw lines in order. It is `parseLine` plus one piece of memory: while
 * a sprite is being written, a line made only of cell characters is a row of
 * it even if the brain forgot the leading bar. Without that, a row of `#`
 * would be read as a comment and a row of digits as an unknown verb.
 */
export class LineReader {
  private open: string | null = null;
  private readonly styles: Set<string>;

  /** `definedStyles`: the names of styles the brain defined in earlier turns */
  constructor(definedStyles: Iterable<string> = []) {
    this.styles = new Set(definedStyles);
  }

  read(raw: string): ParseResult {
    const trimmed = raw.trim();
    if (this.open !== null && trimmed.length >= 2 && !trimmed.startsWith('|') && this.isRow(trimmed)) return parseLine(`| ${trimmed}`);
    let result = parseLine(raw);
    // `fear | What if I can't?`: the name of a style the brain defined, where the verb goes, is speech in that style.
    if (result.kind === 'reject' && trimmed.includes('|')) {
      const first = trimmed.split(/\s+/)[0]?.toLowerCase().replace(/:$/, '') ?? '';
      if (this.styles.has(first)) {
        const retried = parseLine(`say ${trimmed}`);
        if (retried.kind === 'line') {
          const note: Issue = { code: 'unknown-verb', severity: 'warn', message: `"${first}" is a style, not a verb; read as: say ${first} | …`, token: first };
          result = { ...retried, issues: [note, ...retried.issues] };
        }
      }
    }
    if (result.kind !== 'line') return result;
    const { line } = result;
    if (line.verb === 'style') this.styles.add(line.name);
    if (line.verb === 'pix') this.open = ROW_ALPHABET + Object.keys(line.key).join('');
    else if (line.verb !== 'row' && line.verb !== 'frame' && !KEEPS_SPRITE_OPEN.has(line.verb)) this.open = null;
    return result;
  }

  private isRow(text: string): boolean {
    const alphabet = this.open ?? '';
    for (const char of text) if (!alphabet.includes(char)) return false;
    return true;
  }
}

export interface Normalized {
  /** null when the line had nothing to attach to and was dropped */
  readonly line: Line | null;
  readonly issues: readonly Issue[];
}

/**
 * Makes every line explicit, in arrival order, for one conversation.
 *
 * - An element nobody named gets an id from `makeId` (`x1`, `x2`, …).
 * - On a `say` line, a first word that is the name of a style the brain
 *   defined is a style, not an id: `say fear | What if I can't?` means what
 *   it looks like.
 * - `| row` and `frame` are attached to the sprite being written. A `| text`
 *   line with no sprite open is plain speech.
 *
 * The server runs this once per line before scheduling and forwarding, so the
 * painter only ever receives explicit lines and never needs one.
 */
export class LineNormalizer {
  private readonly makeId: () => string;
  private readonly styles: Set<string>;
  private sprite: string | null = null;

  constructor(makeId: () => string, definedStyles: Iterable<string> = []) {
    this.makeId = makeId;
    this.styles = new Set(definedStyles);
  }

  normalize(line: Line): Normalized {
    switch (line.verb) {
      case 'style':
        this.styles.add(line.name);
        return { line, issues: [] };
      case 'row': {
        if (line.id !== '-') return { line, issues: [] };
        if (this.sprite !== null) return { line: { ...line, id: this.sprite }, issues: [] };
        // Speech after all: a bar and some words, with no sprite open. Not cut to a sprite's width.
        const text = line.cells.trim();
        const cut = text.length > LIMITS.text;
        return {
          line: { verb: 'say', id: this.makeId(), styles: [], props: {}, text: cut ? `${text.slice(0, LIMITS.text - 1)}…` : text },
          issues: cut ? [{ code: 'text-too-long', severity: 'warn', message: `text cut to ${LIMITS.text} characters; say less per line` }] : [],
        };
      }
      case 'frame': {
        if (line.id !== '-') {
          this.sprite = line.id;
          return { line, issues: [] };
        }
        if (this.sprite !== null) return { line: { ...line, id: this.sprite }, issues: [] };
        return { line: null, issues: [{ code: 'no-sprite', severity: 'error', message: 'frame has no sprite to belong to; write a pix line first' }] };
      }
      case 'say':
      case 'circle':
      case 'ellipse':
      case 'rect':
      case 'line':
      case 'poly':
      case 'path':
      case 'pix':
      case 'use':
      case 'paint':
      case 'ambient': {
        let { id } = line;
        let { styles } = line;
        // Only speech: a drawn thing may share its name with a style without being mistaken for one.
        if (line.verb === 'say' && id !== '-' && this.styles.has(id)) {
          styles = [id, ...styles];
          id = '-';
        }
        if (id === '-') id = this.makeId();
        this.sprite = line.verb === 'pix' ? id : null;
        return { line: { ...line, id, styles }, issues: [] };
      }
      default:
        if (!KEEPS_SPRITE_OPEN.has(line.verb)) this.sprite = null;
        return { line, issues: [] };
    }
  }
}

export interface ScriptLine {
  readonly lineNumber: number;
  readonly raw: string;
  readonly issues: readonly Issue[];
}

export interface ParsedScript {
  readonly lines: readonly Line[];
  readonly rejects: readonly ScriptLine[];
  readonly warnings: readonly ScriptLine[];
}

/** Parses and normalises a whole script. For fixtures and tools; a live stream uses `LineAssembler`, `LineReader` and `LineNormalizer`. */
export function parseScript(source: string): ParsedScript {
  const lines: Line[] = [];
  const rejects: ScriptLine[] = [];
  const warnings: ScriptLine[] = [];
  const reader = new LineReader();
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  source.split('\n').forEach((raw, index) => {
    const result = reader.read(raw);
    if (result.kind === 'reject') rejects.push({ lineNumber: index + 1, raw, issues: result.issues });
    if (result.kind !== 'line') return;
    const normalized = normalizer.normalize(result.line);
    const issues = [...result.issues, ...normalized.issues];
    if (normalized.line === null) {
      rejects.push({ lineNumber: index + 1, raw, issues });
      return;
    }
    if (issues.length > 0) warnings.push({ lineNumber: index + 1, raw, issues });
    lines.push(normalized.line);
  });
  return { lines, rejects, warnings };
}
