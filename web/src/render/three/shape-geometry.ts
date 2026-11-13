// Turns a shape's outline into the two meshes that draw it: a fill (the
// outline triangulated) and a stroke ribbon that carries along every vertex
// its distance from the start of the outline, so a line can draw itself by
// moving one number. Everything here is pure arithmetic on arrays.

import type { Polyline } from '@conduit/language';
import { ShapeUtils, Vector2 } from 'three';

export interface FillBuffers {
  readonly position: Float32Array;
  readonly index: Uint32Array;
}

export interface StrokeBuffers {
  /** the point on the outline this vertex hangs off */
  readonly position: Float32Array;
  /** direction and reach of the vertex from that point, in half-widths */
  readonly offset: Float32Array;
  /** -1 or 1 across the ribbon, 0 at the middle: coverage is anti-aliased from it */
  readonly edge: Float32Array;
  /** share of the whole outline's length, 0..1 */
  readonly dist: Float32Array;
  /** how sharply the line turns here, 0..1 */
  readonly turn: Float32Array;
  readonly index: Uint32Array;
  /** the whole outline's length, shape units */
  readonly length: number;
}

interface P {
  x: number;
  y: number;
}

const EPS = 1e-9;
/** Past this ratio of miter length to half-width a corner is rounded off instead of mitred. */
const MITER_LIMIT = 4;
const ARC_STEP = Math.PI / 10;

function cleaned(line: Polyline): { points: P[]; closed: boolean } {
  const points: P[] = [];
  for (const point of line.points) {
    const last = points[points.length - 1];
    if (last === undefined || Math.hypot(point.x - last.x, point.y - last.y) > 1e-7) points.push({ x: point.x, y: point.y });
  }
  let closed = line.closed;
  if (closed && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && last !== undefined && Math.hypot(first.x - last.x, first.y - last.y) <= 1e-7) points.pop();
  }
  if (points.length < 3) closed = false;
  return { points, closed };
}

export function outlineLength(outline: readonly Polyline[]): number {
  let total = 0;
  for (const line of outline) {
    const { points, closed } = cleaned(line);
    for (let i = 0; i + 1 < points.length; i++) total += Math.hypot((points[i + 1]?.x ?? 0) - (points[i]?.x ?? 0), (points[i + 1]?.y ?? 0) - (points[i]?.y ?? 0));
    if (closed) {
      const a = points[points.length - 1];
      const b = points[0];
      if (a !== undefined && b !== undefined) total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total;
}

function area(points: readonly P[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a !== undefined && b !== undefined) sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function inside(point: P, polygon: readonly P[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Whether `point` is inside the filled part of an outline (rings inside rings are holes). */
export function insideOutline(point: P, outline: readonly Polyline[]): boolean {
  let count = 0;
  for (const line of outline) {
    const { points } = cleaned(line);
    if (points.length >= 3 && inside(point, points)) count++;
  }
  return count % 2 === 1;
}

/** Past this many edges an outline is not searched for its own crossings (the search is quadratic). */
const CROSSING_LIMIT = 600;

function crossing(a: P, b: P, c: P, d: P): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < EPS) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denominator;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denominator;
  const margin = 1e-9;
  if (t <= margin || t >= 1 - margin || u <= margin || u >= 1 - margin) return null;
  return { t, u };
}

interface Edge {
  readonly a: P;
  readonly b: P;
}

function edgesOf(rings: readonly (readonly P[])[]): Edge[] {
  const edges: Edge[] = [];
  for (const ring of rings) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      if (b !== undefined) edges.push({ a, b });
    });
  }
  return edges;
}

/** The y of every place two edges cross, or null when no edge crosses another (so the rings are simple and either apart or nested). */
function crossingYs(edges: readonly Edge[]): number[] | null {
  if (edges.length > CROSSING_LIMIT) return null;
  const ys: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i];
      const f = edges[j];
      if (e === undefined || f === undefined) continue;
      const hit = crossing(e.a, e.b, f.a, f.b);
      if (hit !== null) ys.push(e.a.y + (e.b.y - e.a.y) * hit.t);
    }
  }
  return ys.length === 0 ? null : ys;
}

