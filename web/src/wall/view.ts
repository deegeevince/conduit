// The wall's camera and its frame. A flat lens (x, y, scale) with no sway, lean, yaw or roll, ever; `lensAt` is a function of time since
// the glide began, so no state is stepped; `wallFrame` is an ordinary Frame of PictureFrames (and a few shapes for far cards).

import type { Frame, FigureFrame, PictureFrame, ShapeFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import { REST_POSE } from '../contracts/space';
import type { Tile, WallBox, WallPlan } from './plan';

/** The world point at the centre of the screen, and CSS pixels a world unit is drawn as. One is a tile at full size. */
export interface Lens {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface Screen {
  readonly width: number;
  readonly height: number;
}

export type Motion = 'glide' | 'fade';

export const GLIDE = {
  /** seconds to a neighbour, and the most any glide takes */
  neighbour: 0.45,
  longest: 1.1,
  /** the picture's fastest travel across the screen, in lengths of its longer side a second (the peak of the ease-out) */
  speedCap: 9,
  /** the reduced-motion cross-fade, seconds */
  fade: 0.15,
} as const;

const RHO = Math.SQRT2;

const easeOut = (u: number): number => 1 - (1 - u) ** 2;

export interface GlidePath {
  readonly duration: number;
  readonly straight: boolean;
  readonly rho: number;
  /** the lens at share `u` (0..1) of the way along the path, before easing */
  at(u: number): Lens;
  /** the fastest travel of the picture across the screen, screen widths a second, with the ease-out applied */
  readonly peak: number;
  /** the fastest zoom, e-folds a second */
  readonly peakZoom: number;
  /** the smallest scale on the way */
  readonly lowest: number;
}

/**
 * van Wijk and Nuij, "Smooth and efficient zooming and panning" (2003): the curve that pulls back just far enough to see both ends and
 * closes in again (d3's `interpolateZoom`, by hand). `w` is the width of the world the screen shows.
 */
function vanWijk(a: Lens, b: Lens, vw: number, rho: number): { S: number; at: (s: number) => Lens } {
  const w0 = vw / a.scale;
  const w1 = vw / b.scale;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const d1 = Math.sqrt(d2);
  if (d1 < 1e-6) {
    const S = Math.log(w1 / w0) / rho;
    return {
      S: Math.abs(S),
      at: (s) => ({ x: a.x, y: a.y, scale: vw / (w0 * Math.exp(rho * s * S)) }),
    };
  }
  const rho2 = rho * rho;
  const rho4 = rho2 * rho2;
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / rho;
  const cosh0 = Math.cosh(r0);
  const sinh0 = Math.sinh(r0);
  return {
    S: Math.abs(S),
    at: (s) => {
      const t = s * S;
      const u = (w0 / rho2 / d1) * (cosh0 * Math.tanh(rho * t + r0) - sinh0);
      const w = (w0 * cosh0) / Math.cosh(rho * t + r0);
      return { x: a.x + u * dx, y: a.y + u * dy, scale: vw / w };
    },
  };
}

function measure(at: (u: number) => Lens, duration: number, vw: number): { peak: number; peakZoom: number; lowest: number } {
  const steps = 60;
  let peak = 0;
  let peakZoom = 0;
  let previous = at(0);
  let lowest = previous.scale;
  for (let i = 1; i <= steps; i += 1) {
    const now = at(easeOut(i / steps));
    const dt = duration / steps;
    // how far the picture under the old centre moved across the screen, and how fast the size changed
    peak = Math.max(peak, (Math.hypot(previous.x - now.x, previous.y - now.y) * now.scale) / dt / vw);
    peakZoom = Math.max(peakZoom, Math.abs(Math.log(now.scale / previous.scale)) / dt);
    lowest = Math.min(lowest, now.scale);
    previous = now;
  }
  return { peak, peakZoom, lowest };
}

let remembered: { key: string; path: GlidePath } | null = null;

/** The largest the world shown gets on a vWN path with this rho (the top of its pull-back), in world units wide. */
function widest(a: Lens, b: Lens, vw: number, rho: number): number {
  const w0 = vw / a.scale;
  const w1 = vw / b.scale;
  const d2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const d1 = Math.sqrt(d2);
  if (d1 < 1e-6) return Math.max(w0, w1);
  const rho2 = rho * rho;
  const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * d2) / (2 * w0 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  return Math.max(w0, w1, w0 * Math.cosh(r0));
}

/**
 * The path from one lens to another on a screen. Pure, and remembered for the glide that is under way. It never pulls back past `floor`
 * (the map's smallest scale: tiles do not go under 96 px wide: the curve's rho is lowered until it fits), and its fastest travel across
 * the screen stays under the cap: past it the curve pulls back further where it can, and takes the longest time, instead of going faster.
 * The fastest zoom is reported, not capped (van Wijk and Nuij's curve spends its zoom at a rate set by the distance).
 */
export function glidePath(a: Lens, b: Lens, screen: Screen, floor = 0): GlidePath {
  const key = `${a.x}|${a.y}|${a.scale}|${b.x}|${b.y}|${b.scale}|${screen.width}|${screen.height}|${floor}`;
  if (remembered !== null && remembered.key === key) return remembered.path;
  const vw = screen.width;
  const unit = Math.max(screen.width, screen.height);
  const travelled = Math.hypot(b.x - a.x, b.y - a.y) * a.scale;
  const flat = Math.abs(Math.log(b.scale / a.scale)) < 0.02;
  const within = (m: { peak: number }): boolean => m.peak <= GLIDE.speedCap;
  let path: GlidePath | null = null;
  // a neighbour is a straight pan with no zoom
  if (flat && travelled <= 1.6 * Math.max(screen.width, screen.height)) {
    const at = (u: number): Lens => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, scale: a.scale });
    for (const duration of [GLIDE.neighbour, 0.7, GLIDE.longest]) {
      const m = measure(at, duration, unit);
      if (within(m)) {
        path = { duration, straight: true, rho: 0, at, ...m };
        break;
      }
    }
  }
  if (path === null) {
    // the largest rho whose pull-back stays at or above the floor
    const limit = floor > 0 ? vw / floor : Infinity;
    let top = 8;
    if (widest(a, b, vw, top) > limit) {
      let lo = 0.02;
      let hi = top;
      for (let i = 0; i < 40; i += 1) {
        const mid = (lo + hi) / 2;
        if (widest(a, b, vw, mid) > limit) hi = mid;
        else lo = mid;
      }
      top = lo;
    }
    let best: GlidePath | null = null;
    let last = -1;
    for (const wanted of [RHO, 2, 2.8, 4]) {
      const rho = Math.min(wanted, top);
      if (rho === last) continue;
      last = rho;
      const curve = vanWijk(a, b, vw, rho);
      const natural = Math.min(GLIDE.longest, Math.max(GLIDE.neighbour, 0.3 + 0.17 * curve.S));
      for (const duration of natural >= GLIDE.longest ? [GLIDE.longest] : [natural, GLIDE.longest]) {
        const m = measure(curve.at, duration, unit);
        const found: GlidePath = { duration, straight: false, rho, at: curve.at, ...m };
        if (best === null || m.peak < best.peak) best = found;
        if (within(m)) {
          path = found;
          break;
        }
      }
      if (path !== null) break;
    }
    path = path ?? best;
  }
  const found = path as GlidePath;
  remembered = { key, path: found };
  return found;
}

