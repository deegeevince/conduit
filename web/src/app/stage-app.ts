import { DEFAULT_LOOK, FIRST_LOAD_DEMO, LineNormalizer, LineReader, parseLine, parseReplayDirective, serializeLine } from '@conduit/language';
import overtureScript from '@conduit/language/demos/overture.series?raw';
import type { ActivityState, ActionRisk, BackEvent, ControlValue, ControlValues, CriticFinding, DataTable, InkMarks, Issue, PassState, Line, LeadWindow, LookId, ScreenFacts, Services, Sight, StageEvent, TurnEndReason, TurnInput } from '@conduit/language';
import type { AppAct, AppHost } from '../contracts/app';
import type { ExportJob, ExportRequest, Exporter } from '../contracts/export';
import type { ChartHost } from '../contracts/chart';
import type { StageHook } from '../contracts/hook';
import type { LinkStatus, StageLink } from '../contracts/link';
import type { Painter } from '../contracts/painter';
import type { Renderer } from '../contracts/renderer';
import type { Viewport } from '../contracts/space';
import { createExporter } from '../export';
import { createHttpLink } from '../link/http-link';
import type { HttpLink } from '../link/http-link';
import { LOOKS } from '../looks';
import { createSound } from '../audio/sound';
import type { Sound } from '../audio/sound';
import { createPainter } from '../painter';
import { createChartEngine } from '../render/chart';
import { createFilm } from '../painter/film';
import { createReel, lastAnswer } from '../painter/reel';
import { createPlainRenderer } from '../render/plain';
import { canUseThree, createThreeRenderer } from '../render/three';
import { asDataTable } from '../link/guards';
import { createAccessLayer } from './access';
import { createChartHost } from './chart-host';
import { createLiveApps } from './live-app';
import { createHook } from './hook';
import { observeRenderer } from './observe';
import type { AppParams } from './params';
import { applyLook } from './theme';

export interface StageAppOptions {
  /** the element the stage fills; its size is the painter's viewport */
  readonly host: HTMLElement;
  readonly params: AppParams;
  /** the gallery locks each stage to one look */
  readonly lockLook: LookId | null;
  /** a fixture script to play as soon as the stage is ready */
  readonly autoplay: string | null;
}

/** What the prompt bar says, and whether its button reads Stop. */
export interface StageStatus {
  readonly text: string;
  readonly busy: boolean;
  /** true for a state a screen reader should hear (stopped, failed, offline); routine playing/thinking is not */
  readonly announce: boolean;
  /** set while an export is running: the status line offers Cancel */
  readonly cancel: (() => void) | null;
}

export interface RejectNote {
  readonly turn: string;
  readonly raw: string;
  readonly issues: readonly Issue[];
}

/** What the debug HUD shows beyond the painter's snapshot. */
export interface Diagnostics {
  readonly lead: LeadWindow | null;
  readonly linkStatus: LinkStatus;
  readonly rejects: readonly RejectNote[];
  /** back-channel events given up on after retries */
  readonly dropped: number;
  /** why a renderer was passed over, and anything else worth a line */
  readonly notes: readonly string[];
  /** what the server said it can do; null before `hello` */
  readonly services: Services | null;
  /** how the last turn landed, as it was reported */
  readonly sight: Sight | null;
  /** what the critic last made of a finished turn (v2.1); null until it has looked */
  readonly critic: CriticFinding | null;
}

/** What the agent is doing, for the chrome: a tool in use, something that needs the owner's yes, or a new turn that clears both. */
export type AgentNote =
  | { readonly type: 'activity'; readonly turn: string; readonly id: string; readonly tool: string; readonly summary: string; readonly state: ActivityState; readonly ms: number | null }
  | { readonly type: 'permission'; readonly turn: string; readonly request: string; readonly tool: string; readonly summary: string; readonly risk: ActionRisk; readonly expiresMs: number; readonly detail?: string }
  /** the turn these belonged to has ended or been stopped: nothing about it is still waiting for an answer */
  | { readonly type: 'over'; readonly turn: string | null };

export interface StageApp {
  readonly painter: Painter;
  readonly link: HttpLink;
  readonly hook: StageHook;
  /** where this stage's charts live; null when this build has no charting engine */
  readonly charts: ChartHost | null;
  /** v2.3. Where live apps run: the sandboxed frames over the stage. `/stop-all` ends them. */
  readonly apps: AppHost;
  /** v2.1. The stage's sound: a tune on it is played here. Muted, stopped and heard by the chrome. */
  readonly sound: Sound;
  /** the line the charting engine's licence asks for, to show in the page; null when there is none */
  readonly attribution: { readonly text: string; readonly href: string } | null;
  /** whether the server can look at a draft and fix it, and whether the viewer has it switched on */
  readonly review: { readonly available: boolean; readonly on: boolean; set(on: boolean): void };
  /** Interrupts whatever is playing, reports it, then starts a turn with this prompt (and the ids of the photos the server kept for it, `link.uploadPhoto`). */
  prompt(text: string, photos?: readonly string[], marks?: InkMarks): Promise<string>;
  demo(name: string): Promise<string>;
  /** Stops the current turn where it is. */
  interrupt(): void;
  /** The same as tapping the element with this key. */
  choose(key: string): void;
  /** Settles the open turn at once. */
  showAll(): void;
  /** v2.1. The owner's answer to a `permission` event: allow it once, or not. Sent once; a second answer to the same request is ignored. */
  permit(turn: string, request: string, allow: boolean): void;
  /** v2.1. Hears what the agent is doing and what it is asking. Returns the way to stop hearing. */
  onAgent(listener: (note: AgentNote) => void): () => void;
  /** v2.1. Keep making the picture on stage better, `passes` times at most (`/better`). Rejects when the server cannot. */
  refine(passes: number): Promise<string>;
  /**
   * v2.1. Puts a page of the app's own on the stage (`/help`, `/status`, `/tools`): lines of Series, played at once as a turn that
   * belongs to the page, never reported to the server. Whatever was playing is stopped first, as Stop does.
   */
  showPage(source: string): void;
  /** v2.1. The id of the turn on stage, or the last that ended; null before the first. */
  lastTurn(): string | null;
  /** The back-channel events actually handed to the link, oldest first (the last 200); taps the app set aside are not among them. */
  sentEvents(): readonly BackEvent[];
  /** The canonical lines of the last turn that ended, one per line; '' before there is one. */
  script(): string;
  playScript(text: string): Promise<string>;
  sight(): Sight | null;
  capture(maxSide?: number): Promise<string | null>;
  /** Throws a sentence a person can act on when there is nothing to export yet. */
  export(request: ExportRequest): ExportJob;
  formats(): ReturnType<Exporter['formats']>;
  /** Says something in the status line, for a screen reader too, for a few seconds. */
  announce(text: string): void;
  onStatus(listener: (status: StageStatus) => void): () => void;
  status(): StageStatus;
  diagnostics(): Diagnostics;
  dispose(): void;
}

