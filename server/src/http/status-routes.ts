// The steward's account of where the product stands, for `/status` and for the brain's note about the app.

import { API } from '@conduit/language';
import type { AppStatus } from '@conduit/language';
import type { Hono } from 'hono';
import { readStatusFile } from '../domain/app-status';
import type { HttpDeps } from './deps';

export function registerStatusRoutes(app: Hono, deps: HttpDeps): void {
  /** 200 `AppStatus`. A file that is not there is an empty status, not an error: the product runs without the steward. */
  app.get(API.status, async (c) => c.json<AppStatus>(await readStatusFile(deps.env.statusFile)));
}
