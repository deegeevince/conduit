import { API, LANGUAGE } from '@conduit/language';
import type { HealthResponse } from '@conduit/language';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ASSET_LIMITS } from '../domain/assets';
import { SERVER_LIMITS } from '../domain/session';
import { AppError, errors, toErrorBody } from '../errors';
import { registerAssetRoutes } from './asset-routes';
import type { HttpDeps } from './deps';
import { registerExploreRoutes } from './explore-routes';
import { registerRelayRoutes } from './relay-routes';
import { registerTasteRoutes } from './taste-routes';
import { registerSessionRoutes } from './session-routes';
import { registerStatic } from './static';
import { registerStatusRoutes } from './status-routes';

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
}

// The server binds to loopback, but a web page in the user's browser can still
// reach loopback. The Host check stops DNS rebinding. Any Origin that is not
// loopback stops another site from posting to the API, and that includes
// `null` (a sandboxed frame, a file: page, a data: URL), which is not a URL.
// Sec-Fetch-Site: cross-site catches the requests that carry no Origin at all,
// such as a GET from an image tag. A request with neither header (curl) is the user's own.
const localOnly = (trusted: readonly string[]): MiddlewareHandler => {
  const allowed = new Set([...LOCAL_HOSTS, ...trusted]);
  return async (c, next) => {
  const host = c.req.header('host') ?? '';
  if (!allowed.has(hostnameOf(host).toLowerCase())) throw errors.forbidden('this server only answers on localhost');
  const origin = c.req.header('origin');
  if (origin !== undefined && !(URL.canParse(origin) && allowed.has(hostnameOf(new URL(origin).host).toLowerCase()))) {
    throw errors.forbidden('cross-origin requests are not allowed');
  }
  if (c.req.header('sec-fetch-site') === 'cross-site') throw errors.forbidden('cross-site requests are not allowed');
  await next();
  };
};

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono();

  app.use('/api/*', localOnly(deps.env.trustedHosts));
  const limited = (maxSize: number): MiddlewareHandler =>
    bodyLimit({
      maxSize,
      onError: () => {
        throw errors.tooLarge(maxSize);
      },
    });
  const ordinary = limited(SERVER_LIMITS.bodyBytes);
  const withReport = limited(SERVER_LIMITS.reportBytes);
  const withPicture = limited(ASSET_LIMITS.uploadBytes);
  // Only the two session POSTs that can carry a report get the larger limit, and only the two uploads a picture's.
  const carriesReport = /^\/api\/sessions\/[^/]+\/(?:events|turns)$/;
  const carriesPicture = /^\/api\/sessions\/[^/]+\/(?:sketches\/[^/]+|turns\/[^/]+\/(?:snapshot|drafts\/\d+))$/;
  app.use('/api/*', (c, next) => {
    if (c.req.method !== 'POST') return ordinary(c, next);
    if (carriesReport.test(c.req.path)) return withReport(c, next);
    return carriesPicture.test(c.req.path) ? withPicture(c, next) : ordinary(c, next);
  });

  app.get(API.health, (c) => c.json<HealthResponse>({ ok: true, language: LANGUAGE.version, brain: deps.env.brain.kind }));
  registerSessionRoutes(app, deps);
  registerAssetRoutes(app, deps);
  registerStatusRoutes(app, deps);
  registerExploreRoutes(app, deps);
  registerTasteRoutes(app, deps);
  registerRelayRoutes(app, deps);
  app.all('/api/*', (c) => {
    throw errors.notFound(`${c.req.method} ${c.req.path}`);
  });
  if (deps.env.webDist !== null) registerStatic(app, deps.env.webDist);

  app.notFound((c) => c.json(toErrorBody(errors.notFound(c.req.path)), 404));
  app.onError((error, c) => {
    const body = toErrorBody(error);
    if (!(error instanceof AppError)) deps.log.error('http.unhandled', { method: c.req.method, path: c.req.path, error });
    else if (body.statusCode >= 500) deps.log.warn('http.failed', { method: c.req.method, path: c.req.path, code: body.code, message: body.message });
    return c.json(body, body.statusCode as ContentfulStatusCode);
  });

  return app;
}
