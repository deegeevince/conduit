// Atmosphere: thousands of small things, all of them on the GPU.

import type { Group } from 'three';
import type { AmbientKind, Layer } from '@conduit/language';
import { BufferAttribute, Color, DoubleSide, InstancedBufferGeometry, Matrix4, Mesh, ShaderMaterial, Vector2, Vector4 } from 'three';
import type { CameraPose, Viewport } from '../../contracts/space';
import { planeBounds, planeScale } from '../../contracts/space';
import type { FieldFrame, Quality } from '../../contracts/frame';
import { HASH, NOISE, PIXEL_SCALE } from './glsl';
import { renderOrderOf } from './stage';
import { VIEW_PX, inkColour } from './style';
import type { SurfaceStyle } from './style';

export interface FieldPool {
  /**
   * One instanced draw per field. Particle `i` of a field is placed entirely
   * in the vertex shader from (`seed`, `i`, `time`): nothing is integrated
   * frame to frame, so a field can be seeked, paused and exported exactly.
   * Each kind is a motion model (rain falls in streaks along the wind, snow
   * drifts on two sines, embers rise and die, stars only twinkle, fog is a
   * few large soft quads, rays are fixed shafts that breathe).
   * `density` 1 is the kind's own full count at 1440x900; counts scale with
   * the viewport's area and halve in `lite` quality. Reduced motion keeps
   * the field and slows it to a fifth.
   *
   * `camera` keeps the particles around whatever the camera is looking at, and `style` says how ink is stored; both are optional.
   */
  sync(
    groups: Readonly<Record<Layer, Group>>,
    fields: readonly FieldFrame[],
    viewport: Viewport,
    quality: Quality,
    reducedMotion: boolean,
    camera?: CameraPose,
    style?: SurfaceStyle,
  ): void;
  dispose(): void;
}

const KIND: Readonly<Record<AmbientKind, number>> = {
  rain: 0,
  snow: 1,
  dust: 2,
  stars: 3,
  fireflies: 4,
  embers: 5,
  sparks: 6,
  bubbles: 7,
  leaves: 8,
  confetti: 9,
  fog: 10,
  rays: 11,
};

/** The kind's own count at density 1 on a 1440x900 screen. Fog and rays are a few large things, so density thins them instead. */
const COUNT: Readonly<Record<AmbientKind, number>> = {
  rain: 900,
  snow: 520,
  dust: 260,
  stars: 420,
  fireflies: 40,
  embers: 160,
  sparks: 240,
  bubbles: 56,
  leaves: 40,
  confetti: 170,
  fog: 12,
  rays: 7,
};

const FIXED_COUNT: ReadonlySet<AmbientKind> = new Set<AmbientKind>(['fog', 'rays']);

/** Fields on a far layer are smaller, slower and fainter than the same field near. */
const LAYER_FEEL: Readonly<Record<Layer, { size: number; speed: number; alpha: number }>> = {
  far: { size: 0.55, speed: 0.55, alpha: 0.6 },
  bg: { size: 0.8, speed: 0.8, alpha: 0.85 },
  mid: { size: 1, speed: 1, alpha: 1 },
  fg: { size: 1.3, speed: 1.2, alpha: 1 },
};

/** The region particles live in, as a share of the layer's visible rectangle: room for the camera to move without uncovering an edge. */
const MARGIN = 1.35;
/** The share of foreground weather that stays over flowing text. */
const FG_KEEP_OVER_TEXT = 1 / 3;

