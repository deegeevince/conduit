import { Color, Vector2, Vector3 } from 'three';
import type { ShaderMaterial, WebGLRenderTarget } from 'three';
import type { Effect } from '.';
import { BAYER4 } from '../glsl';
import { fullscreenMaterial, setUniform, setVec2 } from './tools';
import type { FxShared } from './shared';

const MAX = 24;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform vec2 uSize;
uniform vec3 uPalette[${MAX}];
uniform int uCount;
uniform float uCell;
uniform float uDim;
uniform float uAmount;
varying vec2 vUv;
${BAYER4}

void main() {
  vec3 picture = texture2D(tIn, vUv).rgb;
  vec2 frag = floor(vUv * uSize);
  vec2 unit = uCell > 0.5 ? floor(frag / uCell) : frag;

  float d1 = 1e9;
  float d2 = 1e9;
  vec3 c1 = picture;
  vec3 c2 = picture;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uCount) break;
    vec3 d = picture - uPalette[i];
    float dist = dot(d, d);
    if (dist < d1) {
      d2 = d1;
      c2 = c1;
      d1 = dist;
      c1 = uPalette[i];
    } else if (dist < d2) {
      d2 = dist;
      c2 = uPalette[i];
    }
  }
  float near = sqrt(d1);
  float second = sqrt(d2);
  vec3 cut = c1;
  if (near > 0.004) {
    float share = near / max(near + second, 1e-4);
    if (share > conduitBayer(unit)) cut = c2;
  }
  // The mood dims a bright level by dropping every few pixels of it to the half level, never by blending.
  if (uDim > 0.0 && uCell > 0.5 && min(cut.r, min(cut.g, cut.b)) > 0.99 && conduitBayer(unit) < uDim * 1.6) cut = vec3(0.498039);
  gl_FragColor = vec4(mix(picture, cut, uAmount), 1.0);
}
`;

function paletteOf(shared: FxShared): readonly string[] {
  const { spec } = shared.style;
  if (spec.gamut.kind === 'palette') return [spec.roles.ground, ...spec.gamut.colours];
  const roles = spec.roles;
  return [roles.ground, roles.ink, roles.dim, roles.accent, roles.alt, ...spec.sprite];
}

/** The picture is cut to the look's palette; anything between two members is an ordered 4x4 dither of the two nearest. */
export function createDither(shared: FxShared): Effect {
  let material: ShaderMaterial | null = null;
  const palette: Vector3[] = Array.from({ length: MAX }, () => new Vector3());
  const colour = new Color();
  let key = '';

  return {
    name: 'dither',
    apply(tools, _stage, frame, amount, _quality, input, output) {
      material ??= fullscreenMaterial(FRAGMENT, {
        tIn: { value: null },
        uSize: { value: new Vector2(1, 1) },
        uPalette: { value: palette },
        uCount: { value: 0 },
        uCell: { value: 0 },
        uDim: { value: 0 },
        uAmount: { value: 1 },
      });
      const colours = paletteOf(shared).slice(0, MAX);
      const next = colours.join(',');
      if (next !== key) {
        key = next;
        colours.forEach((hex, index) => {
          colour.set(hex);
          palette[index]?.set(colour.r, colour.g, colour.b);
        });
        setUniform(material, 'uCount', colours.length);
      }
      setUniform(material, 'tIn', (input as WebGLRenderTarget).texture);
      setVec2(material, 'uSize', tools.width, tools.height);
      setUniform(material, 'uCell', shared.cell);
      setUniform(material, 'uDim', frame.dim);
      setUniform(material, 'uAmount', amount);
      tools.pass(material, output as WebGLRenderTarget | null);
    },
    dispose() {
      material?.dispose();
    },
  };
}
