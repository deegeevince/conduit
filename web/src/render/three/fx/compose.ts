// Lays the stage on the surface it belongs to: the sheet (or the flat ground),
// the shadows things throw on it, the dust left on it, and the mood's dimming.
// Ink either covers (light on a dark ground, ordinary paint) or multiplies
// onto the paper, which is why it can never be lighter than the paper.

import { Color, Vector2, Vector3 } from 'three';
import type { ShaderMaterial, WebGLRenderTarget } from 'three';
import type { Frame } from '../../../contracts/frame';
import { HASH, NOISE } from '../glsl';
import { fullscreenMaterial, setUniform, setVec2 } from './tools';
import type { FxTools } from './tools';
import type { FxShared } from './shared';

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tStage;
uniform sampler2D tSheet;
uniform sampler2D tShadow;
uniform sampler2D tDust;
uniform vec3 uGround;
uniform vec3 uDustColour;
uniform float uHasSheet;
uniform float uShadow;
uniform float uDust;
uniform float uMultiply;
uniform float uLamp;
uniform float uDim;
uniform float uCell;
uniform vec2 uSize;
uniform vec2 uGridSize;
varying vec2 vUv;
${HASH}
${NOISE}

float level(vec3 c) { return dot(c, vec3(0.3, 0.5, 0.2)); }

vec4 stageAt() {
  if (uCell > 0.5) {
    float i = floor(gl_FragCoord.x / uCell);
    float j = floor((uSize.y - gl_FragCoord.y) / uCell);
    return texture2D(tStage, vec2(i + 0.5, uGridSize.y - 1.0 - j + 0.5) / uGridSize);
  }
  return texture2D(tStage, vUv);
}

void main() {
  vec4 s = stageAt();
  vec3 base = uHasSheet > 0.5 ? texture2D(tSheet, vUv).rgb : uGround;
  if (uShadow > 0.0) base *= 1.0 - uShadow * texture2D(tShadow, vUv).a;
  if (uDust > 0.0) {
    vec2 d = texture2D(tDust, vUv).rg;
    float haze = clamp(d.r - d.g, 0.0, 1.0);
    float smear = 0.45 + 1.1 * fbm(vec2(gl_FragCoord.x * 0.011, gl_FragCoord.y * 0.034));
    base = mix(base, uDustColour, clamp(haze * 1.6, 0.0, 1.0) * uDust * 0.5 * smear);
  }
  vec2 p = vUv * 2.0 - 1.0;
  float lamp = 1.0 - uLamp * dot(p, p) * 0.5;
  vec3 col;
  if (uMultiply > 0.5) {
    // The lamp's falloff and the mood's dim darken the paper, and dark print on darker paper loses contrast. The
    // ink therefore takes the same darkening again, in proportion to how much ink there is (none on bare paper).
    vec3 ink = min(s.rgb + (1.0 - s.a), vec3(1.0));
    float glass = lamp * (1.0 - uDim * 0.35);
    float inked = clamp(1.0 - level(ink), 0.0, 1.0);
    col = base * ink * glass * pow(glass, 1.3 * inked);
  } else {
    float glass = lamp * (1.0 - uDim * 0.6);
    vec3 paint = s.a > 0.002 ? s.rgb / s.a : vec3(0.0);
    float lp = level(paint);
    float lg = level(base);
    float keep = lp > lg ? smoothstep(0.40, 0.85, lp) : 1.0;
    col = base * (1.0 - s.a) * glass + s.rgb * mix(1.0, glass, keep);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface ComposeInputs {
  readonly stage: WebGLRenderTarget;
  readonly sheet: WebGLRenderTarget | null;
  readonly shadow: WebGLRenderTarget | null;
  readonly dust: WebGLRenderTarget | null;
}

export interface Compose {
  draw(tools: FxTools, shared: FxShared, frame: Frame, inputs: ComposeInputs, output: WebGLRenderTarget | null): void;
  dispose(): void;
}

export function createCompose(): Compose {
  let material: ShaderMaterial | null = null;
  const ground = new Vector3();
  const dustColour = new Vector3();
  const colour = new Color();

  return {
    draw(tools, shared, frame, inputs, output) {
      material ??= fullscreenMaterial(FRAGMENT, {
        tStage: { value: null },
        tSheet: { value: null },
        tShadow: { value: null },
        tDust: { value: null },
        uGround: { value: ground },
        uDustColour: { value: dustColour },
        uHasSheet: { value: 0 },
        uShadow: { value: 0 },
        uDust: { value: 0 },
        uMultiply: { value: 0 },
        uLamp: { value: 0 },
        uDim: { value: 0 },
        uCell: { value: 0 },
        uSize: { value: new Vector2(1, 1) },
        uGridSize: { value: new Vector2(1, 1) },
      });
      const style = shared.style;
      ground.set(style.ground.r, style.ground.g, style.ground.b);
      colour.set(style.spec.roles.ink).lerp(style.ground, 0.4);
      dustColour.set(colour.r, colour.g, colour.b);
      setUniform(material, 'tStage', inputs.stage.texture);
      setUniform(material, 'tSheet', inputs.sheet?.texture ?? null);
      setUniform(material, 'tShadow', inputs.shadow?.texture ?? null);
      setUniform(material, 'tDust', inputs.dust?.texture ?? null);
      setUniform(material, 'uHasSheet', inputs.sheet === null ? 0 : 1);
      setUniform(material, 'uShadow', inputs.shadow === null ? 0 : 0.38 * shared.shadow);
      setUniform(material, 'uDust', inputs.dust === null ? 0 : shared.dust);
      setUniform(material, 'uMultiply', style.multiply ? 1 : 0);
      setUniform(material, 'uLamp', 0.117 * shared.sheet.paper);
      // A coarse raster dims by dropping bright pixels to the half level (see dither), never by blending.
      setUniform(material, 'uDim', shared.cell > 0 ? 0 : frame.dim);
      setUniform(material, 'uCell', shared.cell);
      setVec2(material, 'uSize', tools.width, tools.height);
      setVec2(material, 'uGridSize', inputs.stage.width, inputs.stage.height);
      tools.pass(material, output);
    },
    dispose() {
      material?.dispose();
    },
  };
}