const VERTEX = /* glsl */ `
uniform float uKind;
uniform float uTime;
uniform float uSeed;
uniform float uUnit;
uniform float uSpeed;
uniform float uThin;
uniform vec2 uRegion;
uniform vec2 uCentre;
uniform vec4 uFlow;
uniform float uKeep;
uniform vec3 uColour;
${PIXEL_SCALE}
${HASH}
varying vec2 vQuad;
varying float vShape;
varying float vAlpha;
varying vec3 vColour;
varying float vPhase;

vec4 rnd(float n) {
  return vec4(hash11(n * 1.713 + uSeed * 13.1), hash11(n * 2.371 + uSeed * 7.7 + 3.0), hash11(n * 3.917 + uSeed * 5.3 + 7.0), hash11(n * 5.131 + uSeed * 3.9 + 11.0));
}

// Particles live in the world, not on the screen: wrapped around the camera so that parallax is real and the edges never show.
vec2 wrap(vec2 p) {
  return uCentre + (fract((p - uCentre) / uRegion + 0.5) - 0.5) * uRegion;
}

vec3 hueTurn(vec3 c, float angle) {
  float s = sin(angle);
  float k = cos(angle);
  vec3 axis = vec3(0.57735);
  return c * k + cross(axis, c) * s + axis * dot(axis, c) * (1.0 - k);
}

void main() {
  float i = float(gl_InstanceID);
  vec4 r = rnd(i);
  float t = uTime;
  float U = uUnit;
  vec2 p0 = (r.xy - 0.5) * uRegion;
  vec2 centre = vec2(0.0);
  vec2 size = vec2(1.0);
  vec2 heading = vec2(0.0, 1.0);
  float spin = 0.0;
  float alpha = 1.0;
  float shape = 1.0;
  vColour = uColour;
  vPhase = r.z * 40.0;

  if (uKind < 0.5) {
    // rain: streaks along the wind
    vec2 d = normalize(vec2(0.2, 1.0));
    float v = (820.0 + 520.0 * r.z) * U * uSpeed;
    centre = wrap(p0 + d * v * t);
    size = vec2(1.3 * U, (22.0 + 26.0 * r.w) * U);
    heading = d;
    alpha = 0.22 + 0.3 * r.w;
    shape = 0.0;
  } else if (uKind < 1.5) {
    // snow: drifts on two sines
    float fall = (38.0 + 52.0 * r.z) * U * uSpeed;
    float sway = sin(t * (0.5 + 0.6 * r.w) + r.x * 30.0) * (12.0 + 22.0 * r.y) * U + sin(t * 0.23 + r.w * 20.0) * 10.0 * U;
    centre = wrap(p0 + vec2(sway, fall * t));
    float s = (2.0 + 3.5 * r.w) * U;
    size = vec2(s);
    alpha = 0.5 + 0.4 * r.z;
    shape = 1.0;
  } else if (uKind < 2.5) {
    // dust: motes hanging in light, drifting this way and that
    vec2 velocity = (vec2(r.z, r.w) - 0.5) * 12.0 * U * uSpeed;
    vec2 wander = vec2(sin(t * 0.11 * uSpeed + r.x * 40.0), cos(t * 0.09 * uSpeed + r.y * 40.0)) * 30.0 * U;
    centre = wrap(p0 + velocity * t + wander);
    size = vec2((1.0 + 2.0 * r.z) * U);
    alpha = 0.2 + 0.5 * (0.5 + 0.5 * sin(t * (0.3 + 0.4 * r.w) + r.z * 30.0));
    shape = 1.0;
  } else if (uKind < 3.5) {
    // stars: still, they only twinkle
    centre = wrap(p0);
    float s = (1.2 + 2.4 * r.z * r.z * r.z) * U;
    size = vec2(s);
    alpha = 0.45 + 0.4 * r.w + 0.15 * sin(t * (0.5 + 0.9 * r.y) + r.x * 50.0);
    shape = 1.0;
  } else if (uKind < 4.5) {
    // fireflies: a few warm lights wandering
    float reach = (40.0 + 60.0 * r.z) * U;
    vec2 loop = vec2(sin(t * (0.2 + 0.25 * r.x) * uSpeed + r.y * 40.0), cos(t * (0.17 + 0.22 * r.y) * uSpeed + r.z * 40.0)) * reach;
    centre = wrap(p0 + loop + vec2(sin(t * 0.07 * uSpeed + r.w * 30.0) * 90.0 * U, 0.0));
    float s = (9.0 + 9.0 * r.w) * U;
    size = vec2(s);
    float pulse = 0.5 + 0.5 * sin(t * (0.5 + 0.5 * r.z) + r.w * 40.0);
    alpha = 0.12 + 0.88 * smoothstep(0.25, 1.0, pulse);
    shape = 5.0;
  } else if (uKind < 5.5) {
    // embers: sparks rising and dying, each life landing somewhere new
    float life = 2.6 + 3.0 * r.z;
    float ct = t * uSpeed / life + r.w;
    float u = fract(ct);
    vec4 q = rnd(i + floor(ct) * 17.3 + 100.0);
    float rise = u * (0.5 + 0.35 * q.z) * uRegion.y;
    float sway = sin(u * 6.2831853 * (1.0 + q.w) + q.x * 20.0) * 20.0 * U;
    centre = wrap(vec2((q.x - 0.5) * uRegion.x, 0.45 * uRegion.y - q.y * 0.25 * uRegion.y - rise) + vec2(sway, 0.0));
    float s = (1.8 + 3.0 * q.z) * U * (1.0 - 0.55 * u);
    size = vec2(s);
    alpha = pow(1.0 - u, 1.4) * smoothstep(0.0, 0.08, u) * (0.6 + 0.4 * q.w);
    shape = 1.0;
  } else if (uKind < 6.5) {
    // sparks: a burst flying outward from a point, three bursts a little apart so there is always one
    float group = floor(r.w * 3.0);
    float ct = t * uSpeed / 2.4 + group / 3.0;
    float u = fract(ct);
    float cyc = floor(ct);
    vec2 origin = (vec2(hash11(cyc * 7.1 + group * 3.3 + uSeed), hash11(cyc * 5.3 + group * 9.1 + uSeed)) - 0.5) * uRegion * 0.4 + vec2(0.0, 0.08 * uRegion.y);
    float angle = r.x * 6.2831853;
    vec2 d = vec2(cos(angle), sin(angle));
    float v = (130.0 + 380.0 * r.y) * U;
    vec2 at = origin + d * v * u * (1.0 - 0.45 * u) + vec2(0.0, 150.0 * U * u * u);
    centre = uCentre + at;
    heading = normalize(d * (1.0 - 0.9 * u) + vec2(0.0, 1.8 * u));
    size = vec2(1.5 * U, (5.0 + 14.0 * r.y * (1.0 - u)) * U);
    alpha = pow(1.0 - u, 1.4) * (0.5 + 0.5 * r.z);
    shape = 0.0;
  } else if (uKind < 7.5) {
    // bubbles: rising, wobbling
    float lift = (24.0 + 40.0 * r.z) * U * uSpeed;
    float wobble = sin(t * (0.7 + 0.5 * r.w) + r.x * 30.0) * (8.0 + 10.0 * r.y) * U;
    centre = wrap(p0 + vec2(wobble, -lift * t));
    float s = (8.0 + 18.0 * r.z * r.z) * U;
    size = vec2(s);
    alpha = 0.55;
    shape = 2.0;
  } else if (uKind < 8.5) {
    // leaves: tumbling across
    float across = (55.0 + 90.0 * r.z) * U * uSpeed;
    float bob = sin(t * (1.1 + r.w) * uSpeed + r.x * 40.0) * (14.0 + 20.0 * r.y) * U;
    centre = wrap(p0 + vec2(across * t, bob + 16.0 * U * uSpeed * t));
    float turn = t * uSpeed * (1.0 + 2.0 * r.y) * (r.x > 0.5 ? 1.0 : -1.0) + r.x * 6.2831853;
    float flip = 0.35 + 0.65 * abs(cos(t * uSpeed * (1.5 + r.z) + r.w * 20.0));
    float s = (12.0 + 10.0 * r.w) * U;
    size = vec2(s * flip * 0.55, s);
    heading = vec2(-sin(turn), cos(turn));
    alpha = 0.75;
    float shade = 0.75 + 0.35 * r.z;
    vColour = uColour * shade;
    shape = 3.0;
  } else if (uKind < 9.5) {
    // confetti: falling and fluttering, every piece its own colour
    float fall = (90.0 + 80.0 * r.z) * U * uSpeed;
    float sway = sin(t * uSpeed * (1.0 + r.w) + r.x * 30.0) * 26.0 * U;
    centre = wrap(p0 + vec2(sway, fall * t));
    float turn = t * uSpeed * (2.0 + 3.0 * r.y) + r.x * 6.2831853;
    float flip = abs(cos(t * uSpeed * (3.0 + 4.0 * r.w) + r.z * 30.0));
    float s = (6.0 + 5.0 * r.y) * U;
    size = vec2(s * 0.55, s * flip + 0.6 * U);
    heading = vec2(-sin(turn), cos(turn));
    alpha = 0.9;
    vColour = clamp(hueTurn(uColour, (r.w - 0.5) * 5.2), 0.0, 1.0);
    shape = 4.0;
  } else if (uKind < 10.5) {
    // fog: a few large soft banks sliding slowly
    float w = (0.55 + 0.5 * r.z) * uRegion.x;
    float h = (0.28 + 0.25 * r.w) * uRegion.y;
    centre = wrap(p0 + vec2((6.0 + 10.0 * r.y) * U * uSpeed * t, 0.0));
    size = vec2(w, h);
    alpha = 0.07 + 0.07 * r.x;
    shape = 6.0;
  } else {
    // rays: fixed shafts of light from above that breathe
    float breath = 0.55 + 0.45 * sin(t * (0.12 + 0.1 * r.y) * uSpeed * 6.2831853 + r.z * 30.0);
    float w = (0.05 + 0.1 * r.z) * uRegion.x;
    centre = wrap(vec2(p0.x, -0.2 * uRegion.y));
    size = vec2(w, 1.5 * uRegion.y);
    heading = normalize(vec2(0.34, 1.0));
    alpha = (0.05 + 0.06 * r.w) * breath;
    shape = 7.0;
  }

  // Weather in front of flowing text keeps a share of its particles over the text, so it never makes words hard to read.
  if (uKeep < 1.0 && centre.x > uFlow.x && centre.x < uFlow.z && centre.y > uFlow.y && centre.y < uFlow.w && hash11(i * 0.713 + uSeed * 31.7) > uKeep) alpha = 0.0;

  // Nothing is drawn thinner than a pixel.
  vec4 viewPosition = modelViewMatrix * vec4(centre, 0.0, 1.0);
  float ppu = conduitPixelsPerUnit(viewPosition);
  size = max(size, vec2(1.2 / max(ppu, 1e-4)));
  size *= vec2(uThin);

  vec2 corner = position.xy * size;
  vec2 across = vec2(heading.y, -heading.x);
  vec2 offset = across * corner.x + heading * corner.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(centre + offset, 0.0, 1.0);
  vQuad = position.xy;
  vShape = shape;
  vAlpha = alpha;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform float uOpacity;
varying vec2 vQuad;
varying float vShape;
varying float vAlpha;
varying vec3 vColour;
varying float vPhase;
${HASH}
${NOISE}

void main() {
  vec2 q = vQuad;
  float a;
  if (vShape < 0.5) {
    a = (1.0 - smoothstep(0.25, 0.5, abs(q.x))) * smoothstep(-0.5, 0.35, q.y);
  } else if (vShape < 1.5) {
    a = 1.0 - smoothstep(0.28, 0.5, length(q));
  } else if (vShape < 2.5) {
    float r = length(q) * 2.0;
    a = smoothstep(0.72, 0.86, r) * (1.0 - smoothstep(0.93, 1.0, r));
    a += 0.6 * (1.0 - smoothstep(0.0, 0.17, length(q - vec2(-0.2, -0.2))));
  } else if (vShape < 3.5) {
    a = 1.0 - smoothstep(-0.06, 0.1, abs(q.x * 2.0) - (1.0 - 4.0 * q.y * q.y));
  } else if (vShape < 4.5) {
    a = 1.0 - smoothstep(0.4, 0.5, max(abs(q.x), abs(q.y)));
  } else if (vShape < 5.5) {
    float d = dot(q, q);
    a = exp(-d * 30.0) + 0.5 * exp(-d * 160.0);
  } else if (vShape < 6.5) {
    float bank = 1.0 - smoothstep(0.0, 0.5, length(q * vec2(1.0, 1.5)));
    a = bank * (0.35 + 1.1 * fbm(q * 3.0 + vPhase));
  } else {
    a = (1.0 - smoothstep(0.08, 0.5, abs(q.x))) * (1.0 - smoothstep(-0.5, 0.5, q.y));
  }
  a *= vAlpha * uOpacity;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(vColour, min(a, 1.0));
}
`;