/**
 * Even-odd fill of an outline whose edges cross, as horizontal slabs: between two neighbouring heights where something
 * starts, ends or crosses, the edges that span the slab are sorted left to right and every second gap is solid. Exactly
 * the rule `insideOutline` picks by.
 */
function slabFill(edges: readonly Edge[], crossings: readonly number[]): FillBuffers | null {
  const heights = [...edges.flatMap((edge) => [edge.a.y, edge.b.y]), ...crossings].sort((x, y) => x - y);
  const levels: number[] = [];
  for (const y of heights) if (levels.length === 0 || y - (levels[levels.length - 1] ?? 0) > 1e-9) levels.push(y);
  const positions: number[] = [];
  const indices: number[] = [];
  const xAt = (edge: Edge, y: number): number => (edge.b.y === edge.a.y ? edge.a.x : edge.a.x + ((edge.b.x - edge.a.x) * (y - edge.a.y)) / (edge.b.y - edge.a.y));
  for (let i = 0; i + 1 < levels.length; i++) {
    const y0 = levels[i] ?? 0;
    const y1 = levels[i + 1] ?? 0;
    const middle = (y0 + y1) / 2;
    const spanning = edges.filter((edge) => Math.min(edge.a.y, edge.b.y) < middle && Math.max(edge.a.y, edge.b.y) > middle).sort((e, f) => xAt(e, middle) - xAt(f, middle));
    for (let k = 0; k + 1 < spanning.length; k += 2) {
      const left = spanning[k];
      const right = spanning[k + 1];
      if (left === undefined || right === undefined) continue;
      const base = positions.length / 3;
      positions.push(xAt(left, y0), y0, 0, xAt(right, y0), y0, 0, xAt(right, y1), y1, 0, xAt(left, y1), y1, 0);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  if (indices.length === 0) return null;
  return { position: new Float32Array(positions), index: new Uint32Array(indices) };
}

/**
 * The fill is the even-odd region of the whole outline, the same rule `insideOutline` picks by: a ring inside a ring
 * is a hole, a ring inside that is solid again, and where edges cross, the parts wound round twice stay empty.
 */
export function buildFill(outline: readonly Polyline[]): FillBuffers | null {
  const all = outline.map((line) => cleaned(line).points).filter((points) => points.length >= 3);
  const edges = edgesOf(all);
  const crossings = crossingYs(edges);
  if (crossings !== null) return slabFill(edges, crossings);
  const rings = all.filter((points) => Math.abs(area(points)) > EPS);
  if (rings.length === 0) return null;
  // Rings that do not cross are apart or nested. The smallest ring that holds one is its parent; an even depth is solid, an odd one a hole of its parent.
  const parent = rings.map((ring, index) => {
    const first = ring[0];
    if (first === undefined) return -1;
    let best = -1;
    let bestArea = Infinity;
    rings.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const size = Math.abs(area(other));
      if (size > Math.abs(area(ring)) && size < bestArea && inside(first, other)) {
        best = otherIndex;
        bestArea = size;
      }
    });
    return best;
  });
  const depth = (index: number): number => {
    let d = 0;
    for (let at = parent[index] ?? -1; at !== -1; at = parent[at] ?? -1) d++;
    return d;
  };
  const positions: number[] = [];
  const indices: number[] = [];
  rings.forEach((ring, ringIndex) => {
    if (depth(ringIndex) % 2 !== 0) return;
    const holes = rings.filter((_, holeIndex) => parent[holeIndex] === ringIndex);
    const contour = ring.map((p) => new Vector2(p.x, p.y));
    const holeVectors = holes.map((hole) => hole.map((p) => new Vector2(p.x, p.y)));
    const base = positions.length / 3;
    const faces = ShapeUtils.triangulateShape(contour, holeVectors);
    for (const point of [...contour, ...holeVectors.flat()]) positions.push(point.x, point.y, 0);
    for (const face of faces) indices.push(base + (face[0] ?? 0), base + (face[1] ?? 0), base + (face[2] ?? 0));
  });
  if (indices.length === 0) return null;
  return { position: new Float32Array(positions), index: new Uint32Array(indices) };
}

