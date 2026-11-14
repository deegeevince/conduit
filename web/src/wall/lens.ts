// The wall's camera as a thing that holds one value: where the lens is, and how it got there (WL2). Four ways to be somewhere:
//   rest   the lens is constant (LAW still: nothing here moves it without input);
//   hand   fingers, a wheel or a key are driving it: it is whatever they last set;
//   coast  a pan was let go at a speed: a closed form of the time since (x = x0 + v/k (1 - e^-kt)), clamped, never past the wall's edge;
//   glide  `lensState` of PLAN-wall: a function of the time since the move began (van Wijk and Nuij's curve, ease-out, no overshoot).
// `tick(now)` is the only thing that changes with time, and it only ever drops a finished move into `rest`. Nothing here draws, plans or measures.

import type { Tile, WallPlan } from './plan';
import { focusLens, glideSeconds, lensState, limitsOf, mapLens, panBy, zoomAbout } from './view';
import type { Lens, LensState, Limits, Motion, Screen } from './view';

/** Coasting: how fast a let-go pan slows (per second), the speed under which it has stopped (screen px a second), and the speed it needs to start. */
export const COAST = { k: 5.5, stop: 6, start: 140, window: 90 } as const;

/** The fastest the hands may zoom the lens, e-folds a second (a wheel notch or a quick pinch is held to this; the trace's limit is 4.5). */
export const HAND_ZOOM_CAP = 4;

/** A lens within this share of full size, when let go by a pinch, settles into the frame under it. */
export const SETTLE_NEAR_FULL = 1.12;

type Mode =
  | { kind: 'rest' }
  | { kind: 'hand' }
  | { kind: 'coast'; from: Lens; vx: number; vy: number; began: number; seconds: number }
  | { kind: 'glide'; from: Lens; to: Lens; began: number; motion: Motion };

export interface RigOptions {
  /** the motion in force now: `fade` under reduced motion or the shell's "Motion: fade" */
  readonly motion: () => Motion;
}

/** The tile whose box holds a screen point (relative to the screen's top left), by the plan's boxes alone: no drawing, no DOM. */
export function tileAt(plan: WallPlan, lens: Lens, screen: Screen, sx: number, sy: number): Tile | null {
  const wx = lens.x + (sx - screen.width / 2) / lens.scale;
  const wy = lens.y + (sy - screen.height / 2) / lens.scale;
  for (const tile of plan.tiles) {
    const b = tile.box;
    if (wx >= b.x && wx <= b.x + b.width && wy >= b.y && wy <= b.y + b.height) return tile;
  }
  return null;
}

export class LensRig {
  private mode: Mode = { kind: 'rest' };
  private lens: Lens;
  private focusIndex: number | null = null;
  private back: { lens: Lens; focus: number | null } | null = null;
  /** e-folds the hands have asked for and the lens has not yet taken: it takes them at the zoom cap, so no hand makes a lens that zooms faster */
  private pending = 0;
  private anchor = { x: 0, y: 0 };
  private lastTick = 0;
  private letGo: { vx: number; vy: number; pinched: boolean } | null = null;
  limits: Limits;
  map: Lens;
  /** a move that arrives: the tile it was for, once it is there */
  onArrive: ((tile: Tile | null) => void) | null = null;
  /** a move was begun toward a tile (its still should be asked for before it lands) */
  onGo: ((tile: Tile | null) => void) | null = null;

  constructor(
    private plan: WallPlan,
    private screen: Screen,
    private readonly options: RigOptions,
    start?: Lens,
  ) {
    this.map = mapLens(plan, screen);
    this.limits = limitsOf(plan, screen);
    this.lens = start ?? this.map;
  }

  setPlan(plan: WallPlan, screen: Screen = this.screen): void {
    this.plan = plan;
    this.screen = screen;
    this.map = mapLens(plan, screen);
    this.limits = limitsOf(plan, screen);
  }

  get focus(): number | null {
    return this.focusIndex;
  }

  get floor(): number {
    return this.limits.min;
  }

  /** The lens now, as a function of the clock. Does not change the rig. */
  state(now: number): LensState {
    const mode = this.mode;
    if (mode.kind === 'glide') return lensState(mode.from, mode.to, Math.max(0, (now - mode.began) / 1000), mode.motion, this.screen, this.floor);
    if (mode.kind === 'coast') return { lens: this.coastAt(mode, now), fade: null };
    return { lens: this.lens, fade: null };
  }

