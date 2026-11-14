// The least a tappable thing may measure, css px, on this screen: the audience's target for the pointer in use (`targetFor`, contracts). The app sets it
// once the screen and the person are known and again when the audience changes; the layout, the controls and the hit-test all read it from here.

import { targetFor } from '../core/contracts';

let target = targetFor('adult', 'coarse');

/** The audience and pointer the stage is for. */
export function setTarget(audience: Parameters<typeof targetFor>[0], pointer: Parameters<typeof targetFor>[1]): void {
  target = targetFor(audience, pointer);
}

/** The shorter side a tappable thing is at least, css px. */
export function targetPx(): number {
  return target;
}
