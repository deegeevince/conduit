// Data a chart draws by reference. A chart of a few dozen points is written by
// the brain as rows. Anything larger, or anything that must be true to the last
// digit, is not retyped by a model: the server holds the rows, tells the brain
// what is in them (`DataFacts` in the brief), and sends them to the painter
// itself when the brain writes `chart … data=d1`. A table comes from what the
// user gave: a table pasted into the prompt, or a CSV behind a link.
// `tableFromText` reads the first.
//
// There is no market data service, no price feed and nothing paid. When a
// user asks for a stock's year and the user gave no table, the brain draws
// what it recalls, marks the chart `approx`, and says so.

import { DATA_LIMITS, readNumber, splitCells } from '@conduit/language';
import type { DataFacts, DataTable } from '@conduit/language';

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