  /** Call once a frame: a finished glide or coast drops to rest at its end. Returns the state to draw. */
  tick(now: number): LensState {
    const mode = this.mode;
    if (mode.kind === 'hand') {
      const dt = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
      this.lastTick = now;
      if (this.pending !== 0) {
        const take = Math.max(-HAND_ZOOM_CAP * dt, Math.min(HAND_ZOOM_CAP * dt, this.pending));
        this.pending -= take;
        if (Math.abs(this.pending) < 1e-9) this.pending = 0;
        this.lens = this.clamp(zoomAbout(this.lens, Math.exp(take), this.anchor.x, this.anchor.y, this.limits));
      }
      if (this.pending === 0 && this.letGo !== null) {
        const go = this.letGo;
        this.letGo = null;
        this.finish(now, go.vx, go.vy, go.pinched);
      }
      return { lens: this.lens, fade: null };
    }
    if (mode.kind === 'glide') {
      const seconds = glideSeconds(mode.from, mode.to, mode.motion, this.screen, this.floor);
      if ((now - mode.began) / 1000 >= seconds) {
        this.lens = mode.to;
        this.mode = { kind: 'rest' };
        this.onArrive?.(this.focusIndex === null ? null : (this.plan.tiles[this.focusIndex] ?? null));
        return { lens: this.lens, fade: null };
      }
    } else if (mode.kind === 'coast') {
      if ((now - mode.began) / 1000 >= mode.seconds) {
        this.lens = this.coastAt(mode, mode.began + mode.seconds * 1000);
        this.mode = { kind: 'rest' };
        return { lens: this.lens, fade: null };
      }
    }
    return this.state(now);
  }

  /** True while something is moving the lens or a hand holds it: the frame loop draws. At rest it does not. */
  moving(): boolean {
    return this.mode.kind !== 'rest' || this.pending !== 0;
  }

  get kind(): Mode['kind'] {
    return this.mode.kind;
  }

  /** The lens a move would start from right now. */
  current(now: number): Lens {
    return this.state(now).lens;
  }

  /** The tile at full size and at rest: the one frame that is live. Null while anything moves, or away from full size. */
  live(): Tile | null {
    if (this.mode.kind !== 'rest' || this.focusIndex === null) return null;
    const tile = this.plan.tiles[this.focusIndex];
    if (tile === undefined) return null;
    const at = focusLens(tile, this.screen);
    return Math.abs(this.lens.scale - at.scale) < at.scale * 1e-3 && Math.hypot(this.lens.x - at.x, this.lens.y - at.y) * at.scale < 0.75 ? tile : null;
  }

  /** At the map: the lens is the map's, at rest. */
  atMap(): boolean {
    return this.mode.kind === 'rest' && Math.abs(this.lens.scale - this.map.scale) < this.map.scale * 1e-3 && Math.hypot(this.lens.x - this.map.x, this.lens.y - this.map.y) * this.map.scale < 0.75;
  }

  // ------------------------------------------------------------------ moves

  /** Go to a lens. A glide, or under reduced motion a cross-fade with no travel. */
  goToLens(target: Lens, now: number, tile: Tile | null): void {
    const from = this.current(now);
    this.focusIndex = tile === null ? this.focusIndex : tile.index;
    this.pending = 0;
    this.letGo = null;
    this.onGo?.(tile);
    const motion = this.options.motion();
    if (Math.abs(from.x - target.x) < 1e-6 && Math.abs(from.y - target.y) < 1e-6 && Math.abs(from.scale - target.scale) < 1e-9) {
      this.lens = target;
      this.mode = { kind: 'rest' };
      this.onArrive?.(tile);
      return;
    }
    this.mode = { kind: 'glide', from, to: target, began: now, motion };
  }

  goTo(tile: Tile, now: number): void {
    this.back = null;
    this.goToLens(focusLens(tile, this.screen), now, tile);
  }

  /** Previous or next: a step in the lane (along it), or to a neighbouring lane at the same slot (across it). */
  step(along: number, across: number, now: number): void {
    const at = this.focusIndex ?? this.nearest(this.current(now));
    const here = this.plan.tiles[at];
    if (here === undefined) return;
    const lane = here.lane + across;
    let slot = here.slot + along;
    let found: Tile | undefined;
    if (across === 0) found = this.plan.tiles.find((tile) => tile.lane === here.lane && tile.slot === slot);
    else {
      while (slot >= 0 && found === undefined) {
        found = this.plan.tiles.find((tile) => tile.lane === lane && tile.slot === slot);
        if (found === undefined) slot -= 1;
      }
    }
    if (found !== undefined) this.goTo(found, now);
  }

