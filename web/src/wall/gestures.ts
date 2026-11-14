// The wall's hands (WL2): real touch, mouse, wheel, keys and Safari's `gesture*` events, turned into what a `LensRig` does. No drawing, no
// planning, no measuring in here. The wall owns two fingers; the frame in focus, at full size and at rest, owns one (its controls, scroll, ink).
//
//   pinch, ctrl+wheel, Safari gesture    zoom about the fingers, between the map and full size and no further
//   two fingers, wheel, a drag           pan; a drag let go at speed coasts by a closed form (never under reduced motion)
//   tap                                  go to the tile under it, by the plan's boxes alone: nothing in a far frame can be worked by a tap meant to travel
//   arrows, Map, 0, Escape               previous or next; the map and back
// `touch-action: none` is set on the room while the wall is on and put back when it is off.

import type { Tile, WallPlan } from './plan';
import { LensRig, tileAt } from './lens';
import type { Screen } from './view';

export interface GestureOptions {
  readonly plan: () => WallPlan;
  readonly screen: () => Screen;
  readonly now?: () => number;
  /** Is this target inside the live frame's DOM? One finger there is the frame's. */
  readonly inLive?: (target: EventTarget | null) => boolean;
  /** A tap landed on a tile (the lens is going there). */
  readonly onTap?: (tile: Tile) => void;
  /** Something changed that the page should draw. */
  readonly onChange?: () => void;
}

export interface Hands {
  /** the wall is on: `touch-action: none`, the listeners work */
  setOn(on: boolean): void;
  readonly on: boolean;
  /** the Map button */
  toggleMap(): void;
  dispose(): void;
}

const SLOP = 10;
const TAP_MS = 600;
const WINDOW_MS = 90;
const WHEEL_LINE = 16;
const WHEEL_ZOOM = 0.01;
const WHEEL_REST_MS = 140;

interface Finger {
  x: number;
  y: number;
  readonly startX: number;
  readonly startY: number;
  readonly t0: number;
  /** began inside the live frame: its own, until a second finger comes */
  readonly owned: boolean;
  samples: { t: number; x: number; y: number }[];
}

const editable = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (el === null || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
};

