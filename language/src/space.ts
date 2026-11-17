// Depth as pure geometry (PLAN-depth.md, D1): a point in space, a turn of the camera, an orthographic projection, and the cutting a sphere's
// limb needs. Nothing here knows a painter, a clock or a drawing; the server's measure and the page get the same answer from the same numbers.
//
// The conventions, once:
// - The space is x to the right, y DOWN the screen, and z TOWARDS the viewer: z > 0 faces you. Angles are degrees.
// - A point on a sphere is `lat,lon`, north and east positive, with an optional height above the surface. Latitude 0, longitude 0 is the centre of the
//   disk at rest; the north pole is the top of it.
// - The camera turns in the order yaw, then pitch, then roll. Positive yaw turns the near side to the right, as the Earth spins (so a point at longitude
//   -90 comes to the centre at yaw 90). Positive pitch tips the top towards you (so the north pole comes to the centre at pitch 90). Roll is the
//   clockwise turn the screen already means by `rot=`.
// - The turn is exact at the quarter turns (`sinTurns` and `cosTurns`), so a pole at pitch 90 sits at z = r and not at r - 1e-16.
import { cosTurns, sinTurns } from './motion';
import type { Polyline } from './geometry';
import type { Point } from './types';

/** A point in space: x right, y down, z towards the viewer. */
export interface P3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** How a group's written numbers become space: `flat` reads `x,y,z` from the group's origin; `sphere` reads `lat,lon,height` on a ball of radius `r`. */
export type SpaceFrame = { readonly kind: 'flat' } | { readonly kind: 'sphere'; readonly r: number };

/** The camera, in degrees: the group's `yaw=`, `pitch=` and `rot=`. */
export interface SpaceView {
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
}

/** The farthest a stroke of the limb's arc runs between two points, degrees. */
const ARC_STEP = 5;
const TAU = 2 * Math.PI;

/** A share of a turn from degrees; a number that is not one is no turn at all. */
function turns(degrees: number): number {
  return Number.isFinite(degrees) ? degrees / 360 : 0;
}

/**
 * A written point as a point in space. `flat`: (x, y, z), z being 0 when not written. `sphere`: x is the latitude and y the longitude, in degrees, and z is
 * the height above the surface (0 when not written), so the point is `r + height` from the centre. Never gives a negative zero.
 */
export function lift(point: { readonly x: number; readonly y: number; readonly z?: number }, frame: SpaceFrame): P3 {
  const z = point.z ?? 0;
  if (frame.kind === 'flat') return { x: point.x + 0, y: point.y + 0, z: z + 0 };
  const radius = frame.r + z;
  const lat = turns(point.x);
  const lon = turns(point.y);
  const ring = radius * cosTurns(lat);
  return { x: ring * sinTurns(lon) + 0, y: -radius * sinTurns(lat) + 0, z: ring * cosTurns(lon) + 0 };
}

/** A point seen from the camera: turned by yaw about the vertical, then by pitch about the horizontal, then by roll about the line of sight. */
export function turn(p: P3, view: SpaceView): P3 {
  const yaw = turns(view.yaw);
  const pitch = turns(view.pitch);
  const roll = turns(view.roll);
  const sy = sinTurns(yaw);
  const cy = cosTurns(yaw);
  const sp = sinTurns(pitch);
  const cp = cosTurns(pitch);
  const sr = sinTurns(roll);
  const cr = cosTurns(roll);
  // yaw: the near side (+z) goes to the right (+x)
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  // pitch: the top (-y) comes towards the viewer (+z)
  const y2 = p.y * cp + z1 * sp;
  const z2 = -p.y * sp + z1 * cp;
  // roll: clockwise on the screen, as `turnAbout` is
  return { x: x1 * cr - y2 * sr + 0, y: x1 * sr + y2 * cr + 0, z: z2 + 0 };
}

/** The point on the screen, relative to the group's origin. Orthographic: depth changes nothing but which part covers which. */
export function project(p: P3): Point {
  return { x: p.x + 0, y: p.y + 0 };
}

/** How near a part is: the mean z of its points, so a larger number is nearer. Parts are drawn in ascending order of it, the nearest last. */
export function depthOf(points: readonly P3[]): number {
  if (points.length === 0) return 0;
  let total = 0;
  for (const p of points) total += p.z;
  return total / points.length;
}

/** The greatest cos of a latitude over a stretch of them: 1 if the stretch crosses the equator (or the antipodal one), else the larger of its two ends. Sizes a step along a parallel. */
function reachOf(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (Math.ceil(lo / 180) * 180 <= hi) return 1;
  return Math.max(Math.abs(cosTurns(lo / 360)), Math.abs(cosTurns(hi / 360)));
}

