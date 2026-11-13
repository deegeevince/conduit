import type { LookSpec } from '../contracts/look';
import { softLook } from './common';

/**
 * A cyanotype of a drawing in ruling pen: exact, thin, nothing wobbles. Type is
 * typed in and lines are drawn at the constant speed of a plotter. Nothing in
 * it is nervous, whatever the mood.
 */
export const BLUEPRINT: LookSpec = softLook({
  id: 'blueprint',
  machine: 'a cyanotype print of a drawing in ruling pen',
  amounts: { grid: 0.45, grain: 0.15 },
  stroke: { thick: 0.5, wobble: 0 },
  // the grid's lines sit this close to the paper: any nearer to the text colours and `alt` would fail against them
  groundAlt: '#19427c',
  hot: '#ffffff',
  enter: {
    draw: { from: {}, ease: 'linear', reveal: true, flicker: false },
    wipe: { from: {}, ease: 'linear', reveal: true, flicker: false },
  },
  mood: {
    calm: { agitation: 0.02, dim: 0, sway: 0.002, swayPeriod: 14, lean: 0, snap: 1.2 },
    neutral: { agitation: 0.03, dim: 0, sway: 0.002, swayPeriod: 11, lean: 0, snap: 1 },
    tense: { agitation: 0.15, dim: 0, sway: 0.0015, swayPeriod: 5, lean: 0.03, snap: 0.8 },
    playful: { agitation: 0.06, dim: 0, sway: 0.003, swayPeriod: 7, lean: 0, snap: 0.9 },
    grave: { agitation: 0.03, dim: 0.12, sway: 0.0015, swayPeriod: 20, lean: 0.02, snap: 1.4 },
  },
});
