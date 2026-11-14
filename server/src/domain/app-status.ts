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

/** How long a read of the status file is trusted before the next brief asks the disk again. */
const STATUS_FRESH_MS = 30_000;

/**
 * What a brief can ask for without waiting: the last read, and a new read started in the background when it has grown old. Null until
 * the first read lands, and when the file has nothing in it (the brain is then told it does not know where the product stands).
 */
export function createStatusReader(file: string, now: () => number): () => AppStatus | null {
  let held: AppStatus | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  return () => {
    if (now() - readAt > STATUS_FRESH_MS) {
      readAt = now();
      void readStatusFile(file).then((status) => {
        held = status.live.length + status.building.length + status.waiting.length === 0 ? null : status;
      });
    }
    return held;
  };
}