class Ribbon {
  readonly position: number[] = [];
  readonly offset: number[] = [];
  readonly edge: number[] = [];
  readonly dist: number[] = [];
  readonly turn: number[] = [];
  readonly index: number[] = [];

  vertex(p: P, ox: number, oy: number, edge: number, dist: number, turn: number): number {
    const at = this.position.length / 2;
    this.position.push(p.x, p.y);
    this.offset.push(ox, oy);
    this.edge.push(edge);
    this.dist.push(dist);
    this.turn.push(turn);
    return at;
  }

  triangle(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  /** A fan of triangles around `centre`, from the direction at angle `from` through `sweep` radians. The rim vertices sit one half-width out. */
  fan(centre: P, pivot: P, from: number, sweep: number, dist: number, turn: number): void {
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
    const middle = this.vertex(centre, pivot.x, pivot.y, 0, dist, turn);
    let previous = -1;
    for (let i = 0; i <= steps; i++) {
      const angle = from + (sweep * i) / steps;
      const at = this.vertex(centre, Math.cos(angle), Math.sin(angle), 1, dist, turn);
      if (previous >= 0) this.triangle(middle, previous, at);
      previous = at;
    }
  }
}

interface Station {
  readonly point: P;
  readonly dist: number;
}

interface Pair {
  readonly inLeft: number;
  readonly inRight: number;
  readonly outLeft: number;
  readonly outRight: number;
}

export function buildStroke(outline: readonly Polyline[]): StrokeBuffers | null {
  const lines = outline.map(cleaned).filter((line) => line.points.length >= 1);
  const total = outlineLength(outline);
  if (lines.length === 0) return null;
  const ribbon = new Ribbon();
  const scale = Math.max(total, EPS);
  let travelled = 0;

  for (const { points, closed } of lines) {
    const count = points.length;
    if (count === 1) {
      const only = points[0];
      if (only !== undefined) ribbon.fan(only, { x: 0, y: 0 }, 0, Math.PI * 2, travelled / scale, 0);
      continue;
    }
    // Stations: where the ribbon turns. A closed line returns to its first point, which is the same place at a longer distance.
    const stations: Station[] = [];
    const segments: { dx: number; dy: number }[] = [];
    const segmentCount = closed ? count : count - 1;
    let along = 0;
    for (let i = 0; i < segmentCount; i++) {
      const a = points[i];
      const b = points[(i + 1) % count];
      if (a === undefined || b === undefined) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      stations.push({ point: a, dist: (travelled + along) / scale });
      segments.push({ dx: (b.x - a.x) / length, dy: (b.y - a.y) / length });
      along += length;
    }
    const finish = closed ? points[0] : points[count - 1];
    if (finish !== undefined) stations.push({ point: finish, dist: (travelled + along) / scale });
    travelled += along;

    const pairs: Pair[] = [];
    stations.forEach((station, k) => {
      const prev = closed ? segments[(k - 1 + segments.length) % segments.length] : segments[k - 1];
      const next = closed ? segments[k % segments.length] : segments[k];
      const { point, dist } = station;
      if (prev === undefined && next !== undefined) {
        // Start of an open line: a round cap behind the first segment.
        const nx = -next.dy;
        const ny = next.dx;
        const left = ribbon.vertex(point, nx, ny, 1, dist, 0);
        const right = ribbon.vertex(point, -nx, -ny, -1, dist, 0);
        ribbon.fan(point, { x: 0, y: 0 }, Math.atan2(ny, nx), Math.PI, dist, 0);
        pairs.push({ inLeft: left, inRight: right, outLeft: left, outRight: right });
        return;
      }
      if (next === undefined && prev !== undefined) {
        const nx = -prev.dy;
        const ny = prev.dx;
        const left = ribbon.vertex(point, nx, ny, 1, dist, 0);
        const right = ribbon.vertex(point, -nx, -ny, -1, dist, 0);
        ribbon.fan(point, { x: 0, y: 0 }, Math.atan2(ny, nx), -Math.PI, dist, 0);
        pairs.push({ inLeft: left, inRight: right, outLeft: left, outRight: right });
        return;
      }
      if (prev === undefined || next === undefined) return;
      const ax = -prev.dy;
      const ay = prev.dx;
      const bx = -next.dy;
      const by = next.dx;
      const dot = ax * bx + ay * by;
      const cross = prev.dx * next.dy - prev.dy * next.dx;
      const turn = Math.min(1, Math.max(0, (1 - (prev.dx * next.dx + prev.dy * next.dy)) / 2));
      const uTurn = 1 + dot < 1e-3;
      const mx = uTurn ? 0 : (ax + bx) / (1 + dot);
      const my = uTurn ? 0 : (ay + by) / (1 + dot);
      const miter = Math.hypot(mx, my);
      if (!uTurn && miter <= MITER_LIMIT) {
        const left = ribbon.vertex(point, mx, my, 1, dist, turn);
        const right = ribbon.vertex(point, -mx, -my, -1, dist, turn);
        const left2 = ribbon.vertex(point, mx, my, 1, dist, turn);
        const right2 = ribbon.vertex(point, -mx, -my, -1, dist, turn);
        pairs.push({ inLeft: left, inRight: right, outLeft: left2, outRight: right2 });
        return;
      }
      // Too sharp to mitre: the inside keeps its corner (capped), the outside is rounded off with a fan.
      const outer = uTurn ? 1 : cross > 0 ? -1 : 1;
      const reach = uTurn ? 0 : Math.min(miter, 6) / (miter || 1);
      const innerIn = uTurn ? { x: -outer * ax, y: -outer * ay } : { x: -outer * mx * reach, y: -outer * my * reach };
      const innerOut = uTurn ? { x: -outer * bx, y: -outer * by } : innerIn;
      const fromX = outer * ax;
      const fromY = outer * ay;
      const toX = outer * bx;
      const toY = outer * by;
      const sweep = uTurn ? -Math.PI : Math.atan2(fromX * toY - fromY * toX, fromX * toX + fromY * toY);
      const inner = ribbon.vertex(point, innerIn.x, innerIn.y, -outer, dist, turn);
      const outerIn = ribbon.vertex(point, fromX, fromY, outer, dist, turn);
      const inner2 = ribbon.vertex(point, innerOut.x, innerOut.y, -outer, dist, turn);
      const outerOut = ribbon.vertex(point, toX, toY, outer, dist, turn);
      // A closed line meets itself at its first point: the wedge is laid once, at the start.
      if (!(closed && k === segments.length)) ribbon.fan(point, uTurn ? { x: 0, y: 0 } : innerIn, Math.atan2(fromY, fromX), sweep, dist, turn);
      pairs.push(
        outer === 1
          ? { inLeft: outerIn, inRight: inner, outLeft: outerOut, outRight: inner2 }
          : { inLeft: inner, inRight: outerIn, outLeft: inner2, outRight: outerOut },
      );
    });

    for (let k = 0; k + 1 < pairs.length; k++) {
      const a = pairs[k];
      const b = pairs[k + 1];
      if (a === undefined || b === undefined) continue;
      ribbon.triangle(a.outLeft, a.outRight, b.inLeft);
      ribbon.triangle(a.outRight, b.inRight, b.inLeft);
    }
  }

  if (ribbon.index.length === 0) return null;
  return {
    position: new Float32Array(ribbon.position),
    offset: new Float32Array(ribbon.offset),
    edge: new Float32Array(ribbon.edge),
    dist: new Float32Array(ribbon.dist),
    turn: new Float32Array(ribbon.turn),
    index: new Uint32Array(ribbon.index),
    length: total,
  };
}
