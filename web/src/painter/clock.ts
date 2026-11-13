import type { ClockState } from '@conduit/language';

export interface ClockReading {
  readonly state: ClockState;
  /** seconds on the turn clock */
  readonly playhead: number;
  /** seconds that keep running while the playhead holds */
  readonly ambient: number;
  /** ms since the epoch; frozen while paused */
  readonly wallTime: number;
  readonly hidden: boolean;
  /** ambient seconds at which the current wait or hold began; null when not waiting or holding */
  readonly holdSince: number | null;
}

/** How far the playhead may go right now. */
export interface Horizon {
  readonly pen: number;
  readonly end: number;
  /** true while the brain may still write; the playhead then holds at the pen */
  readonly open: boolean;
  /**
   * false while the renderer cannot yet draw everything in the frame it last
   * rendered (glyphs still being typeset). The playhead then holds exactly as
   * it holds at the pen, so it never passes what can be drawn.
   */
  readonly drawable: boolean;
}

const MAX_ADVANCE_MS = 100;

/** A moment well inside this century. Time that is pinned (a seek, a film) shows a clock that began here, so the same time always draws the same picture. */
const PINNED_EPOCH_MS = 1_767_225_600_000;

export function pinnedWallTime(ambient: number): number {
  return PINNED_EPOCH_MS + Math.round(ambient * 1000);
}

/**
 * The painter's real clock. It only ever advances by time that actually
 * passed between two frames, so a hidden tab, a debugger pause or a slow
 * frame can never make the playhead jump.
 *
 * Rules:
 * - `waiting` until the first line of a turn arrives; then `playing` from 0.
 * - While the turn is open the playhead stops at the pen and the state is
 *   `holding`; it resumes the moment the pen moves.
 * - While the renderer cannot draw what the last frame holds, the playhead
 *   holds too, in the same state: nothing passes that cannot be drawn.
 * - Once the turn is closed the playhead runs to `end`, then the state is `idle`.
 * - `pause`/`seek` set `paused` (whether or not a turn is open); `setHidden(true)` sets `hidden`. Both freeze
 *   the playhead AND ambient time. Hidden wins over every other state.
 * - A single advance is capped (100 ms), so the first frame after a stall
 *   continues from where the last one left off.
 */
export class PlayClock {
  private open = false;
  private started = false;
  private paused = false;
  private hidden = false;
  private playhead = 0;
  private ambient = 0;
  private wall = Date.now();
  private running: ClockState = 'idle';
  private rate = 1;
  private holdAt = 0;
  /** `seek` has pinned time; the wall clock then follows ambient time instead of the world */
  private pinned = false;

  /** Changes the running state; a wait or hold keeps the moment it began until something else happens. */
  private setRunning(next: ClockState): void {
    const waiting = (state: ClockState): boolean => state === 'waiting' || state === 'holding';
    if (waiting(next) && !waiting(this.running)) this.holdAt = this.ambient;
    this.running = next;
  }

  openTurn(): void {
    this.open = true;
    this.started = false;
    this.paused = false;
    this.playhead = 0;
    this.setRunning('waiting');
  }

  /** The first line of the turn has arrived: the turn clock leaves zero. */
  start(): void {
    if (!this.open || this.started) return;
    this.started = true;
    this.running = 'playing';
  }

  /** Stops the turn clock where it is and returns to `idle`. Used by interrupt. */
  stop(): void {
    this.open = false;
    this.started = false;
    this.paused = false;
    this.rate = 1;
    this.running = 'idle';
  }

  pause(): void {
    this.paused = true;
  }

  play(): void {
    this.paused = false;
    this.pinned = false;
  }

  /** Lets the playhead run over a finished turn that is being inspected: `seek` then `play` replays it up to `end`. */
  review(): void {
    this.open = false;
    this.started = true;
    this.running = 'playing';
  }

  /** Pauses and pins both the playhead and ambient time to `seconds`. */
  seek(seconds: number): void {
    this.paused = true;
    this.pinned = true;
    this.playhead = Math.max(0, seconds);
    this.ambient = this.playhead;
  }

  /** Moves the playhead without stopping the clock: a skip. Ambient time is untouched. */
  jump(seconds: number): void {
    this.playhead = Math.max(this.playhead, seconds);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /** Multiplies real time while the painter finishes what was in flight when a turn was interrupted. */
  setRate(rate: number): void {
    this.rate = Math.max(1, rate);
  }

  /** Moves time forward by `elapsedMs` of real time, within the horizon. */
  advance(elapsedMs: number, horizon: Horizon): ClockReading {
    if (!this.hidden && !this.paused) {
      const seconds = Math.min(Math.max(0, elapsedMs), MAX_ADVANCE_MS) / 1000;
      this.ambient += seconds;
      this.wall = Date.now();
      this.pinned = false;
      if (this.started) {
        const limit = horizon.open ? horizon.pen : horizon.end;
        const next = horizon.drawable ? Math.min(this.playhead + seconds * this.rate, limit) : this.playhead;
        this.playhead = Math.max(this.playhead, next);
        if (!horizon.drawable) this.setRunning('holding');
        else if (horizon.open) this.setRunning(this.playhead >= horizon.pen ? 'holding' : 'playing');
        else this.setRunning(this.playhead >= horizon.end ? 'idle' : 'playing');
      }
    }
    return this.read();
  }

  read(): ClockReading {
    let state: ClockState = this.running;
    if (this.hidden) state = 'hidden';
    else if (this.paused) state = 'paused';
    const waiting = this.running === 'waiting' || this.running === 'holding';
    return {
      state,
      playhead: this.playhead,
      ambient: this.ambient,
      wallTime: this.pinned ? pinnedWallTime(this.ambient) : this.wall,
      hidden: this.hidden,
      holdSince: waiting ? this.holdAt : null,
    };
  }
}
