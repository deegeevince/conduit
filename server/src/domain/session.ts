import { STREAM_HEARTBEAT } from '@conduit/language';
import { Observations } from './observations';
import { DrawingMemory } from './drawing-memory';
import type {
  ActionRisk,
  BackEventRecord,
  Capabilities,
  ClockState,
  ControlValues,
  CriticFinding,
  DataTable,
  LineProblem,
  LineReader,
  ReviewOutcome,
  ScreenFacts,
  StageBase,
  StageEvent,
  TurnEndReason,
  TurnInput,
  TurnMemory,
  TurnScore,
} from '@conduit/language';
import { PROMPT_MAX_CHARS } from '@conduit/language';
import { errors } from '../errors';
import type { Brain, BrainId } from './brain';
import type { HeldDocument } from './documents';
import { createDraftGate } from './review';
import type { DraftGate } from './review';

/** lines remembered as having gone wrong, per turn */
export const MAX_PROBLEMS = 8;

export const SERVER_LIMITS = {
  /** sessions kept in memory; the least recently seen is dropped beyond this */
  sessions: 50,
  /** a session nobody has touched for this long is dropped */
  sessionIdleMs: 30 * 60_000,
  /** back-channel records kept per session */
  events: 500,
  /** earlier turns handed to a brain */
  history: 20,
  /** bytes in an ordinary request body */
  bodyBytes: 64 * 1024,
  /** bytes in a body that may carry a turn report (back events, a turn's pending events): a long turn lists everything it showed */
  reportBytes: 1024 * 1024,
  /** characters in a prompt */
  promptChars: PROMPT_MAX_CHARS,
  /** characters in a script the user plays (input kind `script`) */
  scriptChars: 48_000,
  /** an idle SSE stream gets a comment this often so proxies keep it open */
  heartbeatMs: STREAM_HEARTBEAT.everyMs,
  /** longest a relay long-poll may be held */
  longPollMs: 30_000,
  /** lines a brain may write in one turn before it is cut off */
  linesPerTurn: 1000,
  /** turns per session whose clocks and events can still be asked about */
  turnsKept: 30,
} as const;

/** The last thing the painter said about its clock. */
export interface PainterClock {
  readonly playhead: number;
  readonly pen: number;
  readonly state: ClockState;
  readonly ackSeq: number;
  /** server time the report arrived, ms */
  readonly at: number;
}

export interface ActiveTurn {
  readonly id: string;
  readonly session: string;
  readonly input: TurnInput;
  readonly brain: BrainId;
  /** v2.1 ops. Who asked: the Tailscale login the request carried, or `local` for the owner at the keyboard (`identity.ts`) */
  readonly login: string;
  readonly openedAt: number;
  /** aborting it stops the brain */
  readonly abort: AbortController;
  /** the server's own copy of the schedule: exact for the pen, an estimate wherever the playhead matters */
  readonly score: TurnScore;
  /** set once the brain has stopped writing; the painter may still be playing */
  endReason: TurnEndReason | null;
  clock: PainterClock | null;
  /** ids the painter has reported as shown, in order; the fallback memory if no report ever arrives */
  shownIds: string[];
  /** the turn before this one in its session, or null: its snapshot is what a brain is shown first */
  readonly previous: string | null;
  /** one per turn: it remembers that a sprite is being written, across the relay's calls */
  readonly reader: LineReader;
  /** lines of this turn that were dropped or repaired, newest last, at most `MAX_PROBLEMS` */
  problems: LineProblem[];
  /** the last back-channel cursor handed to a relay agent for this turn */
  relayCursor: number;
  /** position in the session's turns; a later turn has a larger ordinal */
  readonly ordinal: number;
  lineCount: number;
  /** lines of this turn that wrote into the document, and `doc` events it sent: a turn that wrote and sent none still tells the page which document it meant */
  docLines: number;
  docEvents: number;
  /** lines of a part's or ask's own that came before it (an `ask in=q1` before `part q1`): kept until it is written, then read, else refused at the turn's end */
  held: Map<string, { readonly event: unknown; readonly issues: readonly unknown[] }[]>;
  /** lines of this turn that were dropped outright, over every pass: what look-and-fix counts */
  rejects: number;
  /** the user has switched look and fix off for this turn (`x-conduit-review: off`) */
  readonly lookAllowed: boolean;
  /** how look-and-fix went, once it has been considered; it goes into the turn's memory */
  review: ReviewOutcome | undefined;
  /** the memory of this turn is closed: a report arrived, or the next turn replaced it */
  reported: boolean;
  /** the brain ended this turn with `refine | …`: what it will do next, and the server runs it again at once. Undefined when it did not. */
  continueNote?: string;
  /** everything sent to the painter for this turn, so a reconnecting stream can be brought up to date */
  readonly sent: StageEvent[];
  /**
   * v2.1. What was sent while no painter was listening. A reconnecting stream is given the turn again, but not the passes and the data
   * it already had (P2-34); these it had not.
   */
  readonly missed: StageEvent[];
  /** v2.1. The file the resting snapshot was saved under beside the log, once it has arrived; what the critic looks at */
  snapshotFile: string | null;
  /** v2.1. The critic has been asked about this turn (or will never be) */
  criticAsked: boolean;
  /** v3. Lines of the lesson the reader refused this turn, and why: said once to the brain, in this turn, to be written again */
  readonly refused: { readonly raw: string; readonly why: string }[];
  /** v3. The reader's refusals were already put to the brain once */
  amended: boolean;
  /** v3. When the brain stopped writing (`finish`), server time; null while it writes */
  endedAt: number | null;
  /** v2.1 ops. Tool calls begun and not yet ended, by the CLI's call id: what the audit trail records when a call ends, or when the turn does first */
  readonly calls: Map<string, { readonly tool: string; readonly summary: string; asked: boolean }>;
}

