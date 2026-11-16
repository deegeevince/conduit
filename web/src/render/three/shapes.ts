// Drawn shapes on the stage graph. The only file that tessellates.

import type { Group } from 'three';
import type { Layer, StrokeCharacter, Texture as FillTexture } from '@conduit/language';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix4, Mesh, ShaderMaterial, Sphere, Vector2, Vector3, Vector4 } from 'three';
import type { Affine, ShapeFrame, StrokeFrame } from '../../contracts/frame';
import type { LookSpec } from '../../contracts/look';
import { planeBounds } from '../../contracts/space';
import type { Viewport } from '../../contracts/space';
import { CLIP_FRAGMENT_DECL, CLIP_TEST, CLIP_VERTEX_DECL, clipVertex, makeClipUniform, setClip } from './clip';
import { HASH, NOISE, PIXEL_SCALE } from './glsl';
import { buildFill, buildStroke } from './shape-geometry';
import { buildDistanceField } from './sdf';
import type { DistanceField } from './sdf';
import { renderOrderOf } from './stage';
import { VIEW_PX, hash01, inkColour } from './style';
import type { SurfaceStyle } from './style';

export interface ShapePool {
  /**
   * Brings the pool in line with a frame's shapes, keyed by `ShapeFrame.key`.
   *
   * - Geometry is rebuilt only when `geometryKey` changes: a fill is the
   *   outline triangulated (three's ShapeUtils), a stroke a ribbon along each
   *   polyline with mitred joins and round caps, carrying along every vertex
   *   its distance from the start of the outline as a share of the whole
   *   length. `stroke.progress` is then one uniform: fragments past it are
   *   discarded, so a line draws itself without a single vertex changing.
   * - The stroke's character is the fragment shader's business: `clean` is
   *   solid, `pencil` and `chalk` break up with a grain fixed in the shape's
   *   own space (it does not swim when the shape moves), `marker` is solid
   *   with a darker overlap at the joins, `pixel` is drawn without
   *   antialiasing.
   * - A gradient fill runs top to bottom of the shape's own box.
   * - `bleed` shapes are scaled to cover the plane's visible rectangle at the
   *   camera's widest pose.
   * - Draw order within a layer is `z`, interleaved with text and sprites.
   *
   * `viewport` and `style` are what the pool needs to cover a plane and to write ink the way the look stores it.
   */
  sync(groups: Readonly<Record<Layer, Group>>, shapes: readonly ShapeFrame[], look: LookSpec, viewport?: Viewport, style?: SurfaceStyle): void;
  dispose(): void;
}

/** The shader's number for each character. `pixel` is 4, `ink` 5, `dry` 6; the tests in the shaders are bands around these. */
const CHARACTER: Readonly<Record<StrokeCharacter, number>> = { clean: 0, pencil: 1, marker: 2, chalk: 3, pixel: 4, ink: 5, dry: 6 };

/** The shader's number for each fill texture. */
const TEXTURE: Readonly<Record<FillTexture, number>> = { flat: 0, wash: 1, hatch: 2, dots: 3, grain: 4, weave: 5 };

