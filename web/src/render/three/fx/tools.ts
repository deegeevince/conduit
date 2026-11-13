import { ShaderMaterial, Vector2 } from 'three';
import type { Camera, Material, Scene, Texture, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { Viewport } from '../../../contracts/space';
import { FULLSCREEN_VERTEX } from '../glsl';

export type StageLayerName = 'far' | 'bg' | 'mid' | 'fg' | 'furniture' | 'surface';

export interface TargetOptions {
  /** relative to the drawing buffer */
  readonly scale?: number;
  /** absolute size in device pixels; wins over `scale` */
  readonly width?: number;
  readonly height?: number;
  readonly nearest?: boolean;
  /** half-float storage, for anything that decays or accumulates */
  readonly half?: boolean;
  /** multisampled, for drawing the stage */
  readonly msaa?: boolean;
}

/** What the pipeline lends an effect while it draws one frame. */
export interface FxTools {
  readonly renderer: WebGLRenderer;
  readonly viewport: Viewport;
  /** device pixels per CSS pixel actually in use; lower in `lite` quality */
  readonly pixelRatio: number;
  /** drawing buffer size in device pixels */
  readonly width: number;
  readonly height: number;
  /** Where the last pass must go: null is the screen. The pipeline sets a target here while one look is giving way to another, or while a picture is being taken. */
  readonly output: WebGLRenderTarget | null;
  /** A render target the pipeline owns and resizes. */
  target(name: string, options: TargetOptions): WebGLRenderTarget;
  /**
   * Draws the stage (or some of its layers) into a target. `clear` is a CSS
   * colour, `'transparent'` (the default) or `'none'` to draw over what is there.
   */
  drawStage(
    scene: Scene,
    camera: Camera,
    output: WebGLRenderTarget | null,
    options?: { readonly layers?: readonly StageLayerName[]; readonly clear?: string },
  ): void;
  /** Runs one full-screen shader. */
  pass(material: Material, output: WebGLRenderTarget | null): void;
  /** Swaps the two half-float targets of a named feedback pair and returns [previous, next]. `scale` is relative to the drawing buffer. */
  feedback(name: string, scale?: number): readonly [WebGLRenderTarget, WebGLRenderTarget];
  /** Clears one named feedback pair to black. */
  clearFeedback(name: string): void;
}

export type { Texture };

export function fullscreenMaterial(fragmentShader: string, uniforms: ShaderMaterial['uniforms']): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  });
}

export function setUniform(material: ShaderMaterial, name: string, value: unknown): void {
  const slot = material.uniforms[name];
  if (slot !== undefined) slot.value = value;
}

export function setVec2(material: ShaderMaterial, name: string, x: number, y: number): void {
  const value = material.uniforms[name]?.value;
  if (value instanceof Vector2) value.set(x, y);
}

const BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tIn, vUv) * 0.2270270270;
  c += (texture2D(tIn, vUv + uStep) + texture2D(tIn, vUv - uStep)) * 0.1945945946;
  c += (texture2D(tIn, vUv + uStep * 2.0) + texture2D(tIn, vUv - uStep * 2.0)) * 0.1216216216;
  c += (texture2D(tIn, vUv + uStep * 3.0) + texture2D(tIn, vUv - uStep * 3.0)) * 0.0540540541;
  c += (texture2D(tIn, vUv + uStep * 4.0) + texture2D(tIn, vUv - uStep * 4.0)) * 0.0162162162;
  gl_FragColor = c;
}
`;

const DOWN_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tIn, vUv + uStep * vec2(-0.5, -0.5));
  c += texture2D(tIn, vUv + uStep * vec2(0.5, -0.5));
  c += texture2D(tIn, vUv + uStep * vec2(-0.5, 0.5));
  c += texture2D(tIn, vUv + uStep * vec2(0.5, 0.5));
  gl_FragColor = c * 0.25;
}
`;

/** Separable gaussian blurs and a 2x down-sample, for halation, soft depth and soft shadows. */
export interface Blurrer {
  /** Blurs `source` into `scratch` then `into`; all three must be the same size. */
  blur(tools: FxTools, source: Texture, scratch: WebGLRenderTarget, into: WebGLRenderTarget, spacing: number): void;
  down(tools: FxTools, source: Texture, sourceWidth: number, sourceHeight: number, into: WebGLRenderTarget): void;
  dispose(): void;
}

export function createBlurrer(): Blurrer {
  const blur = fullscreenMaterial(BLUR_FRAGMENT, { tIn: { value: null }, uStep: { value: new Vector2() } });
  const down = fullscreenMaterial(DOWN_FRAGMENT, { tIn: { value: null }, uStep: { value: new Vector2() } });
  return {
    blur(tools, source, scratch, into, spacing) {
      setUniform(blur, 'tIn', source);
      setVec2(blur, 'uStep', spacing / scratch.width, 0);
      tools.pass(blur, scratch);
      setUniform(blur, 'tIn', scratch.texture);
      setVec2(blur, 'uStep', 0, spacing / scratch.height);
      tools.pass(blur, into);
    },
    down(tools, source, sourceWidth, sourceHeight, into) {
      setUniform(down, 'tIn', source);
      setVec2(down, 'uStep', 1 / sourceWidth, 1 / sourceHeight);
      tools.pass(down, into);
    },
    dispose() {
      blur.dispose();
      down.dispose();
    },
  };
}