export function glideSeconds(from: Lens, to: Lens, motion: Motion, screen: Screen, floor = 0): number {
  return motion === 'fade' ? GLIDE.fade : glidePath(from, to, screen, floor).duration;
}

export interface LensState {
  readonly lens: Lens;
  /** the lens being faded out, and how far the new one has come in (0..1); null outside a cross-fade */
  readonly fade: { readonly from: Lens; readonly k: number } | null;
}

/**
 * The lens `since` seconds after a move began. A function of the time alone. With `fade` it never travels: the old view is drawn under
 * the new one, which comes in over 150 ms.
 */
export function lensState(from: Lens, to: Lens, since: number, motion: Motion, screen: Screen, floor = 0): LensState {
  if (since <= 0) return { lens: from, fade: null };
  if (motion === 'fade') {
    if (since >= GLIDE.fade) return { lens: to, fade: null };
    return { lens: to, fade: { from, k: since / GLIDE.fade } };
  }
  const path = glidePath(from, to, screen, floor);
  if (since >= path.duration) return { lens: to, fade: null };
  return { lens: path.at(easeOut(since / path.duration)), fade: null };
}

export function lensAt(from: Lens, to: Lens, since: number, motion: Motion, screen: Screen, floor = 0): Lens {
  return lensState(from, to, since, motion, screen, floor).lens;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The hands: what a pan and a pinch do to a lens (WL2 owns the real touch; the tour and the bench's mouse use these)

export interface Limits {
  readonly min: number;
  readonly max: number;
}

export function panBy(lens: Lens, dx: number, dy: number): Lens {
  return { x: lens.x - dx / lens.scale, y: lens.y - dy / lens.scale, scale: lens.scale };
}

/** Zoom about a point of the screen (relative to its centre) so the world under it stays under it. */
export function zoomAbout(lens: Lens, factor: number, sx: number, sy: number, limits: Limits): Lens {
  const scale = Math.min(limits.max, Math.max(limits.min, lens.scale * factor));
  const wx = lens.x + sx / lens.scale;
  const wy = lens.y + sy / lens.scale;
  return { x: wx - sx / scale, y: wy - sy / scale, scale };
}

/** Where the map's lens sits: all of the wall if its tiles stay at least 96 px wide, else the widest the tiles allow, on the first tile. */
export function mapLens(plan: WallPlan, screen: Screen): Lens {
  const cell = plan.tiles[0]?.box.width ?? 1;
  const margin = 24;
  const fit = Math.min(screen.width / (plan.bounds.width + margin * 2), screen.height / (plan.bounds.height + margin * 2));
  const scale = Math.max(fit, 96 / cell);
  if (scale <= fit + 1e-9) return { x: plan.bounds.x + plan.bounds.width / 2, y: plan.bounds.y + plan.bounds.height / 2, scale };
  return { x: plan.bounds.x + screen.width / 2 / scale - margin / scale, y: plan.bounds.y + screen.height / 2 / scale - margin / scale, scale };
}

/** One frame at full size: the tile's centre and the scale at which it fills the screen. */
export function focusLens(tile: Tile, screen: Screen): Lens {
  return { x: tile.box.x + tile.box.width / 2, y: tile.box.y + tile.box.height / 2, scale: Math.min(screen.width / tile.box.width, screen.height / tile.box.height) };
}

export function limitsOf(plan: WallPlan, screen: Screen): Limits {
  const cell = plan.tiles[0]?.box.width ?? 1;
  const full = Math.min(screen.width / cell, 1);
  const fit = mapLens(plan, screen).scale;
  return { min: Math.min(fit, full), max: Math.max(full, 1) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The frame

export type Tier = 'still' | 'thumb' | 'card';

export type Resolved =
  | { readonly kind: 'picture'; readonly src: string; readonly tier: Tier; readonly box: WallBox }
  | { readonly kind: 'card'; readonly tint: string; readonly box: WallBox };

/** What the tile cache knows: the best picture held for a tile at a width on screen, never a wait. */
export interface StillIndex {
  resolve(tile: Tile, share: number): Resolved;
}

export interface WallView {
  readonly screen: Screen;
  readonly dpr: number;
  readonly spec: LookSpec;
  readonly ambient: number;
  readonly reducedMotion: boolean;
}

const MASK = 'none' as const;

/** The tiles a lens can see, nearest the centre first: those that touch the screen. */
export function visibleTiles(plan: WallPlan, lens: Lens, screen: Screen, out: Tile[] = []): Tile[] {
  out.length = 0;
  const left = lens.x - screen.width / 2 / lens.scale;
  const right = lens.x + screen.width / 2 / lens.scale;
  const top = lens.y - screen.height / 2 / lens.scale;
  const bottom = lens.y + screen.height / 2 / lens.scale;
  for (const tile of plan.tiles) {
    const b = tile.box;
    if (b.x + b.width < left || b.x > right || b.y + b.height < top || b.y > bottom) continue;
    out.push(tile);
  }
  return out;
}

function figuresOf(plan: WallPlan, lens: Lens, stills: StillIndex, view: WallView, tag: string, opacity: number, z: number, into: FigureFrame[]): void {
  const seen = visibleTiles(plan, lens, view.screen);
  const affine = { a: lens.scale, b: 0, c: 0, d: lens.scale, e: -lens.x * lens.scale, f: -lens.y * lens.scale };
  const cards = new Map<string, { tint: string; boxes: WallBox[]; ids: string[] }>();
  for (const tile of seen) {
    const share = (tile.box.width * lens.scale) / view.screen.width;
    const what = stills.resolve(tile, share);
    if (what.kind === 'picture') {
      const picture: PictureFrame = {
        kind: 'picture',
        key: `${tag}${tile.node}`,
        id: tile.node,
        layer: 'mid',
        z,
        box: what.box,
        transform: affine,
        src: what.src,
        develop: 1,
        mask: MASK,
        opacity,
        waiting: false,
        tappable: false,
      };
      into.push(picture);
    } else {
      let group = cards.get(what.tint);
      if (group === undefined) {
        group = { tint: what.tint, boxes: [], ids: [] };
        cards.set(what.tint, group);
      }
      group.boxes.push(what.box);
      group.ids.push(tile.index.toString(36));
    }
  }
  for (const group of cards.values()) {
    const shape: ShapeFrame = {
      kind: 'shape',
      key: `${tag}cards:${group.tint}`,
      id: `cards:${group.tint}`,
      layer: 'mid',
      z: z - 0.5,
      outline: group.boxes.map((b) => ({
        points: [
          { x: b.x, y: b.y },
          { x: b.x + b.width, y: b.y },
          { x: b.x + b.width, y: b.y + b.height },
          { x: b.x, y: b.y + b.height },
        ],
        closed: true,
      })),
      geometryKey: `${group.tint}:${group.ids.join(',')}`,
      transform: affine,
      fill: { colour: group.tint, to: null, opacity: 1 },
      stroke: null,
      opacity,
      bleed: false,
      tappable: false,
    };
    into.push(shape);
  }
}

/** The wall at one lens as a Frame like any other: pictures, and a few shapes for the cards. A cross-fade draws the old view under the new. */
export function wallFrame(plan: WallPlan, state: LensState, stills: StillIndex, view: WallView): Frame {
  const { screen, spec } = view;
  const figures: FigureFrame[] = [];
  if (state.fade !== null) figuresOf(plan, state.fade.from, stills, view, 'o:', 1, 1, figures);
  figuresOf(plan, state.lens, stills, view, state.fade === null ? 't:' : 'n:', state.fade === null ? 1 : state.fade.k, 2, figures);
  return {
    time: view.ambient,
    ambient: view.ambient,
    wallTime: 0,
    clock: 'playing',
    viewport: { width: screen.width, height: screen.height, dpr: view.dpr },
    look: spec.id,
    spec,
    lookChange: null,
    bodySize: 16,
    margin: 16,
    canvas: { box: { x: -screen.width / 2, y: -screen.height / 2, width: screen.width, height: screen.height }, unit: 1 },
    gridTop: 0,
    ground: spec.roles.ground,
    camera: REST_POSE,
    agitation: 0,
    dim: 0,
    reducedMotion: view.reducedMotion,
    elements: [],
    figures,
    fields: [],
    cursor: null,
  };
}
