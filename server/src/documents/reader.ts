// Reading a document back from the session logs it was written to. The only reader of those files in the server: the log is for people and
// for `pnpm sessions` everywhere else, and here it is also the document's own storage (2.11).

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { DocumentFold } from '../domain/document';
import type { SessionEntry } from '../domain/session-log';

/** The record types a document is built from: every other line of the log is skipped without being parsed. */
const READ = /^\{"type":"(session|line|end|node|state)"/;

/**
 * The records of one log file that a document is made of, in the order they were written. A line that is not JSON (the last one, when
 * the server was killed in the middle of writing it) is skipped: what came before it is still a document.
 */
export async function* documentEntries(path: string): AsyncGenerator<SessionEntry> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of lines) {
      if (!READ.test(text)) continue;
      try {
        const entry = JSON.parse(text) as SessionEntry;
        if (typeof entry === 'object' && entry !== null && typeof entry.type === 'string') yield entry;
      } catch {
        // a torn last line
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The document these files make, folded in order. `files` are names inside `dir`, oldest first. A file that cannot be read is left out. */
export async function foldFiles(id: string, dir: string, files: readonly string[]): Promise<{ readonly fold: DocumentFold; readonly read: readonly string[] }> {
  const fold = new DocumentFold(id);
  const read: string[] = [];
  for (const file of files) {
    try {
      for await (const entry of documentEntries(join(dir, file))) fold.apply(entry);
      read.push(file);
    } catch {
      // gone or unreadable: the document is what the others say
    }
  }
  return { fold, read };
}

/** What a log file says about itself: the document it opens again, if any, and whether it ever named a part. Reads the whole file once. */
export async function inspectFile(path: string): Promise<{ readonly resumes: string | null; readonly hasParts: boolean }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let resumes: string | null = null;
  let first = true;
  let hasParts = false;
  try {
    for await (const text of lines) {
      if (first) {
        first = false;
        if (text.startsWith('{"type":"session"')) {
          try {
            const entry = JSON.parse(text) as { resumes?: unknown };
            if (typeof entry.resumes === 'string') resumes = entry.resumes;
          } catch {
            // unreadable first record: not a session log we know
          }
        }
      }
      if (!hasParts && text.startsWith('{"type":"line"') && text.includes('"text":"part ')) hasParts = true;
      if (hasParts || resumes !== null) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { resumes, hasParts };
}
