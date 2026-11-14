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
//   5. Yes: emit `pass {pass: 2, state: 'looking'}` and call `brain.review`.
//      v2.1, true revision: its lines are COLLECTED, not forwarded. Lines a fix
//      may not hold (`fixLineAllowed`: a `scene`, a `look`) are dropped, each as
//      a problem for the next brief. If it yields no line, emit `pass … kept`.
//   6. The collected lines go to the painter as one `candidate` (`pass …
//      staged`); the painter tries them on a copy of the turn's score and
//      reports how the copy lands, and `reviewTurn` waits on the gate for that
//      report, at most `fix.candidateWaitMs`. Three pure rules decide
//      (`fixKeeps`, `landsNoWorse`; `criticPrefers` is measured in the background and logged, off the turn's clock) when a critic compared
//      both pictures in time). Shown: `pass … fixing`, then the lines, as
//      ordinary lines (same turn, same `seq` numbering, same normaliser, same
//      score). Refused: `pass … refused` with the reason; nothing was pushed
//      anywhere, so the draft stands exactly as it was. A painter that cannot
//      try a candidate gets no fix at all, never a redraw.
//   7. Abandon the pass (abort, `pass … skipped`) when the first line has not
//      come within `policy.firstLineMs` of the draft's end, or the whole pass
//      exceeds `policy.passMs`; a fix cut off with lines in hand is `refused`,
//      never `fixed`. An interruption by the user aborts it like any turn.
//   8. End the turn. The session log gets the review's brief, lines, usage
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

import { FIX_POLICY, contentOf, criticPrefers, draftFactsOf, fixKeeps, fixLineAllowed, isKeep, landsNoWorse, serializeLine, worthAFix, worthALook } from '@conduit/language';
import type {
  ContentCount,
  CriticFinding,
  FixPolicy,
  Line,
  LineProblem,
  PassState,
  PlacedBox,
  ReviewDecision,
  ReviewForm,
  ReviewOutcome,
  ReviewPolicy,
  Schedule,
  Sight,
  TurnInput,
} from '@conduit/language';
import { AppError } from '../errors';
import type { Logger } from '../log';
import type { Brain, BrainEvent, Snapshot } from './brain';
import type { Critic } from './critic';

/** What the painter said about a draft, as the conductor holds it while a look is decided. */
export interface DraftReport {
  readonly turn: string;
  readonly pass: number;
  readonly sight: Sight;
  readonly placed: readonly PlacedBox[];
  /** null when the painter could not take a picture, or it did not arrive in time */
  readonly picture: Snapshot | null;
  /** v2.1. What the painter counted on stage at the end of this pass (`contentOf`); null when it did not say */
  readonly content: ContentCount | null;
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
  receive(turn: string, pass: number, sight: Sight, placed: readonly PlacedBox[], pictureComing: boolean, content?: ContentCount): void;
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
  /** v2.1. Every fix that was tried, shown or not: what the session log's `fix` records are written from */
  readonly fixes: readonly FixAttempt[];
}

/** v2.1. One fix, or one refine pass, tried out of sight: what the brain wrote and what became of it. */
export interface FixAttempt {
  readonly pass: number;
  readonly form: ReviewForm;
  /** the lines the brain wrote and the fix could hold, as they would have been sent */
  readonly lines: readonly string[];
  readonly shown: boolean;
  /** why it was refused; null when it was shown */
  readonly why: string | null;
  readonly draft: ContentCount | null;
  readonly candidate: ContentCount | null;
}

