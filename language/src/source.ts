// A real document is a source with its structure beside it (PLAN-anchors section 2): the file as given, plus one sidecar in one shape for every
// format. `resolve` (anchor.ts), search and the brief read the sidecar and never learn a format.
import { guards } from './anchor';
import type { Frac } from './anchor';

export const FORMATS = ['pdf', 'image', 'sheet', 'docx', 'slides', 'media', 'page'] as const;
export type Format = (typeof FORMATS)[number];

export interface Source {
  readonly id: string;
  readonly format: Format;
  readonly mime: string;
  readonly title: string;
  readonly bytes: number;
  readonly sha: string;
  readonly pages: number;
  readonly from: 'given' | 'fetched' | 'recorded' | 'made';
  /** `never` for a conversation for a learner and for a private service; `ask` for what the owner gave or fetched */
  readonly keep: 'never' | 'ask';
}

/** A run of a page's text, and where it is */
export interface Run {
  readonly start: number;
  readonly end: number;
  readonly box: readonly [x: Frac, y: Frac, w: Frac, h: Frac];
}

export interface StructurePage {
  readonly n: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
  readonly runs: readonly Run[];
}

export interface StructureCell {
  readonly v: string;
  readonly f?: string;
  readonly fmt?: string;
}

/** `<id>.structure.json` */
export interface Structure {
  readonly v: 1;
  readonly source: string;
  readonly sha: string;
  /** a PDF, a photo (no runs), slides, a reader view */
  readonly pages: readonly StructurePage[];
  readonly sheets?: readonly { readonly name: string; readonly rows: number; readonly cols: number; readonly cells: Readonly<Record<string, StructureCell>> }[];
  /** a transcript: offsets into pages[0].text, seconds */
  readonly words?: readonly { readonly start: number; readonly end: number; readonly t: number; readonly d: number }[];
  readonly blocks?: readonly { readonly path: string; readonly role: 'heading' | 'para' | 'list' | 'table' | 'figure'; readonly level: number; readonly page: number; readonly start: number; readonly end: number }[];
}

export const STRUCTURE_LIMITS = { pages: 300, text: 400_000, runs: 20_000, sheets: 32, cells: 200_000, words: 100_000, blocks: 50_000 } as const;

