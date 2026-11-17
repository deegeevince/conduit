// The only module that reads process.env. Everything else is handed an `Env`.

import { skillSettingsFrom } from './skills/catalogue';
import type { SkillSettings } from './skills/catalogue';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePromptVariant, REVIEW_POLICY } from '@conduit/language';
import { AGENT_PERMITS } from '@conduit/language';
import type { BrainMode, PromptVariant, ReviewPolicy } from '@conduit/language';
import { CHROME_GIST, NO_AGENT } from './domain/agent';
import type { AgentSettings } from './domain/agent';
import { CRITIC_POLICY } from './domain/critic';
import type { CriticPolicy } from './domain/critic';
import { ART_POLICY } from './art/studio';
import type { ArtPolicy } from './art/studio';
import { AHEAD_POLICY } from './domain/ahead';
import type { AheadPolicy } from './domain/ahead';
import type { LibrarySettings } from './domain/techniques';
import type { PictureSettings } from './domain/pictures';
import { readPictureSettings } from './pictures/registry';
import { dataPaths, resolveDataDir } from './data-dir';
import { loadPrivateHostAllowList } from './domain/destinations';
import type { DataPaths } from './data-dir';
import type { LogLevel } from './log';

/** Settings an earlier version read. Setting one now does nothing but earn a line in the start-up log. */
const REMOVED_SETTINGS = ['LIBRARY_ROOT', 'LIBRARY_REFRESH_MS', 'LIBRARY_TIMEOUT_MS', 'DATASETS', 'DATASETS_ACTOR', 'DATASETS_REFRESH_MS', 'DATASETS_TIMEOUT_MS'] as const;

/** The only tools a brain may ever hold: read-only web. Nothing else is accepted. */
export const BRAIN_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;
export type BrainTool = (typeof BRAIN_TOOL_NAMES)[number];

export type BrainSettings =
  | {
      readonly kind: 'codex-cli';
      readonly bin: string;
      readonly model: string;
      readonly effort: 'low' | 'medium' | 'high';
      readonly timeoutMs: number;
      readonly web: boolean;
      readonly variant: PromptVariant;
    }
  | { readonly kind: 'relay'; readonly idleTimeoutMs: number }
  | {
      readonly kind: 'claude-cli';
      readonly bin: string;
      readonly model: string;
      readonly firstTokenTimeoutMs: number;
      readonly idleTimeoutMs: number;
      /** the read-only web tools the brain holds (`BRAIN_TOOLS`); empty means none */
      readonly tools: readonly BrainTool[];
      /** passed to `claude --effort` and written over CLAUDE_EFFORT in the child, so the owner's shell never changes the brain. `low` keeps hidden planning short: the stage is empty while the model deliberates. */
      readonly effort: 'low' | 'medium' | 'high';
      /** how the system prompt teaches a diagram */
      readonly variant: PromptVariant;
      /** keep one process per conversation alive between turns */
      readonly warm: boolean;
      /** conversations that may hold a process at once; the least recently used beyond this goes cold */
      readonly maxWarm: number;
      /** a process nobody has asked anything for this long is stopped */
      readonly warmIdleMs: number;
      /** a process whose conversation has grown past this many input tokens is replaced by a fresh one; a paper is tens of thousands, so this leaves room for one or two beside the talk */
      readonly recycleTokens: number;
    }
  | { readonly kind: 'replay'; readonly script: string | null };

/** There is no image model: nothing here costs money, so a `paint` line leaves its sketch. The type stays so that what reads `Env.images` has one place to look. */
export type ImageSettings = { readonly kind: 'none' };

export type BrainKind = BrainSettings['kind'];
export const BRAIN_KINDS: readonly BrainKind[] = ['relay', 'claude-cli', 'codex-cli', 'replay'];