interface Slot {
  report: { sight: Sight; placed: readonly PlacedBox[]; pictureComing: boolean; content: ContentCount | null } | null;
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
    receive(turn, pass, sight, placed, pictureComing, content) {
      const slot = slots.get(key(turn, pass));
      if (slot === undefined || slot.report !== null) return;
      slot.report = { sight, placed, pictureComing, content: content ?? null };
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
      const read = (): DraftReport | null => (slot.report === null ? null : { turn, pass, sight: slot.report.sight, placed: slot.report.placed, picture: slot.picture, content: slot.report.content });
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
  /**
   * v2.1. How a fix is sent to the painter to be tried (`candidate`): the lines, as text, for this pass. Present only when the painter
   * can try one (`Capabilities.candidates`). Absent: a draft that needs a fix gets none, never a redraw.
   */
  readonly candidate?: (pass: number, lines: readonly string[]) => void;
  /** v2.1. What a fix is held to; `FIX_POLICY` when left out */
  readonly fix?: FixPolicy;
  /** v2.1. A critic that compares the draft's picture with the candidate's in the background, after the fix is shown; only logged, never waited for */
  readonly critic?: Pick<Critic, 'compare'>;
  /** v2.1. `fix` (the default) or `refine` */
  readonly form?: ReviewForm;
  /** v2.1, `refine`: the passes asked for */
  readonly of?: number;
  /** v2.1. What the critic made of the picture the brain is about to be shown (a refine pass), handed to the brief as is */
  readonly finding?: Pick<CriticFinding, 'problems' | 'suggestions'> | null;
  /** v2.1. The conversation's standing asks, for the look to hold the draft to */
  readonly standing?: readonly string[];
}

/**
 * Runs the passes after a draft. Yields `pass` steps in order, the brain's
 * events for each fix (its lines only once the fix has been accepted), and
 * one `record` last (unless the turn was interrupted, when the generator
 * simply ends). Never throws.
 */
export async function* reviewTurn(args: ReviewTurnArgs): AsyncGenerator<ReviewStep> {
  const { brain, policy, gate, signal, now } = args;
  const fixPolicy = args.fix ?? FIX_POLICY;
  const form: ReviewForm = args.form ?? 'fix';
  const decisions: ReviewDecision[] = [];
  const fixes: FixAttempt[] = [];
  let costUsd: number | null = null;
  let firstLineMs: number | null = null;
  let written = 1;
  let result: ReviewOutcome['result'] = 'skipped';
  let why: string | null = null;
  let t0 = now();
  const record = (): ReviewStep => ({ type: 'record', record: { result, passes: written, why, decisions, firstLineMs, totalMs: now() - t0, costUsd, fixes } });

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
  if (args.candidate === undefined) {
    // A fix that cannot be tried first is never shown, and a model call spent on one would be wasted.
    decisions.push({ look: false, why: 'the painter cannot try a fix before showing it' });
    why = 'the painter cannot try a fix before showing it';
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
    const draftContent = report?.content ?? contentOf(state.schedule);
    const outcome = yield* collectFix(args, { pass: next, report, passStart, form });
    if (outcome.cost !== null) costUsd = (costUsd ?? 0) + outcome.cost;
    if (outcome.firstLineMs !== null && firstLineMs === null) firstLineMs = outcome.firstLineMs;
    if (signal.aborted) return;

    if (outcome.state === 'failed') {
      why = outcome.reason;
      if (result !== 'fixed') result = 'skipped';
      break;
    }
    if (outcome.state === 'abandoned') {
      // Cut at its deadline with lines in hand: it was never tried, so it is refused and the draft stands (P2-14), never "fixed".
      if (outcome.wrote > 0) {
        written += 1;
        if (result !== 'fixed') result = 'kept';
        why = outcome.reason;
        fixes.push({ pass: next, form, lines: outcome.texts, shown: false, why, draft: draftContent, candidate: null });
        yield { type: 'pass', pass: next, state: 'refused', reason: outcome.reason };
      } else {
        if (result !== 'fixed') result = 'skipped';
        why = outcome.reason;
        yield { type: 'pass', pass: next, state: 'skipped', reason: outcome.reason };
      }
      break;
    }
    if (outcome.wrote === 0) {
      written += 1;
      if (result !== 'fixed') result = 'kept';
      why = null;
      yield { type: 'pass', pass: next, state: 'kept', reason: null };
      break;
    }
    written += 1;
    if (outcome.lines.length === 0) {
      const refusal: string = REFUSALS.nothing;
      if (result !== 'fixed') result = 'kept';
      why = refusal;
      fixes.push({ pass: next, form, lines: [], shown: false, why: refusal, draft: draftContent, candidate: null });
      yield { type: 'pass', pass: next, state: 'refused', reason: refusal };
      break;
    }

    // Tried out of sight. Nothing below touches the turn's score or the stage until the three rules have said yes.
    gate.open(args.turn, next);
    yield { type: 'pass', pass: next, state: 'staged', reason: null };
    args.candidate(next, outcome.texts);
    const tried = await gate.wait(args.turn, next, fixPolicy.candidateWaitMs, signal);
    if (signal.aborted) return;
    const verdict = await judgeFix(args, { policy: fixPolicy, form, pass: next, draft: report, draftContent, tried });
    decisions.push({ look: verdict.refusal === null, why: verdict.refusal ?? 'the fix keeps what was there and lands no worse' });
    fixes.push({ pass: next, form, lines: outcome.texts, shown: verdict.refusal === null, why: verdict.refusal, draft: draftContent, candidate: tried?.content ?? null });
    if (signal.aborted) return;
    if (verdict.refusal !== null) {
      if (result !== 'fixed') result = 'kept';
      why = verdict.refusal;
      yield { type: 'pass', pass: next, state: 'refused', reason: verdict.refusal };
      break;
    }

    result = 'fixed';
    why = null;
    yield { type: 'pass', pass: next, state: 'fixing', reason: null };
    for (const line of outcome.lines) yield line;
    floor = wasSeq;
    pass = next;
    if (pass > policy.passes) break;
  }
  yield record();
}

/** What a refusal says, in the words the log, the battery's card and `pass … refused` carry. The first four are `FixRefusal`'s (`critic` is no longer given: the comparison runs after the fix is shown). */
const REFUSALS = {
  nothing: 'it wrote nothing that changes the stage',
  took: 'it took something away',
  worse: 'it landed worse than the draft',
  critic: 'the critic preferred the draft',
  late: 'it could not be tried in time',
} as const;

/** The three rules, in order. Pure apart from the critic's call, which has its own deadline. A refusal is the words to give; null is a yes. */
export async function judgeFix(
  args: ReviewTurnArgs,
  at: { policy: FixPolicy; form: ReviewForm; pass: number; draft: DraftReport | null; draftContent: ContentCount; tried: DraftReport | null },
): Promise<{ readonly refusal: string | null }> {
  const { tried } = at;
  if (tried === null || tried.content === null) return { refusal: REFUSALS.late };
  const keeps = fixKeeps(at.draftContent, tried.content, at.policy);
  if (!keeps.keeps) return { refusal: `${REFUSALS.took}: ${keeps.why ?? ''}`.trim() };
  const lands = landsNoWorse(at.draft?.sight ?? null, tried.sight);
  if (!lands.ok) return { refusal: `${REFUSALS.worse}: ${lands.why ?? ''}`.trim() };
  // Rule three is off the turn's clock. A comparison is one cold process with two pictures, and on the owner's critic (Fable, high effort)
  // it takes far longer than a viewer will wait: held to 8 s it never finished, and held every fix 8 s for nothing (v2.1 review, P1-2).
  // So the two rules above decide, the fix is shown at once, and the critic compares in the background; what it says is logged as
  // `review.compare` (outcome, both scores, ms) so the share of fixes it would have refused is measured, not guessed.
  const draftPicture = at.draft?.picture ?? null;
  if (args.critic !== undefined && draftPicture !== null && tried.picture !== null) {
    const started = args.now();
    const { turn, pass, form } = { turn: args.turn, pass: at.pass, form: at.form };
    void args.critic
      .compare({ session: args.session, turn, pass, asked: askedOf(args.input), input: args.input.kind, sight: tried.sight }, draftPicture, tried.picture, at.policy.compareMs, new AbortController().signal)
      .then((compared) => {
        const ms = args.now() - started;
        if (compared === null) args.log?.warn('review.compare', { turn, pass, outcome: 'unfinished', ms, deadlineMs: at.policy.compareMs });
        else args.log?.info('review.compare', { turn, pass, outcome: criticPrefers(compared.draft, compared.candidate, form) === 'draft' ? 'prefers-draft' : 'prefers-fix', draft: compared.draft.coherence, candidate: compared.candidate.coherence, ms });
      })
      .catch((error: unknown) => args.log?.warn('review.compare_failed', { turn, message: error instanceof Error ? error.message : String(error) }));
  }
  return { refusal: null };
}

interface CollectOutcome {
  /** `done`: the brain stopped by itself. `abandoned`: a deadline cut it off. `failed`: it threw. */
  readonly state: 'done' | 'abandoned' | 'failed';
  /** lines the brain wrote, of every kind, keeps and rejects left out */
  readonly wrote: number;
  /** the lines a fix may hold, as the brain's own events, ready to be forwarded once accepted */
  readonly lines: readonly BrainEvent[];
  /** the same lines as text, in the order written: what the painter is sent to try */
  readonly texts: readonly string[];
  readonly reason: string | null;
  readonly firstLineMs: number | null;
  readonly cost: number | null;
}

/**
 * One call of `brain.review` under its deadlines. Its lines are held, not yielded: only the brain's `brief`, `usage`, `activity` and
 * `permission` events pass through at once (the log and the bill must show the pass, and an agent's calls must be seen as they happen),
 * and a line a fix may not hold goes back as a `reject`, so the next brief says why it was dropped.
 */
async function* collectFix(args: ReviewTurnArgs, at: { pass: number; report: DraftReport | null; passStart: number; form: ReviewForm }): AsyncGenerator<ReviewStep, CollectOutcome> {
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

  const held: BrainEvent[] = [];
  const texts: string[] = [];
  let wrote = 0;
  let cost: number | null = null;
  let firstLineMs: number | null = null;
  let failure: string | null = null;
  let iterator: AsyncIterator<BrainEvent> | null = null;
  try {
    iterator = brain
      .review!(
        {
          turn: args.turn,
          session: args.session,
          pass: at.pass,
          input: args.input,
          sight: at.report?.sight ?? null,
          picture: at.report?.picture ?? null,
          problems: state.problems,
          styles: args.styles(),
          form: at.form,
          ...(at.report === null || at.report.placed.length === 0 ? {} : { placed: at.report.placed }),
          ...(args.finding === undefined ? {} : { critic: args.finding }),
          ...(args.of === undefined ? {} : { of: args.of }),
          ...(args.standing === undefined || args.standing.length === 0 ? {} : { standing: args.standing }),
        },
        controller.signal,
      )
      [Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([iterator.next(), stopped]);
      if (step === 'stopped' || step.done === true) break;
      const event = step.value;
      if (event.type === 'line') {
        if (wrote === 0) {
          clearTimeout(firstTimer);
          firstTimer = undefined;
          firstLineMs = now() - at.passStart;
        }
        wrote += 1;
        const allowed = fixLineAllowed(event.line);
        if (!allowed.allowed) {
          if (allowed.why !== null) yield rejectedFixLine(event.line, allowed.why);
          continue;
        }
        held.push(event);
        texts.push(serializeLine(event.line));
        continue;
      }
      if (event.type === 'usage') cost = event.usage.costUsd === null ? cost : (cost ?? 0) + event.usage.costUsd;
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
    // Whatever way it ended, the brain is told to let go; one that does not answer the abort is not waited for.
    controller.abort();
    if (iterator !== null) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }

  const collected = { wrote, lines: held, texts, firstLineMs, cost };
  if (signal.aborted) return { state: 'done', ...collected, reason: null };
  if (failure !== null) return { state: 'failed', ...collected, reason: `the look failed: ${failure}` };
  if (abandoned !== null) return { state: 'abandoned', ...collected, reason: abandoned };
  return { state: 'done', ...collected, reason: null };
}

function rejectedFixLine(line: Line, why: string): BrainEvent {
  return { type: 'reject', raw: serializeLine(line), issues: [{ code: 'nothing-to-do', severity: 'warn', message: why }] };
}

/** For callers that want to say a problem about a refused fix in the next brief. */
export function refusalProblem(reason: string): LineProblem {
  return { raw: 'the fix you wrote after looking', kind: 'rejected', why: `it was not shown: ${reason}` };
}
