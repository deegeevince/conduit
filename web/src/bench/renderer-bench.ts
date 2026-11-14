// Entry for bench-renderer.html: the WebGL renderer with no painter. Draws
// hand-built Frames so each look, each figure, each effect, the layers and the
// camera can be judged alone.

import { AMBIENT_KINDS, FX_NAMES, LOOK_IDS } from '@conduit/language';
import type { AmbientKind, FxName, Layer, LookId, Mask, StrokeCharacter } from '@conduit/language';
import type { Frame, Quality } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import { layerZ, projectToScreen, REST_POSE } from '../contracts/space';
import type { CameraPose, Viewport } from '../contracts/space';
import { LOOKS } from '../looks';
import { PHOSPHOR_CURVE, createProbedRenderer } from '../render/three';
import type { ThreeProbe, ThreeRenderer } from '../render/three';
import { CLIP_KINDS, clipFixture, fixtureFrame } from './fixture-frames';
import type { ClipKind, FixtureFigures } from './fixture-frames';
import { frameToSvg } from '../export/svg';
import { createPlainRenderer } from '../render/plain';
import type { Renderer } from '../contracts/renderer';
import { planeQuad } from '../render/place';

type Look = LookId | 'custom';

interface State {
  look: Look;
  quality: Quality;
  truck: number;
  dolly: number;
  yaw: number;
  pitch: number;
  roll: number;
  agitation: number;
  dim: number;
  reduced: boolean;
  animate: boolean;
  sweep: boolean;
  waiting: boolean;
  overlay: boolean;
  preset: string;
  ambient: number;
  content: FixtureFigures['content'];
  progress: number;
  landed: number;
  develop: number;
  mask: Mask;
  character: StrokeCharacter;
  field: AmbientKind | 'none';
  fieldLayer: Layer;
  density: number;
  strokeWidth: number;
  picture: boolean;
  /** `null` takes the look's own list; otherwise the amounts that replace it */
  fx: Partial<Record<FxName, number>> | null;
  /** the custom look: night's palette with a face and ground of its own */
  customGround: string;
  customInk: string;
  customFace: LookSpec['type']['face'];
}

const PRESETS: Readonly<Record<string, { width: number; height: number; dpr: number } | null>> = {
  window: null,
  '1440x900@2': { width: 1440, height: 900, dpr: 2 },
  '1440x900@1': { width: 1440, height: 900, dpr: 1 },
  '1000x640@1.5': { width: 1000, height: 640, dpr: 1.5 },
  '375x667@2': { width: 375, height: 667, dpr: 2 },
  '390x844@3': { width: 390, height: 844, dpr: 3 },
};

const params = new URLSearchParams(location.search);
const state: State = {
  look: (params.get('look') as Look | null) ?? 'paper',
  quality: params.get('quality') === 'lite' ? 'lite' : 'full',
  truck: 0,
  dolly: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  agitation: Number(params.get('agitation') ?? 0.2),
  dim: 0,
  reduced: params.get('reduced') === '1',
  animate: params.get('animate') === '1',
  sweep: params.get('sweep') === '1',
  waiting: params.get('waiting') === '1',
  overlay: params.get('overlay') === '1',
  preset: params.get('viewport') ?? 'window',
  ambient: Number(params.get('t') ?? 3),
  content: (params.get('content') as FixtureFigures['content'] | null) ?? 'both',
  progress: Number(params.get('progress') ?? 0.5),
  landed: Number(params.get('landed') ?? 3.5),
  develop: Number(params.get('develop') ?? 0.5),
  mask: (params.get('mask') as Mask | null) ?? 'none',
  character: (params.get('character') as StrokeCharacter | null) ?? 'clean',
  field: (params.get('field') as AmbientKind | null) ?? 'none',
  fieldLayer: (params.get('layer') as Layer | null) ?? 'mid',
  density: Number(params.get('density') ?? 0.5),
  strokeWidth: Number(params.get('width') ?? 3),
  picture: params.get('picture') !== '0',
  fx: null,
  customGround: '#2b1d3a',
  customInk: '#f1e6d8',
  customFace: 'hand',
};

const app = document.getElementById('app');
if (app === null) throw new Error('missing #app');
document.body.style.cssText = 'margin:0;background:#111;color:#ddd;font:12px/1.4 ui-monospace,Menlo,monospace';

