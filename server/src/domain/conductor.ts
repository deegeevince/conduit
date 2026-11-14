import { API, CANVAS, DATA_LIMITS, EMPTY_STAGE, PASTE_AS_DOCUMENT_CHARS, FULL_CAPABILITIES, LANGUAGE, LEAD_WINDOW, LineNormalizer, LineReader, TurnScore, buildSystemPrompt, draftFactsOf, serializeLine, settle, splitCells, wearingAt, worthALook } from '@conduit/language';
import type { ActivityState, BrainChange, BrainChoice, BrainMode, CriticFinding, DocumentSummary, DocumentView, FixPolicy, NodeId, NodeStatus, OpenDocumentResponse, PromptVariant, Seen, ToolChoice } from '@conduit/language';
import type {
  BackEvent,
  BackEventRecord,
  Capabilities,
  CreateSessionRequest,
  DataFacts,
  DataTable,
  CreateSessionResponse,
  DocumentFacts,
  Figure,
  HexColor,
  Issue,
  LineProblem,
  PaintLine,
  ReviewPolicy,
  Schedule,
  Services,
  RelayClock,
  StageEvent,
  StartTurnResponse,
  TurnEndReason,
  TurnInput,
  UnreadFacts,
} from '@conduit/language';
import { AppError, errors } from '../errors';
import type { Logger } from '../log';
import { ASSET_LIMITS } from './assets';
import type { AssetStore } from './assets';
import type { Brain, BrainEvent, BrainRegistry, Snapshot } from './brain';
import { DOCUMENT_LIMITS, findUrls, hostOf } from './documents';
import type { DocumentReader } from './documents';
import type { ImageModel } from './images';
import { creditLine } from './pictures';
import type { PictureService } from './pictures';
import type { HeldDocument } from './documents';
import { NO_DOCUMENTS, readDocLine } from './document';
import type { DocChange, Documents, LoadedDocument } from './document';
import { buildContext, holdStanding, parseStanding, rememberTurn } from './memory';
import type { StandingAsk } from './memory';
import { MAX_PROBLEMS, SERVER_LIMITS } from './session';
import type { SessionEntry, SessionLog } from './session-log';
import type { ActiveTurn, Session, SessionStore, StageSink } from './session';
import { readPasted } from '../reading/pasted';
import { factsOf, tableFromText } from './datasets';
import type { DatasetLibrary } from './datasets';
import { worthQueuing } from './critic';
import type { Critic, FindingQueue } from './critic';
import { DETAIL_MAX, redactSecrets, splitTool } from './agent';
import { NO_AUDIT } from '../audit';
import type { Audit, AuditDecider } from '../audit';
import { NO_UPLOADS } from './uploads';
import type { StoredUpload, UploadStore } from './uploads';
import type { UsageMeter } from '../usage';
import { currentIdentity, labelOf } from '../identity';
import { askedOf, refusalProblem, reviewTurn } from './review';
import type { FixAttempt } from './review';
import type { TechniqueLibrary } from './techniques';

export interface ConductorDeps {
  readonly sessions: SessionStore;
  readonly brains: BrainRegistry;
  readonly log: Logger;
  readonly assets: AssetStore;
  readonly sessionLog: SessionLog;
  readonly images: ImageModel;
  /** v2.2. Photographs for the `image` parts of a mock-up; absent or unavailable: the placeholder stands */
  readonly pictures?: PictureService;
  /** fetches the links a prompt contains */
  readonly reader: DocumentReader;
  /** what a brain is told about how its last answer landed */
  readonly sight: 'report' | 'snapshot';
  /** how the system prompt teaches a diagram */
  readonly variant: PromptVariant;
  /** the techniques a turn's brief may carry; answers from memory and never waits */
  readonly library: TechniqueLibrary;
  /** the owner's own datasets, for a chart drawn by reference; `NO_DATASETS` unless switched on */
  readonly datasets: DatasetLibrary;
  /** look and fix: whether the brain is shown its draft, and every deadline of it */
  readonly review: ReviewPolicy;
  /** paintings a conversation may ask the image model for */
  readonly maxPaintings: number;
  /**
   * v2.1. The critic that looks at a real turn's resting picture after the turn has ended, and compares a draft with a candidate inside
   * look-and-fix; `NO_CRITIC` when off. Its finding is logged, sent as a `critic` event and queued when it is below `criticQueueBelow`.
   */
  readonly critic: Critic;
  /** v2.1. Where findings wait for the improvement loop */
  readonly findings: FindingQueue;
  /** v2.1. True revision: what a fix must keep, and how long trying one may take (`FIX_POLICY`). Not read from the environment: the loop may not change it. */
  readonly fix: FixPolicy;
  /** v2.1. A finding with a coherence below this is queued for the loop as evidence (`CriticPolicy.queueBelow`) */
  readonly criticQueueBelow: number;
  /** v2.1. The kinds of mind a session may choose (`Env.modes`); `plain` is always there */
  readonly modes: readonly BrainMode[];
  /** v2.1 ops. The audit trail: every tool call, permission asked and answered, setting changed and connector used. Absent: nothing is written. */
  readonly audit?: Audit;
  /** v2.1. The user's photos, kept in the data folder. Absent: no photo can be given. */
  readonly uploads?: UploadStore;
  /** v2.1 ops. The usage meter: every brain turn and review pass is written to it; its throttle only ever warns the owner, never refuses a turn. */
  readonly usage?: UsageMeter;
  /** v3. The document each conversation makes: a fold over its session log (PLAN-v3-core 2.11). Absent: no conversation has one. */
  readonly documents?: Documents;
  /** milliseconds; injected so nothing in the domain reads the wall clock directly */
  readonly now: () => number;
}

export interface EventsPage {
  readonly events: readonly BackEventRecord[];
  readonly cursor: number;
}

const REAP_INTERVAL_MS = 60_000;

/** Stage events that describe a moment and are not part of the turn's score: a reconnecting painter is not given the ones it heard. */
const TRANSIENT: ReadonlySet<StageEvent['type']> = new Set(['pass', 'data', 'candidate', 'permission', 'activity', 'critic']);

/** The longest a turn waits on the owner's datasets before it goes on without them: it is a network call on the turn's path. */
const DATASET_WAIT_MS = 5_000;

/**
 * Runs conversations. It owns the two one-way streams: lines flow from a
 * brain to the painter, and the painter's back channel flows in. HTTP routes
 * translate requests into calls on this class and never touch a brain.
 */
export class Conductor {
  private readonly deps: ConductorDeps;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly reaper: NodeJS.Timeout;
  /** the file each draft's picture was saved under, for the `fix` record; forgotten with the turn's session */
  private readonly draftFiles = new Map<string, string>();

