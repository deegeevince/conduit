// The Pencil on the stage, with no mode (PLAN-maths M4). While a written method has cells to write in, a pen that goes down inside it starts ink there: no Draw toggle, no
// switch. A short pen tap is still a press. A finger taps (and, with the lens, pans) and never writes; once a pen has been seen, a palm is ignored (`PalmGuard`).
//
//   which cell    the cell that holds most of a stroke's points, each cell taken 20% larger; the band above the top row is the carry cells (a carry box reaches up by its
//                 own height). A stroke that is mostly outside every cell is free working: it is kept, drawn, and never checked.
//   reading       800 ms after the pen lifts, and on Check, every cell whose ink changed goes up in ONE request: a numbered contact sheet (a tile a cell) and a prompt that asks
//                 for digits only. The cell shimmers while it waits, then shows the digit read, small, beside the child's own ink.
//   a misread     a tap on the cell opens its input with the digit read selected; a typed digit wins and the ink dims (the painter says so, and `sync` recolours it); the ✕ on
//                 the cell clears its ink; the eraser end erases (the ink layer does that, and the diff here sees the strokes go)
//   mixing        the last writer of a cell wins: a key after the pen, or the pen after a key (`painter/blocks/math-cells.ts`)
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
/** The pen lifts, and this long later (with no new stroke begun) what it wrote is read. */
export const READ_AFTER_MS = 800;
/** A cell is taken this much larger when a stroke is given to it. */
const INFLATE = 0.2;
/** A stroke belongs to a cell only when this share of its points are in it. */
const OWN_SHARE = 0.4;
/** The colour of writing that a typed digit has taken over. */
const DIM = '#b9b3a8';
/** A tile of the contact sheet, and how many stand in a row. */
const TILE = 200;
const PER_ROW = 4;

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
  /** keeps the picture of the sheet; resolves with its upload id */
  readonly upload: (png: Blob) => Promise<string>;
  /** reads the sheet: the digits of each tile by its number */
  readonly readDigits: (request: { readonly image: string; readonly cells: readonly { readonly n: number; readonly max: number; readonly strokes: number }[] }) => Promise<ReadonlyMap<number, string>>;
  /** the painter: the pen has ink in a cell (or none now), and what was read from it */
  readonly painter: { mathInk(key: string, part: string, on: boolean): void; mathRead(key: string, part: string, digits: string): void };
}

export interface PenWrite {
  /** takes the pen's ink off a cell (its ✕) */
  clear(key: string, part: string): void;
  /** reads whatever the pen has written that is not read yet, and resolves when the digits are in the cells (Check waits for it) */
  flush(): Promise<void>;
  /** the written methods changed: ink under a typed digit is shown faint */
  sync(views: readonly MathBlockView[]): void;
  dispose(): void;
}

/** The palm guard a stage shares between its ink and its pen: the lens's own when there is one. */
export const guardFor = (lens: StageLens | null): PalmGuard => lens?.guard ?? new PalmGuard('auto');

const cellKey = (key: string, part: string): string => `${key}\u0001${part}`;
const inside = (box: { x: number; y: number; width: number; height: number }, x: number, y: number): boolean => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;

