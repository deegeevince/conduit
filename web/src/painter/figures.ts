// Everything on stage that is not text, at one instant: shapes, sprites,
// copies, groups, pictures and weather become the `figures` and `fields` of a
// Frame. Like the rest of the timeline this is a pure function of time: it
// keeps nothing between frames (the caches below only remember answers).
//
// Two stages. The first knows no look and no screen: where each thing is in
// canvas units, from the schedule alone (`canvasBoxOf` stops here). The second
// puts the look's colour, stroke and motion on it and maps it to the stage.

import { boundsOf, CANVAS, describeFigure, pointAlong, resample, ROW_SECONDS, sceneAt, valueAt } from '@conduit/language';
import type { Anchor, ElementChange, ElementSpan, ElementStyle, Fill, Figure, Layer, Paint, Polyline, Schedule, SceneSpan, SpriteData, StageBase, StrokeCharacter } from '@conduit/language';
import type { Affine, Colour, FieldFrame, FigureFrame, FillFrame, PictureFrame, ShapeFrame, SpriteFrame, StrokeFrame } from '../contracts/frame';
import { IDENTITY } from '../contracts/frame';
import type { Ease, LookSpec, MotionRecipe } from '../contracts/look';
import type { ElementPhase, StageElementView } from '../contracts/painter';
import { layerZ, planeScale, projectToScreen } from '../contracts/space';
import type { Box, CameraPose, Viewport } from '../contracts/space';
import { about, apply, clamp01, hash, lerp, mixHex, mul, rotation, scaling, translation } from './affine';
import type { Pt } from './affine';
import { canvasToStage } from './canvas';
import type { CanvasFit } from './canvas';
import { contrastRatio, mapToGamut } from './colour';
import { ease } from './ease';
import { bodySize } from './layout/metrics';
import { dashed, morphedOutline, wobbled } from './outline';
import { has, own } from './own';
import { castInk, litFrom, shadeIsOn, strengthFor } from './shade';
import { laidOutOf } from './registry';

/** What is known about a painting at this moment. Arrival is not on the turn clock, so it comes in from outside. */
export interface Painting {
  readonly status: 'waiting' | 'ready' | 'unpainted';
  readonly url: string | null;
  /** seconds on the ambient clock when the picture could first be drawn; the wash grows from here */
  readonly since: number;
  /** a photo the user gave: its width over its height, so that it is fitted whole into its box and never stretched; absent for a painting */
  readonly aspect?: number;
}

/** The largest box of this width over height that fits whole inside `box`, centred in it. */
function containIn(box: CanvasRect, aspect: number): CanvasRect {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return box;
  const width = Math.min(box.w, box.h * aspect);
  const height = width / aspect;
  return { x: box.x + (box.w - width) / 2, y: box.y + (box.h - height) / 2, w: width, h: height };
}

export interface FigureContext {
  readonly viewport: Viewport;
  readonly look: LookSpec;
  readonly camera: CameraPose;
  /** the fit of the scene the frame belongs to; each element is fitted to the scene it was made in */
  readonly fit: CanvasFit;
  /** v2.1: the fit of a scene at this instant (the stage plan's, eased); absent: every scene is fitted as `fit` */
  readonly fitOf?: (sceneId: string) => CanvasFit;
  readonly reducedMotion: boolean;
  /** by element key */
  readonly paintings: ReadonlyMap<string, Painting>;
  /** the `hit flash` changes the flash governor lets show; absent: all of them */
  readonly flashAllowed?: ReadonlySet<ElementChange>;
  /** when set, every element is fitted by this instead of by the fit of its own scene (a sketch cropped to its picture) */
  readonly fixedFit?: CanvasFit;
  /** a thing that cannot be made is reported here and left out; without it the error is thrown */
  readonly onFault?: (error: unknown, key: string) => void;
}

export interface FiguresAt {
  readonly figures: readonly FigureFrame[];
  readonly fields: readonly FieldFrame[];
  /** the test hook's view of each drawn element, in the same order as the schedule's elements */
  readonly views: readonly StageElementView[];
}

/** Seconds of ambient time a painting takes to grow over its sketch. */
export const DEVELOP_SECONDS = 2.5;
/** Frames per second of a sprite that did not say. */
const SPRITE_FPS = 4;
/** A sprite with no scale is this share of the canvas's height. */
const SPRITE_HEIGHT_SHARE = 0.4;
/** Below this many device pixels a sprite's cell is snapped to a whole number of them. */
const SNAP_BELOW_PX = 6;
const LAYER_RANK: Readonly<Record<Layer, number>> = { far: -1, bg: 0, mid: 1, fg: 2 };
const FLICKER_SLOT = 0.36;
const MAX_COPY_DEPTH = 3;
const DENSITY = { light: 0.25, some: 0.5, heavy: 1 } as const;

type MorphChange = Extract<ElementChange, { kind: 'morph' }>;
type MoveChange = Extract<ElementChange, { kind: 'move' }>;
type FigureOf<K extends Figure['kind']> = Extract<Figure, { kind: K }>;
type CanvasRect = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------
// Indexes remembered per schedule

interface Index {
  readonly byKey: Map<string, ElementSpan>;
  readonly children: Map<string, ElementSpan[]>;
  readonly scenes: Map<string, SceneSpan>;
}

const indexes = new WeakMap<Schedule, Index>();

function indexOf(schedule: Schedule): Index {
  const known = indexes.get(schedule);
  if (known !== undefined) return known;
  const byKey = new Map<string, ElementSpan>();
  const children = new Map<string, ElementSpan[]>();
  for (const element of schedule.elements) {
    byKey.set(element.key, element);
    if (element.parent !== null) {
      const list = children.get(element.parent) ?? [];
      list.push(element);
      children.set(element.parent, list);
    }
  }
  const scenes = new Map<string, SceneSpan>();
  for (const scene of schedule.scenes) scenes.set(scene.id, scene);
  const made: Index = { byKey, children, scenes };
  indexes.set(schedule, made);
  return made;
}

const morphLists = new WeakMap<ElementSpan, MorphChange[]>();

function morphsOf(element: ElementSpan): MorphChange[] {
  let found = morphLists.get(element);
  if (found === undefined) {
    found = element.changes.filter((change): change is MorphChange => change.kind === 'morph').sort((a, b) => a.start - b.start);
    morphLists.set(element, found);
  }
  return found;
}

function isPlaced(element: ElementSpan): boolean {
  return element.kind === 'shape' || element.kind === 'sprite' || element.kind === 'picture';
}

function hasEntered(element: ElementSpan, time: number): boolean {
  return element.carried || element.enter === null || element.enter.start <= time;
}

function isOnStage(element: ElementSpan, time: number): boolean {
  return hasEntered(element, time) && (element.exit === null || time < element.exit.end);
}

// ---------------------------------------------------------------------------
// Stage A: where things are, in canvas units

interface Scn {
  readonly schedule: Schedule;
  readonly base: StageBase | null;
  readonly idx: Index;
  readonly tq: number;
  readonly aq: number;
  readonly reduced: boolean;
  readonly curve: Ease;
  /** a resting picture: no loops, no gestures */
  readonly rest: boolean;
  readonly flashAllowed: ReadonlySet<ElementChange> | null;
  readonly groups: Map<string, GroupState>;
  /** told of anything that threw while a thing was being made; that thing is then left out of the frame */
  readonly fault: ((error: unknown, key: string) => void) | null;
}

interface Extras {
  readonly dx: number;
  readonly dy: number;
  readonly rot: number;
  readonly scale: number;
  readonly opacity: number;
  readonly flash: number;
}

const NO_EXTRAS: Extras = { dx: 0, dy: 0, rot: 0, scale: 1, opacity: 1, flash: 0 };

interface Trans {
  readonly from: ElementStyle;
  readonly to: ElementStyle;
  /** eased share of the way from `from` to `to` */
  readonly p: number;
  readonly move: MoveChange | null;
}

interface State {
  readonly trans: Trans;
  readonly centre: Pt;
  readonly natural: Pt;
  readonly scale: number;
  /** a sprite's cell side in canvas units, before the group's scale; 0 for anything else */
  readonly cell: number;
  readonly rot: number;
  readonly opacity: number;
  readonly extras: Extras;
}

interface GroupState {
  readonly M: Affine;
  readonly opacity: number;
  readonly flash: number;
  readonly extras: Extras;
  readonly origin: Pt;
}

interface Placed {
  readonly el: ElementSpan;
  /** whose envelope governs: the element, or the copy it is shown in */
  readonly owner: ElementSpan;
  readonly key: string;
  readonly z: number;
  /** own units to canvas units */
  readonly M: Affine;
  readonly trans: Trans;
  /** a sprite's cell side, canvas units, before the group's scale */
  readonly cell: number;
  /** the element's centre once placed, canvas units */
  readonly pivot: Pt;
  /** the opacities of its groups and copy and its own style, multiplied */
  readonly opacity: number;
  readonly flash: number;
  /** the part whose entrance sets how much is drawn; differs from `owner` inside a copy */
  readonly source: ElementSpan | null;
}

function transition(element: ElementSpan, tq: number, curve: Ease): Trans {
  let from = element.style;
  let to = element.style;
  let p = 1;
  let move: MoveChange | null = null;
  let previous = element.style;
  let bestStart = Number.NEGATIVE_INFINITY;
  for (const change of element.changes) {
    if (change.kind !== 'set' && change.kind !== 'move' && change.kind !== 'morph') continue;
    if (change.start <= tq && change.start >= bestStart) {
      bestStart = change.start;
      from = previous;
      to = change.style;
      p = change.end > change.start ? ease(curve === 'hold' ? 'out' : curve, clamp01((tq - change.start) / (change.end - change.start))) : 1;
      move = change.kind === 'move' ? change : null;
    }
    previous = change.style;
  }
  return { from, to, p, move };
}

