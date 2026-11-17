import { API, SKILL_HOLD, CANVAS, DATA_LIMITS, EMPTY_STAGE, isLessonVerb, PASTE_AS_DOCUMENT_CHARS, FULL_CAPABILITIES, LANGUAGE, LEAD_WINDOW, LineNormalizer, LineReader, PRESENCE_TYPING_MS, parseLine, TurnScore, buildSystemPrompt, draftFactsOf, hasLesson, usesParts, repairWorth, serializeLine, settle, splitCells, wearingAt, withoutUnknownBraces, worthALook } from '@conduit/language';
import type { DrawLine, OwedFinding, PageFacts, RepairWorth, StyleProps, SkillBlockFacts, TechniqueCard } from '@conduit/language';
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
  Line,
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
import { asksForPicture } from './techniques';
import type { Logger } from '../log';
import { ASSET_LIMITS } from './assets';
import type { AssetStore } from './assets';
import type { Brain, BrainEvent, BrainRegistry, Snapshot } from './brain';
import { DOCUMENT_LIMITS, findUrls, hostOf } from './documents';
import type { DocumentReader } from './documents';
import type { ImageModel } from './images';
import { Cast, captionId, captionLines, dropCaption, planDraw, planSwap } from '../art/draw';
import type { Wanting } from '../art/draw';
import { noteArt } from '../art/notes';
import { bestPart, relabel, resolveNear } from '../art/parts';
import type { Shelf } from '../art/shelf';
import { commissionOf } from '../art/studio';
import type { Studio, StudioEvent } from '../art/studio';
import type { Sheet } from '../art/sheet';
import { creditLine } from './pictures';
import type { PictureService } from './pictures';
import type { HeldDocument } from './documents';
import { NO_DOCUMENTS, seedBook } from './document';
import { NO_AHEAD, createAhead, fillPrompt, refusalBrief } from './ahead';
import type { Ahead, AheadHost, AheadPolicy, AheadStatus, FillJob, FillOutcome } from './ahead';
import type { LessonCheckResult } from '../judge/lesson';
import { NO_THROTTLE } from '../usage';
import type { DocChange, Documents, LoadedDocument } from './document';
import type { DocumentAssets } from '../documents/assets';
import { cropJpeg } from '../pictures/image';
import { rebuildMemory } from './drawing-memory';
import { buildContext, holdStanding, oweFindings, owedToTell, parseStanding, rememberTurn } from './memory';
import type { StandingAsk } from './memory';
import { MAX_PROBLEMS, SERVER_LIMITS } from './session';

import type { SessionEntry, SessionLog, SessionRecord } from './session-log';
import type { ActiveTurn, Session, SessionStore, StageSink } from './session';
import { readPasted } from '../reading/pasted';
import { factsOf, tableFromText } from './tables';
import { worthQueuing } from './critic';
import type { Critic, FindingQueue } from './critic';
import { DETAIL_MAX, redactSecrets, splitTool } from './agent';
import { NO_AUDIT } from '../audit';
import type { Audit, AuditDecider } from '../audit';
import { NO_UPLOADS } from './uploads';
import { NO_VOICE } from './voice';
import type { VoiceNotes } from './voice';
import type { StoredUpload, UploadStore } from './uploads';
import type { UsageMeter } from '../usage';
import { currentIdentity, labelOf } from '../identity';
import { processEnvironment } from '../env';
import { askedOf, refusalProblem, repairTurn, reviewTurn } from './review';
import type { RepairOutcome } from './review';
import { quoted } from '@conduit/language';
import { briefEyes, itemObservation, observeInput } from './observations';
import type { NewObservation } from './observations';
import { ENGINE_VERSION, engineMismatch, measurable, measureDraft, tryFix } from './stage-facts';
import type { FixAttempt } from './review';
import type { CanvasService } from '../canvas/api';
import type { Briefed } from './observations';
import type { TechniqueLibrary } from './techniques';
import type { SkillCatalogue } from '../skills/catalogue';
import { readSkillBlock, SKILL_CUTS } from '../skills/text';

/** How many dead binds a turn's end tells the brain of: the first few say what it needs to know, a dozen would bury the rest of its brief. */
const MAX_DEAD_BINDS = 3;

export interface ConductorDeps {
  readonly sessions: SessionStore;
  readonly brains: BrainRegistry;
  readonly log: Logger;
  readonly assets: AssetStore;
  readonly sessionLog: SessionLog;
  readonly images: ImageModel;
  /** v2.2. Photographs for the `image` parts of a mock-up; absent or unavailable: the placeholder stands */
  readonly pictures?: PictureService;
  /** v3 art. The shelf of finished drawings `draw` is answered from. Absent: every `draw` is a quiet placeholder. */
  readonly art?: Shelf;
  /** v3 art. Draws what the shelf lacks, off the answer's clock. Absent or off: a miss stays a placeholder. */
  readonly studio?: Studio;
  /** fetches the links a prompt contains */
  readonly reader: DocumentReader;
  /** what a brain is told about how its last answer landed */
  readonly sight: 'report' | 'snapshot';
  /** how the system prompt teaches a diagram */
  readonly variant: PromptVariant;
  /** the techniques a turn's brief may carry; answers from memory and never waits */
  readonly library: TechniqueLibrary;
  /** SK1. The owner's skills, read only: a turn that holds one has its text read fresh and put in the brief. Absent: no skill can be held. */
  readonly skills?: SkillCatalogue;
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
  /** The brain may go on by its own choice (`refine | what next`): the server runs it again at once, for as long as it keeps writing that (`REFINE`). Absent: off. */
  readonly continuation?: boolean;
  /** v2.1. A finding with a coherence below this is queued for the loop as evidence (`CriticPolicy.queueBelow`) */
  readonly criticQueueBelow: number;
  /** v2.1. The kinds of mind a session may choose (`Env.modes`); `plain` is always there */
  readonly modes: readonly BrainMode[];
  /** v2.1 ops. The audit trail: every tool call, permission asked and answered, setting changed and connector used. Absent: nothing is written. */
  readonly audit?: Audit;
  /** v2.1. The user's photos, kept in the data folder. Absent: no photo can be given. */
  readonly uploads?: UploadStore;
  /** v2.1. The user's voice notes, read on this Mac. Absent: no voice note can be given. */
  readonly voice?: VoiceNotes;
  /** v2.1 ops. The usage meter: every brain turn and review pass is written to it; its throttle only ever warns the owner, never refuses a turn. */
  readonly usage?: UsageMeter;
  /** v3. The document each conversation makes: a fold over its session log (PLAN-v3-core 2.11). Absent: no conversation has one. */
  readonly documents?: Documents;
  /** v3. What a document keeps beside its words: the cut of the photo each question sits on */
  readonly docAssets?: DocumentAssets;
  /**
   * v3 (WS5). Fill ahead and verify: the parts of a document that are named and not written are written in the background, and each is
   * checked before it is offered. Absent: nothing is written ahead. `check` is the second, cheap model check (`judge/lesson.ts`).
   */
  readonly ahead?: { readonly policy: AheadPolicy; readonly check: (session: string, pages: readonly { readonly id: string; readonly text: string }[], signal: AbortSignal) => Promise<LessonCheckResult> };
  /** SA4. The canvas tools: told when a turn opens and ends, and when the model's call has been seen on its stream. Absent: the brain has none. */
  readonly canvas?: CanvasService;
  /** SA4. True when the brain's own process is given the canvas tools (the digest then points at them, and the brief says they exist) */
  readonly canvasTools?: boolean;
  /** milliseconds; injected so nothing in the domain reads the wall clock directly */
  readonly now: () => number;
}

export interface EventsPage {
  readonly events: readonly BackEventRecord[];
  readonly cursor: number;
}

const REAP_INTERVAL_MS = 60_000;

/** The least time between two `typing` events of a turn: about 20 a second. */
const TYPING_EVERY_MS = 50;
/** More than a line of Series is ever this long; the pane has no use for the rest of a runaway one. */
const TYPING_MAX_CHARS = 600;

/** The throttle of one turn's `typing` events: the latest text waits for its turn to be sent, and a line, a reject or the end drops it. */
interface TypingState {
  at: number;
  text: string | null;
  timer: NodeJS.Timeout | null;
}

/** Stage events that describe a moment and are not part of the turn's score: a reconnecting painter is not given the ones it heard. */
const TRANSIENT: ReadonlySet<StageEvent['type']> = new Set(['pass', 'data', 'candidate', 'permission', 'activity', 'critic', 'want', 'typing', 'mend']);

/**
 * A line of the lesson the reader would not take, with why, for the brain to write again; null when the refusal is no lesson line's (a
 * stage line that did not parse is the look's business) or only a warning.
 */
function refusalOf(raw: string, issues: readonly Issue[]): { readonly raw: string; readonly why: string } | null {
  const verb = raw.trim().split(/\s+/)[0] ?? '';
  if (!isLessonVerb(verb) || verb === 'reply' || verb === 'end') return null;
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length === 0) return null;
  return { raw: raw.replace(/\s+/g, ' ').trim().slice(0, 160), why: errors.map((issue) => issue.message).join('; ') };
}


/** v3 art. A placeholder waiting for its drawing. */
interface PendingArt {
  readonly wanting: Wanting;
  /** the newest sheet made and not yet shown */
  next: Sheet | null;
  /** `next` is the finished drawing, not a stage of it */
  final: boolean;
  /** the ids of the parts on stage, once a sheet has been shown (null: the placeholder still stands) */
  shown: readonly string[] | null;
  delivering: boolean;
  /** labels the brain wrote for parts (`near=<figure>-<word>`) while only the placeholder stood: held, as the lines they are, until the parts are there (or the drawing will not come) */
  readonly labels: Line[];
  /** nothing more will be shown: it failed, was shown in full, or its figure was said again */
  over: boolean;
}

/** v3 art. How long a made drawing waits for the person to stop typing and the answer to come to rest before it is left on the shelf for next time. */
const ART_PATIENCE_MS = 120_000;

/**
 * Runs conversations. It owns the two one-way streams: lines flow from a
 * brain to the painter, and the painter's back channel flows in. HTTP routes
 * translate requests into calls on this class and never touch a brain.
 */
/** What the page measured with, as the session log keeps it: whole when it is small, with the oldest playheads cut when it is not, so that a drift can be worked again from the log alone. */
function loggedFacts(facts: PageFacts): PageFacts {
  const text = JSON.stringify(facts);
  if (text.length <= 8000) return facts;
  return { ...facts, floors: facts.floors.slice(-120), asks: { runs: facts.asks.runs.slice(-8).map(([key, run]) => [key.slice(0, 200), run] as const), latest: facts.asks.latest.slice(-16).map(([id, key]) => [id, key.slice(0, 200)] as const) } };
}

export class Conductor {
  private readonly deps: ConductorDeps;
  /** v3 art. One casting of characters a conversation: the fox it drew stays the fox until the brain says `new`. */
  private readonly casts = new WeakMap<Session, Cast>();
  /** v3 art. The drawings a session is waiting for, by figure id: each stands in a placeholder until its sheet is made and it is safe to swap it in. */
  private readonly drawings = new WeakMap<Session, Map<string, PendingArt>>();
  /** v3 art. The turns that put a made drawing in place: they are said to the page as any in-place turn, but are not "tidying" */
  private readonly artTurns = new WeakSet<ActiveTurn>();
  /** v3 art. The figures a session has drawn, by id, and the ids of their parts: `near=<figure>-<word>` is settled against these. */
  private readonly figures = new WeakMap<Session, Map<string, readonly string[]>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** The technique cards that wrote a session's document (a lesson for a young learner, a recipe): they ride on every later turn of it, so the part written ahead, and the answer to a tap, are written by the same rules. */
  private readonly documentCards = new Map<string, readonly TechniqueCard[]>();
  /** The shape (width over height) of each photo a session has named, by upload id: stamped on its `pic` and told in the brief. */
  private readonly photoShapes = new Map<string, Record<string, number>>();
  private readonly reaper: NodeJS.Timeout;
  /** the file each draft's picture was saved under, for the `fix` record; forgotten with the turn's session */
  private readonly draftFiles = new Map<string, string>();
  /** v3 (WS5). Fill ahead and verify; `NO_AHEAD` when off */
  private readonly ahead: Ahead;
  /** v3 (WS5). The quiet processes in use, by the id the brain knows them as (`<session>~ahead0`), and the ones already set to the conversation's model */
  private readonly quietBusy = new Set<string>();
  private readonly quietSet = new Set<string>();
  private quietCount = 0;
  /** SA4. The attention record of each open turn, written when the turn ends with what the canvas tools were used for */
  private readonly attention = new Map<string, Briefed['record']>();
  /** SA4. Pictures asked of the page (`want`) and not yet answered, by request id */
  private readonly looks = new Map<string, { readonly session: string; readonly resolve: (snapshot: Snapshot | null) => void; readonly timer: NodeJS.Timeout }>();
  private lookCounter = 0;

  constructor(deps: ConductorDeps) {
    this.deps = deps;
    deps.sessions.onDrop = (session) => this.release(session, 'session.evicted');
    this.reaper = setInterval(() => {
      for (const session of deps.sessions.reap(deps.now())) this.release(session, 'session.reaped');
    }, REAP_INTERVAL_MS);
    this.reaper.unref();
    this.ahead = deps.ahead === undefined || !deps.ahead.policy.enabled ? NO_AHEAD : createAhead(this.aheadHost(deps.ahead.check), deps.ahead.policy);
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
    if (change !== null && change.nodes.length > 0) this.cutCrops(s, change);
    if (change !== null && change.nodes.length > 0) {
      const turnId = 'turn' in entry ? entry.turn : null;
      const turn = turnId === null ? null : (s.turns.get(turnId) ?? null);
      if (turn !== null) turn.docEvents += 1;
      this.emit(s, turn, { type: 'doc', turn: turnId, document: change.document, title: change.title, root: change.root, nodes: change.nodes });
    }
    // Something that decides what is waiting moved: a turn ended, a session began (or opened a document again), the person went somewhere.
    if (entry.type === 'end' || entry.type === 'session' || (entry.type === 'state' && change?.applied === true)) this.ahead.wake(s.id);
    return change;
  }

