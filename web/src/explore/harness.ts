// The browser half of the evaluation runner. `explore.html#harness` loads this instead of the review page and
// exposes `window.__harness`, which the runner (server/src/tools/explore.ts) drives over the DevTools protocol.
//
// It does what the painter does at the end of a turn, with no clock and no server: lay the recorded lines out for a
// viewport, say where the playhead stopped, settle the stage there, build the report the brain would be told how it
// landed (shown, resting stage, sight), and take the pictures: the one the brain is given as its snapshot (what
// `sendSnapshot` in the painter sends), the ones a judge is shown, and thumbnails for the review page.

import { TurnScore, settle, shownAt } from '@conduit/language';
import type { Capabilities, CanvasBox, ExploreGeometry, Line, LookId, PlacedBox, StageBase, TurnReport } from '@conduit/language';
import type { Frame } from '../contracts/frame';
import type { Renderer } from '../contracts/renderer';
import { REST_POSE, planeScale } from '../contracts/space';
import type { Viewport } from '../contracts/space';
import { pinnedWallTime } from '../painter/clock';
import { createRuntime } from '../painter/bound';
import { createControlStore } from '../painter/controls';
import { fitCanvas, stageToCanvas } from '../painter/canvas';
import type { CanvasFit } from '../painter/canvas';
import { createPainter } from '../painter';
import { placedOf, sightOf } from '../painter/sight';
import { buildTimeline, settledEnd } from '../painter/timeline';
import type { Timeline } from '../painter/timeline';
import { createPlainRenderer } from '../render/plain';
import { canUseThree, createThreeRenderer } from '../render/three';
import { CHARTS_READY, createChartEngine } from '../render/chart';
import type { ChartHost } from '../contracts/chart';
import { createHarnessChartHost } from './chart-host';
import { loadChartFonts } from '../app/chart-host';
import { capabilitiesOf, drive, observed, playToRest } from './drive';
import type { DriveReply, DriveRequest } from './drive';
import { geometryOf } from './geometry';
import type { Composed } from './geometry';
import { carriedOf } from './carry';
import { coverage, maskOf } from './ink';

export interface HarnessRequest {
  readonly turn: string;
  readonly base: StageBase;
  readonly lines: readonly { readonly seq: number; readonly line: Line }[];
  readonly viewport: Viewport;
  /** where the playhead stopped, in seconds; null: the answer played to its end */
  readonly playhead: number | null;
  /** extra pictures for the judge, at these shares of the answer's length, before the final one */
  readonly earlier: readonly number[];
  /** the longer side of the pictures the judge sees */
  readonly judgeSide: number;
  /** v2.1. The look to lay the answer out in, whatever it chose (a replay pass over all nine); absent or null: the one it chose */
  readonly look?: LookId | null;
  /** v2.1. False: count, take no pictures (the replay pass: no model, no judge, no pixels). Default true */
  readonly pictures?: boolean;
  /** v2.1. Shares of the answer at which to picture it, before the resting still, when it is told in captions (words that come and go): what the judge sees of a story told a line at a time */
  readonly strip?: readonly number[];
}

export interface HarnessReply {
  readonly report: TurnReport;
  readonly duration: number;
  /** base64 PNGs for the judge, earlier ones first, the resting stage last */
  readonly judge: readonly string[];
  /** base64 JPEGs of 480 px for the review page, the same order */
  readonly thumbs: readonly string[];
  /** base64 JPEG of 768 px: what the brain is given as its snapshot */
  readonly snapshot: string | null;
  /** false when a picture had to be taken before all of the frame's text could be drawn */
  readonly complete: boolean;
  readonly renderer: string;
  /** what the battery counted on the resting stage */
  readonly geometry: ExploreGeometry;
  /** v2.1. The answer is told in captions: three or more lines of words that come and go. `judge` then holds the strip's stills before the resting one */
  readonly captioned: boolean;
  /** where everything this turn showed really rests, as the painter reports it in a draft */
  readonly placed: readonly PlacedBox[];
}

const SNAPSHOT_SIDE = 768;

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('could not read the picture'));
    reader.readAsDataURL(blob);
  });
}

