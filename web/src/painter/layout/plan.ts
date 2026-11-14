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
/** The share of the column the choices may take at most when a diagram, picture or other block is on the stage: the drawing keeps the room. */
export const FOOT_SHARE_MAX = 0.3;
/** With only words and choices on the stage (an intro, a menu of starters) the choices may take more, so a stacked list on a phone is not cut. */
export const FOOT_SHARE_MAX_WORDS = 0.45;
/** A landscape `figure` gives the picture this share of the width; a portrait one this share of the height. */
const FIGURE_WIDE_SHARE = 0.58;
const FIGURE_TALL_SHARE = 0.55;
/** Blocks and words side by side: the blocks take this share of the width, the words the rest. */
const BESIDE_SHARE = 0.5;

export interface PlanInput {
  readonly viewport: Viewport;
  readonly look: LookSpec;
  readonly layout: Layout;
  readonly blocks: readonly StageBlock[];
  /** the height the flowing words need across `width`, stage units, expected lines included; 0 when there are none */
  readonly flowHeight: (width: number) => number;
  /** the least the words need to show what matters (headings and the tallest line under them); absent: no floor but a fifth of the column */
  readonly flowLeast?: (width: number) => number;
  /** the creation order of the first flowing word, or null */
  readonly flowOrder: number | null;
  /** the height the choices need across `width`, stage units; 0 when there are none */
  readonly footHeight: (width: number) => number;
  /**
   * A wide stage with blocks and a good deal of words sets the blocks in the lead room, to the left, and the words beside them, to the
   * right, rather than the words in a thin band under a block: a subject the words refer to is the first thing read and is never a postage stamp.
   */
  readonly beside?: boolean;
}

/** How much of what a block would like it is given, 0 to 1: the worse of its height and its width. */
function fitOf(block: StageBlock, box: Box): number {
  return Math.min(1, box.height / Math.max(1, block.natural.height), box.width / Math.max(1, Math.min(block.natural.width, block.least.width * 2)));
}

/** A box kept to the shape its block keeps (a ring, a map), centred in what it was offered. */
function shaped(block: StageBlock, offered: Box): Box {
  if (block.aspect === null) return offered;
  const width = Math.min(offered.width, offered.height * block.aspect);
  const kept = Math.min(offered.height, width / block.aspect);
  return { x: offered.x + (offered.width - width) / 2, y: offered.y + (offered.height - kept) / 2, width, height: kept };
}

interface Division {
  readonly rooms: Map<string, Box>;
  readonly worst: number;
  readonly mean: number;
  readonly how: 'stack' | 'row' | 'grid';
}

/** Cut a run of blocks out of `area` in proportion to `size`, along one axis. */
function cut(area: Box, run: readonly StageBlock[], gap: number, across: 'height' | 'width', size: (block: StageBlock) => number): Box[] {
  const room = (across === 'height' ? area.height : area.width) - gap * (run.length - 1);
  const weight = run.reduce((sum, block) => sum + Math.max(1, size(block)), 0);
  const out: Box[] = [];
  let at = across === 'height' ? area.y : area.x;
  for (const block of run) {
    const length = Math.max(1, (room * Math.max(1, size(block))) / weight);
    out.push(across === 'height' ? { x: area.x, y: at, width: area.width, height: length } : { x: at, y: area.y, width: length, height: area.height });
    at += length + gap;
  }
  return out;
}

/** The ways blocks can share an area: one over another, side by side (two or three), two by two. Each is scored by its worst-served block. */
function divisions(area: Box, blocks: readonly StageBlock[], gap: number): Division[] {
  const made: Division[] = [];
  const score = (how: Division['how'], boxes: readonly Box[]): void => {
    const rooms = new Map<string, Box>();
    let worst = 1;
    let sum = 0;
    blocks.forEach((block, index) => {
      const box = shaped(block, boxes[index] ?? area);
      rooms.set(block.key, box);
      const fit = fitOf(block, box);
      worst = Math.min(worst, fit);
      sum += fit;
    });
    made.push({ rooms, worst, mean: sum / blocks.length, how });
  };
  score('stack', cut(area, blocks, gap, 'height', (block) => block.natural.height));
  if (blocks.length >= 2 && blocks.length <= 3) score('row', cut(area, blocks, gap, 'width', (block) => block.natural.width));
  if (blocks.length >= 3) {
    const columns = 2;
    const rows: StageBlock[][] = [];
    for (let i = 0; i < blocks.length; i += columns) rows.push(blocks.slice(i, i + columns));
    const bands = cut(area, rows.map((run) => run[0] as StageBlock), gap, 'height', (block) => block.natural.height);
    const boxes: Box[] = [];
    rows.forEach((run, r) => boxes.push(...cut(bands[r] as Box, run, gap, 'width', (block) => block.natural.width)));
    score('grid', boxes);
  }
  return made;
}

/** Record a division's rooms; a block under its least is crowded. */
function place(division: Division, blocks: readonly StageBlock[], rooms: Map<string, Box>, crowded: string[]): void {
  for (const block of blocks) {
    const box = division.rooms.get(block.key);
    if (box === undefined) continue;
    rooms.set(block.key, box);
    if (box.height < block.least.height - 1e-6 || box.width < block.least.width - 1e-6) crowded.push(block.key);
  }
}

