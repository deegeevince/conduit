import type { Layer } from '@conduit/language';
import { Color, Group, Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import type { Object3D } from 'three';
import type { CursorFrame, ElementFrame } from '../../contracts/frame';
import { FACES } from '../../fonts/faces';
import { BAYER4 } from './glsl';
import { ORDER, placeElement, renderOrderOf } from './stage';
import { inkColour } from './style';
import type { SurfaceStyle } from './style';
import { baselineRatio, xHeightRatio } from './text';

/** Everything on stage that is not a glyph: plates, underlines, boxes, inverted bars, strike-throughs and the cursor. */
export interface MarkPool {
  /** `gridUnit` is the size of one pixel of a coarse raster in stage units, so rules there are a whole number of pixels thick; `ambient` paces the waiting dots. */
  sync(roots: Readonly<Record<Layer, Object3D>>, elements: readonly ElementFrame[], cursor: CursorFrame | null, style: SurfaceStyle, gridUnit: number, ambient: number): void;
  dispose(): void;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Kind = 'rect' | 'disc' | 'plate';

interface Slot {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
}

interface Entry {
  readonly group: Group;
  readonly slots: Slot[];
  used: number;
  root: Object3D | null;
  seen: boolean;
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uOpacity;
uniform float uKind;
uniform float uDither;
uniform vec2 uBox;
uniform float uFeather;
varying vec2 vUv;
${BAYER4}
void main() {
  vec2 p = (vUv - 0.5) * uBox;
  float alpha = uOpacity;
  if (uKind > 1.5) {
    // A plate: the ground colour behind a line of text, soft at its edge.
    vec2 q = abs(p) - uBox * 0.5;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    alpha *= smoothstep(0.0, uFeather, -d);
  } else if (uKind > 0.5) {
    float r = 0.5 * min(uBox.x, uBox.y);
    float d = length(p) - r;
    alpha *= 1.0 - smoothstep(-uFeather, 0.0, d);
  }
  if (uDither > 0.5) {
    if (alpha <= conduitBayer(gl_FragCoord.xy)) discard;
    gl_FragColor = vec4(uColour, 1.0);
  } else {
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(uColour, alpha);
  }
}
`;

let sharedGeometry: PlaneGeometry | null = null;

function geometry(): PlaneGeometry {
  sharedGeometry ??= new PlaneGeometry(1, 1);
  return sharedGeometry;
}

export function createMarkPool(): MarkPool {
  const entries = new Map<string, Entry>();
  const cursorEntry: Entry = { group: new Group(), slots: [], used: 0, root: null, seen: true };
  let activeKey: string | null = null;

  const makeSlot = (): Slot => {
    const material = new ShaderMaterial({
      uniforms: {
        uColour: { value: new Color() },
        uOpacity: { value: 1 },
        uKind: { value: 0 },
        uDither: { value: 0 },
        uBox: { value: new Vector2(1, 1) },
        uFeather: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry(), material);
    mesh.frustumCulled = false;
    return { mesh, material };
  };

  const begin = (entry: Entry): void => {
    entry.used = 0;
  };

  const put = (entry: Entry, style: SurfaceStyle, rect: Rect, colour: string, opacity: number, order: number, kind: Kind = 'rect', feather = 1): void => {
    if (rect.width <= 0 || rect.height <= 0 || opacity <= 0.002) return;
    let slot = entry.slots[entry.used];
    if (slot === undefined) {
      slot = makeSlot();
      entry.slots.push(slot);
      entry.group.add(slot.mesh);
    }
    entry.used++;
    slot.mesh.visible = true;
    slot.mesh.position.set(rect.x + rect.width / 2, -(rect.y + rect.height / 2), 0);
    slot.mesh.scale.set(rect.width, rect.height, 1);
    slot.mesh.renderOrder = order;
    const u = slot.material.uniforms;
    (u['uColour']?.value as Color).copy(inkColour(style, colour));
    (u['uBox']?.value as Vector2).set(rect.width, rect.height);
    const set = (name: string, value: number): void => {
      const uniform = u[name];
      if (uniform !== undefined) uniform.value = value;
    };
    set('uOpacity', opacity);
    set('uKind', kind === 'rect' ? 0 : kind === 'disc' ? 1 : 2);
    set('uDither', style.hard ? 1 : 0);
    set('uFeather', feather);
  };

  const finish = (entry: Entry): void => {
    for (let i = entry.used; i < entry.slots.length; i++) {
      const slot = entry.slots[i];
      if (slot !== undefined) slot.mesh.visible = false;
    }
  };

  const drop = (entry: Entry): void => {
    entry.group.removeFromParent();
    for (const slot of entry.slots) slot.material.dispose();
  };

  const clear = (): void => {
    for (const entry of entries.values()) drop(entry);
    entries.clear();
    drop(cursorEntry);
    cursorEntry.slots.length = 0;
    cursorEntry.group.clear();
    cursorEntry.root = null;
  };

  const build = (entry: Entry, element: ElementFrame, style: SurfaceStyle, gridUnit: number): void => {
    const thick = (wanted: number): number => (style.hard ? Math.max(1, Math.round(wanted / gridUnit)) * gridUnit : Math.max(wanted, 1));
    const face = FACES[element.face];
    const em = element.fontSize;
    const cell = face.advance * em * element.stretch;
    const base = baselineRatio(element.face) * em;
    const plateOrder = renderOrderOf(element.layer, 'plate', element.z);
    const barOrder = renderOrderOf(element.layer, 'bar', element.z);
    const markOrder = renderOrderOf(element.layer, 'mark', element.z);
    const lines = element.lines;
    if (lines.length === 0) return;

    if (element.plate > 0.01 && !style.hard) {
      const pad = em * 0.35;
      const feather = em * 0.3;
      for (const line of lines) {
        put(entry, style, { x: line.x - pad, y: line.y - pad * 0.6, width: line.width + pad * 2, height: line.height + pad * 1.2 }, style.spec.roles.ground, element.plate * element.opacity, plateOrder, 'plate', feather);
      }
    }

    if (element.mark === 'invert') {
      for (const line of lines) {
        const padX = style.hard ? cell / 2 : em * 0.2;
        const padY = style.hard ? line.height / 2 : em * 0.04;
        put(entry, style, { x: line.x - padX, y: line.y - padY, width: line.width + padX * 2, height: line.height + padY * 2 }, element.markColour, element.opacity, barOrder);
      }
    } else if (element.mark === 'underline') {
      for (const line of lines) {
        put(entry, style, { x: line.x, y: line.y + base + em * 0.05, width: line.width, height: thick(em * 0.08) }, element.markColour, element.opacity, markOrder);
      }
    } else if (element.mark === 'box') {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const line of lines) {
        minX = Math.min(minX, line.x);
        minY = Math.min(minY, line.y);
        maxX = Math.max(maxX, line.x + line.width);
        maxY = Math.max(maxY, line.y + line.height);
      }
      // Wide but never tall: stacked choices touch edge to edge, so a box that grew past its own line would strike through its neighbours.
      const pad = em * 0.3;
      const inset = em * 0.04;
      const t = thick(em * 0.07);
      const x0 = minX - pad;
      const y0 = minY + inset;
      const w = maxX - minX + pad * 2;
      const h = maxY - minY - inset * 2;
      put(entry, style, { x: x0, y: y0, width: w, height: t }, element.markColour, element.opacity, markOrder);
      put(entry, style, { x: x0, y: y0 + h - t, width: w, height: t }, element.markColour, element.opacity, markOrder);
      put(entry, style, { x: x0, y: y0 + t, width: t, height: h - 2 * t }, element.markColour, element.opacity, markOrder);
      put(entry, style, { x: x0 + w - t, y: y0 + t, width: t, height: h - 2 * t }, element.markColour, element.opacity, markOrder);
    }

    // `strike` governs whatever the mark is (frame.ts); a line written with mark=strike is always whole.
    const reach = element.mark === 'strike' ? 1 : Math.min(1, element.strike);
    if (reach > 0) {
      const ink = element.runs[0]?.colour ?? element.markColour;
      let remaining = lines.reduce((sum, line) => sum + line.width, 0) * reach;
      for (const line of lines) {
        const length = Math.min(line.width, remaining);
        remaining -= length;
        if (length <= 0) break;
        put(entry, style, { x: line.x, y: line.y + base - xHeightRatio(element.face) * em * 0.5 - em * 0.035, width: length, height: thick(em * 0.07) }, ink, element.opacity, markOrder);
      }
    }
  };

  const drawCursor = (cursor: CursorFrame, style: SurfaceStyle, ambient: number): void => {
    const order = renderOrderOf(cursor.layer, 'cursor', ORDER.zLimit);
    const { x, y, width, height, colour } = cursor;
    switch (cursor.shape) {
      case 'block':
        if (cursor.lit) put(cursorEntry, style, { x, y, width, height }, colour, 1, order);
        break;
      case 'bar': {
        const w = Math.max(2, height * 0.09);
        if (cursor.lit) put(cursorEntry, style, { x, y, width: w, height }, colour, 1, order);
        break;
      }
      case 'head': {
        // The print head: a small solid marker under the line, resting and blinking at the start of the next one.
        const h = Math.max(2, height * 0.16);
        if (cursor.lit) put(cursorEntry, style, { x, y: y + height - h, width, height: h }, colour, 1, order);
        break;
      }
      case 'dots': {
        // Three soft dots that swell in turn, at the place the next thing will appear.
        const size = Math.max(4, height * 0.5);
        const step = size * 1.15;
        for (let i = 0; i < 3; i++) {
          const swell = 0.5 + 0.5 * Math.sin(ambient * 4.2 - i * 1.15);
          const d = size * (0.42 + 0.58 * swell * swell);
          const cx = x + size * 0.6 + i * step;
          put(cursorEntry, style, { x: cx - d / 2, y: y + height / 2 - d / 2, width: d, height: d }, colour, 0.35 + 0.65 * swell, order, 'disc', Math.min(1, d * 0.3));
        }
        break;
      }
    }
  };

  return {
    sync(roots, elements, cursor, style, gridUnit, ambient) {
      const key = `${style.hard ? 'h' : 'n'}`;
      if (activeKey !== key) {
        clear();
        activeKey = key;
      }
      for (const entry of entries.values()) entry.seen = false;
      for (const element of elements) {
        let entry = entries.get(element.key);
        if (entry === undefined) {
          entry = { group: new Group(), slots: [], used: 0, root: null, seen: true };
          entries.set(element.key, entry);
        }
        entry.seen = true;
        const root = roots[element.layer];
        if (entry.root !== root) {
          root.add(entry.group);
          entry.root = root;
        }
        placeElement(entry.group, element);
        begin(entry);
        build(entry, element, style, gridUnit);
        finish(entry);
      }
      for (const [elementKey, entry] of entries) {
        if (!entry.seen) {
          drop(entry);
          entries.delete(elementKey);
        }
      }

      begin(cursorEntry);
      if (cursor !== null) {
        const root = roots[cursor.layer];
        if (cursorEntry.root !== root) {
          root.add(cursorEntry.group);
          cursorEntry.root = root;
        }
        drawCursor(cursor, style, ambient);
      }
      finish(cursorEntry);
    },
    dispose() {
      clear();
    },
  };
}
