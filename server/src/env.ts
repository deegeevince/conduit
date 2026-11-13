// The only module that reads process.env. Everything else is handed an `Env`.

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePromptVariant } from '@conduit/language';
import type { PromptVariant } from '@conduit/language';
import type { LogLevel } from './log';

export type BrainSettings =
  | { readonly kind: 'relay'; readonly idleTimeoutMs: number }
  | {
      readonly kind: 'claude-cli';
      readonly bin: string;
      readonly model: string;
      readonly firstTokenTimeoutMs: number;
      readonly idleTimeoutMs: number;
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
  /** how the system prompt teaches a diagram (`PROMPT_VARIANT`: column | hero) */
  readonly promptVariant: PromptVariant;
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

/** What a child process is given: the server's environment with these names overridden. */
export function childEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
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
    brain = {
      kind,
      bin: text('CLAUDE_BIN') ?? 'claude',
      model: required('CLAUDE_MODEL', 'when BRAIN=claude-cli (for example: sonnet)'),
      firstTokenTimeoutMs: integer('CLAUDE_FIRST_TOKEN_TIMEOUT_MS', 60_000, 1_000, 600_000),
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
  const logDir = resolveLogDir(source);
  const exploreDir = resolvePath(root, 'explore');

  let webDist: string | null = null;
  if (production) {
    webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    if (!existsSync(`${webDist}index.html`)) problems.push(`NODE_ENV=production needs the built web app at ${webDist}; run "pnpm build" first`);
  }

  if (problems.length > 0) throw new EnvError(problems);
  return { production, host, trustedHosts, port, logLevel, brain, images, sight, promptVariant: parsePromptVariant(text('PROMPT_VARIANT')), logDir, readLinks: choice('READ_LINKS', ['on', 'off'] as const, 'on') === 'on', paintingsPerSession: images.kind === 'none' ? 0 : images.maxPerSession, exploreDir, webDist };
}
