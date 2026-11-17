// The chat shell's read-only side: the conversations the session logs hold, one as a thread, and the pictures that go with it.
// Nothing here writes, and nothing here is reachable except through the owner's identity check (`/api/*`). A conversation is a log
// file in `<DATA_DIR>/logs`; its id is the file's stem, which must match `CONVERSATION_ID` before a path is ever built from it.

import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { CONVERSATION_API } from '@conduit/language';
import type { ContinueResponse, ConversationSummary, ConversationView } from '@conduit/language';
import type { Hono } from 'hono';
import { CONVERSATION_ID, earlierText, foldConversation, highestPhoto, highestTurn, summaryOf } from '../domain/conversations';
import type { SessionRecord } from '../domain/session-log';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { jsonBody, param } from './json';

/** The most conversations the list holds, newest first. */
const LIST_LIMIT = 100;
/** A turn id as the conductor makes it. */
const TURN_ID = /^[A-Za-z0-9_-]{1,32}$/;

function parse(line: string): SessionRecord | null {
  if (line.trim() === '') return null;
  try {
    const record = JSON.parse(line) as SessionRecord;
    return typeof record.type === 'string' && typeof record.at === 'number' ? record : null;
  } catch {
    // a line cut short by a kill: the rest of the file is still good
    return null;
  }
}

/** Only the records a summary needs. A log's briefs are large; the list reads past them without parsing. */
async function skim(path: string): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith('{"type":"session"') && !line.startsWith('{"type":"turn"') && !line.startsWith('{"type":"continued"')) continue;
    const record = parse(line);
    if (record !== null) out.push(record);
  }
  return out;
}

async function readAll(path: string): Promise<SessionRecord[]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').flatMap((line) => {
    const record = parse(line);
    return record === null ? [] : [record];
  });
}

/**
 * - `GET CONVERSATION_API.list`: `ConversationSummary[]`, newest first, at most 100. A log that holds no turn is not a conversation yet and is left out.
 * - `GET CONVERSATION_API.one(id)`: a `ConversationView`: every turn, what the person said (and the photos), what the reply said, the lines of Series it wrote, and the url of its still.
 * - `GET CONVERSATION_API.still(id, turn)`: the resting picture the page saved for that turn, a JPEG.
 * - `GET CONVERSATION_API.photo(id, photo)`: a photo the person gave in that conversation, as it was kept (a JPEG). Only one the log names.
 *
 * 404 for an id that is not a log here, 404 when LOG_DIR=off. These routes read files the server already writes for `pnpm sessions`.
 */
export function registerConversationRoutes(app: Hono, deps: HttpDeps): void {
  const logs = deps.env.logDir;
  const dir = (): string => {
    if (logs === null) throw errors.notFound('conversations (the server keeps no logs)');
    return logs;
  };
  const fileOf = (id: string): string => {
    if (!CONVERSATION_ID.test(id)) throw errors.notFound(`conversation ${id.slice(0, 40)}`);
    return join(dir(), `${id}.jsonl`);
  };
  const load = async (id: string): Promise<{ records: SessionRecord[]; updated: string }> => {
    const path = fileOf(id);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) throw errors.notFound(`conversation ${id}`);
    return { records: await readAll(path), updated: info.mtime.toISOString() };
  };

  app.get(CONVERSATION_API.list, async (c) => {
    const folder = dir();
    const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl') && CONVERSATION_ID.test(name.slice(0, -6))).sort().reverse();
    const found: ConversationSummary[] = [];
    for (const name of names) {
      if (found.length >= LIST_LIMIT) break;
      const path = join(folder, name);
      const info = await stat(path).catch(() => null);
      if (info === null) continue;
      const summary = summaryOf(name.slice(0, -6), await skim(path).catch(() => []), info.mtime.toISOString());
      if (summary.turns > 0) found.push(summary);
    }
    c.header('Cache-Control', 'no-store');
    return c.json<readonly ConversationSummary[]>(found);
  });

  app.get('/api/conversations/:id', async (c) => {
    const id = param(c, 'id');
    const { records, updated } = await load(id);
    c.header('Cache-Control', 'no-store');
    return c.json<ConversationView>(foldConversation(id, records, updated));
  });

  /**
   * POST `{ session }`: 200 `ContinueResponse`. The page's own session, which has said nothing yet, takes up this conversation: the
   * server keeps writing to its log, and the brain's first brief carries a short account of it. 404 for an id that is not a log here
   * (the id is checked by `CONVERSATION_ID` before a path is built), 409 for a session that already has a conversation of its own.
   * Like every `/api` route, it answers only the owner.
   */
  app.post('/api/conversations/:id/continue', async (c) => {
    const id = param(c, 'id');
    const body = (await jsonBody(c)) as { session?: unknown } | null;
    const session = typeof body?.session === 'string' ? body.session : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) throw errors.badRequest('session must be the id of this page\'s session');
    const { records, updated } = await load(id);
    const view = foldConversation(id, records, updated);
    if (view.turns.length === 0) throw errors.notFound(`conversation ${id}`);
    const first = records.find((record) => record.type === 'session');
    deps.conductor.continueConversation(session, id, earlierText(view), highestTurn(records), highestPhoto(records), first?.type === 'session' ? first.session : id.slice(16), records);
    c.header('Cache-Control', 'no-store');
    return c.json<ContinueResponse>({ id, session });
  });

  app.get('/api/conversations/:id/turns/:turn/still', async (c) => {
    const id = param(c, 'id');
    const turn = param(c, 'turn');
    if (!TURN_ID.test(turn)) throw errors.notFound('still');
    const { records } = await load(id);
    const kept = records.find((record) => record.type === 'snapshot' && record.turn === turn);
    // The file name comes from the log, and is checked to be a file of this conversation beside it before it is opened.
    if (kept?.type !== 'snapshot' || !kept.file.startsWith(`${id}-`) || kept.file.includes('/') || kept.file.includes('\\')) throw errors.notFound('still');
    const bytes = await readFile(join(dir(), kept.file)).catch(() => null);
    if (bytes === null) throw errors.notFound('still');
    c.header('Content-Type', kept.file.endsWith('.png') ? 'image/png' : 'image/jpeg');
    c.header('Cache-Control', 'private, max-age=3600');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes));
  });

  app.get('/api/conversations/:id/photos/:photo', async (c) => {
    const id = param(c, 'id');
    const photo = param(c, 'photo');
    if (!/^u\d{1,6}$/.test(photo)) throw errors.notFound('photo');
    const { records } = await load(id);
    const kept = records.find((record) => record.type === 'upload' && record.id === photo);
    if (kept?.type !== 'upload' || kept.file === null) throw errors.notFound('photo');
    // `file` is relative to the data folder; it must stay inside the uploads folder there.
    const uploads = resolve(deps.env.data.uploads);
    const path = resolve(deps.env.data.root, kept.file);
    if (!path.startsWith(uploads + sep)) throw errors.notFound('photo');
    const bytes = await readFile(path).catch(() => null);
    if (bytes === null) throw errors.notFound('photo');
    c.header('Content-Type', 'image/jpeg');
    c.header('Cache-Control', 'private, max-age=3600');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes));
  });
}
