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
//      anywhere, so the draft stands exactly as it was. A refusal is not
//      the end while the pass has time: the brain is told why (and what the
//      candidate would have left wrong, as a rejected line of its brief) and writes
//      another, as long as `policy.passMs` from the first call allows and each
//      try leaves fewer things not landing than the one before (the first
//      refusal always earns a second). Only the first try the rules accept is
//      shown; `pass … refused` is said once, when the last try is thrown out. A painter that cannot
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

import { FIX_POLICY, blockingCount, contentOf, retryProblem, criticPrefers, draftFactsOf, fixKeeps, fixLineAllowed, isKeep, landsNoWorse, repairKeeps, serializeLine, worthAFix, worthALook } from '@conduit/language';
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
import type { Measured } from './stage-facts';

/** SA2. How long a measured draft with free drawing waits for the page's picture before the look goes text-only. */
export const PICTURE_GRACE_MS = 1500;

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
  /** SA2. The picture of this pass if it has already arrived, else null. Never waits. */
  peek(turn: string, pass: number): Snapshot | null;
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
  /** the brain was told why it was thrown out and asked for another: this was not the last word on the draft */
  readonly retried?: boolean;
  /** how many things the stage's measure said did not land, in the draft and with this fix tried (null when it was not tried): what the verdict was made from */
  readonly blocking?: FixBlocking;
}

