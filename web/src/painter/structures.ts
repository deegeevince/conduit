// Structures on stage. A flow, a tree, a cycle, a timeline, a map or a table is laid out by an engine (painter/blocks); this file is what
// the painter does with the answer: it gathers a structure's parts from the schedule, calls the engine once per LAYOUT EPOCH, and turns the
// engine's parts into frames, each part entering, leaving, being restyled, pointed at and tapped as the element that owns it is.
//
// A layout epoch begins when a part ARRIVED (the line was heard, which the painter notes in `arrivals`), not when the playhead reaches it:
// the brain writes seconds ahead of the audience, so most of a diagram is known before its first node is seen and the first node stands
// where it will stay. A later arrival makes a new epoch; what is already on stage eases to its new place over `SETTLE_SECONDS`. Like the
// rest of the timeline this is a pure function of (schedule, arrivals, time): the engine's answers are only remembered, in `LAYOUTS`.

import { styleAt } from '@conduit/language';
import type { ElementSpan, ElementStyle, Polyline, Range, Schedule, Scope, SightNote } from '@conduit/language';
import { EMPTY_STRUCTURE_LAYOUT } from '../contracts/blocks';
import type { BlockLook, BlockPart, MeasuredText, StructureEngine, StructureLayout, TextMeasure, TextSpec } from '../contracts/blocks';
import type { Colour, ElementFrame, RunFrame, ShapeFrame } from '../contracts/frame';
import { IDENTITY } from '../contracts/frame';
import type { LookSpec, MotionRecipe } from '../contracts/look';
import { planeScale } from '../contracts/space';
import type { Box, Viewport } from '../contracts/space';
import { about, clamp01, lerp, mixHex } from './affine';
import type { CanvasFit } from './canvas';
import { contrastRatio, minContrastFor, resolveInk } from './colour';
import { ease } from './ease';
import { paintColour } from './figures';
import { setText } from './layout';
import { cellOf } from './layout/metrics';
import { own } from './own';
import { registerLaidOut } from './registry';
import { STRUCTURES_READY, layoutStructure } from './blocks';
import { modelOf, playingParts, rollKey } from './blocks/tune';
import { drawUi, layoutUi, uiKey } from './ui-stage';

const SETTLE_SECONDS = 0.4;
/** Arrivals closer together than this are one layout: a burst of lines is not a dozen layouts. */
const CLUSTER_SECONDS = 0.25;
const ROW_SECONDS = 0.18;
const FADE: MotionRecipe = { from: { opacity: 0 }, ease: 'out', reveal: false, flicker: false };

export interface StructureEnv {
  readonly viewport: Viewport;
  readonly reducedMotion: boolean;
  /** playhead seconds at which each element (by key), and each row (`<key>#r<i>`), was heard; absent: it was there from the start */
  readonly arrivals: ReadonlyMap<string, number>;
  /** what the controls hold, for `{…}` in a node's words or a chart's cells */
  readonly scope: Scope;
  readonly specAt: (time: number) => LookSpec;
  readonly fitOf: (element: ElementSpan, spec: LookSpec, time: number) => CanvasFit;
  /** v2.1: the room the stage plan gave this structure, reading-plane stage units, as of `time`; null when it has none (a bench's own stage) */
  readonly roomOf: (element: ElementSpan, time: number) => Box | null;
  /** the times at which that room changes: the structure is laid out again from each */
  readonly roomTimes: (element: ElementSpan) => readonly number[];
  /** words that stand in that room, reading-plane stage units: the engines keep clear of them */
  readonly obstaclesOf: (element: ElementSpan, time: number) => readonly Box[];
  /** the times at which the look changes over */
  readonly flips: readonly number[];
  readonly snapAt: (time: number) => number;
  /** a bench's own engine; absent: the painter's, for the kinds it has built */
  readonly engine?: StructureEngine;
}

/** What one structure part is, as the test hook and sight see its owner. */
export interface OwnerState {
  readonly key: string;
  readonly id: string;
  readonly kind: ElementSpan['kind'];
  readonly layer: ElementSpan['style']['layer'];
  /** stage units on the owner's layer plane, camera at rest */
  readonly box: Box;
  readonly opacity: number;
  readonly phase: 'entering' | 'on' | 'leaving';
  readonly colour: string;
  readonly contrast: number;
  readonly tappable: boolean;
  readonly fontPx: number;
}

export interface StructureFrames {
  readonly elements: ElementFrame[];
  readonly figures: ShapeFrame[];
  readonly owners: OwnerState[];
}

/** One owner's parts, to be drawn at one instant. */
export interface OwnerCall {
  /** whose room, layer and way out it shares: itself for a control */
  readonly structure: ElementSpan;
  readonly owner: ElementSpan;
  readonly parts: readonly BlockPart[];
  /** the parts it is easing from, when a layout has just changed */
  readonly before: readonly BlockPart[] | null;
  readonly q: number;
  readonly epochStart: number;
  readonly cut?: Box | null;
  readonly ownerBox: Box | null;
  readonly tq: number;
  readonly aq: number;
  readonly look: LookSpec;
  readonly style: ElementStyle;
}