interface Entry {
  readonly kind: AmbientKind;
  readonly layer: Layer;
  geometry: InstancedBufferGeometry;
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  seen: boolean;
}

const FLIP = new Matrix4().set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

export function createFieldPool(): FieldPool {
  const entries = new Map<string, Entry>();
  const corners = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const quadIndex = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const make = (field: FieldFrame): Entry => {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(corners, 3));
    geometry.setIndex(new BufferAttribute(quadIndex, 1));
    const material = new ShaderMaterial({
      uniforms: {
        uKind: { value: KIND[field.field] },
        uTime: { value: 0 },
        uSeed: { value: 0 },
        uUnit: { value: 1 },
        uSpeed: { value: 1 },
        uThin: { value: 1 },
        uRegion: { value: new Vector2(1, 1) },
        uCentre: { value: new Vector2(0, 0) },
        uFlow: { value: new Vector4(0, 0, 0, 0) },
        uKeep: { value: 1 },
        uColour: { value: new Color() },
        uOpacity: { value: 1 },
        uViewPx: VIEW_PX,
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
    mesh.matrix.copy(FLIP);
    // The shadow a foreground casts is the foreground's things, not its weather.
    mesh.layers.set(1);
    return { kind: field.field, layer: field.layer, geometry, mesh, material, seen: true };
  };

  const release = (entry: Entry): void => {
    entry.mesh.removeFromParent();
    entry.geometry.dispose();
    entry.material.dispose();
  };

  return {
    sync(groups, fields, viewport, quality, reducedMotion, camera, style) {
      for (const entry of entries.values()) entry.seen = false;
      for (const field of fields) {
        let entry = entries.get(field.key);
        if (entry === undefined || entry.kind !== field.field || entry.layer !== field.layer) {
          if (entry !== undefined) release(entry);
          entry = make(field);
          entries.set(field.key, entry);
        }
        entry.seen = true;
        const root = groups[field.layer];
        if (entry.mesh.parent !== root) root.add(entry.mesh);

        const feel = LAYER_FEEL[field.layer];
        const bounds = planeBounds(field.layer, viewport);
        const screen = (viewport.width * viewport.height) / (1440 * 900);
        const fixed = FIXED_COUNT.has(field.field);
        const margin2 = MARGIN * MARGIN;
        const wanted = fixed
          ? COUNT[field.field]
          : Math.ceil(COUNT[field.field] * Math.max(0, field.density) * Math.min(1.6, Math.max(0.25, screen)) * margin2 * (quality === 'lite' ? 0.5 : 1));
        const count = field.density > 0 && wanted > 0 ? wanted : 0;
        entry.geometry.instanceCount = count;
        entry.mesh.visible = count > 0 && field.opacity > 0.002;
        entry.mesh.renderOrder = renderOrderOf(field.layer, 'field');

        const u = entry.material.uniforms;
        const set = (name: string, value: number): void => {
          const slot = u[name];
          if (slot !== undefined) slot.value = value;
        };
        const unit = ((viewport.height / 900) / planeScale(field.layer, viewport)) * feel.size;
        set('uTime', field.time * (reducedMotion ? 0.2 : 1));
        set('uSeed', (Math.abs(field.seed) % 9973) / 9973);
        set('uUnit', unit);
        set('uSpeed', feel.speed);
        set('uThin', 1);
        const plane = planeScale(field.layer, viewport);
        (u['uFlow']?.value as Vector4).set(field.flow.x / plane, field.flow.y / plane, (field.flow.x + field.flow.width) / plane, (field.flow.y + field.flow.height) / plane);
        set('uKeep', field.layer === 'fg' ? FG_KEEP_OVER_TEXT : 1);
        (u['uRegion']?.value as Vector2).set(bounds.width * MARGIN, bounds.height * MARGIN);
        (u['uCentre']?.value as Vector2).set(camera?.x ?? 0, camera?.y ?? 0);
        const colour = style === undefined ? new Color(field.colour) : inkColour(style, field.colour);
        (u['uColour']?.value as Color).copy(colour);
        // A few big soft things carry their weight in their opacity: thinner at light, heavier at heavy.
        set('uOpacity', field.opacity * feel.alpha * (fixed ? Math.min(1.5, field.density * 2) : 1));
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
