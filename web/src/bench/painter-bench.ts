// Entry for bench-painter.html: the painter on the plain renderer with no
// server. Plays a fixture script from @conduit/language/demos locally.

import { LineNormalizer, LineReader, LOOK_IDS, parseReplayDirective } from '@conduit/language';
import { fitIn } from '../painter/canvas';
import type { BackEvent, CanvasName, Line, LookId } from '@conduit/language';
import charts from '@conduit/language/demos/charts.series?raw';
import diagrams from '@conduit/language/demos/diagrams.series?raw';
import explorable from '@conduit/language/demos/explorable.series?raw';
import overture from '@conduit/language/demos/overture.series?raw';
import plainly from '@conduit/language/demos/plainly.series?raw';
import sketchbook from '@conduit/language/demos/sketchbook.series?raw';
import styles from '@conduit/language/demos/styles.series?raw';
import titles from '@conduit/language/demos/titles.series?raw';
import type { Frame } from '../contracts/frame';
import type { RasteriseOptions, Renderer } from '../contracts/renderer';
import { planeScale } from '../contracts/space';
import type { Painter, PainterUpload, TranscriptEvent } from '../contracts/painter';
import { createPainter } from '../painter';
import { createChartHost } from '../app/chart-host';
import { createChartEngine } from '../render/chart';
import { createPlainRenderer } from '../render/plain';
import { createThreeRenderer } from '../render/three';

declare global {
  interface Window {
    __painter?: Painter;
    __back?: BackEvent[];
    __backLog?: BackEvent[];
    __transcript?: TranscriptEvent[];
    /** starts a script as the buttons do */
    __bench?: {
      play: (script: string) => void;
      settings: () => Settings;
      /** opens a turn by hand; `send` then adds one raw Series line to it and `end` closes it */
      open: () => void;
      send: (raw: string) => void;
      end: () => void;
      /** the pictures the painter sent for the server, newest last */
      uploads: () => { kind: string; key: string; bytes: number }[];
      /** tries raw Series lines as a fix on the open hand-made turn (`tryCandidate`); the answer is a `draft` in `__backLog` and a picture in `draftPicture` */
      candidate: (pass: number, raws: readonly string[]) => void;
      /** the newest draft picture sent, base64 JPEG, or null */
      draftPicture: () => Promise<string | null>;
    };
    __uploads?: PainterUpload[];
    /** the frame the renderer was last given */
    __frame?: Frame;
  }
}

interface Settings {
  script: string;
  look: LookId | 'none';
  reduced: boolean;
  paced: boolean;
  preset: string;
  renderer: string;
  paint: boolean;
}

const SCRIPTS: Readonly<Record<string, string>> = { overture, sketchbook, plainly, titles, styles, explorable, diagrams, charts };
const PRESETS: Readonly<Record<string, { width: number; height: number }>> = {
  '375x667': { width: 375, height: 667 },
  '390x844': { width: 390, height: 844 },
  '1280x720': { width: 1280, height: 720 },
  '1440x900': { width: 1440, height: 900 },
};
/** About a streaming model: a short pause per line plus the time to write its characters. */
const PACED_LINE_MS = 150;
const PACED_CHARS_PER_SECOND = 60;

