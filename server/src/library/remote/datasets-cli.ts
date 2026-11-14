// The owner's datasets, read through the `remote` command: `get datasets`
// (the index), `get dataset <name>` (identity, filters, fields, an example
// line) and `get rows <name>` (a page, filtered by `field=value`, `--from`,
// `--to`, `--limit`). Off unless `DATASETS=remote`, never the Series account,
// and read only: no command here writes, and every call carries
// `REMOTE_SESSION_ID` and `REMOTE_AGENT` (in `run.ts`).
//
// THE SHAPE. This adapter was written without the three commands' real output:
// the owner's account could not be read from the session that built it (see
// the hand-back of package S2). So nothing here assumes one shape; each reader
// takes the forms such an API prints (an array, or an object holding one under
// `datasets`, `items`, `rows`, `data`, `results`; a field as a name or as an
// object with a `name`; a row as an object, as an object with its values under
// `data` or `fields`, or as an array) and the facts it needs (which field is
// the date, which tells one series from another) are found by name first and
// by looking at the values second. What it cannot find it leaves null and the
// dataset is offered for the whole of itself. `pnpm library datasets` prints
// what it made of the account, so a wrong guess shows at once, and
// `pnpm library datasets raw` prints the command output's keys and types
// (never a value) for fixing it.
//
// The index lives in memory, is refreshed in the background and is kept on
// disk, outside the repository, so that a restart with Remote unreachable
// still knows what the owner holds. What the index holds is names, field names
// and dates: no row, no figure.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_LIMITS, readNumber } from '@conduit/language';
import type { DataTable } from '@conduit/language';
import type { Logger } from '../../log';
import { factsOfDatasets, matchDatasets, plainText } from '../../domain/datasets';
import type { DatasetEntry, DatasetFacts, DatasetInstrument, DatasetLibrary, DatasetRef, DatasetSettings } from '../../domain/datasets';
import { parseJson, runRemote } from './run';

type Settings = Extract<DatasetSettings, { kind: 'remote' }>;
const IDENTITY = { session: `conduit-datasets-${process.pid}`, agent: 'conduit-s2' };
/** how many rows are read to learn a dataset's series and dates; the index never holds them */
const SAMPLE_ROWS = 400;
const MAX_DATASETS = 40;
const MAX_INSTRUMENTS = 200;
const DATE_NAMES = ['date', 'day', 'time', 'timestamp', 'ts', 'datetime', 'at', 'period', 't', 'when', 'month', 'year'];
const INSTRUMENT_NAMES = ['instrument', 'symbol', 'ticker', 'series', 'asset', 'code', 'id', 'name', 'key', 'pair', 'market'];
const LABEL_NAMES = ['name', 'title', 'description', 'label', 'long_name', 'fullname'];
const WRAPPERS = ['data', 'fields', 'values', 'row', 'payload', 'attributes'];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    for (const key of ['datasets', 'items', 'rows', 'data', 'results', 'entries']) {
      const inner = value[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

/** A row as one flat object, whichever way it was wrapped. */
function flat(row: unknown): Json | null {
  if (!isObject(row)) return null;
  for (const key of WRAPPERS) {
    const inner = row[key];
    if (isObject(inner)) return { ...row, ...inner };
  }
  return row;
}

function nameOf(item: unknown): string {
  if (typeof item === 'string') return item;
  return isObject(item) ? String(item['name'] ?? item['dataset'] ?? item['slug'] ?? item['id'] ?? '') : '';
}

function fieldNames(value: unknown): string[] {
  const fields = isObject(value) ? (value['fields'] ?? value['columns'] ?? value['schema'] ?? null) : null;
  if (Array.isArray(fields)) return fields.map(nameOf).filter((name) => name !== '');
  if (isObject(fields)) return Object.keys(isObject(fields['properties']) ? fields['properties'] : fields);
  return [];
}

function filterNames(value: unknown): string[] {
  const filters = isObject(value) ? (value['filters'] ?? null) : null;
  if (Array.isArray(filters)) return filters.map(nameOf).filter((name) => name !== '');
  if (isObject(filters)) return Object.keys(filters);
  return [];
}

/** The first of `wanted` (in its order of preference) that is among `have`, whatever its case. */
function pick(have: readonly string[], wanted: readonly string[]): string | null {
  for (const name of wanted) {
    const found = have.find((candidate) => candidate.toLowerCase() === name);
    if (found !== undefined) return found;
  }
  return null;
}

/** A value as the day it is: `2026-11-13` from an ISO time, a date, or an epoch in seconds or milliseconds; null otherwise. */
export function dayOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    return value > 1e8 ? new Date(ms).toISOString().slice(0, 10) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{9,13}$/.test(text)) return dayOf(Number(text));
  if (!/^\d{4}-\d{2}(-\d{2})?([T ]|$)/.test(text)) return null;
  const at = Date.parse(text.length === 7 ? `${text}-01` : text);
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10);
}

