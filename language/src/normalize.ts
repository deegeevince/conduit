// Two things a brain may leave implicit, settled before a line is scheduled
// or forwarded: which sprite a `| row` belongs to, and the id of anything it
// did not name. After this every line stands alone, which is what lets the
// schedule be a pure function of the lines and lets the wire carry them one
// at a time.

import { parseLine } from './parse';
import type { Issue, Line, ParseResult } from './types';
import { LIMITS, STRUCTURE } from './vocabulary';

/** Lines that do not end a sprite being written: its next row may follow them. */
const KEEPS_SPRITE_OPEN: ReadonlySet<string> = new Set(['wait', 'plan', 'color', 'style', 'look', 'cam', 'hit', 'standing', 'refine']);

const ROW_ALPHABET = '.#0123456789abcdefABCDEF';

/**
 * Reads raw lines in order. It is `parseLine` plus one piece of memory: while
 * a sprite is being written, a line made only of cell characters is a row of
 * it even if the brain forgot the leading bar. Without that, a row of `#`
 * would be read as a comment and a row of digits as an unknown verb.
 */
export class LineReader {
  private open: string | null = null;
  /** a table or a chart is being written: a line of cells without its leading bar is still a row of it */
  private table = false;
  /** a block of code is being written: every line that starts with a bar is a line of it, exactly as written, and a bare bar is an empty one */
  private code = false;
  /** a tune is being written and nothing else has been said since: a line that is no verb at all is a line of its music, bar or no bar */
  private tune = false;
  private readonly styles: Set<string>;

  /** `definedStyles`: the names of styles the brain defined in earlier turns */
  constructor(definedStyles: Iterable<string> = []) {
    this.styles = new Set(definedStyles);
  }

  read(raw: string): ParseResult {
    const trimmed = raw.trim();
    if (this.code && trimmed.startsWith('|')) return this.tune && !/^\|(?:\s|$)/.test(trimmed) ? this.musicRow(trimmed) : this.codeRow(raw);
    // ABC as a model writes it: `K:G`, `V:1`, `|: c d e f |`, `A2 B2 c2 d2`. Before any other line has been said, whatever is no verb is music.
    if (this.tune && trimmed !== '' && !trimmed.startsWith('#')) {
      const tried = parseLine(raw);
      if (tried.kind === 'reject' && tried.issues.some((issue) => issue.code === 'unknown-verb')) return this.musicRow(trimmed);
    }
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
    // `Install | 8,000 | 2,500` under a table: cells whose first word is no verb are a row that lost its leading bar.
    if (result.kind === 'reject' && this.table && trimmed.includes('|') && result.issues.some((issue) => issue.code === 'unknown-verb')) {
      const retried = parseLine(`| ${trimmed}`);
      if (retried.kind === 'line') result = retried;
    }
    if (result.kind !== 'line') return result;
    const { line } = result;
    if (line.verb === 'table' || line.verb === 'chart') this.table = true;
    else if (line.verb === 'scene' || line.verb === 'deck' || line.verb === 'pix' || line.verb in STRUCTURE) this.table = false;
    if (line.verb === 'code' || line.verb === 'tune') this.code = true;
    else if (line.verb === 'scene' || line.verb === 'deck' || line.verb === 'pix' || line.verb in STRUCTURE) this.code = false;
    this.tune = line.verb === 'tune' || (this.tune && line.verb === 'row');
    if (line.verb === 'style') this.styles.add(line.name);
    if (line.verb === 'pix') this.open = ROW_ALPHABET + Object.keys(line.key).join('');
    else if (line.verb !== 'row' && line.verb !== 'frame' && !KEEPS_SPRITE_OPEN.has(line.verb)) this.open = null;
    return result;
  }

