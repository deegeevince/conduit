// What a document keeps beside its words (PLAN-v3-core WS4, kept): the cut of the photo each question sits on, and the strokes of her hand.
// They live with the DOCUMENT, in `<DATA_DIR>/documents/<document id>/`, and not with the session that made them: a photo is its session's and a
// session ends, but a document is opened again from another browser or another device, and her working is hers.
//
//   crop-<node>.jpg    the part of the photo a question sits on, cut by the server when the question was named
//   ink.jsonl          one line a time she wrote: `{ node, ask, n, at, text, doc }`. `n` 0 is the paper as it stands (the draft, rewritten as she writes);
//                      `n` 1, 2, 3… is the strokes of her first, second, third try, with what the reader made of them in `text`.

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InkDocument } from '@conduit/language';
import { DOCUMENT_ID } from '../domain/document';
import type { Logger } from '../log';

export interface InkRecord {
  readonly node: string;
  readonly ask: string;
  /** 0: the paper as it stands now; 1…: that try */
  readonly n: number;
  readonly at: number;
  /** what the reader read from the strokes of a try (the lines she wrote) */
  readonly text: string;
  readonly doc: InkDocument;
}

export interface DocumentAssets {
  putCrop(document: string, node: string, jpeg: Uint8Array): Promise<void>;
  crop(document: string, node: string): Promise<Uint8Array | null>;
  hasCrop(document: string, node: string): Promise<boolean>;
  putInk(document: string, record: InkRecord): Promise<void>;
  /** the latest record of each (node, ask, n); a draft that was cleared is not there */
  ink(document: string): Promise<readonly InkRecord[]>;
}

const stemOf = (node: string): string => createHash('sha1').update(node).digest('hex').slice(0, 20);

export function createDocumentAssets(deps: { readonly dir: string; readonly log: Logger }): DocumentAssets {
  const folder = (document: string): string => {
    if (!DOCUMENT_ID.test(document)) throw new Error('that is not a document id');
    return join(deps.dir, document);
  };
  const cropFile = (document: string, node: string): string => join(folder(document), `crop-${stemOf(node)}.jpg`);
  return {
    async putCrop(document, node, jpeg) {
      await mkdir(folder(document), { recursive: true, mode: 0o700 });
      await writeFile(cropFile(document, node), jpeg, { mode: 0o600 });
    },
    async crop(document, node) {
      try {
        return new Uint8Array(await readFile(cropFile(document, node)));
      } catch {
        return null;
      }
    },
    async hasCrop(document, node) {
      return (await this.crop(document, node)) !== null;
    },
    async putInk(document, record) {
      await mkdir(folder(document), { recursive: true, mode: 0o700 });
      await appendFile(join(folder(document), 'ink.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
    async ink(document) {
      let raw: string;
      try {
        raw = await readFile(join(folder(document), 'ink.jsonl'), 'utf8');
      } catch {
        return [];
      }
      const latest = new Map<string, InkRecord>();
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const record = JSON.parse(line) as InkRecord;
          latest.set(`${record.node}\u0000${record.ask}\u0000${record.n}`, record);
        } catch {
          deps.log.warn('documents.ink_line_unreadable', { document });
        }
      }
      // a draft with no strokes is a paper she cleared
      return [...latest.values()].filter((record) => !(record.n === 0 && record.doc.strokes.length === 0));
    },
  };
}
