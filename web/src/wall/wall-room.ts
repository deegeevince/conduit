// The wall in the main view (PLAN-wall WL3, steward decision 8): `/?wall=1`. Every answer that draws becomes a frame on one endless canvas; the
// camera is a `LensRig` and travels it with the WL2 hands.
//
//   what draws    the frame in focus, at full size and at rest, is the live stage (the painter, untouched). Every other frame is its picture: the
//                 snapshot its turn already took, served by the server's snapshot route. A second three renderer draws those pictures in a layer
//                 over the stage; the layer is there whenever the camera moves or looks from far, and fades away (120 ms) when the camera has landed.
//   frames        `source-turns.ts` says which turn makes which frame (no `scene`: the frame changes in place; a new `scene`: a new lane; a tap's
//                 follow-up: the next slot). The plan is `planWall`, derived every time and never stored.
//   the camera    glides to a new frame when the first `scene` line arrives, while the person is following (until they move the lens: then a chip
//                 says "Answer arriving · Go"). It stays on the last frame at a turn's end. Nothing here moves the lens by itself otherwise.
//   the sync      when the lens settles on a frame the transcript marks that turn; tapping a turn in the transcript flies to its frame.
//
// This file is the one place the wall meets the page. The painter, the transcript and the renderer know nothing of each other through it.

import { API, serializeLine } from '@conduit/language';
import type { StageEvent } from '@conduit/language';
import type { StageApp } from '../app/stage-app';
import type { Transcript } from '../chrome/transcript';
import type { Renderer } from '../contracts/renderer';
import { LOOKS } from '../looks';
import { answerScript } from '../shell/model';
import { createThreeRenderer } from '../render/three';
import { setPictureBudget } from '../render/three/pictures';
import { flatSpec } from '../render/three/style';
import { attachGestures } from './gestures';
import type { Hands } from './gestures';
import { LensRig } from './lens';
import { planWall } from './plan';
import type { Tile, WallNode, WallPlan, WallShape } from './plan';
import { wallNodesOfTurns } from './source-turns';
import type { WallTurn } from './source-turns';
import { DESK_CAPS, PHONE_CAPS, TileCache } from './tiles';
import type { TileSource } from './tiles';
import { focusLens, visibleTiles, wallFrame } from './view';
import type { Lens, LensState, Motion, WallView } from './view';

const MOTION_KEY = 'conduit.wallMotion';
const PAGE_PREFIX = 'local-page-';
/** a snapshot is asked for again at these delays (ms) until the server has it */
const PROBE_DELAYS = [350, 700, 1400, 2800, 5000, 8000, 12000, 20000] as const;
const PICTURE_SIDE = 768;
/** the stage needs a few frames to draw what a restage puts on it before the picture lets go of it */
const RESTAGE_SETTLE_MS = 220;

export interface WallRoomOptions {
  readonly host: HTMLElement;
  readonly app: StageApp;
  readonly transcript: Transcript;
  /** `?motion=reduced|full` from the page's parameters */
  readonly motionParam: 'auto' | 'reduced' | 'full';
}

export interface WallRoom {
  /** the shell's "Motion: glide or fade" setting */
  motionSetting(): Motion;
  setMotionSetting(motion: Motion): void;
  /** the transcript's turn heading was tapped */
  goTurn(turn: string): void;
  dispose(): void;
}

interface TurnRec {
  readonly turn: string;
  readonly kind: string;
  readonly said: string;
  lines: string[];
  /** the lines came from the painter's recording (the turn has ended) */
  final: boolean;
}

function wordsOfInput(input: { readonly kind: string; readonly text?: string; readonly script?: string; readonly note?: string }): string {
  if (input.kind === 'prompt' || input.kind === 'tap' || input.kind === 'act') return input.text ?? '';
  if (input.kind === 'demo') return input.script ?? 'a demo';
  if (input.kind === 'refine') return input.note ?? 'went on';
  return 'a script';
}

const SCENE_LINE = /^\s*scene(\s|$)/;

