import type { LookSpec } from '../contracts/look';
import { softLook } from './common';

/**
 * Pencil and ink on cartridge paper in even daylight: the default, and the
 * quietest look. Things arrive by fading in, drawings by a hand that eases in
 * and out; the pencil strays a fifth of a unit from true, decided once.
 */
export const PAPER: LookSpec = softLook({
  id: 'paper',
  machine: 'pencil and ink on cartridge paper',
  amounts: { paper: 0.45, grain: 0.2 },
  stroke: { thick: 0.7, wobble: 0.2 },
  groundAlt: null,
  hot: null,
  shade: true,
  margin: 0.08,
  mood: {
    calm: { agitation: 0.04, dim: 0, sway: 0.003, swayPeriod: 16, lean: 0, snap: 1.25 },
    neutral: { agitation: 0.08, dim: 0, sway: 0.003, swayPeriod: 12, lean: 0, snap: 1 },
  },
});
