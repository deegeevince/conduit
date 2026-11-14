// Pixel sprites: real pixels, never smoothed.

import type { Group } from 'three';
import type { Layer } from '@conduit/language';
import { BufferAttribute, BufferGeometry, DataTexture, DoubleSide, Matrix4, Mesh, NearestFilter, RGBAFormat, ShaderMaterial, UnsignedByteType, Vector2 } from 'three';
import type { Affine, SpriteFrame } from '../../contracts/frame';
import { CLIP_FRAGMENT_DECL, CLIP_TEST, CLIP_VERTEX_DECL, clipVertex, makeClipUniform, setClip } from './clip';
import { PIXEL_SCALE } from './glsl';
import { renderOrderOf } from './stage';
import { VIEW_PX, inkColour } from './style';
import type { SurfaceStyle } from './style';

export interface SpritePool {
  /**
   * One quad per sprite with a `cols x rows` RGBA texture, nearest-filtered,
   * rebuilt only when `cellsKey` changes. `landed` is a uniform: rows below
   * it are discarded and the row arriving is drawn at its share of opacity.
   * When a cell covers fewer than two device pixels the sprite is snapped to
   * whole device pixels so cells stay square and even.
   *
   * `style` says how the look stores ink; the textures are rebuilt when it changes.
   */
  sync(groups: Readonly<Record<Layer, Group>>, sprites: readonly SpriteFrame[], style?: SurfaceStyle): void;
  dispose(): void;
}

const VERTEX = /* glsl */ `
uniform vec2 uCells;
uniform float uCell;
uniform float uSnap;
${PIXEL_SCALE}
${CLIP_VERTEX_DECL}
varying vec2 vCell;

vec2 pixelsOf(vec4 clip) {
  return (clip.xy / clip.w * 0.5 + 0.5) * uViewPx;
}

void main() {
  vec2 extent = uCells * uCell;
  vec2 corner = position.xy;
  vCell = corner / uCell + uCells * 0.5;
  ${clipVertex('modelMatrix * vec4(corner, 0.0, 1.0)')}
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 centre = mvp * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 clip = mvp * vec4(corner, 0.0, 1.0);
  if (uSnap > 0.5) {
    // Where a cell is under two device pixels, the sprite takes whole pixels: each cell a whole number of them, the whole sprite on the pixel grid.
    vec2 c = pixelsOf(centre);
    vec2 across = pixelsOf(mvp * vec4(uCell, 0.0, 0.0, 1.0)) - c;
    vec2 down = pixelsOf(mvp * vec4(0.0, uCell, 0.0, 1.0)) - c;
    float size = 0.5 * (length(across) + length(down));
    bool upright = abs(across.y) < 0.02 * size && abs(down.x) < 0.02 * size;
    if (upright && size < 2.0) {
      float whole = max(1.0, floor(size + 0.5));
      vec2 half_ = uCells * whole * 0.5;
      vec2 origin = floor(c + 0.5) + 0.5 * mod(uCells * whole, 2.0);
      vec2 side = vec2(corner.x > 0.0 ? 1.0 : -1.0, corner.y > 0.0 ? -1.0 : 1.0);
      vec2 snapped = origin + side * half_;
      clip.xy = (snapped / uViewPx * 2.0 - 1.0) * centre.w;
      clip.w = centre.w;
      clip.z = centre.z;
    }
  }
  gl_Position = clip;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform highp sampler2D tCells;
uniform vec2 uCells;
uniform float uLanded;
uniform float uOpacity;
${CLIP_FRAGMENT_DECL}
varying vec2 vCell;
void main() {
  ${CLIP_TEST}
  vec2 cell = floor(vCell);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= uCells.x || cell.y >= uCells.y) discard;
  // Rows arrive one after another from the top; the one arriving is drawn at its share of opacity.
  float row = clamp(uLanded - cell.y, 0.0, 1.0);
  if (row <= 0.0) discard;
  vec4 texel = texelFetch(tCells, ivec2(cell), 0);
  float alpha = texel.a * row * uOpacity;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(texel.rgb, alpha);
}
`;

interface Entry {
  mesh: Mesh;
  material: ShaderMaterial;
  texture: DataTexture | null;
  geometry: BufferGeometry;
  cellsKey: string;
  size: string;
  seen: boolean;
}