function spriteDims(sprite: SpriteData): { cols: number; rows: number } {
  let cols = 0;
  let rows = 0;
  for (const frame of sprite.frames) {
    rows = Math.max(rows, frame.length);
    for (const row of frame) cols = Math.max(cols, [...row.cells].length);
  }
  return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

function canvasOf(element: ElementSpan, sc: Pick<Scn, 'idx' | 'schedule'>): { width: number; height: number } {
  const scene = sc.idx.scenes.get(element.scene) ?? sc.schedule.scenes[0];
  return CANVAS[scene === undefined ? 'wide' : scene.canvas];
}

/** Canvas units per cell for a sprite whose style says `scale`; null is what the brain leaves unsaid, and the painter sizes it. */
function cellFor(scale: number | null, dims: { cols: number; rows: number }, canvas: { height: number }): number {
  if (scale !== null) return scale;
  return (canvas.height * SPRITE_HEIGHT_SHARE) / Math.max(dims.rows, dims.cols);
}

function pictureBoxOf(element: ElementSpan, sc: Scn): CanvasRect {
  const figure = element.figure;
  const canvas = canvasOf(element, sc);
  if (figure === null || figure.kind !== 'picture') return { x: 0, y: 0, w: canvas.width, h: canvas.height };
  // a photo whose shape the server stamped stands contained in its box: the same frame `in=<pic>` addresses
  const held = (box: CanvasRect): CanvasRect => (figure.from != null && figure.aspect !== undefined ? containIn(box, figure.aspect) : box);
  if (figure.box !== null) return held(figure.box);
  if (figure.over !== null) {
    const group = sc.idx.byKey.get(figure.over);
    const found = group === undefined ? null : unionBox(group, sc.schedule, sc.tq, sc.base, sc.curve);
    if (found !== null) return held(found);
  }
  return held({ x: 0, y: 0, w: canvas.width, h: canvas.height });
}

const centres = new WeakMap<ElementSpan, Pt>();

function naturalCentre(element: ElementSpan, sc: Scn): Pt {
  const known = centres.get(element);
  if (known !== undefined) return known;
  const figure = element.figure;
  let centre: Pt = { x: 0, y: 0 };
  if (figure !== null && figure.kind === 'shape') {
    const box = boundsOf(figure.geometry);
    centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  } else if (figure !== null && figure.kind === 'picture') {
    const box = pictureBoxOf(element, sc);
    centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  } else if (figure !== null && figure.kind === 'sprite' && element.parent === null) {
    const canvas = canvasOf(element, sc);
    centre = { x: canvas.width / 2, y: canvas.height / 2 };
  }
  // Where a picture over a group is depends on where the group is just now; every other centre is fixed.
  if (figure === null || figure.kind !== 'picture' || figure.over === null) centres.set(element, centre);
  return centre;
}

function anchorPoint(anchor: Anchor, canvas: { width: number; height: number }, half: Pt): Pt {
  const inset = 2;
  const left = anchor === 'left' || anchor === 'top-left' || anchor === 'bottom-left';
  const right = anchor === 'right' || anchor === 'top-right' || anchor === 'bottom-right';
  const top = anchor === 'top' || anchor === 'top-left' || anchor === 'top-right';
  const bottom = anchor === 'bottom' || anchor === 'bottom-left' || anchor === 'bottom-right';
  return {
    x: left ? half.x + inset : right ? canvas.width - half.x - inset : canvas.width / 2,
    y: top ? half.y + inset : bottom ? canvas.height - half.y - inset : canvas.height / 2,
  };
}

function halfExtent(element: ElementSpan, sc: Scn, scaled: number | null): Pt {
  const scale = scaled ?? 1;
  const figure = element.figure;
  if (figure === null) return { x: 0, y: 0 };
  if (figure.kind === 'shape') {
    const box = boundsOf(figure.geometry);
    return { x: (box.w / 2) * scale, y: (box.h / 2) * scale };
  }
  if (figure.kind === 'sprite') {
    const dims = spriteDims(figure.sprite);
    const cell = cellFor(scaled, dims, canvasOf(element, sc));
    return { x: (dims.cols * cell) / 2, y: (dims.rows * cell) / 2 };
  }
  if (figure.kind === 'picture') {
    const box = pictureBoxOf(element, sc);
    return { x: (box.w / 2) * scale, y: (box.h / 2) * scale };
  }
  return { x: 0, y: 0 };
}

function resolveAt(style: ElementStyle, element: ElementSpan, natural: Pt, sc: Scn): Pt {
  const at = style.at;
  if (at === null) return natural;
  if (typeof at === 'string') return anchorPoint(at, canvasOf(element, sc), halfExtent(element, sc, style.scale));
  return at;
}

const startShares = new WeakMap<MoveChange, number>();

function nearestShare(line: Polyline, point: Pt): number {
  const samples = resample(line, 240);
  let best = Number.POSITIVE_INFINITY;
  let share = 0;
  samples.forEach((sample, i) => {
    const d = (sample.x - point.x) ** 2 + (sample.y - point.y) ** 2;
    if (d < best - 1e-12) {
      best = d;
      share = line.closed ? i / samples.length : i / (samples.length - 1);
    }
  });
  return share;
}

function trackOutline(key: string, sc: Scn): Polyline | null {
  const route = laidOutOf(sc.schedule)?.routeOf(key, sc.tq);
  if (route !== undefined && route !== null) return route;
  const track = sc.idx.byKey.get(key);
  const figure = track?.figure;
  if (track === undefined || figure === undefined || figure === null || figure.kind !== 'shape') return null;
  return morphedOutline(figure.geometry, morphsOf(track), sc.tq, sc.curve).polylines[0] ?? null;
}

function centreOf(element: ElementSpan, trans: Trans, natural: Pt, sc: Scn): Pt {
  const a = resolveAt(trans.from, element, natural, sc);
  const b = resolveAt(trans.to, element, natural, sc);
  const move = trans.move;
  if (move !== null && move.along !== null) {
    const line = trackOutline(move.along, sc);
    if (line !== null) {
      let first = startShares.get(move);
      if (first === undefined) {
        first = nearestShare(line, a);
        startShares.set(move, first);
      }
      const here = pointAlong(line, lerp(first, 1, trans.p));
      const anchor = pointAlong(line, first);
      // A mover that did not start on the line eases onto it; one that did is always on it.
      if (Math.hypot(a.x - anchor.x, a.y - anchor.y) <= 2) return here;
      return { x: here.x + (a.x - anchor.x) * (1 - trans.p), y: here.y + (a.y - anchor.y) * (1 - trans.p) };
    }
  }
  // A move ends inside the picture (PLAN-v2.1, D4): what it carries never leaves the canvas, whatever point was written.
  // (a stage that carries what a move left has only the point, so a written place is held to the same rule when it puts most of the thing inside)
  // A group sent to a point off the canvas is sent out of it: it runs off whole, and what it left is not there (as the stage it leaves says).
  const leaves = element.figure?.kind === 'group' && trans.to.at !== null && !onCanvas(b, element, sc);
  const end = !leaves && element.parent === null && trans.to.at !== null && (move !== null || mostlyInside(b, element, trans.to, sc)) ? keptInside(b, element, trans.to, sc) : b;
  return { x: lerp(a.x, end.x, trans.p), y: lerp(a.y, end.y, trans.p) };
}

function onCanvas(at: Pt, element: ElementSpan, sc: Scn): boolean {
  const canvas = canvasOf(element, sc);
  return at.x >= 0 && at.x <= canvas.width && at.y >= 0 && at.y <= canvas.height;
}

/**
 * How much of a group sent off the canvas is still on it: 1 until it reaches the edge, then less as it goes, 0 once all of it is past. The
 * stage past the canvas's edge is not the canvas (on a wide screen the picture's region runs on beyond it), so what has gone off is gone, not parked
 * in the margin. A group whose move ends on the canvas is not touched.
 */
function shareOnCanvas(group: ElementSpan, st: State, sc: Scn): number {
  const to = st.trans.to.at;
  if (to === null || typeof to === 'string' || onCanvas(to, group, sc)) return 1;
  const extent = groupExtent(group, sc);
  if (extent === null) return 1;
  const canvas = canvasOf(group, sc);
  const scale = st.scale;
  const across = (low: number, high: number, at: number, size: number): number => {
    const width = Math.max(1e-6, (high - low) * scale);
    const from = at + low * scale;
    return Math.min(1, Math.max(0, Math.min(from + width, size) - Math.max(from, 0)) / width);
  };
  return across(extent.minX, extent.maxX, st.centre.x, canvas.width) * across(extent.minY, extent.maxY, st.centre.y, canvas.height);
}

/**
 * The extent of a group about its own origin, canvas units, from the shapes that stand directly in it: what its place keeps inside the
 * canvas. Null when it holds nothing measurable.
 */
function groupExtent(group: ElementSpan, sc: Scn): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const member of sc.idx.children.get(group.key) ?? []) {
    const figure = member.figure;
    if (figure === null || figure.kind !== 'shape') continue;
    const box = boundsOf(figure.geometry);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** A thing whose written place has its middle on the canvas: it is meant to be seen there, so what hangs over the edge is pulled in. */
function mostlyInside(at: Pt, element: ElementSpan, style: ElementStyle, sc: Scn): boolean {
  const canvas = canvasOf(element, sc);
  const figure = element.figure;
  if (figure === null || (figure.kind !== 'group' && figure.kind !== 'shape' && figure.kind !== 'sprite')) return false;
  if (figure.kind === 'shape') {
    const box = boundsOf(figure.geometry);
    if (box.w >= canvas.width * 0.9 || box.h >= canvas.height * 0.9) return false;
  }
  return at.x >= 0 && at.x <= canvas.width && at.y >= 0 && at.y <= canvas.height && style.at !== null;
}

/** The point `at` (where a move ends) pulled in just far enough that the thing, whole, stands inside its canvas; a thing larger than the canvas is centred. */
function keptInside(at: Pt, element: ElementSpan, style: ElementStyle, sc: Scn): Pt {
  const canvas = canvasOf(element, sc);
  const figure = element.figure;
  let left: number;
  let right: number;
  let up: number;
  let down: number;
  if (figure !== null && figure.kind === 'group') {
    const extent = groupExtent(element, sc);
    if (extent === null) return at;
    const scale = style.scale ?? 1;
    // the group's origin is where its members' own units begin: its extent hangs off the point
    left = -extent.minX * scale;
    right = extent.maxX * scale;
    up = -extent.minY * scale;
    down = extent.maxY * scale;
  } else {
    const half = halfExtent(element, sc, style.scale);
    if (half.x === 0 && half.y === 0) return at;
    [left, right, up, down] = [half.x, half.x, half.y, half.y];
  }
  const fit = (value: number, before: number, after: number, size: number): number => (before + after >= size ? (size - after + before) / 2 : Math.min(Math.max(value, before), size - after));
  return { x: fit(at.x, left, right, canvas.width), y: fit(at.y, up, down, canvas.height) };
}

function extrasOf(element: ElementSpan, style: ElementStyle, sc: Scn, cell: number): Extras {
  if (sc.rest) return NO_EXTRAS;
  const { aq, tq, reduced } = sc;
  let dx = 0;
  let dy = 0;
  let rot = 0;
  let scale = 1;
  let opacity = 1;
  let flash = 0;
  switch (style.loop) {
    case 'breathe':
      scale = 1 + 0.03 * Math.sin((2 * Math.PI * aq) / 4);
      break;
    case 'pulse':
      scale = 1 + 0.08 * (0.5 - 0.5 * Math.cos(2 * Math.PI * ((aq / 1.2) % 1)));
      break;
    case 'blink':
      if (!reduced && (aq / 0.9) % 1 >= 0.5) opacity = 0;
      break;
    case 'shake':
      if (!reduced) {
        const slot = Math.floor(aq * 24);
        dx = 0.8 * (hash(`${element.key}x${slot}`) * 2 - 1);
        dy = 0.8 * (hash(`${element.key}y${slot}`) * 2 - 1);
      }
      break;
    case 'drift': {
      const theta = (2 * Math.PI * aq) / 9;
      dx = 1.6 * Math.sin(theta);
      dy = 0.8 * Math.sin(2 * theta);
      break;
    }
    case 'spin':
      if (!reduced) rot = (360 * aq) / 6;
      break;
    case 'bob':
      if (!reduced) {
        const wave = Math.sin((2 * Math.PI * aq) / 1.8);
        // A sprite rides by whole cells.
        dy = cell > 0 ? -cell * Math.round(wave * 0.9) : -1.2 * wave;
      }
      break;
    case 'sway':
      if (!reduced) rot = 4 * Math.sin((2 * Math.PI * aq) / 3.2);
      break;
    case 'none':
      break;
  }
  for (const change of element.changes) {
    if (change.kind !== 'hit' || tq < change.start || tq >= change.end) continue;
    const p = (tq - change.start) / (change.end - change.start);
    const gesture = change.gesture === 'shake' && reduced ? 'flash' : change.gesture;
    if (gesture === 'pulse') scale *= 1 + 0.12 * Math.sin(Math.PI * p);
    else if (gesture === 'flash') flash = sc.flashAllowed === null || sc.flashAllowed.has(change) ? Math.sin(Math.PI * p) : 0;
    else dx += 1.2 * (1 - p) * Math.sin(2 * Math.PI * 4 * p);
  }
  return { dx, dy, rot, scale, opacity, flash };
}

function stateFor(element: ElementSpan, sc: Scn): State {
  const trans = transition(element, sc.tq, sc.curve);
  const natural = naturalCentre(element, sc);
  const figure = element.figure;
  const scale = lerp(trans.from.scale ?? 1, trans.to.scale ?? 1, trans.p);
  const dims = figure !== null && figure.kind === 'sprite' ? { sprite: spriteDims(figure.sprite), canvas: canvasOf(element, sc) } : null;
  const cell = dims === null ? 0 : lerp(cellFor(trans.from.scale, dims.sprite, dims.canvas), cellFor(trans.to.scale, dims.sprite, dims.canvas), trans.p);
  return {
    trans,
    natural,
    centre: centreOf(element, trans, natural, sc),
    scale,
    cell,
    rot: lerp(trans.from.rot, trans.to.rot, trans.p),
    opacity: lerp(trans.from.opacity, trans.to.opacity, trans.p),
    extras: extrasOf(element, trans.to, sc, cell),
  };
}

function groupState(group: ElementSpan, sc: Scn): GroupState {
  const known = sc.groups.get(group.key);
  if (known !== undefined) return known;
  const st = stateFor(group, sc);
  const share = shareOnCanvas(group, st, sc);
  const M = mul(translation(st.extras.dx, st.extras.dy), mul(translation(st.centre.x, st.centre.y), mul(rotation(st.rot + st.extras.rot), scaling(st.scale * st.extras.scale))));
  const made: GroupState = { M, opacity: st.opacity * st.extras.opacity * share, flash: st.extras.flash, extras: st.extras, origin: st.centre };
  sc.groups.set(group.key, made);
  return made;
}

const ROOT = { M: IDENTITY, opacity: 1, flash: 0 };

function parentChain(element: ElementSpan, sc: Scn): { M: Affine; opacity: number; flash: number } {
  if (element.parent === null) return ROOT;
  const group = sc.idx.byKey.get(element.parent);
  if (group === undefined || group.figure === null || group.figure.kind !== 'group') return ROOT;
  const state = groupState(group, sc);
  return { M: state.M, opacity: state.opacity, flash: state.flash };
}

/** Own units into the parent's: grow and turn about the centre, then go where the centre is. */
function localMatrix(element: ElementSpan, st: State): Affine {
  const turn = st.rot + st.extras.rot;
  const move = mul(translation(st.extras.dx, st.extras.dy), translation(st.centre.x, st.centre.y));
  if (element.figure !== null && element.figure.kind === 'sprite') return mul(move, mul(rotation(turn), scaling(st.extras.scale)));
  return mul(move, mul(rotation(turn), mul(scaling(st.scale * st.extras.scale), translation(-st.natural.x, -st.natural.y))));
}

interface CopyFrame {
  /** the copy */
  readonly owner: ElementSpan;
  /** the matrix of the place the copy stands in: its group's, or its own place for the parts of a copied group */
  readonly M: Affine;
  readonly opacity: number;
  readonly flash: number;
  /** the copy's own place, size and turn */
  readonly state: State;
  readonly index: number;
  readonly count: number;
}

function placePart(element: ElementSpan, sc: Scn, copy: CopyFrame | null): Placed | null {
  if (!isPlaced(element)) return null;
  const st = stateFor(element, sc);
  const figure = element.figure;
  let cell = st.cell;
  if (copy === null) {
    const chain = parentChain(element, sc);
    const M = mul(chain.M, localMatrix(element, st));
    return {
      el: element,
      owner: element,
      key: element.key,
      z: element.order,
      M,
      trans: st.trans,
      cell,
      pivot: apply(M, st.natural),
      opacity: chain.opacity * st.opacity * st.extras.opacity,
      flash: Math.max(chain.flash, st.extras.flash),
      source: null,
    };
  }
  const key = `${copy.owner.key}/${element.key}`;
  const z = copy.owner.order + ((copy.index + 1) / (copy.count + 1)) * 0.9;
  if (element.parent !== null) {
    // A part of a copied group keeps its place in the group, under the copy's matrix.
    const M = mul(copy.M, localMatrix(element, st));
    return {
      el: element,
      owner: copy.owner,
      key,
      z,
      M,
      trans: st.trans,
      cell,
      pivot: apply(M, st.natural),
      opacity: copy.opacity * st.opacity * st.extras.opacity,
      flash: Math.max(copy.flash, st.extras.flash),
      source: element,
    };
  }
  // A single thing copied: the copy's own size and turn replace the source's, and it stands where the copy says, or where the source is.
  const own = copy.state;
  const placeless = own.trans.to.at === null && own.trans.from.at === null;
  const stand: State = { ...st, centre: placeless ? st.centre : own.centre, scale: own.scale, rot: own.rot, extras: own.extras };
  if (figure !== null && figure.kind === 'sprite') cell *= own.scale;
  const M = mul(copy.M, localMatrix(element, stand));
  return {
    el: element,
    owner: copy.owner,
    key,
    z,
    M,
    trans: st.trans,
    cell,
    pivot: apply(M, st.natural),
    opacity: copy.opacity * st.opacity,
    flash: Math.max(copy.flash, st.extras.flash),
    source: element,
  };
}

function placeCopy(copy: ElementSpan, sc: Scn): Placed[] {
  const figure = copy.figure;
  if (figure === null || figure.kind !== 'copy') return [];
  let source = sc.idx.byKey.get(figure.source);
  for (let hops = 0; source !== undefined && source.figure !== null && source.figure.kind === 'copy' && hops < MAX_COPY_DEPTH; hops += 1) {
    source = sc.idx.byKey.get(source.figure.source);
  }
  if (source === undefined || source.figure === null || source.figure.kind === 'copy') return [];
  const own = stateFor(copy, sc);
  const chain = parentChain(copy, sc);
  const opacity = chain.opacity * own.opacity * own.extras.opacity;
  const flash = Math.max(chain.flash, own.extras.flash);
  if (source.figure.kind !== 'group') {
    const placed = placePart(source, sc, { owner: copy, M: chain.M, opacity, flash, state: own, index: 0, count: 1 });
    return placed === null ? [] : [placed];
  }
  const from = groupState(source, sc);
  const placeless = own.trans.to.at === null && own.trans.from.at === null;
  const origin = placeless ? from.origin : own.centre;
  // The copy stands where it is told, at its own size and turn, and keeps the source's loop (it spins when the source spins).
  const M = mul(
    chain.M,
    mul(
      translation(own.extras.dx, own.extras.dy),
      mul(translation(origin.x + from.extras.dx, origin.y + from.extras.dy), mul(rotation(own.rot + own.extras.rot + from.extras.rot), scaling(own.scale * own.extras.scale * from.extras.scale))),
    ),
  );
  const parts = (sc.idx.children.get(source.key) ?? [])
    .filter((part) => isPlaced(part) && hasEntered(part, sc.tq) && (part.exit === null || sc.tq < part.exit.end))
    .sort((a, b) => a.order - b.order);
  const out: Placed[] = [];
  parts.forEach((part, index) => {
    const placed = placePart(part, sc, { owner: copy, M, opacity: opacity * from.opacity, flash: Math.max(flash, from.flash), state: own, index, count: parts.length });
    if (placed !== null) out.push(placed);
  });
  return out;
}

/** Every drawn thing that has a place, for the elements on stage at `sc.tq`. */
function placeAll(sc: Scn): Placed[] {
  const out: Placed[] = [];
  for (const element of sc.schedule.elements) {
    if (!isOnStage(element, sc.tq)) continue;
    try {
      if (element.figure?.kind === 'copy') out.push(...placeCopy(element, sc));
      else {
        const placed = placePart(element, sc, null);
        if (placed !== null) out.push(placed);
      }
    } catch (error) {
      if (sc.fault === null) throw error;
      sc.fault(error, element.key);
    }
  }
  return out;
}

interface RawBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function emptyBox(): RawBox {
  return { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY };
}

function growBox(box: RawBox, p: Pt): void {
  box.minX = Math.min(box.minX, p.x);
  box.minY = Math.min(box.minY, p.y);
  box.maxX = Math.max(box.maxX, p.x);
  box.maxY = Math.max(box.maxY, p.y);
}

function toCanvasRect(box: RawBox): CanvasRect | null {
  if (!Number.isFinite(box.minX)) return null;
  return { x: box.minX, y: box.minY, w: box.maxX - box.minX, h: box.maxY - box.minY };
}

function placedPoints(placed: Placed, sc: Scn): Pt[] {
  const figure = placed.el.figure;
  if (figure === null) return [];
  if (figure.kind === 'shape') {
    const outline = morphedOutline(figure.geometry, morphsOf(placed.el), sc.tq, sc.curve).polylines;
    return outline.flatMap((line) => line.points.map((p) => apply(placed.M, p)));
  }
  if (figure.kind === 'sprite') {
    const dims = spriteDims(figure.sprite);
    const w = (dims.cols * placed.cell) / 2;
    const h = (dims.rows * placed.cell) / 2;
    return [
      apply(placed.M, { x: -w, y: -h }),
      apply(placed.M, { x: w, y: -h }),
      apply(placed.M, { x: w, y: h }),
      apply(placed.M, { x: -w, y: h }),
    ];
  }
  if (figure.kind === 'picture') {
    const box = pictureBoxOf(placed.el, sc);
    return [
      apply(placed.M, { x: box.x, y: box.y }),
      apply(placed.M, { x: box.x + box.w, y: box.y }),
      apply(placed.M, { x: box.x + box.w, y: box.y + box.h }),
      apply(placed.M, { x: box.x, y: box.y + box.h }),
    ];
  }
  return [];
}

function scnAt(schedule: Schedule, base: StageBase | null, time: number, curve: Ease): Scn {
  return { schedule, base, idx: indexOf(schedule), tq: time, aq: time, reduced: false, curve, rest: true, flashAllowed: null, groups: new Map(), fault: null };
}

function unionBox(element: ElementSpan, schedule: Schedule, time: number, base: StageBase | null, curve: Ease): CanvasRect | null {
  const sc = scnAt(schedule, base, time, curve);
  const targets = element.figure?.kind === 'group' ? (sc.idx.children.get(element.key) ?? []).filter((part) => isOnStage(part, time)) : [element];
  const box = emptyBox();
  for (const target of targets) {
    const list = target.figure?.kind === 'copy' ? placeCopy(target, sc) : [placePart(target, sc, null)];
    for (const placed of list) {
      if (placed === null) continue;
      for (const p of placedPoints(placed, sc)) growBox(box, p);
    }
  }
  return toCanvasRect(box);
}

/** Where a group's own units are on the canvas at `time`: what a part measured from the group's `at=` is carried by. Null when it is not a group. */
export function groupMatrixAt(group: ElementSpan, schedule: Schedule, time: number): Affine | null {
  if (group.figure === null || group.figure.kind !== 'group') return null;
  return groupState(group, scnAt(schedule, null, time, 'out')).M;
}

/** The box a drawn element occupies on the canvas at `time`, canvas units: used for `near=`, for `cam focus`, and for the sight report. */
export function canvasBoxOf(element: ElementSpan, schedule: Schedule, time: number, part?: string): CanvasRect | null {
  if (element.kind === 'text' || element.kind === 'field') return null;
  // `near=m1.tens`: the part of a written method; the whole block when the layout does not know the part
  if (element.kind === 'structure' && part !== undefined) return laidOutOf(schedule)?.boxOf(`${element.key}.${part}`, time) ?? laidOutOf(schedule)?.boxOf(element.key, time) ?? null;
  if (element.kind === 'structure' || element.kind === 'node' || element.kind === 'link' || element.kind === 'control') return laidOutOf(schedule)?.boxOf(element.key, time) ?? null;
  return unionBox(element, schedule, time, null, 'out');
}

/** The most a canvas grows to take in what was drawn past it: this many times its declared size on each side. Past it the drawing is cropped, as before. */
const MAX_GROWTH = 4;
const sceneSizes = new WeakMap<Schedule, Map<string, { width: number; height: number }>>();
type Size = { width: number; height: number };

/**
 * The size of the drawing space of a scene: its declared canvas, or, when something was drawn with its centre past the right or the bottom edge
 * (a row of practice boxes that runs off the square), the declared canvas grown to take in all that was drawn there (`fitIn` then leaves room past it for labels), so the whole drawing is
 * fitted to the screen and nothing is cropped. The origin stays where it was, so a picture that fits is fitted exactly as before. Within reason:
 * never more than MAX_GROWTH times the declared size on a side.
 */
export function sceneCanvasOf(schedule: Schedule, scene: Pick<SceneSpan, 'id' | 'canvas'>): Size {
  const declared: Size = CANVAS[scene.canvas];
  const memo = sceneSizes.get(schedule) ?? new Map<string, { width: number; height: number }>();
  sceneSizes.set(schedule, memo);
  const known = memo.get(scene.id);
  if (known !== undefined) return known;
  let right = declared.width;
  let bottom = declared.height;
  let past = false;
  for (const element of schedule.elements) {
    if (element.scene !== scene.id || element.parent !== null || element.figure === null || element.figure.kind !== 'shape') continue;
    if (element.style.layer !== 'mid' || (element.figure.geometry.shape === 'rect' && element.figure.geometry.full)) continue;
    const box = unionBox(element, schedule, Math.max(0, element.enter?.end ?? 0), null, 'out');
    if (box === null) continue;
    if (box.x + box.w / 2 > declared.width || box.y + box.h / 2 > declared.height) past = true;
    right = Math.max(right, box.x + box.w);
    bottom = Math.max(bottom, box.y + box.h);
  }
  const grown: Size = past
    ? { width: Math.min(declared.width * MAX_GROWTH, right), height: Math.min(declared.height * MAX_GROWTH, bottom) }
    : { width: declared.width, height: declared.height };
  memo.set(scene.id, grown);
  return grown;
}

/** The keys of the elements a picture stands on: the sketch the image model is shown, and the lines that fade as the painting grows. */
export function sketchKeysOf(picture: ElementSpan, schedule: Schedule): Set<string> {
  const keys = new Set<string>();
  const figure = picture.figure;
  if (figure === null || figure.kind !== 'picture') return keys;
  for (const element of schedule.elements) {
    if (element === picture || !(isPlaced(element) || element.kind === 'copy') || element.kind === 'picture') continue;
    if (figure.over !== null) {
      if (element.parent === figure.over) keys.add(element.key);
    } else if (element.scene === picture.scene && element.order < picture.order && element.style.layer === picture.style.layer) keys.add(element.key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Stage B: the look, the envelope, the screen

interface Env {
  readonly opacity: number;
  /** stage units on the layer's plane */
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
  /** share of the outline drawn, 0..1 */
  readonly draw: number;
  /** share of the fill that has arrived, 0..1 */
  readonly fill: number;
  readonly entering: boolean;
  readonly leaving: boolean;
}

interface Frm {
  readonly sc: Scn;
  readonly viewport: Viewport;
  readonly look: LookSpec;
  readonly paintings: ReadonlyMap<string, Painting>;
  readonly body: number;
  readonly fits: Map<string, CanvasFit>;
  readonly envs: Map<string, Env | null>;
  readonly fades: ReadonlyMap<string, number>;
  readonly defaultFit: CanvasFit;
  /** `?shade=1` and a look that wants it: shapes the brain drew get a light, a rim and (for a group) a contact shadow */
  readonly lit: boolean;
  readonly fixedFit: CanvasFit | null;
  readonly fitOf: ((sceneId: string) => CanvasFit) | null;
  /** v2.1 (D3): the painting that stands on a group, by the group's key: the group's members are a frame, kept inside the picture's box */
  readonly standing: ReadonlyMap<string, ElementSpan>;
  /** v2.1 (D3): which edges of each scene's canvas filled shapes cover end to end, by scene id: those edges are open, and shapes on them run on to the picture's region */
  readonly open: ReadonlyMap<string, OpenEdges>;
}

interface OpenEdges {
  readonly left: boolean;
  readonly right: boolean;
  readonly top: boolean;
  readonly bottom: boolean;
}

const paintCache = new WeakMap<LookSpec, Map<string, Colour>>();

function isHex(paint: Paint): paint is `#${string}` {
  return paint.startsWith('#');
}

export function paintColour(paint: Paint, look: LookSpec): Colour {
  let cache = paintCache.get(look);
  if (cache === undefined) {
    cache = new Map();
    paintCache.set(look, cache);
  }
  const known = cache.get(paint);
  if (known !== undefined) return known;
  const made = isHex(paint) ? mapToGamut(paint, look) : has(look.roles, paint) ? look.roles[paint] : look.roles.ink;
  cache.set(paint, made);
  return made;
}

function strongest(look: LookSpec): Colour {
  let best = look.roles.ink;
  let bestRatio = 0;
  for (const colour of [look.roles.ink, look.roles.accent, look.roles.alt]) {
    const ratio = contrastRatio(colour, look.roles.ground);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = colour;
    }
  }
  return best;
}

function fitFor(frm: Frm, element: ElementSpan): CanvasFit {
  if (frm.fixedFit !== null) return frm.fixedFit;
  const scene = frm.sc.idx.scenes.get(element.scene) ?? frm.sc.schedule.scenes[0];
  if (scene === undefined || frm.fitOf === null) return frm.defaultFit;
  const known = frm.fits.get(scene.id);
  if (known !== undefined) return known;
  const made = frm.fitOf(scene.id);
  frm.fits.set(scene.id, made);
  return made;
}

const FADE: MotionRecipe = { from: { opacity: 0 }, ease: 'out', reveal: false, flicker: false };

function envelope(element: ElementSpan, frm: Frm): Env | null {
  const known = frm.envs.get(element.key);
  if (known !== undefined) return known;
  const made = computeEnvelope(element, frm);
  frm.envs.set(element.key, made);
  return made;
}

function computeEnvelope(element: ElementSpan, frm: Frm): Env | null {
  const { sc, look, body } = frm;
  const tq = sc.tq;
  const enter = element.enter;
  const exit = element.exit;
  if (enter !== null && tq < enter.start) return null;
  if (exit !== null && tq >= exit.end) return null;
  let opacity = 1;
  let dx = 0;
  let dy = 0;
  let scale = 1;
  let draw = 1;
  let fill = 1;
  let entering = false;
  if (enter !== null && tq < enter.end) {
    entering = true;
    const span = enter.end - enter.start;
    const p = span <= 0 ? 1 : clamp01((tq - enter.start) / span);
    const kind = element.figure?.kind;
    if (enter.effect === 'draw') {
      if (kind === 'shape' && element.style.stroke !== 'none') {
        draw = p;
        fill = clamp01((p - 2 / 3) * 3);
      } else if (kind === 'copy') {
        draw = p;
        fill = clamp01((p - 2 / 3) * 3);
      } else if (kind !== 'sprite') {
        opacity = ease('out', p);
      }
    } else {
      let recipe = own<MotionRecipe>(look.motion.enter as Readonly<Record<string, MotionRecipe>>, enter.effect, FADE);
      if (sc.reduced && (enter.effect === 'slam' || recipe.flicker)) recipe = FADE;
      const e = ease(recipe.ease, p);
      // A wipe reveals text from the left; a drawn thing has no left to reveal from, so it fades.
      opacity = recipe.reveal ? ease('out', p) : lerp(recipe.from.opacity ?? 1, 1, e);
      dx = lerp((recipe.from.dx ?? 0) * body, 0, e);
      dy = lerp((recipe.from.dy ?? 0) * body, 0, e);
      scale = lerp(recipe.from.scale ?? 1, 1, e);
      if (recipe.flicker && !sc.reduced && p < 1) {
        const slot = Math.floor((tq - enter.start) / FLICKER_SLOT);
        const last = Math.floor(span / FLICKER_SLOT);
        if (!(slot >= last || hash(`${element.key}#${slot}`) > 0.45)) opacity = 0;
      }
    }
  }
  let leaving = false;
  if (exit !== null && tq >= exit.start) {
    leaving = true;
    const recipe = own<MotionRecipe>(look.motion.exit as Readonly<Record<string, MotionRecipe>>, exit.effect, FADE);
    const length = exit.end - exit.start;
    const q = length <= 0 ? 1 : clamp01((tq - exit.start) / length);
    const e = ease(recipe.ease === 'hold' ? 'linear' : recipe.ease, q);
    opacity *= recipe.reveal ? 1 - e : lerp(1, recipe.from.opacity ?? 1, e);
    dx += lerp(0, (recipe.from.dx ?? 0) * body, e);
    dy += lerp(0, (recipe.from.dy ?? 0) * body, e);
    scale *= lerp(1, recipe.from.scale ?? 1, e);
  }
  return { opacity, dx, dy, scale, draw, fill, entering, leaving };
}

function stageMatrix(frm: Frm, element: ElementSpan, layer: Layer): Affine {
  const fit = fitFor(frm, element);
  const ps = planeScale(layer, frm.viewport);
  const k = fit.unit / ps;
  return { a: k, b: 0, c: 0, d: k, e: fit.box.x / ps, f: fit.box.y / ps };
}

function layerOf(placed: Placed): Layer {
  return placed.owner.style.layer;
}

/** Own units to the layer's plane in stage units, with the envelope's offset and scale folded in. */
function toStage(placed: Placed, frm: Frm, env: Env): Affine {
  const S = stageMatrix(frm, placed.owner, layerOf(placed));
  const full = mul(S, placed.M);
  if (env.dx === 0 && env.dy === 0 && env.scale === 1) return full;
  return mul(translation(env.dx, env.dy), mul(about(apply(S, placed.pivot), 0, env.scale), full));
}

function flatOf(fill: Fill): { from: Paint; to: Paint | null; mid: readonly Paint[] } | null {
  if (fill === 'none') return null;
  if (typeof fill === 'string') return { from: fill, to: null, mid: [] };
  return { from: fill.from, to: fill.to, mid: fill.mid ?? [] };
}

function fillOf(trans: Trans, look: LookSpec, flash: number, arrival: number): FillFrame | null {
  const filled = fillColours(trans, look, flash, arrival);
  const tex = trans.to.tex;
  return filled === null || tex === 'flat' ? filled : { ...filled, texture: tex };
}

function fillColours(trans: Trans, look: LookSpec, flash: number, arrival: number): FillFrame | null {
  const a = flatOf(trans.from.fill);
  const b = flatOf(trans.to.fill);
  const strong = flash > 0 ? strongest(look) : null;
  const tint = (c: Colour): Colour => (strong === null ? c : mixHex(c, strong, flash));
  if (a === null && b === null) return null;
  const t = trans.p;
  // The colours between the ends of a gradient, spread evenly (`fill=a>b>c`); a change between gradients of as many stops moves each stop.
  const stopsOf = (fill: { from: Paint; to: Paint | null; mid: readonly Paint[] }): Colour[] => [fill.from, ...fill.mid, ...(fill.to === null ? [] : [fill.to])].map((paint) => tint(paintColour(paint, look)));
  const shape = trans.to.fill === 'none' ? {} : { ...(trans.to.radial && { radial: true }), ...(trans.to.angle !== 0 && !trans.to.radial && { angle: trans.to.angle }) };
  if (a === null || b === null) {
    const only = a ?? b;
    if (only === null) return null;
    const stops = stopsOf(only);
    return { colour: tint(paintColour(only.from, look)), to: only.to === null ? null : tint(paintColour(only.to, look)), opacity: (a === null ? t : 1 - t) * arrival, ...(stops.length > 2 && { stops }), ...(only.to !== null && shape) };
  }
  const toA = paintColour(a.to ?? a.from, look);
  const toB = paintColour(b.to ?? b.from, look);
  const gradient = a.to !== null || b.to !== null;
  const before = stopsOf(a);
  const after = stopsOf(b);
  const stops = before.length === after.length ? after.map((stop, i) => mixHex(before[i] ?? stop, stop, t)) : t < 0.5 ? before : after;
  return {
    colour: tint(mixHex(paintColour(a.from, look), paintColour(b.from, look), t)),
    to: gradient ? tint(mixHex(toA, toB, t)) : null,
    opacity: arrival,
    ...(gradient && stops.length > 2 && { stops }),
    ...(gradient && shape),
  };
}

/** From this width (canvas units) a stroke is no longer a pencil line: the grain of a pencil turns to hatching and stripes at that size, so it is drawn as clean ink. */
const PENCIL_MAX_THICK = 2.5;

/** The character a stroke of this width is drawn in when the line gave no `brush=`: the look's own, except that a thick pencil line is clean ink. */
function characterAt(character: StrokeCharacter, width: number): StrokeCharacter {
  return character === 'pencil' && width >= PENCIL_MAX_THICK ? 'ink' : character;
}

function strokeOf(trans: Trans, look: LookSpec, flash: number, progress: number): StrokeFrame | null {
  const { from, to } = trans.from.stroke === 'none' && trans.to.stroke === 'none' ? { from: null, to: null } : { from: trans.from.stroke, to: trans.to.stroke };
  if (from === null || to === null) return null;
  // A line that has been taken away (or not yet given) is not drawn at all: left as a ground-coloured line it would show over anything but bare ground.
  if (to === 'none' && trans.p >= 1) return null;
  if (from === 'none' && trans.p <= 0) return null;
  let colour: Colour;
  if (from === 'none' && to !== 'none') colour = mixHex(look.roles.ground, paintColour(to, look), trans.p);
  else if (to === 'none' && from !== 'none') colour = mixHex(paintColour(from, look), look.roles.ground, trans.p);
  else if (from !== 'none' && to !== 'none') colour = mixHex(paintColour(from, look), paintColour(to, look), trans.p);
  else return null;
  if (flash > 0) colour = mixHex(colour, strongest(look), flash);
  const width = lerp(trans.from.thick ?? look.stroke.thick, trans.to.thick ?? look.stroke.thick, trans.p);
  const profile = pressureOf(trans.to.thickAlong);
  const colours = trans.to.strokeAlong !== null && to !== 'none' ? gradedOf(trans, to, colour, look, flash) : null;
  return {
    colour,
    width,
    progress,
    character: trans.to.brush ?? characterAt(look.stroke.character, width),
    ...(profile !== null && { pressure: profile }),
    ...(colours !== null && { along: colours }),
  };
}

/** `thick=a>b>c` as shares of the widest, or null when the widths do not vary or there is nothing to vary. */
function pressureOf(widths: readonly number[] | null): readonly number[] | null {
  if (widths === null || widths.length < 2) return null;
  const widest = Math.max(...widths);
  return widest > 0 ? widths.map((w) => w / widest) : null;
}

/** `stroke=c1>c2`: the colours along the stroke, the first having come from the stroke's colour a moment ago when it is changing. */
function gradedOf(trans: Trans, to: Paint, colour: Colour, look: LookSpec, flash: number): readonly Colour[] {
  const stops = [to, ...(trans.to.strokeAlong ?? [])].map((paint) => paintColour(paint, look));
  const earlier = trans.p >= 1 || trans.from.stroke === 'none' ? null : paintColour(trans.from.stroke, look);
  const strong = flash > 0 ? strongest(look) : null;
  return stops.map((stop, i) => {
    const mixed = earlier === null || i > 0 ? stop : mixHex(earlier, stop, trans.p);
    return strong === null ? mixed : mixHex(mixed, strong, flash);
  }).map((stop, i) => (i === 0 ? colour : stop));
}

const outlineMemo = new WeakMap<readonly Polyline[], Map<string, readonly Polyline[]>>();

function wobbledFor(lines: readonly Polyline[], seed: string, amount: number): readonly Polyline[] {
  if (amount <= 0) return lines;
  let byKey = outlineMemo.get(lines);
  if (byKey === undefined) {
    byKey = new Map();
    outlineMemo.set(lines, byKey);
  }
  const memo = `${seed}|${amount}`;
  let found = byKey.get(memo);
  if (found === undefined) {
    found = wobbled(lines, seed, amount);
    byKey.set(memo, found);
  }
  return found;
}

const dashMemo = new WeakMap<readonly Polyline[], Map<string, readonly Polyline[] | null>>();

/** `outline` cut into dashes, remembered for as long as the outline is the same one. */
function dashedFor(lines: readonly Polyline[], dash: readonly [number, number]): readonly Polyline[] | null {
  let byDash = dashMemo.get(lines);
  if (byDash === undefined) {
    byDash = new Map();
    dashMemo.set(lines, byDash);
  }
  const memo = `${dash[0]},${dash[1]}`;
  let found = byDash.get(memo);
  if (found === undefined) {
    found = dashed(lines, dash[0], dash[1]);
    byDash.set(memo, found);
  }
  return found;
}

/** How close to the canvas edge (canvas units) a point must be to be on it. */
const EDGE_TOLERANCE = 0.5;

/**
 * How far a bleeding shape may run (stage units): the picture's region, taken out to the stage's own edge on every side the ground covers
 * but the bottom, where the words stand. A landscape then reaches the sides and the top of the screen and is not a picture in a frame; what
 * is not ground (a lighthouse, a ship) is still clipped to the region, so nothing drawn runs under the words.
 */
function bleedRectOf(region: Box, viewport: Viewport, open: OpenEdges): Box {
  // past the screen's edge by a quarter of it: a camera that pans or pushes in moves the planes, and must not find where the ground ends
  const beyondX = viewport.width * 0.25;
  const beyondY = viewport.height * 0.25;
  const left = open.left ? Math.min(region.x, -viewport.width / 2 - beyondX) : region.x;
  const right = open.right ? Math.max(region.x + region.width, viewport.width / 2 + beyondX) : region.x + region.width;
  const top = open.top ? Math.min(region.y, -viewport.height / 2 - beyondY) : region.y;
  return { x: left, y: top, width: right - left, height: region.y + region.height - top };
}

const bleedMemo = new WeakMap<readonly Polyline[], Map<string, readonly Polyline[]>>();

/**
 * Bleed is one decision per scene and edge (PLAN-v2.1, D3). An edge of the canvas is open when filled shapes cover the whole of it; then every
 * filled shape lying along it runs on to the edge of the picture's region (never past: the region clips everything drawn on the canvas), so
 * land, water and sky reach the sides of the picture and a shape that only grazes an edge no one else covers stays where it was drawn.
 * Only the points that lie on an edge move, outward; the rest of the outline is the brain's. A gradient runs top to bottom of its own box,
 * so it runs on sideways only: extending it up or down would stretch the gradient (a renderer cannot hold it to its own box until a frame
 * says what that box is). Returns the outline unchanged (and an empty key) when nothing is to move.
 */
function bleedOutline(lines: readonly Polyline[], placed: Placed, frm: Frm): { lines: readonly Polyline[]; key: string } {
  const { a, b, c, d, e, f } = placed.M;
  if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || Math.abs(a) < 1e-6 || Math.abs(d) < 1e-6) return { lines, key: '' };
  const open = frm.open.get(placed.el.scene);
  if (open === undefined || (!open.left && !open.right && !open.top && !open.bottom)) return { lines, key: '' };
  const canvas = canvasOf(placed.el, frm.sc);
  const fit = fitFor(frm, placed.owner);
  let left = false;
  let right = false;
  let top = false;
  let bottom = false;
  const onEdge = (line: Polyline, test: (p: Pt) => boolean, along: (p: Pt) => number): boolean => {
    const hits = line.points.filter(test);
    if (hits.length < 2) return false;
    const first = along(hits[0] as Pt);
    return hits.some((p) => Math.abs(along(p) - first) > 1e-6);
  };
  for (const line of lines) {
    if (!line.closed || line.points.length < 3) continue;
    if (open.left && onEdge(line, (p) => Math.abs(a * p.x + e) <= EDGE_TOLERANCE, (p) => d * p.y + f)) left = true;
    if (open.right && onEdge(line, (p) => Math.abs(a * p.x + e - canvas.width) <= EDGE_TOLERANCE, (p) => d * p.y + f)) right = true;
    if (open.top && onEdge(line, (p) => Math.abs(d * p.y + f) <= EDGE_TOLERANCE, (p) => a * p.x + e)) top = true;
    if (open.bottom && onEdge(line, (p) => Math.abs(d * p.y + f - canvas.height) <= EDGE_TOLERANCE, (p) => a * p.x + e)) bottom = true;
  }
  if (!left && !right && !top && !bottom) return { lines, key: '' };
  // Canvas units from each canvas edge to the matching edge of the picture's region.
  const region = bleedRectOf(fit.region, frm.viewport, open);
  const reachLeft = Math.max(0, Math.round((fit.box.x - region.x) / fit.unit));
  const reachRight = Math.max(0, Math.round((region.x + region.width - (fit.box.x + fit.box.width)) / fit.unit));
  const reachTop = Math.max(0, Math.round((fit.box.y - region.y) / fit.unit));
  const reachBottom = Math.max(0, Math.round((region.y + region.height - (fit.box.y + fit.box.height)) / fit.unit));
  const key = `${left ? `L${reachLeft}` : ''}${right ? `R${reachRight}` : ''}${top ? `T${reachTop}` : ''}${bottom ? `B${reachBottom}` : ''}|${a.toFixed(2)}|${d.toFixed(2)}`;
  let byKey = bleedMemo.get(lines);
  if (byKey === undefined) {
    byKey = new Map();
    bleedMemo.set(lines, byKey);
  }
  const known = byKey.get(key);
  if (known !== undefined) return { lines: known, key };
  const made = lines.map((line) => {
    if (!line.closed || line.points.length < 3) return line;
    return {
      closed: line.closed,
      points: line.points.map((p) => {
        let x = p.x;
        let y = p.y;
        const cx = a * p.x + e;
        const cy = d * p.y + f;
        if (left && Math.abs(cx) <= EDGE_TOLERANCE) x -= reachLeft / a;
        else if (right && Math.abs(cx - canvas.width) <= EDGE_TOLERANCE) x += reachRight / a;
        if (top && Math.abs(cy) <= EDGE_TOLERANCE) y -= reachTop / d;
        else if (bottom && Math.abs(cy - canvas.height) <= EDGE_TOLERANCE) y += reachBottom / d;
        return { x, y };
      }),
    };
  });
  byKey.set(key, made);
  return { lines: made, key };
}

/** The frame a thing on a canvas is kept inside (D3): the picture's box for a member of a painted group, else the scene's picture region. */
function clipOf(placed: Placed, frm: Frm, bleeds: boolean): Box | undefined {
  if (frm.fixedFit !== null || frm.fitOf === null) return undefined;
  const fit = fitFor(frm, placed.owner);
  const ps = planeScale(layerOf(placed), frm.viewport);
  const open = frm.open.get(placed.el.scene);
  let rect: Box = bleeds && open !== undefined ? bleedRectOf(fit.region, frm.viewport, open) : fit.region;
  // a member of a group a painting stands on is kept inside that painting's box
  let parent = placed.el.parent;
  for (let hops = 0; parent !== null && hops < 16; hops += 1) {
    const picture = frm.standing.get(parent);
    if (picture !== undefined) {
      const box = pictureBoxOf(picture, frm.sc);
      const inside: Box = { x: fit.box.x + box.x * fit.unit, y: fit.box.y + box.y * fit.unit, width: box.w * fit.unit, height: box.h * fit.unit };
      const x0 = Math.max(rect.x, inside.x);
      const y0 = Math.max(rect.y, inside.y);
      const x1 = Math.min(rect.x + rect.width, inside.x + inside.width);
      const y1 = Math.min(rect.y + rect.height, inside.y + inside.height);
      rect = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
      break;
    }
    parent = frm.sc.idx.byKey.get(parent)?.parent ?? null;
  }
  return { x: rect.x / ps, y: rect.y / ps, width: rect.width / ps, height: rect.height / ps };
}

/**
 * Whether a shape stands where it was written (no offset, no change of size from a group, a move or a scale). Only that is ground: a thing that
 * has been carried, or is on its way, has an edge of its own wherever it comes to rest, and one that rests against the canvas's side stays itself
 * and does not run on to the stage's edge. This is read from the place, not from a move in the schedule, because the settled stage that a
 * turn leaves keeps only the place.
 */
function standsWhereWritten(placed: Placed): boolean {
  const { a, b, c, d, e, f } = placed.M;
  return Math.abs(a - 1) < 1e-3 && Math.abs(d - 1) < 1e-3 && Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3 && Math.abs(e) < 1e-3 && Math.abs(f) < 1e-3;
}

/** Whether an element is a member (at any depth) of a group a painting stands on. */
function underPainting(element: ElementSpan, standing: ReadonlyMap<string, ElementSpan>, sc: Pick<Scn, 'idx'>): boolean {
  let parent = element.parent;
  for (let hops = 0; parent !== null && hops < 16; hops += 1) {
    if (standing.has(parent)) return true;
    parent = sc.idx.byKey.get(parent)?.parent ?? null;
  }
  return false;
}

/** `{ clip }` or nothing, to spread into a frame. */
function clipField(placed: Placed, frm: Frm, bleeds = false): { clip?: Box } {
  const clip = clipOf(placed, frm, bleeds);
  return clip === undefined ? {} : { clip };
}

/**
 * Which edges of each scene's canvas the filled shapes on stage cover end to end. A shape inside a group a painting stands on is a frame of its
 * own and does not count (nor bleed).
 */
function openEdgesOf(placed: readonly Placed[], standing: ReadonlyMap<string, ElementSpan>, sc: Scn): Map<string, OpenEdges> {
  type Span = [number, number];
  const covered = new Map<string, { left: Span[]; right: Span[]; top: Span[]; bottom: Span[] }>();
  const inPainting = (element: ElementSpan): boolean => underPainting(element, standing, sc);
  for (const item of placed) {
    const figure = item.el.figure;
    if (figure === null || figure.kind !== 'shape' || item.trans.to.bleed === 'none' || inPainting(item.el) || !standsWhereWritten(item)) continue;
    // an outline with nothing in it does not cover an edge: only a filled shape does
    if (item.el.style.fill === undefined || item.el.style.fill === 'none') continue;
    const { a, b, c, d, e, f } = item.M;
    if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || Math.abs(a) < 1e-6 || Math.abs(d) < 1e-6) continue;
    const canvas = canvasOf(item.el, sc);
    const into = covered.get(item.el.scene) ?? { left: [], right: [], top: [], bottom: [] };
    covered.set(item.el.scene, into);
    for (const line of morphedOutline(figure.geometry, morphsOf(item.el), sc.tq, sc.curve).polylines) {
      if (!line.closed || line.points.length < 3) continue;
      const along = (test: (x: number, y: number) => boolean, pick: (x: number, y: number) => number, list: Span[]): void => {
        const hits = line.points.map((p) => ({ x: a * p.x + e, y: d * p.y + f })).filter((p) => test(p.x, p.y)).map((p) => pick(p.x, p.y));
        if (hits.length >= 2) list.push([Math.min(...hits), Math.max(...hits)]);
      };
      along((x) => Math.abs(x) <= EDGE_TOLERANCE, (_x, y) => y, into.left);
      along((x) => Math.abs(x - canvas.width) <= EDGE_TOLERANCE, (_x, y) => y, into.right);
      along((_x, y) => Math.abs(y) <= EDGE_TOLERANCE, (x) => x, into.top);
      along((_x, y) => Math.abs(y - canvas.height) <= EDGE_TOLERANCE, (x) => x, into.bottom);
    }
  }
  const whole = (spans: Span[], length: number): boolean => {
    if (spans.length === 0) return false;
    const sorted = [...spans].sort((x, y) => x[0] - y[0]);
    let reach = 0;
    for (const [from, to] of sorted) {
      if (from > reach + OPEN_GAP) return false;
      reach = Math.max(reach, to);
    }
    return reach >= length - OPEN_GAP;
  };
  const out = new Map<string, OpenEdges>();
  for (const [scene, lists] of covered) {
    const canvas = CANVAS[sc.idx.scenes.get(scene)?.canvas ?? 'wide'];
    out.set(scene, { left: whole(lists.left, canvas.height), right: whole(lists.right, canvas.height), top: whole(lists.top, canvas.width), bottom: whole(lists.bottom, canvas.width) });
  }
  return out;
}

/** The gap, in canvas units, that two shapes along an edge may leave and still cover it. */
const OPEN_GAP = 1.5;

/** The top and height of an outline as the brain drew it, in the shape's own units: what a gradient runs over, though the outline is made to run on. */
function spanOf(lines: readonly Polyline[]): { readonly top: number; readonly height: number; readonly left: number; readonly width: number } {
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const line of lines) {
    for (const p of line.points) {
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
    }
  }
  return top === Infinity ? { top: 0, height: 0, left: 0, width: 0 } : { top, height: bottom - top, left, width: right - left };
}

