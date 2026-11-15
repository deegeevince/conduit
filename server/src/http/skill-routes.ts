// SK1. The owner's skills, listed and never changed: `GET /api/skills`. It is an `/api` route, so with `OWNER_LOGINS` set it is the owner's alone.
// What it sends has no path and none of a skill's text; a person reads the description, which is one line of the skill's own frontmatter.

import type { Hono } from 'hono';
import { API } from '@conduit/language';
import type { SkillsView } from '@conduit/language';
import { summaryOf } from '../skills/catalogue';
import type { HttpDeps } from './deps';

export function registerSkillRoutes(app: Hono, deps: HttpDeps): void {
  /** 200 `SkillsView`. `?refresh=1` reads the folders again first; otherwise the list is the one built at boot, refreshed at most once a minute. */
  app.get(API.skills, async (c) => {
    const refresh = c.req.query('refresh') === '1';
    const list = await deps.skills.list(refresh);
    return c.json<SkillsView>({ skills: list.map(summaryOf) });
  });
}
