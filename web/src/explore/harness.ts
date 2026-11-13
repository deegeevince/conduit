// The browser half of the evaluation runner. `explore.html#harness` loads this instead of the review page and
// exposes `window.__harness`, which the runner (server/src/tools/explore.ts) drives over the DevTools protocol.
//
// It does what the painter does at the end of a turn, with no clock and no server: lay the recorded lines out for a
// viewport, say where the playhead stopped, settle the stage there, build the report the brain would be told how it
// landed (shown, resting stage, sight), and take the pictures: the one the brain is given as its snapshot (what
// `sendSnapshot` in the painter sends), the ones a judge is shown, and thumbnails for the review page.

import { TurnScore, settle, shownAt } from '@conduit/language';
import type { Line, StageBase, TurnReport } from '@conduit/language';
import type { Frame } from '../contracts/frame';
import type { Renderer } from '../contracts/renderer';
import { REST_POSE } from '../contracts/space';
import type { Viewport } from '../contracts/space';
import { pinnedWallTime } from '../painter/clock';
import { sightOf } from '../painter/sight';
import { buildTimeline, settledEnd } from '../painter/timeline';
import type { Timeline } from '../painter/timeline';
import { createPlainRenderer } from '../render/plain';
import { canUseThree, createThreeRenderer } from '../render/three';

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

export function installHarness(): void {
  let renderer: Renderer | null = null;
  let host: HTMLElement | null = null;
  let mountedFor = '';
  let mounted: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const rendererFor = async (viewport: Viewport, look: Parameters<Renderer['mount']>[2]): Promise<Renderer> => {
    const key = `${viewport.width}x${viewport.height}@${viewport.dpr}`;
    if (renderer !== null && key !== mountedFor) {
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
    return renderer;
  };

  async function run(request: HarnessRequest): Promise<HarnessReply> {
    const { base, viewport } = request;
    const score = new TurnScore(base);
    for (const { seq, line } of request.lines) score.push(line, seq, 0);
    const schedule = score.schedule;
    const timeline: Timeline = buildTimeline(schedule, base, { viewport, reducedMotion: false, lockLook: null, paintings: new Map() });
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
    if (!r.capabilities.capture) throw new Error(`the ${canUseThree() ? 'three' : 'plain'} renderer cannot capture pictures here`);
    let complete = true;
    const onIncomplete = (): void => {
      complete = false;
    };
    r.reset();

    const frames: Frame[] = request.earlier.map((share) => {
      const time = playhead * Math.max(0, Math.min(1, share));
      return timeline.frameAt({ time, ambient: time, wallTime: pinnedWallTime(time), clock: 'paused' });
    });
    // The resting stage, as the painter pictures it for the brain: the settled stage alone on a fresh schedule, camera at rest, ambient 3 s.
    const rest = buildTimeline(new TurnScore(stage).schedule, stage, { viewport, reducedMotion: false, lockLook: null, paintings: new Map() });
    frames.push({ ...rest.frameAt({ time: 0, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' }), camera: REST_POSE });

    const judge: string[] = [];
    const thumbs: string[] = [];
    for (const frame of frames) {
      const png = await r.rasterise(frame, { maxSide: request.judgeSide, mime: 'image/png', onIncomplete });
      const jpg = await r.rasterise(frame, { maxSide: 480, mime: 'image/jpeg', quality: 0.8, onIncomplete });
      if (png === null || jpg === null) throw new Error('the renderer returned no picture');
      judge.push(await base64Of(png));
      thumbs.push(await base64Of(jpg));
    }
    const last = frames[frames.length - 1];
    const shot = last === undefined ? null : await r.rasterise(last, { maxSide: SNAPSHOT_SIDE, mime: 'image/jpeg', quality: 0.8, onIncomplete });
    return { report, duration, judge, thumbs, snapshot: shot === null ? null : await base64Of(shot), complete, renderer: canUseThree() ? 'three' : 'plain' };
  }

  (window as unknown as { __harness: unknown }).__harness = {
    ready: true,
    run: (request: HarnessRequest): Promise<HarnessReply> => {
      // One at a time: they share one renderer.
      const job = chain.then(() => run(request));
      chain = job.catch(() => undefined);
      return job;
    },
  };
}
