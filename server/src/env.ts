// The only module that reads process.env. Everything else is handed an `Env`.

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePromptVariant, REVIEW_POLICY } from '@conduit/language';
import type { PromptVariant, ReviewPolicy } from '@conduit/language';
import type { DatasetSettings } from './domain/datasets';
import type { LibrarySettings } from './domain/techniques';
import type { LogLevel } from './log';

/** The Conduit root block on the Series account: every technique hangs off it. */
export const CONDUIT_ROOT_BLOCK = '00000000-0000-4000-8000-000000000000';

/** The only tools a brain may ever hold: read-only web. Nothing else is accepted. */
export const BRAIN_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;
export type BrainTool = (typeof BRAIN_TOOL_NAMES)[number];

export type BrainSettings =
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

export type ImageSettings =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'openai';
      readonly apiKey: string;
      readonly model: string;
      readonly quality: 'low' | 'medium' | 'high';
      readonly timeoutMs: number;
      readonly baseUrl: string;
      /** paintings a conversation may ask for; the rest are skipped */
      readonly maxPerSession: number;
    };

export const IMAGE_KINDS: readonly ImageSettings['kind'][] = ['none', 'openai'];

export type BrainKind = BrainSettings['kind'];
export const BRAIN_KINDS: readonly BrainKind[] = ['relay', 'claude-cli', 'replay'];

export interface Env {
  readonly production: boolean;
  readonly host: string;
  /** Extra hostnames (e.g. a Tailscale name) the API answers on, besides loopback. */
  readonly trustedHosts: readonly string[];
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly brain: BrainSettings;
  readonly images: ImageSettings;
  /** what a brain is told about how its last answer landed: the structured report, or that and a picture */
  readonly sight: 'report' | 'snapshot';
  /** which teaching of the system prompt (`PROMPT_VARIANT`); one exists */
  readonly promptVariant: PromptVariant;
  /** look and fix: whether the brain is shown its draft, how many times, and how long anything may take (`REVIEW`, `REVIEW_PASSES`, `REVIEW_*_MS`) */
  readonly review: ReviewPolicy;
  /** where techniques come from (`LIBRARY`, `REMOTE_*`, `LIBRARY_*`) */
  readonly library: LibrarySettings;
  /** whether the owner's own datasets may be read for a chart (`DATASETS`, `DATASETS_*`); off unless asked for */
  readonly datasets: DatasetSettings;
  /** absolute path of the folder session logs are written to; null when LOG_DIR=off */
  readonly logDir: string | null;
  /** paintings a conversation may ask the image model for; 0 when there is no image model */
  readonly paintingsPerSession: number;
  /** fetch the web pages and PDFs a prompt links to (`READ_LINKS`); off leaves the brain to say it could not read them */
  readonly readLinks: boolean;
  /** absolute path of the folder that holds the exploration battery and its runs */
  readonly exploreDir: string;
  /** absolute path of the built web app; set only in production */
  readonly webDist: string | null;
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
  /(?:^|_)(?:API_?KEY|AUTH_TOKEN|ACCESS_KEY(?:_ID)?|SECRET(?:_KEY|_ACCESS_KEY)?|PASSWORD|BEARER_TOKEN)$/i,
];
const CREDENTIAL_EXCEPTIONS: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN'];

/** Whether a variable of this name is kept from every child process. Exported for the tools that print what a run will be given. */
export function isCredentialName(name: string): boolean {
  return !CREDENTIAL_EXCEPTIONS.includes(name) && CREDENTIAL_NAMES.some((pattern) => pattern.test(name));
}

