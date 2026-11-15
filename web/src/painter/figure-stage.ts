// A figure on the stage (PLAN-visuals 2(a), FG2): the figure kit's pure engine (`blocks/figure`) laid out and drawn as finished frames, the way a
// mock-up is (`ui-stage.ts`): the rows of the `figure` structure are its own lines (parts, routes, steps), read by the language's `readFigure`.
//
//   rows of the structure  ->  readFigure  ->  layoutFigure in the room  ->  paintFigure  ->  DrawnFrames
//
// What a hand has done to a figure (the step it is at) is kept here, by the structure's key, as a control's value is the control's. A press on the
// stepper's two regions (or the keys) moves it; nothing is told to the mind.

import { readFigure } from '@conduit/language';
import type { ElementSpan } from '@conduit/language';
import type { DrawnFrames, StructureLayout } from '../contracts/blocks';
import { EMPTY_STRUCTURE_LAYOUT } from '../contracts/blocks';
import type { ElementFrame, FigureFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import type { Box, Viewport } from '../contracts/space';
import { cellOf } from './layout/metrics';
import { foldText } from '../fonts/fold';
import { prefixEm } from '../fonts/measure';
import { layoutFigure, paintFigure } from './blocks/figure';
import type { FigureEnv, FigureInput, FigureLayout } from './blocks/figure';

const STEPS = new Map<string, number>();
const LASTS = new Map<string, { readonly room: Box; readonly layout: FigureLayout }>();

// the page's test hook (`__stage` is the painter's; this is the figure's): where each stepper is, so a driver can press it with real events
(globalThis as { __figures?: unknown }).__figures = LASTS;

export const isFigureBlock = (span: ElementSpan): boolean => span.figure?.kind === 'structure' && span.figure.structure === 'figure';

/** The step a hand has the figure at (0: rest), as part of the layout's cache key. */
export const figureKey = (key: string): string => `s${STEPS.get(key) ?? 0}`;

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

export function layoutFigureBlock(args: { readonly structure: ElementSpan; readonly room: Box; readonly spec: LookSpec; readonly viewport?: Viewport }): StructureLayout {
  const { structure, room, spec, viewport } = args;
  if (room.width < 120 || room.height < 120) return { ...EMPTY_STRUCTURE_LAYOUT, boxes: new Map([[structure.key, room]]) };
  const input = figureOf(structure);
  const step = Math.max(0, Math.min(input.steps.length, STEPS.get(structure.key) ?? 0));
  const env: FigureEnv = {
    measure: measureOf(),
    floor: spec.type.minFont,
    ...(viewport === undefined ? {} : { body: cellOf('m', viewport, spec).fontSize, small: cellOf('s', viewport, spec).fontSize }),
    look: { ground: spec.roles.ground, ink: spec.roles.ink, dim: spec.roles.dim, accent: spec.roles.accent, alt: spec.roles.alt, gamut: spec.gamut },
  };
  const layout = layoutFigure(input, { step }, { width: room.width, height: room.height }, env);
  LASTS.set(structure.key, { room, layout });
  const painted = paintFigure(layout, { ambient: 0, motion: false });
  const base = structure.order + 1;
  const prefix = `${structure.key}/`;
  const figures: FigureFrame[] = painted.figures.map((figure) => ({ ...figure, key: prefix + figure.key, z: Math.min(8999, base + figure.z), transform: { ...figure.transform, e: figure.transform.e + room.x, f: figure.transform.f + room.y } }) as FigureFrame);
  const elements: ElementFrame[] = painted.elements.map((element) => ({ ...element, key: prefix + element.key, z: Math.min(8999, base + element.z), x: element.x + room.x, y: element.y + room.y }));
  const drawn: DrawnFrames = { figures, elements, rowOf: new Map(), fontPx: Math.min(layout.labelPx, layout.chrome.px) };
  return { boxes: new Map([[structure.key, room]]), parts: [], routes: new Map(), notes: [], shrink: 1, drawn };
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
