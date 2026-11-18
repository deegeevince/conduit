// The Pencil on the stage, with no mode (PLAN-maths M4). While a written method has cells to write in, a pen that goes down inside it starts ink there: no Draw toggle, no
// switch. A short pen tap is still a press. A finger taps (and, with the lens, pans) and never writes; once a pen has been seen, a palm is ignored (`PalmGuard`).
//
//   which cell    the cell that holds most of a stroke's points, each cell taken 20% larger; the band above the top row is the carry cells (a carry box reaches up by its
//                 own height). A stroke that is mostly outside every cell is free working: it is kept, drawn, and never checked.
//   reading       none. The ink stays where it is written and nothing reads it: the person presses Send (the ink bar's, or the prompt bar's) and the turn carries the picture
//                 of the stage with the writing on it, the strokes, and the sum's id as what it was written on (`setSurface`); the model decides what comes next.
//   the cell      a typed digit over the pen's ink dims the ink (the painter says so, and `sync` recolours it); the ✕ on the cell clears its ink; the eraser end erases (the ink
//                 layer does that, and the diff here sees the strokes go)
//
// The lens used to hold the pen (`?lens=1`, `lens.ts`): it is lifted out whole, with no flag. With the lens the pen writes anywhere on the page, as it did; without it, in the
// written methods only, so that a stage with none behaves exactly as it did before.

import type { InkStroke } from '@conduit/language';
import type { MathBlockView } from '../contracts/painter';
import { PALM_SIZE, PalmGuard } from '../ink/palm';
import type { StageInk } from '../ink/stage';
import type { StageLens } from './lens';
import type { StageApp } from './stage-app';

/** A Pencil tap is a press when the pen travelled no further than this (CSS pixels) between going down and coming up. */
const PEN_TAP_TRAVEL = 8;
/** A cell is taken this much larger when a stroke is given to it. */
const INFLATE = 0.2;
/** A stroke belongs to a cell only when this share of its points are in it. */
const OWN_SHARE = 0.4;
/** The colour of writing that a typed digit has taken over. */
const DIM = '#b9b3a8';

interface Zone {
  readonly key: string;
  readonly part: string;
  readonly max: number;
  readonly box: { x: number; y: number; width: number; height: number };
  /** the box the cell's strokes are looked for in: larger by 20%, and for a carry or an exchange up to a cell's height above */
  readonly reach: { x: number; y: number; width: number; height: number };
}

export interface PenWriteOptions {
  /** the stage element: the pen is listened to here, in the capture phase */
  readonly host: HTMLElement;
  readonly ink: StageInk;
  /** the palm guard the ink layer and the lens share, so that a pen seen by one is seen by all */
  readonly guard: PalmGuard;
  /** with the lens (`?lens=1`) the pen writes anywhere on the page; without it, only in a written method */
  readonly lens: StageLens | null;
  /** the stage is the one to hear a pen now: no document covers it */
  readonly active: () => boolean;
  /** the written methods on stage now (the painter's own list) */
  readonly views: () => readonly MathBlockView[];
  /** a short Pencil tap, as a press */
  readonly penTap: (event: PointerEvent) => void;
  /** whether something that can be pressed (a button, a choice, a control, a cell) is at this point: in Draw a short tap on nothing is a dot, and on one of these it is a press (default: always) */
  readonly pressable?: (event: PointerEvent) => boolean;
  /** the painter: the pen has ink in a cell (or none now) */
  readonly painter: { mathInk(key: string, part: string, on: boolean): void };
}

export interface PenWrite {
  /** takes the pen's ink off a cell (its ✕) */
  clear(key: string, part: string): void;
  /** the written methods changed: ink under a typed digit is shown faint */
  sync(views: readonly MathBlockView[]): void;
  dispose(): void;
}

/** The palm guard a stage shares between its ink and its pen: the lens's own when there is one. */
export const guardFor = (lens: StageLens | null): PalmGuard => lens?.guard ?? new PalmGuard('auto');

const inside = (box: { x: number; y: number; width: number; height: number }, x: number, y: number): boolean => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;

/** Where each cell of the open written methods takes a stroke. */
function zonesOf(views: readonly MathBlockView[]): Zone[] {
  const out: Zone[] = [];
  for (const view of views) {
    for (const cell of view.cells) {
      const b = cell.box;
      const up = /^(carry|exchange)/.test(cell.label) ? b.height : 0;
      out.push({
        key: view.key,
        part: cell.part,
        max: cell.maxLength,
        box: b,
        reach: { x: b.x - b.width * INFLATE / 2, y: b.y - b.height * INFLATE / 2 - up, width: b.width * (1 + INFLATE), height: b.height * (1 + INFLATE) + up },
      });
    }
  }
  return out;
}

