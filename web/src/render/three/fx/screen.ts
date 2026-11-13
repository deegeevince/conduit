// The treatments of the picture as light, in one pass over it: the raster of
// scanlines, the nervousness of the signal, grain, the fall-off at the corners
// and the curve of the glass. One pass because they all resample or weigh the
// same pixel; each effect only says how strongly.

import { Vector2, Vector3 } from 'three';
import type { ShaderMaterial, WebGLRenderTarget } from 'three';
import type { Frame } from '../../../contracts/frame';
import { HASH } from '../glsl';
import { CURVE } from './curve';
import { fullscreenMaterial, setUniform, setVec2 } from './tools';
import type { FxTools } from './tools';
import type { FxShared } from './shared';

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tPicture;
uniform vec3 uGround;
uniform vec2 uSize;
uniform float uPixelRatio;
uniform float uTime;
uniform float uAgitation;
uniform float uScanPeriod;
uniform float uScan;
uniform float uSignal;
uniform float uGrain;
uniform float uVignette;
uniform float uCurve;
uniform float uNoHalo;
uniform float uCell;
uniform float uStatic;
varying vec2 vUv;
${HASH}

float level(vec3 c) { return dot(c, vec3(0.3, 0.5, 0.2)); }

vec3 cellColour(float i, float j) {
  return texture2D(tPicture, vec2((i + 0.5) * uCell, uSize.y - (j + 0.5) * uCell) / uSize).rgb;
}

// Snow is rare, so it needs a hash that stays uniform far down in the tail.
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float snowHash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + ivec2(32768));
  return float(pcg(q.x + pcg(q.y))) * (1.0 / 4294967296.0);
}