export async function mountWall(options: WallRoomOptions): Promise<WallRoom | null> {
  const { host, app, transcript } = options;
  const painter = app.painter;
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const readSetting = (): Motion => {
    try {
      return window.localStorage.getItem(MOTION_KEY) === 'fade' ? 'fade' : 'glide';
    } catch {
      return 'glide';
    }
  };
  let setting: Motion = readSetting();
  /** the motion in force: the system's reduced-motion setting, `?motion=reduced`, or the shell's own "Motion: fade" */
  const motion = (): Motion => {
    if (options.motionParam === 'reduced') return 'fade';
    if (options.motionParam === 'auto' && reduceQuery.matches) return 'fade';
    return setting;
  };

  // ------------------------------------------------------------------ the layer over the stage

  const layer = document.createElement('div');
  layer.className = 'wall-layer';
  layer.dataset['state'] = 'off';
  layer.setAttribute('aria-hidden', 'true');
  const glHost = document.createElement('div');
  glHost.style.cssText = 'position:absolute;inset:0;';
  const labels = document.createElement('div');
  labels.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
  layer.append(glHost, labels);
  // what the person does on a picture is for the wall (it heard it first, in the capture phase); the stage under it hears nothing of it
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup'] as const) {
    layer.addEventListener(type, (event) => event.stopPropagation());
  }
  const nav = document.createElement('div');
  nav.className = 'wall-nav';
  nav.hidden = true;
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Frames on the canvas');
  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.textContent = '‹';
  prevButton.setAttribute('aria-label', 'Previous reply');
  const where = document.createElement('span');
  where.className = 'wall-nav__where';
  where.setAttribute('aria-live', 'polite');
  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.textContent = '›';
  nextButton.setAttribute('aria-label', 'Next reply');
  const mapButton = document.createElement('button');
  mapButton.type = 'button';
  mapButton.textContent = 'Map';
  mapButton.setAttribute('aria-label', 'Show the map of every frame (0)');
  nav.append(prevButton, where, nextButton, mapButton);
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'wall-chip';
  chip.hidden = true;
  chip.textContent = 'Answer arriving · Go';
  const list = document.createElement('ul');
  list.className = 'visually-hidden';
  list.setAttribute('aria-label', 'Frames');
  host.append(layer, nav, chip, list);

  const inLayer = (target: EventTarget | null): boolean => target instanceof Node && layer.contains(target);
  /** the navigator and the chip are controls: a finger on them is theirs, never the wall's */
  const inControls = (target: EventTarget | null): boolean => target instanceof Node && (nav.contains(target) || chip.contains(target));
  for (const el of [nav, chip]) {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'mousedown', 'mouseup'] as const) el.addEventListener(type, (event) => event.stopPropagation());
  }

  // ------------------------------------------------------------------ the renderer for the pictures

  let screen = { width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight) };
  const phone = (): boolean => screen.width < 700;
  const dprNow = (): number => Math.min(2, window.devicePixelRatio || 1);
  const lookId = painter.snapshot().look;
  let renderer: Renderer;
  try {
    renderer = createThreeRenderer();
    if (!renderer.capabilities.capture && renderer.id.includes('plain')) throw new Error('the wall needs the WebGL renderer');
    await renderer.mount(glHost, { width: screen.width, height: screen.height, dpr: dprNow() }, lookId, { looks: [lookId] });
  } catch (cause) {
    layer.remove();
    nav.remove();
    chip.remove();
    list.remove();
    app.announce(`The canvas could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
  let caps = phone() ? PHONE_CAPS : DESK_CAPS;
  setPictureBudget(caps.bytes);
  const spec = flatSpec(LOOKS[lookId]);

  // ------------------------------------------------------------------ the turns, the nodes, the plan

  const turns: TurnRec[] = [];
  /** the turns the stage has had opened for real (not the pages the wall puts up to show an older frame) */
  let stageTurn: string | null = null;
  let streamingTurn: string | null = null;
  let busy = false;

  const asWall = (): WallTurn[] => turns.map((t) => ({ turn: t.turn, kind: t.kind, said: t.said, lines: t.lines }));
  const shapeOf = (): WallShape => ({ cell: { width: screen.width, height: screen.height }, gap: Math.round(Math.min(screen.width, screen.height) * 0.1), axis: phone() ? 'column' : 'row' });

  interface Frames {
    readonly nodes: readonly WallNode[];
    /** the frame each turn belongs to (null before the first); a turn that writes no scene belongs to the frame before it */
    readonly frameOf: Map<string, string | null>;
    /** the turns of a frame, in order; the first opened it */
    readonly turnsOf: Map<string, string[]>;
  }
  const framesOf = (): Frames => {
    const all = asWall();
    const nodes = wallNodesOfTurns(all);
    const frameOf = new Map<string, string | null>();
    const turnsOf = new Map<string, string[]>();
    let seen = 0;
    let current: string | null = null;
    for (let k = 0; k < all.length; k += 1) {
      const upTo = wallNodesOfTurns(all.slice(0, k + 1));
      if (upTo.length > seen) current = upTo[upTo.length - 1]?.id ?? current;
      seen = upTo.length;
      const turn = all[k]?.turn;
      if (turn === undefined) continue;
      frameOf.set(turn, current);
      if (current !== null) turnsOf.set(current, [...(turnsOf.get(current) ?? []), turn]);
    }
    return { nodes, frameOf, turnsOf };
  };

  let frames: Frames = { nodes: [], frameOf: new Map(), turnsOf: new Map() };
  let plan: WallPlan = planWall([], shapeOf());
  let rig: LensRig | null = null;
  let hands: Hands | null = null;
  let cache: TileCache | null = null;
  let dirty = true;
  let state: LensState | null = null;
  let layerState: 'off' | 'on' | 'away' = 'off';
  let revealAt = 0;
  /** the turn the person asked to see (tapped, previous, next): the stage shows the frame as it stood at that turn; null: the frame's latest */
  let shownTurn: string | null = null;
  let marked: string | null = null;
  let following = true;
  let autoMove = false;
  let autoRevealed = false;

  const tileOfNode = (node: string): Tile | undefined => plan.tiles.find((tile) => tile.node === node);
  const latestTurnOf = (node: string): string | null => {
    const mine = frames.turnsOf.get(node);
    return mine === undefined ? null : (mine[mine.length - 1] ?? null);
  };
  const wantedTurn = (node: string): string | null => {
    const mine = frames.turnsOf.get(node) ?? [];
    return shownTurn !== null && mine.includes(shownTurn) ? shownTurn : latestTurnOf(node);
  };

  const makeRig = (first: Tile): void => {
    rig = new LensRig(plan, screen, { motion }, focusLens(first, screen));
    rig.jump(focusLens(first, screen), first);
    cache = new TileCache(plan, [], (url) => probeLoad(url), caps);
    cache.onLand = () => {
      dirty = true;
    };
    rig.onGo = (tile) => {
      if (!autoMove) {
        following = false;
        showChipIfArriving();
      }
      if (tile !== null) cache?.pin(tile.index);
      toLayer();
    };
    rig.onArrive = (tile) => {
      if (tile !== null) settle(tile);
      dirty = true;
    };
    hands = attachGestures(host, rig, {
      plan: () => plan,
      screen: () => screen,
      capture: true,
      inLive: (target) => inControls(target) || (layerState === 'away' && !inLayer(target)),
      onChange: () => {
        if (rig !== null && (rig.kind === 'hand' || rig.kind === 'coast')) {
          following = false;
          showChipIfArriving();
        }
        dirty = true;
        toLayer();
      },
    });
    hands.setOn(true);
  };

  /** Looks for what changed in the turns and makes the plan again. Returns the tiles that are new. */
  const replan = (): readonly Tile[] => {
    const before = plan.tiles.length;
    frames = framesOf();
    plan = planWall(frames.nodes, shapeOf());
    if (rig !== null) {
      rig.setPlan(plan, screen);
      cache?.setPlan(plan);
    }
    return plan.tiles.slice(before);
  };

  // ------------------------------------------------------------------ pictures: the snapshot route

  const retryAt = new Map<string, number>();
  let lastProbeError = '';
  const probeLoad = (url: string): Promise<void> => {
    const wait = retryAt.get(url);
    if (wait !== undefined && performance.now() < wait) return Promise.reject(new Error('not yet'));
    return renderer.preload(url).catch((cause: unknown) => {
      lastProbeError = `${url}: ${cause instanceof Error ? cause.message : String(cause)}`;
      retryAt.set(url, performance.now() + 1500);
      throw cause;
    });
  };

  const loadedIndex = new Map<string, number>();
  const snapshotOf = (turn: string): string | null => {
    const session = app.link.session;
    return session === null ? null : API.snapshot(session, turn);
  };

  /** Asks for a turn's snapshot until the server has it, then gives the frame that turn belongs to its picture. */
  const probe = (turn: string, attempt = 0): void => {
    const url = snapshotOf(turn);
    if (url === null || turn.startsWith(PAGE_PREFIX)) return;
    void renderer.preload(url).then(
      () => {
        const node = frames.frameOf.get(turn);
        if (node === undefined || node === null) return;
        const index = turns.findIndex((t) => t.turn === turn);
        if (index < (loadedIndex.get(node) ?? -1)) return;
        loadedIndex.set(node, index);
        const tile = tileOfNode(node);
        if (tile === undefined || cache === null) return;
        const aspect = screen.width / screen.height;
        const long = PICTURE_SIDE;
        const picture = { url, width: aspect >= 1 ? long : Math.round(long * aspect), height: aspect >= 1 ? Math.round(long / aspect) : long };
        const source: TileSource = { id: node, lane: String(tile.lane), seq: tile.index, title: frames.nodes.find((n) => n.id === node)?.title ?? node, aspect, tint: spec.roles.ground, still: picture, thumb: picture };
        cache.setSource(source);
        cache.warm();
        dirty = true;
      },
      () => {
        const delay = PROBE_DELAYS[attempt];
        if (delay !== undefined) setTimeout(() => probe(turn, attempt + 1), delay);
      },
    );
  };

  // ------------------------------------------------------------------ the layer's state

  const renderNow = (now: number): void => {
    if (rig === null || cache === null) return;
    state = rig.state(now);
    cache.prepare(state.lens, screen, state.fade?.from);
    renderer.render(wallFrame(plan, state, cache, wallView(now)));
    placeLabels(state.lens);
    dirty = false;
  };
  const wallView = (now: number): WallView => ({ screen, dpr: dprNow(), spec, ambient: now / 1000, reducedMotion: motion() === 'fade' });

  const labelEls: HTMLElement[] = [];
  const listButtons: HTMLButtonElement[] = [];
  const syncLabels = (): void => {
    while (labelEls.length < plan.tiles.length) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:600 13px/1.25 system-ui,sans-serif;color:var(--stage-ink);text-shadow:0 0 6px var(--stage-ground),0 0 2px var(--stage-ground);transform-origin:0 0;will-change:transform;';
      el.className = 'wall-label';
      labels.append(el);
      labelEls.push(el);
    }
    while (listButtons.length < plan.tiles.length) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const at = listButtons.length;
      button.addEventListener('click', () => {
        const tile = plan.tiles[at];
        if (tile !== undefined) flyTo(tile);
      });
      item.append(button);
      list.append(item);
      listButtons.push(button);
    }
    plan.tiles.forEach((tile, index) => {
      const title = frames.nodes[index]?.title ?? tile.node;
      const el = labelEls[index];
      if (el !== undefined) {
        el.textContent = `${tile.lane + 1}.${tile.slot + 1}  ${title}`;
        el.dataset['node'] = tile.node;
      }
      const button = listButtons[index];
      if (button !== undefined) button.textContent = `Frame ${index + 1}: ${title}`;
    });
  };

  const placeLabels = (lens: Lens): void => {
    for (let i = 0; i < plan.tiles.length; i += 1) {
      const tile = plan.tiles[i];
      const el = labelEls[i];
      if (tile === undefined || el === undefined) continue;
      const w = tile.box.width * lens.scale;
      const x = (tile.box.x - lens.x) * lens.scale + screen.width / 2;
      const y = (tile.box.y - lens.y) * lens.scale + screen.height / 2;
      // a label is for a frame seen from afar; at full size the frame is the thing
      const show = w < screen.width * 0.8 && w > 36 && x + w > 0 && y + 20 > 0 && x < screen.width && y < screen.height;
      if (!show) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'block';
      el.style.width = `${Math.max(40, w - 8)}px`;
      el.style.transform = `translate(${(x + 6).toFixed(1)}px, ${(y + 4).toFixed(1)}px)`;
    }
  };

  const setLayer = (next: 'on' | 'away'): void => {
    if (layerState === next) return;
    layerState = next;
    layer.dataset['state'] = next;
    layer.setAttribute('aria-hidden', 'true');
  };

  /** The picture takes over from the live stage, at once and drawn first, so there is no frame where neither is there. */
  const toLayer = (): void => {
    if (rig === null) return;
    if (layerState !== 'on') {
      renderNow(performance.now());
      setLayer('on');
    }
    revealAt = 0;
  };

  // ------------------------------------------------------------------ the live stage: which frame it shows

  /** Is the live stage (the painter) the right thing to show for this tile now? */
  const stageServes = (tile: Tile): boolean => {
    const wanted = wantedTurn(tile.node);
    if (wanted === null) return false;
    if (busy) {
      // an answer is being made: the stage is that frame's; any other frame is its picture, read-only (steward decision 5)
      return streamingTurn !== null && frames.frameOf.get(streamingTurn) === tile.node && stageTurn === streamingTurn;
    }
    return true;
  };

  const restageIfNeeded = (tile: Tile): boolean => {
    const wanted = wantedTurn(tile.node);
    if (wanted === null || busy || stageTurn === wanted) return false;
    const script = answerScript(turns.map((t) => ({ turn: t.turn, kind: t.kind, lines: t.lines })), wanted);
    if (script === null || script.trim() === '') return false;
    app.showPage(script);
    painter.showAll();
    stageTurn = wanted;
    return true;
  };

  /** Called every frame at rest: lets the stage take over from the picture once the camera has landed on a frame it can serve. */
  const syncLayer = (now: number): void => {
    if (rig === null) return;
    const live = rig.live();
    if (live === null || !stageServes(live)) {
      if (layerState !== 'on') toLayer();
      return;
    }
    if (layerState === 'away') return;
    if (revealAt === 0) {
      revealAt = now + (restageIfNeeded(live) ? RESTAGE_SETTLE_MS : 0);
      return;
    }
    if (now >= revealAt) {
      revealAt = 0;
      setLayer('away');
    }
  };

  // ------------------------------------------------------------------ moving: flying to a frame, settling on one

  const flyTo = (tile: Tile, turn: string | null = null): void => {
    if (rig === null) return;
    shownTurn = turn;
    autoMove = false;
    const same = rig.live()?.index === tile.index || (rig.focus === tile.index && rig.kind === 'rest' && layerState === 'away');
    if (same) {
      // the same frame, a different reply: no flight, a seek to that version
      revealAt = 0;
      toLayer();
      settle(tile);
      return;
    }
    rig.goTo(tile, performance.now());
  };

  const goTurn = (turn: string): void => {
    const node = frames.frameOf.get(turn);
    if (node === undefined || node === null) {
      app.announce('That reply drew nothing to go to.');
      return;
    }
    const tile = tileOfNode(node);
    if (tile !== undefined) flyTo(tile, turn);
  };

  /** The camera has settled on a frame: the transcript marks the turn on view, the navigator says where. */
  const settle = (tile: Tile): void => {
    const turn = wantedTurn(tile.node);
    marked = turn;
    transcript.markTurn(turn);
    if (arrivingNode === tile.node) chip.hidden = true;
    syncNav();
  };

  // ------------------------------------------------------------------ the navigator

  let arrivingNode: string | null = null;
  const showChipIfArriving = (): void => {
    if (arrivingNode !== null && rig !== null && rig.live()?.node !== arrivingNode) {
      chip.hidden = false;
      chip.textContent = streamingTurn === null ? 'Answer ready · Go' : 'Answer arriving · Go';
    }
  };

  const replies = (): string[] => turns.filter((t) => frames.frameOf.get(t.turn) !== undefined && frames.frameOf.get(t.turn) !== null).map((t) => t.turn);

  const syncNav = (): void => {
    nav.hidden = plan.tiles.length === 0;
    const all = replies();
    const at = marked === null ? -1 : all.indexOf(marked);
    const atMap = rig !== null && rig.atMap();
    prevButton.disabled = all.length === 0 || (at <= 0 && at !== -1);
    nextButton.disabled = all.length === 0 || (at >= 0 && at >= all.length - 1);
    if (atMap || at < 0) where.textContent = `Map · ${plan.tiles.length} ${plan.tiles.length === 1 ? 'frame' : 'frames'}`;
    else {
      const node = frames.frameOf.get(all[at] ?? '');
      const title = frames.nodes.find((n) => n.id === node)?.title ?? '';
      where.textContent = `Reply ${at + 1} of ${all.length} · ${title}`;
    }
  };

  const step = (by: -1 | 1): void => {
    const all = replies();
    if (all.length === 0) return;
    const at = marked === null ? -1 : all.indexOf(marked);
    const next = all[at < 0 ? (by === 1 ? 0 : all.length - 1) : at + by];
    if (next !== undefined) goTurn(next);
  };
  prevButton.addEventListener('click', () => step(-1));
  nextButton.addEventListener('click', () => step(1));
  mapButton.addEventListener('click', () => {
    hands?.toggleMap();
  });
  chip.addEventListener('click', () => {
    const tile = arrivingNode === null ? undefined : tileOfNode(arrivingNode);
    chip.hidden = true;
    if (tile === undefined || rig === null) return;
    following = true;
    autoMove = true;
    shownTurn = null;
    rig.goTo(tile, performance.now());
    autoMove = false;
  });

  // ------------------------------------------------------------------ what the stage tells the wall

  const offTranscript = painter.on('transcript', (event) => {
    if (event.kind !== 'turn' || event.turn.startsWith(PAGE_PREFIX) || turns.some((t) => t.turn === event.turn)) return;
    turns.push({ turn: event.turn, kind: event.input.kind, said: wordsOfInput(event.input as { kind: string; text?: string; script?: string }), lines: [], final: false });
    stageTurn = event.turn;
    streamingTurn = event.turn;
    busy = true;
    following = true;
    arrivingNode = null;
    chip.hidden = true;
    shownTurn = null;
    replan();
  });

  /** Lines of the open turn arrive: a first `scene` opens a frame, and the camera goes there if it is following. */
  const onLine = (turn: string, text: string): void => {
    const rec = turns.find((t) => t.turn === turn);
    if (rec === undefined || rec.final) return;
    rec.lines.push(text);
    if (!SCENE_LINE.test(text)) return;
    const added = replan();
    const tile = added[added.length - 1];
    if (tile === undefined) return;
    syncLabels();
    syncNav();
    if (rig === null) {
      makeRig(tile);
      // the first frame: the camera is on it from the start
      settle(tile);
      dirty = true;
      return;
    }
    arrivingNode = tile.node;
    if (following) {
      autoMove = true;
      shownTurn = null;
      rig.goTo(tile, performance.now());
      autoMove = false;
    } else showChipIfArriving();
  };

  const offEvent = app.link.onEvent((event: StageEvent) => {
    if (event.type === 'line') onLine(event.turn, event.text);
    else if (event.type === 'end') endOf(event.turn);
  });

  /** A turn is over (the brain stopped; the stage may still be playing it): its lines are the painter's own once it is recorded. */
  const endOf = (turn: string): void => {
    if (turn === streamingTurn) {
      showChipIfArriving();
    }
    // the snapshot is taken at rest, a little after: ask until the server has it
    setTimeout(() => collect(), 300);
  };

  /** Takes in the painter's recordings (the demo's lines, and each ended turn's own) and the stage's busy state. */
  let recordedCount = -1;
  const collect = (): void => {
    const open = painter.snapshot().turn;
    busy = open !== null && !open.startsWith(PAGE_PREFIX);
    if (!busy && streamingTurn !== null) {
      const ended = streamingTurn;
      streamingTurn = null;
      probe(ended);
      showChipIfArriving();
    }
    const recs = painter.recordings();
    if (recs.length === recordedCount) return;
    recordedCount = recs.length;
    let changed = false;
    for (const rec of recs) {
      const mine = turns.find((t) => t.turn === rec.turn);
      if (mine === undefined || mine.final) continue;
      // an open stream's lines are the server's own; a finished turn's are the recording's, which cover the demo that never came by the link
      mine.lines = rec.lines.map((entry) => serializeLine(entry.line));
      mine.final = true;
      changed = true;
    }
    if (!changed) return;
    const added = replan();
    syncLabels();
    const tile = added[0];
    if (tile !== undefined && rig === null) {
      makeRig(tile);
      settle(tile);
    }
    syncNav();
    dirty = true;
  };
  const poll = setInterval(collect, 250);

  const offUpload = painter.on('upload', (upload) => {
    if (upload.kind === 'snapshot') probe(upload.turn);
  });

  // ------------------------------------------------------------------ the frame loop

  interface Mark {
    t: number;
    x: number;
    y: number;
    scale: number;
    fade: number;
    drawn: boolean;
    kind: string;
    layer: string;
  }
  let marks: Mark[] = [];
  let recording = false;
  let drawnFrames = 0;
  let raf = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    if (rig === null || cache === null) return;
    const wasKind = rig.kind;
    state = rig.tick(now);
    if (wasKind !== rig.kind && rig.kind === 'rest' && (wasKind === 'hand' || wasKind === 'coast')) {
      // a pan that stopped: the frame under the middle of the screen, if the camera is close to it, is where it settled
      const live = rig.live();
      if (live !== null) settle(live);
    }
    const moving = rig.moving();
    let drew = false;
    if (layerState === 'on' && (moving || dirty)) {
      cache.prepare(state.lens, screen, state.fade?.from);
      renderer.render(wallFrame(plan, state, cache, wallView(now)));
      placeLabels(state.lens);
      dirty = false;
      drew = true;
      drawnFrames += 1;
    }
    if (!moving) syncLayer(now);
    if (!autoRevealed && rig !== null) {
      autoRevealed = true;
      syncNav();
    }
    if (recording) marks.push({ t: now, x: state.lens.x, y: state.lens.y, scale: state.lens.scale, fade: state.fade?.k ?? -1, drawn: drew, kind: rig.kind, layer: layerState });
  };
  raf = requestAnimationFrame(loop);

  // ------------------------------------------------------------------ the screen changes size

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const sizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = { width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight) };
      if (next.width === screen.width && next.height === screen.height) return;
      const wasAtMap = rig?.atMap() === true;
      const focus = rig?.focus ?? null;
      screen = next;
      caps = phone() ? PHONE_CAPS : DESK_CAPS;
      setPictureBudget(caps.bytes);
      renderer.resize({ width: screen.width, height: screen.height, dpr: dprNow() });
      plan = planWall(frames.nodes, shapeOf());
      if (rig !== null) {
        rig.setPlan(plan, screen);
        cache?.setPlan(plan);
        const tile = focus === null ? undefined : plan.tiles[focus];
        if (wasAtMap || tile === undefined) rig.jump(rig.map, null);
        else rig.jump(focusLens(tile, screen), tile);
      }
      dirty = true;
    }, 150);
  });
  sizeObserver.observe(host);

  // ------------------------------------------------------------------ the test hook

  const hook = {
    ready: true,
    info() {
      const l = rig === null ? null : rig.state(performance.now()).lens;
      return {
        tiles: plan.tiles.map((t) => ({ node: t.node, index: t.index, lane: t.lane, slot: t.slot, title: frames.nodes[t.index]?.title ?? '' })),
        lanes: plan.lanes,
        digest: plan.digest,
        turns: turns.map((t) => ({ turn: t.turn, kind: t.kind, said: t.said, frame: frames.frameOf.get(t.turn) ?? null, lines: t.lines.length })),
        focus: rig?.focus ?? null,
        live: rig?.live()?.node ?? null,
        layer: layerState,
        kind: rig?.kind ?? 'none',
        lens: l,
        map: rig?.map ?? null,
        following,
        chip: chip.hidden ? null : chip.textContent,
        marked,
        stageTurn,
        busy,
        screen,
        motion: motion(),
        touchAction: host.style.touchAction,
        drawn: drawnFrames,
        pictures: plan.tiles.map((t) => cache?.hasSource(t.node) === true),
        held: cache?.heldCount ?? 0,
        lastProbeError,
        cacheStats: cache === null ? null : { ...cache.stats },
      };
    },
    lens(): Lens & { kind: string; focus: number | null; layer: string } {
      const l = rig === null ? { x: 0, y: 0, scale: 1 } : rig.state(performance.now()).lens;
      return { ...l, kind: rig?.kind ?? 'none', focus: rig?.focus ?? null, layer: layerState };
    },
    tilePoint(index: number): { x: number; y: number; w: number; h: number; visible: boolean } | null {
      const tile = plan.tiles[index];
      if (tile === undefined || rig === null) return null;
      const l = rig.state(performance.now()).lens;
      const rect = host.getBoundingClientRect();
      return {
        x: rect.left + (tile.box.x + tile.box.width / 2 - l.x) * l.scale + screen.width / 2,
        y: rect.top + (tile.box.y + tile.box.height / 2 - l.y) * l.scale + screen.height / 2,
        w: tile.box.width * l.scale,
        h: tile.box.height * l.scale,
        visible: visibleTiles(plan, l, screen).includes(tile),
      };
    },
    hostRect(): { left: number; top: number; width: number; height: number } {
      const r = host.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    goTurn,
    map(): void {
      hands?.toggleMap();
    },
    step,
    traceStart(): void {
      marks = [];
      drawnFrames = 0;
      recording = true;
    },
    traceStop(): { marks: number[][]; drawn: number; kinds: string[]; layers: string[] } {
      recording = false;
      return {
        marks: marks.map((m) => [m.t, m.x, m.y, m.scale, m.fade, m.drawn ? 1 : 0]),
        drawn: drawnFrames,
        kinds: [...new Set(marks.map((m) => m.kind))],
        layers: [...new Set(marks.map((m) => m.layer))],
      };
    },
    setMotion(m: Motion): void {
      setting = m;
    },
    navText(): string {
      return where.textContent ?? '';
    },
  };
  (window as unknown as { __wall: typeof hook }).__wall = hook;

  // frames made before the wall was mounted (the stage's own opening turn, a reload): take in what the painter has
  collect();

  return {
    motionSetting: () => setting,
    setMotionSetting(next) {
      setting = next;
      try {
        window.localStorage.setItem(MOTION_KEY, next);
      } catch {
        // the setting is for this visit only
      }
    },
    goTurn,
    dispose() {
      cancelAnimationFrame(raf);
      clearInterval(poll);
      clearTimeout(resizeTimer);
      sizeObserver.disconnect();
      offTranscript();
      offEvent();
      offUpload();
      hands?.dispose();
      cache?.dispose();
      renderer.dispose();
      layer.remove();
      nav.remove();
      chip.remove();
      list.remove();
    },
  };
}
