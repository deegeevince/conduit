// Verify a lesson with real arithmetic: for every `ask`, recompute the answer from the ask's own words (or, failing that, from the question it
// belongs to or the steps before it), and say whether the answers it accepts agree. Every sum the page states in its words (a step saying
// "5 x 12 = 60") is checked too.
//
// Three outcomes for an ask. `agree`: recomputed, and it is what the ask accepts. `mismatch`: recomputed from a shape this reads with no doubt,
// and the ask accepts something else. `unchecked`: the words are not a shape this reads, so nothing is claimed either way. Only a mismatch
// is a finding. A lesson this cannot read is never refused for that.

import { nodeOf, pathOf } from '../document';
import type { DocNode, Document, NodeId } from '../document';
import type { LessonAsk, LessonContext, LessonStep } from '../lesson';
import { agrees, answerText, isText, parseAnswer, sameAnswer, askUnit } from './answer';
import type { Answer } from './answer';
import { fragments, solveQuestion, statementsIn } from './solve';
import type { Solved } from './solve';
import { stripLabel } from './steps';

export type AskStatus = 'agree' | 'mismatch' | 'unchecked';

export interface AskCheck {
  /** the ask's id in its way */
  readonly ask: string;
  readonly status: AskStatus;
  /** what the recomputation read: the ask's own words, the question it is under, or the steps before it */
  readonly source: 'prompt' | 'question' | 'steps' | null;
  /** the answer worked out, as text; null when nothing was */
  readonly computed: string | null;
  readonly accepted: readonly string[];
  /** one sentence: why they agree, or how they differ */
  readonly reason: string;
  /** the arithmetic, a line each */
  readonly working: readonly string[];
  /** the reading had no doubt in it */
  readonly sure: boolean;
}

export interface MathFinding {
  /** `refuse`: what the page says is wrong; `note`: worth knowing */
  readonly severity: 'refuse' | 'note';
  readonly node: NodeId;
  /** the ask it is about, by its id in its way */
  readonly ask: string | null;
  readonly where: 'ask' | 'question' | 'step' | 'hint' | 'pick';
  readonly why: string;
}

export interface WayCheck {
  readonly node: NodeId;
  readonly asks: readonly AskCheck[];
  readonly findings: readonly MathFinding[];
  /** the question the way answers, as printed, and what it works out to when it is a sum */
  readonly question: { readonly text: string; readonly computed: string | null } | null;
}

type Cmp = 'same' | 'different' | 'unknown';

function compareAccepted(accepted: string, answers: readonly Answer[], unit: string | null): Cmp {
  const clockAnswer = answers.some((a) => !Array.isArray(a) && !isText(a) && (a as { t: string }).t === 'clock');
  // `9.20` for 9:20 is how a child writes a time
  const written = clockAnswer && /^\s*\d{1,2}\.\d{2}\s*$/.test(accepted) ? accepted.replace('.', ':') : accepted;
  const parsed = parseAnswer(written);
  if (parsed === null) return 'unknown';
  const u = askUnit(unit);
  if (answers.some((a) => sameAnswer(parsed, a, u))) return 'same';
  const parsedText = isText(parsed);
  if (parsedText !== answers.every(isText)) return 'unknown';
  return 'different';
}

function summarise(statuses: readonly Cmp[]): AskStatus {
  if (statuses.includes('different')) return 'mismatch';
  return statuses.includes('same') ? 'agree' : 'unchecked';
}

const quote = (text: string): string => `"${text.length > 70 ? `${text.slice(0, 69)}…` : text}"`;
const list = (answers: readonly Answer[]): string => answers.map(answerText).join(' or ');

/**
 * An ordering ask (`check=order`): `accepted` is the sequence. When the words say which way ("smallest to largest", "greatest first") and every item is a
 * plain number, the sequence is held to it exactly; null when it is right or cannot be told, a sentence when it is not.
 */
export function orderProblem(prompt: string, items: readonly string[]): { readonly checked: boolean; readonly problem: string | null } {
  const numbers = items.map((item) => (/^-?\d[\d,]*(?:\.\d+)?$/.test(item.trim()) ? Number(item.replace(/,/g, '')) : Number.NaN));
  if (numbers.length < 2 || numbers.some((n) => !Number.isFinite(n))) return { checked: false, problem: null };
  const small = /\b(?:smallest|least|lowest|fewest|ascending)\b/i.exec(prompt);
  const large = /\b(?:largest|greatest|biggest|highest|most|descending)\b/i.exec(prompt);
  const first = small !== null && (large === null || small.index < large.index) ? 'small' : large !== null ? 'large' : null;
  if (first === null) return { checked: false, problem: null };
  const sorted = [...numbers].sort((a, b) => (first === 'small' ? a - b : b - a));
  const wrong = sorted.some((n, i) => n !== numbers[i]);
  return { checked: true, problem: wrong ? `the items are listed ${items.join(', ')}, which is not ${first === 'small' ? 'smallest to largest' : 'largest to smallest'} (that is ${sorted.join(', ')})` : null };
}