  /** A line of code is taken as it stands: one space after the bar is the bar's own, every other is the code's. Trailing space is dropped (it cannot be seen and would not survive the wire). */
  private codeRow(raw: string): ParseResult {
    const after = raw.replace(/\r$/, '').replace(/^\s*\|/, '');
    const cells = (after.startsWith(' ') ? after.slice(1) : after).replace(/\s+$/, '');
    const cap = LIMITS.line - 40;
    const cut = cells.length > cap;
    const issues: Issue[] = cut ? [{ code: 'text-too-long', severity: 'warn', message: `a line of code is cut to ${cap} characters` }] : [];
    return { kind: 'line', line: { verb: 'row', id: '-', cells: cut ? cells.slice(0, cap) : cells }, issues };
  }

  /** A line of music: kept whole, and cut at the line's own limit like a line of code. */
  private musicRow(text: string): ParseResult {
    const cap = LIMITS.line - 40;
    const cut = text.length > cap;
    const issues: Issue[] = cut ? [{ code: 'text-too-long', severity: 'warn', message: `a line of music is cut to ${cap} characters` }] : [];
    return { kind: 'line', line: { verb: 'row', id: '-', cells: cut ? text.slice(0, cap) : text }, issues };
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
 * - `| row` and `frame` are attached to the sprite being written, and a
 *   `| cell | cell` row to the table or chart being written. A `| text` line
 *   with neither open is plain speech.
 * - A `node` is attached to the structure being written (`in=<its id>`).
 *
 * A sprite is closed by the next line that is not one of its rows. A table, a
 * chart and a structure of nodes stay open across speech, waits and changes,
 * so they can be built a part at a time with words between; another structure
 * or a new scene closes them.
 *
 * The server runs this once per line before scheduling and forwarding, so the
 * painter only ever receives explicit lines and never needs one.
 */
export class LineNormalizer {
  private readonly makeId: () => string;
  private readonly styles: Set<string>;
  private sprite: string | null = null;
  /** the table or chart whose rows are being written */
  private table: string | null = null;
  /** the flow, tree, cycle, timeline or map whose nodes are being written */
  private structure: string | null = null;

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
        if (this.table !== null) return { line: { ...line, id: this.table }, issues: [] };
        if (line.cells.trim() === '') return { line: null, issues: [{ code: 'no-structure', severity: 'warn', message: 'an empty row with no sprite, table or code block to belong to was dropped' }] };
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
      case 'pic':
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
        // A sprite begun after a table takes the rows from here on.
        if (line.verb === 'pix') this.table = null;
        return { line: { ...line, id, styles }, issues: [] };
      }
      case 'flow':
      case 'tree':
      case 'cycle':
      case 'timeline':
      case 'map':
      case 'table':
      case 'chart':
      case 'code':
      case 'tune': {
        const id = line.id === '-' ? this.makeId() : line.id;
        this.sprite = null;
        if (STRUCTURE[line.verb].parts === 'rows') this.table = id;
        // A chart takes rows and, as its marks, nodes; a table takes rows only.
        if (STRUCTURE[line.verb].parts === 'nodes' || line.verb === 'chart') this.structure = id;
        return { line: { ...line, id }, issues: [] };
      }
      case 'node': {
        this.sprite = null;
        const structure = line.props.in ?? this.structure;
        if (structure === null) {
          return { line: null, issues: [{ code: 'no-structure', severity: 'error', message: 'node has no structure to belong to; write flow, tree, cycle, timeline or map first' }] };
        }
        return { line: { ...line, id: line.id === '-' ? this.makeId() : line.id, props: { ...line.props, in: structure } }, issues: [] };
      }
      case 'link':
      case 'button':
      case 'toggle':
      case 'slider':
      case 'pick':
      case 'input':
      case 'card':
        this.sprite = null;
        return { line: line.id === '-' ? { ...line, id: this.makeId() } : line, issues: [] };
      case 'scene':
      case 'deck':
        this.sprite = null;
        this.table = null;
        this.structure = null;
        return { line, issues: [] };
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
