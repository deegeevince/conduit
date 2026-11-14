// Works what an answer left on stage, the way a person would, through the REAL painter (not a re-implementation of it):
// every control is put at its two ends with a still taken at each, a button is pressed, and every chart is hovered and zoomed.
// What the painter says it can do comes from the same painter, so the brain the battery runs is taught exactly that.
//
// The harness page owns the renderer; this file owns nothing outside one `drive` call and leaves no painter behind.

import type { BackEvent, Capabilities, ControlValue, ControlValues, Line, StageBase } from '@conduit/language';
import type { ChartHost } from '../contracts/chart';
import type { Frame } from '../contracts/frame';
import type { ControlView, Painter } from '../contracts/painter';
import type { Renderer } from '../contracts/renderer';
import type { Viewport } from '../contracts/space';
import { createPainter } from '../painter';

export interface DriveRequest {
  readonly turn: string;
  readonly base: StageBase;
  readonly lines: readonly { readonly seq: number; readonly line: Line }[];
  /** the longer side of the pictures kept for the judge */
  readonly side: number;
}

export interface DrivenControl {
  readonly id: string;
  readonly kind: ControlView['control'];
  readonly label: string;
  readonly bound: boolean;
  /** a change the user commits becomes their next message (a button always does) */
  readonly send: boolean;
  /** the share of the picture's pixels that differ between its two ends; null for a button, or when no picture could be taken */
  readonly changed: number | null;
  /** a `control` event with this id was heard when its value was committed */
  readonly reported: boolean;
  /** words for the judge: what the control is and which end each picture is */
  readonly description: string;
  /** base64 PNGs of the stage with the control at its low end, then its high end; null for a button */
  readonly ends: readonly [string, string] | null;
}

export interface DrivenChart {
  readonly id: string;
  readonly kind: string;
  readonly crosshair: boolean;
  readonly zoomed: boolean;
  /** hovering and zooming sent no `control` event and opened no turn */
  readonly silent: boolean;
  readonly frameMs: { readonly median: number; readonly worst: number };
  readonly ticks: { readonly x: readonly string[]; readonly y: readonly string[] };
}

export interface DriveReply {
  readonly capabilities: Capabilities | null;
  readonly controls: readonly DrivenControl[];
  /** every control's value after the run, for an `act` turn's `values` */
  readonly values: ControlValues;
  /** the button the run pressed (the first), if the answer had one: what the next turn is told */
  readonly pressed: { readonly id: string; readonly text: string; readonly values: ControlValues } | null;
  readonly charts: readonly DrivenChart[];
  readonly fault: string | null;
}

const frames = (count: number): Promise<void> =>
  new Promise((done) => {
    const step = (left: number): void => {
      if (left <= 0) done();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Wraps a renderer so the frame the painter drew last can be taken as a picture, as the app does for `capture`. */
export function observed(renderer: Renderer): Renderer & { lastFrame(): Frame | null } {
  let last: Frame | null = null;
  return {
    id: renderer.id,
    capabilities: renderer.capabilities,
    mount: (host, viewport, look, options) => renderer.mount(host, viewport, look, options),
    resize: (viewport) => renderer.resize(viewport),
    render: (frame) => {
      last = frame;
      renderer.render(frame);
    },
    isDrawable: () => renderer.isDrawable(),
    reset: () => renderer.reset(),
    preload: (url) => renderer.preload(url),
    rasterise: (frame, options) => renderer.rasterise(frame, options),
    pick: (x, y) => renderer.pick(x, y),
    setQuality: (quality) => renderer.setQuality(quality),
    dispose: () => renderer.dispose(),
    lastFrame: () => last,
  };
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('could not read the picture'));
    reader.readAsDataURL(blob);
  });
}

async function pixelsOf(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context to compare pictures with');
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** The share of pixels whose colour differs by more than a little in any channel. */
export function differing(a: ImageData, b: ImageData): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) + Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) + Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (d > 24) count += 1;
  }
  return count / (a.width * a.height);
}

function describe(view: ControlView, low: string, high: string): string {
  const unit = view.unit === null ? '' : ` ${view.unit}`;
  switch (view.control) {
    case 'slider':
      return `A slider "${view.label}" from ${view.min} to ${view.max}${unit}. First picture: at ${low}. Second picture: at ${high}.`;
    case 'toggle':
      return `A toggle "${view.label}". First picture: off. Second picture: on.`;
    case 'pick':
      return `A choice of ${view.options.join(', ')}. First picture: "${low}". Second picture: "${high}".`;
    default:
      return `A ${view.control} "${view.label}".`;
  }
}

/** Where a control goes for each of its two ends. */
function endsOf(view: ControlView): readonly [ControlValue, ControlValue] | null {
  switch (view.control) {
    case 'slider':
      return [view.min, view.max];
    case 'toggle':
      return [false, true];
    case 'pick': {
      const first = view.options[0];
      const last = view.options[view.options.length - 1];
      return first === undefined || last === undefined || first === last ? null : [first, last];
    }
    default:
      return null;
  }
}

export interface DriveEnvironment {
  readonly renderer: Renderer;
  readonly viewport: Viewport;
  readonly charts: ChartHost | null;
}

