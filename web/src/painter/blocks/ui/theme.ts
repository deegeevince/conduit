// A mock-up's theme (PLAN-v2.2 F1, "mock-up fidelity"): what the brain says on a `screen` line (`theme=dark accent=green radius=round type=serif
// density=compact`) becomes the whole token set the kit reads. The brain names a feeling; the kit does the arithmetic: the grounds and the lines are
// tinted from the accent's hue, the inks are moved until they read (contrast of at least 4.5 on every ground they are set on, WCAG's own formula), and what
// is written on an accent is whichever of white or near-black reads better on it. A brain cannot ship unreadable words by choosing a colour.
//
// Pure: no DOM, no clock. The same style on the same look always gives the same tokens.

import type { UiStyle, UiTextToken, UiTokens } from './lang';

// ------------------------------------------------------------------ colour

type Rgb = readonly [number, number, number];
type Hsl = readonly [number, number, number];

/** Plain colour words a brain may write for `accent=`. Brand-agnostic: no name of a product, no product's own value. */
const NAMED: Readonly<Record<string, string>> = {
  red: '#e5393b',
  crimson: '#d1264b',
  rose: '#f0457a',
  pink: '#ec4899',
  magenta: '#d63aa8',
  coral: '#ff6b57',
  orange: '#f97316',
  tangerine: '#ff8a1f',
  amber: '#f5a30c',
  gold: '#e0b020',
  yellow: '#facc15',
  lime: '#84cc16',
  green: '#1fc760',
  emerald: '#10b981',
  mint: '#34d399',
  teal: '#14b8a6',
  turquoise: '#22d3c5',
  cyan: '#06b6d4',
  sky: '#38bdf8',
  blue: '#2f6bff',
  cobalt: '#1f4fd8',
  navy: '#1e3a8a',
  indigo: '#5b5bf0',
  violet: '#8b5cf6',
  purple: '#a855f7',
  lavender: '#a78bfa',
  brown: '#a0663a',
  sand: '#d6b98c',
  slate: '#64748b',
  grey: '#8b93a1',
  gray: '#8b93a1',
  graphite: '#4b5563',
  black: '#111317',
  white: '#f5f6f8',
};

export const NAMED_COLOURS: readonly string[] = Object.keys(NAMED);

