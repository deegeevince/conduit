// An optional account of where the product stands (`STATUS.md`, not part of the published repository): read for `/status` and for the brain's note about the app.

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

/** The most characters of the changelog a brief carries (the whole file is about 5,500). */
const NEWS_CHARS = 7000;

/**
 * What the tour is built from: EVERY version's section, newest first, each with its heading (a heading marked "(live…)" is what the brain is told is
 * live). The newest one alone told the owner "mock-ups are the only live item", which left v2.1 out. Sections are kept whole, from the top, while they fit;
 * a section that would not fit is cut at its last whole item. Null when there is no section.
 */
export function newestSection(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  if (sections.length === 0) return null;
  const out: string[] = [];
  let used = 0;
  for (const section of sections) {
    const text = section.join('\n').trim();
    if (used + text.length + 2 <= NEWS_CHARS) {
      out.push(text);
      used += text.length + 2;
      continue;
    }
    const room = NEWS_CHARS - used - 2;
    if (room > 200) {
      const cut = text.slice(0, room);
      out.push(cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0)).trimEnd());
    }
    break;
  }
  return out.join('\n\n');
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