/**
 * A line written as `lat,lon` points, with points added so that no step is more than `maxDegrees` of arc on the ball. Between two points it goes straight
 * in latitude and longitude, as an atlas draws it (so `0,-180 0,180` is the equator, 72 steps, and not a great circle that has no length); every written
 * point is kept. A closed line is closed with a stretch of the same kind. The result is still `lat,lon`: lift it to space afterwards.
 */
export function resampleOnSphere(line: Polyline, maxDegrees = ARC_STEP): Polyline {
  const step = Number.isFinite(maxDegrees) && maxDegrees >= 0.1 ? maxDegrees : ARC_STEP;
  const points = line.points;
  const count = points.length;
  if (count < 2) return { points: points.map((p) => ({ x: p.x, y: p.y })), closed: line.closed };
  const out: Point[] = [];
  const edges = line.closed ? count : count - 1;
  for (let i = 0; i < edges; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % count];
    if (a === undefined || b === undefined) continue;
    out.push({ x: a.x, y: a.y });
    const arc = Math.hypot(b.x - a.x, (b.y - a.y) * reachOf(a.x, b.x));
    const pieces = Math.min(720, Math.max(1, Math.ceil(arc / step - 1e-9)));
    for (let k = 1; k < pieces; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / pieces, y: a.y + ((b.y - a.y) * k) / pieces });
  }
  if (!line.closed) {
    const last = points[count - 1];
    if (last !== undefined) out.push({ x: last.x, y: last.y });
  }
  return { points: out, closed: line.closed };
}

/** Where the segment a-b meets the plane z = 0, on it. The caller knows the two lie on opposite sides, or that one is on it. */
function crossing(a: P3, b: P3): P3 {
  const t = a.z === b.z ? 0 : a.z / (a.z - b.z);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: 0 };
}

/** A point on the limb: the same bearing, put at the sphere's radius. */
function onLimb(p: P3, r: number): P3 {
  const reach = Math.hypot(p.x, p.y);
  if (!(r > 0) || reach === 0 || Math.abs(reach - r) <= 1e-12 * Math.max(1, r)) return { x: p.x + 0, y: p.y + 0, z: 0 };
  const scale = r / reach;
  return { x: p.x * scale + 0, y: p.y * scale + 0, z: 0 };
}

/** The stretches of a line that face you, each running to the limb where the line went round it. Stretches of one point are no line, and dropped. */
function clipOpen(points: readonly P3[]): P3[][] {
  const out: P3[][] = [];
  let run: P3[] = [];
  const finish = (): void => {
    if (run.length >= 2) out.push(run);
    run = [];
  };
  for (let i = 0; i < points.length; i += 1) {
    const b = points[i];
    if (b === undefined) continue;
    const a = i > 0 ? points[i - 1] : undefined;
    const bIn = b.z >= 0;
    if (a !== undefined && (a.z >= 0) !== bIn) {
      if (bIn && b.z !== 0) run.push(crossing(a, b));
      if (!bIn) {
        if (a.z !== 0) run.push(crossing(a, b));
        finish();
      }
    }
    if (bIn) run.push(b);
  }
  finish();
  return out;
}

/** `to - from` taken round the circle: in [0, TAU). */
function sweep(from: number, to: number, direction: 1 | -1): number {
  const gap = direction === 1 ? to - from : from - to;
  return ((gap % TAU) + TAU) % TAU;
}

/** The limb's own points from one crossing to another, `direction` 1 for a rising bearing, a stroke of at most ARC_STEP degrees at a time. Neither end is included. */
function arcBetween(from: P3, to: P3, direction: 1 | -1, r: number): P3[] {
  const start = Math.atan2(from.y, from.x);
  const span = sweep(start, Math.atan2(to.y, to.x), direction);
  const radius = r > 0 ? r : Math.hypot(from.x, from.y);
  const strokes = Math.ceil(span / ((ARC_STEP * Math.PI) / 180) - 1e-9);
  const out: P3[] = [];
  for (let i = 1; i < strokes; i += 1) {
    const bearing = start + (direction * span * i) / strokes;
    out.push({ x: radius * Math.cos(bearing), y: radius * Math.sin(bearing), z: 0 });
  }
  return out;
}

/** How each run's far end meets the next run's near end along the limb: `to` the run it reaches, `direction` the way round the limb it goes. */
interface Link {
  readonly to: number;
  readonly direction: 1 | -1;
}

/**
 * Pairs the places a closed outline meets the limb. Each run of the outline that faces you begins at one (`2j`, where it came round the edge) and ends at
 * another (`2j + 1`, where it goes behind). Taken in order round the limb the places alternate, so the limb is cut into stretches that are inside the
 * outline and stretches that are outside, one set at even gaps and the other at odd ones. The inside is the set with the shorter total (the smaller patch,
 * whichever way the outline was written); at a tie, the stretches run counter-clockwise from where a run ends to where the next begins. Null when the
 * places do not alternate (an outline that crosses itself), and the caller falls back to joining each run to the next.
 */