  /** The questions already cut (or being cut) for a document, by the rectangle: a question named again with the same box is not cut twice. */
  private readonly cuts = new Set<string>();

  /**
   * v3. A question that sits on a photo (`crop=`) has its part of the photo cut by the server, from the session's own photo, and kept with the
   * DOCUMENT (`docAssets`), so another browser or device that opens the document sees it. Off the turn's clock: a cut that fails is logged and the
   * page cuts it for itself from the photo while the session lasts.
   */
  private cutCrops(s: Session, change: DocChange): void {
    const assets = this.deps.docAssets;
    const uploads = this.deps.uploads;
    if (assets === undefined || uploads === undefined || !uploads.available) return;
    for (const node of change.nodes) {
      const crop = node.crop;
      if (crop === undefined) continue;
      const key = `${change.document}|${node.id}|${crop.x},${crop.y},${crop.w},${crop.h}|${crop.from ?? ''}`;
      if (this.cuts.has(key)) continue;
      this.cuts.add(key);
      void (async () => {
        const photo = await uploads.load(s.id, crop.from ?? 'u1');
        if (photo === null) {
          this.cuts.delete(key);
          return;
        }
        const jpeg = await cropJpeg(photo.bytes, { x: crop.x / 100, y: crop.y / 100, w: crop.w / 100, h: crop.h / 100 });
        await assets.putCrop(change.document, node.id, jpeg);
        this.deps.log.info('document.crop_cut', { session: s.id, document: change.document, node: node.id, bytes: jpeg.byteLength });
      })().catch((error: unknown) => {
        this.cuts.delete(key);
        this.deps.log.warn('document.crop_failed', { session: s.id, node: node.id, error });
      });
    }
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
  /**
   * SK1. The skills the person held for this message, read fresh from disk and made into blocks for the brief. Reading only: nothing in a
   * skill is run. A skill that cannot be given (off, moved, shaped like a key) is left out and the person is told in a line on the stage's
   * status, once. The audit says that a skill was read, which, who picked it and how big; never its text.
   */
  private async skillsFor(s: Session, turn: ActiveTurn): Promise<SkillBlockFacts[]> {
    const catalogue = this.deps.skills;
    if (catalogue === undefined || turn.input.kind !== 'prompt' || (turn.input.skills?.length ?? 0) === 0) return [];
    const { log } = this.deps;
    await catalogue.list();
    const wanted = [...new Set(turn.input.skills ?? [])].slice(0, SKILL_HOLD.held);
    const limit = wanted.length > 1 ? Math.floor(SKILL_CUTS.two / wanted.length) : SKILL_CUTS.one;
    const blocks: SkillBlockFacts[] = [];
    for (const ref of wanted) {
      const entry = catalogue.find(ref);
      if (entry === null || entry.state !== 'on') {
        const why = entry === null ? 'it is not in the list' : (entry.note ?? 'it cannot be used');
        log.info('skill.refused', { session: s.id, turn: turn.id, why: entry === null ? 'unknown' : entry.state });
        this.auditTurn(s, turn, { kind: 'connector', tool: 'skill', target: entry === null ? 'unknown skill' : `${entry.source}:${entry.name}`, decision: 'denied', decidedBy: 'policy', note: why });
        this.emit(s, turn, { type: 'reading', turn: turn.id, label: `your ${entry?.name ?? 'skill'} skill`, state: 'failed', message: `not used: ${why}` });
        continue;
      }
      const label = `your ${entry.name} skill (reading only)`;
      this.emit(s, turn, { type: 'reading', turn: turn.id, label, state: 'start', message: null });
      const read = await readSkillBlock(entry, turn.input.text, limit);
      if (!read.ok) {
        log.info('skill.refused', { session: s.id, turn: turn.id, why: 'unreadable' });
        this.auditTurn(s, turn, { kind: 'connector', tool: 'skill', target: `${entry.source}:${entry.name}`, decision: 'failed', decidedBy: 'policy', note: read.why });
        this.emit(s, turn, { type: 'reading', turn: turn.id, label: `your ${entry.name} skill`, state: 'failed', message: `not used: ${read.why}` });
        continue;
      }
      this.auditTurn(s, turn, { kind: 'connector', tool: 'skill', target: `${entry.source}:${entry.name}`, decision: 'allowed', decidedBy: 'owner', note: `read for this message (reading only); ${read.block.chars} characters${read.block.left.length > 0 ? ', cut at a heading' : ''}; files ${entry.hash}; picked by the person` });
      log.info('skill.used', { session: s.id, turn: turn.id, skill: `${entry.source}:${entry.name}`, chars: read.block.chars, cut: read.block.left.length > 0 });
      this.emit(s, turn, { type: 'reading', turn: turn.id, label, state: 'done', message: null });
      blocks.push({ id: read.block.id, name: read.block.name, hash: read.block.hash, text: read.block.text });
    }
    return blocks;
  }

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
      // the brain may go on by its own choice: it needs a brain that is asked again in its own conversation
      ...(this.deps.continuation === true ? { refine: true } : {}),
      ...(this.deps.uploads?.available === true ? { uploads: true } : {}),
      ...(this.deps.art === undefined ? {} : { art: true }),
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
      ...(resume === null ? {} : { resumes: resume.id }),
    });
    log.info('session.created', { session: session.id, cols: request.screen.cols, rows: request.screen.rows });
    return { session: session.id, lead: LEAD_WINDOW };
  }

  /**
   * The page's own session, still empty, takes up an older conversation: its log goes on in that conversation's file, its turn ids start
   * above that log's, and the brain's first brief carries `earlier` (a short account of the words, never the system prompt or a brief).
   * A session that has begun a conversation of its own cannot: that one would be torn in two. Asking again for the same one is a no-op.
   */
  continueConversation(session: string, id: string, earlier: string, highestTurn: number, highestPhoto: number, firstSession: string, records: readonly SessionRecord[] = []): void {
    const { sessions, now, sessionLog } = this.deps;
    const s = sessions.require(session, now());
    if (s.continued?.id === id) return;
    if (s.continued !== null || s.turn !== null || s.history.length > 0) throw errors.conflict('this page already has a conversation going; open the older one on a fresh page to continue it');
    sessionLog.adopt(s.id, id);
    sessions.reserveTurns(highestTurn);
    this.deps.uploads?.reserve(s.id, highestPhoto);
    s.continued = { id, earlier };
    // the drawings of that conversation are kept in its log: the memory is read from there, so a drawing can be brought back after a restart
    s.memory = rebuildMemory(records);
    sessionLog.write(s.id, { type: 'continued', session: s.id, from: firstSession, started: new Date(now()).toISOString() });
    this.deps.log.info('session.continued', { session: s.id, conversation: id });
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

    // v3. A new prompt (or tap) cancels a repair that is waiting or running: the person has moved on and the answer it would mend is no longer the one on stage.
    s.repair?.abort.abort();
    // a message from the person (or anything else that opens a turn) takes over from a continuation that is waiting
    s.continuing?.abort.abort();
    s.continuing = null;
    const previous = s.turn;
    // T1 (b). A bare prompt (words only: no photo, ink or voice) sent while a turn is writing a document does not cancel the write: it is refused with a plain note and
    // stays in the box. A person who means to stop it presses Stop; a prompt that carries something (a photo, ink, a voice note) or a tap still replaces the open turn.
    if (previous !== null && previous.endReason === null && !previous.reported && previous.input.kind === 'prompt' && input.kind === 'prompt' && (input.images?.length ?? 0) === 0 && input.marks === undefined && (input.voice?.length ?? 0) === 0 && this.docs.viewOfSession(s.id) !== null) {
      throw errors.conflict('Still writing this. It will be there in a moment (or press Stop).');
    }
    if (previous !== null && !previous.reported) {
      if (previous.endReason === null) {
        log.info('turn.interrupted', { session: s.id, turn: previous.id, by: 'next-turn' });
        this.finish(s, previous, 'interrupted', null);
      }
      s.draft.close(previous.id);
      this.closeMemoryWithoutReport(s, previous);
    }

    // The photos a prompt names are this conversation's own, or the turn does not open.
    // The picture of the ink (and the photo it was drawn over) are held the same way.
    if (input.kind === 'prompt' && ((input.images?.length ?? 0) > 0 || input.marks !== undefined)) {
      const held = this.deps.uploads ?? NO_UPLOADS;
      if (!held.available) throw errors.badRequest('photos are switched off on this server');
      const named = [...(input.images ?? []), ...(input.marks === undefined ? [] : [input.marks.image, ...(input.marks.background === undefined ? [] : [input.marks.background]), ...(input.marks.voice?.audio === undefined ? [] : [input.marks.voice.audio])])];
      const missing = named.find((id) => !held.has(s.id, id));
      if (missing !== undefined) throw errors.badRequest(`this conversation has no photo ${missing}`);
    }

    if (input.kind === 'tap' || input.kind === 'act') this.adoptSeen(s, previous?.id ?? null, input.seen);
    // Likewise the voice notes: this conversation's own, or the turn does not open.
    if (input.kind === 'prompt' && (input.voice?.length ?? 0) > 0) {
      const notes = this.deps.voice ?? NO_VOICE;
      if (!notes.available) throw errors.badRequest('voice notes are switched off on this server');
      const missing = (input.voice ?? []).find((id) => !notes.has(s.id, id));
      if (missing !== undefined) throw errors.badRequest(`this conversation has no voice note ${missing}`);
    }

    const brain = brains.forInput(input);
    // A process is started for the first thing the user says, not for a page that only looks (the gallery, the explorer).
    if (brain === brains.configured && (input.kind === 'prompt' || input.kind === 'tap' || input.kind === 'act')) this.prepareBrain(s);
    // SA3. What the person did becomes observations, and the brain is given the digest of what has been seen since it last wrote.
    const before = s.obs.all().length === 0 ? 0 : (s.obs.all()[s.obs.all().length - 1]?.seq ?? 0);
    // SA2. A differing digest costs the turn it was found in, not the conversation: the next turn is measured here again. And a new question
    // clears what a hand left on the controls of an earlier answer (the page does the same), so a stale value is not measured into this one.
    if (s.drift !== null && s.driftTurn !== null) {
      s.drift = null;
      s.driftTurn = null;
    }
    if (input.kind === 'prompt' || input.kind === 'script') s.held = {};
    observeInput(s, input, now());
    for (const made of s.obs.all().filter((one) => one.seq > before)) this.deps.sessionLog.write(s.id, { type: 'obs', turn: null, obs: made });
    const tools = this.deps.canvasTools === true && brain === brains.configured;
    const briefed = briefEyes(s, tools);
    const owed = this.owedFor(s);
    const context = { ...buildContext(s, this.servicesFor(s.capabilities, s.id)), ...(briefed.eyes === null ? {} : { eyes: briefed.eyes }), ...(tools ? { canvas: true } : {}), ...(owed.length === 0 ? {} : { owed }) };
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
      facts: null,
      docLines: 0,
      docEvents: 0,
      held: new Map(),
      rejects: 0,
      lookAllowed: options.look !== false,
      review: undefined,
      reported: false,
      sent: [],
      missed: [],
      snapshotFile: null,
      criticAsked: false,
      refused: [],
      amended: false,
      calls: new Map(),
      endedAt: null,
    };
    s.nextOrdinal += 1;
    s.heardFrom = s.nextCursor - 1;
    s.turn = turn;
    sessions.indexTurn(s, turn);
    log.info('turn.opened', { session: s.id, turn: turn.id, brain: brain.id, input: turn.input.kind, login: turn.login });
    const chosen = brain.choice?.(s.id);
    this.journal(s, { type: 'turn', turn: turn.id, input, brain: brain.id, login: turn.login, ...(chosen?.model ? { model: chosen.model } : {}), ...(chosen?.effort ? { effort: chosen.effort } : {}) });
    // The attention record is written when the turn ends, with what the canvas tools were used for (`finish`).
    s.memory.begin(turn.id, input.kind === 'prompt' || input.kind === 'tap' || input.kind === 'act' ? input.text : input.kind === 'script' ? 'a script' : input.kind === 'refine' ? input.note : input.kind);
    this.attention.set(turn.id, briefed.record);
    this.deps.canvas?.beginTurn(s.id, turn.id, briefed.record.rev[0]);
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
      // `presence` is the server's own business (typing, the repair switch); it is no part of what a relay agent reads
      if (event.type !== 'presence') this.record(s, event);
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

  /**
   * SA4. The brain asked for a picture of the stage as it stands (`canvas_look`): the page is asked with a `want` event and answers by uploading
   * to `API.look`. Null when nobody is listening, or nothing came within `deadlineMs`.
   */
  wantPicture(s: Session, target: string | null, deadlineMs: number): Promise<Snapshot | null> {
    const turn = s.turn;
    if (s.sink === null || turn === null || turn.reported) return Promise.resolve(null);
    this.lookCounter += 1;
    const request = `l${this.lookCounter}`;
    const asked = this.deps.now();
    return new Promise<Snapshot | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.settleLook(request, null)) this.deps.log.info('canvas.picture', { session: s.id, turn: turn.id, request, outcome: 'none in time', ms: this.deps.now() - asked });
      }, deadlineMs);
      timer.unref();
      this.looks.set(request, { session: s.id, resolve: (snapshot) => { if (snapshot !== null) this.deps.log.info('canvas.picture', { session: s.id, turn: turn.id, request, outcome: 'arrived', bytes: snapshot.bytes.byteLength, width: snapshot.width, height: snapshot.height, ms: this.deps.now() - asked }); resolve(snapshot); }, timer });
      this.emit(s, turn, { type: 'want', turn: turn.id, request, what: 'picture', target, deadlineMs });
    });
  }

  private settleLook(request: string, snapshot: Snapshot | null): boolean {
    const held = this.looks.get(request);
    if (held === undefined) return false;
    this.looks.delete(request);
    clearTimeout(held.timer);
    held.resolve(snapshot);
    return true;
  }

  /** SA4. The page's answer to a `want`. A request that is unknown, answered or another conversation's is ignored. */
  receiveLook(session: string, request: string, snapshot: Snapshot): void {
    this.deps.sessions.require(session, this.deps.now());
    if (this.looks.get(request)?.session !== session) return;
    this.settleLook(request, snapshot);
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
    this.deps.log.info('session.brain_set', { session, model: choice.model, effort: choice.effort, mode: choice.mode, permits: choice.permits });
    const write = (name: string, value: string | undefined): void => {
      if (value === undefined) return;
      this.deps.sessionLog.write(session, { type: 'setting', name, value });
      this.audit.record({ kind: 'setting', session, tool: name, target: value, decision: 'allowed', decidedBy: 'owner' });
    };
    write('model', change.model);
    write('effort', change.effort);
    write('mode', change.mode);
    write('permits', change.permits);
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
        this.ahead.release(s.id);
        s.repair?.abort.abort();
        s.continuing?.abort.abort();
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
    this.ahead.close();
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
    this.deps.canvas?.forget(session.id);
    for (const [request, held] of [...this.looks]) if (held.session === session.id) this.settleLook(request, null);
    this.deps.assets.drop(session.id);
    this.ahead.release(session.id);
    for (const slot of [...this.quietSet].filter((id) => id.startsWith(`${session.id}~ahead`))) {
      this.deps.brains.configured.release?.(slot);
      this.quietSet.delete(slot);
    }
    this.docs.release(session.id);
    this.documentCards.delete(session.id);
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

  private readonly typingOf = new WeakMap<ActiveTurn, TypingState>();

  /** The line being written, for the pane that shows the language: throttled, sent to a stream that is open now, and kept nowhere. */
  private typing(session: Session, turn: ActiveTurn, text: string): void {
    if (session.sink === null) return;
    const state = this.typingOf.get(turn) ?? { at: 0, text: null, timer: null };
    this.typingOf.set(turn, state);
    state.text = text.length > TYPING_MAX_CHARS ? text.slice(-TYPING_MAX_CHARS) : text;
    if (state.timer !== null) return;
    const send = (): void => {
      state.timer = null;
      if (state.text === null) return;
      const body = state.text;
      state.text = null;
      state.at = this.deps.now();
      try {
        session.sink?.({ type: 'typing', turn: turn.id, text: body });
      } catch (error) {
        this.deps.log.warn('stream.sink_failed', { session: session.id, error });
      }
    };
    const wait = state.at + TYPING_EVERY_MS - this.deps.now();
    if (wait <= 0) send();
    else {
      state.timer = setTimeout(send, wait);
      state.timer.unref();
    }
  }

  /** A line was finished (or the turn is over): what was waiting to be typed is no longer true. */
  private typingDone(turn: ActiveTurn): void {
    const state = this.typingOf.get(turn);
    if (state === undefined) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.text = null;
  }

  private emit(session: Session, turn: ActiveTurn | null, event: StageEvent): void {
    if (event.type === 'line' || event.type === 'reject' || event.type === 'end') if (turn !== null) this.typingDone(turn);
    if (turn !== null) {
      if (event.type === 'reject' && turn.sent.length >= SERVER_LIMITS.linesPerTurn * 2) return;
      // A candidate and a confirm control are answered or gone within seconds: a painter that was not there to hear them cannot use them.
      if (event.type !== 'candidate' && event.type !== 'permission' && event.type !== 'typing') {
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
        this.journal(s, { type: 'report', turn: report.turn, report, ...(event.facts === undefined ? {} : { facts: loggedFacts(event.facts) }) });
        if (turn !== undefined && event.facts !== undefined) turn.facts = event.facts;
        if (event.boxes !== undefined && turn !== undefined && turn.input.kind === 'prompt' && report.outcome === 'finished' && report.skippedAt === null && this.measuresHere(s) && measurable(turn.score.schedule)) {
          // How the turn rested, as the page measured it, against the server's own measure of the same score. Only for a typed prompt: a turn
          // that carries on from the viewer's own doing (a mock-up's fields, a pressed button) rests on state only the page holds.
          // The server measures with what the page measured with (its floors, asks, target, screen and controls); a page that sends none is measured as before.
          const rested = measureDraft(turn.score, { ...s, held: report.controls ?? s.held }, event.facts);
          if (rested !== null) {
            this.noteBoxes(s, `${turn.id}#report`, 'server', rested.boxes, 'report', turn.id);
            this.noteBoxes(s, `${turn.id}#report`, 'page', event.boxes, 'report', turn.id);
          }
        }

        if (turn === undefined || turn.reported) return;
        turn.reported = true;
        if (turn.input.kind === 'repair' && !this.artTurns.has(turn) && report.outcome === 'finished') {
          this.deps.sessionLog.write(s.id, { type: 'pass', turn: turn.id, pass: 2, state: 'repaired', reason: null });
          this.emit(s, turn, { type: 'pass', turn: turn.id, pass: 2, state: 'repaired', reason: null });
        }
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
        this.observe(s, event.turn, { source: 'person', kind: 'tap', on: event.id, note: `you tapped ${quoted(event.text, 60)}` });
        return;
      case 'observe': {
        // One event a second. What is blocking (an app that threw, or drew nothing) is never lost to that: the page itself sends at most three crashes and one blank an app.
        const open = s.obs.allowObserve(this.deps.now());
        const items = open ? event.items : event.items.filter((item) => item.severity === 'blocking');
        if (items.length === 0) {
          this.deps.log.debug('observe.dropped', { session: s.id, items: event.items.length });
          return;
        }
        for (const item of items) this.observe(s, s.turn?.id ?? null, itemObservation(item));
        return;
      }
      case 'control':
        if (event.ask === true) {
          // HI1. A try, a hint or a giving up on an ask of the stage: one `did` line for the ask, grown by each act, so the digest holds a line and not a stream.
          const more = event.text.replace(/\s+/g, ' ').trim();
          const grown = s.obs.extend('did', event.id, more, this.deps.now());
          if (grown !== null) this.deps.sessionLog.write(s.id, { type: 'obs', turn: event.turn, obs: grown });
          else this.observe(s, event.turn, { source: 'person', kind: 'did', on: event.id, note: `ask ${event.id}: ${more}` });
          this.deps.sessionLog.write(s.id, { type: 'control', turn: event.turn, id: event.id, value: event.value, text: event.text, send: event.send, ask: true });
          this.adoptSeen(s, event.turn, event.seen);
          return;
        }
        s.held = { ...s.held, [event.id]: event.value };
        this.observe(s, event.turn, { source: 'person', kind: 'state', on: event.id, note: `you ${event.app === true ? 'did in the app' : 'set'} ${event.id}: ${quoted(event.text, 60)}` });
        this.deps.sessionLog.write(s.id, { type: 'control', turn: event.turn, id: event.id, value: event.value, text: event.text, send: event.send, ...(event.app === true && { app: true }) });
        this.adoptSeen(s, event.turn, event.seen);
        return;
      case 'state':
        // The person did something the page committed: logged if it changed anything, and what it moved is in the next brief.
        this.journal(s, { type: 'state', turn: event.turn, change: event.change });
        return;
      case 'draft':
        // How the draft will land: what look and fix is waiting on. The picture, when there is one, arrives by upload.
        s.draft.receive(event.turn, event.pass, event.sight, event.placed ?? [], event.snapshot, event.content);
        if (event.facts !== undefined) {
          const drafted = s.turns.get(event.turn);
          if (drafted !== undefined) drafted.facts = event.facts;
          const held = s.boxes.get(`${event.turn}#${event.pass}`) ?? {};
          held.facts = event.facts;
          s.boxes.set(`${event.turn}#${event.pass}`, held);
        }
        if (event.boxes !== undefined) this.noteBoxes(s, `${event.turn}#${event.pass}`, 'page', event.boxes, 'draft', event.turn);
        this.deps.sessionLog.write(s.id, { type: 'draft', turn: event.turn, pass: event.pass, noted: event.sight.items.filter((item) => item.notes.length > 0).length, picture: event.snapshot, file: null, ...(event.facts === undefined ? {} : { facts: loggedFacts(event.facts) }) });
        return;
      case 'presence':
        // A `typing` that is not renewed lapses: a lost "stopped typing" never holds a repair back for long.
        s.typingUntil = event.typing ? this.deps.now() + PRESENCE_TYPING_MS : 0;
        // `/stop` and the Stop button: the brain's own continuation runs between turns, where the painter has nothing open to interrupt
        if (event.stop === true) {
          s.continuing?.abort.abort();
          s.continuing = null;
        }
        if (s.repairOn !== event.repair) {
          s.repairOn = event.repair;
          this.deps.sessionLog.write(s.id, { type: 'setting', name: 'repair', value: event.repair ? 'on' : 'off' });
          if (!event.repair) s.repair?.abort.abort();
        }
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
    turn.endedAt = this.deps.now();
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
    step('braces', () => this.noteUndeclaredBraces(turn));
    step('binds', () => this.noteDeadBinds(s, turn));
    step('held', () => {
      for (const waiting of turn.held.values()) for (const held of waiting) this.reject(s, turn, serializeLine((held.event as { line: Line }).line), held.issues as Issue[]);
      turn.held.clear();
    });
    step('draft', () => s.draft.close(turn.id));
    step('memory', () => s.memory.close());
    // Nothing the owner was asked and did not answer outlives the turn: it is a no.
    step('permissions', () => this.denyPending(s, turn.id, 'turn'));
    // A call that began under the gate's own yes and had not ended when the turn did is still a call that was made.
    step('audit', () => {
      for (const call of turn.calls.values()) if (!call.asked) this.recordCall(s, turn, call.tool, call.summary, 'allowed', 'policy', `still running when the turn ended (${reason})`);
      turn.calls.clear();
    });
    step('attention', () => {
      const held = this.attention.get(turn.id);
      this.attention.delete(turn.id);
      if (held === undefined) return;
      const used = this.deps.canvas?.endTurn(s.id, turn.id) ?? null;
      this.deps.sessionLog.write(s.id, { type: 'attention', turn: turn.id, ...held, ...(used === null ? {} : { pulled: used.pulled, watch: used.watch, ignore: used.ignore, refusedIgnore: used.refusedIgnore, calls: used.calls, toolMs: used.toolMs }) });
    });
    step('log', () => void this.journal(s, { type: 'end', turn: turn.id, reason, message, lines: turn.lineCount }));
    // A turn that wrote the document again exactly as it was changed no node, so no `doc` event went: the page would show nothing. It is told which document, and the root, so it brings it forward.
    step('reopen', () => {
      if (turn.docLines === 0 || turn.docEvents > 0) return;
      const view = this.docs.viewOfSession(s.id);
      const root = view === null ? undefined : view.document.nodes[view.document.root];
      if (view === null || root === undefined) return;
      turn.docEvents += 1;
      this.emit(s, turn, { type: 'doc', turn: turn.id, document: view.document.id, title: view.document.title, root: view.document.root, nodes: [root] });
    });
    step('emit', () => this.emit(s, turn, { type: 'end', turn: turn.id, reason, message }));
    step('say', () => this.deps.log.info('turn.ended', { session: s.id, turn: turn.id, reason, lines: turn.lineCount, durationMs: this.deps.now() - turn.openedAt }));
    step('wake', () => this.wake(s.id));
    // After `end` has gone, and never waited for.
    step('critic', () => this.lookAtResult(s, turn));
    step('continue', () => this.considerContinue(s, turn));
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
   * Everything a prompt brings for the brain to read or draw from. A pasted table is data and costs nothing to read; the links
   * are fetched at the same time, each announced to the stage and each with its own deadline.
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

    const documents = await this.gatherDocuments(s, turn, brain);
    return { ...documents, data, text: null };
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
      const chosen = turn.input.kind === 'prompt' || turn.input.kind === 'tap' || turn.input.kind === 'act' ? this.deps.library.cardsFor({ input: turn.input, documents: s.documents.length > 0 }) : [];
      // the cards that wrote this session's document keep riding while it is open (a part written ahead says nothing the selector could match)
      const writers = chosen.filter((card) => usesParts([card]));
      if (writers.length > 0) this.documentCards.set(s.id, writers);
      const held = this.documentCards.get(s.id) ?? [];
      const viewNow = this.docs.viewOfSession(s.id);
      // a prompt that asks for a picture, the canvas or one step at a time is a new answer, not another turn of the open document
      const pictured = turn.input.kind === 'prompt' && asksForPicture(turn.input.text);
      const techniques = held.length > 0 && !pictured && !usesParts(chosen) && viewNow !== null && hasLesson({ document: { document: viewNow.document, state: viewNow.state } }) ? [...held, ...chosen].slice(0, 3) : chosen;
      if (techniques.length > 0) {
        log.debug('techniques.chosen', { session: s.id, turn: turn.id, techniques: techniques.map((card) => card.id) });
        sessionLog.write(s.id, { type: 'techniques', turn: turn.id, ids: techniques.map((card) => card.id) });
      }
      const skillBlocks = await this.skillsFor(s, turn);
      if (turn.abort.signal.aborted) return;
      const data: DataFacts[] = s.tables.map((table) => factsOf(table, gathered.data.has(table.id)));
      // The photos this prompt names, as they were kept, after the stage's snapshot. A photo that cannot be read back is left out and said in the log.
      const images: Snapshot[] = [];
      const shapes: Record<string, number> = { ...this.photoShapes.get(s.id) };
      if (turn.input.kind === 'prompt') {
        // The photos, then the picture of the ink last: the brief says it is the one that was written or drawn.
        const named = turn.input.images ?? [];
        for (const id of [...named, ...(turn.input.marks === undefined ? [] : [turn.input.marks.image])]) {
          const loaded = await (this.deps.uploads ?? NO_UPLOADS).load(s.id, id);
          if (loaded === null) log.warn('turn.photo_missing', { session: s.id, turn: turn.id, photo: id });
          else {
            images.push(loaded);
            if (named.includes(id) && loaded.height > 0) shapes[id] = loaded.width / loaded.height;
          }
        }
        this.photoShapes.set(s.id, shapes);
      }
      const documentNow = this.docs.viewOfSession(s.id);
      const context = {
        ...base,
        ...(Object.keys(shapes).length > 0 ? { photos: shapes } : {}),
        documents: s.documents.map((doc): DocumentFacts => ({ ...doc.facts, fresh: fresh.has(doc.facts.id) })),
        unread: gathered.unread,
        techniques,
        ...(skillBlocks.length > 0 ? { skills: skillBlocks } : {}),
        ...(data.length > 0 ? { data } : {}),
        // v3. The document and where the person is in it: WS7's DOCUMENT and HERE blocks are made from these.
        ...(documentNow === null ? {} : { document: { document: documentNow.document, state: documentNow.state } }),
      };
      const pdfs = s.documents.flatMap((doc) => (doc.pdf === null ? [] : [{ id: doc.facts.id, bytes: doc.pdf }]));
      const snapshot = this.deps.sight === 'snapshot' && turn.previous !== null ? (this.deps.assets.snapshot(s.id, turn.previous) ?? null) : null;
      const spoken = turn.input.kind === 'prompt' ? (turn.input.voice ?? []).flatMap((id) => this.deps.voice?.transcript(s.id, id) ?? []) : [];
      const input: TurnInput = gathered.text !== null && turn.input.kind === 'prompt' ? { ...turn.input, text: gathered.text } : turn.input;
      // What was said in a voice note goes to the brain as words too (the transcript, beside the text the user sent); never into the log or the audit trail.
      const withVoice: TurnInput = input.kind === 'prompt' && spoken.length > 0 ? { ...input, spoken } : input;
      if (turn.abort.signal.aborted) return;
      const request = { turn: turn.id, session: s.id, input: withVoice, context, snapshot, pdfs, look: this.deps.review.enabled && turn.lookAllowed, ...(images.length > 0 ? { images } : {}) };
      const normalizer = new LineNormalizer(() => {
        s.nextAutoId += 1;
        return `x${s.nextAutoId}`;
      }, Object.keys(s.stage.styles), { placement: brain.id === 'replay' ? 'free' : 'flow', layout: s.stage.scene.layout, photos: shapes });
      // v3. A turn of a conversation that has a document reads its lines against it: `part q3a in=q3` finds q3, and an ask is read against what is on the page.
      if (documentNow !== null) seedBook(normalizer.lessons, documentNow.document);
      let stopped = false;
      for await (const event of brain.respond(request, turn.abort.signal)) {
        if (this.ingest(s, turn, event, normalizer, 1) === 'stop') {
          stopped = true;
          break;
        }
      }
      if (!stopped) await this.amendTurn(s, turn, brain, normalizer);
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
  /** A maths `problem` on the stage: the page draws its workspace itself and the stage's own picture holds only the question, so there is nothing for a look, a fix or the critic to judge */
  private holdsProblem(turn: ActiveTurn): boolean {
    return turn.score.schedule.elements.some((element) => element.exit === null && element.figure?.kind === 'structure' && element.figure.structure === 'problem');
  }

  private async lookAndFix(s: Session, turn: ActiveTurn, brain: Brain, input: TurnInput, normalizer: LineNormalizer): Promise<void> {
    if (this.holdsProblem(turn)) return;
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
      state: () => ({ schedule: turn.score.schedule, rejects: turn.rejects, lastSeq: s.nextSeq - 1, problems: turn.problems, shelf: this.shelfIds(s) }),
      signal: turn.abort.signal,
      now: this.deps.now,
      log: this.deps.log,
      // Only a painter that said it can try a fix first is offered one: otherwise a draft that needs mending is left as it is.
      ...(s.capabilities.candidates ? { candidate: (candidatePass: number, lines: readonly string[]) => this.emit(s, turn, { type: 'candidate', turn: turn.id, pass: candidatePass, lines }) } : {}),
      // SA2: a session whose page measures as the server does is measured here, at once; any other goes through the gate as before.
      ...(this.measuresHere(s)
        ? {
            measure: (measurePass: number) => {
              if (this.measuresHere(s) === false || !measurable(turn.score.schedule)) return null;
              const upto = turn.score.pushes;
              const measured = measureDraft(turn.score, s, turn.facts ?? undefined);
              if (measured === null) return null;
              this.deps.canvas?.seed(s, measured);
              this.deps.sessionLog.write(s.id, { type: 'measure', turn: turn.id, pass: measurePass, ms: Math.round(measured.ms * 10) / 10, boxes: measured.boxes, noted: measured.sight.items.filter((item) => item.notes.length > 0).length });
              this.noteBoxes(s, `${turn.id}#${measurePass}`, 'server', measured.boxes, 'draft', turn.id, (facts) => measureDraft(turn.score, s, facts, upto)?.boxes ?? null);
              return measured;
            },
            tryFix: (tryPass: number, lines: readonly string[]) => (this.measuresHere(s) ? tryFix(turn.score, lines, s, turn.facts ?? undefined) : null),
          }
        : {}),
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

  /**
   * SA2. True when this turn's drafts are measured by the server: the page's engine is the server's and no digest has differed in this turn.
   * The first time a session is found not to be (its engine), or a turn (a digest), the log says why (`drift`), and that turn's drafts go through
   * the gate. A differing digest is the turn's: the next turn is measured here again, and what it finds is its own.
   */
  private measuresHere(s: Session): boolean {
    // Dev only: STAGE_MEASURE=off is the path before SA2 (the page measures, the server waits), for measuring what the change bought.
    if (processEnvironment()['STAGE_MEASURE'] === 'off') return false;
    const engine = engineMismatch(s.capabilities);
    if (engine !== null) {
      if (s.drift === null) {
        s.drift = engine;
        this.deps.log.warn('engine.drift', { session: s.id, where: 'engine', why: engine });
        this.deps.sessionLog.write(s.id, { type: 'drift', turn: s.turn?.id ?? null, where: 'engine', page: s.capabilities.engine ?? null, server: ENGINE_VERSION, why: engine });
        this.observe(s, s.turn?.id ?? null, { source: 'server', kind: 'drift', severity: 'fault', note: engine });
      }
      return false;
    }
    // the page's engine is the server's now (a page that reloaded, or came back on a new build): what was held against it is over
    if (s.drift !== null && s.driftTurn === null) s.drift = null;
    return s.drift === null;
  }

  /**
   * SA2. One side's digest for a pass; when both are in and they differ, this turn drifts. Once the page's facts are in, the server's digest
   * is the one it gets measuring again with them (`again`): the comparison is then of the two engines on one set of inputs, not of what the
   * server guessed (the playhead each line arrived at, the asks the hand has worked) against what the page knew.
   */
  private noteBoxes(s: Session, key: string, side: 'page' | 'server', value: string, where: 'draft' | 'report', turn: string, again?: (facts: PageFacts) => string | null): void {
    const held = s.boxes.get(key) ?? {};
    held[side] = value;
    if (again !== undefined) held.again = again;
    s.boxes.set(key, held);
    while (s.boxes.size > 64) s.boxes.delete(s.boxes.keys().next().value as string);
    if (held.page === undefined || held.server === undefined) return;
    if (held.facts !== undefined && held.again !== undefined) {
      const remeasured = held.again(held.facts);
      if (remeasured !== null) {
        if (remeasured !== held.server) this.deps.log.info('engine.refloored', { session: s.id, turn, where, estimate: held.server, withPageFacts: remeasured });
        held.server = remeasured;
      }
    }
    if (held.page === held.server) {
      this.deps.log.info('engine.agree', { session: s.id, turn, where, boxes: held.page });
      return;
    }
    const why = `the page's boxes (${held.page}) and the server's (${held.server}) differ at ${key}`;
    this.deps.log.warn('engine.drift', { session: s.id, where, page: held.page, server: held.server, why });
    this.deps.sessionLog.write(s.id, { type: 'drift', turn, where, page: held.page, server: held.server, why, ...(held.facts === undefined ? {} : { facts: loggedFacts(held.facts) }) });
    // it costs the turn it was found in, and only while that turn is the one being measured: a report that comes after the next turn opened has no say in it
    if (s.drift === null && (s.turn === null || s.turn.id === turn)) {
      s.drift = why;
      s.driftTurn = turn;
    }
    this.observe(s, turn, { source: 'server', kind: 'drift', severity: 'fault', note: why });
  }

  private noteRefused(turn: ActiveTurn, reason: string): void {
    const problem = refusalProblem(reason);
    turn.problems.push(problem);
    if (turn.problems.length > MAX_PROBLEMS) turn.problems.splice(0, turn.problems.length - MAX_PROBLEMS);
  }

  /** SA3. Adds one observation to the session's feed and writes it to the log. */
  private observe(s: Session, turn: string | null, made: NewObservation): void {
    const one = s.obs.add(made, this.deps.now());
    this.deps.sessionLog.write(s.id, { type: 'obs', turn, obs: one });
  }

  private logFix(s: Session, turn: ActiveTurn, attempt: FixAttempt): void {
    if (!attempt.shown && attempt.why !== null && attempt.retried !== true) this.observe(s, turn.id, { source: 'server', kind: 'refusal', severity: 'blocking', answer: true, note: `a fix was refused: ${attempt.why}` });
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
      ...(attempt.retried === true ? { retried: true } : {}),
    });
  }

  /**
   * The critic, after the turn: once `end` has gone and the resting picture has come, a turn that drew something is looked at in the
   * background. Never awaited, never on the turn's path; what it finds is logged, sent as an event for the HUD, and queued when it is low.
   */
  private lookAtResult(s: Session, turn: ActiveTurn): void {
    const { critic, sessionLog, findings, now, log } = this.deps;
    // CRITIC_SCRIPTS=on (a test rig's switch, never the owner's): a played script is judged, and mended, like an answer, so a known-bad one can be replayed.
    const scripts = processEnvironment()['CRITIC_SCRIPTS'] === 'on';
    if (turn.criticAsked || turn.endReason !== 'done' || turn.snapshotFile === null) return;
    if (!critic.available || (turn.brain === 'replay' && !scripts) || ((turn.input.kind === 'demo' || turn.input.kind === 'script') && !scripts)) return this.mend(s, turn, 'none');
    const snapshot = this.deps.assets.snapshot(s.id, turn.id);
    if (snapshot === undefined) return this.mend(s, turn, 'none');
    const facts = draftFactsOf(turn.score.schedule, 0, 0, this.shelfIds(s));
    // A turn that only changed what an earlier turn left on the stage draws nothing new, but it is the follow-up the critic is for (critic v2)
    if (this.holdsProblem(turn)) return this.mend(s, turn, 'none');
    const previous = this.previousForCritic(s, turn);
    if (previous === null && !worthALook(facts, { ...this.deps.review, enabled: true, passes: 1 }).look) return this.mend(s, turn, 'none');
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
      mockup: turn.score.schedule.elements.some((element) => element.exit === null && element.figure?.kind === 'structure' && element.figure.structure === 'screen'),
      previous,
    };
    void (async () => {
      try {
        const judged = await critic.look(request, s.abort.signal);
        if (judged === null || s.abort.signal.aborted) return this.mend(s, turn, 'none');
        const finding = this.withRepeats(s, turn.id, judged);
        const raised = finding.problems.filter((problem) => problem.raised !== false).length;
        log.info('critic.verdict', { session: s.id, turn: turn.id, coherence: finding.coherence, failedTier: finding.failedTier ?? null, failed: (finding.gates ?? []).filter((gate) => !gate.pass).map((gate) => gate.gate).join(','), raised, held: finding.problems.length - raised, followUp: request.previous !== null && request.previous !== undefined, trend: finding.progress?.trend ?? null });
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
        // v3. A repaired answer is judged once more, against the verdict it had; any other is a candidate for a repair of its own.
        if (turn.input.kind === 'repair') this.noteRepairJudged(s, turn, finding, request.previous?.finding ?? null);
        else this.considerRepair(s, turn, finding);
      } catch (error) {
        log.warn('critic.failed', { session: s.id, turn: turn.id, error });
        this.mend(s, turn, 'none');
      }
    })();
  }

  /**
   * Tells the page whether this answer may still be changed by the critic or a repair: `none` when nothing more will happen to it (said once the
   * critic is known to have no say, or the repair has ended without a change), `working` when a repair is being written, `shown` when its lines went
   * to the page. For whoever waits for the stage to be done (the journey's `rest`); the stage itself does nothing with it.
   */
  private mend(s: Session, turn: ActiveTurn, state: 'none' | 'working' | 'shown'): void {
    if (turn.input.kind === 'repair') return;
    this.emit(s, turn, { type: 'mend', turn: turn.id, state });
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // The brain keeps working at will. A turn that ends with `refine | what next` is the brain saying it has more to do. Once the stage has come
  // to rest the server runs the brain again at once, as a turn of its own (`kind: 'refine'`, carrying the brain's own note): it is shown the
  // picture, YOUR DRAWING NOW and the drawing memory, like any turn, and may draw, write, start a new scene or reuse earlier work. That turn
  // ends with `refine | …` again, or without it, and then it is done. No count and no clock: the brain stops writing it, the person sends a
  // message (a new turn takes over), Stop, the usage cap, or a failed turn. Each continuation is an ordinary turn, in the log and a version.
  // ------------------------------------------------------------------------------------------------------------------------------

  private considerContinue(s: Session, turn: ActiveTurn): void {
    const note = turn.continueNote;
    if (note === undefined || this.deps.continuation !== true || turn.endReason !== 'done') return;
    const { log, usage, now } = this.deps;
    const state = usage?.state(now()) ?? 'off';
    if (state === 'near' || state === 'over') {
      log.info('continue.stopped', { session: s.id, turn: turn.id, why: 'usage is near the cap' });
      return;
    }
    s.continuing?.abort.abort();
    const abort = new AbortController();
    const mine = { of: turn.id, abort };
    s.continuing = mine;
    const signal = AbortSignal.any([abort.signal, s.abort.signal]);
    void (async () => {
      // the stage comes to rest on the page first (its picture is what the brain is shown), and the person's typing is waited out
      while (!signal.aborted && (!turn.reported || s.typingUntil > now())) await new Promise<void>((resolve) => setTimeout(resolve, 200));
      if (signal.aborted || s.turn !== turn) return;
      // the picture comes a moment after the report
      for (let waited = 0; this.deps.assets.snapshot(s.id, turn.id) === undefined && waited < 8000 && !signal.aborted; waited += 200) await new Promise<void>((resolve) => setTimeout(resolve, 200));
      if (signal.aborted || s.turn !== turn) return;
      if (s.continuing === mine) s.continuing = null;
      log.info('continue.started', { session: s.id, turn: turn.id, note: note.slice(0, 120) });
      this.deps.sessionLog.write(s.id, { type: 'continue', turn: turn.id, note });
      this.startTurn(s.id, { kind: 'refine', note });
    })().catch((error: unknown) => {
      if (s.continuing === mine) s.continuing = null;
      log.warn('continue.failed', { session: s.id, turn: turn.id, error });
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // v3: critic-driven repair. The critic sees the picture an answer left at rest. When it says that picture is broken in a way the brain can
  // work around, the server asks the brain (the warm process that wrote it) for fix lines, tries them on a copy of the answer's score here,
  // and shows them as an in-place edit only if the stage then measures strictly better. One repair per answer; never while the person is
  // typing or a new turn is running; a new turn cancels it; never on a lesson, an app or a mock-up. The critic then judges the repaired
  // answer once more, with its `progress`, and the log has both scores.
  // ------------------------------------------------------------------------------------------------------------------------------

  /** Why this answer is not repaired, or null when it may be. */
  private repairLimit(s: Session, turn: ActiveTurn): string | null {
    if (s.turn !== turn || turn.endReason !== 'done') return 'a newer turn is on the stage';
    if (!turn.reported) return 'the answer has not come to rest';
    if (this.deps.brains.configured.review === undefined) return 'this brain cannot look at an answer again';
    if (turn.input.kind === 'act') return 'the person is working a control';
    const view = this.docs.viewOfSession(s.id);
    if ((view !== null && hasLesson({ document: { document: view.document, state: view.state } }))) return 'a lesson or document turn';
    const structures = turn.score.schedule.elements.filter((element) => element.exit === null && element.figure?.kind === 'structure');
    if (structures.some((element) => element.figure?.kind === 'structure' && element.figure.structure === 'app')) return 'an app';
    if (structures.some((element) => element.figure?.kind === 'structure' && element.figure.structure === 'screen')) return 'a mock-up';
    if (!this.measuresHere(s) || !measurable(turn.score.schedule)) return 'the server cannot measure this stage';
    return null;
  }

  /**
   * What the critic found broken that no repair mended, as the next brief is to tell it. A finding is kept while the thing it names is still on
   * stage, and told at most twice: if the brain has had it in two briefs and left it, it was not to be mended by words.
   */
  private owedFor(s: Session): OwedFinding[] {
    return owedToTell(s);
  }

  /**
   * Keeps the critic's blocking findings of an answer that was not repaired, to be told at the next turn. Chosen over repairing the old answer after
   * the newer turn rests: that turn has already moved the drawing (and the person with it), so a repair written for the picture the critic saw may
   * undo or fight what they asked for since. The brain, which knows what the new turn is for, gets the ids and mends them when it next touches them.
   * A repair that is later kept for the same answer does not owe them (a kept repair never reaches here).
   */
  /** Keeps the critic's blocking findings of an answer that was not repaired, to be told at the next turn. A repair that is later kept for the same answer clears them. */
  private oweFindings(s: Session, turn: ActiveTurn, finding: CriticFinding, why: string): void {
    const owed = oweFindings(s, turn.id, finding);
    if (owed.length === 0) return;
    this.deps.log.info('critic.owed', { session: s.id, turn: turn.id, ids: owed.map((one) => one.id ?? '-').join(','), why });
    this.deps.sessionLog.write(s.id, { type: 'owed', turn: turn.id, ids: owed.map((one) => one.id), why });
  }

  private considerRepair(s: Session, turn: ActiveTurn, finding: CriticFinding): void {
    const worth = repairWorth(finding);
    if (!worth.wanted || s.repaired.has(turn.id)) {
      // not a repair's business (a lower tier, or one already tried): the blocking findings are still the brain's to hear of
      if (!s.repaired.has(turn.id)) this.oweFindings(s, turn, finding, 'not a repair\'s kind of finding');
      this.mend(s, turn, 'none');
      return;
    }
    const { now, sessionLog, log } = this.deps;
    const skipped = (why: string): void => {
      log.info('repair.skipped', { session: s.id, turn: turn.id, why });
      sessionLog.write(s.id, { type: 'repair', turn: turn.id, repair: null, state: 'skipped', gates: worth.gates, why, lines: [], coherenceBefore: finding.coherence, blockingBefore: null, blockingAfter: null, costUsd: null, ms: 0, tryMs: null, firstLineMs: null, sinceEndMs: now() - (turn.endedAt ?? now()) });
      // The finding is not dropped with the repair: the brain is told of it at its next turn (never if the person switched repairs off to be left alone).
      this.oweFindings(s, turn, finding, why);
      this.mend(s, turn, 'none');
    };
    if (!s.repairOn) return skipped('switched off (/review repair off)');
    if (turn.continueNote !== undefined) return skipped('the brain went on by its own choice');
    const limit = this.repairLimit(s, turn);
    if (limit !== null) return skipped(limit);
    s.repaired.add(turn.id);
    this.mend(s, turn, 'working');
    const abort = new AbortController();
    s.repair = { of: turn.id, abort };
    void this.runRepair(s, turn, finding, worth, abort).catch((error: unknown) => log.error('repair.escaped', { session: s.id, turn: turn.id, error })).finally(() => {
      if (s.repair?.abort === abort) s.repair = null;
    });
  }

  private async runRepair(s: Session, turn: ActiveTurn, finding: CriticFinding, worth: RepairWorth, abort: AbortController): Promise<void> {
    const { now, sessionLog, log } = this.deps;
    const started = now();
    const signal = AbortSignal.any([abort.signal, s.abort.signal]);
    const write = (state: 'kept' | 'refused' | 'nothing' | 'failed' | 'cancelled' | 'skipped', patch: { repair?: string; why?: string | null; lines?: readonly string[]; blockingBefore?: number | null; blockingAfter?: number | null; costUsd?: number | null; tryMs?: number | null; firstLineMs?: number | null } = {}): void => {
      const entry = { type: 'repair' as const, turn: turn.id, repair: null, state, gates: worth.gates, why: null, lines: [], coherenceBefore: finding.coherence, blockingBefore: null, blockingAfter: null, costUsd: null, ms: now() - started, tryMs: null, firstLineMs: null, sinceEndMs: now() - (turn.endedAt ?? started), ...patch };
      sessionLog.write(s.id, entry);
      if (state !== 'kept') this.oweFindings(s, turn, finding, `the repair was ${state}${entry.why === null ? '' : `: ${entry.why}`}`);
      this.mend(s, turn, state === 'kept' ? 'shown' : 'none');
      log.info(`repair.${state}`, { session: s.id, turn: turn.id, gates: worth.gates.join(','), why: entry.why, repair: entry.repair, blockingBefore: entry.blockingBefore, blockingAfter: entry.blockingAfter, costUsd: entry.costUsd, ms: entry.ms });
    };
    const here = (): boolean => !signal.aborted && s.turn === turn && turn.endReason === 'done' && turn.reported;
    const gone = (): string => (signal.aborted ? 'a new turn began, or the switch went off' : 'the stage moved on');
    let kept: RepairOutcome | null = null;
    try {
      // Never while the person is typing: wait for the keys to stop, for a while, and give up quietly if they do not.
      const patience = now() + 20_000;
      while (s.typingUntil > now() && now() < patience && !signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, 400));
      if (!here()) return write('cancelled', { why: gone() });
      if (s.typingUntil > now()) return write('skipped', { why: 'the person is still typing' });
      const rest = measureDraft(turn.score, s, turn.facts ?? undefined);
      if (rest === null) return write('skipped', { why: 'the server could not measure this stage' });
      this.deps.canvas?.seed(s, rest);
      const briefed = briefEyes(s, this.deps.canvasTools === true);
      this.deps.canvas?.beginTurn(s.id, turn.id, briefed.record.rev[0]);
      log.info('repair.started', { session: s.id, turn: turn.id, gates: worth.gates.join(','), blocking: rest.sight.items.filter((item) => item.notes.length > 0).length, sinceEndMs: now() - (turn.endedAt ?? started) });
      const normalizer = new LineNormalizer(() => {
        s.nextAutoId += 1;
        return `x${s.nextAutoId}`;
      }, Object.keys(s.stage.styles), { photos: this.photoShapes.get(s.id) ?? {} });
      let outcome: RepairOutcome;
      try {
        const steps = repairTurn({
          brain: this.deps.brains.configured,
          policy: { ...this.deps.review, enabled: true, firstLineMs: 30_000, passMs: 75_000 },
          gate: s.draft,
          turn: turn.id,
          session: s.id,
          input: turn.input,
          styles: () => Object.keys(turn.score.schedule.styles),
          drafts: true,
          state: () => ({ schedule: turn.score.schedule, rejects: turn.rejects, lastSeq: s.nextSeq - 1, problems: turn.problems, shelf: this.shelfIds(s) }),
          signal,
          now,
          log,
          tryFix: (_pass, lines) => tryFix(turn.score, lines, s, turn.facts ?? undefined),
          fix: this.deps.fix,
          form: 'repair',
          finding: { problems: finding.problems, suggestions: finding.suggestions },
          standing: s.standing,
          eyes: briefed.eyes,
          written: turn.score.score.filter((entry) => !entry.void).map((entry) => serializeLine(entry.line)),
          rest,
          picture: this.deps.assets.snapshot(s.id, turn.id) ?? null,
        });
        for (;;) {
          const step = await steps.next();
          if (step.done === true) {
            outcome = step.value;
            break;
          }
          // the brain's brief, usage and activity: logged and billed under the answer it is mending, as a pass after the draft
          if (step.value.type !== 'pass' && step.value.type !== 'record') this.ingest(s, turn, step.value, normalizer, 2, true);
        }
      } finally {
        const used = this.deps.canvas?.endTurn(s.id, turn.id) ?? null;
        if (used !== null) log.info('repair.tools', { session: s.id, turn: turn.id, calls: used.calls, pulled: used.pulled.length });
      }
      const detail = { why: outcome.why, lines: outcome.texts, blockingBefore: outcome.blockingBefore, blockingAfter: outcome.blockingAfter, costUsd: outcome.costUsd, tryMs: outcome.tryMs, firstLineMs: outcome.firstLineMs };
      if (outcome.state !== 'kept') return write(signal.aborted ? 'cancelled' : outcome.state, detail);
      // Between the brain's last word and the page: if a new turn began meanwhile, nothing is shown.
      if (!here()) return write('cancelled', { ...detail, why: gone() });
      kept = outcome;
      const shown = this.showRepair(s, turn, normalizer, outcome);
      write('kept', { ...detail, repair: shown });
    } catch (error) {
      if (kept === null) write(signal.aborted ? 'cancelled' : 'failed', { why: error instanceof Error ? error.message : String(error) });
      else log.error('repair.show_failed', { session: s.id, turn: turn.id, error });
    }
  }

  /** Opens the repair as a turn of its own (`input.kind` `repair`, `previous` the answer it mends) and puts its lines on the page, in place. Answers its id. */
  private showRepair(s: Session, of: ActiveTurn, normalizer: LineNormalizer, outcome: RepairOutcome): string {
    return this.showInPlace(s, of, { kind: 'repair', of: of.id }, outcome.lines, normalizer, true);
  }

  /**
   * An in-place turn of the server's own: lines put on the stage, over the answer on it, in a turn that is logged, replayed and reported like
   * any. A repair is one, and so is a made drawing taking the place of its placeholder (`announce` false: nothing is being tidied).
   */
  private showInPlace(s: Session, of: ActiveTurn, input: TurnInput, lines: readonly BrainEvent[], normalizer: LineNormalizer, announce: boolean): string {
    const { sessions, now } = this.deps;
    const brain = this.deps.brains.configured;
    const turn: ActiveTurn = {
      id: sessions.nextTurnId(),
      session: s.id,
      input,
      brain: brain.id,
      login: of.login,
      openedAt: now(),
      abort: new AbortController(),
      score: new TurnScore(s.stage, 'repair'),
      endReason: null,
      clock: null,
      shownIds: [],
      previous: of.id,
      reader: new LineReader(Object.keys(s.stage.styles)),
      problems: [],
      relayCursor: s.nextCursor - 1,
      ordinal: s.nextOrdinal,
      lineCount: 0,
      facts: null,
      docLines: 0,
      docEvents: 0,
      held: new Map(),
      rejects: 0,
      lookAllowed: false,
      review: undefined,
      reported: false,
      sent: [],
      missed: [],
      snapshotFile: null,
      criticAsked: false,
      refused: [],
      amended: false,
      calls: new Map(),
      endedAt: null,
    };
    s.nextOrdinal += 1;
    s.heardFrom = s.nextCursor - 1;
    s.turn = turn;
    sessions.indexTurn(s, turn);
    this.journal(s, { type: 'turn', turn: turn.id, input, brain: brain.id, login: turn.login });
    this.emit(s, turn, { type: 'turn', turn: turn.id, input });
    if (announce) {
      this.emit(s, turn, { type: 'pass', turn: turn.id, pass: 2, state: 'repairing', reason: null });
      this.deps.sessionLog.write(s.id, { type: 'pass', turn: turn.id, pass: 2, state: 'repairing', reason: null });
    } else this.artTurns.add(turn);
    for (const event of lines) if (this.ingest(s, turn, event, normalizer, 2) === 'stop') break;
    // `repaired` is said when the painter reports the repair played out (`apply`, `report`), so that "Tidied" is about the picture the person sees
    this.finish(s, turn, 'done', null);
    return turn.id;
  }

  /** The critic's second look at a repaired answer: both scores, and its own account of the progress, in the log. */
  private noteRepairJudged(s: Session, turn: ActiveTurn, finding: CriticFinding, before: CriticFinding | null): void {
    const of = turn.input.kind === 'repair' ? turn.input.of : null;
    if (of === null) return;
    const earlier = before ?? s.findings.get(of) ?? null;
    const progress = finding.progress ?? null;
    this.deps.sessionLog.write(s.id, {
      type: 'repair-judged',
      turn: of,
      repair: turn.id,
      coherenceBefore: earlier?.coherence ?? finding.previous?.coherence ?? 0,
      coherenceAfter: finding.coherence,
      trend: progress?.trend ?? null,
      fixed: progress?.fixed ?? [],
      stillFailing: progress?.stillFailing ?? [],
      newFailures: progress?.newFailures ?? [],
      note: progress?.note ?? '',
      ms: finding.ms,
    });
    this.deps.log.info('repair.judged', { session: s.id, turn: of, repair: turn.id, before: earlier?.coherence ?? null, after: finding.coherence, trend: progress?.trend ?? null });
  }

  /**
   * Critic v2. A turn that changed the same answer in place (something from the turn before is still on the stage at rest) is shown the
   * picture and the verdict from before: the critic's own record, never what the brain was told or thought. Null when this is a new
   * picture, when the turn before was not judged, or when its picture is gone.
   */
  private previousForCritic(s: Session, turn: ActiveTurn): { readonly picture: Snapshot; readonly finding: CriticFinding } | null {
    if (turn.previous === null || turn.input.kind === 'tap') return null;
    const finding = s.findings.get(turn.previous);
    const picture = this.deps.assets.snapshot(s.id, turn.previous);
    if (finding === undefined || picture === undefined) return null;
    const inPlace = turn.score.schedule.elements.some((element) => element.carried && element.exit === null && element.kind !== 'field');
    return inPlace ? { picture, finding } : null;
  }

  /** Critic v2. Counts each gate that failed here against the session's earlier turns; the judge is not asked, and cannot talk a count down. */
  private withRepeats(s: Session, turn: string, finding: CriticFinding): CriticFinding {
    const failed = (finding.gates ?? []).filter((gate) => !gate.pass).map((gate) => gate.gate);
    if (failed.length === 0) return finding;
    const repeats: { gate: string; count: number; turns: string[] }[] = [];
    for (const gate of failed) {
      const turns = s.gateFails.get(gate) ?? [];
      if (!turns.includes(turn)) turns.push(turn);
      s.gateFails.set(gate, turns);
      if (turns.length >= 2) repeats.push({ gate, count: turns.length, turns: [...turns] });
    }
    return repeats.length === 0 ? finding : { ...finding, repeats };
  }

  /** What the critic is told was asked: the user's words, never a document or a table they pasted. */
  private askedForCritic(input: TurnInput): string {
    if (input.kind === 'prompt' && (input.text.length >= PASTE_AS_DOCUMENT_CHARS || tableFromText(input.text, 'd0', '') !== null)) return '(the user pasted a long text or a table)';
    return askedOf(input);
  }

  /** One event of a brain's pass, carried to the log, the score and the painter. Returns `stop` when the turn can take no more. */
  private ingest(s: Session, turn: ActiveTurn, event: BrainEvent, normalizer: LineNormalizer, pass: number, repairing = false): 'stop' | undefined {
    const { log, sessionLog } = this.deps;
    // What the brain was told and what the turn cost are recorded even when the turn was cut short; its lines no longer matter.
    if (event.type === 'brief') {
      sessionLog.write(s.id, { type: 'brief', turn: turn.id, form: event.form, text: event.text, system: event.system, withSnapshot: event.withSnapshot, pass });
      return undefined;
    }
    if (event.type === 'model') {
      if (pass === 1 && !repairing) this.emit(s, turn, { type: 'model', turn: turn.id, model: event.model, effort: event.effort });
      return undefined;
    }
    if (event.type === 'typing') {
      // Only the first pass is shown as it is written; a look's fix is tried out of sight and a repair is not the owner's stream.
      if (pass === 1 && !repairing && turn.endReason === null) this.typing(s, turn, event.text);
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
        kind: turn.input.kind === 'repair' || repairing ? 'repair' : pass === 1 ? 'turn' : 'review',
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
    // SA4. A call of the canvas tools seen on the model's stream, after every line written before it was taken: the handler waiting for it may go.
    // It is not a tool of the owner's to be shown or audited: it reads the stage and writes nothing.
    if (event.type === 'activity' && event.tool.startsWith('mcp__canvas__')) {
      if (event.state === 'running') this.deps.canvas?.marked(s.id);
      return undefined;
    }
    if (turn.endReason !== null) return undefined;
    if (event.type === 'activity') {
      // A few safe words about a call (the brain adapter has redacted them), logged and shown as it happens. Never its input or its result.
      // The adapter has made these safe; a second net costs nothing and a secret that reaches a log or a stage is the one thing this must not do.
      const summary = redactSecrets(event.summary);
      this.noteCall(s, turn, event.id, event.tool, summary, event.state);
      const permit = event.permit === 'auto' ? ({ permit: 'auto' } as const) : {};
      sessionLog.write(s.id, { type: 'activity', turn: turn.id, id: event.id, tool: event.tool, summary, state: event.state, ms: event.ms, ...permit });
      this.emit(s, turn, { type: 'activity', turn: turn.id, id: event.id, tool: event.tool, summary, state: event.state, ms: event.ms, ...permit });
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
    // Drawing memory: `restore` and `use … from=` are read here and become the remembered lines, ingested one by one as if the brain had written them.
    if (event.line.verb === 'restore' || (event.line.verb === 'use' && event.line.from !== undefined)) return this.recall(s, turn, event.line, normalizer, pass, repairing);
    const normalized = normalizer.normalize(this.withPartsResolved(s, turn, event.line));
    if (normalized.line === null) {
      // A step, ask or hint that came before the part or ask it belongs to is held, and read when that one is written; refused only if it never comes
      const missing = ['step', 'ask', 'hint'].includes(event.line.verb) ? normalized.issues.find((issue) => issue.code === 'unknown-id' && issue.token !== undefined)?.token : undefined;
      if (missing !== undefined && !repairing) {
        const waiting = turn.held.get(missing) ?? [];
        waiting.push({ event, issues: [...event.issues, ...normalized.issues] });
        turn.held.set(missing, waiting);
        return undefined;
      }
      this.reject(s, turn, serializeLine(event.line), [...event.issues, ...normalized.issues]);
      return undefined;
    }
    // A prompt that opens a new `scene` over a live drawing replaces it (a new beat of a story does so on purpose). It is let through, and the log says so.
    if (normalized.line.verb === 'scene' && !repairing && turn.input.kind === 'prompt' && s.stage.elements.some((element) => !element.struck && (element.kind === 'shape' || element.kind === 'group'))) {
      this.deps.log.warn('drawing.scene_over_live', { session: s.id, turn: turn.id, said: turn.input.text.slice(0, 80) });
    }
    // v3 art. `draw` is expanded here, beside `paint` and `findPicture`: a shelf hit becomes a group and its parts, a miss a quiet placeholder.
    // The lines it makes are ingested one by one as if the brain had written them, so the log, the schedule and the page see only real lines.
    if (normalized.line.verb === 'draw') return this.drawFromShelf(s, turn, normalized.line, normalizer, pass, repairing);
    if (this.holdsLabel(s, normalized.line)) return undefined;
    const braced = this.withoutRawBraces(turn, normalized.line);
    const line = braced.line;
    const bracedIssues: Issue[] = [];
    const seq = s.nextSeq;
    s.nextSeq += 1;
    turn.lineCount += 1;
    const penBefore = turn.score.schedule.pen;
    const pushed = turn.score.push(line, seq, this.estimatePlayhead(turn));
    const issues: Issue[] = [...event.issues, ...normalized.issues, ...bracedIssues, ...pushed.issues];
    const text = serializeLine(line);
    log.debug('turn.line', { turn: turn.id, seq, text });
    if (issues.some((issue) => issue.severity === 'warn')) this.noteProblem(turn, text, 'repaired', issues.filter((issue) => issue.severity === 'warn'));
    const start = pushed.schedule.lines.find((timed) => timed.seq === seq)?.start ?? penBefore;
    const node = this.docs.place(s.id, text);
    if (node !== null) turn.docLines += 1;
    this.journal(s, { type: 'line', turn: turn.id, seq, text, start, issues, pass, ...(node === null ? {} : { node }) });
    if (turn.input.kind !== 'demo') s.memory.record(turn.id, seq, text);
    this.emit(s, turn, { type: 'line', turn: turn.id, seq, text, issues });
    // A long `say` was split by the normaliser: its continuations follow at once, in order, as lines of their own. No word is cut.
    for (const next of normalized.rest ?? []) if (this.ingest(s, turn, { type: 'line', line: next, issues: [] }, normalizer, pass, repairing) === 'stop') return 'stop';
    if (line.verb === 'paint') this.paint(s, turn, seq, line, pushed.schedule);
    if (line.verb === 'refine' && !repairing && this.deps.continuation === true) turn.continueNote = (line.text ?? '').trim() === '' ? 'go on' : (line.text ?? '').trim();
    if (line.verb === 'row') this.findPicture(s, turn, line.id, line.cells, pushed.schedule);
    if (line.verb === 'chart' && line.data !== undefined) this.announceData(s, turn, line.data);
    // what was waiting for this part or ask is read now
    const id = (line as { id?: string }).id;
    const waiting = line.verb === 'part' || line.verb === 'ask' ? (id === undefined ? undefined : turn.held.get(id)) : undefined;
    if (id !== undefined && waiting !== undefined) {
      turn.held.delete(id);
      for (const held of waiting) if (this.ingest(s, turn, held.event as BrainEvent, normalizer, pass, repairing) === 'stop') return 'stop';
    }
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

  /**
   * The learner never sees a raw `{…}`. A brace naming a control that is not (yet) on stage is kept while the turn runs, because the brain may
   * declare the slider after the table or sentence that reads it; the painter works it out against every control of the turn. When the turn
   * ends, the names that were never declared are said to the brain as a repair (the painter takes them out of the words).
   */
  private withoutRawBraces(turn: ActiveTurn, line: Line): { readonly line: Line; readonly dropped: string[] } {
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk);
      if (typeof value !== 'object' || value === null) return value;
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'text' && typeof inner === 'string' && inner.includes('{')) {
          const cleaned = withoutUnknownBraces(inner, () => true);
          if (withoutUnknownBraces(inner, (name) => this.declared(turn, name)).dropped.length > 0) this.bracesWaiting.set(turn, [...(this.bracesWaiting.get(turn) ?? []), inner]);
          out[key] = cleaned.text;
        } else out[key] = typeof inner === 'object' ? walk(inner) : inner;
      }
      return out;
    };
    const walked = walk(line) as Line;
    return { line: walked, dropped: [] };
  }

  /** braces that named a control not on stage when they were written, by turn */
  private readonly bracesWaiting = new WeakMap<ActiveTurn, string[]>();

  private declared(turn: ActiveTurn, name: string): boolean {
    return turn.score.schedule.elements.some((element) => element.figure?.kind === 'control' && element.id === name);
  }

  /** At the turn's end: braces that name no control declared anywhere in it. */
  private noteUndeclaredBraces(turn: ActiveTurn): void {
    const waiting = this.bracesWaiting.get(turn);
    if (waiting === undefined) return;
    const never = waiting.flatMap((text) => withoutUnknownBraces(text, (name) => this.declared(turn, name)).dropped);
    if (never.length === 0) return;
    this.noteProblem(turn, never.join(' '), 'repaired', [{ code: 'unknown-name', severity: 'warn', message: `${never.join(' ')} in the words names no control declared in the turn, so it was taken out; a name in braces must be the id of a slider, toggle or pick you declared` }]);
  }

  /**
   * At the turn's end: a control, bound in this turn, whose every bind leaves what it names exactly as it is (the schedule says so: `TurnScore.settledIssues`). The
   * brain is told in its next brief twice, as the line that did nothing and as something the eyes found, so it learns its slider is dead before the person tries it.
   */
  private noteDeadBinds(s: Session, turn: ActiveTurn): void {
    const said = new Set<number>();
    const tell = (seq: number, issue: Issue, problem: boolean): void => {
      const entry = turn.score.score.find((candidate) => candidate.seq === seq && !candidate.void);
      // a bind of an earlier turn was told of in its own; one line is told of once
      if (entry === undefined || entry.line.verb !== 'bind' || said.has(seq) || said.size >= MAX_DEAD_BINDS) return;
      said.add(seq);
      // a bind that names nothing drawn, or cannot do what it says, was given back to the brain with its line as it came: only what still holds at the end is seen
      if (problem) this.noteProblem(turn, serializeLine(entry.line), 'repaired', [issue]);
      this.observe(s, turn.id, { source: 'server', kind: 'refusal', severity: 'blocking', on: issue.token ?? null, answer: true, note: `a bind did nothing: ${issue.message.split('. ')[0] ?? issue.message}` });
    };
    for (const { seq, issue } of turn.score.settledIssues()) tell(seq, issue, true);
    for (const { seq, issue } of turn.score.schedule.issues) if (issue.code === 'bad-bind' || issue.code === 'unknown-id') tell(seq, issue, false);
  }

  private reject(s: Session, turn: ActiveTurn, raw: string, issues: readonly Issue[]): void {
    turn.rejects += 1;
    const refusal = refusalOf(raw, issues);
    if (refusal !== null && turn.refused.length < 8) turn.refused.push(refusal);
    this.noteProblem(turn, raw, 'rejected', issues);
    this.deps.sessionLog.write(s.id, { type: 'reject', turn: turn.id, raw, issues });
    this.observe(s, turn.id, { source: 'server', kind: 'refusal', severity: 'blocking', answer: true, note: `a line was refused: ${quoted(raw.split('\n')[0] ?? '', 70)}` });
    this.emit(s, turn, { type: 'reject', turn: turn.id, raw, issues });
  }

  /** What the next brief says went wrong: the line, cut short, and why. */
  private noteProblem(turn: ActiveTurn, raw: string, kind: LineProblem['kind'], issues: readonly Issue[]): void {
    const why = issues.map((issue) => issue.message).join('; ') || 'it was not understood';
    turn.problems.push({ raw: raw.replace(/\s+/g, ' ').trim().slice(0, 120), kind, why });
    if (turn.problems.length > MAX_PROBLEMS) turn.problems.splice(0, turn.problems.length - MAX_PROBLEMS);
  }

  /**
   * v3 (WS5). The reader's refusals within a turn: lines of the lesson it would not take (an ask that gives its answer away, a part that sits
   * in nothing) are said to the brain once, in the conversation that wrote them, and it writes them again before the turn ends. It is never
   * asked twice, and a brain that cannot be asked leaves the refusals to be found by the verifier.
   */
  private async amendTurn(s: Session, turn: ActiveTurn, brain: Brain, normalizer: LineNormalizer): Promise<void> {
    if (turn.refused.length === 0 || turn.amended || brain.amend === undefined || turn.abort.signal.aborted || turn.endReason !== null) return;
    turn.amended = true;
    const refused = turn.refused.splice(0);
    this.deps.log.info('turn.amend', { session: s.id, turn: turn.id, refused: refused.length });
    try {
      for await (const event of brain.amend({ turn: turn.id, session: s.id, styles: Object.keys(turn.score.schedule.styles), text: refusalBrief(refused) }, turn.abort.signal)) {
        if (this.ingest(s, turn, event, normalizer, 2) === 'stop') break;
      }
    } catch (error) {
      // a refusal that cannot be put to the brain is not a failed turn: the verifier finds what is missing
      this.deps.log.warn('turn.amend_failed', { session: s.id, turn: turn.id, error });
    }
  }

  // ---------------------------------------------------------------- v3 (WS5): fill ahead

  /** What fill ahead and verify need of the conductor. */
  private aheadHost(check: NonNullable<ConductorDeps['ahead']>['check']): AheadHost {
    const { sessions, log, now } = this.deps;
    return {
      now,
      view: (session) => this.docs.viewOfSession(session),
      userTurnOpen: (session) => {
        const turn = sessions.get(session)?.turn;
        return turn !== undefined && turn !== null && turn.endReason === null;
      },
      fill: (session, job, signal) => this.quietFill(session, job, signal),
      setStatus: (session, node, status, options) => {
        const s = sessions.get(session);
        if (s === undefined) return false;
        const change = this.journal(s, { type: 'node', turn: null, node, status, ...(options.reset === true ? { reset: true as const } : {}), why: options.why });
        return change?.applied === true;
      },
      check: (session, pages, signal) => check(session, pages, signal),
      throttle: this.deps.usage ?? NO_THROTTLE,
      log: log.child({ part: 'ahead' }),
    };
  }

  /** v3 (WS5). What is waiting, being written, being checked and done, for a session; null when nothing has been looked at. */
  aheadStatus(session: string): AheadStatus | null {
    return this.ahead.status(session);
  }

  /** v3 (WS5). Resolves when nothing is left to write or check for the session (for the tool that measures it). */
  aheadSettled(session: string): Promise<AheadStatus | null> {
    return this.ahead.settled(session);
  }

  /**
   * v3 (WS5). One part written by a quiet turn of the brain, off the person's clock: its own process (`<session>~ahead<n>`, so it never
   * borrows the conversation's), the same TEACH chapter (the brief is the ordinary one for a conversation with a document), its lines
   * read against the document and journaled into it, none sent to the stage. The reader's refusals are put to it once, as in a turn of her
   * own. It never throws: what went wrong is its outcome and the `end` record's reason.
   */
  private async quietFill(session: string, job: FillJob, signal: AbortSignal): Promise<FillOutcome> {
    const { sessions, log, sessionLog, now } = this.deps;
    const s = sessions.get(session);
    const started = now();
    const turn = `a${(this.quietCount += 1)}`;
    const failed = (reason: string): FillOutcome => ({ ok: false, turn, lines: 0, refused: 0, costUsd: null, ms: now() - started, reason });
    const view = this.docs.viewOfSession(session);
    if (s === undefined || view === null) return failed('the conversation has no document');
    const brain = this.deps.brains.configured;
    let slot = '';
    for (let n = 0; n < 8 && slot === ''; n += 1) if (!this.quietBusy.has(`${session}~ahead${n}`)) slot = `${session}~ahead${n}`;
    if (slot === '') return failed('every quiet process is busy');
    this.quietBusy.add(slot);
    if (!this.quietSet.has(slot)) {
      this.quietSet.add(slot);
      const choice = brain.choice?.(session);
      if (choice !== undefined && brain.choose !== undefined) {
        try {
          brain.choose(slot, { ...(choice.model === null ? {} : { model: choice.model as BrainChange['model'] }), ...(choice.effort === null ? {} : { effort: choice.effort }) });
        } catch (error) {
          log.warn('ahead.choose_failed', { session, error });
        }
      }
    }
    let lines = 0;
    let cost: number | null = null;
    let reason: 'done' | 'interrupted' | 'failed' | 'timeout' = 'done';
    let message: string | null = null;
    const refused: { raw: string; why: string }[] = [];
    let amended = false;
    try {
      const input: TurnInput = { kind: 'prompt', text: fillPrompt(job) };
      this.journal(s, { type: 'turn', turn, input, brain: brain.id, login: 'ahead' });
      const services = this.servicesFor(s.capabilities, s.id);
      const context = {
        screen: s.screen,
        capabilities: s.capabilities,
        services,
        lead: LEAD_WINDOW,
        stage: { ...EMPTY_STAGE, look: s.stage.look, lookName: s.stage.lookName },
        history: [],
        heard: [],
        document: { document: view.document, state: view.state },
      };
      // a try that was refused is written from the page itself: the first photo this conversation was given
      const photoId = job.photo ? (job.crop?.from ?? [...s.turns.values()].flatMap((turnOf) => (turnOf.input.kind === 'prompt' ? (turnOf.input.images ?? []) : []))[0] ?? null) : null;
      const photo = photoId === null ? null : await (this.deps.uploads ?? NO_UPLOADS).load(s.id, photoId);
      const asked: TurnInput = photo !== null && photoId !== null ? { kind: 'prompt', text: input.text, images: [photoId] } : input;
      const normalizer = new LineNormalizer(() => {
        s.nextAutoId += 1;
        return `x${s.nextAutoId}`;
      }, []);
      seedBook(normalizer.lessons, view.document);
      let seq = 0;
      const handle = (event: BrainEvent, pass: number): void => {
        if (event.type === 'brief') {
          sessionLog.write(s.id, { type: 'brief', turn, form: event.form, text: event.text, system: event.system, withSnapshot: false, pass });
        } else if (event.type === 'usage') {
          cost = (cost ?? 0) + (event.usage.costUsd ?? 0);
          this.deps.usage?.record({ kind: 'ahead', model: brain.choice?.(slot).model ?? null, session, turn, login: 'ahead', inputTokens: event.usage.inputTokens, cacheReadTokens: event.usage.cacheReadTokens, cacheWriteTokens: event.usage.cacheWriteTokens, outputTokens: event.usage.outputTokens, thinkingTokens: event.usage.thinkingTokens, costUsd: event.usage.costUsd, ms: event.usage.totalMs });
          sessionLog.write(s.id, { type: 'usage', turn, usage: event.usage, pass });
        } else if (event.type === 'permission') {
          // nobody is there to be asked, and nothing a lesson needs wants anything but reading
          brain.permit?.(slot, event.request, false);
        } else if (event.type === 'reject') {
          const refusal = refusalOf(event.raw, event.issues);
          if (refusal !== null) refused.push(refusal);
          sessionLog.write(s.id, { type: 'reject', turn, raw: event.raw, issues: event.issues });
        } else if (event.type === 'line') {
          const verb = event.line.verb as string;
          if (!isLessonVerb(verb) || verb === 'reply' || verb === 'end') return;
          const normalized = normalizer.normalize(event.line);
          const raw = serializeLine(event.line);
          if (normalized.line === null) {
            const refusal = refusalOf(raw, [...event.issues, ...normalized.issues]);
            if (refusal !== null) refused.push(refusal);
            sessionLog.write(s.id, { type: 'reject', turn, raw, issues: [...event.issues, ...normalized.issues] });
            return;
          }
          const text = serializeLine(normalized.line);
          const node = this.docs.place(s.id, text);
          const inside = node !== null && (node.startsWith(`${job.node}/`) || (node === job.node && verb !== 'part'));
          if (!inside) {
            sessionLog.write(s.id, { type: 'reject', turn, raw: text, issues: [{ code: 'bad-value', severity: 'error', message: `this write is for part ${job.short} only; a line for another part was left out` }] });
            return;
          }
          seq += 1;
          lines += 1;
          this.journal(s, { type: 'line', turn, seq, text, start: 0, issues: [...event.issues, ...normalized.issues], pass, node });
        }
      };
      for await (const event of brain.respond({ turn, session: slot, input: asked, context, snapshot: null, look: false, quiet: true, ...(photo === null ? {} : { images: [photo] }) }, signal)) handle(event, 1);
      if (refused.length > 0 && brain.amend !== undefined && !signal.aborted) {
        amended = true;
        const mend = refused.splice(0);
        log.info('ahead.amend', { session, node: job.node, refused: mend.length });
        try {
          for await (const event of brain.amend({ turn, session: slot, styles: [], text: refusalBrief(mend) }, signal)) handle(event, 2);
        } catch (error) {
          log.warn('ahead.amend_failed', { session, node: job.node, error });
        }
      }
      if (signal.aborted) reason = 'interrupted';
    } catch (error) {
      reason = signal.aborted ? 'interrupted' : error instanceof AppError && error.code === 'brain_timeout' ? 'timeout' : 'failed';
      message = error instanceof AppError ? error.message : 'the brain failed unexpectedly';
      log.warn('ahead.brain_failed', { session, node: job.node, error });
    } finally {
      this.quietBusy.delete(slot);
    }
    if (sessions.get(session) !== undefined) this.journal(s, { type: 'end', turn, reason, message, lines });
    return { ok: reason === 'done', turn, lines, refused: refused.length, costUsd: cost, ms: now() - started, reason: reason === 'done' ? (amended ? 'rewritten once after a refusal' : null) : (message ?? reason) };
  }

  /** The ids of the drawn things on the canvas now that stand alone (not parts of a group): what a whole `restore` clears first. */
  private liveDrawn(turn: ActiveTurn): string[] {
    const ids = new Set<string>();
    for (const element of turn.score.schedule.elements) {
      if (element.exit !== null || element.parent !== null) continue;
      if (element.kind === 'shape' || element.kind === 'group' || element.kind === 'sprite' || element.kind === 'copy' || element.figure?.kind === 'picture') ids.add(element.id);
    }
    return [...ids];
  }

  /**
   * Drawing memory. `restore <turn>` puts that turn's whole resting drawing back (what stood is dropped first); `use <id…> from=<turn>` brings parts of it
   * back beside what is there. The remembered lines are ingested one by one, so what comes back is real: parts the brain can `set`, `move` and `drop`.
   */
  private recall(s: Session, turn: ActiveTurn, line: Line, normalizer: LineNormalizer, pass: number, repairing: boolean): 'stop' | undefined {
    const said = serializeLine(line);
    const refuse = (why: string): undefined => {
      this.reject(s, turn, said, [{ code: 'unknown-id', severity: 'error', message: why }]);
      return undefined;
    };
    let made: ReturnType<typeof s.memory.restore> | null;
    if (line.verb === 'restore') {
      const found = s.memory.find(line.turn);
      if (found === null) return refuse(`DRAWING MEMORY holds no ${line.turn}`);
      // `restore undo` goes on from where the last undo stopped; a named turn is a new place to stand
      if (!/^t\d+$/.test(line.turn)) s.memory.restoredIndex(found.index);
      made = s.memory.restore(found.index, this.liveDrawn(turn));
    } else if (line.verb === 'use' && line.from !== undefined) {
      const taken = new Set(turn.score.schedule.elements.filter((element) => element.exit === null).map((element) => element.id));
      const at = line.props.at !== undefined && typeof line.props.at === 'object' && 'x' in line.props.at ? line.props.at : undefined;
      made = s.memory.bring(line.from, line.sources ?? [line.source], taken, { ...(at === undefined ? {} : { at }), ...(line.props.scale === undefined ? {} : { scale: line.props.scale }), ...(line.props.rot === undefined ? {} : { rot: line.props.rot }) });
      if (made === null) return refuse(`DRAWING MEMORY has no ${(line.sources ?? [line.source]).join(', ')} in ${line.from}`);
    } else return undefined;
    this.deps.log.info('memory.recall', { session: s.id, turn: turn.id, said, brought: made.note, lines: made.lines.length });
    for (const brought of made.lines) {
      if (this.ingest(s, turn, { type: 'line', line: brought, issues: [] }, normalizer, pass, repairing) === 'stop') return 'stop';
    }
    if (line.verb === 'use') return this.paintAgain(s, turn, made.lines, normalizer, pass, repairing);
    return undefined;
  }

  /**
   * Parts that come back under a live painting must not sit under it: a painting of a group or of the whole scene has been developed over the parts it
   * saw, not these. So the painting is said again after them (a second `paint` over the same thing takes the first one's place), and it develops over
   * everything that is there now. The words are the ones kept in the memory.
   */
  private paintAgain(s: Session, turn: ActiveTurn, brought: readonly Line[], normalizer: LineNormalizer, pass: number, repairing: boolean): 'stop' | undefined {
    const schedule = turn.score.schedule;
    const live = schedule.elements.filter((element) => element.exit === null);
    const byKey = new Map(live.map((element) => [element.key, element] as const));
    const byId = new Map(live.map((element) => [element.id, element] as const));
    const reach = new Set<string>();
    for (const line of brought) {
      const id = (line as { id?: string }).id;
      const home = (line as { props?: { in?: string } }).props?.in;
      if (id === undefined || id === '-' || line.verb === 'paint') continue;
      // the group it lands in, and every group above that
      for (let at = home === undefined ? undefined : byId.get(home); at !== undefined; at = at.parent === null ? undefined : byKey.get(at.parent)) reach.add(at.id);
      if (home === undefined) reach.add('');
    }
    if (reach.size === 0) return undefined;
    for (const picture of live) {
      const figure = picture.figure;
      if (figure?.kind !== 'picture') continue;
      const over = figure.over === null ? null : (byKey.get(figure.over)?.id ?? null);
      // a painting of the whole scene covers whatever lands on the canvas; one of a group covers what lands in it
      if (over !== null && !reach.has(over)) continue;
      const text = s.memory.paintOf(picture.id);
      const again = text === null ? null : parseLine(text);
      if (again === null || again.kind !== 'line') continue;
      this.deps.log.info('memory.repaint', { session: s.id, turn: turn.id, painting: picture.id });
      if (this.ingest(s, turn, { type: 'line', line: again.line as Line, issues: [] }, normalizer, pass, repairing) === 'stop') return 'stop';
    }
    return undefined;
  }

  /** v3 art. One `draw` line as the lines of a figure from the shelf, or of a placeholder (and, for a subject the shelf lacks, a commission); see `art/draw.ts`. */
  private drawFromShelf(s: Session, turn: ActiveTurn, line: DrawLine, normalizer: LineNormalizer, pass: number, repairing: boolean): 'stop' | undefined {
    const schedule = turn.score.schedule;
    const scene = schedule.scenes.at(-1);
    const cast = this.casts.get(s) ?? new Cast(s.id);
    this.casts.set(s, cast);
    const canvasName = scene?.canvas ?? s.screen.canvas;
    const planned = planDraw(line, {
      shelf: this.deps.art ?? null,
      cast,
      live: new Set(schedule.elements.map((element) => element.id)),
      canvas: CANVAS[canvasName],
      canvasName,
      look: wearingAt(schedule, turn.score.base, schedule.pen),
    });
    this.deps.log.info('art.draw', { session: s.id, turn: turn.id, ...planned.detail });
    const lines = [...planned.lines];
    if (planned.note !== null) {
      const pending = planned.wanted === null ? null : this.commissionArt(s, planned.wanted);
      noteArt(turn, planned.id, pending ?? planned.note);
      // a drawing on its way: a small dim line under the placeholder says what is being drawn, and leaves with it
      if (pending !== null && planned.wanted !== null) lines.push(...captionLines(planned.wanted));
    }
    this.figureHas(s, planned.id, planned.note?.kind === 'drawn' ? planned.note.parts : []);
    for (const made of lines) {
      if (this.ingest(s, turn, { type: 'line', line: made, issues: [] }, normalizer, pass, repairing) === 'stop') return 'stop';
    }
    return undefined;
  }

  /** The ids of everything the shelf put on stage: figures, parts, placeholders and captions. Review leaves them alone. */
  private shelfIds(s: Session): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const [id, parts] of this.figures.get(s) ?? []) {
      ids.add(id);
      ids.add(`${id}-soft`.slice(0, 24));
      ids.add(captionId(id));
      for (const part of parts) ids.add(part);
    }
    return ids;
  }

  private figureHas(s: Session, id: string, parts: readonly string[]): void {
    const held = this.figures.get(s) ?? new Map<string, readonly string[]>();
    held.set(id, parts);
    this.figures.set(s, held);
  }

  /** v3 art. A label's `near=<figure>-<word>` is read against the parts the figure really has: the best match, else the figure itself. */
  private withPartsResolved(s: Session, turn: ActiveTurn, line: Line): Line {
    const figures = this.figures.get(s);
    const near = 'props' in line ? ((line as { props: StyleProps }).props).near : undefined;
    if (figures === undefined || figures.size === 0 || near === undefined) return line;
    const live = new Set(turn.score.schedule.elements.filter((element) => element.exit === null).map((element) => element.id));
    const found = resolveNear(near.id, live, figures);
    if (found === null) return line;
    this.deps.log.info('art.near', { session: s.id, turn: turn.id, said: near.id, put: found });
    return { ...line, props: { ...(line as { props: StyleProps }).props, near: { ...near, id: found } } } as Line;
  }

  /**
   * v3 art. A label for a part (`near=giraffe1-neck`) of a figure that is still a placeholder has nothing to stand beside: it is held, as the line it
   * is, and shown beside its part when the drawing arrives (`showArt`), or beside the placeholder if the drawing will not come (`dropCaptionOf`).
   */
  private holdsLabel(s: Session, line: Line): boolean {
    const near = 'props' in line ? ((line as { props: StyleProps }).props).near : undefined;
    if (near === undefined || line.verb === 'draw') return false;
    for (const [id, pending] of this.drawings.get(s) ?? []) {
      if (pending.over || pending.shown !== null || !near.id.startsWith(`${id}-`) || near.id === `${id}-soft`.slice(0, 24)) continue;
      pending.labels.push(line);
      this.deps.log.info('art.label_held', { session: s.id, id, near: near.id });
      return true;
    }
    return false;
  }

  /** The held labels pointed at `near` (a part of the drawing, or the figure itself) when `parts` is given and has a better match. */
  private heldLabels(pending: PendingArt, parts: readonly string[] | null): Line[] {
    const id = pending.wanting.id;
    return pending.labels.splice(0).map((line) => {
      const props = (line as { props: StyleProps }).props;
      const near = props.near;
      if (near === undefined) return line;
      const put = parts === null ? id : (bestPart(id, parts, near.id.slice(id.length + 1)) ?? id);
      return { ...line, props: { ...props, near: { ...near, id: put } } } as Line;
    });
  }

  /** v3 art. Asks the studio for a drawing of what the shelf lacks. The `pending` note when it will be made; null when it will not (off, at a ceiling, near the cap), and the note stays `undrawn`. */
  private commissionArt(s: Session, wanting: Wanting): { readonly kind: 'pending'; readonly subject: string } | null {
    const { studio, log } = this.deps;
    if (studio === undefined) return null;
    const pending: PendingArt = { wanting, next: null, final: false, shown: null, delivering: false, labels: [], over: false };
    const accepted = studio.commission(commissionOf(wanting.subject, wanting.words, wanting, wanting.detail), (event) => this.onArt(s, pending, event));
    if (!accepted.ok) {
      log.info('art.not_commissioned', { session: s.id, id: wanting.id, subject: wanting.subject, why: accepted.why });
      return null;
    }
    const held = this.drawings.get(s) ?? new Map<string, PendingArt>();
    // the same figure id said again is a new placeholder: the one before it is let go
    const before = held.get(wanting.id);
    if (before !== undefined) before.over = true;
    held.set(wanting.id, pending);
    this.drawings.set(s, held);
    return { kind: 'pending', subject: wanting.subject };
  }

  private onArt(s: Session, pending: PendingArt, event: StudioEvent): void {
    const { log } = this.deps;
    if (event.kind === 'failed') {
      pending.over = true;
      log.info('art.left_as_placeholder', { session: s.id, id: pending.wanting.id, why: event.why });
      void this.dropCaptionOf(s, pending).catch((error: unknown) => log.error('art.caption_failed', { session: s.id, id: pending.wanting.id, error }));
      return;
    }
    pending.next = event.sheet;
    pending.final = event.kind === 'made';
    void this.deliverArt(s, pending).catch((error: unknown) => log.error('art.delivery_failed', { session: s.id, id: pending.wanting.id, error }));
  }

  /** Why a made drawing cannot be put in its placeholder's place now: `gone` for good (the stage moved on), `wait` for a better moment, null when it can. */
  private artLimit(s: Session, pending: PendingArt): { readonly state: 'gone' | 'wait'; readonly why: string } | null {
    if (pending.over || this.deps.sessions.get(s.id) === undefined || s.abort.signal.aborted) return { state: 'gone', why: 'the session or the figure is gone' };
    const turn = s.turn;
    if (turn === null) return { state: 'gone', why: 'no turn is on the stage' };
    const { id } = pending.wanting;
    const live = (element: string): boolean => turn.score.schedule.elements.some((candidate) => candidate.id === element && candidate.exit === null);
    // a newer scene, or a `drop`, took the placeholder: the drawing stays on the shelf for next time
    if (!live(id) || (pending.shown === null && !live(`${id}-soft`.slice(0, 24)))) return { state: 'gone', why: 'the stage moved on' };
    if (turn.endReason === null) return { state: 'wait', why: 'a turn is still being written' };
    if (turn.endReason !== 'done' || !turn.reported) return { state: 'wait', why: 'the answer has not come to rest' };
    if (s.typingUntil > this.deps.now()) return { state: 'wait', why: 'the person is typing' };
    return null;
  }

  /** A drawing that will not come leaves its placeholder; the caption that said it was coming goes, once the stage is at rest. */
  private async dropCaptionOf(s: Session, pending: PendingArt): Promise<void> {
    const { now } = this.deps;
    const patience = now() + ART_PATIENCE_MS;
    pending.over = false;
    let limit = this.artLimit(s, pending);
    while (limit?.state === 'wait' && now() < patience) {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      limit = this.artLimit(s, pending);
    }
    pending.over = true;
    const turn = s.turn;
    if (limit !== null || turn === null) {
      pending.labels.length = 0;
      return;
    }
    const live = turn.score.schedule.elements.some((element) => element.id === captionId(pending.wanting.id) && element.exit === null);
    // the labels held for its parts are shown beside the placeholder, so that the words are not lost
    const held = this.heldLabels(pending, null);
    if (!live && held.length === 0) return;
    const normalizer = new LineNormalizer(() => {
      s.nextAutoId += 1;
      return `x${s.nextAutoId}`;
    }, Object.keys(s.stage.styles));
    this.showInPlace(s, turn, { kind: 'repair', of: turn.id }, [...(live ? [dropCaption(pending.wanting.id)] : []), ...held].map((line) => ({ type: 'line' as const, line, issues: [] })), normalizer, false);
  }

  /** Puts the latest sheet of a drawing in its place when it is safe to, and says so in the log. One delivery at a time a figure; a newer sheet that arrives meanwhile is the one shown. */
  private async deliverArt(s: Session, pending: PendingArt): Promise<void> {
    if (pending.delivering) return;
    pending.delivering = true;
    const { log, now } = this.deps;
    const id = pending.wanting.id;
    try {
      while (pending.next !== null) {
        const patience = now() + ART_PATIENCE_MS;
        let limit = this.artLimit(s, pending);
        while (limit?.state === 'wait' && now() < patience) {
          await new Promise<void>((resolve) => setTimeout(resolve, 400));
          limit = this.artLimit(s, pending);
        }
        if (limit !== null) {
          log.info('art.kept_for_later', { session: s.id, id, why: limit.why, final: pending.final });
          return;
        }
        const sheet = pending.next;
        pending.next = null;
        const turn = this.showArt(s, pending, sheet);
        log.info('art.shown', { session: s.id, id, turn, parts: sheet.parts.length, final: pending.final, subject: sheet.subject });
      }
    } finally {
      pending.delivering = false;
      if (pending.final && pending.next === null) pending.over = true;
    }
  }

  /** The made drawing as an in-place turn: the placeholder leaves and the parts draw in `in=` the group that is on the stage. Answers the turn's id. */
  private showArt(s: Session, pending: PendingArt, sheet: Sheet): string {
    const turn = s.turn as ActiveTurn;
    const normalizer = new LineNormalizer(() => {
      s.nextAutoId += 1;
      return `x${s.nextAutoId}`;
    }, Object.keys(s.stage.styles));
    const planned = planSwap(pending.wanting, sheet, wearingAt(turn.score.schedule, turn.score.base, turn.score.schedule.pen), pending.shown);
    pending.shown = planned.parts;
    this.figureHas(s, pending.wanting.id, planned.parts);
    // labels said while the drawing was on its way name parts by the brain's guess (`near=giraffe1-neck`): they are pointed at the parts the drawing has
    const labels = turn.score.schedule.elements.flatMap((element) => (element.kind === 'text' && element.exit === null && element.style.near !== null ? [{ id: element.id, near: element.style.near.id, side: element.style.near.side }] : []));
    const pointed = relabel(pending.wanting.id, planned.parts, labels).flatMap((moved) => {
      const parsed = parseLine(`set ${moved.id} near=${moved.near}:${labels.find((label) => label.id === moved.id)?.side ?? 'auto'}`);
      return parsed.kind === 'line' ? [parsed.line] : [];
    });
    if (pointed.length > 0) this.deps.log.info('art.relabel', { session: s.id, id: pending.wanting.id, labels: pointed.length });
    const shown = this.showInPlace(s, turn, { kind: 'repair', of: turn.id }, [...planned.lines, ...this.heldLabels(pending, planned.parts), ...pointed].map((line) => ({ type: 'line' as const, line, issues: [] })), normalizer, false);
    const swap = s.turns.get(shown);
    // what the parts are called goes into the next brief, with the rest of how this turn landed
    if (swap !== undefined) noteArt(swap, pending.wanting.id, { kind: 'drawn', subject: sheet.subject, parts: planned.parts });
    return shown;
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
    case 'observe':
    case 'presence':
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
