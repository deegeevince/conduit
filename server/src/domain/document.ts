// The document on the server (PLAN-v3-core 2.1, 2.11, WS4).
//
// A conversation's document is a FOLD over its session log, and nothing else: `DocumentFolder` (L/document.ts, WS3) takes one record at a
// time, in order, and is the only thing that ever builds a document. The conductor feeds it the very record it has just written to the log;
// a restart feeds it the same records read back from the file. So a logged session folded twice gives the same document, and a document
// that is live and one that was folded from its log cannot differ (the check of WS4).
//
// What is here is what the server adds to that fold: the bounds, the catalogue's summary of a document, a document with the person's state
// in it, and the port the conductor holds (`Documents`). Nothing here reads a file, a clock or the network, and nothing names or describes
// the learner.

import type { DocNode, DocumentFolder, DocumentSummary, DocumentView, NodeId, OutlineItem } from '@conduit/language';
import type { SessionEntry } from './session-log';

/** What one document may hold: a model that goes on writing is bounded here, not trusted. */
export const DOCUMENT_BOUNDS = { nodes: 2_000, stepsPerNode: 60, hintsPerAsk: 8, title: 300, words: 2_000, show: 400, answers: 20, answerChars: 80 } as const;

// ---------------------------------------------------------------- what the catalogue lists

/** What a summary says that the fold cannot: which document, when it began and last moved, and where it is kept. */
export interface DocumentMeta {
  readonly id: string;
  readonly created: string | null;
  readonly updated: string;
  readonly files: readonly string[];
  readonly live: boolean;
  readonly thumbnail: string | null;
}

export function summaryOf(fold: DocumentFolder, meta: DocumentMeta): DocumentSummary {
  const { document, state } = fold.snapshot();
  const outline: OutlineItem[] = [];
  const tagged = new Map<string, NodeId[]>();
  let lessons = 0;
  let outlined = 0;
  let done = 0;
  const isLesson = (node: DocNode): boolean => node.body !== null && node.body.kind === 'lesson';
  const doneOf = (id: NodeId): boolean => state.progress[id]?.done === true;
  const walk = (id: NodeId, depth: number): void => {
    const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
    if (node === undefined) return;
    if (node.tag !== null) tagged.set(node.tag, [...(tagged.get(node.tag) ?? []), id]);
    if (isLesson(node)) lessons += 1;
    if (node.status === 'outlined' && node.children.length === 0) outlined += 1;
    if (doneOf(id)) done += 1;
    if (!isLesson(node)) {
      const ways = node.children.flatMap((child) => (Object.hasOwn(document.nodes, child) ? [document.nodes[child]] : [])).filter((child): child is DocNode => child !== undefined && isLesson(child));
      outline.push({
        id,
        title: node.title,
        depth,
        status: node.status,
        ways: ways.length,
        tags: [...new Set(ways.flatMap((way) => (way.tag === null ? [] : [way.tag])))],
        done: doneOf(id),
      });
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(document.root, 0);
  return {
    id: meta.id,
    title: document.title === '' ? 'A conversation' : document.title,
    created: meta.created,
    updated: meta.updated,
    files: meta.files,
    nodes: Object.keys(document.nodes).length,
    lessons,
    outlined,
    done,
    cursor: state.cursor.node,
    outline,
    techniques: [...tagged.entries()].map(([tag, nodes]) => ({ tag, nodes })),
    thumbnail: meta.thumbnail,
    live: meta.live,
  };
}

export function viewOf(fold: DocumentFolder, meta: DocumentMeta): DocumentView {
  const { document, state } = fold.snapshot();
  return { document, state, summary: summaryOf(fold, meta) };
}

// ---------------------------------------------------------------- the port the conductor holds

/** A document folded from its log, with the files it came from. */
export interface LoadedDocument {
  readonly id: string;
  readonly fold: DocumentFolder;
  readonly files: readonly string[];
  readonly created: string | null;
}

/** What a record did, for the conductor to send: the `doc` event's content, whether state moved, and whether the record is worth keeping. */
export interface DocChange {
  readonly document: string;
  readonly title: string;
  readonly root: NodeId;
  readonly nodes: readonly DocNode[];
  readonly state: boolean;
  readonly applied: boolean;
}

/** What the conductor needs of the documents. The file system is behind it (`S/documents`). */
export interface Documents {
  /** Folds a document from its log files, or answers what is live; null when there is no such document. */
  load(id: string): Promise<LoadedDocument | null>;
  /** A session begins. `file` is its log file's name ('' when nothing is logged); `resume` is the document it opens again, if it does. */
  begin(session: string, file: string, resume: LoadedDocument | null): void;
  /** The node this line text would land in, for the log record; null when it is no document line. */
  place(session: string, text: string): NodeId | null;
  /** Feeds the document the record the conductor has just written (or is about to). Null when the session has no document and the record is nothing to it. */
  record(session: string, entry: SessionEntry): DocChange | null;
  /** The document this session is making or has opened, with the person's state in it; null while it has none. */
  viewOfSession(session: string): DocumentView | null;
  view(id: string): Promise<DocumentView | null>;
  list(): Promise<readonly DocumentSummary[]>;
  release(session: string): void;
  close(): Promise<void>;
}

export const NO_DOCUMENTS: Documents = {
  load: async () => null,
  begin: () => undefined,
  place: () => null,
  record: () => null,
  viewOfSession: () => null,
  view: async () => null,
  list: async () => [],
  release: () => undefined,
  close: async () => undefined,
};

/** A document's id is the stem of the log file that began it (`20261114-173639-c3`): it names a file and is never taken from a path. */
export const DOCUMENT_ID = /^[0-9]{8}-[0-9]{6}-[A-Za-z0-9_-]{1,40}$|^mem-[A-Za-z0-9_-]{1,60}$/;
