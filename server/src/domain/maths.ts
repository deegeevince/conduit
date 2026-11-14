// The exact maths checker, as the server uses it (WS5's verify, and a lesson's `check=working` asks).
//
// The arithmetic is `@conduit/language/maths`: exact rationals (BigInt, never a float), quantities with units, expressions with fractions and
// words ("half of", "less than", "2/3 of"), a step checker, and a lesson check. What is here is the shape the server wants of it: findings that
// drop into verify's `Finding` list, and the counts its `Mechanical` result carries. Nothing here reads a file, a clock or the network, and it
// never throws: a lesson it cannot read is "not recomputed", never refused for that.

import { checkLessonDocument, checkWorking } from '@conduit/language/maths';
import type { AskCheck, LessonCheck, WorkingAsk, WorkingVerdict } from '@conduit/language/maths';
import type { Document, NodeId } from '@conduit/language';

/** The same shape as verify's `Finding` (severity, source, node, ask, why), so a list of these can be pushed straight onto verify's. */
export interface SolverFinding {
  readonly severity: 'refuse' | 'note';
  readonly source: 'solver';
  readonly node: NodeId;
  readonly ask: string | null;
  readonly why: string;
}

export interface MathsCheck {
  /** no refusing finding: nothing the lesson says is wrong in arithmetic */
  readonly ok: boolean;
  readonly findings: readonly SolverFinding[];
  /** every ask of every way, each with what it recomputed to */
  readonly asks: readonly (AskCheck & { readonly node: NodeId })[];
  /** asks recomputed and found to agree */
  readonly confirmed: number;
  /** asks recomputed (agreeing or not) */
  readonly recomputed: number;
  /** every ask looked at */
  readonly total: number;
  /** the question's own answer, when its printed words are a sum the checker reads (the first way's) */
  readonly own: string | null;
  /** one line for the log */
  readonly summary: string;
  readonly detail: LessonCheck;
}

/**
 * Recomputes every ask of a document (or of the part `node` and what is under it) from its words, and checks every sum the page states.
 * `confirmed`, `recomputed` and `findings` are what verify's `Mechanical` result and finding list hold.
 */
export function checkLesson(doc: Document, node?: NodeId): MathsCheck {
  const detail = checkLessonDocument(doc, node);
  const findings: SolverFinding[] = detail.findings.map((f) => ({ severity: f.severity, source: 'solver', node: f.node, ask: f.ask, why: f.why }));
  const first = detail.ways.find((way) => way.question !== null && way.question.computed !== null);
  return {
    ok: detail.ok,
    findings,
    asks: detail.asks,
    confirmed: detail.counts.agree,
    recomputed: detail.counts.agree + detail.counts.mismatch,
    total: detail.counts.asks,
    own: first?.question?.computed ?? null,
    summary: detail.summary,
    detail,
  };
}

/**
 * An ask with `check=working`: her transcribed working (a step to a line) checked step by step, and against the answers the ask accepts.
 * `said` is safe to show her; `detail` is for the brain and the parent's view.
 */
export function checkWorkingSteps(ask: WorkingAsk, working: string | readonly string[]): WorkingVerdict {
  return checkWorking(ask, working);
}
