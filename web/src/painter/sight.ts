// What the painter tells the brain about how a turn landed. This is the
// painter being the authority on what was shown, extended from "which
// elements" to "how they came out".

import { isInFlow, outlineOf, SIGHT_ITEMS } from '@conduit/language';
import type { CanvasBox, ElementSpan, PlacedBox, Schedule, Sight, SightItem, SightNote, StageBase } from '@conduit/language';
import type { ElementFrame, FigureFrame, ShapeFrame } from '../contracts/frame';
import type { LeaderView } from '../contracts/painter';
import type { LookSpec } from '../contracts/look';
import { planeScale } from '../contracts/space';
import { canvasToStage, stageToCanvas } from './canvas';
import type { CanvasFit } from './canvas';
import { mapToGamut } from './colour';
import { canvasBoxOf } from './figures';
import { setText } from './layout';
import { cellOf } from './layout/metrics';
import type { Timeline } from './timeline';
import { laidOutOf } from './registry';

/** Under this many screen pixels on its longer side a drawn thing is "tiny". */
/** A thing covering more of the canvas than this is a backdrop, not the subject. */
const SUBJECT_MAX_SHARE = 0.6;
/** The drawn things' bounds cover less than this share of the canvas: the picture is mostly empty. */
const SPARSE_COVER = 0.25;
/** The drawn things fit in a quarter of the canvas at one of its corners. */
const CORNER_SHARE = 0.5;
const TINY_PX = 12;
/** More than this share of a box outside the screen is "clipped". */
const CLIPPED_SHARE = 0.05;
/** A later opaque figure that hides more than this share of a box has "covered" it. */
const COVERED_SHARE = 0.6;
/** `spills`: a filled shape with more than this share of its area inside a bigger filled shape, and less than SPILL_CLEAN of it (so a visible part is outside) */
const SPILL_MOSTLY = 0.7;
const SPILL_CLEAN = 0.97;
/** the container is at least this many times the area of what spills out of it, or the two are just overlapping shapes */
const SPILL_CONTAINER = 1.5;
const SPILL_GRID = 28;
/** `wrong-part`: a leader's end is this far (screen units) from the part it names, or farther, and it is not on it */
const WRONG_PART_TOLERANCE = 6;
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

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Whether the segment p to q passes through the inside of `box` (Liang-Barsky); `pad` shrinks the box so grazing an edge is not a hit. */
function segmentHits(p: Pt, q: Pt, box: Rect, padX: number, padY: number): boolean {
  const x0 = box.x + padX;
  const y0 = box.y + padY;
  const x1 = box.x + box.w - padX;
  const y1 = box.y + box.h - padY;
  if (x1 <= x0 || y1 <= y0) return false;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (direction: number, distance: number): boolean => {
    if (direction === 0) return distance >= 0;
    const t = distance / direction;
    if (direction < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, p.x - x0) && clip(dx, x1 - p.x) && clip(-dy, p.y - y0) && clip(dy, y1 - p.y) && t0 < t1;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
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
    return timeline.fitAt(owner.id, restAt);
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
    // Resting is being on the stage at rest, not only being scheduled to: the layout lets the oldest words go when a column is full, and words
    // that went are not there for the viewer however the schedule has them.
    const scheduled = element.exit === null || element.exit.start > playhead;
    const resting = scheduled && (element.kind !== 'text' || textFrames.get(element.key) !== undefined);
    const gone = scheduled && !resting;
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
    const own: SightNote[] = [...(layoutNotes.get(element.key) ?? [])];
    if (element.refit === true) own.push('refit');
    if (gone) {
      // the line the answer rests on (a `strong` line, or the first line said when nothing is `strong`) is told as lost; any other as retired
      const style = element.style;
      const key = style.weight === 'bold' && style.size === 'l';
      const heading = (size: ElementSpan['style']['size']): boolean => size === 'xl' || size === 'xxl';
      const first = !style.tap && !heading(style.size) && !shown.some((other) => other.kind === 'text' && other.scene === element.scene && other.order < element.order && !other.style.tap && !heading(other.style.size));
      own.push(key || first ? 'lost' : 'retired');
    }
    entries.push({ element, box, screenBox: { x: topLeft.x, y: topLeft.y, w: box.w * fit.unit, h: box.h * fit.unit }, resting, notes: own });
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
  // Every stroke on stage as screen-unit segments, by its layer: what a word must not be run through by.
  interface Stroke {
    readonly owner: string;
    readonly layer: string;
    readonly points: readonly Pt[];
  }
  const strokes: Stroke[] = [];
  for (const figure of frame.figures) {
    if (figure.kind !== 'shape' || figure.stroke === null || figure.stroke.progress < 0.01 || figure.opacity < 0.3 || figure.key.endsWith('/leader')) continue;
    const ps = planeScale(figure.layer, viewport);
    const t = figure.transform;
    for (const line of figure.outline) {
      const points = line.points.map((p) => ({ x: (t.a * p.x + t.c * p.y + t.e) * ps, y: (t.b * p.x + t.d * p.y + t.f) * ps }));
      strokes.push({ owner: figure.key.split('/')[0] ?? figure.key, layer: figure.layer, points: line.closed ? [...points, ...points.slice(0, 1)] : points });
    }
  }
  /** a drawn stroke runs through the letters of this line */
  const strokeThrough = (key: string): boolean => {
    const placed = textFrames.get(key);
    const lines = lineBoxes.get(key);
    if (placed === undefined || lines === undefined) return false;
    for (const stroke of strokes) {
      if (stroke.layer !== placed.layer || stroke.owner === key) continue;
      for (const box of lines) {
        const padX = Math.min(box.w * 0.08, 6);
        const padY = box.h * 0.22;
        for (let i = 0; i + 1 < stroke.points.length; i += 1) if (segmentHits(stroke.points[i] as Pt, stroke.points[i + 1] as Pt, box, padX, padY)) return true;
      }
    }
    return false;
  };
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

  // Words a bound `correct` can replace are set for the tallest of them; one that nevertheless comes out taller than that room (or wider) is told as a
  // collision when it would run into other words, a control or a drawn structure beside it, so the look pass hears of it before anyone steps through.
  const variantCollides = (entry: Entry): boolean => {
    const element = entry.element;
    const placed = textFrames.get(element.key);
    if (placed === undefined || !entry.resting) return false;
    const variants: { text: string; emphasis: readonly { start: number; end: number }[] }[] = [];
    for (const change of element.driven) if (change.effect.kind === 'text') variants.push({ text: change.effect.text, emphasis: change.effect.emphasis });
    if (variants.length === 0) return false;
    const ps = planeScale(placed.layer, viewport);
    const natural = cellOf(element.style.size, viewport, spec).fontSize / ps;
    const first = placed.lines[0];
    const left = first === undefined ? true : Math.abs(first.x + placed.width / 2) < 0.5;
    for (const variant of variants) {
      const set = setText({ look: spec, viewport, text: variant.text, emphasis: variant.emphasis, style: { ...element.style, layer: placed.layer }, shrink: Math.max(0.05, Math.min(1, placed.fontSize / natural)), maxWidth: placed.width, width: placed.width, align: left ? 'left' : 'center' });
      const grown = set.placement.height - placed.height;
      const wide = set.widest - placed.width;
      if (grown <= 0.5 / ps && wide <= 0.5 / ps) continue;
      const area: Rect = { x: (placed.x - placed.width / 2) * ps, y: (placed.y - placed.height / 2) * ps, w: Math.max(placed.width, set.widest) * ps, h: Math.max(placed.height, set.placement.height) * ps };
      for (const other of entries) {
        if (other === entry || !other.resting) continue;
        const lines = other.element.kind === 'text' ? lineBoxes.get(other.element.key) : undefined;
        const boxes = lines ?? (other.element.kind === 'control' || other.element.kind === 'structure' ? [other.screenBox] : []);
        if (boxes.some((box) => overlapArea(area, box) > 6 && overlapArea(area, box) > 0.04 * Math.min(areaOf(area), areaOf(box)))) return true;
      }
    }
    return false;
  };

  // free words standing on a diagram (the structure engines keep to their room, so this is a diagram that did not fit it, or words set where it is):
  // said on both, the words as `collides` and the diagram as `overlaps`, so the look pass moves one of them
  const DIAGRAMS: ReadonlySet<string> = new Set(['flow', 'tree', 'cycle']);
  const ownedBy = (element: ElementSpan, structure: ElementSpan): boolean => element.parent === structure.key || element.key === structure.key;
  const diagramUnder = (entry: Entry): Entry | null => {
    const lines = lineBoxes.get(entry.element.key);
    if (lines === undefined) return null;
    for (const other of entries) {
      if (!other.resting || other.element.kind !== 'structure' || ownedBy(entry.element, other.element) || areaOf(other.screenBox) <= 0) continue;
      // a diagram of nodes and links (a chart, a screen, a table carry words on themselves on purpose), and not words that were told to stand near it
      const figure = other.element.figure;
      if (figure === null || figure.kind !== 'structure' || !DIAGRAMS.has(figure.structure) || entry.element.style.near !== null) continue;
      if (lines.some((line) => overlapArea(line, other.screenBox) > 0.25 * Math.max(1, areaOf(line)))) return other;
    }
    return null;
  };
  const textOnDiagram = (entry: Entry): boolean => {
    const other = diagramUnder(entry);
    if (other === null) return false;
    if (!other.notes.includes('overlaps')) other.notes.push('overlaps');
    return true;
  };

  entries.forEach((entry, index) => {
    const { element, screenBox, notes } = entry;
    // A line has no thickness to measure; half a pixel of it is enough to be seen or not.
    const probe: Rect = { x: screenBox.x - 0.25, y: screenBox.y - 0.25, w: Math.max(screenBox.w, 0.5), h: Math.max(screenBox.h, 0.5) };
    const area = areaOf(probe);
    const seen = overlapArea(probe, screen);
    // what is not on the stage at rest (it left, or has not come) is not reported as off it, cut, or too small
    if (entry.resting) {
      if (seen <= 0) notes.push('off-canvas');
      else if (1 - seen / area > CLIPPED_SHARE) notes.push('clipped');
      if (element.kind !== 'text' && Math.max(screenBox.w, screenBox.h) < TINY_PX) notes.push('tiny');
    }
    // A subject that ends outside the picture's region (the final frame, not the first): the stage clips it there, and what is cut off is gone.
    if (entry.resting && element.kind !== 'text' && !notes.includes('clipped') && !notes.includes('off-canvas') && element.figure?.kind !== 'group') {
      const fitted = fitOf(element.scene);
      // a control is not drawn on the picture: it stands in the flow room under or beside it, which is the stage's own, so the room it may fill is the picture's region and the flow together
      const room = element.kind === 'control' ? { x: Math.min(fitted.region.x, fitted.flow.x), y: Math.min(fitted.region.y, fitted.flow.y), right: Math.max(fitted.region.x + fitted.region.width, fitted.flow.x + fitted.flow.width), bottom: Math.max(fitted.region.y + fitted.region.height, fitted.flow.y + fitted.flow.height) } : { x: fitted.region.x, y: fitted.region.y, right: fitted.region.x + fitted.region.width, bottom: fitted.region.y + fitted.region.height };
      const regionRect: Rect = { x: room.x, y: room.y, w: room.right - room.x, h: room.bottom - room.y };
      const inside = overlapArea(probe, regionRect);
      if (area > 0 && 1 - inside / area > CLIPPED_SHARE && !figureFrames.get(element.key)?.some((figure) => figure.kind === 'shape' && figure.bleed)) notes.push('clipped');
    }

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
        if (textOverText(entry, index) || textOnDiagram(entry) || variantCollides(entry)) notes.push('collides');
        if (strokeThrough(element.key) && !notes.includes('crossed')) notes.push('crossed');
        const view = restViews.get(element.key);
        if (view !== undefined && view.contrast < (view.fontPx >= 24 ? 3 : 4.5) - 0.01) notes.push('faint');
        if (placed.lines.length > WRAPPED_LINES && layout !== 'page') notes.push('wrapped');
        if (isInFlow(style, layout) && placed.fontSize * planeScale(placed.layer, viewport) < SHRUNK_BELOW * cellOf(style.size, viewport, spec).fontSize) notes.push('shrunk');
        const asked = style.ink;
        const first = placed.runs.find((run) => run.opacity > 0.5);
        if (first !== undefined && asked.startsWith('#') && distance(mapToGamut(asked as `#${string}`, spec), first.colour) > RECOLOURED_DISTANCE) notes.push('recoloured');
        // an ink named by role (`ink=ground`) that could not be read on what the words stand on was swapped for one that can: said, so the look pass stops asking for it
        else if (first !== undefined && asked !== 'ink' && !asked.startsWith('#') && distance(spec.roles[asked as keyof typeof spec.roles] ?? first.colour, first.colour) > RECOLOURED_DISTANCE) notes.push('recoloured');
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

    if (entry.resting) {
      const laid = laidOutOf(schedule);
      const figure = element.figure;
      if (figure !== null && figure.kind === 'link' && laid !== null) {
        // a connector that runs through a thing that is not one of its ends, or across another connector
        const route = laid.routeOf(element.key, restAt);
        if (route !== null && route.points.length >= 2) {
          const ends = new Set([figure.from, figure.to]);
          let hit = false;
          for (const other of entries) {
            if (other === entry || !other.resting || other.element.parent !== element.parent) continue;
            const otherFigure = other.element.figure;
            if (other.element.kind === 'node' && !ends.has(other.element.key)) {
              const b = laid.boxOf(other.element.key, restAt);
              if (b !== null) for (let i = 0; i + 1 < route.points.length && !hit; i += 1) hit = segmentHits(route.points[i] as Pt, route.points[i + 1] as Pt, b, Math.min(1, b.w * 0.1), Math.min(1, b.h * 0.1));
            } else if (otherFigure !== null && otherFigure.kind === 'link' && other.element.key < element.key && !ends.has(otherFigure.from) && !ends.has(otherFigure.to)) {
              const other2 = laid.routeOf(other.element.key, restAt);
              if (other2 !== null)
                for (let i = 0; i + 1 < route.points.length && !hit; i += 1)
                  for (let j = 0; j + 1 < other2.points.length && !hit; j += 1) hit = segmentsCross(route.points[i] as Pt, route.points[i + 1] as Pt, other2.points[j] as Pt, other2.points[j + 1] as Pt);
            }
          }
          if (hit && !notes.includes('crossed')) notes.push('crossed');
        }
      }
      // things that are meant to stand apart standing on one another: two nodes, two controls, a control and a line of words
      if (element.kind === 'node' || element.kind === 'control') {
        for (const other of entries) {
          if (other === entry || !other.resting || other.element.parent !== element.parent) continue;
          const kind = other.element.kind;
          if (kind !== 'node' && kind !== 'control') continue;
          const smaller = Math.min(areaOf(screenBox), areaOf(other.screenBox));
          if (overlapArea(screenBox, other.screenBox) > 0.1 * smaller) {
            if (!notes.includes('crowded')) notes.push('crowded');
            break;
          }
        }
        if (element.kind === 'control' && !notes.includes('crowded')) {
          for (const [key, boxes] of lineBoxes) {
            const text = schedule.elements.find((candidate) => candidate.key === key);
            if (text === undefined || text.parent === element.parent && element.parent !== null) continue;
            if (boxes.some((line) => overlapArea(screenBox, line) > 0.12 * areaOf(line))) {
              notes.push('crowded');
              break;
            }
          }
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

  // The final frame as a whole: a drawing that rests in a corner of its picture with most of the picture empty is `sparse`, said of its largest part.
  {
    const fit = timeline.fitAt(scene.id, restAt);
    const canvas: Rect = { x: fit.box.x, y: fit.box.y, w: fit.box.width, h: fit.box.height };
    const subjects = entries.filter((entry) => {
      if (!entry.resting || entry.element.scene !== scene.id || entry.element.parent !== null) return false;
      const kind = entry.element.kind;
      // words and structures the brain placed on the canvas are part of the drawing: a row of numbers with a box round one is not "in a corner"
      const placedWords = kind === 'text' && (entry.element.style.near !== null || entry.element.style.group !== null || (typeof entry.element.style.at === 'object' && entry.element.style.at !== null));
      if (kind !== 'shape' && kind !== 'sprite' && kind !== 'copy' && kind !== 'group' && kind !== 'structure' && !placedWords) return false;
      // a backdrop (a sheet that bleeds, or most of the canvas) is not the subject
      if (figureFrames.get(entry.element.key)?.some((figure) => figure.kind === 'shape' && figure.bleed)) return false;
      return entry.screenBox.w * entry.screenBox.h > 0 && entry.screenBox.w * entry.screenBox.h < SUBJECT_MAX_SHARE * canvas.w * canvas.h;
    });
    if (subjects.length > 0 && canvas.w > 0 && canvas.h > 0) {
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (const entry of subjects) {
        x0 = Math.min(x0, entry.screenBox.x);
        y0 = Math.min(y0, entry.screenBox.y);
        x1 = Math.max(x1, entry.screenBox.x + entry.screenBox.w);
        y1 = Math.max(y1, entry.screenBox.y + entry.screenBox.h);
      }
      const covered = ((Math.min(x1, canvas.x + canvas.w) - Math.max(x0, canvas.x)) * (Math.min(y1, canvas.y + canvas.h) - Math.max(y0, canvas.y))) / (canvas.w * canvas.h);
      const cx = (x0 + x1) / 2 - canvas.x;
      const cy = (y0 + y1) / 2 - canvas.y;
      const biggest = subjects.reduce((best, entry) => (entry.screenBox.w * entry.screenBox.h > best.screenBox.w * best.screenBox.h ? entry : best));
      // Sparse is a drawing that is small in BOTH directions (a thin line that runs most of the width is not) and stands off the middle of its
      // picture. A lone small subject in the middle is minimal on purpose, and a cluster of small parts in the middle is composed.
      const small = x1 - x0 <= canvas.w * CORNER_SHARE && y1 - y0 <= canvas.h * CORNER_SHARE && covered < SPARSE_COVER;
      const offCentre = Math.abs(cx - canvas.w / 2) > canvas.w * 0.15 || Math.abs(cy - canvas.h / 2) > canvas.h * 0.15;
      if (small && offCentre && !biggest.notes.includes('sparse')) biggest.notes.push('sparse');
    }
  }

  // A filled shape that lies mostly inside a bigger filled shape but spills past its edge (a chamber that pokes out of the heart): said of the inner one, naming the outer,
  // so the look pass can move it. The brain's geometry is not moved for it.
  const within = new Map<Entry, string>();
  {
    interface Solid {
      readonly entry: Entry;
      readonly layer: string;
      readonly poly: readonly Pt[];
      readonly area: number;
    }
    const solids: Solid[] = [];
    for (const entry of entries) {
      if (!entry.resting || entry.element.kind !== 'shape') continue;
      const first = figureFrames.get(entry.element.key)?.find((figure) => figure.kind === 'shape');
      if (first === undefined || first.kind !== 'shape' || first.fill === null || first.fill.opacity * first.opacity < 0.5 || first.bleed) continue;
      const line = first.outline[0];
      if (line === undefined || !line.closed || line.points.length < 3) continue;
      const ps = planeScale(first.layer, viewport);
      const t = first.transform;
      const poly = line.points.map((p) => ({ x: (t.a * p.x + t.c * p.y + t.e) * ps, y: (t.b * p.x + t.d * p.y + t.f) * ps }));
      const area = shoelace(poly);
      if (area > 0) solids.push({ entry, layer: first.layer, poly, area });
    }
    const inside = (poly: readonly Pt[], x: number, y: number): boolean => {
      let in2 = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
        const a = poly[i] as Pt;
        const b = poly[j] as Pt;
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) in2 = !in2;
      }
      return in2;
    };
    for (const inner of solids) {
      const xs = inner.poly.map((p) => p.x);
      const ys = inner.poly.map((p) => p.y);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const grid: Pt[] = [];
      for (let i = 0; i < SPILL_GRID; i += 1) {
        for (let j = 0; j < SPILL_GRID; j += 1) {
          const p = { x: x0 + ((i + 0.5) / SPILL_GRID) * (x1 - x0), y: y0 + ((j + 0.5) / SPILL_GRID) * (y1 - y0) };
          if (inside(inner.poly, p.x, p.y)) grid.push(p);
        }
      }
      if (grid.length === 0) continue;
      let bestShare = 0;
      let bestOuter: Solid | null = null;
      for (const outer of solids) {
        if (outer === inner || outer.layer !== inner.layer || outer.area < inner.area * SPILL_CONTAINER) continue;
        const share = grid.filter((p) => inside(outer.poly, p.x, p.y)).length / grid.length;
        if (share > SPILL_MOSTLY && share < SPILL_CLEAN && share > bestShare) {
          bestShare = share;
          bestOuter = outer;
        }
      }
      if (bestOuter !== null) {
        inner.entry.notes.push('spills');
        within.set(inner.entry, bestOuter.entry.element.id);
      }
    }
  }

  // Leaders (a label's line to the part it names) that cross one another: told of both labels, so the look pass moves one.
  {
    const leaders = frame.figures.filter((figure): figure is ShapeFrame => figure.kind === 'shape' && figure.key.endsWith('/leader') && figure.opacity >= 0.3);
    const lines = leaders.map((figure) => {
      const ps = planeScale(figure.layer, viewport);
      return { key: figure.key.slice(0, -'/leader'.length), points: (figure.outline[0]?.points ?? []).map((p) => ({ x: p.x * ps, y: p.y * ps })) };
    });
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const a = lines[i] as (typeof lines)[number];
        const b = lines[j] as (typeof lines)[number];
        let cross = false;
        for (let p = 0; p + 1 < a.points.length && !cross; p += 1) for (let q = 0; q + 1 < b.points.length && !cross; q += 1) cross = segmentsCross(a.points[p] as Pt, a.points[p + 1] as Pt, b.points[q] as Pt, b.points[q + 1] as Pt);
        if (!cross) continue;
        for (const key of [a.key, b.key]) {
          const entry = entries.find((candidate) => candidate.element.key === key);
          if (entry !== undefined && entry.resting && !entry.notes.includes('tangled')) entry.notes.push('tangled');
        }
      }
    }
  }

  // A leader must end on the part its label names, and nearer to it than to any other part that has a label: else the label points at the wrong thing.
  {
    const outlineOfId = (id: string): Pt[][] => {
      const out: Pt[][] = [];
      for (const entry of entries) {
        if (!entry.resting || entry.element.id !== id || entry.element.kind !== 'shape') continue;
        for (const figure of figureFrames.get(entry.element.key) ?? []) {
          if (figure.kind !== 'shape') continue;
          const ps = planeScale(figure.layer, viewport);
          const t = figure.transform;
          for (const line of figure.outline) {
            const points = line.points.map((p) => ({ x: (t.a * p.x + t.c * p.y + t.e) * ps, y: (t.b * p.x + t.d * p.y + t.f) * ps }));
            out.push(line.closed ? [...points, ...points.slice(0, 1)] : points);
          }
        }
      }
      return out;
    };
    const near = (p: Pt, lines: readonly (readonly Pt[])[]): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const line of lines) {
        for (let i = 0; i + 1 < line.length; i += 1) {
          const a = line[i] as Pt;
          const b = line[i + 1] as Pt;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len2 = dx * dx + dy * dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
          best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
        }
      }
      return best;
    };
    const called = new Map<string, Pt[][]>();
    for (const entry of entries) {
      const target = entry.element.kind === 'text' && entry.resting ? entry.element.style.near : null;
      if (target !== null && !called.has(target.id)) called.set(target.id, outlineOfId(target.id));
    }
    for (const figure of frame.figures) {
      if (figure.kind !== 'shape' || !figure.key.endsWith('/leader') || figure.opacity < 0.3) continue;
      const entry = entries.find((candidate) => candidate.element.key === figure.key.slice(0, -'/leader'.length));
      const wanted = entry?.element.style.near;
      const own = wanted === null || wanted === undefined ? undefined : called.get(wanted.id);
      const pts = figure.outline[0]?.points;
      if (entry === undefined || own === undefined || own.length === 0 || pts === undefined || pts.length < 2) continue;
      const ps = planeScale(figure.layer, viewport);
      const last = pts[pts.length - 1] as Pt;
      const end = { x: last.x * ps, y: last.y * ps };
      const mine = near(end, own);
      let wrong = mine > WRONG_PART_TOLERANCE;
      for (const [id, lines] of called) if (id !== wanted?.id && lines.length > 0 && near(end, lines) < mine - 0.5) wrong = true;
      if (wrong && !entry.notes.includes('wrong-part')) entry.notes.push('wrong-part');
    }
  }

  const noted = entries.filter((entry) => entry.notes.length > 0);
  const rest = entries.filter((entry) => entry.notes.length === 0);
  const keep = new Set<Entry>([...noted.slice(-SIGHT_ITEMS), ...rest.slice(-Math.max(0, SIGHT_ITEMS - noted.length))]);
  const items: SightItem[] = entries
    .filter((entry) => keep.has(entry))
    .map((entry) => ({ id: entry.element.id, kind: entry.element.kind, box: round(entry.box), resting: entry.resting, notes: entry.notes, ...(within.has(entry) ? { within: within.get(entry) as string } : {}) }));
  const fit = timeline.fitAt(scene.id, restAt);
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
  const frame = timeline.frameAt({ time: restAt, ambient: restAt, wallTime: 0, clock: 'idle' });
  const textFrames = new Map<string, ElementFrame>();
  for (const element of frame.elements) textFrames.set(element.key, element);
  const idOf = new Map<string, string>();
  for (const element of schedule.elements) idOf.set(element.key, element.id);
  const out: (PlacedBox & { readonly key: string })[] = [];
  for (const element of schedule.elements) {
    if (!keys.has(element.key) || element.kind === 'field') continue;
    const owner = schedule.scenes.find((candidate) => candidate.id === element.scene) ?? scene;
    const fit = timeline.fitAt(owner.id, restAt);
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
    const entry = { key: element.key, id: element.id, kind: element.kind, parent: element.parent === null ? null : (idOf.get(element.parent) ?? null), box: round(box) };
    // a connector says where it really runs, so a count of what it passes through is of the drawn route and not of a straight line between two centres
    const route = element.kind === 'link' ? laidOutOf(schedule)?.routeOf(element.key, restAt) : null;
    if (route === null || route === undefined) out.push(entry);
    else {
      const routed = { ...entry, route: route.points.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })) };
      out.push(routed);
    }
  }
  return out;
}