export interface StructurePlans {
  readonly any: boolean;
  /** draws parts the way a structure's are drawn; what controls are made of */
  renderOwner(call: OwnerCall, out: StructureFrames): void;
  frames(tq: number, aq: number, look: LookSpec, tunes?: ReadonlyMap<string, number | null>): StructureFrames;
  /** what the layout could not keep clear, by element key, as of `time` */
  notesAt(time: number): ReadonlyMap<string, readonly SightNote[]>;
  /** the last moment a layout changed: what the stage is still easing toward after */
  readonly lastChange: number;
}


// Layouts are remembered between rebuilds: a timeline is rebuilt at every line, and an epoch that has not changed is not laid out again.
const LAYOUTS = new Map<string, StructureLayout>();
const KEPT_LAYOUTS = 160;

function remembered(key: string, make: () => StructureLayout): StructureLayout {
  const known = LAYOUTS.get(key);
  if (known !== undefined) {
    LAYOUTS.delete(key);
    LAYOUTS.set(key, known);
    return known;
  }
  const made = make();
  LAYOUTS.set(key, made);
  if (LAYOUTS.size > KEPT_LAYOUTS) LAYOUTS.delete(LAYOUTS.keys().next().value as string);
  return made;
}

interface Epoch {
  readonly start: number;
  readonly look: LookSpec;
  readonly layout: StructureLayout;
  readonly byOwner: ReadonlyMap<string, readonly BlockPart[]>;
  readonly ps: number;
  /** the room the stage plan gave it, plane units; set when the engine said it is crowded: what it draws past it is cut there, never over the words or the choices */
  readonly cut: Box | null;
  /** how many of the structure's rows had arrived: a tune's playhead and lit notes are read from the same score the roll was laid out from */
  readonly rows: number;
}

interface Plan {
  readonly structure: ElementSpan;
  readonly members: readonly ElementSpan[];
  readonly epochs: readonly Epoch[];
}

function textStyleOf(owner: ElementStyle, spec: TextSpec): ElementStyle {
  return { ...owner, size: spec.size, weight: spec.weight, face: spec.face, case: spec.letterCase };
}

/**
 * The moment on the turn's clock that a tune's music begins, as the painter reckons it when nothing is playing it (a still, a film, a draft): when
 * the block is whole, which is when the brain said anything else, and never before its last row has landed. Null for anything that is no tune.
 */
export function tuneStartOf(element: ElementSpan): number | null {
  const figure = element.figure;
  if (figure === null || figure.kind !== 'structure' || figure.structure !== 'tune') return null;
  const last = figure.rows[figure.rows.length - 1]?.at ?? 0;
  return Math.max(element.enter?.start ?? 0, last, figure.sealed ?? last);
}

export function measurerFor(look: LookSpec, viewport: Viewport, ownerStyle: ElementStyle): TextMeasure {
  return (text, spec, maxWidth): MeasuredText => {
    const set = setText({ look, viewport, text, emphasis: [], style: textStyleOf(ownerStyle, spec), shrink: spec.shrink, maxWidth, align: 'left' });
    return { width: set.widest, height: set.lines.length * set.lineHeight, lineHeight: set.lineHeight, lines: set.lines };
  };
}

export function lookOf(look: LookSpec, viewport: Viewport, fit: CanvasFit, ps: number): BlockLook {
  const body = cellOf('m', viewport, look);
  return {
    body: body.height / ps,
    minShrink: 0.7,
    stroke: (look.stroke.thick * fit.unit) / ps,
    radius: look.type.snapToCells ? 0 : (body.height * 0.2) / ps,
    grid: look.type.snapToCells ? { cell: { width: body.width / ps, height: body.height / ps } } : null,
  };
}

/** A shape's outline as a short string: a part that moves or changes (a knob, a track) must not be taken for the one the renderer built before. */
function shapeHash(outline: readonly Polyline[]): string {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let wx = 0;
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const line of outline)
    for (const p of line.points) {
      n += 1;
      sx += p.x;
      sy += p.y;
      wx += (p.x * n - p.y) * (p.y + n);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  return `${n}:${Math.round(sx * 20)}:${Math.round(sy * 20)}:${Math.round(wx)}:${Math.round(x0 * 10)}:${Math.round(x1 * 10)}:${Math.round(y0 * 10)}:${Math.round(y1 * 10)}`;
}

const TEXTS = new Map<string, ReturnType<typeof setText>>();
const KEPT_TEXTS = 900;

