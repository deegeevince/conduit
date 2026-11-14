// The stage plan (PLAN-v2.1, D1). One pure function divides a scene's stage, once per layout epoch, into regions that do not overlap:
// the foot (the choices), the flow (the words), and what is left for the picture and for each block the painter lays out (a structure,
// a chart, a code block). Nothing else reads the safe frame. The flow, the structure engines, the chart frames and the canvas's fit all
// take their room from the answer, so a thing is never laid out as if it were alone.
//
// The method, in order:
//  1. the foot takes what the choices need, in rows that wrap, from the bottom of the safe frame;
//  2. the flow's words are set across the column's full width to learn their height (`flowHeight`);
//  3. the flow keeps that height, at most `FLOW_SHARE_MAX` of the column, so blocks are never offered less than the rest of it;
//  4. what is left is the visual area: the picture (a canvas, kept in its aspect) and each unpinned block share it, in written order;
//  5. a block that cannot be given its least size is named in `crowded`.
// A block the brain gave a box of its own (`pinned`) takes no room: it stands on the picture, in canvas units, inside the picture's region.

import type { Layout } from '@conduit/language';
import type { LookSpec } from '../../contracts/look';
import type { StageBlock, StagePlan, StagePlanView } from '../../contracts/stage-plan';
import type { Box, Viewport } from '../../contracts/space';
import { cellOf, marginOf, safeFrame } from './metrics';

/** The share of the column the flow's words may take when blocks or a picture are on the stage: they are offered at least the rest. */
export const FLOW_SHARE_MAX = 0.55;
/** The share of the column the choices may take at most. */
export const FOOT_SHARE_MAX = 0.3;
/** A landscape `figure` gives the picture this share of the width; a portrait one this share of the height. */
const FIGURE_WIDE_SHARE = 0.58;
const FIGURE_TALL_SHARE = 0.55;

export interface PlanInput {
  readonly viewport: Viewport;
  readonly look: LookSpec;
  readonly layout: Layout;
  readonly blocks: readonly StageBlock[];
  /** the height the flowing words need across `width`, stage units, expected lines included; 0 when there are none */
  readonly flowHeight: (width: number) => number;
  /** the creation order of the first flowing word, or null */
  readonly flowOrder: number | null;
  /** the height the choices need across `width`, stage units; 0 when there are none */
  readonly footHeight: (width: number) => number;
}

/** The room a stack of blocks shares, top to bottom, in proportion to what each would like; a block under its least is crowded. */
function stack(area: Box, blocks: readonly StageBlock[], gap: number, rooms: Map<string, Box>, crowded: string[]): void {
  if (blocks.length === 0) return;
  const room = area.height - gap * (blocks.length - 1);
  const weight = blocks.reduce((sum, block) => sum + Math.max(1, block.natural.height), 0);
  let y = area.y;
  for (const block of blocks) {
    const height = Math.max(1, (room * Math.max(1, block.natural.height)) / weight);
    let box: Box = { x: area.x, y, width: area.width, height };
    // a block that keeps its shape (a ring, a map) is no wider or taller than that shape allows, centred in what it was offered
    if (block.aspect !== null) {
      const width = Math.min(box.width, box.height * block.aspect);
      const kept = Math.min(box.height, width / block.aspect);
      box = { x: box.x + (box.width - width) / 2, y: box.y + (box.height - kept) / 2, width, height: kept };
    }
    rooms.set(block.key, box);
    if (box.height < block.least.height - 1e-6 || box.width < block.least.width - 1e-6) crowded.push(block.key);
    y += height + gap;
  }
}