const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;top:0;right:0;z-index:5;width:230px;max-height:100vh;overflow:auto;background:#000c;padding:8px;box-sizing:border-box';
const stageBox = document.createElement('div');
stageBox.style.cssText = 'position:fixed;left:0;top:0;overflow:hidden;background:#000';
const outline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
outline.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
const fpsLabel = document.createElement('div');
fpsLabel.style.cssText = 'color:#8f8';
const shotBox = document.createElement('div');
shotBox.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:6;background:#000c;padding:6px;display:none';
app.append(stageBox, panel, shotBox);

const renderer: ThreeRenderer = createProbedRenderer();

function add<K extends keyof HTMLElementTagNameMap>(tag: K, setup: (element: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  setup(element);
  return element;
}

function row(label: string, control: HTMLElement): void {
  panel.append(
    add('label', (l) => {
      l.style.cssText = 'display:block;margin:3px 0';
      l.append(`${label} `, control);
    }),
  );
}

function select(label: string, options: readonly string[], value: string, apply: (value: string) => void): void {
  row(
    label,
    add('select', (s) => {
      for (const option of options) s.append(new Option(option, option, false, option === value));
      s.addEventListener('change', () => apply(s.value));
    }),
  );
}

function slider(label: string, min: number, max: number, step: number, value: number, apply: (value: number) => void): void {
  row(
    label,
    add('input', (i) => {
      i.type = 'range';
      i.min = String(min);
      i.max = String(max);
      i.step = String(step);
      i.value = String(value);
      i.style.width = '100px';
      i.addEventListener('input', () => apply(Number(i.value)));
    }),
  );
}

function toggle(label: string, value: boolean, apply: (value: boolean) => void): void {
  row(
    label,
    add('input', (i) => {
      i.type = 'checkbox';
      i.checked = value;
      i.addEventListener('change', () => apply(i.checked));
    }),
  );
}

let mountMs = 0;
let viewport: Viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
let mounted = false;
let lastFrame: Frame | null = null;
let startedAt = 0;
let pictureUrl: string | null = null;
const frameTimes: number[] = [];
let lastTick = 0;
let fpsWindowStart = 0;
let fpsCount = 0;

function currentViewport(): Viewport {
  const preset = PRESETS[state.preset];
  return preset === null || preset === undefined ? { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } : preset;
}

function pose(): CameraPose {
  if (!state.animate) return { ...REST_POSE, x: state.truck, dolly: state.dolly, yaw: state.yaw, pitch: state.pitch, roll: state.roll };
  const t = state.ambient;
  return {
    ...REST_POSE,
    x: state.truck + Math.sin(t * 0.35) * viewport.width * 0.02,
    dolly: state.dolly + (Math.sin(t * 0.21) * 0.5 + 0.5) * viewport.height * 0.15,
    yaw: state.yaw + Math.sin(t * 0.3) * 0.12,
    pitch: state.pitch + Math.sin(t * 0.17) * 0.04,
    roll: state.roll,
  };
}

const specs = new Map<string, LookSpec>();

/** The spec being drawn: a preset as shipped, or one with the sliders' effects or the custom palette laid over it. Cached so frames share one object until something changes. */
function currentSpec(): LookSpec {
  const base = state.look === 'custom' ? LOOKS.night : LOOKS[state.look];
  const custom = state.look === 'custom';
  if (!custom && state.fx === null) return base;
  const fx = state.fx === null ? base.fx : FX_NAMES.filter((name) => (state.fx?.[name] ?? 0) > 0).map((name) => ({ name, amount: state.fx?.[name] ?? 0 }));
  const key = `${state.look}|${JSON.stringify(fx)}|${custom ? `${state.customGround}|${state.customInk}|${state.customFace}` : ''}`;
  let spec = specs.get(key);
  if (spec === undefined) {
    spec = custom
      ? { ...base, name: 'custom', fx, roles: { ...base.roles, ground: state.customGround, ink: state.customInk }, type: { ...base.type, face: state.customFace } }
      : { ...base, fx };
    specs.set(key, spec);
  }
  return spec;
}

function figures(): FixtureFigures {
  const t = state.ambient;
  return {
    content: state.content,
    progress: state.sweep ? (t / 6) % 1 : state.progress,
    landed: state.sweep ? (t * 6) % 10 : state.landed,
    develop: state.sweep ? (t / 4) % 1 : state.develop,
    mask: state.mask,
    picture: state.picture ? pictureUrl : null,
    character: state.character,
    field: state.field === 'none' ? null : state.field,
    fieldLayer: state.fieldLayer,
    density: state.density,
    strokeWidth: state.strokeWidth,
  };
}

function buildFrame(): Frame {
  const spec = currentSpec();
  return fixtureFrame(spec.id, viewport, pose(), state.ambient, {
    spec,
    figures: figures(),
    animate: state.animate,
    agitation: state.reduced ? 0 : state.agitation,
    dim: state.dim,
    reducedMotion: state.reduced,
    clock: state.waiting ? 'waiting' : 'playing',
    quality: state.quality,
  });
}

/** Where the curved glass puts a point of the flat picture: the inverse of the shader's mapping. */
function warp(x: number, y: number, frame: Frame): { x: number; y: number } {
  const amount = frame.spec.fx.find((setting) => setting.name === 'curve')?.amount ?? 0;
  if (amount <= 0 || state.quality !== 'full') return { x, y };
  const qx = (x / frame.viewport.width) * 2 - 1;
  const qy = (y / frame.viewport.height) * 2 - 1;
  let px = qx;
  let py = qy;
  for (let i = 0; i < 12; i++) {
    const k = 1 + PHOSPHOR_CURVE * amount * (px * px + py * py);
    px = qx / k;
    py = qy / k;
  }
  return { x: (px * 0.5 + 0.5) * frame.viewport.width, y: (py * 0.5 + 0.5) * frame.viewport.height };
}

function drawOverlay(frame: Frame): void {
  outline.replaceChildren();
  outline.style.display = state.overlay ? 'block' : 'none';
  if (!state.overlay) return;
  const colourOf = (layer: Layer): string => (layer === 'bg' ? '#f0f' : layer === 'fg' ? '#0f0' : layer === 'far' ? '#0ff' : '#f55');
  const project = (x: number, y: number, z: number): string => {
    const point = projectToScreen({ x, y, z }, frame.camera, frame.viewport);
    const shown = warp(point.x, point.y, frame);
    return `${shown.x},${shown.y}`;
  };
  const poly = (points: string[], layer: Layer, closed: boolean): void => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', closed ? 'polygon' : 'polyline');
    element.setAttribute('points', points.join(' '));
    element.setAttribute('fill', 'none');
    element.setAttribute('stroke', colourOf(layer));
    element.setAttribute('stroke-width', '1');
    outline.append(element);
  };
  for (const element of frame.elements) {
    const z = layerZ(element.layer, frame.viewport);
    const cos = Math.cos(element.rotation);
    const sin = Math.sin(element.rotation);
    for (const line of element.lines) {
      const corners = [
        [line.x, line.y],
        [line.x + line.width, line.y],
        [line.x + line.width, line.y + line.height],
        [line.x, line.y + line.height],
      ].map(([lx = 0, ly = 0]) => {
        const sx = lx * element.scale;
        const sy = ly * element.scale;
        return project(element.x + sx * cos - sy * sin, element.y + sx * sin + sy * cos, z);
      });
      poly(corners, element.layer, true);
    }
  }
  for (const figure of frame.figures) {
    const z = layerZ(figure.layer, frame.viewport);
    const t = figure.transform;
    const at = (x: number, y: number): string => project(t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f, z);
    if (figure.kind === 'shape') {
      if (figure.bleed) continue;
      for (const line of figure.outline) poly(line.points.map((p) => at(p.x, p.y)), figure.layer, line.closed);
    } else if (figure.kind === 'sprite') {
      const w = (figure.cols * figure.cell) / 2;
      const h = (figure.rows * figure.cell) / 2;
      poly([at(-w, -h), at(w, -h), at(w, h), at(-w, h)], figure.layer, true);
    } else {
      const { box } = figure;
      poly([at(box.x, box.y), at(box.x + box.width, box.y), at(box.x + box.width, box.y + box.height), at(box.x, box.y + box.height)], figure.layer, true);
    }
  }
}