/**
 * Light from one place (above), for a filled shape the brain drew in a plain colour: the fill becomes a two-tone gradient of its own hue, and
 * a shape with no outline gets a thin darker rim of that hue. What the brain already gave a gradient, a texture or a soft edge is left alone,
 * and so is a fill in the ground's own colour (a cut-out).
 */
function lightOf(placed: Placed, fill: FillFrame | null, stroke: StrokeFrame | null, look: LookSpec, draw: number, lines: readonly Polyline[]): { fill: FillFrame; stroke: StrokeFrame | null } | null {
  if (fill === null || fill.to !== null || fill.texture !== undefined) return null;
  if (placed.trans.to.tex !== 'flat' || placed.trans.to.soft > 0 || placed.trans.from.soft > 0 || fill.colour === look.roles.ground) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const line of lines) {
    for (const p of line.points) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  }
  const share = x1 > x0 && y1 > y0 ? ((x1 - x0) * (y1 - y0)) / (CANVAS.wide.width * CANVAS.wide.height) : 0;
  const tones = litFrom(fill.colour, look, strengthFor(share));
  return {
    fill: { ...fill, colour: tones.top, to: tones.bottom },
    stroke: stroke !== null ? stroke : { colour: tones.rim, width: Math.max(0.25, look.stroke.thick * 0.5), progress: draw, character: look.stroke.character },
  };
}

