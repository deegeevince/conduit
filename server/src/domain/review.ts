// Look and fix, as the conductor runs it.
//
// The sequence, for one turn:
//
//   1. `brain.respond` returns: the draft is written. The painter is still
//      playing it; nothing has ended.
//   2. `worthALook(draftFactsOf(schedule, rejects))` (language). No: the turn
//      ends at once, exactly as it does today. Plain words are never held up.
//   3. Yes: emit `pass {pass: 1, state: 'drafted'}` and wait on the gate, at
//      most `policy.draftWaitMs`, for the painter's `draft` back event and
//      its picture (`API.draft`). The painter computes both from the schedule,
//      not from the playhead, so they arrive while the draft is still playing.
//   4. `worthAFix(facts, sight, picture !== null)`. No: emit `pass … skipped`
//      with the reason and end the turn.
//   5. Yes: emit `pass {pass: 2, state: 'looking'}`, call `brain.review`, and
//      forward its lines exactly as `respond`'s are forwarded (same turn, same
//      `seq` numbering, same normaliser, same score). On the first line emit
//      `pass … fixing`. If it yields no line, emit `pass … kept`.
//   6. Abandon the pass (abort, `pass … skipped`) when the first line has not
//      come within `policy.firstLineMs` of the draft's end, or the whole pass
//      exceeds `policy.passMs`. An interruption by the user aborts it like any turn.
//   7. End the turn. The session log gets the review's brief, lines, usage
//      and outcome; `TurnMemory.review` records it for the next brief.
//
// `reviewTurn` is the whole of it, as one function. The conductor drives it
// and so does the exploration battery (through `explore-turn.ts`), so that a
// measured run and a live turn cannot drift apart. It owns no state of the
// turn: the caller pushes every line it is handed into the turn's score, and
// `reviewTurn` reads the score back through `state()` before each decision.
//
// Deadlines are the point of this file. Every wait has one, a brain that
// ignores an abort is raced rather than trusted, and a look that fails for
// any reason other than the user's interruption ends as `skipped`: the draft
// was already good enough to show, and the turn never fails because of a look.

import { draftFactsOf, isKeep, worthAFix, worthALook } from '@conduit/language';
import type { PassState, PlacedBox, ReviewDecision, ReviewOutcome, ReviewPolicy, Schedule, Sight, TurnInput, LineProblem } from '@conduit/language';
import { AppError } from '../errors';
import type { Logger } from '../log';
import type { Brain, BrainEvent, Snapshot } from './brain';

/** What the painter said about a draft, as the conductor holds it while a look is decided. */
export interface DraftReport {
  readonly turn: string;
  readonly pass: number;
  readonly sight: Sight;
  readonly placed: readonly PlacedBox[];
  /** null when the painter could not take a picture, or it did not arrive in time */
  readonly picture: Snapshot | null;
}

/**
 * Where a draft report is waited for. The conductor opens the gate when it
 * emits `drafted`; `receive` (the `draft` back event) and `receivePicture`
 * (the upload) fill it; `wait` resolves when the report has come, with its
 * picture if the painter said one was on its way, or with null at the
 * deadline. One gate per session; a new turn closes the last.
 */
export interface DraftGate {
  open(turn: string, pass: number): void;
  receive(turn: string, pass: number, sight: Sight, placed: readonly PlacedBox[], pictureComing: boolean): void;
  receivePicture(turn: string, pass: number, picture: Snapshot): void;
  wait(turn: string, pass: number, deadlineMs: number, signal: AbortSignal): Promise<DraftReport | null>;
  close(turn: string): void;
}

/** What one turn's look-and-fix came to, with what it cost: logged, and shown on the battery's card. */
export interface ReviewRecord extends ReviewOutcome {
  readonly decisions: readonly ReviewDecision[];
  /** from the end of the draft to the first line of the fix; null when there was none */
  readonly firstLineMs: number | null;
  /** from the end of the draft to the end of the last pass */
  readonly totalMs: number;
  readonly costUsd: number | null;
}

interface Slot {
  report: { sight: Sight; placed: readonly PlacedBox[]; pictureComing: boolean } | null;
  picture: Snapshot | null;
  readonly waiters: Set<() => void>;
}

const complete = (slot: Slot): boolean => slot.report !== null && (!slot.report.pictureComing || slot.picture !== null);