/** A box in host CSS pixels (the page's top-left is its origin) as a box in canvas units: the stage's own origin is the middle of the screen. */
function hostToCanvas(box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, fit: CanvasFit, viewport: Viewport): CanvasBox {
  return { x: (box.x - viewport.width / 2 - fit.box.x) / fit.unit, y: (box.y - viewport.height / 2 - fit.box.y) / fit.unit, w: box.width / fit.unit, h: box.height / fit.unit };
}

export function installHarness(): void {
  let renderer: Renderer | null = null;
  let host: HTMLElement | null = null;
  let mountedFor = '';
  let mounted: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let charts: ChartHost | null = null;
  const chartsFor = (): ChartHost | null => {
    if (charts !== null || host === null) return charts;
    const engine = createChartEngine();
    if (engine !== null) charts = createHarnessChartHost(engine, host);
    return charts;
  };

  const rendererFor = async (viewport: Viewport, look: Parameters<Renderer['mount']>[2]): Promise<Renderer> => {
    const key = `${viewport.width}x${viewport.height}@${viewport.dpr}`;
    if (renderer !== null && key !== mountedFor) {
      charts?.dispose();
      charts = null;
      renderer.dispose();
      host?.remove();
      renderer = null;
    }
    if (renderer === null) {
      renderer = canUseThree() ? createThreeRenderer() : createPlainRenderer();
      host = document.createElement('div');
      host.style.cssText = `position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px;overflow:hidden;`;
      document.body.append(host);
      mountedFor = key;
      mounted = renderer.mount(host, viewport, look);
    }
    await mounted;
    await loadChartFonts();
    return renderer;
  };

  async function run(request: HarnessRequest): Promise<HarnessReply> {
    const { base, viewport } = request;
    const score = new TurnScore(base);
    for (const { seq, line } of request.lines) score.push(line, seq, 0);
    const schedule = score.schedule;
    // A runtime that holds each control at the value the answer wrote: a bound shape is then drawn where its slider stands, as in the app.
    // Without one the painter draws nothing bound at all (P0-2c).
    const controls = createRuntime(createControlStore());
    const lockLook = request.look ?? null;
    const context = { viewport, reducedMotion: false, lockLook, paintings: new Map(), charts: { kinds: CHARTS_READY, data: new Map() }, controls };
    const timeline: Timeline = buildTimeline(schedule, base, context);
    const duration = settledEnd(timeline, null, base.scene.mood);
    const finished = request.playhead === null;
    const playhead = finished ? duration : Math.max(0, Math.min(request.playhead ?? 0, duration));
    const at = finished ? playhead + 1e-6 : playhead;
    const stage = settle(schedule, base, at);
    const report: TurnReport = {
      turn: request.turn,
      outcome: finished ? 'finished' : 'interrupted',
      playhead,
      shown: shownAt(schedule, at),
      stage,
      sight: sightOf(timeline, schedule, base, at, true),
      skippedAt: null,
    };

    const r = await rendererFor(viewport, timeline.frameAt({ time: 0, ambient: 0, wallTime: pinnedWallTime(0), clock: 'paused' }).look);
    const pictures = request.pictures !== false;
    if (pictures && !r.capabilities.capture) throw new Error(`the ${canUseThree() ? 'three' : 'plain'} renderer cannot capture pictures here`);
    const captioned = schedule.elements.filter((element) => !element.carried && element.kind === 'text' && element.exit !== null).length >= 3;
    let complete = true;
    const onIncomplete = (): void => {
      complete = false;
    };
    r.reset();

    const earlier = captioned && request.earlier.length === 0 ? (request.strip ?? []) : request.earlier;
    const frames: Frame[] = earlier.map((share) => {
      const time = playhead * Math.max(0, Math.min(1, share));
      return timeline.frameAt({ time, ambient: time, wallTime: pinnedWallTime(time), clock: 'paused' });
    });
    // The resting stage, as the painter pictures it for the brain: the settled stage alone on a fresh schedule, camera at rest, ambient 3 s.
    const rest = buildTimeline(new TurnScore(stage).schedule, stage, context);
    frames.push({ ...rest.frameAt({ time: 0, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' }), camera: REST_POSE });

    const judge: string[] = [];
    const thumbs: string[] = [];
    const chartHost = chartsFor();
    let shot: Blob | null = null;
    if (pictures) {
      for (const frame of frames) {
        // A chart draws itself in a surface over the stage: give it this frame's state, let it draw, and hand its picture to the renderer.
        chartHost?.sync(frame.charts ?? [], 1);
        if (chartHost !== null && (frame.charts?.length ?? 0) > 0) await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        const chartStill = chartHost === null ? undefined : (key: string): HTMLCanvasElement | null => chartHost.still(key);
        const png = await r.rasterise(frame, { maxSide: request.judgeSide, mime: 'image/png', onIncomplete, ...(chartStill === undefined ? {} : { chartStill }) });
        const jpg = await r.rasterise(frame, { maxSide: 480, mime: 'image/jpeg', quality: 0.8, onIncomplete, ...(chartStill === undefined ? {} : { chartStill }) });
        if (png === null || jpg === null) throw new Error('the renderer returned no picture');
        judge.push(await base64Of(png));
        thumbs.push(await base64Of(jpg));
      }
      const last = frames[frames.length - 1];
      const lastStill = chartHost === null ? undefined : (key: string): HTMLCanvasElement | null => chartHost.still(key);
      shot = last === undefined ? null : await r.rasterise(last, { maxSide: SNAPSHOT_SIDE, mime: 'image/jpeg', quality: 0.8, onIncomplete, ...(lastStill === undefined ? {} : { chartStill: lastStill }) });
    }
    const keys = new Set(schedule.elements.filter((element) => !element.carried).map((element) => element.key));
    const placed = placedOf(timeline, schedule, at, keys);

    // What the battery counts, on every box the stage holds (what it carried from the turn before as well as what this turn drew), and
    // on what the painter says of the composed stage when it is run as the app runs it.
    const everything = placedOf(timeline, schedule, at, new Set(schedule.elements.map((element) => element.key)));
    const scene = schedule.scenes.reduce((found, candidate) => (candidate.start <= at ? candidate : found), schedule.scenes[0]);
    const fit: CanvasFit | null = scene === undefined ? null : fitCanvas(scene.canvas, scene.layout, viewport, timeline.specAt(Math.max(at, schedule.end) + 0.5));
    let composed: Composed | null = null;
    if (fit !== null && base.elements.length === 0) {
      composed = await composedOf(await environment(viewport), request, fit).catch(() => null);
    }
    // Where every run of words rests: the frame the stage comes to, text by text.
    const restAt = Math.max(at, schedule.end) + 0.5;
    const texts =
      fit === null
        ? []
        : timeline
            .frameAt({ time: restAt, ambient: restAt, wallTime: 0, clock: 'idle' })
            .elements.filter((element) => element.opacity >= 0.5)
            .map((element) => {
              const ps = planeScale(element.layer, viewport);
              const left = stageToCanvas({ x: (element.x - element.width / 2) * ps, y: (element.y - element.height / 2) * ps }, fit);
              return { id: element.id, key: element.key, box: { x: left.x, y: left.y, w: (element.width * ps) / fit.unit, h: (element.height * ps) / fit.unit } };
            });
    const toCanvas = (box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): CanvasBox => (fit === null ? { x: box.x, y: box.y, w: box.width, h: box.height } : hostToCanvas(box, fit, viewport));
    // The same resting frame with no words and no charts: what is left is ink.
    let inkUnder: ((box: CanvasBox) => number) | null = null;
    if (fit !== null && r.capabilities.capture) {
      const bare = await r.rasterise({ ...(frames[frames.length - 1] as Frame), elements: [], charts: [] }, { maxSide: 480, mime: 'image/png', onIncomplete });
      if (bare !== null) {
        const bitmap = await createImageBitmap(bare);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const drawing = canvas.getContext('2d');
        if (drawing !== null) {
          drawing.drawImage(bitmap, 0, 0);
          const mask = maskOf(drawing.getImageData(0, 0, bitmap.width, bitmap.height));
          const k = bitmap.width / viewport.width;
          const frameFit = fit;
          inkUnder = (box) => coverage(mask, { x0: (frameFit.box.x + box.x * frameFit.unit + viewport.width / 2) * k, y0: (frameFit.box.y + box.y * frameFit.unit + viewport.height / 2) * k, x1: (frameFit.box.x + (box.x + box.w) * frameFit.unit + viewport.width / 2) * k, y1: (frameFit.box.y + (box.y + box.h) * frameFit.unit + viewport.height / 2) * k });
        }
      }
    }
    const geometry: ExploreGeometry = {
      ...geometryOf({
        schedule,
        placed: everything,
        sight: report.sight,
        texts,
        ...(inkUnder === null ? {} : { inkUnder }),
        screen: toCanvas({ x: 0, y: 0, width: viewport.width, height: viewport.height }),
        composed,
        look: request.look ?? null,
        screenName: `${viewport.width}x${viewport.height}`,
      }),
      ...(base.elements.length === 0 ? {} : { carried: carriedOf(timeline, base, context) }),
    };
    return { report, duration, judge, thumbs, snapshot: shot === null ? null : await base64Of(shot), complete, renderer: canUseThree() ? 'three' : 'plain', geometry, captioned, placed: placed.map(({ key: _key, ...item }) => item) };
  }

  /**
   * Runs the answer as the app runs it, in a painter of its own, and reports where the controls and charts really rest and the stage plan
   * (when the painter publishes one), in canvas units. The placed boxes cannot say this: a card of controls is laid out by the controls.
   */
  async function composedOf(env: { renderer: Renderer; viewport: Viewport; charts: ChartHost | null }, request: HarnessRequest, fit: CanvasFit): Promise<Composed> {
    const painter = createPainter({ renderer: observed(env.renderer), viewport: env.viewport, lockLook: request.look ?? null, reducedMotion: true, pointer: 'fine', charts: env.charts });
    try {
      await playToRest(painter, { turn: request.turn, lines: request.lines });
      const snapshot = painter.snapshot();
      const toCanvas = (box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): CanvasBox => hostToCanvas(box, fit, env.viewport);
      const plan = snapshot.plan;
      return {
        controls: snapshot.controls.map((view) => ({ id: view.id, box: toCanvas(view.box) })),
        charts: snapshot.charts.map((view) => ({ id: view.id, box: toCanvas(view.box) })),
        plan:
          plan === undefined
            ? null
            : { rooms: plan.rooms.map((room) => ({ key: room.key, kind: room.kind, box: toCanvas(room.box) })), flow: toCanvas(plan.flow), foot: plan.foot === null ? null : toCanvas(plan.foot), picture: plan.picture === null ? null : toCanvas(plan.picture) },
      };
    } finally {
      painter.dispose();
    }
  }

  const environment = async (viewport: Viewport): Promise<{ renderer: Renderer; viewport: Viewport; charts: ChartHost | null }> => {
    const r = await rendererFor(viewport, 'paper');
    return { renderer: r, viewport, charts: chartsFor() };
  };

  (window as unknown as { __harness: unknown }).__harness = {
    ready: true,
    /** What the painter behind these pictures says it can do at this viewport: the brain is taught exactly this. */
    capabilities: (viewport: Viewport): Promise<Capabilities | null> => {
      const job = chain.then(async () => capabilitiesOf(await environment(viewport)));
      chain = job.catch(() => undefined);
      return job;
    },
    /** Works every control and chart the answer left, through the real painter. */
    drive: (request: DriveRequest & { readonly viewport: Viewport }): Promise<DriveReply> => {
      const job = chain.then(async () => drive(await environment(request.viewport), request));
      chain = job.catch(() => undefined);
      return job;
    },
    run: (request: HarnessRequest): Promise<HarnessReply> => {
      // One at a time: they share one renderer.
      const job = chain.then(() => run(request));
      chain = job.catch(() => undefined);
      return job;
    },
  };
}
