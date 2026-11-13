import { SIZE_SCALE } from '@conduit/language';
import type { Gamut, LookSpec } from '../contracts/look';
import { rolesOf, spritePalette } from './common';

const uniform = (scale: number): { x: number; y: number } => ({ x: scale, y: scale });

const GAMUT: Gamut = { kind: 'mono', low: '#a87400', high: '#ffd070' };
const GROUND_ALT = null;

/** DEC VT320 with the amber tube, 1987. One phosphor, three beam intensities. */
export const PHOSPHOR: LookSpec = {
  id: 'phosphor',
  name: 'Phosphor',
  machine: 'DEC VT320, amber phosphor, 1987',

  roles: rolesOf('phosphor', GAMUT, GROUND_ALT),
  groundAlt: GROUND_ALT,
  gamut: GAMUT,
  emphasis: { ink: 'accent', dim: 'ink', accent: 'accent', alt: 'accent', ground: 'ground' },
  hot: '#fff0c8',

  fx: [
    { name: 'persistence', amount: 1 },
    { name: 'glow', amount: 0.6 },
    { name: 'scanlines', amount: 1 },
    { name: 'curve', amount: 1 },
    { name: 'signal', amount: 1 },
  ],
  stroke: { character: 'clean', thick: 0.9, wobble: 0 },
  sprite: spritePalette(GAMUT),

  type: {
    face: 'terminal',
    pitch: 'fixed',
    font: 'vt323',
    boldFont: null,
    bold: 'bright',
    advance: 0.4,
    lineHeight: 1.1,
    upperOnly: false,
    targetCols: 44,
    minBody: 22,
    maxBody: 40,
    minFont: 14,
    measure: 46,
    sizes: {
      xs: uniform(SIZE_SCALE.xs),
      s: uniform(SIZE_SCALE.s),
      m: uniform(SIZE_SCALE.m),
      l: uniform(SIZE_SCALE.l),
      xl: uniform(SIZE_SCALE.xl),
      xxl: uniform(SIZE_SCALE.xxl),
    },
    snapToCells: false,
    align: 'left',
    bullet: '>',
  },

  motion: {
    step: null,
    cameraStep: null,
    ease: 'out',
    enter: {
      type: { from: {}, ease: 'linear', reveal: true, flicker: false },
      fade: { from: { opacity: 0 }, ease: 'out', reveal: false, flicker: false },
      rise: { from: { opacity: 0, dy: 0.6 }, ease: 'out', reveal: false, flicker: false },
      slam: { from: { opacity: 0, scale: 1.6 }, ease: 'out-hard', reveal: false, flicker: false },
      wipe: { from: {}, ease: 'out', reveal: true, flicker: false },
      cut: { from: {}, ease: 'hold', reveal: false, flicker: false },
      flicker: { from: { opacity: 0 }, ease: 'out', reveal: false, flicker: true },
      draw: { from: {}, ease: 'linear', reveal: true, flicker: false },
      pop: { from: { opacity: 0, scale: 0.6 }, ease: 'out', reveal: false, flicker: false },
    },
    exit: {
      fade: { from: { opacity: 0 }, ease: 'in', reveal: false, flicker: false },
      cut: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
      fall: { from: { opacity: 0, dy: 1.2 }, ease: 'in', reveal: false, flicker: false },
      wipe: { from: {}, ease: 'in', reveal: true, flicker: false },
    },
    blink: 1,
    cursor: true,
    waiting: 'cursor',
  },

  mood: {
    calm: { agitation: 0.1, dim: 0, sway: 0.004, swayPeriod: 14, lean: 0, snap: 1.2 },
    neutral: { agitation: 0.2, dim: 0, sway: 0.003, swayPeriod: 11, lean: 0, snap: 1 },
    tense: { agitation: 0.6, dim: 0, sway: 0.002, swayPeriod: 4, lean: 0.04, snap: 0.75 },
    playful: { agitation: 0.3, dim: 0, sway: 0.006, swayPeriod: 6, lean: 0, snap: 0.85 },
    grave: { agitation: 0.15, dim: 0.25, sway: 0.002, swayPeriod: 20, lean: 0.02, snap: 1.4 },
  },

  margin: 0.07,
  furniture: { top: 0 },
};
