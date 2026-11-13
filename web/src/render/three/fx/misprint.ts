import { Color, Vector2, Vector3 } from 'three';
import type { ShaderMaterial, WebGLRenderTarget } from 'three';
import type { Effect } from '.';
import { fullscreenMaterial, setUniform, setVec2 } from './tools';
import type { FxShared } from './shared';

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform vec3 uGround;
uniform vec3 uAccent;
uniform vec2 uOffset;
uniform float uAmount;
varying vec2 vUv;

// x: the share of accent ink here; y: how exactly the pixel is just ground mixed with accent.
vec2 accentShare(vec3 picture) {
  vec3 d = uAccent - uGround;
  float dd = max(dot(d, d), 1e-4);
  float t = clamp(dot(picture - uGround, d) / dd, 0.0, 1.0);
  vec3 r = picture - (uGround + t * d);
  return vec2(t, 1.0 - smoothstep(0.0015, 0.012, dot(r, r)));
}

void main() {
  vec3 picture = texture2D(tIn, vUv).rgb;
  vec2 here = accentShare(picture);
  vec2 other = accentShare(texture2D(tIn, vUv - uOffset).rgb);
  float shifted = other.x * other.y;
  vec3 stripped = mix(picture, uGround, here.y * smoothstep(0.005, 0.03, here.x));
  vec3 laid;
  if (dot(uGround, vec3(0.3333)) > 0.5) {
    // Two inks on light paper multiply: where the accent overlaps something dark it is darker still.
    vec3 plate = clamp(uAccent / max(uGround, vec3(1e-3)), 0.0, 1.0);
    laid = stripped * mix(vec3(1.0), plate, shifted);
  } else {
    laid = mix(stripped, uAccent, shifted);
  }
  gl_FragColor = vec4(mix(picture, laid, uAmount), 1.0);
}
`;

/** The accent ink is laid 1.5 px out of register, and where it overlaps another ink it darkens. */
export function createMisprint(shared: FxShared): Effect {
  let material: ShaderMaterial | null = null;
  const ground = new Vector3();
  const accent = new Vector3();
  const colour = new Color();

  return {
    name: 'misprint',
    apply(tools, _stage, _frame, amount, _quality, input, output) {
      material ??= fullscreenMaterial(FRAGMENT, {
        tIn: { value: null },
        uGround: { value: ground },
        uAccent: { value: accent },
        uOffset: { value: new Vector2() },
        uAmount: { value: 1 },
      });
      colour.set(shared.style.spec.roles.accent);
      accent.set(colour.r, colour.g, colour.b);
      ground.set(shared.style.ground.r, shared.style.ground.g, shared.style.ground.b);
      const reach = 1.5 * tools.pixelRatio;
      setUniform(material, 'tIn', (input as WebGLRenderTarget).texture);
      setVec2(material, 'uOffset', reach / tools.width, -0.6 * reach / tools.height);
      setUniform(material, 'uAmount', amount);
      tools.pass(material, output as WebGLRenderTarget | null);
    },
    dispose() {
      material?.dispose();
    },
  };
}
