// Motion that keeps time: the pure arithmetic (PLAN-motion.md). No clock is read here, nothing is added up per frame, and nothing here knows a painter.
// Every pose is a function of the drawing, a clock reading T, and the element's own period: so two periods cannot drift apart.
import type { Point } from './types';
import type { Loop } from './vocabulary';
import { sceneAt } from './schedule';
import type { Schedule } from './schedule';

/**
 * What a loop does when it is not told otherwise: its period in seconds and how far it goes. These are the constants the painter's `extrasOf` used to hold.
 * `amp` is degrees for `sway` and `spin` (a whole turn), canvas units for `bob`, `drift` (across) and `shake`, a share for `breathe` and `pulse`.
 */
export const LOOP_DEFAULT = {
  breathe: { period: 4, amp: 0.03 },
  pulse: { period: 1.2, amp: 0.08 },
  blink: { period: 0.9 },
  /** a tremor: `rate` slots a second, each a fresh random offset of up to `amp` */
  shake: { rate: 24, amp: 0.8 },
  /** a slow wander: `amp` across, half as much up and down, twice as fast */
  drift: { period: 9, amp: 1.6, lift: 0.5 },
  spin: { period: 6, amp: 360 },
  /** a sprite bobs by whole cells: up to `cells` of them */
  bob: { period: 1.8, amp: 1.2, cells: 0.9 },
  sway: { period: 3.2, amp: 4 },
} as const;

/** The fractional part, always in [0, 1): `frac(-0.25)` is 0.75. */
export function frac(value: number): number {
  return value - Math.floor(value);
}

/**
 * How far into its cycle something is when the clock reads `clock`: a number in [0, 1). `T / period` is reduced here, before any trigonometry, so a
 * clock of a hundred thousand beside a period of 0.0748 loses nothing a tiny angle would. A negative period runs backwards; none (or zero) holds still at the phase.
 */
export function cycleAt(clock: number, period: number | null | undefined, phase = 0): number {
  if (period === null || period === undefined || period === 0 || !Number.isFinite(period) || !Number.isFinite(clock)) return frac(phase);
  return frac(clock / period + phase);
}

/** Sine and cosine of a share of a turn, exact at the quarters (a plain `Math.cos(Math.PI / 2)` is 6e-17, and a clock hand sits on quarters). */
export function sinTurns(turns: number): number {
  const c = frac(turns);
  if (c === 0 || c === 0.5) return 0;
  if (c === 0.25) return 1;
  if (c === 0.75) return -1;
  return Math.sin(2 * Math.PI * c);
}

export function cosTurns(turns: number): number {
  const c = frac(turns);
  if (c === 0) return 1;
  if (c === 0.5) return -1;
  if (c === 0.25 || c === 0.75) return 0;
  return Math.cos(2 * Math.PI * c);
}

/** What a loop adds to a pose. All of it is nothing at cycle 0: `scale` and `opacity` are factors, the rest offsets. */
export interface LoopOffset {
  readonly dx: number;
  readonly dy: number;
  /** degrees, clockwise */
  readonly rot: number;
  readonly scale: number;
  readonly opacity: number;
}

export const NO_OFFSET: LoopOffset = { dx: 0, dy: 0, rot: 0, scale: 1, opacity: 1 };

/**
 * The offset a loop gives at `cycle` (0..1, from `cycleAt`). `amp` overrides how far it goes; `cell` is the size of one cell of a sprite, which rides by whole cells
 * (0 for anything else). `shake` is noise, not a cycle, and is the painter's own: it is nothing here.
 */