  /** Map, `0` and Escape: the map; again, back to where you were. */
  toggleMap(now: number): void {
    const from = this.current(now);
    const nearMap = Math.abs(from.scale - this.map.scale) < this.map.scale * 0.02;
    if (this.mode.kind === 'rest' && nearMap) {
      const back = this.back;
      if (back === null) return;
      this.back = null;
      this.goToLens(back.lens, now, back.focus === null ? null : (this.plan.tiles[back.focus] ?? null));
      return;
    }
    this.back = { lens: from, focus: this.focusIndex };
    this.goToLens(this.map, now, null);
  }

  nearest(lens: Lens): number {
    let best = 0;
    let bestD = Infinity;
    for (const tile of this.plan.tiles) {
      const d = Math.hypot(tile.box.x + tile.box.width / 2 - lens.x, tile.box.y + tile.box.height / 2 - lens.y);
      if (d < bestD) {
        bestD = d;
        best = tile.index;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ hands

  /** Fingers or a wheel have it: freeze where the lens is. */
  grab(now: number): void {
    if (this.mode.kind !== 'hand') {
      this.lens = this.current(now);
      this.mode = { kind: 'hand' };
      this.lastTick = now;
    }
    this.letGo = null;
  }

  pan(dx: number, dy: number): void {
    if (this.mode.kind !== 'hand') return;
    this.lens = this.clamp(panBy(this.lens, dx, dy));
  }

  /** Ask to zoom by `ln` e-folds about a screen point (relative to the screen's centre). The lens takes it at the zoom cap, over the next frames. */
  zoom(ln: number, sx: number, sy: number): void {
    if (this.mode.kind !== 'hand') return;
    this.anchor = { x: sx, y: sy };
    this.pending = Math.max(-1.5, Math.min(1.5, this.pending + ln));
  }

  /** Hands let go. When what they asked for has been taken: a pan carries on by a closed form; a pinch near full size settles into the frame. */
  release(vx: number, vy: number, pinched: boolean): void {
    if (this.mode.kind !== 'hand') return;
    this.letGo = { vx, vy, pinched };
  }

  private finish(now: number, vx: number, vy: number, pinched: boolean): void {
    const lens = this.lens;
    if (pinched && this.limits.max / lens.scale < SETTLE_NEAR_FULL && lens.scale > this.limits.max / SETTLE_NEAR_FULL) {
      const tile = this.tileUnder(lens);
      if (tile !== null) {
        this.mode = { kind: 'rest' };
        this.goTo(tile, now);
        return;
      }
    }
    const speed = Math.hypot(vx, vy);
    if (this.options.motion() === 'glide' && !pinched && speed >= COAST.start) {
      const seconds = Math.log(speed / COAST.stop) / COAST.k;
      this.mode = { kind: 'coast', from: lens, vx, vy, began: now, seconds };
      return;
    }
    this.mode = { kind: 'rest' };
  }

  /** The tile that has most of the screen's centre: where a pinch let go near full size lands. */
  private tileUnder(lens: Lens): Tile | null {
    return tileAt(this.plan, lens, this.screen, this.screen.width / 2, this.screen.height / 2) ?? this.plan.tiles[this.nearest(lens)] ?? null;
  }

  /** The lens a coast is at: x0 + v/k (1 - e^-kt) in screen px, as world units, held in the wall's reach. A function of the time alone. */
  private coastAt(mode: Extract<Mode, { kind: 'coast' }>, now: number): Lens {
    const t = Math.min(mode.seconds, Math.max(0, (now - mode.began) / 1000));
    const travel = (1 - Math.exp(-COAST.k * t)) / COAST.k;
    return this.clamp(panBy(mode.from, mode.vx * travel, mode.vy * travel));
  }

  /** The lens's centre stays within the wall and a half screen beyond it: the ground never leaves entirely. */
  private clamp(lens: Lens): Lens {
    const b = this.plan.bounds;
    const mx = this.screen.width / 2 / lens.scale;
    const my = this.screen.height / 2 / lens.scale;
    const x = Math.max(b.x - mx * 0.5, Math.min(b.x + b.width + mx * 0.5, lens.x));
    const y = Math.max(b.y - my * 0.5, Math.min(b.y + b.height + my * 0.5, lens.y));
    return x === lens.x && y === lens.y ? lens : { x, y, scale: lens.scale };
  }

  /** The lens settles by the hands on a tile or the map with no animation: the shell's "go there now" and a reload. */
  jump(lens: Lens, tile: Tile | null): void {
    this.lens = lens;
    this.mode = { kind: 'rest' };
    if (tile !== null) this.focusIndex = tile.index;
  }
}
