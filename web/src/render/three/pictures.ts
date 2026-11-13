// Paintings: textures that grow over their sketch.

import type { Group } from 'three';
import type { Layer } from '@conduit/language';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, LinearFilter, LinearMipmapLinearFilter, Matrix4, Mesh, ShaderMaterial, Texture, Vector2, Vector4 } from 'three';
import type { Affine, PictureFrame } from '../../contracts/frame';
import type { LookSpec } from '../../contracts/look';
import { HASH, NOISE } from './glsl';
import { renderOrderOf } from './stage';
import { inkColour } from './style';
import type { SurfaceStyle } from './style';

export interface PicturePool {
  /** Fetches and decodes a painting. Resolves when a frame naming `url` can be drawn; the texture is kept until no frame has named it for 30 s. */
  preload(url: string): Promise<void>;
  /**
   * One quad per picture, cover-fitted into its box. `develop` drives a wash:
   * the painting appears first where a noise field is lowest and spreads, with
   * a soft wet edge, so it grows rather than cross-fades; at 1 it is exactly
   * the texture. `mask` shapes the alpha (`round`, `circle`, `soft`, `torn`).
   * While `waiting` and nothing is developed, the box's edge breathes at low
   * opacity in the look's dim colour, and nothing else is drawn.
   *
   * `now` is the ambient clock, which paces the breathing and ages the textures; `look` and `style` say which colour is dim and how ink is stored.
   */
  sync(groups: Readonly<Record<Layer, Group>>, pictures: readonly PictureFrame[], now?: number, look?: LookSpec, style?: SurfaceStyle): void;
  dispose(): void;
}

const MASKS = { none: 0, round: 1, circle: 2, soft: 3, torn: 4 } as const;

const VERTEX = /* glsl */ `
varying vec2 vBox;
void main() {
  vBox = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tPicture;
uniform vec4 uFit;
uniform vec2 uHalf;
uniform vec2 uCentre;
uniform float uDevelop;
uniform float uHasPicture;
uniform float uMask;
uniform float uOpacity;
uniform float uBreath;
uniform float uSeed;
uniform vec3 uDim;
uniform vec3 uGround;
uniform float uMultiply;
varying vec2 vBox;
${HASH}
${NOISE}

void main() {
  vec2 local = vBox - uCentre;
  vec2 uv = vec2(0.5 + local.x * uFit.x + uFit.z, 0.5 + local.y * uFit.y + uFit.w);
  // Distance inward from the edge of the box, in units of the box's shorter side.
  float shorter = min(uHalf.x, uHalf.y) * 2.0;
  vec2 inward = uHalf - abs(local);
  float edge = min(inward.x, inward.y) / shorter;
  float px = max(fwidth(edge), 1e-5);
  float shape;
  if (uMask < 0.5) {
    shape = smoothstep(0.0, px, edge);
  } else if (uMask < 1.5) {
    float r = 0.16 * shorter;
    vec2 q = abs(local) - (uHalf - r);
    float d = (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r) / shorter;
    shape = 1.0 - smoothstep(-px, px, d);
  } else if (uMask < 2.5) {
    float d = (length(local) - shorter * 0.5) / shorter;
    shape = 1.0 - smoothstep(-px, px, d);
  } else if (uMask < 3.5) {
    shape = smoothstep(0.0, 0.16, edge);
  } else {
    float rough = (fbm(vBox * 0.09 + uSeed) - 0.5) * 0.09 + (hash21(floor(vBox * 0.5) + uSeed) - 0.5) * 0.012;
    shape = smoothstep(0.0, max(px * 1.5, 0.004), edge + rough);
  }

  float alpha = 0.0;
  vec3 colour = uDim;
  if (uHasPicture > 0.5 && uDevelop > 0.0) {
    // A wash: it appears first where the noise is lowest and spreads, with a soft wet edge. At 1 it is exactly the picture.
    float field = fbm(vBox * 0.012 + uSeed * 7.0) * 0.85 + 0.15 * vnoise(vBox * 0.05);
    float width = 0.22;
    float grown = smoothstep(field, field + width, uDevelop * (1.0 + width));
    vec3 art = texture2D(tPicture, clamp(uv, 0.0, 1.0)).rgb;
    float rim = grown * (1.0 - smoothstep(0.0, 0.5, grown)) * 2.0;
    art *= 1.0 - 0.07 * rim * (1.0 - step(0.999, uDevelop));
    colour = art;
    alpha = grown * shape;
  } else if (uBreath > 0.0) {
    // Only the edge of the box, breathing, while a painting is on its way.
    float band = 1.0 - smoothstep(0.0, 0.025, edge);
    alpha = band * uBreath * step(0.0, edge);
  }
  if (uMultiply > 0.5) colour = min(colour / max(uGround, vec3(1e-3)), vec3(1.0));
  alpha *= uOpacity;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(colour, alpha);
}
`;

interface Held {
  texture: Texture;
  width: number;
  height: number;
  lastNamed: number;
  /** true once a frame has actually drawn it: a picture preloaded for a moment that has not come yet is never aged out */
  shown: boolean;
}

interface Entry {
  mesh: Mesh;
  material: ShaderMaterial;
  geometry: BufferGeometry;
  box: string;
  seen: boolean;
}

function matrixOf(affine: Affine, target: Matrix4): Matrix4 {
  return target.set(affine.a, affine.c, 0, affine.e, -affine.b, -affine.d, 0, -affine.f, 0, 0, 1, 0, 0, 0, 0, 1);
}

function seedOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 997) / 997;
}

const KEEP_SECONDS = 30;

