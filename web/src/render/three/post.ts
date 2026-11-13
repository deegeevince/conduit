// The render-target machinery under the effects: it owns every target, lends
// them to the pipeline one frame at a time, and performs the cut between two
// looks. It needs no addon of three's.

import {
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { RETRO_LOOKS } from '@conduit/language';
import type { Camera, Material, WebGLRenderer } from 'three';
import type { Frame, Quality } from '../../contracts/frame';
import type { Viewport } from '../../contracts/space';
import type { FxPipeline } from './fx';
import type { FxTools, StageLayerName, TargetOptions } from './fx/tools';
import { FULLSCREEN_VERTEX, HASH } from './glsl';
import { VIEW_PX } from './style';
import type { StageGraph } from './stage';

export interface PostPipeline {
  resize(viewport: Viewport): void;
  setQuality(quality: Quality): void;
  /** Clears feedback targets so the next frame inherits no picture. */
  reset(): void;
  /**
   * Sends the final picture into this off-screen target instead of the canvas, or back to the canvas with null.
   * Warming uses it: programs compile and targets allocate without a single pixel reaching the screen.
   */
  setCapture(target: WebGLRenderTarget | null): void;
  /** The pixel ratio in use, which `lite` lowers. */
  readonly pixelRatio: number;
  render(stage: StageGraph, frame: Frame): void;
  /** Number of render targets alive, for the bench. */
  targetCount(): number;
  dispose(): void;
}

interface TargetEntry {
  readonly target: WebGLRenderTarget;
  readonly options: TargetOptions;
  /** the render count at which it was last asked for */
  used: number;
}

interface FeedbackPair {
  readonly a: WebGLRenderTarget;
  readonly b: WebGLRenderTarget;
  current: WebGLRenderTarget;
  used: number;
}

const STATIC_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tPicture;
uniform float uAmount;
uniform float uTime;
uniform float uPixel;
uniform vec2 uSize;
uniform float uDip;
uniform vec3 uGround;
varying vec2 vUv;
${HASH}
void main() {
  vec2 frag = vUv * uSize;
  float step_ = floor(uTime * 24.0);
  float row = floor(frag.y / (uPixel * 3.0));
  float tear = (hash21(vec2(row, step_)) - 0.5) * 0.12 * uAmount * uAmount * (1.0 - uDip);
  vec3 picture = texture2D(tPicture, vec2(fract(vUv.x + tear), vUv.y)).rgb;
  vec2 cell = floor(frag / (uPixel * 2.0));
  float n = hash21(cell + vec2(step_ * 1.7, step_ * 0.3));
  vec3 snow = mix(vec3(0.12 + 0.8 * n), uGround, uDip);
  float amount = uAmount * mix(mix(0.75, 1.0, hash21(vec2(row, step_ + 9.0))), 1.0, uDip);
  gl_FragColor = vec4(mix(picture, snow, amount), 1.0);
}
`;

const MSAA_SAMPLES = 4;

/** A target nothing has asked for in this many renders belongs to a look or an effect that is gone, and is let go. */
const IDLE_RENDERS = 180;

/**
 * `detached` builds a pipeline that never touches the renderer's pixel ratio or the canvas size: its
 * drawing size is computed here and its picture can only go to a capture target. Warm-up kits for looks
 * that are not on screen, and the kit that takes pictures, are built this way.
 */
export function createPostPipeline(renderer: WebGLRenderer, fx: FxPipeline, viewport: Viewport, detached = false): PostPipeline {
  let current = viewport;
  let capture: WebGLRenderTarget | null = null;
  let quality: Quality = 'full';
  let pixelRatio = 1;
  let output: WebGLRenderTarget | null = null;
  const targets = new Map<string, TargetEntry>();
  const feedbacks = new Map<string, FeedbackPair>();
  const drawingSize = new Vector2();
  let renders = 0;

  const quadScene = new Scene();
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeometry = new PlaneGeometry(2, 2);
  const quad = new Mesh(quadGeometry);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const staticMaterial = new ShaderMaterial({
    uniforms: {
      tPicture: { value: null },
      uAmount: { value: 0 },
      uTime: { value: 0 },
      uPixel: { value: 2 },
      uSize: { value: new Vector2(1, 1) },
      uDip: { value: 0 },
      uGround: { value: new Color() },
    },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: STATIC_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });

  const wantedRatio = (): number => (detached ? Math.max(0.05, current.dpr) : Math.max(0.5, Math.min(current.dpr, quality === 'lite' ? 1.25 : 2)));

  const apply = (): void => {
    pixelRatio = wantedRatio();
    if (detached) {
      drawingSize.set(Math.max(1, Math.round(current.width * pixelRatio)), Math.max(1, Math.round(current.height * pixelRatio)));
      return;
    }
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(current.width, current.height, false);
    renderer.getDrawingBufferSize(drawingSize);
  };

  const sizeOf = (options: TargetOptions): { width: number; height: number } => {
    if (options.width !== undefined && options.height !== undefined) {
      return { width: Math.max(1, Math.ceil(options.width)), height: Math.max(1, Math.ceil(options.height)) };
    }
    const scale = options.scale ?? 1;
    return { width: Math.max(1, Math.ceil(drawingSize.x * scale)), height: Math.max(1, Math.ceil(drawingSize.y * scale)) };
  };

  const create = (options: TargetOptions): WebGLRenderTarget => {
    const { width, height } = sizeOf(options);
    const filter = options.nearest === true ? NearestFilter : LinearFilter;
    const target = new WebGLRenderTarget(width, height, {
      minFilter: filter,
      magFilter: filter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: options.msaa === true ? MSAA_SAMPLES : 0,
      type: options.half === true ? HalfFloatType : UnsignedByteType,
    });
    target.texture.generateMipmaps = false;
    return target;
  };

  const disposeTargets = (): void => {
    for (const entry of targets.values()) entry.target.dispose();
    targets.clear();
    for (const pair of feedbacks.values()) {
      pair.a.dispose();
      pair.b.dispose();
    }
    feedbacks.clear();
  };

  // Looks visited earlier leave their targets behind (phosphor's feedback pair, a shadow buffer); free what has gone unused.
  const releaseIdle = (): void => {
    for (const [name, entry] of targets) {
      if (renders - entry.used <= IDLE_RENDERS) continue;
      entry.target.dispose();
      targets.delete(name);
    }
    for (const [name, pair] of feedbacks) {
      if (renders - pair.used <= IDLE_RENDERS) continue;
      pair.a.dispose();
      pair.b.dispose();
      feedbacks.delete(name);
    }
  };

  const clearTarget = (target: WebGLRenderTarget): void => {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
  };

  const sameOptions = (a: TargetOptions, b: TargetOptions): boolean =>
    a.scale === b.scale && a.width === b.width && a.height === b.height && a.nearest === b.nearest && a.half === b.half && a.msaa === b.msaa;

  const tools: FxTools = {
    renderer,
    get viewport() {
      return current;
    },
    get pixelRatio() {
      return pixelRatio;
    },
    get width() {
      return drawingSize.x;
    },
    get height() {
      return drawingSize.y;
    },
    get output() {
      return output;
    },
    target(name, options) {
      const existing = targets.get(name);
      const size = sizeOf(options);
      if (existing !== undefined && sameOptions(existing.options, options) && existing.target.width === size.width && existing.target.height === size.height) {
        existing.used = renders;
        return existing.target;
      }
      existing?.target.dispose();
      const target = create(options);
      targets.set(name, { target, options, used: renders });
      return target;
    },
    drawStage(scene, camera: Camera, to, options) {
      const wanted: readonly StageLayerName[] = options?.layers ?? ['far', 'bg', 'mid', 'fg', 'surface'];
      const hidden: { visible: boolean; object: (typeof scene.children)[number] }[] = [];
      for (const child of scene.children) {
        hidden.push({ visible: child.visible, object: child });
        child.visible = wanted.includes(child.name as StageLayerName);
      }
      VIEW_PX.value.set(to === null ? drawingSize.x : to.width, to === null ? drawingSize.y : to.height);
      renderer.setRenderTarget(to);
      const clear = options?.clear ?? 'transparent';
      if (clear !== 'none') {
        if (clear === 'transparent') renderer.setClearColor(0x000000, 0);
        else renderer.setClearColor(new Color(clear), 1);
        renderer.clear(true, false, false);
      }
      renderer.render(scene, camera);
      for (const item of hidden) item.object.visible = item.visible;
    },
    pass(material: Material, to) {
      quad.material = material;
      renderer.setRenderTarget(to);
      renderer.render(quadScene, quadCamera);
    },
    feedback(name, scale = 1) {
      let pair = feedbacks.get(name);
      const options: TargetOptions = { half: true, scale };
      const size = sizeOf(options);
      if (pair !== undefined && (pair.a.width !== size.width || pair.a.height !== size.height)) {
        pair.a.dispose();
        pair.b.dispose();
        feedbacks.delete(name);
        pair = undefined;
      }
      if (pair === undefined) {
        const a = create(options);
        const b = create(options);
        pair = { a, b, current: a, used: renders };
        feedbacks.set(name, pair);
        clearTarget(a);
        clearTarget(b);
      }
      pair.used = renders;
      const previous = pair.current;
      const next = previous === pair.a ? pair.b : pair.a;
      pair.current = next;
      return [previous, next];
    },
    clearFeedback(name) {
      const pair = feedbacks.get(name);
      if (pair === undefined) return;
      clearTarget(pair.a);
      clearTarget(pair.b);
    },
  };

  apply();

  const staticAmount = (progress: number): number => {
    const ramp = (edge0: number, edge1: number, x: number): number => {
      const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };
    return progress < 0.5 ? ramp(0.04, 0.44, progress) : 1 - ramp(0.56, 0.96, progress);
  };

  return {
    get pixelRatio() {
      return pixelRatio;
    },
    resize(next) {
      current = next;
      apply();
      disposeTargets();
      fx.reset(tools);
    },
    setQuality(next) {
      if (next === quality) return;
      quality = next;
      apply();
      disposeTargets();
      fx.reset(tools);
    },
    setCapture(target) {
      capture = target;
    },
    reset() {
      for (const name of feedbacks.keys()) tools.clearFeedback(name);
      fx.reset(tools);
    },
    render(stage, frame) {
      renders += 1;
      const amount = !frame.reducedMotion && frame.lookChange !== null && !detached ? staticAmount(frame.lookChange.progress) : 0;
      output = amount > 0 ? tools.target('~final', { nearest: false }) : capture;
      fx.draw(tools, stage, frame, quality);
      if (amount > 0 && output !== null) {
        const uniforms = staticMaterial.uniforms;
        const set = (name: string, value: unknown): void => {
          const slot = uniforms[name];
          if (slot !== undefined) slot.value = value;
        };
        set('tPicture', output.texture);
        set('uAmount', amount);
        set('uTime', frame.ambient);
        set('uPixel', Math.max(1, pixelRatio * 2));
        // Static is what a tube does between channels. Between two looks that are not machines the picture dips through the ground instead.
        const change = frame.lookChange;
        const machine = change !== null && (RETRO_LOOKS.includes(change.from) || RETRO_LOOKS.includes(change.to));
        set('uDip', machine ? 0 : 1);
        (uniforms['uGround']?.value as Color).set(frame.ground);
        (uniforms['uSize']?.value as Vector2).set(drawingSize.x, drawingSize.y);
        output = capture;
        tools.pass(staticMaterial, capture);
      }
      renderer.setRenderTarget(null);
      if (renders % 60 === 0) releaseIdle();
    },
    targetCount() {
      return targets.size + feedbacks.size * 2;
    },
    dispose() {
      disposeTargets();
      staticMaterial.dispose();
      quadGeometry.dispose();
    },
  };
}
