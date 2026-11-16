// The ink layer: a box that takes a pen, a finger or a mouse, draws what it takes on a low-latency canvas, and keeps it as strokes.
//
// It fills `host`, or sits over any element (`overlayOn`). It makes no network request, reads no storage and needs nothing outside the DOM, so the same
// code runs on the stage and inside a sandboxed surface. What goes up with a turn is built by `send.ts` from `marks()` here.
//
// Two canvases: `base` holds every finished stroke and is redrawn when the strokes or the size change; `live` (created `desynchronized` so the browser
// can put it on screen without waiting for the page's frame) holds only the stroke being drawn, with the pen's predicted next points on the end.

import { INK_LIMITS } from '../../../language/src/ink';
import type { InkBox, InkDocument, InkMarks, InkOn, InkPoint, InkRegionDef, InkRegionHit, InkSpace, InkStroke, InkVoice } from '@conduit/language';
import { exportPng, exportSvg } from './export';
import type { ExportOptions, InkBackdrop } from './export';
import { regionOf, reportRegions, strokeBounds, strokeTouches, inflate } from './geometry';
import { InkModel } from './model';
import { PalmGuard } from './palm';
import type { PointerKind } from './palm';
import { drawHighlight, drawPen, drawStrokes, HIGHLIGHTER_ALPHA } from './render';
import { injectInkStyles } from './styles';

export type InkToolName = 'pen' | 'highlighter' | 'eraser';

/** What the ink is drawn over: a picture (shown as an image, and drawn into the exported picture), or a card the view shows itself. */
export interface InkBackground {
  /** an address the page may load an image from (a kept photo's URL, a data: URL) */
  readonly src?: string;
  /** the upload id of that photo, so the send names it (`marks.background`) */
  readonly id?: string;
  /** a card the view draws itself: shown as it is; `draw` paints it into the exported picture (without it the picture shows the ink on white) */
  readonly draw?: (ctx: CanvasRenderingContext2D, space: InkSpace) => void;
  readonly alt?: string;
}

export interface InkOptions {
  /** the units strokes live in; default: the host's size now, in CSS pixels. With a picture: its own pixel size. */
  readonly space?: InkSpace;
  /** `fill`: the layer covers the host. `flow`: the layer is as wide as the host and as tall as the space is, in the page's flow (a worksheet to scroll) */
  readonly placement?: 'fill' | 'flow';
  readonly background?: InkBackground;
  readonly regions?: readonly InkRegionDef[];
  readonly on?: InkOn;
  /** a box always in the picture sent with the ink: the question the working is under */
  readonly context?: InkBox;
  /** `auto` (default): a finger draws until a pen has been seen. */
  readonly fingerDraws?: 'auto' | boolean;
  /** CSS pixels the pen draws at full pressure (default 3.2) and the highlighter's width (default 18) */
  readonly penSize?: number;
  readonly highlighterSize?: number;
  readonly colors?: readonly string[];
  readonly document?: InkDocument;
  /** what a finger's drag scrolls when it is not drawing (default: the nearest scrolling ancestor, else the page) */
  readonly scroller?: HTMLElement | null;
  /** the picture under the ink for the exported picture, when the layer is over something it cannot read back (the stage's capture) */
  readonly backdrop?: () => Promise<InkBackdrop | null>;
  readonly onChange?: () => void;
  readonly onStroke?: (event: { readonly stroke: InkStroke; readonly region: string | null }) => void;
  /** a stroke or an erase landing is told to the page's status line */
  readonly announce?: (text: string) => void;
}

export interface LatencyStats {
  readonly samples: number;
  /** event timestamp to the stroke being on the canvas, in ms (what the page controls: queueing + drawing) */
  readonly inputToCanvas: { readonly p50: number; readonly p95: number; readonly max: number };
  /** the handler's own cost, in ms */
  readonly handler: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly desynchronized: boolean;
  readonly predicted: boolean;
}