export interface Env {
  readonly production: boolean;
  readonly host: string;
  /** Extra hostnames (e.g. a Tailscale name) the API answers on, besides loopback. */
  readonly trustedHosts: readonly string[];
  /** v2.1 ops. `USAGE_HOURLY_CAP`: cost-equivalent dollars in any rolling hour at which the critic and the lessons tool stand down (they back off from 80% of it); null: no throttle. The owner's own turns are never refused. */
  readonly usageCapUsd: number | null;
  /** v2.1 ops. The Tailscale logins that may use this server (`OWNER_LOGINS`, a comma list, lower-cased); empty: nobody is refused on identity. Never committed: read from the environment. */
  readonly ownerLogins: readonly string[];
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly brain: BrainSettings;
  readonly images: ImageSettings;
  /** v2.2. Photographs for the `image` parts of a mock-up (`PICTURES=openverse`, `PICTURES_DIR`): off unless the owner switches it on; the placeholder is what there is until then */
  readonly pictures: PictureSettings;
  /** what a brain is told about how its last answer landed: the structured report, or that and a picture */
  readonly sight: 'report' | 'snapshot';
  /** which teaching of the system prompt (`PROMPT_VARIANT`); one exists */
  readonly promptVariant: PromptVariant;
  /** look and fix: whether the brain is shown its draft, how many times, and how long anything may take (`REVIEW`, `REVIEW_PASSES`, `REVIEW_*_MS`) */
  readonly review: ReviewPolicy;
  /** where techniques come from (`LIBRARY`, `LIBRARY_OVERLAY`) */
  readonly library: LibrarySettings;
  /** settings that were set but are no longer read, said once at start-up; never an error */
  readonly notes: readonly string[];
  /** absolute path of the folder session logs are written to; null when LOG_DIR=off */
  readonly logDir: string | null;
  /** v2.1 ops. The owner's data, outside the repository (`DATA_DIR`): logs, snapshots, the audit trail, the usage meter, caches, the loop's queue */
  readonly data: DataPaths;
  /** paintings a conversation may ask the image model for; 0 when there is no image model */
  readonly paintingsPerSession: number;
  /** fetch the web pages and PDFs a prompt links to (`READ_LINKS`); off leaves the brain to say it could not read them */
  readonly readLinks: boolean;
  /** absolute path of the folder that holds the exploration battery and its runs */
  readonly exploreDir: string;
  /** absolute path of the built web app; set only in production */
  readonly webDist: string | null;
  /** v2.1. The live critic (`CRITIC`, `CRITIC_MODEL`, `CRITIC_EFFORT`, `CRITIC_PER_HOUR`): on by default with the claude-cli brain, off with the others */
  readonly critic: CriticPolicy;
  /** v3 art. The studio that draws what the shelf lacks (`ART_MAKER`, `ART_PER_HOUR`): on by default with the claude-cli brain, off with the others */
  readonly art: ArtPolicy;
  /** PLAN-maths M4. Who reads the digits a pen wrote in a written method's cells (`INK_READER`): `claude` (a small Claude process; the default) or `fake`, a test rig's, which reads no picture: it answers each cell with the number of strokes sent for it */
  readonly inkReader: 'claude' | 'fake';
  /** The model that reads the digits a pen wrote (`INK_MODEL`); the verify model of the ahead policy unless set */
  readonly inkModel: string;
  /** v3 (WS5). Fill ahead and verify (`AHEAD`, `AHEAD_PARALLEL`, `AHEAD_VERIFY_MODEL`, `AHEAD_VERIFY_EFFORT`, `AHEAD_BATCH`, `AHEAD_LIMIT`): on by default with the claude-cli brain, off with the others */
  readonly ahead: AheadPolicy;
  /** v2.1. What agent mode may use (`AGENT`, `AGENT_TOOLS`, `AGENT_SERVICES`, `AGENT_DIR`, `AGENT_ANSWER_MS`, `AGENT_PERMITS=ask|auto`): off, with nothing offered, unless the owner says */
  readonly agent: AgentSettings;
  /** v2.1. The kinds of mind a session may choose (`/brain`): `plain` always; `agent` when `AGENT=on`; `steward` when `STEWARD=on` */
  readonly modes: readonly BrainMode[];
  /** The brain keeps working at will (`REFINE`): it ends an answer with `refine | what next` and the server runs it again at once, for as long as it keeps writing that. On by default with a model brain. */
  readonly refine: { readonly enabled: boolean };
  /** v2.1. Pictures with a prompt (`UPLOADS`): on by default */
  readonly uploads: boolean;
  /** v2.1. Voice notes, read on this Mac (`VOICE`, `VOICE_LOCALE`, `VOICE_KEEP`): on by default; the audio is deleted once read unless `VOICE_KEEP=on`; `VOICE_LOCALE` (like `en-US`) names the language, else the Mac's own; `VOICE_COMMAND` is the owner's own recogniser (whisper.cpp behind a script) in place of Apple's */
  readonly voice: { readonly enabled: boolean; readonly locale: string | null; readonly keep: boolean; readonly command: string | null };
  /** v2.1. Absolute path of the steward's status file (`STATUS_FILE`, default `STATUS.md` at the repository's root): what `/status` shows */
  readonly statusFile: string;
  /** v2.1. Absolute path of the changelog (`CHANGELOG_FILE`, default `CHANGELOG.md` at the repository's root): the newest section goes in the brief when the user asks what is new */
  readonly changelogFile: string;
  /** v2.1. Absolute path of the folder, outside the repository, that holds the held-out battery (`BATTERY_SEALED_DIR`); null: there is none and nothing may be called held out */
  readonly sealedDir: string | null;
  /** SK1. Where the owner's skills are read from, read only (`SKILL_ROOTS`, `SKILL_SETTINGS`): the owner's own folders unless named; tests name made-up ones */
  readonly skills: SkillSettings;
}

