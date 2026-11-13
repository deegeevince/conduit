import { Vector2, Vector3 } from 'three';
import type { ShaderMaterial, WebGLRenderTarget } from 'three';
import type { Effect } from '.';
import { createBlurrer, fullscreenMaterial, setUniform, setVec2 } from './tools';
import type { FxShared } from './shared';

const EXTRACT = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform vec2 uStep;
uniform vec3 uGround;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tIn, vUv + uStep * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tIn, vUv + uStep * vec2(0.5, -0.5)).rgb;
  c += texture2D(tIn, vUv + uStep * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tIn, vUv + uStep * vec2(0.5, 0.5)).rgb;
  gl_FragColor = vec4(max(c * 0.25 - uGround, 0.0), 1.0);
}
`;

const COMBINE = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform sampler2D tSmall;
uniform sampler2D tWide;
uniform float uSmall;
uniform float uWide;
varying vec2 vUv;
void main() {
  vec3 picture = texture2D(tIn, vUv).rgb;
  vec3 halo = texture2D(tSmall, vUv).rgb * uSmall + texture2D(tWide, vUv).rgb * uWide;
  gl_FragColor = vec4(min(picture + halo, 1.0), 1.0);
}
`;

/**
 * Bright things bleed into their surroundings: a small blur of what is lighter than the ground is added back
 * at low strength, plus a wider, fainter one. Never enough to close up a counter.
 */
export function createGlow(shared: FxShared): Effect {
  const blurrer = createBlurrer();
  let extract: ShaderMaterial | null = null;
  let combine: ShaderMaterial | null = null;
  const ground = new Vector3();

  return {
    name: 'glow',
    apply(tools, _stage, _frame, amount, _quality, input, output) {
      extract ??= fullscreenMaterial(EXTRACT, { tIn: { value: null }, uStep: { value: new Vector2() }, uGround: { value: ground } });
      combine ??= fullscreenMaterial(COMBINE, { tIn: { value: null }, tSmall: { value: null }, tWide: { value: null }, uSmall: { value: 0 }, uWide: { value: 0 } });
      const source = input as WebGLRenderTarget;
      const half = tools.target('halo-source', { scale: 0.5, half: true });
      ground.set(shared.style.ground.r, shared.style.ground.g, shared.style.ground.b);
      setUniform(extract, 'tIn', source.texture);
      setVec2(extract, 'uStep', 1 / source.width, 1 / source.height);
      tools.pass(extract, half);
      const smallScratch = tools.target('halo-small-scratch', { scale: 0.5, half: true });
      const small = tools.target('halo-small', { scale: 0.5, half: true });
      blurrer.blur(tools, half.texture, smallScratch, small, 1.4);
      const wideA = tools.target('halo-wide-a', { scale: 0.25, half: true });
      blurrer.down(tools, small.texture, small.width, small.height, wideA);
      const wideScratch = tools.target('halo-wide-scratch', { scale: 0.25, half: true });
      const wide = tools.target('halo-wide', { scale: 0.25, half: true });
      blurrer.blur(tools, wideA.texture, wideScratch, wide, 2.2);
      setUniform(combine, 'tIn', source.texture);
      setUniform(combine, 'tSmall', small.texture);
      setUniform(combine, 'tWide', wide.texture);
      setUniform(combine, 'uSmall', 0.33 * amount);
      setUniform(combine, 'uWide', 0.25 * amount);
      tools.pass(combine, output as WebGLRenderTarget | null);
    },
    dispose() {
      blurrer.dispose();
      extract?.dispose();
      combine?.dispose();
    },
  };
}
