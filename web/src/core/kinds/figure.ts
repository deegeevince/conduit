// kinds/figure.ts: The `figure` kind: a labelled drawing with parts that label themselves, routes along them
// and steps that light them in turn. The engine is pure and lives in `painter/blocks/figure/`; this file is its `Kind`.
//
//   model    the typed `FigureInput` and the step a hand is at (0 is rest). No time, no room.
//   measure  it wants the room it is given (a drawing is fitted, not flowed); the least it can be read at is a small one
//   layout   fit, labels, refit, routes, the caption band and the stepper, all inside the box
//   draw     finished frames (gradient fills, outlines, soft shadows, lines, type) as `Drawn.frames`; dots from `Phase.ambient`, none at rest
//   census   every word (labels, caption, counter), and the stepper's two regions at least 44 points
//   input    a press on the stepper, or the keys, moves the step; nothing is told to the mind
//
// THE SEAM. `inputOf` is the one place that reads a `FigureInput` from an element: from the rows of a `figure` structure (the language round's
// `readFigure`), or, for what `pnpm kinds` draws from a one-line stand-in (`figure:<name>`), by the element's id from the fixtures.
//
// Reduced motion: the core gives a leaf `ambient` 0 under reduced motion (and at rest), and dots are drawn only when it is above 0, so the chevrons
// alone remain. A step's light is instant here: the bench (and the core, when it has `since`) pass an ease to `paintFigure`.

import { readFigure } from '@conduit/language';
import type { ElementSpan } from '@conduit/language';
import { foldText } from '../../fonts/fold';
import { prefixEm } from '../../fonts/measure';
import { FIGURES, layoutFigure, paintFigure, TARGET } from '../../painter/blocks/figure';
import type { FigureEnv, FigureInput, FigureLayout } from '../../painter/blocks/figure';
import type { CensusWord, Drawn, Env, Kind, LeafCensus, LeafEvent, Measured, Region, Size2 } from '../contracts';
import { seal } from '../seal';

interface FigureModel {
  readonly input: FigureInput;
  readonly step: number;
}

interface FigureLeaf {
  readonly size: Size2;
  readonly layout: FigureLayout;
}

/**
 * The figure an element stands for. FG2: a `figure` structure's rows are its own lines, read by the language's `readFigure`; an element that is
 * no such structure (what `pnpm kinds` draws from a one-line stand-in) is looked up by id in the fixtures.
 */
export function inputOf(element: ElementSpan): FigureInput {
  const figure = element.figure;
  if (figure?.kind === 'structure' && figure.structure === 'figure') {
    return readFigure(element.id, element.text, figure.mode ?? 'plain', figure.rows.map((row) => row.cells[0] ?? '')).input;
  }
  return FIGURES[element.id] ?? { id: element.id, title: element.text, mode: 'plain', parts: [], routes: [], steps: [] };
}

/** The element a one-line fixture (`figure:<name>`) stands for: what `pnpm kinds` draws until the language can write a figure. */
export function fixtureElement(lines: readonly string[]): { readonly element: ElementSpan; readonly parts: readonly ElementSpan[] } | null {
  const name = /^figure:(\S+)$/.exec(lines[0] ?? '')?.[1];
  const input = name === undefined ? undefined : FIGURES[name];
  if (input === undefined) return null;
  const element = {
    key: `${input.id}@0`,
    id: input.id,
    kind: 'text',
    seq: 0,
    order: 0,
    scene: 'main',
    text: input.title,
    emphasis: [],
    figure: null,
    parent: null,
    carried: false,
    replaces: null,
    enter: null,
    exit: null,
    changes: [],
    driven: [],
    struck: false,
  } as unknown as ElementSpan;
  return { element, parts: [] };
}

/** The painter's own advance tables, for the sans face the figure is set in. */
function measureOf(): FigureEnv['measure'] {
  return (text, px, bold) => {
    const folded = foldText(text);
    return (prefixEm(folded, 'sans', bold ? 'bold' : 'normal')[folded.length] ?? 0) * px;
  };
}

const figureEnv = (env: Env): FigureEnv => ({
  measure: measureOf(),
  floor: env.tokens.floor,
  look: { ground: env.ground, ink: env.ink('ink'), dim: env.ink('dim'), accent: env.ink('accent'), alt: env.ink('alt'), gamut: env.legacy.look.gamut },
});

const LEAST: Size2 = { width: 280, height: 300 };

const kind: Kind<'figure', FigureModel, FigureLeaf> = {
  id: 'figure',
  status: { state: 'ready' },
  model: (element, _parts, held) => ({ input: inputOf(element), step: held?.step ?? 0 }),
  measure(_model, constraint): Measured {
    return {
      width: constraint.maxWidth,
      height: constraint.maxHeight,
      least: { width: Math.min(constraint.maxWidth, LEAST.width), height: Math.min(constraint.maxHeight, LEAST.height) },
      fit: 'contain',
    };
  },
  layout: (model, size, env) => ({ size, layout: layoutFigure(model.input, { step: model.step }, size, figureEnv(env)) }),
  draw(leaf, phase): Drawn {
    const painted = paintFigure(leaf.layout, { ambient: phase.ambient, motion: phase.ambient > 0 });
    const fontPx = Math.min(leaf.layout.labelPx, leaf.layout.chrome.px);
    return { parts: [], frames: { figures: painted.figures, elements: painted.elements, rowOf: new Map(), fontPx }, surface: null };
  },
  census(leaf): LeafCensus {
    const painted = paintFigure(leaf.layout, { ambient: 0, motion: false });
    const words: CensusWord[] = painted.words.map((w) => ({ part: w.part, text: w.text, box: w.box, px: w.px, colour: w.colour, on: w.on }));
    const regions: Region[] = [];
    const stepper = leaf.layout.chrome.stepper;
    if (stepper !== null) {
      regions.push({ part: 'step:prev', box: stepper.prev, role: 'press', label: 'Previous step' });
      regions.push({ part: 'step:next', box: stepper.next, role: 'press', label: 'Next step' });
    }
    return { words, regions };
  },
  input(leaf, held, event: LeafEvent) {
    const last = leaf.layout.input.steps.length;
    const at = held?.step ?? 0;
    const go = (to: number) => ({ held: { step: Math.max(0, Math.min(last, to)) }, emit: null });
    if (event.type === 'key') {
      if (event.key === 'less') return go(at - 1);
      if (event.key === 'more') return go(at + 1);
      if (event.key === 'first') return go(0);
      if (event.key === 'last') return go(last);
      return null;
    }
    if (event.type !== 'press') return null;
    const stepper = leaf.layout.chrome.stepper;
    const inBox = (b: { x: number; y: number; width: number; height: number }): boolean => event.x >= b.x && event.x <= b.x + b.width && event.y >= b.y && event.y <= b.y + b.height;
    if (event.part === 'step:prev' || (stepper !== null && inBox(stepper.prev))) return go(at - 1);
    if (event.part === 'step:next' || (stepper !== null && inBox(stepper.next))) return go(at + 1);
    return null;
  },
  fixtures: Object.keys(FIGURES).map((name) => [`figure:${name}`]),
};

export const figure = seal(kind);
export { TARGET };
