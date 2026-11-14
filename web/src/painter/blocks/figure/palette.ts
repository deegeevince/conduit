// Shading from a hue (PLAN-visuals 2(a)/(d)): each fill gets a darker outline of the same hue, a top light and a contact shadow, derived with
// `looks/colour-math.ts`, so a brain writes `fill=blue` and the kit does the arithmetic. A fill is also held apart from the ground (a contrast the
// look's own gamut can show), and every colour is brought into the look's gamut, so a one-phosphor tube still gets a light and a shade.
// Pure: no DOM, no clock.

import type { Colour } from '../../../contracts/frame';
import type { Gamut } from '../../../contracts/look';
import { contrastRatio, enforceInGamut, fromHsl, mapIntoGamut, mix, toHsl } from '../../../looks/colour-math';

/** What a figure reads of the look: its five roles and the machine's gamut. */
export interface FigureLook {
  readonly ground: Colour;
  readonly ink: Colour;
  readonly dim: Colour;
  readonly accent: Colour;
  readonly alt: Colour;
  readonly gamut: Gamut;
}

/** Plain hue words a brain may write: colours, and the materials a drawing has. Brand-agnostic. */
const HUES: Readonly<Record<string, Colour>> = {
  red: '#d9453f',
  crimson: '#b8324a',
  orange: '#e8832a',
  yellow: '#e9c43c',
  gold: '#d9a82a',
  green: '#3fa35b',
  leaf: '#4f9a3f',
  lime: '#8bbf3a',
  teal: '#2b9c93',
  cyan: '#2fa8c8',
  blue: '#3f74d6',
  navy: '#27408b',
  indigo: '#5a58d0',
  purple: '#8d56c9',
  violet: '#7e62d8',
  pink: '#de6a9a',
  magenta: '#c4429b',
  brown: '#8f5c38',
  tan: '#cdb184',
  sand: '#d8c298',
  grey: '#8b919d',
  gray: '#8b919d',
  black: '#353a45',
  white: '#e9ebef',
  // what a drawing is made of
  muscle: '#b8505c',
  flesh: '#e0a58f',
  skin: '#e6b99d',
  bone: '#e6dcc2',
  fat: '#efd98e',
  blood: '#b8302f',
  water: '#4f9fd6',
  glass: '#9cc9dc',
  metal: '#a3abb8',
  steel: '#8e98a8',
  iron: '#6c7380',
  rubber: '#4a4d57',
  plastic: '#5a86c9',
  wood: '#a9743f',
  paper: '#ece4d2',
  petal: '#e8709b',
  stem: '#4c9a4a',
  soil: '#7a5a3e',
  sun: '#f0b429',
};

export const HUE_NAMES: readonly string[] = Object.keys(HUES);

/** A hue word, `#rgb` or `#rrggbb`; null for anything else. */
export function hueOf(word: string | undefined): Colour | null {
  if (word === undefined) return null;
  const w = word.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const named = HUES[w];
  if (named !== undefined) return named;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(w)) return w.length === 4 ? `#${[...w.slice(1)].map((c) => c + c).join('')}` : w;
  return null;
}

export interface Shade {
  /** the top of a fill's gradient: where the light lands */
  readonly top: Colour;
  /** the bottom of it: the hue itself, a little under */
  readonly bottom: Colour;
  /** the same hue, darker */
  readonly outline: Colour;
  /** a soft light, for the top of a rounded shape */
  readonly light: Colour;
  /** an open part's own colour, and the one it is edged with */
  readonly line: Colour;
  readonly lineEdge: Colour;
  /** hatch ink for a cut face */
  readonly hatch: Colour;
}

/** The ground is dark enough that a light shade is the way to stand out from it. */
const isDark = (ground: Colour): boolean => contrastRatio(ground, '#000000') < contrastRatio(ground, '#ffffff');

const within = (c: Colour, gamut: Gamut): Colour => mapIntoGamut(c, gamut);

function lift(c: Colour, dl: number, ds = 0): Colour {
  const [h, s, l] = toHsl(c);
  return fromHsl(h, Math.max(0, Math.min(1, s + ds)), Math.max(0, Math.min(1, l + dl)));
}

/** Shading for a hue on this look. An unknown or absent hue is a neutral drawn from the look's own inks. */
export function shadeFor(hue: string | undefined, look: FigureLook): Shade {
  const dark = isDark(look.ground);
  const named = hueOf(hue);
  const base0: Colour = named ?? (hue === undefined ? mix(look.ground, look.ink, dark ? 0.32 : 0.2) : look.alt);
  // a fill stands off the ground by at least this much, and still takes the light
  let base = enforceInGamut(base0, [look.ground], 1.7, look.gamut);
  base = lift(base, dark ? 0 : 0, 0);
  const top = within(lift(base, 0.14, -0.04), look.gamut);
  const bottom = within(lift(base, -0.05), look.gamut);
  const outlineRaw = lift(base, -0.26, 0.04);
  // the outline is darker than the fill by a visible step, and stands off the ground too
  let outline = enforceInGamut(outlineRaw, [look.ground], 1.5, look.gamut);
  if (contrastRatio(outline, base) < 1.6) outline = lift(base, dark ? 0.3 : -0.36, 0);
  outline = within(outline, look.gamut);
  const light = within(mix(base, '#ffffff', 0.62), look.gamut);
  const line = within(enforceInGamut(base0, [look.ground], 2.2, look.gamut), look.gamut);
  const lineEdge = within(lift(line, dark ? -0.3 : -0.3, 0.03), look.gamut);
  const hatch = within(mix(outline, look.ground, 0.25), look.gamut);
  return { top, bottom, outline, light, line, lineEdge, hatch };
}

/** The ink of a contact shadow: the ground, deepened. */
export const shadowInk = (look: FigureLook): Colour => within(mix(look.ground, '#000000', 0.7), look.gamut);
