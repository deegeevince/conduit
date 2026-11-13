// One turn through a brain, recorded: every line with the millisecond it was complete, what the brain was told,
// what it cost, and the checks that counting can make. The unit the runner and the scripted conversations share.

import {
  EMPTY_STAGE,
  LineNormalizer,
  TurnScore,
  parseLine,
  serializeLine,
  viewerWaitOf,
} from '@conduit/language';
import type {
  ExploreBaseline,
  ExplorePrompt,
  ExploreResult,
  ExploreTurnMeta,
  ExploreUsage,
  Issue,
  Line,
  StageBase,
  TurnContext,
  TurnEndReason,
  TurnInput,
} from '@conduit/language';
import type { Brain, BrainUsage, Snapshot } from '../domain/brain';
import { AppError } from '../errors';
import { checksOf } from './explore-checks';

export function usageOf(usage: BrainUsage | null): ExploreUsage | null {
  if (usage === null) return null;
  return {
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    costUsd: usage.costUsd,
  };
}

export interface TurnPlay {
  readonly prompt: ExplorePrompt;
  readonly session: string;
  readonly turn: string;
  /** prefix of the ids given to elements the brain did not name, unique among the turns of a conversation */
  readonly idPrefix: string;
  readonly input: TurnInput;
  readonly context: TurnContext;
  readonly snapshot: Snapshot | null;
  readonly brain: Brain;
  readonly timeoutMs: number;
  /** the viewer cuts the turn off this long after its first line; null lets it run */
  readonly interruptAfterMs: number | null;
  readonly signal: AbortSignal;
  /** why `signal` was aborted from outside, if it was */
  readonly why: () => 'timeout' | 'interrupted' | null;
}

export interface TurnPlayed {
  readonly result: ExploreResult;
  readonly accepted: readonly Line[];
  readonly score: TurnScore;
  /** ms from the request to the cut when the viewer interrupted, else null */
  readonly interruptedAtMs: number | null;
  /** seconds into the answer when it was cut: the playhead the painter would have reported */
  readonly playhead: number | null;
  readonly form: ExploreTurnMeta['form'];
  readonly withSnapshot: boolean;
  /** what the brain was told for this turn */
  readonly brief: string;
  /** the system prompt the brain was given, on the turn it first heard it */
  readonly system: string | null;
  readonly rejectedNotes: readonly { readonly raw: string; readonly why: string }[];
}

