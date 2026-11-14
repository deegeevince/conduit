// The document's side of the API (PLAN-v3-core WS4): the catalogue, one document, and opening one again. Each handler is one call on the
// conductor or the documents; none holds state.

import { API } from '@conduit/language';
import type { DocumentSummary, DocumentView, OpenDocumentResponse } from '@conduit/language';
import type { Hono } from 'hono';
import { nodeOf } from '@conduit/language';
import { DOCUMENT_ID } from '../domain/document';
import { readInk } from '../judge/ink';
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
    const raw: unknown = await c.req.json().catch(() => null);
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const image = typeof body['image'] === 'string' ? body['image'] : '';
    if (!/^u[1-9][0-9]{0,3}$/.test(image)) throw errors.badRequest('image must be the id the server gave the picture of the ink (u1, u2, ...)');
    const picture = await uploads.load(session, image);
    if (picture === null) throw errors.notFound(`photo ${image}`);
    // What the ask says is read from the document (never from the request), so the reader is told the question and nothing more.
    const view = conductor.documentOf(session);
    const node = view === null || typeof body['node'] !== 'string' ? null : nodeOf(view.document, body['node']);
    const step = node?.body?.kind === 'lesson' ? node.body.steps.find((s) => s.kind === 'ask' && s.id === body['ask']) : undefined;
    const question = node === null || node === undefined ? '' : node.title;
    const prompt = step?.kind === 'ask' ? step.prompt : '';
    const reading = await readInk(
      { picture: { data: Buffer.from(picture.bytes).toString('base64'), mime: picture.mime }, question, ask: prompt },
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
    return c.json({ text: reading.lines.join('\n'), lines: reading.lines, unclear: reading.unclear });
  });

  /** The cut of the photo a question sits on (JPEG), kept with the document; 404 when none was cut. `?node=` is the question's id. */
  app.get('/api/documents/:id/crop', async (c) => {
    const node = c.req.query('node') ?? '';
    const bytes = node === '' ? null : await docAssets.crop(documentId(param(c, 'id')), node);
    if (bytes === null) throw errors.notFound('crop');
    c.header('content-type', 'image/jpeg');
    c.header('cache-control', 'private, max-age=86400');
    return c.body(bytes as Uint8Array<ArrayBuffer>);
  });
}
