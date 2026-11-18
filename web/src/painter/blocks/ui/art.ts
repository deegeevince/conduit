// Placeholder art: a picture that is not a grey box. Cover art, avatars, a map and a sparkline are drawn from the words they stand for: the same
// title gives the same picture on every screen and every run (a seeded generator, no clock, no random), so a track reads as itself wherever it appears, and
// a replay is the same pixels. Everything is made of the shapes the painter already draws: a gradient rectangle and paths with an alpha, clipped to the
// picture's own rounded corners here (a polygon cut by a convex outline), so that nothing needs a mask.
//
// Pure: no DOM, no clock.

import type { Polyline } from '@conduit/language';
import type { Out, Rect } from './kit-base';
import type { UiMeasure } from './measure';
import type { UiPath, UiRect } from './types';

export interface Pt {
  readonly x: number;
  readonly y: number;
}

// ------------------------------------------------------------------ the seed

/** A 32-bit hash of the words (FNV-1a): the same words, the same number, everywhere. */
export function hashOf(words: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i += 1) {
    h ^= words.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small seeded generator (mulberry32): a function that gives 0 to 1, the same series for the same seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hslHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ------------------------------------------------------------------ geometry

/** A rounded rectangle as a polygon, clockwise from the top edge: corner radii top-left, top-right, bottom-right, bottom-left. */
export function roundedPoly(b: Rect, radii: readonly [number, number, number, number], steps = 6): Pt[] {
  const limit = Math.min(b.w, b.h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, limit))) as [number, number, number, number];
  const pts: Pt[] = [];
  const arc = (cx: number, cy: number, r: number, from: number): void => {
    if (r < 0.5) {
      pts.push({ x: cx + r * Math.cos(from + Math.PI / 4) * Math.SQRT2, y: cy + r * Math.sin(from + Math.PI / 4) * Math.SQRT2 });
      return;
    }
    for (let i = 0; i <= steps; i += 1) {
      const a = from + (i / steps) * (Math.PI / 2);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  arc(b.x + tl, b.y + tl, tl, Math.PI);
  arc(b.x + b.w - tr, b.y + tr, tr, -Math.PI / 2);
  arc(b.x + b.w - br, b.y + b.h - br, br, 0);
  arc(b.x + bl, b.y + b.h - bl, bl, Math.PI / 2);
  return pts;
}

export function circlePoly(cx: number, cy: number, r: number, n = 40): Pt[] {
  return Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * Math.PI * 2), y: cy + r * Math.sin((i / n) * Math.PI * 2) }));
}

/** A circle as a line that comes back to where it began: what a ring is drawn with. */
export function ringLine(cx: number, cy: number, r: number, n = 48): Pt[] {
  const pts = circlePoly(cx, cy, r, n);
  return [...pts, pts[0] as Pt];
}

function area(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i] as Pt;
    const q = poly[(i + 1) % poly.length] as Pt;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** A polygon cut by a convex polygon (Sutherland-Hodgman): what of `subject` is inside `clip`. */
export function clipPoly(subject: readonly Pt[], clip: readonly Pt[]): Pt[] {
  const sign = area(clip) >= 0 ? 1 : -1;
  let out: Pt[] = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i += 1) {
    const a = clip[i] as Pt;
    const b = clip[(i + 1) % clip.length] as Pt;
    const inside = (p: Pt): boolean => sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= 0;
    const cross = (p: Pt, q: Pt): Pt => {
      const dp = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const dq = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
      const t = dp / (dp - dq);
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j += 1) {
      const cur = input[j] as Pt;
      const prev = input[(j + input.length - 1) % input.length] as Pt;
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cross(prev, cur));
    }
  }
  return out;
}

