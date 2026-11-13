import type { RelayStatus } from '@conduit/language';
import type { BrainEvent, TurnRequest } from '../../domain/brain';
import { errors } from '../../errors';
import type { Logger } from '../../log';

export interface RelayHubDeps {
  readonly log: Logger;
  readonly now: () => number;
  /** a claimed turn that receives no lines for this long fails with `brain_timeout` */
  readonly idleTimeoutMs: number;
}

interface Entry {
  readonly request: TurnRequest;
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

  constructor(deps: RelayHubDeps) {
    this.deps = deps;
  }

  /**
   * Parks a turn until an agent claims it, then yields whatever the agent
   * appends until the agent ends the turn. Unclaimed turns wait without a
   * timeout: a user is allowed to wait for a human. Ends quietly on abort.
   */
  async *offer(request: TurnRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    const now = this.deps.now();
    const entry: Entry = {
      request,
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
