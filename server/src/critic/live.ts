// The live critic: a judge that can see, asked about real turns, behind `domain/critic.ts`.
//
// It never runs on a turn's path: `compare` is started after a fix is shown and not waited for. `look` is one at a time per session (a
// newer turn's look replaces one that has not started), at most `policy.perHour`, and bounded by `policy.lookMs`. It never throws: a
// finding it could not make is null and the reason is logged once per kind.

import { noteText } from '@conduit/language';
import type { CriticFinding } from '@conduit/language';
import type { Snapshot } from '../domain/brain';
import type { Critic, CriticComparison, CriticPolicy, CriticRequest } from '../domain/critic';
import { judgeFinding, judgePair } from '../judge';
import type { FindingInput, JudgeSettings, Picture } from '../judge';
import type { Logger } from '../log';
import type { Throttle, UsageKind, UsageMeter } from '../usage';

export interface LiveCriticDeps {
  readonly policy: CriticPolicy;
  readonly bin: string;
  readonly log: Logger;
  readonly now: () => number;
  readonly meter?: UsageMeter;
  readonly throttle?: Throttle;
}

const HOUR = 3_600_000;

function pictureOf(snapshot: Snapshot): Picture {
  return { data: Buffer.from(snapshot.bytes).toString('base64'), mime: snapshot.mime };
}

/** One short line per element that landed badly, the painter's own words: evidence for the judge, never the brain's reasoning. */
function measuredOf(sight: CriticRequest['sight']): readonly string[] {
  const lines: string[] = [];
  for (const item of sight?.items ?? []) {
    if (item.notes.length === 0) continue;
    lines.push(`${item.id} (${item.kind}${item.resting ? '' : ', gone at rest'}): ${item.notes.map((note) => noteText(item, note)).join('; ')}`);
    if (lines.length >= 12) break;
  }
  return lines;
}

function inputOf(request: Omit<CriticRequest, 'picture'>): FindingInput {
  return {
    turn: request.turn,
    pass: request.pass,
    asked: request.asked,
    ids: (request.sight?.items ?? []).map((item) => item.id),
    measured: measuredOf(request.sight),
    mockup: request.mockup === true,
    previous: request.previous === undefined || request.previous === null ? null : { picture: pictureOf(request.previous.picture), finding: request.previous.finding },
  };
}

interface Waiting {
  readonly request: CriticRequest;
  readonly signal: AbortSignal;
  readonly resolve: (finding: CriticFinding | null) => void;
}

interface Lane {
  running: boolean;
  waiting: Waiting | null;
}

