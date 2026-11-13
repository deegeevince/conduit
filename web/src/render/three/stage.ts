import type { Layer } from '@conduit/language';
import { Group, PerspectiveCamera, Scene } from 'three';
import type { ElementFrame } from '../../contracts/frame';
import { cameraRig, layerZ, restDistance } from '../../contracts/space';
import type { CameraPose, Viewport } from '../../contracts/space';

/**
 * The three.js scene: one group per layer at its depth, and the camera.
 * World units are stage units with y flipped, so one unit on the reading
 * plane is one CSS pixel when the camera is at rest.
 */
export interface StageGraph {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly layers: Readonly<Record<Layer, Group>>;
  /** things fixed to the screen, drawn with the resting camera: teletext's header row */
  readonly furniture: Group;
  /** the look's surface in the scene, on the reading plane, so it moves under the camera: paper, fanfold, a drafting grid */
  readonly surface: Group;
  resize(viewport: Viewport): void;
  /** Places the camera exactly where `cameraRig(pose, viewport)` says. */
  setCamera(pose: CameraPose): void;
  dispose(): void;
}

export const LAYER_ORDER: Readonly<Record<Layer, number>> = { far: 0, bg: 1, mid: 2, fg: 3 };

/**
 * One draw-order space for everything on the stage. A layer owns a band; inside it a field comes first, then
 * everything else by `z`, and within one `z` the plate, bar, fill, text, stroke, mark and cursor in that order.
 */
export const ORDER = { furniture: -100000, layerStep: 1000000, zBase: 100000, zStep: 8, zLimit: 9000 } as const;

export type Part = 'field' | 'plate' | 'bar' | 'fill' | 'text' | 'stroke' | 'mark' | 'cursor';

const PART: Readonly<Record<Part, number>> = { field: -1, plate: 0, bar: 1, fill: 2, text: 3, stroke: 4, mark: 5, cursor: 6 };

export function renderOrderOf(layer: Layer, part: Part, z = 0): number {
  const level = Math.max(-ORDER.zLimit, Math.min(ORDER.zLimit, Math.round(z)));
  if (part === 'field') return LAYER_ORDER[layer] * ORDER.layerStep;
  return LAYER_ORDER[layer] * ORDER.layerStep + ORDER.zBase + level * ORDER.zStep + PART[part];
}

export function createStageGraph(viewport: Viewport): StageGraph {
  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 1, 10);
  // Layer 1 holds weather: it is drawn with everything else but left out of the shadow things throw.
  camera.layers.enable(1);
  const furniture = new Group();
  furniture.name = 'furniture';
  const make = (layer: Layer): Group => {
    const group = new Group();
    group.name = layer;
    return group;
  };
  const surface = new Group();
  surface.name = 'surface';
  const layers: Record<Layer, Group> = { far: make('far'), bg: make('bg'), mid: make('mid'), fg: make('fg') };
  scene.add(surface, furniture, layers.far, layers.bg, layers.mid, layers.fg);

  let current = viewport;
  let pose: CameraPose = { x: 0, y: 0, dolly: 0, yaw: 0, pitch: 0, roll: 0 };

  const place = (): void => {
    for (const layer of ['far', 'bg', 'mid', 'fg'] as const) layers[layer].position.set(0, 0, layerZ(layer, current));
    const rest = restDistance(current);
    camera.aspect = current.width / current.height;
    camera.near = rest * 0.05;
    camera.far = rest * 8;
    const rig = cameraRig(pose, current);
    camera.fov = rig.fovYDegrees;
    camera.position.set(rig.position.x, -rig.position.y, rig.position.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(rig.target.x, -rig.target.y, rig.target.z);
    camera.rotateZ(rig.roll);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  place();

  return {
    scene,
    camera,
    layers,
    furniture,
    surface,
    resize(next) {
      current = next;
      place();
    },
    setCamera(next) {
      pose = next;
      place();
    },
    dispose() {
      scene.clear();
    },
  };
}

/** The element's own transform, shared by its text and its marks. Children are in the block's unscaled units, y up. */
export function placeElement(group: Group, element: ElementFrame): void {
  group.position.set(element.x, -element.y, 0);
  group.rotation.set(0, 0, -element.rotation);
  group.scale.set(element.scale, element.scale, 1);
}
