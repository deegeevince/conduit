// Works what an answer left on stage, the way a person would, through the REAL painter (not a re-implementation of it):
// every control is put at its two ends with a still taken at each, a button is pressed, and every chart is hovered and zoomed.
// What the painter says it can do comes from the same painter, so the brain the battery runs is taught exactly that.
//
// v2.1 (P0-2, P2-19). A pick is driven by its number, as the app drives it (`access.ts`), never by its words. A picture is taken only when
// nothing is easing: a toggle's ease is a quarter of a second, and a picture taken a tenth of the way through it shows a knob that has barely
// moved. A control's own redraw (its knob, its value) is masked out of the comparison, so a slider that moves its own handle and nothing else
// has not changed the picture.
//
// The harness page owns the renderer; this file owns nothing outside one `drive` call and leaves no painter behind.

import { settledFormulas } from '../render/formula/host';
import { BOUND_SECONDS } from '@conduit/language';
import type { BackEvent, Capabilities, ChartStageCheck, ControlValue, ControlValues, Line, LookId, StageBase } from '@conduit/language';
import type { ChartHost } from '../contracts/chart';
import type { Frame } from '../contracts/frame';
import type { ControlView, Painter } from '../contracts/painter';
import type { Renderer } from '../contracts/renderer';
import type { Box, Viewport } from '../contracts/space';
import { LOOKS } from '../looks';
import { createPainter } from '../painter';
import { cellOf } from '../painter/layout/metrics';
import { tickProblemsOf } from './ticks';

export interface DriveRequest {
  readonly turn: string;
  readonly base: StageBase;
  readonly lines: readonly { readonly seq: number; readonly line: Line }[];
  /** the longer side of the pictures kept for the judge */
  readonly side: number;
  /** the look the answer is worked in; absent or null: the one it chose */
  readonly look?: LookId | null;
}

