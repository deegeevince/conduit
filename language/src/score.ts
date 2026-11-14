import { buildSchedule } from './schedule';
import type { ElementSpan, Schedule, ScheduleOptions, ScoreEntry, StageBase } from './schedule';
import { splitCells } from './text';
import type { Issue, Line, ReviseLine } from './types';
import { CONTROL, LIMITS, STRUCTURE } from './vocabulary';

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
 * How a turn was opened, which is what decides whether the choices an earlier turn offered are still the user's to tap. It is the `kind` of the
 * turn's input (`TurnInput`), or `none` for a score with no turn behind it (a rest, a film, a bench).
 */
export type TurnOpening = 'prompt' | 'tap' | 'act' | 'refine' | 'demo' | 'script' | 'none';

/**
 * D2(c): choices belong to the turn that offered them. When a turn is opened for a prompt, a tap or a control, the choices still on stage
 * leave as the answer's first line arrives (the one that was tapped too). A demo, a script and a refinement are not answers to anyone.
 */
export function retiresChoices(opened: TurnOpening): boolean {
  return opened === 'prompt' || opened === 'tap' || opened === 'act';
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
  private readonly options: ScheduleOptions;
  private readonly opened: TurnOpening;
  private current: Schedule;

  /**
   * `opened` is how the turn began (`input.kind`). The server and the painter both pass it, and must pass the same, or their schedules
   * would disagree about when the choices went.
   */
  constructor(base: StageBase, opened: TurnOpening = 'none') {
    this.base = base;
    this.opened = opened;
    this.options = { retireChoices: retiresChoices(opened), freshControls: opened === 'prompt' || opened === 'script' };
    this.current = buildSchedule([], base, this.options);
  }

  get schedule(): Schedule {
    return this.current;
  }

  /** A copy with the same base, the same opening and the same entries, to push a candidate on without touching this score. */
  fork(): TurnScore {
    const copy = new TurnScore(this.base, this.opened);
    // every entry in order, the voided ones too: pushing them again voids them again, as it did the first time
    for (const entry of this.entries) copy.push(entry.line, entry.seq, entry.floor);
    return copy;
  }

  get score(): readonly ScoreEntry[] {
    return this.entries;
  }

  push(line: Line, seq: number, playhead: number): PushResult {
    const floor = Math.max(0, playhead);
    let outcome: PushOutcome = 'scheduled';
    const issues: Issue[] = [];

    // What is for the server alone (`standing`, `refine`) is not on the score: it is not scheduled and the painter never hears it.
    if (line.verb === 'standing' || line.verb === 'refine') return { outcome: 'ignored', schedule: this.current, issues };

    if (line.verb === 'revise') {
      outcome = this.revise(line, seq, floor, issues);
    } else if (line.verb === 'cancel') {
      outcome = this.cancel(line.id, seq, floor, issues);
    } else {
      this.entries.push({ seq, line, floor, void: false });
    }

    this.current = buildSchedule(this.entries, this.base, this.options);
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
      const edited = revised(origin.line, line);
      if (edited !== null) this.entries[index] = { ...origin, line: edited };
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
    if (line.text !== undefined && element.kind === 'text') this.entries.push({ seq, line: { verb: 'correct', id: line.id, text: line.text }, floor, void: false });
    else if (line.text !== undefined) {
      // Only words are struck through and replaced; the words of a node, a control or a diagram that is already on stage are changed by dropping it and drawing it again.
      issues.push({ code: 'too-late', severity: 'warn', message: `the words of "${line.id}" cannot change once it is shown; drop it and draw it again`, token: line.id });
    }
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

  /** When the line with this `seq` starts in the schedule so far; null when it put nothing on the clock. */
  private startOf(seq: number): number | null {
    let found: number | null = null;
    for (const time of this.current.lines) {
      if (time.seq === seq) found = found === null ? time.start : Math.min(found, time.start);
    }
    return found;
  }

  /**
   * Takes a line out of the score, and with it what cannot stand without it and
   * has not played yet: a structure takes its nodes, rows and their links; a
   * node takes the links that touch it (a chain loses that node and keeps the
   * rest) and lets go of nodes that followed it; a control takes the changes it
   * drives; a group or card takes its parts.
   */
  private retract(index: number, floor: number): void {
    const origin = this.entries[index];
    if (origin === undefined || origin.void) return;
    this.entries[index] = { ...origin, void: true };
    const { line } = origin;
    const id = 'id' in line && typeof line.id === 'string' ? line.id : null;
    if (id === null || id === '-') return;
    const isStructure = Object.hasOwn(STRUCTURE, line.verb);
    const isControl = Object.hasOwn(CONTROL, line.verb);
    this.entries.forEach((entry, at) => {
      if (entry.void || entry.seq <= origin.seq) return;
      const other = entry.line;
      // A part that has been shown stays, and says so when its owner is missing.
      const begins = this.startOf(entry.seq);
      if (begins !== null && begins <= floor) return;
      const inside = other.verb === 'look' || other.verb === 'set' || other.verb === 'bind' || !('props' in other) ? undefined : other.props.in;
      if ((isStructure || line.verb === 'group' || line.verb === 'card') && inside === id) this.retract(at, floor);
      else if (isStructure && other.verb === 'row' && other.id === id) this.retract(at, floor);
      else if (line.verb === 'node' && other.verb === 'link' && other.nodes.includes(id)) {
        const rest = other.nodes.filter((name) => name !== id);
        if (rest.length < 2) this.retract(at, floor);
        else this.entries[at] = { ...entry, line: { ...other, nodes: rest } };
      } else if (line.verb === 'node' && other.verb === 'node' && other.from?.id === id) {
        const { from: _from, ...free } = other;
        this.entries[at] = { ...entry, line: free };
      } else if (other.verb === 'bind' && ((isControl && other.control === id) || (other.change.verb === 'set' ? other.change.target.kind === 'id' && other.change.target.id === id : other.change.id === id))) this.retract(at, floor);
    });
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
      this.retract(index, floor);
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

/** What a line says once `revise` has had its way with it; null when `revise` has nothing to change in it. Only what has not been shown is edited. */
function revised(origin: Line, change: ReviseLine): Line | null {
  const styles = change.styles.length > 0 ? change.styles : undefined;
  switch (origin.verb) {
    case 'say':
      return { ...origin, styles: styles ?? origin.styles, props: { ...origin.props, ...change.props }, text: change.text ?? origin.text };
    case 'correct':
      return change.text === undefined ? null : { ...origin, text: change.text };
    case 'node':
      return { ...origin, styles: styles ?? origin.styles, props: { ...origin.props, ...change.props }, text: change.text ?? origin.text };
    case 'link':
      return { ...origin, props: { ...origin.props, ...change.props }, ...(change.text !== undefined && { text: change.text }) };
    case 'pick': {
      const options = change.text === undefined ? [] : splitCells(change.text).filter((option) => option !== '');
      return { ...origin, styles: styles ?? origin.styles, props: { ...origin.props, ...change.props }, ...(options.length >= 2 && { options: options.slice(0, LIMITS.options) }) };
    }
    case 'button':
    case 'toggle':
    case 'slider':
    case 'input':
      return { ...origin, styles: styles ?? origin.styles, props: { ...origin.props, ...change.props }, ...(change.text !== undefined && { text: change.text }) };
    case 'card':
    case 'flow':
    case 'tree':
    case 'cycle':
    case 'timeline':
    case 'map':
    case 'table':
    case 'chart':
    case 'code':
    case 'tune':
    case 'app':
    case 'screen':
      // The words of a structure or a card are its title.
      return { ...origin, styles: styles ?? origin.styles, props: { ...origin.props, ...change.props }, ...(change.text !== undefined && { title: change.text }) };
    case 'set':
    case 'revise':
    case 'cancel':
    case 'bind':
    case 'row':
    case 'frame':
    case 'wait':
    case 'plan':
    case 'scene':
    case 'style':
    case 'color':
    case 'look':
    case 'move':
    case 'drop':
    case 'hit':
    case 'cam':
    case 'deck':
    case 'standing':
    case 'refine':
      return null;
    default:
      // Anything drawn can be restyled before it is seen; its geometry is changed by declaring it again.
      return { ...origin, styles: styles ?? origin.styles, props: { ...origin.props, ...change.props } };
  }
}
