import { LEAD_WINDOW, STANDING_LIMITS, describeFigure, owedFrom, owedStanding, shownMaths } from '@conduit/language';
import { withArtNotes } from '../art/notes';
import type { BackEventRecord, CriticFinding, OwedFinding, ReviewOutcome, Services, ShownItem, TurnContext, TurnMemory, TurnReport } from '@conduit/language';
import type { ActiveTurn, Session } from './session';
import { SERVER_LIMITS } from './session';

/** Everything a brain is told when a turn opens. Pure: reads the session, changes nothing. */
export function buildContext(session: Session, services: Services): TurnContext {
  return {
    screen: session.screen,
    capabilities: session.capabilities,
    services,
    lead: LEAD_WINDOW,
    stage: session.stage,
    history: session.history.slice(-SERVER_LIMITS.history),
    heard: heardSince(session, session.heardFrom),
    // What the user asked to hold: given back in every brief, so a later turn cannot forget it.
    ...(session.standing.length > 0 ? { standing: [...session.standing] } : {}),
    ...(session.continued === null ? {} : { earlier: session.continued.earlier }),
    ...(session.memory.versions.length > 0 ? { drawingMemory: session.memory.index() } : {}),
  };
}

/** What the brain wrote about a standing ask: a new one, or one to forget (by its number in `/asks`, from 1). */
export type StandingAsk = { readonly kind: 'add'; readonly words: string } | { readonly kind: 'drop'; readonly n: number };

/**
 * Reads `standing | <their words>` and `standing drop <n>` from a line's text, or null when it is neither. Works from text, so it holds
 * whether the parser sends the line as a line or as a reject: the conductor consumes these lines and never forwards them.
 */
export function parseStanding(text: string): StandingAsk | null {
  const raw = text.trim();
  const drop = /^standing\s+drop\s+(\d{1,2})\s*$/i.exec(raw);
  if (drop !== null) return { kind: 'drop', n: Number(drop[1]) };
  const add = /^standing\s*\|\s*(.+)$/is.exec(raw);
  const words = add?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return words === '' ? null : { kind: 'add', words: words.length > STANDING_LIMITS.chars ? `${words.slice(0, STANDING_LIMITS.chars - 1)}…` : words };
}

/** Keeps a standing ask for the conversation: the same words twice are one, and the oldest goes when a seventh comes. Returns what is now held. */
export function holdStanding(session: Session, ask: StandingAsk): readonly string[] {
  if (ask.kind === 'drop') {
    if (ask.n >= 1 && ask.n <= session.standing.length) session.standing.splice(ask.n - 1, 1);
    return session.standing;
  }
  const same = session.standing.findIndex((held) => held.toLowerCase() === ask.words.toLowerCase());
  if (same >= 0) session.standing.splice(same, 1);
  session.standing.push(ask.words);
  while (session.standing.length > STANDING_LIMITS.asks) session.standing.shift();
  return session.standing;
}

/**
 * Turns a finished or interrupted turn into memory. Memory is what was SHOWN:
 * the painter's report when there is one, otherwise the ids it had reported
 * shown so far matched against the server's own schedule, otherwise nothing.
 * What the brain wrote but nobody saw is never remembered.
 */
export function rememberTurn(turn: ActiveTurn, report: TurnReport | null, snapshot: boolean, maths = false): TurnMemory {
  if (report !== null) {
    return {
      turn: turn.id,
      input: turn.input,
      outcome: report.outcome,
      playhead: report.playhead,
      shown: report.shown,
      sight: withArtNotes(turn, report.sight),
      skippedAt: report.skippedAt,
      problems: [...turn.problems],
      snapshot,
      ...reviewOf(turn),
      ...(maths || shownMaths(report.shown) ? { maths: true } : {}),
    };
  }
  const unreported = { sight: null, skippedAt: null, problems: [...turn.problems], snapshot, ...reviewOf(turn) } as const;
  const shown: ShownItem[] = [];
  for (const id of turn.shownIds) {
    const span = turn.score.schedule.elements.find((element) => element.id === id && !element.carried);
    if (span !== undefined) shown.push({ id, kind: span.kind, text: span.figure === null ? span.text : describeFigure(span.figure), struck: false, partial: false });
  }
  // (a turn the person never saw was still about sums if they asked: the next turn is told)
  const about = maths || shownMaths(shown) ? ({ maths: true } as const) : {};
  if (shown.length === 0) {
    const failed = turn.endReason === 'failed' || turn.endReason === 'timeout';
    return { turn: turn.id, input: turn.input, outcome: failed ? 'failed' : 'unseen', playhead: null, shown: [], ...unreported, ...about };
  }
  return { turn: turn.id, input: turn.input, outcome: 'interrupted', playhead: turn.clock?.playhead ?? null, shown, ...unreported, ...about };
}

function reviewOf(turn: ActiveTurn): { review?: ReviewOutcome } {
  return turn.review === undefined ? {} : { review: turn.review };
}

/** What the painter reported since the previous turn opened: taps, and the controls the user worked; they go into the next turn's context. */
export function heardSince(session: Session, cursor: number): BackEventRecord[] {
  return session.events.filter((record) => record.cursor > cursor && (record.event.type === 'tap' || record.event.type === 'control'));
}


/** The most findings a conversation holds owed, and the most briefs that tell one: past two, it was not to be mended by words. */
const OWED_KEPT = 8;
const OWED_TOLD = 2;

/**
 * Keeps the critic's blocking findings of an answer that nothing mended (its repair was skipped because a newer turn is on stage, or was
 * refused, or failed), so the brain is told of them at its next turn. One answer's findings replace its earlier ones. Answers what was kept.
 */
export function oweFindings(session: Pick<Session, 'owed'>, turn: string, finding: Pick<CriticFinding, 'problems'>): OwedFinding[] {
  const owed = owedFrom(turn, finding);
  if (owed.length === 0) return owed;
  session.owed = session.owed.filter((item) => item.finding.turn !== turn);
  for (const one of owed) session.owed.push({ finding: one, told: 0 });
  while (session.owed.length > OWED_KEPT) session.owed.shift();
  return owed;
}

/**
 * What the next brief says is still broken: findings whose element is still on stage (or that name none), told at most twice each.
 * Counts the telling, so call it once, when a turn's brief is built.
 */
export function owedToTell(session: Pick<Session, 'owed' | 'stage'>): OwedFinding[] {
  if (session.owed.length === 0) return [];
  const live = new Set(session.stage.elements.map((element) => element.id));
  session.owed = session.owed.filter((item) => item.told < OWED_TOLD && (item.finding.id === null || live.has(item.finding.id)));
  const told = owedStanding(session.owed.map((item) => item.finding), live);
  for (const item of session.owed) if (told.includes(item.finding)) item.told += 1;
  return told;
}
