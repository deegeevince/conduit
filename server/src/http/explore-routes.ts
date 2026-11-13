// Read-only access to the exploration runs on disk, for the review page.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { API } from '@conduit/language';
import type { ExploreRun } from '@conduit/language';
import type { Hono } from 'hono';
import { errors } from '../errors';
import type { HttpDeps } from './deps';
import { param } from './json';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

function named(value: string, what: string): string {
  if (!NAME.test(value)) throw errors.badRequest(`${what} must be 1 to 64 letters, digits, - or _`);
  return value;
}

/** The parsed JSON of a file, or null when it is missing or is not JSON. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * - `GET API.exploreRuns`: `ExploreRun[]`, newest first, read from
 *   `<exploreDir>/runs/<run>/index.json`. An empty array when there are none.
 * - `GET API.exploreRun(run)`: that run's `ExploreRun`.
 * - `GET API.exploreResult(run, prompt)`: that prompt's `ExploreResult`.
 *
 * `run` and `prompt` must match `[A-Za-z0-9_-]{1,64}`; anything else is 400,
 * so no request can name a path. Unknown ones are 404.
 */
export function registerExploreRoutes(app: Hono, deps: HttpDeps): void {
  const runs = join(deps.env.exploreDir, 'runs');

  app.get(API.exploreRuns, async (c) => {
    const names = await readdir(runs).catch(() => [] as string[]);
    const found = await Promise.all(names.filter((name) => NAME.test(name)).map((name) => readJson(join(runs, name, 'index.json'))));
    const index = found.filter((item): item is ExploreRun => typeof item === 'object' && item !== null && 'id' in item && 'prompts' in item);
    index.sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
    c.header('Cache-Control', 'no-store');
    return c.json(index);
  });

  app.get(API.exploreRun(':run'), async (c) => {
    const run = named(param(c, 'run'), 'run');
    const index = await readJson(join(runs, run, 'index.json'));
    if (index === null) throw errors.notFound(`run ${run}`);
    c.header('Cache-Control', 'no-store');
    return c.json(index);
  });

  app.get(API.exploreResult(':run', ':prompt'), async (c) => {
    const run = named(param(c, 'run'), 'run');
    const prompt = named(param(c, 'prompt'), 'prompt');
    // index.json is the run's own index, not a prompt's result.
    const result = prompt === 'index' ? null : await readJson(join(runs, run, `${prompt}.json`));
    if (result === null) throw errors.notFound(`result ${prompt} of run ${run}`);
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
}
