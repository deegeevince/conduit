// The wall's camera as a thing that holds one value: where the lens is, and how it got there (WL2). Four ways to be somewhere:
//   rest   the lens is constant (LAW still: nothing here moves it without input);
//   hand   fingers, a wheel or a key are driving it: it is whatever they last set;
//   coast  a pan was let go at a speed: a closed form of the time since (x = x0 + v/k (1 - e^-kt)), clamped, never past the wall's edge;
//   glide  `lensState` of PLAN-wall: a function of the time since the move began (van Wijk and Nuij's curve, ease-out, no overshoot).
// `tick(now)` is the only thing that changes with time, and it only ever drops a finished move into `rest`. Nothing here draws, plans or measures.

import type { Tile, WallPlan } from './plan';
import type { Box, LensView } from '../contracts/space';
import { focusLens, glideSeconds, lensState, limitsOf, mapLens, panBy, zoomAbout } from './view';
import type { Lens, LensState, Limits, Motion, Screen } from './view';
import { VIEW } from '../core/invariants';
import { fitLens, viewOf } from '../painter/view';

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

/**
 * The motion core both cameras share (the wall's, and a page's): where the lens is and how it got there (rest, hand, coast, glide), the hands that
 * drive it (grab, pan, zoom, release) and the one thing that changes with time, `tick`. It knows nothing of what the lens looks at: a subclass says
 * where the lens may go (`clamp`), what the hands' release may settle into (`settle`) and what it does when a glide arrives (`arrived`).
 */
export abstract class MotionRig {
  protected mode: Mode = { kind: 'rest' };
  protected lens: Lens;
  /** e-folds the hands have asked for and the lens has not yet taken: it takes them at the zoom cap, so no hand makes a lens that zooms faster */
  protected pending = 0;
  protected anchor = { x: 0, y: 0 };
  protected lastTick = 0;
  protected letGo: { vx: number; vy: number; pinched: boolean } | null = null;
  limits: Limits;

  protected constructor(
    protected screen: Screen,
    protected readonly options: RigOptions,
    start: Lens,
    limits: Limits,
  ) {
    this.lens = start;
    this.limits = limits;
  }

  /** where the lens may be: the wall's centre stays within it and a half screen beyond; a page's covers the window */
  protected abstract clamp(lens: Lens): Lens;

  /** a pinch let go: whether it settled into something (and so has moved the lens itself); false lets it rest or coast */
  protected settle(_lens: Lens, _now: number): boolean {
    return false;
  }

  /** a glide has arrived at its end */
  protected arrived(): void {}

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
        this.arrived();
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

  /** Go to a lens by a glide, or under reduced motion a cross-fade with no travel. True when the lens was already there (nothing moves). */
  protected glideTo(target: Lens, now: number): boolean {
    const from = this.current(now);
    this.pending = 0;
    this.letGo = null;
    const motion = this.options.motion();
    if (Math.abs(from.x - target.x) < 1e-6 && Math.abs(from.y - target.y) < 1e-6 && Math.abs(from.scale - target.scale) < 1e-9) {
      this.lens = target;
      this.mode = { kind: 'rest' };
      return true;
    }
    this.mode = { kind: 'glide', from, to: target, began: now, motion };
    return false;
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

  protected finish(now: number, vx: number, vy: number, pinched: boolean): void {
    const lens = this.lens;
    if (pinched && this.settle(lens, now)) return;
    const speed = Math.hypot(vx, vy);
    if (this.options.motion() === 'glide' && !pinched && speed >= COAST.start) {
      const seconds = Math.log(speed / COAST.stop) / COAST.k;
      this.mode = { kind: 'coast', from: lens, vx, vy, began: now, seconds };
      return;
    }
    this.mode = { kind: 'rest' };
  }

  /** The lens a coast is at: x0 + v/k (1 - e^-kt) in screen px, as world units, held in the rig's reach. A function of the time alone. */
  protected coastAt(mode: Extract<Mode, { kind: 'coast' }>, now: number): Lens {
    const t = Math.min(mode.seconds, Math.max(0, (now - mode.began) / 1000));
    const travel = (1 - Math.exp(-COAST.k * t)) / COAST.k;
    return this.clamp(panBy(mode.from, mode.vx * travel, mode.vy * travel));
  }

  /** The lens settles where it is told with no animation: a reload, or the owner of the rig putting it somewhere. */
  jump(lens: Lens): void {
    this.lens = lens;
    this.mode = { kind: 'rest' };
    this.pending = 0;
    this.letGo = null;
  }
}

export class LensRig extends MotionRig {
  private focusIndex: number | null = null;
  private back: { lens: Lens; focus: number | null } | null = null;
  map: Lens;
  /** a move that arrives: the tile it was for, once it is there */
  onArrive: ((tile: Tile | null) => void) | null = null;
  /** a move was begun toward a tile (its still should be asked for before it lands) */
  onGo: ((tile: Tile | null) => void) | null = null;