/** `setText`, remembered: a structure's words are set once and read every frame, not set again at sixty a second. */
export function setTextOnce(input: Parameters<typeof setText>[0]): ReturnType<typeof setText> {
  const s = input.style;
  const key = [input.look.id, input.look.name, input.viewport.width, input.viewport.height, input.viewport.dpr, input.text, JSON.stringify(input.emphasis), s.size, s.weight, s.face, s.case, s.layer, input.shrink.toFixed(3), input.maxWidth.toFixed(2), input.width?.toFixed(2) ?? '', input.align].join('|');
  const known = TEXTS.get(key);
  if (known !== undefined) return known;
  const made = setText(input);
  TEXTS.set(key, made);
  if (TEXTS.size > KEPT_TEXTS) TEXTS.delete(TEXTS.keys().next().value as string);
  return made;
}

function signature(structure: ElementSpan, members: readonly ElementSpan[], rows: number, scope: Scope): string {
  const figure = structure.figure;
  const head = figure?.kind === 'structure' ? [figure.structure, figure.grow, figure.bars, figure.route, JSON.stringify(figure.box), structure.text, JSON.stringify(figure.rows.slice(0, rows).map((row) => row.cells))] : [];
  const parts = members.map((member) => {
    const f = member.figure;
    const detail = f?.kind === 'node' ? [f.shape, f.values.join(','), f.x, f.y] : f?.kind === 'link' ? [f.from, f.to, f.ends, f.dashed] : [];
    return [member.key, member.text, detail.join('/'), member.style.size, member.style.weight, member.style.face].join('~');
  });
  return JSON.stringify([structure.key, head, parts, JSON.stringify(scope)]);
}

/**
 * What an engine makes of a structure in a room, for the stage plan to learn the room it really needs: whether it had to cut or shrink
 * to fit. The whole structure is laid out (everything the scene will bring), which is the room the plan keeps for it from the first line.
 * Null when there is no engine for it or it fails.
 */
export function probeStructure(structure: ElementSpan, schedule: Schedule, args: { readonly viewport: Viewport; readonly look: LookSpec; readonly fit: CanvasFit; readonly scope: Scope; readonly room: Box; readonly engine?: StructureEngine }): { readonly crowded: boolean; readonly shrink: number } | null {
  const figure = structure.figure;
  if (figure === null || figure.kind !== 'structure' || figure.structure === 'chart') return null;
  const engine = args.engine ?? (STRUCTURES_READY.includes(figure.structure) ? layoutStructure : null);
  if (engine === null) return null;
  const members = schedule.elements.filter((element) => element.parent === structure.key && (element.kind === 'node' || element.kind === 'link'));
  const ps = planeScale(structure.style.layer, args.viewport);
  const room: Box = { x: args.room.x / ps, y: args.room.y / ps, width: args.room.width / ps, height: args.room.height / ps };
  try {
    const made = engine({
      structure,
      nodes: members.filter((member) => member.kind === 'node'),
      links: members.filter((member) => member.kind === 'link'),
      room,
      canvas: { origin: { x: args.fit.box.x / ps, y: args.fit.box.y / ps }, unit: args.fit.unit / ps },
      measure: measurerFor(args.look, args.viewport, structure.style),
      look: lookOf(args.look, args.viewport, args.fit, ps),
      scope: args.scope,
      obstacles: [],
    });
    return { crowded: made.notes.some((n) => n.note === 'crowded'), shrink: made.shrink };
  } catch {
    return null;
  }
}

