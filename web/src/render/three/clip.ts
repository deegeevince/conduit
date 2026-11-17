// Frames (`Clip`): a rectangle on a layer's plane that nothing of a thing is drawn outside.
//
// The rectangle is in stage units on the thing's own plane with the camera at rest, y down. A layer's group only
// moves in depth, so the world x and y of a vertex ARE its plane coordinates (with y flipped, as the scene is y up).
// Every program that draws a thing asks for that position as a varying and discards what lies outside the rectangle:
// one uniform, one comparison, no stencil and no render target, and the same test in a picture as on the screen.

import { Matrix4, Vector4 } from 'three';
import type { IUniform, Texture } from 'three';
import type { Clip } from '../../contracts/frame';
import type { DistanceField } from './sdf';

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

// Paint inside a shape (`clip=<id>`): the clipping shape's distance field is a small 8-bit texture over its box, and the fragment asks it
// whether the world position it is drawing lies inside, with an edge as soft as one pixel. No stencil and no render target, so nothing here
// costs more than 16 kB a clipping shape and one texture read a fragment; fills and strokes are cut by the same test.

/** The fragment shader's half: the uniforms, and `conduitShapeCover()`, 1 inside the shape and 0 outside it. Needs `vConduitClipAt`. */
export const SHAPE_CLIP_FRAGMENT = /* glsl */ `
uniform sampler2D tClipShape;
uniform vec4 uClipShapeBox;
uniform float uClipShapeRange;
uniform float uHasClipShape;
uniform mat4 uClipShapeInv;
float conduitShapeCover() {
  if (uHasClipShape < 0.5) return 1.0;
  vec2 local = (uClipShapeInv * vec4(vConduitClipAt, 0.0, 1.0)).xy;
  vec2 uv = (local - uClipShapeBox.xy) / uClipShapeBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  float d = (texture2D(tClipShape, uv).r - 0.5) * 2.0 * uClipShapeRange;
  float aa = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(-aa, aa, d);
}
`;

export function makeShapeClipUniforms(): Record<string, IUniform> {
  return {
    tClipShape: { value: null as Texture | null },
    uClipShapeBox: { value: new Vector4(0, 0, 1, 1) },
    uClipShapeRange: { value: 1 },
    uHasClipShape: { value: 0 },
    uClipShapeInv: { value: new Matrix4() },
  };
}

const scratch = new Matrix4();

/** Points a material's clip-shape uniforms at a field and at the matrix that took the clipping shape's own units to the scene (or at nothing). */
export function setShapeClip(uniforms: Record<string, IUniform>, field: DistanceField | null, toScene: Matrix4 | null): void {
  const has = uniforms['uHasClipShape'];
  if (has === undefined) return;
  if (field === null || toScene === null) {
    has.value = 0;
    return;
  }
  has.value = 1;
  const slot = uniforms['tClipShape'];
  if (slot !== undefined) slot.value = field.texture;
  (uniforms['uClipShapeBox']?.value as Vector4 | undefined)?.set(field.x, field.y, field.width, field.height);
  const range = uniforms['uClipShapeRange'];
  if (range !== undefined) range.value = field.range;
  (uniforms['uClipShapeInv']?.value as Matrix4 | undefined)?.copy(scratch.copy(toScene).invert());
}