/** A polyline cut by a convex polygon (Cyrus-Beck, segment by segment): the pieces of it that are inside, each an open polyline. */
export function clipLine(points: readonly Pt[], clip: readonly Pt[]): Pt[][] {
  const sign = area(clip) >= 0 ? 1 : -1;
  const pieces: Pt[][] = [];
  let current: Pt[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const p = points[i] as Pt;
    const q = points[i + 1] as Pt;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (let j = 0; j < clip.length && visible; j += 1) {
      const a = clip[j] as Pt;
      const b = clip[(j + 1) % clip.length] as Pt;
      const nx = -sign * (b.y - a.y);
      const ny = sign * (b.x - a.x);
      // the inside is where (point - a) . n >= 0 with n the inward normal
      const dp = (p.x - a.x) * nx + (p.y - a.y) * ny;
      const dd = (q.x - p.x) * nx + (q.y - p.y) * ny;
      if (Math.abs(dd) < 1e-9) {
        if (dp < 0) visible = false;
      } else {
        const t = -dp / dd;
        if (dd > 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
        if (t0 > t1) visible = false;
      }
    }
    if (!visible) {
      if (current.length > 1) pieces.push(current);
      current = [];
      continue;
    }
    const a = { x: p.x + (q.x - p.x) * t0, y: p.y + (q.y - p.y) * t0 };
    const z = { x: p.x + (q.x - p.x) * t1, y: p.y + (q.y - p.y) * t1 };
    if (current.length === 0 || t0 > 1e-9) {
      if (current.length > 1) pieces.push(current);
      current = [a, z];
    } else current.push(z);
    if (t1 < 1 - 1e-9) {
      pieces.push(current);
      current = [];
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

// ------------------------------------------------------------------ a drawing surface for one picture

/** The shapes of one picture, clipped to its own outline and put in the screen's parts. */
class Sheet {
  constructor(
    private readonly out: Out,
    private readonly owner: string,
    private readonly outline: readonly Pt[],
    private readonly name: string,
  ) {}

  private put(outline: Polyline[], fill: string | null, stroke: UiPath['stroke'], alpha: number): void {
    if (outline.length === 0) return;
    this.out.parts.push({ kind: 'path', key: this.out.key(this.owner, this.name), owner: this.owner, outline, fill, stroke, ...(alpha === 1 ? {} : { alpha }) });
  }

  fill(poly: readonly Pt[], colour: string, alpha = 1): void {
    const cut = clipPoly(poly, this.outline);
    if (cut.length >= 3) this.put([{ closed: true, points: cut }], colour, null, alpha);
  }

  stroke(points: readonly Pt[], colour: string, width: number, alpha = 1): void {
    const pieces = clipLine(points, this.outline);
    if (pieces.length > 0) this.put(pieces.map((points) => ({ closed: false, points })), null, { colour, width }, alpha);
  }

  /** A shape drawn as it is: its points are already inside the picture. */
  whole(poly: readonly Pt[], colour: string, alpha = 1): void {
    this.put([{ closed: true, points: [...poly] }], colour, null, alpha);
  }
}

function rectPart(out: Out, owner: string, what: string, b: Rect, radius: number, fill: UiRect['fill']): void {
  out.parts.push({ kind: 'rect', key: out.key(owner, what), owner, x: b.x, y: b.y, w: b.w, h: b.h, radius, fill, edge: null });
}

// ------------------------------------------------------------------ cover art

const MOTIFS = 8;

/** The hues a title's cover is made of: a base, and a second a third of the way round the wheel one way or the other. */
function hues(seed: number): { readonly a: number; readonly b: number; readonly dark: boolean } {
  const rnd = seeded(seed ^ 0x9e3779b9);
  const a = Math.floor(rnd() * 360);
  const turn = [30, 60, 150, 180, 210, 300][Math.floor(rnd() * 6)] as number;
  return { a, b: (a + turn) % 360, dark: rnd() < 0.35 };
}

/**
 * Cover art for `seed` (a title) filling `b` with corners `radii`. A gradient ground in two hues, and one of eight motifs (a sun, bands, hills, rings, mountains,
 * blocks, a record, a wave) drawn in the same hues, placed by the seed: two titles are never the same picture, and one title is always the same.
 */
export function coverArt(out: Out, owner: string, seed: string, b: Rect, radii: readonly [number, number, number, number], name = 'art'): void {
  const h = hashOf(seed.trim().toLowerCase());
  const { a, b: second, dark } = hues(h);
  const rnd = seeded(h);
  const top = dark ? hslHex(a, 0.55, 0.3) : hslHex(a, 0.72, 0.56);
  const bottom = dark ? hslHex(second, 0.6, 0.14) : hslHex(second, 0.68, 0.34);
  rectPart(out, owner, `${name}:ground`, b, Math.max(...radii), { from: top, to: bottom });
  const outline = roundedPoly(b, radii);
  const sheet = new Sheet(out, owner, outline, `${name}:shape`);
  const { x, y, w } = b;
  const hh = b.h;
  const u = Math.min(w, hh);
  const light = hslHex(a, 0.85, 0.82);
  const pale = '#ffffff';
  const deep = hslHex(second, 0.7, 0.16);
  const warm = hslHex((a + 40) % 360, 0.9, 0.62);
  const motif = Math.floor(rnd() * MOTIFS);
  const at = (fx: number, fy: number): Pt => ({ x: x + fx * w, y: y + fy * hh });
  switch (motif) {
    case 0: {
      // a sun low in the picture, with rings of heat around it
      const c = at(0.3 + rnd() * 0.4, 0.5 + rnd() * 0.2);
      for (let i = 4; i >= 1; i -= 1) sheet.fill(circlePoly(c.x, c.y, u * (0.16 + i * 0.12)), pale, 0.07 + (4 - i) * 0.015);
      sheet.fill(circlePoly(c.x, c.y, u * 0.2), warm, 0.95);
      sheet.fill([at(0, 0.78), at(1, 0.78), at(1, 1), at(0, 1)], deep, 0.55);
      break;
    }
    case 1: {
      // wide diagonal bands
      const n = 4 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i += 1) {
        const f = (i + 0.5) / n;
        const k = (rnd() - 0.5) * 0.06;
        sheet.fill([at(f - 0.55 + k, -0.1), at(f - 0.42 + k, -0.1), at(f + 0.45 + k, 1.1), at(f + 0.32 + k, 1.1)], i % 2 === 0 ? pale : deep, i % 2 === 0 ? 0.16 : 0.22);
      }
      sheet.fill(circlePoly(x + w * (0.25 + rnd() * 0.5), y + hh * (0.25 + rnd() * 0.3), u * 0.13), light, 0.9);
      break;
    }
    case 2: {
      // hills, three ranges deep
      for (let layer = 0; layer < 3; layer += 1) {
        const base = 0.52 + layer * 0.17;
        const amp = 0.1 + rnd() * 0.08;
        const phase = rnd() * 6.28;
        const freq = 1.1 + rnd() * 1.3;
        const pts: Pt[] = [];
        for (let i = 0; i <= 24; i += 1) pts.push(at(i / 24, base + Math.sin(phase + (i / 24) * freq * 3.14) * amp));
        sheet.fill([...pts, at(1, 1.05), at(0, 1.05)], layer === 0 ? light : layer === 1 ? deep : '#000000', layer === 0 ? 0.45 : layer === 1 ? 0.45 : 0.3);
      }
      sheet.fill(circlePoly(x + w * (0.65 + rnd() * 0.2), y + hh * 0.28, u * 0.1), pale, 0.85);
      break;
    }
    case 3: {
      // rings, round a corner
      const c = at(rnd() < 0.5 ? 0.15 : 0.85, rnd() < 0.5 ? 0.2 : 0.8);
      for (let i = 1; i <= 7; i += 1) sheet.stroke(ringLine(c.x, c.y, u * i * 0.17), pale, Math.max(1, u * 0.012), 0.2 + (i % 2) * 0.18);
      sheet.fill(circlePoly(c.x, c.y, u * 0.1), warm, 0.95);
      const d = at(0.5 + (rnd() - 0.5) * 0.4, 0.5 + (rnd() - 0.5) * 0.4);
      sheet.fill(circlePoly(d.x, d.y, u * 0.045), pale, 0.9);
      break;
    }
    case 4: {
      // mountains with a pale peak each
      const peaks = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < peaks; i += 1) {
        const cx = 0.2 + (i / peaks) * 0.7 + rnd() * 0.12;
        const top = 0.2 + rnd() * 0.3;
        const half = 0.28 + rnd() * 0.16;
        sheet.fill([at(cx, top), at(cx + half, 1.02), at(cx - half, 1.02)], i % 2 === 0 ? deep : hslHex(a, 0.6, 0.2), 0.7);
        sheet.fill([at(cx, top), at(cx + half * 0.28, top + (1 - top) * 0.28), at(cx - half * 0.28, top + (1 - top) * 0.28)], pale, 0.8);
      }
      sheet.fill(circlePoly(x + w * (0.15 + rnd() * 0.2), y + hh * 0.2, u * 0.08), warm, 0.9);
      break;
    }
    case 5: {
      // blocks on a grid, a quarter circle or a square in each
      const n = 3;
      for (let gy = 0; gy < n; gy += 1) {
        for (let gx = 0; gx < n; gx += 1) {
          const r = rnd();
          if (r < 0.3) continue;
          const cell = { x: x + (gx / n) * w, y: y + (gy / n) * hh, w: w / n, h: hh / n };
          const colour = r < 0.55 ? pale : r < 0.8 ? deep : warm;
          if (r > 0.65) sheet.fill(circlePoly(cell.x + cell.w / 2, cell.y + cell.h / 2, Math.min(cell.w, cell.h) * 0.4, 24), colour, 0.5);
          else sheet.fill([{ x: cell.x + cell.w * 0.1, y: cell.y + cell.h * 0.1 }, { x: cell.x + cell.w * 0.9, y: cell.y + cell.h * 0.1 }, { x: cell.x + cell.w * 0.9, y: cell.y + cell.h * 0.9 }, { x: cell.x + cell.w * 0.1, y: cell.y + cell.h * 0.9 }], colour, 0.28);
        }
      }
      break;
    }
    case 6: {
      // a record, half off the picture, with a warm label
      const c = at(0.62 + rnd() * 0.2, 0.55 + rnd() * 0.2);
      const r = u * 0.46;
      sheet.fill(circlePoly(c.x, c.y, r, 48), '#0b0b10', 0.82);
      for (let i = 1; i <= 5; i += 1) sheet.stroke(ringLine(c.x, c.y, r * (0.4 + i * 0.1)), pale, Math.max(0.75, u * 0.005), 0.12);
      sheet.fill(circlePoly(c.x, c.y, r * 0.3, 32), warm, 0.95);
      sheet.fill(circlePoly(c.x, c.y, r * 0.05, 16), '#0b0b10', 0.9);
      sheet.fill([at(0, 0), at(0.35, 0), at(0, 0.5)], pale, 0.1);
      break;
    }
    default: {
      // a long wave, twice
      for (let layer = 0; layer < 2; layer += 1) {
        const pts: Pt[] = [];
        const phase = rnd() * 6.28;
        for (let i = 0; i <= 32; i += 1) pts.push(at(i / 32, 0.42 + layer * 0.2 + Math.sin(phase + (i / 32) * 6.28 * (1 + layer * 0.5)) * 0.1));
        sheet.fill([...pts, at(1, 1.05), at(0, 1.05)], layer === 0 ? pale : deep, layer === 0 ? 0.2 : 0.38);
        sheet.stroke(pts, pale, Math.max(1, u * 0.012), 0.45);
      }
      sheet.fill(circlePoly(x + w * (0.3 + rnd() * 0.4), y + hh * 0.22, u * 0.09), light, 0.9);
      break;
    }
  }
}

// ------------------------------------------------------------------ avatars

/** The two letters a person's picture carries: the first letter of the first two words. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = words.slice(0, 2).map((word) => ([...word.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '').toUpperCase());
  return letters.join('') || '?';
}

/** A person's picture: a circle in a colour made from the name, and the initials set in it. The initials are `ink` on the circle (white reads on every circle this makes). */
export function avatar(out: Out, owner: string, name: string, b: Rect, measure: UiMeasure, what = 'avatar'): void {
  const h = hashOf(name.trim().toLowerCase());
  const hue = h % 360;
  const size = Math.min(b.w, b.h);
  const box = { x: b.x + (b.w - size) / 2, y: b.y + (b.h - size) / 2, w: size, h: size };
  rectPart(out, owner, `${what}:ground`, box, size / 2, { from: hslHex(hue, 0.62, 0.46), to: hslHex((hue + 35) % 360, 0.62, 0.3) });
  const letters = initialsOf(name);
  const fontSize = Math.max(10, Math.round(size * 0.38));
  const width = measure.width(letters, fontSize, 'bold');
  out.parts.push({ kind: 'text', key: out.key(owner, `${what}:initials`), owner, x: box.x, y: box.y + (size - fontSize * 1.4) / 2, w: size, h: fontSize * 1.4, lines: [{ text: letters, width }], size: fontSize, line: fontSize * 1.4, weight: 'bold', colour: '#ffffff', align: 'center' });
}

// ------------------------------------------------------------------ a map

export interface MapPalette {
  readonly land: string;
  readonly water: string;
  readonly park: string;
  readonly road: string;
  readonly casing: string;
  readonly minor: string;
  readonly block: string;
}

export function mapPalette(dark: boolean): MapPalette {
  return dark
    ? { land: '#1d2229', water: '#14283a', park: '#1a2e24', road: '#3a424e', casing: '#12161b', minor: '#2a313a', block: '#232a32' }
    : { land: '#eceee9', water: '#bcd9ee', park: '#cfe6c4', road: '#ffffff', casing: '#d3d6d0', minor: '#f7f7f4', block: '#e3e6df' };
}

/** A pin, point down at (x, y): a drop in `colour` with a light eye. */
function pinShape(x: number, y: number, r: number): Pt[] {
  const c = { x, y: y - r * 2.1 };
  const pts: Pt[] = [];
  for (let i = 0; i <= 30; i += 1) {
    const a = Math.PI * 0.62 + (i / 30) * (Math.PI * 2 - Math.PI * 0.24);
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  pts.push({ x, y });
  return pts;
}

/** The pins of a map, as places in the picture (0 to 1), from the seed. Pin 0 is the one the card is about. */
export function mapPins(seed: string, count: number): Pt[] {
  const rnd = seeded(hashOf(`${seed}:pins`));
  return Array.from({ length: Math.max(1, Math.min(6, count)) }, (_, i) => ({ x: 0.2 + rnd() * 0.6, y: 0.22 + rnd() * 0.42 + (i === 0 ? 0.05 : 0) }));
}

/**
 * A map drawn from the words it is for: blocks and streets on a tilted grid, a river, a park, pins, and a route between them when asked. Nothing in it is a
 * place: it is what a map looks like, the way a wireframe's picture is what a picture looks like.
 */
export function mapArt(out: Out, owner: string, seed: string, b: Rect, radii: readonly [number, number, number, number], opts: { readonly dark: boolean; readonly accent: string; readonly pins: number; readonly route: boolean; readonly pinEye: string }): void {
  const p = mapPalette(opts.dark);
  const rnd = seeded(hashOf(`${seed}:map`));
  rectPart(out, owner, 'map:land', b, Math.max(...radii), p.land);
  const outline = roundedPoly(b, radii);
  const sheet = new Sheet(out, owner, outline, 'map:shape');
  const { x, y, w, h } = b;
  const u = Math.min(w, h);
  const theta = (rnd() - 0.5) * 0.7;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rot = (px: number, py: number): Pt => ({ x: cx + (px - cx) * cos - (py - cy) * sin, y: cy + (px - cx) * sin + (py - cy) * cos });
  // a river across the picture, a park beside it
  const bend = rnd() * 6.28;
  const river: Pt[] = [];
  for (let i = 0; i <= 20; i += 1) river.push({ x: x - 10 + (i / 20) * (w + 20), y: y + h * (0.62 + Math.sin(bend + (i / 20) * 3.4) * 0.14) });
  sheet.stroke(river, p.water, Math.max(6, u * 0.09));
  const parkAt = { x: x + w * (0.1 + rnd() * 0.45), y: y + h * (0.1 + rnd() * 0.2) };
  sheet.fill(circlePoly(parkAt.x, parkAt.y, u * 0.2, 28).map((q, i) => ({ x: q.x + Math.sin(i * 1.7) * u * 0.02, y: q.y * 0.9 + parkAt.y * 0.1 })), p.park);
  // a street grid: long thin blocks between white streets
  const step = Math.max(26, u * 0.26);
  const reach = Math.max(w, h) * 1.2;
  for (let gx = -reach; gx <= reach; gx += step * (0.8 + rnd() * 0.5)) {
    sheet.stroke([rot(cx + gx, cy - reach), rot(cx + gx, cy + reach)], p.casing, Math.max(3, u * 0.035));
    sheet.stroke([rot(cx + gx, cy - reach), rot(cx + gx, cy + reach)], p.road, Math.max(2, u * 0.026));
  }
  for (let gy = -reach; gy <= reach; gy += step * (0.7 + rnd() * 0.6)) {
    sheet.stroke([rot(cx - reach, cy + gy), rot(cx + reach, cy + gy)], p.casing, Math.max(3, u * 0.035));
    sheet.stroke([rot(cx - reach, cy + gy), rot(cx + reach, cy + gy)], p.road, Math.max(2, u * 0.026));
  }
  // the pins and what joins them
  const pins = mapPins(seed, opts.pins).map((q) => ({ x: x + q.x * w, y: y + q.y * h }));
  if (opts.route && pins.length > 1) {
    const path: Pt[] = [];
    pins.forEach((q, i) => {
      const prev = pins[i - 1];
      if (prev !== undefined) path.push({ x: q.x, y: prev.y });
      path.push(q);
    });
    sheet.stroke(path, '#ffffff', Math.max(5, u * 0.05), 0.9);
    sheet.stroke(path, opts.accent, Math.max(3, u * 0.03));
  }
  const r = Math.max(7, u * 0.07);
  pins.forEach((q, i) => {
    const main = i === 0;
    const rr = main ? r : r * 0.62;
    sheet.whole(circlePoly(q.x, q.y, rr * 0.5, 14), '#000000', 0.18);
    sheet.whole(pinShape(q.x, q.y, rr), main ? opts.accent : opts.dark ? '#aab3c2' : '#5b6475');
    sheet.whole(circlePoly(q.x, q.y - rr * 2.1, rr * 0.42, 16), main ? opts.pinEye : '#ffffff');
  });
}

// ------------------------------------------------------------------ a sparkline

/** A line chart small enough to sit in a card: the points scaled to the box, a line, and a wash under it. `seed` gives a gentle series when no points are given. */
export function sparkline(out: Out, owner: string, values: readonly number[], b: Rect, colour: string): void {
  if (values.length < 2) return;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts: Pt[] = values.map((v, i) => ({ x: b.x + (i / (values.length - 1)) * b.w, y: b.y + b.h - 2 - ((v - lo) / span) * (b.h - 4) }));
  out.parts.push({ kind: 'path', key: out.key(owner, 'spark:wash'), owner, outline: [{ closed: true, points: [...pts, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }] }], fill: colour, stroke: null, alpha: 0.14 });
  out.parts.push({ kind: 'path', key: out.key(owner, 'spark:line'), owner, outline: [{ closed: false, points: pts }], fill: null, stroke: { colour, width: 2 } });
}