function pairAlongLimb(bearings: readonly number[]): readonly (Link | undefined)[] | null {
  const places = bearings.length;
  const order = bearings.map((_, id) => id).sort((p, q) => (bearings[p] ?? 0) - (bearings[q] ?? 0) || p - q);
  const bearing = (slot: number): number => bearings[order[slot % places] ?? 0] ?? 0;
  let even = 0;
  for (let slot = 0; slot < places; slot += 2) even += slot + 1 < places ? bearing(slot + 1) - bearing(slot) : 0;
  const odd = TAU - even;
  const offset = Math.abs(even - odd) < 1e-9 ? ((order[0] ?? 0) % 2 === 0 ? 0 : 1) : even < odd ? 0 : 1;
  const links: (Link | undefined)[] = Array.from({ length: places / 2 }, () => undefined);
  for (let pair = 0; pair < places / 2; pair += 1) {
    const low = order[(offset + 2 * pair) % places] ?? 0;
    const high = order[(offset + 2 * pair + 1) % places] ?? 0;
    if ((low + high) % 2 !== 1) return null;
    const ends = low % 2 === 1 ? low : high;
    const begins = low % 2 === 1 ? high : low;
    links[ends >> 1] = { to: begins >> 1, direction: ends === low ? 1 : -1 };
  }
  return links;
}

/** A polygon cut where it goes behind the limb, each stretch behind replaced by the limb's own arc. */
function clipRing(points: readonly P3[], r: number): P3[][] {
  const count = points.length;
  const first = points.findIndex((p) => p.z < 0);
  const found: P3[][] = [];
  let run: P3[] | null = null;
  for (let k = 1; k <= count; k += 1) {
    const a = points[(first + k - 1) % count];
    const b = points[(first + k) % count];
    if (a === undefined || b === undefined) continue;
    const aIn = a.z >= 0;
    if (b.z >= 0) {
      if (!aIn) run = b.z === 0 ? [] : [crossing(a, b)];
      run?.push(b);
    } else if (aIn && run !== null) {
      if (a.z !== 0) run.push(crossing(a, b));
      found.push(run);
      run = null;
    }
  }
  const runs = found.filter((stretch) => stretch.length >= 2).map((stretch) => stretch.map((p, i) => (i === 0 || i === stretch.length - 1 ? onLimb(p, r) : p)));
  if (runs.length === 0) return [];
  const bearings: number[] = [];
  for (const stretch of runs) {
    const head = stretch[0] ?? { x: 0, y: 0, z: 0 };
    const tail = stretch[stretch.length - 1] ?? head;
    bearings.push(Math.atan2(head.y, head.x), Math.atan2(tail.y, tail.x));
  }
  let links = pairAlongLimb(bearings);
  if (links === null || links.some((link) => link === undefined)) {
    links = runs.map((stretch, j): Link => {
      const tail = stretch[stretch.length - 1] ?? { x: 0, y: 0, z: 0 };
      const head = runs[(j + 1) % runs.length]?.[0] ?? tail;
      const rising = sweep(Math.atan2(tail.y, tail.x), Math.atan2(head.y, head.x), 1);
      return { to: (j + 1) % runs.length, direction: rising < Math.PI - 1e-9 ? 1 : -1 };
    });
  }
  const outlines: P3[][] = [];
  const used = new Set<number>();
  for (let begin = 0; begin < runs.length; begin += 1) {
    const outline: P3[] = [];
    let j = begin;
    while (!used.has(j)) {
      used.add(j);
      const stretch = runs[j] ?? [];
      const link = links[j];
      const tail = stretch[stretch.length - 1];
      const head = link === undefined ? undefined : runs[link.to]?.[0];
      outline.push(...stretch);
      if (link === undefined || tail === undefined || head === undefined) break;
      outline.push(...arcBetween(tail, head, link.direction, r));
      j = link.to;
    }
    if (outline.length >= 3) outlines.push(outline);
  }
  return outlines;
}

/**
 * What of a line or polygon (already turned, so z > 0 faces the viewer) is in front of the limb of a sphere of radius `r` about the origin: the part with
 * z >= 0, as zero or more outlines.
 * - A line becomes the stretches that face you, each ending on the limb where the line went round it.
 * - A polygon becomes the patch that faces you: where it goes behind, the cut is closed along the limb's arc (not across it), and a polygon that goes
 *   behind and returns in several places comes back as several outlines. All of a polygon in front is kept as it is; all behind is nothing.
 * The inside of a polygon is its smaller side, so the winding it was written in does not matter.
 */
export function clipFront(points: readonly P3[], closed: boolean, r: number): P3[][] {
  if (points.length === 0 || !points.some((p) => p.z >= 0)) return [];
  if (points.every((p) => p.z >= 0)) return [points.slice()];
  return closed ? clipRing(points, r) : clipOpen(points);
}
