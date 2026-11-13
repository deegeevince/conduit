import { LOOK, resolveLook } from '@conduit/language';
import type { Face, LookId, LookSheet, ResolvedLook, StrokeCharacter } from '@conduit/language';
import type { Colour } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import { BLUEPRINT } from './blueprint';
import { CHALK } from './chalk';
import { MIN_CONTRAST, enforceInGamut, fromHsl, luminance, mapIntoGamut, mix, toHsl, worstContrast } from './colour-math';
import { softType } from './common';
import { NIGHT } from './night';
import { PAPER } from './paper';
import { PHOSPHOR } from './phosphor';
import { PIXEL } from './pixel';
import { PRINTOUT } from './printout';
import { RISO } from './riso';
import { TELETEXT } from './teletext';

/** Every preset the painter can perform, as shipped. A look that is not in this table does not exist. */
export const LOOKS: Readonly<Record<LookId, LookSpec>> = {
  paper: PAPER,
  night: NIGHT,
  chalk: CHALK,
  blueprint: BLUEPRINT,
  riso: RISO,
  phosphor: PHOSPHOR,
  pixel: PIXEL,
  teletext: TELETEXT,
  printout: PRINTOUT,
};

/**
 * The spec for the look a schedule is wearing: the preset as shipped when the
 * brain chose one, otherwise the preset it stands on with the brain's
 * palette, face, fx and stroke laid over it.
 *
 * - A brain's colours are taken as written for `ground`, then every other
 *   role is moved, within the preset's gamut, until it passes the contrast
 *   rule against that ground: the brain can ask for any palette and the stage
 *   never shows an unreadable one. `groundAlt` and `hot` follow the ground.
 *   Only when the preset's machine has nothing readable on the new ground does
 *   a role leave the gamut, keeping its hue.
 * - A changed face replaces the `type` fields that come from `FACES`; sizes,
 *   measure and columns follow the face (a machine's face brings the
 *   machine's grid).
 * - A changed fx list replaces the list; each effect takes the preset's
 *   amount when the preset has it, otherwise 0.5.
 * - The result is cached by the resolved look's content, so two frames of
 *   the same look share one object and a renderer can compare by identity.
 */
export function specFor(look: ResolvedLook): LookSpec {
  const preset = LOOKS[look.preset];
  if (isPresetAsShipped(look)) return preset;
  const key = JSON.stringify([look.name, look.preset, look.ground, look.ink, look.dim, look.accent, look.alt, look.face, look.fx, look.stroke]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const built = invent(look, preset);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, built);
  return built;
}

const CACHE_LIMIT = 256;
const cache = new Map<string, LookSpec>();

const STROKE_DEFAULTS: Readonly<Record<StrokeCharacter, { thick: number; wobble: number }>> = {
  clean: { thick: 0.7, wobble: 0 },
  pencil: { thick: 0.7, wobble: 0.2 },
  marker: { thick: 1.4, wobble: 0.12 },
  chalk: { thick: 1.1, wobble: 0.25 },
  pixel: { thick: 1.4, wobble: 0 },
};

const DEFAULT_AMOUNT = 0.5;

function isPresetAsShipped(look: ResolvedLook): boolean {
  if (look.name !== look.preset) return false;
  const shipped = LOOK[look.preset];
  return (
    look.ground === shipped.ground &&
    look.ink === shipped.ink &&
    look.dim === shipped.dim &&
    look.accent === shipped.accent &&
    look.alt === shipped.alt &&
    look.face === shipped.face &&
    look.stroke === shipped.stroke &&
    sameList(look.fx, shipped.fx)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** The type block a face brings: the machine's grid for a machine's face, the soft block for the rest. */
function typeFor(face: Face): LookSpec['type'] {
  if (face === 'terminal') return PHOSPHOR.type;
  if (face === 'teletext') return TELETEXT.type;
  if (face === 'dot') return PRINTOUT.type;
  return softType(face);
}

/** Where the preset's second ground sits relative to its ground, carried over to a ground of the brain's. */
function followGround(preset: LookSpec, ground: Colour): Colour | null {
  const alt = preset.groundAlt;
  if (alt === null) return null;
  if (ground === preset.roles.ground) return alt;
  const [h0, s0, l0] = toHsl(preset.roles.ground);
  const [h1, s1, l1] = toHsl(alt);
  const [h, s, l] = toHsl(ground);
  const wrap = (turn: number): number => ((turn % 1) + 1) % 1;
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  return fromHsl(wrap(h + (h1 - h0)), clamp(s + (s1 - s0)), clamp(l + (l1 - l0)));
}

function invent(look: ResolvedLook, preset: LookSpec): LookSpec {
  const shipped = LOOK[look.preset];
  const ground = look.ground;
  const groundAlt = followGround(preset, ground);
  const grounds = groundAlt === null ? [ground] : [ground, groundAlt];
  const asked: Readonly<Record<'ink' | 'dim' | 'accent' | 'alt', Colour>> = { ink: look.ink, dim: look.dim, accent: look.accent, alt: look.alt };

  // a colour the brain left as the preset has it is the preset's own (already in its gamut); one it wrote is brought into the machine first
  const role = (name: 'ink' | 'dim' | 'accent' | 'alt'): Colour => {
    const base = asked[name] === shipped[name] ? preset.roles[name] : mapIntoGamut(asked[name], preset.gamut);
    const fitted = enforceInGamut(base, grounds, MIN_CONTRAST.normal, preset.gamut);
    // a second ground on the far side of the ground's lightness leaves nothing that passes both: the ground itself wins
    return grounds.length > 1 && worstContrast(fitted, grounds) < MIN_CONTRAST.normal ? enforceInGamut(base, [ground], MIN_CONTRAST.normal, preset.gamut) : fitted;
  };
  const roles = { ground, ink: role('ink'), dim: role('dim'), accent: role('accent'), alt: role('alt') };

  const type = look.face === preset.type.face ? preset.type : typeFor(look.face);
  const machineFace = look.face === 'terminal' || look.face === 'teletext' || look.face === 'dot';
  const fx = sameList(
    look.fx,
    preset.fx.map((setting) => setting.name),
  )
    ? preset.fx
    : [...new Set(look.fx)].map((name) => ({ name, amount: preset.fx.find((setting) => setting.name === name)?.amount ?? DEFAULT_AMOUNT }));
  const stroke = look.stroke === preset.stroke.character ? preset.stroke : { character: look.stroke, ...STROKE_DEFAULTS[look.stroke] };

  let hot: Colour | null = null;
  if (preset.hot !== null) {
    if (ground === preset.roles.ground && roles.accent === preset.roles.accent) hot = preset.hot;
    else {
      const toward = luminance(ground) > 0.18 ? '#000000' : '#ffffff';
      hot = enforceInGamut(mix(roles.accent, toward, 0.75), grounds, MIN_CONTRAST.normal, { kind: 'any' });
    }
  }

  return {
    ...preset,
    name: look.name,
    machine: `a look of its own, after ${preset.machine}`,
    roles,
    groundAlt,
    hot,
    fx,
    stroke,
    type,
    motion: { ...preset.motion, cursor: machineFace, waiting: machineFace ? 'cursor' : 'dots' },
    furniture: { top: fx.some((setting) => setting.name === 'header') ? Math.max(1, preset.furniture.top) : 0 },
  };
}

/** The spec for a look by name, for callers that hold a sheet rather than a schedule. Falls back to the default preset for a name nobody defined. */
export function specByName(name: string, sheet: LookSheet): LookSpec {
  const resolved = resolveLook(name, sheet);
  return resolved === null ? PAPER : specFor(resolved);
}
