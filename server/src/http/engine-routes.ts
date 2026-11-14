// Dev only: the engine's own measurement of a case, for `pnpm parity` to set against the page's. Refused unless ENGINE_DEV=1.

import { ENGINE_VERSION, measureStage, scoreOfCase, wallNodesOfTurns } from '@conduit/web/engine';
import type { EngineCase, EngineInputs, EngineView, WallNode, WallPlan, WallShape, WallTurn } from '@conduit/web/engine';
import type { DataTable } from '@conduit/language';
import type { Hono } from 'hono';
import { processEnvironment } from '../env';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { wallAt } from '../domain/stage-facts';
import { jsonBody } from './json';

/** What the page posts: maps cross as entry lists. */
export interface EngineMeasureRequest {
  readonly case: EngineCase;
  readonly view: EngineView;
  readonly held: EngineInputs['held'];
  readonly charts: readonly (readonly [string, DataTable])[];
  readonly pictures: readonly (readonly [string, { readonly width: number; readonly height: number }])[];
}

/** What the page posts to be planned: a list of nodes as made, or turns (the server makes the nodes itself, as the page does). */
export interface EngineWallCase {
  readonly id: string;
  readonly shape: WallShape;
  readonly nodes?: readonly WallNode[];
  readonly turns?: readonly WallTurn[];
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

  app.post('/api/engine/wall', async (c) => {
    if (processEnvironment()['ENGINE_DEV'] !== '1') throw errors.forbidden('the engine route is for development only (ENGINE_DEV=1)');
    const body = (await jsonBody(c)) as { readonly cases: readonly EngineWallCase[] };
    const plans: { id: string; plan: WallPlan; nodes: number }[] = [];
    for (const item of body.cases) {
      const nodes = item.nodes ?? wallNodesOfTurns(item.turns ?? []);
      // one view key a shape, and the revision is the case's own id: nothing here is reused between cases
      plans.push({ id: item.id, plan: wallAt(item.id, `${item.shape.axis}:${item.shape.cell.width}x${item.shape.cell.height}:${item.shape.gap}`, nodes, item.shape), nodes: nodes.length });
    }
    return c.json({ version: ENGINE_VERSION, plans });
  });
}
