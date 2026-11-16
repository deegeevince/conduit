// The house palette of the shelf's art (PLAN-art.md, sections 6 and 8): a small set of named hues, one for a light look and one for a dark.
// A sheet names up to three of them as colour slots, and says how much lighter or darker each of its parts is (a step of tone). Nothing else
// in a sheet is a colour but the look's own roles, so the same fox is orange in the paper look, a little brighter in the night look, and a
// drawing in line alone in the blueprint look.

import type { InkRole, LookId } from '@conduit/language';
import { INK_ROLES } from '@conduit/language';

export interface Hue {
  /** the hue on a light ground */
  readonly light: string;
  /** the hue on a dark ground: brighter and a little softer, so it reads without glowing */
  readonly dark: string;
}

/** Colours of a picture book, not of a chart: warm, a little muted, never pure. */
export const HOUSE_PALETTE = {
  orange: { light: '#e2702a', dark: '#f08a45' },
  rust: { light: '#b8452a', dark: '#d9694a' },
  red: { light: '#d9433a', dark: '#ee6a5e' },
  pink: { light: '#f08a7a', dark: '#f4a396' },
  peach: { light: '#f4c9a0', dark: '#f1c49c' },
  tan: { light: '#d9b48a', dark: '#dcbb92' },
  cream: { light: '#fbf0dc', dark: '#efe3cf' },
  brown: { light: '#8b5a3c', dark: '#b07a58' },
  cocoa: { light: '#6b3f2a', dark: '#9a6648' },
  yellow: { light: '#f2c230', dark: '#f6cf55' },
  gold: { light: '#e0a63a', dark: '#eab75a' },
  leaf: { light: '#7fb069', dark: '#93c47c' },
  green: { light: '#4f8f3f', dark: '#6dab5a' },
  forest: { light: '#2f5d34', dark: '#4e8654' },
  teal: { light: '#3f9aa0', dark: '#5bb6bc' },
  sky: { light: '#5bb7d6', dark: '#75c6e2' },
  blue: { light: '#3f6fa8', dark: '#6794cc' },
  purple: { light: '#6a5270', dark: '#957ba0' },
  grey: { light: '#9a9aa0', dark: '#b6b6bc' },
} as const satisfies Record<string, Hue>;
export type HueName = keyof typeof HOUSE_PALETTE;
export const HUE_NAMES = Object.keys(HOUSE_PALETTE) as readonly HueName[];

export const isHueName = (word: string): word is HueName => Object.hasOwn(HOUSE_PALETTE, word);

/** How a look takes colour: `light` and `dark` are the two grounds, `line` a look that draws in outline alone (the blueprint, the wireframe). */
export type LookClass = 'light' | 'dark' | 'line';

const LINE_ONLY: readonly LookId[] = ['blueprint', 'wireframe'];

export function lookClassOf(preset: LookId, ground: string): LookClass {
  if (LINE_ONLY.includes(preset)) return 'line';
  return relativeLuminance(ground) < 0.35 ? 'dark' : 'light';
}

// ---- colour arithmetic (HSL, enough for a step of tone) ----

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function relativeLuminance(hex: string): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
}

export function toHsl(hex: string): [number, number, number] {
  const [r8, g8, b8] = parseHex(hex);
  const r = (r8 ?? 0) / 255;
  const g = (g8 ?? 0) / 255;
  const b = (b8 ?? 0) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const two = (v: number): string => Math.max(0, Math.min(255, Math.round((v + m) * 255))).toString(16).padStart(2, '0');
  return `#${two(r)}${two(g)}${two(b)}`;
}

/** One step of tone is this much of lightness; a step down also deepens the colour a little, a step up softens it. */
export const TONE_STEP = 0.075;
export const MAX_TONE = 3;

/** A hue, a step lighter (positive) or darker (negative). Step 0 is the hue as the palette has it. */
export function toned(hex: string, step: number): string {
  if (step === 0) return hex;
  const [h, s, l] = toHsl(hex);
  const nl = Math.max(0.06, Math.min(0.96, l + step * TONE_STEP));
  const ns = Math.max(0, Math.min(1, s * (step < 0 ? 1 + 0.05 * -step : 1 - 0.07 * step)));
  return fromHsl(h, ns, nl);
}

/** The colour of a slot at a step, on a ground of the given class. `line` has no hues: its fills are the ground. */
export function slotColour(hue: HueName, step: number, look: LookClass): string | null {
  if (look === 'line') return null;
  return toned(HOUSE_PALETTE[hue][look], step);
}

/** The nearest hue of the palette to a colour, by distance in lightness-weighted HSL. */
export function nearestHue(hex: string): HueName {
  const [h, s, l] = toHsl(hex);
  let best: HueName = 'grey';
  let bestScore = Infinity;
  for (const name of HUE_NAMES) {
    const [ph, ps, pl] = toHsl(HOUSE_PALETTE[name].light);
    const dh = Math.min(Math.abs(h - ph), 360 - Math.abs(h - ph)) / 180;
    const score = dh * dh * (0.3 + Math.min(s, ps)) * 3 + (s - ps) ** 2 + 1.4 * (l - pl) ** 2;
    if (score < bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

export const ROLE_WORDS: readonly string[] = INK_ROLES;
export const isRole = (word: string): word is InkRole => (ROLE_WORDS as readonly string[]).includes(word);
