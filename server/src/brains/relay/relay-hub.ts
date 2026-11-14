import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewBrief, isKeep } from '@conduit/language';
import type { RelayStatus } from '@conduit/language';
import { askedOf } from '../../domain/review';
import type { BrainEvent, ReviewRequest, TurnRequest } from '../../domain/brain';
import { errors } from '../../errors';
import type { Logger } from '../../log';

export interface RelayHubDeps {
  readonly log: Logger;
  readonly now: () => number;
  /** a claimed turn that receives no lines for this long fails with `brain_timeout` */
  readonly idleTimeoutMs: number;
}

/** A look at a draft, offered to the agent that claimed the turn: what it is told, and where the picture of the draft is. */
export interface ReviewOffer {
  readonly pass: number;
  /** `buildReviewBrief`, then a line naming the file the picture is in */
  readonly brief: string;
  readonly picturePath: string | null;
}

interface Entry {
  readonly request: TurnRequest;
  readonly review?: ReviewOffer;
  readonly signal: AbortSignal;
  readonly offeredAt: number;
  state: 'pending' | 'claimed';
  claimedAt: number;
  lastActivity: number;
  queue: BrainEvent[];
  ended: boolean;
  /** wakes the offering generator so it re-reads the entry */
  wake: (() => void) | null;
  /** resolved when every queued event has been taken by the consumer */
  drains: (() => void)[];
}

interface Claimer {
  readonly resolve: (request: TurnRequest | null) => void;
}

const REMEMBERED_CLOSED = 200;
const REMEMBERED_REQUESTS = 40;

/**
 * The meeting point between a turn that needs a brain and an outside agent
 * that wants to be one. The relay brain parks turns here; the relay routes
 * let an agent claim one and feed it lines.
 */
export class RelayHub {
  private readonly deps: RelayHubDeps;
  private readonly entries = new Map<string, Entry>();
  /** unclaimed turns, oldest first */
  private readonly pending: Entry[] = [];
  private readonly claimers: Claimer[] = [];
  private readonly closed = new Set<string>();
  /** the request each recent turn was offered with, so that a look at its draft can be offered with the same context */
  private readonly offered = new Map<string, TurnRequest>();

  constructor(deps: RelayHubDeps) {
    this.deps = deps;
  }

  /**
   * Parks a turn until an agent claims it, then yields whatever the agent
   * appends until the agent ends the turn. Unclaimed turns wait without a
   * timeout: a user is allowed to wait for a human. Ends quietly on abort.
   */
  async *offer(request: TurnRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    this.offered.set(request.turn, request);
    if (this.offered.size > REMEMBERED_REQUESTS) {
      const oldest = this.offered.keys().next();
      if (oldest.done !== true) this.offered.delete(oldest.value);
    }
    yield* this.park(request, signal, undefined);
  }

  /**
   * A look at the draft of a turn this hub offered, put to whoever claimed the turn (or to the next to claim: the steward's session
   * answers it as it answered the turn). It is claimed like a turn, answered with lines like one (`pnpm relay say`), and ended like one.
   * What it is told is `buildReviewBrief`'s message, the same for every brain, and the file the picture of the draft was written to.
   */
  async *offerReview(request: ReviewRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    const original = this.offered.get(request.turn);
    if (original === undefined) throw errors.brainFailed(`the relay no longer holds turn ${request.turn} to look at it`);
    let picturePath: string | null = null;
    if (request.picture !== null) {
      const dir = join(tmpdir(), 'conduit-relay');
      mkdirSync(dir, { recursive: true });
      picturePath = join(dir, `${request.turn}-pass${request.pass}.${request.picture.mime === 'image/png' ? 'png' : 'jpg'}`);
      writeFileSync(picturePath, request.picture.bytes);
    }
    const text = buildReviewBrief({
      asked: askedOf(request.input),
      sight: request.sight,
      problems: request.problems,
      picture: request.picture !== null,
      pass: request.pass,
      ...(request.form === undefined ? {} : { form: request.form }),
      ...(request.placed === undefined ? {} : { placed: request.placed }),
      ...(request.critic === undefined ? {} : { critic: request.critic }),
      ...(request.of === undefined ? {} : { of: request.of }),
      ...(request.standing === undefined ? {} : { standing: request.standing }),
    });
    const brief = picturePath === null ? text : `${text}\n\nTHE PICTURE OF THE DRAFT is the file ${picturePath} (read it to see it).`;
    try {
      yield { type: 'brief', form: 'since', text: brief, system: null, withSnapshot: request.picture !== null };
      for await (const event of this.park(original, signal, { pass: request.pass, brief, picturePath })) {
        // `ok`, alone on a line, is the draft kept: it is not a line and not a rejection.
        if (event.type === 'reject' && isKeep(event.raw)) continue;
        yield event;
      }
    } finally {
      if (picturePath !== null) rmSync(picturePath, { force: true });
    }
  }

  /** The look being asked of whoever claims this turn now, for the relay route to tell the claimer (it answers the turn's own brief otherwise). */
  reviewOf(turn: string): ReviewOffer | null {
    return this.entries.get(turn)?.review ?? null;
  }

