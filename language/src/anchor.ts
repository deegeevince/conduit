// The anchor: an object id plus a selector. Pure and shared by the server and the page; it never holds a screen coordinate.
// `Anchor` in vocabulary.ts is a named place (`top`, `center`) and keeps its name; this is `DocAnchor`.
import type { Structure } from './source';
import { cellOf } from './source';
import type { Op } from './annotate';

/** 'u3' a source (photo, PDF, sheet, recording, fetched page) · 'w1/s2/q7' a document node · 'w1/#2:rev' element `rev` of a scene */
export type ObjectId = string;
/** 0..1 of the object's own width or height, upright, from its top left: `UploadCrop`'s convention */
export type Frac = number;

export type Selector =
  /** the quote with 24 characters either side, plus the position. `scope` says which run of text inside the object: `p2`, `B4`, `cell:1:2`, `label`, `''` (the whole) */
  | { readonly kind: 'text'; readonly scope: string; readonly quote: string; readonly prefix: string; readonly suffix: string; readonly start: number; readonly end: number; readonly tail?: string }
  /** 'B2:D9'; one cell is 'B2' */
  | { readonly kind: 'cells'; readonly sheet: string; readonly range: string }
  /** seconds; from === to is a moment */
  | { readonly kind: 'time'; readonly from: number; readonly to: number }
  /** a picture is page 1 */
  | { readonly kind: 'region'; readonly page: number; readonly box: readonly [x: Frac, y: Frac, w: Frac, h: Frac] }
  /** a page or a slide, from 1 */
  | { readonly kind: 'page'; readonly page: number }
  /** a place in the object's own tree; '' is the whole object */
  | { readonly kind: 'node'; readonly path: string }
  /** a mock-up's 'screen/part', as `mockups()` names them */
  | { readonly kind: 'part'; readonly path: string }
  /** a point, or a range of x; x as the axis says it */
  | { readonly kind: 'chart'; readonly series: string | null; readonly x: string; readonly to?: string; readonly y?: number };

export type SelectorKind = Selector['kind'];
export const SELECTOR_KINDS = ['text', 'cells', 'time', 'region', 'page', 'node', 'part', 'chart'] as const satisfies readonly SelectorKind[];

export interface DocAnchor {
  readonly on: ObjectId;
  readonly sel: Selector;
}

/** '^1', '^2': the person's, numbered by the fold. '^terms': the mind's, named by it. */
export type AnchorId = string;
/** `said`: the words it covers or what it is, fixed when made */
export interface Pinned {
  readonly id: AnchorId;
  readonly anchor: DocAnchor;
  readonly by: 'you' | 'mind';
  readonly seq: number;
  readonly said: string;
}

export type Resolved = { readonly state: 'exact' | 'moved' | 'orphan'; readonly sel: Selector };

export const ANCHOR_LIMITS = { quote: 240, context: 24, bytes: 600, perAction: 16, perTurn: 32, perDocument: 2000 } as const;

const OBJECT_ID = /^[A-Za-z0-9_][A-Za-z0-9_./#:-]{0,119}$/;
const ANCHOR_ID = /^\^(?:[1-9]\d{0,5}|[a-z][a-z0-9_-]{0,31})$/;
export function isObjectId(value: unknown): value is ObjectId {
  return typeof value === 'string' && OBJECT_ID.test(value);
}
export function isAnchorId(value: unknown): value is AnchorId {
  return typeof value === 'string' && ANCHOR_ID.test(value);
}
/** `^3` is the fold's number; `^terms` is the mind's own name. */
export function isNumberedAnchorId(id: AnchorId): boolean {
  return /^\^\d+$/.test(id);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Small decoders every new wire shape is read through (review R6). They are exported for annotate.ts, action.ts and source.ts.
// ---------------------------------------------------------------------------------------------------------------------------------

export const guards = {
  rec(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  },
  /** a string of at most `max` characters, without control characters other than a tab */
  str(value: unknown, max: number, min = 0): string | null {
    if (typeof value !== 'string' || value.length > max || value.length < min) return null;
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value) ? null : value;
  },
  int(value: unknown, min: number, max: number): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
  },
  num(value: unknown, min: number, max: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
  },
  list(value: unknown, max: number): readonly unknown[] | null {
    return Array.isArray(value) && value.length <= max ? (value as readonly unknown[]) : null;
  },
} as const;