export function planStage(input: PlanInput): StagePlan {
  const { viewport, look, layout, blocks } = input;
  const safe = safeFrame(viewport, look);
  const margin = marginOf(viewport, look);
  const gap = Math.max(8, Math.min(margin * 0.75, cellOf('m', viewport, look).height * 0.5));
  const rooms = new Map<string, Box>();
  const crowded: string[] = [];

  // 1. the foot
  const wanted = input.footHeight(safe.width);
  const footHeight = Math.min(wanted, safe.height * FOOT_SHARE_MAX);
  const foot: Box | null = wanted > 0 ? { x: safe.x, y: safe.y + safe.height - footHeight, width: safe.width, height: footHeight } : null;
  const column: Box = foot === null ? safe : { x: safe.x, y: safe.y, width: safe.width, height: Math.max(1, safe.height - footHeight - gap) };

  const picture = blocks.find((block) => block.kind === 'picture') ?? null;
  const unpinned = blocks.filter((block) => block.kind !== 'picture' && block.pinned === null).sort((a, b) => a.order - b.order);
  // a block with a box of its own stands on the picture: the picture has to be there for it
  const needsPicture = picture !== null || blocks.some((block) => block.kind !== 'picture' && block.pinned !== null);
  const visual = needsPicture || unpinned.length > 0;
  if (!visual) return { picture: null, rooms, flow: column, foot, crowded };

  // 2. and 3. the flow
  const words = input.flowHeight(column.width);
  let flow: Box;
  let area: Box;
  if (layout === 'figure') {
    const gutter = Math.max(16, margin * 0.75);
    if (viewport.width >= viewport.height) {
      const share = column.width * FIGURE_WIDE_SHARE;
      area = { x: column.x, y: column.y, width: share - gutter / 2, height: column.height };
      flow = { x: column.x + share + gutter / 2, y: column.y, width: column.width - share - gutter / 2, height: column.height };
    } else {
      const share = column.height * FIGURE_TALL_SHARE;
      area = { x: column.x, y: column.y, width: column.width, height: share - gutter / 2 };
      flow = { x: column.x, y: column.y + share + gutter / 2, width: column.width, height: column.height - share - gutter / 2 };
    }
  } else if (words <= 0) {
    flow = { x: column.x, y: column.y + column.height, width: column.width, height: 0 };
    area = column;
  } else {
    const height = Math.min(words, column.height * FLOW_SHARE_MAX);
    // words written before every block stand above it; otherwise they stand below, as a caption does
    const firstBlock = blocks.reduce<number | null>((least, block) => (block.kind === 'picture' ? least : least === null ? block.order : Math.min(least, block.order)), null);
    const above = !needsPicture && input.flowOrder !== null && firstBlock !== null && input.flowOrder < firstBlock;
    if (above) {
      flow = { x: column.x, y: column.y, width: column.width, height };
      area = { x: column.x, y: column.y + height + gap, width: column.width, height: Math.max(1, column.height - height - gap) };
    } else {
      flow = { x: column.x, y: column.y + column.height - height, width: column.width, height };
      area = { x: column.x, y: column.y, width: column.width, height: Math.max(1, column.height - height - gap) };
    }
  }

  // 4. the visual area
  let pictureRegion: Box | null = null;
  if (unpinned.length === 0) {
    pictureRegion = area;
  } else if (!needsPicture) {
    stack(area, unpinned, gap, rooms, crowded);
  } else {
    // a picture and a block together: side by side on a wide area, one over the other on a tall one
    if (area.width >= area.height * 1.2) {
      const share = area.width * 0.55;
      pictureRegion = { x: area.x, y: area.y, width: share - gap / 2, height: area.height };
      stack({ x: area.x + share + gap / 2, y: area.y, width: area.width - share - gap / 2, height: area.height }, unpinned, gap, rooms, crowded);
    } else {
      const share = area.height * 0.5;
      pictureRegion = { x: area.x, y: area.y, width: area.width, height: share - gap / 2 };
      stack({ x: area.x, y: area.y + share + gap / 2, width: area.width, height: area.height - share - gap / 2 }, unpinned, gap, rooms, crowded);
    }
  }
  if (words > 0 && words > flow.height + 1e-6 && layout !== 'figure') crowded.push('flow');
  return { picture: pictureRegion, rooms, flow, foot, crowded };
}

/** The plan as the snapshot publishes it: host CSS pixels, origin at the top left of the viewport. */
export function viewOfPlan(plan: StagePlan, kinds: ReadonlyMap<string, StageBlock['kind']>, viewport: Viewport): StagePlanView {
  const shift = (box: Box): Box => ({ x: box.x + viewport.width / 2, y: box.y + viewport.height / 2, width: box.width, height: box.height });
  return {
    picture: plan.picture === null ? null : shift(plan.picture),
    rooms: [...plan.rooms].map(([key, box]) => ({ key, kind: kinds.get(key) ?? 'structure', box: shift(box) })),
    flow: shift(plan.flow),
    foot: plan.foot === null ? null : shift(plan.foot),
  };
}
