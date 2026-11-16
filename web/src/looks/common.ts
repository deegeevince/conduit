// What the presets share. Each preset file states only what makes it itself.

import { LOOK, SIZE_SCALE, SPRITE_PALETTE } from '@conduit/language';
import type { EnterEffect, ExitEffect, Face, FxName, LookId, Mood } from '@conduit/language';
import type { Colour } from '../contracts/frame';
import type { FxSetting, Gamut, LookSpec, MoodCharacter, MotionRecipe } from '../contracts/look';
import { FACES } from '../fonts/faces';
import { MIN_CONTRAST, enforceInGamut, mapIntoGamut } from './colour-math';

/**
 * The sixteen sprite colours as a look with this gamut shows them: an amber
 * tube keeps their luminance, teletext the nearest of its colours. A look that
 * can show any colour shows them as the language defines them (pixels are
 * pixels), printed ink included.
 */
export function spritePalette(gamut: Gamut): readonly Colour[] {
  return gamut.kind === 'mono' || gamut.kind === 'palette' ? SPRITE_PALETTE.map((colour) => mapIntoGamut(colour, gamut)) : SPRITE_PALETTE;
}

/**
 * The five roles of a preset, from the language's definition of it, each moved
 * (keeping its hue) only as far as it must go to pass 4.5:1 against the
 * ground and the look's second ground. A preset is readable by construction.
 */
export function rolesOf(id: LookId, gamut: Gamut, groundAlt: Colour | null): LookSpec['roles'] {
  const spec = LOOK[id];
  const grounds = groundAlt === null ? [spec.ground] : [spec.ground, groundAlt];
  const fit = (colour: Colour): Colour => enforceInGamut(colour, grounds, MIN_CONTRAST.normal, gamut);
  return { ground: spec.ground, ink: fit(spec.ink), dim: fit(spec.dim), accent: fit(spec.accent), alt: fit(spec.alt) };
}

const uniform = (scale: number): { x: number; y: number } => ({ x: scale, y: scale });

/** How things arrive on a surface with no machine behind it: eased, never stepped. */
export const SOFT_ENTER: Readonly<Record<EnterEffect, MotionRecipe>> = {
  type: { from: {}, ease: 'linear', reveal: true, flicker: false },
  fade: { from: { opacity: 0 }, ease: 'out', reveal: false, flicker: false },
  rise: { from: { opacity: 0, dy: 0.5 }, ease: 'out', reveal: false, flicker: false },
  slam: { from: { opacity: 0, scale: 1.5 }, ease: 'out-hard', reveal: false, flicker: false },
  wipe: { from: {}, ease: 'out', reveal: true, flicker: false },
  cut: { from: {}, ease: 'hold', reveal: false, flicker: false },
  flicker: { from: { opacity: 0 }, ease: 'out', reveal: false, flicker: true },
  draw: { from: {}, ease: 'in-out', reveal: true, flicker: false },
  pop: { from: { opacity: 0, scale: 0.6 }, ease: 'out', reveal: false, flicker: false },
};

export const SOFT_EXIT: Readonly<Record<ExitEffect, MotionRecipe>> = {
  fade: { from: { opacity: 0 }, ease: 'in', reveal: false, flicker: false },
  cut: { from: { opacity: 0 }, ease: 'hold', reveal: false, flicker: false },
  fall: { from: { opacity: 0, dy: 1.2 }, ease: 'in', reveal: false, flicker: false },
  wipe: { from: {}, ease: 'in', reveal: true, flicker: false },
};

export const SOFT_MOOD: Readonly<Record<Mood, MoodCharacter>> = {
  calm: { agitation: 0.05, dim: 0, sway: 0.004, swayPeriod: 14, lean: 0, snap: 1.2 },
  neutral: { agitation: 0.1, dim: 0, sway: 0.003, swayPeriod: 11, lean: 0, snap: 1 },
  tense: { agitation: 0.5, dim: 0, sway: 0.002, swayPeriod: 4, lean: 0.04, snap: 0.75 },
  playful: { agitation: 0.2, dim: 0, sway: 0.006, swayPeriod: 6, lean: 0, snap: 0.85 },
  grave: { agitation: 0.1, dim: 0.2, sway: 0.002, swayPeriod: 20, lean: 0.02, snap: 1.4 },
};

/** What a face needs of the type block that the face table does not say: how big it is set and how long its lines run. Per face, because a hand and a heavy poster face are not read alike. */
export type SoftFace = 'serif' | 'sans' | 'hand' | 'display' | 'mono';

