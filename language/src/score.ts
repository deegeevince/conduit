import { buildSchedule } from './schedule';
import type { ElementSpan, Schedule, ScoreEntry, StageBase } from './schedule';
import type { Issue, Line, ReviseLine, SayLine } from './types';

export type PushOutcome =
  /** placed on the timeline at the pen */
  | 'scheduled'
  /** changed or removed lines that had not played yet */
  | 'edited'
  /** a `revise` that came too late and became a visible `correct` / `set` */
  | 'converted'
  /** had nothing to act on */
  | 'ignored';

export interface PushResult {
  readonly outcome: PushOutcome;
  readonly schedule: Schedule;
  /** semantic problems with this line (unknown id, unknown style, too late) */
  readonly issues: readonly Issue[];
}

/**
 * The lines of one turn and the schedule they add up to.
 *
 * `playhead` is passed with every line because the revision family is defined
 * against it: what is still ahead of the playhead can be edited or cancelled,
 * what is behind it is fixed. The painter passes its real clock; the server
 * passes the last playhead the painter reported, so its copy is an estimate
 * and the painter's is the truth.
 */
export class TurnScore {
  readonly base: StageBase;
  private readonly entries: ScoreEntry[] = [];
  private current: Schedule;

  constructor(base: StageBase) {
    this.base = base;
    this.current = buildSchedule([], base);
  }

  get schedule(): Schedule {
    return this.current;
  }

  get score(): readonly ScoreEntry[] {
    return this.entries;
  }

  push(line: Line, seq: number, playhead: number): PushResult {
    const floor = Math.max(0, playhead);
    let outcome: PushOutcome = 'scheduled';
    const issues: Issue[] = [];

    if (line.verb === 'revise') {
      outcome = this.revise(line, seq, floor, issues);
    } else if (line.verb === 'cancel') {
      outcome = this.cancel(line.id, seq, floor, issues);
    } else {
      this.entries.push({ seq, line, floor, void: false });
    }

    this.current = buildSchedule(this.entries, this.base);
    for (const item of this.current.issues) {
      if (item.seq === seq) issues.push(item.issue);
    }
    return { outcome, schedule: this.current, issues };
  }

  private newestElement(id: string): ElementSpan | null {
    for (let i = this.current.elements.length - 1; i >= 0; i -= 1) {
      const element = this.current.elements[i];
      if (element !== undefined && element.id === id) return element;
    }
    return null;
  }

  private revise(line: ReviseLine, seq: number, floor: number, issues: Issue[]): PushOutcome {
    const element = this.newestElement(line.id);
    if (element === null) {
      issues.push({ code: 'unknown-id', severity: 'warn', message: `nothing called "${line.id}" to revise`, token: line.id });
      this.entries.push({ seq, line, floor, void: true });
      return 'ignored';
    }

    const unplayed = element.enter !== null && element.enter.start > floor;
    const index = this.entries.findIndex((entry) => entry.seq === element.seq && !entry.void);
    const origin = index < 0 ? undefined : this.entries[index];
    if (unplayed && origin !== undefined) {
      if (origin.line.verb === 'say') {
        const edited: SayLine = {
          ...origin.line,
          styles: line.styles.length > 0 ? line.styles : origin.line.styles,
          props: { ...origin.line.props, ...line.props },
          text: line.text ?? origin.line.text,
        };
        this.entries[index] = { ...origin, line: edited };
      } else if (origin.line.verb === 'correct' && line.text !== undefined) {
        this.entries[index] = { ...origin, line: { ...origin.line, text: line.text } };
      } else if ('styles' in origin.line && 'props' in origin.line && origin.line.verb !== 'set' && origin.line.verb !== 'revise') {
        // Anything drawn can be restyled before it is seen; its geometry is changed by declaring it again.
        this.entries[index] = {
          ...origin,
          line: { ...origin.line, styles: line.styles.length > 0 ? line.styles : origin.line.styles, props: { ...origin.line.props, ...line.props } },
        };
      }
      this.entries.push({ seq, line, floor, void: true });
      return 'edited';
    }

    // Too late to be quiet: what has been seen cannot be unseen, so the change is performed.
    issues.push({
      code: 'too-late',
      severity: 'warn',
      message: `"${line.id}" had already played; the revision is shown as a visible change`,
      token: line.id,
    });
    if (line.text !== undefined) this.entries.push({ seq, line: { verb: 'correct', id: line.id, text: line.text }, floor, void: false });
    if (line.styles.length > 0 || Object.keys(line.props).length > 0) {
      this.entries.push({
        seq,
        line: { verb: 'set', target: { kind: 'id', id: line.id }, styles: line.styles, props: line.props },
        floor,
        void: false,
      });
    }
    return 'converted';
  }

  private cancel(id: string | undefined, seq: number, floor: number, issues: Issue[]): PushOutcome {
    if (id !== undefined) {
      const element = this.newestElement(id);
      const index = element === null ? -1 : this.entries.findIndex((entry) => entry.seq === element.seq && !entry.void);
      const origin = index < 0 ? undefined : this.entries[index];
      this.entries.push({ seq, line: { verb: 'cancel', id }, floor, void: true });
      if (element === null || origin === undefined) {
        issues.push({ code: 'unknown-id', severity: 'warn', message: `nothing called "${id}" to cancel`, token: id });
        return 'ignored';
      }
      if (element.enter === null || element.enter.start <= floor) {
        issues.push({ code: 'too-late', severity: 'warn', message: `"${id}" had already played; use drop or correct`, token: id });
        return 'ignored';
      }
      this.entries[index] = { ...origin, void: true };
      return 'edited';
    }

    const startBySeq = new Map<number, number>();
    for (const time of this.current.lines) {
      const known = startBySeq.get(time.seq);
      startBySeq.set(time.seq, known === undefined ? time.start : Math.min(known, time.start));
    }
    let removed = 0;
    this.entries.forEach((entry, index) => {
      // Definitions are not performances: the words, colours and looks the brain defined stay defined.
      if (entry.void || entry.line.verb === 'style' || entry.line.verb === 'color' || (entry.line.verb === 'look' && (entry.line.like !== undefined || Object.keys(entry.line.props).length > 0))) return;
      const start = startBySeq.get(entry.seq);
      if (start !== undefined && start >= floor) {
        this.entries[index] = { ...entry, void: true };
        removed += 1;
      }
    });
    this.entries.push({ seq, line: { verb: 'cancel' }, floor, void: false });
    return removed > 0 ? 'edited' : 'ignored';
  }
}
