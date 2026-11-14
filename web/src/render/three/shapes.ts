// Drawn shapes on the stage graph. The only file that tessellates.

import type { Group } from 'three';
import type { Layer } from '@conduit/language';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix4, Mesh, ShaderMaterial, Sphere, Vector2, Vector3 } from 'three';
import type { Affine, ShapeFrame, StrokeFrame } from '../../contracts/frame';
import type { LookSpec } from '../../contracts/look';
import { planeBounds } from '../../contracts/space';
import type { Viewport } from '../../contracts/space';
import { HASH, NOISE, PIXEL_SCALE } from './glsl';
import { buildFill, buildStroke } from './shape-geometry';
import { renderOrderOf } from './stage';
import { VIEW_PX, inkColour } from './style';
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

// `ink` and `dry` are drawn as marker and chalk until the brush shaders exist (PLAN-v2.md, package R); the renderer does not advertise them until then.
const CHARACTER = { clean: 0, pencil: 1, marker: 2, chalk: 3, pixel: 4, ink: 2, dry: 3 } as const;

const STROKE_VERTEX = /* glsl */ `
attribute vec2 aOff;
attribute float aEdge;
attribute float aDist;
attribute float aTurn;
uniform float uHalf;
uniform float uThin;
uniform float uCharacter;
uniform float uLength;
${PIXEL_SCALE}
${HASH}
varying float vEdge;
varying float vDist;
varying float vHalfPx;
varying float vTurn;
varying float vPpu;
varying vec2 vShape;
varying float vLengthPx;

void main() {
  vec4 viewPosition = modelViewMatrix * vec4(position.xy, 0.0, 1.0);
  float ppu = conduitPixelsPerUnit(viewPosition);
  float half_ = uHalf * uThin;
  if (uCharacter > 0.5 && uCharacter < 1.5) {
    // Pencil: the weight wanders by about 15% along the line.
    float wander = hash11(floor(aDist * uLength * 0.35) + 3.0) - 0.5;
    half_ *= 1.0 + 0.3 * mix(wander, hash11(floor(aDist * uLength * 0.35) + 4.0) - 0.5, fract(aDist * uLength * 0.35));
  }
  if (uCharacter > 2.5 && uCharacter < 3.5) half_ *= 1.0 + 0.25 * aTurn;
  // A stroke is never thinner than 1.25 device pixels.
  float reach = max(half_, 0.625 / max(ppu, 1e-4));
  // A pixel stroke is cut by its own test, so its geometry reaches a pixel further out than the line does: multisampling then sees whole pixels or none.
  float spread = uCharacter > 3.5 ? reach + 1.0 / max(ppu, 1e-4) : reach;
  vec2 local = position.xy + aOff * spread;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 0.0, 1.0);
  vEdge = aEdge * spread / reach;
  vDist = aDist;
  vHalfPx = reach * ppu;
  vTurn = aTurn;
  vPpu = ppu;
  vShape = position.xy;
  vLengthPx = uLength * ppu;
}
`;

const STROKE_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uColour;
uniform float uOpacity;
uniform float uProgress;
uniform float uCharacter;
uniform float uHard;
varying float vEdge;
varying float vDist;
varying float vHalfPx;
varying float vTurn;
varying float vPpu;
varying vec2 vShape;
varying float vLengthPx;
${HASH}
${NOISE}

void main() {
  if (uProgress <= 0.0) discard;
  float distance_ = (1.0 - abs(vEdge)) * vHalfPx;
  vec2 grainAt = vShape * vPpu / 1.3;
  float coverage;
  if (uHard > 0.5 || uCharacter > 3.5) {
    coverage = distance_ > 0.0 ? 1.0 : 0.0;
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
  }
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColour, alpha);
}
`;

const FILL_VERTEX = /* glsl */ `
varying float vY;
void main() {
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
}
`;

const FILL_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uFrom;
uniform vec3 uTo;
uniform vec2 uSpan;
uniform float uOpacity;
varying float vY;
void main() {
  float t = uSpan.y > 1e-6 ? clamp((vY - uSpan.x) / uSpan.y, 0.0, 1.0) : 0.0;
  gl_FragColor = vec4(mix(uFrom, uTo, t), uOpacity);
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
        uViewPx: VIEW_PX,
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
      uniforms: { uFrom: { value: new Color() }, uTo: { value: new Color() }, uSpan: { value: new Vector2(0, 1) }, uOpacity: { value: 1 } },
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
        const buffers = buildFill(shape.outline);
        if (buffers !== null) {
          geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(buffers.position, 3));
          geometry.setIndex(new BufferAttribute(buffers.index, 1));
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
      const buffers = buildStroke(shape.outline);
      if (buffers !== null) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(buffers.position, 2));
        geometry.setAttribute('aOff', new BufferAttribute(buffers.offset, 2));
        geometry.setAttribute('aEdge', new BufferAttribute(buffers.edge, 1));
        geometry.setAttribute('aDist', new BufferAttribute(buffers.dist, 1));
        geometry.setAttribute('aTurn', new BufferAttribute(buffers.turn, 1));
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
          entry = { layer: shape.layer, geometryKey: '', built: '', fill: null, stroke: null, fillMaterial: null, strokeMaterial: null, length: 0, bleed: false, seen: true };
          entries.set(shape.key, entry);
        }
        entry.seen = true;
        const built = `${shape.geometryKey}|${shape.fill === null ? 0 : 1}${shape.stroke === null ? 0 : 1}${shape.bleed ? `|${viewport?.width}x${viewport?.height}` : ''}`;
        if (entry.built !== built) {
          rebuild(entry, shape, root, viewport);
          entry.built = built;
        }
        const fillOrder = renderOrderOf(shape.layer, 'fill', shape.z);
        const strokeOrder = renderOrderOf(shape.layer, 'stroke', shape.z);
        if (entry.fill !== null && entry.fillMaterial !== null && shape.fill !== null) {
          const material = entry.fillMaterial;
          const box = boxOf(shape);
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
