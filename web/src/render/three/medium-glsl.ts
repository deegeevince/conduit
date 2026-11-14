// The media: what a picture's sketch becomes when it is painted. Each is a function of the sketch surface and of
// noise fixed to the picture's own box (`vBox`, in box units), so a painting never shimmers when the camera moves.
// The sketch surface is premultiplied; `sketchAt` hands back straight colour and coverage.

import { HASH, NOISE } from './glsl';

/** The shader's number for each medium. */
export const MEDIUM_CODE = { watercolor: 1, gouache: 2, oil: 3, ink: 4, pastel: 5, woodcut: 6, pixel: 7 } as const;

export const MEDIUM_GLSL = /* glsl */ `
uniform sampler2D tSketch;
uniform vec2 uTexel;
uniform vec2 uBoxSize;
uniform vec3 uInk;
uniform float uMedium;
${HASH}
${NOISE}

vec4 sketchAt(vec2 uv) {
  vec4 s = texture2D(tSketch, clamp(uv, 0.0, 1.0));
  return vec4(s.a > 1e-4 ? s.rgb / s.a : vec3(0.0), s.a);
}
// premultiplied average over a disc of taps, radius in texels
vec4 around(vec2 uv, float radius) {
  vec4 sum = texture2D(tSketch, clamp(uv, 0.0, 1.0));
  float angle = 0.0;
  for (int i = 0; i < 8; i++) {
    angle = float(i) * 0.7853982;
    vec2 o = vec2(cos(angle), sin(angle)) * radius * uTexel;
    sum += texture2D(tSketch, clamp(uv + o, 0.0, 1.0));
  }
  return sum / 9.0;
}
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// how far a colour is from the paper, as a share of the furthest it could be: the tone a one-ink medium gives it
float tonal(vec3 c) {
  float g = lum(uGround);
  return smoothstep(0.08, 1.0, pow(clamp(abs(lum(c) - g) / max(max(g, 1.0 - g), 0.2), 0.0, 1.0), 0.75));
}
// the way the sketch runs at a point: along its contours, from the gradient of its coverage
vec2 flowAt(vec2 uv, vec2 fallbackAt) {
  vec2 e = uTexel * 2.0;
  float gx = texture2D(tSketch, clamp(uv + vec2(e.x, 0.0), 0.0, 1.0)).a - texture2D(tSketch, clamp(uv - vec2(e.x, 0.0), 0.0, 1.0)).a;
  float gy = texture2D(tSketch, clamp(uv + vec2(0.0, e.y), 0.0, 1.0)).a - texture2D(tSketch, clamp(uv - vec2(0.0, e.y), 0.0, 1.0)).a;
  vec2 g = vec2(gx, gy);
  float a = 0.6 + (fbm(fallbackAt * 0.004) - 0.5) * 1.1;
  vec2 free = vec2(cos(a), sin(a));
  return length(g) > 0.04 ? normalize(vec2(-g.y, g.x)) : free;
}

// Returns the painted colour and how much of it there is (0 is the paper showing through).
vec4 conduitMedium(vec2 box, vec2 uv) {
  int kind = int(uMedium + 0.5);
  vec2 px = box;
  vec4 s = sketchAt(uv);
  if (kind == 1) {
    // watercolor: loose washes that pool at their edges, bleed into their neighbours and settle into the paper
    vec2 warp = (vec2(fbm(px * 0.021), fbm(px * 0.021 + 31.0)) - 0.5) * 0.02;
    vec2 wuv = uv + warp;
    vec4 near = around(wuv, 3.0);
    vec4 wide = around(wuv, 9.0);
    float cover = smoothstep(0.1, 0.5, near.a);
    vec3 colour = near.a > 1e-3 ? near.rgb / near.a : s.rgb;
    vec3 neighbour = wide.a > 1e-3 ? wide.rgb / wide.a : colour;
    colour = mix(colour, neighbour, 0.3 * smoothstep(0.1, 0.6, wide.a) * (1.0 - near.a));
    float rim = cover * (1.0 - smoothstep(0.45, 0.95, wide.a));
    float paper = fbm(px * 0.9) * 0.6 + 0.4 * hash21(floor(px * 1.4));
    colour *= 1.0 - 0.28 * rim;
    colour *= 0.93 + 0.14 * paper;
    float pigment = 0.74 + 0.3 * fbm(px * 0.05 + 4.0) + 0.2 * rim;
    return vec4(colour, cover * clamp(pigment, 0.0, 1.0) * (0.86 + 0.14 * paper));
  } else if (kind == 2) {
    // gouache: flat, opaque, with a dry edge
    vec4 near = around(uv, 1.5);
    float edge = (fbm(px * 0.35) - 0.5) * 0.4 + (hash21(floor(px * 1.5)) - 0.5) * 0.12;
    float cover = smoothstep(0.46, 0.54, near.a + edge * (1.0 - abs(near.a * 2.0 - 1.0)));
    vec3 colour = near.a > 1e-3 ? near.rgb / near.a : s.rgb;
    colour = floor(colour * 12.0 + 0.5) / 12.0;
    return vec4(colour, cover);
  } else if (kind == 3) {
    // oil: thick strokes whose ridges follow the way each shape was drawn, lit from the upper left
    vec4 near = around(uv, 2.0);
    float cover = smoothstep(0.12, 0.45, near.a);
    vec3 colour = near.a > 1e-3 ? near.rgb / near.a : s.rgb;
    vec2 dir = flowAt(uv, px);
    vec2 across = vec2(-dir.y, dir.x);
    vec2 q = vec2(dot(px, dir) / 34.0, dot(px, across) / 6.0);
    float h = vnoise(q) * 0.65 + 0.35 * vnoise(q * 2.3 + 5.0);
    vec2 qx = vec2(dot(px + vec2(2.0, 0.0), dir) / 34.0, dot(px + vec2(2.0, 0.0), across) / 6.0);
    vec2 qy = vec2(dot(px + vec2(0.0, 2.0), dir) / 34.0, dot(px + vec2(0.0, 2.0), across) / 6.0);
    float hx = vnoise(qx) * 0.65 + 0.35 * vnoise(qx * 2.3 + 5.0);
    float hy = vnoise(qy) * 0.65 + 0.35 * vnoise(qy * 2.3 + 5.0);
    vec2 slope = vec2(hx - h, hy - h) * 1.5;
    float light = dot(slope, normalize(vec2(-1.0, -1.0)));
    colour *= 1.0 + 0.3 * clamp(light, -0.7, 0.7);
    colour *= 0.95 + 0.1 * h;
    float weave = 0.985 + 0.015 * sin(px.x * 1.9) * sin(px.y * 1.9);
    return vec4(colour * weave, cover);
  } else if (kind == 4) {
    // ink: brush and ink, three tones, a dry-brush edge
    vec4 near = around(uv, 1.5);
    float body = near.a > 1e-3 ? tonal(near.rgb / near.a) : 0.0;
    float strength = near.a * body;
    float dry = fbm(vec2(px.x * 0.06, px.y * 1.1) + 5.0);
    float edge = smoothstep(0.2, 0.8, near.a);
    float level = strength + (dry - 0.5) * 0.35 * (1.0 - abs(edge * 2.0 - 1.0)) * 1.5;
    float tone = level > 0.8 ? 1.0 : (level > 0.38 ? 0.46 : 0.0);
    return vec4(uInk, tone * smoothstep(0.05, 0.4, near.a));
  } else if (kind == 5) {
    // pastel: soft chalky colour, smudged along the stroke
    vec2 dir = flowAt(uv, px);
    vec4 smear = (sketchAt(uv) * 0.34 + sketchAt(uv + dir * uTexel * 5.0) * 0.33 + sketchAt(uv - dir * uTexel * 5.0) * 0.33);
    vec4 near = around(uv, 2.5);
    float cover = smoothstep(0.08, 0.5, mix(smear.a, near.a, 0.4));
    vec3 colour = mix(s.rgb, near.a > 1e-3 ? near.rgb / near.a : s.rgb, 0.6);
    colour = mix(colour, vec3(1.0), 0.14);
    float tooth = 0.7 + 0.3 * smoothstep(0.3, 0.7, 0.5 * hash21(floor(px * 1.3)) + 0.5 * vnoise(px * 0.8));
    return vec4(colour, cover * tooth);
  } else if (kind == 6) {
    // woodcut: carved black and white, the cuts following the form
    vec4 wide = around(uv, 6.0);
    vec4 near = around(uv, 1.5);
    float body = near.a > 1e-3 ? tonal(near.rgb / near.a) : 0.0;
    float strength = near.a * body;
    vec2 run = flowAt(uv, px);
    float bands = fract(dot(px, vec2(-run.y, run.x)) / 7.0 + 0.6 * fbm(px * 0.03));
    float cut = smoothstep(0.3, 0.38, bands) * (1.0 - smoothstep(0.6, 0.68, bands));
    float ink = strength > 0.8 ? 1.0 : (strength > 0.36 ? cut : 0.0);
    // a cut line round every shape
    float edge = near.a > 0.12 && near.a < 0.88 ? 1.0 : 0.0;
    ink = max(ink, edge);
    return vec4(uInk, ink);
  } else {
    // pixel: a coarse grid of flat colour, few shades, no smoothing
    float cells = 44.0;
    vec2 grid = uBoxSize.x >= uBoxSize.y ? vec2(cells, cells * uBoxSize.y / uBoxSize.x) : vec2(cells * uBoxSize.x / uBoxSize.y, cells);
    vec2 centre = (floor(uv * grid) + 0.5) / grid;
    vec4 c = around(centre, 0.0) ;
    vec4 blur = vec4(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) blur += texture2D(tSketch, clamp(centre + vec2(float(i), float(j)) / grid * 0.3, 0.0, 1.0));
    blur /= 9.0;
    vec3 colour = blur.a > 1e-3 ? blur.rgb / blur.a : c.rgb;
    colour = floor(colour * 5.0 + 0.5) / 5.0;
    return vec4(colour, step(0.5, blur.a));
  }
}
`;
