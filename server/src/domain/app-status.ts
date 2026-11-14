// The steward's account of where the product stands (`STATUS.md`): read for `/status` and for the brain's note about the app.

import { readFile, stat } from 'node:fs/promises';
import type { AppStatus } from '@conduit/language';

/** The most items read from one heading and the most characters of one item: a file is a note, not a document. */
const STATUS_LIMITS = { items: 12, chars: 200 } as const;

/**
 * Reads `STATUS.md`: three headings (`## Live`, `## Being built …`, `## Waiting on you`) and the `- ` lines under each. Nothing else in the
 * file is read: not the title, not prose, not a heading it does not know, and so not whatever else is written there.
 */
export function readStatus(markdown: string): Omit<AppStatus, 'updated'> {
  const found: Record<'live' | 'building' | 'waiting', string[]> = { live: [], building: [], waiting: [] };
  let into: keyof typeof found | null = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      const heading = line.replace(/^#+\s*/, '').toLowerCase();
      into = heading.startsWith('live') ? 'live' : heading.startsWith('being built') || heading.startsWith('building') ? 'building' : heading.startsWith('waiting') ? 'waiting' : null;
      continue;
    }
    if (into === null || !line.startsWith('- ') || found[into].length >= STATUS_LIMITS.items) continue;
    const item = line.slice(2).replace(/\s+/g, ' ').trim();
    if (item !== '') found[into].push(item.length > STATUS_LIMITS.chars ? `${item.slice(0, STATUS_LIMITS.chars - 1)}…` : item);
  }
  return found;
}

/** A file that is not there is an empty status, not an error: the product runs without the steward. */
export async function readStatusFile(file: string): Promise<AppStatus> {
  try {
    const [markdown, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { ...readStatus(markdown), updated: info.mtime.toISOString() };
  } catch {
    return { live: [], building: [], waiting: [], updated: null };
  }
}

/** How long a read of a note file is trusted before the next brief asks the disk again. */
const NOTE_FRESH_MS = 30_000;

/** The last read of a small file the steward keeps, and a new read started in the background when it has grown old; never waits. */
function cachedNote<T>(read: () => Promise<T | null>, now: () => number): () => T | null {
  let held: T | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  return () => {
    if (now() - readAt > NOTE_FRESH_MS) {
      readAt = now();
      void read().then((value) => {
        held = value;
      });
    }
    return held;
  };
}

/**
 * What a brief can ask for without waiting: the last read of the status file. Null until the first read lands, and when the file has
 * nothing in it (the brain is then told it does not know where the product stands).
 */
export function createStatusReader(file: string, now: () => number): () => AppStatus | null {
  return cachedNote(async () => {
    const status = await readStatusFile(file);
    return status.live.length + status.building.length + status.waiting.length === 0 ? null : status;
  }, now);
}

/** The most characters of the changelog's newest section a brief carries. */
const NEWS_CHARS = 2400;

/** The newest version's section of the changelog: the first `## ` heading and the lines under it, up to the next one. Null when there is none. */
export function newestSection(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.startsWith('## '));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const section = lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
  return section.length > NEWS_CHARS ? `${section.slice(0, NEWS_CHARS - 1).trimEnd()}…` : section;
}

/** The changelog's newest section, for the brief when the user asks what is new. Same rules as the status reader. */
export function createChangelogReader(file: string, now: () => number): () => string | null {
  return cachedNote(async () => {
    try {
      return newestSection(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }, now);
}