/**
 * What a child process is given: the server's environment without anything that selects or carries a paid credential, with `overrides`
 * laid over it. This is the only place a child's environment is made (the brain, the judge, the critic, the loop's agents, the browser,
 * the Remote CLI), so no key can reach any of them; an override that names a credential is dropped too.
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

/** The folder session logs go to, or null when LOG_DIR=off. Shared with the tool that reads them back. */
export function resolveLogDir(source: Source): string | null {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const setting = source['LOG_DIR']?.trim();
  if (setting === 'off') return null;
  return resolvePath(root, setting === undefined || setting === '' ? 'logs' : setting);
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

  // Only the selected image model's settings are required or read, exactly as with brains.
  let images: ImageSettings = { kind: 'none' };
  if (choice('IMAGE_MODEL', IMAGE_KINDS, 'none') === 'openai') {
    images = {
      kind: 'openai',
      apiKey: required('OPENAI_API_KEY', 'when IMAGE_MODEL=openai'),
      model: text('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1',
      quality: choice('IMAGE_QUALITY', ['low', 'medium', 'high'] as const, 'low'),
      timeoutMs: integer('IMAGE_TIMEOUT_MS', 90_000, 5_000, 600_000),
      baseUrl: text('OPENAI_BASE_URL') ?? 'https://api.openai.com',
      maxPerSession: integer('IMAGE_MAX_PER_SESSION', 12, 1, 500),
    };
  }

  const sight = choice('SIGHT', ['report', 'snapshot'] as const, 'snapshot');
  const root = fileURLToPath(new URL('../../', import.meta.url));

  const review: ReviewPolicy = {
    enabled: choice('REVIEW', ['on', 'off'] as const, 'on') === 'on',
    passes: integer('REVIEW_PASSES', REVIEW_POLICY.passes, 0, 2),
    minDrawn: REVIEW_POLICY.minDrawn,
    draftWaitMs: integer('REVIEW_DRAFT_WAIT_MS', REVIEW_POLICY.draftWaitMs, 100, 10_000),
    firstLineMs: integer('REVIEW_FIRST_LINE_MS', REVIEW_POLICY.firstLineMs, 1_000, 120_000),
    passMs: integer('REVIEW_PASS_MS', REVIEW_POLICY.passMs, 2_000, 300_000),
  };

  // Only the selected library's settings are read, exactly as with brains. The seed in the repository is under all of them.
  const seedDir = resolvePath(root, 'techniques/seed');
  const overlayDir = text('LIBRARY_OVERLAY') === undefined ? null : resolvePath(root, text('LIBRARY_OVERLAY') ?? '');
  const libraryKind = choice('LIBRARY', ['remote', 'seed', 'none'] as const, 'remote');
  let library: LibrarySettings = { kind: 'none' };
  if (libraryKind === 'seed') library = { kind: 'seed', seedDir, overlayDir };
  else if (libraryKind === 'remote') {
    library = {
      kind: 'remote',
      bin: text('REMOTE_BIN') ?? 'remote',
      actor: text('REMOTE_ACTOR') ?? 'series@example.invalid',
      env: choice('REMOTE_ENV', ['prod', 'local'] as const, 'prod'),
      root: text('LIBRARY_ROOT') ?? CONDUIT_ROOT_BLOCK,
      seedDir,
      cacheDir: resolvePath(root, 'techniques/.cache'),
      overlayDir,
      refreshMs: integer('LIBRARY_REFRESH_MS', 600_000, 10_000, 86_400_000),
      timeoutMs: integer('LIBRARY_TIMEOUT_MS', 8_000, 500, 60_000),
    };
  }
  const logDir = resolveLogDir(source);
  const exploreDir = resolvePath(root, 'explore');

  // The owner's own data: read only when switched on, and never from the account the techniques live on.
  const datasets: DatasetSettings =
    choice('DATASETS', ['none', 'remote'] as const, 'none') === 'remote'
      ? {
          kind: 'remote',
          bin: text('REMOTE_BIN') ?? 'remote',
          actor: text('DATASETS_ACTOR') ?? null,
          env: choice('REMOTE_ENV', ['prod', 'local'] as const, 'prod'),
          timeoutMs: integer('DATASETS_TIMEOUT_MS', 4_000, 500, 30_000),
          refreshMs: integer('DATASETS_REFRESH_MS', 900_000, 10_000, 86_400_000),
        }
      : { kind: 'none' };

  let webDist: string | null = null;
  if (production) {
    webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    if (!existsSync(`${webDist}index.html`)) problems.push(`NODE_ENV=production needs the built web app at ${webDist}; run "pnpm build" first`);
  }

  if (problems.length > 0) throw new EnvError(problems);
  return { production, host, trustedHosts, port, logLevel, brain, images, sight, promptVariant: parsePromptVariant(text('PROMPT_VARIANT')), review, library, datasets, logDir, readLinks: choice('READ_LINKS', ['on', 'off'] as const, 'on') === 'on', paintingsPerSession: images.kind === 'none' ? 0 : images.maxPerSession, exploreDir, webDist };
}
