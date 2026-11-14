// Dev only: the engine's own measurement of a case, for `pnpm parity` to set against the page's. Refused unless ENGINE_DEV=1.

import { ENGINE_VERSION, measureStage, scoreOfCase } from '@conduit/web/engine';
import type { EngineCase, EngineInputs, EngineView } from '@conduit/web/engine';
import type { DataTable } from '@conduit/language';
import type { Hono } from 'hono';
import { processEnvironment } from '../env';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { jsonBody } from './json';

/** What the page posts: maps cross as entry lists. */
export interface EngineMeasureRequest {
  readonly case: EngineCase;
  readonly view: EngineView;
  readonly held: EngineInputs['held'];
  readonly charts: readonly (readonly [string, DataTable])[];
  readonly pictures: readonly (readonly [string, { readonly width: number; readonly height: number }])[];
}

export function registerEngineRoutes(app: Hono, _deps: HttpDeps): void {
  app.post('/api/engine/measure', async (c) => {
    if (processEnvironment()['ENGINE_DEV'] !== '1') throw errors.forbidden('the engine route is for development only (ENGINE_DEV=1)');
    const body = (await jsonBody(c)) as EngineMeasureRequest;
    const started = performance.now();
    const score = scoreOfCase(body.case);
    const facts = measureStage(score.schedule, score.base, body.view, {
      held: body.held,
      charts: new Map(body.charts),
      pictures: new Map(body.pictures),
    });
    return c.json({ version: ENGINE_VERSION, ms: performance.now() - started, facts });
  });
}
