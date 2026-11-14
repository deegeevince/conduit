// The meter. Money is counted from what each call reports, never from what it was expected to cost, and a call
// is not started unless the money for it is set aside first: the total cannot be passed by starting too much.
// A call that reports nothing is charged what was set aside for it (the honest worst case), never zero.
// On a subscription these dollars are the CLI's own estimate of usage, not a bill; they are the one number every call reports.

import type { LoopBudget } from './types';

export interface Reservation {
  readonly label: string;
  /** the most this call may spend: passed to the CLI as its own cap */
  readonly cap: number;
  settled: boolean;
}

export interface Spend {
  readonly label: string;
  readonly usd: number;
  readonly reported: boolean;
}

export class Meter {
  private readonly spends: Spend[] = [];
  private readonly open = new Set<Reservation>();
  private readonly started: number;

  constructor(
    readonly budget: LoopBudget,
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
  }

  get spent(): number {
    return this.spends.reduce((sum, spend) => sum + spend.usd, 0);
  }

  /** spent plus everything set aside for calls still running */
  get committed(): number {
    let held = 0;
    for (const reservation of this.open) held += reservation.cap;
    return this.spent + held;
  }

  get remaining(): number {
    return Math.max(0, this.budget.usd - this.committed);
  }

  get minutesLeft(): number {
    return this.budget.minutes - (this.now() - this.started) / 60_000;
  }

  get ledger(): readonly Spend[] {
    return this.spends;
  }

  /** Sets money aside, or says why it cannot. `want` is the estimate; the cap is never more than what is left. */
  reserve(label: string, want: number, floor = 0): Reservation | string {
    if (this.minutesLeft <= 0) return `out of time (${this.budget.minutes} minutes)`;
    const cap = Math.min(want, this.remaining);
    if (cap <= 0 || cap < floor) return `out of budget ($${this.spent.toFixed(2)} of $${this.budget.usd.toFixed(2)} spent; ${label} needs at least $${Math.max(floor, 0.01).toFixed(2)})`;
    const reservation: Reservation = { label, cap, settled: false };
    this.open.add(reservation);
    return reservation;
  }

  /** Records what the call reported (null: it reported nothing, so the whole reservation is charged). */
  settle(reservation: Reservation, reported: number | null): number {
    if (reservation.settled) return 0;
    reservation.settled = true;
    this.open.delete(reservation);
    const usd = reported ?? reservation.cap;
    this.spends.push({ label: reservation.label, usd, reported: reported !== null });
    return usd;
  }

  /** By how much the run is over its budget; 0 when it stayed within. */
  get overrun(): number {
    return Math.max(0, this.spent - this.budget.usd);
  }
}
