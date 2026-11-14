// The document's side of the API (PLAN-v3-core WS4): the catalogue, one document, and opening one again. Each handler is one call on the
// conductor or the documents; none holds state.

import { API } from '@conduit/language';
import type { DocumentSummary, DocumentView, OpenDocumentResponse } from '@conduit/language';
import type { Hono } from 'hono';
import { DOCUMENT_ID } from '../domain/document';
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
  const { conductor } = deps;

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
}
