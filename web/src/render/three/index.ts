import { AMBIENT_KINDS, FX_NAMES, LOOK_IDS, PROCEDURAL_MEDIA, STROKES, TEXTURES } from '@conduit/language';
import type { Face, LookId } from '@conduit/language';
import { Color, ColorManagement, LinearSRGBColorSpace, NoToneMapping, Vector3, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { Frame, PictureFrame, Quality, ShapeFrame, SpriteFrame } from '../../contracts/frame';
import type { ContextEvent, Renderer } from '../../contracts/renderer';
import { layerZ } from '../../contracts/space';
import type { Viewport } from '../../contracts/space';
import { FACES } from '../../fonts/faces';
import { LOOKS } from '../../looks';
import { fontFile } from '../fonts';
import { rasteriseFrame } from './capture';
import { insideClip } from './clip';
import { createFieldPool } from './fields';
import { createFxPipeline } from './fx';
import { createSketchPass } from './media';
import type { SketchPass } from './media';
import { createMarkPool } from './marks';
import { createPicturePool } from './pictures';
import { createPostPipeline } from './post';
import type { PostPipeline } from './post';
import { insideOutline } from './shape-geometry';
import { createShapePool } from './shapes';
import { createSpritePool } from './sprites';
import { createStageGraph, renderOrderOf } from './stage';
import type { StageGraph } from './stage';
import { flatSpec, styleOf } from './style';
import { createTextPool, preloadFonts } from './text';
import type { TextPool } from './text';

// Colours are carried exactly as written: every pass works on display values, so a hex from the look is the pixel that comes out.
ColorManagement.enabled = false;

/** Numbers the bench reads to check that nothing leaks and that typesetting has caught up. */
export interface ThreeProbe {
  readonly settled: boolean;
  readonly textures: number;
  readonly geometries: number;
  readonly programs: number;
  /** one short label per compiled program, so the bench can tell which one a look change had to compile */
  readonly programNames: readonly string[];
  readonly targets: number;
  readonly pixelRatio: number;
  readonly look: LookId | null;
  readonly canvas: HTMLCanvasElement | null;
  /** Reads canvas pixels (device pixels, origin top-left) in the same task as the last render. */
  read(x: number, y: number, width: number, height: number): Uint8Array;
}

export { PHOSPHOR_CURVE } from './fx';

export interface ThreeRenderer extends Renderer {
  probe(): ThreeProbe;
}

interface Hit {
  readonly key: string;
  readonly tappable: boolean;
  readonly order: number;
}

/**
 * The WebGL renderer: flat planes at four depths, a perspective camera
 * moving through them, and each look's surface made of the effects it lists.
 * Everything that imports three.js lives in this folder.
 */
export function createThreeRenderer(): Renderer {
  return createProbedRenderer();
}

/** Everything one picture is drawn with. The live stage has one; each look warmed off screen gets a throwaway, and pictures are taken with one more. */
interface Kit {
  stage: StageGraph;
  fx: ReturnType<typeof createFxPipeline>;
  pipeline: PostPipeline;
  text: TextPool;
  marks: ReturnType<typeof createMarkPool>;
  shapes: ReturnType<typeof createShapePool>;
  sprites: ReturnType<typeof createSpritePool>;
  pictures: ReturnType<typeof createPicturePool>;
  /** the sketches of the pictures that are painted by the renderer itself */
  sketches: SketchPass;
  context: WebGLRenderer;
  fields: ReturnType<typeof createFieldPool>;
  viewport: Viewport;
}

function drawKit(kit: Kit, frame: Frame, quality: Quality): void {
  const style = styleOf(frame.spec, quality);
  const v = kit.viewport;
  if (frame.viewport.width !== v.width || frame.viewport.height !== v.height || frame.viewport.dpr !== v.dpr) {
    kit.viewport = frame.viewport;
    kit.stage.resize(frame.viewport);
    kit.pipeline.resize(frame.viewport);
  }
  kit.stage.setCamera(frame.camera, frame.view ?? null);
  const groups = { far: kit.stage.layers.far, bg: kit.stage.layers.bg, mid: kit.stage.layers.mid, fg: kit.stage.layers.fg };
  kit.text.setInk(frame.reducedMotion ? 0 : frame.agitation, quality === 'full');
  kit.text.sync({ ...groups, furniture: kit.stage.furniture }, frame.elements, kit.fx.furniture(frame), style);
  const pixelRatio = kit.pipeline.pixelRatio;
  const gridUnit = style.hard ? Math.max(1, Math.round((frame.bodySize / 20) * pixelRatio)) / pixelRatio : 1 / pixelRatio;
  const unlettered = kit.text.unlettered;
  kit.marks.sync(groups, unlettered.size === 0 ? frame.elements : frame.elements.filter((element) => !unlettered.has(element.key)), frame.cursor, style, gridUnit, frame.ambient);
  const shapes: ShapeFrame[] = [];
  const sprites: SpriteFrame[] = [];
  const pictures: PictureFrame[] = [];
  for (const figure of frame.figures) {
    if (figure.kind === 'shape') shapes.push(figure);
    else if (figure.kind === 'sprite') sprites.push(figure);
    else pictures.push(figure);
  }
  kit.shapes.sync(groups, shapes, frame.spec, frame.viewport, style);
  kit.sprites.sync(groups, sprites, style);
  // Always asked, even with no picture on stage: the pass lets go of the surfaces of sketches that have left.
  const sketches = kit.sketches.update(kit.context, pictures, shapes, frame.spec, frame.viewport);
  kit.pictures.sync(groups, pictures, frame.ambient, frame.spec, style, sketches);
  kit.fields.sync(groups, frame.fields, frame.viewport, quality, frame.reducedMotion, frame.camera, style);
  kit.pipeline.render(kit.stage, frame);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once the browser has had a chance to present what was just drawn; never waits on a hidden tab. */
function presented(): Promise<void> {
  return new Promise((resolve) => {
    const give = setTimeout(resolve, 250);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(give);
        resolve();
      }),
    );
  });
}