/** The UTF-8 length of a string (the page and the server both lack `TextEncoder` in these typings). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const round = (value: number, places: number): number => Number(value.toFixed(places));

// ---------------------------------------------------------------------------------------------------------------------------------
// Cell ranges
// ---------------------------------------------------------------------------------------------------------------------------------

export interface CellBox {
  readonly c1: number;
  readonly r1: number;
  readonly c2: number;
  readonly r2: number;
}

const CELL_RANGE = /^([A-Z]{1,3})([1-9]\d{0,6})(?::([A-Z]{1,3})([1-9]\d{0,6}))?$/;

export function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function columnLetters(n: number): string {
  let out = '';
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) out = String.fromCharCode(65 + ((rest - 1) % 26)) + out;
  return out;
}

/** 'B2:D9' or 'B2' to its corners, in order; null when it is not a range. */
export function parseCellRange(text: string): CellBox | null {
  const m = CELL_RANGE.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const a = { c: columnNumber(m[1]), r: Number(m[2]) };
  const b = m[3] === undefined || m[4] === undefined ? a : { c: columnNumber(m[3]), r: Number(m[4]) };
  if (a.c > 18278 || b.c > 18278) return null;
  return { c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) };
}

/** The one written form: a single cell is 'B2', else 'B2:D9'. */
export function formatCellRange(box: CellBox): string {
  const a = `${columnLetters(box.c1)}${box.r1}`;
  return box.c1 === box.c2 && box.r1 === box.r2 ? a : `${a}:${columnLetters(box.c2)}${box.r2}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------------------------------------------------------------

function readSelector(raw: unknown): Selector | null {
  if (!guards.rec(raw)) return null;
  switch (raw.kind) {
    case 'text': {
      const scope = guards.str(raw.scope, 64);
      const quote = guards.str(raw.quote, ANCHOR_LIMITS.quote, 1);
      const prefix = guards.str(raw.prefix, ANCHOR_LIMITS.context);
      const suffix = guards.str(raw.suffix, ANCHOR_LIMITS.context);
      const start = guards.int(raw.start, -1, 50_000_000);
      const end = guards.int(raw.end, -1, 50_000_000);
      if (scope === null || quote === null || prefix === null || suffix === null || start === null || end === null) return null;
      if (!(start === -1 && end === -1) && !(start >= 0 && end > start)) return null;
      if (raw.tail === undefined) return { kind: 'text', scope, quote, prefix, suffix, start, end };
      const tail = guards.str(raw.tail, ANCHOR_LIMITS.quote / 2, 1);
      return tail === null ? null : { kind: 'text', scope, quote, prefix, suffix, start, end, tail };
    }
    case 'cells': {
      const sheet = guards.str(raw.sheet, 64);
      const box = typeof raw.range === 'string' ? parseCellRange(raw.range) : null;
      return sheet === null || box === null ? null : { kind: 'cells', sheet, range: formatCellRange(box) };
    }
    case 'time': {
      const from = guards.num(raw.from, 0, 86_400 * 7);
      const to = guards.num(raw.to, 0, 86_400 * 7);
      return from === null || to === null || to < from ? null : { kind: 'time', from: round(from, 3), to: round(to, 3) };
    }
    case 'region': {
      const page = guards.int(raw.page, 1, 100_000);
      const box = guards.list(raw.box, 4);
      if (page === null || box === null || box.length !== 4) return null;
      const [x, y, w, h] = box.map((v) => guards.num(v, 0, 1));
      if (x === null || y === null || w === null || h === null || x === undefined || y === undefined || w === undefined || h === undefined) return null;
      return { kind: 'region', page, box: [round(x, 4), round(y, 4), round(w, 4), round(h, 4)] };
    }
    case 'page': {
      const page = guards.int(raw.page, 1, 100_000);
      return page === null ? null : { kind: 'page', page };
    }
    case 'node':
    case 'part': {
      const path = guards.str(raw.path, 200);
      return path === null ? null : { kind: raw.kind, path };
    }
    case 'chart': {
      const series = raw.series === null ? null : guards.str(raw.series, 64, 1);
      const x = guards.str(raw.x, 64, 1);
      if (x === null || (raw.series !== null && series === null)) return null;
      const out: { series: string | null; x: string; to?: string; y?: number } = { series, x };
      if (raw.to !== undefined) {
        const to = guards.str(raw.to, 64, 1);
        if (to === null) return null;
        out.to = to;
      }
      if (raw.y !== undefined) {
        const y = guards.num(raw.y, -1e15, 1e15);
        if (y === null) return null;
        out.y = y;
      }
      return { kind: 'chart', series: out.series, x: out.x, ...(out.to !== undefined && { to: out.to }), ...(out.y !== undefined && { y: out.y }) };
    }
    default:
      return null;
  }
}

/** The wire's decoder: a fresh, canonical, bounded `DocAnchor`, or null. Nothing it does not know survives. */
export function readAnchor(raw: unknown): DocAnchor | null {
  if (!guards.rec(raw) || !isObjectId(raw.on)) return null;
  const sel = readSelector(raw.sel);
  if (sel === null) return null;
  const anchor: DocAnchor = { on: raw.on, sel };
  return utf8Length(JSON.stringify(anchor)) <= ANCHOR_LIMITS.bytes ? anchor : null;
}

/** A list of anchors, bounded by `max`; null when any one is bad (a half-read action would mean something else). */
export function readAnchors(raw: unknown, max: number = ANCHOR_LIMITS.perAction): readonly DocAnchor[] | null {
  const list = guards.list(raw, max);
  if (list === null) return null;
  const out: DocAnchor[] = [];
  for (const item of list) {
    const anchor = readAnchor(item);
    if (anchor === null) return null;
    out.push(anchor);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The text form: `u3 page=2 span=36..82 | pay each invoice…`, and the tokens of a language line
// ---------------------------------------------------------------------------------------------------------------------------------

/** One value in a token: a space is `_`, and `%`, `_`, `|`, `=` and any other white space are `%XX` (or `%uXXXX`). */
export function encodeToken(value: string): string {
  return value.replace(/[%_|=\s]/g, (ch) => {
    if (ch === ' ') return '_';
    const code = ch.charCodeAt(0);
    return code < 256 ? `%${code.toString(16).padStart(2, '0')}` : `%u${code.toString(16).padStart(4, '0')}`;
  });
}

export function decodeToken(value: string): string {
  return value.replace(/_/g, ' ').replace(/%(?:u([0-9a-fA-F]{4})|([0-9a-fA-F]{2}))/g, (_all, wide: string | undefined, narrow: string | undefined) =>
    String.fromCharCode(Number.parseInt(wide ?? narrow ?? '0', 16)),
  );
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The tokens after the verb and the name: `on=u3 page=2 span=36..82`. A text selector's quote is not here; it is the line's words. */
export function anchorTokens(anchor: DocAnchor): string[] {
  const out: string[] = [`on=${anchor.on}`];
  const sel = anchor.sel;
  switch (sel.kind) {
    case 'text': {
      const page = /^p([1-9]\d*)$/.exec(sel.scope);
      if (page?.[1] !== undefined) out.push(`page=${page[1]}`);
      else if (sel.scope !== '') out.push(`scope=${encodeToken(sel.scope)}`);
      if (sel.start >= 0) out.push(`span=${sel.start}..${sel.end}`);
      if (sel.tail !== undefined) out.push(`tail=${encodeToken(flat(sel.tail))}`);
      break;
    }
    case 'cells':
      out.push(`sheet=${encodeToken(sel.sheet)}`, `cells=${sel.range}`);
      break;
    case 'time':
      out.push(`t=${sel.from === sel.to ? sel.from : `${sel.from}..${sel.to}`}`);
      break;
    case 'region':
      out.push(`page=${sel.page}`, `box=${sel.box.join(',')}`);
      break;
    case 'page':
      out.push(`page=${sel.page}`);
      break;
    case 'node':
      if (sel.path !== '') out.push(`node=${encodeToken(sel.path)}`);
      break;
    case 'part':
      out.push(`part=${encodeToken(sel.path)}`);
      break;
    case 'chart':
      out.push(`x=${encodeToken(sel.x)}`);
      if (sel.to !== undefined) out.push(`to=${encodeToken(sel.to)}`);
      if (sel.series !== null) out.push(`series=${encodeToken(sel.series)}`);
      if (sel.y !== undefined) out.push(`y=${sel.y}`);
      break;
  }
  return out;
}

/** The words after the bar: a text selector's quote. */
export function anchorQuote(anchor: DocAnchor): string | null {
  return anchor.sel.kind === 'text' ? flat(anchor.sel.quote) : null;
}

/** The one text form of an anchor: 'u3 page=2 span=36..82 | pay each invoice…'. The prefix and suffix are not in it; the server finds them. */
export function writeAnchor(anchor: DocAnchor): string {
  const head = anchorTokens(anchor).map((token, index) => (index === 0 ? token.slice(3) : token)).join(' ');
  const quote = anchorQuote(anchor);
  return quote === null ? head : `${head} | ${quote}`;
}

export interface PairWord {
  readonly key: string;
  readonly raw: string;
}

export type AnchorRead = { readonly anchor: DocAnchor; readonly unused: readonly PairWord[] } | { readonly problem: string };

const SPAN = /^(\d+)\.\.(\d+)$/;
const TIME = /^(\d+(?:\.\d+)?)(?:\.\.(\d+(?:\.\d+)?))?$/;

/**
 * An anchor out of the `key=value` pairs of a line and its words (the quote of a text selector, or what a picture region is). Keys it does
 * not use come back in `unused`. Lossy only where the line is: `prefix` and `suffix` are empty, and `start`/`end` are -1 without a `span=`.
 */
export function anchorFromPairs(pairs: readonly PairWord[], words: string | null): AnchorRead {
  const get = new Map<string, string>();
  const unused: PairWord[] = [];
  const own = new Set(['on', 'page', 'span', 'scope', 'tail', 'sheet', 'cells', 'cell', 't', 'time', 'box', 'node', 'part', 'x', 'to', 'series', 'y']);
  for (const pair of pairs) {
    if (own.has(pair.key) && !get.has(pair.key)) get.set(pair.key, pair.raw);
    else unused.push(pair);
  }
  const on = get.get('on');
  if (on === undefined || !isObjectId(on)) return { problem: on === undefined ? 'an anchor needs on=<object id>' : `on=${on} is not an object id` };
  const done = (sel: Selector): AnchorRead => {
    const anchor = readAnchor({ on, sel });
    return anchor === null ? { problem: 'the anchor is too long or out of range' } : { anchor, unused };
  };
  const quote = words === null ? '' : flat(words);
  const pageText = get.get('page');
  const page = pageText === undefined ? null : /^[1-9]\d{0,5}$/.test(pageText) ? Number(pageText) : NaN;
  if (page !== null && Number.isNaN(page)) return { problem: `page=${pageText} is not a page number` };
  const cells = get.get('cells') ?? get.get('cell');
  const time = get.get('t') ?? get.get('time');
  const kinds = [cells !== undefined, time !== undefined, get.has('box'), get.has('part'), get.has('x'), get.has('node')].filter(Boolean).length;
  if (kinds > 1) return { problem: 'an anchor has one selector: cells, t, box, part, x or node' };
  if (cells !== undefined) {
    const range = parseCellRange(cells.toUpperCase());
    const sheet = get.get('sheet');
    if (range === null) return { problem: `cells=${cells} is not a range like B2:D9` };
    return done({ kind: 'cells', sheet: sheet === undefined ? '' : decodeToken(sheet), range: formatCellRange(range) });
  }
  if (time !== undefined) {
    const m = TIME.exec(time);
    if (m?.[1] === undefined) return { problem: `t=${time} is not seconds like 12.5 or 12.5..31` };
    return done({ kind: 'time', from: Number(m[1]), to: Number(m[2] ?? m[1]) });
  }
  const box = get.get('box');
  if (box !== undefined) {
    const parts = box.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { problem: `box=${box} is not four fractions: x,y,w,h` };
    return done({ kind: 'region', page: page ?? 1, box: parts as unknown as readonly [number, number, number, number] });
  }
  const part = get.get('part');
  if (part !== undefined) return done({ kind: 'part', path: decodeToken(part) });
  const x = get.get('x');
  if (x !== undefined) {
    const y = get.get('y');
    const to = get.get('to');
    const series = get.get('series');
    const yNumber = y === undefined ? undefined : Number(y);
    if (yNumber !== undefined && !Number.isFinite(yNumber)) return { problem: `y=${y} is not a number` };
    return done({ kind: 'chart', series: series === undefined ? null : decodeToken(series), x: decodeToken(x), ...(to !== undefined && { to: decodeToken(to) }), ...(yNumber !== undefined && { y: yNumber }) });
  }
  // The words make it a text selector (the mind writes a quote only); no words and a page is the page; no words at all is the whole object.
  const spanText = get.get('span');
  const span = spanText === undefined ? null : SPAN.exec(spanText);
  if (spanText !== undefined && span === null) return { problem: `span=${spanText} is not two offsets like 36..82` };
  const scopeText = get.get('scope');
  if (quote !== '' || span !== null || scopeText !== undefined) {
    if (quote === '') return { problem: 'a text anchor needs the exact words after the bar' };
    const scope = page !== null ? `p${page}` : scopeText === undefined ? '' : decodeToken(scopeText);
    const tail = get.get('tail');
    const start = span?.[1] === undefined ? -1 : Number(span[1]);
    const end = span?.[2] === undefined ? -1 : Number(span[2]);
    return done({ kind: 'text', scope, quote, prefix: '', suffix: '', start, end, ...(tail !== undefined && { tail: decodeToken(tail) }) });
  }
  if (page !== null) return done({ kind: 'page', page });
  return done({ kind: 'node', path: get.has('node') ? decodeToken(get.get('node') ?? '') : '' });
}

/** The reverse of `writeAnchor` (and of the line's own tokens): 'u3 page=2 span=36..82 | words' or 'on=u3 …'. */
export function readAnchorText(text: string): DocAnchor | null {
  const bar = text.indexOf('|');
  const head = (bar < 0 ? text : text.slice(0, bar)).trim().split(/\s+/).filter((t) => t !== '');
  const words = bar < 0 ? null : text.slice(bar + 1);
  const pairs: PairWord[] = [];
  head.forEach((token, index) => {
    const eq = token.indexOf('=');
    if (eq > 0) pairs.push({ key: token.slice(0, eq).toLowerCase(), raw: token.slice(eq + 1) });
    else if (index === 0) pairs.push({ key: 'on', raw: token });
  });
  const read = anchorFromPairs(pairs, words);
  return 'anchor' in read && read.unused.length === 0 ? read.anchor : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// resolve: the quote survives an edit we did not make
// ---------------------------------------------------------------------------------------------------------------------------------

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

type TextSel = Extract<Selector, { kind: 'text' }>;

function freshContext(sel: TextSel, text: string, start: number, end: number): Selector {
  return {
    ...sel,
    start,
    end,
    prefix: text.slice(Math.max(0, start - ANCHOR_LIMITS.context), start),
    suffix: text.slice(end, end + ANCHOR_LIMITS.context),
  };
}

/**
 * A text selector against the text it was made on, now. `exact`: the words are still at the position. `moved`: the words are found elsewhere, and
 * where there are several the one whose prefix and suffix agree most and which is nearest the old place wins; a tie is not broken, it is `orphan`
 * (never a guess). `orphan`: the words are not there, or are there in two places that cannot be told apart.
 */
export function resolveText(sel: TextSel, text: string): Resolved {
  const lost: Resolved = { state: 'orphan', sel };
  if (sel.quote === '') return lost;
  const { quote, tail } = sel;
  if (sel.start >= 0 && sel.end > sel.start && sel.end <= text.length) {
    const head = text.slice(sel.start, sel.start + quote.length) === quote;
    const rest = tail === undefined ? text.slice(sel.start, sel.end) === quote : text.slice(sel.end - tail.length, sel.end) === tail && sel.end - sel.start >= quote.length + tail.length;
    if (head && rest) return { state: 'exact', sel };
  }
  const found: { start: number; end: number; score: number }[] = [];
  for (let at = text.indexOf(quote); at >= 0 && found.length < 2000; at = text.indexOf(quote, at + 1)) {
    let end = at + quote.length;
    if (tail !== undefined) {
      const t = text.indexOf(tail, end);
      if (t < 0) continue;
      end = t + tail.length;
    }
    const before = text.slice(Math.max(0, at - ANCHOR_LIMITS.context), at);
    const after = text.slice(end, end + ANCHOR_LIMITS.context);
    const pre = sel.prefix === '' ? 0 : commonSuffix(before, sel.prefix) / sel.prefix.length;
    const suf = sel.suffix === '' ? 0 : commonPrefix(after, sel.suffix) / sel.suffix.length;
    const near = sel.start < 0 ? 0 : 1 - Math.min(1, Math.abs(at - sel.start) / Math.max(1, text.length));
    found.push({ start: at, end, score: 0.35 * pre + 0.35 * suf + 0.3 * near });
  }
  if (found.length === 0) return lost;
  found.sort((a, b) => b.score - a.score || a.start - b.start);
  const best = found[0];
  const next = found[1];
  if (best === undefined) return lost;
  if (next !== undefined && next.score - best.score > -1e-9) return lost;
  return { state: 'moved', sel: freshContext(sel, text, best.start, best.end) };
}

/**
 * Where an anchor's piece is now, in the structure of the source it was made on. Total: it never throws and never guesses.
 * `known` is the stage's own census for the two selectors a source's structure cannot speak for (`part`, `chart`); without it they are `orphan`.
 */
export function resolve(anchor: DocAnchor, structure: Structure, known?: (anchor: DocAnchor) => boolean): Resolved {
  const sel = anchor.sel;
  const lost: Resolved = { state: 'orphan', sel };
  const exact: Resolved = { state: 'exact', sel };
  if (sel.kind === 'part' || sel.kind === 'chart') return known?.(anchor) === true ? exact : lost;
  if (structure.source !== anchor.on) return lost;
  switch (sel.kind) {
    case 'text': {
      const text = textOfScope(structure, sel.scope);
      return text === null ? lost : resolveText(sel, text);
    }
    case 'cells': {
      const box = parseCellRange(sel.range);
      const sheet = structure.sheets?.find((s) => s.name === sel.sheet) ?? (sel.sheet === '' ? structure.sheets?.[0] : undefined);
      if (box === null || sheet === undefined) return lost;
      return box.r2 <= sheet.rows && box.c2 <= sheet.cols ? exact : lost;
    }
    case 'time': {
      const words = structure.words;
      if (words === undefined || words.length === 0) return exact;
      const last = words.reduce((m, w) => Math.max(m, w.t + w.d), 0);
      return sel.to <= last + 1e-6 ? exact : lost;
    }
    case 'region': {
      const page = structure.pages[sel.page - 1];
      const [x, y, w, h] = sel.box;
      return page !== undefined && x + w <= 1 + 1e-6 && y + h <= 1 + 1e-6 ? exact : lost;
    }
    case 'page':
      return sel.page <= structure.pages.length ? exact : lost;
    case 'node':
      return sel.path === '' || structure.blocks?.some((b) => b.path === sel.path) === true ? exact : lost;
  }
}

/** The text a `scope` names in a structure, or null when it names nothing a source holds. */
export function textOfScope(structure: Structure, scope: string): string | null {
  const page = /^p([1-9]\d*)$/.exec(scope);
  if (page?.[1] !== undefined) return structure.pages[Number(page[1]) - 1]?.text ?? null;
  if (scope === '') return structure.pages.length >= 1 && (structure.words !== undefined || structure.pages.length === 1) ? (structure.pages[0]?.text ?? null) : null;
  const cell = cellOf(structure, scope);
  return cell === null ? null : cell.v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// rebase: an edit we made moves the anchor by rule
// ---------------------------------------------------------------------------------------------------------------------------------

/** The new place (1-based) of position `k` after `from` is taken out and put before or after `target`. Beyond the span it is the identity. */
function reorderedPlace(k: number, from: number, target: number, rel: 'before' | 'after'): number {
  if (from === target) return k;
  const top = Math.max(from, target, k);
  const order: number[] = [];
  for (let i = 1; i <= top; i += 1) if (i !== from) order.push(i);
  const at = order.indexOf(target);
  order.splice(rel === 'before' ? at : at + 1, 0, from);
  return order.indexOf(k) + 1;
}

const inRange = (n: number, lo: number, hi: number): boolean => n >= lo && n <= hi;

/**
 * An anchor carried through one op of the log. Only `move` and `fill` can displace a piece. `at` names the anchors the op speaks of (the fold's
 * table of them); without it nothing is known to have touched this anchor and it comes back as it was. `null`: the op removed its piece, or
 * split it so that it can no longer be one piece (words overwritten by a `fill`; a row range cut by a row move).
 */
export function rebase(anchor: DocAnchor, op: Op, at?: (id: string) => DocAnchor | undefined): DocAnchor | null {
  if (at === undefined) return anchor;
  const sel = anchor.sel;
  if (op.kind === 'fill') {
    const filled = at(op.anchor);
    if (filled === undefined || filled.on !== anchor.on || filled.sel.kind !== 'cells' || sel.kind !== 'text') return anchor;
    const where = /^(?:(.+)!)?([A-Z]{1,3}[1-9]\d*)$/.exec(sel.scope);
    const cell = where?.[2] === undefined ? null : parseCellRange(where[2]);
    const range = parseCellRange(filled.sel.range);
    if (cell === null || range === null) return anchor;
    if (where?.[1] !== undefined && where[1] !== filled.sel.sheet) return anchor;
    return inRange(cell.c1, range.c1, range.c2) && inRange(cell.r1, range.r1, range.r2) ? null : anchor;
  }
  if (op.kind !== 'move') return anchor;
  const moved = at(op.anchor);
  const target = at(op.to);
  if (moved === undefined || target === undefined || moved.on !== anchor.on || target.on !== anchor.on) return anchor;
  const ms = moved.sel;
  const ts = target.sel;
  // Pages: the page numbers of everything on those pages follow.
  if (ms.kind === 'page' && ts.kind === 'page' && op.rel !== 'into') {
    const place = (page: number): number => reorderedPlace(page, ms.page, ts.page, op.rel as 'before' | 'after');
    if (sel.kind === 'page') return { on: anchor.on, sel: { kind: 'page', page: place(sel.page) } };
    if (sel.kind === 'region') return { on: anchor.on, sel: { ...sel, page: place(sel.page) } };
    const text = sel.kind === 'text' ? /^p([1-9]\d*)$/.exec(sel.scope) : null;
    if (sel.kind === 'text' && text?.[1] !== undefined) return { on: anchor.on, sel: { ...sel, scope: `p${place(Number(text[1]))}` } };
    return anchor;
  }
  // Nodes: only moving one `into` another changes a path (siblings are named, not numbered).
  if (ms.kind === 'node' && ts.kind === 'node' && op.rel === 'into' && sel.kind === 'node' && ms.path !== '') {
    if (sel.path !== ms.path && !sel.path.startsWith(`${ms.path}/`)) return anchor;
    const name = ms.path.slice(ms.path.lastIndexOf('/') + 1);
    const home = ts.path === '' ? name : `${ts.path}/${name}`;
    return { on: anchor.on, sel: { kind: 'node', path: `${home}${sel.path.slice(ms.path.length)}` } };
  }
  // Rows: a block of whole rows moved before or after another row.
  if (ms.kind === 'cells' && ts.kind === 'cells' && ms.sheet === ts.sheet && sel.kind === 'cells' && sel.sheet === ms.sheet && op.rel !== 'into') {
    const block = parseCellRange(ms.range);
    const row = parseCellRange(ts.range);
    const mine = parseCellRange(sel.range);
    if (block === null || row === null || mine === null || mine.r2 - mine.r1 > 10_000) return anchor;
    const place = rowPlace(block, op.rel === 'before' ? row.r1 : row.r2 + 1);
    if (place === null) return anchor;
    const first = place(mine.r1);
    for (let r = mine.r1; r <= mine.r2; r += 1) if (place(r) !== first + (r - mine.r1)) return null;
    return { on: anchor.on, sel: { kind: 'cells', sheet: sel.sheet, range: formatCellRange({ ...mine, r1: first, r2: first + (mine.r2 - mine.r1) }) } };
  }
  return anchor;
}

/** Where each row goes when `block` is taken out and put in front of row `edge` (null: it is already there). */
function rowPlace(block: CellBox, edge: number): ((r: number) => number) | null {
  if (edge >= block.r1 && edge <= block.r2 + 1) return null;
  const size = block.r2 - block.r1 + 1;
  const start = edge > block.r2 ? edge - size : edge;
  return (r) => {
    if (r >= block.r1 && r <= block.r2) return start + (r - block.r1);
    if (edge > block.r2) return r > block.r2 && r < edge ? r - size : r;
    return r >= edge && r < block.r1 ? r + size : r;
  };
}
