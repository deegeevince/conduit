// The usage meter: every model call made through this server, written down as it ends, so that "what is this costing me" has an answer
// that is not a guess. Every call is on the owner's login (the subscription), so `costUsd` is the CLI's own cost-equivalent: what the
// same tokens would have cost on the API. It is the unit the throttle is set in, and it is real as a measure of load, not as a bill.
//
//   kind      what was asked
//   turn      the brain's answer to the owner
//   review    the brain's second and later passes over its own draft (look and fix, refine)
//   critic    the critic's look at a resting picture
//   compare   the critic's blind comparison of a draft and a fix
//   lessons   `pnpm lessons`: the critic's findings turned into proposals
//   ahead     v3: a part of a document written in the background, before the person reaches it (WS5)
//   verify    v3: the second, cheap check of what was written ahead, before it is offered (WS5)
//
// One line each in `<DATA_DIR>/usage.jsonl`. The tools that make a call outside the server (`lessons`) write to the same file, so the
// hour's total is the machine's, not one process's.
//
// THE THROTTLE (`USAGE_HOURLY_CAP`, cost-equivalent dollars in any rolling hour; unset: off). It is about who backs off first:
//   - under 80% of the cap: nothing changes;
//   - 60% or more (`AHEAD_NEAR_CAP`): fill ahead stands down first: no part is started in the background; what the person reaches is
//     still written, on her turn, as it always was;
//   - 80% or more (`near`) and 100% or more (`over`): the critic and the lessons tool stand down: no looks, no comparisons, no lessons;
//   - 100% or more (`over`): the verifier's model check stands down too (nothing is offered unchecked: it waits);
//   - the owner's own turns are never refused, at any level. They are warned: the answer to a turn says how near the cap is.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type UsageKind = 'turn' | 'review' | 'critic' | 'compare' | 'lessons' | 'ahead' | 'verify' | 'ink' | 'repair' | 'art';

export interface UsageRecord {
  readonly time: string;
  readonly kind: UsageKind;
  readonly model: string | null;
  readonly session: string | null;
  readonly turn: string | null;
  readonly login: string | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
  /** the CLI's cost-equivalent in dollars; null when the call did not report one (it is not guessed) */
  readonly costUsd: number | null;
  readonly ms: number;
}

export type ThrottleState = 'off' | 'ok' | 'near' | 'over';

/** The fraction of the cap at which the critic and the lessons tool back off. */
export const NEAR_CAP = 0.8;

/** The fraction of the cap at which fill ahead backs off: before the critic, because nobody is waiting for it yet. */
export const AHEAD_NEAR_CAP = 0.6;

/** Whether the hour's spending leaves room for work nobody is waiting for. False from `AHEAD_NEAR_CAP` of the cap; always true with no cap. */
export function roomAhead(throttle: Throttle, now: number): boolean {
  return throttle.capUsd === null || throttle.spentLastHour(now) < throttle.capUsd * AHEAD_NEAR_CAP;
}

export interface Throttle {
  readonly capUsd: number | null;
  /** cost-equivalent dollars spent in the last 60 minutes, by every process that writes to the meter */
  spentLastHour(now: number): number;
  state(now: number): ThrottleState;
}

export interface UsageMeter extends Throttle {
  record(entry: Omit<UsageRecord, 'time'> & { readonly time?: string }): void;
}

export const NO_THROTTLE: Throttle = { capUsd: null, spentLastHour: () => 0, state: () => 'off' };

const TAIL_BYTES = 16 * 1024 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The records in the file, oldest first; a torn line is skipped. Reads only the tail of a very large file. */
export function readUsage(file: string, sinceMs = 0): UsageRecord[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  const out: UsageRecord[] = [];
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    try {
      const record = JSON.parse(raw) as UsageRecord;
      if (typeof record.time === 'string' && typeof record.kind === 'string' && Date.parse(record.time) >= sinceMs) out.push(record);
    } catch {
      // a line cut short
    }
  }
  return out;
}

/** Appends one record. Never throws: a meter that cannot be written is a missing line, not a failed answer. */
export function appendUsage(file: string, entry: UsageRecord): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The throttle's reading of a usage file at this moment: what the tools use, which are not the server and have no meter of their own in memory. */
export function throttleOf(file: string, capUsd: number | null): Throttle {
  const spent = (now: number): number => readUsage(file, now - HOUR_MS).reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  return throttleFrom(capUsd, spent);
}

function throttleFrom(capUsd: number | null, spent: (now: number) => number): Throttle {
  return {
    capUsd,
    spentLastHour: spent,
    state(now) {
      if (capUsd === null) return 'off';
      const used = spent(now);
      return used >= capUsd ? 'over' : used >= capUsd * NEAR_CAP ? 'near' : 'ok';
    },
  };
}

