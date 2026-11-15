import { API, LANGUAGE } from '@conduit/language';
import type { HealthResponse } from '@conduit/language';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import { ASSET_LIMITS } from '../domain/assets';
import { identify, runAs } from '../identity';
import { SERVER_LIMITS } from '../domain/session';
import { AppError, errors, toErrorBody } from '../errors';
import { UPLOAD_LIMITS, VOICE_LIMITS } from '@conduit/language';
import { registerCanvasRoutes } from './canvas-routes';
import { registerAssetRoutes } from './asset-routes';
import { registerConversationRoutes } from './conversation-routes';
import { registerUploadRoutes } from './upload-routes';
import { registerDocumentRoutes } from './document-routes';
import { registerVoiceRoutes } from './voice-routes';
import type { HttpDeps } from './deps';
import { registerEngineRoutes } from './engine-routes';
import { registerExploreRoutes } from './explore-routes';
import { registerRelayRoutes } from './relay-routes';
import { registerTasteRoutes } from './taste-routes';
import { registerSessionRoutes } from './session-routes';
import { registerStatic } from './static';
import { registerSkillRoutes } from './skill-routes';
import { registerOpsRoutes } from './ops-routes';
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

  // Who is asking is settled before anything else: a request that is not the owner's does not get as far as the Host and Origin checks.
  const owners: ReadonlySet<string> = new Set(deps.env.ownerLogins);
  app.use('/api/*', async (c, next) => {
    const verdict = identify((name) => c.req.header(name), getConnInfo(c).remote.address, owners);
    if (!verdict.ok) {
      deps.log.warn('http.refused_identity', { path: c.req.path, method: c.req.method, why: verdict.why, refusal: verdict.refusal, login: verdict.identity.login });
      deps.audit.record({ kind: 'refused', login: verdict.identity.login ?? 'unknown', tool: `${c.req.method} ${c.req.path}`, decision: 'denied', decidedBy: 'policy', note: verdict.why });
      throw errors.forbidden('this server answers only its owner');
    }
    return runAs(verdict.identity, next);
  });
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
  const withFilm = limited(ASSET_LIMITS.filmBytes);
  const withPhoto = limited(UPLOAD_LIMITS.bytes);
  const withVoice = limited(VOICE_LIMITS.bytes);
  // Only the two session POSTs that can carry a report get the larger limit, and only the two uploads a picture's.
  const carriesReport = /^\/api\/(?:sessions\/[^/]+\/(?:events|turns)|engine\/measure)$/;
  const carriesPicture = /^\/api\/sessions\/[^/]+\/(?:sketches\/[^/]+|looks\/[^/]+|turns\/[^/]+\/(?:snapshot|drafts\/\d+))$/;
  app.use('/api/*', (c, next) => {
    if (c.req.method !== 'POST') return ordinary(c, next);
    if (carriesReport.test(c.req.path)) return withReport(c, next);
    if (/^\/api\/sessions\/[^/]+\/turns\/[^/]+\/capture$/.test(c.req.path)) return withFilm(c, next);
    if (/^\/api\/sessions\/[^/]+\/uploads$/.test(c.req.path)) return withPhoto(c, next);
    if (/^\/api\/sessions\/[^/]+\/voice$/.test(c.req.path)) return withVoice(c, next);
    return carriesPicture.test(c.req.path) ? withPicture(c, next) : ordinary(c, next);
  });

  // The model's own door, outside `/api` and its identity check: it has a token of its own (`canvas-routes.ts`).
  registerCanvasRoutes(app, deps);
  app.get(API.health, (c) => c.json<HealthResponse>({ ok: true, language: LANGUAGE.version, brain: deps.env.brain.kind }));
  registerSessionRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  registerAssetRoutes(app, deps);
  registerUploadRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerVoiceRoutes(app, deps);
  registerStatusRoutes(app, deps);
  registerOpsRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerExploreRoutes(app, deps);
  registerEngineRoutes(app, deps);
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
