// Two things a brain may leave implicit, settled before a line is scheduled
// or forwarded: which sprite a `| row` belongs to, and the id of anything it
// did not name. After this every line stands alone, which is what lets the
// schedule be a pure function of the lines and lets the wire carry them one
// at a time.

import { isLessonVerb } from './lesson';
import { InterfaceReader, UI_WORDS, nodeLine, screenLine } from './interface';
import { LessonBook, StageBook, textHolds } from './lesson';
import { answerOf, readSum } from './maths/sum';
import { FIGURE_WORDS, figureRowLine } from './figure';
import { shelfReached } from './app';
import { parseLine } from './parse';
import type { Approx, Issue, Line, ParseResult, StyleProps } from './types';
import { LIMITS, STRUCTURE } from './vocabulary';
import type { AppShelf } from './vocabulary';

/** Lines that do not end a sprite being written: its next row may follow them. */
const KEEPS_SPRITE_OPEN: ReadonlySet<string> = new Set(['wait', 'plan', 'color', 'style', 'look', 'cam', 'hit', 'standing', 'refine']);

const ROW_ALPHABET = '.#0123456789abcdefABCDEF';

/** What an app's code reaches for, by shelf word, as the warning names it. */
const SHELF_NAME: Readonly<Record<AppShelf, string>> = { physics: 'Matter', sound: 'Tone', maths: 'katex', charts: 'd3', graphs: 'd3', fonts: 'the shelf fonts', maps: 'World' };

const HEDGE = /\b(about|around|roughly|approximately|approx|nearly|almost|circa|maybe|perhaps)\b|[~\u2248]/i;
const DOUBT_NOTE: Readonly<Record<Approx, string>> = { yes: 'approx.', computed: 'approx.', given: 'approx.', recalled: 'from memory', guessed: 'a guess' };

/**
 * L3. Words marked `approx` are drawn honestly: they say so, in a few words after them, unless they already hedge in their own. The mark is
 * idempotent, so a line the painter reads again (a replay, a fix pass) is not marked twice. The doubt itself stays on the line, for whoever checks.
 */
export function doubted(text: string, approx: Approx): string {
  // already said, anywhere in the words (the brain often writes "(from memory)" itself, before a full stop or in the middle): once is enough (fb-068)
  if (HEDGE.test(text) || /\((?:approx\.|from memory|a guess)\)/.test(text)) return text;
  return `${text} (${DOUBT_NOTE[approx]})`;
}

/**
 * Words are never cut. A text longer than `limit` is split into pieces that each fit, in order and with every character kept (apart from the
 * spaces at the joins): at sentence boundaries when it can, else at the last space before the limit, else hard.
 */