/** The cell a scope names ('B4', or 'Costs!B4'; the first sheet when no sheet is named). */
export function cellOf(structure: Structure, scope: string): StructureCell | null {
  const m = /^(?:(.+)!)?([A-Z]{1,3}[1-9]\d*)$/.exec(scope);
  if (m?.[2] === undefined) return null;
  const sheet = m[1] === undefined ? structure.sheets?.[0] : structure.sheets?.find((s) => s.name === m[1]);
  return sheet?.cells[m[2]] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// pageText: the ONE join of PDF.js's text items, used at ingest and by the reader
// ---------------------------------------------------------------------------------------------------------------------------------

/** The part of a PDF.js `TextItem` this reads. `transform` is [a, b, c, d, e, f] in the page's own units, origin bottom left, y up. */
export interface TextItem {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL?: boolean;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const four = (n: number): number => Number(n.toFixed(4));

/**
 * One page's text and the runs in it. A word break is a space when an item or its neighbour carries one (or a line ended); items that touch are
 * not split. Every white-space run is one space, so a quote never holds a line break and fits on a line of the language. `page` is the
 * upright page's size in the same units as the items (rotation 0); the boxes are fractions of it, from the top left.
 */
export function pageText(items: readonly TextItem[], page: { readonly w: number; readonly h: number }): { text: string; runs: readonly Run[] } {
  let text = '';
  const runs: Run[] = [];
  let gap = false;
  for (const item of items) {
    const flat = item.str.replace(/\s+/g, ' ');
    const core = flat.trim();
    if (core === '') {
      gap = gap || flat !== '' || item.hasEOL === true;
      continue;
    }
    if (text !== '' && (gap || flat.startsWith(' '))) text += ' ';
    const start = text.length;
    text += core;
    const [, , , , e = 0, f = 0] = item.transform;
    const height = item.height > 0 ? item.height : Math.abs(item.transform[3] ?? 0);
    const x = clamp01(e / page.w);
    const y = clamp01((page.h - (f + height)) / page.h);
    runs.push({ start, end: text.length, box: [four(x), four(y), four(Math.min(1 - x, item.width / page.w)), four(Math.min(1 - y, height / page.h))] });
    gap = flat.endsWith(' ') || item.hasEOL === true;
  }
  return { text, runs };
}

/** The runs a character range crosses, so a highlight can be drawn from their boxes. */
export function runsCovering(runs: readonly Run[], start: number, end: number): readonly Run[] {
  return runs.filter((run) => run.end > start && run.start < end);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decoders (the sidecar is served over HTTP and read from disk)
// ---------------------------------------------------------------------------------------------------------------------------------

export function readSource(raw: unknown): Source | null {
  if (!guards.rec(raw)) return null;
  const id = guards.str(raw.id, 120, 1);
  const mime = guards.str(raw.mime, 120);
  const title = guards.str(raw.title, 300);
  const sha = guards.str(raw.sha, 128);
  const bytes = guards.int(raw.bytes, 0, 2 ** 40);
  const pages = guards.int(raw.pages, 0, STRUCTURE_LIMITS.pages);
  const format = FORMATS.find((f) => f === raw.format);
  const from = (['given', 'fetched', 'recorded', 'made'] as const).find((f) => f === raw.from);
  const keep = (['never', 'ask'] as const).find((k) => k === raw.keep);
  if (id === null || mime === null || title === null || sha === null || bytes === null || pages === null) return null;
  if (format === undefined || from === undefined || keep === undefined) return null;
  return { id, format, mime, title, bytes, sha, pages, from, keep };
}

function readRun(raw: unknown, length: number): Run | null {
  if (!guards.rec(raw)) return null;
  const start = guards.int(raw.start, 0, length);
  const end = guards.int(raw.end, 0, length);
  const box = guards.list(raw.box, 4);
  if (start === null || end === null || end < start || box === null || box.length !== 4) return null;
  const [x, y, w, h] = box.map((v) => guards.num(v, 0, 1));
  if (x == null || y == null || w == null || h == null) return null;
  return { start, end, box: [x, y, w, h] };
}

/** The sidecar, read whole or not at all. */
export function readStructure(raw: unknown): Structure | null {
  if (!guards.rec(raw) || raw.v !== 1) return null;
  const source = guards.str(raw.source, 120, 1);
  const sha = guards.str(raw.sha, 128);
  const pageList = guards.list(raw.pages, STRUCTURE_LIMITS.pages);
  if (source === null || sha === null || pageList === null) return null;
  const pages: StructurePage[] = [];
  for (const item of pageList) {
    if (!guards.rec(item)) return null;
    const n = guards.int(item.n, 1, STRUCTURE_LIMITS.pages);
    const w = guards.num(item.w, 0, 1e6);
    const h = guards.num(item.h, 0, 1e6);
    // text carries no line breaks (see `pageText`), and no control characters
    const text = guards.str(item.text, STRUCTURE_LIMITS.text);
    const runList = guards.list(item.runs, STRUCTURE_LIMITS.runs);
    if (n === null || w === null || h === null || text === null || runList === null) return null;
    const runs: Run[] = [];
    for (const r of runList) {
      const run = readRun(r, text.length);
      if (run === null) return null;
      runs.push(run);
    }
    pages.push({ n, w, h, text, runs });
  }
  let sheets: Structure['sheets'];
  if (raw.sheets !== undefined) {
    const list = guards.list(raw.sheets, STRUCTURE_LIMITS.sheets);
    if (list === null) return null;
    const out: NonNullable<Structure['sheets']>[number][] = [];
    let total = 0;
    for (const s of list) {
      if (!guards.rec(s) || !guards.rec(s.cells)) return null;
      const name = guards.str(s.name, 64);
      const rows = guards.int(s.rows, 0, 1_048_576);
      const cols = guards.int(s.cols, 0, 16_384);
      if (name === null || rows === null || cols === null) return null;
      const cells: Record<string, StructureCell> = {};
      for (const [key, value] of Object.entries(s.cells)) {
        total += 1;
        if (total > STRUCTURE_LIMITS.cells || !/^[A-Z]{1,3}[1-9]\d*$/.test(key) || !guards.rec(value)) return null;
        const v = guards.str(value.v, 32_000);
        const f = value.f === undefined ? undefined : guards.str(value.f, 8_000);
        const fmt = value.fmt === undefined ? undefined : guards.str(value.fmt, 64);
        if (v === null || f === null || fmt === null) return null;
        cells[key] = { v, ...(f !== undefined && { f }), ...(fmt !== undefined && { fmt }) };
      }
      out.push({ name, rows, cols, cells });
    }
    sheets = out;
  }
  let words: Structure['words'];
  if (raw.words !== undefined) {
    const list = guards.list(raw.words, STRUCTURE_LIMITS.words);
    if (list === null) return null;
    const out: { start: number; end: number; t: number; d: number }[] = [];
    for (const w of list) {
      if (!guards.rec(w)) return null;
      const start = guards.int(w.start, 0, STRUCTURE_LIMITS.text);
      const end = guards.int(w.end, 0, STRUCTURE_LIMITS.text);
      const t = guards.num(w.t, 0, 86_400 * 7);
      const d = guards.num(w.d, 0, 86_400);
      if (start === null || end === null || t === null || d === null || end < start) return null;
      out.push({ start, end, t, d });
    }
    words = out;
  }
  let blocks: Structure['blocks'];
  if (raw.blocks !== undefined) {
    const list = guards.list(raw.blocks, STRUCTURE_LIMITS.blocks);
    if (list === null) return null;
    const out: NonNullable<Structure['blocks']>[number][] = [];
    for (const b of list) {
      if (!guards.rec(b)) return null;
      const path = guards.str(b.path, 200);
      const role = (['heading', 'para', 'list', 'table', 'figure'] as const).find((r) => r === b.role);
      const level = guards.int(b.level, 0, 12);
      const page = guards.int(b.page, 1, STRUCTURE_LIMITS.pages);
      const start = guards.int(b.start, 0, STRUCTURE_LIMITS.text);
      const end = guards.int(b.end, 0, STRUCTURE_LIMITS.text);
      if (path === null || role === undefined || level === null || page === null || start === null || end === null) return null;
      out.push({ path, role, level, page, start, end });
    }
    blocks = out;
  }
  return { v: 1, source, sha, pages, ...(sheets !== undefined && { sheets }), ...(words !== undefined && { words }), ...(blocks !== undefined && { blocks }) };
}
