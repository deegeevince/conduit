import type {
  BackEventRecord,
  Capabilities,
  ClockState,
  LineProblem,
  LineReader,
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
import type { BrainId } from './brain';
import type { HeldDocument } from './documents';

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
  heartbeatMs: 15_000,
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
  /** the memory of this turn is closed: a report arrived, or the next turn replaced it */
  reported: boolean;
  /** everything sent to the painter for this turn, so a reconnecting stream can be brought up to date */
  readonly sent: StageEvent[];
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
  /** turns a snapshot has been uploaded for */
  snapshotTurns: Set<string>;
  /** aborted when the session is dropped: stops paintings that outlive their turns */
  readonly abort: AbortController;
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
      lateAssets: [],
      paintings: 0,
      snapshotTurns: new Set(),
      abort: new AbortController(),
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
