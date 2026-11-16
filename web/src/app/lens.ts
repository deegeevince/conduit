// The stage's lens (PLAN-canvas step 1, behind `?lens=1`): pinch and pan into any answer, with the Pencil still inking and a tap landing where it is made.
//
// What this file is: the DOM glue. The motion is `PageRig` (wall/lens.ts), the hands are `attachGestures` (wall/gestures.ts), the numbers are
// painter/view.ts and contracts/space.ts. Nothing here lays anything out: the painter still draws the page as it always has, and the lens only
// says which part of it the screen shows.
//
//   renderer   a wrapper that stamps the lens on every frame (`Frame.view`); the three.js renderer crops its camera to it, the plain renderer
//              moves its box; at rest the frame is passed on untouched
//   DOM layers the text, charts, apps and controls layers live in one `div.stage__page`, which carries one CSS transform
//   ink        the layer is looked through the same lens (`Ink.setView`), its strokes in page units
//   pen        on a device that has shown a pen, a Pencil drag draws without Draw being switched on and a short tap presses
//   pointers   `toPage` maps a screen point to the page: the one place the stage's own handlers turn a pointer into a point

import type { Frame } from '../contracts/frame';
import type { Renderer } from '../contracts/renderer';
import { cssOf, isRest, toPage as pageOf } from '../contracts/space';
import type { Box, LensView } from '../contracts/space';
import { PalmGuard, PALM_SIZE } from '../ink/palm';
import type { StageInk } from '../ink/stage';
import { viewOf } from '../painter/view';
import { PageRig } from '../wall/lens';
import { attachGestures } from '../wall/gestures';
import type { Hands } from '../wall/gestures';
import type { Motion, Screen } from '../wall/view';

/** A Pencil tap is a press when the pen travelled no further than this (CSS pixels) between going down and coming up. */
const PEN_TAP_TRAVEL = 8;
/** An arrow key moves the page this far, screen pixels; Page Up and Page Down this share of the window. */
const ARROW_PX = 80;
const PAGE_SHARE = 0.85;
/** One notch of `+` and `-`. */
const KEY_ZOOM = 1.25;
/** A tap that follows another on empty stage within this is Fit; and the zoom a double tap goes to from Fit. */
const DOUBLE_ZOOM = 2;

export interface LensRenderer {
  readonly renderer: Renderer;
  /** the lens the next frames are drawn through; null at rest. Draws the last frame again at once, so a lens that moves while the stage rests is seen. */
  setView(view: LensView | null): void;
}

/**
 * Wraps a renderer so that every frame carries the lens. With no lens (the page's top-left at one to one) the frame goes on exactly as the painter made it,
 * so the lens being on does nothing to a stage that has not been touched.
 */
export function createLensRenderer(inner: Renderer): LensRenderer {
  let view: LensView | null = null;
  let last: Frame | null = null;
  const stamp = (frame: Frame): Frame => (view === null ? frame : { ...frame, page: frame.page ?? { x: 0, y: 0, width: frame.viewport.width, height: frame.viewport.height }, view });
  const renderer: Renderer = {
    get id() {
      return inner.id;
    },
    get capabilities() {
      return inner.capabilities;
    },
    ...(inner.fontFile === undefined ? {} : { fontFile: inner.fontFile }),
    ...(inner.onContext === undefined ? {} : { onContext: inner.onContext.bind(inner) }),
    ...(inner.recheck === undefined ? {} : { recheck: inner.recheck.bind(inner) }),
    mount: (host, viewport, look, options) => inner.mount(host, viewport, look, options),
    resize: (viewport) => inner.resize(viewport),
    render(frame) {
      last = frame;
      inner.render(stamp(frame));
    },
    isDrawable: () => inner.isDrawable(),
    reset: () => inner.reset(),
    preload: (url) => inner.preload(url),
    rasterise: (frame, options) => inner.rasterise(frame, options),
    pick: (x, y) => inner.pick(x, y),
    setQuality: (quality) => inner.setQuality(quality),
    dispose: () => inner.dispose(),
  };
  return {
    renderer,
    setView(next) {
      view = next;
      if (last !== null && inner.isDrawable()) inner.render(stamp(last));
    },
  };
}

export interface LensOptions {
  /** the stage element: the hands listen here, in the capture phase */
  readonly host: HTMLElement;
  /** the element the DOM layers live in (`div.stage__page`): it carries the one transform */
  readonly page: HTMLElement;
  readonly renderer: LensRenderer;
  /** the screen: the stage's size now */
  readonly screen: () => Screen;
  /** the page's own box: the screen's size until the layout makes pages of their own */
  readonly pageBox: () => Box;
  readonly motion: () => Motion;
  /** the lens is not the one to hear a new hand now: a document or a wall covers the stage */
  readonly active: () => boolean;
  /** Whether this pointer or wheel is the stage's own (a control, a chart, an app, a button, a field) and not the lens's. May take the pointer (a control that holds a finger). */
  readonly owns: (event: PointerEvent | WheelEvent) => boolean;
  /** A tap, at client pixels. True when it pressed something; false leaves the spot empty. */
  readonly tap: (x: number, y: number, event: PointerEvent) => boolean;
  /** A short Pencil tap: press what is under it as a down and an up there. */
  readonly penTap: (event: PointerEvent) => void;
  /** The lens has taken these pointers: whoever began a press or a drag with one must let go of it. */
  readonly letGo: (pointers: readonly number[]) => void;
  /** Whether the keyboard is the stage's now (nothing else holds it). */
  readonly keysAreMine: (target: EventTarget | null) => boolean;
}

