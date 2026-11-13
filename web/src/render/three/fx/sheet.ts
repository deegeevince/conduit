// The look's surface: a plane in the scene on the reading plane, so it moves
// correctly under the camera. Green bars with tractor holes and a perforation,
// a fibre tooth, drafting squares: whichever of the three the look lists.

import { Color, Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import type { WebGLRenderTarget } from 'three';
import type { Frame } from '../../../contracts/frame';
import { HASH, NOISE } from '../glsl';
import { ORDER } from '../stage';
import type { StageGraph } from '../stage';
import { luminance } from '../style';
import type { FxTools } from './tools';
import type { FxShared } from './shared';

const VERTEX = /* glsl */ `
varying vec2 vPlane;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPlane = vec2(world.x, -world.y);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uPaper;
uniform vec3 uBar;
uniform vec3 uGridColour;
uniform float uBars;
uniform float uTooth;
uniform float uGrid;
uniform float uGridUnit;
uniform vec2 uGridOrigin;
uniform float uPitch;
uniform float uTop;
uniform vec2 uHalf;
uniform float uStrip;
uniform float uHoles;
uniform vec3 uBacking;
varying vec2 vPlane;
${HASH}
${NOISE}

float gridLines(vec2 g, float width) {
  vec2 fw = max(fwidth(g), vec2(1e-5));
  vec2 d = abs(fract(g - 0.5) - 0.5) / fw;
  vec2 line = 1.0 - smoothstep(width - 0.75, width + 0.75, d);
  float dense = 1.0 - smoothstep(0.18, 0.4, max(fw.x, fw.y));
  return max(line.x, line.y) * dense;
}

void main() {
  vec3 col = uPaper;
  float px = max(fwidth(vPlane.y), 1e-4);

  if (uBars > 0.0) {
    float bar = uPitch * 3.0;
    float d = (vPlane.y - uTop) / bar;
    float t = fract(d * 0.5);
    float s = t < 0.5 ? min(t, 0.5 - t) : -min(t - 0.5, 1.0 - t);
    float w = fwidth(d * 0.5) * 0.75 + 1e-5;
    float green = smoothstep(-w, w, s);
    col = mix(uPaper, mix(uPaper, uBar, green), uBars);

    // The page break: a perforation every 66 lines, dashed.
    float page = uPitch * 66.0;
    float pd = vPlane.y - uTop;
    float edge = abs(pd - floor(pd / page + 0.5) * page);
    float dash = step(0.5, fract(vPlane.x / (uPitch * 0.5)));
    float perf = (1.0 - smoothstep(px * 0.5, px * 1.5, edge - px * 0.5)) * (0.35 + 0.65 * dash);
    col *= 1.0 - 0.1 * perf * uBars;

    if (uHoles > 0.5) {
      float side = vPlane.x < 0.0 ? -1.0 : 1.0;
      float inner = side * (uHalf.x - uStrip);
      float tear = abs(vPlane.x - inner);
      float tearDash = step(0.5, fract(pd / (uPitch * 0.4)));
      col *= 1.0 - 0.07 * uBars * (1.0 - smoothstep(px * 0.5, px * 1.5, tear)) * (0.4 + 0.6 * tearDash);

      float cx = side * (uHalf.x - uStrip * 0.5);
      float cy = (floor(d) + 0.5) * bar + uTop;
      float r = uPitch * 0.36;
      float dist = length(vec2(vPlane.x - cx, vPlane.y - cy));
      float hole = 1.0 - smoothstep(r - px, r + px, dist);
      float rim = smoothstep(r - px * 2.0, r, dist) * (1.0 - smoothstep(r, r + px * 2.5, dist));
      col = mix(col, uBacking, hole * uBars);
      col *= 1.0 - 0.06 * rim * uBars;
    }
  }

  if (uTooth > 0.0) {
    // Paper tooth: short fibres lying every which way over a soft mottle, fading out where they are finer than a pixel.
    float fade = 1.0 - smoothstep(0.35, 0.8, px);
    vec2 cell = floor(vPlane / 5.0);
    float angle = hash21(cell) * 6.2831853;
    vec2 local = fract(vPlane / 5.0) - 0.5;
    float along = dot(local, vec2(cos(angle), sin(angle)));
    float across = dot(local, vec2(-sin(angle), cos(angle)));
    float fibre = (1.0 - smoothstep(0.0, 0.09, abs(across))) * (1.0 - smoothstep(0.1, 0.45, abs(along))) * (hash21(cell + 7.0) - 0.4);
    float tooth = (vnoise(vPlane * 0.8) - 0.5) * 0.045 + (vnoise(vPlane * 0.21 + 17.0) - 0.5) * 0.03 + fibre * 0.05;
    col *= 1.0 + tooth * uTooth * fade;
  }

  if (uGrid > 0.0) {
    vec2 g = (vPlane - uGridOrigin) / uGridUnit;
    float minor = gridLines(g, 0.5);
    float major = gridLines(g / 5.0, 0.8);
    col = mix(col, uGridColour, clamp(minor * 0.5 + major * 0.5, 0.0, 1.0) * uGrid);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/** How far above the sheet the foreground floats, as a share of the viewport height; also the shadow's throw. */
export const LIFT = 0.32;

export interface Sheet {
  attach(stage: StageGraph): void;
  /** Draws the sheet to a target, or reuses the picture if nothing it depends on has moved. */
  draw(tools: FxTools, stage: StageGraph, frame: Frame, shared: FxShared): WebGLRenderTarget;
  detach(): void;
  reset(): void;
  dispose(): void;
}

export function createSheet(): Sheet {
  const geometry = new PlaneGeometry(1, 1);
  const material = new ShaderMaterial({
    uniforms: {
      uPaper: { value: new Color() },
      uBar: { value: new Color() },
      uGridColour: { value: new Color() },
      uBars: { value: 0 },
      uTooth: { value: 0 },
      uGrid: { value: 0 },
      uGridUnit: { value: 10 },
      uGridOrigin: { value: new Vector2(0, 0) },
      uPitch: { value: 20 },
      uTop: { value: 0 },
      uHalf: { value: new Vector2(100, 100) },
      uStrip: { value: 40 },
      uHoles: { value: 0 },
      uBacking: { value: new Color('#8f8b80') },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = ORDER.furniture;
  let parent: StageGraph | null = null;
  let drawn: WebGLRenderTarget | null = null;
  let drawnKey = '';
  const lighter = new Color();

  const set = (name: string, value: number): void => {
    const slot = material.uniforms[name];
    if (slot !== undefined) slot.value = value;
  };

  return {
    attach(stage) {
      if (parent === stage) return;
      parent?.surface.remove(mesh);
      stage.surface.add(mesh);
      parent = stage;
    },
    detach() {
      parent?.surface.remove(mesh);
      parent = null;
    },
    reset() {
      drawn = null;
    },
    draw(tools, stage, frame, shared) {
      const { viewport } = tools;
      const { spec, ground } = shared.style;
      const pitch = frame.bodySize * spec.type.lineHeight;
      const strip = Math.min(frame.margin * 0.9, 48);
      const unit = frame.canvas.unit * 10;

      mesh.scale.set(viewport.width * 8, viewport.height * 8, 1);
      (material.uniforms['uPaper']?.value as Color).copy(ground);
      (material.uniforms['uBar']?.value as Color).set(spec.groundAlt ?? spec.roles.ground);
      // The ground's lighter neighbour on a dark board, its darker one on paper.
      lighter.copy(ground);
      if (luminance(ground) < 0.5) lighter.lerp(new Color(1, 1, 1), 0.3);
      else lighter.lerp(new Color(0, 0, 0), 0.22);
      (material.uniforms['uGridColour']?.value as Color).copy(lighter);
      set('uBars', shared.sheet.bars);
      set('uTooth', shared.sheet.paper);
      set('uGrid', shared.sheet.grid);
      set('uGridUnit', unit);
      (material.uniforms['uGridOrigin']?.value as Vector2).set(frame.canvas.box.x, frame.canvas.box.y);
      set('uPitch', pitch);
      set('uTop', frame.gridTop);
      (material.uniforms['uHalf']?.value as Vector2).set(viewport.width / 2, viewport.height / 2);
      set('uStrip', strip);
      set('uHoles', viewport.width >= 600 && shared.sheet.bars > 0 ? 1 : 0);

      // The sheet depends only on the camera, the grid and the screen, so a page at rest keeps its picture instead of redrawing it each frame.
      const target = tools.target('sheet', {});
      const key = [
        ground.getHex(),
        spec.groundAlt,
        shared.sheet.bars,
        shared.sheet.paper,
        shared.sheet.grid,
        viewport.width,
        viewport.height,
        tools.width,
        tools.height,
        pitch,
        frame.gridTop,
        strip,
        unit,
        frame.canvas.box.x,
        frame.canvas.box.y,
        ...stage.camera.matrixWorld.elements,
        ...stage.camera.projectionMatrix.elements,
      ].join('|');
      if (target !== drawn || key !== drawnKey) {
        tools.drawStage(stage.scene, stage.camera, target, { layers: ['surface'], clear: `#${ground.getHexString()}` });
        drawn = target;
        drawnKey = key;
      }
      return target;
    },
    dispose() {
      parent?.surface.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