function spanned(fill: FillFrame | null, edged: boolean, lines: readonly Polyline[]): FillFrame | null {
  return fill === null || fill.to === null || !edged ? fill : { ...fill, span: spanOf(lines) };
}

function softOf(trans: Trans): { soft?: number } {
  const soft = lerp(trans.from.soft, trans.to.soft, trans.p);
  return soft > 0 ? { soft } : {};
}

function shapeFrame(placed: Placed, frm: Frm): ShapeFrame | null {
  const figure = placed.el.figure as FigureOf<'shape'>;
  const env = envelope(placed.owner, frm);
  if (env === null) return null;
  const { look, sc } = frm;
  // Inside a copy the source's own drawing-on still shows, never past what the copy has drawn.
  const part = placed.source === null ? null : envelope(placed.source, frm);
  const draw = Math.min(env.draw, part?.draw ?? 1);
  const arrival = Math.min(env.fill, part?.fill ?? 1);
  const morph = morphedOutline(figure.geometry, morphsOf(placed.el), sc.tq, sc.curve);
  const amount = sc.reduced && morph.moving ? 0 : look.stroke.wobble;
  const done = morphsOf(placed.el).filter((m) => m.start <= sc.tq);
  const latest = done[done.length - 1]?.geometry ?? figure.geometry;
  const fill = fillOf(placed.trans, look, placed.flash, arrival);
  const fullBleed = latest.shape === 'rect' && latest.full;
  const edged = fill !== null && !fullBleed && placed.trans.to.bleed !== 'none' && !underPainting(placed.el, frm.standing, frm.sc) && standsWhereWritten(placed) ? bleedOutline(morph.polylines, placed, frm) : { lines: morph.polylines, key: '' };
  const stroke = strokeOf(placed.trans, look, placed.flash, draw);
  const lit = frm.lit && !fullBleed ? lightOf(placed, fill, stroke, look, draw, morph.polylines) : null;
  const outline = wobbledFor(edged.lines, placed.el.key, amount);
  const dash = placed.trans.to.dash;
  const cut = dash !== null && stroke !== null && !fullBleed ? dashedFor(outline, dash) : null;
  return {
    kind: 'shape',
    key: placed.key,
    id: placed.owner.id,
    layer: layerOf(placed),
    z: placed.z,
    outline,
    ...(cut !== null && { strokeOutline: cut }),
    geometryKey: `${placed.key}|${morph.token}|${look.name}|${amount}${edged.key === '' ? '' : `|bleed${edged.key}`}${cut === null || dash === null ? '' : `|dash${dash[0]},${dash[1]}`}`,
    transform: toStage(placed, frm, env),
    fill: spanned(lit === null ? fill : lit.fill, edged.key !== '', morph.polylines),
    stroke: lit === null ? stroke : lit.stroke,
    opacity: clamp01(env.opacity * placed.opacity * (frm.fades.get(placed.owner.key) ?? 1)),
    ...softOf(placed.trans),
    ...(placed.trans.to.blend !== 'normal' && { blend: placed.trans.to.blend }),
    bleed: fullBleed,
    ...(fullBleed ? {} : clipField(placed, frm, edged.key !== '')),
    tappable: placed.trans.to.tap,
  };
}

