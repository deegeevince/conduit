// Data a chart draws by reference. The port and the pure parts are here;
// the adapter that reads Remote is `library/remote/datasets-cli.ts`.
//
// A chart of a few dozen points is written by the brain as rows. Anything
// larger, or anything that must be true to the last digit, is not retyped by
// a model: the server holds the rows, tells the brain what is in them
// (`DataFacts` in the brief), and sends them to the painter itself when the
// brain writes `chart … data=d1`. There are two sources, and no third:
//
//   1. What the user gave: a table pasted into the prompt, or a CSV behind a
//      link. `tableFromText` reads it. No network beyond the link the user gave.
//   2. The owner's own datasets in Remote (`remote get datasets`, `get rows`),
//      when `DATASETS=remote` and the prompt names something stored there.
//      Read through the same module that reads techniques, so the `remote`
//      command is still known in exactly one place.
//
// There is no market data service, no price feed and nothing paid. When a
// user asks for a stock's year and neither source has it, the brain draws
// what it recalls, marks the chart `approx`, and says so.
//
// Unlike choosing techniques, reading rows from Remote IS a network call on
// a turn's path, so it is treated exactly like reading a link: a `reading`
// event tells the viewer, it has one short deadline, and when it fails the
// brain is told it could not be read and answers without it.

import { DATA_LIMITS, readNumber, splitCells } from '@conduit/language';
import type { DataFacts, DataTable } from '@conduit/language';

/** A dataset the owner keeps, as the index knows it: enough to tell that a prompt is asking about it, and what to ask Remote for. */
export interface DatasetEntry {
  /** the dataset's name in Remote */
  readonly dataset: string;
  /** what one series in it is called and known by: the field that tells the instruments apart, as the adapter found it (`instrument`, `symbol`); `dataset` when it has none */
  readonly key: string;
  /** what a prompt may say to mean the dataset itself */
  readonly names: readonly string[];
  /** its fields, the first being what runs along the bottom of a chart */
  readonly fields: readonly string[];
  /** the field that runs along the bottom: a date or a time; null when none could be told */
  readonly dateField: string | null;
  /** the field that tells one series from another; null when the dataset is one series */
  readonly instrumentField: string | null;
  /** the series in it, as far as the index has read: `key` is what a filter takes, `names` what a person calls it */
  readonly instruments: readonly DatasetInstrument[];
  /** the dates of its first and last row, as the index read them (`2026-11-13`); null when not known */
  readonly first: string | null;
  readonly last: string | null;
  /** the rows it holds, when the index says; null when it does not */
  readonly count: number | null;
  /** the series this prompt named: what `rows` reads. Null: the dataset as a whole. Set only by `find`. */
  readonly instrument: string | null;
}

export interface DatasetInstrument {
  readonly key: string;
  readonly names: readonly string[];
  /** the dates of its first and last row in what was read; null when not known */
  readonly first: string | null;
  readonly last: string | null;
}

/** What a chart says to draw from a dataset: `data=dataset:<dataset> instrument=<key> field=<field>`. */
export interface DatasetRef {
  readonly dataset: string;
  readonly instrument: string | null;
  readonly field: string | null;
}

export type Freshness = 'today' | 'recent' | 'stale' | 'unknown';

/** What the brief says of one dataset: which exist, what is in them, how fresh. Never a row. */
export interface DatasetFacts {
  readonly dataset: string;
  readonly instruments: readonly { readonly key: string; readonly names: readonly string[]; readonly first: string | null; readonly last: string | null }[];
  readonly instrumentsMore: number;
  readonly fields: readonly string[];
  readonly dateField: string | null;
  readonly first: string | null;
  readonly last: string | null;
  readonly freshness: Freshness;
}

export interface DatasetLibrary {
  /** The datasets a prompt is asking about, from the index held in memory, each narrowed to the series the prompt named. Never waits: no network on this call. */
  find(prompt: string): readonly DatasetEntry[];
  /** What the brief says of every dataset the index holds, from memory. Empty when there are none or none could be read. */
  facts(now: number): readonly DatasetFacts[];
  /** Reads the rows of what `find` returned. A network call with a deadline: rejects when it cannot be done in time. */
  rows(entry: DatasetEntry, signal: AbortSignal): Promise<DataTable>;
  /** Reads the rows a chart named by reference (`data=dataset:…`). Rejects, in a sentence, when the dataset, the series or the field is not in the index. */
  table(ref: DatasetRef, signal: AbortSignal): Promise<DataTable>;
  /** Reads the index again, in the background. */
  refresh(signal: AbortSignal): Promise<void>;
}