/** `#rgb`, `#rrggbb` or one of the plain colour words; null for anything else. */
export function parseColour(value: string): Rgb | null {
  const v = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const source = NAMED[v] ?? (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(v) ? v : null);
  if (source === null) return null;
  const digits = source.replace('#', '');
  const full = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

function toHsl([r, g, b]: Rgb): Hsl {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function fromHsl([h, s, l]: Hsl): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp01(s);
  const ll = clamp01(l);
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const hsl = (h: number, s: number, l: number): string => toHex(fromHsl([h, s, l]));

function luminance([r, g, b]: Rgb): number {
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function rgbOf(hex: string): Rgb {
  return parseColour(hex) ?? [0, 0, 0];
}

/** WCAG's contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(rgbOf(a));
  const lb = luminance(rgbOf(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mixHex(a: string, b: string, t: number): string {
  const pa = rgbOf(a);
  const pb = rgbOf(b);
  return toHex([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]);
}

/** The least contrast of `fg` against each of `grounds`. */
function least(fg: string, grounds: readonly string[]): number {
  return Math.min(...grounds.map((g) => contrast(fg, g)));
}

/**
 * `fg`, moved in lightness (its hue and its saturation kept) until it reads on every ground at `target` or better: lighter when the grounds are dark,
 * darker when they are light. The smallest move that does it; white or near-black when no move does.
 */
export function reach(fg: string, grounds: readonly string[], target = 4.5): string {
  if (least(fg, grounds) >= target) return fg;
  const [h, s, l] = toHsl(rgbOf(fg));
  const dark = grounds.reduce((sum, g) => sum + luminance(rgbOf(g)), 0) / grounds.length < 0.3;
  let lo = dark ? l : 0;
  let hi = dark ? 1 : l;
  // binary search the smallest change of lightness that reaches the target, on the side away from the grounds
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const ok = least(hsl(h, s, mid), grounds) >= target;
    if (dark) {
      if (ok) hi = mid;
      else lo = mid;
    } else if (ok) lo = mid;
    else hi = mid;
  }
  const found = hsl(h, s, dark ? hi : lo);
  if (least(found, grounds) >= target) return found;
  const pole = dark ? '#ffffff' : '#0b0d12';
  return pole;
}

/** An accent fill that either white or near-black reads on at 4.6 or better: a mid colour is moved a little until one does. */
function readable(fill: string): string {
  if (Math.max(contrast('#ffffff', fill), contrast('#0b0d12', fill)) >= 4.6) return fill;
  const [h, s, l] = toHsl(rgbOf(fill));
  for (let step = 1; step < 40; step += 1) {
    const darker = hsl(h, s, l - step * 0.01);
    if (contrast('#ffffff', darker) >= 4.6) return darker;
  }
  return fill;
}

/** Whichever of white and near-black is written better on `fill`: never under 4.5, whatever the fill is. */
export function onFill(fill: string): string {
  return contrast('#ffffff', fill) >= contrast('#0b0d12', fill) ? '#ffffff' : '#0b0d12';
}

export function isDark(colour: string): boolean {
  return luminance(rgbOf(colour)) < 0.18;
}

// ------------------------------------------------------------------ the derivation

const RADII = {
  sharp: { s: 2, m: 4, l: 6 },
  round: { s: 12, m: 24, l: 28 },
} as const;

/** The faces of a type word. The kit has three faces to set a screen in (a plain sans, a heavy display sans, a serif): `geometric` sets its large words in the display sans. */
function typeFaces(word: NonNullable<UiStyle['type']>): Partial<Record<keyof UiTokens['type'], UiTextToken['face']>> {
  if (word === 'geometric') return { display: 'display', hero: 'display', price: 'display', heading: 'display' };
  if (word === 'serif') return { title: 'serif', heading: 'serif', display: 'serif', hero: 'serif', price: 'serif' };
  return {};
}

interface Palette {
  readonly screen: string;
  readonly surface: string;
  readonly sunken: string;
  readonly ink: string;
  readonly dim: string;
  readonly faint: string;
  readonly line: string;
  readonly edge: string;
  readonly accent: string;
  readonly accentInk: string;
  readonly onAccent: string;
  readonly accentWash: string;
  readonly success: string;
  readonly danger: string;
  readonly shadow: string;
  readonly bezel: string;
  readonly bezelEdge: string;
}

/** The colours of a finished design (not a wireframe) of the given theme, tinted from the accent's hue. */
function palette(dark: boolean, accentIn: string): Palette {
  const [h, sat] = toHsl(rgbOf(accentIn));
  // the greys carry a breath of the accent's hue: a dark green app is not the same black as a dark blue one
  const tint = Math.max(0.05, Math.min(0.16, sat * 0.22));
  const screen = dark ? hsl(h, tint, 0.075) : hsl(h, tint * 1.2, 0.965);
  const surface = dark ? hsl(h, tint, 0.125) : '#ffffff';
  const sunken = dark ? hsl(h, tint, 0.175) : hsl(h, tint * 1.4, 0.925);
  const line = dark ? hsl(h, tint, 0.2) : hsl(h, tint, 0.9);
  const edge = dark ? hsl(h, tint, 0.28) : hsl(h, tint, 0.82);
  const grounds = [screen, surface, sunken];
  const ink = dark ? hsl(h, Math.min(tint, 0.1), 0.96) : hsl(h, Math.min(0.25, tint * 1.5), 0.09);
  const dim = reach(dark ? hsl(h, tint * 0.8, 0.7) : hsl(h, tint * 0.8, 0.38), grounds);
  const faint = reach(dark ? hsl(h, tint * 0.7, 0.6) : hsl(h, tint * 0.6, 0.43), grounds);
  // the accent as a fill must stand out from the ground (3:1, the least a shape needs); as words it must read (4.5)
  const fill = readable(reach(accentIn, [screen, surface], dark ? 4.5 : 3));
  const wash = dark ? mixHex(surface, fill, 0.2) : mixHex('#ffffff', fill, 0.13);
  const accentInk = reach(fill, [screen, surface, sunken, wash]);
  return {
    screen,
    surface,
    sunken,
    ink,
    dim,
    faint,
    line,
    edge,
    accent: fill,
    accentInk,
    onAccent: onFill(fill),
    accentWash: wash,
    success: reach(dark ? '#3ddc84' : '#12a36a', [screen, surface, sunken]),
    danger: reach(dark ? '#ff6b70' : '#e5484d', [screen, surface, sunken]),
    shadow: dark ? '#000000' : '#101828',
    bezel: dark ? '#050507' : '#0b0c10',
    bezelEdge: dark ? '#2f3541' : '#2b303b',
  };
}

/** A wireframe, turned over to the dark: white lines on a dark paper, the accent still the ink. */
function darkWire(base: UiTokens): UiTokens['colour'] {
  return {
    ...base.colour,
    bezel: '#1b1f27',
    bezelEdge: '#4a5262',
    screen: '#14171d',
    surface: '#14171d',
    sunken: '#232832',
    ink: '#eef0f4',
    dim: '#a9b1c0',
    faint: '#8e97a8',
    line: '#3a4150',
    edge: '#eef0f4',
    accent: '#eef0f4',
    accentInk: '#eef0f4',
    onAccent: '#14171d',
    accentWash: '#232832',
    success: '#eef0f4',
    danger: '#eef0f4',
    shadow: '#000000',
  };
}

const cache = new Map<string, UiTokens>();

/**
 * The tokens of a look as a screen's style changes them. A style that says nothing gives the look's own tokens, untouched; every word it does say is read here and
 * nowhere else. A colour the kit does not know is named in `notes` by the caller (`unknownAccent`) and the look's own accent is kept.
 */
export function themed(base: UiTokens, style: UiStyle | undefined): UiTokens {
  if (style === undefined || (style.theme === undefined && style.accent === undefined && style.radius === undefined && style.type === undefined && style.density === undefined)) return base;
  const key = `${base.id}|${base.minText ?? ''}|${base.colour.screen}|${style.theme ?? ''}|${style.accent ?? ''}|${style.radius ?? ''}|${style.type ?? ''}|${style.density ?? ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const given = style.accent === undefined ? null : parseColour(style.accent);
  const accentIn = given === null ? base.colour.accent : toHex(given);
  const dark = style.theme === undefined ? isDark(base.colour.screen) : style.theme === 'dark';
  let colour: UiTokens['colour'];
  let elevation = base.elevation;
  if (base.wire) {
    colour = style.theme === 'dark' ? darkWire(base) : base.colour;
  } else {
    const p = palette(dark, accentIn);
    colour = { ...base.colour, ...p, ground: base.colour.ground };
    if (dark) elevation = { none: base.elevation.none, low: { ...base.elevation.low, alpha: 0.4 }, high: { ...base.elevation.high, alpha: 0.55 } };
  }
  const radius = style.radius === undefined || style.radius === 'soft' ? base.radius : { ...base.radius, ...RADII[style.radius] };
  const faces = style.type === undefined ? {} : typeFaces(style.type);
  const type = { ...base.type };
  for (const role of Object.keys(faces) as (keyof UiTokens['type'])[]) {
    const face = faces[role];
    if (face !== undefined) type[role] = { ...type[role], face, ...(face === 'display' ? { weight: 'normal' as const } : {}) };
  }
  const out: UiTokens = { ...base, colour, elevation, radius, type, ...(style.density === undefined ? {} : { pack: style.density }) };
  if (cache.size > 64) cache.clear();
  cache.set(key, out);
  return out;
}

/** The style's accent word when the kit cannot read it: the caller names it to the brain. */
export function unknownAccent(style: UiStyle | undefined): string | null {
  return style?.accent !== undefined && parseColour(style.accent) === null ? style.accent : null;
}

/** The pairs of colours a themed set must read at 4.5, by name: what the check and the bench count. */
export function readingPairs(c: UiTokens['colour']): readonly { readonly name: string; readonly fg: string; readonly bg: string }[] {
  return [
    { name: 'ink on screen', fg: c.ink, bg: c.screen },
    { name: 'ink on surface', fg: c.ink, bg: c.surface },
    { name: 'ink on sunken', fg: c.ink, bg: c.sunken },
    { name: 'dim on screen', fg: c.dim, bg: c.screen },
    { name: 'dim on surface', fg: c.dim, bg: c.surface },
    { name: 'dim on sunken', fg: c.dim, bg: c.sunken },
    { name: 'faint on surface', fg: c.faint, bg: c.surface },
    { name: 'accent words on screen', fg: c.accentInk, bg: c.screen },
    { name: 'accent words on surface', fg: c.accentInk, bg: c.surface },
    { name: 'accent words on its wash', fg: c.accentInk, bg: c.accentWash },
    { name: 'on-accent on accent', fg: c.onAccent, bg: c.accent },
    { name: 'success on surface', fg: c.success, bg: c.surface },
    { name: 'danger on surface', fg: c.danger, bg: c.surface },
  ];
}