export function createDraftGate(): DraftGate {
  const slots = new Map<string, Slot>();
  let current: string | null = null;
  const key = (turn: string, pass: number): string => `${turn}#${pass}`;
  const notify = (slot: Slot): void => {
    for (const wake of [...slot.waiters]) wake();
  };
  const dropTurn = (turn: string): void => {
    for (const [id, slot] of [...slots]) {
      if (!id.startsWith(`${turn}#`)) continue;
      slots.delete(id);
      notify(slot);
    }
  };

  return {
    open(turn, pass) {
      if (current !== null && current !== turn) dropTurn(current);
      current = turn;
      slots.set(key(turn, pass), { report: null, picture: null, waiters: new Set() });
    },
    receive(turn, pass, sight, placed, pictureComing) {
      const slot = slots.get(key(turn, pass));
      if (slot === undefined || slot.report !== null) return;
      slot.report = { sight, placed, pictureComing };
      if (complete(slot)) notify(slot);
    },
    receivePicture(turn, pass, picture) {
      const slot = slots.get(key(turn, pass));
      if (slot === undefined || slot.picture !== null) return;
      slot.picture = picture;
      if (complete(slot)) notify(slot);
    },
    wait(turn, pass, deadlineMs, signal) {
      const id = key(turn, pass);
      const slot = slots.get(id);
      if (slot === undefined) return Promise.resolve(null);
      const read = (): DraftReport | null => (slot.report === null ? null : { turn, pass, sight: slot.report.sight, placed: slot.report.placed, picture: slot.picture });
      if (complete(slot) || signal.aborted || deadlineMs <= 0) return Promise.resolve(signal.aborted ? null : read());
      return new Promise((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          slot.waiters.delete(finish);
          resolve(signal.aborted || slots.get(id) !== slot ? null : read());
        };
        const timer = setTimeout(finish, deadlineMs);
        slot.waiters.add(finish);
        signal.addEventListener('abort', finish, { once: true });
      });
    },
    close(turn) {
      dropTurn(turn);
      if (current === turn) current = null;
    },
  };
}

/** The policy in force: the language's defaults, with what the environment overrides. */
export function reviewPolicyFrom(base: ReviewPolicy, overrides: Partial<ReviewPolicy>): ReviewPolicy {
  return { ...base, ...overrides };
}

/** What the brain is asked when it is shown its draft, as the user's words. */
export function askedOf(input: TurnInput): string {
  const text = input.kind === 'prompt' ? input.text : input.kind === 'tap' || input.kind === 'act' ? input.text : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 600 ? `${flat.slice(0, 600)}...` : flat;
}

/** What `reviewTurn` yields: its own `pass` and `record`, and the brain's own events for the fix pass. */
export type ReviewStep =
  | { readonly type: 'pass'; readonly pass: number; readonly state: PassState; readonly reason: string | null }
  | BrainEvent
  | { readonly type: 'record'; readonly record: ReviewRecord };

/** What the caller knows of the turn as it stands; read again before each decision, after the caller has pushed what it was handed. */
export interface ReviewState {
  readonly schedule: Schedule;
  /** lines the parser or the normaliser dropped, over the whole turn */
  readonly rejects: number;
  /** the `seq` of the last line pushed */
  readonly lastSeq: number;
  readonly problems: readonly LineProblem[];
}

export interface ReviewTurnArgs {
  readonly brain: Brain;
  readonly policy: ReviewPolicy;
  readonly gate: DraftGate;
  readonly turn: string;
  readonly session: string;
  readonly input: TurnInput;
  readonly styles: () => readonly string[];
  /** the painter can report on a draft (`Capabilities.drafts`) */
  readonly drafts: boolean;
  readonly state: () => ReviewState;
  /** the turn's own signal: the user interrupting aborts it */
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly log?: Logger;
}

/**
 * Runs the passes after a draft. Yields `pass` steps in order, the brain's
 * events for each fix, and one `record` last (unless the turn was
 * interrupted, when the generator simply ends). Never throws.
 */
export async function* reviewTurn(args: ReviewTurnArgs): AsyncGenerator<ReviewStep> {
  const { brain, policy, gate, signal, now } = args;
  const decisions: ReviewDecision[] = [];
  let costUsd: number | null = null;
  let firstLineMs: number | null = null;
  let written = 1;
  let result: ReviewOutcome['result'] = 'skipped';
  let why: string | null = null;
  let t0 = now();
  const record = (): ReviewStep => ({ type: 'record', record: { result, passes: written, why, decisions, firstLineMs, totalMs: now() - t0, costUsd } });

  const first = args.state();
  const before = worthALook(draftFactsOf(first.schedule, first.rejects), policy);
  decisions.push(before);
  if (!before.look || signal.aborted) {
    why = before.why;
    yield record();
    return;
  }
  if (!args.drafts) {
    decisions.push({ look: false, why: 'the painter cannot report on a draft' });
    why = 'the painter cannot report on a draft';
    yield record();
    return;
  }
  if (brain.review === undefined) {
    decisions.push({ look: false, why: 'this brain cannot look' });
    why = 'this brain cannot look';
    yield { type: 'pass', pass: 1, state: 'skipped', reason: why };
    yield record();
    return;
  }

  let pass = 1;
  let floor = 0;
  for (;;) {
    const state = args.state();
    const facts = draftFactsOf(state.schedule, state.rejects, floor);
    if (pass === 1) t0 = now();
    const passStart = now();
    gate.open(args.turn, pass);
    yield { type: 'pass', pass, state: 'drafted', reason: null };
    const report = await gate.wait(args.turn, pass, policy.draftWaitMs, signal);
    if (signal.aborted) return;
    const fix = worthAFix(facts, report?.sight ?? null, report?.picture != null, policy);
    decisions.push(fix);
    if (!fix.look) {
      why = fix.why;
      yield { type: 'pass', pass, state: 'skipped', reason: fix.why };
      break;
    }

    const next = pass + 1;
    yield { type: 'pass', pass: next, state: 'looking', reason: null };
    const wasSeq = args.state().lastSeq;
    const outcome = yield* lookOnce(args, { pass: next, report, passStart });
    if (outcome.cost !== null) costUsd = (costUsd ?? 0) + outcome.cost;
    if (outcome.firstLineMs !== null && firstLineMs === null) firstLineMs = outcome.firstLineMs;
    if (signal.aborted) return;
    if (outcome.state !== 'done') {
      if (outcome.lines > 0) {
        written += 1;
        result = 'fixed';
      } else if (result !== 'fixed') {
        result = 'skipped';
      }
      why = outcome.reason;
      break;
    }
    written += 1;
    if (outcome.lines === 0) {
      if (result !== 'fixed') result = 'kept';
      why = null;
      break;
    }
    result = 'fixed';
    why = null;
    floor = wasSeq;
    pass = next;
    if (pass > policy.passes) break;
  }
  yield record();
}