export const NO_DATASETS: DatasetLibrary = {
  find: () => [],
  facts: () => [],
  rows: () => Promise.reject(new Error('no datasets are configured')),
  table: () => Promise.reject(new Error('no datasets are configured')),
  refresh: () => Promise.resolve(),
};

const DAY = 86_400_000;
const FACT_INSTRUMENTS = 12;

/** Text that came from Remote and is about to be put in a brief: one short plain line, no markup, no control characters. */
export function plainText(text: string, max = 60): string {
  return text.replace(/[\u0000-\u001f\u007f`<>{}|\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** How old a last date is. Dates are read as UTC days. */
export function freshnessOf(last: string | null, now: number): Freshness {
  if (last === null) return 'unknown';
  const at = Date.parse(last);
  if (Number.isNaN(at)) return 'unknown';
  const age = (now - at) / DAY;
  return age <= 3 ? 'today' : age <= 30 ? 'recent' : 'stale';
}

/** The facts of every dataset in the index, for the brief. Instruments with the freshest last date first. */
export function factsOfDatasets(entries: readonly DatasetEntry[], now: number): DatasetFacts[] {
  return entries.map((entry) => {
    const sorted = [...entry.instruments].sort((a, b) => (b.last ?? '').localeCompare(a.last ?? '') || a.key.localeCompare(b.key));
    return {
      dataset: entry.dataset,
      instruments: sorted.slice(0, FACT_INSTRUMENTS).map((one) => ({ key: one.key, names: one.names.slice(0, 2), first: one.first, last: one.last })),
      instrumentsMore: Math.max(0, sorted.length - FACT_INSTRUMENTS),
      fields: entry.fields,
      dateField: entry.dateField,
      first: entry.first,
      last: entry.last,
      freshness: freshnessOf(entry.last, now),
    };
  });
}

/** The brief's paragraph about the owner's datasets; null when there are none. The words come from Remote, so each is cleaned. */
export function datasetsText(facts: readonly DatasetFacts[]): string | null {
  if (facts.length === 0) return null;
  const lines = ["THE USER'S OWN DATA (stored; read-only; draw it by reference, never retype it: `chart | … data=dataset:<name> instrument=<series> field=<field>`):"];
  for (const one of facts) {
    const span = one.first !== null && one.last !== null ? `${one.first} to ${one.last}` : 'dates unknown';
    const age = one.freshness === 'today' ? 'up to date' : one.freshness === 'recent' ? 'a few days to weeks old' : one.freshness === 'stale' ? 'out of date' : 'age unknown';
    const series = one.instruments.map((item) => `${item.key}${item.last === null ? '' : ` (to ${item.last})`}`).join(', ');
    lines.push(`- ${plainText(one.dataset)}: ${span}, ${age}; fields ${one.fields.map((field) => plainText(field, 30)).join(', ')}${series === '' ? '' : `; series ${series}${one.instrumentsMore > 0 ? ` and ${one.instrumentsMore} more` : ''}`}`);
  }
  lines.push('If a question is about something not here, say plainly that the app holds no such data; do not invent a live figure.');
  return lines.join('\n');
}

const SKIP = new Set('the and for you your how what who why with this that are was does doing did has have about from into over under today now price prices stock stocks share shares chart show tell give year month week day long run any all its not but can will just like more most than then them they their some'.split(' '));
const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);

/**
 * The datasets (each narrowed to a series when the prompt names one) that a
 * prompt is asking about, best first. A series is named by its key, in any
 * case when the key is three letters or more and in capitals (or after a `$`)
 * when it is shorter, or by a name it is known by. A dataset is named by its
 * own name, and then only when it has no series the prompt could have meant
 * instead. A prompt that names neither gets none: a dataset is never
 * offered because it exists.
 */
export function matchDatasets(index: readonly DatasetEntry[], prompt: string): DatasetEntry[] {
  const lower = new Set(tokens(prompt));
  const capitals = new Set((prompt.match(/\$?[A-Z][A-Z0-9.]{0,9}\b/g) ?? []).map((word) => word.replace('$', '').toLowerCase()));
  const dollar = new Set((prompt.match(/\$[A-Za-z][A-Za-z0-9.]{0,9}\b/g) ?? []).map((word) => word.slice(1).toLowerCase()));
  const hits: { entry: DatasetEntry; score: number }[] = [];
  for (const entry of index) {
    const named = entry.instruments.filter((one) => {
      const key = one.key.toLowerCase();
      if (key.length >= 3 ? lower.has(key) && !SKIP.has(key) : capitals.has(key) || dollar.has(key)) return true;
      return one.names.some((name) => {
        const parts = tokens(name).filter((part) => part.length > 2 && !SKIP.has(part));
        return parts.length > 0 && parts.every((part) => lower.has(part));
      });
    });
    if (named.length > 0) {
      for (const one of named.slice(0, 1)) hits.push({ entry: { ...entry, instrument: one.key }, score: 3 });
      continue;
    }
    const byName = entry.names.some((name) => {
      const parts = tokens(name).filter((part) => !SKIP.has(part));
      return parts.length > 0 && parts.every((part) => lower.has(part));
    });
    if (byName) hits.push({ entry: { ...entry, instrument: null }, score: 1 });
  }
  return hits.sort((a, b) => b.score - a.score).map((hit) => hit.entry);
}

export type DatasetSettings =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'remote';
      readonly bin: string;
      /** whose datasets: the owner's own account. Null: whatever the directory's `.remote` binding says. Never the Series account. */
      readonly actor: string | null;
      readonly env: 'prod' | 'local';
      /** one read may take this long before the turn goes on without it */
      readonly timeoutMs: number;
      readonly refreshMs: number;
    };

/**
 * Reads a table out of text the user pasted: comma-, tab- or bar-separated
 * lines with the same number of cells and numbers in most of them. Null when
 * the text is not a table, which is the usual case and not an error.
 */
export function tableFromText(text: string, id: string, source: string): DataTable | null {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length < 4) return null;
  const split = (line: string): string[] => (line.includes('\t') ? line.split('\t') : line.includes('|') ? splitCells(line.replace(/^\|/, '')) : line.split(',')).map((cell) => cell.trim());
  const cells = lines.map(split);
  const width = cells[0]?.length ?? 0;
  if (width < 2 || cells.filter((row) => row.length === width).length < lines.length * 0.9) return null;
  const body = cells.filter((row) => row.length === width);
  const numeric = body.slice(1).filter((row) => row.slice(1).some((cell) => readNumber(cell) !== null)).length;
  if (numeric < (body.length - 1) * 0.8) return null;
  const header = (body[0] ?? []).slice(1).every((cell) => readNumber(cell) === null);
  const columns = header ? (body[0] ?? []) : (body[0] ?? []).map((_, index) => (index === 0 ? 'x' : `series ${index}`));
  return { id, source, columns, rows: (header ? body.slice(1) : body).slice(0, DATA_LIMITS.rows) };
}

/** What the brain is told about a table: its size, its columns, a few rows, and the range of every numeric column. */
export function factsOf(table: DataTable, fresh: boolean): DataFacts {
  const range: Record<string, { min: string; max: string; first: string; last: string }> = {};
  table.columns.forEach((column, index) => {
    if (index === 0) return;
    const cells = table.rows.map((row) => row[index] ?? '').filter((cell) => readNumber(cell) !== null);
    if (cells.length === 0) return;
    let min = cells[0] ?? '';
    let max = cells[0] ?? '';
    for (const cell of cells) {
      const value = readNumber(cell)?.value ?? 0;
      if (value < (readNumber(min)?.value ?? 0)) min = cell;
      if (value > (readNumber(max)?.value ?? 0)) max = cell;
    }
    range[column] = { min, max, first: cells[0] ?? '', last: cells[cells.length - 1] ?? '' };
  });
  const sample = table.rows.length <= 4 ? table.rows : [...table.rows.slice(0, 2), ...table.rows.slice(-2)];
  return { id: table.id, source: table.source, columns: table.columns, count: table.rows.length, sample, range, fresh };
}