interface SpriteMemo {
  readonly cells: Map<string, readonly (Colour | null)[]>;
}

const spriteMemos = new WeakMap<SpriteData, WeakMap<LookSpec, SpriteMemo>>();

function spriteMemo(data: SpriteData, look: LookSpec): SpriteMemo {
  let byLook = spriteMemos.get(data);
  if (byLook === undefined) {
    byLook = new WeakMap();
    spriteMemos.set(data, byLook);
  }
  let found = byLook.get(look);
  if (found === undefined) {
    found = { cells: new Map() };
    byLook.set(look, found);
  }
  return found;
}

function cellColour(char: string, data: SpriteData, look: LookSpec): Colour | null {
  const keyed = has(data.key, char) ? data.key[char] : undefined;
  if (keyed !== undefined) return keyed === 'none' ? null : paintColour(keyed, look);
  if (char === '.') return null;
  if (char === '#') return look.roles.ink;
  if (/^[0-9a-f]$/i.test(char)) return look.sprite[Number.parseInt(char, 16)] ?? look.roles.ink;
  return look.roles.ink;
}

const colourSets = new WeakMap<SpriteData, WeakMap<LookSpec, readonly Colour[]>>();

/** Every distinct colour a sprite ever shows in a look, over all its frames and rows: what its backing has to be chosen against. */
export function spriteColours(data: SpriteData, look: LookSpec): readonly Colour[] {
  let byLook = colourSets.get(data);
  if (byLook === undefined) {
    byLook = new WeakMap();
    colourSets.set(data, byLook);
  }
  const known = byLook.get(look);
  if (known !== undefined) return known;
  const found = new Set<Colour>();
  for (const frame of data.frames) {
    for (const row of frame) {
      for (const char of row.cells) {
        const colour = cellColour(char, data, look);
        if (colour !== null) found.add(colour);
      }
    }
  }
  const list = [...found];
  byLook.set(look, list);
  return list;
}

