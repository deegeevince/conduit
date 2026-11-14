import { controlText, describeFigure, EMPTY_STAGE, holdControl, FULL_CAPABILITIES, NO_SERVICES, sceneAt, serializeLine, TurnScore, valueAt } from '@conduit/language';
import { CHARTS_READY } from '../render/chart';
import { STRUCTURES_READY } from './blocks';
import { CONTROLS_READY, controlEngine, createControlStore, nextEases } from './controls';
import { controlIndexOf, createRuntime, controlSpecOf, stateReader } from './bound';
import type { ControlSite } from './controls-stage';
import type { ChartData } from './charts';
import type { ChartView } from '../contracts/chart';
import { CALM } from '../contracts/controls';
import { NO_SIGHT } from '@conduit/language';
import type { DataTable, ControlValue, ControlValues, PassState } from '@conduit/language';
import type { BackEvent, Capabilities, ClockState, ElementSpan, Issue, Line, Schedule, ScoreEntry, Services, StageBase, TurnEndReason, TurnInput, TurnReport } from '@conduit/language';
import type { Recording } from '../contracts/film';
import { noteArrivals as noteArrivalsInto } from './arrivals';
import type { ElementFrame, Frame, Quality, ShapeFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import type { ControlView, LineView, Painter, PainterEvents, PainterOptions, PainterSnapshot, UiMockup } from '../contracts/painter';
import { REST_POSE } from '../contracts/space';
import type { Box, CameraPose, Viewport } from '../contracts/space';
import { PlayClock, pinnedWallTime } from './clock';
import type { ClockReading, Horizon } from './clock';
import { resolveInk } from './colour';
import { ease } from './ease';
import { canvasBoxOf, figuresAt, sketchKeysOf } from './figures';
import type { Painting } from './figures';
import { QualityGovernor } from './governor';
import { bodySize, marginOf, screenFacts } from './layout/metrics';
import { Reporter } from './report';
import { annotated } from './annotate';
import { placedOf, sightOf } from './sight';
import { textSignature, textSpansOf } from './text-out';
import { downUi, easeUi, easingUi, isScreenBlock, moveUi, setUiPicture, typeUi, typingUi, uiBlockAt, uiMockupViews, upUi } from './ui-stage';
import type { UiSend } from './ui-stage';
import { ENGINE_VERSION, measureStage } from '../engine';
import type { EngineInputs, EngineView } from '../engine';
import { buildTimeline, settledAfter, settledEnd as settledEndOf } from './timeline';
import type { Timeline, TimelineContext, TimelineInstant } from './timeline';

/** True once `notePass` answers `drafted` with a draft report (PLAN-v2.md, package T). Until then the server is told not to wait for one. */
const DRAFTS_READY = true;
/** True: a `candidate` event is tried on a copy of the open turn's score and answered with a `draft` (sight, placed boxes, `content`, a picture) for its pass, none of it shown. */
const CANDIDATES_READY = true;
/** Sequence numbers a candidate's lines carry on the copy of the score: far above any a turn will reach, so they never meet a real one. */
const CANDIDATE_SEQ = 1_000_000;
/** STUB(PLAN-v2.1 package T2): true once a `deck` turn stops at each slide and `Painter.slide` steps through them. */
const DECKS_READY = false;
/** True: `pic … from=<upload id>` draws the user's photo, fetched from `options.uploadUrl` (the session's own `/api/sessions/<id>/uploads/<upload id>`). */
const UPLOADS_READY = true;
/** STUB(PLAN-v2.1 part two): true once `say href=` is drawn as a link the viewer can follow. The brain is taught `href` only when it is. */
const LINKS_READY = false;
/** ms a chart waits for the rows it draws by reference before it is shown without them */
const DATA_WAIT_MS = 20_000;
/** ms the report on a draft waits for its picture before it goes without: under the server's own wait for it (1.5 s) */
const DRAFT_PICTURE_MS = 1000;

/** Dev only (a page served from this machine): `?holdDraft=<ms>` holds the draft report and its picture back, `?engine=<text>` pretends to be a stale bundle. Anywhere else: null. */
function devFlag(name: string): string | null {
  try {
    const host = globalThis.location?.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') return null;
    return new URLSearchParams(globalThis.location.search).get(name);
  } catch {
    return null;
  }
}


const HOME_SECONDS = 1.2;
const SETTLE_SECONDS = 0.12;
const GRACE_MS = 1000;
const GLYPH_HOLD_MS = 4000;
/** The cross-fade that "show all" settles the stage with. */
const SKIP_FADE_SECONDS = 0.15;
/** The longer side of a sketch or a snapshot sent to the server, in pixels. */
const PICTURE_SIDE = 768;
/** How long a picture of the stage waits for each live app to draw itself first, ms. */
const APP_PICTURE_MS = 1500;
/** How many finished turns can still be recorded for export: a conversation of this many turns can be saved whole. */
const KEPT_RECORDINGS = 64;

/** What the viewer did to open a turn, in a few words: the title of its card in a saved conversation. */
function askedOf(input: TurnInput): string {
  const words = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 200);
  switch (input.kind) {
    case 'prompt':
      return words(input.text);
    case 'tap':
      return `Tapped "${words(input.text)}"`;
    case 'act':
      return `Used "${words(input.text)}"`;
    case 'demo':
      return `Played the demo ${words(input.script)}`;
    case 'script':
      return 'Played a pasted script';
    case 'refine':
      return 'Kept making it better';
  }
}

interface Turn {
  readonly id: string;
  readonly input: TurnInput;
  readonly base: StageBase;
  readonly score: TurnScore;
  readonly seqs: Set<number>;
  readonly issues: Map<number, Issue[]>;
  ack: number;
  closed: boolean;
  started: boolean;
  /** the viewer asked to see everything at once: lines still arriving land settled */
  showingAll: boolean;
  /** where the playhead was when they asked */
  skippedAt: number | null;
}

/** What a finished or interrupted turn leaves for the hook to read. */
interface Memory {
  readonly playhead: number;
  readonly pen: number;
  readonly end: number;
  readonly lines: readonly LineView[];
}

type Listener<K extends keyof PainterEvents> = (event: PainterEvents[K]) => void;

function patched(schedule: Schedule, at: number): Schedule {
  const elements = schedule.elements
    .filter((element) => element.carried || (element.enter !== null && element.enter.start < at))
    .map((element) => ({
      ...element,
      exit: element.exit !== null && element.exit.start <= at ? element.exit : null,
      changes: element.changes.filter((change) => change.start < at),
    }));
  let end = at;
  for (const element of elements) {
    if (element.enter !== null) end = Math.max(end, element.enter.end);
    if (element.exit !== null) end = Math.max(end, element.exit.end);
    for (const change of element.changes) end = Math.max(end, change.end);
  }
  return {
    ...schedule,
    pen: Math.min(schedule.pen, at),
    end,
    scenes: schedule.scenes.filter((scene, i) => i === 0 || scene.start <= at),
    elements,
    // The camera stops travelling when the turn stops: the picture eases home from where it is (see `homing`), not toward the end of a move.
    camera: [],
    looks: schedule.looks.filter((span) => span.start < at),
    lines: schedule.lines.filter((line) => line.start < at),
  };
}

/** What a finished or interrupted turn leaves to be inspected with `seek` and `step`. */
interface Review {
  readonly schedule: Schedule;
  readonly base: StageBase;
}

/** The moment the last thing that had begun by `at` has finished. */
function completionOf(schedule: Schedule, at: number): number {
  let done = at;
  for (const element of schedule.elements) {
    if (element.enter !== null && element.enter.start < at) done = Math.max(done, element.enter.end);
    if (element.exit !== null && element.exit.start <= at) done = Math.max(done, element.exit.end);
    for (const change of element.changes) done = Math.max(done, change.end);
  }
  for (const span of schedule.looks) if (span.start < at) done = Math.max(done, span.end);
  return done;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The old frame giving way to the new one: every element and figure fades between its two opacities, by key. */
function crossFade(from: Frame, to: Frame, p: number): Frame {
  const fade = <T extends { readonly key: string; readonly opacity: number }>(before: readonly T[], after: readonly T[]): T[] => {
    const was = new Map(before.map((item) => [item.key, item]));
    const now = new Set(after.map((item) => item.key));
    const arriving = after.map((item) => ({ ...item, opacity: lerp(was.get(item.key)?.opacity ?? 0, item.opacity, p) }));
    const leaving = before.filter((item) => !now.has(item.key)).map((item) => ({ ...item, opacity: item.opacity * (1 - p) }));
    return [...leaving, ...arriving];
  };
  const a = from.camera;
  const b = to.camera;
  return {
    ...to,
    elements: fade<ElementFrame>(from.elements, to.elements),
    figures: fade(from.figures, to.figures),
    fields: fade(from.fields, to.fields),
    camera: { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), dolly: lerp(a.dolly, b.dolly, p), yaw: lerp(a.yaw, b.yaw, p), pitch: lerp(a.pitch, b.pitch, p), roll: lerp(a.roll, b.roll, p) },
  };
}

/**
 * Builds the painter around a mounted renderer. It starts its own frame loop
 * at once, draws the empty stage in the default look, and emits `ready` on
 * the back channel with the screen facts for this viewport.
 */
