// Look and fix, as the conductor runs it. STUB: the contract is here; the
// pass is not yet run (PLAN-v2.md, package S1).
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
//      come within `policy.firstLineMs`, or the whole pass exceeds
//      `policy.passMs`. An interruption by the user aborts it like any turn.
//   7. End the turn. The session log gets the review's brief, lines, usage
//      and outcome; `TurnMemory.review` records it for the next brief.
//
// Only the conductor calls this. The exploration battery calls the same
// functions through `explore-turn.ts`, so that a measured run and a live turn
// cannot drift apart.

import type { PlacedBox, ReviewDecision, ReviewOutcome, ReviewPolicy, Sight } from '@conduit/language';
import type { Snapshot } from './brain';

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

export function createDraftGate(): DraftGate {
  // STUB: nothing waits and nothing arrives, so every look is decided without a report and skipped.
  return {
    open() {},
    receive() {},
    receivePicture() {},
    wait: () => Promise.resolve(null),
    close() {},
  };
}

/** The policy in force: the language's defaults, with what the environment overrides. */
export function reviewPolicyFrom(base: ReviewPolicy, overrides: Partial<ReviewPolicy>): ReviewPolicy {
  return { ...base, ...overrides };
}