function rowSeconds(frm: Frm, at: number): number {
  const scene = sceneAt(frm.sc.schedule, at);
  return ROW_SECONDS[valueAt(scene.pace, at, frm.sc.base === null ? 'steady' : frm.sc.base.scene.pace)];
}

function meanOf(m: Affine): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

function spriteFrame(placed: Placed, frm: Frm): SpriteFrame | null {
  const figure = placed.el.figure as FigureOf<'sprite'>;
  const env = envelope(placed.owner, frm);
  if (env === null) return null;
  const { look, sc, viewport } = frm;
  const data = figure.sprite;
  const dims = spriteDims(data);
  const first = data.frames[0] ?? [];
  const drawing = placed.el.style.enter === 'draw' && placed.el.enter !== null;
  let present = first.length;
  let landed = first.length;
  if (drawing) {
    present = 0;
    landed = 0;
    for (const row of first) {
      if (row.at <= sc.tq) present += 1;
      landed += clamp01((sc.tq - row.at) / rowSeconds(frm, row.at));
    }
  }
  // Frame 0 draws itself in; once it is whole the frames cycle on ambient time.
  let frameIndex = 0;
  if (data.frames.length > 1 && landed >= first.length) {
    const fps = Math.min(data.fps ?? SPRITE_FPS, sc.reduced ? 2 : 60);
    frameIndex = Math.floor(sc.aq * fps + 1e-9) % data.frames.length;
  }
  const rows = data.frames[frameIndex] ?? first;
  const shown = frameIndex === 0 ? present : rows.length;
  const memoKey = `${frameIndex}:${shown}`;
  const memo = spriteMemo(data, look);
  let cells = memo.cells.get(memoKey);
  if (cells === undefined) {
    const list: (Colour | null)[] = [];
    for (let r = 0; r < dims.rows; r += 1) {
      const row = r < shown ? rows[r] : undefined;
      const chars = row === undefined ? [] : [...row.cells];
      for (let c = 0; c < dims.cols; c += 1) {
        const char = chars[c];
        list.push(char === undefined ? null : cellColour(char, data, look));
      }
    }
    cells = list;
    memo.cells.set(memoKey, cells);
  }
  const layer = layerOf(placed);
// Device pixels per own unit: a canvas unit is `unit` stage pixels on every layer with the camera at rest (the plane's own scale is already inside the stage matrix).
  const toDevice = fitFor(frm, placed.owner).unit * viewport.dpr * meanOf(placed.M);
  let cell = placed.cell;
  const cellPx = cell * toDevice;
  // The `pixel` look is made of whole device pixels at every size; every other look snaps only the cells too small to be seen apart.
  if (cellPx > 0 && (cellPx < SNAP_BELOW_PX || look.id === 'pixel')) cell = Math.max(1, Math.round(cellPx)) / toDevice;
  return {
    kind: 'sprite',
    key: placed.key,
    id: placed.owner.id,
    layer,
    z: placed.z,
    cols: dims.cols,
    rows: dims.rows,
    cells,
    cellsKey: `${placed.el.key}|${memoKey}|${look.name}`,
    cell,
    transform: toStage(placed, frm, env),
    landed,
    opacity: clamp01(env.opacity * placed.opacity * (frm.fades.get(placed.owner.key) ?? 1)),
    ...clipField(placed, frm),
    tappable: placed.trans.to.tap,
  };
}