export function loopOffset(loop: Loop, cycle: number, amp?: number, cell = 0): LoopOffset {
  switch (loop) {
    case 'breathe':
      return { ...NO_OFFSET, scale: 1 + (amp ?? LOOP_DEFAULT.breathe.amp) * sinTurns(cycle) };
    case 'pulse':
      return { ...NO_OFFSET, scale: 1 + (amp ?? LOOP_DEFAULT.pulse.amp) * (0.5 - 0.5 * cosTurns(cycle)) };
    case 'blink':
      return { ...NO_OFFSET, opacity: frac(cycle) >= 0.5 ? 0 : 1 };
    case 'drift': {
      const across = amp ?? LOOP_DEFAULT.drift.amp;
      return { ...NO_OFFSET, dx: across * sinTurns(cycle), dy: across * LOOP_DEFAULT.drift.lift * sinTurns(2 * cycle) };
    }
    case 'spin':
      return { ...NO_OFFSET, rot: (amp ?? LOOP_DEFAULT.spin.amp) * frac(cycle) };
    case 'bob': {
      const wave = sinTurns(cycle);
      return { ...NO_OFFSET, dy: cell > 0 ? -cell * Math.round(wave * LOOP_DEFAULT.bob.cells) + 0 : -(amp ?? LOOP_DEFAULT.bob.amp) * wave + 0 };
    }
    case 'sway':
      return { ...NO_OFFSET, rot: (amp ?? LOOP_DEFAULT.sway.amp) * sinTurns(cycle) };
    default:
      return NO_OFFSET;
  }
}

/** A point turned `degrees` clockwise (on a screen, where y runs down) about a pivot. Exact at the quarter turns. */
export function turnAbout(point: Point, pivot: Point, degrees: number): Point {
  const turns = Number.isFinite(degrees) ? degrees / 360 : 0;
  const sin = sinTurns(turns);
  const cos = cosTurns(turns);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

/**
 * How far along its outline (0..1, by length) a rider is. `start` is the share it was drawn at, `cycle` how far into its lap the clock has taken it.
 * A closed outline goes round and round; an open one goes to the far end and back, so at half a cycle from the start of it the rider is at the far end.
 */
export function rideShare(start: number, cycle: number, closed: boolean): number {
  const from = Math.min(1, Math.max(0, start));
  if (closed) return frac(from + cycle);
  const along = frac(cycle + from / 2) * 2;
  return along <= 1 ? along : 2 - along;
}

/**
 * The stage clock: it reads `t0` at ambient time `since`, then runs at `rate` clock units a second. Nothing is added up per frame, so a reading is one
 * multiplication from the last time the clock was touched.
 */
export interface MotionClock {
  readonly t0: number;
  readonly since: number;
  readonly rate: number;
}

/** A clock at rest at zero, running at one a second from `ambient`. A scene opens like this. */
export function openClock(ambient: number, rate = 1): MotionClock {
  return { t0: 0, since: ambient, rate };
}

/** The reading at ambient time `ambient`. */
export function clockAt(clock: MotionClock, ambient: number): number {
  return clock.rate === 0 ? clock.t0 : clock.t0 + clock.rate * (ambient - clock.since);
}

/**
 * The same clock, touched at `ambient`: what it reads then is kept, and `change` says what is different from now on (a new `rate`, or `time` set to a
 * value, as when a time slider is dragged). Called only when something is touched, never once a frame.
 */
export function rebase(clock: MotionClock, ambient: number, change: { readonly rate?: number; readonly time?: number } = {}): MotionClock {
  return { t0: change.time ?? clockAt(clock, ambient), since: ambient, rate: change.rate ?? clock.rate };
}

/** What a resting picture knows of the clock: the time slider's value if there is one, and the rate if a control sets it. */
export interface ClockHold {
  /** the value of the `clock=time` slider; null: there is none */
  readonly time: number | null;
  /** what the `clock=rate` controls multiply to; absent: one */
  readonly rate?: number;
  /** true for a draft, a candidate, the snapshot, the sight picture: time stands still, at the slider's value or at zero */
  readonly rest?: boolean;
}

/**
 * The reading for a picture that is not live. At rest: the time slider's value, else zero. A film or a seek at `time` seconds into the turn: the slider's value
 * if there is one, else `rate × (time − the start of the scene `time` falls in)`.
 */
export function pinnedClock(schedule: Schedule, time: number, held: ClockHold): number {
  if (held.time !== null) return held.time;
  if (held.rest === true) return 0;
  return (held.rate ?? 1) * (time - sceneAt(schedule, time).start);
}
