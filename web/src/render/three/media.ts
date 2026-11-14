// The first half of a procedural painting: the sketch's own figures, drawn into a surface of their own.
// The picture pool then passes that surface through the medium's shader (`medium-glsl.ts`). Nothing is fetched and
// nothing is invented: a medium only re-renders what the brain drew.
//
// The surface is in the picture's own box units, so the painting is fixed to the picture and nothing shimmers when
// the camera moves. It is drawn once, as the finished sketch (every stroke fully drawn, every figure fully opaque:
// the painter fades the sketch under `develop`, and the painting must not fade with it), and again only when the
// sketch changes.

import type { Medium } from '@conduit/language';
import { PROCEDURAL_MEDIA } from '@conduit/language';
import { Color, Group, LinearFilter, OrthographicCamera, Scene, WebGLRenderTarget } from 'three';
import type { Texture, WebGLRenderer } from 'three';
import type { Affine, FigureFrame, PictureFrame, ShapeFrame } from '../../contracts/frame';
import type { LookSpec } from '../../contracts/look';
import { planeScale } from '../../contracts/space';
import type { Viewport } from '../../contracts/space';
import { createShapePool } from './shapes';
import type { ShapePool } from './shapes';
import { VIEW_PX, flatSpec, styleOf } from './style';

export interface Sketch {
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
}

export interface SketchPass {
  /**
   * Makes sure every picture that names a procedural medium has its sketch drawn, and returns the surface of each by
   * the picture's key. A picture whose sketch has no figures in this frame (or whose medium the renderer does not
   * draw) is left out.
   */
  update(gl: WebGLRenderer, pictures: readonly PictureFrame[], figures: readonly FigureFrame[], spec: LookSpec, viewport: Viewport): ReadonlyMap<string, Sketch>;
  dispose(): void;
}

interface Entry {
  readonly root: Group;
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  readonly pool: ShapePool;
  target: WebGLRenderTarget | null;
  signature: string;
  seen: boolean;
}

const MIN_SIDE = 64;
const MAX_SIDE = 1024;
const STEP = 32;

export function isProcedural(medium: Medium | undefined): medium is Medium {
  return medium !== undefined && PROCEDURAL_MEDIA.includes(medium);
}

function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** `outer` after `inner`. */
function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

function signatureOf(picture: PictureFrame, shapes: readonly ShapeFrame[], width: number, height: number): string {
  const parts: string[] = [`${width}x${height}`, `${picture.box.x},${picture.box.y},${picture.box.width},${picture.box.height}`, Object.values(picture.transform).join(',')];
  for (const s of shapes) {
    const f = s.fill;
    const k = s.stroke;
    parts.push(
      `${s.key}|${s.geometryKey}|${f === null ? '-' : `${f.colour}${f.to ?? ''}${f.opacity}${f.texture ?? ''}`}|${k === null ? '-' : `${k.colour}${k.width}${k.character}`}|${s.soft ?? 0}|${s.z}|${Object.values(s.transform).join(',')}`,
    );
  }
  return parts.join(';');
}

export function createSketchPass(): SketchPass {
  const entries = new Map<string, Entry>();
  const result = new Map<string, Sketch>();

  const make = (): Entry => {
    const root = new Group();
    const scene = new Scene();
    scene.add(root);
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0, 0, 10);
    return { root, scene, camera, pool: createShapePool(), target: null, signature: '', seen: true };
  };

  const release = (entry: Entry): void => {
    entry.pool.dispose();
    entry.target?.dispose();
    entry.scene.clear();
  };

  return {
    update(gl, pictures, figures, spec, viewport) {
      result.clear();
      for (const entry of entries.values()) entry.seen = false;
      const wanted = pictures.filter((picture) => isProcedural(picture.medium) && picture.sketch !== undefined && picture.sketch.length > 0);
      if (wanted.length > 0) {
        const byKey = new Map<string, ShapeFrame>();
        for (const figure of figures) if (figure.kind === 'shape') byKey.set(figure.key, figure);
        const style = styleOf(flatSpec(spec), 'full');
        for (const picture of wanted) {
          const shapes = (picture.sketch ?? []).map((key) => byKey.get(key)).filter((shape): shape is ShapeFrame => shape !== undefined);
          if (shapes.length === 0) continue;
          let entry = entries.get(picture.key);
          if (entry === undefined) {
            entry = make();
            entries.set(picture.key, entry);
          }
          entry.seen = true;

          // About one texel per device pixel at rest, in steps so a small change of size does not redraw it.
          const scale = Math.sqrt(Math.abs(picture.transform.a * picture.transform.d - picture.transform.b * picture.transform.c)) * planeScale(picture.layer, viewport) * viewport.dpr;
          const longBox = Math.max(picture.box.width, picture.box.height, 1e-6);
          const long = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round((longBox * Math.max(scale, 1e-3)) / STEP) * STEP));
          const width = Math.max(8, Math.round((picture.box.width / longBox) * long));
          const height = Math.max(8, Math.round((picture.box.height / longBox) * long));
          const signature = signatureOf(picture, shapes, width, height);

          if (entry.target === null || entry.target.width !== width || entry.target.height !== height) {
            entry.target?.dispose();
            entry.target = new WebGLRenderTarget(width, height, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
            entry.signature = '';
          }
          if (entry.signature !== signature) {
            const inverse = invert(picture.transform);
            // The sketch is drawn in the picture's own box units, where a plane-space frame means nothing: the picture's own `clip` frames the painting.
            const frozen: ShapeFrame[] = shapes.map(({ clip: _plane, ...shape }) => ({
              ...shape,
              transform: compose(inverse, shape.transform),
              opacity: 1,
              bleed: false,
              stroke: shape.stroke === null ? null : { ...shape.stroke, progress: 1 },
            }));
            const groups = { far: entry.root, bg: entry.root, mid: entry.root, fg: entry.root };
            entry.pool.sync(groups, frozen, flatSpec(spec), viewport, style);
            const { box } = picture;
            // Box units are y down and the scene is y up (the pool folds the flip into its matrices).
            entry.camera.left = box.x;
            entry.camera.right = box.x + box.width;
            entry.camera.top = -box.y;
            entry.camera.bottom = -(box.y + box.height);
            entry.camera.updateProjectionMatrix();
            entry.camera.updateMatrixWorld(true);

            const previousTarget = gl.getRenderTarget();
            const previousViewPx = VIEW_PX.value.clone();
            const clear = gl.getClearColor(new Color());
            const clearAlpha = gl.getClearAlpha();
            VIEW_PX.value.set(width, height);
            gl.setRenderTarget(entry.target);
            gl.setClearColor(0x000000, 0);
            gl.clear(true, false, false);
            gl.render(entry.scene, entry.camera);
            gl.setRenderTarget(previousTarget);
            gl.setClearColor(clear, clearAlpha);
            VIEW_PX.value.copy(previousViewPx);
            entry.signature = signature;
          }
          result.set(picture.key, { texture: entry.target.texture, width, height });
        }
      }
      for (const [key, entry] of entries) {
        if (!entry.seen) {
          release(entry);
          entries.delete(key);
        }
      }
      return result;
    },
    dispose() {
      for (const entry of entries.values()) release(entry);
      entries.clear();
      result.clear();
    },
  };
}