  constructor(deps: ConductorDeps) {
    this.deps = deps;
    deps.sessions.onDrop = (session) => this.release(session, 'session.evicted');
    this.reaper = setInterval(() => {
      for (const session of deps.sessions.reap(deps.now())) this.release(session, 'session.reaped');
    }, REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  private get audit(): Audit {
    return this.deps.audit ?? NO_AUDIT;
  }

  private get docs(): Documents {
    return this.deps.documents ?? NO_DOCUMENTS;
  }

  /**
   * v3. Writes a record to the session log and gives the same record to the conversation's document, which is a fold over exactly these
   * records: so the document in memory and the one folded from the file after a restart cannot differ. A `state` or `node` record that
   * changed nothing is not written. What changed in the document is sent to the painter as a `doc` event.
   */
  private journal(s: Session, entry: SessionEntry): DocChange | null {
    const change = this.docs.record(s.id, entry);
    const gated = entry.type === 'state' || entry.type === 'node';
    if (!gated || change?.applied === true) this.deps.sessionLog.write(s.id, entry);
    if (change !== null && change.nodes.length > 0) {
      const turnId = 'turn' in entry ? entry.turn : null;
      const turn = turnId === null ? null : (s.turns.get(turnId) ?? null);
      this.emit(s, turn, { type: 'doc', turn: turnId, document: change.document, title: change.title, root: change.root, nodes: change.nodes });
    }
    return change;
  }

  /** The person's place and values at the instant they acted (`seen`, on a tap, a control or an act): taken as state when it says something the server had not heard. */
  private adoptSeen(s: Session, turn: string | null, seen: Seen | undefined): void {
    if (seen === undefined) return;
    this.journal(s, { type: 'state', turn, change: { kind: 'sync', seen } });
  }

  /** v3. The catalogue: every document there is, newest first. */
  listDocuments(): Promise<readonly DocumentSummary[]> {
    return this.docs.list();
  }

  /** v3. One document, live or folded from its log, with the person's state in it; null when there is none. */
  documentView(id: string): Promise<DocumentView | null> {
    return this.docs.view(id);
  }

  /** v3. The document this session is making or has opened again; null while it has none. */
  documentOf(session: string): DocumentView | null {
    this.assertSession(session);
    return this.docs.viewOfSession(session);
  }

  /**
   * v3. Opens a document again in a new session, with its own log file that says what it continues (`resumes`). The brain is a fresh
   * process and learns the place from the brief (`context.document`); the page is given the view to draw.
   */
  async resumeDocument(id: string, request: CreateSessionRequest): Promise<OpenDocumentResponse> {
    const loaded = await this.docs.load(id);
    if (loaded === null) throw errors.notFound(`document ${id}`);
    const created = this.createSession(request, loaded);
    const view = this.docs.viewOfSession(created.session);
    if (view === null) throw errors.notFound(`document ${id}`);
    this.deps.log.info('document.resumed', { session: created.session, document: id, nodes: Object.keys(view.document.nodes).length });
    return { ...created, view };
  }

  /**
   * v3, for WS5. Sets a node's status from outside the turn that wrote it (`verified`, `refused`), or sends it back to be written again
   * (`reset`: its body goes, its children stay). Logged as a `node` record and sent as a `doc` event. False when it changed nothing.
   */
  setNodeStatus(session: string, node: NodeId, status: NodeStatus, options: { readonly turn?: string | null; readonly why?: string; readonly reset?: boolean } = {}): boolean {
    const s = this.deps.sessions.require(session, this.deps.now());
    const change = this.journal(s, { type: 'node', turn: options.turn ?? null, node, status, ...(options.reset === true ? { reset: true as const } : {}), why: options.why ?? null });
    return change?.applied === true;
  }

  /** One line of the audit trail about this turn, in the name of whoever started it. */
  private auditTurn(s: Session, turn: ActiveTurn, entry: Omit<Parameters<Audit['record']>[0], 'session' | 'turn'>): void {
    this.audit.record({ login: turn.login, ...entry, session: s.id, turn: turn.id });
  }

  /**
   * What the server offers a conversation. A look is promised only when the policy is on, the painter says it can report on a
   * draft, and the configured brain can look: a painter told to expect one that never comes would only wait.
   */
  private servicesFor(capabilities: Capabilities, session?: string): Services {
    const { review, brains, images, sight, critic } = this.deps;
    const mode = session === undefined ? undefined : brains.configured.choice?.(session).mode;
    return {
      paint: images.available,
      sight,
      // A look is promised only when a fix can be tried first: a painter that cannot gets no fix at all, never a redraw.
      review: review.enabled && review.passes >= 1 && capabilities.drafts && capabilities.candidates && brains.configured.review !== undefined,
      ...(critic.available ? { critic: true } : {}),
      ...(this.deps.uploads?.available === true ? { uploads: true } : {}),
      ...(mode === undefined || mode === 'plain' ? {} : { mode }),
    };
  }

  createSession(request: CreateSessionRequest, resume: LoadedDocument | null = null): CreateSessionResponse {
    const { sessions, now, log } = this.deps;
    const session = sessions.create(request.screen, request.capabilities, now(), { ...EMPTY_STAGE, look: request.look, lookName: request.look });
    this.record(session, { type: 'ready', screen: request.screen, capabilities: request.capabilities, look: request.look });
    this.docs.begin(session.id, this.deps.sessionLog.fileOf(session.id), resume);
    this.journal(session, {
      type: 'session',
      session: session.id,
      started: new Date(now()).toISOString(),
      brain: this.deps.brains.configured.id,
      language: LANGUAGE.version,
      screen: request.screen,
      capabilities: request.capabilities,
      services: this.servicesFor(session.capabilities, session.id),
      ...(resume === null ? {} : { resumes: resume.fold.id }),
    });
    log.info('session.created', { session: session.id, cols: request.screen.cols, rows: request.screen.rows });
    return { session: session.id, lead: LEAD_WINDOW };
  }

  /**
   * Attaches the painter's stream and sends `hello`. If the latest turn has not been reported yet (open or
   * ended), its `turn` event and every event so far are sent again, so a stream that
   * dropped and reconnected misses nothing; the painter ignores a `seq` it
   * has already scheduled. A session has one painter; a second subscriber
   * replaces the first. `close` shuts this subscriber's connection when it is
   * replaced or the server stops. Returns the detach function, which the route
   * calls when the connection closes.
   */
  subscribe(session: string, sink: StageSink, close?: () => void): () => void {
    const s = this.deps.sessions.require(session, this.deps.now());
    s.closeSink?.();
    s.sink = sink;
    s.closeSink = close ?? null;
    sink({ type: 'hello', session: s.id, lead: LEAD_WINDOW, services: this.servicesFor(s.capabilities, s.id) });
    const turn = s.turn;
    // A stream that dropped and came back is given the turn again, but not the passes and the data it already had (P2-34): replayed, a
    // `pass` would ask the painter for a draft it has reported, and `data` would fetch the rows again. What it missed it is given.
    if (turn !== null && !turn.reported) for (const event of turn.sent) if (!TRANSIENT.has(event.type) || turn.missed.includes(event)) sink(event);
    // A painting that settled after its turn was reported, with nobody listening, would otherwise never arrive.
    for (const event of s.lateAssets.splice(0)) sink(event);
    return () => {
      if (s.sink === sink) {
        s.sink = null;
        s.closeSink = null;
      }
    };
  }

  /**
   * Opens a turn and starts its brain. If a turn is still open, it is
   * interrupted first: its brain is aborted and it is remembered as far as
   * the painter has reported it shown. Returns at once; lines arrive on the
   * session's stream.
   */
  startTurn(session: string, input: TurnInput, options: { readonly look?: boolean } = {}): StartTurnResponse {
    const { sessions, brains, log, now } = this.deps;
    const s = sessions.require(session, now());

    const previous = s.turn;
    if (previous !== null && !previous.reported) {
      if (previous.endReason === null) {
        log.info('turn.interrupted', { session: s.id, turn: previous.id, by: 'next-turn' });
        this.finish(s, previous, 'interrupted', null);
      }
      s.draft.close(previous.id);
      this.closeMemoryWithoutReport(s, previous);
    }

    // The photos a prompt names are this conversation's own, or the turn does not open.
    if (input.kind === 'prompt' && (input.images?.length ?? 0) > 0) {
      const held = this.deps.uploads ?? NO_UPLOADS;
      if (!held.available) throw errors.badRequest('photos are switched off on this server');
      const missing = (input.images ?? []).find((id) => !held.has(s.id, id));
      if (missing !== undefined) throw errors.badRequest(`this conversation has no photo ${missing}`);
    }

    if (input.kind === 'tap' || input.kind === 'act') this.adoptSeen(s, previous?.id ?? null, input.seen);
    const brain = brains.forInput(input);
    // A process is started for the first thing the user says, not for a page that only looks (the gallery, the explorer).
    if (brain === brains.configured && (input.kind === 'prompt' || input.kind === 'tap' || input.kind === 'act')) this.prepareBrain(s);
    const context = buildContext(s, this.servicesFor(s.capabilities, s.id));
    const turn: ActiveTurn = {
      id: sessions.nextTurnId(),
      session: s.id,
      input,
      brain: brain.id,
      login: labelOf(currentIdentity()),
      openedAt: now(),
      abort: new AbortController(),
      score: new TurnScore(s.stage, input.kind),
      endReason: null,
      clock: null,
      shownIds: [],
      previous: previous?.id ?? null,
      reader: new LineReader(Object.keys(context.stage.styles)),
      problems: [],
      relayCursor: s.nextCursor - 1,
      ordinal: s.nextOrdinal,
      lineCount: 0,
      rejects: 0,
      lookAllowed: options.look !== false,
      review: undefined,
      reported: false,
      sent: [],
      missed: [],
      snapshotFile: null,
      criticAsked: false,
      calls: new Map(),
    };
    s.nextOrdinal += 1;
    s.heardFrom = s.nextCursor - 1;
    s.turn = turn;
    sessions.indexTurn(s, turn);
    log.info('turn.opened', { session: s.id, turn: turn.id, brain: brain.id, input: turn.input.kind, login: turn.login });
    this.deps.sessionLog.write(s.id, { type: 'turn', turn: turn.id, input, brain: brain.id, login: turn.login });
    this.emit(s, turn, { type: 'turn', turn: turn.id, input });

    // `run` ends its own turn and does not throw; this is the net under it, so that nothing can ever be an unhandled rejection from here.
    this.run(s, turn, brain, context).catch((error: unknown) => {
      log.error('turn.run_escaped', { session: s.id, turn: turn.id, error });
      this.finish(s, turn, 'failed', 'the brain failed unexpectedly');
    });
    return { turn: turn.id, ...this.usageWarning() };
  }

  /**
   * The owner's own turn is never refused for what it costs. When the hour is near the cap (`USAGE_HOURLY_CAP`), or past it, the answer
   * to the turn says so, once the critic and the lessons tool have already stood down: the owner decides whether to go on.
   */
  private usageWarning(): { readonly warning?: string } {
    const meter = this.deps.usage;
    if (meter === undefined || meter.capUsd === null) return {};
    const now = this.deps.now();
    const state = meter.state(now);
    if (state !== 'near' && state !== 'over') return {};
    const spent = meter.spentLastHour(now);
    this.deps.log.warn('usage.cap', { state, spentLastHourUsd: Math.round(spent * 100) / 100, capUsd: meter.capUsd });
    const used = 'The last hour has used ' + dollars(spent) + ' of the ' + dollars(meter.capUsd) + ' an hour you set.';
    return { warning: state === 'over' ? used + ' This answer goes ahead; the critic and the lessons have stopped. See /usage.' : used + ' The critic and the lessons have stopped; your answers have not. See /usage.' };
  }

  /**
   * Takes back-channel events from the painter, in order. `progress` updates
   * the clock; a `report` closes the turn's memory and replaces the session's
   * stage; a `report` with outcome `interrupted` also aborts the brain.
   */
  receive(session: string, events: readonly BackEvent[]): void {
    const s = this.deps.sessions.require(session, this.deps.now());
    for (const event of events) {
      this.record(s, event);
      this.apply(s, event);
    }
  }

  /** Back-channel records after `cursor`. */
  eventsSince(session: string, cursor: number): EventsPage {
    const s = this.deps.sessions.require(session, this.deps.now());
    return { events: s.events.filter((record) => record.cursor > cursor), cursor: Math.max(cursor, s.nextCursor - 1) };
  }

  /** Like `eventsSince`, but waits up to `waitMs` for at least one record. Resolves early if `signal` aborts. */
  async waitForEvents(session: string, cursor: number, waitMs: number, signal: AbortSignal): Promise<EventsPage> {
    const page = this.eventsSince(session, cursor);
    if (page.events.length > 0 || waitMs <= 0 || signal.aborted) return page;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(session) ?? new Set<() => void>();
      this.waiters.set(session, set);
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      set.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
    return this.eventsSince(session, cursor);
  }

  /**
   * The back channel as one turn's relay agent sees it: this turn's events
   * and the painter's `ready`/untargeted taps, after `since` (default: where
   * this agent last looked). Waits for something relevant, or for the turn to
   * close, up to `waitMs`.
   */
  async turnEvents(turn: string, since: number | null, waitMs: number, signal: AbortSignal): Promise<EventsPage> {
    const { session, active } = this.lookup(turn);
    const deadline = this.deps.now() + waitMs;
    let from = since ?? active.relayCursor;
    let page: EventsPage = { events: [], cursor: from };
    for (;;) {
      const remaining = deadline - this.deps.now();
      page = await this.waitForEvents(session.id, from, remaining, signal);
      const relevant = page.events.filter((record) => concerns(record.event, turn));
      if (relevant.length > 0 || remaining <= 0 || signal.aborted || active.endReason !== null) {
        active.relayCursor = Math.max(active.relayCursor, page.cursor);
        return { events: relevant, cursor: page.cursor };
      }
      from = page.cursor;
    }
  }

  /** Pen from the server's schedule, playhead from the painter's last report. Throws `not_found` for an unknown turn. */
  clockOf(turn: string): RelayClock {
    const { active } = this.lookup(turn);
    const pen = active.score.schedule.pen;
    const clock = active.clock;
    if (clock === null) return { pen, playhead: null, lead: null, state: null, reportedMsAgo: null };
    const playhead = this.estimatePlayhead(active);
    return { pen, playhead, lead: pen - playhead, state: clock.state, reportedMsAgo: Math.max(0, this.deps.now() - clock.at) };
  }

  /** True while the turn may still be written to. */
  isOpen(turn: string): boolean {
    return this.lookup(turn).active.endReason === null;
  }

  sessionOfTurn(turn: string): string {
    return this.lookup(turn).session.id;
  }

  /** The brain system prompt for a session's capabilities, or for the full set when no session is given. It never depends on the screen. */
  guideFor(session: string | null): string {
    const capabilities = session === null ? FULL_CAPABILITIES : this.deps.sessions.require(session, this.deps.now()).capabilities;
    return buildSystemPrompt({ capabilities, services: this.servicesFor(capabilities, session ?? undefined), variant: this.deps.variant });
  }

  /** The turn's line reader, which lives as long as the turn does. */
  lineReaderFor(turn: string): LineReader {
    return this.lookup(turn).active.reader;
  }

  /** Where a relay agent can fetch the picture of how the previous answer landed, or null when there is none. */
  snapshotLinkFor(turn: string): string | null {
    const { session, active } = this.lookup(turn);
    if (this.deps.sight !== 'snapshot' || active.previous === null || this.deps.assets.snapshot(session.id, active.previous) === undefined) return null;
    return API.snapshot(session.id, active.previous);
  }

  /** A brain that is not a process (the relay) is briefed by a route; the session log records what it was given. */
  noteBrief(turn: string, text: string): void {
    const { session } = this.lookup(turn);
    this.deps.sessionLog.write(session.id, { type: 'brief', turn, form: 'full', text, system: null, withSnapshot: this.snapshotLinkFor(turn) !== null });
  }

  /**
   * The painter's picture of the stage as a turn left it. Kept for the next
   * brief and saved beside the session log. Dropped without complaint when
   * SIGHT=report, since the painter cannot know that setting.
   */
  /** `/capture`: a film of a turn, made in the page, saved beside the session's log for the steward. Returns the file name. */
  receiveFilm(session: string, turn: string, bytes: Uint8Array): string {
    const s = this.deps.sessions.require(session, this.deps.now());
    if (!s.turns.has(turn)) throw errors.notFound(`turn ${turn}`);
    const file = this.deps.sessionLog.saveSnapshot(s.id, turn, 'video/webm', bytes);
    if (file === '') throw errors.conflict('this server keeps no log folder (LOG_DIR=off), so there is nowhere to put a film');
    this.deps.log.info('capture.saved', { session: s.id, turn, file, bytes: bytes.byteLength });
    return file;
  }

  receiveSnapshot(session: string, turn: string, snapshot: Snapshot): void {
    const s = this.deps.sessions.require(session, this.deps.now());
    if (!s.turns.has(turn)) throw errors.notFound(`turn ${turn}`);
    if (this.deps.sight !== 'snapshot') return;
    this.deps.assets.putSnapshot(s.id, turn, snapshot);
    const file = this.deps.sessionLog.saveSnapshot(s.id, turn, snapshot.mime, snapshot.bytes);
    if (file !== '') this.deps.sessionLog.write(s.id, { type: 'snapshot', turn, file });
    s.snapshotTurns.add(turn);
    const index = s.history.findIndex((memory) => memory.turn === turn);
    const memory = s.history[index];
    if (memory !== undefined) s.history[index] = { ...memory, snapshot: true };
    const active = s.turns.get(turn);
    if (active !== undefined) {
      active.snapshotFile = file === '' ? null : file;
      this.lookAtResult(s, active);
    }
  }

  /**
   * The painter's picture of the stage as pass `pass` of an open turn will leave it. It is what the brain is shown when it looks at its
   * draft; it is kept beside the session log, and nowhere else: a draft's picture is never the next turn's snapshot.
   */
  receiveDraftPicture(session: string, turn: string, pass: number, snapshot: Snapshot): void {
    const s = this.deps.sessions.require(session, this.deps.now());
    if (!s.turns.has(turn)) throw errors.notFound(`turn ${turn}`);
    s.draft.receivePicture(turn, pass, snapshot);
    const file = this.deps.sessionLog.saveSnapshot(s.id, `${turn}-draft${pass}`, snapshot.mime, snapshot.bytes);
    if (file !== '') {
      this.draftFiles.set(`${s.id}/${turn}#${pass}`, file);
      this.deps.sessionLog.write(s.id, { type: 'draft', turn, pass, noted: 0, picture: true, file });
    }
  }

  /** The rows of a table this conversation holds, for the painter's `data` fetch; undefined when there is none under that id. */
  dataFor(session: string, id: string): DataTable | undefined {
    return this.deps.sessions.require(session, this.deps.now()).tables.find((table) => table.id === id);
  }

  /** Throws `not_found` unless the session exists. */
  /** What this session's brain is set to; `configurable: false` when the brain has no model or effort. */
  brainChoice(session: string): BrainChoice {
    this.assertSession(session);
    const brain = this.deps.brains.configured;
    return brain.choice?.(session) ?? { configurable: false, model: null, effort: null };
  }

  /** Sets the model, effort and/or mode of this session's brain; the next turn starts fresh with them. A mode the server does not offer is refused by name. */
  setBrain(session: string, change: BrainChange): BrainChoice {
    this.assertSession(session);
    const brain = this.deps.brains.configured;
    if (brain.choose === undefined) throw errors.badRequest(`the ${brain.id} brain has no model or effort to set`);
    if (change.mode !== undefined && !this.deps.modes.includes(change.mode)) {
      throw errors.badRequest(`this server does not offer the ${change.mode} brain; it offers ${this.deps.modes.join(', ')}`);
    }
    const choice = brain.choose(session, change);
    this.deps.log.info('session.brain_set', { session, model: choice.model, effort: choice.effort, mode: choice.mode });
    const write = (name: string, value: string | undefined): void => {
      if (value === undefined) return;
      this.deps.sessionLog.write(session, { type: 'setting', name, value });
      this.audit.record({ kind: 'setting', session, tool: name, target: value, decision: 'allowed', decidedBy: 'owner' });
    };
    write('model', change.model);
    write('effort', change.effort);
    write('mode', change.mode);
    return { ...choice, modes: this.deps.modes.length > 1 ? this.deps.modes : choice.modes };
  }

  /** What this session's brain may use in agent mode, and what is on (`/tools`); empty for a brain with none. */
  toolsOf(session: string): readonly ToolChoice[] {
    this.assertSession(session);
    return this.deps.brains.configured.tools?.(session) ?? [];
  }

  /** Switches one tool or connected service on or off for this session. Only what the server offers can be switched on: the brain checks its own allowlist, and an unknown name is refused here. */
  setTool(session: string, name: string, on: boolean): readonly ToolChoice[] {
    this.assertSession(session);
    const brain = this.deps.brains.configured;
    if (brain.setTool === undefined) throw errors.badRequest(`the ${brain.id} brain has no tools to switch`);
    if (!(brain.tools?.(session) ?? []).some((tool) => tool.name === name)) throw errors.badRequest(`there is no tool or service called ${name} on offer`);
    const tools = brain.setTool(session, name, on);
    this.deps.sessionLog.write(session, { type: 'setting', name: `tool ${name}`, value: on ? 'on' : 'off' });
    this.audit.record({ kind: 'setting', session, tool: `tool ${name}`, target: on ? 'on' : 'off', decision: 'allowed', decidedBy: 'owner' });
    return tools;
  }

  /** What the user asked to hold on every reply, oldest first (`/asks`). */
  asksOf(session: string): readonly string[] {
    return [...this.deps.sessions.require(session, this.deps.now()).standing];
  }

  /** Forgets one standing ask by its number from 1, or all of them when `n` is null; answers what is left. */
  forgetAsks(session: string, n: number | null): readonly string[] {
    const s = this.deps.sessions.require(session, this.deps.now());
    if (n === null) s.standing = [];
    else holdStanding(s, { kind: 'drop', n });
    this.deps.sessionLog.write(s.id, { type: 'setting', name: 'asks', value: n === null ? 'clear' : `drop ${n}` });
    this.audit.record({ kind: 'setting', session: s.id, tool: 'asks', target: n === null ? 'clear' : `drop ${n}`, decision: 'allowed', decidedBy: 'owner' });
    return [...s.standing];
  }

  /** What the critic made of a turn, or undefined until it has looked. */
  criticOf(session: string, turn: string): CriticFinding | undefined {
    return this.deps.sessions.require(session, this.deps.now()).findings.get(turn);
  }

  /** A photo the user gave has been kept: said in the session's log by its id and size, never its bytes. */
  noteUpload(session: string, stored: StoredUpload): void {
    const s = this.deps.sessions.require(session, this.deps.now());
    this.deps.sessionLog.write(s.id, { type: 'upload', turn: null, id: stored.id, mime: stored.mime, bytes: stored.bytes, width: stored.width, height: stored.height, file: stored.file });
  }

  assertSession(session: string): void {
    this.deps.sessions.require(session, this.deps.now());
  }

  /**
   * The kill switch (v2.1 ops). Everything that is running stops now: every open turn is ended `interrupted` (which aborts its brain, its
   * fetches, its paintings and its looks), every confirm control still waiting for the owner is answered no, every conversation's
   * process is let go, and the critic's looks in flight are abandoned. Synchronous and bounded: nothing here waits for a child to say it
   * has stopped, because a stuck one never will; `killAllChildren` is the hand that makes sure it is gone. Sessions and their settings stay.
   */
  killAll(by: string): { readonly sessions: number; readonly turns: number; readonly permissions: number; readonly browserTabs: number } {
    let turns = 0;
    let browserTabs = 0;
    let permissions = 0;
    const sessions = this.deps.sessions.all();
    for (const s of sessions) {
      permissions += s.permissions.size;
      try {
        this.denyPending(s, null, 'kill');
        const turn = s.turn;
        if (turn !== null && turn.endReason === null) {
          turns += 1;
          this.finish(s, turn, 'interrupted', 'stopped by /stop-all');
        }
      } catch (error) {
        this.deps.log.error('kill.session_failed', { session: s.id, error });
      }
    }
    try {
      browserTabs = this.deps.brains.killAll().browserTabs;
      this.deps.critic.cancel?.();
    } catch (error) {
      this.deps.log.error('kill.brains_failed', { error });
    }
    this.deps.log.warn('kill.all', { by, sessions: sessions.length, turns, permissions, browserTabs });
    return { sessions: sessions.length, turns, permissions, browserTabs };
  }

  /** Aborts every open turn and drops every session. */
  async close(): Promise<void> {
    clearInterval(this.reaper);
    for (const session of this.deps.sessions.clear()) this.release(session, 'session.closed');
  }

  private lookup(turn: string): { session: Session; active: ActiveTurn } {
    const session = this.deps.sessions.findByTurn(turn);
    const active = session?.turns.get(turn);
    if (session === undefined || active === undefined) throw errors.notFound(`turn ${turn}`);
    return { session, active };
  }

  private release(session: Session, event: string): void {
    this.deps.log.info(event, { session: session.id });
    const turn = session.turn;
    if (turn !== null && turn.endReason === null) this.finish(session, turn, 'interrupted', null);
    session.abort.abort();
    this.denyPending(session, null);
    this.deps.brains.configured.release?.(session.id);
    this.deps.assets.drop(session.id);
    this.docs.release(session.id);
    this.deps.sessionLog.close(session.id);
    session.closeSink?.();
    session.sink = null;
    session.closeSink = null;
    this.wake(session.id);
  }

  private wake(session: string): void {
    const set = this.waiters.get(session);
    if (set === undefined) return;
    for (const done of [...set]) done();
  }

  private emit(session: Session, turn: ActiveTurn | null, event: StageEvent): void {
    if (turn !== null) {
      if (event.type === 'reject' && turn.sent.length >= SERVER_LIMITS.linesPerTurn * 2) return;
      // A candidate and a confirm control are answered or gone within seconds: a painter that was not there to hear them cannot use them.
      if (event.type !== 'candidate' && event.type !== 'permission') {
        turn.sent.push(event);
        if (session.sink === null) turn.missed.push(event);
      }
    }
    if (session.sink === null && (event.type === 'asset' || event.type === 'picture') && turn?.reported === true && session.lateAssets.length < 64) session.lateAssets.push(event);
    try {
      session.sink?.(event);
    } catch (error) {
      this.deps.log.warn('stream.sink_failed', { session: session.id, error });
    }
  }

  private record(session: Session, event: BackEvent): void {
    session.events.push({ cursor: session.nextCursor, at: new Date(this.deps.now()).toISOString(), event });
    session.nextCursor += 1;
    while (session.events.length > SERVER_LIMITS.events) {
      // Progress arrives twice a second and must not push out the taps a later turn needs to hear.
      const progress = session.events.findIndex((record) => record.event.type === 'progress');
      session.events.splice(progress < 0 ? 0 : progress, 1);
    }
    this.wake(session.id);
  }

  private apply(s: Session, event: BackEvent): void {
    switch (event.type) {
      case 'ready':
        s.screen = event.screen;
        s.capabilities = event.capabilities;
        return;
      case 'progress': {
        const turn = s.turn;
        if (turn === null || turn.id !== event.turn) return;
        turn.clock = { playhead: event.playhead, pen: event.pen, state: event.clock, ackSeq: event.ackSeq, at: this.deps.now() };
        for (const id of event.shown) if (!turn.shownIds.includes(id)) turn.shownIds.push(id);
        return;
      }
      case 'report': {
        const report = event.report;
        const turn = s.turns.get(report.turn);
        this.deps.sessionLog.write(s.id, { type: 'report', turn: report.turn, report });
        if (turn === undefined || turn.reported) return;
        turn.reported = true;
        this.upsertMemory(s, rememberTurn(turn, report, s.snapshotTurns.has(turn.id)));
        const superseded = [...s.turns.values()].some((other) => other.ordinal > turn.ordinal && other.reported);
        if (!superseded) s.stage = report.stage;
        if (report.outcome === 'interrupted' && turn.endReason === null) {
          this.deps.log.info('turn.interrupted', { session: s.id, turn: turn.id, by: 'painter' });
          this.finish(s, turn, 'interrupted', null);
        }
        return;
      }
      case 'started':
        this.deps.sessionLog.write(s.id, { type: 'started', turn: event.turn });
        return;
      case 'tap':
        this.deps.sessionLog.write(s.id, { type: 'tap', turn: event.turn, id: event.id, text: event.text, choice: event.choice });
        this.adoptSeen(s, event.turn, event.seen);
        return;
      case 'control':
        this.deps.sessionLog.write(s.id, { type: 'control', turn: event.turn, id: event.id, value: event.value, text: event.text, send: event.send });
        this.adoptSeen(s, event.turn, event.seen);
        return;
      case 'state':
        // The person did something the page committed: logged if it changed anything, and what it moved is in the next brief.
        this.journal(s, { type: 'state', turn: event.turn, change: event.change });
        return;
      case 'draft':
        // How the draft will land: what look and fix is waiting on. The picture, when there is one, arrives by upload.
        s.draft.receive(event.turn, event.pass, event.sight, event.placed ?? [], event.snapshot, event.content);
        this.deps.sessionLog.write(s.id, { type: 'draft', turn: event.turn, pass: event.pass, noted: event.sight.items.filter((item) => item.notes.length > 0).length, picture: event.snapshot, file: null });
        return;
      case 'permit':
        // The only road to a yes. The request must be one this session raised for this turn.
        this.answer(s, event.request, event.turn, event.allow, 'owner');
        return;
    }
  }

  /**
   * Tells the configured brain to get ready, once per conversation. A change of screen or look is not a reason: those travel
   * in each turn's brief, and a brain that is already warm keeps its process and its cache.
   */
  private prepareBrain(s: Session): void {
    if (s.preparedFor !== '') return;
    s.preparedFor = 'opened';
    try {
      this.deps.brains.configured.open?.({ session: s.id, capabilities: s.capabilities, screen: s.screen, services: this.servicesFor(s.capabilities, s.id) });
    } catch (error) {
      this.deps.log.warn('brain.open_failed', { session: s.id, error });
    }
  }

  private upsertMemory(s: Session, memory: ReturnType<typeof rememberTurn>): void {
    const index = s.history.findIndex((entry) => entry.turn === memory.turn);
    if (index >= 0) s.history[index] = memory;
    else s.history.push(memory);
    if (s.history.length > SERVER_LIMITS.history * 2) s.history.splice(0, s.history.length - SERVER_LIMITS.history * 2);
  }

  /** The painter never reported this turn: remember what it said it showed, and rest the stage where it stopped. */
  private closeMemoryWithoutReport(s: Session, turn: ActiveTurn): void {
    this.upsertMemory(s, rememberTurn(turn, null, s.snapshotTurns.has(turn.id)));
    if (turn.clock !== null) s.stage = settle(turn.score.schedule, turn.score.base, turn.clock.playhead);
  }

  private estimatePlayhead(turn: ActiveTurn): number {
    const clock = turn.clock;
    if (clock === null) return 0;
    if (clock.state !== 'playing') return clock.playhead;
    const advanced = clock.playhead + (this.deps.now() - clock.at) / 1000;
    return Math.min(advanced, Math.max(turn.score.schedule.pen, clock.pen, clock.playhead));
  }

  /**
   * Ends a turn. It never throws: `run`'s `catch` calls this, and a throw out of a `catch` in a detached promise is an unhandled rejection
   * that, on Node 22, ends the process: the owner's server and every conversation with it (the architecture review's F8). Each step is
   * taken on its own, so one that fails is logged and the ones after it still happen: the turn is marked ended first, so nothing can
   * end it twice, and `end` is sent whatever went wrong before it.
   */
  private finish(s: Session, turn: ActiveTurn, reason: TurnEndReason, message: string | null): void {
    if (turn.endReason !== null) return;
    turn.endReason = reason;
    const step = (what: string, work: () => void): void => {
      try {
        work();
      } catch (error) {
        try {
          this.deps.log.error('turn.finish_step_failed', { session: s.id, turn: turn.id, step: what, error });
        } catch {
          // a logger that throws is the last thing that can be done about
        }
      }
    };
    step('abort', () => {
      if (reason !== 'done') turn.abort.abort();
    });
    step('draft', () => s.draft.close(turn.id));
    // Nothing the owner was asked and did not answer outlives the turn: it is a no.
    step('permissions', () => this.denyPending(s, turn.id, 'turn'));
    // A call that began under the gate's own yes and had not ended when the turn did is still a call that was made.
    step('audit', () => {
      for (const call of turn.calls.values()) if (!call.asked) this.recordCall(s, turn, call.tool, call.summary, 'allowed', 'policy', `still running when the turn ended (${reason})`);
      turn.calls.clear();
    });
    step('log', () => void this.journal(s, { type: 'end', turn: turn.id, reason, message, lines: turn.lineCount }));
    step('emit', () => this.emit(s, turn, { type: 'end', turn: turn.id, reason, message }));
    step('say', () => this.deps.log.info('turn.ended', { session: s.id, turn: turn.id, reason, lines: turn.lineCount, durationMs: this.deps.now() - turn.openedAt }));
    step('wake', () => this.wake(s.id));
    // After `end` has gone, and never waited for.
    step('critic', () => this.lookAtResult(s, turn));
  }

  /**
   * Agent mode: the owner's answer to a confirm control, or the deadline's. Only a `permit` event of this session, for a request this
   * session raised and has not had answered, can say yes; a request answered once is gone, so a second `permit` is nothing.
   */
  private answer(s: Session, request: string, turn: string | null, allow: boolean | null, by: AuditDecider): void {
    const pending = s.permissions.get(request);
    if (pending === undefined || (turn !== null && pending.turn !== turn)) {
      // An answer from the owner (it names a turn) that matches nothing is said, not dropped: it is either late, doubled, or for a request that is not here.
      if (turn !== null) {
        const reason = pending === undefined ? 'no such request' : 'another turn';
        this.deps.log.info('permit.unmatched', { session: s.id, request, turn, open: [...s.permissions.keys()].length, reason });
        // A yes or a no for a question that is not open is on the trail too: late, doubled, or someone guessing at request ids.
        this.audit.record({ kind: 'permission_answered', session: s.id, turn, tool: pending?.tool ?? null, target: pending?.summary ?? request, decision: 'denied', decidedBy: 'policy', note: `a ${allow === true ? 'yes' : 'no'} that matched nothing (${reason}); nothing was allowed by it` });
      }
      return;
    }
    s.permissions.delete(request);
    clearTimeout(pending.timer);
    // The trail is written before the brain is told: a call that runs on this yes has already said who gave it.
    this.audit.record({
      kind: 'permission_answered',
      session: s.id,
      turn: pending.turn,
      login: by === 'owner' ? labelOf(currentIdentity()) : (s.turns.get(pending.turn)?.login ?? labelOf(currentIdentity())),
      tool: pending.tool,
      target: pending.summary,
      decision: allow === true ? 'allowed' : 'denied',
      decidedBy: by,
      note: `risk ${pending.risk}; answered after ${this.deps.now() - pending.askedAt} ms`,
    });
    this.deps.sessionLog.write(s.id, { type: 'permission', turn: pending.turn, request, tool: pending.tool, summary: pending.summary, risk: pending.risk, allow, ms: this.deps.now() - pending.askedAt });
    try {
      pending.brain.permit?.(s.id, request, allow === true);
    } catch (error) {
      this.deps.log.warn('brain.permit_failed', { session: s.id, request, error });
    }
  }

  /** Every confirm control still open, of one turn or of the whole session, is a no. */
  private denyPending(s: Session, turn: string | null, by: AuditDecider = 'turn'): void {
    for (const [request, pending] of [...s.permissions]) if (turn === null || pending.turn === turn) this.answer(s, request, null, null, by);
  }

  /**
   * Reads what the prompt brings: a long paste becomes a document, and the links in a short prompt are
   * fetched (in parallel, each announced to the stage the moment it starts). Failures are kept, not thrown:
   * the brain is told what could not be read and answers honestly.
   */
  /**
   * Everything a prompt brings for the brain to read or draw from. A pasted table is data and costs nothing to read; the links and
   * the owner's dataset are fetched at the same time, each announced to the stage and each with its own deadline.
   * `text` is the prompt the brain is shown when it is not the one the user typed (a table too long to retype is taken out of it).
   */
  private async gather(s: Session, turn: ActiveTurn, brain: Brain): Promise<{ fresh: Set<string>; unread: UnreadFacts[]; data: Set<string>; text: string | null }> {
    const data = new Set<string>();
    const input = turn.input;
    if (input.kind !== 'prompt' || brain.id === 'replay') return { fresh: new Set(), unread: [], data, text: null };
    const say = (label: string, state: 'start' | 'done' | 'failed', message: string | null): void => this.emit(s, turn, { type: 'reading', turn: turn.id, label, state, message });

    const pasted = tableFromText(input.text, 'd0', 'pasted by the user');
    if (pasted !== null) {
      say('your table', 'start', null);
      data.add(this.holdTable(s, turn, pasted).id);
      say('your table', 'done', null);
      // A short table is also in the words; a long one is only data, and the words that came with it are what is left.
      if (input.text.length >= PASTE_AS_DOCUMENT_CHARS) {
        const rest = wordsWithoutRows(input.text, pasted.columns.length);
        return { fresh: new Set(), unread: [], data, text: `${rest === '' ? '' : `${rest}\n`}(a table of ${pasted.rows.length} rows follows as DATA)` };
      }
    }

    const [documents, dataset] = await Promise.all([this.gatherDocuments(s, turn, brain), pasted === null ? this.gatherDataset(s, turn, input.text, say) : Promise.resolve(null)]);
    if (dataset !== null) {
      if (dataset.table !== null) data.add(dataset.table.id);
      else documents.unread.push({ url: dataset.label, why: dataset.why });
    }
    return { ...documents, data, text: null };
  }

  /** The owner's own rows, when the prompt names a dataset the index knows. A network call with one short deadline: a failure is told to the brain, never thrown. */
  private async gatherDataset(
    s: Session,
    turn: ActiveTurn,
    prompt: string,
    say: (label: string, state: 'start' | 'done' | 'failed', message: string | null) => void,
  ): Promise<{ label: string; table: DataTable | null; why: string } | null> {
    const entry = this.deps.datasets.find(prompt)[0];
    if (entry === undefined) return null;
    const label = `your dataset ${entry.dataset}`;
    say(label, 'start', null);
    const started = this.deps.now();
    try {
      const signal = AbortSignal.any([turn.abort.signal, AbortSignal.timeout(DATASET_WAIT_MS)]);
      const rows = await Promise.race([
        this.deps.datasets.rows(entry, signal),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error(turn.abort.signal.aborted ? 'the turn was interrupted' : `no answer within ${DATASET_WAIT_MS} ms`)), { once: true })),
      ]);
      this.auditTurn(s, turn, { kind: 'connector', tool: 'remote', target: `dataset ${entry.dataset}`, decision: 'allowed', decidedBy: 'policy', note: 'the owner\'s own data, read for a chart the prompt named' });
      const table = this.holdTable(s, turn, { ...rows, source: rows.source === '' ? `your dataset ${entry.dataset}` : rows.source });
      if (!turn.abort.signal.aborted) say(label, 'done', null);
      this.deps.log.info('turn.dataset', { session: s.id, turn: turn.id, dataset: entry.dataset, rows: table.rows.length, ms: this.deps.now() - started });
      return { label, table, why: '' };
    } catch (error) {
      const why = error instanceof Error ? error.message : 'it could not be read';
      this.deps.log.warn('turn.dataset_failed', { session: s.id, turn: turn.id, dataset: entry.dataset, why });
      if (!turn.abort.signal.aborted) say(label, 'failed', why);
      return { label, table: null, why };
    }
  }

  /** Keeps a table under the next id; the oldest goes when the conversation holds more than `DATA_LIMITS.tables`. */
  private holdTable(s: Session, turn: ActiveTurn, table: DataTable): DataTable {
    const held: DataTable = { ...table, id: `d${s.nextTable}`, rows: table.rows.slice(0, DATA_LIMITS.rows) };
    s.nextTable += 1;
    s.tables.push(held);
    while (s.tables.length > DATA_LIMITS.tables) s.tables.shift();
    this.deps.sessionLog.write(s.id, { type: 'data', turn: turn.id, id: held.id, source: held.source, rows: held.rows.length, status: 'held', reason: null });
    return held;
  }

  /** A chart said `data=<id>`: tell the painter where its rows are, or that there are none. Not on the turn clock, like a painting. */
  private announceData(s: Session, turn: ActiveTurn, id: string): void {
    const table = s.tables.find((held) => held.id === id);
    const reason = table === undefined ? `the conversation holds no data called ${id}` : null;
    this.deps.sessionLog.write(s.id, { type: 'data', turn: turn.id, id, source: table?.source ?? '', rows: table?.rows.length ?? 0, status: table === undefined ? 'failed' : 'ready', reason });
    this.emit(s, turn, { type: 'data', turn: turn.id, id, status: table === undefined ? 'failed' : 'ready', url: table === undefined ? null : API.data(s.id, id), reason });
  }

  private async gatherDocuments(s: Session, turn: ActiveTurn, brain: Brain): Promise<{ fresh: Set<string>; unread: UnreadFacts[] }> {
    const fresh = new Set<string>();
    const unread: UnreadFacts[] = [];
    const input = turn.input;
    if (input.kind !== 'prompt' || brain.id === 'replay') return { fresh, unread };
    const { sessionLog, log } = this.deps;
    const say = (label: string, state: 'start' | 'done' | 'failed', message: string | null): void => this.emit(s, turn, { type: 'reading', turn: turn.id, label, state, message });
    const hold = (held: Omit<HeldDocument, 'facts'> & { facts: Omit<DocumentFacts, 'id' | 'fresh'> }): void => {
      const id = `d${s.nextDocument}`;
      s.nextDocument += 1;
      s.documents.push({ ...held, facts: { ...held.facts, id } });
      fresh.add(id);
      const pdfBytes = (): number => s.documents.reduce((total, doc) => total + (doc.pdf?.length ?? 0), 0);
      while (s.documents.length > DOCUMENT_LIMITS.perSession || pdfBytes() > DOCUMENT_LIMITS.pdfBytesPerSession) {
        const oldest = s.documents.findIndex((doc) => !fresh.has(doc.facts.id));
        if (oldest < 0) break;
        s.documents.splice(oldest, 1);
      }
    };

    if (input.text.length >= PASTE_AS_DOCUMENT_CHARS) {
      say('your text', 'start', null);
      const read = readPasted(input.text);
      hold({ requested: null, pdf: null, facts: { kind: 'pasted', source: 'pasted', url: null, title: null, chars: read.total, truncated: read.truncated, text: read.text } });
      say('your text', 'done', null);
      return { fresh, unread };
    }

    const urls = findUrls(input.text).filter((url) => !s.documents.some((doc) => doc.requested === url));
    if (urls.length === 0) return { fresh, unread };
    const results = await Promise.all(
      urls.map(async (url) => {
        const label = hostOf(url);
        say(label, 'start', null);
        const result = await this.deps.reader.read(url, turn.abort.signal);
        sessionLog.write(s.id, { type: 'fetch', turn: turn.id, ...result.trace, reason: result.ok ? null : result.why });
        this.auditTurn(s, turn, { kind: 'tool', tool: 'read-link', target: url, decision: result.ok ? 'allowed' : 'failed', decidedBy: 'policy', note: `${result.trace.outcome}${result.trace.status === null ? '' : ` ${result.trace.status}`}` });
        log.info('turn.fetched', { session: s.id, turn: turn.id, url, outcome: result.trace.outcome, status: result.trace.status, bytes: result.trace.bytes, ms: result.trace.ms });
        if (turn.abort.signal.aborted) return { url, result };
        say(label, result.ok ? 'done' : 'failed', result.ok ? null : result.why);
        return { url, result };
      }),
    );
    for (const { url, result } of results) {
      if (!result.ok) {
        unread.push({ url, why: result.why });
        continue;
      }
      const address = result.trace.finalUrl ?? url;
      hold({ requested: url, pdf: result.pdf, facts: { kind: result.kind, source: hostOf(address), url: address, title: result.title, chars: result.text?.length ?? 0, truncated: result.truncated, text: result.text } });
    }
    return { fresh, unread };
  }

  private async run(s: Session, turn: ActiveTurn, brain: Brain, base: ReturnType<typeof buildContext>): Promise<void> {
    const { log, sessionLog } = this.deps;
    let fresh = new Set<string>();
    try {
      const gathered = await this.gather(s, turn, brain);
      fresh = gathered.fresh;
      if (turn.abort.signal.aborted) return;
      // The few techniques that fit what was just said. From memory: no network, file or model is on this path.
      const techniques = turn.input.kind === 'prompt' || turn.input.kind === 'tap' || turn.input.kind === 'act' ? this.deps.library.cardsFor({ input: turn.input, documents: s.documents.length > 0 }) : [];
      if (techniques.length > 0) {
        log.debug('techniques.chosen', { session: s.id, turn: turn.id, techniques: techniques.map((card) => card.id) });
        sessionLog.write(s.id, { type: 'techniques', turn: turn.id, ids: techniques.map((card) => card.id) });
      }
      const data: DataFacts[] = s.tables.map((table) => factsOf(table, gathered.data.has(table.id)));
      const documentNow = this.docs.viewOfSession(s.id);
      const context = {
        ...base,
        documents: s.documents.map((doc): DocumentFacts => ({ ...doc.facts, fresh: fresh.has(doc.facts.id) })),
        unread: gathered.unread,
        techniques,
        ...(data.length > 0 ? { data } : {}),
        // v3. The document and where the person is in it: WS7's DOCUMENT and HERE blocks are made from these.
        ...(documentNow === null ? {} : { document: { document: documentNow.document, state: documentNow.state } }),
      };
      const pdfs = s.documents.flatMap((doc) => (doc.pdf === null ? [] : [{ id: doc.facts.id, bytes: doc.pdf }]));
      const snapshot = this.deps.sight === 'snapshot' && turn.previous !== null ? (this.deps.assets.snapshot(s.id, turn.previous) ?? null) : null;
      const input: TurnInput = gathered.text !== null && turn.input.kind === 'prompt' ? { ...turn.input, text: gathered.text } : turn.input;
      // The photos this prompt names, as they were kept, after the stage's snapshot. A photo that cannot be read back is left out and said in the log.
      const images: Snapshot[] = [];
      if (input.kind === 'prompt') {
        for (const id of input.images ?? []) {
          const loaded = await (this.deps.uploads ?? NO_UPLOADS).load(s.id, id);
          if (loaded === null) log.warn('turn.photo_missing', { session: s.id, turn: turn.id, photo: id });
          else images.push(loaded);
        }
      }
      if (turn.abort.signal.aborted) return;
      const request = { turn: turn.id, session: s.id, input, context, snapshot, pdfs, look: this.deps.review.enabled && turn.lookAllowed, ...(images.length > 0 ? { images } : {}) };
      const normalizer = new LineNormalizer(() => {
        s.nextAutoId += 1;
        return `x${s.nextAutoId}`;
      }, Object.keys(s.stage.styles));
      let stopped = false;
      for await (const event of brain.respond(request, turn.abort.signal)) {
        if (this.ingest(s, turn, event, normalizer, 1) === 'stop') {
          stopped = true;
          break;
        }
      }
      if (!stopped && turn.endReason === null && !turn.abort.signal.aborted) await this.lookAndFix(s, turn, brain, request.input, normalizer);
      this.finish(s, turn, turn.abort.signal.aborted ? 'interrupted' : 'done', null);
    } catch (error) {
      if (turn.endReason !== null) {
        log.debug('turn.error_after_end', { turn: turn.id, error });
        return;
      }
      const timedOut = error instanceof AppError && error.code === 'brain_timeout';
      // A PDF the model would not take must not be handed to it again on every later turn.
      if (error instanceof AppError && error.code === 'brain_failed' && fresh.size > 0) {
        s.documents = s.documents.filter((doc) => !(fresh.has(doc.facts.id) && doc.pdf !== null));
      }
      log.warn('turn.brain_failed', { session: s.id, turn: turn.id, error });
      this.finish(s, turn, timedOut ? 'timeout' : 'failed', error instanceof AppError ? error.message : 'the brain failed unexpectedly');
    }
  }

  /**
   * Look and fix, as true revision: the draft is written; decide, through `reviewTurn`, whether the brain is shown it, and whether what it
   * writes in reply is shown. Its lines reach the stage only as a diff that was tried first and found no worse; a refused one leaves the
   * draft as it was. A look that goes wrong never fails the turn: `reviewTurn` does not throw, and what it gave up on is logged and shown.
   */
  private async lookAndFix(s: Session, turn: ActiveTurn, brain: Brain, input: TurnInput, normalizer: LineNormalizer): Promise<void> {
    const { sessionLog, critic } = this.deps;
    let pass = 1;
    const steps = reviewTurn({
      brain,
      policy: { ...this.deps.review, enabled: this.deps.review.enabled && turn.lookAllowed },
      gate: s.draft,
      turn: turn.id,
      session: s.id,
      input,
      styles: () => Object.keys(turn.score.schedule.styles),
      drafts: s.capabilities.drafts,
      state: () => ({ schedule: turn.score.schedule, rejects: turn.rejects, lastSeq: s.nextSeq - 1, problems: turn.problems }),
      signal: turn.abort.signal,
      now: this.deps.now,
      log: this.deps.log,
      // Only a painter that said it can try a fix first is offered one: otherwise a draft that needs mending is left as it is.
      ...(s.capabilities.candidates ? { candidate: (candidatePass: number, lines: readonly string[]) => this.emit(s, turn, { type: 'candidate', turn: turn.id, pass: candidatePass, lines }) } : {}),
      fix: this.deps.fix,
      ...(critic.available ? { critic } : {}),
      standing: s.standing,
    });
    for await (const step of steps) {
      if (turn.endReason !== null) break;
      if (step.type === 'pass') {
        pass = step.pass;
        sessionLog.write(s.id, { type: 'pass', turn: turn.id, pass: step.pass, state: step.state, reason: step.reason });
        this.emit(s, turn, { type: 'pass', turn: turn.id, pass: step.pass, state: step.state, reason: step.reason });
        // What was thrown away is told to the brain at its next turn, so that it does not write the same fix again.
        if (step.state === 'refused' && step.reason !== null) this.noteRefused(turn, step.reason);
      } else if (step.type === 'record') {
        const { record } = step;
        // Remembered only when a look was actually considered: a plain answer was never a candidate.
        const considered = record.decisions.length > 1 || record.decisions[0]?.look === true;
        if (considered) turn.review = { result: record.result, passes: record.passes, why: record.why };
        for (const attempt of record.fixes) this.logFix(s, turn, attempt);
        sessionLog.write(s.id, {
          type: 'review',
          turn: turn.id,
          outcome: { result: record.result, passes: record.passes, why: record.why },
          decisions: record.decisions,
          firstLineMs: record.firstLineMs,
          totalMs: record.totalMs,
          costUsd: record.costUsd,
        });
      } else if (this.ingest(s, turn, step, normalizer, pass) === 'stop') {
        break;
      }
    }
  }

  private noteRefused(turn: ActiveTurn, reason: string): void {
    const problem = refusalProblem(reason);
    turn.problems.push(problem);
    if (turn.problems.length > MAX_PROBLEMS) turn.problems.splice(0, turn.problems.length - MAX_PROBLEMS);
  }

  private logFix(s: Session, turn: ActiveTurn, attempt: FixAttempt): void {
    this.deps.sessionLog.write(s.id, {
      type: 'fix',
      turn: turn.id,
      pass: attempt.pass,
      form: attempt.form,
      lines: attempt.lines,
      shown: attempt.shown,
      why: attempt.why,
      draft: attempt.draft,
      candidate: attempt.candidate,
      file: this.draftFiles.get(`${s.id}/${turn.id}#${attempt.pass}`) ?? null,
    });
  }

  /**
   * The critic, after the turn: once `end` has gone and the resting picture has come, a turn that drew something is looked at in the
   * background. Never awaited, never on the turn's path; what it finds is logged, sent as an event for the HUD, and queued when it is low.
   */
  private lookAtResult(s: Session, turn: ActiveTurn): void {
    const { critic, sessionLog, findings, now, log } = this.deps;
    if (!critic.available || turn.criticAsked || turn.endReason !== 'done' || turn.snapshotFile === null || turn.brain === 'replay') return;
    if (turn.input.kind === 'demo' || turn.input.kind === 'script') return;
    const snapshot = this.deps.assets.snapshot(s.id, turn.id);
    if (snapshot === undefined) return;
    const facts = draftFactsOf(turn.score.schedule, 0);
    if (!worthALook(facts, { ...this.deps.review, enabled: true, passes: 1 }).look) return;
    turn.criticAsked = true;
    const picture = snapshot;
    const file = turn.snapshotFile;
    const request = {
      session: s.id,
      turn: turn.id,
      pass: 1,
      asked: this.askedForCritic(turn.input),
      input: turn.input.kind,
      picture,
      sight: s.history.find((memory) => memory.turn === turn.id)?.sight ?? null,
    };
    void (async () => {
      try {
        const finding = await critic.look(request, s.abort.signal);
        if (finding === null || s.abort.signal.aborted) return;
        const queued = worthQueuing(finding, this.deps.criticQueueBelow);
        s.findings.set(turn.id, finding);
        while (s.findings.size > SERVER_LIMITS.turnsKept) {
          const oldest = s.findings.keys().next();
          if (oldest.done === true) break;
          s.findings.delete(oldest.value);
        }
        sessionLog.write(s.id, { type: 'critic', turn: turn.id, finding, queued });
        this.emit(s, turn, { type: 'critic', turn: turn.id, finding });
        if (queued) findings.add({ at: new Date(now()).toISOString(), log: sessionLog.fileOf(s.id), turn: turn.id, asked: request.asked, finding, snapshot: file });
      } catch (error) {
        log.warn('critic.failed', { session: s.id, turn: turn.id, error });
      }
    })();
  }

  /** What the critic is told was asked: the user's words, never a document or a table they pasted. */
  private askedForCritic(input: TurnInput): string {
    if (input.kind === 'prompt' && (input.text.length >= PASTE_AS_DOCUMENT_CHARS || tableFromText(input.text, 'd0', '') !== null)) return '(the user pasted a long text or a table)';
    return askedOf(input);
  }

  /** One event of a brain's pass, carried to the log, the score and the painter. Returns `stop` when the turn can take no more. */
  private ingest(s: Session, turn: ActiveTurn, event: BrainEvent, normalizer: LineNormalizer, pass: number): 'stop' | undefined {
    const { log, sessionLog } = this.deps;
    // What the brain was told and what the turn cost are recorded even when the turn was cut short; its lines no longer matter.
    if (event.type === 'brief') {
      sessionLog.write(s.id, { type: 'brief', turn: turn.id, form: event.form, text: event.text, system: event.system, withSnapshot: event.withSnapshot, pass });
      return undefined;
    }
    if (event.type === 'tool') {
      this.recordCall(s, turn, event.tool, event.target ?? '', 'allowed', 'policy');
      sessionLog.write(s.id, { type: 'tool', turn: turn.id, tool: event.tool, target: event.target, pass });
      log.info('brain.tool', { session: s.id, turn: turn.id, pass, tool: event.tool, target: event.target });
      return undefined;
    }
    if (event.type === 'usage') {
      this.deps.usage?.record({
        kind: pass === 1 ? 'turn' : 'review',
        model: this.deps.brains.configured.choice?.(s.id).model ?? null,
        session: s.id,
        turn: turn.id,
        login: turn.login,
        inputTokens: event.usage.inputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        outputTokens: event.usage.outputTokens,
        thinkingTokens: event.usage.thinkingTokens,
        costUsd: event.usage.costUsd,
        ms: event.usage.totalMs,
      });
      sessionLog.write(s.id, { type: 'usage', turn: turn.id, usage: event.usage, pass });
      log.info('turn.usage', {
        session: s.id,
        turn: turn.id,
        pass,
        firstTextMs: event.usage.firstTextMs,
        outputTokens: event.usage.outputTokens,
        thinkingTokens: event.usage.thinkingTokens,
        costUsd: event.usage.costUsd,
      });
      return undefined;
    }
    if (turn.endReason !== null) return undefined;
    if (event.type === 'activity') {
      // A few safe words about a call (the brain adapter has redacted them), logged and shown as it happens. Never its input or its result.
      // The adapter has made these safe; a second net costs nothing and a secret that reaches a log or a stage is the one thing this must not do.
      const summary = redactSecrets(event.summary);
      this.noteCall(s, turn, event.id, event.tool, summary, event.state);
      sessionLog.write(s.id, { type: 'activity', turn: turn.id, id: event.id, tool: event.tool, summary, state: event.state, ms: event.ms });
      this.emit(s, turn, { type: 'activity', turn: turn.id, id: event.id, tool: event.tool, summary, state: event.state, ms: event.ms });
      return undefined;
    }
    if (event.type === 'permission') {
      this.hold(s, turn, event);
      return undefined;
    }
    if (event.type === 'reject') {
      const ask = parseStanding(event.raw);
      if (ask !== null) {
        this.keep(s, turn, ask);
        return undefined;
      }
      if (this.deps.documents !== undefined && this.takeDocumentLine(s, turn, event.raw, pass)) return undefined;
      this.reject(s, turn, event.raw, event.issues);
      return undefined;
    }
    // A standing ask is the conversation's, not the picture's: kept, and neither scheduled nor shown.
    if ((event.line.verb as string) === 'standing') {
      const ask = parseStanding(serializeLine(event.line));
      if (ask !== null) {
        this.keep(s, turn, ask);
        return undefined;
      }
    }
    if (turn.lineCount >= SERVER_LIMITS.linesPerTurn) {
      this.finish(s, turn, 'failed', `the brain wrote more than ${SERVER_LIMITS.linesPerTurn} lines`);
      return 'stop';
    }
    const normalized = normalizer.normalize(event.line);
    if (normalized.line === null) {
      this.reject(s, turn, serializeLine(event.line), [...event.issues, ...normalized.issues]);
      return undefined;
    }
    const line = normalized.line;
    const seq = s.nextSeq;
    s.nextSeq += 1;
    turn.lineCount += 1;
    const penBefore = turn.score.schedule.pen;
    const pushed = turn.score.push(line, seq, this.estimatePlayhead(turn));
    const issues: Issue[] = [...event.issues, ...normalized.issues, ...pushed.issues];
    const text = serializeLine(line);
    log.debug('turn.line', { turn: turn.id, seq, text });
    if (issues.some((issue) => issue.severity === 'warn')) this.noteProblem(turn, text, 'repaired', issues.filter((issue) => issue.severity === 'warn'));
    const start = pushed.schedule.lines.find((timed) => timed.seq === seq)?.start ?? penBefore;
    const node = this.docs.place(s.id, text);
    this.journal(s, { type: 'line', turn: turn.id, seq, text, start, issues, pass, ...(node === null ? {} : { node }) });
    this.emit(s, turn, { type: 'line', turn: turn.id, seq, text, issues });
    if (line.verb === 'paint') this.paint(s, turn, seq, line, pushed.schedule);
    if (line.verb === 'row') this.findPicture(s, turn, line.id, line.cells, pushed.schedule);
    if (line.verb === 'chart' && line.data !== undefined) this.announceData(s, turn, line.data);
    return undefined;
  }

  /**
   * The audit trail's view of a tool call, from the brain's activity stream. `running` comes first (before the CLI asks, for a call that
   * needs the owner), then `waiting` when it was put to the owner; the trail takes a call at its end, because only then is it known what
   * was decided: `denied` by the gate, or `done`/`failed` after a yes or a read that needed none. A call put to the owner is decided by
   * `permission_answered`, which has its own line; here it is only said to have been theirs.
   */
  private noteCall(s: Session, turn: ActiveTurn, id: string, tool: string, summary: string, state: ActivityState): void {
    const known = turn.calls.get(id);
    if (state === 'running') {
      if (known === undefined) turn.calls.set(id, { tool, summary, asked: false });
      return;
    }
    if (state === 'waiting') {
      if (known === undefined) turn.calls.set(id, { tool, summary, asked: true });
      else known.asked = true;
      return;
    }
    const call = known ?? { tool, summary, asked: false };
    turn.calls.delete(id);
    if (state === 'denied') {
      if (!call.asked) this.recordCall(s, turn, call.tool, call.summary, 'denied', 'policy');
      return;
    }
    this.recordCall(s, turn, call.tool, call.summary, 'allowed', call.asked ? 'owner' : 'policy', state === 'failed' ? 'the call failed' : undefined);
  }

  /** One tool call in the audit trail: a connected service's call (`mcp__<service>__<action>`) is filed as the service being used. */
  private recordCall(s: Session, turn: ActiveTurn, tool: string, summary: string, decision: 'allowed' | 'denied', decidedBy: AuditDecider, note?: string): void {
    // Claude in Chrome's own name for itself is `claude-in-chrome`; the trail calls it what the owner offered it as: `chrome`.
    const { service, action } = splitTool(tool);
    this.auditTurn(s, turn, {
      kind: service === null ? 'tool' : 'connector',
      tool: service === null ? tool : service,
      target: service === null ? summary : `${action}: ${summary}`,
      decision,
      decidedBy,
      ...(note === undefined ? {} : { note }),
    });
  }

  /**
   * v3. A document line (`part`, `step`, `ask`, `hint`, `reply`: 2.10) that the parser did not know yet comes here as a reject. It is the
   * document's, not a fault: it is logged as a line and given to the document, and the painter hears of it as a `doc` event. Once the parser
   * reads these verbs they arrive as lines and are placed in `ingest`; the document is built from the same record either way.
   */
  private takeDocumentLine(s: Session, turn: ActiveTurn, raw: string, pass: number): boolean {
    if (readDocLine(raw) === null || turn.lineCount >= SERVER_LIMITS.linesPerTurn) return false;
    const seq = s.nextSeq;
    s.nextSeq += 1;
    turn.lineCount += 1;
    const text = raw.replace(/\s+/g, ' ').trim();
    const node = this.docs.place(s.id, text);
    this.deps.log.debug('turn.document_line', { turn: turn.id, seq, text });
    this.journal(s, { type: 'line', turn: turn.id, seq, text, start: turn.score.schedule.pen, issues: [], pass, ...(node === null ? {} : { node }) });
    return true;
  }

  /** `standing | …` or `standing drop n`: kept for the conversation and given back in every later brief. */
  private keep(s: Session, turn: ActiveTurn, ask: StandingAsk): void {
    const held = holdStanding(s, ask);
    this.deps.sessionLog.write(s.id, { type: 'setting', name: 'standing', value: ask.kind === 'add' ? `add: ${ask.words}` : `drop ${ask.n}` });
    this.auditTurn(s, turn, { kind: 'setting', tool: 'standing', target: ask.kind === 'add' ? `add: ${ask.words}` : `drop ${ask.n}`, decision: 'allowed', decidedBy: 'owner' });
    this.deps.log.info('turn.standing', { session: s.id, turn: turn.id, held: held.length });
  }

  /** The brain wants to do something that needs the owner's yes: shown on the stage, held until a `permit` or the deadline. */
  private hold(s: Session, turn: ActiveTurn, event: Extract<BrainEvent, { type: 'permission' }>): void {
    const { now } = this.deps;
    // A duration from now; a brain that sends a time on the wall clock is read as one.
    const left = Math.max(0, Math.min(event.expiresMs > 1e11 ? event.expiresMs - now() : event.expiresMs, 3_600_000));
    if (s.permissions.has(event.request)) return;
    const brain = this.deps.brains.configured;
    const timer = setTimeout(() => this.answer(s, event.request, null, null, 'timeout'), left);
    timer.unref();
    const summary = redactSecrets(event.summary);
    s.permissions.set(event.request, { request: event.request, turn: turn.id, brain, tool: event.tool, summary, risk: event.risk, askedAt: now(), timer });
    this.auditTurn(s, turn, { kind: 'permission_asked', tool: event.tool, target: summary, decision: 'asked', decidedBy: null, note: `risk ${event.risk}; ${Math.round(left / 1000)} s to answer` });
    // `detail` goes to the confirm control only: not to the session log, not to the activity strip. A second net of redaction, keeping its lines.
    const detail = event.detail === undefined ? undefined : redactSecrets(event.detail, DETAIL_MAX, true);
    this.emit(s, turn, { type: 'permission', turn: turn.id, request: event.request, tool: event.tool, summary, risk: event.risk, expiresMs: left, ...(detail === undefined ? {} : { detail }) });
  }

  private reject(s: Session, turn: ActiveTurn, raw: string, issues: readonly Issue[]): void {
    turn.rejects += 1;
    this.noteProblem(turn, raw, 'rejected', issues);
    this.deps.sessionLog.write(s.id, { type: 'reject', turn: turn.id, raw, issues });
    this.emit(s, turn, { type: 'reject', turn: turn.id, raw, issues });
  }

  /** What the next brief says went wrong: the line, cut short, and why. */
  private noteProblem(turn: ActiveTurn, raw: string, kind: LineProblem['kind'], issues: readonly Issue[]): void {
    const why = issues.map((issue) => issue.message).join('; ') || 'it was not understood';
    turn.problems.push({ raw: raw.replace(/\s+/g, ' ').trim().slice(0, 120), kind, why });
    if (turn.problems.length > MAX_PROBLEMS) turn.problems.splice(0, turn.problems.length - MAX_PROBLEMS);
  }

  /**
   * v2.2. An `image … | what it shows` part of a mock-up: a photograph is looked for by those words, off the turn clock. The line has been
   * forwarded and the turn goes on; a picture that is found arrives as a `picture` event whenever it does, and nothing is said when it is not
   * (the placeholder stays). Only the words leave the machine, and the trail records that they did.
   */
  private findPicture(s: Session, turn: ActiveTurn, block: string, cells: string, schedule: Schedule): void {
    const { pictures, log } = this.deps;
    if (pictures === undefined || !pictures.available) return;
    const found = /^image\b([^|]*)\|\s*(.+)$/i.exec(cells);
    if (found === null) return;
    // only a row of a mock-up: a line of code or a table's cell that begins with the word is not a picture
    const owner = schedule.elements.find((element) => element.id === block && element.kind === 'structure');
    if (owner?.figure?.kind !== 'structure' || owner.figure.structure !== 'screen') return;
    const head = found[1] ?? '';
    const part = /\bid=(\S+)/.exec(head)?.[1];
    // `q="harbour boats water"` is what the brain says to look for: a few concrete nouns, not the caption the placeholder carries
    const asked = /\bq=(?:"([^"]*)"|(\S+))/i.exec(head);
    const words = ((asked?.[1] ?? asked?.[2] ?? '').trim() || (found[2] ?? '').trim());
    if (part === undefined || words === '') return;
    const flags = head.toLowerCase().split(/\s+/);
    // A round picture is an avatar: a photograph of a stranger is never put beside a made-up name
    if (flags.includes('round')) return;
    const aspect = flags.includes('tall') ? 3 / 4 : flags.includes('square') || flags.includes('round') ? 1 : 16 / 9;
    // The turn's abort stops a search that is still wanted only by it; a turn that ended well does not, so the session's abort is the other way out.
    const signal = AbortSignal.any([turn.abort.signal, s.abort.signal]);
    void pictures
      .find({ words, aspect }, signal)
      .then((picture) => {
        if (signal.aborted) return;
        this.auditTurn(s, turn, { kind: 'connector', tool: pictures.id, target: words, decision: picture === null ? 'failed' : 'allowed', decidedBy: 'policy', note: picture === null ? 'a photograph for an image part: none found, the placeholder stays' : 'a photograph for an image part; only these words left the machine' });
        if (picture === null) return;
        log.info('picture.ready', { session: s.id, turn: turn.id, part, key: picture.key });
        this.emit(s, turn, { type: 'picture', turn: turn.id, id: part, url: API.picture(picture.key), credit: creditLine(picture.credit), landing: picture.credit.landingUrl });
      })
      .catch((error: unknown) => log.warn('picture.failed', { session: s.id, turn: turn.id, error }));
  }

  /**
   * A painting is not on the turn clock: the line has been forwarded, the
   * turn goes on, and the outcome arrives as an `asset` event whenever it
   * does. Unavailable or exhausted, the answer is immediate.
   */
  private paint(s: Session, turn: ActiveTurn, seq: number, line: PaintLine, schedule: Schedule): void {
    const key = `${line.id}@${seq}`;
    const span = schedule.elements.find((element) => element.key === key);
    const figure: Figure | null | undefined = span?.figure;
    if (span === undefined || figure === null || figure === undefined || figure.kind !== 'picture') return;

    const { assets, images, sessionLog, now, log } = this.deps;
    const startedAt = now();
    const settleAs = (status: 'ready' | 'skipped' | 'failed', url: string | null, reason: string | null, costUsd: number | null): void => {
      sessionLog.write(s.id, { type: 'paint', turn: turn.id, key, prompt: figure.prompt, status, ms: now() - startedAt, costUsd, reason });
      this.emit(s, turn, { type: 'asset', turn: turn.id, key, status, url, reason });
    };

    if (!images.available) {
      settleAs('skipped', null, 'no image model is configured; the sketch stands', null);
      return;
    }
    if (s.paintings >= this.deps.maxPaintings) {
      settleAs('skipped', null, `this conversation has already had its ${this.deps.maxPaintings} paintings`, null);
      return;
    }
    s.paintings += 1;

    const look = wearingAt(schedule, turn.score.base, span.enter?.start ?? 0);
    const palette: HexColor[] = [look.ground, look.ink, look.accent, look.alt];
    const scene = schedule.scenes.filter((candidate) => candidate.id === span.scene).at(-1);
    const canvas = CANVAS[scene?.canvas ?? s.screen.canvas];
    const aspect = figure.box !== null && figure.box.h > 0 && figure.box.w > 0 ? figure.box.w / figure.box.h : canvas.width / canvas.height;
    // The turn's abort stops its paintings; a turn that ended well does not, so the session's abort is the other way out.
    const signal = AbortSignal.any([turn.abort.signal, s.abort.signal]);

    void (async () => {
      try {
        const sketch = await assets.sketchFor(s.id, key, ASSET_LIMITS.sketchWaitMs, signal);
        if (signal.aborted) throw new AppError('aborted', 499, 'the turn was interrupted');
        const result = await images.generate({ prompt: figure.prompt, medium: figure.medium, palette, aspect, sketch }, signal);
        if (signal.aborted) throw new AppError('aborted', 499, 'the turn was interrupted');
        const stored = assets.putPainting(s.id, result.mime, result.bytes);
        settleAs('ready', API.asset(s.id, stored.id), null, result.costUsd);
      } catch (error) {
        if (!(error instanceof AppError)) log.warn('paint.failed', { session: s.id, turn: turn.id, key, error });
        settleAs('failed', null, error instanceof AppError ? error.message : 'the image model failed unexpectedly', null);
      }
    })();
  }
}

/**
 * The user's words with the rows of the table taken out of them, and nothing else: a line goes only when it reads as a row of that table
 * (the same cells, split the way `tableFromText` splits them). A sentence that happens to hold a comma stays (P1-14).
 */
function wordsWithoutRows(text: string, width: number): string {
  const cellsOf = (line: string): number => (line.includes('\t') ? line.split('\t') : line.includes('|') ? splitCells(line.replace(/^\|/, '')) : line.split(',')).length;
  return text
    .split('\n')
    .filter((line) => line.trim() === '' || cellsOf(line.trim()) !== width)
    .join('\n')
    .trim();
}

function dollars(amount: number): string {
  return '$' + amount.toFixed(2);
}

function concerns(event: BackEvent, turn: string): boolean {
  switch (event.type) {
    case 'ready':
      return true;
    case 'tap':
    case 'control':
      return event.turn === null || event.turn === turn;
    case 'report':
      return event.report.turn === turn;
    case 'state':
      return event.turn === null || event.turn === turn;
    case 'started':
    case 'progress':
    case 'draft':
    case 'permit':
      return event.turn === turn;
  }
}