function planOf(structure: ElementSpan, schedule: Schedule, env: StructureEnv): Plan | null {
  const figure = structure.figure;
  if (figure === null || figure.kind !== 'structure' || figure.structure === 'chart') return null;
  const engine = env.engine ?? (STRUCTURES_READY.includes(figure.structure) ? layoutStructure : null);
  if (engine === null) return null;
  const members = schedule.elements.filter((element) => element.parent === structure.key && (element.kind === 'node' || element.kind === 'link'));
  // What an earlier turn left on stage was heard then and is whole now: it is not waited for again. (Read from the map, a part carried
  // from a turn whose lines came seconds apart left the resting picture, and came back, re-laid, when the next turn began.)
  const carried = new Set<string>(structure.carried ? [structure.key] : []);
  for (const member of members) if (member.carried) carried.add(member.key);
  const arrival = (key: string): number => (carried.has(key) ? 0 : (env.arrivals.get(key) ?? 0));
  const times = new Set<number>([0]);
  for (const member of members) {
    times.add(arrival(member.key));
    if (member.exit !== null) times.add(member.exit.start);
  }
  figure.rows.forEach((_, index) => times.add(arrival(`${structure.key}#r${index}`)));
  times.add(arrival(structure.key));
  for (const flip of env.flips) times.add(flip);
  for (const change of env.roomTimes(structure)) times.add(change);
  // a burst of arrivals is one layout, made when the first of them came
  const sorted = [...times].sort((a, b) => a - b);
  const starts: number[] = [];
  for (const time of sorted) {
    const last = starts[starts.length - 1];
    if (last === undefined || time - last > CLUSTER_SECONDS) starts.push(time);
  }
  const ps = planeScale(structure.style.layer, env.viewport);
  const epochs: Epoch[] = [];
  for (const start of starts) {
    const next = starts[starts.indexOf(start) + 1] ?? Number.POSITIVE_INFINITY;
    const look = env.specAt(start);
    const present = members.filter((member) => {
      // arrived by the end of this cluster, and not gone by its start
      if (arrival(member.key) >= next) return false;
      return member.exit === null || member.exit.start > start;
    });
    let rows = 0;
    while (rows < figure.rows.length && arrival(`${structure.key}#r${rows}`) < next) rows += 1;
    const fit = env.fitOf(structure, look, start);
    const origin = { x: fit.box.x / ps, y: fit.box.y / ps };
    const unit = fit.unit / ps;
    const box = figure.box;
    // a structure with no box of its own takes the room the stage plan gave it; one the brain placed stands where it said, on the canvas
    // (a box on a scene that draws nothing on its canvas is let go by the stage plan, which then gives the structure a room: that room wins)
    const given = env.roomOf(structure, start);
    const room: Box =
      given !== null
        ? { x: given.x / ps, y: given.y / ps, width: given.width / ps, height: given.height / ps }
        : box !== null
          ? { x: origin.x + box.x * unit, y: origin.y + box.y * unit, width: box.w * unit, height: box.h * unit }
          : { x: origin.x, y: origin.y, width: fit.box.width / ps, height: fit.box.height / ps };
    const obstacles = env.obstaclesOf(structure, start).map((o) => ({ x: o.x / ps, y: o.y / ps, width: o.width / ps, height: o.height / ps }));
    const key = [signature(structure, present, rows, env.scope), look.id, look.name, env.viewport.width, env.viewport.height, room.x.toFixed(2), room.y.toFixed(2), room.width.toFixed(2), room.height.toFixed(2), obstacles.map((o) => `${o.x.toFixed(0)},${o.y.toFixed(0)},${o.width.toFixed(0)},${o.height.toFixed(0)}`).join(';'), env.engine === undefined ? 'e' : 'b', figure.structure === 'screen' ? uiKey(structure.key) : '', env.viewport.dpr].join('|');
    const layout = remembered(key, () => {
      const shown: ElementSpan = { ...structure, figure: { ...figure, rows: figure.rows.slice(0, rows) } };
      // v2.2: a mock-up is laid out and drawn by the interface kit, as finished frames
      if (figure.structure === 'screen' && env.engine === undefined) {
        try {
          return layoutUi({ structure: shown, room, spec: look, dpr: env.viewport.dpr });
        } catch {
          return EMPTY_STRUCTURE_LAYOUT;
        }
      }
      try {
        return engine({
          structure: shown,
          nodes: present.filter((member) => member.kind === 'node'),
          links: present.filter((member) => member.kind === 'link'),
          room,
          canvas: { origin, unit },
          measure: measurerFor(look, env.viewport, structure.style),
          look: lookOf(look, env.viewport, fit, ps),
          scope: env.scope,
          obstacles,
        });
      } catch {
        return EMPTY_STRUCTURE_LAYOUT;
      }
    });
    const byOwner = new Map<string, BlockPart[]>();
    for (const part of layout.parts) {
      const list = byOwner.get(part.owner) ?? [];
      list.push(part);
      byOwner.set(part.owner, list);
    }
    const crowded = given !== null && layout.notes.some((n) => n.note === 'crowded');
    const pad = 3;
    epochs.push({ start, look, layout, byOwner, ps, rows, cut: crowded ? { x: room.x - pad, y: room.y - pad, width: room.width + 2 * pad, height: room.height + 2 * pad } : null });
  }
  return { structure, members, epochs };
}

interface Window {
  readonly start: number;
  readonly end: number;
  readonly effect: ElementSpan['style']['enter'];
}

function epochIndex(plan: Plan, time: number): number {
  let index = 0;
  plan.epochs.forEach((epoch, i) => {
    if (epoch.start <= time) index = i;
  });
  return index;
}