bool isGround(vec3 c) { return dot(c - uGround, c - uGround) < 0.0004; }

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = vUv * 2.0 - 1.0;
  vec2 q = p * (1.0 + ${CURVE} * uCurve * dot(p, p));
  float mask = 1.0;
  if (uCurve > 0.01) {
    vec2 half_ = uSize * 0.5;
    float radius = 0.035 * min(uSize.x, uSize.y) * uCurve;
    vec2 d = abs(q * half_) - (half_ - radius);
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
    mask = 1.0 - smoothstep(-0.5, 1.0, dist);
  }
  vec2 s = q * 0.5 + 0.5;

  float ag = uAgitation * uSignal;
  float tick = floor(uTime * 20.0);
  if (uSignal > 0.0 && uCell < 0.5 && ag > 0.0) {
    float band = floor(frag.y / max(uScanPeriod, 3.0 * uPixelRatio));
    float pick = hash21(vec2(band, tick));
    float jitter = (hash21(vec2(band + 91.0, tick)) - 0.5) * 2.0;
    s.x += step(0.72, pick) * jitter * (2.0 * ag * uPixelRatio) / uSize.x;
  }

  vec3 picture = texture2D(tPicture, s).rgb;

  if (uSignal > 0.0 && uCell > 0.5) {
    // The picture is a grid of whole cells: at rest it is clean, and a nervous signal smears colour one cell to the right of saturated edges and sprinkles snow.
    float teletick = floor(uTime * 12.5);
    float nerve = max(uAgitation - 0.15, 0.0) * 1.4 * uSignal;
    if (nerve > 0.0) {
      float i = floor(frag.x / uCell);
      float j = floor((uSize.y - frag.y) / uCell);
      vec3 left = i > 0.0 ? cellColour(i - 1.0, j) : uGround;
      float saturated = max(max(left.r, left.g), left.b) - min(min(left.r, left.g), left.b);
      float smearRow = step(snowHash(vec2(j * 1.37, teletick + 0.5)), nerve * nerve * 0.8);
      if (isGround(picture) && !isGround(left) && saturated > 0.5 && smearRow > 0.5) picture = left;
      if (snowHash(vec2(i, j) + teletick * vec2(7.0, 13.0)) < nerve * nerve * 0.004) picture = vec3(1.0);
    }
  }

  // The glass (scanlines, the corners, the mood) darkens the ground fully but ink only as far as its surplus
  // contrast allows: ink near the painter's floor must not lose contrast to it. "keep" is 0 for the dimmest
  // light ink (the floor) and 1 for ink bright enough to have contrast to spare; dark ink on a light ground
  // darkens with it. Without halation the dimmest ink is lifted a tenth to pay for what thin strokes lose between scanlines.
  float lp = level(picture);
  float lg = level(uGround);
  float keep = lp > lg ? smoothstep(0.40, 0.85, lp) : 1.0;

  float scanGround = 1.0;
  float scanInk = 1.0;
  if (uScanPeriod > 0.0 && uScan > 0.0) {
    float phase = mod(frag.y, uScanPeriod) / uScanPeriod;
    float line = 0.5 + 0.5 * cos(6.2831853 * (phase - 0.5));
    float depth = 0.3 * (1.0 - 0.6 * clamp(lp, 0.0, 1.0));
    scanGround = 1.0 - 0.3 * uScan * (1.0 - line);
    scanInk = 1.0 - depth * uScan * mix(0.3, 1.0, keep) * (1.0 - line);
  }

  float edge = pow(dot(p, p) * 0.5, 1.5);
  float glass = (1.0 - 0.3 * edge * uCurve) * (1.0 - 0.35 * edge * uVignette);
  vec3 deviation = picture - uGround;
  vec3 col = uGround * scanGround * glass + deviation * scanInk * mix(1.0 + 0.1 * uNoHalo * uScan * (1.0 - keep), glass, keep);

  if (uGrain > 0.0) {
    float n = hash21(floor(frag) + floor(uTime * 12.0) * (1.0 - uStatic) * vec2(17.0, 31.0)) - 0.5;
    col *= 1.0 + n * 0.09 * uGrain;
  }
  if (ag > 0.0 && uCell < 0.5) {
    float n = hash21(floor(frag) + tick * vec2(17.0, 31.0)) - 0.5;
    col *= 1.0 + n * (0.015 + 0.07 * ag);
    col *= 1.0 + (0.004 + 0.012 * ag) * sin(6.2831853 * (vUv.y * 1.6 - uTime * 0.55));
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * mask, 1.0);
}
`;

export interface Screen {
  /** True when any treatment is on, so a pass is worth running. */
  wanted(shared: FxShared): boolean;
  draw(tools: FxTools, shared: FxShared, frame: Frame, input: WebGLRenderTarget, output: WebGLRenderTarget | null): void;
  dispose(): void;
}

export function createScreen(): Screen {
  let material: ShaderMaterial | null = null;
  const ground = new Vector3();

  return {
    wanted(shared) {
      const s = shared.screen;
      return s.scanlines > 0 || s.signal > 0 || s.grain > 0 || s.vignette > 0 || s.curve > 0;
    },
    draw(tools, shared, frame, input, output) {
      material ??= fullscreenMaterial(FRAGMENT, {
        tPicture: { value: null },
        uGround: { value: ground },
        uSize: { value: new Vector2(1, 1) },
        uPixelRatio: { value: 1 },
        uTime: { value: 0 },
        uAgitation: { value: 0 },
        uScanPeriod: { value: 0 },
        uScan: { value: 0 },
        uSignal: { value: 0 },
        uGrain: { value: 0 },
        uVignette: { value: 0 },
        uCurve: { value: 0 },
        uNoHalo: { value: 0 },
        uCell: { value: 0 },
        uStatic: { value: 0 },
      });
      const s = shared.screen;
      // One line pair per tenth of the body size; below 3 device pixels a line the modulation is switched off rather than left to moire.
      const period = Math.round((frame.bodySize / 10) * tools.pixelRatio);
      ground.set(shared.style.ground.r, shared.style.ground.g, shared.style.ground.b);
      setUniform(material, 'tPicture', input.texture);
      setVec2(material, 'uSize', tools.width, tools.height);
      setUniform(material, 'uPixelRatio', tools.pixelRatio);
      setUniform(material, 'uTime', frame.ambient);
      setUniform(material, 'uAgitation', frame.reducedMotion ? 0 : frame.agitation);
      setUniform(material, 'uScanPeriod', period >= 3 ? period : 0);
      setUniform(material, 'uScan', period >= 3 ? s.scanlines : 0);
      setUniform(material, 'uSignal', s.signal);
      setUniform(material, 'uGrain', s.grain);
      setUniform(material, 'uVignette', s.vignette);
      setUniform(material, 'uCurve', s.curve);
      setUniform(material, 'uNoHalo', shared.halo ? 0 : 1);
      setUniform(material, 'uCell', shared.cell);
      setUniform(material, 'uStatic', frame.reducedMotion ? 1 : 0);
      tools.pass(material, output);
    },
    dispose() {
      material?.dispose();
    },
  };
}