export interface DrivenControl {
  readonly id: string;
  readonly kind: ControlView['control'];
  readonly label: string;
  readonly bound: boolean;
  /** a change the user commits becomes their next message (a button always does) */
  readonly send: boolean;
  /** the share of the picture's pixels that differ between its two ends, outside the boxes of the controls; null for a button, or when no picture could be taken */
  readonly changed: number | null;
  /** the share that differs inside them: what the knob and its value did on their own */
  readonly ownChanged: number | null;
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
  /** what the stage showed of it: type size, ticks, the plot's share of its room */
  readonly stage: ChartStageCheck;
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

export const frames = (count: number): Promise<void> =>
  new Promise((done) => {
    const step = (left: number): void => {
      if (left <= 0) done();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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

/** A rectangle of a picture, in its own pixels. */
export interface Mask {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The shares of the picture's pixels whose colour differs by more than a little in any channel: those outside every mask, and those inside
 * one. The first is the picture changing; the second is the controls redrawing themselves.
 */
export function differing(a: ImageData, b: ImageData, masks: readonly Mask[] = []): { readonly outside: number; readonly inside: number } {
  if (a.width !== b.width || a.height !== b.height) return { outside: 1, inside: 0 };
  let outside = 0;
  let inside = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const i = (y * a.width + x) * 4;
      const d = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) + Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) + Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
      if (d <= 24) continue;
      if (masks.some((mask) => x >= mask.x0 && x < mask.x1 && y >= mask.y0 && y < mask.y1)) inside += 1;
      else outside += 1;
    }
  }
  const area = a.width * a.height;
  return { outside: outside / area, inside: inside / area };
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

/** Where a control goes for each of its two ends, and what each is called. A pick takes its option's NUMBER, from 1: the painter holds nothing else. */
export function endsOf(view: ControlView): { readonly values: readonly [ControlValue, ControlValue]; readonly names: readonly [string, string] } | null {
  switch (view.control) {
    case 'slider':
      return { values: [view.min, view.max], names: [String(view.min), String(view.max)] };
    case 'toggle':
      return { values: [false, true], names: ['off', 'on'] };
    case 'pick': {
      const first = view.options[0];
      const last = view.options[view.options.length - 1];
      return first === undefined || last === undefined || view.options.length < 2 ? null : { values: [1, view.options.length], names: [first, last] };
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

/** Plays an answer into a painter as the app would and waits until it has come to rest: the turn closed, charts given their data and finished revealing. */
export async function playToRest(painter: Painter, request: Pick<DriveRequest, 'turn' | 'lines'>): Promise<void> {
  await frames(2);
  painter.openTurn(request.turn, { kind: 'prompt', text: '' });
  for (const { seq, line } of request.lines) painter.ingest(request.turn, seq, line);
  painter.closeTurn(request.turn, 'done');
  painter.showAll();
  for (let waited = 0; waited < 60 && painter.snapshot().turn !== null; waited += 1) await sleep(100);
  await frames(6);
}

/** Whether a probe carries a plot rectangle (the chart engine's extension of the contract); the share of the chart's room it takes, or null when it does not say. */
function plotShareOf(probe: unknown, room: Box): number | null {
  if (typeof probe !== 'object' || probe === null || !('plot' in probe)) return null;
  const plot = probe.plot;
  if (typeof plot !== 'object' || plot === null || !('width' in plot) || !('height' in plot)) return null;
  const { width, height } = plot;
  if (typeof width !== 'number' || typeof height !== 'number' || room.width <= 0 || room.height <= 0) return null;
  return Math.max(0, Math.min(1, (width * height) / (room.width * room.height)));
}

export async function drive(env: DriveEnvironment, request: DriveRequest): Promise<DriveReply> {
  const watched = observed(env.renderer);
  const painter: Painter = createPainter({ renderer: watched, viewport: env.viewport, lockLook: request.look ?? null, reducedMotion: true, pointer: 'fine', charts: env.charts });
  const heard: BackEvent[] = [];
  let capabilities: Capabilities | null = null;
  painter.on('back', (event) => {
    heard.push(event);
    if (event.type === 'ready') capabilities = event.capabilities;
  });
  try {
    await playToRest(painter, request);

    interface Taken {
      readonly data: ImageData;
      readonly png: string;
    }
    const encoded = async (): Promise<Taken | null> => {
      await settledFormulas();
      await frames(3);
      const frame = watched.lastFrame();
      if (frame === null || !watched.capabilities.capture) return null;
      const blob = await watched.rasterise(frame, { maxSide: request.side, mime: 'image/png', chartStill: (key) => env.charts?.still(key) ?? null });
      return blob === null ? null : { data: await pixelsOf(blob), png: await base64Of(blob) };
    };
    // A picture of the stage when nothing on it is easing. A bound change eases for BOUND_SECONDS, so wait that and half as long again, then
    // take pictures until two in a row are the same: whatever is still moving after that is the ambient (grain, a loop), which is not the control.
    const settledPicture = async (): Promise<Taken | null> => {
      await sleep(BOUND_SECONDS * 1500);
      let last = await encoded();
      for (let tries = 0; tries < 12 && last !== null; tries += 1) {
        await sleep(90);
        const next = await encoded();
        if (next === null) return last;
        const moved = differing(last.data, next.data);
        last = next;
        if (moved.outside + moved.inside < 0.0005) break;
      }
      return last;
    };

    const controls: DrivenControl[] = [];
    let pressed: DriveReply['pressed'] = null;
    const views = painter.snapshot().controls;
    for (const view of views) {
      const ends = endsOf(view);
      const heardBefore = heard.length;
      if (ends === null) {
        // A button, or a control with nothing to set: press it and see what the painter reports.
        if (view.control === 'button') {
          painter.setControl(view.id, null, true);
          await frames(2);
          const event = heard.slice(heardBefore).find((candidate): candidate is Extract<BackEvent, { type: 'control' }> => candidate.type === 'control' && candidate.id === view.id);
          if (pressed === null && event !== undefined) pressed = { id: view.id, text: event.text, values: {} };
          controls.push({ id: view.id, kind: view.control, label: view.label, bound: view.bound, send: true, changed: null, ownChanged: null, reported: event !== undefined && event.send, description: describe(view, '', ''), ends: null });
        }
        continue;
      }
      const [low, high] = ends.values;
      const resting = view.value;
      painter.setControl(view.id, low, false);
      const a = await settledPicture();
      painter.setControl(view.id, high, false);
      const b = await settledPicture();
      // The controls' own boxes, in the pictures' pixels: where a knob and its value redraw themselves.
      const scale = a === null ? 1 : a.data.width / env.viewport.width;
      const masks: Mask[] = painter.snapshot().controls.map((other) => ({ x0: Math.floor((other.box.x - 2) * scale), y0: Math.floor((other.box.y - 2) * scale), x1: Math.ceil((other.box.x + other.box.width + 2) * scale), y1: Math.ceil((other.box.y + other.box.height + 2) * scale) }));
      painter.setControl(view.id, high, true);
      await frames(2);
      const event = heard.slice(heardBefore).find((candidate) => candidate.type === 'control' && candidate.id === view.id);
      // Put it back where the answer left it, so the next control is worked on the answer's own picture.
      painter.setControl(view.id, resting, true);
      await frames(2);
      const moved = a === null || b === null ? null : differing(a.data, b.data, masks);
      controls.push({
        id: view.id,
        kind: view.control,
        label: view.label,
        bound: view.bound,
        send: view.send,
        changed: moved === null ? null : moved.outside,
        ownChanged: moved === null ? null : moved.inside,
        reported: event !== undefined,
        description: describe(view, ends.names[0], ends.names[1]),
        ends: a === null || b === null ? null : [a.png, b.png],
      });
    }

    const values: Record<string, ControlValue> = {};
    for (const view of painter.snapshot().controls) if (view.value !== null) values[view.id] = view.value;
    if (pressed !== null) pressed = { ...pressed, values };

    const charts: DrivenChart[] = [];
    const host = env.charts;
    if (host !== null) {
      const look = LOOKS[painter.snapshot().look];
      const xsPx = cellOf('xs', env.viewport, look).fontSize;
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
        const ticks = after?.ticks ?? { x: [], y: [] };
        const frame = watched.lastFrame()?.charts?.find((candidate) => candidate.key === view.key);
        charts.push({
          id: view.id,
          kind: view.kind,
          crosshair: crosshair !== null && crosshair.label.trim() !== '' && crosshair.values.length > 0 && crosshair.values.every((value) => value.trim() !== '' && !/NaN|undefined/.test(value)),
          zoomed: before !== null && after !== null && (after.from !== before.from || after.to !== before.to),
          silent: heard.slice(quiet).every((event) => event.type !== 'control') && painter.snapshot().turn === null,
          frameMs: after?.frameMs ?? { median: 0, worst: 0 },
          ticks,
          stage: {
            id: view.id,
            fontPx: frame?.state.theme.fontPx ?? null,
            xsPx,
            tickProblems: before === null ? ['the engine gave no probe'] : tickProblemsOf(ticks),
            plotShare: plotShareOf(before, frame?.rest ?? view.box),
          },
        });
        await host.act(view.key, { reset: true }).catch(() => undefined);
      }
    }
    return { capabilities, controls, values, pressed, charts, fault: painter.snapshot().fault };
  } finally {
    painter.dispose();
  }
}
