// The structure engines (PLAN-v2.md, package D). Pure: no DOM, no clock; text
// is sized only through the measurer handed in. Everything is placed in the
// same stage units as the room it was given (not relative to its corner).
//
//   flow.ts       layered layout, orthogonal connectors in the gaps between ranks
//   tree.ts       tidy tree, elbows through a shared bar
//   cycle.ts      a ring, with arcs that close it
//   timeline.ts   an axis to scale, labels alternating, tiers when crowded
//   map.ts        pins where the brain put them; eight places round each; a route
//   table.ts      columns by content, numbers on their decimal point, bars
//   callouts.ts   boundary labelling: labels in clear room, leaders that never cross
//   audit.ts      counts collisions in a layout (the bench's judge, and the painter's check)
//   kit.ts, geom.ts  shared parts
//
// Conventions the painter reads:
//   - an implicit arc of a cycle belongs to the node it leaves (part `line`/`head`), and its route is keyed by that node;
//   - a table's bar for a starred row has the part name `bar:<r>:star` (accent), others `bar:<r>`;
//   - a map's and a cycle's labels are in `boxes` under their node key.

import type { StructureKind } from '@conduit/language';
import { EMPTY_CALLOUT_LAYOUT, EMPTY_STRUCTURE_LAYOUT } from '../../contracts/blocks';
import type { CalloutEngine, StructureEngine } from '../../contracts/blocks';
import { layoutCallouts as callouts } from './callouts';
import { layoutCycle } from './cycle';
import { layoutFlow } from './flow';
import { layoutMap } from './map';
import { layoutTable } from './table';
import { layoutTimeline } from './timeline';
import { layoutTree } from './tree';

/** The structures this painter can lay out today. */
export const STRUCTURES_READY: readonly StructureKind[] = ['flow', 'tree', 'cycle', 'timeline', 'map', 'table'];

/** True once `layoutCallouts` places labels with leaders; until then a `callout` is placed as a plain `near=` label. */
export const CALLOUTS_READY = true;

export const layoutStructure: StructureEngine = (input) => {
  const f = input.structure.figure;
  if (f?.kind !== 'structure') return EMPTY_STRUCTURE_LAYOUT;
  switch (f.structure) {
    case 'flow':
      return layoutFlow(input);
    case 'tree':
      return layoutTree(input);
    case 'cycle':
      return layoutCycle(input);
    case 'timeline':
      return layoutTimeline(input);
    case 'map':
      return layoutMap(input);
    case 'table':
      return layoutTable(input);
    default:
      return EMPTY_STRUCTURE_LAYOUT;
  }
};

export const layoutCallouts: CalloutEngine = (input) => (input.labels.length === 0 ? EMPTY_CALLOUT_LAYOUT : callouts(input));
