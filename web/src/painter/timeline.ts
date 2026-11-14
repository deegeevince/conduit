import { describeFigure, outlineOf, ENTER_SECONDS, exitSeconds, isInFlow, isStruckAt, lookOfStage, PACE_TIMING, sceneAt, styleAt, valueAt } from '@conduit/language';
import type { SightNote, ClockState, ElementChange, ElementSpan, ElementStyle, ExitEffect, Layer, LookId, Mood, ResolvedLook, SceneSpan, Schedule, StageBase } from '@conduit/language';
import type { CameraSpan } from '@conduit/language';
import type { Colour, ElementFrame, FigureFrame, Frame, RunFrame, ShapeFrame } from '../contracts/frame';
import type { LookSpec, MotionRecipe, MoodCharacter } from '../contracts/look';
import type { ElementPhase, StageElementView } from '../contracts/painter';
import { layerZ, MAX_DOLLY, planeScale, projectToScreen, restDistance } from '../contracts/space';
import type { Box, CameraPose, Viewport } from '../contracts/space';
import type { ControlMood } from '../contracts/controls';
import type { ControlValue } from '@conduit/language';
import { LOOKS, specFor } from '../looks';
import type { StructureEngine } from '../contracts/blocks';
import { chartFrames } from './charts';
import type { ChartData } from './charts';
import { createControlStore, compileTemplate, renderTemplate, scopeOf } from './controls';
import type { Template } from './controls';
import { boundElement, boundSchedule, controlIndexOf, createRuntime, heldBy, moodOf, controlSpecOf } from './bound';
import type { BoundWords, ControlRuntime } from './bound';
import { controlInputOf, controlLayoutOf, placeParts } from './controls-stage';
import type { ControlSite } from './controls-stage';
import { layoutCard } from './controls';
import type { ControlLayout } from '../contracts/controls';
import { lookOf, measurerFor } from './structures';
import { CALM } from '../contracts/controls';
import { registerLaidOut, laidOutOf } from './registry';
import { buildStructures, setTextOnce, structureExtent } from './structures';
import { CALLOUTS_READY, layoutCallouts } from './blocks';
import type { CalloutInput } from '../contracts/blocks';
import type { StructureFrames } from './structures';
import { cameraAt } from './camera';
import { canvasToStage, fitCanvas } from './canvas';
import type { CanvasFit } from './canvas';
import { contrastRatio, mapToGamut, minContrastFor, plateFor, resolveInk, spriteBacking } from './colour';
import { ease, quantise } from './ease';
import { canvasBoxOf, figuresAt, groupMatrixAt, spriteColours } from './figures';
import type { Painting } from './figures';
import { revealShare } from '../fonts/measure';
import { arrange } from './layout';
import { has, own as lookup } from './own';
import { placeLabel } from './layout/labels';
import type { Arrangement, LayoutItem, Placement, PlacedRun } from './layout';
import { bodySize, cellOf, marginOf, safeFrame, topInset } from './layout/metrics';

export interface TimelineContext {
  readonly viewport: Viewport;
  readonly reducedMotion: boolean;
  readonly lockLook: LookId | null;
  /** what is known of each painting, by element key. Read at every frame: the painter keeps it up to date and a film is given it whole. */
  readonly paintings: ReadonlyMap<string, Painting>;
  /** told of anything that threw while a frame was made; the element that threw is left out of that frame. Without it the error is thrown. */
  readonly onFault?: (error: unknown, where: string) => void;
  /** playhead seconds at which each element (and each row, `<key>#r<i>`) was heard; what a structure's layout epochs begin at. Absent: all at the start. */
  readonly arrivals?: ReadonlyMap<string, number>;
  /** a stand-in structure engine, for a bench; absent: the painter's own */
  readonly engine?: StructureEngine;
  /** what the user's hand holds: control values, moods, how far bound changes have eased. Read at every frame. Absent: nothing is held and every control shows what was written. */
  readonly controls?: ControlRuntime;
  /** the charting engine this stage has, and the DATA that has come for it (live); absent: the stage has no charts and draws none */
  readonly charts?: { readonly kinds: readonly string[]; readonly data: ReadonlyMap<string, ChartData> };
}

export interface TimelineInstant {
  readonly time: number;
  readonly ambient: number;
  readonly wallTime: number;
  readonly clock: ClockState;
  /**
   * Ambient seconds at which the current wait or hold began, when the clock is
   * waiting or holding. The waiting cursor blinks from this moment, so it is
   * lit the instant the hold starts. Without it the blink keeps ambient phase.
   */
  readonly holdSince?: number;
}

/**
 * A turn's schedule joined with space: for any time, the complete Frame.
 * It is a pure function of time. Nothing in it is advanced, mutated or
 * remembered between calls, so the playhead can be moved anywhere and the
 * picture is always the one that belongs to that time.
 */
export interface Timeline {
  readonly schedule: Schedule;
  readonly viewport: Viewport;
  readonly paintings: ReadonlyMap<string, Painting>;
  /** the look worn at `time`, as the frame at that time would be drawn in */
  specAt(time: number): LookSpec;
  frameAt(instant: TimelineInstant): Frame;
  /** the same instant as the test hook and the HUD see it */
  viewsAt(instant: TimelineInstant): StageElementView[];
  /** keys of elements whose entrance has begun by `time` and that have not left */
  onStageAt(time: number): string[];
  /** elements the painter retired early because the scene could not hold them, with the moment each began to leave. The schedule does not know these. */
  readonly retired: ReadonlyMap<string, number>;
  /** the last moment a structure's layout changed: the stage is still easing toward it for a moment after */
  readonly lastLayoutChange: number;
  /** what a structure's layout could not keep clear (`crowded`, `crossed`, `clipped`), by element key, as of `time` */
  layoutNotesAt(time: number): ReadonlyMap<string, readonly SightNote[]>;
  /** the controls on stage at this instant: where each is, what it holds, which parts the pointer can work */
  controlsAt(instant: TimelineInstant): ControlSite[];
  /** true when a structure or a chart reads a control's value: the timeline is then stale as soon as a control changes */
  readonly reactive: boolean;
}