/** The cell that holds most of a stroke's points: null when no cell holds enough of them (free working). */
export function cellOf(stroke: InkStroke, zones: readonly Zone[]): { readonly key: string; readonly part: string } | null {
  if (stroke.points.length === 0 || zones.length === 0) return null;
  const counts = new Map<Zone, number>();
  for (const [x, y] of stroke.points) {
    let best: Zone | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const zone of zones) {
      if (!inside(zone.reach, x, y)) continue;
      const distance = Math.hypot(x - (zone.box.x + zone.box.width / 2), y - (zone.box.y + zone.box.height / 2));
      if (distance < nearest) {
        nearest = distance;
        best = zone;
      }
    }
    if (best !== null) counts.set(best, (counts.get(best) ?? 0) + 1);
  }
  let top: Zone | null = null;
  let most = 0;
  for (const [zone, count] of counts) {
    if (count > most) {
      top = zone;
      most = count;
    }
  }
  return top !== null && most / stroke.points.length >= OWN_SHARE ? { key: top.key, part: top.part } : null;
}

export function mountPenWrite(options: PenWriteOptions): PenWrite {
  const { host, ink, guard, lens, painter } = options;
  const anywhere = lens !== null;
  const model = ink.ink.model;
  ink.through(true);
  // fb-102. While a written method has cells to write in, the stage takes the Pencil with no gesture of the browser's to wait for: `touch-action: none` (the stage is `pinch-zoom` otherwise, which
  // leaves the browser free to read a resting hand and the pen as a pinch, and a pinch cancels the pen's stream; Safari's own arbitration cannot be seen from a desktop browser, so this is the
  // safe setting, not a measured fix). Only while there is a sum to write in, so that nothing else on the page changes for a finger.
  const touchActionWas = host.style.touchAction;
  const takePen = (views: readonly MathBlockView[]): void => {
    if (anywhere) return;
    const writing = views.some((view) => view.cells.length > 0);
    const want = writing ? 'none' : touchActionWas;
    if (host.style.touchAction !== want) host.style.touchAction = want;
  };

  /** a point of the screen as a point of the page the strokes live on */
  const pageOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const at = host.getBoundingClientRect();
    return lens === null ? { x: clientX - at.left, y: clientY - at.top } : lens.toPage(clientX - at.left, clientY - at.top);
  };
  /** whether a pen at this point is on a written method that still has cells to write in */
  const onMethod = (e: PointerEvent): boolean => {
    const at = pageOf(e.clientX, e.clientY);
    return options.views().some((view) => inside({ x: view.box.x - 16, y: view.box.y - 16, width: view.box.width + 32, height: view.box.height + 32 }, at.x, at.y));
  };

  // ----------------------------------------------------------------------------------------------------------------------------- the pen
  // It goes down on the stage: the ink begins the stroke at once; if the pen then comes up having hardly moved it was a tap, the stroke is thrown away and what is under it is pressed.
  const downs = new Map<number, { readonly x: number; readonly y: number; readonly eraser: boolean; readonly drawing: boolean; travel: number }>();
  const works = (): boolean => !ink.isOpen() && options.active();
  const onPen = (e: PointerEvent): void => {
    if (e.pointerType !== 'pen') return;
    // seen: from now on a hand resting by the pen is a palm, and a finger on this device taps or pans
    if (e.type === 'pointermove' || e.type === 'pointerdown') guard.penNear(e.timeStamp);
    if (e.type === 'pointerdown') {
      if (!works() || (e.button !== 0 && e.button !== 5)) return;
      const target = e.target;
      // In Draw (the Pencil draws anywhere on the stage, a finger and a mouse work what is under the layer) a chart or an app is drawn over like the rest of the stage; a button or a
      // field of the page, and the bar, are still worked by the pen as they always were
      const drawing = ink.drawing();
      if (target instanceof Element && target.closest(drawing ? 'button, input, textarea, select, a[href], [contenteditable="true"], .ink-bar' : 'button, input, textarea, select, a[href], [contenteditable="true"], .stage__chart, .stage__app, .ink-bar')) return;
      if (!anywhere && !drawing && !onMethod(e)) return;
      downs.set(e.pointerId, { x: e.clientX, y: e.clientY, eraser: e.button === 5 || (e.buttons & 32) !== 0, drawing, travel: 0 });
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
    // (in Draw a tap on nothing is a dot, a mark like any other: only a tap on something that can be pressed is a press, fb-103)
    if (e.type === 'pointerup' && !down.eraser && Math.max(down.travel, Math.hypot(e.clientX - down.x, e.clientY - down.y)) <= PEN_TAP_TRAVEL && (!down.drawing || (options.pressable?.(e) ?? true))) {
      ink.abort(e.pointerId);
      options.penTap(e);
    }
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) host.addEventListener(type, onPen as EventListener, true);

  // A palm is ignored: once a pen has been seen, a touch that comes while the pen is on the screen, or whose contact is wider than a fingertip, is not a hand's press
  // (with the lens, the lens's own gestures say the same through the same guard)
  const onTouch = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch' || anywhere || !guard.seenPen) return;
    if (guard.penInContact || Math.max(e.width, e.height) > PALM_SIZE) e.stopImmediatePropagation();
  };
  host.addEventListener('pointerdown', onTouch, true);

  // ----------------------------------------------------------------------------------------------------------------------------- whose strokes
  /** every stroke the ink holds, and the cell it was given to (null: free working) */
  const owner = new Map<string, { key: string; part: string } | null>();
  /** the sum each owned stroke was written under (fb-097): a stroke belongs to a sum, not only to a block's id, which a later sum may take again */
  const sumOf = new Map<string, string>();
  const dimmed = new Set<string>();
  /** the sum most of the pen's writing is in, named for the turn that carries it: its id (what the model knows it by). Null: none of the ink is in a sum. */
  ink.setSurface(() => {
    const counts = new Map<string, number>();
    for (const stroke of model.strokes) {
      const own = owner.get(stroke.id);
      if (own != null) counts.set(own.key, (counts.get(own.key) ?? 0) + 1);
    }
    let best: string | null = null;
    let most = 0;
    for (const [key, count] of counts) {
      if (count > most) {
        best = key;
        most = count;
      }
    }
    const view = best === null ? undefined : options.views().find((candidate) => candidate.key === best);
    return view === undefined ? null : { element: view.id, label: 'the sum on the stage, as the user saw it' };
  });

  const strokesOf = (key: string, part: string): InkStroke[] => model.strokes.filter((stroke) => {
    const own = owner.get(stroke.id);
    return own != null && own.key === key && own.part === part;
  });

  const noticed = (): void => {
    const present = new Set(model.strokes.map((stroke) => stroke.id));
    for (const [id, own] of [...owner]) {
      if (present.has(id)) continue;
      owner.delete(id);
      sumOf.delete(id);
      dimmed.delete(id);
      if (own !== null && strokesOf(own.key, own.part).length === 0) painter.mathInk(own.key, own.part, false);
    }
    const zones = zonesOf(options.views());
    for (const stroke of model.strokes) {
      if (owner.has(stroke.id)) continue;
      const own = cellOf(stroke, zones);
      owner.set(stroke.id, own);
      if (own === null) continue;
      const sum = options.views().find((view) => view.key === own.key)?.sum;
      if (sum !== undefined) sumOf.set(stroke.id, sum);
      painter.mathInk(own.key, own.part, true);
    }
  };
  const offChange = ink.ink.onChange(noticed);

  // ----------------------------------------------------------------------------------------------------------------------------- for the test hook
  const hook = window as unknown as { __penWrite?: unknown };
  hook.__penWrite = {
    owners: (): { stroke: string; key: string; part: string }[] => [...owner].flatMap(([stroke, own]) => (own === null ? [] : [{ stroke, key: own.key, part: own.part }])),
    free: (): string[] => [...owner].flatMap(([stroke, own]) => (own === null ? [stroke] : [])),
    colours: (): string[] => model.strokes.map((stroke) => stroke.color),
  };

  return {
    clear(key, part) {
      const ids = strokesOf(key, part).map((stroke) => stroke.id);
      if (ids.length > 0) model.erase(new Set(ids));
    },
    sync(views) {
      takePen(views);
      // fb-097. The working a sum had written leaves with the sum: ink owned by a block that is no longer on the stage, or that now works another sum under the same id, is taken off
      const stale = model.strokes.filter((stroke) => {
        const own = owner.get(stroke.id);
        if (own == null) return false;
        const view = views.find((candidate) => candidate.key === own.key);
        return view === undefined || (sumOf.get(stroke.id) ?? view.sum) !== view.sum;
      });
      if (stale.length > 0) model.erase(new Set(stale.map((stroke) => stroke.id)));
      const faint = new Set<string>();
      for (const view of views) for (const cell of view.cells) if (cell.dim) for (const stroke of strokesOf(view.key, cell.part)) if (!dimmed.has(stroke.id)) faint.add(stroke.id);
      if (faint.size === 0) return;
      for (const id of faint) dimmed.add(id);
      model.recolour(faint, DIM);
    },
    dispose() {
      offChange();
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) host.removeEventListener(type, onPen as EventListener, true);
      host.removeEventListener('pointerdown', onTouch, true);
      ink.through(false);
      host.style.touchAction = touchActionWas;
      delete hook.__penWrite;
    },
  };
}

/** The pen on a mounted stage: wired to the painter, the link and the stage's taps. */
export function mountPenWriting(app: StageApp, ink: StageInk, host: HTMLElement, guard: PalmGuard): PenWrite {
  const write = mountPenWrite({
    host,
    ink,
    guard,
    lens: app.lens,
    active: () => app.stageActive(),
    views: () => app.painter.mathViews(),
    penTap: (event) => app.penTap(event),
    pressable: (event) => app.pressableAt(event.clientX, event.clientY),
    painter: { mathInk: (key, part, on) => app.painter.mathInk(key, part, on) },
  });
  app.pen.set(write);
  app.painter.on('math', (views) => write.sync(views));
  return write;
}
