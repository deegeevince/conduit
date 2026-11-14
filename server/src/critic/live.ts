// The live critic (PLAN-v2.1 package S3): a judge that can see, asked about real turns, behind `domain/critic.ts`.
//
// It never runs on a turn's path except `compare`, which is bounded by its caller's deadline. `look` is one at a time per session (a
// newer turn's look replaces one that has not started), at most `policy.perHour`, and bounded by `policy.lookMs`. It never throws: a
// finding it could not make is null and the reason is logged once per kind.

import type { CriticFinding } from '@conduit/language';
import type { Snapshot } from '../domain/brain';
import type { Critic, CriticComparison, CriticPolicy, CriticRequest } from '../domain/critic';
import { judgeFinding, judgePair } from '../judge';
import type { FindingInput, JudgeSettings, Picture } from '../judge';
import type { Logger } from '../log';

export interface LiveCriticDeps {
  readonly policy: CriticPolicy;
  readonly bin: string;
  readonly log: Logger;
  readonly now: () => number;
}

const HOUR = 3_600_000;

function pictureOf(snapshot: Snapshot): Picture {
  return { data: Buffer.from(snapshot.bytes).toString('base64'), mime: snapshot.mime };
}

function inputOf(request: Omit<CriticRequest, 'picture'>): FindingInput {
  return { turn: request.turn, pass: request.pass, asked: request.asked, ids: (request.sight?.items ?? []).map((item) => item.id) };
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
  const settings = (timeoutMs: number): JudgeSettings => ({ bin: deps.bin, model: policy.model, effort: policy.effort, timeoutMs });
  const starts: number[] = [];
  const lanes = new Map<string, Lane>();
  const told = new Set<string>();
  const closing = new AbortController();
  const tell = (kind: string, fields: Record<string, string | number>): void => {
    if (told.has(kind)) return;
    told.add(kind);
    log.warn(`critic.${kind}`, fields);
  };

  /** Spends one of the hour's looks, or says there are none left. */
  const spend = (): boolean => {
    const at = now();
    while (starts.length > 0 && (starts[0] ?? 0) <= at - HOUR) starts.shift();
    if (starts.length >= policy.perHour) return false;
    starts.push(at);
    return true;
  };

  const lookNow = async (request: CriticRequest, signal: AbortSignal): Promise<CriticFinding | null> => {
    if (!spend()) {
      tell('ceiling', { perHour: policy.perHour });
      return null;
    }
    try {
      const bounded = AbortSignal.any([signal, closing.signal, AbortSignal.timeout(policy.lookMs)]);
      const got = await judgeFinding(inputOf(request), pictureOf(request.picture), settings(policy.lookMs), bounded);
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
      try {
        const bounded = AbortSignal.any([signal, closing.signal, AbortSignal.timeout(Math.max(1, deadlineMs))]);
        // Which picture is shown first is decided here and never said.
        const draftFirst = Math.random() < 0.5;
        const got = await judgePair(inputOf(request), pictureOf(draft), pictureOf(candidate), draftFirst, settings(Math.max(1, deadlineMs)), bounded);
        if ('failure' in got) {
          if (!bounded.aborted) tell('compare', { turn: request.turn, why: got.failure });
          return null;
        }
        return { draft: got.a, candidate: got.b };
      } catch (error) {
        tell('threw', { turn: request.turn, why: error instanceof Error ? error.message : String(error) });
        return null;
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
