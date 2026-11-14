// The documents that sessions are making now, and the way back to the ones that are not live. The conductor feeds a document the records it
// writes to the log; the catalogue keeps the index; a document that is not live is folded from its files each time it is asked for.

import { DocumentFolder } from '@conduit/language';
import type { DocumentSummary, DocumentView } from '@conduit/language';
import { summaryOf, viewOf } from '../domain/document';
import type { DocChange, DocumentMeta, Documents, LoadedDocument } from '../domain/document';
import type { SessionEntry } from '../domain/session-log';
import type { Logger } from '../log';
import type { Catalogue } from './catalogue';

interface Live {
  readonly id: string;
  readonly fold: DocumentFolder;
  created: string | null;
  /** log files this document is folded from, oldest first; a session that opens it again adds its own */
  readonly files: string[];
  readonly sessions: Set<string>;
  /** the version of the fold that the catalogue last heard of */
  told: number;
}

export interface DocumentsDeps {
  readonly catalogue: Catalogue;
  readonly log: Logger;
  readonly now: () => number;
}

function stemOf(file: string): string {
  return file.replace(/\.jsonl$/, '');
}

export function createDocuments(deps: DocumentsDeps): Documents {
  const { catalogue, log, now } = deps;
  const live = new Map<string, Live>();
  const bySession = new Map<string, Live>();

  const meta = (doc: Live): DocumentMeta => ({
    id: doc.id,
    created: doc.created,
    updated: new Date(now()).toISOString(),
    files: [...doc.files],
    live: doc.sessions.size > 0,
    thumbnail: catalogue.list().find((entry) => entry.id === doc.id)?.thumbnail ?? null,
  });

  /** Tells the catalogue what this document is now, when it is a document and has moved since it was last told. */
  const tell = (doc: Live): void => {
    if (!doc.fold.isDocument() || doc.fold.revision() === doc.told) return;
    doc.told = doc.fold.revision();
    catalogue.put(summaryOf(doc.fold, meta(doc)));
  };

  return {
    load: async (id) => {
      const open = live.get(id);
      if (open !== undefined) return { id, fold: open.fold, files: [...open.files], created: open.created };
      return catalogue.load(id);
    },

    begin: (session, file, resume) => {
      let doc: Live | undefined = resume === null ? undefined : live.get(resume.id);
      if (doc === undefined) {
        const id = resume !== null ? resume.id : file !== '' ? stemOf(file) : `mem-${session}-${now()}`;
        doc = { id, fold: resume !== null ? resume.fold : new DocumentFolder({ id }), created: resume?.created ?? null, files: resume !== null ? [...resume.files] : [], sessions: new Set(), told: -1 };
        live.set(id, doc);
      }
      if (file !== '' && !doc.files.includes(file)) doc.files.push(file);
      doc.sessions.add(session);
      bySession.set(session, doc);
    },

    place: (session, text) => bySession.get(session)?.fold.place(text) ?? null,

    record: (session, entry: SessionEntry): DocChange | null => {
      const doc = bySession.get(session);
      if (doc === undefined) return null;
      if (entry.type === 'session' && doc.created === null) doc.created = entry.started;
      const out = doc.fold.apply(entry);
      tell(doc);
      return { document: doc.id, ...doc.fold.heading(), nodes: out.nodes, state: out.state, applied: out.applied, issues: out.issues };
    },

    viewOfSession: (session) => {
      const doc = bySession.get(session);
      return doc === undefined || !doc.fold.isDocument() ? null : viewOf(doc.fold, meta(doc));
    },

    view: async (id): Promise<DocumentView | null> => {
      await catalogue.ready;
      const open = live.get(id);
      if (open !== undefined) return open.fold.isDocument() ? viewOf(open.fold, meta(open)) : null;
      const loaded: LoadedDocument | null = await catalogue.load(id);
      if (loaded === null) return null;
      const known = catalogue.list().find((entry) => entry.id === id);
      return viewOf(loaded.fold, { id, created: loaded.created, updated: known?.updated ?? new Date(now()).toISOString(), files: loaded.files, live: false, thumbnail: known?.thumbnail ?? null });
    },

    list: async (): Promise<readonly DocumentSummary[]> => {
      await catalogue.ready;
      const out = new Map<string, DocumentSummary>();
      for (const summary of catalogue.list()) out.set(summary.id, summary);
      for (const doc of live.values()) if (doc.fold.isDocument()) out.set(doc.id, summaryOf(doc.fold, meta(doc)));
      return [...out.values()].sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
    },

    release: (session) => {
      const doc = bySession.get(session);
      if (doc === undefined) return;
      bySession.delete(session);
      doc.sessions.delete(session);
      if (doc.sessions.size > 0) return;
      // Nobody is making it now: what it is goes to the index, and it is let go of; opening it again folds it from its files.
      live.delete(doc.id);
      if (doc.fold.isDocument()) {
        doc.told = -1;
        tell(doc);
        void catalogue.flush().catch((error: unknown) => log.warn('documents.flush_failed', { error }));
      }
    },

    close: async () => {
      for (const doc of live.values()) {
        doc.sessions.clear();
        doc.told = -1;
        tell(doc);
      }
      live.clear();
      bySession.clear();
      await catalogue.flush();
    },
  };
}