/** v2.1. A confirm control on the stage that the owner has not answered: the brain holds the call until `permit`, or the deadline says no. */
export interface PendingPermission {
  readonly request: string;
  readonly turn: string;
  readonly brain: Brain;
  readonly tool: string;
  readonly summary: string;
  readonly risk: ActionRisk;
  readonly askedAt: number;
  readonly timer: NodeJS.Timeout;
}

export type StageSink = (event: StageEvent) => void;

export interface Session {
  readonly id: string;
  readonly createdAt: number;
  lastSeenAt: number;
  screen: ScreenFacts;
  capabilities: Capabilities;
  /** the stage as the painter last reported it at rest */
  stage: StageBase;
  /** earlier turns as they were SHOWN, oldest first */
  history: TurnMemory[];
  /** the turn being written or still playing */
  turn: ActiveTurn | null;
  /** the back-channel log, oldest first, bounded by SERVER_LIMITS.events */
  events: BackEventRecord[];
  nextCursor: number;
  /** line sequence numbers increase over the whole session */
  nextSeq: number;
  nextAutoId: number;
  /** the painter's open stream, if it is connected */
  sink: StageSink | null;
  /** closes the open stream's connection */
  closeSink: (() => void) | null;
  /** recent turns by id, oldest first; the latest is `turn` */
  turns: Map<string, ActiveTurn>;
  nextOrdinal: number;
  /** back-channel cursor when the latest turn opened: taps after it are what the next turn hears */
  heardFrom: number;
  /** set once the configured brain has been told to get ready for this conversation */
  preparedFor: string;
  /** paintings that settled while no painter was listening; sent when one connects */
  lateAssets: StageEvent[];
  /** paintings asked of the image model so far */
  paintings: number;
  /** what the user gave the brain to read, oldest first; every turn's brief draws on it */
  documents: HeldDocument[];
  nextDocument: number;
  /** rows a chart draws by reference (`data=d1`), oldest first, at most `DATA_LIMITS.tables` */
  tables: DataTable[];
  nextTable: number;
  /** where the painter's report on a draft is waited for */
  readonly draft: DraftGate;
  /** SA2. What the user last set each control to, by element id: an input to the server's own measurement */
  held: ControlValues;
  /** SA2. Why this session's drafts are no longer measured here (the page's engine or a digest differed); null while they are */
  drift: string | null;
  /** SA2. The digest of a pass's boxes as the server and the page each said it, by `turn#pass` (or `turn#report`); compared when both are in */
  readonly boxes: Map<string, { page?: string; server?: string }>;
  /** turns a snapshot has been uploaded for */
  snapshotTurns: Set<string>;
  /** aborted when the session is dropped: stops paintings that outlive their turns */
  readonly abort: AbortController;
  /** v2.1. What the user asked to hold on every reply, oldest first, at most `STANDING_LIMITS.asks` */
  standing: string[];
  /** v2.1. What the critic made of each turn, by turn id; bounded like the turns themselves */
  readonly findings: Map<string, CriticFinding>;
  /** critic v2. Turns in which each gate failed, by gate id: counted by the server so a gate that keeps failing is seen to (never by the judge) */
  readonly gateFails: Map<string, string[]>;
  /** v2.1. Confirm controls waiting for the owner, by request id */
  readonly permissions: Map<string, PendingPermission>;
  /** v2.1. A returning conversation: its id, and the short account the brain is given of it. Null for a conversation that began here. */
  continued: { readonly id: string; readonly earlier: string } | null;
  /** SA3. What the session has seen and been told, as observations */
  readonly obs: Observations;
  /** v3. The person is typing until this server time (`presence`); 0 when they are not. A repair never starts while it is in the future. */
  typingUntil: number;
  /** v3. Whether the person allows repairs (`/review repair`); on until the page says off */
  repairOn: boolean;
  /** v3. The repair waiting or running, of the answer `of`; any new turn aborts it */
  repair: { readonly of: string; readonly abort: AbortController } | null;
  /** The brain's own continuation, waiting for the stage to rest before it is started; a message from the person, Stop and a new turn end it */
  continuing: { readonly of: string; readonly abort: AbortController } | null;
  /** v3. Answers a repair was started for: one each, kept or not */
  readonly repaired: Set<string>;
  /** Every accepted line of a drawing by turn, and a version for each turn that changed it: what `restore`, `use … from=` and `/undo` bring back */
  memory: DrawingMemory;
}

