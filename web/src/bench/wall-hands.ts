// Entry for bench-wall-hands.html (WL2): the wall under real hands. Pictures drawn by the three renderer, a `LensRig` for the camera, and
// `attachGestures` on the room for touch, mouse, wheel, keys and Safari's gesture events. One live DOM frame (a card with a slider) shows
// only for the tile at full size and at rest; a far frame has no DOM. The server tool (`pnpm wall-bench hands`)
// drives it with real input over DevTools and reads the per-frame lens trace this page keeps.
//
//   bench-wall-hands.html?source=real|made&screen=phone|desk&motion=glide|fade&hud=1

import { LOOKS } from '../looks';
import { flatSpec } from '../render/three/style';
import { createProbedRenderer } from '../render/three';
import { planWall, wallCounters } from '../wall/plan';
import type { WallNode, WallPlan, WallShape } from '../wall/plan';
import { DESK_CAPS, PHONE_CAPS, TileCache } from '../wall/tiles';
import type { TileSource } from '../wall/tiles';
import { LensRig } from '../wall/lens';
import { attachGestures } from '../wall/gestures';
import { focusLens, visibleTiles, wallFrame } from '../wall/view';
import type { Lens, LensState, Motion, WallView } from '../wall/view';
import { setPictureBudget } from '../render/three/pictures';

const params = new URLSearchParams(location.search);
const phone = (params.get('screen') ?? (innerWidth < 700 ? 'phone' : 'desk')) === 'phone';
const source = params.get('source') ?? 'made';
const caps = phone ? PHONE_CAPS : DESK_CAPS;
const screen = { width: innerWidth, height: innerHeight };
const dpr = Math.min(2, window.devicePixelRatio || 1);
const hud = params.get('hud') === '1';

interface Manifest {
  readonly tiles: readonly TileSource[];
}

