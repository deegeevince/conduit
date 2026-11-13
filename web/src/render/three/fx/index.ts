// The surface of a look: one pipeline that applies whichever effects a look
// lists. A retro preset is nothing but its list. Effects fall into four kinds:
//
//   raster   `pixelate` decides the resolution the stage is drawn at.
//   surface  `bars`, `paper`, `grid` (one sheet in the scene), `dust`, `shadow`
//            say how strongly to lay themselves on the ground; one compose
//            pass puts the stage on it.
//   print    `halftone`, `misprint`, `dither` are passes over the picture.
//   light    `persistence`, `glow` are passes; `scanlines`, `signal`, `grain`,
//            `vignette`, `curve` are done together in one last pass (screen.ts).

import type { FxName, Layer } from '@conduit/language';
import { AddEquation, CustomBlending, OneFactor, OneMinusSrcAlphaFactor, PerspectiveCamera, ShaderMaterial } from 'three';
import type { WebGLRenderTarget } from 'three';
import type { ElementFrame, Frame, Quality } from '../../../contracts/frame';
import { FOV_Y_DEGREES, planeScale, restDistance } from '../../../contracts/space';
import type { Viewport } from '../../../contracts/space';
import { FULLSCREEN_VERTEX } from '../glsl';
import type { StageGraph } from '../stage';
import { styleOf } from '../style';
import { createBars } from './bars';
import { createCompose } from './compose';
import { createCurve } from './curve';
import { createDither } from './dither';
import { createDust } from './dust';
import { createGlow } from './glow';
import { createGrain } from './grain';
import { createGrid } from './grid';
import { createHalftone } from './halftone';
import { createHeader } from './header';
import { createMisprint } from './misprint';
import { createPaper } from './paper';
import { createPersistence } from './persistence';
import { createPixelate } from './pixelate';
import { createRibbon } from './ribbon';
import { createScanlines } from './scanlines';
import { createScreen } from './screen';
import { clearShared, createShared } from './shared';
import type { FxShared } from './shared';
import { createShadow } from './shadow';
import { createSheet, LIFT } from './sheet';
import { createSignal } from './signal';
import { createBlurrer, fullscreenMaterial, setUniform } from './tools';
import type { FxTools } from './tools';
import { createVignette } from './vignette';

export { CURVE as PHOSPHOR_CURVE } from './curve';
export type { FxTools, StageLayerName, TargetOptions } from './tools';

/**
 * The fixed order effects are applied in, whatever order a look lists them.
 * `raster` decides the resolution the stage is drawn at; `surface` is what
 * the picture is laid on (it is in the scene, so it moves under the camera);
 * `print` treats the picture as ink; `light` treats it as light.
 */
export const FX_ORDER: readonly FxName[] = [
  'pixelate',
  'bars',
  'paper',
  'grid',
  'dust',
  'shadow',
  'ribbon',
  'halftone',
  'misprint',
  'dither',
  'persistence',
  'glow',
  'scanlines',
  'signal',
  'grain',
  'vignette',
  'curve',
  'header',
];

/** One effect. It owns its shaders and its targets and nothing else. */
export interface Effect {
  readonly name: FxName;
  /** Adds anything the effect keeps in the scene (a sheet of paper, a grid plane). */
  attach?(stage: StageGraph): void;
  detach?(stage: StageGraph): void;
  /** Text the effect draws itself (teletext's header row), in screen units. */
  furniture?(frame: Frame): readonly ElementFrame[];
  /**
   * Applies itself. `input` is the picture so far; the effect draws into
   * `output` (null is the screen). `amount` is the look's setting for it,
   * 0..1. An effect that only changes how the stage is rasterised (`pixelate`)
   * says so through `rasterScale` and passes its input through. An effect that
   * is a share of a pass done together with others (the surface and the light)
   * only records its amount and is given no picture.
   */
  apply(tools: FxTools, stage: StageGraph, frame: Frame, amount: number, quality: Quality, input: unknown, output: unknown): void;
  /** Where the picture must go when this effect keeps its own history (afterglow): it is asked first, and given the target as `output`. */
  destination?(tools: FxTools): WebGLRenderTarget;
  /** device pixels of the stage raster per device pixel of the screen; 1 when the effect does not change it */
  rasterScale?(frame: Frame, amount: number): number;
  /** Maps a screen point back to the unwarped picture, for picking. */
  toPicture?(x: number, y: number, viewport: Viewport, amount: number): { readonly x: number; readonly y: number };
  /** Forgets anything carried from earlier frames. */
  reset?(tools: FxTools): void;
  dispose(): void;
}

