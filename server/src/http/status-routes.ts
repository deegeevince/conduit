// The steward's account of where the product stands, for `/status` and for the brain's note about the app.

import { readFile, stat } from 'node:fs/promises';
import { API } from '@conduit/language';
import type { AppStatus } from '@conduit/language';
import type { Hono } from 'hono';
import type { HttpDeps } from './deps';

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

export function registerStatusRoutes(app: Hono, deps: HttpDeps): void {
  /** 200 `AppStatus`. A file that is not there is an empty status, not an error: the product runs without the steward. */
  app.get(API.status, async (c) => {
    try {
      const [markdown, info] = await Promise.all([readFile(deps.env.statusFile, 'utf8'), stat(deps.env.statusFile)]);
      return c.json<AppStatus>({ ...readStatus(markdown), updated: info.mtime.toISOString() });
    } catch {
      return c.json<AppStatus>({ live: [], building: [], waiting: [], updated: null });
    }
  });
}
