// The catalogue: every document there is, listed from `<DATA_DIR>/documents/index.json` and kept honest by the session logs.
//
// The logs are the truth and the index is a cache of them (2.11): it is written as documents change, and when it is missing, corrupt or
// behind (the server was killed inside the write's delay) it is rebuilt from the logs. Each log file is remembered with the size it had
// when it was read, so a start reads again only the files that are new or have grown.
//
// Nothing here writes outside `<DATA_DIR>/documents`, and nothing in the index but the question's own words and the person's place.

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentFolder, DocumentSummary } from '@conduit/language';
import { summaryOf as summarise } from '../domain/document';
import type { LoadedDocument } from '../domain/document';
import type { Logger } from '../log';
import { foldFiles, inspectFile } from './reader';

const INDEX_VERSION = 1;

interface IndexFile {
  readonly version: number;
  /** every log file read, and the size it had then: a file the same size is not read again */
  readonly scanned: Readonly<Record<string, number>>;
  readonly documents: readonly DocumentSummary[];
}

export interface CatalogueDeps {
  /** `<DATA_DIR>/documents` */
  readonly dir: string;
  /** the session logs' folder; null when LOG_DIR=off, and then nothing is listed or opened again */
  readonly logs: string | null;
  readonly log: Logger;
  /** milliseconds; injected so nothing here reads the clock directly */
  readonly now: () => number;
}

export interface Catalogue {
  /** Resolves when the index has been loaded and checked against the logs. Nothing is listed before. */
  readonly ready: Promise<void>;
  list(): readonly DocumentSummary[];
  has(id: string): boolean;
  /** Folds a document from its files. Null when it is not in the catalogue or its files are gone. */
  load(id: string): Promise<LoadedDocument | null>;
  /** Records a live document's summary, to be written soon. */
  put(summary: DocumentSummary): void;
  /** Writes what is waiting. */
  flush(): Promise<void>;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function stemOf(file: string): string {
  return file.replace(/\.jsonl$/, '');
}

export function createCatalogue(deps: CatalogueDeps): Catalogue {
  const { dir, logs, log, now } = deps;
  const path = join(dir, 'index.json');
  const documents = new Map<string, DocumentSummary>();
  let scanned: Record<string, number> = {};
  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();
  let dirty = false;

  const write = async (): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    const body: IndexFile = { version: INDEX_VERSION, scanned, documents: [...documents.values()] };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // Whole or not at all: a kill in the middle leaves the old index, never half of one.
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      dirty = true;
      log.warn('documents.index_write_failed', { error });
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      writing = writing.then(write);
    }, 750);
    timer.unref();
  };

  const sizeOf = async (file: string): Promise<number | null> => {
    if (logs === null) return null;
    try {
      return (await stat(join(logs, file))).size;
    } catch {
      return null;
    }
  };

  const summaryOf = async (id: string, fold: DocumentFolder, created: string | null, files: readonly string[], previous: DocumentSummary | undefined): Promise<DocumentSummary> => {
    let newest = 0;
    for (const file of files) {
      try {
        if (logs !== null) newest = Math.max(newest, (await stat(join(logs, file))).mtimeMs);
      } catch {
        // gone
      }
    }
    return summarise(fold, { id, created, updated: isoOf(newest > 0 ? newest : now()), files, live: false, thumbnail: previous?.thumbnail ?? null });
  };

  /** Reads what the logs say that the index does not, once, at the start. */
  const reconcile = async (): Promise<void> => {
    try {
      const index = JSON.parse(await readFile(path, 'utf8')) as IndexFile;
      if (index.version === INDEX_VERSION) {
        scanned = { ...index.scanned };
        for (const summary of index.documents) documents.set(summary.id, summary);
      }
    } catch {
      // none yet, or not readable: every log is read again below
    }
    if (logs === null) return;
    let names: string[];
    try {
      names = (await readdir(logs)).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      return;
    }
    // Which documents have a file that is new or longer than when it was read.
    const stale = new Set<string>();
    const fresh = new Map<string, string[]>();
    let moved = false;
    for (const file of names) {
      const size = await sizeOf(file);
      if (size === null || scanned[file] === size) continue;
      const found = await inspectFile(join(logs, file)).catch(() => null);
      scanned[file] = size;
      moved = true;
      if (found === null) continue;
      const id = found.resumes ?? (found.hasParts ? stemOf(file) : null);
      if (id === null) continue;
      stale.add(id);
      fresh.set(id, [...(fresh.get(id) ?? []), file]);
    }
    // A document whose file was already known but has since grown is stale too, though inspecting the file says nothing new about it.
    for (const summary of documents.values()) {
      for (const file of summary.files) {
        if ((await sizeOf(file)) !== scanned[file]) stale.add(summary.id);
      }
    }
    let changed = false;
    for (const id of stale) {
      const known = documents.get(id);
      const files = [...new Set([...(known?.files ?? []), ...(fresh.get(id) ?? [])])].sort();
      const { fold, read, created } = await foldFiles(id, logs, files);
      for (const file of read) scanned[file] = (await sizeOf(file)) ?? scanned[file] ?? 0;
      if (!fold.isDocument()) {
        if (documents.delete(id)) changed = true;
        continue;
      }
      documents.set(id, await summaryOf(id, fold, created, read, known));
      changed = true;
      log.info('documents.indexed', { document: id, files: read.length, nodes: Object.keys(fold.document().nodes).length });
    }
    if (changed || moved) schedule();
  };

  const ready = reconcile().catch((error: unknown) => log.warn('documents.reconcile_failed', { error }));

  return {
    ready,
    list: () => [...documents.values()].sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0)),
    has: (id) => documents.has(id),
    load: async (id) => {
      await ready;
      const summary = documents.get(id);
      if (summary === undefined || logs === null) return null;
      const { fold, read, created } = await foldFiles(id, logs, summary.files);
      return fold.isDocument() ? { id, fold, files: read, created } : null;
    },
    put: (summary) => {
      documents.set(summary.id, summary);
      schedule();
    },
    flush: async () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // The sizes the files have now, so that the next start does not read again what was already folded.
      if (logs !== null) {
        for (const summary of documents.values()) {
          for (const file of summary.files) {
            const size = await sizeOf(file);
            if (size !== null) scanned[file] = size;
          }
        }
      }
      dirty = true;
      writing = writing.then(write);
      await writing;
    },
  };
}
