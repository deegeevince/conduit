// What every unit of a run shares: the brain, the eyes, the judge, the limits.

import { EMPTY_STAGE, FULL_CAPABILITIES, NO_V4_CAPABILITIES } from '@conduit/language';
import type { Capabilities, ExploreJudgement, Services, StageBase } from '@conduit/language';
import type { Brain } from '../domain/brain';
import type { HarnessReply } from './explore-browser';
import { judge } from './explore-judge';
import type { JudgeSettings } from './explore-judge';

export interface Running {
  readonly controller: AbortController;
  /** why the controller was aborted, if it was */
  reason: 'timeout' | 'interrupted' | null;
}

export interface Rig {
  readonly runId: string;
  readonly brain: Brain;
  readonly services: Services;
  readonly emptyStage: StageBase;
  readonly timeoutMs: number;
  readonly running: Running;
  readonly stopped: () => boolean;
  /** null: no judge in this run */
  readonly judgeSettings: JudgeSettings | null;
  /** shares of the answer at which the judge is also shown a picture, before the final one */
  readonly judgeEarlier: readonly number[];
  readonly judgeSide: number;
  /** judge calls at once */
  readonly judgeSlots: { take(): Promise<() => void> };
}

export const EMPTY: StageBase = EMPTY_STAGE;

/**
 * What the battery's brain is told the painter can do. It must be what the
 * painter behind the battery's pictures really does, or a run measures a brain
 * taught words nobody performs. Today that painter lays out no structure and
 * draws no control, so nothing of Series 4 is claimed here. PLAN-v2.md,
 * package H: ask the harness page (`window.__harness.capabilities`) instead of
 * writing it down, so this can never drift from the painter again.
 */
export const HARNESS_CAPABILITIES: Capabilities = { ...FULL_CAPABILITIES, ...NO_V4_CAPABILITIES };

/** Asks the judge about a picture, a few at a time. Never throws: a failed judge is a judgement with a `failure`. */
export async function judgeStills(rig: Rig, request: string, reply: HarnessReply): Promise<ExploreJudgement | null> {
  const settings = rig.judgeSettings;
  if (settings === null) return null;
  const release = await rig.judgeSlots.take();
  try {
    const verdict = await judge({ request, images: reply.judge, thumbs: reply.thumbs }, settings, new AbortController().signal);
    return reply.complete ? verdict : { ...verdict, why: `${verdict.why} (the picture was taken before all its text could be drawn)`.trim() };
  } catch (error) {
    return { model: settings.model, asked: false, textProblem: null, wrongLabel: null, correct: false, mistake: null, coherence: 1, why: '', costUsd: null, ms: 0, stills: [], failure: error instanceof Error ? error.message : String(error) };
  } finally {
    release();
  }
}

/** A counting semaphore as a queue of waiters. */
export function slots(count: number): Rig['judgeSlots'] {
  let free = count;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next !== undefined) next();
    else free += 1;
  };
  return {
    take: () =>
      new Promise<() => void>((resolve) => {
        if (free > 0) {
          free -= 1;
          resolve(release);
        } else {
          waiting.push(() => resolve(release));
        }
      }),
  };
}
