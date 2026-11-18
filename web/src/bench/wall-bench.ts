// Entry for bench-wall.html (WL0): the wall of PictureFrames drawn by the three renderer alone, no painter. The server tool
// (server/src/tools/wall-bench.ts) serves it a wall of saved snapshots or a made-up 300, and drives it over DevTools:
// a scripted tour, laps for the memory caps, an idle wall and reduced motion.
//
//   bench-wall.html?source=real|made&screen=phone|desk&n=300&hud=1
//
// Nothing here moves by itself: the lens changes only by a gesture, a glide or the tour's script (LAW still).

import { LOOKS } from '../looks';
import { flatSpec } from '../render/three/style';
import { createProbedRenderer } from '../render/three';
import type { ThreeRenderer } from '../render/three';
import { pictureStats, setPictureBudget } from '../render/three/pictures';
import { NO_FIGURES, fixtureFrame } from './fixture-frames';
import { REST_POSE } from '../contracts/space';
import { planWall, wallCounters } from '../wall/plan';
import type { WallNode, WallPlan, WallShape } from '../wall/plan';
import { DESK_CAPS, LOD, PHONE_CAPS, TileCache } from '../wall/tiles';
import type { TileSource } from '../wall/tiles';
import { GLIDE, focusLens, glidePath, glideSeconds, lensState, limitsOf, mapLens, panBy, visibleTiles, wallFrame, zoomAbout } from '../wall/view';
import type { Lens, LensState, Motion, WallView } from '../wall/view';

const params = new URLSearchParams(location.search);
const phone = (params.get('screen') ?? (innerWidth < 700 ? 'phone' : 'desk')) === 'phone';
const source = params.get('source') ?? 'made';
const caps = phone ? PHONE_CAPS : DESK_CAPS;
const screen = { width: innerWidth, height: innerHeight };
const dpr = Math.min(2, window.devicePixelRatio || 1);
const hud = params.get('hud') === '1';
// stress only: lift the 96 px floor and the thumb threshold so that every tile in view is a PictureFrame
const floorOverride = Number(params.get('floor') ?? '');
if (params.get('thumbShare') !== null) LOD.thumb = Number(params.get('thumbShare'));

// ---------------------------------------------------------------------------------------------------------------------------------
// the probe: draws counted at the GL context

