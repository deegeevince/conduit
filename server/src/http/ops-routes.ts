// The owner's own routes: who the server takes them to be, and what it has done in their name.

import type { Hono } from 'hono';
import { readAudit } from '../audit';
import { currentIdentity, labelOf } from '../identity';
import type { HttpDeps } from './deps';
import { errors } from '../errors';

export function registerOpsRoutes(app: Hono, deps: HttpDeps): void {
  /** 200 `{ login, name, via, label, enforced }`: who this server takes the caller to be. How the owner reads their own login, to set `OWNER_LOGINS` without guessing. */
  app.get('/api/whoami', (c) => {
    const who = currentIdentity();
    return c.json({ login: who.login, name: who.name, via: who.via, label: labelOf(who), enforced: deps.env.ownerLogins.length > 0 });
  });

  /**
   * 200 `{ entries }`, newest first: the audit trail. Query: `limit` (default 100, at most 5000), `kind`, `session`, `login`, `since` (an
   * ISO time). Like every `/api` route it is the owner's alone: with `OWNER_LOGINS` set, nobody else gets as far as here.
   */
  app.get('/api/audit', (c) => {
    const limit = c.req.query('limit');
    const count = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(count) || count < 1) throw errors.badRequest('limit must be a whole number from 1');
    const since = c.req.query('since');
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw errors.badRequest('since must be a time, like 2026-11-14T09:00:00Z');
    const pick = (name: string): string | undefined => {
      const value = c.req.query(name);
      return value === undefined || value === '' ? undefined : value;
    };
    const kind = pick('kind');
    const session = pick('session');
    const login = pick('login');
    return c.json({ entries: readAudit(deps.env.data.audit, { limit: count, ...(kind === undefined ? {} : { kind }), ...(session === undefined ? {} : { session }), ...(login === undefined ? {} : { login }), ...(since === undefined ? {} : { since: new Date(since).toISOString() }) }) });
  });
}
