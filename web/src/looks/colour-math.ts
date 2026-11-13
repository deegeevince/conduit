// The arithmetic of colour that both the presets and the painter need: contrast,
// hue-keeping lightness moves, and bringing a colour into a machine's gamut.
// It lives under `looks/` so a preset can be built from it; `painter/colour.ts`
// re-exports the parts the painter calls.

import type { Colour } from '../contracts/frame';
import type { Gamut } from '../contracts/look';

/** Minimum contrast against the ground: WCAG AA. */
export const MIN_CONTRAST = { normal: 4.5, large: 3 } as const;

/** `*emphasis*` is at least this much brighter than the text it sits in, as a contrast ratio between the two, on a look whose emphasis is a matter of brightness. */
export const MIN_EMPHASIS_STEP = 1.25;

/** Text at or above this many CSS pixels counts as large. */
export const LARGE_TEXT_PX = 24;

type Rgb = readonly [number, number, number];

export function parse(colour: Colour): Rgb {
  let hex = colour.startsWith('#') ? colour.slice(1) : colour;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

export function format([r, g, b]: Rgb): Colour {
  const part = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(colour: Colour): number {
  const [r, g, b] = parse(colour);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, 1..21. */
export function contrastRatio(a: Colour, b: Colour): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function distance(a: Colour, b: Colour): number {
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  // Weighted toward green, where the eye is most sensitive.
  return 2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2;
}

export function mix(a: Colour, b: Colour, t: number): Colour {
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return format([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

export function toHsl(colour: Colour): [number, number, number] {
  const [r8, g8, b8] = parse(colour);
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function fromHsl(h: number, s: number, l: number): Colour {
  if (s === 0) return format([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return format([channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255]);
}

/** Perceptual brightness of the encoded colour, 0..1: what a monochrome tube keeps of a colour. */
export function luma(colour: Colour): number {
  const [r, g, b] = parse(colour);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Brings any colour into what a machine with this gamut could show. */
export function mapIntoGamut(colour: Colour, gamut: Gamut): Colour {
  switch (gamut.kind) {
    case 'mono':
      return mix(gamut.low, gamut.high, luma(colour));
    case 'palette': {
      let best = gamut.colours[0] ?? colour;
      let bestDistance = Infinity;
      for (const member of gamut.colours) {
        const d = distance(colour, member);
        if (d < bestDistance) {
          best = member;
          bestDistance = d;
        }
      }
      return best;
    }
    case 'ink': {
      const [h, s, l] = toHsl(colour);
      return l <= gamut.maxLightness ? format(parse(colour)) : fromHsl(h, s, gamut.maxLightness);
    }
    case 'any':
      return format(parse(colour));
  }
}

export function worstContrast(colour: Colour, against: readonly Colour[]): number {
  let worst = Infinity;
  for (const ground of against) worst = Math.min(worst, contrastRatio(colour, ground));
  return worst;
}

/**
 * Moves lightness, keeping hue and saturation, until the colour reaches
 * `minimum` against every ground. The direction away from the grounds is tried
 * first, then the other; the nearest colour that passes wins. `cap` is the
 * highest lightness the caller will accept.
 */
function walk(colour: Colour, against: readonly Colour[], minimum: number, cap: number): { colour: Colour; passes: boolean } {
  const [h, s, l] = toHsl(colour);
  const groundLuminance = against.reduce((sum, g) => sum + luminance(g), 0) / Math.max(1, against.length);
  const first = groundLuminance > 0.18 ? -1 : 1;
  let best = colour;
  let bestContrast = worstContrast(colour, against);
  for (const direction of [first, -first]) {
    for (let step = 1; step <= 200; step += 1) {
      const lightness = Math.max(0, Math.min(cap, l + (direction * step) / 200));
      const candidate = fromHsl(h, s, lightness);
      const c = worstContrast(candidate, against);
      if (c > bestContrast) {
        best = candidate;
        bestContrast = c;
      }
      if (c >= minimum) return { colour: candidate, passes: true };
      if (lightness === 0 || lightness === cap) break;
    }
  }
  return { colour: best, passes: bestContrast >= minimum };
}

function nearestMember(colour: Colour, members: readonly Colour[], against: readonly Colour[], minimum: number): { colour: Colour; passes: boolean } {
  let best: Colour | null = null;
  let bestDistance = Infinity;
  let fallback = colour;
  let fallbackContrast = -1;
  for (const member of members) {
    const c = worstContrast(member, against);
    if (c > fallbackContrast) {
      fallback = member;
      fallbackContrast = c;
    }
    const d = distance(colour, member);
    if (c >= minimum && d < bestDistance) {
      best = member;
      bestDistance = d;
    }
  }
  return best === null ? { colour: fallback, passes: false } : { colour: best, passes: true };
}

/**
 * The colour closest to `colour`, inside the machine's gamut, that reaches
 * `minimum` against every ground. A machine that cannot show anything readable
 * on these grounds (a brain gave an amber tube a pale ground) loses to
 * readability: the colour then leaves the gamut, keeping its hue.
 */
export function enforceInGamut(colour: Colour, against: readonly Colour[], minimum: number, gamut: Gamut): Colour {
  if (worstContrast(colour, against) >= minimum) return colour;
  let inside: { colour: Colour; passes: boolean };
  if (gamut.kind === 'palette') inside = nearestMember(colour, gamut.colours, against, minimum);
  else if (gamut.kind === 'mono') {
    const steps = 512;
    const ramp: Colour[] = [];
    for (let i = 0; i <= steps; i += 1) ramp.push(mix(gamut.low, gamut.high, i / steps));
    inside = nearestMember(colour, ramp, against, minimum);
  } else inside = walk(colour, against, minimum, gamut.kind === 'ink' ? gamut.maxLightness : 1);
  if (inside.passes) return inside.colour;
  const outside = walk(colour, against, minimum, 1);
  return worstContrast(outside.colour, against) >= worstContrast(inside.colour, against) ? outside.colour : inside.colour;
}
