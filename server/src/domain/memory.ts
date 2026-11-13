import { LEAD_WINDOW, describeFigure } from '@conduit/language';
import type { BackEventRecord, Services, ShownItem, TurnContext, TurnMemory, TurnReport } from '@conduit/language';
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
  };
}

/**
 * Turns a finished or interrupted turn into memory. Memory is what was SHOWN:
 * the painter's report when there is one, otherwise the ids it had reported
 * shown so far matched against the server's own schedule, otherwise nothing.
 * What the brain wrote but nobody saw is never remembered.
 */
export function rememberTurn(turn: ActiveTurn, report: TurnReport | null, snapshot: boolean): TurnMemory {
  if (report !== null) {
    return {
      turn: turn.id,
      input: turn.input,
      outcome: report.outcome,
      playhead: report.playhead,
      shown: report.shown,
      sight: report.sight,
      skippedAt: report.skippedAt,
      problems: [...turn.problems],
      snapshot,
    };
  }
  const unreported = { sight: null, skippedAt: null, problems: [...turn.problems], snapshot } as const;
  const shown: ShownItem[] = [];
  for (const id of turn.shownIds) {
    const span = turn.score.schedule.elements.find((element) => element.id === id && !element.carried);
    if (span !== undefined) shown.push({ id, kind: span.kind, text: span.figure === null ? span.text : describeFigure(span.figure), struck: false, partial: false });
  }
  if (shown.length === 0) {
    const failed = turn.endReason === 'failed' || turn.endReason === 'timeout';
    return { turn: turn.id, input: turn.input, outcome: failed ? 'failed' : 'unseen', playhead: null, shown: [], ...unreported };
  }
  return { turn: turn.id, input: turn.input, outcome: 'interrupted', playhead: turn.clock?.playhead ?? null, shown, ...unreported };
}

/** Taps the painter reported since the previous turn opened; they go into the next turn's context. */
export function heardSince(session: Session, cursor: number): BackEventRecord[] {
  return session.events.filter((record) => record.cursor > cursor && record.event.type === 'tap');
}
