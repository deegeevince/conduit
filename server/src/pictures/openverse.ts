// Openverse, keyless: https://api.openverse.org/v1/images/. The probe's findings are at the top of domain/pictures.ts.

import { makeCredit, aspectWord, PICTURE_LIMITS } from '../domain/pictures';
import type { PictureCandidate, PictureQuery, PictureSource } from '../domain/pictures';
import type { Logger } from '../log';
import { CLIENT_NAME } from './net';

const ENDPOINT = 'https://api.openverse.org/v1/images/';

export interface OpenverseOptions {
  readonly log: Logger;
  readonly minIntervalMs: number;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly fetchJson?: (url: string, signal: AbortSignal) => Promise<{ status: number; headers: Headers; json: unknown }>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Candidates from an Openverse answer; anything malformed or outside the licence list is left out. Pure. */
export function parseOpenverse(json: unknown): PictureCandidate[] {
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: PictureCandidate[] = [];
  for (const raw of results as Record<string, unknown>[]) {
    const url = str(raw['url']);
    const id = str(raw['id']);
    if (url === null || id === null || !url.startsWith('https://')) continue;
    const credit = makeCredit({
      title: str(raw['title']),
      creator: str(raw['creator']),
      licence: str(raw['license']),
      licenceVersion: str(raw['license_version']),
      licenceUrl: str(raw['license_url']),
      landingUrl: str(raw['foreign_landing_url']),
      source: str(raw['source']) ?? str(raw['provider']),
    });
    if (credit === null) continue;
    out.push({ id, url, width: num(raw['width']), height: num(raw['height']), credit, mature: raw['mature'] === true });
  }
  return out;
}

async function defaultFetchJson(url: string, signal: AbortSignal): Promise<{ status: number; headers: Headers; json: unknown }> {
  const response = await fetch(url, { signal, headers: { 'user-agent': CLIENT_NAME, accept: 'application/json' } });
  const json: unknown = response.status === 200 ? await response.json() : (await response.body?.cancel(), null);
  return { status: response.status, headers: response.headers, json };
}

/**
 * Paced to Openverse's anonymous limits (20 a minute, 200 a day): requests go one at a time, no closer than
 * `minIntervalMs`; a 429 or a spent allowance closes the door until `Retry-After` (or a minute, or the day's end).
 */
export function createOpenverse(options: OpenverseOptions): PictureSource {
  const now = options.now ?? Date.now;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  let nextAt = 0;
  let closedUntil = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const MAX_WAIT_MS = 20_000;

  const once = async (query: PictureQuery, signal: AbortSignal): Promise<readonly PictureCandidate[]> => {
    if (now() < closedUntil) return [];
    const wait = nextAt - now();
    if (wait > MAX_WAIT_MS) return [];
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    if (signal.aborted) return [];
    nextAt = now() + options.minIntervalMs;
    const params = new URLSearchParams({ q: query.words, license_type: 'commercial,modification', mature: 'false', page_size: '20', extension: 'jpg' });
    const shape = aspectWord(query.aspect);
    if (shape !== null) params.set('aspect_ratio', shape);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
    try {
      const { status, headers, json } = await fetchJson(`${ENDPOINT}?${params}`, deadline);
      const left = headers.get('x-ratelimit-available-anon_sustained');
      if (left !== null && Number(left) <= 0) closedUntil = now() + 3_600_000;
      if (status === 429) {
        const retry = Number(headers.get('retry-after') ?? '60');
        closedUntil = now() + Math.min(86_400_000, Math.max(5, Number.isFinite(retry) ? retry : 60) * 1000);
        options.log.warn('pictures.throttled', { until: new Date(closedUntil).toISOString() });
        return [];
      }
      if (status !== 200) {
        options.log.warn('pictures.search_status', { status });
        return [];
      }
      const found = parseOpenverse(json);
      options.log.debug('pictures.search', { words: query.words, found: found.length });
      return found;
    } catch (error) {
      if (!signal.aborted) options.log.warn('pictures.search_failed', { error });
      return [];
    }
  };

  return {
    id: 'openverse',
    available: true,
    search(query, signal) {
      const run = chain.then(() => once(query, signal));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

export const OPENVERSE_LIMITS = { burstPerMinute: 20, perDay: 200, maxPageSize: 20, tries: PICTURE_LIMITS.maxTries } as const;
