// Where the things the painter lays out are, for the modules that must know without owning them: `canvasBoxOf` (near=, cam focus, sight)
// and the track a `move along=` rides. A timeline registers its structures against its schedule; nothing here keeps a clock.

import type { Polyline, Schedule } from '@conduit/language';

export interface LaidOut {
  /** canvas units, for a structure, node, link or control the painter placed; null when it is not one of those or is not placed yet */
  boxOf(key: string, time: number): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  /** the route of a link, canvas units */
  routeOf(key: string, time: number): Polyline | null;
}

const registered = new WeakMap<Schedule, LaidOut>();

export function registerLaidOut(schedule: Schedule, laidOut: LaidOut): void {
  registered.set(schedule, laidOut);
}

export function laidOutOf(schedule: Schedule): LaidOut | null {
  return registered.get(schedule) ?? null;
}