/** The range of days a dataset's listing says it covers, under whatever names it uses. */
function rangeOf(item: unknown): { first: string | null; last: string | null } {
  if (!isObject(item)) return { first: null, last: null };
  const nested = isObject(item['range']) ? item['range'] : isObject(item['timeRange']) ? item['timeRange'] : isObject(item['time_range']) ? item['time_range'] : {};
  const read = (...names: string[]): string | null => {
    for (const source of [item, nested]) for (const name of names) if (name in source) return dayOf(source[name]);
    return null;
  };
  return { first: read('first', 'from', 'start', 'min', 'earliest', 'since'), last: read('last', 'to', 'end', 'max', 'latest', 'until') };
}

interface Sample {
  readonly dateField: string | null;
  readonly instrumentField: string | null;
  readonly instruments: DatasetInstrument[];
  readonly first: string | null;
  readonly last: string | null;
}

/** What a page of rows says about the dataset: which field is the date, which tells series apart, and each series' first and last day. */
function sampleOf(rows: readonly Json[], fields: readonly string[], filters: readonly string[], known: { dateField: string | null; instrumentField: string | null }): Sample {
  const seen = fields.length > 0 ? fields : rows[0] === undefined ? [] : Object.keys(rows[0]);
  let dateField = known.dateField ?? pick(seen, DATE_NAMES);
  if (dateField === null) dateField = seen.find((name) => rows.slice(0, 5).every((row) => dayOf(row[name]) !== null)) ?? null;
  // The series field: a filter by a name that says so, then any named like one, then a field of text with a few repeating values.
  let instrumentField = known.instrumentField ?? pick(filters, INSTRUMENT_NAMES) ?? pick(seen, INSTRUMENT_NAMES.filter((name) => name !== 'id' && name !== 'name'));
  if (instrumentField === null) {
    instrumentField =
      seen.find((name) => {
        if (name === dateField) return false;
        const values = rows.map((row) => row[name]);
        if (!values.every((value) => typeof value === 'string' && readNumber(value) === null)) return false;
        const distinct = new Set(values).size;
        return distinct > 0 && distinct <= Math.max(2, rows.length / 4);
      }) ?? null;
  }
  const byKey = new Map<string, { names: Set<string>; first: string | null; last: string | null }>();
  let first: string | null = null;
  let last: string | null = null;
  for (const row of rows) {
    const day = dateField === null ? null : dayOf(row[dateField]);
    if (day !== null) {
      if (first === null || day < first) first = day;
      if (last === null || day > last) last = day;
    }
    if (instrumentField === null) continue;
    const raw = row[instrumentField];
    const key = typeof raw === 'string' || typeof raw === 'number' ? plainText(String(raw), 30) : '';
    if (key === '') continue;
    let one = byKey.get(key);
    if (one === undefined) {
      if (byKey.size >= MAX_INSTRUMENTS) continue;
      one = { names: new Set(), first: null, last: null };
      byKey.set(key, one);
    }
    for (const labelField of LABEL_NAMES) {
      const labelled = pick(Object.keys(row), [labelField]);
      const value = labelled === null || labelled === instrumentField ? null : row[labelled];
      const text = typeof value === 'string' ? plainText(value, 60) : '';
      if (text !== '' && text.toLowerCase() !== key.toLowerCase()) one.names.add(text);
    }
    if (day !== null) {
      if (one.first === null || day < one.first) one.first = day;
      if (one.last === null || day > one.last) one.last = day;
    }
  }
  const instruments = [...byKey].map(([key, one]) => ({ key, names: [...one.names].slice(0, 3), first: one.first, last: one.last }));
  return { dateField, instrumentField, instruments, first, last };
}