const STROKE_VERTEX = /* glsl */ `
attribute vec2 aOff;
attribute float aEdge;
attribute float aDist;
attribute float aTurn;
attribute vec3 aSub;
uniform float uPress[8];
uniform float uPressN;
uniform float uHalf;
uniform float uThin;
uniform float uCharacter;
uniform float uLength;
uniform float uSoft;
${PIXEL_SCALE}
${HASH}
${CLIP_VERTEX_DECL}
varying float vEdge;
varying float vDist;
varying float vHalfPx;
varying float vTurn;
varying float vPpu;
varying vec2 vShape;
varying float vLengthPx;
varying float vSoftPx;
varying vec3 vOwn;

// A stroke's width along it, as pressure: the stops are spread evenly over the stroke's own length.
float pressureAt(float t) {
  if (uPressN < 1.5) return 1.0;
  float f = clamp(t, 0.0, 1.0) * (uPressN - 1.0);
  float r = uPress[0];
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    if (fi < uPressN - 1.0 && f >= fi) r = mix(uPress[i], uPress[i + 1], clamp(f - fi, 0.0, 1.0));
  }
  return r;
}

void main() {
  vec4 viewPosition = modelViewMatrix * vec4(position.xy, 0.0, 1.0);
  float ppu = conduitPixelsPerUnit(viewPosition);
  float half_ = uHalf * uThin * pressureAt(aSub.x);
  if (uCharacter > 0.5 && uCharacter < 1.5) {
    // Pencil: the weight wanders by about 15% along the line.
    float wander = hash11(floor(aDist * uLength * 0.35) + 3.0) - 0.5;
    half_ *= 1.0 + 0.3 * mix(wander, hash11(floor(aDist * uLength * 0.35) + 4.0) - 0.5, fract(aDist * uLength * 0.35));
  }
  if (uCharacter > 2.5 && uCharacter < 3.5) half_ *= 1.0 + 0.25 * aTurn;
  // Ink is heavier on the inside of a turn; the fragment shader trims it back to the swell and taper.
  if (uCharacter > 4.5 && uCharacter < 5.5) half_ *= 1.0 + 0.22 * aTurn;
  // A stroke is never thinner than 1.25 device pixels.
  float reach = max(half_, 0.625 / max(ppu, 1e-4));
  // A pixel stroke is cut by its own test, so its geometry reaches a pixel further out than the line does: multisampling then sees whole pixels or none.
  float spread = (uCharacter > 3.5 && uCharacter < 4.5) ? reach + 1.0 / max(ppu, 1e-4) : reach;
  // A soft stroke fades out over its own length either side: the ribbon is as much wider as the fade is.
  spread += uSoft;
  vec2 local = position.xy + aOff * spread;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 0.0, 1.0);
  ${clipVertex('modelMatrix * vec4(local, 0.0, 1.0)')}
  vEdge = aEdge * spread / reach;
  vDist = aDist;
  vHalfPx = reach * ppu;
  vTurn = aTurn;
  vPpu = ppu;
  vShape = position.xy;
  vLengthPx = uLength * ppu;
  vOwn = vec3(aSub.x, aSub.y * ppu, aSub.z);
  vSoftPx = uSoft * ppu;
}
`;

const STROKE_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uColour;
uniform float uOpacity;
uniform float uProgress;
uniform float uCharacter;
uniform float uHard;
uniform float uSeed;
uniform vec3 uAlong[8];
uniform float uAlongN;
varying float vEdge;
varying float vDist;
varying float vHalfPx;
varying float vTurn;
varying float vPpu;
varying vec2 vShape;
varying float vLengthPx;
varying float vSoftPx;
varying vec3 vOwn;
${CLIP_FRAGMENT_DECL}

// The stroke's colour along it: the stops are spread evenly over the stroke's own length.
vec3 colourAt(float t) {
  if (uAlongN < 1.5) return uColour;
  float f = clamp(t, 0.0, 1.0) * (uAlongN - 1.0);
  vec3 c = uAlong[0];
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    if (fi < uAlongN - 1.0 && f >= fi) c = mix(uAlong[i], uAlong[i + 1], clamp(f - fi, 0.0, 1.0));
  }
  return c;
}
${HASH}
${NOISE}