/** Where each cell of the open written methods takes a stroke. */
function zonesOf(views: readonly MathBlockView[]): Zone[] {
  const out: Zone[] = [];
  for (const view of views) {
    if (view.verdict === 'right' || view.verdict === 'shown') continue;
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

  /** a point of the screen as a point of the page the strokes live on */
  const pageOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const at = host.getBoundingClientRect();
    return lens === null ? { x: clientX - at.left, y: clientY - at.top } : lens.toPage(clientX - at.left, clientY - at.top);
  };
  /** whether a pen at this point is on a written method that still has cells to write in */
  const onMethod = (e: PointerEvent): boolean => {
    const at = pageOf(e.clientX, e.clientY);
    return options.views().some((view) => view.verdict !== 'right' && view.verdict !== 'shown' && inside({ x: view.box.x - 16, y: view.box.y - 16, width: view.box.width + 32, height: view.box.height + 32 }, at.x, at.y));
  };

  // ----------------------------------------------------------------------------------------------------------------------------- the pen
  // It goes down on the stage: the ink begins the stroke at once; if the pen then comes up having hardly moved it was a tap, the stroke is thrown away and what is under it is pressed.
  const downs = new Map<number, { readonly x: number; readonly y: number; readonly eraser: boolean; travel: number }>();
  const works = (): boolean => !ink.isOpen() && options.active();
  const onPen = (e: PointerEvent): void => {
    if (e.pointerType !== 'pen') return;
    // seen: from now on a hand resting by the pen is a palm, and a finger on this device taps or pans
    if (e.type === 'pointermove' || e.type === 'pointerdown') guard.penNear(e.timeStamp);
    if (e.type === 'pointerdown') {
      if (!works() || (e.button !== 0 && e.button !== 5)) return;
      const target = e.target;
      // a button, a field or a chart is worked by the pen as it always was
      if (target instanceof Element && target.closest('button, input, textarea, select, a[href], [contenteditable="true"], .stage__chart, .stage__app, .ink-bar')) return;
      if (!anywhere && !onMethod(e)) return;
      downs.set(e.pointerId, { x: e.clientX, y: e.clientY, eraser: e.button === 5 || (e.buttons & 32) !== 0, travel: 0 });
      // a stroke is begun: what the last one is waiting to be read after waits for this one
      clearTimer();
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
    if (e.type === 'pointerup' && !down.eraser && Math.max(down.travel, Math.hypot(e.clientX - down.x, e.clientY - down.y)) <= PEN_TAP_TRAVEL) {
      ink.abort(e.pointerId);
      options.penTap(e);
    }
    // a pen that has lifted: what it wrote is read once it has been still for a while
    else if (dirty.size > 0) schedule();
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
  /** the sum each owned stroke was written under (fb-082): a stroke belongs to a sum, not only to a block's id, which a later sum may take again */
  const sumOf = new Map<string, string>();
  const version = new Map<string, number>();
  const dirty = new Set<string>();
  const dimmed = new Set<string>();
  ink.setOwned((id) => owner.get(id) != null);

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
      if (own === null) continue;
      const ck = cellKey(own.key, own.part);
      version.set(ck, (version.get(ck) ?? 0) + 1);
      if (strokesOf(own.key, own.part).length === 0) {
        dirty.delete(ck);
        painter.mathInk(own.key, own.part, false);
      } else {
        dirty.add(ck);
        schedule();
      }
    }
    const zones = zonesOf(options.views());
    let added = false;
    for (const stroke of model.strokes) {
      if (owner.has(stroke.id)) continue;
      const own = cellOf(stroke, zones);
      owner.set(stroke.id, own);
      if (own === null) continue;
      const sum = options.views().find((view) => view.key === own.key)?.sum;
      if (sum !== undefined) sumOf.set(stroke.id, sum);
      const ck = cellKey(own.key, own.part);
      version.set(ck, (version.get(ck) ?? 0) + 1);
      dirty.add(ck);
      added = true;
      painter.mathInk(own.key, own.part, true);
    }
    // the ink layer keeps the bar and the badge by what is owned
    ink.setOwned((id) => owner.get(id) != null);
    // the pen lifted (or the ink was put back): the wait begins; a stroke still being drawn is not in the model yet
    if (added && downs.size === 0) schedule();
  };
  const offChange = ink.ink.onChange(noticed);

  // ----------------------------------------------------------------------------------------------------------------------------- reading
  let timer: number | undefined;
  let busy: Promise<void> | null = null;
  function clearTimer(): void {
    window.clearTimeout(timer);
    timer = undefined;
  }
  function schedule(): void {
    clearTimer();
    timer = window.setTimeout(() => void flush(), READ_AFTER_MS);
  }

  interface Entry {
    readonly n: number;
    readonly key: string;
    readonly part: string;
    readonly max: number;
    readonly version: number;
    readonly box: { x: number; y: number; width: number; height: number };
    readonly strokes: InkStroke[];
  }

  /** the sheet: a tile for each cell, its number in the corner, the cell's own edge in grey, and what the pen wrote in it, scaled to the tile */
  async function sheetOf(entries: readonly Entry[]): Promise<Blob | null> {
    const columns = Math.min(PER_ROW, entries.length);
    const rows = Math.ceil(entries.length / columns);
    const canvas = document.createElement('canvas');
    canvas.width = columns * TILE;
    canvas.height = rows * TILE;
    const g = canvas.getContext('2d');
    if (g === null) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    entries.forEach((entry, at) => {
      const ox = (at % columns) * TILE;
      const oy = Math.floor(at / columns) * TILE;
      const margin = 26;
      const area = TILE - 2 * margin;
      const k = area / Math.max(entry.box.width * (1 + INFLATE), entry.box.height * (1 + INFLATE));
      const cx = ox + TILE / 2;
      const cy = oy + TILE / 2 + 6;
      const mapX = (x: number): number => cx + (x - (entry.box.x + entry.box.width / 2)) * k;
      const mapY = (y: number): number => cy + (y - (entry.box.y + entry.box.height / 2)) * k;
      g.save();
      g.beginPath();
      g.rect(ox + 2, oy + 2, TILE - 4, TILE - 4);
      g.clip();
      g.strokeStyle = '#9a9a9a';
      g.lineWidth = 2;
      g.strokeRect(mapX(entry.box.x), mapY(entry.box.y), entry.box.width * k, entry.box.height * k);
      g.strokeStyle = '#111111';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const stroke of entry.strokes) {
        g.lineWidth = Math.max(4, stroke.width * k * 1.1);
        g.beginPath();
        stroke.points.forEach(([x, y], i) => (i === 0 ? g.moveTo(mapX(x), mapY(y)) : g.lineTo(mapX(x), mapY(y))));
        if (stroke.points.length === 1) {
          const [x, y] = stroke.points[0] as readonly number[];
          g.lineTo(mapX(x as number) + 0.1, mapY(y as number));
        }
        g.stroke();
      }
      g.restore();
      g.strokeStyle = '#d0d0d0';
      g.lineWidth = 1;
      g.strokeRect(ox + 0.5, oy + 0.5, TILE - 1, TILE - 1);
      g.fillStyle = '#c62828';
      g.font = 'bold 24px sans-serif';
      g.textBaseline = 'top';
      g.fillText(String(entry.n), ox + 8, oy + 5);
    });
    return new Promise((done) => canvas.toBlob((blob) => done(blob), 'image/png'));
  }

  async function readEntries(entries: readonly Entry[]): Promise<void> {
    const began = performance.now();
    let digits: ReadonlyMap<number, string> | null = null;
    let uploaded = began;
    try {
      const blob = await sheetOf(entries);
      if (blob === null) throw new Error('no sheet');
      const image = await options.upload(blob);
      uploaded = performance.now();
      digits = await options.readDigits({ image, cells: entries.map((entry) => ({ n: entry.n, max: entry.max, strokes: entry.strokes.length })) });
    } catch {
      // the sheet could not be read: each cell is a smudge to be corrected by a tap and a typed digit
      digits = null;
    }
    const ended = performance.now();
    const log = ((window as unknown as { __mathReads?: unknown[] }).__mathReads ??= []);
    log.push({ cells: entries.length, uploadMs: Math.round(uploaded - began), readMs: Math.round(ended - uploaded), totalMs: Math.round(ended - began), ok: digits !== null });
    for (const entry of entries) {
      const ck = cellKey(entry.key, entry.part);
      // ink written since the sheet was made is read again
      if (version.get(ck) !== entry.version) {
        if (strokesOf(entry.key, entry.part).length > 0) dirty.add(ck);
        continue;
      }
      painter.mathRead(entry.key, entry.part, digits === null ? '?' : (digits.get(entry.n) ?? '?'));
    }
    if (dirty.size > 0) schedule();
  }

  /** Reads every cell whose ink changed, in one request. */
  async function flush(): Promise<void> {
    clearTimer();
    for (let round = 0; round < 3; round += 1) {
      if (busy !== null) await busy.catch(() => undefined);
      if (dirty.size === 0) return;
      const zones = zonesOf(options.views());
      const entries: Entry[] = [];
      for (const ck of [...dirty]) {
        const [key = '', part = ''] = ck.split('\u0001');
        const zone = zones.find((candidate) => candidate.key === key && candidate.part === part);
        const strokes = strokesOf(key, part);
        if (zone === undefined || strokes.length === 0) continue;
        entries.push({ n: entries.length + 1, key, part, max: zone.max, version: version.get(ck) ?? 0, box: zone.box, strokes });
      }
      dirty.clear();
      if (entries.length === 0) return;
      const run = readEntries(entries);
      busy = run;
      try {
        await run;
      } finally {
        if (busy === run) busy = null;
      }
    }
  }

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
    flush,
    sync(views) {
      // fb-082. The working a sum had written leaves with the sum: ink owned by a block that is no longer on the stage, or that now works another sum under the same id, is taken off
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
      clearTimer();
      offChange();
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) host.removeEventListener(type, onPen as EventListener, true);
      host.removeEventListener('pointerdown', onTouch, true);
      ink.through(false);
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
    upload: async (png) => (await app.link.uploadPhoto(png)).id,
    readDigits: (request) => app.link.readDigits(request),
    painter: { mathInk: (key, part, on) => app.painter.mathInk(key, part, on), mathRead: (key, part, digits) => app.painter.mathRead(key, part, digits) },
  });
  app.pen.set(write);
  app.painter.on('math', (views) => write.sync(views));
  return write;
}
