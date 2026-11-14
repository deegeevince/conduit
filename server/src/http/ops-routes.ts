// The owner's own routes: who the server takes them to be, and what it has done in their name.

import type { Hono } from 'hono';
import { readAudit } from '../audit';
import { readUsage, summarizeUsage } from '../usage';
import { killAllChildren } from '../brains/claude-cli/process';
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
   * 200 `UsageSummary`: what the server's model calls have used. `hours` is the last `hours` hours (default 48, at most 720), zero-filled,
   * oldest first and ending with this one; `days` the last `days` days (default 14, at most 365). Each bucket has the calls, the tokens,
   * the cost-equivalent in dollars (what the same tokens would have cost on the API: every call is on the owner's login), the time the
   * calls took, and the split by kind (turn, review, critic, compare, lessons) and by model. `throttle` says where the last hour
   * stands against `USAGE_HOURLY_CAP`.
   */
  app.get('/api/usage', (c) => {
    const whole = (name: string, fallback: number, max: number): number => {
      const raw = c.req.query(name);
      if (raw === undefined || raw === '') return fallback;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > max) throw errors.badRequest(`${name} must be a whole number from 1 to ${max}`);
      return value;
    };
    const hours = whole('hours', 48, 720);
    const days = whole('days', 14, 365);
    const now = Date.now();
    return c.json(summarizeUsage(readUsage(deps.env.data.usage, now - (Math.max(days, Math.ceil(hours / 24)) + 1) * 86_400_000), deps.usage, now, hours, days));
  });

  /**
   * POST: the kill switch. Answers within a few seconds whatever state any child is in. It
   *   1. switches agent tools off, and remembers it across a restart (`DELETE` below switches them back on);
   *   2. ends every open turn (`interrupted`) and answers no to every confirm control waiting for the owner;
   *   3. lets go of every brain process and abandons the critic's looks in flight;
   *   4. SIGKILLs every child process this server started and everything below them, without waiting for any of them to agree.
   * 200 `{ engaged, at, sessions, turns, permissionsDenied, children, descendants, survivors, browserTabsLeftOpen, answeredInMs }`; `survivors` are pids that were
   * still there after the wait (a process stuck in the kernel), and is empty when everything is gone.
   */
  app.post('/api/kill', async (c) => {
    const started = Date.now();
    const by = labelOf(currentIdentity());
    const state = deps.kill.engage(by, 'the owner pulled the kill switch');
    deps.audit.record({ kind: 'kill', tool: 'kill-switch', target: 'stop everything; agent tools off', decision: 'allowed', decidedBy: 'owner' });
    deps.log.warn('kill.requested', { by });
    const done = (async () => {
      const stopped = deps.conductor.killAll(by);
      const killed = await killAllChildren();
      return { stopped, killed };
    })();
    // Never longer than this, whatever a child is doing: the answer is the owner's proof the switch worked.
    const outcome = await Promise.race([done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000).unref())]);
    const stopped = outcome?.stopped ?? { sessions: 0, turns: 0, permissions: 0, browserTabs: 0 };
    const killed = outcome?.killed ?? { children: 0, descendants: 0, survivors: [] as number[], ms: Date.now() - started };
    deps.audit.record({ kind: 'kill', tool: 'kill-switch', target: `${stopped.turns} turns ended, ${stopped.permissions} permissions denied, ${killed.children + killed.descendants} processes killed`, decision: killed.survivors.length === 0 ? 'done' : 'failed', decidedBy: 'system', note: [killed.survivors.length === 0 ? '' : `${killed.survivors.length} process(es) survived SIGKILL`, stopped.browserTabs === 0 ? '' : `${stopped.browserTabs} browser tab(s) the brain opened are still open in Chrome`].filter((part) => part !== '').join('; ') || undefined });
    return c.json({ engaged: true, at: state.at, sessions: stopped.sessions, turns: stopped.turns, permissionsDenied: stopped.permissions, children: killed.children, descendants: killed.descendants, survivors: killed.survivors, browserTabsLeftOpen: stopped.browserTabs, answeredInMs: Date.now() - started, timedOut: outcome === null });
  });

  /** GET `{ engaged, at, by, reason }`: whether agent tools are off. */
  app.get('/api/kill', (c) => {
    const state = deps.kill.state();
    return c.json({ engaged: state !== null, ...(state ?? {}) });
  });

  /** DELETE: switches agent tools back on (what `AGENT=on` configured), and nothing else: what was stopped stays stopped. 200 `{ engaged: false, was }`. */
  app.delete('/api/kill', (c) => {
    const was = deps.kill.release();
    deps.audit.record({ kind: 'kill', tool: 'kill-switch', target: 'agent tools switched back on', decision: 'allowed', decidedBy: 'owner' });
    deps.log.warn('kill.released', { by: labelOf(currentIdentity()), was });
    return c.json({ engaged: false, was });
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