const MAX_NOTES = 30;
const MAX_REJECTS = 20;
const MAX_OPENED = 200;
const MAX_SENT = 200;
const START_LIMIT_MS = 15000;
/** a turn that is fetching a document may take this long to show its first line */
const READING_LIMIT_MS = 60000;
const CONNECT_DELAYS_MS = [0, 400, 800, 1500, 2500, 4000] as const;
/** the fixture is performed at a model's speed, as the server's replay brain does */
const LOCAL_CHARS_PER_SECOND = 240;
const LOCAL_TURN = 'local-first-load';
const REVIEW_KEY = 'conduit.lookAndFix';
const DATA_LIMIT_MS = 20000;
/** turns the app plays for itself (a help page, a look); the server never hears of them */
const PAGE_PREFIX = 'local-page-';
const MAX_SEEN = 400;

function readReviewSetting(): boolean {
  try {
    return window.localStorage.getItem(REVIEW_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeReviewSetting(on: boolean): void {
  try {
    window.localStorage.setItem(REVIEW_KEY, on ? 'on' : 'off');
  } catch {
    // the setting is for this visit only
  }
}

/** Fixtures that ship inside the page, so the first drawing never waits for the server. */
const BUNDLED_SCRIPTS: Readonly<Record<string, string>> = { [FIRST_LOAD_DEMO]: overtureScript };

interface LocalStep {
  readonly delayMs: number;
  readonly line: Line;
}

/** The fixture as the stage would have received it: paced like a model writing, ids filled in. */
function localSteps(source: string): LocalStep[] {
  const reader = new LineReader();
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  const steps: LocalStep[] = [];
  let owed = 0;
  for (const raw of source.split('\n')) {
    const directive = parseReplayDirective(raw);
    if (directive !== null) {
      owed += directive.seconds * 1000;
      continue;
    }
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const parsed = reader.read(raw);
    if (parsed.kind !== 'line') continue;
    const { line } = normalizer.normalize(parsed.line);
    if (line === null) continue;
    steps.push({ delayMs: owed + (raw.length / LOCAL_CHARS_PER_SECOND) * 1000, line });
    owed = 0;
  }
  return steps;
}

function pointerKind(): ScreenFacts['pointer'] {
  if (matchMedia('(pointer: coarse)').matches) return 'coarse';
  return matchMedia('(pointer: fine)').matches ? 'fine' : 'none';
}

function viewportOf(host: HTMLElement): Viewport {
  const box = host.getBoundingClientRect();
  return { width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)), dpr: window.devicePixelRatio || 1 };
}

async function mountRenderer(host: HTMLElement, viewport: Viewport, startLook: LookId, locked: boolean, params: AppParams, notes: string[]): Promise<Renderer> {
  const note = (text: string): void => {
    notes.push(text);
    if (notes.length > MAX_NOTES) notes.shift();
  };
  if (params.renderer !== 'plain') {
    let usable = false;
    try {
      usable = params.renderer === 'three' || canUseThree();
    } catch (cause) {
      note(`WebGL check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (usable) {
      const three = (() => {
        try {
          return createThreeRenderer();
        } catch (cause) {
          note(`WebGL renderer unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
          return null;
        }
      })();
      if (three !== null) {
        try {
          await (locked ? three.mount(host, viewport, startLook, { looks: [startLook] }) : three.mount(host, viewport, startLook));
          return three;
        } catch (cause) {
          note(`WebGL renderer failed to mount, using plain: ${cause instanceof Error ? cause.message : String(cause)}`);
          try {
            three.dispose();
          } catch {
            // already unusable
          }
        }
      }
    } else if (params.renderer === 'auto') {
      note('WebGL2 is not available, using plain');
    }
  }
  const plain = createPlainRenderer();
  await plain.mount(host, viewport, startLook);
  return plain;
}

function newRenderer(params: AppParams): Renderer {
  if (params.renderer !== 'plain') {
    try {
      if (params.renderer === 'three' || canUseThree()) return createThreeRenderer();
    } catch {
      // the plain renderer can always draw
    }
  }
  return createPlainRenderer();
}

/**
 * Composes one stage: picks a renderer (three.js when it can run, otherwise
 * plain), builds the painter on it, connects the link, and wires the two
 * streams together. Stage events drive the painter; the painter's back
 * channel goes up the link. This is the only place those three meet.
 */