function developOf(painting: Painting | undefined, ambient: number): number {
  if (painting === undefined || painting.status !== 'ready') return 0;
  // Time pinned earlier than the arrival (a seek) shows the painting as it came to rest.
  if (ambient < painting.since) return 1;
  return clamp01((ambient - painting.since) / DEVELOP_SECONDS);
}

/**
 * How far a painting the renderer makes itself (a `paint` line with `as=`) has developed: over the same two and a half seconds, counted
 * on the timeline from the moment its picture has come in, so a seek and a film show what a live run shows.
 */
function ownDevelopOf(picture: ElementSpan, time: number): number {
  // A picture carried from an earlier turn, or rebuilt at rest, has long since developed.
  if (picture.carried) return 1;
  const since = picture.enter?.end ?? picture.enter?.start ?? 0;
  return clamp01((time - since) / DEVELOP_SECONDS);
}

function pictureFrame(placed: Placed, frm: Frm): PictureFrame | null {
  const figure = placed.el.figure as FigureOf<'picture'>;
  const env = envelope(placed.owner, frm);
  if (env === null) return null;
  const painting = frm.paintings.get(placed.el.key);
  const whole = pictureBoxOf(placed.el, frm.sc);
  const box = figure.from != null && painting?.aspect !== undefined ? containIn(whole, painting.aspect) : whole;
  const url = painting !== undefined && painting.status === 'ready' ? painting.url : null;
  if (figure.medium !== null && painting?.status !== 'ready') {
    return {
      kind: 'picture',
      key: placed.key,
      id: placed.owner.id,
      layer: layerOf(placed),
      z: placed.z,
      box: { x: box.x, y: box.y, width: box.w, height: box.h },
      transform: toStage(placed, frm, env),
      src: null,
      develop: ownDevelopOf(placed.el, frm.sc.tq),
      mask: figure.mask,
      opacity: clamp01(env.opacity * placed.opacity),
      waiting: false,
      ...clipField(placed, frm),
      tappable: placed.trans.to.tap,
      medium: figure.medium,
      sketch: [],
    };
  }
  return {
    kind: 'picture',
    key: placed.key,
    id: placed.owner.id,
    layer: layerOf(placed),
    z: placed.z,
    box: { x: box.x, y: box.y, width: box.w, height: box.h },
    transform: toStage(placed, frm, env),
    src: url,
    develop: url === null ? 0 : developOf(painting, frm.sc.aq),
    mask: figure.mask,
    opacity: clamp01(env.opacity * placed.opacity),
    waiting: painting !== undefined && painting.status === 'waiting',
    ...clipField(placed, frm),
    tappable: placed.trans.to.tap,
  };
}

function fieldFrame(element: ElementSpan, frm: Frm): FieldFrame | null {
  const figure = element.figure as FigureOf<'field'>;
  const env = envelope(element, frm);
  if (env === null) return null;
  const { look, viewport } = frm;
  const style = element.style;
  const trans = transition(element, frm.sc.tq, frm.sc.curve);
  const role = figure.field === 'embers' || figure.field === 'fireflies' ? 'accent' : figure.field === 'stars' ? 'ink' : 'dim';
  const area = (viewport.width * viewport.height) / (1440 * 900);
  return {
    kind: 'field',
    key: element.key,
    layer: style.layer,
    field: figure.field,
    density: clamp01(own<number>(DENSITY, figure.amount, 0.5) * Math.min(1, Math.max(0.3, Math.sqrt(area)))),
    colour: style.ink !== 'ink' ? paintColour(style.ink, look) : look.roles[role],
    opacity: clamp01(env.opacity * lerp(trans.from.opacity, trans.to.opacity, trans.p)),
    seed: Math.floor(hash(element.key) * 2147483647),
    time: frm.sc.aq,
    flow: fitFor(frm, element).flow,
  };
}

// ---------------------------------------------------------------------------
// Views

interface Span2 {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** The frame's extent in stage units on its own plane, or (with `view`) as it lands on the screen, where frames of different layers can be compared. */
function spanOfFrame(frame: FigureFrame, view: { readonly camera: CameraPose; readonly viewport: Viewport } | null = null): Span2 | null {
  const stage = framePoints(frame);
  const points = view === null ? stage : stage.map((p) => projectToScreen({ x: p.x, y: p.y, z: layerZ(frame.layer, view.viewport) }, view.camera, view.viewport));
  if (points.length === 0) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { x0, x1, y0, y1 };
}

/**
 * The soft shadow of a group that stands on something: an ellipse under its box, in the ink of the surface it stands on, deepened. A group
 * stands on a filled shape (not one of its own parts, not a full-screen ground) whose top meets the group between its head and its foot and which reaches wider
 * than it does. Nothing else casts one: a group floating in air or hung on a wall has no ground to shade.
 */
function contactShadowOf(group: ElementSpan, parts: readonly FigureFrame[], all: readonly FigureFrame[], look: LookSpec, view: { readonly camera: CameraPose; readonly viewport: Viewport }): ShapeFrame | null {
  const own = new Set(parts);
  let box: Span2 | null = null;
  let z = Infinity;
  let opacity = 0;
  let layer: Layer | null = null;
  for (const part of parts) {
    if (part.kind !== 'shape' || part.fill === null || part.bleed) continue;
    const span = spanOfFrame(part);
    if (span === null) continue;
    box = box === null ? span : { x0: Math.min(box.x0, span.x0), x1: Math.max(box.x1, span.x1), y0: Math.min(box.y0, span.y0), y1: Math.max(box.y1, span.y1) };
    z = Math.min(z, part.z);
    opacity = Math.max(opacity, part.opacity);
    layer = part.layer;
  }
  if (box === null || layer === null || opacity <= 0.02) return null;
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  if (width <= 0 || height <= 0) return null;
  // what it stands on is looked for as the viewer sees it: a ground on a far layer is still what a near thing stands on
  const here = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const part of parts) {
    const span = part.kind === 'shape' && part.fill !== null && !part.bleed ? spanOfFrame(part, view) : null;
    if (span === null) continue;
    here.x0 = Math.min(here.x0, span.x0);
    here.x1 = Math.max(here.x1, span.x1);
    here.y0 = Math.min(here.y0, span.y0);
    here.y1 = Math.max(here.y1, span.y1);
  }
  const seenWidth = here.x1 - here.x0;
  const seenHeight = here.y1 - here.y0;
  let surface: Colour | null = null;
  for (const other of all) {
    if (other.kind !== 'shape' || own.has(other) || other.bleed || other.fill === null || other.opacity < 0.5) continue;
    if (LAYER_RANK[other.layer] > LAYER_RANK[layer] || (other.layer === layer && other.z >= z)) continue;
    const span = spanOfFrame(other, view);
    if (span === null) continue;
    const overlap = Math.min(here.x1, span.x1) - Math.max(here.x0, span.x0);
    if (overlap < 0.4 * seenWidth || span.x1 - span.x0 < 0.9 * seenWidth) continue;
    if (span.y0 < here.y0 - 0.1 * seenHeight || span.y0 > here.y1 + 0.08 * seenHeight) continue;
    surface = other.fill.colour;
  }
  if (surface === null) return null;
  const rx = 0.5 * width;
  const ry = Math.max(0.05 * width, 0.04 * height);
  const cx = (box.x0 + box.x1) / 2;
  const cy = box.y1;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    points.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) });
  }
  return {
    kind: 'shape',
    key: `${group.key}/shadow`,
    id: group.id,
    layer,
    z: z - 0.5,
    outline: [{ points, closed: true }],
    geometryKey: `${group.key}|shadow|${rx.toFixed(2)}|${ry.toFixed(2)}`,
    // the ellipse is built about its own centre, so the geometry a renderer keeps stays the same as the group moves
    transform: { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy },
    fill: { colour: castInk(surface, look), to: null, opacity: 0.28 },
    stroke: null,
    opacity: clamp01(opacity),
    bleed: false,
    tappable: false,
    soft: 0.35 * ry + 0.02 * width,
  };
}

