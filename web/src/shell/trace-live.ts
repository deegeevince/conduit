// The live side of "how it was made": a turn's trace, grown from the stage events as they arrive. The same shape the server folds from a log
// (`TurnTrace`), so a reply reads the same while it is made and after. When the turn has ended the page asks the server for the log's own version.

import { EMPTY_TRACE } from '@conduit/language';
import type { StageEvent, TraceTool, TurnTrace } from '@conduit/language';

export interface LiveTrace {
  /** takes an event of this turn; returns true when the trace changed */
  take(event: StageEvent, now: number): boolean;
  snapshot(): TurnTrace;
  /** ms from the turn's opening */
  elapsed(now: number): number;
  /** the brain the reply is made with, when the page knows it */
  setBrain(brain: TurnTrace['brain']): void;
}

export function startTrace(openedAt: number, brain: TurnTrace['brain']): LiveTrace {
  let trace: TurnTrace = { ...EMPTY_TRACE, brain };
  let pass = 1;
  const at = (now: number): number => Math.max(0, now - openedAt);
  const set = (next: Partial<TurnTrace>): true => {
    trace = { ...trace, ...next };
    return true;
  };
  return {
    elapsed: (now) => at(now),
    snapshot: () => trace,
    setBrain(next) {
      trace = { ...trace, brain: next };
    },
    take(event, now) {
      switch (event.type) {
        case 'reading':
          return set({ readings: [...trace.readings, { at: at(now), label: event.label, state: event.state, message: event.message }] });
        case 'line':
          return set({ lines: [...trace.lines, { at: at(now), text: event.text, pass }] });
        case 'reject':
          return set({ rejects: [...trace.rejects, { at: at(now), raw: event.raw, why: event.issues.map((issue) => issue.message) }] });
        case 'pass':
          if (event.state === 'fixing' || event.state === 'refining') pass = event.pass;
          if (event.state === 'drafted') pass = event.pass;
          return set({ passes: [...trace.passes, { at: at(now), pass: event.pass, state: event.state, reason: event.reason }] });
        case 'candidate':
          return set({ fixes: [...trace.fixes, { at: at(now), pass: event.pass, form: 'fix', lines: event.lines, shown: null, why: null }] });
        case 'activity': {
          const held = trace.tools.find((tool) => tool.id === event.id);
          const next: TraceTool = { id: event.id, at: held?.at ?? at(now), tool: event.tool, summary: event.summary, state: event.state, ms: event.ms ?? held?.ms ?? null };
          return set({ tools: held === undefined ? [...trace.tools, next] : trace.tools.map((tool) => (tool.id === event.id ? next : tool)) });
        }
        case 'permission':
          return set({ asks: [...trace.asks, { at: at(now), tool: event.tool, summary: event.summary, risk: event.risk, allow: null }] });
        case 'critic':
          return set({
            critic: {
              at: at(now),
              coherence: event.finding.coherence,
              readable: event.finding.readable,
              asked: event.finding.asked,
              problems: event.finding.problems.map((problem) => ({ what: problem.what, weight: problem.weight })),
              suggestions: event.finding.suggestions,
              model: event.finding.model,
              costUsd: event.finding.costUsd,
            },
          });
        case 'end':
          return set({ end: { at: at(now), reason: event.reason, message: event.message } });
        default:
          return false;
      }
    },
  };
}