/** What the painter at this viewport says it can do: the first `ready` it sends. */
export async function capabilitiesOf(env: DriveEnvironment): Promise<Capabilities | null> {
  const watched = observed(env.renderer);
  const painter = createPainter({ renderer: watched, viewport: env.viewport, lockLook: null, reducedMotion: true, pointer: 'fine', charts: env.charts });
  try {
    return await new Promise<Capabilities | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      painter.on('back', (event: BackEvent) => {
        if (event.type !== 'ready') return;
        clearTimeout(timer);
        resolve(event.capabilities);
      });
    });
  } finally {
    painter.dispose();
  }
}

export async function drive(env: DriveEnvironment, request: DriveRequest): Promise<DriveReply> {
  const watched = observed(env.renderer);
  const painter: Painter = createPainter({ renderer: watched, viewport: env.viewport, lockLook: null, reducedMotion: true, pointer: 'fine', charts: env.charts });
  const heard: BackEvent[] = [];
  let capabilities: Capabilities | null = null;
  painter.on('back', (event) => {
    heard.push(event);
    if (event.type === 'ready') capabilities = event.capabilities;
  });
  try {
    await frames(2);
    painter.openTurn(request.turn, { kind: 'prompt', text: '' });
    for (const { seq, line } of request.lines) painter.ingest(request.turn, seq, line);
    painter.closeTurn(request.turn, 'done');
    painter.showAll();
    // Let the answer come to rest: the turn closes, charts get their data and finish revealing.
    for (let waited = 0; waited < 60 && painter.snapshot().turn !== null; waited += 1) await sleep(100);
    await frames(6);

    const picture = async (): Promise<ImageData | null> => {
      await frames(3);
      const frame = watched.lastFrame();
      if (frame === null || !watched.capabilities.capture) return null;
      const blob = await watched.rasterise(frame, { maxSide: request.side, mime: 'image/png', chartStill: (key) => env.charts?.still(key) ?? null });
      return blob === null ? null : await pixelsOf(blob);
    };
    const encoded = async (): Promise<{ data: ImageData; png: string } | null> => {
      await frames(3);
      const frame = watched.lastFrame();
      if (frame === null || !watched.capabilities.capture) return null;
      const blob = await watched.rasterise(frame, { maxSide: request.side, mime: 'image/png', chartStill: (key) => env.charts?.still(key) ?? null });
      return blob === null ? null : { data: await pixelsOf(blob), png: await base64Of(blob) };
    };
    void picture;

    const controls: DrivenControl[] = [];
    let pressed: DriveReply['pressed'] = null;
    for (const view of painter.snapshot().controls) {
      const ends = endsOf(view);
      const heardBefore = heard.length;
      if (ends === null) {
        // A button, or a control with nothing to set: press it and see what the painter reports.
        if (view.control === 'button') {
          painter.setControl(view.id, null, true);
          await frames(2);
          const event = heard.slice(heardBefore).find((candidate): candidate is Extract<BackEvent, { type: 'control' }> => candidate.type === 'control' && candidate.id === view.id);
          if (pressed === null && event !== undefined) pressed = { id: view.id, text: event.text, values: {} };
          controls.push({ id: view.id, kind: view.control, label: view.label, bound: view.bound, send: true, changed: null, reported: event !== undefined && event.send, description: describe(view, '', ''), ends: null });
        }
        continue;
      }
      const [low, high] = ends;
      const resting = view.value;
      painter.setControl(view.id, low, false);
      const a = await encoded();
      painter.setControl(view.id, high, false);
      const b = await encoded();
      painter.setControl(view.id, high, true);
      await frames(2);
      const event = heard.slice(heardBefore).find((candidate) => candidate.type === 'control' && candidate.id === view.id);
      // Put it back where the answer left it, so the next control is worked on the answer's own picture.
      painter.setControl(view.id, resting, true);
      await frames(2);
      controls.push({
        id: view.id,
        kind: view.control,
        label: view.label,
        bound: view.bound,
        send: view.send,
        changed: a === null || b === null ? null : differing(a.data, b.data),
        reported: event !== undefined,
        description: describe(view, String(low), String(high)),
        ends: a === null || b === null ? null : [a.png, b.png],
      });
    }

    const values: Record<string, ControlValue> = {};
    for (const view of painter.snapshot().controls) if (view.value !== null) values[view.id] = view.value;
    if (pressed !== null) pressed = { ...pressed, values };

    const charts: DrivenChart[] = [];
    const host = env.charts;
    if (host !== null) {
      for (const view of painter.snapshot().charts) {
        const quiet = heard.length;
        const before = host.probe(view.key);
        let after = before;
        let hovered = before;
        try {
          hovered = await host.act(view.key, { hover: 0.5 });
          await host.act(view.key, { zoom: 2 });
          after = host.probe(view.key);
        } catch {
          // a chart that cannot be worked is recorded as one that did not work
        }
        const crosshair = hovered?.crosshair ?? null;
        charts.push({
          id: view.id,
          kind: view.kind,
          crosshair: crosshair !== null && crosshair.label.trim() !== '' && crosshair.values.length > 0 && crosshair.values.every((value) => value.trim() !== '' && !/NaN|undefined/.test(value)),
          zoomed: before !== null && after !== null && (after.from !== before.from || after.to !== before.to),
          silent: heard.slice(quiet).every((event) => event.type !== 'control') && painter.snapshot().turn === null,
          frameMs: after?.frameMs ?? { median: 0, worst: 0 },
          ticks: after?.ticks ?? { x: [], y: [] },
        });
        await host.act(view.key, { reset: true }).catch(() => undefined);
      }
    }
    return { capabilities, controls, values, pressed, charts, fault: painter.snapshot().fault };
  } finally {
    painter.dispose();
  }
}