/** What a block is given at least before the words are asked to give way: four fifths of what it would like. */
const GOOD_FIT = 0.8;

/** The best division of an area, the stack unless another is clearly better (it keeps the written order top to bottom). */
function divide(area: Box, blocks: readonly StageBlock[], gap: number): Division {
  const all = divisions(area, blocks, gap);
  let top = all[0] as Division;
  for (const other of all.slice(1)) if (other.worst > top.worst + 0.05 || (other.worst > top.worst - 0.02 && other.mean > top.mean + 0.1)) top = other;
  return top;
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
  const footHeight = Math.min(wanted, safe.height * (blocks.length > 0 ? FOOT_SHARE_MAX : FOOT_SHARE_MAX_WORDS));
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
  let flowWords = words;
  if (layout === 'figure' && words > 0) {
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
  } else if (input.beside === true && !needsPicture && unpinned.length > 0 && viewport.width >= viewport.height) {
    const gutter = Math.max(16, margin * 0.75);
    const share = column.width * BESIDE_SHARE;
    area = { x: column.x, y: column.y, width: share - gutter / 2, height: column.height };
    flow = { x: column.x + share + gutter / 2, y: column.y, width: column.width - share - gutter / 2, height: column.height };
    flowWords = input.flowHeight(flow.width);
  } else {
    const most = Math.min(words, column.height * FLOW_SHARE_MAX);
    // words written before every block stand above it; otherwise they stand below, as a caption does
    const firstBlock = blocks.reduce<number | null>((least, block) => (block.kind === 'picture' ? least : least === null ? block.order : Math.min(least, block.order)), null);
    const above = !needsPicture && input.flowOrder !== null && firstBlock !== null && input.flowOrder < firstBlock;
    const areaFor = (height: number): Box => (above ? { x: column.x, y: column.y + height + gap, width: column.width, height: Math.max(1, column.height - height - gap) } : { x: column.x, y: column.y, width: column.width, height: Math.max(1, column.height - height - gap) });
    // Blocks alone with the words: the words give way before a block is set below what it needs. The words are tried at their full height, then at
    // less and less of it (the oldest lines retire, as they do when a column is full), and the first height that serves every block well wins.
    let height = most;
    if (!needsPicture && unpinned.length > 0) {
      // the words ask for their least (headings and a line under them), but a block is given its own least first: they give way to it
      const wide = viewport.width >= viewport.height * 1.2;
      const blocksLeast = wide ? Math.max(...unpinned.map((block) => block.least.height)) : unpinned.reduce((sum, block) => sum + block.least.height, 0) + gap * (unpinned.length - 1);
      const wordsAsk = Math.max(column.height * 0.18, input.flowLeast === undefined ? 0 : input.flowLeast(column.width));
      const least = Math.min(most, Math.max(Math.min(wordsAsk, column.height - gap - blocksLeast), column.height * 0.08, 1));
      const levels = [most, most * 0.8, most * 0.62, most * 0.48, least].filter((h, i, all) => h >= least - 1e-6 && (i === 0 || h < (all[i - 1] as number) - 1)).map((h) => Math.max(h, least));
      let chosen = levels[levels.length - 1] as number;
      let bestWorst = -1;
      for (const level of levels) {
        const worst = divide(areaFor(level), unpinned, gap).worst;
        if (worst >= GOOD_FIT) {
          chosen = level;
          bestWorst = worst;
          break;
        }
        if (worst > bestWorst + 0.02) {
          bestWorst = worst;
          chosen = level;
        }
      }
      height = chosen;
    }
    flow = above ? { x: column.x, y: column.y, width: column.width, height } : { x: column.x, y: column.y + column.height - height, width: column.width, height };
    area = areaFor(height);
  }

  // 4. the visual area
  let pictureRegion: Box | null = null;
  if (unpinned.length === 0) {
    pictureRegion = area;
  } else if (!needsPicture) {
    place(divide(area, unpinned, gap), unpinned, rooms, crowded);
  } else {
    // a picture and a block together: side by side on a wide area, one over the other on a tall one
    if (area.width >= area.height * 1.2) {
      const share = area.width * 0.55;
      pictureRegion = { x: area.x, y: area.y, width: share - gap / 2, height: area.height };
      place(divide({ x: area.x + share + gap / 2, y: area.y, width: area.width - share - gap / 2, height: area.height }, unpinned, gap), unpinned, rooms, crowded);
    } else {
      const share = area.height * 0.5;
      pictureRegion = { x: area.x, y: area.y, width: area.width, height: share - gap / 2 };
      place(divide({ x: area.x, y: area.y + share + gap / 2, width: area.width, height: area.height - share - gap / 2 }, unpinned, gap), unpinned, rooms, crowded);
    }
  }
  if (flowWords > 0 && flowWords > flow.height + 1e-6 && layout !== 'figure') crowded.push('flow');
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