export function splitSpeech(text: string, limit: number = LIMITS.text): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') pieces.push(current);
    current = '';
  };
  const sentences = text.match(/.*?(?:[.!?\u2026]["'\u201d\u2019)\]*]*(?=\s)|$)\s*/gs) ?? [text];
  for (const sentence of sentences) {
    if (sentence === '') continue;
    if ((current + sentence).trimEnd().length <= limit) {
      current += sentence;
      continue;
    }
    flush();
    let rest = sentence;
    while (rest.trimEnd().length > limit) {
      const space = rest.lastIndexOf(' ', limit);
      const at = space > limit / 4 ? space : limit;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trimStart();
    }
    current = rest;
  }
  flush();
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '');
}

/** The id of the n-th piece of a split line: `x24-2`, the base trimmed so the whole stays within the id rule. */
function continuationId(id: string, n: number): string {
  const tail = `-${n}`;
  return `${id.slice(0, LIMITS.name - tail.length)}${tail}`;
}

/** A long `say` as the lines it becomes: the first keeps everything, the rest are its continuations with ids of their own, no time, place or alternates. */
function splitSay(line: Extract<Line, { verb: 'say' }>): Line[] {
  // A choice, a tappable line and a link are one thing to press: kept whole (the painter wraps it), never made into several.
  if (line.styles.includes('choice') || line.props.tap === true || line.href !== undefined) return [line];
  const parts = splitSpeech(line.text);
  if (parts.length < 2) return [line];
  return parts.map((text, index): Line => {
    const last = index === parts.length - 1;
    const { approx: _approx, alts: _alts, ...whole } = line;
    const base = last && line.approx !== undefined ? { ...whole, approx: line.approx } : whole;
    if (index === 0) return { ...base, text };
    const { when: _when, ...rest } = base;
    const { at: _at, near: _near, ...props } = line.props;
    return { ...rest, id: continuationId(line.id, index + 1), props, text };
  });
}

/**
 * L1. Whether a line no verb owns is a sentence the brain wrote as speech: three words or more, mostly letters, no `key=value` and no bar (a line with
 * either is a command that went wrong, and is told so), and not made of numbers and coordinates (a shape that was misnamed).
 */
export function readsAsProse(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length < 3 || /[|=]/.test(text) || !/^["'\u201c(*]?[A-Za-z]/.test(text)) return false;
  const lettered = words.filter((word) => /[A-Za-z]{2}/.test(word)).length;
  const numeric = words.filter((word) => /^[-\d.,x@]+$/.test(word)).length;
  return lettered >= 3 && lettered >= words.length / 2 && numeric <= words.length / 4;
}

/**
 * Markdown's emphasis, taken off words that are to be said: `**bold**`, `__bold__`, `*italic*`, `_italic_` (not the underscores inside a name like
 * `snake_case`), `~~struck~~` and `` `code` ``. Nothing else is touched.
 */
export function withoutEmphasis(text: string): string {
  return text
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '$1')
    .replace(/(^|[^\w])__(\S(?:.*?\S)?)__(?!\w)/g, '$1$2')
    .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(\S(?:[^_]*?\S)?)_(?!\w)/g, '$1$2')
    .replace(/~~(\S(?:.*?\S)?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * fb-008. A markdown list item: a line that begins "- ", "* ", "\u2022 " or "1. " / "1) " and goes on to say something. Its words, the marker and the emphasis taken off, and the
 * marker; null when it is not one, or when nothing with a letter or a digit in it follows the marker (a rule `---`, a lone `-`).
 */
export function bulletOf(text: string): { readonly marker: string; readonly words: string } | null {
  const found = /^([-*\u2022]|\d{1,3}[.)])\s+(\S.*)$/.exec(text.trim());
  if (found?.[1] === undefined || found[2] === undefined) return null;
  const words = withoutEmphasis(found[2]).trim();
  return /[\p{L}\p{N}]/u.test(words) ? { marker: found[1], words } : null;
}

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
  /** v2.2. A mock-up is being written: after a `screen` line, the words of the interface (parts, `row`, `col`, `end`) are its lines and nothing else's */
  private ui = false;
  /** L1. A `when <control>=<value>` block is open: the head every line inside it is given as a `bind` (`stage=2`, `chord="C major"`), until `end` */
  private when: string | null = null;
  /** FG2. A figure is being written: its own words (parts, `route`, `step`) are its rows, and `end` closes it */
  private figure = false;
  private readonly styles: Set<string>;

  /** `definedStyles`: the names of styles the brain defined in earlier turns */
  constructor(definedStyles: Iterable<string> = []) {
    this.styles = new Set(definedStyles);
  }

  read(raw: string): ParseResult {
    let trimmed = raw.trim();
    // L1. `when stage=2` … `end`: each line inside is written as `bind stage=2 | <line>`, which is all the rest of the system knows.
    if (!this.code && !this.tune) {
      const opened = /^when\s+(\S.*?)\s*:?$/i.exec(trimmed);
      if (opened?.[1] !== undefined && !/^[=|]/.test(opened[1])) {
        this.when = opened[1].replace(/\s+then$/i, '');
        return { kind: 'blank' };
      }
      if (this.when !== null) {
        if (/^end(?:\s+when)?$/i.test(trimmed)) {
          this.when = null;
          return { kind: 'blank' };
        }
        const verb = (/^([a-z]+)/i.exec(trimmed)?.[1] ?? '').toLowerCase();
        if (verb === 'scene' || verb === 'deck') this.when = null;
        else if (trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('|') && verb !== 'bind') {
          raw = `bind ${this.when} | ${trimmed}`;
          trimmed = raw;
        }
      }
    }
    if (this.code && trimmed.startsWith('|')) return this.tune && !/^\|(?:\s|$)/.test(trimmed) ? this.musicRow(trimmed) : this.codeRow(raw);
    // ABC as a model writes it: `K:G`, `V:1`, `|: c d e f |`, `A2 B2 c2 d2`. Before any other line has been said, whatever is no verb is music.
    if (this.tune && trimmed !== '' && !trimmed.startsWith('#')) {
      const tried = parseLine(raw);
      if (tried.kind === 'reject' && tried.issues.some((issue) => issue.code === 'unknown-verb')) return this.musicRow(trimmed);
    }
    // FG2. Inside a figure, its own words are its rows exactly as written (`step show=… | …` is the figure's, not a lesson's); `end` closes it.
    if (this.figure) {
      const word = (/^([a-z]+)/i.exec(trimmed)?.[1] ?? '').toLowerCase();
      if (/^end\s*$/i.test(trimmed)) {
        this.figure = false;
        return { kind: 'blank' };
      }
      if (trimmed === '' || trimmed.startsWith('#')) return parseLine(raw);
      if (FIGURE_WORDS.includes(word)) return { kind: 'line', line: { verb: 'row', id: '-', cells: trimmed.slice(0, LIMITS.line - 40) }, issues: [] };
      this.figure = false;
    }
    const interfaced = this.readInterface(raw, trimmed);
    if (interfaced !== null) return interfaced;
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
    // fb-008. A markdown bullet or numbered item that is no Series ("- **Mercury** goes round 8 times", "1. First thing") is said as text, its marker and its emphasis taken off:
    // a list the brain wrote as a list is still its answer, and was refused line by line.
    if (result.kind === 'reject' && result.issues.some((issue) => issue.code === 'unknown-verb')) {
      const item = bulletOf(trimmed);
      if (item !== null) {
        const said = parseLine(`say | ${item.words}`);
        if (said.kind === 'line') {
          const note: Issue = { code: 'said-as-text', severity: 'warn', message: `a markdown bullet is not a verb; the line was said as text. Write \`say | …\` for words`, token: item.marker };
          result = { ...said, issues: [note, ...said.issues] };
        }
      }
    }
    // L1. A line rejected as an unknown verb that reads as a sentence is said: losing a sentence is worse than losing a flourish.
    if (result.kind === 'reject' && result.issues.some((issue) => issue.code === 'unknown-verb') && readsAsProse(trimmed)) {
      const said = parseLine(`say | ${trimmed}`);
      if (said.kind === 'line') {
        // `said-as-text`, not `unknown-verb`: the conductor tells words the brain meant (`say | …`) from a sentence that was only rescued (fb-075)
        const note: Issue = { code: 'said-as-text', severity: 'warn', message: `"${trimmed.split(/\s+/)[0] ?? ''}" is not a verb; the line was said as text. Write \`say | …\` for words`, token: trimmed.split(/\s+/)[0] ?? '' };
        result = { ...said, issues: [note, ...said.issues] };
      }
    }
    if (result.kind !== 'line') return result;
    const { line } = result;
    if (line.verb === 'figure') this.figure = true;
    if (line.verb === 'table' || line.verb === 'chart') this.table = true;
    else if (line.verb === 'scene' || line.verb === 'deck' || line.verb === 'pix' || line.verb in STRUCTURE || isLessonVerb(line.verb)) this.table = false;
    if (line.verb === 'scene' || line.verb === 'deck' || line.verb === 'pix' || line.verb in STRUCTURE || isLessonVerb(line.verb)) this.ui = false;
    if (line.verb === 'code' || line.verb === 'tune' || line.verb === 'app') this.code = true;
    else if (line.verb === 'scene' || line.verb === 'deck' || line.verb === 'pix' || line.verb in STRUCTURE || isLessonVerb(line.verb)) this.code = false;
    this.tune = line.verb === 'tune' || (this.tune && line.verb === 'row');
    if (line.verb === 'style') this.styles.add(line.name);
    if (line.verb === 'pix') this.open = ROW_ALPHABET + Object.keys(line.key).join('');
    else if (line.verb !== 'row' && line.verb !== 'frame' && !KEEPS_SPRITE_OPEN.has(line.verb)) this.open = null;
    return result;
  }

  /**
   * v2.2. The words of an interface are read only inside a screen. The first `screen` line opens the block (a `screen` structure whose title is
   * that line, which the schedule takes as the block's first row); every line after it that is the interface's is a row of it, as written. A
   * `screen` line that already names a block (`screen x3 | screen s1 phone`) is the wire form, and is read as any structure line is.
   */
  private readInterface(raw: string, trimmed: string): ParseResult | null {
    const first = (/^([a-z]+)/i.exec(trimmed)?.[1] ?? '').toLowerCase();
    if (first === 'screen') {
      if (/^screen\s+\S+\s*\|\s*screen\s/i.test(trimmed)) return null;
      const cut = trimmed.slice(0, LIMITS.line - 40);
      if (!this.ui) {
        this.ui = true;
        this.open = null;
        return { kind: 'line', line: { verb: 'screen', id: '-', styles: [], props: {}, title: cut }, issues: [] };
      }
      return { kind: 'line', line: { verb: 'row', id: '-', cells: cut }, issues: [] };
    }
    if (!this.ui || trimmed.startsWith('#') || trimmed.startsWith('|')) return null;
    if (UI_WORDS.includes(first)) return { kind: 'line', line: { verb: 'row', id: '-', cells: trimmed.slice(0, LIMITS.line - 40) }, issues: [] };
    // a word that is no verb at all, inside a screen, is a part the kit does not know: it is set as text, and the brain is told
    const tried = parseLine(raw);
    if (tried.kind === 'reject' && tried.issues.some((issue) => issue.code === 'unknown-verb')) return { kind: 'line', line: { verb: 'row', id: '-', cells: trimmed.slice(0, LIMITS.line - 40) }, issues: [] };
    return null;
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
  /** a long `say` is split: the lines that follow `line`, in order, each already explicit (ingest them one by one, as the lines that follow) */
  readonly rest?: readonly Line[];
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
/**
 * A run of three or more underscores in plain words is a fake blank: it looks like somewhere to write and is not. It is shown as a short line instead, and
 * the brain is told where a real blank comes from (an `ask` for a question to answer). Only words are scrubbed: code,
 * a tune and an app are taken exactly.
 */
const FAKE_BLANK = /_{3,}/g;
function scrubBlanks(line: Line): { readonly line: Line; readonly issues: Issue[] } | null {
  const issue: Issue = { code: 'bad-value', severity: 'warn', message: 'a run of underscores is not a blank and was shown as a short line: a question to answer is an `ask`' };
  if ((line.verb === 'say' || line.verb === 'correct' || line.verb === 'node') && typeof line.text === 'string' && FAKE_BLANK.test(line.text)) {
    FAKE_BLANK.lastIndex = 0;
    return { line: { ...line, text: line.text.replace(FAKE_BLANK, '–') } as Line, issues: [issue] };
  }
  FAKE_BLANK.lastIndex = 0;
  if (line.verb === 'card' && line.title !== undefined && FAKE_BLANK.test(line.title)) {
    FAKE_BLANK.lastIndex = 0;
    return { line: { ...line, title: line.title.replace(FAKE_BLANK, '–') }, issues: [issue] };
  }
  FAKE_BLANK.lastIndex = 0;
  return null;
}

export class LineNormalizer {
  private readonly makeId: () => string;
  private readonly styles: Set<string>;
  private sprite: string | null = null;
  /** the table or chart whose rows are being written */
  private table: string | null = null;
  /** the flow, tree, cycle, timeline or map whose nodes are being written */
  private structure: string | null = null;
  /** v2.2. The mock-up being written: the block's id, and the reader that keeps the stack of open rows and cols so that every line says what it sits in */
  private ui: { readonly id: string; readonly reader: InterfaceReader; told: number } | null = null;
  /** The app being written: which shelves its line asked for, and which it has been told it reaches for without asking (once each) */
  private app: { readonly id: string; readonly asked: readonly AppShelf[]; readonly told: Set<AppShelf> } | null = null;
  /** FG2. The figure being written: its rows get an id each, so that a route and a step can name them */
  private figureRows = 0;
  private figureId: string | null = null;
  /** v3. The parts, steps and asks of the conversation: what `in=` and an id are written from, and what an `ask` that would give itself away is refused by. */
  private readonly book: LessonBook;
  /** HI1. The asks of the scene being written, when no part holds them: they stand on the stage. */
  private readonly asks: StageBook;
  /** PLAN-maths M0. What the written methods of this scene come to, which no words may show: sealed as an ask's `is=` is. A `worked` method seals nothing. */
  private mathAnswers: string[] = [];

  /** SA5. `flow`: a live brain's words and controls are placed by the stage, never by a coordinate. `free`: lines are taken as written (replays, golden, old logs). */
  private readonly placement: 'flow' | 'free';
  /** SA5. The layout of the scene being written: a `free` scene keeps honouring `at=x,y` on words */
  private layout: string | null;

  /** The shape (width over height) of each photo the user gave, by upload id: stamped on a `pic` so that `in=<pic>` addresses the photo's own frame. */
  private readonly photos: Readonly<Record<string, number>>;

  constructor(makeId: () => string, definedStyles: Iterable<string> = [], options: { readonly placement?: 'flow' | 'free'; readonly layout?: string | null; readonly photos?: Readonly<Record<string, number>> } = {}) {
    this.photos = options.photos ?? {};
    this.makeId = makeId;
    this.styles = new Set(definedStyles);
    this.book = new LessonBook(makeId);
    this.asks = new StageBook(makeId);
    this.placement = options.placement ?? 'free';
    this.layout = options.layout ?? null;
  }

  /**
   * SA5. A numeric `at=x,y` on words or a control that is not in a group, not near anything and not in a `free` scene is the brain placing by guess: it is
   * dropped, the line joins the flow, and the brain is told. A callout with a leader keeps its spot: the spot is what the line points to.
   */
  private placedByStage<T extends { readonly props: StyleProps; readonly styles?: readonly string[] }>(line: T): { line: T; issues: Issue[] } {
    const { at, near, in: group, leader } = line.props;
    // A callout or a label at a spot (`say callout at=x,y`) names that spot: its words are the stage's to place, and a line runs from them to the spot.
    const names = line.styles ?? [];
    if (this.placement === 'flow' && (line as { verb?: string }).verb === 'say' && typeof at === 'object' && near === undefined && leader !== false && (names.includes('callout') || names.includes('label') || leader === true)) {
      return { line: leader === true ? line : { ...line, props: { ...line.props, leader: true } }, issues: [] };
    }
    if (this.placement !== 'flow' || at === undefined || typeof at === 'string' || near !== undefined || group !== undefined || leader === true || this.layout === 'free') return { line, issues: [] };
    const { at: _dropped, ...props } = line.props;
    return { line: { ...line, props }, issues: [{ code: 'bad-geometry', severity: 'warn', message: 'placed by the stage', token: 'at' }] };
  }

  /** v3. The conversation's document as it has been written so far: the parts and what each holds. */
  get lessons(): LessonBook {
    return this.book;
  }

  /**
   * A row of an app whose code reaches for a shelf library the app line did not name (`d3.select(…)` with no `uses=charts`): the row is kept as written, and the host loads the
   * library all the same (`shelfOf`), so the app runs. The first row that does says so, once for each library, as a warning: it shows in the log, and the brain is told to say it.
   */
  private shelfNote(id: string, cells: string): Issue[] {
    const app = this.app;
    if (app === null || app.id !== id) return [];
    const issues: Issue[] = [];
    for (const shelf of shelfReached(app.asked, cells)) {
      if (app.told.has(shelf)) continue;
      app.told.add(shelf);
      issues.push({ code: 'uses-inferred', severity: 'warn', message: `the code reaches for ${SHELF_NAME[shelf]} and the app line does not say uses=${shelf}: it was loaded anyway; say uses=${shelf} on the app line`, token: shelf });
    }
    return issues;
  }

  /** A line of the interface, as the line that stands alone: what it is and what it sits in. */
  private interfaceRow(line: Extract<Line, { verb: 'row' }>): Normalized {
    const open = this.ui;
    if (open === null) return { line, issues: [] };
    const read = open.reader.read(line.cells);
    const text = read.kind === 'node' ? nodeLine(read.node, read.parent) : read.kind === 'screen' ? screenLine(read.screen) : 'end';
    const notes = open.reader.document().notes;
    const issues: Issue[] = notes.slice(open.told).map((note) => ({ code: 'unknown-verb', severity: 'warn', message: note.message }));
    open.told = notes.length;
    return { line: { ...line, id: open.id, cells: text }, issues };
  }

  normalize(line: Line): Normalized {
    const whole = this.normalizeWhole(line);
    if (whole.line === null || whole.line.verb !== 'say' || whole.line.text.length <= LIMITS.text) return whole;
    const [first, ...rest] = splitSay(whole.line);
    return { line: first ?? null, issues: whole.issues, ...(rest.length === 0 ? {} : { rest }) };
  }

  private normalizeWhole(line: Line): Normalized {
    const scrubbed = scrubBlanks(line);
    if (scrubbed !== null) {
      const inner = this.normalizeLine(scrubbed.line);
      return { line: inner.line, issues: [...scrubbed.issues, ...inner.issues] };
    }
    return this.normalizeLine(line);
  }

  private normalizeLine(line: Line): Normalized {
    // An old `problem` line (logs and replays hold them) is ordinary canvas content now: the question and a blank to answer, one `ask`
    if (line.verb === 'problem') {
      const label = (line.title ?? '').replace(/_{2,}|□|\[\s*\]/g, '').replace(/\s+/g, ' ').trim();
      const answers = (line.answer ?? []).map((value) => value.replace(/_/g, ' '));
      if (answers.length === 0) return { line: { verb: 'say', id: this.makeId(), styles: [], props: {}, text: label } as Line, issues: [] };
      const id = line.id === '-' ? this.makeId() : line.id;
      // a question whose own words hold its answer (a time, "7:18 is ___ past 7") would be refused as a spoiler: it is said first, and the ask carries no words of it
      const shows = answers.some((value) => new RegExp(`(^|[^\\p{L}\\p{N}])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(label));
      if (shows) {
        const said = { verb: 'say', id: this.makeId(), styles: [], props: {}, text: (line.title ?? '').replace(/_{2,}|□|\[\s*\]/g, '…') } as Line;
        return { line: said, issues: [], rest: [{ verb: 'ask', id, is: answers, text: 'Your answer' } as Line] };
      }
      return this.normalizeLine({ verb: 'ask', id, is: answers, text: label === '' ? 'Your answer' : label } as Line);
    }
    switch (line.verb) {
      case 'style':
        this.styles.add(line.name);
        return { line, issues: [] };
      case 'row': {
        if (line.id !== '-') return { line, issues: this.shelfNote(line.id, line.cells) };
        if (this.sprite !== null) return { line: { ...line, id: this.sprite }, issues: [] };
        if (this.ui !== null) return this.interfaceRow(line);
        if (this.table !== null && this.figureId === this.table) {
          this.figureRows += 1;
          return { line: { ...line, id: this.table, cells: figureRowLine(line.cells, this.figureRows) }, issues: [] };
        }
        if (this.table !== null) return { line: { ...line, id: this.table }, issues: this.shelfNote(this.table, line.cells) };
        if (line.cells.trim() === '') return { line: null, issues: [{ code: 'no-structure', severity: 'warn', message: 'an empty row with no sprite, table or code block to belong to was dropped' }] };
        // Speech after all: a bar and some words, with no sprite open. Not cut to a sprite's width; a long one is split by `normalize`.
        const text = line.cells.trim();
        return { line: { verb: 'say', id: this.makeId(), styles: [], props: {}, text }, issues: [] };
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
        if (line.verb === 'pic') {
          const aspect = this.photos[line.from];
          return { line: { ...line, id, styles, ...(aspect === undefined || line.aspect !== undefined ? {} : { aspect: Math.round(aspect * 10000) / 10000 }) }, issues: [] };
        }
        // A sprite begun after a table takes the rows from here on.
        if (line.verb === 'pix') {
          this.table = null;
          this.ui = null;
        }
        if (line.verb === 'say') {
          // HI1. Words that would show what an open ask accepts are refused; the rest are on the page for the asks written after them.
          const showing = this.asks.asked ? this.asks.showing(line.text) : null;
          if (showing !== null) {
            return { line: null, issues: [{ code: 'spoiler', severity: 'error', message: `these words show ${showing.answer}, which ask ${showing.ask} accepts; the person would see the answer before trying. Say them without it (a bound change can show it once the ask is right)` }] };
          }
          const spoiled = this.mathAnswers.find((answer) => textHolds(line.text, answer));
          if (spoiled !== undefined) {
            return { line: null, issues: [{ code: 'spoiler', severity: 'error', message: `these words show ${spoiled}, which a written method (math) works out for the person; they would see the answer before trying. Say what to do next, not what it comes to` }] };
          }
          this.asks.said(line.text);
          const placed = this.placedByStage({ ...line, id, styles });
          const said = placed.line;
          const marked = said.approx === undefined ? said : { ...said, text: doubted(said.text, said.approx), ...(said.alts === undefined ? {} : { alts: said.alts.map((alt) => doubted(alt, said.approx ?? 'yes')) }) };
          return { line: marked, issues: placed.issues };
        }
        return { line: { ...line, id, styles }, issues: [] };
      }
      case 'screen': {
        // Wire form (`screen x3 | screen s1 phone`): it already says everything and stands alone.
        if (line.id !== '-') return { line, issues: [] };
        const reader = new InterfaceReader();
        const read = reader.read(line.title ?? '');
        const id = this.makeId();
        this.sprite = null;
        this.table = null;
        this.structure = null;
        this.ui = { id, reader, told: 0 };
        return { line: { ...line, id, title: read.kind === 'screen' ? screenLine(read.screen) : (line.title ?? '') }, issues: [] };
      }
      case 'flow':
      case 'tree':
      case 'cycle':
      case 'timeline':
      case 'map':
      case 'table':
      case 'chart':
      case 'code':
      case 'tune':
      case 'figure':
      case 'app': {
        const id = line.id === '-' ? this.makeId() : line.id;
        this.sprite = null;
        this.ui = null;
        this.figureId = line.verb === 'figure' ? id : null;
        this.figureRows = 0;
        this.app = line.verb === 'app' ? { id, asked: line.uses ?? [], told: new Set() } : null;
        this.table = STRUCTURE[line.verb].parts === 'rows' ? id : this.table;
        // A chart takes rows and, as its marks, nodes; a table takes rows only.
        if (STRUCTURE[line.verb].parts === 'nodes' || line.verb === 'chart') this.structure = id;
        // SA5. A room on a structure's opening line is the brain placing by guess: the stage gives the room.
        if (this.placement === 'flow' && line.box !== undefined) {
          const { box: _room, ...rest } = line;
          return { line: { ...rest, id } as typeof line, issues: [{ code: 'bad-geometry', severity: 'warn', message: 'placed by the stage', token: 'box' }] };
        }
        return { line: { ...line, id }, issues: [] };
      }
      case 'node': {
        this.sprite = null;
        const structure = line.props.in ?? this.structure;
        if (structure === null) {
          return { line: null, issues: [{ code: 'no-structure', severity: 'error', message: 'node has no structure to belong to; write flow, tree, cycle, timeline or map first' }] };
        }
        return { line: { ...line, id: line.id === '-' ? this.makeId() : line.id, props: { ...line.props, in: structure }, ...(line.approx === undefined ? {} : { text: doubted(line.text, line.approx) }) }, issues: [] };
      }
      case 'link':
        this.sprite = null;
        return { line: line.id === '-' ? { ...line, id: this.makeId() } : line, issues: [] };
      case 'button':
      case 'toggle':
      case 'slider':
      case 'pick':
      case 'input':
        this.sprite = null;
        return this.placedByStage(line.id === '-' ? { ...line, id: this.makeId() } : line);
      case 'card':
        this.sprite = null;
        return { line: line.id === '-' ? { ...line, id: this.makeId() } : line, issues: [] };
      case 'part':
      case 'step':
      case 'ask':
      case 'hint':
      case 'reply':
      case 'end': {
        // A lesson ends whatever was being written (a sprite, a table, a mock-up): its words are the document's, not the stage's.
        this.sprite = null;
        this.table = null;
        this.structure = null;
        this.ui = null;
        // HI1. An ask that no part holds stands on the stage, with its hints; the reader, the matcher and the seal are the document's.
        if (line.verb === 'ask' && line.in === undefined && this.book.openPart() === null) {
          const read = this.asks.ask(line);
          return { line: read.line, issues: read.issues };
        }
        if (line.verb === 'hint' && this.asks.asked && (line.in === undefined ? this.book.openPart() === null : this.asks.has(line.in))) {
          const read = this.asks.hint(line);
          return { line: read.line, issues: read.issues };
        }
        const read = this.book.read(line);
        return { line: read.line, issues: read.issues };
      }
      case 'math': {
        // The painter computes every digit; the answer is held here, on the server's side of the line, and no `say` may state it.
        this.sprite = null;
        this.table = null;
        const read = readSum(line.method, line.sum);
        if (read.ok && line.worked !== true) this.mathAnswers.push(...answerOf(read.sum));
        // SA5. A room on the opening line is the brain placing by guess: the stage gives the room.
        if (this.placement === 'flow' && line.box !== undefined) {
          const { box: _room, ...rest } = line;
          return { line: rest, issues: [{ code: 'bad-geometry', severity: 'warn', message: 'placed by the stage', token: 'box' }] };
        }
        return { line, issues: [] };
      }
      case 'scene':
      case 'deck':
        if (line.verb === 'scene') this.layout = line.layout ?? 'stack';
        this.mathAnswers = [];
        this.asks.reset();
        this.ui = null;
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