function render(): Frame {
  const frame = buildFrame();
  lastFrame = frame;
  renderer.render(frame);
  drawOverlay(frame);
  return frame;
}

function layout(): void {
  viewport = currentViewport();
  stageBox.style.width = `${viewport.width}px`;
  stageBox.style.height = `${viewport.height}px`;
  if (mounted) renderer.resize(viewport);
  render();
}

function tick(now: number): void {
  if (lastTick > 0) {
    frameTimes.push(now - lastTick);
    if (frameTimes.length > 900) frameTimes.shift();
  }
  lastTick = now;
  fpsCount++;
  if (now - fpsWindowStart >= 500) {
    fpsLabel.textContent = `${((fpsCount * 1000) / (now - fpsWindowStart)).toFixed(1)} fps  ${renderer.probe().pixelRatio}x`;
    fpsWindowStart = now;
    fpsCount = 0;
  }
  if (state.animate || state.sweep || state.field !== 'none') {
    state.ambient = (now - startedAt) / 1000 + 3;
    render();
  }
  requestAnimationFrame(tick);
}

function colours(x: number, y: number, width: number, height: number): [string, number][] {
  const frame = lastFrame ?? render();
  renderer.render(frame);
  const probe = renderer.probe();
  const ratio = probe.pixelRatio;
  const px = Math.max(0, Math.floor(x * ratio));
  const py = Math.max(0, Math.floor(y * ratio));
  const pw = Math.max(1, Math.floor(width * ratio));
  const ph = Math.max(1, Math.floor(height * ratio));
  const data = probe.read(px, py, pw, ph);
  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = `#${[data[i], data[i + 1], data[i + 2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 400);
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/** A painting to stand in for the image model's: bands of colour with soft blobs, made here so no request leaves the page. */
async function makePainting(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  const sky = context.createLinearGradient(0, 0, 0, 400);
  sky.addColorStop(0, '#f2a65a');
  sky.addColorStop(0.55, '#f7d9a0');
  sky.addColorStop(0.56, '#3b6ea5');
  sky.addColorStop(1, '#16324f');
  context.fillStyle = sky;
  context.fillRect(0, 0, 600, 400);
  context.fillStyle = '#c0392b';
  context.beginPath();
  context.arc(420, 150, 52, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#2c3e2f';
  for (let i = 0; i < 6; i++) {
    context.beginPath();
    context.moveTo(40 + i * 40, 224);
    context.lineTo(70 + i * 40, 150 - (i % 3) * 20);
    context.lineTo(100 + i * 40, 224);
    context.fill();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('no painting');
  return URL.createObjectURL(blob);
}

async function rasterise(options: { maxSide?: number; mime?: 'image/png' | 'image/jpeg'; quality?: number; fx?: boolean }): Promise<{ width: number; height: number; ms: number; bytes: number; url: string } | null> {
  const frame = lastFrame ?? render();
  const start = performance.now();
  const blob = await renderer.rasterise(frame, { maxSide: options.maxSide ?? 768, mime: options.mime ?? 'image/jpeg', quality: options.quality ?? 0.7, fx: options.fx ?? true });
  const ms = performance.now() - start;
  if (blob === null) return null;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  await image.decode();
  shotBox.replaceChildren(image);
  image.style.cssText = 'max-width:380px;max-height:260px;display:block';
  shotBox.style.display = 'block';
  return { width: image.naturalWidth, height: image.naturalHeight, ms, bytes: blob.size, url };
}

/** The real cost of a frame, with the GPU waited for: render, then read one pixel back. This is what a frame budget has to cover, unlike the browser's refresh interval, which waits for the screen. */
function cost(frames: number): { p50: number; p95: number; max: number; mean: number } {
  const times: number[] = [];
  const start = state.ambient;
  for (let i = 0; i < frames; i++) {
    state.ambient = start + i / 60;
    const began = performance.now();
    render();
    renderer.probe().read(0, 0, 1, 1);
    times.push(performance.now() - began);
  }
  state.ambient = start;
  return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: Math.max(...times), mean: times.reduce((a, c) => a + c, 0) / times.length };
}

/** One clipped fixture, drawn and counted. */
interface ClipResult {
  readonly look: LookId;
  readonly kind: ClipKind;
  readonly layer: Layer;
  readonly screen: string;
  readonly camera: string;
  /** pixels inside the frame that differ from the empty stage: the thing really was drawn */
  readonly inside: number;
  /** pixels outside the frame (its edge widened by one device pixel) that differ from the empty stage: what leaked */
  readonly outside: number;
}

async function decode(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Row 14: a thing much larger than its frame, kept inside it, in every look, kind and layer, at both screens and with the
 * camera moved. The picture is taken with the look's surface off (`fx: false`), so the count is the frame's own: a
 * look's glow or grain is not the clip's to hold. Each picture is compared pixel for pixel with the empty stage.
 * `sheet` also lays the first look's pictures out on the page, to be looked at.
 */
async function clipCheck(looks: readonly LookId[], screens: readonly Viewport[], sheet: boolean, control = false): Promise<ClipResult[]> {
  const out: ClipResult[] = [];
  const cameras: { readonly name: string; readonly pose: CameraPose }[] = [
    { name: 'rest', pose: REST_POSE },
    { name: 'moved', pose: { ...REST_POSE, x: 40, y: -18, dolly: 90 } },
  ];
  const tiles: { readonly label: string; readonly canvas: HTMLCanvasElement }[] = [];
  const probeChart = (key: string): HTMLCanvasElement | null => {
    // The engine's still, stood in for: solid, so that every pixel of it that shows is a pixel the frame let through.
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const context = canvas.getContext('2d');
    if (context === null || key === '') return null;
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, 400, 300);
    return canvas;
  };
  for (const screen of screens) {
    for (const look of looks) {
      for (const camera of cameras) {
        for (const kind of CLIP_KINDS) {
          for (const layer of ['bg', 'mid', 'fg'] as const) {
            if (layer !== 'mid' && !(kind === 'fill' || kind === 'text' || kind === 'picture')) continue;
            const fixture = clipFixture(look, screen, camera.pose, kind, layer, pictureUrl);
            const clip = fixture.clip;
            // The control: the same things with their frames taken off. If this does not leak, the count above means nothing.
            const frame: Frame = control
              ? {
                  ...fixture.frame,
                  elements: fixture.frame.elements.map(({ clip: _f, ...rest }) => rest),
                  figures: fixture.frame.figures.map((figure) => {
                    const { clip: _f, ...rest } = figure;
                    return rest;
                  }),
                  ...(fixture.frame.charts === undefined ? {} : { charts: fixture.frame.charts.map(({ clip: _f, ...rest }) => rest) }),
                }
              : fixture.frame;
            const empty: Frame = { ...frame, elements: [], figures: [], charts: [] };
            const maxSide = Math.max(screen.width, screen.height) * screen.dpr;
            const options = { maxSide, mime: 'image/png' as const, fx: false, chartStill: probeChart };
            const [shot, none] = await Promise.all([renderer.rasterise(frame, options), renderer.rasterise(empty, options)]);
            if (shot === null || none === null) throw new Error('the renderer cannot take a picture');
            const [a, b] = await Promise.all([decode(shot), decode(none)]);
            const scale = a.width / screen.width;
            const quad = planeQuad(clip, layer, camera.pose, screen);
            const left = Math.min(...quad.map((p) => p.x)) * scale - 1;
            const right = Math.max(...quad.map((p) => p.x)) * scale + 1;
            const top = Math.min(...quad.map((p) => p.y)) * scale - 1;
            const bottom = Math.max(...quad.map((p) => p.y)) * scale + 1;
            let inside = 0;
            let outside = 0;
            for (let y = 0; y < a.height; y++) {
              for (let x = 0; x < a.width; x++) {
                const i = (y * a.width + x) * 4;
                const same = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) <= 3 && Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) <= 3 && Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)) <= 3;
                if (same) continue;
                if (x + 0.5 >= left && x + 0.5 <= right && y + 0.5 >= top && y + 0.5 <= bottom) inside++;
                else outside++;
              }
            }
            out.push({ look, kind, layer, screen: `${screen.width}x${screen.height}`, camera: camera.name, inside, outside });
            if (sheet && look === looks[0] && layer === 'mid') {
              const tile = document.createElement('canvas');
              tile.width = a.width;
              tile.height = a.height;
              const context = tile.getContext('2d');
              context?.putImageData(a, 0, 0);
              if (context !== null) {
                context.strokeStyle = '#00e5ff';
                context.lineWidth = 1;
                context.setLineDash([4, 3]);
                context.strokeRect(left + 1, top + 1, right - left - 2, bottom - top - 2);
              }
              tiles.push({ label: `${look} ${kind} ${camera.name}`, canvas: tile });
            }
          }
        }
      }
    }
  }
  if (sheet) {
    const box = document.createElement('div');
    box.id = 'clip-sheet';
    box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:20;background:#111;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;padding:6px';
    for (const tile of tiles) {
      const cell = document.createElement('figure');
      cell.style.cssText = 'margin:0;color:#ccc;font:11px monospace';
      tile.canvas.style.cssText = `width:${Math.min(300, screens[0]?.width ?? 300)}px;display:block`;
      cell.append(tile.canvas, tile.label);
      box.append(cell);
    }
    document.body.append(box);
  }
  return out;
}

/**
 * The same count on the live canvas, with the look's surface ON. The clip is a geometric fact about what the stage draws;
 * a look's glow, halation or curved glass then moves light across the frame's edge on purpose. This says how far and how
 * much: `outside` counts pixels more than `guard` device pixels outside the frame that differ from the empty stage.
 */
async function clipLive(looks: readonly LookId[], guard: number): Promise<{ look: LookId; kind: ClipKind; outside: number; inside: number }[]> {
  const out: { look: LookId; kind: ClipKind; outside: number; inside: number }[] = [];
  const screen = viewport;
  for (const look of looks) {
    for (const kind of CLIP_KINDS) {
      if (kind === 'chart') continue;
      const { frame, clip } = clipFixture(look, screen, REST_POSE, kind, 'mid', pictureUrl);
      const empty: Frame = { ...frame, elements: [], figures: [] };
      const grab = async (shown: Frame): Promise<Uint8Array> => {
        renderer.reset();
        renderer.render(shown);
        for (let i = 0; i < 100 && !renderer.probe().settled; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          renderer.render(shown);
        }
        const probe = renderer.probe();
        const canvas = probe.canvas;
        return probe.read(0, 0, canvas?.width ?? 1, canvas?.height ?? 1);
      };
      const a = await grab(frame);
      const b = await grab(empty);
      const width = renderer.probe().canvas?.width ?? 1;
      const scale = width / screen.width;
      const quad = planeQuad(clip, 'mid', REST_POSE, screen);
      const left = Math.min(...quad.map((p) => p.x)) * scale - guard;
      const right = Math.max(...quad.map((p) => p.x)) * scale + guard;
      const top = Math.min(...quad.map((p) => p.y)) * scale - guard;
      const bottom = Math.max(...quad.map((p) => p.y)) * scale + guard;
      let inside = 0;
      let outside = 0;
      const height = a.length / 4 / width;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) <= 3 && Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) <= 3 && Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) <= 3) continue;
          // probe.read is bottom-up: the row is flipped
          const row = height - 1 - y;
          if (x + 0.5 >= left && x + 0.5 <= right && row + 0.5 >= top && row + 0.5 <= bottom) inside++;
          else outside++;
        }
      }
      out.push({ look, kind, outside, inside });
    }
  }
  return out;
}

/** The vector drawing of the same fixtures, drawn by the browser and counted like the pictures: nothing of a framed thing outside its frame in the file. */
async function clipSvg(looks: readonly LookId[], screen: Viewport): Promise<{ look: LookId; kind: ClipKind; layer: Layer; inside: number; outside: number }[]> {
  const out: { look: LookId; kind: ClipKind; layer: Layer; inside: number; outside: number }[] = [];
  const chartStill = (): HTMLCanvasElement | null => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 30;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, 40, 30);
    return canvas;
  };
  const draw = async (frame: Frame): Promise<ImageData> => {
    const svg = await frameToSvg(frame, { width: screen.width, height: screen.height }, renderer.fontFile, chartStill);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = new OffscreenCanvas(screen.width, screen.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.drawImage(image, 0, 0);
    URL.revokeObjectURL(url);
    return context.getImageData(0, 0, screen.width, screen.height);
  };
  for (const look of looks) {
    for (const kind of CLIP_KINDS) {
      for (const layer of ['bg', 'mid', 'fg'] as const) {
        if (layer !== 'mid' && !(kind === 'fill' || kind === 'text')) continue;
        if (kind === 'medium') continue;
        const { frame, clip } = clipFixture(look, screen, { ...REST_POSE, x: 40, y: -18, dolly: 90 }, kind, layer, pictureUrl);
        const a = await draw(frame);
        const b = await draw({ ...frame, elements: [], figures: [], charts: [] });
        const quad = planeQuad(clip, layer, frame.camera, screen);
        const left = Math.min(...quad.map((p) => p.x)) - 1;
        const right = Math.max(...quad.map((p) => p.x)) + 1;
        const top = Math.min(...quad.map((p) => p.y)) - 1;
        const bottom = Math.max(...quad.map((p) => p.y)) + 1;
        let inside = 0;
        let outside = 0;
        for (let y = 0; y < a.height; y++) {
          for (let x = 0; x < a.width; x++) {
            const i = (y * a.width + x) * 4;
            if (Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) <= 3 && Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) <= 3 && Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)) <= 3) continue;
            if (x + 0.5 >= left && x + 0.5 <= right && y + 0.5 >= top && y + 0.5 <= bottom) inside++;
            else outside++;
          }
        }
        out.push({ look, kind, layer, inside, outside });
      }
    }
  }
  return out;
}

let plain: { readonly renderer: Renderer; readonly host: HTMLElement } | null = null;

/**
 * Shows a clip fixture in the plain (DOM) renderer over the whole page, or the empty stage, for a screenshot to be taken and
 * counted from outside: the plain renderer cannot take a picture of itself. Returns where the frame is on the screen.
 */
async function plainShow(look: LookId, kind: ClipKind, layer: Layer, empty: boolean, moved: boolean): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const screen = { width: innerWidth, height: innerHeight, dpr: 1 };
  if (plain === null) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:50;background:#000';
    document.body.append(host);
    const made = createPlainRenderer();
    await made.mount(host, screen, look);
    plain = { renderer: made, host };
  }
  const camera = moved ? { ...REST_POSE, x: 40, y: -18, dolly: 90 } : REST_POSE;
  const { frame, clip } = clipFixture(look, screen, camera, kind, layer, pictureUrl);
  plain.renderer.render(empty ? { ...frame, elements: [], figures: [] } : frame);
  const quad = planeQuad(clip, layer, camera, screen);
  return { left: Math.min(...quad.map((p) => p.x)), top: Math.min(...quad.map((p) => p.y)), right: Math.max(...quad.map((p) => p.x)), bottom: Math.max(...quad.map((p) => p.y)) };
}

interface Bench {
  plainShow: typeof plainShow;
  clipSvg: typeof clipSvg;
  clipLive: typeof clipLive;
  clipCheck: typeof clipCheck;
  renderer: ThreeRenderer;
  state: State;
  frame(): Frame | null;
  render(): Frame;
  set(patch: Partial<State>): Frame;
  pixels(x: number, y: number, width: number, height: number): [string, number][];
  probe(): ThreeProbe;
  settled(): Promise<void>;
  perf(): { frames: number; p50: number; p95: number; max: number };
  clearPerf(): void;
  rasterise: typeof rasterise;
  cost: typeof cost;
  readonly mountMs: number;
  ready: Promise<void>;
}

function rebuildPanel(): void {
  panel.replaceChildren(fpsLabel);
  const redo = (): void => {
    render();
  };
  select('look', [...LOOK_IDS, 'custom'], state.look, (v) => {
    state.look = v as Look;
    state.fx = null;
    rebuildPanel();
    redo();
  });
  if (state.look === 'custom') {
    select('face', ['serif', 'sans', 'hand', 'display', 'mono', 'terminal', 'teletext', 'dot'], state.customFace, (v) => {
      state.customFace = v as State['customFace'];
      redo();
    });
    row(
      'ground',
      add('input', (i) => {
        i.value = state.customGround;
        i.addEventListener('change', () => {
          state.customGround = i.value;
          redo();
        });
      }),
    );
    row(
      'ink',
      add('input', (i) => {
        i.value = state.customInk;
        i.addEventListener('change', () => {
          state.customInk = i.value;
          redo();
        });
      }),
    );
  }
  select('quality', ['full', 'lite'], state.quality, (v) => {
    state.quality = v as Quality;
    renderer.setQuality(state.quality);
    redo();
  });
  select('viewport', Object.keys(PRESETS), state.preset, (v) => {
    state.preset = v;
    layout();
  });
  select('content', ['text', 'figures', 'both', 'paint'], state.content, (v) => {
    state.content = v as State['content'];
    redo();
  });
  slider('truck x', -600, 600, 1, state.truck, (v) => {
    state.truck = v;
    redo();
  });
  slider('dolly', 0, 300, 1, state.dolly, (v) => {
    state.dolly = v;
    redo();
  });
  slider('yaw', -0.6, 0.6, 0.01, state.yaw, (v) => {
    state.yaw = v;
    redo();
  });
  slider('pitch', -0.4, 0.4, 0.01, state.pitch, (v) => {
    state.pitch = v;
    redo();
  });
  slider('roll', -0.3, 0.3, 0.01, state.roll, (v) => {
    state.roll = v;
    redo();
  });
  slider('agitation', 0, 1, 0.01, state.agitation, (v) => {
    state.agitation = v;
    redo();
  });
  slider('dim', 0, 1, 0.01, state.dim, (v) => {
    state.dim = v;
    redo();
  });
  slider('time', 0, 60, 0.1, state.ambient, (v) => {
    state.ambient = v;
    redo();
  });
  slider('stroke', 0.3, 10, 0.1, state.strokeWidth, (v) => {
    state.strokeWidth = v;
    redo();
  });
  slider('progress', 0, 1, 0.01, state.progress, (v) => {
    state.progress = v;
    redo();
  });
  slider('landed', 0, 9, 0.1, state.landed, (v) => {
    state.landed = v;
    redo();
  });
  slider('develop', 0, 1, 0.01, state.develop, (v) => {
    state.develop = v;
    redo();
  });
  select('mask', ['none', 'round', 'circle', 'soft', 'torn'], state.mask, (v) => {
    state.mask = v as Mask;
    redo();
  });
  select('stroke look', ['clean', 'pencil', 'marker', 'chalk', 'pixel'], state.character, (v) => {
    state.character = v as StrokeCharacter;
    redo();
  });
  select('field', ['none', ...AMBIENT_KINDS], state.field, (v) => {
    state.field = v as State['field'];
    redo();
  });
  select('field layer', ['far', 'bg', 'mid', 'fg'], state.fieldLayer, (v) => {
    state.fieldLayer = v as Layer;
    redo();
  });
  slider('density', 0, 1, 0.01, state.density, (v) => {
    state.density = v;
    redo();
  });
  toggle('reduced motion', state.reduced, (v) => {
    state.reduced = v;
    redo();
  });
  toggle('waiting', state.waiting, (v) => {
    state.waiting = v;
    redo();
  });
  toggle('animate', state.animate, (v) => {
    state.animate = v;
    startedAt = performance.now() - (state.ambient - 3) * 1000;
    redo();
  });
  toggle('sweep progress', state.sweep, (v) => {
    state.sweep = v;
    startedAt = performance.now() - (state.ambient - 3) * 1000;
    redo();
  });
  toggle('painting', state.picture, (v) => {
    state.picture = v;
    redo();
  });
  toggle('outlines', state.overlay, (v) => {
    state.overlay = v;
    redo();
  });
  panel.append(add('div', (d) => (d.textContent = 'effects (amount)')));
  const amounts = new Map(currentSpec().fx.map((setting) => [setting.name, setting.amount]));
  for (const name of FX_NAMES) {
    slider(name, 0, 1, 0.05, state.fx?.[name] ?? amounts.get(name) ?? 0, (v) => {
      const next: Partial<Record<FxName, number>> = state.fx ?? Object.fromEntries(currentSpec().fx.map((setting) => [setting.name, setting.amount]));
      next[name] = v;
      state.fx = next;
      redo();
    });
  }
  panel.append(
    add('button', (b) => {
      b.textContent = 'reset trail';
      b.addEventListener('click', () => renderer.reset());
    }),
    add('button', (b) => {
      b.textContent = 'rasterise';
      b.addEventListener('click', () => {
        void rasterise({});
      });
    }),
    add('button', (b) => {
      b.textContent = 'rasterise (no fx)';
      b.addEventListener('click', () => {
        void rasterise({ fx: false });
      });
    }),
  );
}

const ready = (async (): Promise<void> => {
  viewport = currentViewport();
  stageBox.style.width = `${viewport.width}px`;
  stageBox.style.height = `${viewport.height}px`;
  const mountStart = performance.now();
  await renderer.mount(stageBox, viewport, state.look === 'custom' ? 'night' : state.look);
  mountMs = performance.now() - mountStart;
  stageBox.append(outline);
  mounted = true;
  renderer.setQuality(state.quality);
  try {
    pictureUrl = await makePainting();
    await renderer.preload(pictureUrl);
  } catch {
    pictureUrl = null;
  }
  rebuildPanel();
  render();
  startedAt = performance.now();
  requestAnimationFrame(tick);
})();

const bench: Bench = {
  renderer,
  state,
  frame: () => lastFrame,
  render,
  set(patch) {
    Object.assign(state, patch);
    if (patch.quality !== undefined) renderer.setQuality(patch.quality);
    if (patch.preset !== undefined) layout();
    return render();
  },
  pixels: colours,
  probe: () => renderer.probe(),
  async settled() {
    for (let i = 0; i < 200; i++) {
      render();
      if (renderer.probe().settled) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  },
  perf: () => ({ frames: frameTimes.length, p50: percentile(frameTimes, 0.5), p95: percentile(frameTimes, 0.95), max: Math.max(0, ...frameTimes) }),
  clearPerf: () => {
    frameTimes.length = 0;
  },
  clipCheck,
  clipLive,
  clipSvg,
  plainShow,
  rasterise,
  cost,
  get mountMs() {
    return mountMs;
  },
  ready,
};
(window as unknown as { __bench: Bench }).__bench = bench;

addEventListener('resize', () => {
  if (state.preset === 'window') layout();
});