interface Mark {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly fade: number;
  readonly drawn: boolean;
  readonly kind: string;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function boot(): Promise<void> {
  const manifest = (await (await fetch(`/api/wall/manifest?source=${source}&screen=${phone ? 'phone' : 'desk'}&n=${params.get('n') ?? ''}`)).json()) as Manifest;
  const nodes: WallNode[] = manifest.tiles.map((tile) => ({ id: tile.id, lane: tile.lane, from: null, seq: tile.seq, title: tile.title }));
  const shape: WallShape = { cell: { width: screen.width, height: screen.height }, gap: Math.round(Math.min(screen.width, screen.height) * 0.1), axis: phone ? 'column' : 'row' };
  const plan: WallPlan = planWall(nodes, shape);

  const room = document.getElementById('room') as HTMLElement;
  const host = document.getElementById('host') as HTMLElement;
  const live = document.getElementById('live') as HTMLElement;
  const slider = document.getElementById('live-slider') as HTMLInputElement;
  const output = document.getElementById('live-value') as HTMLOutputElement;
  const liveTitle = document.getElementById('live-title') as HTMLElement;
  room.style.width = host.style.width = `${screen.width}px`;
  room.style.height = host.style.height = `${screen.height}px`;
  const renderer = createProbedRenderer();
  const spec = flatSpec(LOOKS['paper']);
  await renderer.mount(host, { width: screen.width, height: screen.height, dpr }, 'paper', { looks: ['paper'] });
  setPictureBudget(caps.bytes);
  const cache = new TileCache(plan, manifest.tiles, (url) => renderer.preload(url), caps);

  // the motion in force: the system's setting, or the shell's "Motion: fade" bit
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let shellFade = params.get('motion') === 'fade';
  const motion = (): Motion => (reduceQuery.matches || shellFade ? 'fade' : 'glide');

  const rig = new LensRig(plan, screen, { motion });
  let dirty = true;
  let state: LensState = { lens: rig.map, fade: null };
  const events: { kind: string; t: number; tile: number | null }[] = [];
  const stamp = (kind: string, tile: number | null): void => void events.push({ kind, t: performance.now(), tile });
  rig.onGo = (tile) => {
    if (tile !== null) cache.pin(tile.index);
    stamp('go', tile?.index ?? null);
  };
  rig.onArrive = (tile) => {
    stamp('arrive', tile?.index ?? null);
    dirty = true;
  };
  cache.onLand = () => {
    dirty = true;
  };
  window.addEventListener('pointerup', (e) => stamp(`up:${e.pointerType}`, null), true);

  // one live frame: the tile at full size and at rest. The slider keeps a value for each tile, as `held` would.
  const values = new Map<number, number>();
  let liveIndex: number | null = null;
  slider.addEventListener('input', () => {
    if (liveIndex === null) return;
    values.set(liveIndex, Number(slider.value));
    output.textContent = slider.value;
    stamp('slider', liveIndex);
  });
  const syncLive = (): void => {
    const tile = rig.live();
    const index = tile === null ? null : tile.index;
    if (index === liveIndex) return;
    liveIndex = index;
    if (index === null) {
      live.style.display = 'none';
      return;
    }
    const held = values.get(index) ?? 40;
    slider.value = String(held);
    output.textContent = String(held);
    liveTitle.textContent = `Frame ${index}`;
    live.style.display = 'block';
  };

  const hands = attachGestures(room, rig, {
    plan: () => plan,
    screen: () => screen,
    inLive: (target) => target instanceof Node && live.contains(target) && live.style.display !== 'none',
    onTap: (tile) => stamp('tap', tile.index),
    onChange: () => {
      dirty = true;
    },
  });
  hands.setOn(true);

  const view = (now: number): WallView => ({ screen, dpr, spec, ambient: now / 1000, reducedMotion: motion() === 'fade' });
  const gl = { draws: 0 };

  let marks: Mark[] = [];
  let recording = false;
  let drawn = 0;

  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    state = rig.tick(now);
    syncLive();
    const moving = rig.moving();
    let did = false;
    if (moving || dirty) {
      cache.prepare(state.lens, screen, state.fade?.from);
      renderer.render(wallFrame(plan, state, cache, view(now)));
      dirty = false;
      did = true;
      drawn += 1;
    }
    if (recording) marks.push({ t: now, x: state.lens.x, y: state.lens.y, scale: state.lens.scale, fade: state.fade?.k ?? -1, drawn: did, kind: rig.kind });
    if (hud) paintHud();
  };

  const paintHud = (): void => {
    const el = document.getElementById('hud');
    if (el !== null) el.textContent = `lens ${state.lens.x.toFixed(0)},${state.lens.y.toFixed(0)} x${state.lens.scale.toFixed(3)} ${rig.kind} focus ${String(rig.focus)} live ${String(liveIndex)} motion ${motion()}`;
  };

  const sliderFraction = (): { fx: number; fy: number } => {
    const was = live.style.display;
    live.style.display = 'block';
    live.style.visibility = 'hidden';
    const r = slider.getBoundingClientRect();
    live.style.display = was;
    live.style.visibility = '';
    return { fx: (r.left + r.width / 2) / screen.width, fy: (r.top + r.height / 2) / screen.height };
  };

  // ------------------------------------------------------------------ what the driver asks