export interface FxPipeline {
  /** Draws one frame through the effects `frame.spec.fx` lists, in FX_ORDER, synchronously. A look change is a retune of amounts, with the list cut over at the midpoint. */
  draw(tools: FxTools, stage: StageGraph, frame: Frame, quality: Quality): void;
  furniture(frame: Frame): readonly ElementFrame[];
  toPicture(x: number, y: number, frame: Frame): { readonly x: number; readonly y: number };
  reset(tools: FxTools): void;
  dispose(): void;
}

/** Passes over the picture, run in order after the stage is composed. */
const PASSES: ReadonlySet<FxName> = new Set<FxName>(['halftone', 'misprint', 'dither', 'persistence', 'glow']);
/** Effects with a `lite` form that is nothing: they keep history, need a wide blur or a second picture. */
const FULL_ONLY: ReadonlySet<FxName> = new Set<FxName>(['persistence', 'glow', 'curve', 'dust', 'misprint', 'ribbon']);

const BLIT = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tIn, vUv) * uOpacity;
}
`;

function usedLayers(frame: Frame): Set<Layer> {
  const used = new Set<Layer>();
  for (const element of frame.elements) used.add(element.layer);
  for (const figure of frame.figures) used.add(figure.layer);
  for (const field of frame.fields) used.add(field.layer);
  if (frame.cursor !== null) used.add(frame.cursor.layer);
  return used;
}

export function createFxPipeline(): FxPipeline {
  let shared: FxShared | null = null;
  let effects: Record<FxName, Effect> | null = null;
  const sheet = createSheet();
  const compose = createCompose();
  const screen = createScreen();
  const blurrer = createBlurrer();
  const header = new PerspectiveCamera();
  let attached: StageGraph | null = null;

  const blit = new ShaderMaterial({
    uniforms: { tIn: { value: null }, uOpacity: { value: 1 } },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: BLIT,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  const copy = fullscreenMaterial(BLIT, { tIn: { value: null }, uOpacity: { value: 1 } });

  const dustMaterial = fullscreenMaterial(
    /* glsl */ `
