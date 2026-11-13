import { Color, Vector2, Vector3 } from 'three';
import type { ShaderMaterial, WebGLRenderTarget } from 'three';
import type { Effect } from '.';
import { HASH } from '../glsl';
import { fullscreenMaterial, setUniform, setVec2 } from './tools';
import type { FxShared } from './shared';

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform vec2 uSize;
uniform vec3 uGround;
uniform vec3 uInks[4];
uniform float uPitch;
uniform float uAmount;
varying vec2 vUv;
${HASH}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 picture = texture2D(tIn, vUv).rgb;
  vec3 ground = uGround;
  // The tone of this pixel as a share of one ink laid on the ground: the closest of the look's inks, else its own ink.
  float tone = 0.0;
  vec3 ink = picture;
  float best = 1e9;
  for (int k = 0; k < 4; k++) {
    vec3 d = uInks[k] - ground;
    float dd = dot(d, d);
    if (dd > 1e-4) {
      float a = clamp(dot(picture - ground, d) / dd, 0.0, 1.2);
      vec3 r = picture - (ground + a * d);
      float residual = dot(r, r);
      if (residual < best) {
        best = residual;
        tone = a;
        ink = uInks[k];
      }
    }
  }
  if (best > 0.006) {
    float density = clamp(1.0 - luma(picture) / max(luma(ground), 1e-3), 0.0, 1.0);
    float a = clamp(density / 0.85, 0.0, 1.0);
    tone = a;
    ink = a > 0.02 ? clamp(ground + (picture - ground) / a, 0.0, 1.0) : picture;
  }
  tone = clamp(tone, 0.0, 1.0);

  // Only flat tone becomes dots: an anti-aliased edge of something solid is left as it is.
  float flatness = 1.0 - smoothstep(0.06, 0.16, fwidth(tone));
  // The paper's own tooth and the lamp's falloff are a few percent of tone: they stay paper.
  float inTone = smoothstep(0.1, 0.17, tone) * (1.0 - smoothstep(0.93, 0.985, tone));

  vec2 frag = vUv * uSize;
  float c = 0.70710678;
  vec2 q = vec2(frag.x * c - frag.y * c, frag.x * c + frag.y * c) / uPitch;
  float r = length(fract(q) - 0.5);
  float radius = sqrt(tone / 3.14159265);
  float aa = 0.75 / uPitch;
  float dotMask = 1.0 - smoothstep(radius - aa, radius + aa, r);
  vec3 dots = mix(ground, ink, dotMask);

  gl_FragColor = vec4(mix(picture, dots, flatness * inTone * uAmount), 1.0);
}
`;

/** Every tone between the ground and an ink becomes dots at 45 degrees, 6 px apart; solid ink stays solid. */
export function createHalftone(shared: FxShared): Effect {
  let material: ShaderMaterial | null = null;
  const inks: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const ground = new Vector3();
  const colour = new Color();

  return {
    name: 'halftone',
    apply(tools, _stage, _frame, amount, _quality, input, output) {
      material ??= fullscreenMaterial(FRAGMENT, {
        tIn: { value: null },
        uSize: { value: new Vector2(1, 1) },
        uGround: { value: ground },
        uInks: { value: inks },
        uPitch: { value: 6 },
        uAmount: { value: 1 },
      });
      const { roles } = shared.style.spec;
      [roles.ink, roles.accent, roles.alt, roles.dim].forEach((hex, index) => {
        colour.set(hex);
        inks[index]?.set(colour.r, colour.g, colour.b);
      });
      ground.set(shared.style.ground.r, shared.style.ground.g, shared.style.ground.b);
      setUniform(material, 'tIn', (input as WebGLRenderTarget).texture);
      setVec2(material, 'uSize', tools.width, tools.height);
      setUniform(material, 'uPitch', 6 * tools.pixelRatio);
      setUniform(material, 'uAmount', amount);
      tools.pass(material, output as WebGLRenderTarget | null);
    },
    dispose() {
      material?.dispose();
    },
  };
}