function boundsOf(parts: readonly BlockPart[]): Box | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    if (part.kind === 'text') {
      x0 = Math.min(x0, part.box.x);
      y0 = Math.min(y0, part.box.y);
      x1 = Math.max(x1, part.box.x + part.box.width);
      y1 = Math.max(y1, part.box.y + part.box.height);
    } else
      for (const line of part.outline)
        for (const p of line.points) {
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function blendLine(a: Polyline, b: Polyline, t: number): Polyline {
  if (a.points.length !== b.points.length) return t < 0.5 ? a : b;
  return { closed: b.closed, points: b.points.map((p, i) => ({ x: lerp(a.points[i]?.x ?? p.x, p.x, t), y: lerp(a.points[i]?.y ?? p.y, p.y, t) })) };
}

function strongest(look: LookSpec): string {
  let best = look.roles.ink;
  let ratio = 0;
  for (const colour of [look.roles.ink, look.roles.accent, look.roles.alt]) {
    const r = contrastRatio(colour, look.roles.ground);
    if (r > ratio) [ratio, best] = [r, colour];
  }
  return best;
}

export function buildStructures(schedule: Schedule, env: StructureEnv): StructurePlans {
  const plans: Plan[] = [];
  for (const element of schedule.elements) {
    if (element.kind !== 'structure') continue;
    const plan = planOf(element, schedule, env);
    if (plan !== null) plans.push(plan);
  }
  const byKey = new Map<string, Plan>();
  for (const plan of plans) {
    byKey.set(plan.structure.key, plan);
    for (const member of plan.members) byKey.set(member.key, plan);
  }
  const spans = new Map<string, ElementSpan>();
  for (const plan of plans) {
    spans.set(plan.structure.key, plan.structure);
    for (const member of plan.members) spans.set(member.key, member);
  }

  /** Where an owner's boxes are at `time`: its own epoch, and how far across the move from the one before it. */
  const placeOf = (plan: Plan, owner: ElementSpan, time: number): { epoch: Epoch; previous: Epoch | null; q: number } => {
    const frozen = owner.exit === null ? time : Math.min(time, owner.exit.start - 1e-9);
    const index = epochIndex(plan, frozen);
    const epoch = plan.epochs[index] as Epoch;
    const previous = plan.epochs[index - 1] ?? null;
    const q = previous === null || previous.look !== epoch.look ? 1 : clamp01((frozen - epoch.start) / (SETTLE_SECONDS * env.snapAt(epoch.start)));
    return { epoch, previous, q: q >= 1 ? 1 : ease('out', q) };
  };

  const boxIn = (epoch: Epoch, key: string): Box | undefined => epoch.layout.boxes.get(key);
  const boxAtTime = (plan: Plan, owner: ElementSpan, time: number): Box | null => {
    const { epoch, previous, q } = placeOf(plan, owner, time);
    const now = boxIn(epoch, owner.key);
    if (now === undefined) return null;
    const was = previous === null || q >= 1 ? undefined : boxIn(previous, owner.key);
    if (was === undefined) return now;
    return { x: lerp(was.x, now.x, q), y: lerp(was.y, now.y, q), width: lerp(was.width, now.width, q), height: lerp(was.height, now.height, q) };
  };

  registerLaidOut(schedule, {
    boxOf(key, time) {
      const plan = byKey.get(key);
      const owner = spans.get(key);
      if (plan === undefined || owner === undefined) return null;
      const box = boxAtTime(plan, owner, time);
      if (box === null) return null;
      const fit = env.fitOf(owner, env.specAt(time), time);
      const ps = planeScale(owner.style.layer, env.viewport);
      return { x: (box.x * ps - fit.box.x) / fit.unit, y: (box.y * ps - fit.box.y) / fit.unit, w: (box.width * ps) / fit.unit, h: (box.height * ps) / fit.unit };
    },
    routeOf(key, time) {
      const plan = byKey.get(key);
      const owner = spans.get(key);
      if (plan === undefined || owner === undefined) return null;
      const route = placeOf(plan, owner, time).epoch.layout.routes.get(key);
      if (route === undefined) return null;
      const fit = env.fitOf(owner, env.specAt(time), time);
      const ps = planeScale(owner.style.layer, env.viewport);
      return { closed: route.closed, points: route.points.map((p) => ({ x: (p.x * ps - fit.box.x) / fit.unit, y: (p.y * ps - fit.box.y) / fit.unit })) };
    },
  });

  const windowOf = (part: BlockPart, owner: ElementSpan, structure: ElementSpan): { enter: Window | null; leave: ElementSpan['exit'] } => {
    const leave = owner.exit ?? structure.exit;
    // a structure carried from an earlier turn is already whole: its rows landed then
    if (part.row !== undefined && structure.figure?.kind === 'structure' && !structure.carried) {
      const at = structure.figure.rows[part.row]?.at ?? 0;
      const base = structure.enter === null ? 0 : structure.enter.end;
      const start = Math.max(at, base);
      return { enter: { start, end: start + ROW_SECONDS, effect: 'fade' }, leave };
    }
    return { enter: owner.enter === null ? null : { start: owner.enter.start, end: owner.enter.end, effect: owner.enter.effect }, leave };
  };

  /** What one owner's parts look like at `tq`: the whole of how a part enters, leaves, is restyled, pointed at and drawn. Structures and controls both go through it. */
  const renderOwner = (call: OwnerCall, out: StructureFrames): void => {
    const { structure, owner, parts, before, q, epochStart, cut, tq, aq, look, style } = call;
    const clipOf = cut === null || cut === undefined ? {} : { clip: cut };
    const fit = env.fitOf(structure, look, tq);
    const ps = planeScale(structure.style.layer, env.viewport);
    const unit = fit.unit / ps;
    const body = cellOf('m', env.viewport, look).height;
    const reduced = env.reducedMotion;
    const isControl = owner.kind === 'control';
    const hits = owner.changes.filter((change) => change.kind === 'hit' && tq >= change.start && tq < change.end);
    let pulse = 1;
    let shake = 0;
    let flash = 0;
    for (const change of hits) {
      if (change.kind !== 'hit') continue;
      const p = (tq - change.start) / (change.end - change.start);
      const gesture = change.gesture === 'shake' && reduced ? 'flash' : change.gesture;
      if (gesture === 'pulse') pulse = 1 + 0.12 * Math.sin(Math.PI * p);
      else if (gesture === 'flash') flash = Math.sin(Math.PI * p);
      else shake = 0.15 * body * (1 - p) * Math.sin(2 * Math.PI * 4 * p);
    }
    const ownerBox = call.ownerBox ?? boundsOf(parts);
    const centre = ownerBox === null ? { x: 0, y: 0 } : { x: ownerBox.x + ownerBox.width / 2, y: ownerBox.y + ownerBox.height / 2 };
    let minOpacity = 0;
    let phase: OwnerState['phase'] = 'on';
    let ownerColour: string = look.roles.ink;
    let ownerContrast = 21;
    let fontPx = 0;
    let seen = false;
    // a control's markers are inked in, and words set over one are set in the ground's colour, so the pair reads inverted
    const inks: Box[] = [];
    if (isControl) for (const part of parts) if (part.kind === 'shape' && part.role === 'marker') { const b = boundsOf([part]); if (b !== null) inks.push(b); }
    for (const part of parts) {
      // the caret blinks once a second, steady under reduced motion
      if (isControl && part.part === 'caret' && !reduced && Math.floor(aq / 0.5) % 2 === 1) continue;
      const win = windowOf(part, owner, structure);
      const enter = win.enter;
      if (enter !== null && tq < enter.start) continue;
      if (win.leave !== null && tq >= win.leave.end) continue;
      // the envelope of this part: how far it has come in and gone out
      let opacity = 1;
      let dx = 0;
      let dy = 0;
      let scale = 1;
      let draw = 1;
      let fill = 1;
      if (enter !== null && tq < enter.end) {
        phase = 'entering';
        const span = enter.end - enter.start;
        const p = span <= 0 ? 1 : clamp01((tq - enter.start) / span);
        if (enter.effect === 'draw' && part.kind === 'shape' && (part.role === 'line' || part.role === 'frame' || part.role === 'grid')) {
          draw = p;
          fill = clamp01((p - 2 / 3) * 3);
        } else if (enter.effect === 'draw' && part.kind === 'shape' && part.role === 'head') opacity = clamp01((p - 0.8) * 5);
        else {
          let recipe = own<MotionRecipe>(look.motion.enter as Readonly<Record<string, MotionRecipe>>, enter.effect, FADE);
          if (reduced && enter.effect === 'slam') recipe = FADE;
          const e = ease(recipe.ease, p);
          opacity = recipe.reveal ? ease('out', p) : lerp(recipe.from.opacity ?? 1, 1, e);
          dx = lerp((recipe.from.dx ?? 0) * body, 0, e);
          dy = lerp((recipe.from.dy ?? 0) * body, 0, e);
          scale = lerp(recipe.from.scale ?? 1, 1, e);
        }
      }
      if (win.leave !== null && tq >= win.leave.start) {
        phase = 'leaving';
        const recipe = own<MotionRecipe>(look.motion.exit as Readonly<Record<string, MotionRecipe>>, win.leave.effect, FADE);
        const length = win.leave.end - win.leave.start;
        const e = ease(recipe.ease === 'hold' ? 'linear' : recipe.ease, length <= 0 ? 1 : clamp01((tq - win.leave.start) / length));
        opacity *= recipe.reveal ? 1 - e : lerp(1, recipe.from.opacity ?? 1, e);
        dy += lerp(0, (recipe.from.dy ?? 0) * body, e);
        scale *= lerp(1, recipe.from.scale ?? 1, e);
      }
      opacity *= style.opacity;
      if (opacity <= 0.001 && draw <= 0.001) continue;
      seen = true;
      minOpacity = Math.max(minOpacity, opacity);
      const earlier = before?.find((candidate) => candidate.part === part.part && candidate.kind === part.kind);
      const key = part.part === 'words' && part.kind === 'text' ? owner.key : `${owner.key}/${part.part}`;
      const z = owner.order + 0.001;
      const mix = (colour: string): string => (flash > 0 ? mixHex(colour, strongest(look), flash) : colour);
      if (part.kind === 'shape') {
        let outline = part.outline;
        if (earlier !== undefined && earlier.kind === 'shape' && earlier.outline.length === part.outline.length) outline = part.outline.map((line, i) => blendLine((earlier.outline[i] as Polyline), line, q));
        const strokePaint = style.stroke === 'none' ? 'ink' : style.stroke;
        const ring = isControl && part.role === 'bar' && part.part.startsWith('ring');
        const width = ring ? 2 / ps : (style.thick ?? look.stroke.thick) * unit * (part.role === 'grid' ? 0.6 : 1);
        const stroked = part.role === 'frame' || part.role === 'line' || part.role === 'grid' || part.role === 'lit' || ring || (part.role === 'marker' && !isControl);
        const colour = ring ? look.roles.accent : part.role === 'grid' ? look.roles.dim : paintColour(strokePaint, look);
        const filled = part.role === 'fill' || part.role === 'head' || (part.role === 'bar' && !ring) || part.role === 'marker' || part.role === 'note' || part.role === 'note2' || part.role === 'lit';
        const fillColour = part.role === 'note' ? (style.fill !== 'none' && typeof style.fill === 'string' ? paintColour(style.fill, look) : look.roles.accent) : part.role === 'note2' ? look.roles.alt : part.role === 'lit' ? strongest(look) : part.role === 'fill' ? (style.fill !== 'none' && typeof style.fill === 'string' ? paintColour(style.fill, look) : mixHex(look.roles.ground, look.roles.ink, 0.1)) : part.role === 'head' ? colour : part.role === 'bar' ? (style.fill !== 'none' && typeof style.fill === 'string' ? paintColour(style.fill, look) : look.roles.accent) : isControl && part.role === 'marker' ? look.roles.ink : look.roles.accent;
        const transform = pulse === 1 && shake === 0 ? IDENTITY : { ...about(centre, 0, pulse), e: about(centre, 0, pulse).e + shake };
        out.figures.push({
          kind: 'shape',
          key,
          id: owner.id,
          layer: structure.style.layer,
          z,
          outline,
          geometryKey: `${key}|${epochStart}|${q >= 1 ? 'r' : q.toFixed(2)}|${shapeHash(outline)}`,
          transform,
          fill: filled ? { colour: mix(fillColour), to: null, opacity: part.role === 'fill' ? fill * 0.9 : part.role === 'head' ? 1 : fill } : null,
          stroke: stroked ? { colour: mix(colour), width, progress: draw, character: look.stroke.character } : null,
          opacity,
          bleed: false,
          tappable: style.tap,
          ...clipOf,
        });
        ownerColour = colour;
      } else {
        const box = earlier !== undefined && earlier.kind === 'text' ? ({ x: lerp(earlier.box.x, part.box.x, q), y: lerp(earlier.box.y, part.box.y, q), width: lerp(earlier.box.width, part.box.width, q), height: lerp(earlier.box.height, part.box.height, q) } satisfies Box) : part.box;
        const spec: TextSpec = earlier !== undefined && earlier.kind === 'text' ? { ...part.spec, shrink: lerp(earlier.spec.shrink, part.spec.shrink, q) } : part.spec;
        const set = setTextOnce({ look, viewport: env.viewport, text: part.text, emphasis: part.emphasis as readonly Range[], style: { ...textStyleOf(style, spec), layer: structure.style.layer }, shrink: spec.shrink, maxWidth: box.width, width: box.width, align: part.align });
        const px = set.fontSize * ps;
        const role = part.role === 'tick' || part.role === 'value' ? 'dim' : style.ink;
        const minRatio = minContrastFor(px, structure.style.layer);
        const cx0 = box.x + box.width / 2;
        const cy0 = box.y + box.height / 2;
        const overInk = inks.some((b) => cx0 >= b.x && cx0 <= b.x + b.width && cy0 >= b.y && cy0 <= b.y + b.height);
        // what the words stand on: a filled shape under their centre (a node's own ground, a bar). The ink is judged against it as well as the look's grounds,
        // so white words are never set on yellow: the ink is whichever of the look's colours reads best on it.
        let under: Colour | null = null;
        for (let i = out.figures.length - 1; i >= 0 && under === null; i -= 1) {
          const figure = out.figures[i];
          if (figure === undefined || figure.kind !== 'shape' || figure.fill === null || figure.fill.opacity < 0.5 || figure.opacity < 0.5 || !figure.key.startsWith(`${owner.key}/`)) continue;
          let inside = false;
          for (const line of figure.outline) {
            if (!line.closed) continue;
            let x0 = Number.POSITIVE_INFINITY;
            let y0 = Number.POSITIVE_INFINITY;
            let x1 = Number.NEGATIVE_INFINITY;
            let y1 = Number.NEGATIVE_INFINITY;
            for (const point of line.points) {
              x0 = Math.min(x0, point.x);
              y0 = Math.min(y0, point.y);
              x1 = Math.max(x1, point.x);
              y1 = Math.max(y1, point.y);
            }
            if (cx0 >= x0 && cx0 <= x1 && cy0 >= y0 && cy0 <= y1) inside = true;
          }
          if (inside) under = figure.fill.colour;
        }
        const ink = (emphasised: boolean): string => {
          if (overInk) return look.roles.ground;
          const base = mix(resolveInk(role as never, look, { minRatio, weight: spec.weight, emphasised, onBar: false, behind: under }));
          if (under === null || contrastRatio(base, under) >= minRatio) return base;
          // the role's own colour cannot be made to read on it: the look's ink or its ground, whichever has the better ratio
          const dark = resolveInk('ink', look, { minRatio, weight: spec.weight, emphasised, onBar: false, behind: under });
          const light = look.roles.ground;
          return contrastRatio(dark, under) >= contrastRatio(light, under) ? dark : light;
        };
        const place = set.placement;
        const runs: RunFrame[] = place.runs.map((run) => ({ text: run.text, x: run.x, y: run.y, width: run.width, colour: ink(run.emphasised), opacity, dx, dy, scale, reveal: 1 }));
        const cx = box.x + box.width / 2 + shake;
        const cy = box.y + box.height / 2;
        out.elements.push({
          key,
          id: owner.id,
          layer: structure.style.layer,
          z,
          face: spec.face ?? look.type.face,
          x: cx,
          y: cy,
          width: box.width,
          height: place.height,
          fontSize: set.fontSize,
          stretch: place.stretch,
          weight: spec.weight,
          opacity,
          scale: pulse,
          rotation: 0,
          runs,
          lines: place.lines,
          mark: 'none',
          markColour: look.roles.ink,
          strike: 0,
          ghost: false,
          tappable: style.tap,
          plate: part.plate ? 1 : 0,
          ...clipOf,
        });
        ownerColour = runs[0]?.colour ?? look.roles.ink;
        ownerContrast = Math.min(ownerContrast, contrastRatio(ownerColour, look.roles.ground));
        fontPx = Math.max(fontPx, px);
      }
    }
    if (!seen || ownerBox === null) return;
    out.owners.push({ key: owner.key, id: owner.id, kind: owner.kind, layer: structure.style.layer, box: ownerBox, opacity: minOpacity, phase, colour: ownerColour, contrast: ownerContrast, tappable: style.tap, fontPx });
  };

  const frames = (tq: number, aq: number, look: LookSpec, tunes?: ReadonlyMap<string, number | null>): StructureFrames => {
    const out: StructureFrames = { elements: [], figures: [], owners: [] };
    for (const plan of plans) {
      const structure = plan.structure;
      const everyone = [structure, ...plan.members];
      for (const owner of everyone) {
        const { epoch, previous, q } = placeOf(plan, owner, tq);
        // v2.2: a mock-up draws itself, a row at a time
        if (owner === structure && epoch.layout.drawn !== undefined) {
          const drawn = drawUi({ structure, drawn: epoch.layout.drawn, before: previous?.layout.drawn ?? null, q, tq, out });
          const box = epoch.layout.boxes.get(structure.key);
          if (drawn.drawn && box !== undefined) out.owners.push({ key: structure.key, id: structure.id, kind: structure.kind, layer: structure.style.layer, box, opacity: 1, phase: drawn.phase, colour: look.roles.ink, contrast: 21, tappable: false, fontPx: epoch.layout.drawn.fontPx * planeScale(structure.style.layer, env.viewport) });
          continue;
        }
        let parts = epoch.byOwner.get(owner.key) ?? [];
        // A tune that sounds has a playhead and lit notes, drawn against the roll this epoch laid out.
        if (owner === structure && structure.figure?.kind === 'structure' && structure.figure.structure === 'tune') {
          const position = tunes?.get(structure.key) ?? null;
          const roll = epoch.layout.boxes.get(rollKey(structure.key));
          if (position !== null && roll !== undefined) parts = [...parts, ...playingParts(structure.key, modelOf(structure, epoch.rows), roll, position, env.reducedMotion)];
        }
        if (parts.length === 0) continue;
        const before = previous === null || q >= 1 ? null : (previous.byOwner.get(owner.key) ?? null);
        renderOwner({ structure, owner, parts, before, q, epochStart: epoch.start, cut: epoch.cut, ownerBox: boxAtTime(plan, owner, tq), tq, aq, look, style: styleAt(owner, tq) }, out);
      }
    }
    return out;
  };

  const notesAt = (time: number): ReadonlyMap<string, readonly SightNote[]> => {
    const out = new Map<string, SightNote[]>();
    for (const plan of plans) {
      const epoch = plan.epochs[epochIndex(plan, time)];
      for (const { key, note } of epoch?.layout.notes ?? []) {
        const list = out.get(key) ?? [];
        if (!list.includes(note)) list.push(note);
        out.set(key, list);
      }
    }
    return out;
  };

  let lastChange = 0;
  for (const plan of plans) for (const epoch of plan.epochs) lastChange = Math.max(lastChange, epoch.start);
  return { any: plans.length > 0, renderOwner, frames, notesAt, lastChange };
}