/** What a fix was held to by the measure: things not landing in the draft, and in the draft with the fix on it. */
export interface FixBlocking {
  readonly draft: number;
  readonly candidate: number | null;
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
    peek(turn, pass) {
      return slots.get(key(turn, pass))?.picture ?? null;
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
  /** v3 art. The ids of what the art shelf drew (figures, parts, placeholders, captions): not free drawing */
  readonly shelf?: ReadonlySet<string>;
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
  /**
   * SA2. The server's own measurement of the turn's draft as it stands (`stage-facts`), for the screen and look in force. Present only for
   * a session whose engine is the server's; `null` (a leaf threw, a photo only the page can size, or the session has drifted) falls
   * back to the gate for that pass. A measured draft is never waited on the browser for: its picture is attached only if it has already
   * arrived and the draft has drawing, and its fix is tried here (`tryFix`), not sent to the page.
   */
  readonly measure?: (pass: number) => Measured | null;
  /** SA2. A fix tried on a copy of the turn's score, here; `null` as for `measure` */
  readonly tryFix?: (pass: number, lines: readonly string[]) => { readonly measured: Measured; readonly rejects: readonly unknown[] } | null;
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
  /** v3, `repair`: the brain's EYES digest, handed to the brief */
  readonly eyes?: string | null;
  /** v3, `repair`: the answer's own lines, as written */
  readonly written?: readonly string[];
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
  const before = worthALook(draftFactsOf(first.schedule, first.rejects, 0, first.shelf), policy);
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
  if (args.candidate === undefined && args.measure === undefined) {
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
    const facts = draftFactsOf(state.schedule, state.rejects, floor, state.shelf);
    if (pass === 1) t0 = now();
    const passStart = now();
    gate.open(args.turn, pass);
    const draftedAt = now();
    yield { type: 'pass', pass, state: 'drafted', reason: null };
    // SA2: the facts are measured here, at once; only a session that cannot be measured waits on the page.
    const measured = args.measure === undefined ? null : args.measure(pass);
    // The picture gets a short grace, only when something free is drawn to judge: it is attached if it comes within PICTURE_GRACE_MS and the look goes text-only if not.
    let picture: Snapshot | null = null;
    if (measured !== null && facts.drawn >= policy.minDrawn) {
      const until = now() + PICTURE_GRACE_MS;
      picture = gate.peek(args.turn, pass);
      while (picture === null && now() < until && !signal.aborted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        picture = gate.peek(args.turn, pass);
      }
      const waitedMs = Math.round(now() - draftedAt);
      if (picture !== null) args.log?.info('review.picture', { turn: args.turn, pass, picture: 'attached', waitedMs });
      else {
        // Text-only; whether it came at all afterwards is logged too, so the rate of late pictures is seen.
        void gate.wait(args.turn, pass, 6000, signal).then((later) => args.log?.info('review.picture', { turn: args.turn, pass, picture: later?.picture != null ? 'late' : 'none', waitedMs }));
      }
    } else if (measured !== null) {
      args.log?.info('review.picture', { turn: args.turn, pass, picture: 'none', waitedMs: 0, why: 'nothing free drawn' });
    }
    const report: DraftReport | null =
      measured !== null
        ? { turn: args.turn, pass, sight: measured.sight, placed: measured.placed, picture, content: measured.content }
        : await gate.wait(args.turn, pass, policy.draftWaitMs, signal);
    if (signal.aborted) return;
    // A measured draft that has free drawing is worth a look whether or not its picture has come: the picture is a bonus, never waited for.
    const fix = worthAFix(facts, report?.sight ?? null, report?.picture != null || (measured !== null && facts.drawn >= policy.minDrawn), policy);
    decisions.push(fix);
    if (!fix.look) {
      why = fix.why;
      yield { type: 'pass', pass, state: 'skipped', reason: fix.why };
      break;
    }

    const next = pass + 1;
    args.log?.info('review.decided', { turn: args.turn, pass, measured: measured !== null, draftedToLookingMs: Math.round(now() - draftedAt), ms: measured === null ? null : Math.round(measured.ms * 10) / 10 });
    yield { type: 'pass', pass: next, state: 'looking', reason: null };
    const wasSeq = args.state().lastSeq;
    const draftContent = report?.content ?? contentOf(state.schedule);
    // A fix that is thrown out is told back to the brain, with what it would have left wrong, and it writes another, while the pass's own time
    // (`policy.passMs`, from the first call) allows and each try is nearer than the last. Nothing is shown until a try is accepted.
    const triesFrom = now();
    const thrown: LineProblem[] = [];
    let lastAfter: number | null = null;
    let verdictLeft: string | null = null;
    let accepted = false;
    for (let attempt = 1; ; attempt += 1) {
      const left = policy.passMs - (now() - triesFrom);
      const outcome = yield* collectFix(args, { pass: next, report, passStart: attempt === 1 ? passStart : now(), form, extra: thrown, passMs: Math.max(1, left) });
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
          fixes.push({ pass: next, form, lines: outcome.texts, shown: false, why, draft: draftContent, candidate: null, blocking: { draft: blockingCount(report?.sight ?? null), candidate: null } });
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
        why = attempt === 1 ? null : verdictLeft;
        yield { type: 'pass', pass: next, state: attempt === 1 ? 'kept' : 'refused', reason: attempt === 1 ? null : verdictLeft };
        break;
      }
      written += 1;

      // Tried out of sight. Nothing below touches the turn's score or the stage until the three rules have said yes.
      let refusal: string | null = null;
      let tried: DraftReport | null = null;
      let here: ReturnType<NonNullable<ReviewTurnArgs['tryFix']>> = null;
      if (outcome.lines.length === 0) {
        refusal = REFUSALS.nothing;
      } else {
        gate.open(args.turn, next);
        yield { type: 'pass', pass: next, state: 'staged', reason: null };
        here = measured !== null && args.tryFix !== undefined ? args.tryFix(next, outcome.texts) : null;
        if (here !== null) {
          // SA2: tried on a copy of the turn's score, here. The page is not asked.
          tried = { turn: args.turn, pass: next, sight: here.measured.sight, placed: here.measured.placed, picture: null, content: here.measured.content };
          args.log?.info('review.tried', { turn: args.turn, pass: next, attempt, ms: Math.round(here.measured.ms * 10) / 10, rejects: here.rejects.length });
        } else if (args.candidate !== undefined) {
          args.candidate(next, outcome.texts);
          tried = await gate.wait(args.turn, next, fixPolicy.candidateWaitMs, signal);
        }
        if (signal.aborted) return;
        const verdict = await judgeFix(args, { policy: fixPolicy, form, pass: next, draft: report, draftContent, tried });
        refusal = verdict.refusal;
        // A fix tried here has no picture of its own. When the draft has one and the critic is on, the page is asked for the candidate's picture
        // alone, after the fix is shown and off the turn's clock, and the critic compares the two in the background.
        if (here !== null && refusal === null && args.critic !== undefined && args.candidate !== undefined && report?.picture != null) {
          const draftPicture = report.picture;
          const triedSight = here.measured.sight;
          args.candidate(next, outcome.texts);
          void gate.wait(args.turn, next, fixPolicy.compareMs, signal).then((late) => {
            if (late?.picture != null) startCompare(args, { policy: fixPolicy, form, pass: next, draftPicture, candidatePicture: late.picture, sight: triedSight });
          });
        }
        decisions.push({ look: refusal === null, why: refusal ?? 'the fix keeps what was there and lands no worse' });
      }
      if (signal.aborted) return;

      let again = false;
      if (refusal !== null) {
        // Another try, when the time allows and the last one came nearer: the first refusal always earns a second.
        const after = tried === null ? null : blockingCount(tried.sight);
        const improving = attempt === 1 || (after !== null && lastAfter !== null && after < lastAfter);
        const remaining = policy.passMs - (now() - triesFrom);
        again = refusal !== REFUSALS.late && improving && remaining >= Math.min(policy.firstLineMs, policy.passMs / 2) && !signal.aborted;
        fixes.push({ pass: next, form, lines: outcome.texts, shown: false, why: refusal, draft: draftContent, candidate: tried?.content ?? null, retried: again, blocking: { draft: blockingCount(report?.sight ?? null), candidate: tried === null ? null : blockingCount(tried.sight) } });
        if (again) {
          thrown.push(retryProblem(attempt, outcome.texts, refusal, tried?.sight ?? null));
          lastAfter = after ?? lastAfter;
          verdictLeft = refusal;
          yield { type: 'pass', pass: next, state: 'looking', reason: `trying again: ${refusal}` };
          continue;
        }
        if (result !== 'fixed') result = 'kept';
        why = refusal;
        yield { type: 'pass', pass: next, state: 'refused', reason: refusal };
        break;
      }

      fixes.push({ pass: next, form, lines: outcome.texts, shown: true, why: null, draft: draftContent, candidate: tried?.content ?? null, blocking: { draft: blockingCount(report?.sight ?? null), candidate: tried === null ? null : blockingCount(tried.sight) } });
      result = 'fixed';
      why = null;
      yield { type: 'pass', pass: next, state: 'fixing', reason: null };
      for (const line of outcome.lines) yield line;
      floor = wasSeq;
      pass = next;
      accepted = true;
      break;
    }
    if (!accepted || pass > policy.passes) break;
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
  if (draftPicture !== null && tried.picture !== null) startCompare(args, { policy: at.policy, form: at.form, pass: at.pass, draftPicture, candidatePicture: tried.picture, sight: tried.sight });
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
export async function* collectFix(args: ReviewTurnArgs, at: { pass: number; report: DraftReport | null; passStart: number; form: ReviewForm; extra?: readonly LineProblem[]; passMs?: number }): AsyncGenerator<ReviewStep, CollectOutcome> {
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
  const passMs = at.passMs ?? policy.passMs;
  const passTimer = setTimeout(() => abandon(`the fix took longer than ${passMs} ms`), passMs);
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
          problems: at.extra === undefined || at.extra.length === 0 ? state.problems : [...state.problems, ...at.extra],
          styles: args.styles(),
          form: at.form,
          ...(at.report === null || at.report.placed.length === 0 ? {} : { placed: at.report.placed }),
          ...(args.finding === undefined ? {} : { critic: args.finding }),
          ...(args.of === undefined ? {} : { of: args.of }),
          ...(args.standing === undefined || args.standing.length === 0 ? {} : { standing: args.standing }),
          ...(args.eyes === undefined ? {} : { eyes: args.eyes }),
          ...(args.written === undefined ? {} : { written: args.written }),
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
        const allowed = fixLineAllowed(event.line, state.schedule);
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

/** The critic compares the draft's picture with the candidate's, in the background; what it says is logged as `review.compare`. */
function startCompare(args: ReviewTurnArgs, at: { policy: FixPolicy; form: ReviewForm; pass: number; draftPicture: Snapshot; candidatePicture: Snapshot; sight: Sight }): void {
  if (args.critic === undefined) return;
  const started = args.now();
  const { turn, pass, form } = { turn: args.turn, pass: at.pass, form: at.form };
  void args.critic
    .compare({ session: args.session, turn, pass, asked: askedOf(args.input), input: args.input.kind, sight: at.sight }, at.draftPicture, at.candidatePicture, at.policy.compareMs, new AbortController().signal)
    .then((compared) => {
      const ms = args.now() - started;
      if (compared === null) args.log?.warn('review.compare', { turn, pass, outcome: 'unfinished', ms, deadlineMs: at.policy.compareMs });
      else args.log?.info('review.compare', { turn, pass, outcome: criticPrefers(compared.draft, compared.candidate, form) === 'draft' ? 'prefers-draft' : 'prefers-fix', draft: compared.draft.coherence, candidate: compared.candidate.coherence, ms });
    })
    .catch((error: unknown) => args.log?.warn('review.compare_failed', { turn, message: error instanceof Error ? error.message : String(error) }));
}

// ---------------------------------------------------------------- v3: critic-driven repair

/** What one repair pass came to, once the brain has written and the lines have been tried. */
export interface RepairOutcome {
  /** `kept`: tried and better, to be shown. `refused`: tried and not kept. `nothing`: the brain wrote nothing to change, or `ok`. `failed`: it threw, was cut off, or could not be tried. */
  readonly state: 'kept' | 'refused' | 'nothing' | 'failed';
  readonly why: string | null;
  /** the lines to show, as the brain's own events, when kept */
  readonly lines: readonly BrainEvent[];
  /** every line the brain wrote and a fix may hold, as text */
  readonly texts: readonly string[];
  readonly costUsd: number | null;
  readonly firstLineMs: number | null;
  /** how many things did not land, by the stage's measure: at rest, and with the fix tried; null when it was not tried */
  readonly blockingBefore: number;
  readonly blockingAfter: number | null;
  readonly tryMs: number | null;
}

export interface RepairArgs extends ReviewTurnArgs {
  /** the stage as the answer rests, measured here: the baseline a repair has to beat */
  readonly rest: Measured;
  /** the picture of the answer at rest, the one the critic judged */
  readonly picture: Snapshot | null;
}

/**
 * One repair pass. The brain, in the conversation that wrote the answer, is told what the critic found (and the EYES digest) and writes fix
 * lines; they are tried on a copy of the answer's score, here, and kept only by `repairKeeps`. Its lines are held, not yielded: the caller
 * shows them if the outcome says `kept`. Yields only the brain's `brief`, `usage`, `activity` events (for the log and the bill). Never throws.
 */
export async function* repairTurn(args: RepairArgs): AsyncGenerator<ReviewStep, RepairOutcome> {
  const { rest } = args;
  const before = blockingCount(rest.sight);
  const fail = (why: string, more: Partial<RepairOutcome> = {}): RepairOutcome => ({ state: 'failed', why, lines: [], texts: [], costUsd: null, firstLineMs: null, blockingBefore: before, blockingAfter: null, tryMs: null, ...more });
  if (args.brain.review === undefined) return fail('this brain cannot look');
  if (args.tryFix === undefined) return fail('the stage cannot be measured here, so a repair cannot be tried');
  const report: DraftReport = { turn: args.turn, pass: 2, sight: rest.sight, placed: rest.placed, picture: args.picture, content: rest.content };
  const collected = yield* collectFix(args, { pass: 2, report, passStart: args.now(), form: 'repair' });
  const common = { costUsd: collected.cost, firstLineMs: collected.firstLineMs, texts: collected.texts };
  if (args.signal.aborted) return fail('cancelled', common);
  if (collected.state === 'failed') return fail(collected.reason ?? 'the look failed', common);
  if (collected.state === 'abandoned') return fail(collected.reason ?? 'the repair took too long', common);
  if (collected.wrote === 0) return { state: 'nothing', why: 'the brain saw nothing it could mend with lines', lines: [], blockingBefore: before, blockingAfter: null, tryMs: null, ...common };
  if (collected.lines.length === 0) return { state: 'refused', why: REFUSALS.nothing, lines: [], blockingBefore: before, blockingAfter: null, tryMs: null, ...common };
  const started = args.now();
  const tried = args.tryFix(2, collected.texts);
  const tryMs = Math.round(args.now() - started);
  if (tried === null) return fail('it could not be tried', { ...common, tryMs });
  const verdict = repairKeeps({ content: rest.content, sight: rest.sight }, { content: tried.measured.content, sight: tried.measured.sight });
  const after = blockingCount(tried.measured.sight);
  args.log?.info('repair.tried', { turn: args.turn, before, after, rejects: tried.rejects.length, ms: Math.round(tried.measured.ms * 10) / 10, keeps: verdict.keeps });
  if (!verdict.keeps) return { state: 'refused', why: verdict.why, lines: [], blockingBefore: before, blockingAfter: after, tryMs, ...common };
  return { state: 'kept', why: null, lines: collected.lines, blockingBefore: before, blockingAfter: after, tryMs, ...common };
}
