import { API, CANVAS, EMPTY_STAGE, PASTE_AS_DOCUMENT_CHARS, FULL_CAPABILITIES, LANGUAGE, LEAD_WINDOW, LineNormalizer, LineReader, TurnScore, buildSystemPrompt, serializeLine, settle, wearingAt } from '@conduit/language';
import type { PromptVariant } from '@conduit/language';
import type {
  BackEvent,
  BackEventRecord,
  CreateSessionRequest,
  CreateSessionResponse,
  DocumentFacts,
  Figure,
  HexColor,
  Issue,
  LineProblem,
  PaintLine,
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
import type { Brain, BrainRegistry, Snapshot } from './brain';
import { DOCUMENT_LIMITS, findUrls, hostOf } from './documents';
import type { DocumentReader } from './documents';
import type { ImageModel } from './images';
import type { HeldDocument } from './documents';
import { buildContext, rememberTurn } from './memory';
import { MAX_PROBLEMS, SERVER_LIMITS } from './session';
import type { SessionLog } from './session-log';
import type { ActiveTurn, Session, SessionStore, StageSink } from './session';
import type { DatasetLibrary } from './datasets';
import type { TechniqueLibrary } from './techniques';

export interface ConductorDeps {
  readonly sessions: SessionStore;
  readonly brains: BrainRegistry;
  readonly log: Logger;
  readonly assets: AssetStore;
  readonly sessionLog: SessionLog;
  readonly images: ImageModel;
  /** fetches the links a prompt contains */
  readonly reader: DocumentReader;
  /** what a brain is told about how its last answer landed */
  readonly sight: 'report' | 'snapshot';
  /** how the system prompt teaches a diagram */
  readonly variant: PromptVariant;
  /** the techniques a turn's brief may carry; answers from memory and never waits */
  readonly library: TechniqueLibrary;
  /** the owner's own datasets, for a chart drawn by reference; `NO_DATASETS` unless switched on. Not yet read by a turn (PLAN-v2.md, package S1). */
  readonly datasets: DatasetLibrary;
  /** paintings a conversation may ask the image model for */
  readonly maxPaintings: number;
  /** milliseconds; injected so nothing in the domain reads the wall clock directly */
  readonly now: () => number;
}

export interface EventsPage {
  readonly events: readonly BackEventRecord[];
  readonly cursor: number;
}

const REAP_INTERVAL_MS = 60_000;

/**
 * Runs conversations. It owns the two one-way streams: lines flow from a
 * brain to the painter, and the painter's back channel flows in. HTTP routes
 * translate requests into calls on this class and never touch a brain.
 */
export class Conductor {
  private readonly deps: ConductorDeps;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly reaper: NodeJS.Timeout;
  private readonly services: Services;

  constructor(deps: ConductorDeps) {
    this.deps = deps;
    // `review` stays off until the conductor can run the pass (PLAN-v2.md, package S1): a painter told to expect a look that never comes would only wait.
    this.services = { paint: deps.images.available, sight: deps.sight, review: false };
    deps.sessions.onDrop = (session) => this.release(session, 'session.evicted');
    this.reaper = setInterval(() => {
      for (const session of deps.sessions.reap(deps.now())) this.release(session, 'session.reaped');
    }, REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  createSession(request: CreateSessionRequest): CreateSessionResponse {
    const { sessions, now, log } = this.deps;
    const session = sessions.create(request.screen, request.capabilities, now(), { ...EMPTY_STAGE, look: request.look, lookName: request.look });
    this.record(session, { type: 'ready', screen: request.screen, capabilities: request.capabilities, look: request.look });
    this.deps.sessionLog.write(session.id, {
      type: 'session',
      session: session.id,
      started: new Date(now()).toISOString(),
      brain: this.deps.brains.configured.id,
      language: LANGUAGE.version,
      screen: request.screen,
      capabilities: request.capabilities,
      services: this.services,
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
    sink({ type: 'hello', session: s.id, lead: LEAD_WINDOW, services: this.services });
    const turn = s.turn;
    if (turn !== null && !turn.reported) for (const event of turn.sent) sink(event);
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
  startTurn(session: string, input: TurnInput): StartTurnResponse {
    const { sessions, brains, log, now } = this.deps;
    const s = sessions.require(session, now());

    const previous = s.turn;
    if (previous !== null && !previous.reported) {
      if (previous.endReason === null) {
        log.info('turn.interrupted', { session: s.id, turn: previous.id, by: 'next-turn' });
        this.finish(s, previous, 'interrupted', null);
      }
      this.closeMemoryWithoutReport(s, previous);
    }

    const brain = brains.forInput(input);
    // A process is started for the first thing the user says, not for a page that only looks (the gallery, the explorer).
    if (brain === brains.configured && (input.kind === 'prompt' || input.kind === 'tap')) this.prepareBrain(s);
    const context = buildContext(s, this.services);
    const turn: ActiveTurn = {
      id: sessions.nextTurnId(),
      session: s.id,
      input,
      brain: brain.id,
      openedAt: now(),
      abort: new AbortController(),
      score: new TurnScore(s.stage),
      endReason: null,
      clock: null,
      shownIds: [],
      previous: previous?.id ?? null,
      reader: new LineReader(Object.keys(context.stage.styles)),
      problems: [],
      relayCursor: s.nextCursor - 1,
      ordinal: s.nextOrdinal,
      lineCount: 0,
      reported: false,
      sent: [],
    };
    s.nextOrdinal += 1;
    s.heardFrom = s.nextCursor - 1;
    s.turn = turn;
    sessions.indexTurn(s, turn);
    log.info('turn.opened', { session: s.id, turn: turn.id, brain: brain.id, input: turn.input.kind });
    this.deps.sessionLog.write(s.id, { type: 'turn', turn: turn.id, input, brain: brain.id });
    this.emit(s, turn, { type: 'turn', turn: turn.id, input });

    void this.run(s, turn, brain, context);
    return { turn: turn.id };
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
    return buildSystemPrompt({ capabilities, services: this.services, variant: this.deps.variant });
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
  }

  /** Throws `not_found` unless the session exists. */
  assertSession(session: string): void {
    this.deps.sessions.require(session, this.deps.now());
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
    this.deps.brains.configured.release?.(session.id);
    this.deps.assets.drop(session.id);
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
      turn.sent.push(event);
    }
    if (session.sink === null && event.type === 'asset' && turn?.reported === true && session.lateAssets.length < 64) session.lateAssets.push(event);
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
      this.deps.brains.configured.open?.({ session: s.id, capabilities: s.capabilities, screen: s.screen, services: this.services });
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

  private finish(s: Session, turn: ActiveTurn, reason: TurnEndReason, message: string | null): void {
    if (turn.endReason !== null) return;
    turn.endReason = reason;
    if (reason !== 'done') turn.abort.abort();
    this.deps.sessionLog.write(s.id, { type: 'end', turn: turn.id, reason, message, lines: turn.lineCount });
    this.emit(s, turn, { type: 'end', turn: turn.id, reason, message });
    this.deps.log.info('turn.ended', { session: s.id, turn: turn.id, reason, lines: turn.lineCount, durationMs: this.deps.now() - turn.openedAt });
    this.wake(s.id);
  }

  /**
   * Reads what the prompt brings: a long paste becomes a document, and the links in a short prompt are
   * fetched (in parallel, each announced to the stage the moment it starts). Failures are kept, not thrown:
   * the brain is told what could not be read and answers honestly.
   */
  private async gather(s: Session, turn: ActiveTurn, brain: Brain): Promise<{ fresh: Set<string>; unread: UnreadFacts[] }> {
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
      hold({ requested: null, pdf: null, facts: { kind: 'pasted', source: 'pasted', url: null, title: null, chars: input.text.length, truncated: false, text: input.text } });
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
      if (techniques.length > 0) log.debug('techniques.chosen', { session: s.id, turn: turn.id, techniques: techniques.map((card) => card.id) });
      const context = {
        ...base,
        documents: s.documents.map((doc): DocumentFacts => ({ ...doc.facts, fresh: fresh.has(doc.facts.id) })),
        unread: gathered.unread,
        techniques,
      };
      const pdfs = s.documents.flatMap((doc) => (doc.pdf === null ? [] : [{ id: doc.facts.id, bytes: doc.pdf }]));
      const snapshot = this.deps.sight === 'snapshot' && turn.previous !== null ? (this.deps.assets.snapshot(s.id, turn.previous) ?? null) : null;
      const request = { turn: turn.id, session: s.id, input: turn.input, context, snapshot, pdfs };
      const normalizer = new LineNormalizer(() => {
        s.nextAutoId += 1;
        return `x${s.nextAutoId}`;
      }, Object.keys(s.stage.styles));
      for await (const event of brain.respond(request, turn.abort.signal)) {
        // What the brain was told and what the turn cost are recorded even when the turn was cut short; its lines no longer matter.
        if (event.type === 'brief') {
          sessionLog.write(s.id, { type: 'brief', turn: turn.id, form: event.form, text: event.text, system: event.system, withSnapshot: event.withSnapshot });
          continue;
        }
        if (event.type === 'usage') {
          sessionLog.write(s.id, { type: 'usage', turn: turn.id, usage: event.usage });
          log.info('turn.usage', {
            session: s.id,
            turn: turn.id,
            firstTextMs: event.usage.firstTextMs,
            outputTokens: event.usage.outputTokens,
            thinkingTokens: event.usage.thinkingTokens,
            costUsd: event.usage.costUsd,
          });
          continue;
        }
        if (turn.endReason !== null) continue;
        if (event.type === 'reject') {
          this.reject(s, turn, event.raw, event.issues);
          continue;
        }
        if (turn.lineCount >= SERVER_LIMITS.linesPerTurn) {
          this.finish(s, turn, 'failed', `the brain wrote more than ${SERVER_LIMITS.linesPerTurn} lines`);
          break;
        }
        const normalized = normalizer.normalize(event.line);
        if (normalized.line === null) {
          this.reject(s, turn, serializeLine(event.line), [...event.issues, ...normalized.issues]);
          continue;
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
        sessionLog.write(s.id, { type: 'line', turn: turn.id, seq, text, start, issues });
        this.emit(s, turn, { type: 'line', turn: turn.id, seq, text, issues });
        if (line.verb === 'paint') this.paint(s, turn, seq, line, pushed.schedule);
      }
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

  private reject(s: Session, turn: ActiveTurn, raw: string, issues: readonly Issue[]): void {
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

function concerns(event: BackEvent, turn: string): boolean {
  switch (event.type) {
    case 'ready':
      return true;
    case 'tap':
    case 'control':
      return event.turn === null || event.turn === turn;
    case 'report':
      return event.report.turn === turn;
    case 'started':
    case 'progress':
    case 'draft':
      return event.turn === turn;
  }
}