/** `USAGE_HOURLY_CAP` as the tools read it (the server reads it through `loadEnv`): dollars, or null for off or for something that is not a positive number. */
export function capFromEnv(source: Readonly<Record<string, string | undefined>>): number | null {
  const raw = source['USAGE_HOURLY_CAP']?.trim();
  if (raw === undefined || raw === '' || raw === 'off') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The server's meter: the file is the record, and the last hour's spending is kept in memory, loaded at boot and refreshed from the file so a tool's calls count too. */
export function createUsageMeter(file: string, capUsd: number | null, now: () => number): UsageMeter {
  let recent: { at: number; cost: number }[] = readUsage(file, now() - HOUR_MS).map((record) => ({ at: Date.parse(record.time), cost: record.costUsd ?? 0 }));
  let readAt = now();
  const spent = (at: number): number => {
    // Other processes write to the file (the lessons tool); look again at most every 20 s.
    if (at - readAt > 20_000) {
      readAt = at;
      recent = readUsage(file, at - HOUR_MS).map((record) => ({ at: Date.parse(record.time), cost: record.costUsd ?? 0 }));
    }
    recent = recent.filter((entry) => entry.at > at - HOUR_MS);
    return recent.reduce((sum, entry) => sum + entry.cost, 0);
  };
  return {
    ...throttleFrom(capUsd, spent),
    record(entry) {
      const record: UsageRecord = { ...entry, time: entry.time ?? new Date(now()).toISOString() };
      appendUsage(file, record);
      recent.push({ at: Date.parse(record.time), cost: record.costUsd ?? 0 });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The summary `/api/usage` and `/usage` show

export interface UsageBucket {
  /** the start of the hour (ISO, UTC), or of the day (`YYYY-MM-DD`, the server's own calendar) */
  readonly start: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** cost-equivalent dollars; calls that reported none add nothing, and are counted in `unmetered` */
  readonly costUsd: number;
  readonly unmetered: number;
  readonly ms: number;
  readonly byKind: Readonly<Record<string, { readonly calls: number; readonly costUsd: number }>>;
  readonly byModel: Readonly<Record<string, { readonly calls: number; readonly costUsd: number }>>;
}

export interface UsageSummary {
  readonly generatedAt: string;
  readonly throttle: { readonly capUsd: number | null; readonly spentLastHourUsd: number; readonly state: ThrottleState; readonly nearAtUsd: number | null };
  readonly hours: readonly UsageBucket[];
  readonly days: readonly UsageBucket[];
}

interface Mutable {
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  unmetered: number;
  ms: number;
  byKind: Record<string, { calls: number; costUsd: number }>;
  byModel: Record<string, { calls: number; costUsd: number }>;
}

const blank = (): Mutable => ({ calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, unmetered: 0, ms: 0, byKind: {}, byModel: {} });

function add(bucket: Mutable, record: UsageRecord): void {
  const cost = record.costUsd ?? 0;
  bucket.calls += 1;
  bucket.inputTokens += record.inputTokens ?? 0;
  bucket.cacheReadTokens += record.cacheReadTokens ?? 0;
  bucket.cacheWriteTokens += record.cacheWriteTokens ?? 0;
  bucket.outputTokens += record.outputTokens ?? 0;
  bucket.costUsd += cost;
  bucket.ms += record.ms;
  if (record.costUsd === null) bucket.unmetered += 1;
  const kind = (bucket.byKind[record.kind] ??= { calls: 0, costUsd: 0 });
  kind.calls += 1;
  kind.costUsd += cost;
  const model = (bucket.byModel[record.model ?? 'unknown'] ??= { calls: 0, costUsd: 0 });
  model.calls += 1;
  model.costUsd += cost;
}

const dayKey = (ms: number): string => {
  const date = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const frozen = (start: string, b: Mutable): UsageBucket => ({ start, ...b, costUsd: round(b.costUsd) });

/** Per hour for the last `hours` (zero-filled, oldest first, the current hour last) and per day for the last `days`. */
export function summarizeUsage(records: readonly UsageRecord[], throttle: Throttle, now: number, hours = 48, days = 14): UsageSummary {
  const byHour = new Map<number, Mutable>();
  const byDay = new Map<string, Mutable>();
  for (const record of records) {
    const at = Date.parse(record.time);
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
    add(byHour.get(hour) ?? byHour.set(hour, blank()).get(hour) ?? blank(), record);
    const day = dayKey(at);
    add(byDay.get(day) ?? byDay.set(day, blank()).get(day) ?? blank(), record);
  }
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const hourBuckets: UsageBucket[] = [];
  for (let i = hours - 1; i >= 0; i -= 1) {
    const start = thisHour - i * HOUR_MS;
    hourBuckets.push(frozen(new Date(start).toISOString(), byHour.get(start) ?? blank()));
  }
  const dayBuckets: UsageBucket[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * DAY_MS);
    dayBuckets.push(frozen(key, byDay.get(key) ?? blank()));
  }
  return {
    generatedAt: new Date(now).toISOString(),
    throttle: { capUsd: throttle.capUsd, spentLastHourUsd: round(throttle.spentLastHour(now)), state: throttle.state(now), nearAtUsd: throttle.capUsd === null ? null : round(throttle.capUsd * NEAR_CAP) },
    hours: hourBuckets,
    days: dayBuckets,
  };
}
