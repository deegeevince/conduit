import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { FIX_POLICY } from '@conduit/language';
import { ENGINE_VERSION, warmEngine } from './domain/stage-facts';
import { createBrains } from './brains/registry';
import { createCritic, createFindingQueue } from './critic/registry';
import { RelayHub } from './brains/relay/relay-hub';
import { createChangelogReader, createStatusReader } from './domain/app-status';
import { AssetStore } from './domain/assets';
import { Conductor } from './domain/conductor';
import { SessionStore } from './domain/session';
import { CanvasService } from './canvas/api';
import { EnvError, loadEnv, processEnvironment, withheldCredentialNames } from './env';
import type { Env } from './env';
import { createApp } from './http/app';
import { createSkillCatalogue } from './skills/catalogue';
import { createImageModel } from './images/registry';
import { NO_UPLOADS } from './domain/uploads';
import { createUploadStore } from './uploads/store';
import { NO_VOICE } from './domain/voice';
import { createAppleTranscriber } from './voice/helper';
import { createVoiceNotes } from './voice/store';
import { createLibrary } from './library/registry';
import { createDocumentReader } from './reading/web-reader';
import { createCatalogue } from './documents/catalogue';
import { createDocuments } from './documents/store';
import { createDocumentAssets } from './documents/assets';
import { createJsonlSessionLog } from './logs/jsonl-session-log';
import { NO_SESSION_LOG } from './domain/session-log';
import { createLogger } from './log';
import { createShelf } from './art/shelf';
import { createHeadlessLook } from './art/eyes';
import { stagedMaker } from './art/staged';
import { createStudio, fakeMaker, oneShotMaker } from './art/studio';
import type { MakerSettings } from './art/studio';
import { createPictures } from './pictures/registry';
import { createAudit } from './audit';
import { createKillSwitch } from './kill';
import { createUsageMeter } from './usage';
import { checkLessons } from './judge/lesson';
import { ensureDataDirs, extraRepos, migrateLegacyData } from './data-dir';

const RELAY_IDLE_FALLBACK_MS = 180_000;

