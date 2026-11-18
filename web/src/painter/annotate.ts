// The brain's own picture of its draft. The stage as it will rest, with what a fix needs to name things on it drawn over: each
// element's id at its top-left corner, and a ruler of canvas units along the picture's top and left edges. It is made from a frame computed
// for the purpose and rasterised by itself, never drawn on the stage; a look that cannot spare the ink (its ground is too busy to read small
// marks on) gets the picture as it is.

import type { ElementSpan, Schedule } from '@conduit/language';
import type { ElementFrame, Frame, ShapeFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import type { Box } from '../contracts/space';
import { contrastRatio } from './colour';
import { setText } from './layout';
import type { SetText } from './layout';
import { placedOf } from './sight';
import type { Timeline } from './timeline';

/** The most element ids written on one picture: the largest things first. */
const MAX_LABELS = 36;
/** Canvas units between ruler ticks, and between the numbers on them. */
const TICK = 10;
const NUMBERED = 20;
const KINDS: ReadonlySet<string> = new Set(['shape', 'sprite', 'copy', 'picture', 'structure', 'group', 'control']);

function frameOfText(key: string, z: number, set: SetText, at: { x: number; y: number }, colour: string, spec: LookSpec): ElementFrame {
  const p = set.placement;
  return {
    key,
    id: key,
    layer: 'mid',
    z,
    face: spec.type.face,
    x: at.x + p.width / 2,
    y: at.y + p.height / 2,
    width: p.width,
    height: p.height,
    fontSize: p.fontSize,
    stretch: p.stretch,
    weight: 'normal',
    opacity: 1,
    scale: 1,
    rotation: 0,
    runs: p.runs.map((run) => ({ text: run.text, x: run.x, y: run.y, width: run.width, colour, opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 })),
    lines: p.lines,
    mark: 'none',
    markColour: colour,
    strike: 0,
    ghost: false,
    tappable: false,
    plate: 1,
  };
}

function line(key: string, z: number, a: { x: number; y: number }, b: { x: number; y: number }, colour: string, width: number): ShapeFrame {
  return {
    kind: 'shape',
    key,
    id: key,
    layer: 'mid',
    z,
    outline: [{ closed: false, points: [a, b] }],
    geometryKey: `${key}|${a.x}|${a.y}|${b.x}|${b.y}`,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    fill: null,
    stroke: { colour, width, progress: 1, character: 'clean' },
    opacity: 0.9,
    bleed: false,
    tappable: false,
  };
}

/**
 * `frame` with the ids and the ruler laid over it. `when` is the moment the frame was made for, on the timeline's clock: where each element
 * rests. Returns the frame unchanged when nothing on it has an id worth writing or the look's ink cannot be read against its ground.
 */
export function annotated(frame: Frame, timeline: Timeline, schedule: Schedule, when: number, spec: LookSpec): Frame {
  const ink = spec.roles.accent;
  if (contrastRatio(ink, spec.roles.ground) < 3) return frame;
  const style = schedule.elements.find((element) => element.kind === 'text')?.style ?? schedule.elements[0]?.style;
  if (style === undefined) return frame;
  const labelStyle = { ...style, size: 'xs' as const, weight: 'normal' as const, layer: 'mid' as const, case: 'asis' as const };
  const word = (text: string): SetText => setText({ look: spec, viewport: frame.viewport, text, emphasis: [], style: labelStyle, shrink: 1, maxWidth: 240, align: 'left' });
  const { box, unit } = frame.canvas;
  const toStage = (x: number, y: number): { x: number; y: number } => ({ x: box.x + x * unit, y: box.y + y * unit });
  const elements: ElementFrame[] = [];
  const figures: ShapeFrame[] = [];
  const z = 1_000_000;

  // the ruler
  const stroke = Math.max(1, unit * 0.12);
  const canvasW = box.width / unit;
  const canvasH = box.height / unit;
  for (let x = 0; x <= canvasW + 1e-6; x += TICK) {
    const long = x % NUMBERED === 0;
    figures.push(line(`ruler/x${x}`, z, toStage(x, 0), toStage(x, long ? 3 : 1.5), ink, stroke));
    if (long && x > 0) elements.push(frameOfText(`ruler/tx${x}`, z, word(String(x)), { x: toStage(x, 0).x + 2, y: toStage(x, 3).y }, ink, spec));
  }
  for (let y = 0; y <= canvasH + 1e-6; y += TICK) {
    const long = y % NUMBERED === 0;
    figures.push(line(`ruler/y${y}`, z, toStage(0, y), toStage(long ? 3 : 1.5, y), ink, stroke));
    if (long && y > 0) elements.push(frameOfText(`ruler/ty${y}`, z, word(String(y)), { x: toStage(3, y).x + 2, y: toStage(3, y).y - 6 }, ink, spec));
  }

  // the ids
  const byKey = new Map<string, ElementSpan>();
  for (const element of schedule.elements) byKey.set(element.key, element);
  const placed = placedOf(timeline, schedule, when, new Set(schedule.elements.map((element) => element.key)))
    .filter((item) => KINDS.has(item.kind) && byKey.get(item.key)?.exit === null)
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
    .slice(0, MAX_LABELS);
  const taken: Box[] = [];
  for (const item of placed) {
    const set = word(item.id);
    const at = toStage(item.box.x, item.box.y);
    const spot: Box = { x: at.x, y: at.y, width: set.placement.width, height: set.placement.height };
    // two ids on top of each other say nothing: the smaller one waits for a free corner or is left out
    const crowded = taken.some((other) => spot.x < other.x + other.width && spot.x + spot.width > other.x && spot.y < other.y + other.height && spot.y + spot.height > other.y);
    if (crowded) continue;
    taken.push(spot);
    elements.push(frameOfText(`id/${item.key}`, z, set, at, ink, spec));
  }
  return { ...frame, elements: [...frame.elements, ...elements], figures: [...frame.figures, ...figures] };
}