precision highp float;
uniform sampler2D tStage;
uniform sampler2D tPrev;
uniform float uDecay;
varying vec2 vUv;
void main() {
  float now = texture2D(tStage, vUv).a;
  gl_FragColor = vec4(max(texture2D(tPrev, vUv).r * uDecay, now), now, 0.0, 1.0);
}
`,
    { tStage: { value: null }, tPrev: { value: null }, uDecay: { value: 0 } },
  );
  let dustAt: number | null = null;

  const ensure = (frame: Frame, quality: Quality): { shared: FxShared; effects: Record<FxName, Effect> } => {
    if (shared === null || effects === null) {
      shared = createShared(styleOf(frame.spec, quality), frame);
      const s = shared;
      effects = {
        pixelate: createPixelate(s),
        bars: createBars(s),
        paper: createPaper(s),
        grid: createGrid(s),
        dust: createDust(s),
        shadow: createShadow(s),
        ribbon: createRibbon(),
        halftone: createHalftone(s),
        misprint: createMisprint(s),
        dither: createDither(s),
        persistence: createPersistence(s),
        glow: createGlow(s),
        scanlines: createScanlines(s),
        signal: createSignal(s),
        grain: createGrain(s),
        vignette: createVignette(s),
        curve: createCurve(s),
        header: createHeader(),
      };
    }
    return { shared, effects };
  };

  const placeHeaderCamera = (viewport: Viewport, fullW: number, fullH: number, gridW: number, gridH: number, offset: boolean): void => {
    const rest = restDistance(viewport);
    header.fov = FOV_Y_DEGREES;
    header.aspect = viewport.width / viewport.height;
    header.near = rest * 0.05;
    header.far = rest * 8;
    header.position.set(0, 0, rest);
    header.lookAt(0, 0, 0);
    if (offset) header.setViewOffset(fullW, fullH, 0, 0, gridW, gridH);
    else header.clearViewOffset();
    header.updateProjectionMatrix();
    header.updateMatrixWorld(true);
  };

  const blitInto = (tools: FxTools, source: WebGLRenderTarget, into: WebGLRenderTarget, opacity: number): void => {
    setUniform(blit, 'tIn', source.texture);
    setUniform(blit, 'uOpacity', opacity);
    tools.pass(blit, into);
  };

  const drawShadow = (tools: FxTools, stage: StageGraph, quality: Quality): WebGLRenderTarget => {
    const full = quality === 'full';
    const { viewport } = tools;
    const lift = LIFT * viewport.height;
    const fg = stage.layers.fg;
    const home = fg.position.clone();
    const homeScale = fg.scale.clone();
    const k = planeScale('fg', viewport);
    // The foreground floats above the sheet: drop it onto the paper, thrown away from the lamp, and blur it.
    fg.position.set(0.04 * lift, -0.065 * lift, 0);
    fg.scale.set(k, k, 1);
    const shadow = tools.target('shadow', { scale: full ? 0.5 : 0.25 });
    stage.camera.layers.disable(1);
    tools.drawStage(stage.scene, stage.camera, shadow, { layers: ['fg'], clear: 'transparent' });
    stage.camera.layers.enable(1);
    fg.position.copy(home);
    fg.scale.copy(homeScale);
    if (!full) return shadow;
    const scratch = tools.target('shadow-scratch', { scale: 0.5 });
    const soft = tools.target('shadow-soft', { scale: 0.5 });
    blurrer.blur(tools, shadow.texture, scratch, soft, 1.6);
    return soft;
  };

  let drawnQuality: Quality = 'full';

  return {
    furniture(frame) {
      const found = frame.spec.fx.find((setting) => setting.name === 'header' && setting.amount > 0);
      if (found === undefined) return [];
      return effects?.header.furniture?.(frame) ?? createHeader().furniture?.(frame) ?? [];
    },

    toPicture(x, y, frame) {
      let point = { x, y };
      const amount = frame.spec.fx.find((setting) => setting.name === 'curve')?.amount ?? 0;
      // Lite quality leaves the glass curve out of the picture, so a tap must not be bent by it either.
      const curved = !(drawnQuality === 'lite' && FULL_ONLY.has('curve'));
      if (amount > 0 && curved && effects !== null) point = effects.curve.toPicture?.(x, y, frame.viewport, amount) ?? point;
      return point;
    },

    reset(tools) {
      if (effects !== null) for (const effect of Object.values(effects)) effect.reset?.(tools);
      sheet.reset();
      dustAt = null;
    },

    draw(tools, stage, frame, quality) {
      drawnQuality = quality;
      const style = styleOf(frame.spec, quality);
      const { shared: state, effects: all } = ensure(frame, quality);
      clearShared(state, style, frame, quality, tools.pixelRatio);
      const lite = quality === 'lite';

      const listed: { effect: Effect; amount: number }[] = [];
      for (const name of FX_ORDER) {
        const amount = style.amounts[name] ?? 0;
        if (amount <= 0 || (lite && FULL_ONLY.has(name))) continue;
        listed.push({ effect: all[name], amount });
      }

      // Raster, and every effect that only records how strongly to lay itself on the picture.
      for (const { effect, amount } of listed) {
        if (effect.rasterScale !== undefined) {
          const wanted = Math.round(1 / Math.max(effect.rasterScale(frame, amount), 1e-3));
          state.cell = wanted > 1 ? wanted : 0;
        }
        if (!PASSES.has(effect.name)) effect.apply(tools, stage, frame, amount, quality, null, null);
        if (effect.name === 'glow') state.halo = true;
      }

      const gp = state.cell;
      const fullW = gp > 0 ? tools.width / gp : tools.width;
      const fullH = gp > 0 ? tools.height / gp : tools.height;
      const gridW = Math.ceil(fullW);
      const gridH = Math.ceil(fullH);

      if (attached !== stage) {
        sheet.detach();
        attached = stage;
      }
      const hasSheet = state.sheet.bars > 0 || state.sheet.paper > 0 || state.sheet.grid > 0;
      let sheetTarget: WebGLRenderTarget | null = null;
      if (hasSheet) {
        sheet.attach(stage);
        sheetTarget = sheet.draw(tools, stage, frame, state);
      }

      const used = usedLayers(frame);
      let shadowTarget: WebGLRenderTarget | null = null;
      if (state.shadow > 0 && used.has('fg')) shadowTarget = drawShadow(tools, stage, quality);

      // The stage: premultiplied picture of every layer, on transparent.
      const stageTarget = gp > 0 ? tools.target('stage', { width: gridW, height: gridH, nearest: true }) : tools.target('stage', { msaa: !lite });
      if (gp > 0) {
        stage.camera.setViewOffset(fullW, fullH, 0, 0, gridW, gridH);
        stage.camera.updateProjectionMatrix();
      }
      const behind: Layer[] = [];
      if (gp === 0) {
        for (const layer of ['far', 'bg'] as const) {
          const depth = style.depth[layer];
          if (used.has(layer) && (depth.fade > 0 || depth.soft)) behind.push(layer);
        }
      }
      if (behind.length > 0) {
        tools.drawStage(stage.scene, stage.camera, stageTarget, { layers: [], clear: 'transparent' });
        for (const layer of ['far', 'bg'] as const) {
          if (!used.has(layer)) continue;
          const depth = style.depth[layer];
          const soft = depth.soft;
          const own = tools.target(`layer-${layer}`, { scale: soft ? 0.5 : 1, msaa: !lite && !soft });
          tools.drawStage(stage.scene, stage.camera, own, { layers: [layer], clear: 'transparent' });
          if (soft) {
            const scratch = tools.target('layer-scratch', { scale: 0.5 });
            const blurred = tools.target('layer-soft', { scale: 0.5 });
            blurrer.blur(tools, own.texture, scratch, blurred, 1.3);
            blitInto(tools, blurred, stageTarget, 1 - depth.fade);
          } else {
            blitInto(tools, own, stageTarget, 1 - depth.fade);
          }
        }
        tools.drawStage(stage.scene, stage.camera, stageTarget, { layers: ['mid', 'fg'], clear: 'none' });
      } else {
        tools.drawStage(stage.scene, stage.camera, stageTarget, { layers: ['far', 'bg', 'mid', 'fg'], clear: 'transparent' });
      }
      if (gp > 0) {
        stage.camera.clearViewOffset();
        stage.camera.updateProjectionMatrix();
      }
      if (listed.some(({ effect }) => effect.name === 'header')) {
        placeHeaderCamera(tools.viewport, fullW, fullH, gridW, gridH, gp > 0);
        tools.drawStage(stage.scene, header, stageTarget, { layers: ['furniture'], clear: 'none' });
      }

      // Where marks have been, and where they are no longer: chalk dust.
      let dustTarget: WebGLRenderTarget | null = null;
      if (state.dust > 0) {
        const [previous, next] = tools.feedback('dust', 0.25);
        const dt = dustAt === null ? 0 : frame.ambient - dustAt;
        dustAt = frame.ambient;
        setUniform(dustMaterial, 'tStage', stageTarget.texture);
        setUniform(dustMaterial, 'tPrev', previous.texture);
        setUniform(dustMaterial, 'uDecay', dt < 0 ? 0 : Math.exp(-Math.min(dt, 5) / 6));
        tools.pass(dustMaterial, next);
        dustTarget = next;
      }

      // Compose, then the passes over the picture, then the screen.
      const passes = listed.filter(({ effect }) => PASSES.has(effect.name));
      const finish = screen.wanted(state);
      const total = 1 + passes.length + (finish ? 1 : 0);
      let turn = 0;
      const nextTarget = (avoid: WebGLRenderTarget | null): WebGLRenderTarget => {
        const first = tools.target(turn % 2 === 0 ? 'fx-a' : 'fx-b', {});
        turn++;
        if (first !== avoid) return first;
        const second = tools.target(turn % 2 === 0 ? 'fx-a' : 'fx-b', {});
        turn++;
        return second;
      };

      let current = total === 1 ? tools.output : nextTarget(null);
      compose.draw(tools, state, frame, { stage: stageTarget, sheet: sheetTarget, shadow: shadowTarget, dust: dustTarget }, current);
      let step = 1;
      for (const { effect, amount } of passes) {
        const own = effect.destination?.(tools) ?? null;
        const out = own ?? (step === total - 1 ? tools.output : nextTarget(current));
        effect.apply(tools, stage, frame, amount, quality, current, out);
        current = out;
        step++;
      }
      if (finish) {
        if (current !== null) screen.draw(tools, state, frame, current, tools.output);
      } else if (current !== tools.output && current !== null) {
        // The last effect kept its own history in its own target: put the picture where it was wanted.
        setUniform(copy, 'tIn', current.texture);
        tools.pass(copy, tools.output);
      }
    },

    dispose() {
      if (effects !== null) for (const effect of Object.values(effects)) effect.dispose();
      sheet.dispose();
      compose.dispose();
      screen.dispose();
      blurrer.dispose();
      blit.dispose();
      copy.dispose();
      dustMaterial.dispose();
      effects = null;
      shared = null;
    },
  };
}