interface LookOutcome {
  readonly state: 'done' | 'abandoned' | 'failed';
  readonly lines: number;
  readonly reason: string | null;
  readonly firstLineMs: number | null;
  readonly cost: number | null;
}

/** One call of `brain.review` under its deadlines. */
async function* lookOnce(args: ReviewTurnArgs, at: { pass: number; report: DraftReport | null; passStart: number }): AsyncGenerator<ReviewStep, LookOutcome> {
  const { brain, policy, signal, now } = args;
  const state = args.state();
  const controller = new AbortController();
  let abandoned: string | null = null;
  const abandon = (reason: string): void => {
    if (abandoned !== null || signal.aborted) return;
    abandoned = reason;
    controller.abort();
  };
  const onTurnAbort = (): void => controller.abort();
  signal.addEventListener('abort', onTurnAbort, { once: true });
  if (signal.aborted) controller.abort();

  const firstLeft = Math.max(0, policy.firstLineMs - (now() - at.passStart));
  let firstTimer: NodeJS.Timeout | undefined = setTimeout(() => abandon(`no first line of the fix within ${policy.firstLineMs} ms of the draft`), firstLeft);
  const passTimer = setTimeout(() => abandon(`the fix took longer than ${policy.passMs} ms`), policy.passMs);
  const stopped = new Promise<'stopped'>((resolve) => controller.signal.addEventListener('abort', () => resolve('stopped'), { once: true }));

  let lines = 0;
  let cost: number | null = null;
  let firstLineMs: number | null = null;
  let failure: string | null = null;
  let iterator: AsyncIterator<BrainEvent> | null = null;
  try {
    iterator = brain
      .review!({ turn: args.turn, session: args.session, pass: at.pass, input: args.input, sight: at.report?.sight ?? null, picture: at.report?.picture ?? null, problems: state.problems, styles: args.styles() }, controller.signal)
      [Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([iterator.next(), stopped]);
      if (step === 'stopped' || step.done === true) break;
      const event = step.value;
      if (event.type === 'line') {
        if (lines === 0) {
          clearTimeout(firstTimer);
          firstTimer = undefined;
          firstLineMs = now() - at.passStart;
          yield { type: 'pass', pass: at.pass, state: 'fixing', reason: null };
        }
        lines += 1;
      } else if (event.type === 'usage') {
        cost = event.usage.costUsd === null ? cost : (cost ?? 0) + event.usage.costUsd;
      }
      if (event.type === 'reject' && isKeep(event.raw)) continue;
      yield event;
    }
  } catch (error) {
    if (!signal.aborted) {
      failure = error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error);
      args.log?.warn('review.failed', { turn: args.turn, message: failure });
    }
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(passTimer);
    signal.removeEventListener('abort', onTurnAbort);
    // A brain that does not answer the abort is not waited for; the abort has told it to let go.
    if (iterator !== null) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }

  if (signal.aborted) return { state: 'done', lines, reason: null, firstLineMs, cost };
  if (failure !== null) {
    yield { type: 'pass', pass: at.pass, state: 'skipped', reason: `the look failed: ${failure}` };
    return { state: 'failed', lines, reason: `the look failed: ${failure}`, firstLineMs, cost };
  }
  if (abandoned !== null) {
    yield { type: 'pass', pass: at.pass, state: 'skipped', reason: abandoned };
    return { state: 'abandoned', lines, reason: abandoned, firstLineMs, cost };
  }
  if (lines === 0) yield { type: 'pass', pass: at.pass, state: 'kept', reason: null };
  return { state: 'done', lines, reason: null, firstLineMs, cost };
}
