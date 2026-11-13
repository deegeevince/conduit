// Shader snippets shared by the skins, the mark pool and the text patches.

export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const HASH = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** 4x4 ordered-dither threshold in (0, 1), from integer pixel coordinates. */
export const BAYER4 = /* glsl */ `
float conduitBayer(vec2 pixel) {
  ivec2 p = ivec2(mod(floor(pixel), 4.0));
  int i = p.x + p.y * 4;
  float m = 0.0;
  if (i == 0) m = 0.0; else if (i == 1) m = 8.0; else if (i == 2) m = 2.0; else if (i == 3) m = 10.0;
  else if (i == 4) m = 12.0; else if (i == 5) m = 4.0; else if (i == 6) m = 14.0; else if (i == 7) m = 6.0;
  else if (i == 8) m = 3.0; else if (i == 9) m = 11.0; else if (i == 10) m = 1.0; else if (i == 11) m = 9.0;
  else if (i == 12) m = 15.0; else if (i == 13) m = 7.0; else if (i == 14) m = 13.0; else m = 5.0;
  return (m + 0.5) / 16.0;
}
`;

export const NOISE = /* glsl */ `
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return v;
}
`;

/** Pixels per local unit of an object, from its model-view and the projection: the shader's way of knowing how big a stroke or a cell really is. */
export const PIXEL_SCALE = /* glsl */ `
uniform vec2 uViewPx;
float conduitPixelsPerUnit(vec4 viewPosition) {
  float depth = max(-viewPosition.z, 1e-3);
  float local = sqrt(abs(modelMatrix[0][0] * modelMatrix[1][1] - modelMatrix[1][0] * modelMatrix[0][1]));
  return local * projectionMatrix[1][1] * uViewPx.y * 0.5 / depth;
}
`;
