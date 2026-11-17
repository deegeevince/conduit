// Outlines in motion: a shape's polylines moved through its morphs and given
// the hand wobble of its look. Everything here is a pure function of its
// arguments; the caches only remember answers.

import { outlineOf, polylineLength, resample } from '@conduit/language';
import type { ElementChange, Point, Polyline, ShapeGeometry } from '@conduit/language';
import { ease } from './ease';
import type { Ease } from '../contracts/look';
import { clamp01, hash, lerp } from './affine';

/** Points every polyline is reduced to before one shape becomes another. */
export const MORPH_POINTS = 96;
/** The longest a straight piece may be before wobble gets to bend it. */
const WOBBLE_STEP = 3;

type Morph = Extract<ElementChange, { kind: 'morph' }>;

const outlineCache = new WeakMap<ShapeGeometry, Polyline[]>();

/** `outlineOf`, remembered per geometry. */
export function outlineFor(geometry: ShapeGeometry): Polyline[] {
  let found = outlineCache.get(geometry);
  if (found === undefined) {
    found = outlineOf(geometry);
    outlineCache.set(geometry, found);
  }
  return found;
}

const resampled = new WeakMap<Polyline, Point[]>();

function pointsOf(line: Polyline): Point[] {
  let found = resampled.get(line);
  if (found === undefined) {
    found = resample(line, MORPH_POINTS);
    resampled.set(line, found);
  }
  return found;
}

function collapsed(to: Point | undefined): Point[] {
  const at = to ?? { x: 0, y: 0 };
  return Array.from({ length: MORPH_POINTS }, () => at);
}

function squaredDistance(a: readonly Point[], b: readonly Point[], shift: number, reverse: boolean): number {
  const n = a.length;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const j = reverse ? (((shift - i) % n) + n) % n : (shift + i) % n;
    const p = a[i];
    const q = b[j];
    if (p === undefined || q === undefined) continue;
    total += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
  }
  return total;
}

/** Rotates (and, if that is closer, reverses) `b` so that its points sit nearest to `a`'s. */
function aligned(a: readonly Point[], b: readonly Point[]): Point[] {
  const n = b.length;
  let best = Number.POSITIVE_INFINITY;
  let bestShift = 0;
  let bestReverse = false;
  for (const reverse of [false, true]) {
    for (let shift = 0; shift < n; shift += 1) {
      const d = squaredDistance(a, b, shift, reverse);
      if (d < best - 1e-9) {
        best = d;
        bestShift = shift;
        bestReverse = reverse;
      }
    }
  }
  return b.map((_, i) => {
    const j = bestReverse ? (((bestShift - i) % n) + n) % n : (bestShift + i) % n;
    return b[j] ?? b[i] ?? { x: 0, y: 0 };
  });
}

const alignments = new WeakMap<Polyline, WeakMap<Polyline, Point[]>>();

function alignedTarget(from: Polyline, to: Polyline): Point[] {
  let inner = alignments.get(from);
  if (inner === undefined) {
    inner = new WeakMap();
    alignments.set(from, inner);
  }
  let found = inner.get(to);
  if (found === undefined) {
    found = aligned(pointsOf(from), pointsOf(to));
    inner.set(to, found);
  }
  return found;
}

/** One outline becoming another, `p` of the way: no frame holds both. */
export function blendOutlines(from: readonly Polyline[], to: readonly Polyline[], p: number): Polyline[] {
  const count = Math.max(from.length, to.length);
  const out: Polyline[] = [];
  for (let k = 0; k < count; k += 1) {
    const a = from[k];
    const b = to[k];
    let pa: Point[];
    let pb: Point[];
    let closed: boolean;
    if (a !== undefined && b !== undefined) {
      closed = p < 0.5 ? a.closed : b.closed;
      pa = pointsOf(a);
      pb = a.closed && b.closed ? alignedTarget(a, b) : pointsOf(b);
    } else if (a !== undefined) {
      closed = a.closed;
      pa = pointsOf(a);
      pb = collapsed(pa[0]);
    } else if (b !== undefined) {
      closed = b.closed;
      pb = pointsOf(b);
      pa = collapsed(pb[0]);
    } else continue;
    const points: Point[] = pa.map((q, i) => {
      const r = pb[i] ?? q;
      return { x: lerp(q.x, r.x, p), y: lerp(q.y, r.y, p) };
    });
    out.push({ points, closed });
  }
  return out;
}

export interface MorphState {
  readonly polylines: readonly Polyline[];
  /** names the points: it changes when they do, and not otherwise */
  readonly token: string;
  readonly moving: boolean;
}

/**
 * The outline of a shape at `time`: its first geometry, then each morph in
 * turn. A morph begun while another is in flight starts from where that one
 * had got to.
 */
