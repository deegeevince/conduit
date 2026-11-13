import { settle, shownAt } from '@conduit/language';
import type { BackEvent, ClockState, ElementSpan, PlacedBox, Schedule, Sight, StageBase, TurnReport } from '@conduit/language';

/** Minimum gap between two `progress` events while nothing but the playhead changes. */
export const PROGRESS_INTERVAL_MS = 500;

/** A visible moment of an element, in the order the playhead reached it. */
export interface Milestone {
  readonly kind: 'shown' | 'struck' | 'gone';
  readonly time: number;
  readonly element: ElementSpan;
}

/**
 * Writes the back channel. It watches the playhead cross element entrances
 * and exits and says so exactly once each, however the clock is paused, held
 * or sought: reports follow the furthest point the playhead has reached and
 * are never retracted.
 */
export class Reporter {
  private readonly emit: (event: BackEvent) => void;
  private turn: string | null = null;
  private frontier = 0;
  private started = false;
  private lastClock: ClockState | null = null;
  private lastAck = 0;
  private lastProgressMs = Number.NEGATIVE_INFINITY;
  private readonly shown = new Set<string>();
  private readonly struck = new Set<string>();
  private readonly gone = new Set<string>();
  private pendingShown: string[] = [];
  private pendingGone: string[] = [];

  constructor(emit: (event: BackEvent) => void) {
    this.emit = emit;
  }

  openTurn(turn: string): void {
    this.turn = turn;
    this.frontier = 0;
    this.started = false;
    this.lastClock = null;
    this.lastAck = 0;
    this.lastProgressMs = Number.NEGATIVE_INFINITY;
    this.shown.clear();
    this.struck.clear();
    this.gone.clear();
    this.pendingShown = [];
    this.pendingGone = [];
  }

  /**
   * Called every frame and after every ingested line. Emits `started` once,
   * then `progress` when the clock state changes, when a line is acknowledged,
   * when something is newly shown or gone, or every PROGRESS_INTERVAL_MS.
   * Returns what the playhead newly crossed, for the transcript.
   */
  observe(schedule: Schedule, retired: ReadonlyMap<string, number>, playhead: number, clock: ClockState, ackSeq: number, nowMs: number, pen: number = schedule.pen): Milestone[] {
    const turn = this.turn;
    if (turn === null) return [];
    this.frontier = Math.max(this.frontier, playhead);
    const milestones = this.cross(schedule, retired);

    if (!this.started && ackSeq > 0) {
      this.started = true;
      this.emit({ type: 'started', turn });
    }
    if (!this.started) return milestones;

    const changed = clock !== this.lastClock || ackSeq !== this.lastAck || this.pendingShown.length > 0 || this.pendingGone.length > 0;
    const due = nowMs - this.lastProgressMs >= PROGRESS_INTERVAL_MS && (clock === 'playing' || clock === 'holding');
    if (changed || due) {
      this.emit({
        type: 'progress',
        turn,
        playhead,
        pen,
        clock,
        ackSeq,
        shown: this.pendingShown,
        gone: this.pendingGone,
      });
      this.pendingShown = [];
      this.pendingGone = [];
      this.lastClock = clock;
      this.lastAck = ackSeq;
      this.lastProgressMs = nowMs;
    }
    return milestones;
  }

  private cross(schedule: Schedule, retired: ReadonlyMap<string, number>): Milestone[] {
    const found: Milestone[] = [];
    const reach = this.frontier;
    for (const element of schedule.elements) {
      if (element.enter !== null && element.enter.start < reach && !this.shown.has(element.key)) {
        this.shown.add(element.key);
        this.pendingShown.push(element.id);
        found.push({ kind: 'shown', time: element.enter.start, element });
      }
      for (const change of element.changes) {
        if (change.kind === 'strike' && change.start <= reach && !this.struck.has(element.key)) {
          this.struck.add(element.key);
          found.push({ kind: 'struck', time: change.start, element });
        }
      }
      const early = retired.get(element.key);
      const leaves = early !== undefined ? early : element.exit?.start;
      if (leaves !== undefined && leaves <= reach && !this.gone.has(element.key)) {
        this.gone.add(element.key);
        this.pendingGone.push(element.id);
        found.push({ kind: 'gone', time: leaves, element });
      }
    }
    return found.sort((a, b) => a.time - b.time);
  }

  /** Builds and emits the turn's report: what was shown up to `playhead`, the stage as it now rests, how it landed, and where the viewer skipped. */
  close(
    schedule: Schedule,
    retired: ReadonlyMap<string, number>,
    base: StageBase,
    playhead: number,
    outcome: TurnReport['outcome'],
    landing: { readonly sight: (at: number) => Sight; readonly placed: (at: number, keys: ReadonlySet<string>) => (PlacedBox & { readonly key: string })[]; readonly skippedAt: number | null },
  ): TurnReport {
    const at = reportAt(outcome, playhead);
    const settled = withoutRetired(settle(schedule, base, at), retired, at);
    const placed = landing.placed(at, new Set(settled.elements.map((element) => element.key)));
    const byKey = new Map(placed.map((item) => [item.key, item.box]));
    // Each thing the stage carries on says where it really is, for the brief.
    const stage: StageBase = { ...settled, elements: settled.elements.map((element) => ({ ...element, ...(byKey.has(element.key) ? { placed: byKey.get(element.key) } : {}) })) };
    const report: TurnReport = {
      turn: this.turn ?? '',
      outcome,
      playhead,
      shown: shownAt(schedule, at),
      stage,
      sight: landing.sight(at),
      skippedAt: landing.skippedAt,
      placed: placed.map(({ key: _key, ...item }) => item),
    };
    this.emit({ type: 'report', report });
    this.turn = null;
    return report;
  }
}

/** The instant a report is about: a finished turn has shown everything that began at or before its last instant. */
export function reportAt(outcome: TurnReport['outcome'], playhead: number): number {
  return outcome === 'finished' ? playhead + 1e-6 : playhead;
}

/** The painter's early retirements are not in the schedule, so `settle` still carries them; they are gone as far as the next turn is concerned. */
function withoutRetired(stage: StageBase, retired: ReadonlyMap<string, number>, at: number): StageBase {
  if (retired.size === 0) return stage;
  return { ...stage, elements: stage.elements.filter((element) => (retired.get(element.key) ?? Number.POSITIVE_INFINITY) > at) };
}