export function createPainter(options: PainterOptions): Painter {
  const { renderer, lockLook } = options;
  let viewport: Viewport = options.viewport;
  const reducedMotion = options.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const listeners: { [K in keyof PainterEvents]: Set<Listener<K>> } = { back: new Set(), transcript: new Set(), clock: new Set(), upload: new Set(), controls: new Set(), text: new Set() };
  const emit = <K extends keyof PainterEvents>(type: K, event: PainterEvents[K]): void => {
    queueMicrotask(() => {
      for (const listener of listeners[type]) (listener as Listener<K>)(event);
    });
  };
  const emitBack = (event: BackEvent): void => emit('back', event);

  const clock = new PlayClock();
  const reporter = new Reporter(emitBack);
  const governor = new QualityGovernor();
  const mountedAt = performance.now();

  const withLook = (stage: StageBase): StageBase => (lockLook === null || stage.look === lockLook ? stage : { ...stage, look: lockLook });
  let base: StageBase = withLook(EMPTY_STAGE);
  /** the stage a page of the app's own (`/help`) is covering; null when no page is up */
  let pageUnder: StageBase | null = null;
  let turn: Turn | null = null;
  let memory: Memory | null = null;
  /** the last finished or interrupted turn, kept so `seek` and `step` can still inspect it */
  let review: Review | null = null;
  /** true while `timeline` is that turn's, being inspected or replayed after the turn has rested */
  let reviewing = false;
  /** ids of every turn already opened: a replayed `turn` for one of them must not reopen it */
  const openedTurns = new Set<string>();
  const settledCache = new WeakMap<Schedule, number>();
  let timeline: Timeline;
  /** after an interrupt: the frozen schedule that is being run to completion */
  let settling: { readonly until: number } | null = null;
  let homing: { readonly from: CameraPose; readonly startedAt: number } | null = null;
  let lastClockState: ClockState = 'idle';
  let lastReadySpec: LookSpec | null = null;
  let lastFrameAt: number | null = null;
  /** performance.now() when the renderer first could not draw what it holds; null while it can */
  let undrawableSince: number | null = null;
  /** after GLYPH_HOLD_MS undrawable, playback goes on without the hold; only what is drawn is reported shown */
  let glyphStalled = false;
  let skipFrames = 0;
  let disposed = false;
  let frameHandle = 0;

  // What the server can do, and what has come of it ------------------------
  let services: Services = NO_SERVICES;
  const paintings = new Map<string, Painting>();
  /** news of paintings that are ready but whose picture has not yet come on stage, by element key */
  const arrived = new Map<string, string>();
  /** sketches to send once the playhead has drawn them: picture key to the turn-clock time that is so */
  const sketchQueue = new Map<string, number>();
  const sketched = new Set<string>();
  const recordings = new Map<string, Recording>();
  /** paintings that came after the turn they belong to was recorded: an exported film must show them, not the sketch */
  const latePaintings = new Map<string, string>();
  let lastRecorded: string | null = null;

  // Being heard, and skipping ----------------------------------------------
  let anticipation: { readonly tappedKey: string | null; readonly since: number } | null = null;
  let fading: { readonly from: Frame; readonly startedAt: number } | null = null;
  let lastFrame: Frame | null = null;

  /** Faults seen while making frames, by message: said once to the console, counted for the HUD and `__stage`. */
  const faults = new Map<string, number>();
  let lastFault: string | null = null;
  const noteFault = (error: unknown, where: string): void => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const message = `${text} [${where}]`;
    const count = (faults.get(message) ?? 0) + 1;
    if (faults.size > 40 && count === 1) faults.clear();
    faults.set(message, count);
    lastFault = message;
    if (count === 1 && typeof console !== 'undefined') console.error(`[conduit] a frame failed and was carried on: ${message}`);
  };
  const faultText = (): string | null => {
    if (lastFault === null) return null;
    let total = 0;
    for (const count of faults.values()) total += count;
    return `${total}x, last: ${lastFault}`;
  };

  /** playhead seconds at which each part of a structure (and each row) was heard: what its layout epochs begin at */
  const arrivals = new Map<string, number>();
  const noteArrivals = (schedule: Schedule, at: number): void => noteArrivalsInto(arrivals, schedule, at);
  // What the user's hand holds: one store, the moods the pointer and keyboard give, and how far each bound change has eased.
  const store = createControlStore();
  const runtime = createRuntime(store);
  const declared = new Set<string>();
  const declareControls = (schedule: Schedule): void => {
    for (const element of schedule.elements) {
      const spec = controlSpecOf(element);
      if (spec === null || declared.has(element.key)) continue;
      declared.add(element.key);
      store.declare(element.key, element.id, spec);
    }
  };
  /**
   * The turn is over and the stage is what it left: keys of controls and structure parts that are no longer on it are forgotten, so a long
   * conversation does not keep every value the hand ever held. A control the stage still has keeps its value.
   */
  const forgetGone = (schedule: Schedule): void => {
    const live = new Set<string>();
    for (const element of schedule.elements) live.add(element.key);
    for (const key of [...declared]) {
      if (live.has(key)) continue;
      declared.delete(key);
      store.drop(key);
      runtime.moods.delete(key);
    }
    // What rests on the stage has arrived, rows included: the next turn's layout begins with all of it in place.
    for (const key of [...arrivals.keys()]) {
      if (live.has(key.split('#')[0] ?? key)) arrivals.set(key, 0);
      else arrivals.delete(key);
    }
  };
  let easedAt = -1;
  let easedFor = -1;
  /** Bound changes ease from where they are to where the controls now send them, when the store's revision (or the set of bindings) moves. */
  const refreshEases = (force: boolean): void => {
    const schedule = timeline.schedule;
    const index = controlIndexOf(schedule);
    if (!force && easedFor === store.revision && easedAt === index.driven.length) return;
    easedFor = store.revision;
    easedAt = index.driven.length;
    const reading = clock.read();
    runtime.eases = nextEases(index.driven, stateReader(index, runtime, reading.playhead), runtime.eases, reading.ambient);
    runtime.version += 1;
  };
  const host = options.charts ?? null;
  /** where the music is made, when this stage can make it */
  const player = options.tunes ?? null;
  /** where live apps run, when this stage can run them */
  const appHost = options.apps ?? null;
  /** what has come of the data charts asked for by reference */
  const chartData = new Map<string, ChartData>();
  const chartKinds = host === null ? [] : CHARTS_READY.filter((kind) => host.kinds.includes(kind));
  const timelineContext = (): TimelineContext => ({ viewport, reducedMotion, lockLook, paintings, onFault: noteFault, arrivals, controls: runtime, ...(host === null || chartKinds.length === 0 ? {} : { charts: { kinds: chartKinds, data: chartData } }), ...(appHost === null ? {} : { apps: true }) });

  const photoAspects = new Map<string, number>();
  /** The width over the height of the picture at `url`, once the browser has read it. */
  const shapeOf = (url: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : 1);
      image.onerror = () => reject(new Error('the photo could not be read'));
      image.src = url;
    });

  /** The user's photo `from` for the picture with this key: loaded once, then handed to the same arrival path a painting uses. A photo this conversation does not hold is drawn as nothing. */
  const fetchPhoto = (key: string, from: string): void => {
    const url = options.uploadUrl?.(from) ?? null;
    if (url === null) {
      paintings.set(key, { status: 'unpainted', url: null, since: 0 });
      return;
    }
    paintings.set(key, { status: 'waiting', url: null, since: 0 });
    // Loaded twice over: the renderer takes it into its own cache, and the page reads its shape, so that it is fitted whole and never stretched.
    Promise.all([renderer.preload(url), shapeOf(url)]).then(
      ([, aspect]) => {
        if (disposed) return;
        photoAspects.set(key, aspect);
        arrived.set(key, url);
        promoteArrivals(clock.read());
        drawNow();
      },
      () => {
        if (!disposed) paintings.set(key, { status: 'unpainted', url: null, since: 0 });
      },
    );
  };

  /** Every picture the stage has is accounted for: waiting for its painting if the server can paint, unpainted if not. */
  const syncPaintings = (schedule: Schedule): void => {
    for (const element of schedule.elements) {
      if (element.figure?.kind !== 'picture' || paintings.has(element.key)) continue;
      // A photo the user gave is fetched, not painted: it is on its way from the moment the line is read, and grows once it is on stage.
      if (element.figure.from !== undefined && element.figure.from !== null) {
        fetchPhoto(element.key, element.figure.from);
        continue;
      }
      paintings.set(element.key, { status: services.paint && !element.carried ? 'waiting' : 'unpainted', url: null, since: 0 });
    }
  };

  const canSketch = (): boolean => services.paint && renderer.capabilities.capture;

  /**
   * Pictures new to the schedule get their sketch sent at once. The sketch is rendered from the schedule, not from what the playhead
   * has drawn, and the server only waits a moment for it: a brain's pen runs seconds ahead of the playhead.
   */
  const queueSketches = (schedule: Schedule): void => {
    if (!canSketch()) return;
    for (const element of schedule.elements) {
      if (element.figure?.kind !== 'picture' || element.figure.from != null || element.carried || sketched.has(element.key) || sketchQueue.has(element.key)) continue;
      sketchQueue.set(element.key, 0);
    }
  };

  const rebuild = (schedule: Schedule): void => {
    syncPaintings(schedule);
    queueSketches(schedule);
    declareControls(schedule);
    timeline = buildTimeline(schedule, turn !== null && settling === null ? turn.base : base, timelineContext());
    refreshEases(true);
  };
  const restSchedule = (stage: StageBase): Schedule => new TurnScore(stage).schedule;
  const rebuildRest = (): void => {
    const schedule = restSchedule(base);
    syncPaintings(schedule);
    forgetGone(schedule);
    declareControls(schedule);
    timeline = buildTimeline(schedule, base, timelineContext());
    refreshEases(true);
  };
  timeline = buildTimeline(restSchedule(base), base, timelineContext());

  const capabilities = (): Capabilities => {
    const caps = renderer.capabilities;
    const looks = lockLook !== null ? [lockLook] : FULL_CAPABILITIES.looks.filter((id) => caps.looks.includes(id));
    return {
      ...FULL_CAPABILITIES,
      renderer: renderer.id,
      depth: caps.depth,
      looks,
      layers: caps.depth ? FULL_CAPABILITIES.layers : ['mid'],
      camera: caps.depth ? FULL_CAPABILITIES.camera : [],
      kinds: FULL_CAPABILITIES.kinds.filter((kind) => kind === 'text' || caps.kinds.includes(kind)),
      fx: FULL_CAPABILITIES.fx.filter((name) => caps.fx.includes(name)),
      ambient: FULL_CAPABILITIES.ambient.filter((kind) => caps.ambient.includes(kind)),
      sight: caps.capture ? 'snapshot' : 'report',
      // Series 4. Each list is what is really built: the structure and control engines say what they lay out, the renderer what it
      // paints. The brain is taught exactly these, so nothing here may be switched on ahead of the code that performs it.
      structures: FULL_CAPABILITIES.structures.filter((kind) => (kind === 'chart' ? chartKinds.length > 0 : kind === 'app' ? appHost !== null : STRUCTURES_READY.includes(kind))),
      charts: FULL_CAPABILITIES.charts.filter((kind) => chartKinds.includes(kind)),
      controls: FULL_CAPABILITIES.controls.filter((kind) => CONTROLS_READY.includes(kind)),
      media: FULL_CAPABILITIES.media.filter((medium) => caps.media.includes(medium)),
      textures: FULL_CAPABILITIES.textures.filter((texture) => texture === 'flat' || caps.textures.includes(texture)),
      brushes: FULL_CAPABILITIES.brushes.filter((brush) => caps.brushes.includes(brush)),
      drafts: DRAFTS_READY,
      candidates: DRAFTS_READY && CANDIDATES_READY,
      decks: DECKS_READY,
      uploads: UPLOADS_READY,
      links: LINKS_READY,
      engine: devFlag('engine') ?? ENGINE_VERSION,
    };
  };

  const sendReady = (spec: LookSpec): void => {
    lastReadySpec = spec;
    emitBack({ type: 'ready', screen: screenFacts(viewport, spec, reducedMotion, options.pointer), capabilities: capabilities(), look: spec.id });
  };
  sendReady(timeline.specAt(0));

  /** When the turn's last layout change has finished easing (see `settledAfter`); never before the schedule's own end. */
  const settledEnd = (): number => {
    const schedule = timeline.schedule;
    let settled = settledCache.get(schedule);
    if (settled === undefined) {
      settled = settledEndOf(timeline, lockLook, (turn?.base ?? base).scene.mood);
      settledCache.set(schedule, settled);
    }
    return Math.max(schedule.end, settled);
  };

  const horizon = (): Horizon => {
    if (settling !== null) return { pen: settling.until, end: settling.until, open: false, drawable: true };
    if (reviewing) return { pen: settledEnd(), end: settledEnd(), open: false, drawable: true };
    if (turn === null) return { pen: 0, end: 0, open: false, drawable: true };
    return { pen: timeline.schedule.pen, end: turn.closed ? settledEnd() : timeline.schedule.end, open: !turn.closed, drawable: renderer.isDrawable() || glyphStalled };
  };

  /** The clock as the stage should read it: the user has spoken and the answer is on its way, so it is waiting. */
  const hearing = (): boolean => anticipation !== null && (turn === null || !turn.started || settling !== null);
  const effectiveState = (reading: ClockReading): ClockState => (hearing() && reading.state !== 'hidden' ? 'waiting' : reading.state);

  const instantOf = (reading: ClockReading): TimelineInstant => {
    const waitingNow = hearing();
    const holdSince = waitingNow && anticipation !== null ? anticipation.since : reading.holdSince;
    // where each tune is in its music: the player's own answer, so that the picture is at the sound
    let tunes: Map<string, number | null> | undefined;
    if (player !== null) {
      tunes = new Map();
      for (const element of timeline.schedule.elements) if (element.figure?.kind === 'structure' && element.figure.structure === 'tune') tunes.set(element.key, player.positionOf(element.key));
    }
    return {
      ...(tunes === undefined ? {} : { tunes, closed: turn === null || turn.closed }),
      time: reading.playhead,
      ambient: reading.ambient,
      wallTime: reading.wallTime,
      clock: effectiveState(reading),
      ...(holdSince === null ? {} : { holdSince }),
    };
  };

  /** The tapped choice pressed in, the other choices receding: the stage showing that it heard, before anyone has answered. */
  const withAnticipation = (frame: Frame): Frame => {
    if (anticipation === null || anticipation.tappedKey === null || (turn !== null && turn.started && settling === null)) return frame;
    const tapped = anticipation.tappedKey;
    const pressed = frame.elements.find((element) => element.key === tapped);
    if (pressed === undefined) return frame;
    const dim = resolveInk('dim', frame.spec, { minRatio: 3, weight: 'normal', emphasised: false, onBar: false });
    const elements = frame.elements.map((element) => (element.tappable && element.key !== tapped ? { ...element, runs: element.runs.map((run) => ({ ...run, colour: dim })) } : element));
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const line of pressed.lines) {
      minX = Math.min(minX, pressed.x + line.x);
      minY = Math.min(minY, pressed.y + line.y);
      maxX = Math.max(maxX, pressed.x + line.x + line.width);
      maxY = Math.max(maxY, pressed.y + line.y + line.height);
    }
    if (!Number.isFinite(minX)) return { ...frame, elements };
    const pad = pressed.fontSize * 0.25;
    const ink = pressed.runs[0]?.colour ?? frame.spec.roles.ink;
    const press: ShapeFrame = {
      kind: 'shape',
      key: `press:${tapped}`,
      id: pressed.id,
      layer: pressed.layer,
      z: pressed.z - 0.5,
      outline: [
        {
          points: [
            { x: minX - pad, y: minY - pad / 2 },
            { x: maxX + pad, y: minY - pad / 2 },
            { x: maxX + pad, y: maxY + pad / 2 },
            { x: minX - pad, y: maxY + pad / 2 },
          ],
          closed: true,
        },
      ],
      geometryKey: `press:${tapped}:${minX.toFixed(1)}:${maxX.toFixed(1)}:${minY.toFixed(1)}:${maxY.toFixed(1)}`,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      fill: { colour: ink, to: null, opacity: 0.2 },
      stroke: null,
      opacity: 1,
      bleed: false,
      tappable: false,
    };
    return { ...frame, elements, figures: [...frame.figures, press] };
  };

  const frameFor = (reading: ClockReading): Frame => {
    let frame = timeline.frameAt(instantOf(reading));
    if (homing !== null) {
      const p = Math.min(1, (reading.ambient - homing.startedAt) / HOME_SECONDS);
      if (p >= 1) homing = null;
      else {
        const e = ease('in-out', Math.max(0, p));
        const to = frame.camera;
        const from = homing.from;
        const mix = (a: number, b: number): number => a + (b - a) * e;
        frame = {
          ...frame,
          camera: { x: mix(from.x, to.x), y: mix(from.y, to.y), dolly: mix(from.dolly, to.dolly), yaw: mix(from.yaw, to.yaw), pitch: mix(from.pitch, to.pitch), roll: mix(from.roll, to.roll) },
        };
      }
    }
    frame = withAnticipation(frame);
    if (fading !== null) {
      const p = (performance.now() - fading.startedAt) / (SKIP_FADE_SECONDS * 1000);
      if (p >= 1) fading = null;
      else frame = crossFade(fading.from, frame, Math.max(0, p));
    }
    return frame;
  };

  const setClockEvent = (state: ClockState): void => {
    if (state === lastClockState) return;
    lastClockState = state;
    emit('clock', state);
  };

  const emitMilestones = (milestones: ReturnType<Reporter['observe']>): void => {
    for (const item of milestones) {
      const element = item.element;
      // The parts of a group are told once, as the group.
      if (element.parent !== null) continue;
      if (item.kind === 'shown') {
        const tappable = element.changes.reduce<boolean>((tap, change) => (change.kind === 'set' && change.start <= item.time ? change.style.tap : tap), element.style.tap);
        const text = element.figure === null ? element.text : describeFigure(element.figure);
        emit('transcript', { kind: 'shown', key: element.key, id: element.id, text, tappable, replaces: element.replaces });
      } else if (item.kind === 'struck') emit('transcript', { kind: 'struck', key: element.key });
      else emit('transcript', { kind: 'gone', key: element.key });
    }
  };

  /** a chart draws itself in a surface of its own: a picture of the stage takes the engine's still of it */
  const stills = (frame?: Frame): { chartStill?: (key: string) => HTMLCanvasElement | null; appStill?: (key: string) => CanvasImageSource | null } => ({
    ...(host === null
      ? {}
      : {
          chartStill: (key: string) => {
            // a frame computed ahead of the playhead (a draft, a snapshot) has charts the stage has not mounted yet: draw them off screen
            const chart = frame?.charts?.find((candidate) => candidate.key === key);
            return (chart === undefined ? null : host.stillOf(chart)) ?? host.still(key);
          },
        }),
    // a live app runs in a frame over the stage: a picture of the stage takes the app's own picture of itself
    ...(appHost === null ? {} : { appStill: (key: string) => appHost.still(key) }),
  });

  /** what a picture of the stage waits for first: each running app drawing itself as it stands (a moment, no more) */
  const appsFresh = (): Promise<void> => (appHost === null ? Promise.resolve() : appHost.refresh(APP_PICTURE_MS).catch(() => undefined));

  const wantsSnapshot = (): boolean => renderer.capabilities.capture && services.sight === 'snapshot';

  /** What every control on the stage holds, by element id: the report's `controls`, and what the stage carries on. */
  const heldValues = (schedule: Schedule): ControlValues => {
    const byId = new Map<string, string>();
    for (const element of schedule.elements) if (element.kind === 'control' && (element.exit === null || element.exit.start > clock.read().playhead)) byId.set(element.id, element.key);
    return store.values(byId);
  };

  const landingFor = (at: Timeline, schedule: Schedule, stage: StageBase, skippedAt: number | null) => ({
    controls: heldValues(schedule),
    sight: (when: number) => sightOf(at, schedule, stage, when, wantsSnapshot()),
    placed: (when: number, keys: ReadonlySet<string>) => placedOf(at, schedule, when, keys),
    skippedAt,
  });

  let passState: { readonly turn: string; readonly pass: number; readonly state: PassState } | null = null;

  /**
   * How the lines so far WILL land, worked out from the schedule's end without waiting for the playhead and without touching anything
   * on stage: sight and placed boxes from a timeline that is only read, and a picture of its resting frame when both sides want one.
   */
  /** The server waits for a reply to every `drafted` and every `candidate`: when there is nothing to say, say so at once and say why, never nothing. */
  const emptyDraft = (id: string, pass: number, why: string): void => {
    if (disposed) return;
    console.warn(`[conduit painter] no draft report for ${id} pass ${pass}: ${why}`);
    emitBack({ type: 'draft', turn: id, pass, sight: NO_SIGHT, snapshot: false });
  };

  const sendDraft = (open: Turn, pass: number, candidate: Schedule | null = null): void => {
    try {
      sendDraftOf(open, pass, candidate);
    } catch (error) {
      noteFault(error, 'draft');
      emptyDraft(open.id, pass, error instanceof Error ? error.message : String(error));
    }
  };

  const engineView = (): EngineView => ({ width: viewport.width, height: viewport.height, dpr: viewport.dpr, pointer: 'fine', reducedMotion, look: (turn?.base ?? base).look, lockLook, insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  const engineInputs = (schedule: Schedule): EngineInputs => {
    const charts = new Map<string, DataTable>();
    for (const [key, data] of chartData) if (data.table !== null) charts.set(key, data.table);
    const pictures = new Map<string, { width: number; height: number }>();
    for (const [key, painting] of paintings) if (painting.aspect !== undefined) pictures.set(key, { width: painting.aspect, height: 1 });
    return { held: heldValues(schedule), charts, pictures, chartKinds };
  };

  const sendDraftOf = (open: Turn, pass: number, candidate: Schedule | null): void => {
    // A draft (and a candidate) is judged as it will rest: nothing is waited for, so no part is still arriving and every chart is whole.
    // The measuring is the engine's, the same code the server runs (`@conduit/web/engine`).
    const source = candidate ?? timeline.schedule;
    const facts = measureStage(source, open.base, engineView(), engineInputs(source));
    if (facts.fault !== null) {
      noteFault(new Error(facts.fault), 'draft');
      emitBack({ type: 'draft', turn: open.id, pass, sight: NO_SIGHT, snapshot: false });
      return;
    }
    const { sight, placed, content } = facts;
    let reported = false;
    const holdMs = Number(devFlag('holdDraft') ?? 0);
    const held = (send: () => void): void => {
      if (holdMs > 0) setTimeout(send, holdMs);
      else send();
    };
    const report = (snapshot: boolean): void => {
      if (disposed || reported) return;
      reported = true;
      held(() => emitBack({ type: 'draft', turn: open.id, pass, sight: { ...sight, snapshot }, placed: placed.map(({ key: _key, ...item }) => item), snapshot, content, boxes: facts.boxes }));
    };
    if (!(services.review && wantsSnapshot())) {
      report(false);
      return;
    }
    // the picture is of a timeline the engine does not keep: built once more, for the raster only
    // the picture below is of the same timeline; the engine keeps its own, so this one is built once more for the raster only
    const at = buildTimeline(source, open.base, { ...timelineContext(), arrivals: new Map() });
    const schedule = at.schedule;
    const when = Math.max(schedule.end, settledAfter(at, lockLook, open.base.scene.mood)) + 1e-6;
    const plain: Frame = { ...at.frameAt({ time: when, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' }), camera: REST_POSE };
    // the brain's own picture carries each element's id and a ruler of canvas units: a separate frame, rasterised on its own, never the stage
    const frame = annotated(plain, at, schedule, when, plain.spec);
    // The words and numbers go as soon as the picture is there or DRAFT_PICTURE_MS has passed, whichever is first: a slow picture (a phone,
    // a busy page) must not make the server give the whole fix up (v2.1 review, W-6). A picture that comes later is still uploaded.
    const late = setTimeout(() => report(false), DRAFT_PICTURE_MS);
    void renderer
      .rasterise(frame, { maxSide: PICTURE_SIDE, mime: 'image/jpeg', quality: 0.8, ...stills(frame) })
      .then((blob) => {
        clearTimeout(late);
        if (blob !== null && !disposed) held(() => emit('upload', { kind: 'draft', turn: open.id, pass, blob }));
        report(blob !== null);
      })
      .catch(() => {
        clearTimeout(late);
        report(false);
      });
  };

  /** A picture of the stage a turn left, for the brain's next brief. */
  const sendSnapshot = (turnId: string, stage: StageBase): void => {
    if (!wantsSnapshot()) return;
    // A resting stage has no arrivals: everything on it is there. The turn's own (an interrupted turn is still settling) must not be read.
    const rest = buildTimeline(restSchedule(stage), stage, { ...timelineContext(), arrivals: new Map() });
    const frame: Frame = { ...rest.frameAt({ time: 0, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' }), camera: REST_POSE };
    void appsFresh()
      .then(() => renderer.rasterise(frame, { maxSide: PICTURE_SIDE, mime: 'image/jpeg', quality: 0.8, ...stills(frame) }))
      .then((blob) => {
        if (blob !== null && !disposed) emit('upload', { kind: 'snapshot', turn: turnId, blob });
      })
      .catch(() => undefined);
  };

  /** The sketch under a picture, alone on its ground, cropped to the picture's box. */
  const sketchFrame = (at: Timeline, picture: ElementSpan): Frame | null => {
    const schedule = at.schedule;
    const keys = sketchKeysOf(picture, schedule);
    if (keys.size === 0) return null;
    let when = picture.enter?.start ?? 0;
    for (const element of schedule.elements) if (keys.has(element.key)) when = Math.max(when, element.enter?.end ?? 0);
    const box = canvasBoxOf(picture, schedule, when);
    if (box === null || box.w <= 0 || box.h <= 0) return null;
    const spec = at.specAt(when);
    const unit = PICTURE_SIDE / Math.max(box.w, box.h);
    const crop: Viewport = { width: Math.max(8, Math.round(box.w * unit)), height: Math.max(8, Math.round(box.h * unit)), dpr: 1 };
    const fit = {
      box: { x: -crop.width / 2 - box.x * unit, y: -crop.height / 2 - box.y * unit, width: box.w * unit, height: box.h * unit },
      unit,
      flow: { x: -crop.width / 2, y: -crop.height / 2, width: crop.width, height: crop.height },
      region: { x: -crop.width / 2, y: -crop.height / 2, width: crop.width, height: crop.height },
      coverage: 1,
    };
    const drawn = figuresAt(schedule, timelineBase(), when, when + 5, { viewport: crop, look: spec, camera: REST_POSE, fit, fixedFit: fit, reducedMotion: true, paintings: new Map() });
    const figures = drawn.figures.filter((figure) => keys.has(figure.key.split('/')[0] ?? figure.key));
    if (figures.length === 0) return null;
    return {
      time: when,
      ambient: when + 5,
      wallTime: pinnedWallTime(when),
      clock: 'idle',
      viewport: crop,
      look: spec.id,
      spec,
      lookChange: null,
      bodySize: bodySize(crop, spec),
      margin: marginOf(crop, spec),
      canvas: { box: fit.box, unit: fit.unit },
      gridTop: -crop.height / 2,
      ground: spec.roles.ground,
      camera: REST_POSE,
      agitation: 0,
      dim: 0,
      reducedMotion: true,
      elements: [],
      figures,
      fields: [],
      cursor: null,
    };
  };

  const timelineBase = (): StageBase => (turn !== null && settling === null ? turn.base : (review?.base ?? base));

  const sendSketch = (at: Timeline, key: string): void => {
    sketched.add(key);
    sketchQueue.delete(key);
    const picture = at.schedule.elements.find((element) => element.key === key);
    if (picture === undefined) return;
    const frame = sketchFrame(at, picture);
    if (frame === null) return;
    void renderer
      .rasterise(frame, { maxSide: PICTURE_SIDE, mime: 'image/png', fx: false })
      .then((blob) => {
        if (blob !== null && !disposed) emit('upload', { kind: 'sketch', key, blob });
      })
      .catch(() => undefined);
  };

  const flushSketches = (playhead: number): void => {
    for (const [key, ready] of [...sketchQueue]) if (ready <= playhead) sendSketch(timeline, key);
  };

  /** A painting that has come, whose picture is now on stage, starts to grow. */
  const promoteArrivals = (reading: ClockReading): void => {
    for (const [key, url] of [...arrived]) {
      const picture = timeline.schedule.elements.find((element) => element.key === key);
      if (picture === undefined || (picture.exit !== null && picture.exit.start <= reading.playhead)) {
        if (picture === undefined || picture.exit !== null) arrived.delete(key);
        continue;
      }
      if (picture.carried || picture.enter === null || picture.enter.start <= reading.playhead) {
        arrived.delete(key);
        const aspect = photoAspects.get(key);
        paintings.set(key, { status: 'ready', url, since: reading.ambient, ...(aspect === undefined ? {} : { aspect }) });
        latePaintings.set(key, url);
        if (latePaintings.size > 64) latePaintings.delete(latePaintings.keys().next().value as string);
      }
    }
  };

  const observe = (reading: ClockReading): void => {
    if (turn === null || settling !== null) return;
    // Nothing is reported shown before it has been drawn.
    if (!renderer.isDrawable()) return;
    const pen = turn.showingAll ? Math.max(timeline.schedule.pen, reading.playhead) : timeline.schedule.pen;
    const milestones = reporter.observe(timeline.schedule, timeline.retired, reading.playhead, reading.state, turn.ack, performance.now(), pen);
    emitMilestones(milestones);
    flushSketches(reading.playhead);
  };

  const rest = (stage: StageBase, endPose: CameraPose | null, ambient: number): void => {
    base = withLook(stage);
    turn = null;
    settling = null;
    clock.stop();
    if (endPose !== null) homing = { from: endPose, startedAt: ambient };
    rebuildRest();
  };

  const cameraNow = (reading: ClockReading): CameraPose => timeline.frameAt(instantOf(reading)).camera;

  const record = (closing: Turn, schedule: Schedule): void => {
    const seen = new Set(schedule.lines.map((line) => line.seq));
    // What the stage was left holding: a sprite's rows that were written are carried whole (see `settle`), so they are recorded even when the pen was ahead of the playhead.
    const spriteIds = new Set<string>();
    for (const entry of closing.score.score) if (!entry.void && seen.has(entry.seq) && entry.line.verb !== 'row' && entry.line.verb !== 'frame' && 'id' in entry.line && typeof entry.line.id === 'string') spriteIds.add(entry.line.id);
    const lines = closing.score.score
      // A bare `cancel` already voided what it cancelled; played again at time zero it would void everything before it.
      .filter((entry) => !entry.void && entry.line.verb !== 'cancel' && (seen.has(entry.seq) || ((entry.line.verb === 'row' || entry.line.verb === 'frame') && spriteIds.has(entry.line.id))))
      .map((entry) => ({ seq: entry.seq, line: entry.line, floor: entry.floor }));
    const pictures: Record<string, string> = {};
    for (const element of schedule.elements) {
      const painting = paintings.get(element.key);
      if (element.figure?.kind === 'picture' && painting !== undefined && painting.status === 'ready' && painting.url !== null) pictures[element.key] = painting.url;
    }
    recordings.set(closing.id, { turn: closing.id, base: closing.base, lines, paintings: pictures, aspects: Object.fromEntries(photoAspects), opened: closing.input.kind, asked: askedOf(closing.input) });
    lastRecorded = closing.id;
    for (const id of [...recordings.keys()]) {
      if (recordings.size <= KEPT_RECORDINGS) break;
      if (id !== lastRecorded) recordings.delete(id);
    }
  };

  const finish = (reading: ClockReading): void => {
    if (turn === null) return;
    const closing = turn;
    const schedule = timeline.schedule;
    const pose = cameraNow(reading);
    observe(reading);
    const report = reporter.close(schedule, timeline.retired, closing.base, reading.playhead, 'finished', landingFor(timeline, schedule, closing.base, closing.skippedAt));
    memory = { playhead: reading.playhead, pen: schedule.pen, end: Math.max(schedule.end, settledEnd()), lines: linesOf(closing, schedule) };
    review = { schedule, base: closing.base };
    record(closing, schedule);
    sketchQueue.clear();
    rest(report.stage, pose, reading.ambient);
    sendSnapshot(closing.id, report.stage);
  };

  const linesOf = (of: Turn, schedule: Schedule): LineView[] => {
    const bySeq = new Map<number, ScoreEntry[]>();
    for (const entry of of.score.score) {
      if (entry.void) continue;
      const list = bySeq.get(entry.seq) ?? [];
      list.push(entry);
      bySeq.set(entry.seq, list);
    }
    return schedule.lines.map((time) => {
      const entry = bySeq.get(time.seq)?.shift();
      return {
        seq: time.seq,
        text: entry === undefined ? time.verb : serializeLine(entry.line),
        start: time.start,
        end: time.end,
        issues: of.issues.get(time.seq) ?? [],
      };
    });
  };

  /** Draws one frame and returns the milliseconds spent inside the renderer. */
  const draw = (reading: ClockReading, reset: boolean): number => {
    let frame: Frame;
    try {
      frame = frameFor(reading);
    } catch (error) {
      // A frame that cannot be made is not the end of the show: say so, and keep what was last on screen.
      noteFault(error, 'frame');
      return 0;
    }
    try {
      if (frame.spec !== lastReadySpec && !reset) sendReady(frame.spec);
      if (reset) renderer.reset();
      if (host !== null) host.sync(frame.charts ?? [], viewport.dpr);
      if (appHost !== null && !reset) appHost.sync(frame.apps ?? [], viewport.dpr);
      // the music follows the stage: begun when a tune is whole, held while the stage is paused or hidden, let go when its tune has left
      if (player !== null && !reset) player.sync(frame.tunes ?? [], { aq: reading.ambient, running: reading.state !== 'paused' && !reading.hidden });
      lastFrame = frame;
      const startedAt = performance.now();
      renderer.render(frame);
      return performance.now() - startedAt;
    } catch (error) {
      noteFault(error, 'render');
      return 0;
    }
  };

  /** Leaves an inspection of a finished turn: the stage goes back to rest. */
  const endReview = (): void => {
    if (!reviewing) return;
    reviewing = false;
    clock.stop();
    homing = null;
    rebuildRest();
  };

  /** Starts inspecting the last finished turn; false when there is none. */
  const beginReview = (): boolean => {
    if (reviewing) return true;
    if (review === null || turn !== null) return false;
    reviewing = true;
    homing = null;
    clock.review();
    timeline = buildTimeline(review.schedule, review.base, timelineContext());
    return true;
  };

  /** `drawn` is false while the frame just rendered holds something the renderer could not yet draw: a turn does not end on a frame nobody saw. */
  const advanceTurnState = (reading: ClockReading, drawn: boolean): ClockReading => {
    let current = reading;
    if (settling !== null && current.playhead >= settling.until) {
      // The ease that began at the interrupt carries on; it is not restarted from a pose the screen never showed.
      const stage = settledStage;
      settledStage = null;
      rest(stage ?? base, null, current.ambient);
      current = clock.read();
    } else if (reviewing && current.state === 'idle') {
      endReview();
      current = clock.read();
    } else if (drawn && turn !== null && turn.closed && settling === null && current.state === 'idle' && turn.started) {
      finish(current);
      current = clock.read();
    }
    return current;
  };
  let settledStage: StageBase | null = null;

  const frame = (now: number): void => {
    if (disposed) return;
    frameHandle = requestAnimationFrame(frame);
    try {
      step(now);
    } catch (error) {
      noteFault(error, 'loop');
    }
  };

  const step = (now: number): void => {
    if (document.hidden) {
      lastFrameAt = null;
      return;
    }
    const elapsed = lastFrameAt === null ? 16 : now - lastFrameAt;
    lastFrameAt = now;
    let reading = clock.advance(elapsed, horizon());
    promoteArrivals(reading);
    // a knob of a mock-up easing home: the stage is made again with it a little nearer, every frame, until it rests
    if (easingUi() && easeUi(now, reducedMotion)) refreshTimeline();
    const renderMs = draw(reading, false);
    const drawn = renderer.isDrawable();
    if (drawn || turn === null) {
      undrawableSince = null;
      glyphStalled = false;
    } else {
      undrawableSince ??= now;
      if (now - undrawableSince > GLYPH_HOLD_MS) glyphStalled = true;
    }
    reading = advanceTurnState(reading, drawn || glyphStalled);
    announceControls();
    announceText();
    observe(reading);
    // The frame just drawn may have met glyphs not yet typeset: say so now, the clock holds from the next frame.
    const waitingOnDraw = !drawn && !glyphStalled && turn !== null && turn.started && settling === null && reading.state === 'playing';
    setClockEvent(waitingOnDraw ? 'holding' : effectiveState(reading));
    if (skipFrames > 0) skipFrames -= 1;
    else if (now - mountedAt > GRACE_MS) {
      const quality: Quality | null = governor.sample(elapsed, renderMs);
      if (quality !== null) renderer.setQuality(quality);
    }
  };

  const onVisibility = (): void => {
    const hidden = document.hidden;
    clock.setHidden(hidden);
    lastFrameAt = null;
    if (!hidden) skipFrames = 3;
    const reading = clock.read();
    observe(reading);
    setClockEvent(effectiveState(reading));
  };
  document.addEventListener('visibilitychange', onVisibility);
  clock.setHidden(document.hidden);
  frameHandle = requestAnimationFrame(frame);

  const drawNow = (): ClockReading => {
    const reading = clock.read();
    draw(reading, true);
    observe(reading);
    setClockEvent(effectiveState(reading));
    return reading;
  };

  const startTurnState = (): void => {
    if (turn === null) return;
    turn.started = true;
    // The answer has begun: it is no longer anticipated.
    anticipation = null;
    clock.start();
  };

  const interruptTurn = (): TurnReport | null => {
    if (turn === null || settling !== null) return null;
    const reading = clock.read();
    const open = turn;
    observe(reading);
    const playhead = reading.playhead;
    const frozen = open.started ? patched(timeline.schedule, playhead) : timeline.schedule;
    const frozenTimeline = open.started ? buildTimeline(frozen, open.base, timelineContext()) : timeline;
    const report = reporter.close(frozen, timeline.retired, open.base, playhead, 'interrupted', landingFor(frozenTimeline, frozen, open.base, open.skippedAt));
    memory = { playhead, pen: Math.min(timeline.schedule.pen, playhead), end: playhead, lines: linesOf(open, frozen) };
    const pose = cameraNow(reading);
    // A picture that had begun gets its sketch sent: it is on stage, and it will be whole. One that had not is forgotten.
    for (const [key] of [...sketchQueue]) {
      const picture = frozen.elements.find((element) => element.key === key);
      if (picture !== undefined && picture.enter !== null && picture.enter.start < playhead) sendSketch(frozenTimeline, key);
    }
    sketchQueue.clear();
    if (!open.started) {
      review = null;
      // Stop before the first line: nothing is being answered any more, so the stage stops showing that it heard and the choices live again.
      anticipation = null;
      rest(report.stage, null, reading.ambient);
      setClockEvent(effectiveState(clock.read()));
      return report;
    }
    record(open, frozen);
    review = { schedule: frozen, base: open.base };
    settledStage = report.stage;
    settling = { until: playhead };
    turn = open;
    timeline = frozenTimeline;
    // Run to the end of what had begun, including the easing of the others into their new places.
    const until = Math.max(completionOf(frozen, playhead), settledEnd());
    settling = { until };
    homing = { from: pose, startedAt: reading.ambient };
    clock.setRate(Math.max(1, (until - playhead) / SETTLE_SECONDS));
    clock.play();
    if (until <= playhead) {
      rest(report.stage, pose, reading.ambient);
      settledStage = null;
    }
    sendSnapshot(open.id, report.stage);
    return report;
  };

  const snapshotNow = (): PainterSnapshot => {
    const reading = clock.read();
    const instant = instantOf(reading);
    const schedule = timeline.schedule;
    const views = timeline.viewsAt(instant);
    const frame = timeline.frameAt(instant);
    const scene = sceneAt(schedule, reading.playhead);
    const active = turn !== null;
    const showingAll = turn !== null && turn.showingAll;
    const pen = active ? (showingAll ? Math.max(schedule.pen, reading.playhead) : schedule.pen) : (memory?.pen ?? 0);
    const end = active ? (turn !== null && turn.closed && settling === null ? settledEnd() : schedule.end) : (memory?.end ?? 0);
    const playhead = active || reviewing || memory === null ? reading.playhead : memory.playhead;
    return {
      turn: turn !== null && settling === null ? turn.id : null,
      clock: effectiveState(reading),
      playhead,
      pen,
      end,
      lead: Math.max(0, pen - playhead),
      hidden: reading.hidden,
      look: frame.look,
      lookLocked: lockLook !== null,
      scene: {
        id: scene.id,
        layout: scene.layout,
        mood: valueAt(scene.mood, reading.playhead, base.scene.mood),
        pace: valueAt(scene.pace, reading.playhead, base.scene.pace),
        expected: valueAt(scene.expected, reading.playhead, null),
        canvas: frame.canvas,
      },
      elements: views,
      lines: active ? linesOf(turn as Turn, schedule) : (memory?.lines ?? []),
      renderer: renderer.id,
      quality: governor.quality,
      fps: governor.fps,
      reducedMotion,
      viewport,
      screen: screenFacts(viewport, frame.spec, reducedMotion, options.pointer),
      glyphStall: glyphStalled,
      anticipating: anticipation !== null,
      showingAll,
      fault: faultText(),
      controls: controlViews(),
      charts: chartViews(frame),
      pass: passState === null || turn === null || passState.turn !== turn.id ? null : { pass: passState.pass, state: passState.state },
      plan: timeline.planAt(reading.playhead),
    };
  };

  // Controls ---------------------------------------------------------------------------------------------------------------
  const sitesNow = (): readonly ControlSite[] => timeline.controlsAt(instantOf(clock.read()));
  const siteById = (id: string): ControlSite | null => {
    const found = sitesNow().filter((site) => site.id === id);
    return found[found.length - 1] ?? null;
  };
  const touch = (): void => {
    runtime.version += 1;
  };
  const setMood = (key: string | null, patch: Partial<typeof CALM>): void => {
    for (const [other, was] of [...runtime.moods]) {
      if (other !== key && (was.hover || was.pressed !== null) && patch.pressed === undefined) runtime.moods.set(other, { ...was, hover: false });
    }
    if (key !== null) runtime.moods.set(key, { ...(runtime.moods.get(key) ?? CALM), ...patch });
    touch();
  };
  /** the part of a control under a point, host CSS pixels: the smallest zone that holds it, so a knob wins over its track */
  const hitControl = (x: number, y: number): { readonly site: ControlSite; readonly zone: ControlSite['layout']['zones'][number] } | null => {
    const sites = sitesNow();
    for (let i = sites.length - 1; i >= 0; i -= 1) {
      const site = sites[i] as ControlSite;
      if (!site.enabled) continue;
      const lx = (x - site.screen.x) / site.screen.scale;
      const ly = (y - site.screen.y) / site.screen.scale;
      let best: ControlSite['layout']['zones'][number] | null = null;
      for (const zone of site.layout.zones) {
        const b = zone.box;
        if (lx < b.x || lx > b.x + b.width || ly < b.y || ly > b.y + b.height) continue;
        if (best === null || b.width * b.height < best.box.width * best.box.height) best = zone;
      }
      if (best !== null) return { site, zone: best };
    }
    return null;
  };
  const localOf = (site: ControlSite, x: number, y: number): { x: number; y: number } => ({ x: (x - site.screen.x) / site.screen.scale, y: (y - site.screen.y) / site.screen.scale });

  const sayControl = (site: ControlSite, value: ControlValue): void => {
    const spec = site.input.spec;
    const reading = clock.read();
    emitBack({ type: 'control', turn: turn === null ? null : turn.id, id: site.id, value, text: controlText(spec, value), playhead: reading.playhead, send: spec.control === 'button' ? true : spec.send });
  };
  /** the value a control holds changed; bound changes and `{…}` follow in the next frame, and a timeline that reads values is made again */
  const holdValue = (site: ControlSite, value: ControlValue): void => {
    store.set(site.key, value);
    refreshEases(false);
    if (timeline.reactive) refreshTimeline();
  };
  /** the finger that is on a mock-up, and the block it came down on */
  let uiGrab: { readonly pointer: number; readonly block: string } | null = null;
  /** A button of a mock-up was pressed and it is for the brain: said as a control is, with what every live part of its screen holds. */
  const sayPress = (press: UiSend): void => {
    const reading = clock.read();
    emitBack({ type: 'control', turn: turn === null ? null : turn.id, id: press.id, value: true, text: press.text, playhead: reading.playhead, send: true, screen: press.screen, values: press.values });
  };
  let grab: { readonly pointer: number; readonly key: string; readonly zone: string; readonly from: ControlValue | null } | null = null;
  let pressedZone: { readonly pointer: number; readonly key: string; readonly zone: string } | null = null;

  /** A pointer released on a part that acts on release: a press, a switch, an option, a field. */
  const actOn = (site: ControlSite, zone: ControlSite['layout']['zones'][number], x: number, y: number): void => {
    const spec = site.input.spec;
    if (spec.control === 'button') {
      sayControl(site, true);
      return;
    }
    if (zone.part === 'field') {
      if (spec.control === 'pick') {
        runtime.open = runtime.open === site.key ? null : site.key;
        touch();
      } else setMood(site.key, { focus: true });
      return;
    }
    if (zone.part === 'list') return;
    const value = controlEngine.valueAt({ ...site.input, mood: CALM }, site.layout, zone, localOf(site, x, y));
    if (value === null) return;
    holdValue(site, value);
    if (spec.control === 'pick' && zone.part.startsWith('option')) {
      runtime.open = null;
      touch();
    }
    sayControl(site, value);
  };

  const refreshTimeline = (): void => {
    if (turn !== null) rebuild(timeline.schedule);
    else if (reviewing && review !== null) timeline = buildTimeline(review.schedule, review.base, timelineContext());
    else rebuildRest();
  };

  const viewOf = (site: ControlSite): ControlView => {
    const spec = site.input.spec;
    const half = (n: number): number => Math.max(22, (n * site.screen.scale) / 2);
    const w = half(site.layout.width);
    const h = half(site.layout.height);
    const index = controlIndexOf(timeline.schedule);
    return {
      key: site.key,
      id: site.id,
      control: spec.control,
      form: spec.form,
      label: site.span.text,
      options: spec.options,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      unit: spec.unit,
      value: site.value,
      valueText: controlText(spec, site.value),
      box: { x: site.screen.x - w, y: site.screen.y - h, width: 2 * w, height: 2 * h },
      enabled: site.enabled,
      send: spec.control === 'button' ? true : spec.send,
      bound: index.driven.some((change) => change.control === site.key),
    };
  };
  const chartViews = (frame: Frame): ChartView[] =>
    (frame.charts ?? []).map((chart) => ({ key: chart.key, id: chart.id, kind: chart.state.kind, box: chart.box, series: chart.state.model.series.map((series) => series.name), points: chart.state.landed, waiting: chart.state.waiting }));
  const controlViews = (): ControlView[] => sitesNow().map(viewOf);
  let lastControlsSignature = '';
  /** Tells the app when controls arrived, left, moved or took a new value: never on every frame of a drag. */
  const announceControls = (): void => {
    const views = controlViews();
    if (views.length === 0 && lastControlsSignature === '') return;
    const dragging = grab !== null;
    const signature = views.map((v) => [v.key, v.enabled ? 1 : 0, Math.round(v.box.x), Math.round(v.box.y), Math.round(v.box.width), Math.round(v.box.height), dragging ? '' : v.valueText].join(':')).join('|');
    if (signature === lastControlsSignature) return;
    lastControlsSignature = signature;
    emit('controls', views);
  };

  /** the mock-ups on stage as they rest, in host CSS pixels (the test hook's `mockups()`, and the text layer's way to leave a mock-up's live parts to the finger) */
  const mockupViews = (): readonly UiMockup[] => {
    const blocks = timeline.schedule.elements.filter(isScreenBlock).map((span) => span.key);
    const dx = viewport.width / 2;
    const dy = viewport.height / 2;
    const host = (b: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Box => ({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
    return uiMockupViews(blocks).map((view) => ({
      screen: view.screen,
      hits: view.hits.map((hit) => ({ id: hit.id, part: hit.part, action: hit.action, box: host(hit), ...(hit.send === true ? { send: true } : {}), ...(hit.to === undefined ? {} : { to: hit.to }) })),
      words: view.words.map((word) => ({ owner: word.owner, text: word.text, box: host(word) })),
      notes: view.notes,
    }));
  };

  // Text out (PLAN-v2.1 T2): the words on stage and where they are, for the chrome's text layer. Sent when the stage has come to rest and what
  // is on it has changed, and once, empty, when it begins to move: the layer is not there to be dragged over while things slide.
  const still = { time: Number.NaN, camera: '', width: 0, height: 0, frames: 0, hash: '', sent: '' };
  const announceText = (): void => {
    const shown = lastFrame;
    if (shown === null || listeners.text.size === 0) return;
    const camera = JSON.stringify(shown.camera);
    if (shown.time !== still.time || camera !== still.camera || viewport.width !== still.width || viewport.height !== still.height) {
      still.time = shown.time;
      still.camera = camera;
      still.width = viewport.width;
      still.height = viewport.height;
      still.frames = 0;
      still.hash = '';
      if (still.sent !== '') {
        still.sent = '';
        emit('text', []);
      }
      return;
    }
    still.frames += 1;
    if (still.frames < 3) return;
    // a cheap look at what could have moved while the clock stood still: a control dragged, a field typed in, a value that took a new number
    let hash = `${shown.elements.length}`;
    for (const element of shown.elements) hash += `|${Math.round(element.x * 4)},${Math.round(element.y * 4)},${Math.round(element.opacity * 20)},${element.runs.length}`;
    if (hash === still.hash) return;
    still.hash = hash;
    let spans = textSpansOf(shown, timeline.schedule);
    if (spans.some((span) => span.structure === 'screen')) {
      const hits = mockupViews().flatMap((view) => view.hits.map((hit) => hit.box));
      spans = spans.map((span) => {
        if (span.structure !== 'screen' || span.lines.length === 0) return span;
        const box = (span.lines[0] as { readonly box: Box }).box;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        return hits.some((hit) => cx >= hit.x && cx <= hit.x + hit.width && cy >= hit.y && cy <= hit.y + hit.height) ? { ...span, role: 'control' } : span;
      });
    }
    const signature = textSignature(spans);
    if (signature === still.sent) return;
    still.sent = signature;
    emit('text', spans);
  };

  /** A fingertip is not a pixel: a choice smaller than 44 px is grown to 44 px around its centre for hit-testing only. */
  const nearTappable = (x: number, y: number): string | null => {
    const MIN_TARGET = 44;
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const view of timeline.viewsAt(instantOf(clock.read()))) {
      if (!view.tappable || view.opacity < 0.5) continue;
      const cx = view.box.x + view.box.width / 2;
      const cy = view.box.y + view.box.height / 2;
      const halfW = Math.max(view.box.width, MIN_TARGET) / 2;
      const halfH = Math.max(view.box.height, MIN_TARGET) / 2;
      if (Math.abs(x - cx) > halfW || Math.abs(y - cy) > halfH) continue;
      const distance = Math.abs(y - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = view.key;
      }
    }
    return best;
  };

  const tapOn = (key: string): void => {
    // A second tap while the first is being answered is not a second message.
    if (anticipation !== null) return;
    const reading = clock.read();
    const views = timeline.viewsAt(instantOf(reading));
    const view = views.find((item) => item.key === key) ?? views.find((item) => item.key === key.split('/')[0]);
    if (view === undefined) return;
    emitBack({ type: 'tap', turn: turn === null ? null : turn.id, id: view.id, text: view.text, playhead: reading.playhead, choice: view.tappable });
  };

  /** With a turn open, or a finished one kept for inspection, the playhead can be moved; with neither there is nothing to move it over. */
  const seekable = (): boolean => turn !== null || beginReview();
  const seekLimit = (): number => (turn === null || turn.closed ? settledEnd() : timeline.schedule.pen);

  /** Whether a picture is still on stage, which is whether news of its painting still matters. */
  const pictureOnStage = (key: string): boolean => {
    const picture = timeline.schedule.elements.find((element) => element.key === key);
    if (picture === undefined || picture.figure?.kind !== 'picture') return false;
    return picture.exit === null || picture.exit.start > clock.read().playhead;
  };

  const painter: Painter = {
    openTurn(id, input, options) {
      // A turn id is opened once. A replayed `turn` for the one playing, settling or already played must not cut it off.
      if (openedTurns.has(id)) return;
      openedTurns.add(id);
      endReview();
      review = null;
      if (turn !== null) interruptTurn();
      if (settling !== null) {
        const stage = settledStage;
        rest(stage ?? base, null, clock.read().ambient);
        settledStage = null;
      }
      if (options?.page === true) {
        pageUnder ??= base;
      } else if (pageUnder !== null) {
        // The page is gone with the next real turn: the stage it covered is the one the server has described to the brain.
        base = pageUnder;
        pageUnder = null;
      }
      const opened: Turn = { id, input, base, score: new TurnScore(base, input.kind), seqs: new Set(), issues: new Map(), ack: 0, closed: false, started: false, showingAll: false, skippedAt: null };
      turn = opened;
      if (input.kind === 'prompt' || input.kind === 'script') store.restart();
      memory = null;
      clock.openTurn();
      reporter.openTurn(id);
      rebuild(opened.score.schedule);
      emit('transcript', { kind: 'turn', turn: id, input });
      setClockEvent('waiting');
    },

    ingest(id, seq, line: Line) {
      const open = turn;
      if (open === null || settling !== null || open.id !== id || open.closed || open.seqs.has(seq)) return [];
      open.seqs.add(seq);
      if (lockLook !== null && line.verb === 'look') {
        open.ack = Math.max(open.ack, seq);
        if (!open.started) startTurnState();
        return [];
      }
      // A chart that draws data by reference waits for its `data` event. If that event was lost the chart would wait for ever: past
      // DATA_WAIT_MS it is told the rows could not be had, and says so (v2.1 review, W-3).
      if (line.verb === 'chart' && line.data !== undefined && !chartData.has(line.data)) {
        const wanted = line.data;
        setTimeout(() => {
          if (!chartData.has(wanted)) {
            console.error(`[conduit painter] the data ${wanted} never arrived; the chart is shown without it`);
            chartData.set(wanted, { table: null, since: clock.read().ambient });
          }
        }, DATA_WAIT_MS);
      }
      const reading = clock.read();
      const result = open.score.push(line, seq, reading.playhead);
      open.issues.set(seq, [...result.issues]);
      open.ack = Math.max(open.ack, seq);
      if (!open.started) startTurnState();
      noteArrivals(result.schedule, reading.playhead);
      rebuild(result.schedule);
      // Once the viewer has asked to see it all, what the brain writes next lands already settled.
      if (open.showingAll) clock.jump(settledEnd());
      observe(clock.read());
      return result.issues;
    },

    closeTurn(id, reason: TurnEndReason) {
      if (turn === null || turn.id !== id || turn.closed) return;
      if (reason === 'interrupted') {
        interruptTurn();
        return;
      }
      turn.closed = true;
      if (!turn.started) {
        const reading = clock.read();
        const closing = turn;
        const report = reporter.close(timeline.schedule, timeline.retired, closing.base, 0, 'finished', landingFor(timeline, timeline.schedule, closing.base, closing.skippedAt));
        memory = { playhead: 0, pen: 0, end: 0, lines: [] };
        review = null;
        anticipation = null;
        rest(report.stage, null, reading.ambient);
      }
    },

    interrupt() {
      return interruptTurn();
    },

    play() {
      clock.play();
    },

    pause() {
      clock.pause();
    },

    seek(seconds) {
      if (!seekable()) {
        drawNow();
        return;
      }
      clock.seek(Math.min(Math.max(0, seconds), seekLimit()));
      drawNow();
    },

    step(seconds) {
      if (!seekable()) {
        drawNow();
        return;
      }
      const now = clock.read();
      clock.seek(Math.min(Math.max(0, now.playhead + seconds), seekLimit()));
      drawNow();
    },

    tapAt(x, y) {
      const key = renderer.pick(x, y) ?? nearTappable(x, y);
      if (key !== null) tapOn(key);
    },

    tapElement(key) {
      tapOn(key);
    },

    dataArrived(id: string, rows: DataTable | null) {
      chartData.set(id, { table: rows, since: clock.read().ambient });
    },
    tryCandidate(id, pass, lines) {
      const open = turn;
      if (!CANDIDATES_READY || open === null || open.id !== id || settling !== null) {
        emptyDraft(id, pass, !CANDIDATES_READY ? 'this painter cannot try a fix' : open === null || open.id !== id ? 'that turn is not the one open' : 'the turn is settling');
        return;
      }
      // a copy of the turn's score, the fix's lines pushed on it, and how that would land: the turn's own score and the stage are not touched
      let copy: TurnScore;
      try {
        copy = open.score.fork();
        const floor = Math.max(0, clock.read().playhead);
        lines.forEach((line, index) => copy.push(line, CANDIDATE_SEQ + index, floor));
      } catch (error) {
        noteFault(error, 'candidate');
        emptyDraft(id, pass, error instanceof Error ? error.message : String(error));
        return;
      }
      sendDraft(open, pass, copy.schedule);
    },
    lookNow(id, request) {
      // SA4 (`canvas_look`). A picture of the open turn as the lines so far will leave it, uploaded for the brain that asked: the same picture a draft
      // is given, taken on request. Nothing is reported back and nothing on stage moves; with no capture, or a turn that is not the open one, nothing is said.
      const open = turn;
      if (open === null || open.id !== id || settling !== null || !wantsSnapshot()) return;
      try {
        const at = buildTimeline(timeline.schedule, open.base, { ...timelineContext(), arrivals: new Map() });
        const when = Math.max(at.schedule.end, settledAfter(at, lockLook, open.base.scene.mood)) + 1e-6;
        const plain: Frame = { ...at.frameAt({ time: when, ambient: 3, wallTime: pinnedWallTime(3), clock: 'paused' }), camera: REST_POSE };
        const frame = annotated(plain, at, at.schedule, when, plain.spec);
        void renderer
          .rasterise(frame, { maxSide: PICTURE_SIDE, mime: 'image/jpeg', quality: 0.7, ...stills(frame) })
          .then((blob) => {
            if (blob !== null && !disposed) emit('upload', { kind: 'look', turn: id, request, blob });
          })
          .catch(() => undefined);
      } catch (error) {
        noteFault(error, 'look');
      }
    },
    // STUB(PLAN-v2.1 package T2): step a deck to a slide.
    slide(_to) {},
    notePass(id, pass, state) {
      const open = turn;
      if (open === null || open.id !== id || settling !== null) {
        if (state === 'drafted') emptyDraft(id, pass, open === null || open.id !== id ? 'that turn is not the one open' : 'the turn is settling');
        return;
      }
      passState = { turn: id, pass, state };
      if (state !== 'drafted') return;
      sendDraft(open, pass);
    },
    typing() {
      return timeline.schedule.elements.some((span) => isScreenBlock(span) && typingUi(span.key));
    },
    key(key) {
      for (const span of timeline.schedule.elements) {
        if (!isScreenBlock(span) || !typingUi(span.key)) continue;
        if (!typeUi(span.key, key)) return false;
        refreshTimeline();
        drawNow();
        return true;
      }
      return false;
    },
    pointer(input) {
      const { x, y, phase } = input;
      if (x <= -1e5 || y <= -1e5) {
        // the pointer left the stage
        for (const [key, mood] of [...runtime.moods]) if (mood.hover) runtime.moods.set(key, { ...mood, hover: false });
        touch();
        return false;
      }
      if (phase === 'move') {
        if (uiGrab !== null && uiGrab.pointer === input.pointer) {
          // a switch or slider of a mock-up follows the finger in the same frame
          if (moveUi(uiGrab.block, x - viewport.width / 2, y - viewport.height / 2, input.pointer)) {
            refreshTimeline();
            drawNow();
          }
          return true;
        }
        if (grab !== null && grab.pointer === input.pointer) {
          const site = sitesNow().find((candidate) => candidate.key === grab?.key);
          const zone = site?.layout.zones.find((candidate) => candidate.part === grab?.zone);
          if (site === undefined || zone === undefined) return true;
          const value = controlEngine.valueAt({ ...site.input, mood: CALM }, site.layout, zone, localOf(site, x, y));
          if (value !== null) holdValue(site, value);
          return true;
        }
        const hit = hitControl(x, y);
        setMood(hit === null ? null : hit.site.key, hit === null ? {} : { hover: true });
        return hit !== null;
      }
      if (phase === 'down') {
        // v2.2: a finger on a mock-up: a tab, a pick, a toggle, a slider, or a thumbnail brought forward
        const blocks = timeline.schedule.elements.filter(isScreenBlock).map((span) => span.key);
        if (blocks.length > 0) {
          const sx = x - viewport.width / 2;
          const sy = y - viewport.height / 2;
          const block = uiBlockAt(blocks, sx, sy);
          const touched = block === null ? null : downUi(block, sx, sy, input.pointer);
          if (block !== null && touched !== null && touched.taken) {
            // the rest of this gesture is the mock-up's: a held switch or slider, a button that acts when the finger lets go
            uiGrab = { pointer: input.pointer, block };
            if (touched.changed) {
              refreshTimeline();
              drawNow();
            }
            return true;
          }
        }
        const hit = hitControl(x, y);
        if (hit === null) {
          if (runtime.open !== null) {
            runtime.open = null;
            touch();
          }
          return false;
        }
        const { site, zone } = hit;
        // a click anywhere but the open menu's own list closes it
        if (runtime.open !== null && runtime.open !== site.key) runtime.open = null;
        setMood(site.key, { hover: true, pressed: zone.part });
        if (zone.drag) {
          grab = { pointer: input.pointer, key: site.key, zone: zone.part, from: site.value };
          const value = controlEngine.valueAt({ ...site.input, mood: CALM }, site.layout, zone, localOf(site, x, y));
          if (value !== null) holdValue(site, value);
        } else pressedZone = { pointer: input.pointer, key: site.key, zone: zone.part };
        return true;
      }
      // up, cancel
      if (uiGrab !== null && uiGrab.pointer === input.pointer) {
        const held = uiGrab;
        uiGrab = null;
        const done = upUi(held.block, input.pointer, phase === 'cancel', x - viewport.width / 2, y - viewport.height / 2);
        if (done.changed) {
          refreshTimeline();
          drawNow();
        }
        if (done.send !== undefined) sayPress(done.send);
        return true;
      }
      if (grab !== null && grab.pointer === input.pointer) {
        const done = grab;
        grab = null;
        const site = sitesNow().find((candidate) => candidate.key === done.key);
        setMood(done.key, { pressed: null });
        if (site === undefined) return true;
        if (phase === 'cancel' && done.from !== null) holdValue(site, done.from);
        else if (site.value !== null) sayControl(site, site.value);
        return true;
      }
      if (pressedZone !== null && pressedZone.pointer === input.pointer) {
        const done = pressedZone;
        pressedZone = null;
        setMood(done.key, { pressed: null });
        if (phase === 'up') {
          const hit = hitControl(x, y);
          if (hit !== null && hit.site.key === done.key && hit.zone.part === done.zone) actOn(hit.site, hit.zone, x, y);
        }
        return true;
      }
      return false;
    },
    setControl(id, value, commit) {
      const site = siteById(id);
      if (site === null) return;
      const spec = site.input.spec;
      if (spec.control === 'button') {
        if (commit) sayControl(site, true);
        return;
      }
      const held = holdControl(spec, value ?? undefined);
      if (held === null) return;
      holdValue(site, held);
      if (commit) {
        const now = siteById(id) ?? site;
        sayControl(now, held);
      }
    },

    resize(next) {
      viewport = next;
      renderer.resize(next);
      if (turn !== null) rebuild(timeline.schedule);
      else if (reviewing && review !== null) timeline = buildTimeline(review.schedule, review.base, timelineContext());
      else rebuildRest();
      if (settling !== null) timeline = buildTimeline(timeline.schedule, turn?.base ?? base, timelineContext());
      sendReady(lastReadySpec ?? timeline.specAt(0));
      drawNow();
    },

    mockups: mockupViews,

    snapshot: snapshotNow,

    on(type, listener) {
      const set = listeners[type] as Set<typeof listener>;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },

    anticipate(_input, tappedKey) {
      // The turn the user is interrupting stops exactly as Stop would stop it.
      if (turn !== null && settling === null) interruptTurn();
      anticipation = { tappedKey, since: clock.read().ambient };
      setClockEvent('waiting');
      draw(clock.read(), false);
    },

    cancelAnticipation() {
      if (anticipation === null) return;
      anticipation = null;
      const reading = clock.read();
      setClockEvent(effectiveState(reading));
      draw(reading, false);
    },

    setServices(next) {
      services = next;
      // Without a painter on the server every picture is its sketch and nothing is on its way.
      if (!next.paint) {
        for (const [key, painting] of paintings) if (painting.status === 'waiting') paintings.set(key, { status: 'unpainted', url: null, since: 0 });
        sketchQueue.clear();
      }
    },

    assetArrived(key, status, url) {
      const known = paintings.get(key);
      if (known === undefined || !pictureOnStage(key)) return;
      if (status !== 'ready' || url === null) {
        arrived.delete(key);
        paintings.set(key, { status: 'unpainted', url: null, since: 0 });
        return;
      }
      if (known.status === 'ready' || arrived.has(key)) return;
      renderer.preload(url).then(
        () => {
          if (disposed || !pictureOnStage(key)) return;
          arrived.set(key, url);
          promoteArrivals(clock.read());
        },
        () => {
          if (!disposed && pictureOnStage(key)) paintings.set(key, { status: 'unpainted', url: null, since: 0 });
        },
      );
    },

    pictureArrived(partId, picture) {
      if (picture === null) return;
      renderer.preload(picture.url).then(
        () => {
          if (disposed) return;
          setUiPicture(partId, picture);
          refreshTimeline();
          drawNow();
        },
        () => undefined,
      );
    },

    showAll() {
      if (turn === null || settling !== null || turn.showingAll) return;
      const reading = clock.read();
      turn.showingAll = true;
      turn.skippedAt = reading.playhead;
      if (lastFrame !== null) fading = { from: lastFrame, startedAt: performance.now() };
      clock.jump(settledEnd());
      observe(clock.read());
    },

    recordings() {
      return [...recordings.values()].map((found) => (latePaintings.size === 0 ? found : { ...found, paintings: { ...Object.fromEntries(latePaintings), ...found.paintings } }));
    },

    recording(id) {
      const found = recordings.get(id ?? lastRecorded ?? '');
      if (found === undefined) return null;
      if (latePaintings.size === 0) return found;
      return { ...found, paintings: { ...Object.fromEntries(latePaintings), ...found.paintings } };
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(frameHandle);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const set of Object.values(listeners)) set.clear();
    },
  };
  return painter;
}

