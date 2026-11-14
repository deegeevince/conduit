// The owner's datasets, read through the `remote` command: `get datasets`
// (the index), `get dataset <name>` (fields) and `get rows <name>` (a page).
// Off unless `DATASETS=remote`, never the Series account, and read only: no
// command here writes.
//
// THE SHAPE IS ASSUMED. The Remote side has not yet supplied one example of
// each command's output (PLAN-v2.md section 6), and reading the owner's
// account to find out was not done in development. The parsing below accepts
// the shapes such an API most plausibly prints (an array, or an object that
// holds one under `datasets`, `items`, `rows` or `data`; fields as names or as
// objects with a `name`; a row as an object or an array) and says plainly when
// it finds none. Before switching `DATASETS` on, run `pnpm library datasets`
// and read what it prints.

import { DATA_LIMITS } from '@conduit/language';
import type { DataTable } from '@conduit/language';
import type { Logger } from '../../log';
import type { DatasetEntry, DatasetLibrary, DatasetSettings } from '../../domain/datasets';
import { parseJson, runRemote } from './run';

type Settings = Extract<DatasetSettings, { kind: 'remote' }>;
const IDENTITY = { session: `conduit-datasets-${process.pid}`, agent: 'conduit-library' };

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    for (const key of ['datasets', 'items', 'rows', 'data', 'results']) {
      const inner = (value as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

function fieldNames(value: unknown): string[] {
  const fields = typeof value === 'object' && value !== null && !Array.isArray(value) ? ((value as Record<string, unknown>)['fields'] ?? null) : null;
  if (Array.isArray(fields)) return fields.map((field) => (typeof field === 'string' ? field : typeof field === 'object' && field !== null ? String((field as Record<string, unknown>)['name'] ?? '') : '')).filter((name) => name !== '');
  if (typeof fields === 'object' && fields !== null) return Object.keys(fields);
  return [];
}

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);

function args(settings: Settings, rest: readonly string[]): string[] {
  return [...rest, ...(settings.actor === null ? [] : ['--as', settings.actor]), '--env', settings.env];
}

export function createRemoteDatasets(settings: Settings, log: Logger): DatasetLibrary {
  let index: readonly DatasetEntry[] = [];
  const call = (rest: readonly string[], signal: AbortSignal): Promise<string> => runRemote({ bin: settings.bin, args: args(settings, rest), identity: IDENTITY, timeoutMs: settings.timeoutMs, signal });

  return {
    find(prompt) {
      const said = new Set(words(prompt));
      return index.filter((entry) => entry.names.some((name) => words(name).some((word) => said.has(word))));
    },
    async rows(entry, signal) {
      const text = await call(['get', 'rows', entry.dataset, '--limit', String(DATA_LIMITS.rows)], signal);
      const rows = listOf(parseJson(text, `rows of ${entry.dataset}`));
      if (rows.length === 0) throw new Error(`dataset ${entry.dataset} returned no rows this adapter can read`);
      const columns = entry.fields.length > 0 ? [...entry.fields] : Object.keys((rows[0] ?? {}) as Record<string, unknown>);
      const cell = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
      const table: DataTable = {
        id: entry.dataset,
        source: `your dataset ${entry.dataset}`,
        columns,
        rows: rows.slice(0, DATA_LIMITS.rows).map((row) => (Array.isArray(row) ? row.map(cell) : columns.map((column) => cell((row as Record<string, unknown>)[column])))),
      };
      return table;
    },
    async refresh(signal) {
      try {
        const listed = listOf(parseJson(await call(['get', 'datasets'], signal), 'the dataset list'));
        const next: DatasetEntry[] = [];
        for (const item of listed) {
          const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? String((item as Record<string, unknown>)['name'] ?? '') : '';
          if (name === '') continue;
          let fields = fieldNames(item);
          if (fields.length === 0) fields = fieldNames(parseJson(await call(['get', 'dataset', name], signal), `dataset ${name}`));
          next.push({ dataset: name, key: name, names: [name.replace(/[-_]+/g, ' ')], fields });
        }
        index = next;
      } catch (error) {
        // The index stays as it was; a turn that names a dataset is told it could not be read.
        log.warn('datasets.unreadable', { error });
        throw error;
      }
    },
  };
}