  constructor(
    private plan: WallPlan,
    screen: Screen,
    options: RigOptions,
    start?: Lens,
  ) {
    const map = mapLens(plan, screen);
    super(screen, options, start ?? map, limitsOf(plan, screen));
    this.map = map;
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
    this.focusIndex = tile === null ? this.focusIndex : tile.index;
    this.onGo?.(tile);
    if (this.glideTo(target, now)) this.onArrive?.(tile);
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


  protected override arrived(): void {
    this.onArrive?.(this.focusIndex === null ? null : (this.plan.tiles[this.focusIndex] ?? null));
  }

  /** a pinch let go near full size settles into the frame under it */
  protected override settle(lens: Lens, now: number): boolean {
    if (!(this.limits.max / lens.scale < SETTLE_NEAR_FULL && lens.scale > this.limits.max / SETTLE_NEAR_FULL)) return false;
    const tile = this.tileUnder(lens);
    if (tile === null) return false;
    this.mode = { kind: 'rest' };
    this.goTo(tile, now);
    return true;
  }

  /** The tile that has most of the screen's centre: where a pinch let go near full size lands. */
  private tileUnder(lens: Lens): Tile | null {
    return tileAt(this.plan, lens, this.screen, this.screen.width / 2, this.screen.height / 2) ?? this.plan.tiles[this.nearest(lens)] ?? null;
  }

  /** The lens's centre stays within the wall and a half screen beyond it: the ground never leaves entirely. */
  protected clamp(lens: Lens): Lens {
    const b = this.plan.bounds;
    const mx = this.screen.width / 2 / lens.scale;
    const my = this.screen.height / 2 / lens.scale;
    const x = Math.max(b.x - mx * 0.5, Math.min(b.x + b.width + mx * 0.5, lens.x));
    const y = Math.max(b.y - my * 0.5, Math.min(b.y + b.height + my * 0.5, lens.y));
    return x === lens.x && y === lens.y ? lens : { x, y, scale: lens.scale };
  }

  /** The lens settles by the hands on a tile or the map with no animation: the shell's "go there now" and a reload. */
  override jump(lens: Lens, tile: Tile | null = null): void {
    super.jump(lens);
    if (tile !== null) this.focusIndex = tile.index;
  }
}

/**
 * A page's camera (PLAN-canvas): the same motion as the wall's, over one page. The page is a box with its top-left at the screen's top-left; the
 * lens never leaves it. It is in one of two states: `following` (the lens is where Fit puts it, and moves when the page changes) and free (the person
 * has touched it, and it holds still until they press Fit). `reveal` takes a box into view by the least move.
 */
export class PageRig extends MotionRig {
  private free = false;
  /** the smallest scale Fit may take the page to (the body text's legible share); absent: the screen's default */
  private legible: number | undefined;
  /** where the last move that followed a growing page was bound, so that the same target is not set off again while it glides there */
  private bound: Lens | null = null;

  constructor(
    private page: Box,
    screen: Screen,
    options: RigOptions,
  ) {
    super(screen, options, fitLens(page, screen), PageRig.limitsFor(page, screen));
  }

  /** how far a person may zoom out: to the whole page, down to the view's floor (the floor of legible type only decides where Fit goes) */
  private static limitsFor(page: Box, screen: Screen): Limits {
    const fit = fitLens(page, screen).scale;
    return { min: Math.min(fit, 1), max: Math.max(VIEW.max, fit) };
  }

  /** the page grew, or the screen changed size: the lens keeps where it is, held inside the new page; a lens not yet touched is refitted */
  setPage(page: Box, screen: Screen = this.screen): void {
    this.page = page;
    this.screen = screen;
    this.limits = PageRig.limitsFor(page, screen);
    if (!this.free && this.mode.kind === 'rest') this.lens = fitLens(page, screen, this.legible);
    else this.lens = this.clamp({ ...this.lens, scale: Math.min(this.limits.max, Math.max(this.limits.min, this.lens.scale)) });
  }

  /**
   * A page that grows, and the newest line on it (PLAN-canvas step 2). A lens the person has not touched goes where Fit puts it, and when the page is taller than the window
   * at that scale (the floor of legible type) it keeps the newest line in view; one they have touched holds still. `fresh`: another scene or turn has begun, so the lens
   * is the page's to place again.
   */
  follow(page: Box, newest: Box | null, now: number, fresh: boolean, floor?: number): void {
    if (fresh) this.free = false;
    this.legible = floor;
    this.page = page;
    this.limits = PageRig.limitsFor(page, this.screen);
    if (this.mode.kind === 'hand') return;
    if (this.free) {
      this.lens = this.clamp({ ...this.lens, scale: Math.min(this.limits.max, Math.max(this.limits.min, this.lens.scale)) });
      return;
    }
    let target = fitLens(page, this.screen, floor);
    if (newest !== null && this.screen.height / target.scale < page.height - 1) target = this.clamp(revealed(target, newest, this.screen, 16));
    const last = this.bound;
    if (last !== null && Math.abs(last.x - target.x) < 0.5 && Math.abs(last.y - target.y) < 0.5 && Math.abs(last.scale - target.scale) < 1e-4 && this.mode.kind === 'glide') return;
    const here = this.current(now);
    if (this.mode.kind === 'rest' && Math.abs(here.x - target.x) < 0.5 && Math.abs(here.y - target.y) < 0.5 && Math.abs(here.scale - target.scale) < 1e-4) return;
    this.bound = target;
    this.glideTo(target, now);
  }

