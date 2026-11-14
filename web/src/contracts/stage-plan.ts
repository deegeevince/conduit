// v2.1: one layout. A scene's stage is divided once per layout epoch into regions that do not overlap, and everything the painter
// places (flowing words, a structure, a chart, a code block, a card of controls, the scene's canvas, the choices) is given its room from
// the same division. Nothing is laid out as if it were alone, so nothing is drawn over anything else: that is the whole point of it.
//
// The division is made by `planStage` (web/src/painter/layout/plan.ts), a pure function of what is on stage and what is expected. The
// flow (`arrange`), the structure engines, the chart frames and `fitCanvas` all read their room from its answer; none of them reads the
// safe frame for itself any more. It is published in the painter's snapshot so that the battery can audit a composed stage with code
// that is not the painter's own, and so that the chrome's text layer sits where the words are.

import type { Box } from './space';

/** What takes room on a stage besides flowing words. `picture` is the scene's canvas: free drawing, sprites, paintings. */
export type StageBlockKind = 'picture' | 'structure' | 'chart' | 'code' | 'card' | 'control';

/** One block that wants room, as `planStage` is told of it. Sizes are on the reading plane, stage units. */
export interface StageBlock {
  /** the element's key; `canvas` for the scene's own canvas */
  readonly key: string;
  readonly kind: StageBlockKind;
  /** creation order: blocks and words keep the order they were written in */
  readonly order: number;
  /** the size it would take with all the room in the world, and the least it can be read at */
  readonly natural: { readonly width: number; readonly height: number };
  readonly least: { readonly width: number; readonly height: number };
  /** width over height it must keep (a canvas, a chart), or null when it reflows (a table, a flow, code) */
  readonly aspect: number | null;
  /** the brain gave it a box of its own (`4,4 152x54`): it keeps that box inside the picture region and takes no room from the flow */
  readonly pinned: Box | null;
}

/** Where everything goes for one layout epoch. Regions are disjoint; every box is on the reading plane, stage units. */
export interface StagePlan {
  /** the region pictures have: the scene's canvas is fitted inside it, a filled shape that runs to the canvas edge bleeds to its edge and no further, and everything drawn on the canvas is clipped by it */
  readonly picture: Box | null;
  /** the room each block was given, by key. A block is laid out inside its room and never outside it: an engine that cannot fit scales the whole of itself down. */
  readonly rooms: ReadonlyMap<string, Box>;
  /** the room flowing words have */
  readonly flow: Box;
  /** the foot: the choices and any control that sends, set apart under everything, in rows that wrap. Null when there are none. */
  readonly foot: Box | null;
  /** keys that could not be given their least size: the painter says so in sight (`crowded`) and, for words, retires the oldest as it does today */
  readonly crowded: readonly string[];
}

/** The plan as the snapshot and the test hook publish it, in host CSS pixels with the camera at rest. */
export interface StagePlanView {
  readonly picture: Box | null;
  readonly rooms: readonly { readonly key: string; readonly kind: StageBlockKind; readonly box: Box }[];
  readonly flow: Box;
  readonly foot: Box | null;
}