const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #101010; color: #ddd; font: 13px/1.4 ui-monospace, Menlo, monospace; }
  #app { display: grid; grid-template-columns: 300px 1fr; gap: 16px; padding: 12px; align-items: start; }
  #panel { display: flex; flex-direction: column; gap: 8px; }
  #panel label { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  #panel select, #panel button, #panel input[type=range] { font: inherit; }
  #panel button, #panel select { min-height: 28px; }
  #panel input[type=range] { width: 100%; }
  .stage__charts { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 1; }
  .stage__chart { position: absolute; left: 0; top: 0; transform-origin: 0 0; touch-action: none; }
  #host { position: relative; border: 1px solid #444; overflow: hidden; background: #000; cursor: default; }
  #outline { position: absolute; border: 1px dashed #f0f; pointer-events: none; z-index: 50; display: none; }
  #sketches { display: flex; gap: 6px; flex-wrap: wrap; }
  #sketches img { max-width: 140px; border: 1px solid #555; background: #222; }
  pre { margin: 0; padding: 6px; background: #181818; border: 1px solid #333; max-height: 260px; overflow: auto; white-space: pre-wrap; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  @media (max-width: 800px) { #app { grid-template-columns: 1fr; } }
`;
document.head.appendChild(style);

const app = document.getElementById('app');
if (app === null) throw new Error('bench-painter.html has no #app');

const panel = document.createElement('div');
panel.id = 'panel';
const stage = document.createElement('div');
const host = document.createElement('div');
host.id = 'host';
stage.appendChild(host);
app.append(panel, stage);

function control<T extends HTMLElement>(label: string, element: T): T {
  const row = document.createElement('label');
  row.append(label, element);
  panel.appendChild(row);
  return element;
}

function select(options: readonly string[]): HTMLSelectElement {
  const el = document.createElement('select');
  for (const option of options) el.add(new Option(option, option));
  return el;
}

function checkbox(): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  return el;
}

function button(text: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = text;
  return el;
}

const scriptSelect = control('script', select(Object.keys(SCRIPTS)));
const lookSelect = control('look lock', select(['none', ...LOOK_IDS]));
const rendererSelect = control('renderer', select(['plain', 'three']));
const paintBox = control('server can paint', checkbox());
const outlineBox = control('canvas outline', checkbox());
const canvasSelect = control('outline canvas', select(['wide', 'square', 'tall']));
const presetSelect = control('viewport', select(Object.keys(PRESETS)));
presetSelect.value = '1280x720';
const reducedBox = control('reduced motion', checkbox());
const pacedBox = control('arrive paced', checkbox());
const row = document.createElement('div');
row.className = 'row';
const startButton = button('start');
const playButton = button('pause');
const stopButton = button('stop');
const showAllButton = button('show all');
const anticipateButton = button('anticipate');
const cancelButton = button('cancel');
row.append(startButton, playButton, stopButton, showAllButton, anticipateButton, cancelButton);
panel.appendChild(row);
const paintingsRow = document.createElement('div');
paintingsRow.className = 'row';
const readyButton = button('picture ready');
const unpaintedButton = button('picture unpainted');
paintingsRow.append(readyButton, unpaintedButton);
panel.appendChild(paintingsRow);
const sketches = document.createElement('div');
sketches.id = 'sketches';
panel.appendChild(sketches);
const seekInput = control('seek', document.createElement('input'));
seekInput.type = 'range';
seekInput.min = '0';
seekInput.max = '60';
seekInput.step = '0.05';
seekInput.value = '0';
const readout = document.createElement('pre');
const transcriptOut = document.createElement('pre');
const backOut = document.createElement('pre');
panel.append(readout, transcriptOut, backOut);

let renderer: Renderer = createPlainRenderer();
let painter: Painter | null = null;
let unsubscribe: (() => void)[] = [];
let timers: number[] = [];
let sequence = 0;
let turnCounter = 0;
let autoId = 0;
const reader = new LineReader();
const normalizer = new LineNormalizer(() => `x${(autoId += 1)}`);
const transcript: TranscriptEvent[] = [];
window.__back = [];
window.__backLog = [];
window.__transcript = transcript;
window.__uploads = [];

function settings(): Settings {
  return {
    script: scriptSelect.value,
    look: lookSelect.value as LookId | 'none',
    reduced: reducedBox.checked,
    paced: pacedBox.checked,
    preset: presetSelect.value,
    renderer: rendererSelect.value,
    paint: paintBox.checked,
  };
}

function viewport(): { width: number; height: number; dpr: number } {
  const preset = PRESETS[presetSelect.value] ?? { width: 1280, height: 720 };
  return { ...preset, dpr: window.devicePixelRatio || 1 };
}

function sizeHost(): void {
  const v = viewport();
  host.style.width = `${v.width}px`;
  host.style.height = `${v.height}px`;
}

function clearTimers(): void {
  for (const timer of timers) window.clearTimeout(timer);
  timers = [];
}

function build(): Painter {
  clearTimers();
  for (const off of unsubscribe) off();
  unsubscribe = [];
  painter?.dispose();
  transcript.length = 0;
  const v = viewport();
  const engine = createChartEngine();
chartHost?.dispose();
const charts = engine === null ? null : (chartHost = createChartHost({ engine, stage: host, access: { root: host, controls: () => undefined, charts: () => undefined, focusControl: () => undefined, dispose: () => undefined } }));
  const next = createPainter({
    renderer,
    viewport: v,
    lockLook: lookSelect.value === 'none' ? null : (lookSelect.value as LookId),
    reducedMotion: reducedBox.checked,
    pointer: 'fine',
    charts,
  });
  unsubscribe.push(
    next.on('back', (event) => {
      const recent = window.__back ?? [];
      recent.push(event);
      if (recent.length > 10) recent.shift();
      window.__back = recent;
      window.__backLog?.push(event);
    }),
    next.on('transcript', (event) => {
      transcript.push(event);
      if (transcript.length > 400) transcript.shift();
    }),
    next.on('upload', (event) => {
      window.__uploads?.push(event);
      const image = document.createElement('img');
      image.src = URL.createObjectURL(event.blob);
      image.title = `${event.kind} ${event.kind === 'sketch' ? event.key : event.turn}`;
      sketches.appendChild(image);
      while (sketches.children.length > 6) sketches.firstElementChild?.remove();
    }),
  );
  next.setServices({ paint: paintBox.checked, sight: 'snapshot', review: false });
  painter = next;
  window.__painter = next;
  return next;
}

function play(script: string): void {
  const source = SCRIPTS[script];
  if (source === undefined) return;
  const current = painter ?? build();
  current.interrupt();
  clearTimers();
  turnCounter += 1;
  const turn = `bench-${turnCounter}`;
  current.openTurn(turn, { kind: 'demo', script });
  const paced = pacedBox.checked;
  let delay = 0;
  for (const raw of source.split('\n')) {
    const directive = parseReplayDirective(raw);
    if (directive !== null) {
      delay += directive.seconds * 1000;
      continue;
    }
    const parsed = reader.read(raw);
    if (parsed.kind !== 'line') continue;
    const line = normalizer.normalize(parsed.line).line;
    if (line === null) continue;
    sequence += 1;
    const seq = sequence;
    if (!paced) {
      current.ingest(turn, seq, line);
      continue;
    }
    delay += PACED_LINE_MS + (raw.length / PACED_CHARS_PER_SECOND) * 1000;
    timers.push(window.setTimeout(() => current.ingest(turn, seq, line), delay));
  }
  if (paced) timers.push(window.setTimeout(() => current.closeTurn(turn, 'done'), delay + PACED_LINE_MS));
  else current.closeTurn(turn, 'done');
  playButton.textContent = 'pause';
}

startButton.addEventListener('click', () => play(scriptSelect.value));
playButton.addEventListener('click', () => {
  if (painter === null) return;
  if (painter.snapshot().clock === 'paused') {
    painter.play();
    playButton.textContent = 'pause';
  } else {
    painter.pause();
    playButton.textContent = 'play';
  }
});
stopButton.addEventListener('click', () => {
  clearTimers();
  painter?.interrupt();
});
seekInput.addEventListener('input', () => {
  painter?.seek(Number(seekInput.value));
  playButton.textContent = 'play';
});
presetSelect.addEventListener('change', () => {
  sizeHost();
  painter?.resize(viewport());
  renderer.resize(viewport());
});
lookSelect.addEventListener('change', build);
paintBox.addEventListener('change', () => painter?.setServices({ paint: paintBox.checked, sight: 'snapshot', review: false }));
showAllButton.addEventListener('click', () => painter?.showAll());
anticipateButton.addEventListener('click', () => {
  const choice = painter?.snapshot().elements.find((element) => element.tappable);
  painter?.anticipate({ kind: 'prompt', text: 'by hand' }, choice?.key ?? null);
});
cancelButton.addEventListener('click', () => painter?.cancelAnticipation());

/** A local picture to stand in for a painting: a soft gradient with a ring. */
function localPainting(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext('2d');
  if (g === null) return Promise.reject(new Error('no 2d context'));
  const sky = g.createLinearGradient(0, 0, 0, 360);
  sky.addColorStop(0, '#f7b267');
  sky.addColorStop(1, '#3d5a80');
  g.fillStyle = sky;
  g.fillRect(0, 0, 640, 360);
  g.fillStyle = '#ffe9b0';
  g.beginPath();
  g.arc(480, 110, 50, 0, Math.PI * 2);
  g.fill();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error('no blob')) : resolve(URL.createObjectURL(blob))), 'image/png'));
}
function pictureKeys(): string[] {
  return (painter?.snapshot().elements ?? []).filter((element) => element.kind === 'picture').map((element) => element.key);
}
readyButton.addEventListener('click', () => {
  void localPainting().then((url) => {
    for (const key of pictureKeys()) painter?.assetArrived(key, 'ready', url);
  });
});
unpaintedButton.addEventListener('click', () => {
  for (const key of pictureKeys()) painter?.assetArrived(key, 'skipped', null);
});
rendererSelect.addEventListener('change', () => {
  const next = rendererSelect.value;
  location.search = `?renderer=${next}&look=${lookSelect.value}&preset=${presetSelect.value}`;
});
reducedBox.addEventListener('change', build);

let chartHost: ReturnType<typeof createChartHost> | null = null;
const pointerAt = (phase: 'down' | 'move' | 'up' | 'cancel', event: PointerEvent): boolean => {
  const rect = host.getBoundingClientRect();
  return painter?.pointer({ phase, x: event.clientX - rect.left, y: event.clientY - rect.top, pointer: event.pointerId }) ?? false;
};
host.addEventListener('pointerdown', (event) => {
  if (pointerAt('down', event)) return;
  const rect = host.getBoundingClientRect();
  painter?.tapAt(event.clientX - rect.left, event.clientY - rect.top);
});
host.addEventListener('pointermove', (event) => void pointerAt('move', event));
host.addEventListener('pointerup', (event) => void pointerAt('up', event));
host.addEventListener('pointercancel', (event) => void pointerAt('cancel', event));
host.addEventListener('pointerleave', () => void painter?.pointer({ phase: 'move', x: -1e5, y: -1e5, pointer: 0 }));

let manual: string | null = null;
function open(): void {
  const current = painter ?? build();
  current.interrupt();
  clearTimers();
  turnCounter += 1;
  manual = `bench-${turnCounter}`;
  current.openTurn(manual, { kind: 'prompt', text: 'by hand' });
}
function send(raw: string): void {
  if (painter === null || manual === null) return;
  const parsed = reader.read(raw);
  if (parsed.kind !== 'line') return;
  const line = normalizer.normalize(parsed.line).line;
  if (line === null) return;
  sequence += 1;
  painter.ingest(manual, sequence, line);
}
function end(): void {
  if (painter !== null && manual !== null) painter.closeTurn(manual, 'done');
  manual = null;
}

function candidate(pass: number, raws: readonly string[]): void {
  if (painter === null || manual === null) return;
  const lines: Line[] = [];
  for (const raw of raws) {
    const parsed = reader.read(raw);
    if (parsed.kind !== 'line') continue;
    const line = normalizer.normalize(parsed.line).line;
    if (line !== null) lines.push(line);
  }
  painter.tryCandidate(manual, pass, lines);
}
async function draftPicture(): Promise<string | null> {
  const drafts = (window.__uploads ?? []).filter((upload) => upload.kind === 'draft');
  const last = drafts[drafts.length - 1];
  if (last === undefined) return null;
  const reader2 = new FileReader();
  return new Promise((resolve) => {
    reader2.onload = () => resolve(String(reader2.result).split(',')[1] ?? null);
    reader2.readAsDataURL(last.blob);
  });
}

window.__bench = {
  candidate,
  draftPicture,
  play,
  settings,
  open,
  send,
  end,
  uploads: () => (window.__uploads ?? []).map((upload) => ({ kind: upload.kind, key: upload.kind === 'sketch' ? upload.key : upload.turn, bytes: upload.blob.size })),
};

const outline = document.createElement('div');
outline.id = 'outline';
host.appendChild(outline);
function drawOutline(): void {
  if (painter === null || !outlineBox.checked) {
    outline.style.display = 'none';
    return;
  }
  const s = painter.snapshot();
  const v = viewport();
  // the outline is where the selected canvas would stand in the picture's region of the stage plan (the whole stage when nothing is drawn)
  const region = s.plan?.picture ?? null;
  const picture = region === null ? { x: -v.width / 2, y: -v.height / 2, width: v.width, height: v.height } : { x: region.x - v.width / 2, y: region.y - v.height / 2, width: region.width, height: region.height };
  const fit = fitIn(canvasSelect.value as CanvasName, picture, picture, v);
  outline.style.display = 'block';
  outline.style.left = `${v.width / 2 + fit.box.x}px`;
  outline.style.top = `${v.height / 2 + fit.box.y}px`;
  outline.style.width = `${fit.box.width}px`;
  outline.style.height = `${fit.box.height}px`;
}

function refresh(): void {
  if (painter === null) return;
  const s = painter.snapshot();
  readout.textContent = [
    `clock    ${s.clock}${s.hidden ? ' (hidden)' : ''}`,
    `playhead ${s.playhead.toFixed(2)}   pen ${s.pen.toFixed(2)}   lead ${s.lead.toFixed(2)}   end ${s.end.toFixed(2)}`,
    `look     ${s.look}${s.lookLocked ? ' (locked)' : ''}   scene ${s.scene.id} ${s.scene.layout} ${s.scene.mood} ${s.scene.pace}`,
    `fps      ${s.fps.toFixed(1)}   quality ${s.quality}   ${s.renderer}`,
    `screen   ${s.screen.cols}x${s.screen.rows}   elements ${s.elements.length}${s.anticipating ? '   anticipating' : ''}${s.showingAll ? '   showing all' : ''}`,
  ].join('\n');
  transcriptOut.textContent = transcript
    .slice(-12)
    .map((e) => (e.kind === 'shown' ? `shown  ${e.id}: ${e.text}` : e.kind === 'turn' ? `turn   ${e.turn}` : `${e.kind.padEnd(6)} ${e.key}`))
    .join('\n');
  backOut.textContent = (window.__back ?? []).map((e) => (e.type === 'progress' ? `progress ${e.playhead.toFixed(1)} ${e.clock} +${e.shown.length}/-${e.gone.length}` : e.type)).join('\n');
  drawOutline();
  seekInput.max = String(Math.max(1, Math.ceil(s.end)));
  if (document.activeElement !== seekInput) seekInput.value = String(s.playhead);
}

{
  const params = new URLSearchParams(location.search);
  const look = params.get('look');
  if (look !== null && (LOOK_IDS as readonly string[]).includes(look)) lookSelect.value = look;
  if (params.get('renderer') === 'three') {
    rendererSelect.value = 'three';
    renderer = createThreeRenderer();
  }
  if (params.get('paint') === '1') paintBox.checked = true;
  if (params.get('outline') === '1') outlineBox.checked = true;
  const preset = params.get('preset');
  if (preset !== null && preset in PRESETS) presetSelect.value = preset;
  if (params.get('reduced') === '1') reducedBox.checked = true;
}
sizeHost();
/** The plain renderer cannot capture; `?capture=1` lends it a 2D-canvas pen so the sketch a painting is asked to follow can be seen. */
function rasteriseWith2d(frame: Frame, options: RasteriseOptions): Promise<Blob | null> {
  const scale = options.maxSide / Math.max(frame.viewport.width, frame.viewport.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(frame.viewport.width * scale));
  canvas.height = Math.max(1, Math.round(frame.viewport.height * scale));
  const g = canvas.getContext('2d');
  if (g === null) return Promise.resolve(null);
  g.fillStyle = frame.ground;
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (const figure of frame.figures) {
    if (figure.kind !== 'shape') continue;
    const ps = planeScale(figure.layer, frame.viewport);
    g.save();
    g.setTransform(scale * ps, 0, 0, scale * ps, canvas.width / 2, canvas.height / 2);
    g.transform(figure.transform.a, figure.transform.b, figure.transform.c, figure.transform.d, figure.transform.e, figure.transform.f);
    g.globalAlpha = figure.opacity;
    g.beginPath();
    for (const line of figure.outline) {
      line.points.forEach((q, i) => (i === 0 ? g.moveTo(q.x, q.y) : g.lineTo(q.x, q.y)));
      if (line.closed) g.closePath();
    }
    if (figure.fill !== null) {
      g.globalAlpha = figure.opacity * figure.fill.opacity;
      g.fillStyle = figure.fill.colour;
      g.fill();
      g.globalAlpha = figure.opacity;
    }
    if (figure.stroke !== null) {
      g.lineWidth = figure.stroke.width;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = figure.stroke.colour;
      g.stroke();
    }
    g.restore();
  }
  return new Promise((resolve) => canvas.toBlob(resolve, options.mime));
}
if (new URLSearchParams(location.search).get('capture') === '1') {
  const plain = renderer;
  renderer = { ...plain, capabilities: { ...plain.capabilities, capture: true }, rasterise: (frame, options) => Promise.resolve(rasteriseWith2d(frame, options)) };
}
const drawFrame = renderer.render.bind(renderer);
renderer.render = (frame) => {
  window.__frame = frame;
  drawFrame(frame);
};
renderer
  .mount(host, viewport(), lookSelect.value === 'none' ? 'paper' : (lookSelect.value as LookId))
  .then(() => {
    build();
    window.setInterval(refresh, 100);
    const params = new URLSearchParams(location.search);
    const script = params.get('script');
    if (params.get('paced') === '1') pacedBox.checked = true;
    if (script !== null && script in SCRIPTS) {
      scriptSelect.value = script;
      play(script);
    }
  })
  .catch((error: unknown) => {
    readout.textContent = `renderer failed: ${String(error)}`;
  });
