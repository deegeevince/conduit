// The registry: every kind of the stage, by name, and the compiler's proof that none is missing (PLAN-v3-core 2.3, package PC1).
//
//   KINDS is `{ [K in KindId]: Sealed<K> }`. Leave a kind out and the build stops with its name (TS2741); file a toggle under `slider`
//   and it stops (the `id` does not match); each kind's own M and L are private to its file (`seal`).
//
// What a painter advertises is derived from it, not kept by hand beside it (review R4, F4, I2):
//
//   structures  the structure kinds that are ready, plus those whose host is present (a charting engine, an app host)
//   controls    the control kinds that are ready
//   taught      `teachingFor(capabilities)` over the lexicon, which is the same keys
//
// Today's painter keeps three lists by hand (`STRUCTURES_READY`, `CONTROLS_READY`, and the two host tests in `painter/index.ts`); the
// conformance run holds this derivation equal to them, so they cannot drift before PC2 deletes them.

import type { ControlKind, StructureKind } from '@conduit/language';
import { CONTROL_KINDS, STRUCTURE_KINDS } from '@conduit/language';
import { KIND_IDS, isControlKind, isStructureKind } from '../../../language/src/kinds';
import type { KindId } from '../../../language/src/kinds';
import type { Registry, Sealed, Status } from './contracts';
import { app } from './kinds/app';
import { button } from './kinds/button';
import { canvas } from './kinds/canvas';
import { chart } from './kinds/chart';
import { choice } from './kinds/choice';
import { code } from './kinds/code';
import { cycle } from './kinds/cycle';
import { figure } from './kinds/figure';
import { flow } from './kinds/flow';
import { input } from './kinds/input';
import { map } from './kinds/map';
import { pick } from './kinds/pick';
import { screen } from './kinds/screen';
import { slider } from './kinds/slider';
import { table } from './kinds/table';
import { timeline } from './kinds/timeline';
import { toggle } from './kinds/toggle';
import { tree } from './kinds/tree';
import { tune } from './kinds/tune';
import { words } from './kinds/words';

export const KINDS: Registry = {
  words,
  choice,
  canvas,
  figure,
  flow,
  tree,
  cycle,
  timeline,
  map,
  table,
  chart,
  code,
  tune,
  app,
  screen,
  button,
  toggle,
  slider,
  pick,
  input,
};

/** The hosts a painter may have: a charting engine, and an app host. Neither is the kinds' to give. */
export interface Hosts {
  readonly chart: boolean;
  readonly app: boolean;
}
export const NO_HOSTS: Hosts = { chart: false, app: false };

/** One kind's entry, from its name. */
export const kindOf = <K extends KindId>(id: K): Sealed<K> => KINDS[id];

/** Whether a kind can be drawn by the new core here: ready, or ready where its host is. */
export function isReady(status: Status, hosts: Hosts): boolean {
  return status.state === 'ready' || (status.state === 'host' && hosts[status.host]);
}

/** The kinds the registry can draw, given the hosts. Complete by the type of `KINDS`; the order is the lexicon's. */
export function readyKinds(hosts: Hosts): readonly KindId[] {
  return KIND_IDS.filter((id) => isReady(KINDS[id].status, hosts));
}

/** `Capabilities.structures`, derived: in the vocabulary's order. */
export function advertisedStructures(hosts: Hosts): readonly StructureKind[] {
  return STRUCTURE_KINDS.filter((id) => isReady(KINDS[id].status, hosts));
}

/** `Capabilities.controls`, derived: in the vocabulary's order. */
export function advertisedControls(): readonly ControlKind[] {
  return CONTROL_KINDS.filter((id) => isReady(KINDS[id].status, NO_HOSTS));
}

/** The kinds that are "not yet", with why: what a builder is shown when it asks what is left. */
export function notYetKinds(): readonly { readonly id: KindId; readonly why: string }[] {
  const left: { id: KindId; why: string }[] = [];
  for (const id of KIND_IDS) {
    const status = KINDS[id].status;
    if (status.state === 'not-yet') left.push({ id, why: status.why });
  }
  return left;
}

export { isControlKind, isStructureKind };
