// The taste page's two routes, over the sittings in `domain/taste.ts`. Local only, like every route here.

import { API } from '@conduit/language';
import type { Hono } from 'hono';
import { TasteMissing, createTaste } from '../domain/taste';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { jsonBody } from './json';

const NAME = /^[A-Za-z0-9_-]{1,80}$/;

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw errors.badRequest(`${what} must be text of at most ${max} characters`);
  return value;
}

/**
 * - `GET API.taste`: the sitting in progress (a new one is drawn when there is none), as a `TasteState`.
 * - `POST API.taste`: a `TasteRequest`: one score, the undoing of the last, or `{ new: true }` for a fresh sitting. Replies with the new `TasteState`.
 *
 * The judge's scores are not in a `TasteState` until the sitting is done.
 */
export function registerTasteRoutes(app: Hono, deps: HttpDeps): void {
  const taste = createTaste(deps.env.exploreDir);
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TasteMissing) throw errors.notFound(error.message);
      throw error;
    }
  };

  app.get(API.taste, async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await guarded(() => taste.current()));
  });

  app.post(API.taste, async (c) => {
    const body = await jsonBody(c);
    if (typeof body !== 'object' || body === null) throw errors.badRequest('the body must be an object');
    const fields = body as Record<string, unknown>;
    c.header('Cache-Control', 'no-store');
    if (fields['new'] === true) return c.json(await guarded(() => taste.fresh()));
    const id = text(fields['id'], 'id', 80);
    if (!NAME.test(id)) throw errors.badRequest('id is not a sheet id');
    if (fields['undo'] === true) return c.json(await guarded(() => taste.undo(id)));
    const run = text(fields['run'], 'run', 80);
    const answer = text(fields['answer'], 'answer', 80);
    if (!NAME.test(run) || !NAME.test(answer)) throw errors.badRequest('run and answer must be 1 to 80 letters, digits, - or _');
    if (typeof fields['up'] !== 'boolean') throw errors.badRequest('up must be true or false');
    const word = fields['word'] === undefined ? '' : text(fields['word'], 'word', 80);
    deps.log.info('taste.score', { id, answer, up: fields['up'] });
    return c.json(await guarded(() => taste.score(id, run, answer, fields['up'] as boolean, word)));
  });
}