export function attachGestures(el: HTMLElement, rig: LensRig, options: GestureOptions): Hands {
  const clock = options.now ?? ((): number => performance.now());
  const inLive = options.inLive ?? ((): boolean => false);
  const fingers = new Map<number, Finger>();
  let on = false;
  let before = '';
  let grabbed = false;
  let pinched = false;
  let tapOk = false;
  let prevDist = 0;
  let prevMid = { x: 0, y: 0 };
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelKind: 'zoom' | 'pan' = 'pan';
  let gestureScale = 1;
  let gestureLive = false;

  const rect = (): { left: number; top: number; width: number; height: number } => el.getBoundingClientRect();
  const local = (x: number, y: number): { x: number; y: number } => {
    const r = rect();
    return { x: x - r.left, y: y - r.top };
  };
  const centred = (x: number, y: number): { x: number; y: number } => {
    const p = local(x, y);
    const screen = options.screen();
    return { x: p.x - screen.width / 2, y: p.y - screen.height / 2 };
  };
  const changed = (): void => options.onChange?.();

  const grab = (): void => {
    if (!grabbed) {
      rig.grab(clock());
      grabbed = true;
    }
  };

  const velocity = (finger: Finger): { vx: number; vy: number } => {
    const now = clock();
    const recent = finger.samples.filter((s) => now - s.t <= WINDOW_MS * 2);
    const first = recent[0];
    const last = recent[recent.length - 1];
    if (first === undefined || last === undefined || last.t - first.t < 8) return { vx: 0, vy: 0 };
    // a finger that waited before letting go has stopped
    if (now - last.t > WINDOW_MS) return { vx: 0, vy: 0 };
    const dt = (last.t - first.t) / 1000;
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  };

  const midOf = (): { x: number; y: number; d: number } => {
    const [a, b] = [...fingers.values()];
    if (a === undefined || b === undefined) return { x: 0, y: 0, d: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  const finishAll = (lastFinger: Finger | undefined, wasTap: boolean, point: { x: number; y: number }): void => {
    const speed = lastFinger !== undefined && !pinched ? velocity(lastFinger) : { vx: 0, vy: 0 };
    if (wasTap) {
      // a tap is not a pan: let go with no speed, then go where it was
      rig.release(0, 0, false);
      grabbed = false;
      const p = local(point.x, point.y);
      const tile = tileAt(options.plan(), rig.current(clock()), options.screen(), p.x, p.y);
      if (tile !== null) {
        rig.goTo(tile, clock());
        options.onTap?.(tile);
      }
    } else if (grabbed) {
      rig.release(speed.vx, speed.vy, pinched);
      grabbed = false;
    }
    pinched = false;
    changed();
  };

  const onDown = (e: PointerEvent): void => {
    if (!on || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const owned = fingers.size === 0 && inLive(e.target);
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, t0: e.timeStamp, owned, samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] });
    if (fingers.size === 1) {
      tapOk = true;
      pinched = false;
      if (owned) return;
      grab();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // not capturable: the page still gets its moves
      }
      if (e.pointerType === 'mouse') e.preventDefault();
    } else if (fingers.size === 2) {
      // two fingers are the wall's, wherever the first began
      tapOk = false;
      pinched = true;
      grab();
      for (const id of fingers.keys()) {
        try {
          el.setPointerCapture(id);
        } catch {
          // as above
        }
      }
      const m = midOf();
      prevDist = m.d;
      prevMid = { x: m.x, y: m.y };
      e.preventDefault();
    }
  };

  const onMove = (e: PointerEvent): void => {
    const finger = fingers.get(e.pointerId);
    if (finger === undefined || !on) return;
    const px = e.clientX - finger.x;
    const py = e.clientY - finger.y;
    finger.x = e.clientX;
    finger.y = e.clientY;
    finger.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    while (finger.samples.length > 0 && e.timeStamp - (finger.samples[0]?.t ?? 0) > WINDOW_MS * 3) finger.samples.shift();
    if (fingers.size >= 2) {
      const m = midOf();
      if (prevDist > 0 && m.d > 0) {
        const c = centred(m.x, m.y);
        rig.pan(m.x - prevMid.x, m.y - prevMid.y);
        rig.zoom(Math.log(m.d / prevDist), c.x, c.y);
      }
      prevDist = m.d;
      prevMid = { x: m.x, y: m.y };
      e.preventDefault();
      changed();
      return;
    }
    if (finger.owned) return;
    if (Math.hypot(e.clientX - finger.startX, e.clientY - finger.startY) > SLOP) tapOk = false;
    if (!tapOk) {
      rig.pan(px, py);
      changed();
    }
  };

  const onUp = (e: PointerEvent): void => {
    const finger = fingers.get(e.pointerId);
    if (finger === undefined) return;
    fingers.delete(e.pointerId);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // gone already
    }
    if (fingers.size === 1) {
      // one finger of a pinch lifts: the other carries on as a pan from here
      const rest = [...fingers.values()][0];
      if (rest !== undefined) rest.samples = [{ t: e.timeStamp, x: rest.x, y: rest.y }];
      prevDist = 0;
      return;
    }
    if (fingers.size > 0) return;
    if (!grabbed && finger.owned) return;
    const quick = e.timeStamp - finger.t0 <= TAP_MS;
    const wasTap = e.type === 'pointerup' && tapOk && quick && !pinched && !finger.owned && Math.hypot(e.clientX - finger.startX, e.clientY - finger.startY) <= SLOP;
    finishAll(finger, wasTap, { x: e.clientX, y: e.clientY });
  };

  const onWheel = (e: WheelEvent): void => {
    if (!on) return;
    const zoom = e.ctrlKey || e.metaKey;
    // one finger or a wheel over the live frame at full size is the frame's scroll; ctrl and wheel is always the wall's
    if (!zoom && inLive(e.target)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? options.screen().height : 1;
    grab();
    wheelKind = zoom ? 'zoom' : 'pan';
    if (zoom) {
      const c = centred(e.clientX, e.clientY);
      rig.zoom(Math.max(-0.5, Math.min(0.5, -e.deltaY * unit * WHEEL_ZOOM)), c.x, c.y);
    } else {
      rig.pan(-e.deltaX * unit, -e.deltaY * unit);
    }
    if (wheelTimer !== null) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      if (fingers.size === 0 && grabbed) {
        rig.release(0, 0, wheelKind === 'zoom');
        grabbed = false;
        changed();
      }
    }, WHEEL_REST_MS);
    changed();
  };

  // Safari: a pinch fires gesture events, and would zoom the page unless stopped. With fingers down the pointer events already did the
  // work; with none (a trackpad) the gesture's scale is the zoom.
  type GestureEvent = Event & { scale: number; clientX: number; clientY: number };
  const onGestureStart = (event: Event): void => {
    if (!on) return;
    event.preventDefault();
    gestureScale = 1;
    gestureLive = fingers.size === 0;
    if (gestureLive) grab();
  };
  const onGestureChange = (event: Event): void => {
    if (!on) return;
    event.preventDefault();
    const e = event as GestureEvent;
    if (!gestureLive || !(e.scale > 0)) return;
    const c = centred(e.clientX, e.clientY);
    rig.zoom(Math.log(e.scale / gestureScale), c.x, c.y);
    gestureScale = e.scale;
    changed();
  };
  const onGestureEnd = (event: Event): void => {
    if (!on) return;
    event.preventDefault();
    if (gestureLive && grabbed && fingers.size === 0) {
      rig.release(0, 0, true);
      grabbed = false;
      changed();
    }
    gestureLive = false;
  };

  const onKey = (e: KeyboardEvent): void => {
    if (!on || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
    const now = clock();
    const rows = rowAxis(options.plan());
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        rows ? rig.step(1, 0, now) : rig.step(0, 1, now);
        break;
      case 'ArrowLeft':
        rows ? rig.step(-1, 0, now) : rig.step(0, -1, now);
        break;
      case 'ArrowDown':
        rows ? rig.step(0, 1, now) : rig.step(1, 0, now);
        break;
      case 'ArrowUp':
        rows ? rig.step(0, -1, now) : rig.step(-1, 0, now);
        break;
      case '0':
      case 'Escape':
        rig.toggleMap(now);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      changed();
    }
  };

  const bind = (): void => {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
    el.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
    el.addEventListener('gestureend', onGestureEnd as EventListener, { passive: false });
    window.addEventListener('keydown', onKey);
  };
  const unbind = (): void => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('gesturestart', onGestureStart as EventListener);
    el.removeEventListener('gesturechange', onGestureChange as EventListener);
    el.removeEventListener('gestureend', onGestureEnd as EventListener);
    window.removeEventListener('keydown', onKey);
  };

  const hands: Hands = {
    get on() {
      return on;
    },
    setOn(next: boolean): void {
      if (next === on) return;
      on = next;
      if (on) {
        before = el.style.touchAction;
        // the room's own scroll and pinch-zoom are the wall's now
        el.style.touchAction = 'none';
        bind();
      } else {
        el.style.touchAction = before;
        unbind();
        fingers.clear();
        grabbed = false;
      }
    },
    toggleMap(): void {
      rig.toggleMap(clock());
      changed();
    },
    dispose(): void {
      hands.setOn(false);
      if (wheelTimer !== null) clearTimeout(wheelTimer);
    },
  };
  return hands;
}

/** Lanes run across on a desk (the next slot is to the right) and down on a phone: read from the plan, which holds both. */
function rowAxis(plan: WallPlan): boolean {
  const a = plan.tiles.find((t) => t.slot === 0 && t.lane === 0);
  const b = plan.tiles.find((t) => t.slot === 1 && t.lane === 0);
  if (a !== undefined && b !== undefined) return b.box.x > a.box.x;
  const c = plan.tiles.find((t) => t.slot === 0 && t.lane === 1);
  return !(a !== undefined && c !== undefined && c.box.x > a.box.x);
}