const SOFT_TYPE: Readonly<Record<SoftFace, { targetCols: number; minBody: number; maxBody: number; minFont: number; measure: number; bullet: string }>> = {
  serif: { targetCols: 58, minBody: 18, maxBody: 34, minFont: 12, measure: 64, bullet: '\u2013' },
  sans: { targetCols: 58, minBody: 17, maxBody: 32, minFont: 12, measure: 64, bullet: '-' },
  hand: { targetCols: 54, minBody: 22, maxBody: 40, minFont: 14, measure: 60, bullet: '-' },
  display: { targetCols: 44, minBody: 20, maxBody: 34, minFont: 14, measure: 48, bullet: '*' },
  mono: { targetCols: 58, minBody: 16, maxBody: 30, minFont: 12, measure: 64, bullet: '>' },
};

/** The type block of a look with no machine behind it, set in one of the five soft faces. */
export function softType(face: SoftFace): LookSpec['type'] {
  const spec = FACES[face];
  const tuning = SOFT_TYPE[face];
  return {
    face,
    pitch: spec.pitch,
    font: spec.font,
    boldFont: spec.boldFont,
    bold: spec.bold,
    advance: spec.advance,
    lineHeight: spec.lineHeight,
    upperOnly: false,
    ...tuning,
    sizes: { xs: uniform(SIZE_SCALE.xs), s: uniform(SIZE_SCALE.s), m: uniform(SIZE_SCALE.m), l: uniform(SIZE_SCALE.l), xl: uniform(SIZE_SCALE.xl), xxl: uniform(SIZE_SCALE.xxl) },
    snapToCells: false,
    align: 'left',
  };
}

export function isSoftFace(face: Face): face is SoftFace {
  return face === 'serif' || face === 'sans' || face === 'hand' || face === 'display' || face === 'mono';
}

export interface SoftLook {
  readonly id: LookId;
  /** the material it is pinned to, the way a retro preset is pinned to a machine */
  readonly machine: string;
  /** how strongly each effect of the look is applied; an effect not named here is applied at 0.5 */
  readonly amounts: Readonly<Partial<Record<FxName, number>>>;
  readonly stroke: { readonly thick: number; readonly wobble: number };
  /** a second ground the surface has (a grid line, a paper tooth), for the contrast check; null when it has none */
  readonly groundAlt: Colour | null;
  /** a level brighter than the ink for emphasis on a dark ground; null when emphasis is told by hue */
  readonly hot: Colour | null;
  /** the look's own manner of arriving and leaving; an entrance not named is the shared soft one */
  readonly enter?: Readonly<Partial<Record<EnterEffect, MotionRecipe>>>;
  readonly exit?: Readonly<Partial<Record<ExitEffect, MotionRecipe>>>;
  readonly mood?: Readonly<Partial<Record<Mood, MoodCharacter>>>;
  readonly blink?: number;
  readonly margin?: number;
  /** the painter lights the brain's shapes in this look (behind `?shade=1`) */
  readonly shade?: boolean;
}

/**
 * A preset with no machine behind it, built from the language's definition of
 * the look: palette, face, fx and stroke are read from `LOOK`, so they have
 * one home. DESIGN.md says why each look's numbers are what they are.
 */
export function softLook(look: SoftLook): LookSpec {
  const spec = LOOK[look.id];
  const face = spec.face;
  if (!isSoftFace(face)) throw new Error(`${look.id} is set in ${face}, which is a machine's face: write it out like phosphor.ts does`);
  const gamut: Gamut = { kind: 'any' };
  const fx: FxSetting[] = spec.fx.map((name) => ({ name, amount: look.amounts[name] ?? 0.5 }));
  return {
    id: look.id,
    name: look.id,
    machine: look.machine,
    roles: rolesOf(look.id, gamut, look.groundAlt),
    groundAlt: look.groundAlt,
    gamut,
    emphasis: { ink: 'accent', dim: 'ink', accent: 'alt', alt: 'accent', ground: 'ground' },
    hot: look.hot,
    fx,
    stroke: { character: spec.stroke, thick: look.stroke.thick, wobble: look.stroke.wobble },
    sprite: spritePalette(gamut),
    type: softType(face),
    motion: {
      step: null,
      cameraStep: null,
      ease: 'out',
      enter: { ...SOFT_ENTER, ...look.enter },
      exit: { ...SOFT_EXIT, ...look.exit },
      blink: look.blink ?? 1.2,
      cursor: false,
      waiting: 'dots',
    },
    mood: { ...SOFT_MOOD, ...look.mood },
    margin: look.margin ?? 0.07,
    furniture: { top: 0 },
    shade: look.shade ?? false,
  };
}