function screenBox(points: readonly Pt[], layer: Layer, camera: CameraPose, viewport: Viewport): Box {
  const box = emptyBox();
  const z = layerZ(layer, viewport);
  for (const p of points) growBox(box, projectToScreen({ x: p.x, y: p.y, z }, camera, viewport));
  if (!Number.isFinite(box.minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
}

function framePoints(frame: FigureFrame): Pt[] {
  if (frame.kind === 'shape') {
    const out: Pt[] = [];
    for (const line of frame.outline) for (const p of line.points) out.push(apply(frame.transform, p));
    return out;
  }
  if (frame.kind === 'sprite') {
    const w = (frame.cols * frame.cell) / 2;
    const h = (frame.rows * frame.cell) / 2;
    return [{ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }].map((p) => apply(frame.transform, p));
  }
  const { box } = frame;
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((p) => apply(frame.transform, p));
}

function viewColour(element: ElementSpan, frames: readonly FigureFrame[], fields: readonly FieldFrame[], look: LookSpec): Colour {
  const first = frames[0];
  if (first !== undefined && first.kind === 'shape') return first.stroke?.colour ?? first.fill?.colour ?? look.roles.ink;
  if (first !== undefined && first.kind === 'sprite') return first.cells.find((cell) => cell !== null) ?? look.roles.ink;
  const field = fields.find((candidate) => candidate.key === element.key);
  return field === undefined ? paintColour(element.style.ink, look) : field.colour;
}

/**
 * The drawn elements of a schedule at `time` (turn clock) and `ambient`.
 *
 * - A shape's outline comes from `outlineOf` in the language, moved through
 *   its morphs (both outlines resampled to the same number of points and
 *   blended), and through the look's stroke wobble, which is decided once
 *   from the element's key so a line never shimmers. `geometryKey` changes
 *   only when the points do.
 * - `enter=draw` advances `stroke.progress` over the entrance span; a fill
 *   arrives over its last third. Other entrances and every exit use the
 *   look's motion recipes, as text does.
 * - Place, turn, size and opacity come from the style in force (`styleAt`),
 *   eased across each `set` and `move`; a `move` with `along` follows the
 *   path by length. A part's transform is its group's transform times its
 *   own; a copy emits each of its source's parts again under its own.
 * - A sprite shows the rows that have landed, then cycles its frames at its
 *   `fps` on ambient time.
 * - A picture's `develop` rises over 2.5 s of ambient time from when its
 *   painting could be drawn; with `sketch=fade` the shapes it stands on lose
 *   opacity as it rises.
 * - Loops run on ambient time; reduced motion stills `shake`, `spin` and
 *   `bob` and removes wobble from morphs, and changes no time.
 *
 * Outlines and stroke widths are in canvas units; `transform` takes them to
 * the layer's plane in stage units.
 */
export function figuresAt(schedule: Schedule, base: StageBase, time: number, ambient: number, context: FigureContext): FiguresAt {
  const { look, viewport } = context;
  const sc: Scn = {
    schedule,
    base,
    idx: indexOf(schedule),
    tq: time,
    aq: ambient,
    reduced: context.reducedMotion,
    curve: look.motion.ease,
    rest: false,
    flashAllowed: context.flashAllowed ?? null,
    groups: new Map(),
    fault: context.onFault ?? null,
  };
  const fades = new Map<string, number>();
  for (const picture of schedule.elements) {
    const figure = picture.figure;
    if (figure === null || figure.kind !== 'picture' || figure.sketch !== 'fade' || !isOnStage(picture, time)) continue;
    const own = figure.medium !== null && context.paintings.get(picture.key)?.status !== 'ready';
    const develop = own ? ownDevelopOf(picture, time) : developOf(context.paintings.get(picture.key), ambient);
    if (develop <= 0) continue;
    for (const key of sketchKeysOf(picture, schedule)) fades.set(key, Math.min(fades.get(key) ?? 1, 1 - develop));
  }
  const standing = new Map<string, ElementSpan>();
  for (const picture of schedule.elements) if (picture.figure?.kind === 'picture' && picture.figure.over !== null && isOnStage(picture, time)) standing.set(picture.figure.over, picture);
  const placedAll = placeAll(sc);
  const frm: Frm = { sc, viewport, look, paintings: context.paintings, body: bodySize(viewport, look), fits: new Map(), envs: new Map(), fades, defaultFit: context.fit, lit: shadeIsOn() && look.shade, fixedFit: context.fixedFit ?? null, fitOf: context.fitOf ?? null, standing, open: context.fitOf === undefined ? new Map() : openEdgesOf(placedAll, standing, sc) };

  const figures: FigureFrame[] = [];
  const byOwner = new Map<string, FigureFrame[]>();
  const clips: { at: number; target: string }[] = [];
  for (const item of placedAll) {
    const kind = item.el.figure?.kind;
    let frame: FigureFrame | null = null;
    try {
      frame = kind === 'shape' ? shapeFrame(item, frm) : kind === 'sprite' ? spriteFrame(item, frm) : kind === 'picture' ? pictureFrame(item, frm) : null;
    } catch (error) {
      if (sc.fault === null) throw error;
      sc.fault(error, item.key);
    }
    if (frame === null) continue;
    if (frame.kind === 'shape' && item.trans.to.clip !== null) clips.push({ at: figures.length, target: item.trans.to.clip });
    figures.push(frame);
    const list = byOwner.get(item.owner.key) ?? [];
    list.push(frame);
    byOwner.set(item.owner.key, list);
  }
  // `clip=<id>`: a shape is painted only inside another shape on its layer, as that shape stands now (moved, morphed, drawn on or not).
  for (const { at, target } of clips) {
    const frame = figures[at];
    if (frame === undefined || frame.kind !== 'shape' || frame.bleed) continue;
    const source = figures.find((other): other is ShapeFrame => other.kind === 'shape' && other.id === target && other.key !== frame.key && other.layer === frame.layer && !other.bleed);
    if (source !== undefined) figures[at] = { ...frame, clipTo: { key: source.key, outline: source.outline, geometryKey: source.geometryKey, transform: source.transform } };
  }
  if (frm.lit) for (const element of schedule.elements) {
    if (element.figure?.kind !== 'group' || !isOnStage(element, time)) continue;
    const shadow = contactShadowOf(element, (sc.idx.children.get(element.key) ?? []).flatMap((part) => byOwner.get(part.key) ?? []), figures, look, { camera: context.camera, viewport });
    if (shadow !== null) figures.push(shadow);
  }
  // the renderer's own paintings stand on the figures that are their sketch: it re-renders those, in the medium, into the picture's box
  for (let i = 0; i < figures.length; i += 1) {
    const frame = figures[i];
    if (frame === undefined || frame.kind !== 'picture' || frame.medium === undefined) continue;
    const picture = schedule.elements.find((element) => element.key === frame.key.split('/')[0]);
    if (picture === undefined) continue;
    const roots = sketchKeysOf(picture, schedule);
    figures[i] = { ...frame, sketch: figures.filter((other) => other.kind !== 'picture' && roots.has(other.key.split('/')[0] ?? other.key)).map((other) => other.key) };
  }
  figures.sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || a.z - b.z);

  const fields: FieldFrame[] = [];
  for (const element of schedule.elements) {
    if (element.figure?.kind !== 'field' || !isOnStage(element, time)) continue;
    try {
      const field = fieldFrame(element, frm);
      if (field !== null) fields.push(field);
    } catch (error) {
      if (sc.fault === null) throw error;
      sc.fault(error, element.key);
    }
  }
  fields.sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer]);

  const views: StageElementView[] = [];
  for (const element of schedule.elements) {
    if (element.kind === 'text' || !isOnStage(element, time)) continue;
    const env = envelope(element, frm);
    if (env === null) continue;
    const layer = element.style.layer;
    const figure = element.figure;
    const frames = figure?.kind === 'group' ? (sc.idx.children.get(element.key) ?? []).flatMap((part) => byOwner.get(part.key) ?? []) : (byOwner.get(element.key) ?? []);
    let box: Box;
    if (figure?.kind === 'field') box = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    else if (frames.length > 0) box = screenBox(frames.flatMap(framePoints), layer, context.camera, viewport);
    else {
      const centre = canvasToStage(stateFor(element, sc).centre, fitFor(frm, element), layer, viewport);
      const there = projectToScreen({ x: centre.x, y: centre.y, z: layerZ(layer, viewport) }, context.camera, viewport);
      box = { x: there.x, y: there.y, width: 0, height: 0 };
    }
    const painting = figure?.kind === 'picture' ? frm.paintings.get(element.key) : undefined;
    let status: StageElementView['painting'] = null;
    if (figure?.kind === 'picture') {
      if (painting === undefined || painting.status === 'unpainted') status = 'unpainted';
      else if (painting.status === 'waiting') status = 'waiting';
      else status = developOf(painting, ambient) < 1 ? 'developing' : 'painted';
    }
    const colour = viewColour(element, frames, fields, look);
    const phase: ElementPhase = env.leaving ? 'leaving' : env.entering ? 'entering' : 'on';
    views.push({
      key: element.key,
      id: element.id,
      kind: element.kind,
      text: figure === null ? element.text : describeFigure(figure),
      layer,
      phase,
      box,
      fontPx: 0,
      colour,
      contrast: contrastRatio(colour, look.roles.ground),
      painting: status,
      opacity: clamp01(frames.length === 0 ? env.opacity : Math.max(...frames.map((frame) => frame.opacity))),
      tappable: transition(element, time, sc.curve).to.tap,
    });
  }
  return { figures, fields, views };
}