export function createPicturePool(): PicturePool {
  const held = new Map<string, Held>();
  const loading = new Map<string, Promise<void>>();
  const entries = new Map<string, Entry>();
  let clock = 0;
  let disposed = false;

  const load = async (url: string): Promise<void> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`the painting could not be fetched (${response.status})`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
    if (disposed) {
      bitmap.close();
      return;
    }
    const texture = new Texture(bitmap);
    texture.flipY = false;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    held.set(url, { texture, width: bitmap.width, height: bitmap.height, lastNamed: clock, shown: false });
  };

  const make = (): Entry => {
    const geometry = new BufferGeometry();
    const material = new ShaderMaterial({
      uniforms: {
        tPicture: { value: null },
        uFit: { value: new Vector4(1, 1, 0, 0) },
        uHalf: { value: new Vector2(1, 1) },
        uCentre: { value: new Vector2(0, 0) },
        uDevelop: { value: 0 },
        uHasPicture: { value: 0 },
        uMask: { value: 0 },
        uOpacity: { value: 1 },
        uBreath: { value: 0 },
        uSeed: { value: 0 },
        uDim: { value: new Color() },
        uGround: { value: new Color() },
        uMultiply: { value: 0 },
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
    return { mesh, material, geometry, box: '', seen: true };
  };

  const release = (entry: Entry): void => {
    entry.mesh.removeFromParent();
    entry.geometry.dispose();
    entry.material.dispose();
  };

  return {
    preload(url) {
      if (held.has(url)) {
        const found = held.get(url);
        if (found !== undefined) found.lastNamed = clock;
        return Promise.resolve();
      }
      let pending = loading.get(url);
      if (pending === undefined) {
        pending = load(url).finally(() => loading.delete(url));
        loading.set(url, pending);
      }
      return pending;
    },

    sync(groups, pictures, now, look, style) {
      if (style === undefined || look === undefined) return;
      if (now !== undefined) clock = now;
      for (const entry of entries.values()) entry.seen = false;
      for (const picture of pictures) {
        let entry = entries.get(picture.key);
        if (entry === undefined) {
          entry = make();
          entries.set(picture.key, entry);
        }
        entry.seen = true;
        const root = groups[picture.layer];
        if (entry.mesh.parent !== root) root.add(entry.mesh);
        const { box } = picture;
        const boxKey = `${box.x}|${box.y}|${box.width}|${box.height}`;
        if (entry.box !== boxKey) {
          const x0 = box.x;
          const x1 = box.x + box.width;
          const y0 = box.y;
          const y1 = box.y + box.height;
          entry.geometry.setAttribute('position', new BufferAttribute(new Float32Array([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0]), 3));
          entry.geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
          entry.box = boxKey;
        }
        const have = picture.src === null ? undefined : held.get(picture.src);
        if (have !== undefined) {
          have.lastNamed = clock;
          have.shown = true;
        } else if (picture.src !== null && !loading.has(picture.src)) {
          // Named but not held (aged out, or lost with a context): fetch it again rather than draw nothing for ever.
          const url = picture.src;
          const again = load(url).finally(() => loading.delete(url));
          again.catch(() => undefined);
          loading.set(url, again);
        }
        const u = entry.material.uniforms;
        const set = (name: string, value: number): void => {
          const slot = u[name];
          if (slot !== undefined) slot.value = value;
        };
        const slot = u['tPicture'];
        if (slot !== undefined) slot.value = have?.texture ?? null;
        // Cover-fit: the shorter proportion fills the box and the longer one is cropped, from the centre.
        let fitX = 1 / Math.max(box.width, 1e-6);
        let fitY = 1 / Math.max(box.height, 1e-6);
        if (have !== undefined) {
          const boxAspect = box.width / Math.max(box.height, 1e-6);
          const imageAspect = have.width / Math.max(have.height, 1);
          if (imageAspect > boxAspect) fitX *= boxAspect / imageAspect;
          else fitY *= imageAspect / boxAspect;
        }
        (u['uFit']?.value as Vector4).set(fitX, fitY, 0, 0);
        (u['uHalf']?.value as Vector2).set(box.width / 2, box.height / 2);
        (u['uCentre']?.value as Vector2).set(box.x + box.width / 2, box.y + box.height / 2);
        set('uDevelop', picture.develop);
        set('uHasPicture', have === undefined ? 0 : 1);
        set('uMask', MASKS[picture.mask]);
        set('uOpacity', picture.opacity);
        set('uSeed', seedOf(picture.key));
        // The edge breathes about once every five seconds, at a tenth to a fifth of the dim ink.
        set('uBreath', picture.waiting && picture.develop <= 0 ? 0.1 + 0.07 * (0.5 + 0.5 * Math.sin(clock * 1.26)) : 0);
        (u['uDim']?.value as Color).copy(inkColour(style, look.roles.dim));
        (u['uGround']?.value as Color).copy(style.ground);
        set('uMultiply', style.multiply ? 1 : 0);
        matrixOf(picture.transform, entry.mesh.matrix);
        entry.mesh.matrixWorldNeedsUpdate = true;
        entry.mesh.renderOrder = renderOrderOf(picture.layer, 'fill', picture.z);
        entry.mesh.visible = picture.opacity > 0.002;
      }
      for (const [key, entry] of entries) {
        if (!entry.seen) {
          release(entry);
          entries.delete(key);
        }
      }
      for (const [url, texture] of held) {
        // The clock can run backwards (a seek, a new film): age from the new time, never from the old.
        if (texture.lastNamed > clock) texture.lastNamed = clock;
        if (texture.shown && clock - texture.lastNamed > KEEP_SECONDS) {
          texture.texture.dispose();
          held.delete(url);
        }
      }
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) release(entry);
      entries.clear();
      for (const texture of held.values()) texture.texture.dispose();
      held.clear();
    },
  };
}
