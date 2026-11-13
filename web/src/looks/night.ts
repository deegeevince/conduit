import type { LookSpec } from '../contracts/look';
import { softLook } from './common';

/**
 * Gouache on dark blue board, lit from within. Light bleeds a little and the
 * corners fall away; the sky is flat and cold. Slower than the daylight looks:
 * everything arrives as if it were already there.
 */
export const NIGHT: LookSpec = softLook({
  id: 'night',
  machine: 'gouache on dark blue board, lit from within',
  amounts: { glow: 0.35, grain: 0.25, vignette: 0.45 },
  stroke: { thick: 0.6, wobble: 0 },
  groundAlt: null,
  hot: '#fff8e8',
  mood: {
    calm: { agitation: 0.04, dim: 0, sway: 0.003, swayPeriod: 18, lean: 0, snap: 1.35 },
    neutral: { agitation: 0.08, dim: 0, sway: 0.0025, swayPeriod: 14, lean: 0, snap: 1.15 },
    grave: { agitation: 0.08, dim: 0.12, sway: 0.0015, swayPeriod: 24, lean: 0.02, snap: 1.5 },
  },
});
