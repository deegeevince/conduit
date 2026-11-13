import type { LookSpec } from '../contracts/look';
import { softLook } from './common';

/**
 * A two-drum risograph print: flat shapes, tone as halftone dots, the second
 * colour a hair out of register. Things land, they do not drift: pop is the
 * look's natural entrance and a slam is a heavy stamp.
 */
export const RISO: LookSpec = softLook({
  id: 'riso',
  machine: 'a two-colour risograph print on uncoated stock',
  amounts: { paper: 0.5, halftone: 0.6, misprint: 0.5 },
  stroke: { thick: 1.4, wobble: 0.12 },
  groundAlt: null,
  hot: null,
  enter: {
    pop: { from: { opacity: 0, scale: 0.7 }, ease: 'out-hard', reveal: false, flicker: false },
    slam: { from: { opacity: 0, scale: 1.35 }, ease: 'out-hard', reveal: false, flicker: false },
    rise: { from: { opacity: 0, dy: 0.35 }, ease: 'out', reveal: false, flicker: false },
  },
  mood: {
    neutral: { agitation: 0.12, dim: 0, sway: 0.004, swayPeriod: 9, lean: 0, snap: 0.95 },
    playful: { agitation: 0.25, dim: 0, sway: 0.007, swayPeriod: 5, lean: 0, snap: 0.8 },
  },
});
