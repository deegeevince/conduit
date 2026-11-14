// What the painter tells the brain about how a turn landed. This is the
// painter being the authority on what was shown, extended from "which
// elements" to "how they came out".

import { isInFlow, outlineOf, SIGHT_ITEMS } from '@conduit/language';
import type { CanvasBox, ElementSpan, PlacedBox, Schedule, Sight, SightItem, SightNote, StageBase } from '@conduit/language';
import type { ElementFrame, FigureFrame, ShapeFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import { planeScale } from '../contracts/space';
import { canvasToStage, fitCanvas, stageToCanvas } from './canvas';
import type { CanvasFit } from './canvas';
import { mapToGamut } from './colour';
import { canvasBoxOf } from './figures';
import { cellOf } from './layout/metrics';
import type { Timeline } from './timeline';

/** Under this many screen pixels on its longer side a drawn thing is "tiny". */
const TINY_PX = 12;
/** More than this share of a box outside the screen is "clipped". */
const CLIPPED_SHARE = 0.05;
/** A later opaque figure that hides more than this share of a box has "covered" it. */
const COVERED_SHARE = 0.6;
/** Text below this share of the size its size word asks for has been "shrunk". */
const SHRUNK_BELOW = 0.85;
/** More lines than this outside `layout=page` is "wrapped". */
const WRAPPED_LINES = 3;
/** Distance in RGB at which a colour has been "recoloured" and not merely mapped. */
const RECOLOURED_DISTANCE = 48;

const RANK = { far: 0, bg: 1, mid: 2, fg: 3 } as const;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function areaOf(box: Rect): number {
  return Math.max(box.w, 0.5) * Math.max(box.h, 0.5);
}

function rgb(colour: string): [number, number, number] {
  const n = Number.parseInt(colour.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function distance(a: string, b: string): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

function shoelace(points: readonly { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a !== undefined && b !== undefined) total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

/** How much of its bounding box a shape's fill covers: 1 for a rectangle. */
function fillRatio(element: ElementSpan): number {
  const figure = element.figure;
  if (figure === null || figure.kind !== 'shape') return 1;
  const line = outlineOf(figure.geometry)[0];
  if (line === undefined || !line.closed || line.points.length < 3) return 0;
  const xs = line.points.map((p) => p.x);
  const ys = line.points.map((p) => p.y);
  const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  return box <= 0 ? 0 : Math.min(1, shoelace(line.points) / box);
}

function round(box: Rect): CanvasBox {
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
}

/**
 * The sight report for a turn that has come to rest at `playhead`.
 *
 * For each element the turn showed, in the order it appeared: its box in
 * whole canvas units where it rested (or last was), whether it is still on
 * stage, and every `SightNote` that applies:
 * `clipped` (more than 5% of its box outside the viewport), `off-canvas`
 * (all of it), `covered` (a later opaque figure hides more than 60% of it),
 * `overlaps` (a figure sits on in-flow text and a plate was needed),
 * `shrunk` (layout scaled it below 85% of what its size word asks),
 * `wrapped` (text over 3 lines outside `layout=page`), `recoloured` (the
 * contrast rule moved its colour visibly), `tiny` (under 12 px on its longer
 * side), `partial`, `painted`, `unpainted`.
 * At most SIGHT_ITEMS items: those with notes first, then the newest.
 */
export function sightOf(timeline: Timeline, schedule: Schedule, base: StageBase, playhead: number, snapshot: boolean): Sight {
  const viewport = timeline.viewport;
  const scene = schedule.scenes.reduce((found, candidate) => (candidate.start <= playhead ? candidate : found), schedule.scenes[0]);
  if (scene === undefined) return { canvas: base.scene.canvas, coverage: 1, items: [], snapshot };
  const restAt = Math.max(playhead, schedule.end) + 0.5;
  const spec: LookSpec = timeline.specAt(restAt);
  const fitOf = (sceneId: string): CanvasFit => {
    const owner = schedule.scenes.find((candidate) => candidate.id === sceneId) ?? scene;
    return fitCanvas(owner.canvas, owner.layout, viewport, spec);
  };
  const shown = schedule.elements
    .filter((element) => !element.carried && element.enter !== null && element.enter.start < playhead && element.kind !== 'group' && element.kind !== 'field')
    .sort((a, b) => (a.enter?.start ?? 0) - (b.enter?.start ?? 0) || a.order - b.order);

  const frame = timeline.frameAt({ time: restAt, ambient: restAt, wallTime: 0, clock: 'idle' });
  const textFrames = new Map<string, ElementFrame>();
  for (const element of frame.elements) textFrames.set(element.key, element);
  const restViews = new Map(timeline.viewsAt({ time: restAt, ambient: restAt, wallTime: 0, clock: 'idle' }).map((view) => [view.key, view]));
  const figureFrames = new Map<string, FigureFrame[]>();
  for (const figure of frame.figures) {
    const list = figureFrames.get(figure.key.split('/')[0] ?? figure.key) ?? [];
    list.push(figure);
    figureFrames.set(figure.key.split('/')[0] ?? figure.key, list);
  }
  const screen: Rect = { x: -viewport.width / 2, y: -viewport.height / 2, w: viewport.width, h: viewport.height };

  interface Entry {
    readonly element: ElementSpan;
    readonly box: Rect;
    readonly screenBox: Rect;
    readonly resting: boolean;
    readonly notes: SightNote[];
  }
  const layoutNotes = timeline.layoutNotesAt(restAt);
  const entries: Entry[] = [];
  for (const element of shown) {
    const fit = fitOf(element.scene);
    const resting = element.exit === null || element.exit.start > playhead;
    const at = resting ? restAt : Math.max(element.enter?.end ?? 0, Math.min(playhead, (element.exit?.start ?? playhead) - 1e-3));
    let box: Rect | null = null;
    if (element.kind === 'text') {
      const placed = resting ? textFrames.get(element.key) : timeline.frameAt({ time: at, ambient: at, wallTime: 0, clock: 'idle' }).elements.find((item) => item.key === element.key);
      if (placed !== undefined) {
        const ps = planeScale(placed.layer, viewport);
        const left = (placed.x - placed.width / 2) * ps;
        const top = (placed.y - placed.height / 2) * ps;
        const a = stageToCanvas({ x: left, y: top }, fit);
        box = { x: a.x, y: a.y, w: (placed.width * ps) / fit.unit, h: (placed.height * ps) / fit.unit };
      }
    } else {
      box = canvasBoxOf(element, schedule, at);
    }
    box ??= { x: 0, y: 0, w: 0, h: 0 };
    const topLeft = canvasToStage({ x: box.x, y: box.y }, fit, 'mid', viewport);
    entries.push({ element, box, screenBox: { x: topLeft.x, y: topLeft.y, w: box.w * fit.unit, h: box.h * fit.unit }, resting, notes: [...(layoutNotes.get(element.key) ?? [])] });
  }

  const filled = (entry: Entry): ShapeFrame | null => {
    const list = figureFrames.get(entry.element.key);
    const first = list?.[0];
    if (first === undefined || first.kind !== 'shape' || first.fill === null || first.fill.opacity < 0.9 || first.opacity < 0.9 || first.fill.to !== null) return null;
    return first;
  };

  /** The screen area a figure can have words laid over, or null when it cannot be one (a line, or nothing filled). */
  const underText = (entry: Entry): Rect | null => {
    const list = figureFrames.get(entry.element.key);
    if (list === undefined) return null;
    let covers = false;
    for (const figure of list) {
      if (figure.kind === 'shape' && figure.bleed && figure.fill !== null && figure.fill.opacity * figure.opacity >= 0.05) return screen;
      if (figure.kind === 'shape' && figure.fill !== null && figure.fill.opacity * figure.opacity >= 0.05) covers = true;
      if (figure.kind === 'sprite' || (figure.kind === 'picture' && figure.src !== null)) covers = true;
    }
    return covers ? entry.screenBox : null;
  };

  // Words that lie on words: the later line sits on top of the earlier, and is told so. The line boxes are what is compared, not the block around them.
  const lineBoxes = new Map<string, Rect[]>();
  for (const entry of entries) {
    if (entry.element.kind !== 'text' || !entry.resting) continue;
    const placed = textFrames.get(entry.element.key);
    if (placed === undefined || placed.opacity < 0.5) continue;
    const ps = planeScale(placed.layer, viewport);
    lineBoxes.set(
      entry.element.key,
      placed.lines.map((line) => ({ x: (placed.x + line.x) * ps, y: (placed.y + line.y) * ps, w: line.width * ps, h: line.height * ps })),
    );
  }
  const textOverText = (entry: Entry, index: number): boolean => {
    const mine = lineBoxes.get(entry.element.key);
    if (mine === undefined) return false;
    for (const earlier of entries.slice(0, index)) {
      const theirs = lineBoxes.get(earlier.element.key);
      if (theirs === undefined) continue;
      for (const a of mine) {
        for (const b of theirs) {
          // A hairline of shared leading is not a collision: it takes a visible patch of letters.
          const area = overlapArea(a, b);
          if (area > 6 && area > 0.04 * Math.min(areaOf(a), areaOf(b))) return true;
        }
      }
    }
    return false;
  };

  entries.forEach((entry, index) => {
    const { element, screenBox, notes } = entry;
    // A line has no thickness to measure; half a pixel of it is enough to be seen or not.
    const probe: Rect = { x: screenBox.x - 0.25, y: screenBox.y - 0.25, w: Math.max(screenBox.w, 0.5), h: Math.max(screenBox.h, 0.5) };
    const area = areaOf(probe);
    const seen = overlapArea(probe, screen);
    if (seen <= 0) notes.push('off-canvas');
    else if (1 - seen / area > CLIPPED_SHARE) notes.push('clipped');
    if (element.kind !== 'text' && Math.max(screenBox.w, screenBox.h) < TINY_PX) notes.push('tiny');

    // A later figure with an opaque fill that lies over most of it.
    if (entry.resting) {
      for (const later of entries.slice(index + 1)) {
        if (!later.resting || later.element.kind === 'text') continue;
        const cover = filled(later);
        if (cover === null) continue;
        if (RANK[cover.layer] < RANK[element.style.layer]) continue;
        // `rect full` is drawn over the whole screen, not just the canvas.
        const over = cover.bleed ? screen : later.screenBox;
        if ((overlapArea(screenBox, over) * (cover.bleed ? 1 : fillRatio(later.element))) / area > COVERED_SHARE) {
          notes.push('covered');
          break;
        }
      }
    }

    if (element.kind === 'text') {
      const placed = textFrames.get(element.key);
      const style = element.style;
      if (placed !== undefined && entry.resting) {
        const layout = scene.layout;
        if (textOverText(entry, index)) notes.push('collides');
        const view = restViews.get(element.key);
        if (view !== undefined && view.contrast < (view.fontPx >= 24 ? 3 : 4.5) - 0.01) notes.push('faint');
        if (placed.lines.length > WRAPPED_LINES && layout !== 'page') notes.push('wrapped');
        if (isInFlow(style, layout) && placed.fontSize * planeScale(placed.layer, viewport) < SHRUNK_BELOW * cellOf(style.size, viewport, spec).fontSize) notes.push('shrunk');
        const asked = style.ink;
        const first = placed.runs.find((run) => run.opacity > 0.5);
        if (first !== undefined && asked.startsWith('#') && distance(mapToGamut(asked as `#${string}`, spec), first.colour) > RECOLOURED_DISTANCE) notes.push('recoloured');
      }
    } else if (underText(entry) !== null) {
      // A figure with words laid over it that needed a plate to be read: whatever it is, a flat fill, a gradient, a sprite, a painting or a sheet that bleeds.
      const under = underText(entry) as Rect;
      for (const other of entries) {
        if (other.element.kind !== 'text' || !other.resting) continue;
        const text = textFrames.get(other.element.key);
        if (text === undefined || text.plate <= 0) continue;
        if (overlapArea(under, other.screenBox) > 0) {
          notes.push('overlaps');
          break;
        }
      }
    }

    if (element.enter !== null && element.enter.end > playhead) notes.push('partial');
    if (element.kind === 'picture') {
      const painting = timeline.paintings.get(element.key);
      if (painting !== undefined && painting.status === 'ready') notes.push('painted');
      else if (painting !== undefined && painting.status === 'unpainted') notes.push('unpainted');
    }
  });

  const noted = entries.filter((entry) => entry.notes.length > 0);
  const rest = entries.filter((entry) => entry.notes.length === 0);
  const keep = new Set<Entry>([...noted.slice(-SIGHT_ITEMS), ...rest.slice(-Math.max(0, SIGHT_ITEMS - noted.length))]);
  const items: SightItem[] = entries
    .filter((entry) => keep.has(entry))
    .map((entry) => ({ id: entry.element.id, kind: entry.element.kind, box: round(entry.box), resting: entry.resting, notes: entry.notes }));
  const fit = fitCanvas(scene.canvas, scene.layout, viewport, spec);
  return { canvas: scene.canvas, coverage: fit.coverage, items, snapshot };
}


/**
 * Where every thing the stage holds really is, once the turn has come to rest at `playhead`: the painter's own resolved boxes, in whole canvas
 * units of the scene's canvas and in world coordinates. A move, a `set at=` and every offset of a group are already in them, and so are the
 * parts of a group (a part at 52,60 on the canvas is reported at 52,60, not where it sits inside its group). Text is where the layout put it,
 * after labels and words set on a point have found their places. Only the keys asked for, which are the ones the stage carries on.
 */
export function placedOf(timeline: Timeline, schedule: Schedule, playhead: number, keys: ReadonlySet<string>): (PlacedBox & { readonly key: string })[] {
  const viewport = timeline.viewport;
  const scene = schedule.scenes.reduce((found, candidate) => (candidate.start <= playhead ? candidate : found), schedule.scenes[0]);
  if (scene === undefined) return [];
  const restAt = Math.max(playhead, schedule.end) + 0.5;
  const spec: LookSpec = timeline.specAt(restAt);
  const frame = timeline.frameAt({ time: restAt, ambient: restAt, wallTime: 0, clock: 'idle' });
  const textFrames = new Map<string, ElementFrame>();
  for (const element of frame.elements) textFrames.set(element.key, element);
  const idOf = new Map<string, string>();
  for (const element of schedule.elements) idOf.set(element.key, element.id);
  const out: (PlacedBox & { readonly key: string })[] = [];
  for (const element of schedule.elements) {
    if (!keys.has(element.key) || element.kind === 'field') continue;
    const owner = schedule.scenes.find((candidate) => candidate.id === element.scene) ?? scene;
    const fit = fitCanvas(owner.canvas, owner.layout, viewport, spec);
    let box: Rect | null = null;
    if (element.kind === 'text') {
      const placed = textFrames.get(element.key);
      if (placed === undefined) continue;
      const ps = planeScale(placed.layer, viewport);
      const a = stageToCanvas({ x: (placed.x - placed.width / 2) * ps, y: (placed.y - placed.height / 2) * ps }, fit);
      box = { x: a.x, y: a.y, w: (placed.width * ps) / fit.unit, h: (placed.height * ps) / fit.unit };
    } else {
      box = canvasBoxOf(element, schedule, restAt);
    }
    if (box === null) continue;
    out.push({ key: element.key, id: element.id, kind: element.kind, parent: element.parent === null ? null : (idOf.get(element.parent) ?? null), box: round(box) });
  }
  return out;
}