const ALL_LOOKS: readonly LookId[] = LOOK_IDS;

/** How long a lost context is given to come back before a new one is built, and how many times a new one is tried. */
const RESTORE_WAIT_MS = 2000;
const REBUILD_ATTEMPTS = 4;

export function createProbedRenderer(): ThreeRenderer {
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderer | null = null;
  let kit: Kit | null = null;
  let taking: Kit | null = null;
  let takingTarget: WebGLRenderTarget | null = null;
  let viewport: Viewport = { width: 1, height: 1, dpr: 1 };
  let quality: Quality = 'full';
  let last: Frame | null = null;
  let lost = false;
  let lostTimer: ReturnType<typeof setTimeout> | null = null;
  let mounted: HTMLElement | null = null;
  let mountedLook: LookId = 'paper';
  const listeners = new Set<(event: ContextEvent) => void>();
  let drawn = false;
  const preloaded = new Set<string>();
  /** faces whose glyphs a still has asked for, so a long film asks once */
  const faceLoads = new Map<Face, Promise<void | undefined>>();

  const makeKit = (context: WebGLRenderer, size: Viewport, detached: boolean): Kit => {
    const fx = createFxPipeline();
    return {
      stage: createStageGraph(size),
      fx,
      pipeline: createPostPipeline(context, fx, size, detached),
      text: createTextPool(),
      marks: createMarkPool(),
      shapes: createShapePool(),
      sprites: createSpritePool(),
      pictures: createPicturePool(),
      sketches: createSketchPass(),
      context,
      fields: createFieldPool(),
      viewport: size,
    };
  };

  const releaseKit = (each: Kit): void => {
    each.text.dispose();
    each.marks.dispose();
    each.shapes.dispose();
    each.sprites.dispose();
    each.pictures.dispose();
    each.sketches.dispose();
    each.fields.dispose();
    each.pipeline.dispose();
    each.fx.dispose();
    each.stage.dispose();
  };

  const releaseContext = (): void => {
    const context = canvas;
    if (context === null) return;
    context.removeEventListener('webglcontextlost', onLost);
    context.removeEventListener('webglcontextrestored', onRestored);
  };

  const tell = (event: ContextEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // a listener's failure is its own
      }
    }
  };

  const createContext = (): WebGLRenderer => {
    let created: WebGLRenderer;
    try {
      created = new WebGLRenderer({ antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    } catch (error) {
      throw new Error(`WebGL context creation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!created.capabilities.isWebGL2) {
      created.dispose();
      throw new Error('WebGL2 is not available');
    }
    created.outputColorSpace = LinearSRGBColorSpace;
    created.toneMapping = NoToneMapping;
    created.autoClear = false;
    return created;
  };

  const attach = (created: WebGLRenderer, host: HTMLElement): void => {
    gl = created;
    canvas = created.domElement;
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:manipulation';
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    host.appendChild(canvas);
  };

  const onLost = (event: Event): void => {
    event.preventDefault();
    lost = true;
    tell('lost');
    // A browser may never give the context back (the GPU process was reset, too many contexts): wait a moment, then build a new one.
    if (lostTimer !== null) clearTimeout(lostTimer);
    lostTimer = setTimeout(() => rebuild(1), RESTORE_WAIT_MS);
  };

  // The old context is gone for good: its objects are let go, never disposed (disposing would only raise GL errors), and everything is made afresh on a new canvas in the same place.
  const rebuild = (attempt: number): void => {
    lostTimer = null;
    const dead = gl;
    const host = mounted;
    if (dead === null || host === null || !lost) return;
    releaseContext();
    try {
      dead.forceContextLoss();
      dead.dispose();
    } catch {
      // already dead
    }
    canvas?.remove();
    parked.length = 0;
    taking = null;
    takingTarget = null;
    preloaded.clear();
    try {
      attach(createContext(), host);
    } catch {
      gl = null;
      canvas = null;
      kit = null;
      if (attempt >= REBUILD_ATTEMPTS) {
        tell('failed');
        return;
      }
      gl = dead;
      lostTimer = setTimeout(() => rebuild(attempt + 1), RESTORE_WAIT_MS * 2 ** attempt);
      return;
    }
    const fresh = gl as WebGLRenderer | null;
    if (fresh === null) return;
    kit = makeKit(fresh, viewport, false);
    kit.pipeline.setQuality(quality);
    lost = false;
    paintGround(last?.look ?? mountedLook);
    if (last !== null) renderer.render(last);
    tell('rebuilt');
  };

  // After a restore three's own caches still name objects of the dead context, so disposing anything old would
  // raise GL errors. Everything is rebuilt fresh instead and the old objects are simply let go.
  const onRestored = (): void => {
    if (lostTimer !== null) clearTimeout(lostTimer);
    lostTimer = null;
    lost = false;
    if (gl === null) return;
    kit = makeKit(gl, viewport, false);
    kit.pipeline.setQuality(quality);
    taking = null;
    takingTarget = null;
    preloaded.clear();
    if (last !== null) renderer.render(last);
    tell('restored');
  };

  /** The canvas shows the look's own ground from the moment it exists, never the browser's black. */
  const paintGround = (look: LookId): void => {
    if (gl === null) return;
    gl.setRenderTarget(null);
    gl.setClearColor(new Color(LOOKS[look].roles.ground), 1);
    gl.clear(true, false, false);
  };

  // Programs are compiled, targets allocated and glyphs typeset off screen, so neither mount nor a later look
  // change hitches, and nothing but the look's ground ever reaches the visible canvas before the first real frame.
  // The starting look is warmed on the live kit with its output captured; the others in idle time, one per task,
  // on throwaway kits that cannot touch the canvas, the live targets or the live text pool.
  const settleOn = async (target: Kit, frame: Frame): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt++) {
      drawKit(target, frame, quality);
      if (target.text.settled) return;
      await pause(8);
    }
  };

  const warmStarting = async (look: LookId): Promise<void> => {
    const live = kit;
    if (gl === null || live === null) return;
    const capture = new WebGLRenderTarget(8, 8);
    live.pipeline.setCapture(capture);
    try {
      const test = warmFrame(look, viewport);
      await settleOn(live, test);
      // Compile the look-change pass too, then settle the look's own furniture (a teletext header) on an empty stage.
      drawKit(live, { ...test, ambient: test.ambient + 1, lookChange: { from: look, to: look, progress: 0.5 } }, quality);
      await settleOn(live, { ...test, elements: [], figures: [], fields: [], cursor: null });
    } finally {
      live.pipeline.setCapture(null);
      capture.dispose();
    }
    if (gl === null) return;
    live.pipeline.reset();
    const ground: Frame = { ...warmFrame(look, viewport), elements: [], figures: [], fields: [], cursor: null };
    renderer.render(ground);
    await presented();
  };

  // A compiled program lives only while some material uses it. Changing look disposes the live look's text and mark
  // materials, so every look that can be shown keeps a small parked kit (a 160x100 stage with its own pipeline, text and
  // marks, never drawn to the canvas) whose only job is to hold its programs alive until the look is needed.
  const parked: { kit: Kit; capture: WebGLRenderTarget }[] = [];

  const release = (each: { kit: Kit; capture: WebGLRenderTarget }): void => {
    releaseKit(each.kit);
    each.capture.dispose();
  };

  const warmOffscreen = async (look: LookId): Promise<void> => {
    if (gl === null) return;
    const size: Viewport = { width: 160, height: 100, dpr: 1 };
    const throwaway = makeKit(gl, size, true);
    const capture = new WebGLRenderTarget(8, 8);
    throwaway.pipeline.setCapture(capture);
    const entry = { kit: throwaway, capture };
    const test = warmFrame(look, size);
    for (let attempt = 0; attempt < 400 && gl !== null; attempt++) {
      drawKit(throwaway, test, quality);
      if (throwaway.text.settled) break;
      await pause(8);
    }
    if (gl === null) {
      release(entry);
      return;
    }
    drawKit(throwaway, { ...test, ambient: test.ambient + 1, lookChange: { from: look, to: look, progress: 0.5 } }, quality);
    // The test elements stay in the parked stage on purpose: a program is released the moment the last mesh using it goes.
    parked.push(entry);
  };

  const warmRest = (looks: readonly LookId[]): void => {
    // A stage that can only ever show one look never changes look: nothing to keep ready.
    if (looks.length < 2) return;
    void preloadFonts(Object.keys(FACES) as Face[])
      .then(async () => {
        for (const id of looks) {
          await pause(250);
          if (gl === null) return;
          await warmOffscreen(id);
        }
      })
      .catch(() => undefined);
  };

  const takeKit = (context: WebGLRenderer): Kit => {
    taking ??= makeKit(context, { width: 160, height: 100, dpr: 1 }, true);
    return taking;
  };

  const renderer: ThreeRenderer = {
    id: 'three',
    fontFile,
    // `kinds` is what this renderer draws from a Frame. Structures and controls reach it as shapes and text, so they are not its to advertise.
    capabilities: { depth: true, post: true, looks: ALL_LOOKS, kinds: ['text', 'shape', 'sprite', 'group', 'copy', 'picture', 'field'], fx: FX_NAMES, ambient: AMBIENT_KINDS, capture: true, media: PROCEDURAL_MEDIA, textures: TEXTURES, brushes: STROKES, clip: true },

    async mount(target, initial, look, options) {
      if (!canUseThree()) throw new Error('WebGL2 is not available');
      viewport = initial;
      attach(createContext(), target);
      mounted = target;
      mountedLook = look;
      const context = gl as WebGLRenderer | null;
      if (context === null) return;
      kit = makeKit(context, viewport, false);
      paintGround(look);
      try {
        const spec = LOOKS[look];
        await preloadFonts([spec.type.face]);
        await warmStarting(look);
      } catch (error) {
        renderer.dispose();
        throw error;
      }
      if (gl === null) return;
      warmRest(options?.looks ?? ALL_LOOKS);
    },

    resize(next) {
      viewport = next;
      if (kit === null) return;
      kit.viewport = next;
      kit.stage.resize(next);
      kit.pipeline.resize(next);
      kit.pipeline.reset();
      if (last !== null && drawn) renderer.render({ ...last, viewport: next });
      else paintGround(last?.look ?? 'paper');
    },

    render(frame) {
      if (gl === null || kit === null || lost) return;
      last = frame;
      drawKit(kit, frame, quality);
      viewport = kit.viewport;
      drawn = true;
    },

    isDrawable() {
      return gl !== null && kit !== null && !lost && drawn && kit.text.drawable;
    },

    async preload(url) {
      if (gl === null || kit === null) throw new Error('the renderer is not mounted');
      await kit.pictures.preload(url);
      preloaded.add(url);
    },

    onContext(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async rasterise(frame, options) {
      const context = gl;
      if (context === null || lost) return null;
      const fx = options.fx !== false;
      const seen = frame.figures.filter((figure): figure is PictureFrame => figure.kind === 'picture' && figure.src !== null);
      const mine = takeKit(context);
      await Promise.all(seen.map((figure) => (figure.src === null ? Promise.resolve() : mine.pictures.preload(figure.src).catch(() => undefined))));
      // The faces this frame is set in must be in the glyph atlas before the wait for its text starts (`preloadFonts` has its own limit and a failure is not fatal).
      const faces = [...new Set<Face>([frame.spec.type.face, ...frame.elements.map((element) => element.face)])];
      const fresh = faces.filter((face) => !faceLoads.has(face));
      if (fresh.length > 0) {
        const load = preloadFonts(fresh).catch(() => undefined);
        for (const face of fresh) faceLoads.set(face, load);
      }
      const ready = Promise.all(faces.map((face) => faceLoads.get(face)));
      return rasteriseFrame(
        (shot, width, height, withFx, force) => {
          if (gl === null || taking === null) return null;
          const own = taking;
          const dpr = shot.viewport.width >= shot.viewport.height ? width / shot.viewport.width : height / shot.viewport.height;
          if (takingTarget === null || takingTarget.width !== width || takingTarget.height !== height) {
            takingTarget?.dispose();
            takingTarget = new WebGLRenderTarget(width, height, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
          }
          own.pipeline.setCapture(takingTarget);
          own.pipeline.reset();
          const spec = withFx ? shot.spec : flatSpec(shot.spec);
          const plain: Frame = {
            ...shot,
            spec,
            lookChange: null,
            viewport: { width: shot.viewport.width, height: shot.viewport.height, dpr },
            dim: withFx ? shot.dim : 0,
            agitation: withFx ? shot.agitation : 0,
            camera: shot.camera,
          };
          drawKit(own, plain, 'full');
          if (!force && (!own.text.settled || !own.text.drawable)) return null;
          const out = new Uint8Array(width * height * 4);
          context.readRenderTargetPixels(takingTarget, 0, 0, width, height, out);
          context.setRenderTarget(null);
          return out;
        },
        frame,
        { ...options, fx: fx },
        ready,
      );
    },

    reset() {
      kit?.pipeline.reset();
    },

    pick(x, y) {
      const frame = last;
      const active = kit;
      if (frame === null || active === null) return null;
      const vp = active.viewport;
      // a point of the page is where the lens puts it on the screen; the camera, cropped to the lens, is asked about the screen
      const view = frame.view;
      const picture = active.fx.toPicture(view === undefined ? x : (x - view.x) * view.scale, view === undefined ? y : (y - view.y) * view.scale, frame);
      const camera = active.stage.camera;
      const near = new Vector3((picture.x / vp.width) * 2 - 1, -((picture.y / vp.height) * 2 - 1), -1).unproject(camera);
      const far = new Vector3((picture.x / vp.width) * 2 - 1, -((picture.y / vp.height) * 2 - 1), 1).unproject(camera);
      const direction = far.sub(near);
      if (Math.abs(direction.z) < 1e-9) return null;

      let best: Hit | null = null;
      const consider = (hit: Hit): void => {
        if (best === null || (hit.tappable && !best.tappable) || (hit.tappable === best.tappable && hit.order > best.order)) best = hit;
      };
      const onPlane = new Map<string, { x: number; y: number }>();
      const planePoint = (layer: Frame['elements'][number]['layer']): { x: number; y: number } => {
        let found = onPlane.get(layer);
        if (found === undefined) {
          const t = (layerZ(layer, vp) - near.z) / direction.z;
          found = { x: near.x + direction.x * t, y: -(near.y + direction.y * t) };
          onPlane.set(layer, found);
        }
        return found;
      };

      frame.elements.forEach((element, index) => {
        if (element.opacity <= 0.05) return;
        const p = planePoint(element.layer);
        if (!insideClip(element.clip, p.x, p.y)) return;
        const cos = Math.cos(-element.rotation);
        const sin = Math.sin(-element.rotation);
        const dx = p.x - element.x;
        const dy = p.y - element.y;
        const lx = (dx * cos - dy * sin) / element.scale;
        const ly = (dx * sin + dy * cos) / element.scale;
        if (Math.abs(lx) > element.width / 2 || Math.abs(ly) > element.height / 2) return;
        consider({ key: element.key, tappable: element.tappable, order: renderOrderOf(element.layer, 'text', element.z) + index * 1e-3 });
      });

      frame.figures.forEach((figure, index) => {
        if (figure.opacity <= 0.05) return;
        const t = figure.transform;
        const det = t.a * t.d - t.b * t.c;
        if (Math.abs(det) < 1e-12) return;
        const p = planePoint(figure.layer);
        if (!insideClip(figure.kind === 'shape' && figure.bleed ? undefined : figure.clip, p.x, p.y)) return;
        const dx = p.x - t.e;
        const dy = p.y - t.f;
        const local = { x: (t.d * dx - t.c * dy) / det, y: (-t.b * dx + t.a * dy) / det };
        const order = renderOrderOf(figure.layer, 'fill', figure.z) + 1 + index * 1e-3;
        if (figure.kind === 'shape') {
          if (figure.bleed) return;
          let hit = figure.fill !== null && figure.fill.opacity > 0.05 && insideOutline(local, figure.outline);
          if (!hit && figure.stroke !== null) {
            const reach = Math.max(figure.stroke.width / 2, 3 / Math.sqrt(Math.abs(det)) / Math.max(1e-6, 1));
            hit = nearOutline(local, figure.outline, reach);
          }
          if (hit) consider({ key: figure.key, tappable: figure.tappable, order });
        } else if (figure.kind === 'sprite') {
          const w = (figure.cols * figure.cell) / 2;
          const h = (figure.rows * figure.cell) / 2;
          if (Math.abs(local.x) <= w && Math.abs(local.y) <= h) consider({ key: figure.key, tappable: figure.tappable, order });
        } else {
          const { box } = figure;
          if (local.x >= box.x && local.x <= box.x + box.width && local.y >= box.y && local.y <= box.y + box.height) consider({ key: figure.key, tappable: figure.tappable, order });
        }
      });
      return (best as Hit | null)?.key ?? null;
    },

    setQuality(next) {
      quality = next;
      kit?.pipeline.setQuality(next);
      if (last !== null && drawn) renderer.render(last);
    },

    dispose() {
      if (lostTimer !== null) clearTimeout(lostTimer);
      lostTimer = null;
      listeners.clear();
      mounted = null;
      releaseContext();
      for (const each of parked) release(each);
      parked.length = 0;
      if (taking !== null) releaseKit(taking);
      taking = null;
      takingTarget?.dispose();
      takingTarget = null;
      if (kit !== null) releaseKit(kit);
      canvas?.remove();
      gl?.dispose();
      gl?.forceContextLoss();
      gl = null;
      canvas = null;
      kit = null;
      last = null;
      drawn = false;
      preloaded.clear();
      faceLoads.clear();
    },

    probe() {
      const info = gl?.info;
      return {
        settled: kit?.text.settled ?? false,
        textures: info?.memory.textures ?? 0,
        geometries: info?.memory.geometries ?? 0,
        programs: info?.programs?.length ?? 0,
        programNames: (info?.programs ?? []).map((program) => `${program.name}:${program.cacheKey.slice(0, 60)}`),
        targets: kit?.pipeline.targetCount() ?? 0,
        pixelRatio: kit?.pipeline.pixelRatio ?? 1,
        look: last?.look ?? null,
        canvas,
        read(x, y, width, height) {
          const out = new Uint8Array(width * height * 4);
          const context = gl?.getContext();
          if (context === undefined || canvas === null) return out;
          const flipped = canvas.height - y - height;
          context.readPixels(x, flipped, width, height, context.RGBA, context.UNSIGNED_BYTE, out);
          return out;
        },
      };
    },
  };
  return renderer;
}

function nearOutline(point: { x: number; y: number }, outline: ShapeFrame['outline'], reach: number): boolean {
  const limit = reach * reach;
  for (const line of outline) {
    const points = line.points;
    const count = line.closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a === undefined || b === undefined) continue;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lengthSquared = abx * abx + aby * aby;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSquared));
      const dx = point.x - (a.x + abx * t);
      const dy = point.y - (a.y + aby * t);
      if (dx * dx + dy * dy <= limit) return true;
    }
  }
  return false;
}

/** One of everything, so that every program a look can need is compiled before it is shown. */
function warmFrame(look: LookId, viewport: Viewport): Frame {
  const spec = LOOKS[look];
  const size = 24;
  const advance = FACES[spec.type.face].advance;
  const run = { text: 'Ag', x: -size * advance, y: -size / 2, width: size * advance * 2, colour: spec.roles.ink, opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 0.5 };
  const line = { x: run.x, y: run.y, width: run.width, height: size };
  const element = (key: string, layer: 'bg' | 'mid' | 'fg') => ({
    key,
    id: key,
    layer,
    x: 0,
    y: 0,
    width: run.width,
    height: size,
    fontSize: size,
    stretch: 1,
    weight: 'normal' as const,
    opacity: 0.6,
    scale: 1,
    rotation: 0,
    runs: [run],
    lines: [line],
    mark: 'invert' as const,
    markColour: spec.roles.accent,
    strike: 1,
    ghost: false,
    tappable: false,
    z: 0,
    face: spec.type.face,
    plate: 0.5,
  });
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const square = [
    { x: -10, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ];
  return {
    time: 0,
    ambient: 0,
    wallTime: 0,
    clock: 'idle',
    viewport,
    look,
    spec,
    lookChange: null,
    bodySize: size,
    margin: 16,
    canvas: { box: { x: -viewport.width / 2, y: -viewport.height / 2, width: viewport.width, height: viewport.height }, unit: viewport.width / 160 },
    gridTop: -viewport.height / 2 + 16,
    ground: spec.roles.ground,
    camera: { x: 0, y: 0, dolly: 0, yaw: 0, pitch: 0, roll: 0 },
    agitation: 0.2,
    dim: 0.1,
    reducedMotion: false,
    elements: [element('warm-bg', 'bg'), element('warm-mid', 'mid'), element('warm-fg', 'fg')],
    figures: [
      {
        kind: 'shape',
        key: 'warm-shape',
        id: 'warm-shape',
        layer: 'mid',
        z: 0,
        outline: [{ points: square, closed: true }],
        geometryKey: 'warm',
        transform: identity,
        fill: { colour: spec.roles.accent, to: spec.roles.alt, opacity: 0.8, texture: 'wash' },
        stroke: { colour: spec.roles.ink, width: 1, progress: 0.6, character: spec.stroke.character },
        opacity: 1,
        bleed: false,
        tappable: false,
        soft: 1,
      },
      // The rest of what a shape can be, so that every branch of the shape shaders is compiled before it is needed.
      { kind: 'shape', key: 'warm-sketch', id: 'warm-sketch', layer: 'bg', z: 0, outline: [{ points: square, closed: true }], geometryKey: 'warm-sketch', transform: identity, fill: { colour: spec.roles.accent, to: null, opacity: 1, texture: 'hatch' }, stroke: { colour: spec.roles.ink, width: 1, progress: 1, character: 'ink' }, opacity: 1, bleed: false, tappable: false },
      {
        kind: 'sprite',
        key: 'warm-sprite',
        id: 'warm-sprite',
        layer: 'fg',
        z: 0,
        cols: 2,
        rows: 2,
        cells: [spec.roles.ink, null, null, spec.roles.accent],
        cellsKey: 'warm',
        cell: 4,
        transform: identity,
        landed: 1.5,
        opacity: 1,
        tappable: false,
      },
      {
        kind: 'picture',
        key: 'warm-picture',
        id: 'warm-picture',
        layer: 'bg',
        z: 0,
        box: { x: -20, y: -20, width: 40, height: 40 },
        transform: identity,
        src: null,
        develop: 0,
        mask: 'round',
        opacity: 1,
        waiting: true,
        tappable: false,
      },
      {
        kind: 'picture',
        key: 'warm-painting',
        id: 'warm-painting',
        layer: 'bg',
        z: 0,
        box: { x: -20, y: -20, width: 40, height: 40 },
        transform: identity,
        src: null,
        develop: 0.5,
        mask: 'none',
        opacity: 1,
        waiting: false,
        tappable: false,
        medium: 'watercolor',
        sketch: ['warm-sketch'],
      },
    ],
    fields: [{ kind: 'field', key: 'warm-field', layer: 'mid', field: 'rain', density: 0.2, colour: spec.roles.dim, opacity: 1, seed: 1, time: 1, flow: { x: -viewport.width / 2, y: -viewport.height / 2, width: viewport.width, height: viewport.height } }],
    cursor: { layer: 'mid', x: 0, y: 0, width: 10, height: size, colour: spec.roles.accent, lit: true, shape: 'block' },
  };
}

/** True when this browser can run the WebGL renderer at all. Cheap; creates and discards one context. */
export function canUseThree(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('canvas');
    const context = probe.getContext('webgl2');
    if (context === null) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
