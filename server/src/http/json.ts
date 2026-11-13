import type { Context } from 'hono';
import { errors } from '../errors';

function mediaType(c: Context): string {
  return (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The request body as JSON; anything unparseable is a 400. The Content-Type
 * must say JSON: a page on another site can send text/plain or a form without
 * a preflight, so a route that insists on JSON is one that page cannot reach.
 */
export async function jsonBody(c: Context): Promise<unknown> {
  const type = mediaType(c);
  if (type !== 'application/json' && !type.endsWith('+json')) throw errors.unsupportedMedia('application/json');
  try {
    return JSON.parse(await c.req.text());
  } catch {
    throw errors.badRequest('the body must be valid JSON');
  }
}

/** The request body as text; the Content-Type must be text/plain (curl needs `-H 'content-type: text/plain'`). */
export async function textBody(c: Context): Promise<string> {
  if (mediaType(c) !== 'text/plain') throw errors.unsupportedMedia("text/plain (with curl: -H 'content-type: text/plain')");
  return c.req.text();
}

/** A query value in seconds, as milliseconds, within [0, maxMs]. */
export function waitMs(raw: string | undefined, fallbackSeconds: number, maxMs: number): number {
  if (raw === undefined || raw === '') return Math.min(fallbackSeconds * 1000, maxMs);
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) throw errors.badRequest('wait must be a number of seconds, 0 or more');
  return Math.min(seconds * 1000, maxMs);
}

/** A path parameter; routes are registered with it, so a missing one is a bad request rather than a crash. */
export function param(c: Context, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === '') throw errors.badRequest(`missing ${name}`);
  return value;
}