void main() {
  ${CLIP_TEST}
  if (uProgress <= 0.0) discard;
  float across = abs(vEdge) * vHalfPx;
  float distance_ = vHalfPx - across;
  vec2 grainAt = vShape * vPpu / 1.3;
  float isPixel = (uCharacter > 3.5 && uCharacter < 4.5) ? 1.0 : 0.0;
  float isInk = (uCharacter > 4.5 && uCharacter < 5.5) ? 1.0 : 0.0;
  float isDry = uCharacter > 5.5 ? 1.0 : 0.0;
  // The brush works along the stroke's own length: each sub-path of a path is a stroke with a start and an end of its own.
  float own = vOwn.x;
  float ownPx = vOwn.y;
  float along = own * ownPx;

  if (isInk > 0.5) {
    // A brush pen: it starts thin, swells to its thickness and tapers; the width is a profile along the line, trimmed here.
    float swell = clamp(ownPx * 0.22, 2.0, 14.0 * vHalfPx);
    float rise = smoothstep(0.0, swell, along);
    float fall = smoothstep(0.0, swell * 1.6, ownPx - along);
    float profile = (0.16 + 0.84 * rise) * (0.12 + 0.88 * fall) * (0.94 + 0.12 * vnoise(vec2(along / 26.0, uSeed * 40.0 + vOwn.z * 3.1)));
    float wide = max(vHalfPx * profile, 0.625);
    distance_ = wide - across;
  }

  float coverage;
  if (uHard > 0.5 || isPixel > 0.5) {
    coverage = distance_ > 0.0 ? 1.0 : 0.0;
  } else if (vSoftPx > 0.0) {
    // soft=: the line fades out over its own length either side of where it would have ended.
    coverage = smoothstep(-vSoftPx, 0.5 * vSoftPx, distance_);
  } else {
    float ragged = uCharacter > 2.5 && uCharacter < 3.5 ? (hash21(floor(grainAt) + 5.0) - 0.5) * 0.9 : 0.0;
    coverage = clamp(distance_ + 0.5 + ragged, 0.0, 1.0);
  }
  float lead = uProgress >= 1.0 ? 1.0 : clamp((uProgress - vDist) * vLengthPx + 0.5, 0.0, 1.0);
  float alpha = coverage * lead * uOpacity;
  if (uCharacter > 0.5 && uCharacter < 1.5) {
    float n = 0.6 * vnoise(grainAt * 0.9) + 0.4 * hash21(floor(grainAt));
    alpha *= 0.55 + 0.45 * smoothstep(0.12, 0.8, n);
  } else if (uCharacter > 1.5 && uCharacter < 2.5) {
    alpha *= 0.88;
  } else if (uCharacter > 2.5 && uCharacter < 3.5) {
    float bank = vnoise(vShape * vPpu / 8.0);
    float skip = smoothstep(0.30 - 0.18 * vTurn, 0.47 - 0.18 * vTurn, bank);
    alpha *= skip * (0.5 + 0.5 * hash21(floor(grainAt) + 11.0));
  } else if (isInk > 0.5) {
    alpha *= 0.94;
  } else if (isDry > 0.5) {
    // A dry brush: the bristles are parallel streaks across the stroke, and each runs out at a point of its own; the longer the stroke, the sooner.
    float gate = clamp(ownPx / 160.0, 0.0, 1.0);
    float streaks = clamp(floor(vHalfPx * 1.6) + 4.0, 5.0, 11.0);
    float u = vEdge * 0.5 + 0.5;
    float k = floor(u * streaks);
    float inside = fract(u * streaks);
    float born = hash11(k + uSeed * 91.0 + vOwn.z * 13.7);
    float runs = 1.0 - gate * (0.1 + 0.5 * born);
    float jag = (vnoise(vec2(along / 9.0, k * 3.7 + vOwn.z * 17.0)) - 0.5) * 0.22;
    float alive = 1.0 - smoothstep(runs - 0.05, runs + 0.05, own + jag);
    float gap = gate * (0.02 + 0.1 * smoothstep(0.1, 1.0, own)) + 0.02;
    float bar = smoothstep(gap, gap + 0.06, inside) * smoothstep(gap, gap + 0.06, 1.0 - inside);
    float tooth = 0.72 + 0.28 * hash21(floor(grainAt) + 17.0);
    alpha *= alive * bar * tooth;
  }
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(colourAt(own), alpha);
}
`;

const FILL_VERTEX = /* glsl */ `
${PIXEL_SCALE}
${CLIP_VERTEX_DECL}
varying float vY;
varying vec2 vLocal;
varying float vPpu;
void main() {
  vY = position.y;
  vLocal = position.xy;
  vPpu = conduitPixelsPerUnit(modelViewMatrix * vec4(position.xy, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
  ${clipVertex('modelMatrix * vec4(position.xy, 0.0, 1.0)')}
}
`;

const FILL_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uFrom;
uniform vec3 uTo;
uniform vec2 uSpan;
uniform float uOpacity;
uniform float uTexture;
uniform float uPitch;
uniform float uSeed;
uniform float uSoft;
uniform float uWash;
uniform sampler2D tField;
uniform vec4 uFieldBox;
uniform float uFieldRange;
uniform float uHasField;
varying float vY;
varying vec2 vLocal;
varying float vPpu;
${CLIP_FRAGMENT_DECL}
${HASH}
${NOISE}

void main() {
  ${CLIP_TEST}
  float t = uSpan.y > 1e-6 ? clamp((vY - uSpan.x) / uSpan.y, 0.0, 1.0) : 0.0;
  vec3 colour = mix(uFrom, uTo, t);
  float alpha = uOpacity;

  // Distance to the outline, negative inside, in the shape's units.
  float d = 1e6;
  if (uHasField > 0.5) {
    vec2 uv = (vLocal - uFieldBox.xy) / uFieldBox.zw;
    d = (texture2D(tField, uv).r - 0.5) * 2.0 * uFieldRange;
  }
  if (uSoft > 0.0 && uHasField > 0.5) alpha *= 1.0 - smoothstep(-0.5 * uSoft, uSoft, d);

  // Never denser than a pen line a few pixels apart, whatever the camera does.
  float pitch = max(uPitch, 3.0 / max(vPpu, 1e-3));
  int kind = int(uTexture + 0.5);
  if (kind == 1) {
    // wash: pooled, darker at the edges, with the pigment settling unevenly into the paper
    float depth = uHasField > 0.5 ? clamp(-d / max(uWash, 1e-3), 0.0, 1.0) : 1.0;
    float rim = 1.0 - smoothstep(0.0, 1.0, depth);
    float pool = fbm(vLocal / max(uWash * 1.6, 1e-3) + uSeed * 9.0);
    float settle = hash21(floor(vLocal / max(0.55, 1.2 / vPpu)) + uSeed * 5.0);
    colour *= 1.0 - 0.3 * rim - 0.1 * (pool - 0.5);
    alpha *= clamp(0.7 + 0.3 * rim + 0.28 * (pool - 0.5) + 0.06 * (settle - 0.5), 0.0, 1.0);
  } else if (kind == 2) {
    // hatch: pen lines at 45 degrees, a stroke apart, each a little different
    float p = (vLocal.x + vLocal.y) * 0.70710678 / pitch;
    float id = floor(p);
    float f = p - id - 0.5;
    float half_ = 0.15 * (0.8 + 0.4 * hash11(id + uSeed * 57.0));
    float aa = max(fwidth(p), 1e-4);
    alpha *= 1.0 - smoothstep(half_ - aa, half_ + aa, abs(f));
  } else if (kind == 3) {
    // dots: a stipple, jittered, some left out
    vec2 g = vLocal / (pitch * 0.9);
    vec2 cell = floor(g);
    float aa = max(fwidth(g.x), 1e-4);
    float cover = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = cell + vec2(float(i), float(j));
        float present = step(0.14, hash21(c + uSeed * 31.0 + 1.7));
        vec2 centre = c + 0.22 + 0.56 * vec2(hash21(c + uSeed * 17.0), hash21(c.yx + 7.3 + uSeed * 13.0));
        float r = 0.15 + 0.12 * hash21(c + 3.3);
        cover = max(cover, present * (1.0 - smoothstep(r - aa, r + aa, length(g - centre))));
      }
    }
    alpha *= cover;
  } else if (kind == 4) {
    // grain: a dry chalk, broken
    vec2 q = vLocal / max(0.5, 1.2 / vPpu);
    float n = 0.55 * hash21(floor(q) + uSeed * 13.0) + 0.45 * vnoise(q * 0.3);
    alpha *= 0.28 + 0.72 * smoothstep(0.24, 0.72, n);
  } else if (kind == 5) {
    // weave: canvas under paint; threads pass over and under
    float cellSize = max(pitch * 1.3, 3.6 / max(vPpu, 1e-3));
    vec2 g = vLocal / cellSize;
    vec2 id = floor(g);
    vec2 f = fract(g);
    float over = mod(id.x + id.y, 2.0);
    float thread = over > 0.5 ? sin(f.x * 3.14159265) : sin(f.y * 3.14159265);
    float shade = mix(0.35, thread, 0.9);
    float knot = hash21(id + uSeed * 23.0);
    colour *= 0.78 + 0.24 * shade + 0.05 * (knot - 0.5);
  }
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(colour, alpha);
}
`;

interface Entry {
  readonly layer: Layer;
  geometryKey: string;
  /** what the meshes were built for, so a change of any of it rebuilds them */
  built: string;
  fill: Mesh | null;
  stroke: Mesh | null;
  fillMaterial: ShaderMaterial | null;
  strokeMaterial: ShaderMaterial | null;
  length: number;
  bleed: boolean;
  /** the outline's distance field, when the fill needs to know where its edge is (a wash, or a soft edge) */
  field: DistanceField | null;
  seen: boolean;
}

function matrixOf(affine: Affine, target: Matrix4): Matrix4 {
  // Stage space is y down and the scene is y up: the flip is folded into the matrix, so outlines stay in the shape's own units.
  return target.set(affine.a, affine.c, 0, affine.e, -affine.b, -affine.d, 0, -affine.f, 0, 0, 1, 0, 0, 0, 0, 1);
}

export function createShapePool(): ShapePool {
  const entries = new Map<string, Entry>();
  const scratch = new Matrix4();

  const makeStrokeMaterial = (): ShaderMaterial =>
    new ShaderMaterial({
      uniforms: {
        uColour: { value: new Color() },
        uOpacity: { value: 1 },
        uProgress: { value: 1 },
        uHalf: { value: 0.5 },
        uThin: { value: 1 },
        uCharacter: { value: 0 },
        uLength: { value: 1 },
        uHard: { value: 0 },
        uSoft: { value: 0 },
        uSeed: { value: 0 },
        uPress: { value: new Array<number>(8).fill(1) },
        uPressN: { value: 0 },
        uAlong: { value: Array.from({ length: 8 }, () => new Color()) },
        uAlongN: { value: 0 },
        uViewPx: VIEW_PX,
        uConduitClip: makeClipUniform(),
      },
      vertexShader: STROKE_VERTEX,
      fragmentShader: STROKE_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });

  const makeFillMaterial = (): ShaderMaterial =>
    new ShaderMaterial({
      uniforms: {
        uFrom: { value: new Color() },
        uTo: { value: new Color() },
        uSpan: { value: new Vector2(0, 1) },
        uOpacity: { value: 1 },
        uTexture: { value: 0 },
        uPitch: { value: 1 },
        uSeed: { value: 0 },
        uSoft: { value: 0 },
        uWash: { value: 1 },
        tField: { value: null },
        uFieldBox: { value: new Vector4(0, 0, 1, 1) },
        uFieldRange: { value: 1 },
        uHasField: { value: 0 },
        uViewPx: VIEW_PX,
        uConduitClip: makeClipUniform(),
      },
      vertexShader: FILL_VERTEX,
      fragmentShader: FILL_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });

  const release = (entry: Entry): void => {
    for (const mesh of [entry.fill, entry.stroke]) {
      if (mesh === null) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    entry.fillMaterial?.dispose();
    entry.strokeMaterial?.dispose();
    entry.field?.texture.dispose();
  };

  const rebuild = (entry: Entry, shape: ShapeFrame, root: Group, viewport: Viewport | undefined): void => {
    for (const mesh of [entry.fill, entry.stroke]) {
      if (mesh === null) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    entry.fill = null;
    entry.stroke = null;
    entry.length = 0;
    entry.bleed = shape.bleed;
    entry.field?.texture.dispose();
    entry.field = null;

    if (shape.fill !== null) {
      let geometry: BufferGeometry | null = null;
      if (shape.bleed && viewport !== undefined) {
        // `rect full`: far more than any camera move can uncover, in the layer's own units.
        const bounds = planeBounds(shape.layer, viewport);
        const reach = Math.max(bounds.width, bounds.height) * 3;
        geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array([-reach, -reach, 0, reach, -reach, 0, reach, reach, 0, -reach, reach, 0]), 3));
        geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
      } else {
        // A wash pools against its edge and a soft edge fades along it: both read the outline's distance field.
        const soft = shape.soft ?? 0;
        const wash = shape.fill.texture === 'wash';
        if (soft > 0 || wash) {
          const width = washWidth(shape);
          entry.field = buildDistanceField(shape.outline, Math.max(wash ? width : 0, soft * 1.5), 1);
        }
        if (entry.field !== null && soft > 0) {
          // The fill is as much wider as the edge fades: a quad over the field's box, cut by the field.
          const f = entry.field;
          geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(new Float32Array([f.x, f.y, 0, f.x + f.width, f.y, 0, f.x + f.width, f.y + f.height, 0, f.x, f.y + f.height, 0]), 3));
          geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
        } else {
          const buffers = buildFill(shape.outline);
          if (buffers !== null) {
            geometry = new BufferGeometry();
            geometry.setAttribute('position', new BufferAttribute(buffers.position, 3));
            geometry.setIndex(new BufferAttribute(buffers.index, 1));
          }
        }
      }
      if (geometry !== null) {
        entry.fillMaterial ??= makeFillMaterial();
        entry.fill = new Mesh(geometry, entry.fillMaterial);
        entry.fill.frustumCulled = false;
        entry.fill.matrixAutoUpdate = false;
        root.add(entry.fill);
      }
    }
    if (shape.stroke !== null && !shape.bleed) {
      // Dashes are pieces of one stroke; the sub-paths of a path are strokes of their own.
      const buffers = buildStroke(shape.strokeOutline ?? shape.outline, shape.strokeOutline !== undefined);
      if (buffers !== null) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(buffers.position, 2));
        geometry.setAttribute('aOff', new BufferAttribute(buffers.offset, 2));
        geometry.setAttribute('aEdge', new BufferAttribute(buffers.edge, 1));
        geometry.setAttribute('aDist', new BufferAttribute(buffers.dist, 1));
        geometry.setAttribute('aTurn', new BufferAttribute(buffers.turn, 1));
        geometry.setAttribute('aSub', new BufferAttribute(buffers.sub, 3));
        geometry.setIndex(new BufferAttribute(buffers.index, 1));
        // two-component positions have no z for three to bound; nothing here is culled, so any sphere will do
        geometry.boundingSphere = new Sphere(new Vector3(), 1e6);
        entry.strokeMaterial ??= makeStrokeMaterial();
        entry.stroke = new Mesh(geometry, entry.strokeMaterial);
        entry.stroke.frustumCulled = false;
        entry.stroke.matrixAutoUpdate = false;
        entry.length = buffers.length;
        root.add(entry.stroke);
      }
    }
  };

  const boxOf = (shape: ShapeFrame): { top: number; height: number } => {
    let top = Infinity;
    let bottom = -Infinity;
    for (const line of shape.outline) {
      for (const point of line.points) {
        top = Math.min(top, point.y);
        bottom = Math.max(bottom, point.y);
      }
    }
    return top === Infinity ? { top: 0, height: 0 } : { top, height: bottom - top };
  };

  /** How wide a wash pools at its edge: a fifth of the shape's shorter side, within what reads as a pooled edge. */
  const washWidth = (shape: ShapeFrame): number => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const line of shape.outline) {
      for (const point of line.points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }
    return minX === Infinity ? 1 : Math.max(0.6, Math.min(24, 0.2 * Math.min(maxX - minX, maxY - minY)));
  };

  const setFill = (material: ShaderMaterial, shape: ShapeFrame, entry: Entry, style: SurfaceStyle): void => {
    const set = (name: string, value: number): void => {
      const slot = material.uniforms[name];
      if (slot !== undefined) slot.value = value;
    };
    const texture = shape.fill?.texture ?? 'flat';
    set('uTexture', TEXTURE[texture]);
    // Pen lines and canvas threads sit a stroke apart: the shape's own stroke, or the look's when it has none.
    set('uPitch', Math.max(0.5, (shape.stroke?.width ?? style.spec.stroke.thick) * 2.2));
    set('uSeed', hash01(shape.key));
    set('uSoft', entry.field !== null ? (shape.soft ?? 0) : 0);
    set('uWash', washWidth(shape));
    const field = entry.field;
    const slot = material.uniforms['tField'];
    if (slot !== undefined) slot.value = field?.texture ?? null;
    set('uHasField', field === null ? 0 : 1);
    if (field !== null) {
      (material.uniforms['uFieldBox']?.value as Vector4).set(field.x, field.y, field.width, field.height);
      set('uFieldRange', field.range);
    }
  };

  const setStroke = (material: ShaderMaterial, shape: ShapeFrame, stroke: StrokeFrame, length: number, style: SurfaceStyle, layer: Layer): void => {
    (material.uniforms['uColour']?.value as Color).copy(inkColour(style, stroke.colour));
    const set = (name: string, value: number): void => {
      const slot = material.uniforms[name];
      if (slot !== undefined) slot.value = value;
    };
    set('uOpacity', shape.opacity);
    set('uProgress', Math.max(0, Math.min(1, stroke.progress)));
    set('uHalf', stroke.width / 2);
    set('uThin', layer === 'far' ? style.thin : 1);
    set('uCharacter', CHARACTER[stroke.character]);
    set('uLength', Math.max(length, 1e-6));
    set('uHard', style.hard ? 1 : 0);
    set('uSoft', shape.soft ?? 0);
    set('uSeed', hash01(shape.key));
    const press = stroke.pressure;
    const slots = (material.uniforms['uPress']?.value ?? []) as number[];
    const pressed = press === undefined || press.length < 2 ? 0 : Math.min(8, press.length);
    for (let i = 0; i < pressed; i += 1) slots[i] = press?.[i] ?? 1;
    set('uPressN', pressed);
    const colours = stroke.along;
    const graded = colours === undefined || colours.length < 2 ? 0 : Math.min(8, colours.length);
    const stops = (material.uniforms['uAlong']?.value ?? []) as Color[];
    for (let i = 0; i < graded; i += 1) stops[i]?.copy(inkColour(style, colours?.[i] ?? stroke.colour));
    set('uAlongN', graded);
  };

  return {
    sync(groups, shapes, _look, viewport, style) {
      if (style === undefined) return;
      for (const entry of entries.values()) entry.seen = false;
      for (const shape of shapes) {
        const root = groups[shape.layer];
        let entry = entries.get(shape.key);
        if (entry === undefined || entry.layer !== shape.layer) {
          if (entry !== undefined) release(entry);
          entry = { layer: shape.layer, geometryKey: '', built: '', fill: null, stroke: null, fillMaterial: null, strokeMaterial: null, length: 0, bleed: false, field: null, seen: true };
          entries.set(shape.key, entry);
        }
        entry.seen = true;
        const built = `${shape.geometryKey}|${shape.fill === null ? 0 : 1}${shape.stroke === null ? 0 : 1}|${shape.fill?.texture === 'wash' ? 'w' : ''}${shape.soft ?? 0}${shape.bleed ? `|${viewport?.width}x${viewport?.height}` : ''}`;
        if (entry.built !== built) {
          rebuild(entry, shape, root, viewport);
          entry.built = built;
        }
        const fillOrder = renderOrderOf(shape.layer, 'fill', shape.z);
        const strokeOrder = renderOrderOf(shape.layer, 'stroke', shape.z);
        if (entry.fill !== null && entry.fillMaterial !== null && shape.fill !== null) {
          const material = entry.fillMaterial;
          const box = shape.fill.span ?? boxOf(shape);
          (material.uniforms['uFrom']?.value as Color).copy(inkColour(style, shape.fill.colour));
          (material.uniforms['uTo']?.value as Color).copy(inkColour(style, shape.fill.to ?? shape.fill.colour));
          const span = material.uniforms['uSpan']?.value as Vector2;
          if (shape.bleed) {
            // A bleeding fill is in stage units on its plane: its gradient runs over the box the shape would have had.
            const top = shape.transform.d * box.top + shape.transform.f;
            const bottom = shape.transform.d * (box.top + box.height) + shape.transform.f;
            span.set(top, bottom - top);
          } else {
            span.set(box.top, box.height);
          }
          const opacity = material.uniforms['uOpacity'];
          if (opacity !== undefined) opacity.value = shape.fill.opacity * shape.opacity;
          setFill(material, shape, entry, style);
          setClip(material.uniforms['uConduitClip'], shape.bleed ? undefined : shape.clip);
          entry.fill.renderOrder = fillOrder;
          entry.fill.visible = shape.fill.opacity * shape.opacity > 0.002;
          if (shape.bleed) {
            // Plane units, not the shape's own: the quad is built there already.
            entry.fill.matrix.set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
          } else {
            matrixOf(shape.transform, entry.fill.matrix);
          }
          entry.fill.matrixWorldNeedsUpdate = true;
        }
        if (entry.stroke !== null && entry.strokeMaterial !== null && shape.stroke !== null) {
          setStroke(entry.strokeMaterial, shape, shape.stroke, entry.length, style, shape.layer);
          setClip(entry.strokeMaterial.uniforms['uConduitClip'], shape.clip);
          entry.stroke.renderOrder = strokeOrder;
          entry.stroke.visible = shape.opacity > 0.002 && shape.stroke.progress > 0;
          matrixOf(shape.transform, scratch);
          entry.stroke.matrix.copy(scratch);
          entry.stroke.matrixWorldNeedsUpdate = true;
        }
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
