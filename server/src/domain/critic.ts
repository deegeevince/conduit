// The live critic: a judge that can see, asked about real turns.
//
// In v2 the only thing that ever looked at an answer with eyes was the exploration battery, on prompts nobody had asked. The owner's
// own turns were looked at by nobody: a diagram drawn twice, a caption over a ship, a flow missing from its own snapshot were found by
// the owner. From v2.1 every real turn that drew something is looked at, in the background, by the same judge with the same rubric
// the battery uses, so a finding in real use and a score in a measured run mean the same thing.
//
// The domain owns this interface. The judge behind it is `claude` on the owner's login (`server/src/judge/`), the one place a
// judgement is asked for, shared with the battery. No key, no paid service.
//
// Contract:
// - `look` never runs on the turn's path. The conductor calls it after `end` has been sent and the resting snapshot has arrived, and
//   does not wait for it. A critic that is slow, fails or is switched off changes nothing a viewer sees.
// - One look at a time per session; a newer turn's look replaces an older one that has not started. At most `CriticPolicy.perHour`.
// - `compare` is never waited for. Look-and-fix shows a fix on the two pure rules and starts the comparison in the background, under
//   `FixPolicy.compareMs`: it is shown two pictures in one message, in an order it is not told, and says which is better; the answer
//   is logged (`review.compare`). Past the deadline it resolves null and the timeout is logged. It counts against `perHour`.
// - Never throws. A finding it could not make is null, and the reason is logged once.
// - What it is shown is the picture and the user's words. Never a document, a pasted table, an upload, or anything a tool returned.
// - Critic v2: every verdict is made in a fresh process with clean context: the person's words, the fixed gates, the picture, the
//   painter's measurements; never the brain's reasoning, brief or prompt. A turn that revised the same answer in place is also shown the
//   previous picture and the critic's own verdict on it. Gates are tiered (on stage and readable; answers the ask; polish): a note of a
//   higher tier is logged but not raised while a lower tier fails. Each problem names its gate, its evidence and who owns the fix.

import type { CriticFinding, Sight, TurnInput } from '@conduit/language';
import type { Snapshot } from './brain';

export interface CriticPolicy {
  readonly enabled: boolean;
  /** passed to `claude --model` and `--effort`; a judge a size below the brain is the default, never the same process */
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  /** turns it looks at in an hour, at most: a ceiling on what real use can spend on being judged */
  readonly perHour: number;
  /** ms one look may take before it is given up */
  readonly lookMs: number;
  /** below this coherence a finding is queued for the loop as evidence (`loop/queue/`) */
  readonly queueBelow: number;
}

/**
 * Whether a finding is evidence worth keeping for the loop: a low score AND a problem that blocks, or at least two that hurt. A critic that
 * queued five turns of six, one of them on a fact it had wrong about itself, taught the loop noise (v2.1 review, P1-9).
 */
export function worthQueuing(finding: Pick<CriticFinding, 'coherence' | 'problems'>, queueBelow: number): boolean {
  if (finding.coherence >= queueBelow) return false;
  const blocks = finding.problems.filter((problem) => problem.weight === 'blocks').length;
  const hurts = finding.problems.filter((problem) => problem.weight === 'hurts').length;
  return blocks >= 1 || hurts >= 2;
}

export const CRITIC_POLICY: CriticPolicy = { enabled: true, model: 'sonnet', effort: 'low', perHour: 60, lookMs: 45_000, queueBelow: 4 };

/** What the critic is asked about: one resting picture and what was asked for. */
export interface CriticRequest {
  readonly session: string;
  readonly turn: string;
  readonly pass: number;
  /** the user's words, cut as the review brief cuts them (`askedOf`); for a tap or a control, what it said */
  readonly asked: string;
  readonly input: TurnInput['kind'];
  readonly picture: Snapshot;
  /** what the painter measured, so that the critic's problems can name ids */
  readonly sight: Sight | null;
  /** critic v2: the answer is a mock-up (a `screen` on stage at rest): the worst-case gate is asked, as a note */
  readonly mockup?: boolean;
  /** critic v2: this turn revised the same answer in place; the picture the critic saw before, and what it said of it. Never what the brain was told or thought. */
  readonly previous?: { readonly picture: Snapshot; readonly finding: CriticFinding } | null;
}

export interface CriticComparison {
  /** each picture judged by the same rubric, in the one call */
  readonly draft: CriticFinding;
  readonly candidate: CriticFinding;
}

export interface Critic {
  readonly available: boolean;
  /** Looks at one resting picture. Resolves null when it is off, over its hourly ceiling, out of time, or could not read the judge's answer twice. */
  look(request: CriticRequest, signal: AbortSignal): Promise<CriticFinding | null>;
  /** Looks at a draft and a candidate together, blind to which is which. Resolves null at `deadlineMs`. */
  compare(request: Omit<CriticRequest, 'picture'>, draft: Snapshot, candidate: Snapshot, deadlineMs: number, signal: AbortSignal): Promise<CriticComparison | null>;
  /** v2.1 ops, the kill switch: abandons every look and comparison in flight and every one waiting; the critic goes on to serve the next. */
  cancel?(): void;
  close(): Promise<void>;
}

/** The critic that is used when `CRITIC=off`, and until package S3 has built the real one. */
export const NO_CRITIC: Critic = {
  available: false,
  look: async () => null,
  compare: async () => null,
  close: async () => undefined,
};

/**
 * Where findings wait for the improvement loop: one JSON line each, appended to `loop/queue/findings.jsonl` (not tracked). The loop's
 * critic agent reads them as evidence from real use beside the tune set's judgements. A queued finding carries the session log's file
 * name and the turn, never the conversation's text beyond the user's words for that turn.
 */
export interface FindingQueue {
  add(entry: { readonly at: string; readonly log: string; readonly turn: string; readonly asked: string; readonly finding: CriticFinding; readonly snapshot: string | null }): void;
}

export const NO_FINDING_QUEUE: FindingQueue = { add: () => undefined };
