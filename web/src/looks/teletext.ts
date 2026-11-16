import type { Gamut, LookSpec } from '../contracts/look';
import { rolesOf, spritePalette } from './common';

const GAMUT: Gamut = { kind: 'palette', colours: ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#7f7f7f'] };
const GROUND_ALT = null;

/**
 * Ceefax-era teletext as the SAA5050 character generator drew it (BBC Micro
 * Mode 7, 1981). The eight Level 1 colours, plus one concession: the
 * half-intensity white of Level 2.5 stands in for `dim`, because Level 1 has
 * nothing that recedes and still passes contrast.
 */
export const TELETEXT: LookSpec = {
  id: 'teletext',
  name: 'Teletext',
  machine: 'Ceefax on the Mullard SAA5050 (BBC Micro Mode 7), 1981',

  roles: rolesOf('teletext', GAMUT, GROUND_ALT),
  groundAlt: GROUND_ALT,
  gamut: GAMUT,
  emphasis: { ink: 'accent', dim: 'ink', accent: 'alt', alt: 'accent', ground: 'ground' },
  hot: null,

  fx: [
    { name: 'pixelate', amount: 1 },
    { name: 'dither', amount: 1 },
    { name: 'signal', amount: 1 },
    { name: 'header', amount: 1 },
  ],
  stroke: { character: 'pixel', thick: 1.4, wobble: 0 },
  sprite: spritePalette(GAMUT),

  type: {
    face: 'teletext',
    pitch: 'fixed',
    font: 'bedstead',
    boldFont: null,
    bold: 'none',
    advance: 0.6,
    lineHeight: 1,
    upperOnly: false,
    targetCols: 40,
    minBody: 16,
    maxBody: 36,
    minFont: 16,
    measure: 40,
    // Level 1 could only double a row's height; double size and beyond are the banner sizes later levels added.
    sizes: {
      xs: { x: 1, y: 1 },
      s: { x: 1, y: 1 },
      m: { x: 1, y: 1 },
      l: { x: 1, y: 2 },
      xl: { x: 2, y: 2 },
      xxl: { x: 3, y: 3 },
    },
    snapToCells: true,
    align: 'left',
    bullet: '*',
  },

  motion: {
    step: 12.5,
    cameraStep: 25,
    ease: 'linear',
    enter: {
      type: { from: {}, ease: 'linear', reveal: true, flicker: false },
      fade: { from: { opacity: 0 }, ease: 'linear', reveal: false, flicker: false },
      rise: { from: { opacity: 0, dy: 1 }, ease: 'linear', reveal: false, flicker: false },
      slam: { from: { scale: 2 }, ease: 'out-hard', reveal: false, flicker: false },
      wipe: { from: {}, ease: 'linear', reveal: true, flicker: false },
      cut: { from: {}, ease: 'hold', reveal: false, flicker: false },
      flicker: { from: { opacity: 0 }, ease: 'linear', reveal: false, flicker: true },
      draw: { from: {}, ease: 'linear', reveal: true, flicker: false },
      pop: { from: { opacity: 0, scale: 0.6 }, ease: 'out', reveal: false, flicker: false },
    },
    exit: {
      fade: { from: { opacity: 0 }, ease: 'linear', reveal: false, flicker: false },
      cut: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
      fall: { from: { opacity: 0, dy: 2 }, ease: 'linear', reveal: false, flicker: false },
      wipe: { from: {}, ease: 'linear', reveal: true, flicker: false },
    },
    blink: 1,
    cursor: false,
    waiting: 'dots',
  },

  mood: {
    calm: { agitation: 0.05, dim: 0, sway: 0.002, swayPeriod: 16, lean: 0, snap: 1.1 },
    neutral: { agitation: 0.1, dim: 0, sway: 0.002, swayPeriod: 12, lean: 0, snap: 1 },
    tense: { agitation: 0.45, dim: 0, sway: 0.002, swayPeriod: 5, lean: 0.04, snap: 0.8 },
    playful: { agitation: 0.15, dim: 0, sway: 0.004, swayPeriod: 7, lean: 0, snap: 0.9 },
    grave: { agitation: 0.1, dim: 0.2, sway: 0.001, swayPeriod: 20, lean: 0.02, snap: 1.3 },
  },

  margin: 0.05,
  furniture: { top: 1 },
  shade: false,
};