  /** the person has touched the lens: it stays where they put it until Fit */
  get touched(): boolean {
    return this.free;
  }

  /** a hand has hold of the lens; it is the person's from the first thing it really moves */
  override pan(dx: number, dy: number): void {
    const before = this.lens;
    super.pan(dx, dy);
    if (this.lens !== before) this.free = true;
  }

  override zoom(ln: number, sx: number, sy: number): void {
    if (this.mode.kind === 'hand' && ln !== 0) this.free = true;
    super.zoom(ln, sx, sy);
  }

  /** where Fit puts the lens */
  fitted(): Lens {
    return fitLens(this.page, this.screen, this.legible);
  }

  /** `0`, a double tap on empty stage: the whole page, or as much of it as reads. The lens is following again. */
  fit(now: number): void {
    this.free = false;
    this.glideTo(this.fitted(), now);
  }

  /** `1`: one to one about a point of the screen (relative to its centre), or about the middle */
  actual(now: number, sx = 0, sy = 0): void {
    this.zoomTo(1, now, sx, sy);
  }

  /** a given scale about a point of the screen (relative to its centre), by a glide */
  zoomTo(scale: number, now: number, sx = 0, sy = 0): void {
    this.free = true;
    const from = this.current(now);
    this.glideTo(this.clamp(zoomAbout(from, scale / from.scale, sx, sy, this.limits)), now);
  }

  /** `+` and `-`, a step in zoom about a point of the screen (relative to its centre) */
  step(factor: number, now: number, sx = 0, sy = 0): void {
    this.free = true;
    const from = this.current(now);
    const next = zoomAbout(from, factor, sx, sy, this.limits);
    this.glideTo(this.clamp(next), now);
  }

  /** the arrows and the paging keys: a move across the page by screen pixels */
  nudge(dx: number, dy: number, now: number): void {
    this.free = true;
    const from = this.current(now);
    this.glideTo(this.clamp(panBy(from, -dx, -dy)), now);
  }

  /** Brings a page box into view by the least move: no zoom when it fits the window at the lens's scale, else the zoom that shows all of it. A box already in view moves nothing. */
  reveal(box: Box, now: number, margin = 16): void {
    this.glideTo(this.clamp(revealed(this.current(now), box, this.screen, margin, this.limits.min)), now);
  }

  /** the lens as the frame carries it */
  view(now: number): LensView {
    return viewOf(this.current(now), this.screen);
  }

  /** the lens covers the window with the page, and the page is centred on an axis it is smaller than the window on */
  protected clamp(lens: Lens): Lens {
    const p = this.page;
    const spanX = this.screen.width / lens.scale;
    const spanY = this.screen.height / lens.scale;
    const x = spanX >= p.width ? p.x + p.width / 2 : Math.max(p.x + spanX / 2, Math.min(p.x + p.width - spanX / 2, lens.x));
    const y = spanY >= p.height ? p.y + p.height / 2 : Math.max(p.y + spanY / 2, Math.min(p.y + p.height - spanY / 2, lens.y));
    return x === lens.x && y === lens.y ? lens : { x, y, scale: lens.scale };
  }
}

/** The lens that brings a page box into view from `from` by the least move: its scale kept when the box fits the window at it, else the scale that shows all of the box (not under `least`). */
export function revealed(from: Lens, box: Box, screen: Screen, margin = 16, least = 0): Lens {
  const fits = Math.min((screen.width - margin * 2) / Math.max(1, box.width), (screen.height - margin * 2) / Math.max(1, box.height));
  const scale = Math.max(least, Math.min(from.scale, fits));
  const spanX = screen.width / scale;
  const spanY = screen.height / scale;
  const pad = margin / scale;
  const axis = (centre: number, span: number, lo: number, hi: number): number => {
    const left = centre - span / 2;
    const right = centre + span / 2;
    if (lo - pad >= left && hi + pad <= right) return centre;
    if (hi - lo + 2 * pad >= span) return (lo + hi) / 2;
    return lo - pad < left ? lo - pad + span / 2 : hi + pad - span / 2;
  };
  return { x: axis(from.x, spanX, box.x, box.x + box.width), y: axis(from.y, spanY, box.y, box.y + box.height), scale };
}
