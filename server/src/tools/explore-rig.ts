// What every unit of a run shares: the brain, the eyes, the judge, the limits.

import { EMPTY_STAGE } from '@conduit/language';
import type { Capabilities, ExploreJudgement, ScreenFacts, Services, StageBase, TechniqueCard, TurnInput } from '@conduit/language';
import type { Brain } from '../domain/brain';
import type { TechniqueLibrary } from '../domain/techniques';
import type { DriveReply, HarnessReply } from './explore-browser';
import { judge, judgeCompare, judgeResponds } from './explore-judge';
import type { Compared, JudgeSettings } from './explore-judge';

export interface Running {
  readonly controller: AbortController;
  /** why the controller was aborted, if it was */
  reason: 'timeout' | 'interrupted' | null;
}

export interface Rig {
  readonly runId: string;
  readonly brain: Brain;
  readonly services: Services;
  /**
   * What the painter behind the battery's pictures says it can do, asked of the page itself: the brain is taught exactly this,
   * so a run can never measure a brain taught words nobody performs.
   */
  readonly capabilities: Capabilities;
  /** the techniques a brief may carry, chosen the way the server chooses them (from memory, the seed and the cache: no network) */
  readonly library: TechniqueLibrary;
  readonly emptyStage: StageBase;
  readonly timeoutMs: number;
  readonly running: Running;
  readonly stopped: () => boolean;
  /** null: no judge in this run */
  readonly judgeSettings: JudgeSettings | null;
  /** shares of the answer at which the judge is also shown a picture, before the final one */
  readonly judgeEarlier: readonly number[];
  readonly judgeSide: number;
  /** the window the run lays answers out and pictures them for, as the brain is told of it */
  readonly screen: ScreenFacts;
  /** judge calls at once */
  readonly judgeSlots: { take(): Promise<() => void> };
}

export const EMPTY: StageBase = EMPTY_STAGE;

/** Where an answer told in captions is also pictured, before its resting stage: what the judge sees of a story told a line at a time (P2-21). */
export const STRIP: readonly number[] = [0.2, 0.45, 0.7];

/** The techniques the library hands this turn, as the conductor does: only for a message the brain will read. Null: none fitted. */
export function techniquesFor(rig: Rig, input: TurnInput): { readonly cards: readonly TechniqueCard[]; readonly ids: readonly string[] } {
  const cards = input.kind === 'prompt' || input.kind === 'tap' || input.kind === 'act' ? rig.library.cardsFor({ input, documents: false }) : [];
  return { cards, ids: cards.map((card) => card.id) };
}

/** Asks the judge about a picture, a few at a time. Never throws: a failed judge is a judgement with a `failure`. */
export async function judgeStills(rig: Rig, request: string, reply: HarnessReply, options: { readonly chart?: boolean; readonly drive?: DriveReply | null } = {}): Promise<ExploreJudgement | null> {
  const settings = rig.judgeSettings;
  if (settings === null) return null;
  const release = await rig.judgeSlots.take();
  try {
    const signal = new AbortController().signal;
    const asked = await judge({ request, images: reply.judge, thumbs: reply.thumbs, chart: options.chart === true }, settings, signal);
    const verdict = reply.complete ? asked : { ...asked, why: `${asked.why} (the picture was taken before all its text could be drawn)`.trim() };
    // Does the picture respond? Asked of the two ends of each control that something follows, blind to everything but the request and the two pictures.
    const worked = (options.drive?.controls ?? []).filter((control) => control.ends !== null && control.bound);
    if (worked.length === 0 || verdict.failure !== null) return verdict;
    const answers = await Promise.all(worked.map((control) => judgeResponds({ request, control: control.description, images: control.ends as readonly [string, string] }, settings, signal)));
    const usable = answers.filter((answer) => answer.responds !== null);
    if (usable.length === 0) return verdict;
    const cost = answers.reduce((total, answer) => total + (answer.costUsd ?? 0), verdict.costUsd ?? 0);
    const failing = usable.find((answer) => answer.responds === false);
    return { ...verdict, responds: failing === undefined, respondsWhy: (failing ?? usable[0])?.why ?? null, costUsd: cost };
  } catch (error) {
    return { model: settings.model, asked: false, textProblem: null, wrongLabel: null, correct: false, mistake: null, coherence: 1, why: '', costUsd: null, ms: 0, stills: [], failure: error instanceof Error ? error.message : String(error) };
  } finally {
    release();
  }
}

/** Draft and final in one call (P1-9), through the same slots as every judgement. Never throws: a failed judge is a comparison with a `failure`. */
export async function compareStills(rig: Rig, request: string, draft: HarnessReply, final: HarnessReply): Promise<Compared> {
  const settings = rig.judgeSettings;
  const failed = (failure: string): Compared => ({ draft: null, final: null, prefer: null, why: null, costUsd: null, failure });
  const was = draft.judge[draft.judge.length - 1];
  const is = final.judge[final.judge.length - 1];
  if (settings === null) return failed('no judge in this run');
  if (was === undefined || is === undefined) return failed('a picture is missing');
  const release = await rig.judgeSlots.take();
  try {
    return await judgeCompare({ request, draft: was, final: is }, settings, new AbortController().signal);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
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