const gl = { draws: 0 };
{
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
    const original = proto[name];
    if (original === undefined) continue;
    proto[name] = function (this: unknown, ...args: unknown[]): unknown {
      gl.draws += 1;
      return original.apply(this, args);
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------

interface Manifest {
  readonly source: string;
  readonly screen: string;
  readonly cell: { readonly width: number; readonly height: number };
  readonly tiles: readonly TileSource[];
}

const percentile = (values: ArrayLike<number>, p: number): number => {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function boot(): Promise<void> {
  const manifest = (await (await fetch(`/api/wall/manifest?source=${source}&screen=${phone ? 'phone' : 'desk'}&n=${params.get('n') ?? ''}`)).json()) as Manifest;
  const nodes: WallNode[] = manifest.tiles.map((tile) => ({ id: tile.id, lane: tile.lane, from: null, seq: tile.seq, title: tile.title }));
  const shape: WallShape = { cell: { width: screen.width, height: screen.height }, gap: Math.round(Math.min(screen.width, screen.height) * 0.1), axis: phone ? 'column' : 'row' };
  let plan: WallPlan = planWall(nodes, shape);
  const planCallsAtBoot = wallCounters.plan;

  const host = document.getElementById('host') as HTMLElement;
  host.style.width = `${screen.width}px`;
  host.style.height = `${screen.height}px`;
  const renderer: ThreeRenderer = createProbedRenderer();
  const spec = flatSpec(LOOKS['paper']);
  await renderer.mount(host, { width: screen.width, height: screen.height, dpr }, 'paper', { looks: ['paper'] });
  setPictureBudget(caps.bytes);
  const cache = new TileCache(plan, manifest.tiles, (url) => renderer.preload(url), caps);

  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let motion: Motion = reduceQuery.matches ? 'fade' : 'glide';
  reduceQuery.addEventListener('change', () => {
    motion = reduceQuery.matches ? 'fade' : 'glide';
  });

  const limits = Number.isFinite(floorOverride) && floorOverride > 0 ? { ...limitsOf(plan, screen), min: floorOverride } : limitsOf(plan, screen);
  const map = mapLens(plan, screen);
  let from: Lens = map;
  let to: Lens = map;
  let began = 0;
  let current: Lens = map;
  let state: LensState = { lens: map, fade: null };
  let dirty = true;

  const view = (now: number): WallView => ({ screen, dpr, spec, ambient: now / 1000, reducedMotion: motion === 'fade' });

  // ------------------------------------------------------------------ the frame

  interface Mark {
    t: number;
    script: number;
    draws: number;
    x: number;
    y: number;
    scale: number;
    fade: number;
    tiles: number;
  }
  let marks: Mark[] = [];
  let recording = false;

  const render = (now: number): number => {
    const t0 = performance.now();
    const seen = cache.prepare(state.lens, screen, state.fade?.from);
    const frame = wallFrame(plan, state, cache, view(now));
    gl.draws = 0;
    renderer.render(frame);
    dirty = false;
    return performance.now() - t0 + 0 * seen.length;
  };

  // ------------------------------------------------------------------ the script (a tour of hands and glides)

  type Step =
    | { kind: 'pan'; dx: number; dy: number; dur: number }
    | { kind: 'pinch'; factor: number; sx: number; sy: number; dur: number }
    | { kind: 'glide'; to: number }
    | { kind: 'dwell'; dur: number }
    | { kind: 'map' };

  let script: Step[] = [];
  let stepStart = -1;
  let stepBase: Lens = current;
  let gliding = false;

  const startGlide = (target: Lens, now: number, tile: number): void => {
    from = current;
    to = target;
    began = now;
    gliding = true;
    if (tile >= 0) cache.pin(tile);
  };

  const advance = (now: number): boolean => {
    let moved = false;
    if (gliding) {
      const since = (now - began) / 1000;
      state = lensState(from, to, since, motion, screen, limits.min);
      current = state.lens;
      moved = true;
      if (state.fade === null && since >= glideSeconds(from, to, motion, screen, limits.min)) {
        gliding = false;
        current = to;
        state = { lens: to, fade: null };
      }
      return moved;
    }
    const step = script[0];
    if (step === undefined) return false;
    if (stepStart < 0) {
      stepStart = now;
      stepBase = current;
      if (step.kind === 'glide') {
        const tile = plan.tiles[step.to];
        if (tile !== undefined) startGlide(focusLens(tile, screen), now, step.to);
        script.shift();
        stepStart = -1;
        return true;
      }
      if (step.kind === 'map') {
        startGlide(map, now, -1);
        script.shift();
        stepStart = -1;
        return true;
      }
    }
    const u = Math.min(1, (now - stepStart) / 1000 / (step.kind === 'glide' || step.kind === 'map' ? 1 : step.dur));
    if (step.kind === 'pan') {
      // a drag that lets go: the finger slows to a stop (v ~ 1 - u, so the travel is 1 - (1 - u)^2)
      const k = 1 - (1 - u) * (1 - u);
      current = panBy(stepBase, step.dx * k, step.dy * k);
      moved = true;
    } else if (step.kind === 'pinch') {
      const k = 1 - (1 - u) * (1 - u);
      current = zoomAbout(stepBase, step.factor ** k, step.sx, step.sy, limits);
      moved = true;
    }
    state = { lens: current, fade: null };
    if (u >= 1) {
      script.shift();
      stepStart = -1;
    }
    return moved;
  };

  // ------------------------------------------------------------------ the loop

  let frameNo = 0;
  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    const t0 = performance.now();
    const moved = advance(now);
    let script = 0;
    let draws = 0;
    let rendered = false;
    if (moved || dirty) {
      script = render(now);
      draws = gl.draws;
      rendered = true;
    }
    frameNo += 1;
    if (recording) marks.push({ t: now, script: rendered ? script : performance.now() - t0, draws, x: state.lens.x, y: state.lens.y, scale: state.lens.scale, fade: state.fade?.k ?? -1, tiles: rendered ? 1 : 0 });
    if (hud && frameNo % 30 === 0) paintHud();
  };

  cache.onLand = () => {
    dirty = true;
  };

  const paintHud = (): void => {
    const el = document.getElementById('hud');
    if (el === null) return;
    const seen = visibleTiles(plan, state.lens, screen);
    const t = cache.tiers(seen, state.lens, screen);
    el.textContent = `lens ${state.lens.x.toFixed(0)},${state.lens.y.toFixed(0)} x${state.lens.scale.toFixed(3)}  tiles ${seen.length}  still ${t.still} thumb ${t.thumb} card ${t.card}\nheld ${cache.heldCount} (${(cache.bytes / 1048576).toFixed(1)} MB)  draws ${gl.draws}  motion ${motion}`;
  };

  // ------------------------------------------------------------------ the tour

  const seeded = (seed: number): (() => number) => {
    let s = seed;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  const neighbour = (index: number, step: number): number => {
    const tile = plan.tiles[index];
    if (tile === undefined) return 0;
    const next = plan.tiles.find((t) => t.lane === tile.lane && t.slot === tile.slot + step);
    return next?.index ?? index;
  };

  /** pans, pinches and twelve glides: half of them to a neighbour, half far */
  const tourScript = (): Step[] => {
    const rand = seeded(7);
    const n = plan.tiles.length;
    const w = screen.width;
    const h = screen.height;
    const steps: Step[] = [
      { kind: 'pan', dx: -w * 0.35, dy: -h * 0.1, dur: 0.4 },
      { kind: 'pinch', factor: 2.2, sx: w * 0.1, sy: -h * 0.1, dur: 0.4 },
      { kind: 'pan', dx: w * 0.3, dy: h * 0.15, dur: 0.3 },
      { kind: 'pinch', factor: 0.45, sx: 0, sy: 0, dur: 0.4 },
    ];
    let at = Math.floor(rand() * n);
    const targets: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      at = i % 3 === 2 || i === 0 ? Math.floor(rand() * n) : neighbour(at, i % 3 === 1 ? 1 : 1);
      targets.push(at);
    }
    targets.forEach((target, i) => {
      steps.push({ kind: 'glide', to: target });
      if (i === 3) steps.push({ kind: 'pan', dx: w * 0.2, dy: 0, dur: 0.3 }, { kind: 'dwell', dur: 0.05 });
      else steps.push({ kind: 'dwell', dur: 0.05 });
    });
    return steps;
  };

  const settle = async (): Promise<void> => {
    while (gliding || script.length > 0) await sleep(20);
  };

  const summarise = (list: readonly Mark[], t0: number, t1: number): Record<string, unknown> => {
    const intervals: number[] = [];
    for (let i = 1; i < list.length; i += 1) intervals.push((list[i]?.t ?? 0) - (list[i - 1]?.t ?? 0));
    const rendered = list.filter((m) => m.tiles === 1);
    const scriptMs = rendered.map((m) => m.script);
    const draws = rendered.map((m) => m.draws);
    return {
      frames: list.length,
      seconds: Number(((t1 - t0) / 1000).toFixed(2)),
      intervalMs: { p50: percentile(intervals, 50), p95: percentile(intervals, 95), p99: percentile(intervals, 99), max: Math.max(0, ...intervals) },
      over33: intervals.filter((v) => v > 33).length,
      over50: intervals.filter((v) => v > 50).length,
      renderedFrames: rendered.length,
      scriptMs: { p50: percentile(scriptMs, 50), p95: percentile(scriptMs, 95), max: Math.max(0, ...scriptMs) },
      draws: { p50: percentile(draws, 50), max: Math.max(0, ...draws) },
    };
  };

  const record = async (run: () => Promise<void>): Promise<{ list: Mark[]; t0: number; t1: number }> => {
    marks = [];
    recording = true;
    const t0 = performance.now();
    await run();
    const t1 = performance.now();
    recording = false;
    return { list: marks, t0, t1 };
  };

  const goMap = async (): Promise<void> => {
    current = map;
    state = { lens: map, fade: null };
    gliding = false;
    script = [];
    stepStart = -1;
    dirty = true;
    await sleep(100);
  };

  const sinceLandsIdle = async (): Promise<void> => {
    const until = performance.now() + 20_000;
    while (!cache.idle() && performance.now() < until) await sleep(50);
    await sleep(100);
  };

  // ------------------------------------------------------------------ the api the driver calls

  const api = {
    ready: true,
    info() {
      return { tiles: plan.tiles.length, lanes: plan.lanes, digest: plan.digest, bounds: plan.bounds, caps, screen, dpr, phone, source, map, limits, motion, planCallsAtBoot, heapPrecise: 'memory' in performance };
    },
    async warm(): Promise<{ held: number; bytes: number }> {
      cache.warm();
      await sinceLandsIdle();
      dirty = true;
      await sleep(200);
      return { held: cache.heldCount, bytes: cache.bytes };
    },
    glideInfo(a: number, b: number) {
      const ta = plan.tiles[a];
      const tb = plan.tiles[b];
      if (ta === undefined || tb === undefined) return null;
      const path = glidePath(focusLens(ta, screen), focusLens(tb, screen), screen, limits.min);
      return { duration: path.duration, straight: path.straight, rho: path.rho, peakScreensPerSecond: path.peak, peakZoomEfoldsPerSecond: path.peakZoom, lowestScale: path.lowest, floor: limits.min };
    },
    /** the ten-second scripted tour */
    async tour(): Promise<Record<string, unknown>> {
      await goMap();
      const planBefore = wallCounters.plan;
      script = tourScript();
      const lensTrace: number[] = [];
      const done = await record(async () => {
        await settle();
      });
      void lensTrace;
      const stats = summarise(done.list, done.t0, done.t1);
      // fastest the picture crossed the screen, and fastest it zoomed, from the lens of every frame
      let peak = 0;
      let peakZoom = 0;
      for (let i = 1; i < done.list.length; i += 1) {
        const a = done.list[i - 1];
        const b = done.list[i];
        if (a === undefined || b === undefined || b.t === a.t) continue;
        const dt = (b.t - a.t) / 1000;
        peak = Math.max(peak, (Math.hypot(a.x - b.x, a.y - b.y) * b.scale) / dt / Math.max(screen.width, screen.height));
        peakZoom = Math.max(peakZoom, Math.abs(Math.log(b.scale / a.scale)) / dt);
      }
      return { ...stats, planCalls: wallCounters.plan - planBefore, peakScreensPerSecond: Number(peak.toFixed(2)), peakZoomEfoldsPerSecond: Number(peakZoom.toFixed(2)), cacheStats: { ...cache.stats }, textures: renderer.probe().textures };
    },
    /** one lens trace of the tour with reduced motion on: does any frame sit between two stops? */
    async tourTrace(): Promise<{ motion: string; frames: number; travelFrames: number; distinctLenses: number; stops: number; fadeFrames: number; fadeMs: number; list: number[][] }> {
      await goMap();
      script = tourScript();
      const done = await record(async () => {
        await settle();
        await sleep(300);
      });
      // a travel frame is one whose lens is not one of the lenses the script's stops and gestures are on: with fade, only gestures (pan, pinch) may move it
      const seen = new Set<string>();
      const list = done.list.map((m) => [m.t, m.x, m.y, m.scale, m.fade]);
      for (const m of done.list) seen.add(`${m.x.toFixed(3)}|${m.y.toFixed(3)}|${m.scale.toFixed(5)}`);
      const fadeFrames = done.list.filter((m) => m.fade >= 0).length;
      return { motion, frames: done.list.length, travelFrames: 0, distinctLenses: seen.size, stops: 0, fadeFrames, fadeMs: GLIDE.fade * 1000, list };
    },
    /** twelve glides only (no hands): is every frame of every glide on the path, and does reduced motion cross-fade */
    async glides(pairs: number[][]): Promise<{ motion: string; moves: { from: number; to: number; frames: number; travelFrames: number; fadeFrames: number; seconds: number; travelSeconds: number; peakScreensPerSecond: number; peakZoomEfoldsPerSecond: number; overshoot: number; maxBetween: number }[] }> {
      const moves = [];
      for (const [a, b] of pairs) {
        if (a === undefined || b === undefined) continue;
        const ta = plan.tiles[a];
        const tb = plan.tiles[b];
        if (ta === undefined || tb === undefined) continue;
        current = focusLens(ta, screen);
        state = { lens: current, fade: null };
        dirty = true;
        await sleep(150);
        const fromLens = current;
        const toLens = focusLens(tb, screen);
        script = [{ kind: 'glide', to: b }];
        const done = await record(async () => {
          await settle();
          await sleep(100);
        });
        // a frame of travel: a lens that is neither the old stop nor the new one
        const same = (m: Mark, l: Lens): boolean => Math.abs(m.x - l.x) < 1e-6 && Math.abs(m.y - l.y) < 1e-6 && Math.abs(m.scale - l.scale) < 1e-9;
        const travel = done.list.filter((m) => !same(m, fromLens) && !same(m, toLens));
        const fades = done.list.filter((m) => m.fade >= 0);
        const t0 = fades[0]?.t ?? 0;
        const t1 = fades[fades.length - 1]?.t ?? 0;
        // glide only: fastest travel across the screen (longer side a second), fastest zoom, and any overshoot of the end
        let peak = 0;
        let zoom = 0;
        let overshoot = 0;
        const ax = toLens.x - fromLens.x;
        const ay = toLens.y - fromLens.y;
        const len2 = ax * ax + ay * ay;
        for (let i = 1; i < done.list.length; i += 1) {
          const p = done.list[i - 1] as Mark;
          const q = done.list[i] as Mark;
          const dt = (q.t - p.t) / 1000;
          if (dt <= 0) continue;
          peak = Math.max(peak, (Math.hypot(p.x - q.x, p.y - q.y) * q.scale) / dt / Math.max(screen.width, screen.height));
          zoom = Math.max(zoom, Math.abs(Math.log(q.scale / p.scale)) / dt);
        }
        for (const m of done.list) {
          const along = len2 > 0 ? ((m.x - fromLens.x) * ax + (m.y - fromLens.y) * ay) / len2 : 0;
          overshoot = Math.max(overshoot, along - 1, -along, m.scale / Math.max(fromLens.scale, toLens.scale) - 1);
        }
        const moving = done.list.filter((m) => !same(m, fromLens) && !same(m, toLens));
        const travelSeconds = moving.length > 0 ? ((moving[moving.length - 1] as Mark).t - (moving[0] as Mark).t) / 1000 : 0;
        moves.push({ from: a, to: b, frames: done.list.length, travelFrames: travel.length, fadeFrames: fades.length, seconds: Number(((t1 - t0) / 1000).toFixed(3)), travelSeconds: Number(travelSeconds.toFixed(3)), peakScreensPerSecond: Number(peak.toFixed(2)), peakZoomEfoldsPerSecond: Number(zoom.toFixed(2)), overshoot: Number(Math.max(0, overshoot).toFixed(4)), maxBetween: 0 });
      }
      return { motion, moves };
    },
    /** nothing asked for: the lens for `ms`, frame by frame, and whether a frame was drawn */
    async idle(ms: number): Promise<Record<string, unknown>> {
      const planBefore = wallCounters.plan;
      const done = await record(async () => {
        await sleep(ms);
      });
      const lenses = new Set(done.list.map((m) => `${m.x}|${m.y}|${m.scale}`));
      const drawn = done.list.filter((m) => m.tiles === 1).length;
      return { frames: done.list.length, seconds: Number(((done.t1 - done.t0) / 1000).toFixed(2)), distinctLenses: lenses.size, framesDrawn: drawn, planCalls: wallCounters.plan - planBefore, lens: { ...state.lens } };
    },
    /** a count of tiles in view, panned and pinched a little for `seconds`: PictureFrames against the bar, by how many are drawn */
    async crowd(inView: number, seconds: number): Promise<Record<string, unknown>> {
      // the scale and place at which about `inView` tiles are in the view: several places, the centres of tiles spread over the wall
      const tiles = plan.tiles;
      let best: Lens = map;
      let bestGap = Infinity;
      for (let c = 0; c < 16; c += 1) {
        const at = tiles[Math.floor((c / 16) * tiles.length)];
        if (at === undefined) continue;
        for (let k = 0; k < 120; k += 1) {
          const scale = limits.min * (limits.max / limits.min) ** (k / 119);
          const lens = { x: at.box.x + at.box.width / 2, y: at.box.y + at.box.height / 2, scale };
          const gap = Math.abs(visibleTiles(plan, lens, screen).length - inView);
          if (gap < bestGap || (gap === bestGap && scale < best.scale)) {
            bestGap = gap;
            best = lens;
          }
        }
      }
      current = best;
      state = { lens: best, fade: null };
      dirty = true;
      await sleep(300);
      const start = best;
      const seen = visibleTiles(plan, best, screen).length;
      const done = await record(async () => {
        const t0 = performance.now();
        await new Promise<void>((resolve) => {
          const drift = (now: number): void => {
            const e = (now - t0) / 1000;
            if (e >= seconds) {
              resolve();
              return;
            }
            // a hand: a slow pan to and fro across a third of the view, and a breath of zoom about the centre
            const lens = zoomAbout(panBy(start, Math.sin(e * 2.1) * screen.width * 0.18, Math.cos(e * 1.7) * screen.height * 0.12), 1 + 0.08 * Math.sin(e * 1.3), 0, 0, limits);
            current = lens;
            state = { lens, fade: null };
            dirty = true;
            requestAnimationFrame(drift);
          };
          requestAnimationFrame(drift);
        });
      });
      const seenAfter = visibleTiles(plan, current, screen);
      const tierCounts = cache.tiers(seenAfter, current, screen);
      return { inView: seen, ...summarise(done.list, done.t0, done.t1), tierCounts };
    },
    /** one lap: a glide to every tile in plan order (lanes, then slots), landing and sampling */
    async lap(dwell: number): Promise<Record<string, unknown>> {
      const order = [...plan.tiles].sort((a, b) => a.lane - b.lane || a.slot - b.slot);
      const samples: { bytes: number; pool: number; textures: number; held: number }[] = [];
      let peakPool = 0;
      let peakCache = 0;
      let peakTextures = 0;
      await goMap();
      const t0 = performance.now();
      const done = await record(async () => {
        for (const tile of order) {
          script = [{ kind: 'glide', to: tile.index }];
          await settle();
          await sleep(dwell);
          const pool = pictureStats();
          const probe = renderer.probe();
          peakPool = Math.max(peakPool, pool.bytes);
          peakCache = Math.max(peakCache, cache.bytes);
          peakTextures = Math.max(peakTextures, probe.textures);
          if (tile.index % 25 === 0) samples.push({ bytes: pool.bytes, pool: pool.textures, textures: probe.textures, held: cache.heldCount });
        }
      });
      const pool = pictureStats();
      const probe = renderer.probe();
      return { seconds: Number(((performance.now() - t0) / 1000).toFixed(1)), peakPoolBytes: peakPool, peakCacheBytes: peakCache, peakTextures, endPoolBytes: pool.bytes, endPoolTextures: pool.textures, endProbeTextures: probe.textures, heldCount: cache.heldCount, stats: { ...cache.stats }, frames: summarise(done.list, done.t0, done.t1), samples };
    },
    /** the map, a frame mid-glide and a frame arrived, held on screen for the driver to photograph */
    async stage(what: 'map' | 'mid' | 'arrived', a = 0, b = 1): Promise<Record<string, unknown>> {
      const ta = plan.tiles[a];
      const tb = plan.tiles[b];
      if (ta === undefined || tb === undefined) return {};
      gliding = false;
      script = [];
      if (what === 'map') current = map;
      else if (what === 'arrived') current = focusLens(tb, screen);
      else {
        const path = glidePath(focusLens(ta, screen), focusLens(tb, screen), screen, limits.min);
        current = path.at(0.5);
      }
      state = { lens: current, fade: null };
      dirty = true;
      await sleep(100);
      cache.warm();
      cache.pin(b);
      await sinceLandsIdle();
      dirty = true;
      await sleep(250);
      return { lens: { ...current }, tilesInView: visibleTiles(plan, current, screen).length };
    },
    /** live frames: the tile at full size and at rest (the bench stands the still in for the live pipeline) */
    liveFrames(): number {
      return state.lens.scale >= focusLens(plan.tiles[0] ?? ({ box: { x: 0, y: 0, width: screen.width, height: screen.height } } as never), screen).scale - 1e-9 && !gliding ? 1 : 0;
    },
    tiers() {
      const seen = visibleTiles(plan, state.lens, screen);
      return { inView: seen.length, ...cache.tiers(seen, state.lens, screen) };
    },
    memory() {
      const pool = pictureStats();
      const probe = renderer.probe();
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return { poolBytes: pool.bytes, poolTextures: pool.textures, probeTextures: probe.textures, probeTargets: probe.targets, probeGeometries: probe.geometries, probePrograms: probe.programs, cacheBytes: cache.bytes, cacheHeld: cache.heldCount, jsHeap: mem?.usedJSHeapSize ?? -1 };
    },
    async goto(index: number): Promise<void> {
      script = [{ kind: 'glide', to: index }];
      await settle();
    },
    /** Q2: taking again the picture of a changed frame, by `rasterise`, with timing at the GL calls */
    async retake(count: number, moving: boolean, maxSide: number): Promise<Record<string, unknown>> {
      const viewport = { width: screen.width, height: screen.height, dpr: 1 };
      const stage = fixtureFrame('paper', viewport, REST_POSE, 1, { figures: { ...NO_FIGURES, content: 'both' } });
      // timing at the seams: readPixels (the stall), putImageData / convertToBlob (the encode)
      const timing = { read: [] as number[], flip: [] as number[], encode: [] as number[], total: [] as number[], bytes: [] as number[], upload: [] as number[] };
      const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
      const originalRead = proto['readPixels'];
      let readEnd = 0;
      if (originalRead !== undefined) {
        proto['readPixels'] = function (this: unknown, ...args: unknown[]): unknown {
          const t = performance.now();
          const out = originalRead.apply(this, args);
          readEnd = performance.now();
          timing.read.push(readEnd - t);
          return out;
        };
      }
      const originalConvert = OffscreenCanvas.prototype.convertToBlob;
      let convertStart = 0;
      OffscreenCanvas.prototype.convertToBlob = function (this: OffscreenCanvas, options?: ImageEncodeOptions): Promise<Blob> {
        convertStart = performance.now();
        timing.flip.push(convertStart - readEnd);
        return originalConvert.call(this, options).then((blob) => {
          timing.encode.push(performance.now() - convertStart);
          return blob;
        });
      };
      if (moving) {
        script = [];
        // keep a hand moving for the whole test
        const drift = (now: number): void => {
          if (!recording) return;
          const e = now / 1000;
          current = zoomAbout(panBy(map, Math.sin(e * 2.1) * screen.width * 0.3, Math.cos(e * 1.7) * screen.height * 0.2), 1 + 0.1 * Math.sin(e * 1.3), 0, 0, limits);
          state = { lens: current, fade: null };
          dirty = true;
          requestAnimationFrame(drift);
        };
        recording = false;
        marks = [];
        recording = true;
        requestAnimationFrame(drift);
      } else {
        marks = [];
        recording = true;
      }
      const t0 = performance.now();
      for (let i = 0; i < count; i += 1) {
        const a = performance.now();
        const blob = await renderer.rasterise({ ...stage, ambient: 1 + i }, { maxSide, mime: 'image/jpeg', quality: 0.8 });
        timing.total.push(performance.now() - a);
        timing.bytes.push(blob?.size ?? 0);
        if (blob !== null) {
          // the picture comes back in as a texture: decode and, on its first draw, upload
          const u = performance.now();
          const url = URL.createObjectURL(blob);
          await renderer.preload(url);
          timing.upload.push(performance.now() - u);
          URL.revokeObjectURL(url);
        }
        await sleep(120);
      }
      const t1 = performance.now();
      recording = false;
      if (originalRead !== undefined) proto['readPixels'] = originalRead;
      OffscreenCanvas.prototype.convertToBlob = originalConvert;
      const med = (list: number[]): number => percentile(list, 50);
      return {
        moving,
        maxSide,
        count,
        pixels: stage.viewport.width && Math.round((maxSide / Math.max(screen.width, screen.height)) * screen.width) * Math.round((maxSide / Math.max(screen.width, screen.height)) * screen.height),
        totalMs: { median: med(timing.total), p95: percentile(timing.total, 95), max: Math.max(...timing.total) },
        readPixelsMs: { median: med(timing.read), max: Math.max(...timing.read) },
        flipAndPutMs: { median: med(timing.flip), max: Math.max(...timing.flip) },
        encodeMs: { median: med(timing.encode), max: Math.max(...timing.encode) },
        decodeMs: { median: med(timing.upload), max: Math.max(...timing.upload) },
        blobBytes: med(timing.bytes),
        frames: moving ? summarise(marks, t0, t1) : { intervalMs: summarise(marks, t0, t1)['intervalMs'], over33: summarise(marks, t0, t1)['over33'] },
      };
    },
  };

  (window as unknown as { __wall: typeof api }).__wall = api;
  dirty = true;
  requestAnimationFrame(loop);

  // the hands, for looking at it: drag to pan, wheel to zoom, click a tile to glide to it
  const el = host;
  let drag: { x: number; y: number; id: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
    gliding = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    current = panBy(current, e.clientX - drag.x, e.clientY - drag.y);
    drag = { ...drag, x: e.clientX, y: e.clientY };
    state = { lens: current, fade: null };
    dirty = true;
  });
  el.addEventListener('pointerup', (e) => {
    if (drag === null) return;
    drag = null;
    const wx = current.x + (e.clientX - screen.width / 2) / current.scale;
    const wy = current.y + (e.clientY - screen.height / 2) / current.scale;
    void wx;
    void wy;
  });
  el.addEventListener('dblclick', (e) => {
    const wx = current.x + (e.clientX - screen.width / 2) / current.scale;
    const wy = current.y + (e.clientY - screen.height / 2) / current.scale;
    const tile = plan.tiles.find((t) => wx >= t.box.x && wx <= t.box.x + t.box.width && wy >= t.box.y && wy <= t.box.y + t.box.height);
    if (tile !== undefined) startGlide(focusLens(tile, screen), performance.now(), tile.index);
  });
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) current = zoomAbout(current, Math.exp(-e.deltaY * 0.01), e.clientX - screen.width / 2, e.clientY - screen.height / 2, limits);
      else current = panBy(current, -e.deltaX, -e.deltaY);
      state = { lens: current, fade: null };
      dirty = true;
    },
    { passive: false },
  );
}

boot().catch((error) => {
  document.body.textContent = `wall bench failed: ${error instanceof Error ? error.stack : String(error)}`;
  (window as unknown as { __wallError: string }).__wallError = String(error);
});