export async function mountStage(options: StageAppOptions): Promise<StageApp> {
  const { host, params, lockLook, autoplay } = options;
  const notes: string[] = [];
  const rejects: RejectNote[] = [];
  const statusListeners = new Set<(status: StageStatus) => void>();

  if (lockLook !== null) applyLook(host, LOOKS[lockLook]);

  const viewport = viewportOf(host);
  let rawRenderer: Renderer;
  try {
    rawRenderer = await mountRenderer(host, viewport, lockLook ?? DEFAULT_LOOK, lockLook !== null, params, notes);
  } catch (cause) {
    throw new Error(`The stage could not start: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  let shownSpec: object | null = null;
  const observed = observeRenderer(rawRenderer, (frame) => {
    if (frame.spec === shownSpec) return;
    shownSpec = frame.spec;
    applyLook(host, frame.spec);
  });
  const renderer = observed.renderer;

  const link: HttpLink = createHttpLink();
  let painter: Painter;
  host.style.touchAction = 'pinch-zoom';
  const engine = createChartEngine();
  const access = createAccessLayer(host, {
    setControl: (id, value, commit) => painter.setControl(id, value, commit),
    chartAct: (key, action) => (chartHost === null ? Promise.reject(new Error('No charts.')) : chartHost.act(key, action)),
  });
  const chartHost: ChartHost | null = engine === null ? null : createChartHost({ engine, stage: host, access });
  const sound = createSound();
  // Live apps run here, in sandboxed frames over the stage; what the user does in one goes up the back channel (`appAct`, below).
  const liveApps: AppHost = createLiveApps({ stage: host, onAct: (act) => appAct(act), onNote: (text) => announce(text) });
  // A browser lets a page make sound once the person has done something on it: the Send that asks for music is that, and so is any first click or key.
  const wake = (): void => sound.unlock();
  document.addEventListener('pointerdown', wake, { capture: true });
  document.addEventListener('keydown', wake, { capture: true });
  try {
    painter = createPainter({
      renderer,
      viewport,
      lockLook,
      charts: chartHost,
      tunes: sound,
      uploadUrl: (id) => link.photoUrl(id),
      apps: liveApps,
      pointer: pointerKind(),
      reducedMotion: params.motion === 'reduced' ? true : params.motion === 'full' ? false : null,
    });
  } catch (cause) {
    liveApps.dispose();
    chartHost?.dispose();
    access.dispose();
    try {
      renderer.dispose();
    } catch {
      // nothing to release
    }
    throw new Error(`The stage could not start: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const offControls = painter.on('controls', (views) => access.controls(views));
  access.controls(painter.snapshot().controls);

  let reviewOn = readReviewSetting();
  /** the pass the open turn's look-and-fix is at, from the server's `pass` events; null between turns */
  let passState: PassState | null = null;
  let passInfo: { readonly pass: number; readonly of: number | null; readonly reason: string | null } | null = null;
  /** one controller per data call: a slow table does not cancel the others, and leaving the page cancels all */
  const dataCalls = new Set<AbortController>();
  /** the rows that came, by id, for an export to draw the charts the same way */
  const dataTables = new Map<string, DataTable | null>();
  const agentListeners = new Set<(note: AgentNote) => void>();
  /** an event the stream may deliver again after a reconnect is acted on once */
  const seenEvents = new Set<string>();
  const firstTime = (key: string): boolean => {
    if (seenEvents.has(key)) return false;
    seenEvents.add(key);
    if (seenEvents.size > MAX_SEEN) seenEvents.delete(seenEvents.values().next().value ?? '');
    return true;
  };
  const permitted = new Set<string>();
  let lastCritic: CriticFinding | null = null;
  let pageCount = 0;

  let lead: LeadWindow | null = null;
  let services: Services | null = null;
  let lastSight: Sight | null = null;
  let dropped = 0;
  let disposed = false;
  let currentTurn: string | null = null;
  let lastSeq = -1;
  /** every turn id this stage has opened; a stream replay of one of them is ignored even after it ended */
  const opened = new Set<string>();
  let sendFailure: string | null = null;
  let pending = 0;
  let lastEnd: { readonly reason: TurnEndReason; readonly message: string | null } | null = null;
  let stoppedByUser = false;
  let connecting = true;
  let firstReady = true;
  let lastStatus = '';

  /** From a tap or Enter until the answer's first line: the stage already shows it heard, and a second tap is ignored. */
  let starting = false;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  /** the viewer pressed Stop before the server had opened the turn: close it the moment it opens */
  let stopPending = false;
  /** counts submissions, so a failure of one that was replaced does not undo its replacement */
  let submission = 0;

  /**
   * The first-load demo is performed from the copy that ships in the page while the connection is
   * made in parallel. Once the session exists the server plays the same demo into its own memory
   * (so the brain knows what the viewer saw); that copy is not drawn a second time.
   */
  let localTimer: ReturnType<typeof setTimeout> | undefined;
  let localOpen = false;
  let localActed = false;
  /** the server's id for the muted demo turn; back events about the local one are re-addressed to it */
  let mutedTurn: string | null = null;
  let mutingNext = false;
  const mutedTurns = new Set<string>();
  const sent: BackEvent[] = [];
  /** Every back-channel event that goes up passes here, so the hook reports what the server was really given. */
  function sendBack(event: BackEvent): void {
    sent.push(event);
    if (sent.length > MAX_SENT) sent.shift();
    link.send(event);
  }
  let heldReport: BackEvent | null = null;

  /** what the server is fetching for this turn, by name, and what it could not read */
  const readingNow = new Set<string>();
  let readingFailed: string[] = [];

  let notice: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let exporting: { readonly label: string; fraction: number; readonly cancel: () => void } | null = null;
  let exporter: Exporter | null = null;

  let connectSettle: { readonly resolve: () => void; readonly reject: (error: Error) => void } | null = null;
  const connected = new Promise<void>((resolve, reject) => {
    connectSettle = { resolve, reject };
  });
  connected.catch(() => undefined);

  function computeStatus(): StageStatus {
    const link_ = link.status;
    if (link_ === 'closed') return { text: 'connection lost: reload to start again', busy: false, announce: true, cancel: null };
    if (connecting || link_ === 'connecting') return { text: 'connecting', busy: false, announce: false, cancel: null };
    const snap = painter.snapshot();
    const active = starting || pending > 0 || snap.turn !== null;
    const playing = snap.clock === 'playing' || (snap.clock === 'hidden' && snap.playhead < snap.end);
    const waiting = readingNow.size > 0 ? `reading ${[...readingNow].join(' and ')}...` : readingFailed.length > 0 ? readingFailed.join('; ') : 'thinking';
    let text: string;
    let announce = false;
    if (sendFailure !== null) {
      text = sendFailure;
      announce = true;
    } else if (!active) {
      if (lastEnd !== null && (lastEnd.reason === 'failed' || lastEnd.reason === 'timeout')) {
        announce = true;
        text = lastEnd.reason === 'timeout' ? 'the brain went quiet and was stopped' : `the brain failed${lastEnd.message ? `: ${lastEnd.message}` : ''}`;
      } else if (notice !== null) {
        text = notice;
        announce = true;
      } else {
        text = stoppedByUser ? 'stopped' : 'ready';
        announce = stoppedByUser;
      }
    } else if (starting) text = waiting;
    else if (snap.showingAll) text = 'showing everything';
    else if (snap.clock === 'paused') text = 'paused';
    else if (playing) text = snap.clock === 'hidden' ? 'playing (this tab is in the background)' : 'playing';
    else text = waiting;
    if (passState !== null && (text === 'playing' || text === 'thinking')) text = passText(passState) ?? text;
    if (active && text === 'playing' && readingFailed.length > 0) text = readingFailed.join('; ');
    if (link_ === 'reconnecting') {
      text = `reconnecting; ${text}`;
      announce = true;
    }
    if (exporting !== null) {
      return { text: `making ${exporting.label}: ${Math.round(exporting.fraction * 100)}%`, busy: active, announce: false, cancel: exporting.cancel };
    }
    return { text, busy: active, announce, cancel: null };
  }

  /** What the status line says while a look-and-fix or a better-pass is going on; null for a state it has nothing to say about. */
  function passText(state: PassState): string | null {
    const of = passInfo?.of ?? null;
    switch (state) {
      case 'refining':
        return `making it better: pass ${passInfo?.pass ?? 1}${of === null ? '' : ` of ${of}`}`;
      case 'refused':
        return passInfo?.reason ? `the fix was not used: ${passInfo.reason}` : 'the fix was not used; the drawing stands';
      case 'staged':
        return 'trying a fix out of sight';
      case 'drafted':
      case 'looking':
      case 'fixing':
        return reviewOn ? 'checking the drawing' : null;
      case 'kept':
      case 'skipped':
        return null;
    }
  }

  function publishStatus(): void {
    const status = computeStatus();
    const key = `${status.text}|${status.busy}|${status.announce}|${status.cancel === null}`;
    if (key === lastStatus) return;
    lastStatus = key;
    for (const listener of [...statusListeners]) listener(status);
  }

  function announce(text: string): void {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = null;
      lastStatus = '';
      publishStatus();
    }, 6000);
    lastStatus = '';
    publishStatus();
  }

  function beginStarting(limit = START_LIMIT_MS): void {
    starting = true;
    clearTimeout(startTimer);
    startTimer = setTimeout(() => {
      if (!starting) return;
      starting = false;
      if (currentTurn === null && painter.snapshot().anticipating) painter.cancelAnticipation();
      publishStatus();
    }, limit);
  }

  function endStarting(): void {
    if (!starting) return;
    starting = false;
    clearTimeout(startTimer);
  }

  function stopLocal(): void {
    clearTimeout(localTimer);
    localTimer = undefined;
    localActed = true;
    if (localOpen) {
      localOpen = false;
      painter.interrupt();
    }
  }

  function startLocal(name: string): boolean {
    const source = BUNDLED_SCRIPTS[name];
    if (source === undefined) return false;
    const steps = localSteps(source);
    localOpen = true;
    painter.openTurn(LOCAL_TURN, { kind: 'demo', script: name });
    let index = 0;
    let seq = 0;
    const next = (): void => {
      if (disposed || !localOpen) return;
      const step = steps[index];
      if (step === undefined) {
        localOpen = false;
        localTimer = undefined;
        painter.closeTurn(LOCAL_TURN, 'done');
        publishStatus();
        return;
      }
      localTimer = setTimeout(() => {
        if (disposed || !localOpen) return;
        index += 1;
        seq += 1;
        painter.ingest(LOCAL_TURN, seq, step.line);
        publishStatus();
        next();
      }, step.delayMs);
    };
    next();
    return true;
  }

  /** Rows a chart draws by reference: fetched like a painting's news, handed to the painter; a failure is told as null so the chart says so. */
  async function loadData(id: string, url: string | null): Promise<void> {
    if (url === null) {
      dataTables.set(id, null);
      painter.dataArrived(id, null);
      return;
    }
    const call = new AbortController();
    dataCalls.add(call);
    const timer = setTimeout(() => call.abort(), DATA_LIMIT_MS);
    try {
      const response = await fetch(url, { signal: call.signal });
      const body: unknown = response.ok ? await response.json() : null;
      const table = asDataTable(body);
      if (!disposed) {
        dataTables.set(id, table);
        painter.dataArrived(id, table);
      }
    } catch {
      if (!disposed) {
        dataTables.set(id, null);
        painter.dataArrived(id, null);
      }
    } finally {
      clearTimeout(timer);
      dataCalls.delete(call);
    }
  }

  function tellAgent(note: AgentNote): void {
    for (const listener of [...agentListeners]) listener(note);
  }

  function noteReject(note: RejectNote): void {
    rejects.push(note);
    if (rejects.length > MAX_REJECTS) rejects.shift();
  }

  function onStageEvent(event: StageEvent): void {
    switch (event.type) {
      case 'hello':
        lead = event.lead;
        services = event.services;
        painter.setServices(event.services);
        return;
      case 'turn':
        if (event.turn === currentTurn || opened.has(event.turn)) return;
        opened.add(event.turn);
        if (mutingNext) {
          mutingNext = false;
          mutedTurns.add(event.turn);
          if (mutedTurn === null) {
            mutedTurn = event.turn;
            if (heldReport?.type === 'report') sendBack({ ...heldReport, report: { ...heldReport.report, turn: event.turn } });
            heldReport = null;
          }
          return;
        }
        if (opened.size > MAX_OPENED) opened.delete(opened.values().next().value ?? '');
        currentTurn = event.turn;
        sendFailure = null;
        lastEnd = null;
        stoppedByUser = false;
        notice = null;
        readingNow.clear();
        readingFailed = [];
        passState = null;
        passInfo = null;
        tellAgent({ type: 'over', turn: null });
        pending = Math.max(0, pending);
        painter.openTurn(event.turn, event.input);
        if (stopPending) {
          stopPending = false;
          stoppedByUser = true;
          endStarting();
          painter.interrupt();
          currentTurn = null;
        }
        return;
      case 'reading':
        if (event.turn !== currentTurn) return;
        if (event.state === 'start') readingNow.add(event.label);
        else if (event.state === 'failed') readingNow.delete(event.label);
        if (event.state === 'failed') {
          const note = `could not read ${event.label}: ${event.message ?? 'unknown reason'}`;
          if (!readingFailed.includes(note)) readingFailed.push(note);
        }
        if (starting) beginStarting(READING_LIMIT_MS);
        return;
      case 'line': {
        if (event.turn !== currentTurn || event.seq <= lastSeq) return;
        lastSeq = event.seq;
        endStarting();
        const parsed = parseLine(event.text);
        if (parsed.kind === 'line') {
          painter.ingest(event.turn, event.seq, parsed.line);
        } else {
          noteReject({
            turn: event.turn,
            raw: event.text,
            issues: parsed.kind === 'reject' ? parsed.issues : [{ code: 'not-a-line', severity: 'error', message: `server sent a ${parsed.kind}` }],
          });
        }
        return;
      }
      case 'reject':
        noteReject({ turn: event.turn, raw: event.raw, issues: event.issues });
        return;
      case 'asset':
        painter.assetArrived(event.key, event.status, event.url);
        return;
      case 'picture':
        // A reconnect may hand the same news again: the painter takes a part's photograph once.
        if (!firstTime(`picture:${event.turn}:${event.id}`)) return;
        painter.pictureArrived(event.id, { url: event.url, credit: event.credit, landing: event.landing });
        return;
      case 'data':
        // A reconnect may hand the same news again: the rows are fetched once.
        if (!firstTime(`data:${event.turn}:${event.id}:${event.status}`)) return;
        void loadData(event.id, event.status === 'ready' ? event.url : null);
        return;
      case 'pass':
        // Look and fix: the painter answers `drafted` with a draft report; the other states are for the status line.
        // With the switch off the painter is not told, so no picture of the draft is made or sent. A better-pass is the viewer's
        // own request and goes on whatever that switch says. A reconnect does not play a pass again.
        if (event.turn !== currentTurn || (!reviewOn && event.state !== 'refining')) return;
        if (!firstTime(`pass:${event.turn}:${event.pass}:${event.state}`)) return;
        passState = event.state;
        passInfo = { pass: event.pass, of: event.of ?? null, reason: event.reason };
        painter.notePass(event.turn, event.pass, event.state);
        return;
      case 'candidate': {
        // A fix tried out of sight: the painter applies it to a copy of the turn and answers with a draft; nothing on stage moves.
        if (event.turn !== currentTurn || !reviewOn || !firstTime(`candidate:${event.turn}:${event.pass}`)) return;
        const lines: Line[] = [];
        for (const text of event.lines) {
          const parsed = parseLine(text);
          if (parsed.kind === 'line') lines.push(parsed.line);
        }
        painter.tryCandidate(event.turn, event.pass, lines);
        return;
      }
      case 'critic':
        if (firstTime(`critic:${event.turn}`)) lastCritic = event.finding;
        return;
      case 'activity':
        if (event.turn === currentTurn && firstTime(`activity:${event.turn}:${event.id}:${event.state}`)) tellAgent(event);
        return;
      case 'permission':
        // A request already answered is never asked again, whatever the stream replays.
        if (event.turn !== currentTurn || permitted.has(event.request) || !firstTime(`permission:${event.request}`)) return;
        tellAgent(event);
        return;
      case 'end':
        if (event.turn !== currentTurn) return;
        endStarting();
        lastEnd = { reason: event.reason, message: event.message };
        readingNow.clear();
        passState = null;
        passInfo = null;
        currentTurn = null;
        tellAgent({ type: 'over', turn: event.turn });
        painter.closeTurn(event.turn, event.reason);
        return;
    }
  }

  const offEvent = link.onEvent((event) => {
    onStageEvent(event);
    publishStatus();
  });
  const offLinkStatus = link.onStatus(publishStatus);
  const offDropped = link.onDropped((count) => {
    dropped += count;
  });
  const offNote = link.onNote(noteTurnFailure);
  const offClock = painter.on('clock', publishStatus);
  const offUpload = painter.on('upload', (upload) => {
    // A picture of a page the app played for itself is of no use to the server, which never heard of that turn.
    if (upload.kind !== 'sketch' && upload.turn.startsWith(PAGE_PREFIX)) return;
    link.upload(upload);
  });

  /**
   * Opens a turn for something the viewer did. The stage shows it was heard before anything is
   * sent; if the request cannot be made the stage goes back to how it was and the caller learns why.
   */
  async function submit(input: TurnInput, tappedKey: string | null, anticipate: boolean): Promise<string> {
    // before anything is awaited, so that it is still the click or the key that sent it
    sound.unlock();
    if (connecting) await connected;
    // Nothing is stopped for a turn that cannot be sent.
    if (link.status !== 'open') {
      sendFailure = `could not send${input.kind === 'prompt' ? ' (your words are back in the box)' : ''}: the connection is down, so nothing was sent; try again in a moment`;
      publishStatus();
      throw new Error('the connection is down, so nothing was sent; try again in a moment');
    }
    stopLocal();
    // a new turn is a new answer: what was playing stops, and this gesture is what lets the next music begin
    sound.stop();
    submission += 1;
    const mine = submission;
    stoppedByUser = false;
    stopPending = false;
    sendFailure = null;
    notice = null;
    if (anticipate) {
      painter.anticipate(input, tappedKey);
      beginStarting();
    } else {
      painter.interrupt();
    }
    currentTurn = null;
    pending += 1;
    publishStatus();
    try {
      return await link.startTurn(input);
    } catch (cause) {
      if (mine === submission) {
        if (anticipate) painter.cancelAnticipation();
        endStarting();
        stopPending = false;
        sendFailure = `could not send${input.kind === 'prompt' ? ' (your words are back in the box)' : input.kind === 'script' ? ' (the script is still in the box)' : ''}: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      throw cause;
    } finally {
      pending -= 1;
      publishStatus();
    }
  }

  function keyOfChoice(id: string): string | null {
    const found = painter.snapshot().elements.filter((element) => element.id === id && element.tappable);
    return found[found.length - 1]?.key ?? null;
  }

  const offContext = renderer.onContext?.((event) => {
    if (event === 'lost') announce('The graphics context was lost. Trying to bring the stage back.');
    else if (event === 'restored' || event === 'rebuilt') announce('The stage is back.');
    else {
      // Nothing else is coming: the notice stays until the page is reloaded.
      notice = 'The graphics could not be brought back. Reload this page with ?renderer=plain to carry on with the plain renderer.';
      clearTimeout(noticeTimer);
      lastStatus = '';
      publishStatus();
    }
  });

  const offBack = painter.on('back', (event) => {
    // What the painter says about a page the app played for itself stays here.
    if (('turn' in event && typeof event.turn === 'string' && event.turn.startsWith(PAGE_PREFIX)) || (event.type === 'report' && event.report.turn.startsWith(PAGE_PREFIX))) return;
    if (event.type === 'ready') {
      if (firstReady) {
        firstReady = false;
        sent.push(event);
        void connectWithRetry({ screen: event.screen, capabilities: event.capabilities, look: event.look });
        return;
      }
    }
    if (event.type === 'control' && event.turn === LOCAL_TURN) {
      publishBack({ ...event, turn: mutedTurn });
      return;
    }
    if (('turn' in event && event.turn === LOCAL_TURN) || (event.type === 'report' && event.report.turn === LOCAL_TURN)) {
      // About the local demo: the server knows it under its own id, once it has one.
      if (event.type === 'started' || event.type === 'progress') return;
      if (event.type === 'report') {
        lastSight = event.report.sight;
        if (mutedTurn === null) {
          heldReport = event;
          return;
        }
        sendBack({ ...event, report: { ...event.report, turn: mutedTurn } });
        return;
      }
      if (event.type === 'tap') {
        publishBack({ ...event, turn: mutedTurn });
        return;
      }
    }
    publishBack(event);
  });

  function publishBack(event: BackEvent): void {
    if (event.type === 'report') lastSight = event.report.sight;
    if (event.type === 'tap' && event.choice) {
      // A second tap while the first is still starting its turn is not a second message.
      if (starting) return;
      sendBack(event);
      void submit({ kind: 'tap', id: event.id, text: event.text }, keyOfChoice(event.id), true).catch(noteTurnFailure);
      return;
    }
    if (event.type === 'control' && event.send) {
      // A press, or a change the viewer meant for the brain: it is also the next turn's input, as a choice's tap is.
      if (starting) return;
      sendBack(event);
      const views = painter.snapshot().controls;
      const view = views.find((candidate) => candidate.id === event.id);
      const values: Record<string, ControlValue> = {};
      for (const candidate of views) if (candidate.value !== null) values[candidate.id] = candidate.value;
      const text = view === undefined ? event.text : view.control === 'pick' ? view.valueText : view.label !== '' ? view.label : event.text;
      void submit({ kind: 'act', id: event.id, text, values: values satisfies ControlValues }, null, true).catch(noteTurnFailure);
      return;
    }
    sendBack(event);
    publishStatus();
  }

  /**
   * What the user did in a live app. It goes up the back channel as a control event marked as the app's: the brain is told of it on its next
   * turn ("the user did X in the app"), or, when the app asked (`conduit.ask`), it is also the next turn's input, as a press is.
   */
  function appAct(act: AppAct): void {
    if (disposed) return;
    const at = painter.snapshot();
    const said = typeof act.value === 'string' ? (act.name === 'state' ? act.value : JSON.stringify(act.value)) : String(act.value);
    const text = (act.name === 'state' ? `state ${said}` : `${act.name} ${said}`).slice(0, 380);
    publishBack({ type: 'control', turn: at.turn, id: act.id.slice(0, 24), value: act.value, text, playhead: at.playhead, send: act.ask, app: true });
  }

  function noteTurnFailure(cause: unknown): void {
    notes.push(typeof cause === 'string' ? cause : `turn failed to start: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (notes.length > MAX_NOTES) notes.shift();
    publishStatus();
  }

  async function connectWithRetry(ready: Parameters<StageLink['connect']>[0]): Promise<void> {
    let lastError: unknown = null;
    for (const delay of CONNECT_DELAYS_MS) {
      if (disposed) return;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await link.connect(ready);
        connecting = false;
        connectSettle?.resolve();
        publishStatus();
        if (autoplay !== null) {
          if (localStarted) {
            // The viewer is already watching it; the server plays its own copy unseen so the brain remembers it.
            if (!localActed) {
              mutingNext = true;
              link.startTurn({ kind: 'demo', script: autoplay }).catch((cause: unknown) => {
                mutingNext = false;
                noteTurnFailure(cause);
              });
            }
          } else {
            void submit({ kind: 'demo', script: autoplay }, null, false).catch(noteTurnFailure);
          }
        }
        return;
      } catch (cause) {
        lastError = cause;
      }
    }
    connecting = false;
    link.close();
    notes.push(lastError instanceof Error ? lastError.message : 'The server cannot be reached.');
    connectSettle?.reject(lastError instanceof Error ? lastError : new Error('The server cannot be reached.'));
    publishStatus();
  }

  applyLook(host, LOOKS[painter.snapshot().look]);

  // Events are never emitted from inside the call, so the transcript (mounted by the page once this
  // function returns) still hears the demo's first line.
  let localStarted = false;
  if (autoplay !== null) {
    localTimer = setTimeout(() => {
      localTimer = undefined;
      if (!disposed && !localActed) localStarted = startLocal(autoplay);
    }, 0);
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!disposed) painter.resize(viewportOf(host));
    }, 100);
  });
  observer?.observe(host);

  /** the pointers a control has taken: the rest of their gesture is the control's */
  const taken = new Set<number>();
  let hoverFrame = 0;
  let hoverAt: { readonly x: number; readonly y: number } | null = null;
  const inChart = (event: Event): boolean => event.target instanceof Element && event.target.closest('.stage__chart') !== null;
  const localPoint = (event: PointerEvent): { readonly x: number; readonly y: number } => {
    const box = host.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const controlAt = (point: { readonly x: number; readonly y: number }): string | null => {
    const views = painter.snapshot().controls;
    for (let index = views.length - 1; index >= 0; index -= 1) {
      const view = views[index];
      if (view === undefined || !view.enabled) continue;
      const box = view.box;
      if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) return view.id;
    }
    return null;
  };
  const tappableAt = (x: number, y: number): boolean =>
    painter.snapshot().elements.some((el) => el.tappable && x >= el.box.x && x <= el.box.x + el.box.width && y >= el.box.y && y <= el.box.y + el.box.height);
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || inChart(event)) return;
    const { x, y } = localPoint(event);
    if (painter.pointer({ phase: 'down', x, y, pointer: event.pointerId })) {
      taken.add(event.pointerId);
      event.preventDefault();
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        // a pointer that has already gone: its up is not coming either
        taken.delete(event.pointerId);
      }
      return;
    }
    if (starting && tappableAt(x, y)) return;
    painter.tapAt(x, y);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (inChart(event)) return;
    const point = localPoint(event);
    if (taken.has(event.pointerId)) {
      // A drag is not throttled: the picture follows the finger in the same frame.
      painter.pointer({ phase: 'move', x: point.x, y: point.y, pointer: event.pointerId });
      return;
    }
    if (event.pointerType === 'touch') return;
    hoverAt = point;
    if (hoverFrame !== 0) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const at = hoverAt;
      if (at === null || disposed) return;
      const over = painter.pointer({ phase: 'move', x: at.x, y: at.y, pointer: -1 });
      host.style.cursor = over || (!starting && tappableAt(at.x, at.y)) ? 'pointer' : '';
    });
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (!taken.has(event.pointerId)) return;
    taken.delete(event.pointerId);
    const point = localPoint(event);
    painter.pointer({ phase: event.type === 'pointerup' ? 'up' : 'cancel', x: point.x, y: point.y, pointer: event.pointerId });
    try {
      host.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    // The keyboard carries on from the control that was worked; a text field gets its keyboard now, while the gesture is still the user's.
    if (event.type === 'pointerup') {
      const id = controlAt(point);
      if (id !== null) access.focusControl(id);
      else if (painter.typing()) keys.focus({ preventScroll: true });
    }
  };
  const onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || taken.has(event.pointerId)) return;
    hoverAt = null;
    painter.pointer({ phase: 'move', x: -1e5, y: -1e5, pointer: -1 });
    host.style.cursor = '';
  };
  // The keyboard for a field of a mock-up: a real input, kept focused while a field has the keyboard (a phone raises its keyboard for it; a desktop
  // reads the keys the same way), and every character it takes is handed to the painter, which draws it in the field.
  const keys = document.createElement('input');
  keys.type = 'text';
  keys.className = 'ui-keys';
  keys.autocomplete = 'off';
  keys.setAttribute('aria-hidden', 'true');
  keys.tabIndex = -1;
  keys.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;pointer-events:none';
  host.append(keys);
  keys.addEventListener('keydown', (event) => {
    if (event.key !== 'Backspace' && event.key !== 'Enter' && event.key !== 'Escape') return;
    if (painter.key(event.key)) event.preventDefault();
    if (!painter.typing()) keys.blur();
  });
  keys.addEventListener('input', () => {
    for (const character of keys.value) painter.key(character);
    keys.value = '';
    if (!painter.typing()) keys.blur();
  });
  keys.addEventListener('blur', () => {
    if (painter.typing()) painter.key('Escape');
  });
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerEnd);
  host.addEventListener('pointercancel', onPointerEnd);
  host.addEventListener('pointerleave', onPointerLeave);

  function getExporter(): Exporter {
    exporter ??= createExporter({ createRenderer: () => newRenderer(params), appStill: (key) => liveApps.still(key), appsFresh: () => liveApps.refresh(1500), chartStill: (frame, key) => { const chart = frame.charts?.find((candidate) => candidate.key === key); return chart === undefined ? null : (chartHost?.stillOf(chart) ?? null); } });
    return exporter;
  }

  function scriptText(): string {
    const recording = painter.recording();
    return recording === null ? '' : recording.lines.map(({ line }) => serializeLine(line)).join('\n');
  }

  const LABELS = { video: 'film', still: 'picture', script: 'script', pdf: 'pdf' } as const;
  /** The longest a film of several turns is made: a conversation longer than this keeps its latest turns, and says so. */
  const REEL_MAX_SECONDS = 600;

  function startExport(request: ExportRequest): ExportJob {
    const recording = painter.recording();
    if (recording === null) throw new Error('There is nothing to take away yet. Ask for something first.');
    const snap = painter.snapshot();
    const size = request.kind === 'script' ? snap.viewport : { width: request.width, height: request.height, dpr: 1 };
    // What the viewer's hand held and what the charts were given go into the file: it shows the picture as they left it.
    const held: Record<string, ControlValue> = {};
    for (const view of snap.controls) if (view.value !== null) held[view.id] = view.value;
    const filmOptions = { apps: true, viewport: size, reducedMotion: snap.reducedMotion, arrival: 'at-once' as const, controls: held, data: Object.fromEntries(dataTables) };
    // A film is of the last answer (a prompt and the taps that carried it on) unless `scope` says the last turn alone, or the whole conversation.
    let film;
    let reelNote: string | null = null;
    if (request.kind === 'video' && request.scope !== 'turn') {
      const everything = painter.recordings();
      const conversation = request.scope === 'conversation';
      const turns = conversation ? everything : lastAnswer(everything);
      const reel = createReel(turns.length > 0 ? turns : [recording], filmOptions, { cards: conversation, maxSeconds: REEL_MAX_SECONDS });
      film = reel;
      if (reel.leftOut > 0 || reel.cut) reelNote = `The film holds at most ${REEL_MAX_SECONDS / 60} minutes: ${reel.leftOut > 0 ? `the first ${reel.leftOut} turn${reel.leftOut === 1 ? '' : 's'} ${reel.leftOut === 1 ? 'is' : 'are'} left out` : 'the last turn is cut short'}`;
    } else film = createFilm(recording, filmOptions);
    // A film is not touched by a second job: the exporter refuses it, and the one still running keeps the status line.
    const refused = exporting !== null && request.kind !== 'script' && !(request.kind === 'still' && request.format === 'svg');
    const job = getExporter().start(film, request.kind === 'still' ? { ...request, at: Math.min(request.at, film.duration) } : request);
    const run = { label: request.kind === 'video' && request.scope === 'conversation' ? 'conversation film' : LABELS[request.kind], fraction: 0, cancel: () => job.cancel() };
    if (!refused) exporting = run;
    job.onProgress((progress) => {
      run.fraction = progress.done;
      publishStatus();
    });
    const finish = (message: string | null): void => {
      if (exporting === run) exporting = null;
      if (message === null) publishStatus();
      else announce(message);
    };
    job.done.then(
      () => finish(null),
      (cause: unknown) =>
        finish(
          cause instanceof Error && cause.name === 'AbortError'
            ? `${run.label} cancelled`
            : refused && cause instanceof Error
              ? cause.message
              : `the ${run.label} could not be made: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    );
    publishStatus();
    return reelNote === null ? job : { ...job, done: job.done.then((made) => ({ ...made, note: reelNote })) };
  }

  /** Lines of Series played at once, as a turn of the app's own. */
  function showPage(source: string): void {
    stopLocal();
    if (painter.snapshot().turn !== null || starting) {
      // What was being written is stopped exactly as Stop stops it.
      app.interrupt();
    }
    pageCount += 1;
    const turn = `${PAGE_PREFIX}${pageCount}`;
    const steps = localSteps(source);
    painter.openTurn(turn, { kind: 'script', text: source }, { page: true });
    steps.forEach((step, index) => painter.ingest(turn, index + 1, step.line));
    painter.closeTurn(turn, 'done');
    publishStatus();
  }

  const app: Omit<StageApp, 'hook'> = {
    painter,
    link,
    charts: chartHost,
    apps: liveApps,
    sound,
    attribution: engine?.attribution ?? null,
    review: {
      get available() {
        return services?.review === true;
      },
      get on() {
        return reviewOn;
      },
      set(on) {
        reviewOn = on;
        writeReviewSetting(on);
        link.setReview(on);
        if (!on) passState = null;
        lastStatus = '';
        publishStatus();
      },
    },
    prompt: (text, photos, marks) => submit({ kind: 'prompt', text, ...(photos === undefined || photos.length === 0 ? {} : { images: photos }), ...(marks === undefined ? {} : { marks }) }, null, true),
    demo: (name) => submit({ kind: 'demo', script: name }, null, true),
    playScript: (text) => submit({ kind: 'script', text }, null, true),
    interrupt() {
      sound.stop();
      if (localOpen) {
        stopLocal();
        stoppedByUser = true;
      } else if (painter.interrupt() !== null) {
        stoppedByUser = true;
      } else if (starting) {
        painter.cancelAnticipation();
        stopPending = true;
        stoppedByUser = true;
      }
      endStarting();
      currentTurn = null;
      passState = null;
      passInfo = null;
      tellAgent({ type: 'over', turn: null });
      publishStatus();
    },
    permit(turn, request, allow) {
      if (permitted.has(request)) return;
      permitted.add(request);
      if (permitted.size > MAX_SEEN) permitted.delete(permitted.values().next().value ?? '');
      sendBack({ type: 'permit', turn, request, allow });
    },
    onAgent(listener) {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    refine: (passes) => submit({ kind: 'refine', passes }, null, false),
    showPage,
    // A page of the app's own is not a turn the server knows: Save, /export and /capture never name it to the server.
    lastTurn: () => {
      const turn = painter.snapshot().turn ?? painter.recording()?.turn ?? null;
      return turn !== null && turn.startsWith(PAGE_PREFIX) ? null : turn;
    },
    choose(key) {
      painter.tapElement(key);
    },
    sentEvents: () => [...sent],
    showAll() {
      painter.showAll();
      publishStatus();
    },
    script: scriptText,
    sight: () => lastSight,
    async capture(maxSide = 768) {
      const frame = observed.lastFrame();
      if (frame === null || !renderer.capabilities.capture) return null;
      const blob = await renderer.rasterise(frame, { maxSide, mime: 'image/jpeg', quality: 0.8 });
      if (blob === null) return null;
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    },
    export: startExport,
    formats: () => getExporter().formats(),
    announce,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    status: computeStatus,
    diagnostics: () => ({ lead, linkStatus: link.status, rejects: [...rejects], dropped, notes: [...notes], services, sight: lastSight, critic: lastCritic }),
    dispose() {
      disposed = true;
      clearTimeout(resizeTimer);
      clearTimeout(startTimer);
      clearTimeout(noticeTimer);
      clearTimeout(localTimer);
      exporting?.cancel();
      observer?.disconnect();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerEnd);
      host.removeEventListener('pointercancel', onPointerEnd);
      host.removeEventListener('pointerleave', onPointerLeave);
      cancelAnimationFrame(hoverFrame);
      for (const call of dataCalls) call.abort();
      agentListeners.clear();
      offControls();
      offEvent();
      offLinkStatus();
      offDropped();
      offNote();
      offClock();
      offUpload();
      offBack();
      offContext?.();
      statusListeners.clear();
      exporter?.dispose();
      document.removeEventListener('pointerdown', wake, { capture: true });
      keys.remove();
      document.removeEventListener('keydown', wake, { capture: true });
      sound.dispose();
      link.close();
      painter.dispose();
      liveApps.dispose();
      chartHost?.dispose();
      access.dispose();
      renderer.dispose();
    },
  };

  const hook = createHook(app, connected);
  publishStatus();
  return { ...app, hook };
}