function matrixOf(affine: Affine, target: Matrix4): Matrix4 {
  return target.set(affine.a, affine.c, 0, affine.e, -affine.b, -affine.d, 0, -affine.f, 0, 0, 1, 0, 0, 0, 0, 1);
}

function upright(affine: Affine): boolean {
  return Math.abs(affine.b) < 1e-6 && Math.abs(affine.c) < 1e-6 && affine.a > 0 && affine.d > 0;
}

export function createSpritePool(): SpritePool {
  const entries = new Map<string, Entry>();

  const make = (): Entry => {
    const geometry = new BufferGeometry();
    const material = new ShaderMaterial({
      uniforms: {
        tCells: { value: null },
        uCells: { value: new Vector2(1, 1) },
        uCell: { value: 1 },
        uSnap: { value: 0 },
        uLanded: { value: 0 },
        uOpacity: { value: 1 },
        uViewPx: VIEW_PX,
        uConduitClip: makeClipUniform(),
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return { mesh, material, texture: null, geometry, cellsKey: '', size: '', seen: true };
  };

  const release = (entry: Entry): void => {
    entry.mesh.removeFromParent();
    entry.geometry.dispose();
    entry.material.dispose();
    entry.texture?.dispose();
  };

  const upload = (entry: Entry, sprite: SpriteFrame, style: SurfaceStyle): void => {
    entry.texture?.dispose();
    const data = new Uint8Array(sprite.cols * sprite.rows * 4);
    sprite.cells.forEach((cell, index) => {
      if (cell === null) return;
      const colour = inkColour(style, cell);
      data[index * 4] = Math.round(colour.r * 255);
      data[index * 4 + 1] = Math.round(colour.g * 255);
      data[index * 4 + 2] = Math.round(colour.b * 255);
      data[index * 4 + 3] = 255;
    });
    const texture = new DataTexture(data, sprite.cols, sprite.rows, RGBAFormat, UnsignedByteType);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    entry.texture = texture;
    const slot = entry.material.uniforms['tCells'];
    if (slot !== undefined) slot.value = texture;
  };

  return {
    sync(groups, sprites, style) {
      if (style === undefined) return;
      for (const entry of entries.values()) entry.seen = false;
      for (const sprite of sprites) {
        let entry = entries.get(sprite.key);
        if (entry === undefined) {
          entry = make();
          entries.set(sprite.key, entry);
        }
        entry.seen = true;
        const root = groups[sprite.layer];
        if (entry.mesh.parent !== root) root.add(entry.mesh);

        const size = `${sprite.cols}x${sprite.rows}x${sprite.cell}`;
        if (entry.size !== size) {
          const w = (sprite.cols * sprite.cell) / 2;
          const h = (sprite.rows * sprite.cell) / 2;
          entry.geometry.setAttribute('position', new BufferAttribute(new Float32Array([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0]), 3));
          entry.geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
          entry.size = size;
        }
        const wanted = `${sprite.cellsKey}|${style.key}`;
        if (entry.cellsKey !== wanted) {
          upload(entry, sprite, style);
          entry.cellsKey = wanted;
        }
        const u = entry.material.uniforms;
        (u['uCells']?.value as Vector2).set(sprite.cols, sprite.rows);
        const set = (name: string, value: number): void => {
          const slot = u[name];
          if (slot !== undefined) slot.value = value;
        };
        set('uCell', sprite.cell);
        set('uSnap', upright(sprite.transform) ? 1 : 0);
        set('uLanded', sprite.landed);
        set('uOpacity', sprite.opacity);
        setClip(u['uConduitClip'], sprite.clip);
        matrixOf(sprite.transform, entry.mesh.matrix);
        entry.mesh.matrixWorldNeedsUpdate = true;
        entry.mesh.renderOrder = renderOrderOf(sprite.layer, 'fill', sprite.z) + 1;
        entry.mesh.visible = sprite.opacity > 0.002 && sprite.landed > 0;
      }
      for (const [key, entry] of entries) {
        if (!entry.seen) {
          release(entry);
          entries.delete(key);
        }
      }
    },
    dispose() {
      for (const entry of entries.values()) release(entry);
      entries.clear();
    },
  };
}
