// A figure on the stage: the figure kit's pure engine (`blocks/figure`) laid out and drawn as finished frames, the way a
// mock-up is (`ui-stage.ts`): the rows of the `figure` structure are its own lines (parts, routes, steps), read by the language's `readFigure`.
//
//   rows of the structure  ->  readFigure  ->  layoutFigure in the room  ->  paintFigure  ->  DrawnFrames
//
// What a hand has done to a figure (the step it is at) is kept here, by the structure's key, as a control's value is the control's. A press on the
// stepper's two regions (or the keys) moves it; nothing is told to the mind.

import { readFigure } from '@conduit/language';
import type { ElementSpan, FigureHold } from '@conduit/language';
import type { DrawnFrames, StructureLayout } from '../contracts/blocks';
import { EMPTY_STRUCTURE_LAYOUT } from '../contracts/blocks';
import type { ElementFrame, FigureFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import type { Box, Viewport } from '../contracts/space';
import { cellOf } from './layout/metrics';
import { foldText } from '../fonts/fold';
import { prefixEm } from '../fonts/measure';
import { layoutFigure, paintFigure } from './blocks/figure';
import type { FigureEnv, FigureInput, FigureKeep, FigureLayout } from './blocks/figure';

const STEPS = new Map<string, number>();
const LASTS = new Map<string, { readonly room: Box; readonly layout: FigureLayout }>();
/** what each layout made here was laid out in and as: a layout the cache hands back again is still known by it */
const LAID = new WeakMap<StructureLayout, { readonly room: Box; readonly layout: FigureLayout }>();

/** The layout a figure's plan ends in is the one that stands (its stepper is what a press is tried against, and `__figures` says how it is set): noted for the key, whether it was just made or remembered. */
export function noteFigure(key: string, laid: StructureLayout): void {
  const known = LAID.get(laid);
  if (known !== undefined) LASTS.set(key, known);
}

// the page's test hook (`__stage` is the painter's; this is the figure's): where each stepper is, so a driver can press it with real events
(globalThis as { __figures?: unknown }).__figures = LASTS;

export const isFigureBlock = (span: ElementSpan): boolean => span.figure?.kind === 'structure' && span.figure.structure === 'figure';

/** The step a hand has the figure at (0: rest), and how it was set a turn ago when it is gone on with, as part of the layout's cache key. */
export const figureKey = (key: string, held?: FigureHold): string => `s${STEPS.get(key) ?? 0}${held === undefined ? '' : `h${held.scale.toFixed(4)},${held.offset.x.toFixed(1)},${held.offset.y.toFixed(1)}`}`;

function measureOf(): FigureEnv['measure'] {
  return (text, px, bold) => {
    const folded = foldText(text);
    return (prefixEm(folded, 'sans', bold ? 'bold' : 'normal')[folded.length] ?? 0) * px;
  };
}

/** The figure an element's rows draw. */
export function figureOf(structure: ElementSpan): FigureInput {
  const figure = structure.figure;
  const rows = figure?.kind === 'structure' ? figure.rows.map((row) => row.cells[0] ?? '') : [];
  const mode = figure?.kind === 'structure' ? (figure.mode ?? 'plain') : 'plain';
  return readFigure(structure.id, structure.text, mode, rows).input;
}

/** How a figure that is gone on with was set a turn ago, when it can be set so again: the same screen and the same size of room. Otherwise the kit fits it afresh. */
function keepOf(held: FigureHold | undefined, size: { readonly width: number; readonly height: number }, viewport: Viewport | undefined): FigureKeep | undefined {
  if (held === undefined || viewport === undefined || held.view.width !== viewport.width || held.view.height !== viewport.height) return undefined;
  if (Math.abs(held.size.width - size.width) > 0.5 || Math.abs(held.size.height - size.height) > 0.5) return undefined;
  return { scale: held.scale, offset: held.offset };
}

function layoutOf(structure: ElementSpan, size: { readonly width: number; readonly height: number }, spec: LookSpec, viewport: Viewport | undefined): FigureLayout {
  const input = figureOf(structure);
  const step = Math.max(0, Math.min(input.steps.length, STEPS.get(structure.key) ?? 0));
  const env: FigureEnv = {
    measure: measureOf(),
    floor: spec.type.minFont,
    ...(viewport === undefined ? {} : { body: cellOf('m', viewport, spec).fontSize, small: cellOf('s', viewport, spec).fontSize }),
    look: { ground: spec.roles.ground, ink: spec.roles.ink, dim: spec.roles.dim, accent: spec.roles.accent, alt: spec.roles.alt, gamut: spec.gamut },
  };
  return layoutFigure(input, { step }, size, env, keepOf(structure.held, size, viewport));
}

/**
 * How the figure rests in the room the stage plan gave it (`room`, the plan's own units), for the report that closes a turn: what the next turn of the scene keeps the drawing by
 * (`FigureHold`). Null when the room is too small to draw in.
 */
export function figureHoldOf(args: { readonly structure: ElementSpan; readonly room: Box; readonly planeScale: number; readonly spec: LookSpec; readonly viewport: Viewport }): FigureHold | null {
  const { structure, room, planeScale, spec, viewport } = args;
  const size = { width: room.width / planeScale, height: room.height / planeScale };
  if (size.width < 120 || size.height < 120) return null;
  const layout = layoutOf(structure, size, spec, viewport);
  return { room: { x: room.x, y: room.y, width: room.width, height: room.height }, view: { width: viewport.width, height: viewport.height }, size, scale: layout.scale, offset: layout.offset };
}

export function layoutFigureBlock(args: { readonly structure: ElementSpan; readonly room: Box; readonly spec: LookSpec; readonly viewport?: Viewport }): StructureLayout {
  const { structure, room, spec, viewport } = args;
  if (room.width < 120 || room.height < 120) return { ...EMPTY_STRUCTURE_LAYOUT, boxes: new Map([[structure.key, room]]) };
  const layout = layoutOf(structure, { width: room.width, height: room.height }, spec, viewport);
  const painted = paintFigure(layout, { ambient: 0, motion: false });
  const base = structure.order + 1;
  const prefix = `${structure.key}/`;
  const figures: FigureFrame[] = painted.figures.map((figure) => ({ ...figure, key: prefix + figure.key, z: Math.min(8999, base + figure.z), transform: { ...figure.transform, e: figure.transform.e + room.x, f: figure.transform.f + room.y } }) as FigureFrame);
  const elements: ElementFrame[] = painted.elements.map((element) => ({ ...element, key: prefix + element.key, z: Math.min(8999, base + element.z), x: element.x + room.x, y: element.y + room.y }));
  const drawn: DrawnFrames = { figures, elements, rowOf: new Map(), fontPx: Math.min(layout.labelPx, layout.chrome.px) };
  const result: StructureLayout = { boxes: new Map([[structure.key, room]]), parts: [], routes: new Map(), notes: [], shrink: 1, drawn };
  LAID.set(result, { room, layout });
  return result;
}

/**
 * A finger down on a figure's stepper at stage point (x, y): the step moves, and the answer says whether it did. The figure it is on is the one
 * whose room holds the point and whose stepper's regions (44 points at the least) hold it.
 */
export function pressFigure(blocks: readonly string[], x: number, y: number): boolean {
  for (const key of blocks) {
    const last = LASTS.get(key);
    const stepper = last?.layout.chrome.stepper;
    if (last === undefined || stepper === null || stepper === undefined) continue;
    const inBox = (b: { x: number; y: number; width: number; height: number }): boolean => x - last.room.x >= b.x && x - last.room.x <= b.x + b.width && y - last.room.y >= b.y && y - last.room.y <= b.y + b.height;
    const at = STEPS.get(key) ?? 0;
    const most = last.layout.input.steps.length;
    if (inBox(stepper.prev)) STEPS.set(key, Math.max(0, at - 1));
    else if (inBox(stepper.next)) STEPS.set(key, Math.min(most, at + 1));
    else continue;
    return true;
  }
  return false;
}

/** The step the keys move a figure to (`first`, `less`, `more`, `last`); false when no figure stands. */
export function keyFigure(blocks: readonly string[], key: 'first' | 'less' | 'more' | 'last'): boolean {
  for (const block of blocks) {
    const last = LASTS.get(block);
    if (last === undefined || last.layout.input.steps.length === 0) continue;
    const at = STEPS.get(block) ?? 0;
    const most = last.layout.input.steps.length;
    STEPS.set(block, key === 'first' ? 0 : key === 'last' ? most : Math.max(0, Math.min(most, at + (key === 'more' ? 1 : -1))));
    return true;
  }
  return false;
}
