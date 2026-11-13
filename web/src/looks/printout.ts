import { SIZE_SCALE } from '@conduit/language';
import type { Gamut, LookSpec } from '../contracts/look';
import { rolesOf, spritePalette } from './common';

const GAMUT: Gamut = { kind: 'ink', maxLightness: 0.4 };
const GROUND_ALT = '#d7e6d0';

/**
 * An Epson MX-80 printing on green-bar fanfold paper, 1980. The printer's own
 * modes are the size ladder: normal pitch for body, double width for
 * emphasis. The red second ribbon is borrowed from two-colour teleprinters.
 */
export const PRINTOUT: LookSpec = {
  id: 'printout',
  name: 'Printout',
  machine: 'Epson MX-80 on green-bar fanfold paper, 1980',

  roles: rolesOf('printout', GAMUT, GROUND_ALT),
  groundAlt: GROUND_ALT,
  gamut: GAMUT,
  emphasis: { ink: 'accent', dim: 'ink', accent: 'ink', alt: 'accent', ground: 'ground' },
  hot: null,

  fx: [
    { name: 'bars', amount: 1 },
    { name: 'ribbon', amount: 1 },
    { name: 'shadow', amount: 1 },
    { name: 'paper', amount: 0.6 },
  ],
  stroke: { character: 'pencil', thick: 0.8, wobble: 0.15 },
  sprite: spritePalette(GAMUT),

  type: {
    face: 'dot',
    pitch: 'fixed',
    font: 'doto-700',
    boldFont: 'doto-900',
    bold: 'face',
    advance: 0.6,
    lineHeight: 1.2,
    upperOnly: false,
    targetCols: 44,
    minBody: 17,
    maxBody: 30,
    minFont: 13,
    measure: 48,
    sizes: {
      // The MX-80's condensed mode: the same height as `s`, set narrow. It is told apart from `s` by width.
      xs: { x: SIZE_SCALE.s * 0.6, y: SIZE_SCALE.s },
      s: { x: SIZE_SCALE.s, y: SIZE_SCALE.s },
      m: { x: 1, y: 1 },
      l: { x: 2, y: 1 },
      xl: { x: 2, y: 2 },
      xxl: { x: 3, y: 3 },
    },
    snapToCells: true,
    align: 'left',
    bullet: '-',
  },

  motion: {
    step: 24,
    cameraStep: null,
    ease: 'out',
    enter: {
      type: { from: {}, ease: 'linear', reveal: true, flicker: false },
      fade: { from: { opacity: 0 }, ease: 'linear', reveal: false, flicker: false },
      rise: { from: { opacity: 0, dy: 1.2 }, ease: 'out', reveal: false, flicker: false },
      slam: { from: { opacity: 0, scale: 1.25 }, ease: 'out-hard', reveal: false, flicker: false },
      wipe: { from: {}, ease: 'linear', reveal: true, flicker: false },
      cut: { from: {}, ease: 'hold', reveal: false, flicker: false },
      flicker: { from: { opacity: 0 }, ease: 'linear', reveal: false, flicker: true },
      draw: { from: {}, ease: 'linear', reveal: true, flicker: false },
      pop: { from: { opacity: 0, scale: 0.6 }, ease: 'out', reveal: false, flicker: false },
    },
    // Ink does not fade off paper. Leaving gently means the paper feeds on.
    exit: {
      fade: { from: { opacity: 0, dy: -6 }, ease: 'in', reveal: false, flicker: false },
      cut: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
      fall: { from: { opacity: 0, dy: 4 }, ease: 'in', reveal: false, flicker: false },
      wipe: { from: {}, ease: 'linear', reveal: true, flicker: false },
    },
    blink: 0.9,
    cursor: true,
    waiting: 'cursor',
  },

  mood: {
    calm: { agitation: 0.1, dim: 0, sway: 0.003, swayPeriod: 16, lean: 0, snap: 1.2 },
    neutral: { agitation: 0.2, dim: 0, sway: 0.002, swayPeriod: 12, lean: 0, snap: 1 },
    tense: { agitation: 0.5, dim: 0, sway: 0.002, swayPeriod: 5, lean: 0.04, snap: 0.8 },
    playful: { agitation: 0.3, dim: 0, sway: 0.004, swayPeriod: 7, lean: 0, snap: 0.9 },
    grave: { agitation: 0.15, dim: 0.15, sway: 0.001, swayPeriod: 22, lean: 0.02, snap: 1.4 },
  },

  margin: 0.07,
  furniture: { top: 0 },
};
