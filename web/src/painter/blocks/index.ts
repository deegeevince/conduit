// The structure engines. STUB: nothing is laid out yet (PLAN-v2.md, package D).
//
// What goes here: one pure module per family, behind the two functions below.
//   flow.ts      layered layout (ranks by longest path, crossings reduced, nodes sized by their words)
//   tree.ts      tidy tree
//   cycle.ts     a ring, with arcs that close it
//   timeline.ts  an axis to scale, labels staggered above and below with leaders
//   map.ts       pins where the brain put them; point-feature label placement; the route
//   table.ts     columns sized by content, numbers right-aligned, hairlines by the look
//   chart.ts     bars, columns and a line, to scale from zero, with nice ticks
//   route.ts     orthogonal connector routing that never passes through a node
//   callouts.ts  boundary labelling: labels in clear room, leaders that never cross
//
// Each kind is added to STRUCTURES_READY only when its engine is done: the
// painter advertises exactly this list, and the brain is taught only what is
// advertised.

import type { StructureKind } from '@conduit/language';
import { EMPTY_CALLOUT_LAYOUT, EMPTY_STRUCTURE_LAYOUT } from '../../contracts/blocks';
import type { CalloutEngine, StructureEngine } from '../../contracts/blocks';

/** The structures this painter can lay out today. */
export const STRUCTURES_READY: readonly StructureKind[] = [];

/** True once `layoutCallouts` places labels with leaders; until then a `callout` is placed as a plain `near=` label. */
export const CALLOUTS_READY = false;

export const layoutStructure: StructureEngine = () => EMPTY_STRUCTURE_LAYOUT;

export const layoutCallouts: CalloutEngine = () => EMPTY_CALLOUT_LAYOUT;
