import type { LookSpec } from '../contracts/look';
import { softLook } from './common';

/**
 * A flat mid-grey screen for pixel art: no fx, hard stair-stepped lines, things
 * arrive by cutting in. The ground is the one grey that keeps the sixteen
 * sprite colours furthest from it (no sprite colour is closer than about
 * 1.25:1, and white, black and the mid hues each read by luminance or hue); a
 * sprite is drawn at a whole number of screen pixels per cell by the renderer.
 */
export const PIXEL: LookSpec = softLook({
  id: 'pixel',
  machine: 'a flat grey screen, hard-edged pixels',
  amounts: {},
  stroke: { thick: 1.4, wobble: 0 },
  groundAlt: null,
  hot: null,
  enter: {
    pop: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
    rise: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
    slam: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
    fade: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
  },
  mood: {
    calm: { agitation: 0, dim: 0, sway: 0, swayPeriod: 16, lean: 0, snap: 1.1 },
    neutral: { agitation: 0, dim: 0, sway: 0, swayPeriod: 12, lean: 0, snap: 1 },
    playful: { agitation: 0, dim: 0, sway: 0, swayPeriod: 7, lean: 0, snap: 0.9 },
  },
  margin: 0.06,
});
