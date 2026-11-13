import { serve } from '@hono/node-server';
import { createBrains } from './brains/registry';
import { RelayHub } from './brains/relay/relay-hub';
import { AssetStore } from './domain/assets';
import { Conductor } from './domain/conductor';
import { SessionStore } from './domain/session';
import { EnvError, loadEnv, processEnvironment } from './env';
import type { Env } from './env';
import { createApp } from './http/app';
import { createImageModel } from './images/registry';
import { createDocumentReader } from './reading/web-reader';
import { createJsonlSessionLog } from './logs/jsonl-session-log';
import { NO_SESSION_LOG } from './domain/session-log';
import { createLogger } from './log';

const RELAY_IDLE_FALLBACK_MS = 180_000;

function boot(env: Env): void {
  const log = createLogger(env.logLevel);
  const now = (): number => Date.now();

  const relayHub = new RelayHub({
    log: log.child({ part: 'relay' }),
    now,
    idleTimeoutMs: env.brain.kind === 'relay' ? env.brain.idleTimeoutMs : RELAY_IDLE_FALLBACK_MS,
  });
  const brains = createBrains({ settings: env.brain, log: log.child({ part: 'brain' }), relayHub });
  const assets = new AssetStore();
  const images = createImageModel(env.images, log.child({ part: 'images' }));
  const sessionLog = env.logDir === null ? NO_SESSION_LOG : createJsonlSessionLog({ log: log.child({ part: 'sessionlog' }), dir: env.logDir, now });
  const conductor = new Conductor({
    sessions: new SessionStore(),
    brains,
    log: log.child({ part: 'conductor' }),
    assets,
    sessionLog,
    images,
    reader: createDocumentReader({ enabled: env.readLinks, log: log.child({ part: 'reading' }) }),
    sight: env.sight,
    variant: env.promptVariant,
    maxPaintings: env.paintingsPerSession,
    now,
  });
  const app = createApp({ env, log: log.child({ part: 'http' }), conductor, relayHub, assets });

  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    log.info('server.listening', { host: env.host, port: info.port, brain: env.brain.kind, production: env.production });
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info('server.closing', { signal });
    void conductor
      .close()
      .then(() => brains.close())
      .then(() => sessionLog.closeAll())
      .catch((error: unknown) => log.error('server.close_failed', { error }))
      .finally(() => {
        server.close(() => process.exit(0));
        if ('closeAllConnections' in server) server.closeAllConnections();
        // Open SSE streams would hold the process forever.
        setTimeout(() => process.exit(0), 1_000).unref();
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  boot(loadEnv(processEnvironment()));
} catch (error) {
  // The logger needs a valid environment, so a failed boot is the one thing written to stderr directly.
  process.stderr.write(`${error instanceof EnvError ? error.message : String(error instanceof Error ? (error.stack ?? error.message) : error)}\n`);
  process.exit(1);
}