export interface Ink {
  readonly root: HTMLElement;
  readonly model: InkModel;
  tool: InkToolName;
  color: string;
  readonly colors: readonly string[];
  setRegions(regions: readonly InkRegionDef[]): void;
  setOn(on: InkOn | undefined): void;
  setContext(box: InkBox | undefined): void;
  setBackground(background: InkBackground | null, space?: InkSpace): void;
  setFingerDraws(value: 'auto' | boolean): void;
  /** whether a finger draws now (with `auto`: until a pen has been seen) */
  fingerDraws(): boolean;
  undo(): void;
  redo(): void;
  clear(): void;
  /** forgets everything, history included (after a send) */
  reset(): void;
  load(doc: InkDocument): void;
  document(): InkDocument;
  regionReport(): { readonly regions: InkRegionHit[]; readonly outside: string[] };
  exportPng(options?: ExportOptions): ReturnType<typeof exportPng>;
  exportSvg(options?: ExportOptions): string | null;
  /** everything of `InkMarks` but the picture's id, which the sender gets from the server */
  marks(crop: InkBox, voice?: InkVoice): Omit<InkMarks, 'image'> | null;
  /** the picture for the brain: the ink cropped, over its background */
  picture(): Promise<{ readonly blob: Blob; readonly crop: InkBox } | null>;
  stats(): LatencyStats;
  onChange(listener: () => void): () => void;
  /** a fresh draw of everything (after the host's size or the page's theme changed) */
  refresh(): void;
  dispose(): void;
}

const DEFAULT_COLORS = ['#1f2933', '#c62828', '#1565c0', '#2e7d32'] as const;
const MAX_CANVAS_SIDE = 4096;
const ERASER_CSS = 14;

interface Building {
  readonly pointerId: number;
  readonly kind: PointerKind;
  readonly erase: boolean;
  readonly stroke: { id: string; tool: 'pen' | 'highlighter'; color: string; width: number; at: number };
  readonly points: InkPoint[];
  readonly started: number;
  predicted: InkPoint[];
  lastP: number;
  lastSpeedT: number;
  erased: Set<string>;
  last: { x: number; y: number } | null;
}

interface Panning {
  readonly pointerId: number;
  x: number;
  y: number;
  moved: boolean;
  readonly scroller: HTMLElement | null;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! * 100) / 100;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return null;
}