function boot(env: Env): void {
  const log = createLogger(env.logLevel);
  const now = (): number => Date.now();

  // The owner's data is outside the repository. The first start with a data folder copies what is in the old places (never moves, never
  // deletes, never overwrites), once; every later start finds the marker and copies nothing.
  ensureDataDirs(env.data);
  const source = processEnvironment();
  for (const report of migrateLegacyData(fileURLToPath(new URL('../../', import.meta.url)), env.data, extraRepos(source), source)) {
    log.info('data.migrated', { from: report.from, to: report.to, copied: report.copied, skipped: report.skipped, failed: report.failed, note: 'copied, not moved: the originals are untouched' });
  }
  log.info('data.dir', { dir: env.data.root, logs: env.logDir });

  const audit = createAudit(env.data.audit, now, log.child({ part: 'audit' }));
  audit.record({ kind: 'server', login: 'system', tool: 'start', target: `port ${env.port}`, decision: 'done', decidedBy: 'system', note: `brain ${env.brain.kind}; agent ${env.agent.enabled ? 'on' : 'off'}; owners ${env.ownerLogins.length}` });

  const usage = createUsageMeter(env.data.usage, env.usageCapUsd, now);
  const kill = createKillSwitch(`${env.data.state}/agent-off.json`, now);
  if (kill.engaged()) log.warn('kill.still_engaged', { state: kill.state(), note: 'agent tools stay off until the owner switches them back on (/stop-all resume, or DELETE /api/kill)' });

  const relayHub = new RelayHub({
    log: log.child({ part: 'relay' }),
    now,
    idleTimeoutMs: env.brain.kind === 'relay' ? env.brain.idleTimeoutMs : RELAY_IDLE_FALLBACK_MS,
  });
  // The steward's status, for the brief's note about the app; the first read starts now so the first turn has it.
  const status = createStatusReader(env.statusFile, now);
  status();
  const news = createChangelogReader(env.changelogFile, now);
  news();
  // SA4. The canvas tools: the model's own process knocks at /mcp on this server's loopback address with a token minted for it; the relay and the
  // steward use the same handlers at /api/sessions/:session/canvas/:tool. CANVAS_TOOLS=off (dev) leaves the processes without them.
  const sessions = new SessionStore();
  const canvas = new CanvasService({ sessions, log: log.child({ part: 'canvas' }), now, wantPicture: (s, target, deadlineMs) => conductor.wantPicture(s, target, deadlineMs) });
  const canvasOn = (env.brain.kind === 'claude-cli' || env.brain.kind === 'codex-cli') && processEnvironment()['CANVAS_TOOLS'] !== 'off';
  const brains = createBrains({
    kill,
    settings: env.brain,
    log: log.child({ part: 'brain' }),
    relayHub,
    agent: env.agent,
    modes: env.modes,
    status,
    news,
    ...(canvasOn ? { canvas: { url: `http://127.0.0.1:${env.port}/mcp`, mint: (session: string) => canvas.tokens.mint(session), revoke: (token: string) => canvas.tokens.revoke(token) } } : {}),
  });
  const assets = new AssetStore();
  const images = createImageModel(env.images, log.child({ part: 'images' }));
  // v2.2. Photographs for a mock-up's `image` parts: off unless `PICTURES=openverse`. Only the words of the line ever leave the machine.
  const pictures = createPictures(env.pictures, log.child({ part: 'pictures' }));
  // v2.1. The user's photos: kept under the data folder as safe JPEGs, or not taken at all with `UPLOADS=off`.
  // v3 art. The shelf of finished drawings: the seeds in the repository, and what the data folder keeps. `draw` is answered from it.
  const art = createShelf({ seedDir: fileURLToPath(new URL('../../art/seed', import.meta.url)), cacheDir: env.data.artCache, log: log.child({ part: 'art' }) });
  log.info('art.loaded', { sheets: art.count(), subjects: art.subjects().join(',') });
  // v3 art. The studio draws what the shelf lacks, off the answer's clock, on the owner's login. Its calls are on the usage meter, and it stands down near the cap.
  const artBin = env.brain.kind === 'claude-cli' ? env.brain.bin : (processEnvironment()['CLAUDE_BIN'] ?? 'claude');
  const artSettings: MakerSettings = {
    bin: artBin,
    callMs: env.art.callMs,
    meter: (call) => usage.record({ kind: 'art', model: call.model, session: null, turn: null, login: null, inputTokens: call.usage.inputTokens, cacheReadTokens: call.usage.cacheReadTokens, cacheWriteTokens: call.usage.cacheWriteTokens, outputTokens: call.usage.outputTokens, thinkingTokens: call.usage.thinkingTokens, costUsd: call.usage.costUsd, ms: call.usage.ms }),
  };
  const oneShot = oneShotMaker(artSettings);
  const studio = createStudio({
    policy: env.art,
    shelf: art,
    maker: env.art.maker === 'fake' ? fakeMaker(env.art.fakeMs, env.art.fakeStages) : env.art.maker === 'staged' ? stagedMaker({ settings: artSettings, looker: createHeadlessLook(env.art.eyesPort), fallback: oneShot }) : oneShot,
    throttle: usage,
    log: log.child({ part: 'art' }),
    now,
  });
  log.info('art.studio', { maker: env.art.maker, perHour: env.art.perHour });
  const uploads = env.uploads ? createUploadStore({ dir: env.data.uploads, log: log.child({ part: 'uploads' }), now }) : NO_UPLOADS;
  // v2.1. Voice notes: read on this Mac by Apple's on-device recogniser (a helper built with swiftc on first use), or not taken at all with `VOICE=off`.
  const voice = env.voice.enabled
    ? createVoiceNotes({ dir: env.data.voice, transcriber: createAppleTranscriber({ cacheDir: env.data.voiceCache, workDir: `${env.data.voice}/work`, command: env.voice.command, log: log.child({ part: 'voice' }) }), locale: env.voice.locale, keep: env.voice.keep, log: log.child({ part: 'voice' }), now })
    : NO_VOICE;
  const sessionLog = env.logDir === null ? NO_SESSION_LOG : createJsonlSessionLog({ log: log.child({ part: 'sessionlog' }), dir: env.logDir, now });
  // The techniques are read from the repository, once, here; a turn only ever uses the index held in memory.
  const library = createLibrary(env.library);
  const loaded = library.status();
  log.info('library.loaded', { techniques: loaded.techniques, bySource: loaded.bySource, line: `${loaded.techniques} techniques: ${Object.entries(loaded.bySource).map(([source, count]) => `${count} ${source}`).join(', ')}` });
  for (const note of env.notes) log.warn('env.setting_ignored', { note });
  // v3. The documents conversations make, and the catalogue of them in the data folder (an index over the session logs, rebuilt from them when it is behind).
  const docAssets = createDocumentAssets({ dir: env.data.documents, log: log.child({ part: 'documents' }) });
  const documents = createDocuments({ catalogue: createCatalogue({ dir: env.data.documents, logs: env.logDir, log: log.child({ part: 'documents' }), now }), log: log.child({ part: 'documents' }), now });
  // SK1. The owner's skills, read only; the list is built in the background and a turn never waits for it unless it holds a skill.
  const skills = createSkillCatalogue(env.skills, log.child({ part: 'skills' }), now);
  skills.warm();
  const conductor = new Conductor({
    ...(env.brain.kind === 'codex-cli' ? {} : { skills }),
    sessions,
    canvas,
    canvasTools: canvasOn,
    brains,
    log: log.child({ part: 'conductor' }),
    assets,
    sessionLog,
    images,
    pictures,
    art,
    studio,
    uploads,
    voice,
    reader: createDocumentReader({ enabled: env.readLinks, log: log.child({ part: 'reading' }) }),
    sight: env.sight,
    variant: env.promptVariant,
    library,
    review: env.review,
    maxPaintings: env.paintingsPerSession,
    critic: createCritic({ policy: env.critic, bin: env.brain.kind === 'claude-cli' ? env.brain.bin : 'claude', log: log.child({ part: 'critic' }), now, meter: usage, throttle: usage }),
    findings: createFindingQueue(env.critic.enabled && env.logDir !== null ? env.data.queue : null, log.child({ part: 'critic' })),
    fix: FIX_POLICY,
    continuation: env.refine.enabled,
    criticQueueBelow: env.critic.queueBelow,
    modes: env.modes,
    audit,
    usage,
    documents,
    docAssets,
    ahead: {
      policy: env.ahead,
      // The second check of what is written ahead: a cheap model, asked cold, through the judge's own process; its calls are on the meter.
      check: (session, pages, signal) =>
        checkLessons(
          { pages },
          {
            bin: env.brain.kind === 'claude-cli' ? env.brain.bin : 'claude',
            model: env.ahead.verifyModel,
            effort: env.ahead.verifyEffort,
            timeoutMs: env.ahead.verifyTimeoutMs,
            meter: (call) => usage.record({ kind: 'verify', model: call.model, session, turn: null, login: null, inputTokens: call.usage.inputTokens, cacheReadTokens: call.usage.cacheReadTokens, cacheWriteTokens: call.usage.cacheWriteTokens, outputTokens: call.usage.outputTokens, thinkingTokens: call.usage.thinkingTokens, costUsd: call.usage.costUsd, ms: call.usage.ms }),
          },
          signal,
        ),
    },
    now,
  });
  const withheld = withheldCredentialNames();
  if (withheld.length > 0) log.info('env.credentials_withheld', { names: withheld, note: 'no child process is given these; every model call is on the owner\'s login' });
  const app = createApp({ env, log: log.child({ part: 'http' }), conductor, canvas, relayHub, audit, kill, usage, assets, docAssets, pictures, uploads, voice, status, news, skills });

  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    setImmediate(() => log.info('engine.warm', { ms: Math.round(warmEngine()), version: ENGINE_VERSION }));
    log.info('server.listening', { host: env.host, port: info.port, brain: env.brain.kind, production: env.production, owners: env.ownerLogins.length, usageCapUsd: env.usageCapUsd });
    if (env.ownerLogins.length === 0 && env.trustedHosts.length > 0) {
      log.warn('identity.not_enforced', { note: 'OWNER_LOGINS is not set: anyone on the tailnet who can reach this server may use it. Set it to the owner\'s Tailscale login (GET /api/whoami shows what the server sees).' });
    }
  });

  // An error nobody caught is logged, written to the audit trail and survived: one conversation's bug does not end every conversation. A
  // process that does this over and over is not healthy, though: past `CRASH_LIMIT` in a minute it exits and lets launchd start it afresh.
  const faults: number[] = [];
  const CRASH_LIMIT = 10;
  const survive = (kind: 'unhandled_rejection' | 'uncaught_exception') => (error: unknown): void => {
    const at = now();
    faults.push(at);
    while (faults.length > 0 && (faults[0] ?? 0) < at - 60_000) faults.shift();
    try {
      log.error(`process.${kind}`, { error, faultsInLastMinute: faults.length });
      audit.record({ kind: 'server', login: 'system', tool: kind, target: error instanceof Error ? error.message : String(error), decision: 'failed', decidedBy: 'system', note: 'the server kept serving' });
    } catch {
      // nothing left to say it with
    }
    if (faults.length >= CRASH_LIMIT) {
      process.stderr.write(`conduit: ${faults.length} unhandled errors in a minute; exiting so the service manager can start a fresh process\n`);
      process.exit(1);
    }
  };
  process.on('unhandledRejection', survive('unhandled_rejection'));
  process.on('uncaughtException', survive('uncaught_exception'));

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info('server.closing', { signal });
    // Whatever a child or a stream does, the process is gone within this: a shutdown that waits for a stuck one is a server that cannot be restarted.
    setTimeout(() => process.exit(0), 6_000).unref();
    void conductor
      .close()
      .then(() => brains.close())
      .then(() => documents.close())
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