  private async *park(request: TurnRequest, signal: AbortSignal, review: ReviewOffer | undefined): AsyncGenerator<BrainEvent> {
    const now = this.deps.now();
    const entry: Entry = {
      request,
      ...(review === undefined ? {} : { review }),
      signal,
      offeredAt: now,
      state: 'pending',
      claimedAt: now,
      lastActivity: now,
      queue: [],
      ended: false,
      wake: null,
      drains: [],
    };
    const poke = (): void => entry.wake?.();
    signal.addEventListener('abort', poke);
    this.entries.set(request.turn, entry);
    this.pending.push(entry);
    this.handOut();
    try {
      while (!signal.aborted) {
        const next = entry.queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        this.settleDrains(entry);
        if (entry.ended) return;
        await this.sleep(entry);
        if (entry.state === 'claimed' && this.deps.now() - entry.lastActivity >= this.deps.idleTimeoutMs && entry.queue.length === 0 && !entry.ended) {
          this.deps.log.warn('relay.idle_timeout', { turn: request.turn, idleMs: this.deps.now() - entry.lastActivity });
          throw errors.brainTimeout(`the agent that claimed ${request.turn} wrote nothing for ${Math.round(this.deps.idleTimeoutMs / 1000)}s`);
        }
      }
    } finally {
      signal.removeEventListener('abort', poke);
      this.entries.delete(request.turn);
      const index = this.pending.indexOf(entry);
      if (index >= 0) this.pending.splice(index, 1);
      this.closed.add(request.turn);
      if (this.closed.size > REMEMBERED_CLOSED) {
        const oldest = this.closed.values().next();
        if (oldest.done !== true) this.closed.delete(oldest.value);
      }
      this.settleDrains(entry);
    }
  }

  /** The oldest unclaimed turn, waiting up to `waitMs` for one to appear. Null on timeout or abort. */
  claim(waitMs: number, signal: AbortSignal): Promise<TurnRequest | null> {
    const first = this.takePending();
    if (first !== null) return Promise.resolve(first);
    if (waitMs <= 0 || signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const claimer: Claimer = {
        resolve: (request) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(request);
        },
      };
      // Leaving the queue synchronously on disconnect is what keeps a dead long-poll from swallowing the next turn.
      const leave = (): void => {
        const index = this.claimers.indexOf(claimer);
        if (index >= 0) this.claimers.splice(index, 1);
        claimer.resolve(null);
      };
      const onAbort = leave;
      const timer = setTimeout(leave, waitMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.claimers.push(claimer);
    });
  }

  /** Puts a claimed turn back at the front of the queue, for a claim whose answer could not be delivered. */
  release(turn: string): void {
    const entry = this.entries.get(turn);
    if (entry === undefined || entry.state !== 'claimed' || entry.queue.length > 0 || entry.signal.aborted) return;
    entry.state = 'pending';
    this.pending.unshift(entry);
    this.deps.log.info('relay.released', { turn });
    this.handOut();
  }

  /** Hands the agent's lines to the waiting turn. Throws `not_found` or `turn_closed`. */
  append(turn: string, events: readonly BrainEvent[]): void {
    const entry = this.live(turn);
    entry.lastActivity = this.deps.now();
    entry.queue.push(...events);
    entry.wake?.();
  }

  /** The agent is done with this turn. Idempotent. */
  end(turn: string): void {
    const entry = this.entries.get(turn);
    if (entry === undefined) return;
    entry.ended = true;
    entry.wake?.();
  }

  /** Resolves once everything appended so far has been taken in by the turn, or the turn closed. */
  drained(turn: string): Promise<void> {
    const entry = this.entries.get(turn);
    if (entry === undefined || (entry.queue.length === 0 && entry.wake !== null)) return Promise.resolve();
    return new Promise((resolve) => entry.drains.push(resolve));
  }

  status(): RelayStatus {
    const now = this.deps.now();
    const pending = this.pending.map((entry) => ({
      turn: entry.request.turn,
      session: entry.request.session,
      input: entry.request.input,
      waitingMs: now - entry.offeredAt,
    }));
    const claimed = [...this.entries.values()]
      .filter((entry) => entry.state === 'claimed')
      .map((entry) => ({ turn: entry.request.turn, session: entry.request.session, idleMs: now - entry.lastActivity }));
    return { pending, claimed };
  }

  private live(turn: string): Entry {
    const entry = this.entries.get(turn);
    if (entry === undefined) {
      if (this.closed.has(turn)) throw errors.turnClosed(turn, 'it has ended');
      throw errors.notFound(`relay turn ${turn}`);
    }
    if (entry.signal.aborted) throw errors.turnClosed(turn, 'the user interrupted it');
    if (entry.ended) throw errors.turnClosed(turn, 'it has ended');
    if (entry.state === 'pending') throw errors.badRequest(`turn ${turn} has not been claimed; POST /api/relay/next first`);
    return entry;
  }

  private takePending(): TurnRequest | null {
    for (;;) {
      const entry = this.pending.shift();
      if (entry === undefined) return null;
      if (entry.signal.aborted) continue;
      const now = this.deps.now();
      entry.state = 'claimed';
      entry.claimedAt = now;
      entry.lastActivity = now;
      this.deps.log.info('relay.claimed', { turn: entry.request.turn, waitedMs: now - entry.offeredAt });
      entry.wake?.();
      return entry.request;
    }
  }

  private handOut(): void {
    while (this.claimers.length > 0 && this.pending.length > 0) {
      const request = this.takePending();
      const claimer = this.claimers.shift();
      if (request === null || claimer === undefined) break;
      claimer.resolve(request);
    }
  }

  private sleep(entry: Entry): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(timer);
        entry.wake = null;
        resolve();
      };
      entry.wake = done;
      if (entry.state === 'claimed') {
        const remaining = Math.max(0, entry.lastActivity + this.deps.idleTimeoutMs - this.deps.now());
        timer = setTimeout(done, remaining);
      }
    });
  }

  private settleDrains(entry: Entry): void {
    const waiting = entry.drains;
    entry.drains = [];
    for (const resolve of waiting) resolve();
  }
}
