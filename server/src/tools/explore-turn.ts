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
  ExploreReview,
  LineProblem,
  ReviewPolicy,
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
import type { Brain, BrainEvent, BrainUsage, Snapshot } from '../domain/brain';
import { createDraftGate, reviewTurn } from '../domain/review';
import type { HarnessReply } from './explore-browser';
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
  /** look and fix: the answer is pictured as it will land and the brain may fix it, as the server does between a draft and the end of a turn */
  readonly look?: TurnLook;
}

/** What playing a turn needs to look at its own draft: the policy, and the page's picture of the draft. */
export interface TurnLook {
  readonly policy: ReviewPolicy;
  readonly styles: () => readonly string[];
  /** the page's report on the answer so far: its sight, where things rest, a picture of how it lands */
  readonly draft: (lines: readonly { readonly seq: number; readonly line: Line }[]) => Promise<HarnessReply>;
}

/** What the look came to and the draft it looked at, for the caller to judge and show. */
export interface TurnLooked {
  readonly review: Omit<ExploreReview, 'before' | 'after' | 'addedWaitMs'> & { readonly addedWaitMs: number };
  /** the page's pictures of the draft; null when the look never reached the page */
  readonly draft: HarnessReply | null;
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
  /** present when look and fix was offered to this turn */
  readonly looked?: TurnLooked;
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
  let usage = null as BrainUsage | null;
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
  let fixing = false;
  let looked: TurnLooked | undefined;

  const local = new AbortController();
  const onOuter = (): void => local.abort();
  play.signal.addEventListener('abort', onOuter, { once: true });
  if (play.signal.aborted) local.abort();
  let cut: NodeJS.Timeout | undefined;
  const started = performance.now();

  try {
    const onEvent = (event: BrainEvent): void => {
      const ms = Math.round(performance.now() - started);
      if (event.type === 'brief') {
        form = event.form;
        withSnapshot = event.withSnapshot;
        brief = event.text;
        system = event.system;
      } else if (event.type === 'usage') {
        usage = usage === null ? event.usage : mergeUsage(usage, event.usage, fixing);
      } else if (event.type === 'reject') {
        rejects.push({ raw: event.raw, ms, issues: event.issues });
      } else if (event.type === 'line') {
        const normalized = normalizer.normalize(event.line);
        if (normalized.line === null) {
          rejects.push({ raw: serializeLine(event.line), ms, issues: [...event.issues, ...normalized.issues] });
          return;
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
    };
    for await (const event of brain.respond({ turn: play.turn, session: play.session, input: play.input, context, snapshot: play.snapshot }, local.signal)) onEvent(event);

    // Look and fix, as the server does it: the draft is complete, so the page pictures how it will land and the brain may fix what it sees.
    if (play.look !== undefined && !local.signal.aborted && accepted.length > 0 && interruptedAtMs === null) {
      const look = play.look;
      const draftEndMs = Math.round(performance.now() - started);
      const draftPlayMs = Math.round(score.schedule.end * 1000);
      let reply: HarnessReply | null = null;
      try {
        reply = await look.draft(lines.map((line, at) => ({ seq: line.seq, line: accepted[at] as Line })));
      } catch (error) {
        process.stderr.write(`explore: the draft of ${play.turn} could not be pictured: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      const gate = createDraftGate();
      if (reply !== null) {
        gate.open(play.turn, 1);
        const picture: Snapshot | null =
          reply.snapshot === null
            ? null
            : { mime: 'image/jpeg', bytes: new Uint8Array(Buffer.from(reply.snapshot, 'base64')), width: Math.round(play.context.screen.width * Math.min(1, 768 / Math.max(play.context.screen.width, play.context.screen.height))), height: Math.round(play.context.screen.height * Math.min(1, 768 / Math.max(play.context.screen.width, play.context.screen.height))) };
        gate.receive(play.turn, 1, reply.report.sight, reply.placed, picture !== null);
        if (picture !== null) gate.receivePicture(play.turn, 1, picture);
      }
      let recordOut: Extract<ReviewStepOf, { type: 'record' }>['record'] | null = null;
      fixing = true;
      for await (const step of reviewTurn({
        brain,
        policy: look.policy,
        gate,
        turn: play.turn,
        session: play.session,
        input: play.input,
        styles: look.styles,
        drafts: reply !== null,
        state: () => ({ schedule: score.schedule, rejects: rejects.length, lastSeq: lines.length, problems: rejects.map((reject): LineProblem => ({ raw: reject.raw, kind: 'rejected', why: reject.issues[0]?.message ?? 'not a usable line' })) }),
        signal: local.signal,
        now: () => performance.now(),
      })) {
        if (step.type === 'record') recordOut = step.record;
        else if (step.type !== 'pass') onEvent(step);
      }
      fixing = false;
      gate.close(play.turn);
      if (recordOut !== null) {
        const finishedMs = draftEndMs + recordOut.totalMs;
        looked = {
          review: { result: recordOut.result, passes: recordOut.passes, why: recordOut.why, firstLineMs: recordOut.firstLineMs, addedWaitMs: Math.max(0, finishedMs - ((firstLineMs ?? 0) + draftPlayMs)), costUsd: recordOut.costUsd, ...(reply === null ? {} : { draftStills: reply.thumbs.map((thumb) => `data:image/jpeg;base64,${thumb}`) }) },
          draft: reply,
        };
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
  return { result, accepted, score, interruptedAtMs, playhead, form, withSnapshot, brief, system, rejectedNotes: notes.slice(0, 8), ...(looked === undefined ? {} : { looked }) };
}

type ReviewStepOf = import('../domain/review').ReviewStep;

/** The usage of a turn that was fixed: the fix's tokens and cost count with the draft's, so the turn's cost is whole. */
function mergeUsage(first: BrainUsage, next: BrainUsage, fix: boolean): BrainUsage {
  if (!fix) return next;
  const add = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  return {
    ...first,
    outputTokens: add(first.outputTokens, next.outputTokens),
    thinkingTokens: add(first.thinkingTokens, next.thinkingTokens),
    cacheReadTokens: add(first.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, next.cacheWriteTokens),
    inputTokens: add(first.inputTokens, next.inputTokens),
    costUsd: add(first.costUsd, next.costUsd),
  };
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
