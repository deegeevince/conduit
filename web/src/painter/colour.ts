import type { HexColor, InkRole, Layer, Weight } from '@conduit/language';
import type { Colour } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import { LARGE_TEXT_PX, MIN_CONTRAST, MIN_EMPHASIS_STEP, contrastRatio, enforceInGamut, mapIntoGamut, mix } from '../looks/colour-math';

export { LARGE_TEXT_PX, MIN_CONTRAST, MIN_EMPHASIS_STEP, contrastRatio };

/** Brings any colour into what the look's machine could show. */
export function mapToGamut(colour: Colour, look: LookSpec): Colour {
  return mapIntoGamut(colour, look.gamut);
}

function enforce(colour: Colour, against: readonly Colour[], minimum: number, look: LookSpec): Colour {
  return enforceInGamut(colour, against, minimum, look.gamut);
}

/** Large type (24 px and up on screen) and anything on the far plane are held to 3:1; everything else to 4.5:1. */
export function minContrastFor(screenPx: number, layer: Layer): number {
  return layer === 'bg' || screenPx >= LARGE_TEXT_PX ? MIN_CONTRAST.large : MIN_CONTRAST.normal;
}

export interface InkContext {
  /** the contrast ratio the ink must reach against the worse of the look's grounds; see `minContrastFor` */
  readonly minRatio: number;
  /**
   * What is actually behind the text when it lands on something drawn: the
   * ink is judged against this as well as the grounds. Omit it (or pass null)
   * for text on the bare stage; for text that gets a plate, leave it out and
   * ask `plateFor` instead.
   */
  readonly behind?: Colour | null;
  readonly weight: Weight;
  /** inside an `*emphasis*` span */
  readonly emphasised: boolean;
  /** knocked out of a `mark=invert` bar: the bar takes the ink's colour and the text takes the ground's */
  readonly onBar: boolean;
}

/** Per spec object: `specFor` hands out one object per look, so a look redefined under the same name cannot read another's answers. */
const memos = new WeakMap<LookSpec, Map<string, Colour>>();

/**
 * The colour actually drawn for an ink: the role's colour, or the brain's hex
 * mapped into the gamut, then pushed away from what it sits on until it meets
 * the minimum contrast for its size against the WORSE of the look's grounds.
 * The brain may pick a clash; the screen never shows one.
 *
 * In a look whose bold is `bright`, bold `ink` is drawn at the accent's
 * intensity: on a monochrome tube that is what bold is.
 */
export function resolveInk(ink: InkRole | HexColor, look: LookSpec, context: InkContext): Colour {
  const key = `${ink}|${context.minRatio}|${context.weight}|${context.emphasised ? 1 : 0}|${context.onBar ? 1 : 0}|${context.behind ?? ''}`;
  let memo = memos.get(look);
  if (memo === undefined) {
    memo = new Map();
    memos.set(look, memo);
  }
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const result = resolveUncached(ink, look, context);
  if (memo.size > 4000) memo.clear();
  memo.set(key, result);
  return result;
}

function isRole(ink: InkRole | HexColor): ink is InkRole {
  return !ink.startsWith('#');
}

/** A role's colour; on a tube whose bold is a brighter beam, bold `ink` is drawn at the accent's intensity. */
function roleColour(role: InkRole, look: LookSpec, weight: Weight): Colour {
  return role === 'ink' && weight === 'bold' && look.type.bold === 'bright' ? look.roles.accent : look.roles[role];
}

function resolveUncached(ink: InkRole | HexColor, look: LookSpec, context: InkContext): Colour {
  const minimum = context.minRatio;
  const grounds = [look.roles.ground];
  if (look.groundAlt !== null) grounds.push(look.groundAlt);
  if (context.behind !== undefined && context.behind !== null) grounds.push(context.behind);
  let base: Colour;
  if (isRole(ink)) {
    const plain = roleColour(ink, look, context.weight);
    base = plain;
    if (context.emphasised) {
      base = roleColour(look.emphasis[ink], look, context.weight);
      // bold, strong and accent text are already at the top of the ramp: emphasis goes above it rather than vanish
      if (look.hot !== null && contrastRatio(base, plain) < MIN_EMPHASIS_STEP) base = look.hot;
    }
  } else {
    base = mapToGamut(ink, look);
    if (context.emphasised && look.hot !== null && contrastRatio(look.hot, base) >= MIN_EMPHASIS_STEP) base = look.hot;
  }
  if (!context.onBar) return enforce(base, grounds, minimum, look);
  const bar = isRole(ink) && ink === 'ground' ? look.roles.ink : enforce(base, grounds, minimum, look);
  return enforce(look.roles.ground, [bar], minimum, look);
}

/**
 * How solid a plate of the ground colour must be behind text for it to read:
 * 0 when `text` already passes against `behind`, otherwise the least opacity
 * of `ground` laid over `behind` that restores the minimum ratio for text of
 * `screenPx`, in steps of one hundredth (rounded up, so the ratio is met).
 * 1 when even a solid plate does not do it: the text colour itself is wrong
 * for this ground, and `resolveInk` is what fixes that.
 */
export function plateFor(text: Colour, behind: Colour, ground: Colour, screenPx: number): number {
  const minimum = screenPx >= LARGE_TEXT_PX ? MIN_CONTRAST.large : MIN_CONTRAST.normal;
  if (contrastRatio(text, behind) >= minimum) return 0;
  for (let step = 1; step <= 100; step += 1) {
    const opacity = step / 100;
    if (contrastRatio(text, mix(behind, ground, opacity)) >= minimum) return opacity;
  }
  return 1;
}

/** A sprite colour is lost on a ground it is closer than this to. */
export const SPRITE_VISIBLE = 1.5;

/**
 * The surface a sprite needs under it so that every colour it uses shows:
 * null when each of `used` already stands 1.5:1 clear of `ground` (or of the
 * look's second ground), otherwise the colour of a backing tile that keeps
 * the worst of them furthest from it, chosen among the look's own roles and
 * a ladder of greys, moved into the look's gamut; null too when no tile
 * would do better than the ground (the sixteen colours at once have no
 * single backing). A tile is a surface, not
 * ink: it only has to be a contrasting field, so it is not held to the text bar.
 */
export function spriteBacking(used: readonly Colour[], look: LookSpec): Colour | null {
  if (used.length === 0) return null;
  const grounds = [look.roles.ground];
  if (look.groundAlt !== null) grounds.push(look.groundAlt);
  const worst = (against: readonly Colour[]): number => Math.min(...used.flatMap((colour) => against.map((ground) => contrastRatio(colour, ground))));
  if (worst(grounds) >= SPRITE_VISIBLE) return null;
  const candidates: Colour[] = [look.roles.ground, look.roles.ink, look.roles.dim, look.roles.accent, look.roles.alt];
  for (let step = 0; step <= 255; step += 15) {
    const hex = step.toString(16).padStart(2, '0');
    candidates.push(`#${hex}${hex}${hex}` as Colour);
  }
  let best: Colour | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const colour = mapToGamut(candidate, look);
    const score = worst([colour]);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = colour;
    }
  }
  // a tile that does not help the worst colour is no tile
  return bestScore > worst(grounds) + 0.05 ? best : null;
}
