// When each part of a structure was heard: what its layout epochs begin at. The live painter and a film made of a recorded turn both call
// this, with the playhead each line arrived at, so a film is laid out in the epochs the viewer saw.

import type { Schedule } from '@conduit/language';

/** Notes, in `arrivals`, the playhead `at` for every structure, node and link of `schedule` (and each of a structure's rows) not yet noted. */
export function noteArrivals(arrivals: Map<string, number>, schedule: Schedule, at: number): void {
  for (const element of schedule.elements) {
    if (element.kind !== 'structure' && element.kind !== 'node' && element.kind !== 'link') continue;
    if (!element.carried && !arrivals.has(element.key)) arrivals.set(element.key, at);
    if (element.figure?.kind === 'structure') element.figure.rows.forEach((_, i) => arrivals.has(`${element.key}#r${i}`) || arrivals.set(`${element.key}#r${i}`, at));
  }
}
