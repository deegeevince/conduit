// The geometry every part of the web app agrees on. The painter lays out in
// these units and the renderer draws in them; if the two disagreed about
// where the camera is, focus, picking and fitting would all be wrong at once.
//
// STAGE UNITS. One unit is one CSS pixel on the reading plane when the camera
// is at rest. The origin is the centre of the viewport. +x is right, +y is
// DOWN (screen convention; a WebGL renderer flips it), +z is toward the viewer.

import type { Layer } from '@conduit/language';

export interface Viewport {
  /** CSS pixels of the stage host */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /**
   * CSS pixels from the foot of the stage that the page keeps for its own controls over the stage (the tour's bar, fb-004), on top of the line that floats there:
   * nothing the painter lays out stands in this band, so the stage keeps the room for as long as the controls are up and nothing jumps when they appear. Absent: none.
   */
  readonly foot?: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Box {
  /** top-left corner */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The part of the page the screen shows, for a stage looked at through a lens. `x`, `y` are the page point at the screen's top-left,
 * `scale` is the screen pixels one page unit takes, and `width`, `height` are the screen window in CSS pixels. Absent on a frame: the screen shows
 * the page from its top-left at one to one, as it always has.
 */
export interface LensView {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the camera is, relative to rest. The painter animates these numbers;
 * the renderer turns them into a real camera with `cameraRig`.
 */
export interface CameraPose {
  /** truck: camera and its target move together across the stage, in stage units */
  readonly x: number;
  readonly y: number;
  /** stage units toward the stage; positive pushes in */
  readonly dolly: number;
  /** radians of orbit around the point the camera looks at, about the vertical axis */
  readonly yaw: number;
  /** radians of orbit about the horizontal axis */
  readonly pitch: number;
  /** radians about the view axis */
  readonly roll: number;
}

export const REST_POSE: CameraPose = { x: 0, y: 0, dolly: 0, yaw: 0, pitch: 0, roll: 0 };

/** Vertical field of view. Narrow, like a title-sequence lens: enough perspective to feel depth, not enough to distort type. */
export const FOV_Y_DEGREES = 35;

/** How far behind and in front of the reading plane the other layers sit, as a share of the viewport height. `far` is deep enough to barely move under a pan: a sky. */
export const LAYER_DEPTH: Readonly<Record<Layer, number>> = { far: -2.6, bg: -1.1, mid: 0, fg: 0.32 };

/** The furthest the camera may push, as a share of its rest distance. Keeps it well clear of the foreground plane. */
export const MAX_DOLLY = 0.4;

/** Distance from the resting camera to the reading plane, at which one stage unit is one CSS pixel. */
export function restDistance(viewport: Viewport): number {
  return viewport.height / (2 * Math.tan((FOV_Y_DEGREES * Math.PI) / 360));
}

export function layerZ(layer: Layer, viewport: Viewport): number {
  return LAYER_DEPTH[layer] * viewport.height;
}

/**
 * How large one stage unit on a layer appears on screen with the camera at
 * rest. The painter divides by this to make a background word that is laid
 * out in its own plane's units end up the intended size on screen.
 */
export function planeScale(layer: Layer, viewport: Viewport): number {
  const distance = restDistance(viewport);
  return distance / (distance - layerZ(layer, viewport));
}

/** The visible rectangle of a layer's plane, in that plane's stage units, with the camera at rest. */
export function planeBounds(layer: Layer, viewport: Viewport): Box {
  const scale = planeScale(layer, viewport);
  const width = viewport.width / scale;
  const height = viewport.height / scale;
  return { x: -width / 2, y: -height / 2, width, height };
}

/** Whether a view is the plain one (the page's top-left at one to one), which a renderer draws as it always has. */
export function isRest(view: LensView | null | undefined): boolean {
  return view === null || view === undefined || (view.scale === 1 && view.x === 0 && view.y === 0);
}

/** A point on the screen (CSS pixels from its top-left) as a point on the page. */
export function toPage(view: LensView | null | undefined, x: number, y: number): { readonly x: number; readonly y: number } {
  return view === null || view === undefined ? { x, y } : { x: view.x + x / view.scale, y: view.y + y / view.scale };
}

/** A point on the page as a point on the screen. */
export function toScreen(view: LensView | null | undefined, x: number, y: number): { readonly x: number; readonly y: number } {
  return view === null || view === undefined ? { x, y } : { x: (x - view.x) * view.scale, y: (y - view.y) * view.scale };
}

/** The CSS transform that lays a page-sized layer (origin at its top-left) over the screen as the view says. */
export function cssOf(view: LensView | null | undefined): string {
  if (isRest(view)) return '';
  const v = view as LensView;
  return `translate(${-v.x * v.scale}px, ${-v.y * v.scale}px) scale(${v.scale})`;
}

export interface CameraRig {
  /** stage units, y down */
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly roll: number;
  readonly fovYDegrees: number;
}

/** The actual camera for a pose: it orbits its target on the reading plane at the dollied distance. */
export function cameraRig(pose: CameraPose, viewport: Viewport): CameraRig {
  const rest = restDistance(viewport);
  const distance = rest - Math.min(pose.dolly, rest * MAX_DOLLY);
  const cosPitch = Math.cos(pose.pitch);
  return {
    position: {
      x: pose.x + distance * Math.sin(pose.yaw) * cosPitch,
      y: pose.y + distance * Math.sin(pose.pitch),
      z: distance * Math.cos(pose.yaw) * cosPitch,
    },
    target: { x: pose.x, y: pose.y, z: 0 },
    up: { x: 0, y: -1, z: 0 },
    roll: pose.roll,
    fovYDegrees: FOV_Y_DEGREES,
  };
}

/**
 * Projects a point in stage space to CSS pixels in the host (origin top-left).
 * Exact for poses without roll, which is all the painter needs it for:
 * fitting, focus framing and reporting where things are.
 */
export function projectToScreen(point: Vec3, pose: CameraPose, viewport: Viewport): { x: number; y: number; scale: number } {
  const rig = cameraRig(pose, viewport);
  const forward = normalize(subtract(rig.target, rig.position));
  // Stage space is left-handed (y down, z toward the viewer), hence this order of operands.
  const right = normalize(cross(rig.up, forward));
  const down = cross(right, forward);
  const relative = subtract(point, rig.position);
  const depth = Math.max(1e-6, dot(relative, forward));
  const focal = restDistance(viewport);
  const scale = focal / depth;
  return {
    x: viewport.width / 2 + dot(relative, right) * scale,
    y: viewport.height / 2 + dot(relative, down) * scale,
    scale,
  };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
}
