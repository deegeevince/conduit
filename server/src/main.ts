import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { FIX_POLICY } from '@conduit/language';
import { createBrains } from './brains/registry';
import { createCritic, createFindingQueue } from './critic/registry';
import { RelayHub } from './brains/relay/relay-hub';
import { createStatusReader } from './domain/app-status';
import { AssetStore } from './domain/assets';
import { Conductor } from './domain/conductor';
import { SessionStore } from './domain/session';
import { EnvError, loadEnv, processEnvironment, withheldCredentialNames } from './env';
import type { Env } from './env';
import { createApp } from './http/app';
import { createImageModel } from './images/registry';
import { createDatasets, createLibrary } from './library/registry';
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
  // The steward's status, for the brief's note about the app; the first read starts now so the first turn has it.
  const status = createStatusReader(env.statusFile, now);
  status();
  const brains = createBrains({ settings: env.brain, log: log.child({ part: 'brain' }), relayHub, agent: env.agent, modes: env.modes, status });
  const assets = new AssetStore();
  const images = createImageModel(env.images, log.child({ part: 'images' }));
  const sessionLog = env.logDir === null ? NO_SESSION_LOG : createJsonlSessionLog({ log: log.child({ part: 'sessionlog' }), dir: env.logDir, now });
  // The seed is in memory from here on. Remote is read in the background, now and every `refreshMs`; no turn waits for it.
  const library = createLibrary(env.library, log.child({ part: 'library' }), now);
  // Said once per outage: the warning on the first failed refresh, silence while it persists, a line when it recovers.
  let libraryDown = false;
  const refreshLibrary = (): void => {
    void library.refresh(new AbortController().signal).then((status) => {
      if (status.failure !== null) {
        if (!libraryDown) log.warn('library.unreachable', { failure: status.failure, serving: status.techniques });
        libraryDown = true;
      } else {
        if (libraryDown) log.info('library.recovered', { techniques: status.techniques });
        libraryDown = false;
        log.info('library.refreshed', { techniques: status.techniques, bySource: status.bySource });
      }
    });
  };
  if (env.library.kind === 'remote') {
    refreshLibrary();
    setInterval(refreshLibrary, env.library.refreshMs).unref();
  }
  // Read in the background, now and every `refreshMs`; a turn only ever uses the index held in memory.
  const datasets = createDatasets(env.datasets, log.child({ part: 'datasets' }));
  if (env.datasets.kind !== 'none') {
    const refreshDatasets = (): void => void datasets.refresh(new AbortController().signal).catch((error: unknown) => log.warn('datasets.refresh_failed', { error }));
    refreshDatasets();
    setInterval(refreshDatasets, env.datasets.refreshMs).unref();
  }
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
    library,
    // The owner's datasets are off unless `DATASETS` names a reader for them; `env.datasets` says which.
    datasets,
    review: env.review,
    maxPaintings: env.paintingsPerSession,
    critic: createCritic({ policy: env.critic, bin: env.brain.kind === 'claude-cli' ? env.brain.bin : 'claude', log: log.child({ part: 'critic' }), now }),
    findings: createFindingQueue(env.critic.enabled && env.logDir !== null ? fileURLToPath(new URL('../../loop/queue/', import.meta.url)) : null, log.child({ part: 'critic' })),
    fix: FIX_POLICY,
    criticQueueBelow: env.critic.queueBelow,
    modes: env.modes,
    now,
  });
  const withheld = withheldCredentialNames();
  if (withheld.length > 0) log.info('env.credentials_withheld', { names: withheld, note: 'no child process is given these; every model call is on the owner\'s login' });
  const app = createApp({ env, log: log.child({ part: 'http' }), conductor, relayHub, assets, status });

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