export function createInk(host: HTMLElement, options: InkOptions = {}): Ink {
  injectInkStyles(host.getRootNode() instanceof ShadowRoot ? (host.getRootNode() as ShadowRoot) : host.ownerDocument);
  const doc = host.ownerDocument;
  const placement = options.placement ?? 'fill';
  const colors = options.colors ?? DEFAULT_COLORS;

  const root = doc.createElement('div');
  root.className = `ink ink--${placement}`;
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'Drawing area. Draw with a pen, a finger or a mouse.');
  root.innerHTML = '<img class="ink__bg" alt="" draggable="false" hidden /><div class="ink__guides" aria-hidden="true"></div><canvas class="ink__base" aria-hidden="true"></canvas><canvas class="ink__live" aria-hidden="true"></canvas>';
  host.append(root);
  const bg = root.querySelector<HTMLImageElement>('.ink__bg')!;
  const guides = root.querySelector<HTMLElement>('.ink__guides')!;
  const base = root.querySelector<HTMLCanvasElement>('.ink__base')!;
  const live = root.querySelector<HTMLCanvasElement>('.ink__live')!;
  const baseCtx = base.getContext('2d')!;
  // desynchronized: the browser may present this canvas without waiting for the page's next frame, which is what takes a pen's latency from two frames to about one.
  const liveCtx = live.getContext('2d', { desynchronized: true })!;
  const desynchronized = ((liveCtx as unknown as { getContextAttributes?: () => { desynchronized?: boolean } }).getContextAttributes?.()?.desynchronized) === true;

  let space: InkSpace = options.document?.space ?? options.space ?? { w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) };
  const model = new InkModel(space, options.document?.strokes ?? []);
  let regions: readonly InkRegionDef[] = options.regions ?? [];
  let on: InkOn | undefined = options.on;
  let context: InkBox | undefined = options.context;
  let background: InkBackground | null = options.background ?? null;
  let tool: InkToolName = 'pen';
  let color: string = colors[0]!;
  const guard = new PalmGuard(options.fingerDraws ?? 'auto');
  let building: Building | null = null;
  const pans = new Map<number, Panning>();
  const ignored = new Set<number>();
  let view = { scale: 1, ox: 0, oy: 0, w: 1, h: 1, dpr: 1 };
  let disposed = false;
  let scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  const lat: number[] = [];
  const handlerCost: number[] = [];
  let sawPredicted = false;
  const listeners = new Set<() => void>();
  let eraserAt: { x: number; y: number } | null = null;

  const announce = options.announce ?? (() => undefined);

  const emitChange = (): void => {
    options.onChange?.();
    for (const listener of listeners) listener();
  };

  // ---------------------------------------------------------------- the view: space to pixels
  function layout(): void {
    if (placement === 'flow') root.style.aspectRatio = `${space.w} / ${space.h}`;
    const w = Math.max(1, root.clientWidth);
    const h = Math.max(1, root.clientHeight);
    const scale = placement === 'flow' ? w / space.w : Math.min(w / space.w, h / space.h);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_SIDE / Math.max(w, h));
    view = { scale, ox: placement === 'flow' ? 0 : (w - space.w * scale) / 2, oy: placement === 'flow' ? 0 : (h - space.h * scale) / 2, w, h, dpr };
    for (const canvas of [base, live]) {
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
    }
    const left = `${view.ox}px`;
    const top = `${view.oy}px`;
    const width = `${space.w * view.scale}px`;
    const height = `${space.h * view.scale}px`;
    Object.assign(bg.style, { left, top, width, height });
    Object.assign(guides.style, { left, top, width, height });
    drawGuides();
    redrawBase();
    redrawLive();
  }

  const apply = (ctx: CanvasRenderingContext2D): void => ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, view.dpr * view.ox, view.dpr * view.oy);

  function redrawBase(): void {
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, base.width, base.height);
    apply(baseCtx);
    drawStrokes(baseCtx, model.strokes, () => {
      if (scratch === null || scratch.canvas.width !== base.width || scratch.canvas.height !== base.height) {
        const canvas = doc.createElement('canvas');
        canvas.width = base.width;
        canvas.height = base.height;
        scratch = { canvas, ctx: canvas.getContext('2d')! };
      }
      return scratch;
    });
  }

  function redrawLive(): void {
    liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    liveCtx.clearRect(0, 0, live.width, live.height);
    apply(liveCtx);
    const b = building;
    if (b !== null && !b.erase) {
      const stroke = { ...b.stroke, points: [...b.points, ...b.predicted] } as InkStroke;
      if (stroke.tool === 'pen') drawPen(liveCtx, stroke, false);
      else {
        liveCtx.save();
        liveCtx.globalAlpha = HIGHLIGHTER_ALPHA;
        drawHighlight(liveCtx, stroke, false);
        liveCtx.restore();
      }
    }
    if (tool === 'eraser' && eraserAt !== null) {
      liveCtx.beginPath();
      liveCtx.arc(eraserAt.x, eraserAt.y, ERASER_CSS / view.scale, 0, Math.PI * 2);
      liveCtx.lineWidth = 1.5 / view.scale;
      liveCtx.strokeStyle = 'rgba(30,30,30,.7)';
      liveCtx.fillStyle = 'rgba(255,255,255,.35)';
      liveCtx.fill();
      liveCtx.stroke();
    }
  }

  function drawGuides(): void {
    guides.replaceChildren();
    for (const region of regions) {
      const el = doc.createElement('div');
      el.className = `ink__box ink__box--${region.kind}`;
      el.dataset['region'] = region.id;
      Object.assign(el.style, { left: `${region.box.x * view.scale}px`, top: `${region.box.y * view.scale}px`, width: `${region.box.w * view.scale}px`, height: `${region.box.h * view.scale}px` });
      if (region.label !== undefined) {
        const label = doc.createElement('span');
        label.className = 'ink__label';
        label.textContent = region.label;
        el.append(label);
      }
      guides.append(el);
    }
  }

  function setBackgroundNow(next: InkBackground | null): void {
    background = next;
    if (next?.src !== undefined) {
      bg.hidden = false;
      bg.src = next.src;
      bg.alt = next.alt ?? '';
    } else {
      bg.hidden = true;
      bg.removeAttribute('src');
    }
  }
  setBackgroundNow(background);

  // ---------------------------------------------------------------- pointer handling
  const spaceOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = root.getBoundingClientRect();
    return { x: (clientX - rect.left - view.ox) / view.scale, y: (clientY - rect.top - view.oy) / view.scale };
  };

  const kindOf = (e: PointerEvent): PointerKind => (e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse');

  function penWidth(kind: 'pen' | 'highlighter'): number {
    return (kind === 'pen' ? (options.penSize ?? 3.2) : (options.highlighterSize ?? 18)) / view.scale;
  }

  function sample(b: Building, e: PointerEvent): InkPoint | null {
    const at = spaceOf(e.clientX, e.clientY);
    const x = Math.min(Math.max(at.x, 0), space.w);
    const y = Math.min(Math.max(at.y, 0), space.h);
    const t = Math.max(0, e.timeStamp - b.started);
    const last = b.points[b.points.length - 1];
    if (last !== undefined && Math.hypot(x - last[0], y - last[1]) * view.scale < 0.45) return null;
    let p: number;
    if (b.kind === 'pen' && e.pressure > 0) {
      // the pen's own pressure, with a low (leaning) pen drawing a little wider, like the side of a pencil
      const lean = Math.min(1, Math.max(Math.abs(e.tiltX), Math.abs(e.tiltY)) / 80);
      p = Math.min(1, Math.max(0.05, e.pressure * (1 + 0.35 * lean)));
    } else {
      // no pressure on a mouse or a finger: slow is wide, fast is thin, as a real pen does it
      const dt = Math.max(1, t - (last?.[3] ?? 0));
      const speed = last === undefined ? 0 : (Math.hypot(x - last[0], y - last[1]) * view.scale) / dt;
      const target = Math.min(0.85, Math.max(0.25, 0.85 - speed * 0.22));
      b.lastP += (target - b.lastP) * 0.3;
      p = b.lastP;
    }
    return [x, y, p, t];
  }

  function eraseAlong(b: Building, x: number, y: number): void {
    const radius = ERASER_CSS / view.scale;
    const from = b.last ?? { x, y };
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / (radius / 2)));
    const hit = new Set<string>();
    for (let i = 1; i <= steps; i += 1) {
      const px = from.x + ((x - from.x) * i) / steps;
      const py = from.y + ((y - from.y) * i) / steps;
      for (const stroke of model.strokes) {
        if (hit.has(stroke.id)) continue;
        const bounds = inflate(strokeBounds(stroke), radius);
        if (px < bounds.x || py < bounds.y || px > bounds.x + bounds.w || py > bounds.y + bounds.h) continue;
        if (strokeTouches(stroke, px, py, radius)) hit.add(stroke.id);
      }
    }
    b.last = { x, y };
    if (hit.size > 0 && model.erase(hit)) {
      for (const id of hit) b.erased.add(id);
      redrawBase();
    }
  }

  function begin(e: PointerEvent, kind: PointerKind, erase: boolean): void {
    const asErase = erase || tool === 'eraser';
    const drawTool: 'pen' | 'highlighter' = tool === 'highlighter' ? 'highlighter' : 'pen';
    const startedAt = Date.now();
    building = {
      pointerId: e.pointerId,
      kind,
      erase: asErase,
      stroke: { id: model.newId(), tool: drawTool, color, width: penWidth(drawTool), at: startedAt },
      points: [],
      started: e.timeStamp,
      predicted: [],
      lastP: 0.7,
      lastSpeedT: e.timeStamp,
      erased: new Set(),
      last: null,
    };
    if (asErase) model.beginErase();
    root.setPointerCapture(e.pointerId);
  }

  function extend(b: Building, e: PointerEvent): void {
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    for (const ev of events) {
      if (b.erase) {
        const at = spaceOf(ev.clientX, ev.clientY);
        eraseAlong(b, at.x, at.y);
        eraserAt = at;
        continue;
      }
      const point = sample(b, ev);
      if (point !== null && b.points.length < INK_LIMITS.pointsPerStroke && model.room(b.points.length + 1)) b.points.push(point);
    }
    b.predicted = [];
    if (!b.erase && typeof e.getPredictedEvents === 'function') {
      const ahead = e.getPredictedEvents();
      if (ahead.length > 0) sawPredicted = true;
      const last = b.points[b.points.length - 1];
      for (const ev of ahead) {
        const at = spaceOf(ev.clientX, ev.clientY);
        if (last !== undefined) b.predicted.push([at.x, at.y, last[2], Math.max(last[3], ev.timeStamp - b.started)]);
      }
    }
  }

  function finish(b: Building): void {
    building = null;
    if (b.erase) {
      model.endErase();
      redrawBase();
      redrawLive();
      if (b.erased.size > 0) announce(`Erased ${b.erased.size} stroke${b.erased.size === 1 ? '' : 's'}`);
      return;
    }
    if (b.points.length === 0) {
      redrawLive();
      return;
    }
    const stroke: InkStroke = { ...b.stroke, points: b.points };
    model.add(stroke);
    note({ what: 'stroke kept', points: b.points.length, pen: b.stroke.tool });
    redrawBase();
    redrawLive();
    options.onStroke?.({ stroke, region: regions.length === 0 ? null : regionOf(stroke, regions) });
  }

  function abandon(b: Building): void {
    building = null;
    if (b.erase) model.endErase();
    note({ what: 'stroke abandoned', pen: b.kind });
    redrawLive();
  }

  /** Tells the page what the layer decided (taken, ignored and why, a stroke kept), for "Report a problem". Deferred so it never counts in a stroke's latency. */
  function note(detail: Record<string, string | number | boolean>): void {
    queueMicrotask(() => root.dispatchEvent(new CustomEvent('ink:note', { bubbles: true, detail })));
  }

  function record(started: number, event: PointerEvent): void {
    const done = performance.now();
    lat.push(done - event.timeStamp);
    handlerCost.push(done - started);
    if (lat.length > 800) {
      lat.shift();
      handlerCost.shift();
    }
  }

  const onDown = (e: PointerEvent): void => {
    const started = performance.now();
    const kind = kindOf(e);
    const eraser = kind === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5);
    const { verdict, cancel } = guard.down({
      kind,
      id: e.pointerId,
      time: e.timeStamp,
      width: e.width,
      height: e.height,
      eraser,
      primaryButton: e.button === 0,
    });
    if (cancel.length > 0 && building !== null && cancel.includes(building.pointerId)) abandon(building);
    for (const id of cancel) pans.delete(id);
    if (verdict.act === 'ignore') {
      ignored.add(e.pointerId);
      note({ what: 'pointer ignored', kind, why: verdict.why });
      return;
    }
    note({ what: verdict.act === 'pan' ? 'pointer pans' : verdict.erase ? 'pointer erases' : 'pointer draws', kind });
    e.preventDefault();
    root.focus({ preventScroll: true });
    if (verdict.act === 'pan') {
      pans.set(e.pointerId, { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false, scroller: options.scroller ?? scrollParent(root) });
      root.setPointerCapture(e.pointerId);
      return;
    }
    // a stroke that never heard its pointerup (the layer was hidden, or the pen left the screen) ends here; it must not swallow the next one
    if (building !== null) finish(building);
    begin(e, kind, verdict.erase);
    const b = building as Building | null;
    if (b !== null) {
      if (b.erase) {
        const at = spaceOf(e.clientX, e.clientY);
        eraserAt = at;
        eraseAlong(b, at.x, at.y);
      } else {
        const first = sample(b, e);
        if (first !== null) b.points.push(first);
        else {
          const at = spaceOf(e.clientX, e.clientY);
          b.points.push([at.x, at.y, 0.6, 0]);
        }
      }
      redrawLive();
      record(started, e);
    }
  };

  const onMove = (e: PointerEvent): void => {
    const started = performance.now();
    const kind = kindOf(e);
    if (kind === 'pen') guard.penNear(e.timeStamp);
    if (ignored.has(e.pointerId)) return;
    const pan = pans.get(e.pointerId);
    if (pan !== undefined) {
      if (guard.penInContact) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < 6) return;
      pan.moved = true;
      pan.x = e.clientX;
      pan.y = e.clientY;
      if (pan.scroller !== null) pan.scroller.scrollBy(-dx, -dy);
      else window.scrollBy(-dx, -dy);
      return;
    }
    const b = building;
    if (b === null || b.pointerId !== e.pointerId) {
      // hovering: the eraser's ring follows the pen or the mouse
      if (tool === 'eraser' && (kind === 'pen' || kind === 'mouse') && (e.buttons === 0 || kind === 'pen')) {
        eraserAt = spaceOf(e.clientX, e.clientY);
        redrawLive();
      }
      return;
    }
    e.preventDefault();
    extend(b, e);
    redrawLive();
    record(started, e);
  };

  const onUp = (e: PointerEvent): void => {
    const kind = kindOf(e);
    if (kind === 'pen') guard.penLifted(e.pointerId, e.timeStamp);
    guard.released(e.pointerId);
    ignored.delete(e.pointerId);
    pans.delete(e.pointerId);
    const b = building;
    if (b !== null && b.pointerId === e.pointerId) {
      const started = performance.now();
      extend(b, e);
      finish(b);
      record(started, e);
    }
  };

  const onCancel = (e: PointerEvent): void => {
    if (kindOf(e) === 'pen') guard.penLifted(e.pointerId, e.timeStamp);
    guard.released(e.pointerId);
    ignored.delete(e.pointerId);
    pans.delete(e.pointerId);
    const b = building;
    if (b !== null && b.pointerId === e.pointerId) abandon(b);
  };

  const onLeave = (): void => {
    if (eraserAt !== null && building === null) {
      eraserAt = null;
      redrawLive();
    }
  };

  const stop = (e: Event): void => e.preventDefault();
  const onKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    }
  };

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onCancel);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('contextmenu', stop);
  root.addEventListener('keydown', onKey);
  root.addEventListener('selectstart', stop);
  root.addEventListener('dragstart', stop);

  const unsubscribe = model.onChange(() => {
    if (building === null) redrawBase();
    emitChange();
  });

  const observer = new ResizeObserver(() => {
    if (!disposed) layout();
  });
  observer.observe(root);
  layout();

  // ---------------------------------------------------------------- the handle
  function undo(): void {
    if (building !== null) return;
    if (model.undo()) announce('Undone');
  }
  function redo(): void {
    if (building !== null) return;
    if (model.redo()) announce('Redone');
  }

  const report = (): { regions: InkRegionHit[]; outside: string[] } => reportRegions(model.strokes, regions);

  const exportOptions = async (extra: ExportOptions | undefined): Promise<ExportOptions> => {
    const picked = options.backdrop === undefined ? null : await options.backdrop();
    let backdrop: InkBackdrop | null = extra?.backdrop ?? picked;
    if (backdrop === null && background?.src !== undefined && bg.complete && bg.naturalWidth > 0) backdrop = { kind: 'image', image: bg };
    if (backdrop === null && background?.draw !== undefined) backdrop = { kind: 'draw', draw: background.draw };
    return { regions, ...(context === undefined ? {} : { include: [context] }), ...extra, backdrop };
  };

  const handle: Ink = {
    root,
    model,
    get tool() {
      return tool;
    },
    set tool(next) {
      tool = next;
      root.dataset['tool'] = next;
      if (next !== 'eraser') eraserAt = null;
      redrawLive();
    },
    get color() {
      return color;
    },
    set color(next) {
      color = next;
    },
    colors,
    setRegions(next) {
      regions = next;
      drawGuides();
    },
    setOn(next) {
      on = next;
    },
    setContext(next) {
      context = next;
    },
    setBackground(next, nextSpace) {
      setBackgroundNow(next);
      if (nextSpace !== undefined) {
        space = nextSpace;
        model.space = nextSpace;
      }
      layout();
    },
    setFingerDraws: (value) => {
      guard.setFingerDraws(value);
      emitChange();
    },
    fingerDraws: () => guard.fingerDrawing,
    undo,
    redo,
    clear: () => model.clear(),
    reset: () => model.reset(),
    load(next) {
      space = next.space;
      model.load(next);
      layout();
    },
    document: () => model.document(),
    regionReport: report,
    exportPng: async (extra) => exportPng(model.document(), await exportOptions(extra)),
    exportSvg: (extra) => exportSvg(model.document(), { regions, ...extra, ...(background?.src === undefined ? {} : { background: background.src }) }),
    marks(crop, voice) {
      if (model.strokes.length === 0) return null;
      const { regions: hits, outside } = report();
      return {
        space: model.space,
        crop,
        strokes: model.strokes,
        regions: hits,
        ...(regions.length > 0 && outside.length > 0 ? { outside } : {}),
        ...(on === undefined ? {} : { on }),
        ...(background?.id === undefined ? {} : { background: background.id }),
        ...(voice === undefined ? {} : { voice }),
      };
    },
    async picture() {
      const made = await exportPng(model.document(), await exportOptions(undefined));
      return made === null ? null : { blob: made.blob, crop: made.crop };
    },
    stats() {
      const a = [...lat].sort((x, y) => x - y);
      const c = [...handlerCost].sort((x, y) => x - y);
      return {
        samples: lat.length,
        inputToCanvas: { p50: percentile(a, 0.5), p95: percentile(a, 0.95), max: a.length === 0 ? 0 : Math.round(a[a.length - 1]! * 100) / 100 },
        handler: { p50: percentile(c, 0.5), p95: percentile(c, 0.95), max: c.length === 0 ? 0 : Math.round(c[c.length - 1]! * 100) / 100 },
        desynchronized,
        predicted: sawPredicted,
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: layout,
    dispose() {
      disposed = true;
      observer.disconnect();
      unsubscribe();
      root.remove();
    },
  };
  return handle;
}
