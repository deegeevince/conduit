// What a look's surface does to the way things are drawn into the stage.
// Pools read this and nothing else about a look: whether ink is stored
// relative to paper, whether edges are hard, how depth reads.

import type { FxName, Layer, LookId } from '@conduit/language';
import { Color, Vector2 } from 'three';
import type { Quality } from '../../contracts/frame';
import type { LookSpec } from '../../contracts/look';

/** Size in pixels of the target being drawn into, set by the pipeline around every stage draw. Shared by every shader that needs a pixel. */
export const VIEW_PX = { value: new Vector2(1, 1) };

export interface LayerDepth {
  /** how far toward the ground the layer is pushed, 0..1 */
  readonly fade: number;
  /** blurs the layer at half resolution */
  readonly soft: boolean;
}

export interface SurfaceStyle {
  /** changes when anything a pool bakes into its output changes */
  readonly key: string;
  readonly spec: LookSpec;
  readonly ground: Color;
  /** ink is stored as a share of the paper and multiplied onto the sheet, so it can never be lighter than it */
  readonly multiply: boolean;
  /** `pixelate`: no anti-aliasing, opacity is a dither */
  readonly hard: boolean;
  /** `ribbon`: ink density varies along the line and per dot */
  readonly ribbon: number;
  readonly amounts: Readonly<Partial<Record<FxName, number>>>;
  readonly depth: Readonly<Record<'far' | 'bg', LayerDepth>>;
  /** far strokes are drawn thinner, not paler */
  readonly thin: number;
}

export function luminance(colour: Color): number {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

const NO_FADE: LayerDepth = { fade: 0, soft: false };

/** Each preset says in its own idiom what behind means (DESIGN.md, "Depth"). */
const DEPTH: Readonly<Record<LookId, { far: LayerDepth; bg: LayerDepth; thin: number }>> = {
  paper: { far: { fade: 0.5, soft: false }, bg: { fade: 0.2, soft: false }, thin: 1 },
  night: { far: { fade: 0.2, soft: false }, bg: { fade: 0.08, soft: false }, thin: 1 },
  chalk: { far: { fade: 0.55, soft: false }, bg: { fade: 0.25, soft: false }, thin: 1 },
  blueprint: { far: NO_FADE, bg: NO_FADE, thin: 0.55 },
  riso: { far: { fade: 0.5, soft: false }, bg: { fade: 0.2, soft: false }, thin: 1 },
  phosphor: { far: { fade: 0.45, soft: true }, bg: { fade: 0.3, soft: true }, thin: 1 },
  teletext: { far: NO_FADE, bg: NO_FADE, thin: 1 },
  printout: { far: { fade: 0.35, soft: false }, bg: { fade: 0.2, soft: false }, thin: 1 },
  // A flat mid-grey screen with no fx: depth is said by size alone, so nothing fades.
  pixel: { far: NO_FADE, bg: NO_FADE, thin: 1 },
};

const cache = new WeakMap<LookSpec, Map<Quality, SurfaceStyle>>();
let counter = 0;
const keys = new WeakMap<LookSpec, number>();

export function styleOf(spec: LookSpec, quality: Quality): SurfaceStyle {
  if (FLAT.has(spec)) return flat(spec);
  let byQuality = cache.get(spec);
  if (byQuality === undefined) {
    byQuality = new Map();
    cache.set(spec, byQuality);
  }
  const found = byQuality.get(quality);
  if (found !== undefined) return found;
  const amounts: Partial<Record<FxName, number>> = {};
  for (const setting of spec.fx) amounts[setting.name] = Math.max(0, Math.min(1, setting.amount));
  const ground = new Color(spec.roles.ground);
  const multiply = ((amounts.bars ?? 0) > 0 || (amounts.paper ?? 0) > 0) && luminance(ground) > 0.45;
  const hard = (amounts.pixelate ?? 0) > 0;
  const depth = DEPTH[spec.id];
  let id = keys.get(spec);
  if (id === undefined) {
    id = ++counter;
    keys.set(spec, id);
  }
  const lite = quality === 'lite';
  const style: SurfaceStyle = {
    key: `${id}-${quality}`,
    spec,
    ground,
    multiply,
    hard,
    ribbon: lite ? 0 : (amounts.ribbon ?? 0),
    amounts,
    depth: { far: { fade: depth.far.fade, soft: depth.far.soft && !lite }, bg: { fade: depth.bg.fade, soft: depth.bg.soft && !lite } },
    thin: depth.thin,
  };
  byQuality.set(quality, style);
  return style;
}

const FLAT = new WeakSet<LookSpec>();
const flattened = new WeakMap<LookSpec, LookSpec>();

/** The same look with no surface at all: the flat ground and ordinary alpha, for a sketch an image model will read. Cached, so it can be compared by identity. */
export function flatSpec(spec: LookSpec): LookSpec {
  let flat = flattened.get(spec);
  if (flat === undefined) {
    flat = { ...spec, fx: [] };
    flattened.set(spec, flat);
    FLAT.add(flat);
  }
  return flat;
}

const flatStyles = new WeakMap<LookSpec, SurfaceStyle>();

function flat(spec: LookSpec): SurfaceStyle {
  let style = flatStyles.get(spec);
  if (style === undefined) {
    style = { key: `flat-${++counter}`, spec, ground: new Color(spec.roles.ground), multiply: false, hard: false, ribbon: 0, amounts: {}, depth: { far: NO_FADE, bg: NO_FADE }, thin: 1 };
    flatStyles.set(spec, style);
  }
  return style;
}

const inks = new Map<string, Color>();

/** The colour a pool should write for `hex`: as written, or relative to the paper when ink multiplies. */
export function inkColour(style: SurfaceStyle, hex: string): Color {
  const key = `${style.key}|${hex}`;
  let colour = inks.get(key);
  if (colour === undefined) {
    colour = new Color(hex);
    if (style.multiply) {
      colour.r = Math.min(1, colour.r / Math.max(style.ground.r, 1e-3));
      colour.g = Math.min(1, colour.g / Math.max(style.ground.g, 1e-3));
      colour.b = Math.min(1, colour.b / Math.max(style.ground.b, 1e-3));
    }
    if (inks.size > 4000) inks.clear();
    inks.set(key, colour);
  }
  return colour;
}

export function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export const LAYERS: readonly Layer[] = ['far', 'bg', 'mid', 'fg'];