  const api = {
    ready: true,
    info() {
      return { tiles: plan.tiles.length, lanes: plan.lanes, digest: plan.digest, screen, dpr, phone, source, map: rig.map, limits: rig.limits, motion: motion(), caps, touchAction: room.style.touchAction, planCalls: wallCounters.plan };
    },
    async warm(): Promise<void> {
      cache.warm();
      const until = performance.now() + 20_000;
      while (!cache.idle() && performance.now() < until) await sleep(50);
      dirty = true;
      await sleep(250);
    },
    setMotion(m: 'glide' | 'fade'): void {
      shellFade = m === 'fade';
    },
    /** put the lens somewhere with no animation (a test's starting place) */
    place(where: 'map' | number): void {
      if (where === 'map') rig.jump(rig.map, null);
      else {
        const tile = plan.tiles[where];
        if (tile !== undefined) rig.jump(focusLens(tile, screen), tile);
      }
      dirty = true;
    },
    lens(): Lens & { kind: string; focus: number | null; live: number | null } {
      const l = rig.state(performance.now()).lens;
      return { ...l, kind: rig.kind, focus: rig.focus, live: liveIndex };
    },
    /** where a tile's centre is on the screen now */
    tilePoint(index: number): { x: number; y: number; w: number; h: number; visible: boolean } | null {
      const tile = plan.tiles[index];
      if (tile === undefined) return null;
      const l = rig.state(performance.now()).lens;
      const x = (tile.box.x + tile.box.width / 2 - l.x) * l.scale + screen.width / 2;
      const y = (tile.box.y + tile.box.height / 2 - l.y) * l.scale + screen.height / 2;
      return { x, y, w: tile.box.width * l.scale, h: tile.box.height * l.scale, visible: visibleTiles(plan, l, screen).includes(tile) };
    },
    /** tiles with their centre on the screen now, away from the centre first (a tap target that is not the one at the middle) */
    onScreen(): { index: number; x: number; y: number; w: number }[] {
      const l = rig.state(performance.now()).lens;
      return visibleTiles(plan, l, screen).map((t) => ({ index: t.index, x: (t.box.x + t.box.width / 2 - l.x) * l.scale + screen.width / 2, y: (t.box.y + t.box.height / 2 - l.y) * l.scale + screen.height / 2, w: t.box.width * l.scale }));
    },
    /** where tile `index`'s slider would be on screen now, were it live, and what is at that point */
    sliderPoint(index: number): { x: number; y: number; inside: boolean; element: string } | null {
      const tile = plan.tiles[index];
      if (tile === undefined) return null;
      const f = sliderFraction();
      const l = rig.state(performance.now()).lens;
      const x = (tile.box.x + tile.box.width * f.fx - l.x) * l.scale + screen.width / 2;
      const y = (tile.box.y + tile.box.height * f.fy - l.y) * l.scale + screen.height / 2;
      const el = document.elementFromPoint(x, y);
      return { x, y, inside: x >= 0 && y >= 0 && x <= screen.width && y <= screen.height, element: el === null ? 'none' : `${el.tagName.toLowerCase()}${el.id === '' ? '' : `#${el.id}`}` };
    },
    setSlider(index: number, value: number): void {
      values.set(index, value);
      if (liveIndex === index) {
        slider.value = String(value);
        output.textContent = String(value);
      }
    },
    values(): Record<string, number> {
      return Object.fromEntries(values);
    },
    liveState(): { liveIndex: number | null; display: string; rangeInputsVisible: number; value: string } {
      return { liveIndex, display: live.style.display, rangeInputsVisible: live.style.display === 'none' ? 0 : 1, value: slider.value };
    },
    sliderRectNow(): { x: number; y: number } | null {
      if (live.style.display === 'none') return null;
      const r = slider.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    traceStart(): void {
      marks = [];
      events.length = 0;
      drawn = 0;
      recording = true;
    },
    traceStop(): { marks: number[][]; events: { kind: string; t: number; tile: number | null }[]; drawn: number; kinds: string[] } {
      recording = false;
      const kinds = [...new Set(marks.map((m) => m.kind))];
      return { marks: marks.map((m) => [m.t, m.x, m.y, m.scale, m.fade, m.drawn ? 1 : 0]), events: [...events], drawn, kinds };
    },
    stats() {
      return { planCalls: wallCounters.plan, cache: { ...cache.stats }, heldCount: cache.heldCount };
    },
    setHud(on: boolean): void {
      const el = document.getElementById('hud');
      if (el !== null) el.style.display = on ? 'block' : 'none';
    },
  };
  void gl;
  (window as unknown as { __hands: typeof api }).__hands = api;
  dirty = true;
  requestAnimationFrame(loop);
}

boot().catch((error) => {
  document.body.textContent = `wall hands bench failed: ${error instanceof Error ? error.stack : String(error)}`;
  (window as unknown as { __wallError: string }).__wallError = String(error);
});
