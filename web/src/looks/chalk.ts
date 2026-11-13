import type { LookSpec } from '../contracts/look';
import { softLook } from './common';

/**
 * A blackboard that has been wiped more than once: chalk that breaks up along
 * its stroke, a haze where marks were. Written on with a wipe, at the steady
 * speed of an arm, never eased in the way a brush would be.
 */
export const CHALK: LookSpec = softLook({
  id: 'chalk',
  machine: 'chalk on a slate board',
  amounts: { dust: 0.6, vignette: 0.35 },
  stroke: { thick: 1.1, wobble: 0.25 },
  groundAlt: '#2a3a34',
  hot: '#ffffff',
  enter: {
    wipe: { from: {}, ease: 'linear', reveal: true, flicker: false },
    draw: { from: {}, ease: 'linear', reveal: true, flicker: false },
    rise: { from: { opacity: 0, dy: 0.35 }, ease: 'out', reveal: false, flicker: false },
  },
  mood: {
    calm: { agitation: 0.05, dim: 0, sway: 0.004, swayPeriod: 13, lean: 0, snap: 1.15 },
    playful: { agitation: 0.2, dim: 0, sway: 0.006, swayPeriod: 6, lean: 0, snap: 0.9 },
  },
});