export async function playTurn(play: TurnPlay): Promise<TurnPlayed> {
  const { brain, context } = play;
  const base: StageBase = context.stage;
  let nextId = 0;
  const normalizer = new LineNormalizer(() => `${play.idPrefix}x${++nextId}`);
  const score = new TurnScore(base);
  const lines: { seq: number; text: string; ms: number; issues: readonly Issue[] }[] = [];
  const accepted: Line[] = [];
  const rejects: { raw: string; ms: number; issues: readonly Issue[] }[] = [];
  let usage: BrainUsage | null = null;
  let firstVisibleMs: number | null = null;
  let firstLineMs: number | null = null;
  let form: ExploreTurnMeta['form'] = null;
  let withSnapshot = false;
  let brief = '';
  let system: string | null = null;
  let end: TurnEndReason = 'done';
  let message: string | null = null;
  let interruptedAtMs: number | null = null;
  let playhead: number | null = null;

  const local = new AbortController();
  const onOuter = (): void => local.abort();
  play.signal.addEventListener('abort', onOuter, { once: true });
  if (play.signal.aborted) local.abort();
  let cut: NodeJS.Timeout | undefined;
  const started = performance.now();

  try {
    for await (const event of brain.respond({ turn: play.turn, session: play.session, input: play.input, context, snapshot: play.snapshot }, local.signal)) {
      const ms = Math.round(performance.now() - started);
      if (event.type === 'brief') {
        form = event.form;
        withSnapshot = event.withSnapshot;
        brief = event.text;
        system = event.system;
      } else if (event.type === 'usage') {
        usage = event.usage;
      } else if (event.type === 'reject') {
        rejects.push({ raw: event.raw, ms, issues: event.issues });
      } else if (event.type === 'line') {
        const normalized = normalizer.normalize(event.line);
        if (normalized.line === null) {
          rejects.push({ raw: serializeLine(event.line), ms, issues: [...event.issues, ...normalized.issues] });
          continue;
        }
        const seq = lines.length + 1;
        const before = score.schedule.elements.length;
        const pushed = score.push(normalized.line, seq, 0);
        if (firstLineMs === null) {
          firstLineMs = ms;
          if (play.interruptAfterMs !== null) {
            cut = setTimeout(() => {
              interruptedAtMs = Math.round(performance.now() - started);
              local.abort();
            }, play.interruptAfterMs);
            cut.unref();
          }
        }
        if (firstVisibleMs === null && pushed.schedule.elements.length > before) firstVisibleMs = ms;
        accepted.push(normalized.line);
        lines.push({ seq, text: serializeLine(normalized.line), ms, issues: [...event.issues, ...normalized.issues, ...pushed.issues] });
      }
    }
    const why = play.why();
    if (interruptedAtMs !== null) {
      end = 'interrupted';
      message = `the viewer spoke ${play.interruptAfterMs ?? 0} ms after the first line`;
      playhead = Math.min(score.schedule.end, Math.max(0, (interruptedAtMs - (firstLineMs ?? interruptedAtMs)) / 1000));
    } else if (why === 'timeout') {
      end = 'timeout';
      message = `no end within ${play.timeoutMs / 1000} s`;
    } else if (why === 'interrupted') {
      end = 'interrupted';
      message = 'stopped by Ctrl-C';
    }
  } catch (error) {
    if (error instanceof AppError) {
      end = error.code === 'brain_timeout' ? 'timeout' : 'failed';
      message = error.message;
    } else {
      end = 'failed';
      message = error instanceof Error ? error.message : String(error);
    }
  } finally {
    clearTimeout(cut);
    play.signal.removeEventListener('abort', onOuter);
  }
  const totalMs = Math.round(performance.now() - started);
  const lastLineMs = lines.length === 0 ? null : (lines[lines.length - 1]?.ms ?? null);
  const checks = checksOf(accepted, rejects.length, lines, score.schedule, play.prompt.expects);
  const brainUsage = usageOf(usage);
  const result: ExploreResult = {
    prompt: play.prompt,
    lines,
    rejects,
    end,
    message,
    firstVisibleMs,
    totalMs,
    usage: brainUsage,
    checks,
    baseline: null,
    firstTextMs: usage?.firstTextMs ?? firstLineMs,
    viewerWaitMs: interruptedAtMs === null ? viewerWaitOf(firstLineMs, lastLineMs, checks.playSeconds) : null,
    ...(base === EMPTY_STAGE ? {} : { base }),
  };
  const notes = rejects.map((reject) => ({ raw: reject.raw.slice(0, 120), why: reject.issues[0]?.message ?? 'not a usable line' }));
  return { result, accepted, score, interruptedAtMs, playhead, form, withSnapshot, brief, system, rejectedNotes: notes.slice(0, 8) };
}

export function cacheShareOf(usage: ExploreUsage | null): number | null {
  if (usage === null) return null;
  const read = usage.cacheReadTokens;
  if (read === null) return null;
  const total = read + (usage.cacheWriteTokens ?? 0) + (usage.inputTokens ?? 0);
  return total > 0 ? read / total : null;
}

/** Re-parse check the runner prints: lines that do not read back are a bug in the recorder, not in the brain. */
export function unreadable(result: ExploreResult): number {
  return result.lines.filter((line) => parseLine(line.text).kind !== 'line').length;
}

export type { ExploreBaseline };