export function createLiveCritic(deps: LiveCriticDeps): Critic {
  const { policy, log, now } = deps;
  /** What a call is told to the meter as: `request` is the turn it is about. */
  const settings = (timeoutMs: number, kind: UsageKind = 'critic', request?: { readonly session: string; readonly turn: string }): JudgeSettings => ({
    bin: deps.bin,
    model: policy.model,
    effort: policy.effort,
    timeoutMs,
    ...(deps.meter === undefined
      ? {}
      : {
          meter: (call: { readonly model: string; readonly usage: { readonly inputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number; readonly outputTokens: number; readonly thinkingTokens: number | null; readonly costUsd: number | null; readonly ms: number } }) =>
            deps.meter?.record({
              kind,
              model: call.model,
              session: request?.session ?? null,
              turn: request?.turn ?? null,
              login: null,
              inputTokens: call.usage.inputTokens,
              cacheReadTokens: call.usage.cacheReadTokens,
              cacheWriteTokens: call.usage.cacheWriteTokens,
              outputTokens: call.usage.outputTokens,
              thinkingTokens: call.usage.thinkingTokens,
              costUsd: call.usage.costUsd,
              ms: call.usage.ms,
            }),
        }),
  });
  const starts: number[] = [];
  const lanes = new Map<string, Lane>();
  const told = new Set<string>();
  const closing = new AbortController();
  // What the kill switch aborts: everything in flight now. A new one is made at once, so the critic is not left dead.
  let epoch = new AbortController();
  const tell = (kind: string, fields: Record<string, string | number>): void => {
    if (told.has(kind)) return;
    told.add(kind);
    log.warn(`critic.${kind}`, fields);
  };

  /** Spends one of the hour's looks, or says why not: the owner's spending is near the cap they set, or the hour's looks are used. */
  const spend = (): 'ok' | 'throttled' | 'ceiling' => {
    const at = now();
    // The critic is the first to stand down when the hour's spending nears the cap: it is the one thing here the owner did not ask for.
    const throttled = deps.throttle?.state(at);
    if (throttled === 'near' || throttled === 'over') {
      tell(`throttled_${throttled}`, { state: throttled, capUsd: deps.throttle?.capUsd ?? 0 });
      return 'throttled';
    }
    while (starts.length > 0 && (starts[0] ?? 0) <= at - HOUR) starts.shift();
    if (starts.length >= policy.perHour) return 'ceiling';
    starts.push(at);
    return 'ok';
  };

  /** Whether a look may be made now; the reason is logged once, when it is the ceiling (a throttle says so itself). */
  const allowed = (): boolean => {
    const verdict = spend();
    if (verdict === 'ceiling') tell('ceiling', { perHour: policy.perHour });
    return verdict === 'ok';
  };

  const lookNow = async (request: CriticRequest, signal: AbortSignal): Promise<CriticFinding | null> => {
    if (!allowed()) return null;
    try {
      const bounded = AbortSignal.any([signal, closing.signal, epoch.signal, AbortSignal.timeout(policy.lookMs)]);
      const got = await judgeFinding(inputOf(request), pictureOf(request.picture), settings(policy.lookMs, 'critic', request), bounded);
      if (got.finding === null) tell('failed', { turn: request.turn, why: got.failure ?? 'no finding' });
      return got.finding;
    } catch (error) {
      tell('threw', { turn: request.turn, why: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  const pump = async (session: string, lane: Lane, first: Waiting): Promise<void> => {
    lane.running = true;
    let current: Waiting | null = first;
    while (current !== null) {
      current.resolve(await lookNow(current.request, current.signal));
      current = lane.waiting;
      lane.waiting = null;
    }
    lane.running = false;
    if (lanes.get(session) === lane) lanes.delete(session);
  };

  return {
    available: policy.enabled,

    look(request, signal) {
      if (!policy.enabled) return Promise.resolve(null);
      return new Promise<CriticFinding | null>((resolve) => {
        const entry: Waiting = { request, signal, resolve };
        const lane = lanes.get(request.session) ?? { running: false, waiting: null };
        lanes.set(request.session, lane);
        if (lane.running) {
          // The one that was waiting is replaced by this turn's, which is the picture that is on the stage now.
          lane.waiting?.resolve(null);
          lane.waiting = entry;
        } else {
          void pump(request.session, lane, entry);
        }
      });
    },

    async compare(request, draft, candidate, deadlineMs, signal): Promise<CriticComparison | null> {
      if (!policy.enabled) return null;
      if (!allowed()) return null;
      try {
        const bounded = AbortSignal.any([signal, closing.signal, epoch.signal, AbortSignal.timeout(Math.max(1, deadlineMs))]);
        // Which picture is shown first is decided here and never said.
        const draftFirst = Math.random() < 0.5;
        const got = await judgePair(inputOf(request), pictureOf(draft), pictureOf(candidate), draftFirst, settings(Math.max(1, deadlineMs), 'compare', request), bounded);
        if ('failure' in got) {
          // A timeout is logged every time: the deadline is the thing to measure. Other failures once per kind.
          if (bounded.aborted) log.warn('critic.compare_timeout', { turn: request.turn, deadlineMs, why: got.failure });
          else tell('compare', { turn: request.turn, why: got.failure });
          return null;
        }
        return { draft: got.a, candidate: got.b };
      } catch (error) {
        tell('threw', { turn: request.turn, why: error instanceof Error ? error.message : String(error) });
        return null;
      }
    },

    cancel() {
      epoch.abort();
      epoch = new AbortController();
      for (const lane of lanes.values()) {
        lane.waiting?.resolve(null);
        lane.waiting = null;
      }
    },

    async close() {
      closing.abort();
      for (const lane of lanes.values()) {
        lane.waiting?.resolve(null);
        lane.waiting = null;
      }
    },
  };
}
