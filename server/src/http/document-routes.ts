// The document's side of the API (PLAN-v3-core WS4): the catalogue, one document, and opening one again. Each handler is one call on the
// conductor or the documents; none holds state.

import { API } from '@conduit/language';
import type { DocumentSummary, DocumentView, OpenDocumentResponse } from '@conduit/language';
import type { Hono } from 'hono';
import { INK_LIMITS, checkInkDocument, nodeOf } from '@conduit/language';
import { DOCUMENT_ID } from '../domain/document';
import { fakeDigits, holdsAnswer, readDigits, readInk } from '../judge/ink';
import type { DigitCell } from '../judge/ink';
import { parseCreateSession } from '../domain/validate';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { jsonBody, param } from './json';

/** A document's id names a log file: it is checked whole before it is used for anything. */
function documentId(raw: string): string {
  if (!DOCUMENT_ID.test(raw)) throw errors.badRequest('that is not a document id');
  return raw;
}

export function registerDocumentRoutes(app: Hono, deps: HttpDeps): void {
  const { conductor, uploads, usage, env, docAssets } = deps;

  /** 200 `DocumentSummary[]`: the catalogue, newest first. */
  app.get(API.documents, async (c) => c.json<readonly DocumentSummary[]>(await conductor.listDocuments()));

  /** 200 `DocumentView`: the document and the person's state in it. 404 when there is no such document. */
  app.get(API.document(':id'), async (c) => {
    const id = documentId(param(c, 'id'));
    const view = await conductor.documentView(id);
    if (view === null) throw errors.notFound(`document ${id}`);
    return c.json<DocumentView>(view);
  });

  /** Body: CreateSessionRequest. 201 `OpenDocumentResponse`: a new session, bound to the document, and what to draw. This is how a conversation is opened again after a restart. */
  app.post(API.documentOpen(':id'), async (c) => {
    const id = documentId(param(c, 'id'));
    const request = parseCreateSession(await jsonBody(c));
    return c.json<OpenDocumentResponse>(await conductor.resumeDocument(id, request), 201);
  });

  /** 200 `DocumentView`: the document this session is making or has opened. 404 until it has one. */
  app.get(API.sessionDocument(':session'), (c) => {
    const view = conductor.documentOf(param(c, 'session'));
    if (view === null) throw errors.notFound(`a document for session ${param(c, 'session')}`);
    return c.json<DocumentView>(view);
  });

  /**
   * Body `{ image, node, ask }`: `image` is the upload id of the picture of the ink (`POST API.uploads`), `node` and `ask` say which ask of the session's
   * document it answers. Reads the handwriting as words (a cheap model that only transcribes: the document's own matcher says whether it is right).
   * 200 `{ text, lines, unclear }`.
   */
  app.post(API.readInk(':session'), async (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    if (!uploads.available) throw errors.forbidden('photos are switched off on this server');
    // The ink is read by a small Claude process; a server on the Codex brain has none, so the learner types the answer.
    if (env.brain.kind === 'codex-cli') throw errors.forbidden('reading handwriting needs the Claude brain on this server; type the answer instead');
    const raw: unknown = await c.req.json().catch(() => null);
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const image = typeof body['image'] === 'string' ? body['image'] : '';
    if (!/^u[1-9][0-9]{0,3}$/.test(image)) throw errors.badRequest('image must be the id the server gave the picture of the ink (u1, u2, ...)');
    const picture = await uploads.load(session, image);
    if (picture === null) throw errors.notFound(`photo ${image}`);
    // PLAN-maths M4: the cells of a written method, as one numbered contact sheet: `{ mode: 'digits', cells: [{ n, max, strokes }] }` answers `{ digits: { "1": "7", "2": "" } }`
    if (body['mode'] === 'digits') {
      const asked = (Array.isArray(body['cells']) ? body['cells'] : []).slice(0, 24).flatMap((entry): (DigitCell & { strokes: number })[] => {
        const one = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
        const n = one['n'];
        const max = one['max'];
        const strokes = one['strokes'];
        return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 99 ? [{ n, max: typeof max === 'number' && max >= 1 && max <= 4 ? Math.floor(max) : 1, strokes: typeof strokes === 'number' && strokes >= 0 ? Math.floor(strokes) : 0 }] : [];
      });
      if (asked.length === 0) throw errors.badRequest('cells must name the tiles of the sheet');
      if (env.inkReader === 'fake') return c.json({ digits: Object.fromEntries(fakeDigits(asked)) });
      const read = await readDigits(
        { picture: { data: Buffer.from(picture.bytes).toString('base64'), mime: picture.mime }, cells: asked },
        {
          bin: env.brain.kind === 'claude-cli' ? env.brain.bin : 'claude',
          model: env.ahead.verifyModel,
          effort: 'low',
          timeoutMs: 60_000,
          meter: (call) => usage.record({ kind: 'ink', model: call.model, session, turn: null, login: null, inputTokens: call.usage.inputTokens, cacheReadTokens: call.usage.cacheReadTokens, cacheWriteTokens: call.usage.cacheWriteTokens, outputTokens: call.usage.outputTokens, thinkingTokens: call.usage.thinkingTokens, costUsd: call.usage.costUsd, ms: call.usage.ms }),
        },
        c.req.raw.signal,
      );
      if (read.failure !== null) throw errors.brainFailed(read.failure);
      return c.json({ digits: Object.fromEntries(read.digits) });
    }
    // What the ask says is read from the document (never from the request), so the reader is told the question and nothing more.
    const view = conductor.documentOf(session);
    const node = view === null || typeof body['node'] !== 'string' ? null : nodeOf(view.document, body['node']);
    const step = node?.body?.kind === 'lesson' ? node.body.steps.find((s) => s.kind === 'ask' && s.id === body['ask']) : undefined;
    // a question on the stage (no document): the page says which question it is, in a few words; the reader only reads, so this is never trusted for more
    const said = (key: string): string => (typeof body[key] === 'string' ? (body[key] as string).replace(/\s+/g, ' ').trim().slice(0, 160) : '');
    const question = node === null || node === undefined ? said('question') : node.title;
    const prompt = step?.kind === 'ask' ? step.prompt : node === null || node === undefined ? said('prompt') : '';
    const reading = await readInk(
      { picture: { data: Buffer.from(picture.bytes).toString('base64'), mime: picture.mime }, question, ask: prompt, accepted: step?.kind === 'ask' ? step.accepted : [] },
      {
        bin: env.brain.kind === 'claude-cli' ? env.brain.bin : 'claude',
        model: env.ahead.verifyModel,
        effort: 'low',
        timeoutMs: 60_000,
        meter: (call) => usage.record({ kind: 'ink', model: call.model, session, turn: null, login: null, inputTokens: call.usage.inputTokens, cacheReadTokens: call.usage.cacheReadTokens, cacheWriteTokens: call.usage.cacheWriteTokens, outputTokens: call.usage.outputTokens, thinkingTokens: call.usage.thinkingTokens, costUsd: call.usage.costUsd, ms: call.usage.ms }),
      },
      c.req.raw.signal,
    );
    if (reading.failure !== null) throw errors.brainFailed(reading.failure);
    // what it sees is shown only when it holds no answer the ask accepts (the reader is told not to say it, and this does not trust it)
    const accepted = step?.kind === 'ask' ? step.accepted : [];
    const sees = reading.sees !== null && !holdsAnswer(reading.sees, accepted, step?.kind === 'ask' ? step.unit : null) ? reading.sees : null;
    return c.json({ text: reading.lines.join('\n'), lines: reading.lines, unclear: reading.unclear, sees });
  });

  /**
   * Body `{ node, ask, n, text, doc }`: her strokes (an `InkDocument`) for an ask, kept with the session's document. `n` 0 is the paper as it stands
   * (rewritten as she writes, and cleared when she sends it); `n` 1, 2… is a try, with what the reader read from it in `text`. 204.
   */
  app.post(API.keepInk(':session'), async (c) => {
    const session = param(c, 'session');
    conductor.assertSession(session);
    const raw: unknown = await c.req.json().catch(() => null);
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const view = conductor.documentOf(session);
    if (view === null) throw errors.notFound(`a document for session ${session}`);
    const node = typeof body['node'] === 'string' ? body['node'].slice(0, 200) : '';
    const ask = typeof body['ask'] === 'string' ? body['ask'].slice(0, 64) : '';
    const n = typeof body['n'] === 'number' && Number.isInteger(body['n']) && body['n'] >= 0 && body['n'] < 100 ? body['n'] : -1;
    if (nodeOf(view.document, node) === null || ask === '' || n < 0) throw errors.badRequest('node, ask and n must name an ask of this document, and the try it was');
    const problem = checkInkDocument(body['doc']);
    if (problem !== null) throw errors.badRequest(`doc: ${problem}`);
    if (JSON.stringify(body['doc']).length > INK_LIMITS.bytes) throw errors.badRequest('that is more ink than a try keeps');
    const text = typeof body['text'] === 'string' ? body['text'].slice(0, 600) : '';
    await docAssets.putInk(view.summary.id, { node, ask, n, at: Date.now(), text, doc: body['doc'] as never });
    return c.body(null, 204);
  });

  /** 200 `DocumentInk[]`: every stroke kept with the document, latest of each (node, ask, n). */
  app.get(API.documentInk(':id'), async (c) => c.json(await docAssets.ink(documentId(param(c, 'id')))));

  /** The cut of the photo a question sits on (JPEG), kept with the document; 404 when none was cut. `?node=` is the question's id. */
  app.get('/api/documents/:id/crop', async (c) => {
    const node = c.req.query('node') ?? '';
    const bytes = node === '' ? null : await docAssets.crop(documentId(param(c, 'id')), node);
    // none cut yet is an answer, not an error: the page asks again, and an error here would be in every console and every gate
    if (bytes === null) return c.body(null, 204);
    c.header('content-type', 'image/jpeg');
    c.header('cache-control', 'private, max-age=86400');
    return c.body(bytes as Uint8Array<ArrayBuffer>);
  });
}