/** The open sums in some words (`12 + 12 so far`): what the steps before an ask were working towards. */
function openSumIn(words: string): Solved | null {
  const open = fragments(words).filter((f) => f.kind === 'question');
  const last = open[open.length - 1];
  if (last === undefined) return null;
  return solveQuestion(last.source);
}

/** Every ask of one way (a lesson's steps), against what it recomputes to. `context` is the question the way answers. */
export function checkWay(node: NodeId, steps: readonly LessonStep[], context: LessonContext): WayCheck {
  const findings: MathFinding[] = [];
  const asks: AskCheck[] = [];
  const titles = context.question.map((t) => stripLabel(t)).filter((t) => t !== '');
  const questionText = titles[titles.length - 1] ?? null;
  const questionSolved = questionText === null ? null : solveQuestion(questionText);
  const note = (where: MathFinding['where'], ask: string | null, why: string, severity: MathFinding['severity'] = 'refuse'): void => void findings.push({ severity, node, ask, where, why });

  // what the page states in its own words must be so
  const statements = (text: string, where: MathFinding['where'], ask: string | null, label: string): void => {
    for (const s of statementsIn(text)) {
      if (s.result.verdict === 'wrong') note(where, ask, `${label} says ${quote(s.source)}, and ${s.result.said}`);
    }
  };
  if (questionText !== null) statements(questionText, 'question', null, 'the question');

  steps.forEach((step, index) => {
    if (step.kind === 'step') {
      statements(step.words, 'step', step.id, `step ${step.id}`);
      return;
    }
    const ask: LessonAsk = step;
    statements(ask.prompt, 'ask', ask.id, `ask ${ask.id}`);
    ask.hints.forEach((hint, h) => statements(hint, 'hint', ask.id, `hint ${h + 1} of ${ask.id}`));

    if (ask.check === 'order') {
      // the ask's own words say which way; failing that, the question's
      const own = orderProblem(ask.prompt, ask.accepted);
      const ordered = own.checked || questionText === null ? own : orderProblem(questionText, ask.accepted);
      asks.push({ ask: ask.id, status: ordered.problem !== null ? 'mismatch' : ordered.checked ? 'agree' : 'unchecked', source: 'prompt', computed: null, accepted: ask.accepted, reason: ordered.problem ?? (ordered.checked ? 'the sequence is in the order the words ask for' : 'the order asked for is not one this reads'), working: [], sure: ordered.checked });
      if (ordered.problem !== null) note('ask', ask.id, `ask ${ask.id}: ${ordered.problem}`);
      return;
    }
    const own = solveQuestion(ask.prompt);
    let solved: Solved | null = own;
    let source: AskCheck['source'] = own === null ? null : 'prompt';
    if (solved === null) {
      // the steps just before it were working towards it: they can confirm it, never contradict it
      for (let back = index - 1; back >= 0 && solved === null; back -= 1) {
        const before = steps[back];
        if (before !== undefined && before.kind === 'step') {
          solved = openSumIn(before.words);
          if (solved !== null) source = 'steps';
        } else break;
      }
    }
    if (solved === null && questionSolved !== null) {
      solved = questionSolved;
      source = 'question';
    }
    if (solved === null) {
      asks.push({ ask: ask.id, status: 'unchecked', source: null, computed: null, accepted: ask.accepted, reason: 'the words are not a sum this reads, so the answer is not recomputed', working: [], sure: false });
    } else {
      const verdicts = ask.accepted.map((a) => compareAccepted(a, solved.answers, ask.unit));
      let status = summarise(verdicts);
      // a way of working towards an answer, or the question's own sum, may be a stage and not this ask's answer: only the ask's own words contradict it
      if (status === 'mismatch' && source !== 'prompt') status = 'unchecked';
      const computed = answerText(solved.answers[0] as Answer);
      const differs = ask.accepted.filter((_, i) => verdicts[i] === 'different');
      const reason =
        status === 'agree'
          ? `${solved.sum} is ${computed}, and the ask accepts ${ask.accepted.join(' or ')}`
          : status === 'mismatch'
            ? `${quote(solved.sum)} works out to ${list(solved.answers)}, and the ask accepts ${differs.join(' or ')}`
            : source === 'prompt'
              ? 'the accepted answer is not written in a form this can compare'
              : `its own words are not a sum; the ${source === 'steps' ? 'steps before it work' : 'question works'} out to ${list(solved.answers)}, which a later ask may be the one to take`;
      asks.push({ ask: ask.id, status, source, computed, accepted: ask.accepted, reason, working: solved.working, sure: solved.sure });
      if (status === 'mismatch') note('ask', ask.id, `ask ${ask.id} says ${quote(ask.prompt)}: ${reason}`, solved.sure ? 'refuse' : 'note');
      if (ask.pick !== null && own !== null) {
        const right = ask.pick.filter((choice) => compareAccepted(choice, own.answers, ask.unit) === 'same').length;
        if (right !== 1) note('pick', ask.id, `${right} of the choices ${ask.pick.join(', ')} are ${list(own.answers)}; one should be`);
      }
    }
  });

  // the question's own sum must be reached by some ask of the way
  let computed: string | null = null;
  if (questionSolved !== null) {
    computed = answerText(questionSolved.answers[0] as Answer);
    const mine = steps.filter((s): s is LessonAsk => s.kind === 'ask');
    // an ordering ask is its own check (the sequence is held to the words above): the question's sorted list is no single answer to be reached
    if (mine.length > 0 && !mine.some((a) => a.check === 'order') && !mine.some((a) => a.accepted.some((x) => compareAccepted(x, questionSolved.answers, a.unit) === 'same'))) {
      const comparable = mine.some((a) => a.accepted.some((x) => compareAccepted(x, questionSolved.answers, a.unit) !== 'unknown'));
      if (comparable) note('question', null, `the question ${quote(questionText ?? '')} works out to ${list(questionSolved.answers)} and no ask of this way accepts it`, questionSolved.sure ? 'refuse' : 'note');
    }
  }
  return { node, asks, findings, question: questionText === null ? null : { text: questionText, computed } };
}