export class EnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`cannot start:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

type Source = Readonly<Record<string, string | undefined>>;

/** The process environment, for the few callers that must pass it on (main, the probe, the sessions tool). */
export function processEnvironment(): Source {
  return process.env;
}

/**
 * Names that select or carry a paid credential. A child process is never given one: every model call goes through the `claude` CLI on the
 * owner's login (the subscription), and a key in the owner's shell would silently turn that into a metered API call. The CLI's own
 * subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) is the login itself and is let through.
 */
const CREDENTIAL_NAMES: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /^CLAUDE_CODE_USE_/i,
  /^CLAUDE_CODE_(?:API_KEY|SKIP_.*_AUTH)/i,
  /^(?:AWS|GOOGLE|GCLOUD|GCP|AZURE|VERTEX|BEDROCK|OPENAI|OPENROUTER|GEMINI|MISTRAL|COHERE|GROQ|XAI|HF|HUGGINGFACE)_/i,
  /^CLOUD_ML_REGION$/i,
  /(?:^|_)(?:API_?KEY|TOKEN|ACCESS_KEY(?:_ID)?|SECRET(?:_KEY|_ACCESS_KEY)?|PASSWORD|PASSWD|CREDENTIALS?)$/i,
];
const CREDENTIAL_EXCEPTIONS: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * A service may describe itself in a note beside its configuration file: `<config without .json>.service.json`, `{ "gist": "...", "reads": ["tool", ...] }`.
 * `gist` is the one line `/tools` shows; `reads` names the tools that only read (a call to one runs unasked; every other call is asked for).
 * Nothing else is taken from it, and a missing or unreadable note changes nothing.
 */
function serviceNote(config: string): { gist?: string; reads?: string[] } {
  try {
    const raw: unknown = JSON.parse(readFileSync(config.replace(/\.json$/, '') + '.service.json', 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const { gist, reads } = raw as { gist?: unknown; reads?: unknown };
    return {
      ...(typeof gist === 'string' && gist.trim() !== '' ? { gist: gist.trim().slice(0, 160) } : {}),
      ...(Array.isArray(reads) ? { reads: reads.filter((name): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) } : {}),
    };
  } catch {
    return {};
  }
}

/** Whether a variable of this name is kept from every child process. Exported for the tools that print what a run will be given. */
export function isCredentialName(name: string): boolean {
  return !CREDENTIAL_EXCEPTIONS.includes(name) && CREDENTIAL_NAMES.some((pattern) => pattern.test(name));
}

/**
 * What a child process is given: the server's environment without anything that selects or carries a paid credential, with `overrides`
 * laid over it. This is the only place a child's environment is made (the brain, the judge, the critic, the loop's agents, the browser), so no key can reach any of them; an override that names a credential is dropped too.
 */
export function childEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !isCredentialName(name)) out[name] = value;
  for (const [name, value] of Object.entries(overrides)) if (!isCredentialName(name)) out[name] = value;
  return out;
}

/** The names `childEnvironment` is holding back right now, for one line in the boot log. Names only, never a value. */
export function withheldCredentialNames(): string[] {
  return Object.keys(process.env).filter((name) => process.env[name] !== undefined && isCredentialName(name)).sort();
}

/** The folder session logs go to, or null when LOG_DIR=off. Shared with the tool that reads them back. By default it is `<DATA_DIR>/logs`; `LOG_DIR` names another. */
export function resolveLogDir(source: Source): string | null {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const setting = source['LOG_DIR']?.trim();
  if (setting === 'off') return null;
  return setting === undefined || setting === '' ? dataPaths(resolveDataDir(source)).logs : resolvePath(root, setting);
}

/** The data folder's paths for this environment. The tools take this, or a `--data <dir>` flag that sets `DATA_DIR` for the run. */
export function resolveDataPaths(source: Source): DataPaths {
  return dataPaths(resolveDataDir(source));
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Reads and validates the environment. Collects every problem before
 * throwing, so one failed boot names everything that has to be fixed.
 * Only the selected brain's settings are required or even looked at.
 */
export function loadEnv(source: Source): Env {
  const problems: string[] = [];

  const text = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
      return fallback;
    }
    return value;
  };

  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const found = allowed.find((item) => item === raw);
    if (found === undefined) problems.push(`${name} must be one of ${allowed.join(' | ')}, got "${raw}"`);
    return found ?? fallback;
  };

  const required = (name: string, why: string): string => {
    const value = text(name);
    if (value === undefined) problems.push(`${name} is required ${why}`);
    return value ?? '';
  };

  const production = text('NODE_ENV') === 'production';
  const host = text('HOST') ?? '127.0.0.1';
  const trustedHosts = (text('TRUSTED_HOSTS') ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
  const ownerLogins = [...new Set((text('OWNER_LOGINS') ?? '').split(',').map((login) => login.trim().toLowerCase()).filter((login) => login !== ''))];
  const badLogin = ownerLogins.find((login) => /\s/.test(login) || login.length > 254);
  if (badLogin !== undefined) problems.push('OWNER_LOGINS is a comma list of Tailscale logins, with no spaces inside one');
  const rawCap = text('USAGE_HOURLY_CAP');
  const usageCapUsd = rawCap === undefined || rawCap === 'off' ? null : Number(rawCap);
  if (usageCapUsd !== null && !(Number.isFinite(usageCapUsd) && usageCapUsd > 0)) problems.push(`USAGE_HOURLY_CAP is dollars (cost-equivalent) per hour, more than 0, or "off"; got "${rawCap ?? ''}"`);
  const port = integer('PORT', 4300, 1, 65535);

  const rawLevel = text('LOG_LEVEL') ?? 'info';
  const logLevel = (LOG_LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevel) : 'info';
  if (logLevel !== rawLevel) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(' | ')}, got "${rawLevel}"`);

  const kind = text('BRAIN');
  let brain: BrainSettings = { kind: 'replay', script: null };
  if (kind === undefined) {
    problems.push(`BRAIN is required: one of ${BRAIN_KINDS.join(' | ')}`);
  } else if (kind === 'relay') {
    brain = { kind, idleTimeoutMs: integer('RELAY_IDLE_TIMEOUT_MS', 180_000, 1_000, 3_600_000) };
  } else if (kind === 'codex-cli') {
    brain = {
      kind,
      bin: text('CODEX_BIN') ?? 'codex',
      model: required('CODEX_MODEL', 'when BRAIN=codex-cli'),
      effort: choice('BRAIN_EFFORT', ['low', 'medium', 'high'] as const, 'low'),
      timeoutMs: integer('CODEX_TIMEOUT_MS', 180_000, 1_000, 600_000),
      web: choice('CODEX_WEB', ['on', 'off'] as const, 'on') === 'on',
      variant: parsePromptVariant(text('PROMPT_VARIANT')),
    };
  } else if (kind === 'claude-cli') {
    const rawTools = (text('BRAIN_TOOLS') ?? 'WebSearch,WebFetch').split(',').map((name) => name.trim()).filter((name) => name !== '');
    const unknown = rawTools.filter((name) => !(BRAIN_TOOL_NAMES as readonly string[]).includes(name));
    if (unknown.length > 0) problems.push(`BRAIN_TOOLS may only name ${BRAIN_TOOL_NAMES.join(' and ')}, got "${unknown.join(', ')}"`);
    const tools = [...new Set(rawTools)].filter((name): name is BrainTool => (BRAIN_TOOL_NAMES as readonly string[]).includes(name));
    brain = {
      kind,
      bin: text('CLAUDE_BIN') ?? 'claude',
      model: required('CLAUDE_MODEL', 'when BRAIN=claude-cli (for example: sonnet)'),
      tools,
      // a search takes seconds before the first word, so tools buy a longer, still bounded, wait
      firstTokenTimeoutMs: integer('CLAUDE_FIRST_TOKEN_TIMEOUT_MS', tools.length > 0 ? 120_000 : 60_000, 1_000, 600_000),
      idleTimeoutMs: integer('CLAUDE_IDLE_TIMEOUT_MS', 30_000, 1_000, 600_000),
      effort: choice('BRAIN_EFFORT', ['low', 'medium', 'high'] as const, 'low'),
      variant: parsePromptVariant(text('PROMPT_VARIANT')),
      warm: choice('CLAUDE_WARM', ['on', 'off'] as const, 'on') === 'on',
      maxWarm: integer('CLAUDE_MAX_WARM', 4, 1, 32),
      warmIdleMs: integer('CLAUDE_WARM_IDLE_MS', 600_000, 10_000, 86_400_000),
      recycleTokens: integer('CLAUDE_RECYCLE_TOKENS', 150_000, 10_000, 900_000),
    };
  } else if (kind === 'replay') {
    brain = { kind, script: text('REPLAY_SCRIPT') ?? null };
  } else {
    problems.push(`BRAIN must be one of ${BRAIN_KINDS.join(' | ')}, got "${kind}"`);
  }

  // Paid image models were removed with the OpenAI path: every model call is the `claude` CLI on the owner's login. A leftover setting is said, not ignored.
  const images: ImageSettings = { kind: 'none' };
  const imageModel = text('IMAGE_MODEL');
  if (imageModel !== undefined && imageModel !== 'none') problems.push(`IMAGE_MODEL=${imageModel} is no longer offered: there is no image model, and a \`paint\` line leaves its sketch. Remove it from .env`);

  const sight = choice('SIGHT', ['report', 'snapshot'] as const, 'snapshot');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const data = resolveDataPaths(source);
  const pictured = readPictureSettings(text, data.picturesCache);
  problems.push(...pictured.problems);
  const pictures = pictured.settings;

  const review: ReviewPolicy = {
    enabled: choice('REVIEW', ['on', 'off'] as const, 'on') === 'on',
    passes: integer('REVIEW_PASSES', REVIEW_POLICY.passes, 0, 2),
    minDrawn: REVIEW_POLICY.minDrawn,
    draftWaitMs: integer('REVIEW_DRAFT_WAIT_MS', REVIEW_POLICY.draftWaitMs, 100, 10_000),
    firstLineMs: integer('REVIEW_FIRST_LINE_MS', REVIEW_POLICY.firstLineMs, 1_000, 120_000),
    passMs: integer('REVIEW_PASS_MS', REVIEW_POLICY.passMs, 2_000, 300_000),
  };

  // The techniques in the repository, with an overlay folder laid over them when LIBRARY_OVERLAY names one.
  const seedDir = resolvePath(root, 'techniques/seed');
  const overlayDir = text('LIBRARY_OVERLAY') === undefined ? null : resolvePath(root, text('LIBRARY_OVERLAY') ?? '');
  const notes: string[] = [];
  const rawLibrary = text('LIBRARY');
  if (rawLibrary !== undefined && rawLibrary !== 'seed' && rawLibrary !== 'none') notes.push(`LIBRARY=${rawLibrary} is not a library this server has; the techniques in techniques/seed are used`);
  for (const name of REMOVED_SETTINGS) if (text(name) !== undefined) notes.push(`${name} is no longer read`);
  const library: LibrarySettings = rawLibrary === 'none' ? { kind: 'none' } : { kind: 'seed', seedDir, overlayDir };
  const logDir = resolveLogDir(source);

  // v2.1. Read here so that no package needs this file; each is used by the package the comment names (PLAN-v2.1.md).
  const withModel = brain.kind === 'claude-cli';
  // package S3
  const critic: CriticPolicy = {
    enabled: choice('CRITIC', ['on', 'off'] as const, withModel ? 'on' : 'off') === 'on' && withModel,
    model: text('CRITIC_MODEL') ?? CRITIC_POLICY.model,
    effort: choice('CRITIC_EFFORT', ['low', 'medium', 'high'] as const, CRITIC_POLICY.effort),
    perHour: integer('CRITIC_PER_HOUR', CRITIC_POLICY.perHour, 0, 10_000),
    lookMs: integer('CRITIC_LOOK_MS', CRITIC_POLICY.lookMs, 5_000, 300_000),
    queueBelow: CRITIC_POLICY.queueBelow,
  };
  // v3 art. A drawing the shelf lacks is made off the answer's clock on the owner's login. `ART_MAKER=off` is the kill switch; `fake` is a test rig's.
  const art: ArtPolicy = {
    maker: choice('ART_MAKER', ['one', 'staged', 'off', 'fake'] as const, withModel ? 'one' : 'off'),
    perHour: integer('ART_PER_HOUR', ART_POLICY.perHour, 0, 1_000),
    callMs: ART_POLICY.callMs,
    fakeMs: integer('ART_FAKE_MS', ART_POLICY.fakeMs, 0, 120_000),
    fakeStages: choice('ART_FAKE_STAGES', ['on', 'off'] as const, 'off') === 'on',
    eyesPort: integer('ART_EYES_PORT', ART_POLICY.eyesPort, 1024, 65_535),
  };
  // v3, WS5. A part written ahead takes a process of its own beside the conversation's, so at most one fewer than the warm pool holds are written at once.
  const warmRoom = brain.kind === 'claude-cli' ? Math.max(1, brain.maxWarm - 1) : 1;
  const ahead: AheadPolicy = {
    enabled: choice('AHEAD', ['on', 'off'] as const, withModel ? 'on' : 'off') === 'on' && withModel,
    parallel: Math.min(integer('AHEAD_PARALLEL', AHEAD_POLICY.parallel, 1, 6), warmRoom),
    verifyModel: text('AHEAD_VERIFY_MODEL') ?? AHEAD_POLICY.verifyModel,
    verifyEffort: choice('AHEAD_VERIFY_EFFORT', ['low', 'medium', 'high'] as const, AHEAD_POLICY.verifyEffort),
    batch: integer('AHEAD_BATCH', AHEAD_POLICY.batch, 1, 8),
    fillsPerPart: AHEAD_POLICY.fillsPerPart,
    limit: integer('AHEAD_LIMIT', AHEAD_POLICY.limit, 1, 500),
    verifyTimeoutMs: AHEAD_POLICY.verifyTimeoutMs,
  };
  // package G. Nothing is offered that is not named here; a service is `name=path/to/mcp.json`, and its file must be outside the repository.
  // On by default for the CLI brain: the brain is always the agent. Reads are free and everything else asks, so `on` costs a prompt nothing.
  const agentOn = choice('AGENT', ['on', 'off'] as const, 'on') === 'on' && withModel;
  const agentDir = text('AGENT_DIR') === undefined ? null : resolvePath(root, text('AGENT_DIR') ?? '');
  const services: AgentSettings['services'][number][] = [];
  for (const item of (text('AGENT_SERVICES') ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
    // `chrome` alone: the owner's Chrome through Claude in Chrome. It has no configuration file; the CLI brings it with `--chrome`.
    if (item === 'chrome') {
      services.push({ name: 'chrome', config: '', gist: CHROME_GIST });
      continue;
    }
    const at = item.indexOf('=');
    const name = at < 0 ? '' : item.slice(0, at).trim();
    const config = at < 0 ? '' : resolvePath(root, item.slice(at + 1).trim());
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || config === '' || !existsSync(config)) problems.push(`AGENT_SERVICES entries are name=path to an MCP configuration file that exists, got "${item}"`);
    else if (config.startsWith(root)) problems.push(`AGENT_SERVICES: "${name}" is configured from inside the repository; keep ${config} outside it, it may hold a credential`);
    else {
      const note = serviceNote(config);
      services.push({ name, config, gist: note.gist ?? 'a connected service; asks before it acts', ...(note.reads === undefined ? {} : { reads: note.reads }) });
    }
  }
  const agent: AgentSettings = agentOn
    ? {
        enabled: true,
        tools: (text('AGENT_TOOLS') ?? 'WebSearch,WebFetch').split(',').map((name) => name.trim()).filter((name) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)),
        services,
        dir: agentDir,
        answerMs: integer('AGENT_ANSWER_MS', NO_AGENT.answerMs, 5_000, 3_600_000),
        permits: choice('AGENT_PERMITS', AGENT_PERMITS, 'ask'),
        allowPrivate: loadPrivateHostAllowList(resolveDataDir(source)),
      }
    : NO_AGENT;
  // `plain` is only what a server without the agent has (AGENT=off, or a brain with no tools to give); it is never a choice beside `agent`.
  const modes: BrainMode[] = [agent.enabled ? 'agent' : 'plain', ...(withModel && choice('STEWARD', ['on', 'off'] as const, 'off') === 'on' ? (['steward'] as const) : [])];
  // package S4
  const refine = {
    enabled: choice('REFINE', ['on', 'off'] as const, withModel ? 'on' : 'off') === 'on',
  };
  const uploads = choice('UPLOADS', ['on', 'off'] as const, 'on') === 'on';
  const voiceLocale = text('VOICE_LOCALE');
  if (voiceLocale !== undefined && !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(voiceLocale)) problems.push(`VOICE_LOCALE must be a language like en-US, got "${voiceLocale}"`);
  const voice = { enabled: choice('VOICE', ['on', 'off'] as const, 'on') === 'on', locale: voiceLocale === undefined ? null : voiceLocale.replace('_', '-'), keep: choice('VOICE_KEEP', ['on', 'off'] as const, 'off') === 'on', command: text('VOICE_COMMAND') ?? null };
  const statusFile = resolvePath(root, text('STATUS_FILE') ?? 'STATUS.md');
  const changelogFile = resolvePath(root, text('CHANGELOG_FILE') ?? 'CHANGELOG.md');
  // package H. The held-out set does not live in the repository: a builder, a seed or a prompt edit cannot have read what is not there.
  const sealedDir = text('BATTERY_SEALED_DIR') === undefined ? null : resolvePath(root, text('BATTERY_SEALED_DIR') ?? '');
  if (sealedDir !== null && sealedDir.startsWith(root)) problems.push(`BATTERY_SEALED_DIR must be outside the repository, got ${sealedDir}`);
  const exploreDir = resolvePath(root, 'explore');

  let webDist: string | null = null;
  if (production) {
    webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    if (!existsSync(`${webDist}index.html`)) problems.push(`NODE_ENV=production needs the built web app at ${webDist}; run "pnpm build" first`);
  }

  if (problems.length > 0) throw new EnvError(problems);
  return { production, host, trustedHosts, ownerLogins, usageCapUsd: usageCapUsd !== null && Number.isFinite(usageCapUsd) && usageCapUsd > 0 ? usageCapUsd : null, port, logLevel, brain, images, pictures, sight, promptVariant: parsePromptVariant(text('PROMPT_VARIANT')), review, library, notes, logDir, data, readLinks: choice('READ_LINKS', ['on', 'off'] as const, 'on') === 'on', paintingsPerSession: 0, exploreDir, webDist, critic, art, inkReader: choice('INK_READER', ['claude', 'fake'] as const, 'claude'), inkModel: text('INK_MODEL') ?? ahead.verifyModel, ahead, agent, modes, refine, uploads, voice, statusFile, changelogFile, sealedDir, skills: skillSettingsFrom(text('SKILL_ROOTS'), text('SKILL_SETTINGS') === undefined ? undefined : resolvePath(root, text('SKILL_SETTINGS') ?? '')) };
}