/** The distance from a point to the nearest of some polylines. */
function nearestOn(p: Pt, lines: readonly (readonly Pt[])[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i += 1) {
      const a = line[i] as Pt;
      const b = line[i + 1] as Pt;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
  }
  return best;
}

/** Every leader on stage as it rests at `playhead`, with its end measured against the outlines of the parts that have labels. */
export function leadersOf(timeline: Timeline, schedule: Schedule, playhead: number): LeaderView[] {
  const viewport = timeline.viewport;
  const restAt = Math.max(playhead, schedule.end) + 0.5;
  const frame = timeline.frameAt({ time: restAt, ambient: restAt, wallTime: 0, clock: 'idle' });
  const byKey = new Map(schedule.elements.map((element) => [element.key, element]));
  const outlines = new Map<string, Pt[][]>();
  const outlineOfId = (id: string): Pt[][] => {
    const have = outlines.get(id);
    if (have !== undefined) return have;
    const out: Pt[][] = [];
    for (const figure of frame.figures) {
      if (figure.kind !== 'shape' || figure.key.endsWith('/leader') || figure.opacity < 0.05) continue;
      const owner = byKey.get(figure.key.split('/')[0] ?? figure.key);
      if (owner === undefined || owner.id !== id || owner.kind !== 'shape') continue;
      const ps = planeScale(figure.layer, viewport);
      const t = figure.transform;
      for (const line of figure.outline) {
        const points = line.points.map((p) => ({ x: (t.a * p.x + t.c * p.y + t.e) * ps, y: (t.b * p.x + t.d * p.y + t.f) * ps }));
        out.push(line.closed ? [...points, ...points.slice(0, 1)] : points);
      }
    }
    outlines.set(id, out);
    return out;
  };
  const labelled = new Set<string>();
  for (const element of schedule.elements) if (element.kind === 'text' && element.style.near !== null && frame.elements.some((item) => item.key === element.key)) labelled.add(element.style.near.id);
  const out: LeaderView[] = [];
  for (const figure of frame.figures) {
    if (figure.kind !== 'shape' || !figure.key.endsWith('/leader') || figure.opacity < 0.3) continue;
    const label = byKey.get(figure.key.slice(0, -'/leader'.length));
    const target = label?.style.near;
    const pts = figure.outline[0]?.points;
    if (label === undefined || target === null || target === undefined || pts === undefined || pts.length < 2) continue;
    const ps = planeScale(figure.layer, viewport);
    const last = pts[pts.length - 1] as Pt;
    const end = { x: last.x * ps, y: last.y * ps };
    const own = outlineOfId(target.id);
    if (own.length === 0) continue;
    const mine = nearestOn(end, own);
    let nearer: LeaderView['nearer'] = null;
    for (const id of labelled) {
      if (id === target.id) continue;
      const lines = outlineOfId(id);
      if (lines.length === 0) continue;
      const d = nearestOn(end, lines);
      if (d < mine - 0.5 && (nearer === null || d < nearer.distance)) nearer = { id, distance: Math.round(d * 10) / 10 };
    }
    out.push({ label: label.id, part: target.id, end: { x: Math.round((end.x + viewport.width / 2) * 10) / 10, y: Math.round((end.y + viewport.height / 2) * 10) / 10 }, distance: Math.round(mine * 10) / 10, nearer });
  }
  return out;
}
