// A shape's signed distance field, made once on the CPU when its outline changes and sampled by the fill shader.
// It is what lets a fill know where its edge is: `soft=` fades along it, a `wash` pools against it, and a medium
// reads the same field when the sketch is re-rendered. Pure arithmetic on arrays, then one small 8-bit texture.

import type { Polyline } from '@conduit/language';
import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three';

export interface DistanceField {
  readonly texture: DataTexture;
  /** the region the texture covers, in the shape's own units */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** a texel of 0.5 is the outline; the texture holds distances within +-range, so d = (texel - 0.5) * 2 * range, negative inside */
  readonly range: number;
}

/** Texels times segments the field may cost: about 3 ms, so a morph that rebuilds it every frame stays within a frame. */
const WORK = 260_000;
const MAX_SIDE = 128;
const MIN_SIDE = 12;

interface Segment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

function segmentsOf(outline: readonly Polyline[]): Segment[] {
  const out: Segment[] = [];
  for (const line of outline) {
    const points = line.points;
    if (points.length < 3) continue;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a === undefined || b === undefined) continue;
      out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }
  return out;
}

/**
 * The field of `outline` out to `range` units each side of it, over its box grown by `range`. Null when the outline
 * encloses nothing. `detail` is 1 at full quality; below it the field is coarser.
 */
export function buildDistanceField(outline: readonly Polyline[], range: number, detail = 1): DistanceField | null {
  const segments = segmentsOf(outline);
  if (segments.length < 3 || !(range > 0)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.ax);
    maxX = Math.max(maxX, s.ax);
    minY = Math.min(minY, s.ay);
    maxY = Math.max(maxY, s.ay);
  }
  const x = minX - range;
  const y = minY - range;
  const width = maxX - minX + 2 * range;
  const height = maxY - minY + 2 * range;
  if (!(width > 0) || !(height > 0)) return null;

  // About the same texel in both directions, within the work allowed.
  const budget = Math.sqrt((WORK * detail) / segments.length);
  const long = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.floor(budget * Math.SQRT2)));
  const cell = Math.max(width, height) / long;
  const cols = Math.max(2, Math.min(MAX_SIDE, Math.ceil(width / cell)));
  const rows = Math.max(2, Math.min(MAX_SIDE, Math.ceil(height / cell)));
  const data = new Uint8Array(cols * rows);
  const stepX = width / cols;
  const stepY = height / rows;
  const scale = 1 / (2 * range);

  for (let row = 0; row < rows; row++) {
    const py = y + (row + 0.5) * stepY;
    for (let col = 0; col < cols; col++) {
      const px = x + (col + 0.5) * stepX;
      let best = Infinity;
      let crossings = 0;
      for (const s of segments) {
        const abx = s.bx - s.ax;
        const aby = s.by - s.ay;
        const length2 = abx * abx + aby * aby;
        let t = length2 === 0 ? 0 : ((px - s.ax) * abx + (py - s.ay) * aby) / length2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (s.ax + abx * t);
        const dy = py - (s.ay + aby * t);
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
        // even-odd: a ray to the right crosses the segment
        if (s.ay > py !== s.by > py && px < s.ax + ((py - s.ay) / (s.by - s.ay)) * abx) crossings++;
      }
      const signed = (crossings % 2 === 1 ? -1 : 1) * Math.sqrt(best);
      const value = 0.5 + signed * scale;
      data[row * cols + col] = Math.max(0, Math.min(255, Math.round(value * 255)));
    }
  }

  const texture = new DataTexture(data, cols, rows, RedFormat, UnsignedByteType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { texture, x, y, width, height, range };
}
