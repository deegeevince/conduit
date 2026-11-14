// Data a chart draws by reference. STUB: the port and the pure parts are
// here; nothing is read yet (PLAN-v2.md, packages S1 and S2).
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

/** A dataset the owner keeps, as the index knows it: enough to tell that a prompt is asking about it. */
export interface DatasetEntry {
  /** the dataset's name in Remote */
  readonly dataset: string;
  /** what one series in it is called and known by: a symbol and a name (`ACME`, `Acme Corporation`) */
  readonly key: string;
  readonly names: readonly string[];
  /** its fields, the first being what runs along the bottom of a chart */
  readonly fields: readonly string[];
}

export interface DatasetLibrary {
  /** The datasets a prompt is asking about, from the index held in memory. Never waits: no network on this call. */
  find(prompt: string): readonly DatasetEntry[];
  /** Reads the rows. A network call with a deadline: rejects when it cannot be done in time. */
  rows(entry: DatasetEntry, signal: AbortSignal): Promise<DataTable>;
  /** Reads the index again, in the background. */
  refresh(signal: AbortSignal): Promise<void>;
}

export const NO_DATASETS: DatasetLibrary = { find: () => [], rows: () => Promise.reject(new Error('no datasets are configured')), refresh: () => Promise.resolve() };

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