export interface LessonCheck {
  /** nothing the page says is wrong in arithmetic */
  readonly ok: boolean;
  readonly ways: readonly WayCheck[];
  readonly asks: readonly (AskCheck & { readonly node: NodeId })[];
  readonly findings: readonly MathFinding[];
  readonly counts: { readonly asks: number; readonly agree: number; readonly mismatch: number; readonly unchecked: number };
  /** one line for a log */
  readonly summary: string;
}

const isWay = (node: DocNode): boolean => node.body !== null && node.body.kind === 'lesson';

/** The words a way is read against: the question as printed (and the sheet's), and the way's own title. */
export function contextOf(doc: Document, way: NodeId): LessonContext {
  const chain = pathOf(doc, way);
  const first = chain.findIndex((n) => n.tag !== null);
  if (first < 0) return { question: chain.map((n) => n.title), way: null };
  return { question: chain.slice(0, first).map((n) => n.title), way: chain.slice(first).map((n) => n.title).join(' · ') };
}

function waysUnder(doc: Document, id: NodeId, out: NodeId[] = []): NodeId[] {
  const node = nodeOf(doc, id);
  if (node === null) return out;
  if (isWay(node)) out.push(id);
  for (const child of node.children) waysUnder(doc, child, out);
  return out;
}

/** Checks every way of a document, or of the part `only` and what is under it. Never throws. */
export function checkLessonDocument(doc: Document, only?: NodeId): LessonCheck {
  const ways: WayCheck[] = [];
  const start = only ?? doc.root;
  for (const id of waysUnder(doc, start)) {
    const node = nodeOf(doc, id);
    if (node === null || node.body === null || node.body.kind !== 'lesson') continue;
    try {
      ways.push(checkWay(id, node.body.steps, contextOf(doc, id)));
    } catch (error) {
      // the check must never be what stops a lesson: a way it cannot read is a way it says nothing about
      ways.push({ node: id, asks: [], findings: [{ severity: 'note', node: id, ask: null, where: 'ask', why: `the maths check could not read this way (${error instanceof Error ? error.message : 'unknown'})` }], question: null });
    }
  }
  const asks = ways.flatMap((w) => w.asks.map((a) => ({ ...a, node: w.node })));
  const findings = ways.flatMap((w) => w.findings);
  const counts = {
    asks: asks.length,
    agree: asks.filter((a) => a.status === 'agree').length,
    mismatch: asks.filter((a) => a.status === 'mismatch').length,
    unchecked: asks.filter((a) => a.status === 'unchecked').length,
  };
  const refused = findings.filter((f) => f.severity === 'refuse').length;
  return {
    ok: refused === 0,
    ways,
    asks,
    findings,
    counts,
    summary: `${counts.asks} ask${counts.asks === 1 ? '' : 's'}: ${counts.agree} recomputed and agree, ${counts.mismatch} disagree, ${counts.unchecked} not recomputable; ${refused} refused`,
  };
}

// helpers other callers want

/** Whether `text`, typed as an answer, is one the ask accepts, compared as exact values (not words). */
export function exactAccepts(ask: Pick<LessonAsk, 'accepted' | 'unit'>, text: string): boolean {
  const parsed = parseAnswer(text);
  return parsed !== null && ask.accepted.some((a) => agrees(a, parsed, ask.unit));
}