export interface StageLens {
  /** shared with the ink layer: a pen seen by one is seen by both */
  readonly guard: PalmGuard;
  /** the lens now, null at rest */
  view(): LensView | null;
  /** a point of the screen (CSS pixels from the stage's top-left) as a point of the page */
  toPage(x: number, y: number): { readonly x: number; readonly y: number };
  /** whether the lens is the one to hear a new finger now (not while a document covers the stage) */
  handling(): boolean;
  /** has the person touched the lens: if not, it goes where Fit puts it */
  readonly touched: boolean;
  fit(): void;
  /** Brings a page box into view by the least move (a control the keyboard went to). */
  reveal(box: Box): void;
  /** the screen or the page changed size */
  resize(): void;
  /** the stage's ink: the lens hands it the pen and the view, and takes them back when it is put away */
  useInk(ink: StageInk | null): void;
  /** whether the lens is drawing the pen's strokes itself (there is ink, and Draw is not what has it) */
  readonly pen: boolean;
  dispose(): void;
}

export function createStageLens(options: LensOptions): StageLens {
  const { host, page, screen } = options;
  const guard = new PalmGuard('auto');
  const rig = new PageRig(options.pageBox(), screen(), { motion: options.motion });
  const clock = (): number => performance.now();
  let view: LensView | null = null;
  let ink: StageInk | null = null;
  let frame = 0;
  let space = false;
  let disposed = false;

  page.style.transformOrigin = '0 0';

  /** Puts the lens where the rig says: the renderer, the DOM layers and the ink all read the same view. */
  const apply = (): void => {
    const now = viewOf(rig.current(clock()), screen());
    const next = isRest(now) ? null : now;
    if (next === null && view === null) return;
    if (next !== null && view !== null && next.x === view.x && next.y === view.y && next.scale === view.scale && next.width === view.width && next.height === view.height) return;
    view = next;
    page.style.transform = cssOf(view);
    options.renderer.setView(view);
    ink?.setView(view === null ? null : { x: view.x, y: view.y, scale: view.scale });
  };

  const loop = (now: number): void => {
    frame = 0;
    if (disposed) return;
    // for the browser checks (`lens-bench.ts`): what each frame of a moving lens cost on the page's thread, and the gap since the one before
    const trace = (window as unknown as { __lensTrace?: { cost: number[]; gap: number[]; last: number } }).__lensTrace;
    const began = trace === undefined ? 0 : performance.now();
    rig.tick(now);
    apply();
    if (trace !== undefined) {
      trace.cost.push(performance.now() - began);
      if (trace.last > 0) trace.gap.push(now - trace.last);
      trace.last = now;
    }
    if (rig.moving()) frame = requestAnimationFrame(loop);
  };
  const kick = (): void => {
    if (frame === 0 && !disposed) frame = requestAnimationFrame(loop);
  };

  const fit = (): void => {
    rig.fit(clock());
    kick();
  };

  const inScope = (target: EventTarget | null): boolean => options.keysAreMine(target);

  const onKeys = (e: KeyboardEvent): boolean => {
    if (e.metaKey || e.ctrlKey || e.altKey || !inScope(e.target)) return false;
    const now = clock();
    const h = screen().height;
    switch (e.key) {
      case '0':
        rig.fit(now);
        break;
      case '1':
        rig.actual(now);
        break;
      case '+':
      case '=':
        rig.step(KEY_ZOOM, now);
        break;
      case '-':
      case '_':
        rig.step(1 / KEY_ZOOM, now);
        break;
      case 'ArrowLeft':
        rig.nudge(ARROW_PX, 0, now);
        break;
      case 'ArrowRight':
        rig.nudge(-ARROW_PX, 0, now);
        break;
      case 'ArrowUp':
        rig.nudge(0, ARROW_PX, now);
        break;
      case 'ArrowDown':
        rig.nudge(0, -ARROW_PX, now);
        break;
      case 'PageUp':
        rig.nudge(0, h * PAGE_SHARE, now);
        break;
      case 'PageDown':
        rig.nudge(0, -h * PAGE_SHARE, now);
        break;
      case 'Home':
        rig.nudge(0, 1e6, now);
        break;
      case 'End':
        rig.nudge(0, -1e6, now);
        break;
      default:
        return false;
    }
    kick();
    return true;
  };

  const local = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = host.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  };

  /** two quick taps on empty stage: Fit when the page is zoomed in, else one step in about that spot */
  const onDoubleTap = (clientX: number, clientY: number): boolean => {
    const now = clock();
    const here = rig.current(now);
    const fitted = rig.fitted();
    if (here.scale > fitted.scale * 1.08) rig.fit(now);
    else {
      const at = local(clientX, clientY);
      const s = screen();
      rig.zoomTo(Math.min(rig.limits.max, Math.max(fitted.scale * DOUBLE_ZOOM, 1)), now, at.x - s.width / 2, at.y - s.height / 2);
    }
    kick();
    return true;
  };

  const hands: Hands = attachGestures(host, rig, {
    screen,
    capture: true,
    swallow: true,
    lazyGrab: true,
    ignorePen: true,
    ignoreSynthetic: true,
    wheelAfter: true,
    tapMs: 800,
    active: options.active,
    inLive: (_target, event) => options.owns(event),
    rejectTouch: (e) => guard.penBusy(e.timeStamp) || Math.max(e.width, e.height) > PALM_SIZE,
    // a mouse drag selects text; it pans only with the middle button, or the left one with Space held
    mousePans: (e) => e.button === 1 || (e.button === 0 && space),
    onTapAt: (x, y, e) => options.tap(x, y, e),
    onDoubleTap,
    onKeys,
    onPinch: (ids) => {
      options.letGo(ids);
      for (const id of ids) ink?.abort(id);
    },
    onChange: kick,
  });
  hands.setOn(true);

  const onSpace = (e: KeyboardEvent): void => {
    if (e.key === ' ') space = e.type === 'keydown';
  };
  window.addEventListener('keydown', onSpace);
  window.addEventListener('keyup', onSpace);

  // ----------------------------------------------------------------------------------------------------------------------------- the pen
  // A pen is the lens's own to look after only when there is ink to draw on and Draw is not what has the layer (then the layer takes the pen itself). It goes down
  // on the stage: the ink begins the stroke at once; if the pen then comes up having hardly moved it was a tap, the stroke is thrown away and what is under it is pressed.
  const downs = new Map<number, { readonly x: number; readonly y: number; travel: number }>();
  const penWorks = (): boolean => ink !== null && !ink.isOpen() && options.active();
  const onPen = (e: PointerEvent): void => {
    if (e.pointerType !== 'pen') return;
    // seen: from now on a hand resting by the pen is a palm, and a finger on this device pans or points
    if (e.type === 'pointermove' || e.type === 'pointerdown') guard.penNear(e.timeStamp);
    if (e.type === 'pointerdown') {
      if (!penWorks() || ink === null || e.button !== 0 && e.button !== 5) return;
      const target = e.target;
      // a button, a field or a chart is worked by the pen as it always was
      if (target instanceof Element && target.closest('button, input, textarea, select, a[href], [contenteditable="true"], .stage__chart, .stage__app, .ink-bar')) return;
      downs.set(e.pointerId, { x: e.clientX, y: e.clientY, travel: 0 });
      e.stopImmediatePropagation();
      ink.penDown(e);
      return;
    }
    const down = downs.get(e.pointerId);
    if (down === undefined) return;
    if (e.type === 'pointermove') {
      down.travel = Math.max(down.travel, Math.hypot(e.clientX - down.x, e.clientY - down.y));
      return;
    }
    if (e.type !== 'pointerup' && e.type !== 'pointercancel') return;
    downs.delete(e.pointerId);
    // the layer is the one to tell the guard the pen has lifted when it had the stroke; this makes sure that it is told, whoever had it
    guard.penLifted(e.pointerId, e.timeStamp);
    if (e.type === 'pointerup' && Math.max(down.travel, Math.hypot(e.clientX - down.x, e.clientY - down.y)) <= PEN_TAP_TRAVEL) {
      ink?.abort(e.pointerId);
      options.penTap(e);
    }
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) host.addEventListener(type, onPen as EventListener, true);

  // for the browser checks: whether a move of the lens is still going
  (window as unknown as { __lensMoving?: () => boolean }).__lensMoving = () => rig.moving();

  const lens: StageLens = {
    guard,
    view: () => view,
    toPage: (x, y) => pageOf(viewOf(rig.current(clock()), screen()), x, y),
    handling: () => options.active(),
    get touched() {
      return rig.touched;
    },
    fit,
    reveal(box) {
      rig.reveal(box, clock());
      kick();
    },
    resize() {
      rig.setPage(options.pageBox(), screen());
      apply();
      kick();
    },
    useInk(next) {
      ink?.through(false);
      ink?.setView(null);
      ink = next;
      if (ink !== null) {
        ink.through(true);
        ink.setView(view === null ? null : { x: view.x, y: view.y, scale: view.scale });
      }
    },
    get pen() {
      return penWorks();
    },
    dispose() {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) host.removeEventListener(type, onPen as EventListener, true);
      window.removeEventListener('keydown', onSpace);
      window.removeEventListener('keyup', onSpace);
      hands.dispose();
      ink?.through(false);
      ink?.setView(null);
      ink = null;
      page.style.transform = '';
      options.renderer.setView(null);
      delete (window as unknown as { __lensMoving?: () => boolean }).__lensMoving;
    },
  };
  return lens;
}
