import { Vector3 } from 'three';
import type { ShaderMaterial, WebGLRenderTarget } from 'three';
import type { Effect } from '.';
import { fullscreenMaterial, setUniform } from './tools';
import type { FxShared } from './shared';

/** Persistence time constant of the amber phosphor at amount 1, seconds. */
const TAU = 0.12;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tNow;
uniform sampler2D tPrev;
uniform vec3 uGround;
uniform float uDecay;
uniform float uLight;
varying vec2 vUv;
void main() {
  vec3 now = texture2D(tNow, vUv).rgb;
  vec3 held = uGround + (texture2D(tPrev, vUv).rgb - uGround) * uDecay;
  // Light on dark keeps the brighter of the two; ink on a light ground keeps the darker, or the ink would be erased.
  gl_FragColor = vec4(mix(max(now, held), min(now, held), uLight), 1.0);
}
`;

/**
 * A feedback buffer holds the previous picture, decaying toward the ground with
 * a time constant of about 120 ms (`decay = exp(-dt / tau)`, frame-rate
 * independent), combined with the new picture by maximum.
 */
export function createPersistence(shared: FxShared): Effect {
  let material: ShaderMaterial | null = null;
  let last: number | null = null;
  let pair: readonly [WebGLRenderTarget, WebGLRenderTarget] | null = null;
  const ground = new Vector3();

  return {
    name: 'persistence',
    destination(tools) {
      pair = tools.feedback('persistence');
      return pair[1];
    },
    apply(tools, _stage, frame, amount, _quality, input) {
      material ??= fullscreenMaterial(FRAGMENT, { tNow: { value: null }, tPrev: { value: null }, uGround: { value: ground }, uDecay: { value: 0 }, uLight: { value: 0 } });
      const dt = last === null ? 0 : frame.ambient - last;
      last = frame.ambient;
      const decay = frame.reducedMotion || dt < 0 ? 0 : Math.exp(-Math.min(dt, 5) / (TAU * amount));
      if (pair === null) return;
      const [previous, target] = pair;
      ground.set(shared.style.ground.r, shared.style.ground.g, shared.style.ground.b);
      setUniform(material, 'tNow', (input as WebGLRenderTarget).texture);
      setUniform(material, 'tPrev', previous.texture);
      setUniform(material, 'uDecay', decay);
      setUniform(material, 'uLight', 0.2126 * ground.x + 0.7152 * ground.y + 0.0722 * ground.z > 0.5 ? 1 : 0);
      tools.pass(material, target);
    },
    reset(tools) {
      tools.clearFeedback('persistence');
      last = null;
    },
    dispose() {
      material?.dispose();
    },
  };
}