/** Seconds a laid-out element takes to approach a new place, before the mood scales it. */
const SETTLE_SECONDS = 0.4;
const MOOD_SECONDS = 0.6;
const REDUCED_FADE_SECONDS = 0.2;
const FLICKER_SLOT = 0.36;
/** The flash governor: nothing lights up or goes dark more than three times a second. */
const FLASH_FLOOR_SECONDS = 0.34;
/** An element whose box covers more than this share of the viewport is "large" for the governor. */
const LARGE_SHARE = 0.05;
const LAYER_ORDER: Readonly<Record<Layer, number>> = { far: -1, bg: 0, mid: 1, fg: 2 };
const FADE_RECIPE: MotionRecipe = { from: { opacity: 0 }, ease: 'out', reveal: false, flicker: false };

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function parseHex(colour: string): [number, number, number] {
  const n = Number.parseInt(colour.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  if (t <= 0 || a === b) return a;
  if (t >= 1) return b;
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const channel = (x: number, y: number): string => Math.round(lerp(x, y, t)).toString(16).padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

/** A placement as it is drawn between two arrangements. */
interface Pose {
  readonly layer: Layer;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly stretch: number;
  readonly runs: readonly PlacedRun[];
  readonly lines: readonly Box[];
  readonly bullet: PlacedRun | null;
  /** extra scale that hides a change of size while the element settles */
  readonly comp: number;
}

function poseOf(placement: Placement): Pose {
  return { ...placement, comp: 1 };
}

function lerpRun(a: PlacedRun, b: PlacedRun, t: number): PlacedRun {
  return { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), width: lerp(a.width, b.width, t) };
}

function sameStructure(a: Pose, b: Placement): boolean {
  if (a.layer !== b.layer || a.runs.length !== b.runs.length || a.lines.length !== b.lines.length) return false;
  if ((a.bullet === null) !== (b.bullet === null)) return false;
  return a.runs.every((run, i) => run.text === b.runs[i]?.text);
}

function blendPose(a: Pose, b: Placement, t: number, scaleLimit: (pose: Pose) => number): Pose {
  if (a.layer !== b.layer) return poseOf(b);
  if (!sameStructure(a, b)) {
    const moved: Pose = { ...poseOf(b), x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    // The new wrap is drawn at the old size and shrinks into place; it may not grow past the safe frame on the way.
    const wanted = lerp((a.fontSize * a.comp) / b.fontSize, 1, t);
    return { ...moved, comp: wanted > 1 ? Math.min(wanted, Math.max(1, scaleLimit(moved))) : wanted };
  }
  return {
    layer: b.layer,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
    fontSize: lerp(a.fontSize, b.fontSize, t),
    stretch: lerp(a.stretch, b.stretch, t),
    runs: b.runs.map((run, i) => {
      const from = a.runs[i];
      return from === undefined ? run : lerpRun(from, run, t);
    }),
    lines: b.lines.map((line, i) => {
      const from = a.lines[i];
      return from === undefined
        ? line
        : { x: lerp(from.x, line.x, t), y: lerp(from.y, line.y, t), width: lerp(from.width, line.width, t), height: lerp(from.height, line.height, t) };
    }),
    bullet: b.bullet === null || a.bullet === null ? b.bullet : lerpRun(a.bullet, b.bullet, t),
    comp: lerp(a.comp, 1, t),
  };
}

/** The worst contrast any visible run of an element has against what is behind it: the ground, or the colour of what is drawn under it. */
function judge(frame: ElementFrame, look: LookSpec, backdrop: Colour | readonly Colour[] | null): { worst: number; colour: string; visible: number } {
  const onBar = frame.mark === 'invert';
  const backdrops: readonly Colour[] = backdrop === null ? [] : typeof backdrop === 'string' ? [backdrop] : backdrop;
  let worst = Number.POSITIVE_INFINITY;
  let colour = look.roles.ink;
  let visible = 0;
  for (const run of frame.runs) {
    visible = Math.max(visible, run.opacity);
    // The ink as it lands on the ground: opacity included, against the worse of the grounds.
    const alpha = clamp01(run.opacity * frame.opacity);
    if (alpha <= 0) continue;
    let ratio: number;
    if (onBar) ratio = contrastRatio(mixHex(frame.markColour, run.colour, alpha), frame.markColour);
    else if (backdrops.length > 0) ratio = Math.min(...backdrops.map((under) => contrastRatio(mixHex(under, run.colour, alpha), under)));
    else
      ratio = Math.min(
        contrastRatio(mixHex(look.roles.ground, run.colour, alpha), look.roles.ground),
        look.groundAlt === null ? Number.POSITIVE_INFINITY : contrastRatio(mixHex(look.groundAlt, run.colour, alpha), look.groundAlt),
      );
    if (ratio < worst) {
      worst = ratio;
      colour = run.colour;
    }
  }
  return { worst, colour, visible };
}

interface Epoch {
  readonly start: number;
  readonly look: LookSpec;
  readonly snap: number;
  readonly arrangement: Arrangement;
}

interface Forced {
  readonly start: number;
  readonly end: number;
  readonly effect: ExitEffect;
}

interface RunState {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  reveal: number;
}

interface Evaluated {
  readonly frame: ElementFrame;
  readonly view: StageElementView;
  /** present while the element is being typed: where the cursor goes */
  readonly typing: { readonly layer: Layer; readonly cursor: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly start: number } | null;
}

/** Which column each undecided in-flow line of a split scene belongs to, balanced over every line the scene ever holds, so retiring the oldest never moves a line across. */
function splitSides(schedule: Schedule, sceneId: string): ReadonlyMap<string, 'left' | 'right'> {
  const sides = new Map<string, 'left' | 'right'>();
  let left = 0;
  let right = 0;
  const lines = schedule.elements.filter((element) => element.scene === sceneId && element.kind === 'text' && element.replaces === null).sort((a, b) => a.order - b.order);
  for (const element of lines) {
    const style = styleAt(element, element.enter?.start ?? 0);
    if (!isInFlow(style, 'split') || style.at === 'left' || style.at === 'right') {
      if (style.at === 'left') left += 1;
      else if (style.at === 'right') right += 1;
      continue;
    }
    if (left <= right) {
      sides.set(element.key, 'left');
      left += 1;
    } else {
      sides.set(element.key, 'right');
      right += 1;
    }
  }
  for (const element of schedule.elements) {
    if (element.scene !== sceneId || element.replaces === null) continue;
    const side = sides.get(element.replaces);
    if (side !== undefined) sides.set(element.key, side);
  }
  return sides;
}

export function buildTimeline(schedule: Schedule, base: StageBase, context: TimelineContext): Timeline {
  const { viewport, reducedMotion, lockLook, paintings, onFault } = context;
  const runtime: ControlRuntime = context.controls ?? createRuntime(createControlStore());
  const cindex = controlIndexOf(schedule);
  const controlSpans = schedule.elements.filter((element) => element.kind === 'control');
  const templates = new Map<string, Template>();
  const templateOf = (element: ElementSpan): Template => {
    let found = templates.get(element.key);
    if (found === undefined) {
      found = compileTemplate(element.text, (id) => cindex.ids.has(id));
      templates.set(element.key, found);
    }
    return found;
  };
  /** the control a `{name}` means: the latest one of that id that has come on stage by `time` */
  const controlNamed = (id: string, time: number): { readonly spec: NonNullable<ReturnType<typeof controlSpecOf>>; readonly value: import('@conduit/language').ControlValue | null } | null => {
    let found: ElementSpan | null = null;
    for (const span of controlSpans) if (span.id === id && (span.carried || (span.enter !== null && span.enter.start <= time)) && (span.exit === null || time < span.exit.end)) found = span;
    const spec = found === null ? null : controlSpecOf(found);
    return found === null || spec === null ? null : { spec, value: heldBy(runtime, found) };
  };
  /** the words of an element as the hand has them now: `{…}` worked out, or a bound `text` change */
  const wordsNow = (element: ElementSpan, bound: BoundWords | null, time: number): BoundWords | null => {
    if (bound !== null) return bound;
    const template = templateOf(element);
    if (!template.reactive) return null;
    return renderTemplate(template, element.text, element.emphasis, (id) => controlNamed(id, time));
  };
  // Words are laid out here; everything drawn is placed by painter/figures.ts.
  const elements = schedule.elements.filter((element) => element.kind === 'text');
  const byKey = new Map<string, ElementSpan>();
  for (const element of elements) byKey.set(element.key, element);
  const drawn = schedule.elements.filter((element) => element.kind !== 'text');
  const drawnByKey = new Map<string, ElementSpan>();
  for (const element of drawn) drawnByKey.set(element.key, element);

  // The looks this timeline can wear, as specs. A look the brain defined is a spec like any other.
  // A line that replaces another in the same slot (caption, solo, a re-said line) does not show until the one it replaces has all but gone,
  // so the two are never both readable in one place.
  const GATE_SECONDS = 0.04;
  const replacedUntil = new Map<string, number>();
  for (const element of elements) {
    const enter = element.enter;
    if (enter === null) continue;
    let until = Number.NEGATIVE_INFINITY;
    for (const other of elements) {
      const exit = other.exit;
      if (other === element || exit === null || (exit.cause !== 'solo' && exit.cause !== 'resay') || other.scene !== element.scene) continue;
      if (exit.start <= enter.end && exit.end > enter.start && exit.start >= enter.start - 5) until = Math.max(until, exit.end);
    }
    if (Number.isFinite(until)) replacedUntil.set(element.key, until);
  }
  const specOfResolved = new Map<ResolvedLook, LookSpec>();
  const specOf = (resolved: ResolvedLook): LookSpec => {
    let found = specOfResolved.get(resolved);
    if (found === undefined) {
      found = specFor(resolved);
      specOfResolved.set(resolved, found);
    }
    return found;
  };
  const lockedSpec = lockLook === null ? null : LOOKS[lockLook];
  const startSpec = lockedSpec ?? specOf(lookOfStage(base));
  /** the spec that takes over at the middle of each look change, in order */
  const flips = lockedSpec !== null ? [] : schedule.looks.map((span) => ({ at: (span.start + span.end) / 2, spec: specOf(span.wearing) }));
  const allSpecs: LookSpec[] = [startSpec, ...flips.map((flip) => flip.spec)];
  const specIds = new Map<LookSpec, number>();
  for (const spec of allSpecs) if (!specIds.has(spec)) specIds.set(spec, specIds.size);
  const specAt = (time: number): LookSpec => {
    let found = startSpec;
    for (const flip of flips) if (time >= flip.at) found = flip.spec;
    return found;
  };

  /** The edge the camera keeps text from: 16 px, and the sway that rides on every move. */
  const edge = 16 + viewport.height * 0.006;
  /**
   * The edge the camera keeps element boxes from: 16 px, and the sway of the moods in play. A box is what the snapshot reports (the whole
   * column for in-flow text, which can be wider than its lines); the lines keep the larger `edge` since they carry the glyphs.
   */
  const boxEdge = Math.min(
    edge,
    16 + viewport.height * Math.max(0, ...allSpecs.flatMap((spec) => Object.values(spec.mood).map((m) => m.sway))),
  );
  /** The same at the top, where a look may keep rows for its own furniture (the teletext header): the deepest any look in this timeline reaches. */
  const topEdge = Math.max(
    edge,
    viewport.height * 0.006 + Math.max(...allSpecs.map((spec) => topInset(viewport, spec))),
  );

  interface Spread {
    readonly layer: Layer;
    readonly x: number;
    readonly y: number;
    readonly lines: readonly Box[];
  }

  /** How far an element on a layer may still travel on each axis, in that plane's units, before its lines are 16 px from the edge with the camera at rest. */
  const slackOf = (spread: Spread): { x: number; y: number } => {
    const scale = planeScale(spread.layer, viewport);
    const halfW = (viewport.width / 2 - edge) / scale;
    const halfH = (viewport.height / 2 - edge) / scale;
    const halfTop = (viewport.height / 2 - topEdge) / scale;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const line of spread.lines) {
      left = Math.min(left, spread.x + line.x);
      right = Math.max(right, spread.x + line.x + line.width);
      top = Math.min(top, spread.y + line.y);
      bottom = Math.max(bottom, spread.y + line.y + line.height);
    }
    if (!Number.isFinite(left)) return { x: halfW, y: Math.min(halfH, halfTop) };
    return { x: Math.max(0, Math.min(halfW - right, halfW + left)), y: Math.max(0, Math.min(halfH - bottom, halfTop + top)) };
  };

  /** The largest scale an element may be drawn at about its centre and stay inside the safe frame (4% short of it: the camera may already be dollied in on a resting line). */
  const scaleLimit = (spread: Spread): number => {
    const scale = planeScale(spread.layer, viewport);
    const halfW = ((viewport.width / 2 - edge) * 0.96) / scale;
    const halfH = ((viewport.height / 2 - topEdge) * 0.96) / scale;
    let reachX = 0;
    let reachY = 0;
    for (const line of spread.lines) {
      reachX = Math.max(reachX, Math.abs(line.x), Math.abs(line.x + line.width));
      reachY = Math.max(reachY, Math.abs(line.y), Math.abs(line.y + line.height));
    }
    return Math.min(reachX > 0 ? (halfW - Math.abs(spread.x)) / reachX : Number.POSITIVE_INFINITY, reachY > 0 ? (halfH - Math.abs(spread.y)) / reachY : Number.POSITIVE_INFINITY);
  };

  /**
   * The share (0 to 1) of a wander of `ax` by `ay` that keeps a drifting
   * element clear of every box in the flow of the text, in the drifter's own
   * plane (the boxes are scaled across from the reading plane). A box is only
   * a danger if the wander can close the gap on both axes at once.
   */
  const driftClearance = (key: string, spread: Spread, time: number, ax: number, ay: number): number => {
    const arrangement = epochs[epochIndexAt(time)]?.arrangement;
    let share = 1;
    if (arrangement === undefined || spread.lines.length === 0 || ax <= 0 || ay <= 0) return share;
    const across = planeScale('mid', viewport) / planeScale(spread.layer, viewport);
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const line of spread.lines) {
      left = Math.min(left, spread.x + line.x);
      right = Math.max(right, spread.x + line.x + line.width);
      top = Math.min(top, spread.y + line.y);
      bottom = Math.max(bottom, spread.y + line.y + line.height);
    }
    for (const [otherKey, other] of arrangement.placements) {
      if (otherKey === key || other.layer !== 'mid') continue;
      for (const line of other.lines) {
        const l = (other.x + line.x) * across;
        const r = (other.x + line.x + line.width) * across;
        const t = (other.y + line.y) * across;
        const b = (other.y + line.y + line.height) * across;
        const gapX = Math.max(0, l - right, left - r);
        const gapY = Math.max(0, t - bottom, top - b);
        // Keep 2 px clear: the wander must stay short of the gap on at least one axis.
        share = Math.min(share, Math.max(Math.max(0, gapX - 2) / ax, Math.max(0, gapY - 2) / ay));
      }
    }
    return Math.min(1, share);
  };

  const loopsDrift = (element: ElementSpan): boolean => element.style.loop === 'drift' || element.changes.some((change) => change.kind === 'set' && change.props.loop === 'drift');
  const hitsShake = (element: ElementSpan): boolean => element.changes.some((change) => change.kind === 'hit' && change.gesture === 'shake');


  const moods: { at: number; value: Mood }[] = [];
  for (const scene of schedule.scenes) for (const item of scene.mood) moods.push({ at: item.at, value: item.value });
  moods.sort((a, b) => a.at - b.at);

  /** The mood leaving, the mood arriving and how far across the change we are. */
  const moodPair = (time: number, look: LookSpec): { from: MoodCharacter | null; to: MoodCharacter; t: number } => {
    let index = -1;
    moods.forEach((item, i) => {
      if (item.at <= time) index = i;
    });
    const current = moods[index];
    if (current === undefined) return { from: null, to: look.mood[base.scene.mood], t: 1 };
    const previous = moods[index - 1];
    const to = look.mood[current.value];
    if (previous === undefined) return { from: null, to, t: 1 };
    return { from: look.mood[previous.value], to, t: clamp01((time - current.at) / MOOD_SECONDS) };
  };

  const partsOf = (pair: { from: MoodCharacter | null; to: MoodCharacter; t: number }, weight: number): { mood: MoodCharacter; weight: number }[] =>
    pair.from === null || pair.t >= 1
      ? [{ mood: pair.to, weight }]
      : [
          { mood: pair.from, weight: weight * (1 - pair.t) },
          { mood: pair.to, weight: weight * pair.t },
        ];

  /** When each look takes over (the middle of its retune), oldest first. */
  const lookFlips = lockLook !== null ? [] : schedule.looks.map((span) => (span.start + span.end) / 2).sort((a, b) => a - b);

  /** The sway the camera carries: the mood blend, and across a look change the old look's character fading into the new one's. */
  const swayPartsAt = (time: number, look: LookSpec, pair: { from: MoodCharacter | null; to: MoodCharacter; t: number }): { mood: MoodCharacter; weight: number }[] => {
    let flip: number | null = null;
    for (const at of lookFlips) if (at <= time) flip = at;
    if (flip === null || time - flip >= MOOD_SECONDS) return partsOf(pair, 1);
    const earlier = specAt(flip - 1e-6);
    if (earlier === look) return partsOf(pair, 1);
    const w = clamp01((time - flip) / MOOD_SECONDS);
    return [...partsOf(moodPair(time, earlier), 1 - w), ...partsOf(pair, w)];
  };

  const moodAt = (time: number, look: LookSpec): MoodCharacter => {
    const { from, to, t } = moodPair(time, look);
    if (from === null || t >= 1) return to;
    const mix = (a: number, b: number): number => lerp(a, b, t);
    return {
      agitation: mix(from.agitation, to.agitation),
      dim: mix(from.dim, to.dim),
      sway: mix(from.sway, to.sway),
      swayPeriod: mix(from.swayPeriod, to.swayPeriod),
      lean: mix(from.lean, to.lean),
      snap: mix(from.snap, to.snap),
    };
  };

  const paceAt = (time: number): keyof typeof PACE_TIMING => {
    const scene = sceneAt(schedule, time);
    return valueAt(scene.pace, time, base.scene.pace);
  };

  // Layout epochs ----------------------------------------------------------
  const boundaries: number[] = [0];
  for (const scene of schedule.scenes) {
    boundaries.push(scene.start);
    for (const item of scene.expected) boundaries.push(item.at);
  }
  for (const element of [...elements, ...controlSpans]) {
    if (element.enter !== null) boundaries.push(element.enter.start);
    if (element.exit !== null) boundaries.push(element.exit.start);
    for (const change of element.changes) {
      if (change.kind !== 'set') continue;
      const p = change.props;
      if (p.size !== undefined || p.layer !== undefined || p.at !== undefined || p.case !== undefined || p.mark !== undefined) boundaries.push(change.start);
    }
  }
  if (lockLook === null) for (const span of schedule.looks) boundaries.push((span.start + span.end) / 2);
  boundaries.sort((a, b) => a - b);
  const starts = boundaries.filter((time, i) => time >= 0 && (i === 0 || time - (boundaries[i - 1] ?? 0) > 1e-9));

  const forced = new Map<string, Forced>();
  const wordsOfScene = new Map<string, Box[]>();
  const epochs: Epoch[] = [];

  const exitOf = (element: ElementSpan): { start: number; end: number; effect: ExitEffect } | null => {
    const own = element.exit;
    const extra = forced.get(element.key);
    if (extra === undefined) return own;
    if (own === null || extra.start < own.start) return extra;
    return own;
  };

  /**
   * Words that a point of the canvas or a thing drawn decides the place of are not in the flow, and the layout must not stack them there:
   * it is told they are anchored at the centre, and `placeLoose` puts them where they belong each frame.
   */
  const laidStyle = (style: ElementStyle): ElementStyle => (style.near !== null || style.group !== null || (typeof style.at === 'object' && style.at !== null) ? { ...style, at: 'center', near: null } : style);

  /** the widest a control may be, in its layer's plane units: the room the flow has across */
  const controlRoom = (span: ElementSpan, fit: CanvasFit): number => fit.flow.width / planeScale(span.style.layer, viewport);

  /** a card with no place of its own stands in the flow */
  function cardIsInFlow(style: ElementStyle): boolean {
    return style.near === null && style.group === null && !(typeof style.at === 'object' && style.at !== null);
  }
  /**
   * The column of controls inside a card and the frame round it, measured with the card at the origin: `inner` is where the column
   * goes relative to the card's own centre, `outer` the frame. The same arithmetic draws the card and reserves its room in the flow.
   */
  function cardRoom(group: ElementSpan, tq: number, look: LookSpec, fit: CanvasFit) {
    if (group.figure?.kind !== 'group' || group.figure.card === undefined) return null;
    const ps = planeScale(group.style.layer, viewport);
    const gap = cellOf('m', viewport, look).height / ps / 4;
    let width = 0;
    let height = -gap;
    let count = 0;
    for (const member of controlSpans) {
      if (member.parent !== group.key || (!member.carried && (member.enter === null || member.enter.start > tq))) continue;
      const gone = exitOf(member);
      if (gone !== null && gone.start <= tq) continue;
      const spec = controlSpecOf(member);
      const layout = spec === null ? null : controlLayoutOf({ span: member, value: spec.value, mood: CALM, maxWidth: (fit.flow.width * 0.8) / ps, look, viewport, fit });
      if (layout === null) continue;
      width = Math.max(width, layout.width);
      height += layout.height + gap;
      count += 1;
    }
    if (count === 0) return null;
    const inner: Box = { x: -width / 2, y: -height / 2, width, height };
    const card = layoutCard({ owner: group.key, title: group.figure.card.title, inner, measure: measurerFor(look, viewport, group.style), look: lookOf(look, viewport, fit, ps) });
    return { inner, outer: card.outer };
  }

  for (const start of starts) {
    const look = specAt(start);
    const scene = sceneAt(schedule, start);
    const present = elements.filter((element) => {
      if (!element.carried && (element.enter === null || element.enter.start > start)) return false;
      const exit = exitOf(element);
      return exit === null || exit.start > start;
    });
    const replaced = new Set<string>();
    for (const element of present) if (element.replaces !== null) replaced.add(element.replaces);
    const sceneFit = fitCanvas(scene.canvas, scene.layout, viewport, look);
    const items: LayoutItem[] = present.map((element) => {
      const template = templateOf(element);
      const words = template.reactive ? renderTemplate(template, element.text, element.emphasis, (id) => controlNamed(id, start)) : null;
      return {
        key: element.key,
        order: element.order,
        text: words === null ? element.text : words.text,
        emphasis: words === null ? element.emphasis : words.emphasis,
        style: laidStyle(styleAt(element, start)),
        struck: isStruckAt(element, start) && replaced.has(element.key),
        replaces: element.replaces,
      };
    });
    const liveControls: ElementSpan[] = [];
    // a control takes a line's place in the flow, or its `at=`, as a block of the size it will be
    for (const span of controlSpans) {
      if (!span.carried && (span.enter === null || span.enter.start > start)) continue;
      const gone = exitOf(span);
      if (gone !== null && gone.start <= start) continue;
      const spec = controlSpecOf(span);
      if (spec === null || span.parent !== null) continue;
      const layout = controlLayoutOf({ span, value: spec.value, mood: CALM, maxWidth: controlRoom(span, sceneFit), look, viewport, fit: sceneFit });
      if (layout === null) continue;
      liveControls.push(span);
      items.push({ key: span.key, order: span.order, text: '', emphasis: [], style: laidStyle(styleAt(span, start)), struck: false, replaces: null, reserve: { width: layout.width, height: layout.height } });
    }
    // a card of controls takes the room it will fill, as one block of the flow, so that words and controls after it stand clear of it
    for (const group of drawn) {
      if (group.figure?.kind !== 'group' || group.figure.card === undefined) continue;
      if (!group.carried && (group.enter === null || group.enter.start > start)) continue;
      const gone = exitOf(group);
      if (gone !== null && gone.start <= start) continue;
      const style = styleAt(group, start);
      if (!cardIsInFlow(style)) continue;
      const room = cardRoom(group, start, look, sceneFit);
      if (room === null) continue;
      liveControls.push(group);
      items.push({ key: group.key, order: group.order, text: '', emphasis: [], style: { ...laidStyle(style), stay: 'pin' }, struck: false, replaces: null, reserve: { width: room.outer.width, height: room.outer.height } });
    }
    // HOTFIX (overlap): a structure takes the room it will have when whole, as one block of the flow, as a control does, so words
    // stand above or below it and never over it. Only where words are stacked; elsewhere the scene's own arrangement keeps them apart.
    if (scene.layout === 'stack' || scene.layout === 'page' || scene.layout === 'list') {
      for (const span of schedule.elements) {
        if (span.kind !== 'structure' || span.figure?.kind !== 'structure' || span.scene !== scene.id) continue;
        if (!span.carried && (span.enter === null || span.enter.start > start)) continue;
        const gone = exitOf(span);
        if (gone !== null && gone.start <= start) continue;
        const ps = planeScale(span.style.layer, viewport);
        const extent = structureExtent(span, schedule, { viewport, scope: scopeOf([...cindex.ids], (id) => controlNamed(id, 1e9)), ...(context.engine === undefined ? {} : { engine: context.engine }) }, look, sceneFit);
        if (extent === null) continue;
        // never more than most of the room: a taller structure is laid out smaller, in the room it is given, rather than pushing words off
        const width = Math.min(extent.width, sceneFit.flow.width / ps);
        // a little air above and below, so the words either side do not touch its outermost boxes
        const air = (cellOf('m', viewport, look).height / ps) * 1.6;
        const height = Math.min(extent.height + air, (sceneFit.flow.height / ps) * 0.62);
        items.push({ key: span.key, order: span.order, text: '', emphasis: [], style: { ...laidStyle(styleAt(span, start)), at: null, stay: 'pin' }, struck: false, replaces: null, reserve: { width, height } });
      }
    }
    const sides = scene.layout === 'split' ? splitSides(schedule, scene.id) : undefined;
    // text given a point of the canvas is set by the layout, which keeps it off other text; this is where it wants its centre
    const pins = new Map<string, { x: number; y: number }>();
    for (const element of [...present, ...liveControls]) {
      const style = styleAt(element, start);
      if (style.near !== null || style.group !== null || typeof style.at !== 'object' || style.at === null) continue;
      const scale = planeScale(style.layer, viewport);
      pins.set(element.key, { x: (sceneFit.box.x + style.at.x * sceneFit.unit) / scale, y: (sceneFit.box.y + style.at.y * sceneFit.unit) / scale });
    }
    const arrangement = arrange({
      viewport,
      look,
      layout: scene.layout,
      align: scene.align,
      expected: valueAt(scene.expected, start, null),
      items,
      flow: sceneFit.flow,
      pins,
      ...(sides === undefined ? {} : { sides }),
    });
    for (const key of arrangement.overflow) {
      const element = byKey.get(key);
      if (element === undefined || forced.has(key)) continue;
      const effect = styleAt(element, start).exit;
      forced.set(key, { start, end: start + exitSeconds(effect, paceAt(start)), effect });
    }
    // HOTFIX (overlap): where the scene's free words stand, for structures the flow holds no room for (a caption under a diagram)
    if (!(scene.layout === 'stack' || scene.layout === 'page' || scene.layout === 'list')) {
      const list = wordsOfScene.get(scene.id) ?? [];
      for (const element of present) {
        const style = styleAt(element, start);
        const placement = arrangement.placements.get(element.key);
        if (placement === undefined || (typeof style.at === 'object' && style.at !== null) || style.near !== null || style.group !== null || style.layer !== 'mid') continue;
        list.push({ x: placement.x - placement.width / 2, y: placement.y - placement.height / 2, width: placement.width, height: placement.height });
      }
      wordsOfScene.set(scene.id, list);
    }
    const mood = moodAt(start, look);
    epochs.push({ start, look, snap: mood.snap, arrangement });
  }

  const epochIndexAt = (time: number): number => {
    let low = 0;
    let high = epochs.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((epochs[mid]?.start ?? 0) <= time) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  // The flash governor ------------------------------------------------------
  // It only shapes appearance. The schedule is never touched, so `lines()` is the same.
  // 1. A `hit flash` shows only if no earlier one began less than 0.34 s before it, on any element.
  const allowedFlashes = new Set<ElementChange>();
  {
    const flashes: { change: ElementChange; start: number }[] = [];
    for (const element of schedule.elements) {
      for (const change of element.changes) {
        if (change.kind !== 'hit') continue;
        if (change.gesture === 'flash' || (reducedMotion && change.gesture === 'shake')) flashes.push({ change, start: change.start });
      }
    }
    flashes.sort((a, b) => a.start - b.start);
    let last = Number.NEGATIVE_INFINITY;
    for (const flash of flashes) {
      if (flash.start - last < FLASH_FLOOR_SECONDS - 1e-9) continue;
      allowedFlashes.add(flash.change);
      last = flash.start;
    }
  }

  // 2. A large element (box over 5% of the viewport) stays lit at least 0.34 s, and the screen
  //    stays free of large elements at least 0.34 s between two of them: a later one waits.
  const governed = new Map<string, { enterShift: number; exitShift: number }>();
  {
    const large: ElementSpan[] = [];
    for (const element of elements) {
      const enter = element.enter;
      if (enter === null) continue;
      const placement = epochs[epochIndexAt(enter.start)]?.arrangement.placements.get(element.key);
      if (placement === undefined) continue;
      const scale = planeScale(placement.layer, viewport);
      if (placement.width * placement.height * scale * scale > LARGE_SHARE * viewport.width * viewport.height) large.push(element);
    }
    large.sort((a, b) => (a.enter?.start ?? 0) - (b.enter?.start ?? 0) || a.order - b.order);
    let litEnd = Number.NEGATIVE_INFINITY;
    for (const element of large) {
      const enter = element.enter;
      if (enter === null) continue;
      let start = enter.start;
      if (start >= litEnd && start - litEnd < FLASH_FLOOR_SECONDS - 1e-9) start = litEnd + FLASH_FLOOR_SECONDS;
      const enterShift = start - enter.start;
      const naturalEnd = element.exit === null ? Number.POSITIVE_INFINITY : element.exit.end;
      const end = Math.max(naturalEnd + enterShift, start + FLASH_FLOOR_SECONDS);
      const exitShift = Number.isFinite(end) ? end - naturalEnd : 0;
      if (enterShift > 0 || exitShift > 0) governed.set(element.key, { enterShift, exitShift });
      litEnd = Math.max(litEnd, end);
    }
  }

  const poseIn = (index: number, key: string, time: number): Pose | null => {
    const epoch = epochs[index];
    const current = epoch?.arrangement.placements.get(key);
    if (epoch === undefined || current === undefined) return null;
    const previousEpoch = epochs[index - 1];
    const previous = previousEpoch?.arrangement.placements.get(key);
    if (previousEpoch === undefined || previousEpoch.look !== epoch.look) return poseOf(current);
    const q = (time - epoch.start) / (SETTLE_SECONDS * epoch.snap);
    if (previous === undefined) {
      // A line that arrives while the lines above it scroll away starts where the block would have put it before the scroll, and rides up with them:
      // placed at its final slot at once it would sit on the lines still on their way.
      if (q >= 1 || current.layer !== 'mid') return poseOf(current);
      const order = byKey.get(key)?.order ?? 0;
      const layout = sceneAt(schedule, epoch.start).layout;
      let lead: { before: number; after: number } | null = null;
      let leadOrder = -1;
      for (const [other, now] of epoch.arrangement.placements) {
        const was = previousEpoch.arrangement.placements.get(other);
        const rank = byKey.get(other)?.order ?? 0;
        const own = byKey.get(other);
        if (was === undefined || own === undefined || other === key || now.layer !== 'mid' || was.layer !== 'mid' || rank >= order || rank <= leadOrder) continue;
        if (layout === 'free' || !isInFlow(styleAt(own, epoch.start), layout)) continue;
        leadOrder = rank;
        lead = { before: was.y, after: now.y };
      }
      if (lead === null || Math.abs(lead.before - lead.after) < 1e-6) return poseOf(current);
      const curve = epoch.look.motion.ease === 'hold' ? 'out' : epoch.look.motion.ease;
      return blendPose({ ...poseOf(current), y: current.y + (lead.before - lead.after) }, current, ease(curve, Math.max(0, q)), scaleLimit);
    }
    if (q >= 1) return poseOf(current);
    const from = poseIn(index - 1, key, epoch.start) ?? poseOf(previous);
    const curve = epoch.look.motion.ease === 'hold' ? 'out' : epoch.look.motion.ease;
    return blendPose(from, current, ease(curve, Math.max(0, q)), scaleLimit);
  };

  /** Where an element is at `time`. A leaving element keeps the place it had when it started to go. */
  const poseAt = (key: string, time: number, freezeAt: number | null): Pose | null => {
    const at = freezeAt === null ? time : Math.min(time, freezeAt - 1e-9);
    let found: Pose | null = null;
    for (let index = epochIndexAt(at); index >= 0; index -= 1) {
      const pose = poseIn(index, key, at);
      if (pose !== null) {
        found = pose;
        break;
      }
    }
    if (found === null || freezeAt === null || time <= at) return found;
    // A line the layout retired because the column was full scrolls away with the lines that stay, rather than stand still while they slide onto it.
    const retired = forced.get(key);
    if (retired === undefined || Math.abs(retired.start - freezeAt) > 1e-9 || found.layer !== 'mid') return found;
    const index = epochIndexAt(retired.start);
    const before = epochs[index - 1];
    const after = epochs[index];
    const element = byKey.get(key);
    if (before === undefined || after === undefined || before.look !== after.look || element === undefined) return found;
    const layout = sceneAt(schedule, retired.start).layout;
    let follow: { key: string; order: number } | null = null;
    for (const [other, placement] of after.arrangement.placements) {
      const own = byKey.get(other);
      if (own === undefined || placement.layer !== 'mid' || own.order <= element.order || (follow !== null && own.order >= follow.order)) continue;
      if (!before.arrangement.placements.has(other) || layout === 'free' || !isInFlow(styleAt(own, retired.start), layout)) continue;
      follow = { key: other, order: own.order };
    }
    const was = follow === null ? undefined : before.arrangement.placements.get(follow.key);
    const now = follow === null ? null : poseAt(follow.key, time, null);
    if (was === undefined || now === null) return found;
    return { ...found, y: found.y + (now.y - was.y) };
  };

  // Colour -------------------------------------------------------------------
  const inkCache = new Map<string, string>();
  const inkFor = (style: ElementStyle, look: LookSpec, minRatio: number, emphasised: boolean, onBar: boolean, role?: 'dim'): string => {
    // A name that is not a colour of this look is the look's ink, never a lookup of whatever the name happens to be called on an object.
    const named = role ?? style.ink;
    const ink = (named.startsWith('#') || has(look.roles, named) ? named : 'ink') as typeof named;
    const key = `${specIds.get(look) ?? look.id}|${ink}|${minRatio}|${style.weight}|${emphasised ? 1 : 0}|${onBar ? 1 : 0}`;
    const known = inkCache.get(key);
    if (known !== undefined) return known;
    const made = resolveInk(ink, look, { minRatio, weight: style.weight, emphasised, onBar });
    inkCache.set(key, made);
    return made;
  };

  const strongest = (look: LookSpec): string => {
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
  };

  // One element at one instant -------------------------------------------
  const evaluate = (rawElement: ElementSpan, tq: number, aq: number, look: LookSpec, camera: CameraPose, place: { x: number; y: number } | null): Evaluated | null => {
    const bound = boundElement(rawElement, tq, aq, cindex, runtime);
    const element = bound.element;
    const govern = governed.get(element.key);
    const enter = element.enter !== null && govern !== undefined ? { ...element.enter, start: element.enter.start + govern.enterShift, end: element.enter.end + govern.enterShift } : element.enter;
    if (enter !== null && tq < enter.start) return null;
    const ownExit = exitOf(element);
    const exit = ownExit !== null && ownExit === element.exit && govern !== undefined ? { ...ownExit, start: ownExit.start + govern.exitShift, end: ownExit.end + govern.exitShift } : ownExit;
    if (exit !== null && tq >= exit.end) return null;
    const laid = poseAt(element.key, tq, exit === null ? null : exit.start);
    if (laid === null) return null;
    const style = styleAt(element, tq);
    const placed: Pose = place === null ? laid : { ...laid, x: place.x, y: place.y };
    // words the hand has changed (`{…}`, or a bound `text`) are set again in the room the line has
    const words = wordsNow(element, bound.words, tq);
    let pose: Pose = placed;
    if (words !== null) {
      const first = placed.lines[0];
      const left = first === undefined ? true : Math.abs(first.x + placed.width / 2) < 0.5;
      const right = first !== undefined && Math.abs(first.x + first.width - placed.width / 2) < 0.5 && !left;
      const natural = cellOf(style.size, viewport, look).fontSize / planeScale(placed.layer, viewport);
      const set = setTextOnce({ look, viewport, text: words.text, emphasis: words.emphasis, style: { ...style, layer: placed.layer }, shrink: Math.max(0.05, Math.min(1, placed.fontSize / natural)), maxWidth: placed.width, width: placed.width, align: left ? 'left' : right ? 'right' : 'center' });
      pose = { ...placed, runs: set.placement.runs, lines: set.placement.lines, height: Math.max(placed.height, set.placement.height) };
    }
    const fs = pose.fontSize;
    const screenPx = fs * planeScale(pose.layer, viewport);
    const minRatio = minContrastFor(screenPx, pose.layer);
    const onBar = style.mark === 'invert';
    const baseColour = (s: ElementStyle, emphasised: boolean): string => inkFor(s, look, minRatio, emphasised, s.mark === 'invert');

    // Colour changes from a `set` tween over its span; a correction fades the old line to a ghost.
    let previousStyle: ElementStyle | null = null;
    let setProgress = 1;
    for (const change of element.changes) {
      if (change.kind === 'set' && change.start <= tq && (previousStyle === null || change.start >= setStart(element, tq))) {
        previousStyle = styleAt(element, change.start - 1e-9);
        setProgress = change.end > change.start ? clamp01((tq - change.start) / (change.end - change.start)) : 1;
      }
    }
    let strike = element.struck ? 1 : 0;
    for (const change of element.changes) {
      if (change.kind === 'strike' && change.start <= tq) strike = change.end > change.start ? clamp01((tq - change.start) / (change.end - change.start)) : 1;
    }
    const ghostColour = inkFor(style, look, minRatio, false, onBar, 'dim');
    const runColourOf = (emphasised: boolean): string => {
      let colour = baseColour(style, emphasised);
      if (previousStyle !== null && setProgress < 1) colour = mixHex(baseColour(previousStyle, emphasised), colour, setProgress);
      if (strike > 0) colour = mixHex(colour, ghostColour, strike);
      return colour;
    };

    // Gestures ---------------------------------------------------------------
    let hitScale = 1;
    let hitDx = 0;
    let hitFlash = 0;
    // How far this element may wander sideways and up or down and still keep 16 px from the edge.
    const slack = slackOf(pose);
    for (const change of element.changes) {
      if (change.kind !== 'hit' || tq < change.start || tq >= change.end) continue;
      const p = (tq - change.start) / (change.end - change.start);
      const gesture = change.gesture === 'shake' && reducedMotion ? 'flash' : change.gesture;
      if (gesture === 'pulse') hitScale = 1 + 0.12 * Math.sin(Math.PI * p);
      else if (gesture === 'flash') hitFlash = allowedFlashes.has(change) ? Math.sin(Math.PI * p) : 0;
      else hitDx = Math.min(0.15 * fs, slack.x) * (1 - p) * Math.sin(2 * Math.PI * 4 * p);
    }
    const flashColour = hitFlash > 0 ? strongest(look) : null;

    // Loops, on ambient time ---------------------------------------------
    let loopScale = 1;
    let loopDx = 0;
    let loopDy = 0;
    let loopOpacity = 1;
    switch (style.loop) {
      case 'breathe':
        loopScale = 1 + 0.015 * Math.sin((2 * Math.PI * aq) / 4);
        break;
      case 'pulse': {
        const phase = (aq / 1.2) % 1;
        loopScale = 1 + 0.06 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
        break;
      }
      case 'blink':
        if (!reducedMotion && (aq / Math.max(look.motion.blink, 2 * FLASH_FLOOR_SECONDS)) % 1 >= 0.5) loopOpacity = 0;
        break;
      case 'shake':
        if (!reducedMotion) {
          const slot = Math.floor(aq * 24);
          loopDx = 0.03 * fs * (hash(`${element.key}x${slot}`) * 2 - 1);
          loopDy = 0.03 * fs * (hash(`${element.key}y${slot}`) * 2 - 1);
        }
        break;
      case 'drift': {
        const theta = (2 * Math.PI * aq) / 9;
        const ax = Math.min(0.3 * fs, slack.x);
        const ay = Math.min(0.15 * fs, slack.y);
        const share = pose.layer === 'mid' ? 1 : driftClearance(element.key, pose, tq, ax, ay);
        loopDx = ax * share * Math.sin(theta);
        loopDy = ay * share * Math.sin(2 * theta);
        break;
      }
      case 'none':
        break;
    }

    // Entrance ---------------------------------------------------------------
    const runs = pose.runs;
    const count = runs.length;
    const states: RunState[] = runs.map(() => ({ opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 }));
    let entering = false;
    let typing: Evaluated['typing'] = null;
    if (enter !== null) {
      const span = enter.end - enter.start;
      let recipe: MotionRecipe = lookup<MotionRecipe>(look.motion.enter as Readonly<Record<string, MotionRecipe>>, enter.effect, FADE_RECIPE);
      let length = span;
      if (reducedMotion && (enter.effect === 'slam' || recipe.flicker)) {
        recipe = FADE_RECIPE;
        length = Math.min(span, REDUCED_FADE_SECONDS);
      }
      const p = length <= 0 ? (tq >= enter.start ? 1 : 0) : clamp01((tq - enter.start) / length);
      entering = tq < enter.start + length;
      const reveal = recipe.reveal || enter.by === 'char';
      const total = Math.max(1, ...runs.map((run) => run.offset + run.text.length));
      const apply = (state: RunState, q: number): void => {
        const from = recipe.from;
        state.opacity = lerp(from.opacity ?? 1, 1, q);
        state.dx = lerp((from.dx ?? 0) * fs, 0, q);
        state.dy = lerp((from.dy ?? 0) * fs, 0, q);
        state.scale = lerp(from.scale ?? 1, 1, q);
      };
      if (reveal) {
        const frontier = ease(recipe.ease === 'hold' ? 'linear' : recipe.ease, p) * total;
        const face = style.face ?? look.type.face;
        runs.forEach((run, i) => {
          const state = states[i];
          if (state === undefined) return;
          const length = Math.max(1, run.text.length);
          const progress = clamp01((frontier - run.offset) / length);
          // Whole characters, in order: how much of the run's width that is depends on the face, which is not the same width for every letter.
          state.reveal = revealShare(run.text, Math.floor(progress * length + 1e-9), face, style.weight);
          apply(state, progress);
          if (state.reveal <= 0) state.opacity = 0;
        });
        if ((enter.effect === 'type' || enter.by === 'char') && p > 0 && p < 1) {
          const cell = { width: fs * look.type.advance * pose.stretch, height: fs * look.type.lineHeight };
          let target: PlacedRun | undefined;
          let into = 0;
          for (const run of runs) {
            if (frontier <= run.offset) {
              target = run;
              into = 0;
              break;
            }
            target = run;
            into = Math.min(run.text.length, Math.floor(frontier - run.offset + 1e-9));
            if (frontier < run.offset + run.text.length) break;
          }
          if (target !== undefined) {
            const reach = revealShare(target.text, into, face, style.weight) * target.width;
            typing = { layer: pose.layer, cursor: { x: pose.x + target.x + reach, y: pose.y + target.y, width: cell.width, height: cell.height }, start: enter.start };
          }
        }
      } else if (enter.by === 'word' && count > 0) {
        const slot = span / count;
        const eased = reducedMotion && recipe === FADE_RECIPE ? REDUCED_FADE_SECONDS : lookup<number>(ENTER_SECONDS as Readonly<Record<string, number>>, enter.effect, 0.3) * PACE_TIMING[paceAt(enter.start)].ease;
        const own = Math.min(slot, eased);
        runs.forEach((_, i) => {
          const state = states[i];
          if (state === undefined) return;
          const begin = enter.start + i * slot;
          if (tq < begin) {
            state.opacity = 0;
            state.reveal = 0;
            return;
          }
          const q = own <= 0 ? 1 : clamp01((tq - begin) / own);
          apply(state, ease(recipe.ease, q));
        });
      } else {
        const e = ease(recipe.ease, p);
        for (const state of states) apply(state, e);
      }
      if (recipe.flicker && !reducedMotion && p < 1) {
        const slot = Math.floor((tq - enter.start) / FLICKER_SLOT);
        const last = Math.floor(span / FLICKER_SLOT);
        const on = slot >= last || hash(`${element.key}#${slot}`) > 0.45;
        if (!on) for (const state of states) state.opacity = 0;
      }
    }

    // Exit -------------------------------------------------------------------
    let exitOpacity = 1;
    let exitScale = 1;
    let leaving = false;
    if (exit !== null && tq >= exit.start) {
      leaving = true;
      const recipe = lookup<MotionRecipe>(look.motion.exit as Readonly<Record<string, MotionRecipe>>, exit.effect, FADE_RECIPE);
      const length = exit.end - exit.start;
      const e = ease(recipe.ease === 'hold' ? 'linear' : recipe.ease, length <= 0 ? 1 : clamp01((tq - exit.start) / length));
      exitOpacity = lerp(1, recipe.from.opacity ?? 1, e);
      exitScale = lerp(1, recipe.from.scale ?? 1, e);
      const total = Math.max(1, ...runs.map((run) => run.offset + run.text.length));
      runs.forEach((run, i) => {
        const state = states[i];
        if (state === undefined) return;
        state.dx += lerp(0, (recipe.from.dx ?? 0) * fs, e);
        state.dy += lerp(0, (recipe.from.dy ?? 0) * fs, e);
        if (recipe.reveal) state.reveal = Math.min(state.reveal, clamp01((total * (1 - e) - run.offset) / Math.max(1, run.text.length)));
      });
    }

    // Assemble ------------------------------------------------------------------
    const runFrames: RunFrame[] = [];
    const first = states[0];
    if (pose.bullet !== null) {
      const bullet = pose.bullet;
      runFrames.push({
        text: bullet.text,
        x: bullet.x,
        y: bullet.y,
        width: bullet.width,
        colour: runColourOf(false),
        opacity: first === undefined ? 1 : first.reveal > 0 ? first.opacity : 0,
        dx: first?.dx ?? 0,
        dy: first?.dy ?? 0,
        scale: first?.scale ?? 1,
        reveal: first !== undefined && first.reveal > 0 ? 1 : 0,
      });
    }
    runs.forEach((run, i) => {
      const state = states[i];
      if (state === undefined) return;
      let colour = runColourOf(run.emphasised);
      if (flashColour !== null) colour = mixHex(colour, flashColour, hitFlash);
      runFrames.push({
        text: run.text,
        x: run.x,
        y: run.y,
        width: run.width,
        colour,
        opacity: state.opacity,
        dx: state.dx,
        dy: state.dy,
        scale: state.scale,
        reveal: state.reveal,
      });
    });

    // A struck line rests at full opacity in `dim`: the strike line carries "withdrawn", not a fade that would take it under the contrast bar.
    const gateUntil = replacedUntil.get(element.key);
    const gate = gateUntil === undefined ? 1 : clamp01((tq - (gateUntil - GATE_SECONDS)) / GATE_SECONDS);
    const opacity = exitOpacity * loopOpacity * gate;
    const scale = pose.comp * loopScale * hitScale * exitScale;
    const frame: ElementFrame = {
      key: element.key,
      id: element.id,
      layer: pose.layer,
      z: element.order,
      face: style.face ?? look.type.face,
      x: pose.x + loopDx + hitDx,
      y: pose.y + loopDy,
      width: pose.width,
      height: pose.height,
      fontSize: fs,
      stretch: pose.stretch,
      weight: style.weight,
      opacity,
      scale,
      rotation: look.id === 'printout' && enter?.effect === 'slam' ? (hash(element.key) - 0.5) * 0.05 : 0,
      runs: runFrames,
      lines: pose.lines,
      mark: style.mark,
      markColour: onBar ? inkFor(style, look, minRatio, false, false) : baseColour(style, false),
      strike,
      ghost: strike > 0,
      tappable: style.tap,
      plate: 0,
    };

    // The test hook's view of the same moment.
    const projected = projectToScreen({ x: frame.x, y: frame.y, z: layerZ(pose.layer, viewport) }, camera, viewport);
    const s = projected.scale * scale;
    const judged = judge(frame, look, null);
    const worst = judged.worst;
    const worstColour = judged.colour;
    const visibleOpacity = judged.visible;
    const phase: ElementPhase = leaving ? 'leaving' : entering ? 'entering' : strike > 0 ? 'struck' : 'on';
    const view: StageElementView = {
      key: element.key,
      id: element.id,
      kind: element.kind,
      painting: null,
      text: words === null ? element.text : words.text,
      layer: pose.layer,
      phase,
      box: { x: projected.x - (pose.width * s) / 2, y: projected.y - (pose.height * s) / 2, width: pose.width * s, height: pose.height * s },
      fontPx: fs * s,
      colour: worstColour,
      contrast: Number.isFinite(worst) ? worst : 21,
      opacity: opacity * visibleOpacity,
      tappable: style.tap,
    };
    return { frame, view, typing };
  };

  const setStart = (element: ElementSpan, tq: number): number => {
    let latest = -1;
    for (const change of element.changes) if (change.kind === 'set' && change.start <= tq) latest = Math.max(latest, change.start);
    return latest;
  };

  /**
   * Where text reaches on each layer over everything a scene ever shows, bg and
   * fg included, with the sideways wander of drifting and shaking words added
   * (as far as they are allowed to wander).
   */
  interface Extent {
    readonly layer: Layer;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    /** the same for the elements' boxes as the snapshot reports them */
    boxMinX: number;
    boxMaxX: number;
    boxMinY: number;
    boxMaxY: number;
  }
  const reachCache = new Map<number, Extent[]>();
  const reachOf = (sceneIndex: number, from: number, to: number): Extent[] => {
    const known = reachCache.get(sceneIndex);
    if (known !== undefined) return known;
    const found = new Map<Layer, Extent>();
    epochs.forEach((epoch, i) => {
      const next = epochs[i + 1]?.start ?? Number.POSITIVE_INFINITY;
      if (next <= from || epoch.start >= to) return;
      for (const [key, placement] of epoch.arrangement.placements) {
        const element = byKey.get(key);
        const slack = slackOf(placement);
        const padX = element === undefined ? 0 : Math.max(loopsDrift(element) ? Math.min(0.3 * placement.fontSize, slack.x) : 0, hitsShake(element) ? Math.min(0.15 * placement.fontSize, slack.x) : 0);
        const padY = element !== undefined && loopsDrift(element) ? Math.min(0.15 * placement.fontSize, slack.y) : 0;
        const entry = found.get(placement.layer) ?? { layer: placement.layer, minX: 0, maxX: 0, minY: 0, maxY: 0, boxMinX: 0, boxMaxX: 0, boxMinY: 0, boxMaxY: 0 };
        for (const line of placement.lines) {
          entry.minX = Math.min(entry.minX, placement.x + line.x - padX);
          entry.maxX = Math.max(entry.maxX, placement.x + line.x + line.width + padX);
          entry.minY = Math.min(entry.minY, placement.y + line.y - padY);
          entry.maxY = Math.max(entry.maxY, placement.y + line.y + line.height + padY);
        }
        entry.boxMinX = Math.min(entry.boxMinX, placement.x - placement.width / 2 - padX);
        entry.boxMaxX = Math.max(entry.boxMaxX, placement.x + placement.width / 2 + padX);
        entry.boxMinY = Math.min(entry.boxMinY, placement.y - placement.height / 2 - padY);
        entry.boxMaxY = Math.max(entry.boxMaxY, placement.y + placement.height / 2 + padY);
        found.set(placement.layer, entry);
      }
    });
    const list = [...found.values()];
    reachCache.set(sceneIndex, list);
    return list;
  };

  const sceneBoundsAt = (time: number): { scene: ReturnType<typeof sceneAt>; extents: Extent[] } => {
    const scene = sceneAt(schedule, time);
    const later = schedule.scenes.find((candidate) => candidate.start > scene.start);
    return { scene, extents: reachOf(scene.index, scene.start, later?.start ?? Number.POSITIVE_INFINITY) };
  };

  const leanCache = new Map<number, number>();
  /** The strongest lean any mood of a scene has, as a share of the rest distance. */
  const sceneLeanAt = (time: number): number => {
    const { scene } = sceneBoundsAt(time);
    const known = leanCache.get(scene.index);
    if (known !== undefined) return known;
    const later = schedule.scenes.find((candidate) => candidate.start > scene.start);
    const look = specAt(scene.start);
    let lean = moodAt(scene.start + MOOD_SECONDS, look).lean;
    for (const item of moods) if (item.at >= scene.start && item.at < (later?.start ?? Number.POSITIVE_INFINITY)) lean = Math.max(lean, look.mood[item.value].lean);
    leanCache.set(scene.index, lean);
    return lean;
  };

  const fits = (time: number, pose: CameraPose, withLean: boolean): boolean => {
    const { extents } = sceneBoundsAt(time);
    const rest = restDistance(viewport);
    const at: CameraPose = withLean ? { ...pose, dolly: pose.dolly + sceneLeanAt(time) * rest } : pose;
    for (const extent of extents) {
      const z = layerZ(extent.layer, viewport);
      for (const x of [extent.minX, extent.maxX]) {
        for (const y of [extent.minY, extent.maxY]) {
          const point = projectToScreen({ x, y, z }, at, viewport);
          if (point.x < edge || point.y < edge || point.x > viewport.width - edge || point.y > viewport.height - edge) return false;
        }
      }
      for (const x of [extent.boxMinX, extent.boxMaxX]) {
        for (const y of [extent.boxMinY, extent.boxMaxY]) {
          const point = projectToScreen({ x, y, z }, at, viewport);
          if (point.x < boxEdge || point.y < boxEdge || point.x > viewport.width - boxEdge || point.y > viewport.height - boxEdge) return false;
        }
      }
    }
    return true;
  };

  const roomAt = (time: number, dolly: number): { maxDolly: number; x: number; y: number } => {
    const { extents } = sceneBoundsAt(time);
    const rest = restDistance(viewport);
    const halfW = viewport.width / 2 - edge;
    const halfH = viewport.height / 2 - edge;
    let maxDolly = Number.POSITIVE_INFINITY;
    let x = halfW;
    let y = halfH;
    for (const reach of extents) {
      const scale = planeScale(reach.layer, viewport);
      const ex = Math.max(Math.abs(reach.minX), Math.abs(reach.maxX)) * scale;
      const ey = Math.max(Math.abs(reach.minY), Math.abs(reach.maxY)) * scale;
      const z = layerZ(reach.layer, viewport);
      const limit = Math.min(ex > 0 ? halfW / ex : Number.POSITIVE_INFINITY, ey > 0 ? halfH / ey : Number.POSITIVE_INFINITY);
      if (Number.isFinite(limit)) maxDolly = Math.min(maxDolly, limit <= 1 ? 0 : (rest - z) * (1 - 1 / limit));
      const bex = Math.max(Math.abs(reach.boxMinX), Math.abs(reach.boxMaxX)) * scale;
      const bey = Math.max(Math.abs(reach.boxMinY), Math.abs(reach.boxMaxY)) * scale;
      const boxHalfW = viewport.width / 2 - boxEdge;
      const boxHalfH = viewport.height / 2 - boxEdge;
      const boxLimit = Math.min(bex > 0 ? boxHalfW / bex : Number.POSITIVE_INFINITY, bey > 0 ? boxHalfH / bey : Number.POSITIVE_INFINITY);
      if (Number.isFinite(boxLimit)) maxDolly = Math.min(maxDolly, boxLimit <= 1 ? 0 : (rest - z) * (1 - 1 / boxLimit));
      const grown = (rest - z) / (rest - dolly - z);
      x = Math.min(x, halfW - ex * grown);
      y = Math.min(y, halfH - ey * grown);
      x = Math.min(x, boxHalfW - bex * grown);
      y = Math.min(y, boxHalfH - bey * grown);
    }
    return { maxDolly: Number.isFinite(maxDolly) ? maxDolly : MAX_DOLLY * rest, x: Math.max(0, x), y: Math.max(0, y) };
  };

  // Drawn things, labels and plates --------------------------------------
  const fitMemo = new Map<string, CanvasFit>();
  const fitOfScene = (scene: Pick<SceneSpan, 'id' | 'canvas' | 'layout'>, spec: LookSpec): CanvasFit => {
    const key = `${scene.id}|${specIds.get(spec) ?? 0}`;
    let found = fitMemo.get(key);
    if (found === undefined) {
      found = fitCanvas(scene.canvas, scene.layout, viewport, spec);
      fitMemo.set(key, found);
    }
    return found;
  };
  const sceneOfElement = (element: ElementSpan) => schedule.scenes.find((scene) => scene.id === element.scene) ?? schedule.scenes[0];
  const fitOfElement = (element: ElementSpan, spec: LookSpec): CanvasFit => {
    const scene = sceneOfElement(element);
    return fitOfScene(scene ?? { id: base.scene.id, canvas: base.scene.canvas, layout: base.scene.layout }, spec);
  };

  const structures = buildStructures(schedule, {
    viewport,
    reducedMotion,
    arrivals: context.arrivals ?? new Map(),
    scope: scopeOf([...cindex.ids], (id) => controlNamed(id, 1e9)),
    specAt,
    fitOf: (element, spec) => fitOfElement(element, spec),
    flips: lockLook === null ? lookFlips : [],
    snapAt: (time) => moodAt(time, specAt(time)).snap,
    avoid: (structure) => wordsOfScene.get(structure.scene) ?? [],
    placed: (structure, time) => {
      const placement = epochs[epochIndexAt(time)]?.arrangement.placements.get(structure.key);
      return placement === undefined ? null : { x: placement.x - placement.width / 2, y: placement.y - placement.height / 2, width: placement.width, height: placement.height };
    },
    ...(context.engine === undefined ? {} : { engine: context.engine }),
  });

  /** Where a control is at `time` and what it looks like, from where the flow (or its `at=`) put it. */
  const presentControl = (span: ElementSpan, tq: number): boolean => {
    if (!span.carried && (span.enter === null || tq < span.enter.start)) return false;
    const gone = exitOf(span);
    return gone === null || tq < gone.end;
  };
  /** The controls of a `card` (or any group) stand in a column inside it, one under another, where the group was put. */
  const stackOf = (group: ElementSpan, tq: number, look: LookSpec) => {
    const members = controlSpans.filter((member) => member.parent === group.key && presentControl(member, tq)).sort((a, b) => a.order - b.order);
    if (members.length === 0) return null;
    const fit = fitOfElement(group, look);
    const ps = planeScale(group.style.layer, viewport);
    const gap = cellOf('m', viewport, look).height / ps / 4;
    const layouts = new Map<string, ControlLayout>();
    let width = 0;
    let height = -gap;
    for (const member of members) {
      const spec = controlSpecOf(member);
      const layout = spec === null ? null : controlLayoutOf({ span: member, value: spec.value, mood: CALM, maxWidth: (fit.flow.width * 0.8) / ps, look, viewport, fit });
      if (layout === null) continue;
      layouts.set(member.key, layout);
      width = Math.max(width, layout.width);
      height += layout.height + gap;
    }
    const at = styleAt(group, tq).at;
    let middle = typeof at === 'object' && at !== null ? { x: (fit.box.x + at.x * fit.unit) / ps, y: (fit.box.y + at.y * fit.unit) / ps } : { x: (fit.flow.x + fit.flow.width / 2) / ps, y: (fit.flow.y + fit.flow.height / 2) / ps };
    const pose = typeof at === 'object' && at !== null ? null : poseAt(group.key, tq, null);
    if (pose !== null) {
      // the flow gave the card a block; the column sits in it, under the frame's title
      const room = cardRoom(group, tq, look, fit);
      const outer = room?.outer ?? { x: 0, y: 0, width, height };
      const shift = room === null ? 0 : outer.y + outer.height / 2 - (room.inner.y + room.inner.height / 2);
      const left = pose.x + (pose.lines[0]?.x ?? -pose.width / 2);
      middle = { x: left + outer.width / 2, y: pose.y - shift };
    }
    const inner: Box = { x: middle.x - width / 2, y: middle.y - height / 2, width, height };
    const slots = new Map<string, { x: number; y: number }>();
    let top = inner.y;
    for (const member of members) {
      const layout = layouts.get(member.key);
      if (layout === undefined) continue;
      slots.set(member.key, { x: inner.x + layout.width / 2, y: top + layout.height / 2 });
      top += layout.height + gap;
    }
    return { fit, ps, inner, slots, layouts };
  };
  const siteOf = (span: ElementSpan, tq: number, look: LookSpec, mood: ControlMood, value: ControlValue | null) => {
    if (!presentControl(span, tq)) return null;
    const gone = exitOf(span);
    if (span.parent !== null) {
      const group = schedule.elements.find((element) => element.key === span.parent);
      const stack = group === undefined ? null : stackOf(group, tq, look);
      const slot = stack?.slots.get(span.key);
      if (stack === null || slot === undefined) return null;
      const layout = controlLayoutOf({ span, value, mood, maxWidth: (stack.fit.flow.width * 0.8) / stack.ps, look, viewport, fit: stack.fit });
      return layout === null ? null : { pose: null, layout, fit: stack.fit, centre: slot };
    }
    const pose = poseAt(span.key, tq, gone === null ? null : gone.start);
    if (pose === null) return null;
    const fit = fitOfElement(span, look);
    const layout = controlLayoutOf({ span, value, mood, maxWidth: controlRoom(span, fit), look, viewport, fit });
    if (layout === null) return null;
    const left = pose.x + (pose.lines[0]?.x ?? -pose.width / 2);
    return { pose, layout, fit, centre: { x: left + layout.width / 2, y: pose.y } };
  };
  const chartSpans = context.charts === undefined ? [] : schedule.elements.filter((element) => element.kind === 'structure' && element.figure?.kind === 'structure' && element.figure.structure === 'chart');
  if (controlSpans.length > 0 || chartSpans.length > 0) {
    // a control is a thing the painter placed: `near=`, `cam focus` and the sight report find it where it is
    const before = laidOutOf(schedule);
    const byControl = new Map(controlSpans.map((span) => [span.key, span]));
    registerLaidOut(schedule, {
      boxOf(key, time) {
        const chart = chartSpans.find((candidate) => candidate.key === key);
        if (chart !== undefined && chart.figure?.kind === 'structure') {
          const fit = fitOfElement(chart, specAt(time));
          const room = chart.figure.box;
          return room === null ? { x: (fit.box.x - fit.box.x) / fit.unit, y: 0, w: fit.box.width / fit.unit, h: fit.box.height / fit.unit } : { x: room.x, y: room.y, w: room.w, h: room.h };
        }
        const span = byControl.get(key);
        const spec = span === undefined ? null : controlSpecOf(span);
        if (span === undefined || spec === null) return before?.boxOf(key, time) ?? null;
        const site = siteOf(span, time, specAt(time), CALM, spec.value);
        if (site === null) return null;
        const ps = planeScale(span.style.layer, viewport);
        return { x: ((site.centre.x - site.layout.width / 2) * ps - site.fit.box.x) / site.fit.unit, y: ((site.centre.y - site.layout.height / 2) * ps - site.fit.box.y) / site.fit.unit, w: (site.layout.width * ps) / site.fit.unit, h: (site.layout.height * ps) / site.fit.unit };
      },
      routeOf: (key, time) => before?.routeOf(key, time) ?? null,
    });
  }

  const isLiveAt = (element: ElementSpan, time: number): boolean => (element.carried || element.enter === null || element.enter.start <= time) && (element.exit === null || time < element.exit.end);
  const drawnLive = (id: string, time: number): ElementSpan | null => {
    for (let i = drawn.length - 1; i >= 0; i -= 1) {
      const candidate = drawn[i];
      if (candidate !== undefined && candidate.id === id && candidate.kind !== 'field' && isLiveAt(candidate, time)) return candidate;
    }
    return null;
  };
  const hasPictureAt = (time: number): boolean => {
    const scene = sceneAt(schedule, time);
    return drawn.some((element) => element.scene === scene.id && element.kind !== 'field' && element.kind !== 'group' && isLiveAt(element, time));
  };

  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const hitRects = (a: Rect, b: Rect, pad: number): boolean => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

  /** A canvas rectangle in screen units with the camera at rest (the reading plane's units). */
  const toScreenRect = (box: Rect, fit: CanvasFit): Rect => ({ x: fit.box.x + box.x * fit.unit, y: fit.box.y + box.y * fit.unit, w: box.w * fit.unit, h: box.h * fit.unit });

  /**
   * Where text goes that the layout cannot decide: a label beside the thing it
   * names, and a line given a point of the canvas. Centres, on the text's own
   * layer plane. A pure function of time, like everything else.
   */
  let calloutLeaders = new Map<string, { points: { x: number; y: number }[]; closed: boolean; layer: Layer }>();
  const calloutMemo = new Map<string, ReturnType<typeof layoutCallouts>>();
  const placeLoose = (tq: number, look: LookSpec): Map<string, { x: number; y: number }> => {
    const out = new Map<string, { x: number; y: number }>();
    const cell = cellOf('m', viewport, look);
    const taken: Rect[] = [];
    // the layout's own text on the reading plane (the flow and words set at a point), which a label must keep clear of as it keeps clear of other labels
    let seeded = false;
    const seedText = (): void => {
      if (seeded) return;
      seeded = true;
      const arrangement = epochs[epochIndexAt(tq)]?.arrangement;
      if (arrangement === undefined) return;
      for (const placement of arrangement.placements.values()) {
        if (placement.layer !== 'mid') continue;
        const element = byKey.get(placement.key);
        if (element === undefined || (element.exit !== null && tq >= element.exit.end) || (!element.carried && (element.enter === null || tq < element.enter.start))) continue;
        const own = styleAt(element, tq);
        if (own.near !== null || own.group !== null) continue;
        for (const line of placement.lines) taken.push({ x: placement.x + line.x, y: placement.y + line.y, w: line.width, h: line.height });
      }
    };
    const obstacles: { rect: Rect; owner: ElementSpan; outline: boolean }[] = [];
    let obstaclesBuilt = false;
    const buildObstacles = (): void => {
      if (obstaclesBuilt) return;
      obstaclesBuilt = true;
      for (const element of drawn) {
        if (element.kind !== 'shape' && element.kind !== 'sprite' && element.kind !== 'copy') continue;
        if (!isLiveAt(element, tq)) continue;
        const box = canvasBoxOf(element, schedule, tq);
        if (box === null) continue;
        const fit = fitOfElement(element, look);
        const big = box.w * box.h > 0.2 * (fit.box.width * fit.box.height) / (fit.unit * fit.unit);
        const shape = element.figure?.kind === 'shape' ? element.figure.geometry.shape : null;
        // a large closed shape is an outline a label must not cross; a large line or path has no edge to keep clear of
        if (big && shape !== 'rect' && shape !== 'circle' && shape !== 'ellipse') {
          // A long stroke has no edge to keep inside, but every piece of it is still something a word must not sit on: it is an obstacle in short lengths.
          const geometry = element.figure?.kind === 'shape' ? element.figure.geometry : null;
          if (geometry !== null) {
            const piece = Math.max(2, 1.5 * cell.width / fit.unit);
            for (const line of outlineOf(geometry)) {
              const pts = line.closed ? [...line.points, ...line.points.slice(0, 1)] : line.points;
              for (let i = 0; i + 1 < pts.length && obstacles.length < 900; i += 1) {
                const a = pts[i];
                const b = pts[i + 1];
                if (a === undefined || b === undefined) continue;
                const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / piece));
                for (let k = 0; k < n; k += 1) {
                  const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
                  const q = { x: a.x + ((b.x - a.x) * (k + 1)) / n, y: a.y + ((b.y - a.y) * (k + 1)) / n };
                  obstacles.push({ rect: toScreenRect({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) }, fit), owner: element, outline: false });
                }
              }
            }
          }
          continue;
        }
        obstacles.push({ rect: toScreenRect(box, fit), owner: element, outline: big });
      }
    };
    const callouts: { key: string; ps: number; w: number; h: number; target: Rect; side: 'auto' | 'above' | 'below' | 'left' | 'right'; fit: CanvasFit; layer: Layer }[] = [];
    calloutLeaders = new Map();
    for (const element of elements) {
      if (element.exit !== null && tq >= element.exit.end) continue;
      if (!element.carried && (element.enter === null || tq < element.enter.start)) continue;
      const style = styleAt(element, tq);
      if (style.near === null && element.parent === null) continue;
      const exit = exitOf(element);
      const pose = poseAt(element.key, tq, exit === null ? null : exit.start);
      if (pose === null) continue;
      const ps = planeScale(pose.layer, viewport);
      const w = pose.width * ps;
      const h = pose.height * ps;
      const fit = fitOfElement(element, look);
      if (style.near === null) {
        // Words that are a part of a group (`say in=<group>`) stand where the group's own units put them, and go with it.
        const group = element.parent === null ? undefined : drawnByKey.get(element.parent);
        const m = group === undefined ? null : groupMatrixAt(group, schedule, tq);
        if (m === null) continue;
        const local = typeof style.at === 'object' && style.at !== null ? style.at : { x: 0, y: 0 };
        const wx = m.a * local.x + m.c * local.y + m.e;
        const wy = m.b * local.x + m.d * local.y + m.f;
        const halfX = viewport.width / 2 - edge - w / 2;
        const halfY = viewport.height / 2 - edge - h / 2;
        const cx = Math.max(-halfX, Math.min(halfX, fit.box.x + wx * fit.unit));
        const cy = Math.max(-viewport.height / 2 + topEdge + h / 2, Math.min(halfY, fit.box.y + wy * fit.unit));
        out.set(element.key, { x: cx / ps, y: cy / ps });
        continue;
      }
      let target = drawnLive(style.near.id, tq);
      if (CALLOUTS_READY && style.leader && target !== null) {
        // a label with a line to the part it names is placed with the others of its drawing: no two leaders cross, no label sits on a stroke
        const box = canvasBoxOf(target, schedule, tq);
        if (box !== null) {
          callouts.push({ key: element.key, ps, w, h, target: toScreenRect(box, fitOfElement(target, look)), side: style.near.side, fit, layer: pose.layer });
          continue;
        }
      }
      // The thing it names has gone: the label keeps the place beside where it last stood, instead of falling to the middle of the stage.
      let seenAt = tq;
      if (target === null) {
        for (let i = drawn.length - 1; i >= 0 && target === null; i -= 1) {
          const candidate = drawn[i];
          if (candidate !== undefined && candidate.id === style.near.id && candidate.kind !== 'field' && candidate.exit !== null && candidate.exit.end <= tq) target = candidate;
        }
        if (target === null) continue;
        seenAt = Math.max(0, (target.exit?.end ?? tq) - 1e-3);
      }
      const box = canvasBoxOf(target, schedule, seenAt);
      if (box === null) continue;
      const targetRect = toScreenRect(box, fitOfElement(target, look));
      const region: Rect = { x: fit.box.x, y: fit.box.y, w: fit.box.width, h: fit.box.height };
      // One body line away, measured to where the label's letters are: its box has leading above and below them.
      const gap = cell.height * 0.6;
      buildObstacles();
      const family = new Set<ElementSpan>([target]);
      for (const other of drawn) if (other.parent === target.key) family.add(other);
      seedText();
      const chosen = placeLabel({
        w,
        h,
        target: targetRect,
        region,
        side: style.near.side,
        gap,
        step: cell.width,
        pad: cell.width,
        taken,
        outer: { x: -viewport.width / 2 + edge, y: -viewport.height / 2 + topEdge, w: viewport.width - 2 * edge, h: viewport.height - topEdge - edge },
        obstacles: obstacles.filter((obstacle) => !family.has(obstacle.owner)).map((obstacle) => ({ rect: obstacle.rect, outline: obstacle.outline })),
      });
      taken.push({ x: chosen.x - w / 2, y: chosen.y - h / 2, w, h });
      out.set(element.key, { x: chosen.x / ps, y: chosen.y / ps });
    }
    if (callouts.length > 0) {
      buildObstacles();
      seedText();
      const first = callouts[0] as (typeof callouts)[number];
      const region: Box = { x: first.fit.box.x, y: first.fit.box.y, width: first.fit.box.width, height: first.fit.box.height };
      const outerX = -viewport.width / 2 + edge;
      const outerY = -viewport.height / 2 + topEdge;
      const room: Box = { x: Math.max(region.x, outerX), y: Math.max(region.y, outerY), width: Math.min(region.x + region.width, viewport.width / 2 - edge) - Math.max(region.x, outerX), height: Math.min(region.y + region.height, viewport.height / 2 - edge) - Math.max(region.y, outerY) };
      const targets = new Set(callouts.map((callout) => callout.key));
      // the drawing the labels are about: everything drawn that is not a label, and every stroke of it, which no leader may cross but at its target
      let fx0 = Number.POSITIVE_INFINITY;
      let fy0 = Number.POSITIVE_INFINITY;
      let fx1 = Number.NEGATIVE_INFINITY;
      let fy1 = Number.NEGATIVE_INFINITY;
      for (const rect of [...obstacles.map((o) => o.rect), ...callouts.map((c) => c.target)]) {
        fx0 = Math.min(fx0, rect.x);
        fy0 = Math.min(fy0, rect.y);
        fx1 = Math.max(fx1, rect.x + rect.w);
        fy1 = Math.max(fy1, rect.y + rect.h);
      }
      const strokes: { points: { x: number; y: number }[]; closed: boolean }[] = [];
      for (const element of drawn) {
        if (element.kind !== 'shape' || element.figure?.kind !== 'shape' || !isLiveAt(element, tq)) continue;
        const fit = fitOfElement(element, look);
        for (const line of outlineOf(element.figure.geometry)) strokes.push({ closed: line.closed, points: line.points.map((p) => ({ x: fit.box.x + p.x * fit.unit, y: fit.box.y + p.y * fit.unit })) });
      }
      const body = cell.height;
      const input: CalloutInput = {
        labels: callouts.map((callout) => ({ key: callout.key, size: { width: callout.w, height: callout.h }, target: { x: callout.target.x, y: callout.target.y, width: callout.target.w, height: callout.target.h }, side: callout.side })),
        figure: { x: fx0, y: fy0, width: Math.max(1, fx1 - fx0), height: Math.max(1, fy1 - fy0) },
        room,
        obstacles: taken.map((rect) => ({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })),
        strokes,
        look: { body, minShrink: 0.7, stroke: look.stroke.thick * first.fit.unit, radius: 0, grid: null },
      };
      const signature = JSON.stringify([input.labels.map((l) => [l.key, Math.round(l.size.width), Math.round(l.size.height), l.target, l.side]), input.figure, room, input.obstacles.length, strokes.length, body, look.id].map((part) => (typeof part === 'object' ? JSON.parse(JSON.stringify(part, (_k, v) => (typeof v === 'number' ? Math.round(v * 2) / 2 : v))) : part)));
      let laid = calloutMemo.get(signature);
      if (laid === undefined) {
        try {
          laid = layoutCallouts(input);
        } catch {
          laid = { boxes: new Map(), leaders: new Map(), notes: [] };
        }
        calloutMemo.set(signature, laid);
        if (calloutMemo.size > 80) calloutMemo.delete(calloutMemo.keys().next().value as string);
      }
      void targets;
      for (const callout of callouts) {
        const placed = laid.boxes.get(callout.key);
        if (placed !== undefined) out.set(callout.key, { x: (placed.x + placed.width / 2) / callout.ps, y: (placed.y + placed.height / 2) / callout.ps });
        const leader = laid.leaders.get(callout.key);
        if (leader !== undefined) calloutLeaders.set(callout.key, { points: leader.points.map((p) => ({ x: p.x / callout.ps, y: p.y / callout.ps })), closed: leader.closed, layer: callout.layer });
      }
    }
    return out;
  };

  interface Poly {
    readonly points: readonly { x: number; y: number }[];
    readonly box: Rect;
  }
  const insidePolygon = (points: readonly { x: number; y: number }[], x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const a = points[i];
      const b = points[j];
      if (a === undefined || b === undefined) continue;
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const segmentHitsRect = (a: { x: number; y: number }, b: { x: number; y: number }, r: Rect): boolean => {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const edges: [number, number][] = [
      [-dx, a.x - r.x],
      [dx, r.x + r.w - a.x],
      [-dy, a.y - r.y],
      [dy, r.y + r.h - a.y],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return false;
      } else {
        const t = q / p;
        if (p < 0) {
          if (t > t1) return false;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return false;
          if (t < t1) t1 = t;
        }
      }
    }
    return true;
  };
  const polygonHitsRect = (poly: Poly, r: Rect): boolean => {
    if (!hitRects(poly.box, r, 0)) return false;
    const pts = poly.points;
    if (insidePolygon(pts, r.x + r.w / 2, r.y + r.h / 2) || insidePolygon(pts, r.x, r.y) || insidePolygon(pts, r.x + r.w, r.y) || insidePolygon(pts, r.x, r.y + r.h) || insidePolygon(pts, r.x + r.w, r.y + r.h)) return true;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a === undefined || b === undefined) continue;
      if (segmentHitsRect(a, b, r)) return true;
    }
    return false;
  };

  /** Something filled, a sprite or a painting that text may be laid over, in the reading plane's units. */
  interface Backing {
    readonly layer: Layer;
    readonly z: number;
    /** whether a line box lies over it */
    hits(rect: Rect): boolean;
    /** the colours that can lie behind a line box, worst first needed; null for a painting, whose colours are not known */
    behind(rect: Rect): readonly Colour[] | null;
  }
  const polygonsOf = (lines: readonly { points: readonly { x: number; y: number }[] }[], m: { a: number; b: number; c: number; d: number; e: number; f: number }, ps: number): Poly[] => {
    const polygons: Poly[] = [];
    for (const line of lines) {
      if (line.points.length < 3) continue;
      const points = line.points.map((q) => ({ x: (m.a * q.x + m.c * q.y + m.e) * ps, y: (m.b * q.x + m.d * q.y + m.f) * ps }));
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const q of points) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x);
        maxY = Math.max(maxY, q.y);
      }
      polygons.push({ points, box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } });
    }
    return polygons;
  };

  const backingsOf = (figures: readonly FigureFrame[], look: LookSpec): Backing[] => {
    const out: Backing[] = [];
    const ground = look.roles.ground;
    for (const figure of figures) {
      const ps = planeScale(figure.layer, viewport);
      if (figure.kind === 'shape') {
        if (figure.fill === null) continue;
        const fill = figure.fill;
        const alpha = fill.opacity * figure.opacity;
        if (alpha < 0.05) continue;
        const outlines = polygonsOf(figure.outline, figure.transform, ps);
        if (outlines.length === 0) continue;
        // A gradient runs top to bottom of the box the shape would have had; what is behind a line is the colour at that height.
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (const poly of outlines) {
          top = Math.min(top, poly.box.y);
          bottom = Math.max(bottom, poly.box.y + poly.box.h);
        }
        // `rect full` is drawn over the whole screen, whatever its outline says.
        const reach = Math.max(viewport.width, viewport.height) * 3;
        const polygons: Poly[] = figure.bleed
          ? [{ points: [{ x: -reach, y: -reach }, { x: reach, y: -reach }, { x: reach, y: reach }, { x: -reach, y: reach }], box: { x: -reach, y: -reach, w: 2 * reach, h: 2 * reach } }]
          : outlines;
        const colourAt = (y: number): Colour => {
          if (fill.to === null) return mixHex(ground, fill.colour, alpha);
          const t = bottom > top ? clamp01((y - top) / (bottom - top)) : 0;
          return mixHex(ground, mixHex(fill.colour, fill.to, t), alpha);
        };
        out.push({
          layer: figure.layer,
          z: figure.z,
          hits: (rect) => polygons.some((poly) => polygonHitsRect(poly, rect)),
          behind: (rect) => (fill.to === null ? [colourAt(rect.y)] : [colourAt(rect.y), colourAt(rect.y + rect.h)]),
        });
      } else if (figure.kind === 'sprite') {
        if (figure.opacity < 0.05) continue;
        const m = figure.transform;
        const w = (figure.cols * figure.cell) / 2;
        const h = (figure.rows * figure.cell) / 2;
        const corner = (x: number, y: number): { x: number; y: number } => ({ x: (m.a * x + m.c * y + m.e) * ps, y: (m.b * x + m.d * y + m.f) * ps });
        const quad = (x0: number, y0: number, x1: number, y1: number): Poly => {
          const points = [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)];
          const xs = points.map((q) => q.x);
          const ys = points.map((q) => q.y);
          return { points, box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
        };
        const whole = quad(-w, -h, w, h);
        out.push({
          layer: figure.layer,
          z: figure.z,
          hits: (rect) => polygonHitsRect(whole, rect),
          behind: (rect) => {
            // The cells under the line, and the bare ground between them.
            const found = new Set<Colour>([ground]);
            figure.cells.forEach((cell, index) => {
              if (cell === null) return;
              const c = index % figure.cols;
              const r = Math.floor(index / figure.cols);
              const x0 = -w + c * figure.cell;
              const y0 = -h + r * figure.cell;
              if (polygonHitsRect(quad(x0, y0, x0 + figure.cell, y0 + figure.cell), rect)) found.add(mixHex(ground, cell, figure.opacity));
            });
            return [...found];
          },
        });
      } else {
        if (figure.develop < 0.05 || figure.src === null) continue;
        const b = figure.box;
        const polygons = polygonsOf([{ points: [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }] }], figure.transform, ps);
        out.push({ layer: figure.layer, z: figure.z, hits: (rect) => polygons.some((poly) => polygonHitsRect(poly, rect)), behind: () => null });
      }
    }
    return out;
  };

  /** The plate an element needs where it lies over drawn things, and the colours behind its words once the plate is on. */
  const backdropFor = (frame: ElementFrame, look: LookSpec, backings: readonly Backing[]): { plate: number; behind: Colour[] } | null => {
    if (backings.length === 0 || frame.mark === 'invert') return null;
    const ps = planeScale(frame.layer, viewport);
    const lineRects: Rect[] = frame.lines.map((line) => ({ x: (frame.x + line.x) * ps, y: (frame.y + line.y) * ps, w: line.width * ps, h: line.height * ps }));
    const colours = [...new Set(frame.runs.filter((run) => run.opacity > 0.5 && run.reveal > 0).map((run) => run.colour))];
    if (colours.length === 0) return null;
    const px = frame.fontSize * ps * frame.scale;
    const ground = look.roles.ground;
    let best: { plate: number; behind: Colour[]; floor: number } | null = null;
    for (const backing of backings) {
      if (LAYER_ORDER[backing.layer] > LAYER_ORDER[frame.layer] || (backing.layer === frame.layer && backing.z >= frame.z)) continue;
      let plate = 0;
      let floor = Number.POSITIVE_INFINITY;
      const unders: Colour[] = [];
      let touched = false;
      // Each line is judged against what is behind it at its own height.
      for (const rect of lineRects) {
        if (!backing.hits(rect)) continue;
        touched = true;
        const behind = backing.behind(rect);
        for (const text of colours) {
          for (const under of behind ?? [text]) {
            plate = Math.max(plate, plateFor(text, under, ground, px));
            floor = Math.min(floor, contrastRatio(text, under));
            unders.push(under);
          }
        }
      }
      if (!touched) continue;
      if (best === null || plate > best.plate + 1e-9 || (plate === best.plate && floor < best.floor)) best = { plate, behind: unders, floor };
    }
    if (best === null) return null;
    return { plate: best.plate, behind: [...new Set(best.behind.map((under) => mixHex(under, ground, best.plate)))] };
  };

  // A sprite whose colours would vanish into the ground is given a tile to stand on ----------
  const MIN_SPRITE_RATIO = 1.5;
  /** a colour closer to the ground than this (red or sky blue on paper, say) is a near miss and also gets the tile */
  const NEAR_MISS_RATIO = 3;
  const tileColours = new Map<string, Colour | null>();
  /** The surface a sprite with these colours stands on in this look, or null when it needs none: the least conspicuous one that keeps every colour clear of it. */
  const tileFor = (colours: readonly Colour[], look: LookSpec): Colour | null => {
    const grounds = look.groundAlt === null ? [look.roles.ground] : [look.roles.ground, look.groundAlt];
    const against = (cell: Colour, surfaces: readonly Colour[]): number => Math.min(...surfaces.map((surface) => contrastRatio(cell, surface)));
    const standard = spriteBacking(colours, look);
    if (standard !== null) return standard;
    if (colours.length === 0 || colours.every((cell) => against(cell, grounds) >= NEAR_MISS_RATIO)) return null;
    const key = `${specIds.get(look) ?? look.id}|${colours.join(',')}`;
    const known = tileColours.get(key);
    if (known !== undefined) return known;
    // Quiet surfaces first (the ground sliding into the ink); a hue only when no neutral keeps every colour apart.
    const neutrals: Colour[] = [];
    for (let step = 0; step <= 10; step += 1) neutrals.push(mapToGamut(mixHex(look.roles.ground, look.roles.ink, step / 10), look));
    const hues: Colour[] = [mapToGamut(look.roles.accent, look), mapToGamut(look.roles.alt, look)];
    let chosen: Colour | null = null;
    let bestAny: Colour | null = null;
    let bestAnyScore = -1;
    for (const group of [neutrals, hues]) {
      let chosenHold = Number.POSITIVE_INFINITY;
      for (const candidate of group) {
        const score = Math.min(...colours.map((cell) => contrastRatio(cell, candidate)));
        if (score > bestAnyScore) {
          bestAnyScore = score;
          bestAny = candidate;
        }
        if (score < MIN_SPRITE_RATIO) continue;
        const hold = against(candidate, grounds);
        if (hold < chosenHold) {
          chosenHold = hold;
          chosen = candidate;
        }
      }
      if (chosen !== null) break;
    }
    const made = chosen ?? bestAny;
    tileColours.set(key, made);
    return made;
  };
  const tilesFor = (figures: readonly FigureFrame[], look: LookSpec): ShapeFrame[] => {
    const tiles: ShapeFrame[] = [];
    for (const figure of figures) {
      if (figure.kind !== 'sprite' || figure.opacity <= 0) continue;
      const owner = drawnByKey.get(figure.key.split('/').pop() ?? figure.key);
      const sprite = owner?.figure;
      if (sprite === undefined || sprite === null || sprite.kind !== 'sprite') continue;
      const tile = tileFor(spriteColours(sprite.sprite, look), look);
      if (tile === null) continue;
      const pad = figure.cell * 0.5;
      const w = (figure.cols * figure.cell) / 2 + pad;
      const h = (figure.rows * figure.cell) / 2 + pad;
      tiles.push({
        kind: 'shape',
        key: `tile:${figure.key}`,
        id: figure.id,
        layer: figure.layer,
        z: figure.z - 0.0005,
        outline: [{ points: [{ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }], closed: true }],
        geometryKey: `tile:${figure.key}:${figure.cols}x${figure.rows}:${figure.cell}`,
        transform: figure.transform,
        fill: { colour: tile, to: null, opacity: 1 },
        stroke: null,
        opacity: figure.opacity,
        bleed: false,
        tappable: false,
      });
    }
    return tiles;
  };

  const compute = (instant: TimelineInstant): { frame: Frame; views: StageElementView[]; sites: ControlSite[] } => {
    const look = specAt(instant.time);
    const stepLook = look.motion;
    const tq = quantise(instant.time, stepLook.step);
    const aq = quantise(instant.ambient, stepLook.step);
    const drawLook = specAt(tq);
    const mood = moodAt(instant.time, drawLook);
    const pair = moodPair(instant.time, drawLook);
    const nowScene = sceneAt(schedule, tq);
    const fit = fitOfScene(nowScene, drawLook);

    const moves: readonly CameraSpan[] = schedule.camera;
    const camera = cameraAt(moves, instant.time, instant.ambient, {
      viewport,
      mood,
      sway: swayPartsAt(instant.time, drawLook, pair),
      reducedMotion,
      step: drawLook.motion.cameraStep,
      centreOf: (key, time) => {
        const target = drawnByKey.get(key);
        if (target !== undefined) {
          const box = canvasBoxOf(target, schedule, time);
          if (box === null) return null;
          const c = canvasToStage({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, fitOfElement(target, drawLook), target.style.layer, viewport);
          return { x: c.x, y: c.y };
        }
        const pose = poseAt(key, time, null);
        return pose === null ? null : { x: pose.x, y: pose.y };
      },
      sizeOf: (key, time) => {
        const target = drawnByKey.get(key);
        if (target === undefined) return null;
        const box = canvasBoxOf(target, schedule, time);
        if (box === null) return null;
        const f = fitOfElement(target, drawLook);
        return { width: box.w * f.unit, height: box.h * f.unit };
      },
      isDrawn: (key) => drawnByKey.has(key),
      hasPicture: hasPictureAt,
      sceneIndexAt: (time) => sceneAt(schedule, time).index,
      roomAt,
      fits,
      sceneLean: sceneLeanAt,
      sceneStartAt: (time) => sceneAt(schedule, time).start,
    });

    const fault = onFault ?? null;
    const drawnFigures = figuresAt(boundSchedule(schedule, tq, aq, context.controls), base, tq, aq, { viewport, look: drawLook, camera, fit, reducedMotion, paintings, flashAllowed: allowedFlashes, ...(fault === null ? {} : { onFault: fault }) });
    // A sprite whose colours would vanish into the ground stands on a tile.
    const tiles = tilesFor(drawnFigures.figures, drawLook);
    const figs =
      tiles.length === 0
        ? drawnFigures
        : { ...drawnFigures, figures: [...drawnFigures.figures, ...tiles].sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] || a.z - b.z) };
    let loose: Map<string, { x: number; y: number }>;
    try {
      loose = placeLoose(tq, drawLook);
    } catch (error) {
      if (fault === null) throw error;
      fault(error, 'labels');
      loose = new Map();
    }
    const backings = elements.length === 0 ? [] : backingsOf(figs.figures, drawLook);

    const evaluated: Evaluated[] = [];
    for (const element of elements) {
      try {
        const done = evaluate(element, tq, aq, drawLook, camera, loose.get(element.key) ?? null);
        if (done === null) continue;
        const backdrop = backdropFor(done.frame, drawLook, backings);
        if (backdrop === null) {
          evaluated.push(done);
          continue;
        }
        const frame: ElementFrame = { ...done.frame, plate: backdrop.plate };
        const judged = judge(frame, drawLook, backdrop.behind);
        const view: StageElementView = { ...done.view, colour: judged.colour, contrast: Number.isFinite(judged.worst) ? judged.worst : 21 };
        evaluated.push({ ...done, frame, view });
      } catch (error) {
        // One element that cannot be made is left out of the frame; the rest of the stage goes on.
        if (fault === null) throw error;
        fault(error, element.key);
      }
    }
    const order = (frame: ElementFrame): number => byKey.get(frame.key)?.order ?? 0;
    evaluated.sort((a, b) => LAYER_ORDER[a.frame.layer] - LAYER_ORDER[b.frame.layer] || order(a.frame) - order(b.frame));

    // The line from each callout to the part it names, drawn with the label and as faint as it.
    const leaderFigures: ShapeFrame[] = [];
    for (const [key, leader] of calloutLeaders) {
      const item = evaluated.find((candidate) => candidate.frame.key === key);
      if (item === undefined || item.frame.opacity <= 0.01 || leader.points.length < 2) continue;
      leaderFigures.push({
        kind: 'shape',
        key: `${key}/leader`,
        id: item.frame.id,
        layer: leader.layer,
        z: item.frame.z - 0.001,
        outline: [{ points: leader.points, closed: leader.closed }],
        geometryKey: `leader:${key}:${leader.points.map((p) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`).join(';')}`,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        fill: null,
        stroke: { colour: drawLook.roles.dim, width: Math.max(1, drawLook.stroke.thick * fit.unit * 0.5) / planeScale(leader.layer, viewport), progress: 1, character: drawLook.stroke.character },
        opacity: item.frame.opacity,
        bleed: false,
        tappable: false,
      });
    }

    // Cursor ---------------------------------------------------------------
    let cursor: Frame['cursor'] = null;
    const typingNow = evaluated.reduce<Evaluated['typing']>((best, item) => (item.typing !== null && (best === null || item.typing.start >= best.start) ? item.typing : best), null);
    const waiting = instant.clock === 'waiting' || instant.clock === 'holding';
    const emptyStage = evaluated.length === 0 && figs.figures.length === 0;
    if (typingNow !== null && drawLook.motion.cursor) {
      cursor = { layer: typingNow.layer, ...typingNow.cursor, colour: drawLook.roles.ink, lit: true, shape: drawLook.id === 'printout' ? 'head' : 'block' };
    } else if (waiting || (instant.clock === 'idle' && emptyStage)) {
      const own = drawLook.motion.waiting === 'cursor' && drawLook.motion.cursor;
      const next = epochs[epochIndexAt(tq)]?.arrangement.next;
      const safe = safeFrame(viewport, drawLook);
      const cellBox = cellOf('m', viewport, drawLook);
      // The waiting cursor blinks from the moment the hold began, so it is lit at once.
      const blinkFrom = waiting && instant.holdSince !== undefined ? quantise(instant.holdSince, drawLook.motion.step) : 0;
      const lit = reducedMotion || !own ? true : (Math.max(0, aq - blinkFrom) / drawLook.motion.blink) % 1 < 0.5;
      const shape: NonNullable<Frame['cursor']>['shape'] = own ? (drawLook.id === 'printout' ? 'head' : 'block') : 'dots';
      if (emptyStage && !own) {
        cursor = { layer: 'mid', x: safe.x, y: safe.y + safe.height - 2 * cellBox.height, width: cellBox.width * 3, height: cellBox.height, colour: drawLook.roles.dim, lit, shape };
      } else if (next !== undefined) {
        cursor = { layer: next.layer, x: next.x, y: next.y, width: own ? next.width : Math.max(next.width, cellBox.width * 3), height: next.height, colour: own ? drawLook.roles.ink : drawLook.roles.dim, lit, shape };
      }
    }

    let lookChange: Frame['lookChange'] = null;
    if (lockLook === null) {
      for (const span of schedule.looks) {
        if (tq >= span.start && tq < span.end) lookChange = { from: span.from, to: span.look, progress: clamp01((tq - span.start) / (span.end - span.start)) };
      }
    }

    let laid = structures.any ? structures.frames(tq, aq, drawLook) : null;
    const sites: ControlSite[] = [];
    if (controlSpans.length > 0) {
      const out: StructureFrames = laid ?? { elements: [], figures: [], owners: [] };
      for (const span of controlSpans) {
        const spec = controlSpecOf(span);
        if (spec === null) continue;
        const value = heldBy(runtime, span);
        const site = siteOf(span, tq, drawLook, moodOf(runtime, span.key), value);
        if (site === null) continue;
        const { layout, centre } = site;
        const box: Box = { x: centre.x - layout.width / 2, y: centre.y - layout.height / 2, width: layout.width, height: layout.height };
        const seen = out.owners.length;
        structures.renderOwner({ structure: span, owner: span, parts: placeParts(layout.parts, centre.x, centre.y), before: null, q: 1, epochStart: 0, ownerBox: box, tq, aq, look: drawLook, style: styleAt(boundElement(span, tq, aq, cindex, runtime).element, tq) }, out);
        const state = out.owners.length > seen ? out.owners[out.owners.length - 1] : undefined;
        if (state === undefined) continue;
        const z = layerZ(span.style.layer, viewport);
        const p = projectToScreen({ x: centre.x, y: centre.y, z }, camera, viewport);
        const input = controlInputOf({ span, value, mood: moodOf(runtime, span.key), maxWidth: controlRoom(span, site.fit), look: drawLook, viewport, fit: site.fit });
        if (input === null) continue;
        sites.push({ key: span.key, id: span.id, span, layout, input, value, layer: span.style.layer, centre, screen: { x: p.x, y: p.y, scale: p.scale }, enabled: state.phase === 'on' && state.opacity > 0.5 });
      }
      // the frame of each card that holds controls, round the column they stand in
      for (const group of schedule.elements) {
        const figure = group.figure;
        if (figure === null || figure.kind !== 'group' || figure.card === undefined) continue;
        const stack = stackOf(group, tq, drawLook);
        if (stack === null) continue;
        const card = layoutCard({ owner: group.key, title: figure.card.title, inner: stack.inner, measure: measurerFor(drawLook, viewport, group.style), look: lookOf(drawLook, viewport, stack.fit, stack.ps), lit: sites.some((site) => site.span.parent === group.key && (runtime.moods.get(site.key)?.hover === true || runtime.moods.get(site.key)?.focus === true)) });
        structures.renderOwner({ structure: group, owner: group, parts: card.parts, before: null, q: 1, epochStart: 0, ownerBox: card.outer, tq, aq, look: drawLook, style: styleAt(group, tq) }, out);
      }
      laid = out;
    }
    const laidFigures = laid === null && leaderFigures.length === 0 ? figs.figures : [...figs.figures, ...(laid === null ? [] : laid.figures), ...leaderFigures].sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] || a.z - b.z);
    const laidElements = laid === null ? evaluated.map((item) => item.frame) : [...evaluated.map((item) => item.frame), ...laid.elements].sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] || a.z - b.z);
    const laidViews: StageElementView[] = [];
    if (laid !== null) {
      for (const owner of laid.owners) {
        const ps = planeScale(owner.layer, viewport);
        const z = layerZ(owner.layer, viewport);
        const a = projectToScreen({ x: owner.box.x, y: owner.box.y, z }, camera, viewport);
        const b = projectToScreen({ x: owner.box.x + owner.box.width, y: owner.box.y + owner.box.height, z }, camera, viewport);
        const span = schedule.elements.find((element) => element.key === owner.key);
        void ps;
        laidViews.push({
          key: owner.key,
          id: owner.id,
          kind: owner.kind,
          text: span === undefined ? '' : span.figure === null ? span.text : describeFigure(span.figure),
          layer: owner.layer,
          phase: owner.phase,
          box: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
          fontPx: owner.fontPx * a.scale,
          colour: owner.colour,
          contrast: owner.contrast,
          painting: null,
          opacity: owner.opacity,
          tappable: owner.tappable,
        });
      }
    }
    const chartFrameList = context.charts === undefined ? undefined : chartFrames(schedule, tq, aq, drawLook, { viewport, reducedMotion, camera, kinds: context.charts.kinds, data: context.charts.data, scope: scopeOf([...cindex.ids], (id) => controlNamed(id, tq)), fitOf: (element) => fitOfElement(element, drawLook), avoid: (element) => wordsOfScene.get(element.scene) ?? [] });
    const frame: Frame = {
      ...(chartFrameList === undefined ? {} : { charts: chartFrameList }),
      time: instant.time,
      ambient: instant.ambient,
      wallTime: instant.wallTime,
      clock: instant.clock,
      viewport,
      look: drawLook.id,
      spec: drawLook,
      lookChange,
      bodySize: bodySize(viewport, drawLook),
      margin: marginOf(viewport, drawLook),
      canvas: { box: fit.box, unit: fit.unit },
      gridTop: safeFrame(viewport, drawLook).y,
      ground: drawLook.roles.ground,
      camera,
      agitation: reducedMotion ? 0 : mood.agitation,
      dim: mood.dim,
      reducedMotion,
      elements: laidElements,
      figures: laidFigures,
      fields: figs.fields,
      cursor,
    };
    for (const chart of chartFrameList ?? []) {
      const span = schedule.elements.find((element) => element.key === chart.key);
      laidViews.push({ key: chart.key, id: chart.id, kind: 'structure', text: span?.figure == null ? '' : describeFigure(span.figure), layer: chart.layer, phase: chart.state.interactive ? 'on' : 'entering', box: chart.box, fontPx: chart.state.theme.fontPx, colour: chart.state.theme.ink, contrast: 21, painting: null, opacity: chart.opacity, tappable: false });
    }
    const drawnViews = laidViews.length === 0 ? figs.views : [...figs.views.filter((view) => !laidViews.some((laidView) => laidView.key === view.key)), ...laidViews];
    return { frame, views: [...evaluated.map((item) => item.view), ...drawnViews], sites };
  };

  // The same instant asked of twice (a frame, then a pointer, then the snapshot) is made once, while nothing the hand holds has changed.
  let last: { readonly instant: TimelineInstant; readonly version: number; readonly revision: number; readonly made: ReturnType<typeof compute> } | null = null;
  const cached = (instant: TimelineInstant): ReturnType<typeof compute> => {
    if (last !== null && last.version === runtime.version && last.revision === runtime.store.revision && last.instant.time === instant.time && last.instant.ambient === instant.ambient && last.instant.wallTime === instant.wallTime && last.instant.clock === instant.clock && last.instant.holdSince === instant.holdSince) return last.made;
    const made = compute(instant);
    last = { instant, version: runtime.version, revision: runtime.store.revision, made };
    return made;
  };
  const reactive = schedule.elements.some((element) => {
    const figure = element.figure;
    if (element.kind === 'node' || element.kind === 'structure') return element.text.includes('{') || (figure?.kind === 'structure' && figure.rows.some((row) => row.cells.some((cell) => cell.includes('{'))));
    return false;
  });

  const retired = new Map<string, number>();
  for (const element of elements) {
    const extra = forced.get(element.key);
    if (extra !== undefined && (element.exit === null || extra.start < element.exit.start)) retired.set(element.key, extra.start);
  }

  return {
    schedule,
    viewport,
    paintings,
    specAt,
    retired,
    lastLayoutChange: structures.lastChange,
    layoutNotesAt: structures.notesAt,
    frameAt: (instant) => cached(instant).frame,
    viewsAt: (instant) => cached(instant).views,
    controlsAt: (instant) => cached(instant).sites,
    reactive,
    onStageAt: (time) =>
      schedule.elements
        .filter((element) => {
          if (!element.carried && (element.enter === null || element.enter.start > time)) return false;
          const exit = exitOf(element);
          return exit === null || exit.start > time;
        })
        .map((element) => element.key),
  };
}

export type { ElementChange };

/**
 * The moment the last layout change of the schedule has finished easing: when
 * the last thing arrived or left, the rest took 0.4 s x the mood's `snap` to
 * move to their new places. The schedule's `end` knows nothing of that.
 */
export function settledAfter(timeline: Timeline, lockLook: LookId | null, fallbackMood: Mood): number {
  const schedule = timeline.schedule;
  let last = 0;
  const note = (time: number): void => {
    if (time > last) last = time;
  };
  for (const scene of schedule.scenes) {
    note(scene.start);
    for (const item of scene.expected) note(item.at);
  }
  for (const element of schedule.elements) {
    if (element.kind !== 'text') continue;
    if (element.enter !== null) note(element.enter.start);
    if (element.exit !== null) note(element.exit.start);
    for (const change of element.changes) {
      if (change.kind !== 'set') continue;
      const p = change.props;
      if (p.size !== undefined || p.layer !== undefined || p.at !== undefined || p.case !== undefined || p.mark !== undefined) note(change.start);
    }
  }
  if (lockLook === null) for (const span of schedule.looks) note((span.start + span.end) / 2);
  for (const time of timeline.retired.values()) note(time);
  note(timeline.lastLayoutChange);
  if (last <= 0) return 0;
  const look = timeline.specAt(last);
  const scene = sceneAt(schedule, last);
  const now = valueAt(scene.mood, last, fallbackMood);
  const before = valueAt(scene.mood, Math.max(0, last - MOOD_SECONDS), fallbackMood);
  const snap = Math.max(look.mood[now].snap, look.mood[before].snap);
  return last + SETTLE_SECONDS * snap;
}

/** When a turn has finished and everything has come to rest: the schedule's end, or later if the layout was still easing. */
export function settledEnd(timeline: Timeline, lockLook: LookId | null, fallbackMood: Mood): number {
  return Math.max(timeline.schedule.end, settledAfter(timeline, lockLook, fallbackMood));
}