const SECRET_LIKE = /(?:sk-[a-z0-9]{8,}|api[_ -]?key|password|secret|bearer\s+[a-z0-9._-]{12,})/i;

function cachePath(dir: string): string {
  return join(dir, 'datasets-index.json');
}

function isEntry(value: unknown): value is DatasetEntry {
  return isObject(value) && typeof value['dataset'] === 'string' && Array.isArray(value['fields']) && Array.isArray(value['instruments']) && Array.isArray(value['names']);
}

function readCached(dir: string): DatasetEntry[] {
  try {
    if (!existsSync(cachePath(dir))) return [];
    const parsed: unknown = JSON.parse(readFileSync(cachePath(dir), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isEntry).map((entry) => ({ ...entry, instrument: null })) : [];
  } catch {
    return [];
  }
}

function writeCached(dir: string, entries: readonly DatasetEntry[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = cachePath(dir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 });
  renameSync(temp, file);
}

/** Where the index is kept on disk: outside the repository, owner-only. */
export function defaultCacheDir(): string {
  return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'conduit', 'datasets');
}

export function createRemoteDatasets(settings: Settings, log: Logger, cacheDir: string = defaultCacheDir()): DatasetLibrary {
  let index: readonly DatasetEntry[] = readCached(cacheDir);
  let said: string | null = null;
  const call = (rest: readonly string[], signal: AbortSignal): Promise<string> => runRemote({ bin: settings.bin, args: [...rest, ...(settings.actor === null ? [] : ['--as', settings.actor]), '--env', settings.env], identity: IDENTITY, timeoutMs: settings.timeoutMs, signal });

  const entryOf = (name: string): DatasetEntry | undefined => index.find((entry) => entry.dataset === name);

  /** One dataset, read into the index: its listing line, its description, and a page of its rows. */
  async function readEntry(item: unknown, signal: AbortSignal): Promise<DatasetEntry | null> {
    const name = plainText(nameOf(item), 80);
    if (name === '' || SECRET_LIKE.test(name)) return null;
    if (isObject(item) && (item['hasRows'] === false || item['has_rows'] === false || item['rows'] === 0 || item['count'] === 0)) return null;
    const described: unknown = parseJson(await call(['get', 'dataset', name], signal), `dataset ${name}`);
    let fields = [...fieldNames(item), ...fieldNames(described)].filter((field, at, all) => all.indexOf(field) === at).map((field) => plainText(field, 40)).filter((field) => field !== '');
    const filters = [...filterNames(item), ...filterNames(described)];
    const page = listOf(parseJson(await call(['get', 'rows', name, '--limit', String(SAMPLE_ROWS)], signal), `rows of ${name}`)).map(flat).filter((row): row is Json => row !== null);
    if (fields.length === 0 && page[0] !== undefined) fields = Object.keys(page[0]).map((field) => plainText(field, 40));
    const listed = rangeOf(item);
    const seen = sampleOf(page, fields, filters, { dateField: null, instrumentField: null });
    const first = listed.first ?? seen.first;
    const last = listed.last ?? seen.last;
    const ordered = seen.dateField === null ? fields : [seen.dateField, ...fields.filter((field) => field !== seen.dateField)];
    const count = isObject(item) ? [item['count'], item['rows'], item['rowCount'], item['row_count']].find((value): value is number => typeof value === 'number') ?? null : null;
    return {
      dataset: name,
      key: seen.instrumentField ?? name,
      names: [name.replace(/[-_]+/g, ' ')],
      fields: ordered,
      dateField: seen.dateField,
      instrumentField: seen.instrumentField,
      instruments: seen.instruments,
      first,
      last,
      count,
      instrument: null,
    };
  }

  async function read(entry: DatasetEntry, instrument: string | null, signal: AbortSignal): Promise<DataTable> {
    const filter = entry.instrumentField !== null && instrument !== null ? [`${entry.instrumentField}=${instrument}`] : [];
    const text = await call(['get', 'rows', entry.dataset, ...filter, '--limit', String(DATA_LIMITS.rows)], signal);
    const rows = listOf(parseJson(text, `rows of ${entry.dataset}`)).map(flat).filter((row): row is Json => row !== null);
    if (rows.length === 0) throw new Error(`dataset ${entry.dataset}${instrument === null ? '' : ` for ${instrument}`} returned no rows this adapter can read`);
    const have = Object.keys(rows[0] ?? {});
    const dateField = entry.dateField !== null && have.includes(entry.dateField) ? entry.dateField : sampleOf(rows, have, [], { dateField: null, instrumentField: null }).dateField;
    // A series' rows, oldest first. Whatever order the page came in, a chart reads left to right.
    const sorted = dateField === null ? rows : [...rows].sort((a, b) => String(dayOf(a[dateField]) ?? '').localeCompare(String(dayOf(b[dateField]) ?? '')) || String(a[dateField]).localeCompare(String(b[dateField])));
    const numeric = have.filter((field) => field !== dateField && field !== entry.instrumentField && sorted.slice(0, 20).some((row) => readNumber(String(row[field] ?? '')) !== null));
    const columns = [...(dateField === null ? [] : [dateField]), ...numeric];
    if (columns.length < 2) throw new Error(`dataset ${entry.dataset} has no numeric field this adapter can read`);
    const cell = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'object' ? '' : String(value));
    const last = dateField === null ? null : dayOf(sorted[sorted.length - 1]?.[dateField]);
    const label = [instrument, last === null ? null : `to ${last}`].filter((part): part is string => part !== null).join(', ');
    return {
      id: entry.dataset,
      source: `your dataset ${entry.dataset}${label === '' ? '' : ` (${label})`}`,
      columns,
      rows: sorted.slice(-DATA_LIMITS.rows).map((row) => columns.map((column) => (column === dateField ? (dayOf(row[column]) ?? cell(row[column])) : cell(row[column])))),
    };
  }

  return {
    find: (prompt) => matchDatasets(index, prompt),
    facts: (now): readonly DatasetFacts[] => factsOfDatasets(index, now),
    rows: (entry, signal) => read(entry, entry.instrument, signal),
    async table(ref: DatasetRef, signal) {
      const entry = entryOf(ref.dataset);
      if (entry === undefined) throw new Error(`there is no dataset named ${plainText(ref.dataset, 40)} in the index`);
      const instrument = ref.instrument === null ? null : (entry.instruments.find((one) => one.key.toLowerCase() === ref.instrument?.toLowerCase())?.key ?? null);
      if (ref.instrument !== null && instrument === null) throw new Error(`dataset ${entry.dataset} has no series ${plainText(ref.instrument, 30)}`);
      const table = await read(entry, instrument, signal);
      if (ref.field === null) return table;
      const column = table.columns.findIndex((name, at) => at > 0 && name.toLowerCase() === ref.field?.toLowerCase());
      if (column < 0) throw new Error(`dataset ${entry.dataset} has no field ${plainText(ref.field, 30)}`);
      return { ...table, columns: [table.columns[0] ?? '', table.columns[column] ?? ''], rows: table.rows.map((row) => [row[0] ?? '', row[column] ?? '']) };
    },
    async refresh(signal) {
      try {
        const listing = parseJson(await call(['get', 'datasets'], signal), 'the dataset list');
        const next: DatasetEntry[] = [];
        for (const item of listOf(listing).slice(0, MAX_DATASETS)) {
          try {
            const entry = await readEntry(item, signal);
            if (entry !== null) next.push(entry);
          } catch (error) {
            // One dataset that cannot be read keeps what the index had of it; the others are served.
            if (signal.aborted) throw error;
            const had = entryOf(nameOf(item));
            if (had !== undefined) next.push(had);
            log.warn('datasets.entry_unread', { dataset: nameOf(item), error });
          }
        }
        index = next;
        said = null;
        try {
          writeCached(cacheDir, next);
        } catch (error) {
          log.warn('datasets.cache_unwritten', { error });
        }
      } catch (error) {
        // The index stays as it was; a turn that names a dataset is told it could not be read. Said once, not on every refresh.
        const message = error instanceof Error ? error.message : String(error);
        if (message !== said) log.warn('datasets.unreadable', { reason: message, serving: index.length });
        said = message;
        throw error;
      }
    },
  };
}