export function morphedOutline(first: ShapeGeometry, morphs: readonly Morph[], time: number, curve: Ease): MorphState {
  let index = -1;
  for (let i = 0; i < morphs.length; i += 1) {
    const morph = morphs[i];
    if (morph !== undefined && morph.start <= time) index = i;
  }
  const morph = morphs[index];
  if (morph === undefined) return { polylines: outlineFor(first), token: 'g0', moving: false };
  if (time >= morph.end) return { polylines: outlineFor(morph.geometry), token: `g${index + 1}`, moving: false };
  const before = morphedOutline(first, morphs.slice(0, index), morph.start, curve);
  // a morph the hand made (seq -1, see bound.ts) is as far along as its control says: eased once, by the control's own travel, never again by the look
  const progress = ease(morph.seq < 0 ? 'linear' : curve === 'hold' ? 'in-out' : curve, clamp01((time - morph.start) / Math.max(1e-6, morph.end - morph.start)));
  return {
    polylines: blendOutlines(before.polylines, outlineFor(morph.geometry), progress),
    token: `m${index}:${Math.round(progress * 4096)}`,
    moving: true,
  };
}

/** Smooth, periodic noise in -1..1 along a line of length `length`, decided by `seed` alone. */
function noiseAt(u: number, length: number, seed: string): number {
  const base = Math.max(2, Math.round(length / 22));
  const parts = [
    { k: base, w: 0.55 },
    { k: base * 2 + 1, w: 0.3 },
    { k: base * 3 + 2, w: 0.15 },
  ];
  let total = 0;
  parts.forEach((part, i) => {
    total += part.w * Math.sin(2 * Math.PI * part.k * u + hash(`${seed}#${i}`) * 2 * Math.PI);
  });
  return total;
}

function densified(line: Polyline): Polyline {
  const source = line.points;
  const points: Point[] = [];
  const last = line.closed ? source.length : source.length - 1;
  for (let i = 0; i < last; i += 1) {
    const a = source[i];
    const b = source[(i + 1) % source.length];
    if (a === undefined || b === undefined) continue;
    const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WOBBLE_STEP));
    for (let s = 0; s < pieces; s += 1) points.push({ x: lerp(a.x, b.x, s / pieces), y: lerp(a.y, b.y, s / pieces) });
  }
  if (!line.closed) {
    const end = source[source.length - 1];
    if (end !== undefined) points.push(end);
  }
  return { points, closed: line.closed };
}

/** The hand's wobble: each point moves along its normal by up to `amount`, by a noise that depends only on the key and the distance along. */
export function wobbled(lines: readonly Polyline[], seed: string, amount: number): Polyline[] {
  if (amount <= 0) return [...lines];
  return lines.map((line, k) => {
    if (line.points.length < 2) return line;
    const dense = densified(line);
    const points = dense.points;
    const n = points.length;
    const length = polylineLength(dense);
    let travelled = 0;
    const moved = points.map((p, i) => {
      const before = points[line.closed ? (i + n - 1) % n : Math.max(0, i - 1)] ?? p;
      const after = points[line.closed ? (i + 1) % n : Math.min(n - 1, i + 1)] ?? p;
      const tx = after.x - before.x;
      const ty = after.y - before.y;
      const size = Math.hypot(tx, ty) || 1;
      const previous = points[i - 1];
      if (i > 0 && previous !== undefined) travelled += Math.hypot(p.x - previous.x, p.y - previous.y);
      const u = length > 0 ? travelled / length : 0;
      const push = amount * noiseAt(u, length, `${seed}/${k}`);
      return { x: p.x - (ty / size) * push, y: p.y + (tx / size) * push };
    });
    return { points: moved, closed: line.closed };
  });
}

/** The most dashes one stroke may be cut into: past it the line is left whole, so a tiny `dash=` cannot flood a frame. */
const MAX_DASHES = 1500;

/**
 * Each polyline cut into dashes of `on` along it with `off` between, the pattern starting afresh at the start of each (a closed
 * line is walked round once, back to where it began). A dash is its own open polyline, so a renderer sees one stroke in pieces.
 * Returns null when the pattern would make more than `MAX_DASHES`.
 */
export function dashed(lines: readonly Polyline[], on: number, off: number): Polyline[] | null {
  const period = on + off;
  if (!(on > 0) || !(period > 0)) return null;
  let count = 0;
  for (const line of lines) count += Math.ceil(polylineLength(line) / period);
  if (count > MAX_DASHES) return null;
  const out: Polyline[] = [];
  for (const line of lines) {
    const points = line.closed && line.points.length > 1 ? [...line.points, line.points[0] as Point] : line.points;
    if (points.length < 2) {
      if (points.length === 1) out.push({ points: [...points], closed: false });
      continue;
    }
    // the cumulative length at each point
    const at: number[] = [0];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      at.push((at[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const total = at[at.length - 1] ?? 0;
    const pointAt = (d: number): Point => {
      let i = 1;
      while (i < at.length - 1 && (at[i] ?? 0) < d) i += 1;
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      const span = (at[i] ?? 0) - (at[i - 1] ?? 0);
      const t = span > 0 ? Math.min(1, Math.max(0, (d - (at[i - 1] ?? 0)) / span)) : 0;
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    };
    for (let start = 0; start < total - 1e-9; start += period) {
      const end = Math.min(total, start + on);
      const piece: Point[] = [pointAt(start)];
      for (let i = 1; i < points.length - 1; i += 1) {
        const d = at[i] ?? 0;
        if (d > start + 1e-9 && d < end - 1e-9) piece.push(points[i] as Point);
      }
      piece.push(pointAt(end));
      out.push({ points: piece, closed: false });
    }
  }
  return out;
}