/** In-memory sessions. There is no database; a restart forgets everything, by design. */
export class SessionStore {
  /** called for a session dropped to make room; the owner aborts its turn */
  onDrop: ((session: Session) => void) | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly turnIndex = new Map<string, string>();
  private sessionCounter = 0;
  private turnCounter = 0;

  create(screen: ScreenFacts, capabilities: Capabilities, now: number, stage: StageBase): Session {
    while (this.sessions.size >= SERVER_LIMITS.sessions) {
      let oldest: Session | undefined;
      for (const candidate of this.sessions.values()) {
        if (oldest === undefined || candidate.lastSeenAt < oldest.lastSeenAt) oldest = candidate;
      }
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    this.sessionCounter += 1;
    const session: Session = {
      id: `c${this.sessionCounter}`,
      createdAt: now,
      lastSeenAt: now,
      screen,
      capabilities,
      stage,
      history: [],
      turn: null,
      events: [],
      nextCursor: 1,
      nextSeq: 1,
      nextAutoId: 0,
      sink: null,
      closeSink: null,
      turns: new Map(),
      nextOrdinal: 1,
      heardFrom: 0,
      preparedFor: '',
      documents: [],
      nextDocument: 1,
      tables: [],
      nextTable: 1,
      draft: createDraftGate(),
      lateAssets: [],
      paintings: 0,
      held: {},
      drift: null,
      boxes: new Map(),
      snapshotTurns: new Set(),
      abort: new AbortController(),
      standing: [],
      findings: new Map(),
      gateFails: new Map(),
      permissions: new Map(),
      continued: null,
      obs: new Observations(),
      typingUntil: 0,
      repairOn: true,
      repair: null,
      continuing: null,
      repaired: new Set(),
      memory: new DrawingMemory(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Throws `not_found` when the session does not exist. Marks it as seen. */
  require(id: string, now: number): Session {
    const session = this.sessions.get(id);
    if (session === undefined) throw errors.notFound(`session ${id}`);
    session.lastSeenAt = now;
    return session;
  }

  findByTurn(turn: string): Session | undefined {
    const id = this.turnIndex.get(turn);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  /** Turn ids are handed out from here; after a restart they begin again, so a log taken up again keeps its own ids by starting above them. */
  reserveTurns(upTo: number): void {
    if (upTo > this.turnCounter) this.turnCounter = upTo;
  }

  nextTurnId(): string {
    this.turnCounter += 1;
    return `t${this.turnCounter}`;
  }

  indexTurn(session: Session, turn: ActiveTurn): void {
    session.turns.set(turn.id, turn);
    this.turnIndex.set(turn.id, session.id);
    while (session.turns.size > SERVER_LIMITS.turnsKept) {
      const oldest = session.turns.keys().next();
      if (oldest.done === true) break;
      session.turns.delete(oldest.value);
      this.turnIndex.delete(oldest.value);
    }
  }

  /** Drops sessions idle past SERVER_LIMITS.sessionIdleMs and returns them so their turns can be aborted. A connected painter is not idle. */
  reap(now: number): Session[] {
    const dropped: Session[] = [];
    for (const session of [...this.sessions.values()]) {
      if (session.sink === null && now - session.lastSeenAt > SERVER_LIMITS.sessionIdleMs) {
        this.remove(session);
        dropped.push(session);
      }
    }
    return dropped;
  }

  all(): readonly Session[] {
    return [...this.sessions.values()];
  }

  /** Removes every session without calling `onDrop`; for shutdown. */
  clear(): Session[] {
    const all = [...this.sessions.values()];
    for (const session of all) this.remove(session);
    return all;
  }

  private drop(session: Session): void {
    this.remove(session);
    this.onDrop?.(session);
  }

  private remove(session: Session): void {
    this.sessions.delete(session.id);
    for (const id of session.turns.keys()) this.turnIndex.delete(id);
  }
}
