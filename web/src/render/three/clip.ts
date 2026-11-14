// Frames (`Clip`): a rectangle on a layer's plane that nothing of a thing is drawn outside.
//
// The rectangle is in stage units on the thing's own plane with the camera at rest, y down. A layer's group only
// moves in depth, so the world x and y of a vertex ARE its plane coordinates (with y flipped, as the scene is y up).
// Every program that draws a thing asks for that position as a varying and discards what lies outside the rectangle:
// one uniform, one comparison, no stencil and no render target, and the same test in a picture as on the screen.

import { Vector4 } from 'three';
import type { IUniform } from 'three';
import type { Clip } from '../../contracts/frame';

/** The vertex shader's half: pass the world position in. `at` is an expression for a vec4 in the thing's world space. */
export const CLIP_VERTEX_DECL = /* glsl */ `varying vec2 vConduitClipAt;`;

export function clipVertex(world: string): string {
  return `vConduitClipAt = (${world}).xy;`;
}

/** The fragment shader's half: the declarations, then the test as the first statement of `main`. */
export const CLIP_FRAGMENT_DECL = /* glsl */ `
uniform vec4 uConduitClip;
varying vec2 vConduitClipAt;
`;

export const CLIP_TEST = /* glsl */ `
  if (vConduitClipAt.x < uConduitClip.x || vConduitClipAt.y < uConduitClip.y || vConduitClipAt.x > uConduitClip.z || vConduitClipAt.y > uConduitClip.w) discard;
`;

const REACH = 1e9;

/** A uniform every clipped material holds: min x, min y, max x, max y in the scene's own axes (y up). Born open. */
export function makeClipUniform(): IUniform<Vector4> {
  return { value: new Vector4(-REACH, -REACH, REACH, REACH) };
}

/** Writes a frame's `clip` (or its absence) into a clip uniform. Returns true when it changed anything. */
export function setClip(uniform: IUniform | undefined, clip: Clip | undefined): boolean {
  const v: unknown = uniform?.value;
  if (!(v instanceof Vector4)) return false;
  const minX = clip === undefined ? -REACH : clip.x;
  const maxX = clip === undefined ? REACH : clip.x + clip.width;
  const minY = clip === undefined ? -REACH : -(clip.y + clip.height);
  const maxY = clip === undefined ? REACH : -clip.y;
  if (v.x === minX && v.y === minY && v.z === maxX && v.w === maxY) return false;
  v.set(minX, minY, maxX, maxY);
  return true;
}

/** Whether a point on the thing's plane (stage units, y down) is inside its frame. Absent means everywhere. */
export function insideClip(clip: Clip | undefined, x: number, y: number): boolean {
  return clip === undefined || (x >= clip.x && x <= clip.x + clip.width && y >= clip.y && y <= clip.y + clip.height);
}
