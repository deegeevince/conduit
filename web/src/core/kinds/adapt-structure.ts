// An adapter: a structure engine of today (`painter/blocks/*`) as a kind of the new contract, its code where it is.
//
//   model    the structure, its nodes and its links, as the schedule holds them. Nothing else: no time, no room.
//   measure  the engine run at the constraint: its extent, and `least` as the extent at the reading floor (an estimate: PC11 gives each
//            engine its own `least`).
//   layout   the engine run in the box it is given, from the box's corner.
//   draw     the engine's parts, each as solid as its row has landed. Roles stay roles: the core chooses the ink.
//
// An engine takes its whole room and decides for itself where in it things go; so a box the engine does not fill is measured by what it
// did fill. That is the honest size of a diagram and what `measure` reports.

import type { ElementSpan, StructureKind } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import type { CensusWord, Drawn, DrawnPart, Env, Kind, LeafCensus, Measured, Phase, Size2, Status } from '../contracts';
import type { InkRole } from '@conduit/language';

export interface StructureModel {
  readonly structure: ElementSpan;
  readonly nodes: readonly ElementSpan[];
  readonly links: readonly ElementSpan[];
}

export interface StructureLeaf {
  readonly size: Size2;
  readonly layout: StructureLayout;
  readonly key: string;
  readonly words: readonly CensusWord[];
}

export const modelOfStructure = (structure: ElementSpan, parts: readonly ElementSpan[]): StructureModel => ({
  structure,
  nodes: parts.filter((part) => part.figure?.kind === 'node'),
  links: parts.filter((part) => part.figure?.kind === 'link'),
});

/** The ink a part's role asks for. `value` and `tick` are drawn in `dim`, as `BlockPart` says. */
export function inkRoleOf(role: Extract<BlockPart, { kind: 'text' }>['role']): InkRole {
  return role === 'value' || role === 'tick' ? 'dim' : 'ink';
}

export function inputOf(model: StructureModel, room: Box, env: Env): StructureInput {
  return {
    structure: model.structure,
    nodes: model.nodes,
    links: model.links,
    room,
    canvas: { origin: { x: room.x, y: room.y }, unit: env.canvasUnit },
    measure: env.measure,
    look: env.tokens,
    scope: {},
    obstacles: [],
  };
}

/** The smallest box round everything a layout drew, or null when it drew nothing. */
export function extentOf(layout: StructureLayout, key: string): Box | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const take = (box: Box): void => {
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.width);
    y1 = Math.max(y1, box.y + box.height);
  };
  for (const part of layout.parts) {
    if (part.kind === 'text') take(part.box);
    else for (const line of part.outline) for (const p of line.points) take({ x: p.x, y: p.y, width: 0, height: 0 });
  }
  for (const frames of layout.drawn === undefined ? [] : [layout.drawn]) {
    for (const element of frames.elements) take({ x: element.x - element.width / 2, y: element.y - element.height / 2, width: element.width, height: element.height });
  }
  if (!Number.isFinite(x0)) {
    const own = layout.boxes.get(key);
    return own === undefined ? null : own;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function wordsOf(layout: StructureLayout, env: Env): readonly CensusWord[] {
  const words: CensusWord[] = [];
  for (const part of layout.parts) {
    if (part.kind !== 'text' || part.text.trim() === '') continue;
    words.push({ part: part.part, text: part.text, box: part.box, px: env.px(part.spec), colour: env.ink(inkRoleOf(part.role)), on: env.ground });
  }
  for (const element of layout.drawn?.elements ?? []) {
    const text = element.runs.map((run) => run.text).join(' ').trim();
    if (text === '') continue;
    words.push({ part: element.key, text, box: { x: element.x - element.width / 2, y: element.y - element.height / 2, width: element.width, height: element.height }, px: element.fontSize, colour: element.runs[0]?.colour ?? env.ink('ink'), on: env.ground });
  }
  return words;
}

export function drawParts(layout: StructureLayout, phase: Phase): Drawn {
  const solid = (part: BlockPart): number => phase.presence * (part.row === undefined ? 1 : phase.landed(part.row));
  const parts: DrawnPart[] = layout.parts.map((part) => ({ part, opacity: solid(part) }));
  return { parts, frames: layout.drawn ?? null, surface: null };
}

export interface StructureKindOptions<K extends StructureKind> {
  readonly id: K;
  /** an engine of today; one that reads the look is handed the env as well */
  readonly engine: (input: StructureInput, env: Env) => StructureLayout;
  readonly fit: Measured['fit'];
  readonly fixtures: readonly (readonly string[])[];
  readonly status?: Status;
  /** a leaf whose picture is a surface over its box (a chart's engine, a live app): `draw` names it, and the engine's parts are its placeholder */
  readonly surface?: 'chart' | 'app';
  /**
   * The engine takes the whole room and scales its content to fit it, margins included (the mock-up's board does): what it wants is the room,
   * and the least it can be read at follows from how large its smallest type is there. Measuring the extent of what it drew would undersize it,
   * because the same engine in that smaller box would scale again.
   */
  readonly fill?: boolean;
}

export function structureKind<K extends StructureKind>(options: StructureKindOptions<K>): Kind<K, StructureModel, StructureLeaf> {
  const { id, engine } = options;
  return {
    id,
    status: options.status ?? { state: 'ready' },
    model: (element, parts) => modelOfStructure(element, parts),
    measure(model, constraint, env) {
      const layout = engine(inputOf(model, { x: 0, y: 0, width: constraint.maxWidth, height: constraint.maxHeight }, env), env);
      if (options.fill === true) {
        const fontPx = layout.drawn?.fontPx ?? 0;
        // type scales with the board: at this share of the room its smallest type is at the floor (and no less than the room when it is already under)
        const share = fontPx > 0 ? Math.min(1, env.tokens.floor / fontPx) : env.tokens.minShrink;
        return { width: constraint.maxWidth, height: constraint.maxHeight, least: { width: constraint.maxWidth * share, height: constraint.maxHeight * share }, fit: options.fit };
      }
      const extent = extentOf(layout, model.structure.key);
      const width = extent === null ? 0 : Math.min(constraint.maxWidth, extent.width);
      const height = extent === null ? 0 : Math.min(constraint.maxHeight, extent.height);
      // 1 when the engine drew at the look's size; less when it shrank to fit. At the reading floor it is the least it can be.
      const natural = layout.shrink > 0 ? 1 / layout.shrink : 1;
      return { width, height, least: { width: width * natural * env.tokens.minShrink, height: height * natural * env.tokens.minShrink }, fit: options.fit };
    },
    layout(model, size, env) {
      const layout = engine(inputOf(model, { x: 0, y: 0, width: size.width, height: size.height }, env), env);
      return { size, layout, key: model.structure.key, words: wordsOf(layout, env) };
    },
    draw(leaf, phase) {
      const drawn = drawParts(leaf.layout, phase);
      return options.surface === undefined ? drawn : { ...drawn, surface: { kind: options.surface, key: leaf.key, box: { x: 0, y: 0, width: leaf.size.width, height: leaf.size.height } } };
    },
    census: (leaf): LeafCensus => ({ words: leaf.words, regions: [] }),
    input: null,
    fixtures: options.fixtures,
  };
}
