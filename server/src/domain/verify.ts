// Verify (PLAN-v3-core WS5, 2.9): what is checked about a part of a document written ahead, before it is offered.
//
// Nothing here reads a file, a clock or the network, and nothing names or describes the learner. A part is checked BY KIND, and the kinds are
// a table (`CHECKERS`) so that the worksheet is the first case and not the only one:
//
//   lesson   a part whose body is steps and asks, or whose children are ways: every ask's accepted answer is recomputed here, on our own
//            arithmetic, from the words of the question and the ask (arithmetic, a gap, money, a length or a weight, a time); no accepted
//            answer may be on the page before it is tried (the lesson lint); the shape (three to five tagged ways, each with an ask)
//   chart    a painted scene with a chart in it: its figures must be sourced and dated in the words beside it
//   mockup   a painted scene with a screen in it: the interface reader must have nothing to complain of
//
// A check of this file is `mechanical`: it is free and it is exact where it knows. What it cannot know (a word problem, a picture) goes to the
// second check, a cheap model asked cold (`judge/lesson.ts`), whose verdict is joined to this one by `settle`.

import { TECHNIQUE, lintLesson, matchAnswer, nodeOf, parseInterface, pathOf, serializeLine, spoilerMessage } from '@conduit/language';
import type { DocNode, Document, LessonAsk, LessonContext, LessonStep, NodeId } from '@conduit/language';
import type { AskCheck } from '@conduit/language/maths';
import { checkLesson } from './maths';

// ---------------------------------------------------------------------------------------------------------------------------------
// what a check finds

export type FindingSource = 'solver' | 'lint' | 'shape' | 'model' | 'chart' | 'mockup';

export interface Finding {
  /** `refuse`: the part is not offered. `note`: said in the log, nothing more. */
  readonly severity: 'refuse' | 'note';
  readonly source: FindingSource;
  /** the way (or the part) it is about */
  readonly node: NodeId;
  /** the ask it is about, by its id in the document */
  readonly ask: string | null;
  readonly why: string;
}

export type VerifyKind = 'lesson' | 'chart' | 'mockup';

/** What the free checks made of a part. */
export interface Mechanical {
  readonly kind: VerifyKind;
  readonly node: NodeId;
  readonly findings: readonly Finding[];
  /** asks whose accepted answer was recomputed independently and found right */
  readonly confirmed: number;
  /** asks that held a sum this file could recompute (confirmed or not) */
  readonly recomputed: number;
  /** every ask of the part */
  readonly asks: number;
  /** the part's own answer, when its words are a sum this file can do (a worksheet's question) */
  readonly own: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the lesson check
// ---------------------------------------------------------------------------------------------------------------------------------

/** A way: a node whose body is a lesson. */
export const isWay = (node: DocNode): boolean => node.body !== null && node.body.kind === 'lesson';

export function stepsOf(node: DocNode): readonly LessonStep[] {
  return node.body !== null && node.body.kind === 'lesson' ? node.body.steps : [];
}

export const asksOf = (node: DocNode): readonly LessonAsk[] => stepsOf(node).filter((step): step is LessonAsk => step.kind === 'ask');

/** The words a way is read against: the question's printed words (and the sheet's), and the way's own title. */
export function lessonContext(doc: Document, way: NodeId): LessonContext {
  const chain = pathOf(doc, way);
  const first = chain.findIndex((node) => node.tag !== null);
  if (first < 0) return { question: chain.map((node) => node.title), way: null };
  return { question: chain.slice(0, first).map((node) => node.title), way: chain.slice(first).map((node) => node.title).join(' · ') };
}

const shortId = (id: NodeId): string => id.slice(id.lastIndexOf('/') + 1);

/**
 * What a part was written as: a question with ways (`ways`), steps of its own (`steps`), or both (`both`: the question's own ask is her try
 * before any help, and its ways are the help under it, which "Show me how" opens). Null when nothing is written.
 */
export function profileOf(doc: Document, node: DocNode): 'ways' | 'steps' | 'both' | null {
  const kids = node.children.map((child) => nodeOf(doc, child)).filter((child): child is DocNode => child !== null && !child.id.startsWith('#'));
  const helped = kids.some(isWay);
  if (isWay(node)) return helped ? 'both' : 'steps';
  return helped ? 'ways' : null;
}

/** The ways of a part, in order, empty ones (a part sent back to be written) included. */
export function waysOf(doc: Document, node: DocNode): readonly DocNode[] {
  return node.children.map((child) => nodeOf(doc, child)).filter((child): child is DocNode => child !== null && !child.id.startsWith('#') && child.children.length === 0);
}

export const WAYS = { least: 3, most: 5 } as const;

/** A figure's own reading, exact: what a figure declares it computes (a grid's area, in squares). Null when the figure cannot say, or says it could not be read. */
export function figureValue(show: { readonly visual: string; readonly args: Readonly<Record<string, string>> }): number | 'unreadable' | null {
  if (show.visual !== 'grid') return null;
  const cells = show.args['cells'];
  if (cells === undefined) return null;
  if (cells === 'unreadable') return 'unreadable';
  const rows = cells.split('/');
  if (rows.some((row) => !/^[xoh]+$/.test(row) || row.length !== rows[0]?.length)) return null;
  let halves = 0;
  for (const row of rows) for (const cell of row) halves += cell === 'x' ? 2 : cell === 'h' ? 1 : 0;
  return halves / 2;
}

/** Every figure of a part and its helps that declares what it reads. */
function figuresOf(doc: Document, node: DocNode): readonly (number | 'unreadable')[] {
  return [node, ...waysOf(doc, node)].flatMap((part) => stepsOf(part).flatMap((step) => (step.kind === 'step' && step.show !== null ? [figureValue(step.show)] : []))).filter((value): value is number | 'unreadable' => value !== null);
}

/** Whether a figure of the part says it could not be read exactly: the part is for a person to check. */
export function unreadableFigure(node: DocNode, doc: Document): boolean {
  return figuresOf(doc, node).includes('unreadable');
}

/** The figure checks of a part: figures that declare a value agree, and the last ask of every part that shows one is held to it. */
function figureFindings(doc: Document, node: DocNode, refuse: (source: FindingSource, at: NodeId, ask: string | null, why: string) => void): void {
  if (unreadableFigure(node, doc)) return;
  const values = figuresOf(doc, node).filter((value): value is number => typeof value === 'number');
  const first = values[0];
  if (first === undefined) return;
  if (values.some((value) => value !== first)) {
    refuse('shape', node.id, null, 'two figures of this part declare different values');
    return;
  }
  for (const part of [node, ...waysOf(doc, node)]) {
    const shows = stepsOf(part).some((step) => step.kind === 'step' && step.show !== null && figureValue(step.show) !== null);
    const asks = asksOf(part);
    const last = asks[asks.length - 1];
    if (!shows || last === undefined) continue;
    if (!last.accepted.some((answer) => matchAnswer(answer, String(first), last.unit))) refuse('solver', part.id, last.id, `the figure reads ${first}, and ask ${last.id} accepts ${last.accepted.join(' | ') || 'nothing'}`);
  }
}

function lessonCheck(doc: Document, node: DocNode): Mechanical {
  const findings: Finding[] = [];
  const profile = profileOf(doc, node);
  // `both`: the part's own steps are her try first (no tag, an ask of its own), and the ways under it are the help
  const helps = profile === 'ways' || profile === 'both';
  const ways = profile === 'steps' ? [node] : waysOf(doc, node);
  const written = ways.filter(isWay);
  const mine: readonly DocNode[] = profile === 'both' ? [node] : [];
  let confirmed = 0;
  let recomputed = 0;
  let asks = 0;
  // the exact checker: every ask recomputed from its words (or the question's), every sum the page states
  const maths = checkLesson(doc, node.id);
  const askStatus = new Map<string, AskCheck['status']>();
  for (const checked of maths.asks) askStatus.set(`${checked.node}\u0000${checked.ask}`, checked.status);
  const refuse = (source: FindingSource, at: NodeId, ask: string | null, why: string): void => void findings.push({ severity: 'refuse', source, node: at, ask, why });
  const note = (source: FindingSource, at: NodeId, ask: string | null, why: string): void => void findings.push({ severity: 'note', source, node: at, ask, why });

  if (written.length === 0) refuse('shape', node.id, null, 'nothing is written');
  if (helps) {
    // her own try comes first and is the question; a question that has it and two ways is offered at once (a third is written for the next time) rather than held back
    const least = profile === 'both' ? 2 : WAYS.least;
    if (written.length < least) refuse('shape', node.id, null, `${written.length} way${written.length === 1 ? '' : 's'} written, and a question has three to five`);
    else if (written.length < WAYS.least) note('shape', node.id, null, `${written.length} ways written; three to five are asked for`);
    if (written.length > WAYS.most) note('shape', node.id, null, `${written.length} ways written; three to five are asked for`);
    const tags = written.flatMap((way) => (way.tag === null ? [] : [way.tag]));
    if (new Set(tags).size < tags.length) note('shape', node.id, null, 'two ways are tagged with the same technique');
    for (const way of ways) if (!isWay(way)) note('shape', way.id, null, `way ${shortId(way.id)} is empty (left from a rewrite)`);
  }
  for (const way of [...mine, ...written]) {
    const waySteps = stepsOf(way);
    const first = mine.includes(way);
    if (first) {
      if (asksOf(way).length === 0) refuse('shape', way.id, null, `the question ${shortId(way.id)} has steps of its own and no ask: her try first is an ask on the question itself`);
    } else if (helps) {
      if (way.tag === null || !Object.hasOwn(TECHNIQUE, way.tag)) refuse('shape', way.id, null, `way ${shortId(way.id)} has no technique tag`);
      if (asksOf(way).length === 0) refuse('shape', way.id, null, `way ${shortId(way.id)} has no ask`);
    }
    if (waySteps.length === 0) refuse('shape', way.id, null, `${shortId(way.id)} has no steps`);
    // no accepted answer on the page before it is tried
    for (const spoiler of lintLesson(waySteps, lessonContext(doc, way.id))) {
      refuse('lint', way.id, spoiler.in, spoilerMessage(spoiler.in ?? '?', [spoiler]));
    }
    for (const ask of asksOf(way)) {
      asks += 1;
      for (const hint of ask.hints) if (/\bwrong\b/i.test(hint)) note('shape', way.id, ask.id, `a hint of ${ask.id} says "wrong"`);
      if (ask.hints.length === 0) note('shape', way.id, ask.id, `ask ${ask.id} has no hint`);
      const status = askStatus.get(`${way.id}\u0000${ask.id}`);
      if (status === 'agree') {
        recomputed += 1;
        confirmed += 1;
      } else if (status === 'mismatch') recomputed += 1;
    }
  }
  figureFindings(doc, node, refuse);
  for (const found of maths.findings) findings.push({ severity: found.severity, source: 'solver', node: found.node, ask: found.ask, why: found.why });
  return { kind: 'lesson', node: node.id, findings, confirmed, recomputed, asks, own: profile === 'steps' ? null : maths.own };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the chart and mock-up checks (painted scenes)
// ---------------------------------------------------------------------------------------------------------------------------------

function sceneLines(node: DocNode): string[] {
  if (node.body === null || node.body.kind !== 'scene') return [];
  return node.body.segments.flatMap((segment) => segment.lines.map((entry) => serializeLine(entry.line)));
}

const SOURCED = /\b(?:source|sources|from|via|according to|data|dataset|survey|census|report|study|published)\b\s*[:\-]?/i;
const DATED = /\b(?:1[89]\d{2}|20\d{2})\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{4}\b/i;

function chartCheck(node: DocNode): Mechanical {
  const lines = sceneLines(node);
  const findings: Finding[] = [];
  const words = lines.filter((line) => !/^(?:chart|row|set|cam|look|scene)\b/.test(line)).join(' ');
  const chartText = lines.filter((line) => /^chart\b/.test(line)).join(' ');
  if (!SOURCED.test(`${words} ${chartText}`)) findings.push({ severity: 'refuse', source: 'chart', node: node.id, ask: null, why: 'a chart must say where its figures are from (a source line beside it)' });
  if (!DATED.test(`${words} ${chartText}`)) findings.push({ severity: 'refuse', source: 'chart', node: node.id, ask: null, why: 'a chart must say when its figures are from (a year or a date)' });
  return { kind: 'chart', node: node.id, findings, confirmed: 0, recomputed: 0, asks: 0, own: null };
}

function mockupCheck(node: DocNode): Mechanical {
  const lines = sceneLines(node);
  const findings: Finding[] = [];
  const parsed = parseInterface(lines);
  if (parsed.screens.length === 0) findings.push({ severity: 'refuse', source: 'mockup', node: node.id, ask: null, why: 'a mock-up with no screen' });
  for (const noted of parsed.notes.slice(0, 6)) findings.push({ severity: 'refuse', source: 'mockup', node: node.id, ask: null, why: `the interface reader: ${noted.message}` });
  return { kind: 'mockup', node: node.id, findings, confirmed: 0, recomputed: 0, asks: 0, own: null };
}

/** The kind of check a part wants, from what it holds. Null when it holds nothing a check knows (a plain explainer's words are left as they are). */
export function kindOfPart(doc: Document, node: DocNode): VerifyKind | null {
  if (node.body !== null && node.body.kind === 'scene') {
    const lines = sceneLines(node);
    if (lines.some((line) => /^chart\b/.test(line))) return 'chart';
    if (lines.some((line) => /^screen\b/.test(line))) return 'mockup';
    return null;
  }
  return profileOf(doc, node) === null ? null : 'lesson';
}

/** The table of checks by kind: add a kind of part and its check here. */
export const CHECKERS: { readonly [K in VerifyKind]: (doc: Document, node: DocNode) => Mechanical } = {
  lesson: lessonCheck,
  chart: (_doc, node) => chartCheck(node),
  mockup: (_doc, node) => mockupCheck(node),
};

/** The free checks of a part; a part of no kind a check knows is checked as a lesson of nothing and refused (it was asked for and is empty). */
export function mechanicalCheck(doc: Document, id: NodeId): Mechanical {
  const node = nodeOf(doc, id);
  if (node === null) return { kind: 'lesson', node: id, findings: [{ severity: 'refuse', source: 'shape', node: id, ask: null, why: 'there is no such part' }], confirmed: 0, recomputed: 0, asks: 0, own: null };
  return (CHECKERS[kindOfPart(doc, node) ?? 'lesson'])(doc, node);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the second check, joined to the first
// ---------------------------------------------------------------------------------------------------------------------------------

/** One thing the model check says is wrong. */
export interface ModelProblem {
  readonly way: string | null;
  readonly ask: string | null;
  readonly kind: 'answer' | 'fact' | 'wording';
  readonly blocking: boolean;
  readonly right: string | null;
  readonly why: string;
}

export interface ModelVerdict {
  /** the model's own answer to the whole question */
  readonly answer: string | null;
  readonly problems: readonly ModelProblem[];
}

export interface Verdict {
  readonly node: NodeId;
  readonly kind: VerifyKind;
  readonly status: 'verified' | 'refused';
  /** one line: why it was refused, or what was checked */
  readonly why: string;
  readonly refused: readonly Finding[];
  readonly notes: readonly Finding[];
  readonly mechanical: Mechanical;
  readonly model: ModelVerdict | null;
  /** answers the model disputed and the solver confirmed (the solver is exact where it knows): said, not refused */
  readonly overruled: readonly string[];
}

/** The part as text for the second check: the question as printed, then each way with its steps, asks, choices, answers and hints. No picture; a step's picture is said in words. */
export function lessonText(doc: Document, id: NodeId): string {
  const node = nodeOf(doc, id);
  if (node === null) return '';
  const out: string[] = [`QUESTION ${shortId(id)}: ${node.title}`];
  const profile = profileOf(doc, node);
  const ways = profile === 'steps' ? [node] : profile === 'both' ? [node, ...waysOf(doc, node).filter(isWay)] : waysOf(doc, node).filter(isWay);
  for (const way of ways) {
    out.push(`  ${way.id === id && profile === 'both' ? 'HER FIRST TRY (before any help)' : 'WAY'} ${shortId(way.id)}${way.tag === null ? '' : ` [${way.tag}]`}: ${way.title}`);
    for (const step of stepsOf(way)) {
      if (step.kind === 'step') {
        const show = step.show === null ? '' : ` [picture: ${step.show.visual}${step.show.range === null ? '' : ` ${step.show.range[0]}..${step.show.range[1]}`}${Object.entries(step.show.args).map(([key, value]) => ` ${key}=${value}`).join('')}]`;
        out.push(`    step${show}: ${step.words}`);
      } else {
        out.push(`    ASK ${step.id}: ${step.prompt}${step.check === 'order' ? ' (she drags tiles of these items into order)' : step.pick === null ? ' (she types it)' : ` (she taps one of: ${step.pick.join(', ')})`}  ${step.check === 'order' ? 'THE RIGHT ORDER' : 'ACCEPTED'}: ${step.accepted.join(step.check === 'order' ? ' , ' : ' | ')}${step.unit === null ? '' : ` (${step.unit})`}`);
        for (const hint of step.hints) out.push(`      hint: ${hint}`);
      }
    }
  }
  return out.join('\n');
}

/**
 * The verdict of a part: the free checks, and the model's. A model finding that the solver exactly contradicts is overruled (the solver
 * recomputed that very sum); every other blocking finding refuses. With no model verdict (it was not asked, or could not be) a part with no
 * ask the solver could not recompute is still verified on the free checks alone only when `modelOptional` says so.
 */
export function settle(mechanical: Mechanical, model: ModelVerdict | null, solverSays: (ask: string | null) => 'agrees' | 'disagrees' | 'silent'): Verdict {
  const refused: Finding[] = mechanical.findings.filter((finding) => finding.severity === 'refuse');
  const notes: Finding[] = mechanical.findings.filter((finding) => finding.severity === 'note');
  const overruled: string[] = [];
  for (const problem of model?.problems ?? []) {
    const finding: Finding = { severity: problem.blocking || problem.kind !== 'wording' ? 'refuse' : 'note', source: 'model', node: problem.way ?? mechanical.node, ask: problem.ask, why: `${problem.kind}: ${problem.why}${problem.right === null ? '' : ` (it says ${problem.right})`}` };
    if (finding.severity === 'refuse' && problem.kind === 'answer' && solverSays(problem.ask) === 'agrees') {
      overruled.push(`${problem.ask ?? '?'}: ${problem.why}`);
      notes.push({ ...finding, severity: 'note', why: `the model disputed this and the solver confirmed it: ${finding.why}` });
    } else (finding.severity === 'refuse' ? refused : notes).push(finding);
  }
  const why = refused.length === 0 ? `checked ${mechanical.asks} ask${mechanical.asks === 1 ? '' : 's'}, ${mechanical.confirmed} recomputed${model === null ? '' : ', model agrees'}` : refused.slice(0, 3).map((finding) => finding.why).join('; ');
  return { node: mechanical.node, kind: mechanical.kind, status: refused.length === 0 ? 'verified' : 'refused', why, refused, notes, mechanical, model, overruled };
}

/** Whether the free check, ask by ask, agrees with an accepted answer: for `settle`. */
export function solverOpinion(doc: Document, id: NodeId): (ask: string | null) => 'agrees' | 'disagrees' | 'silent' {
  const byAsk = new Map<string, 'agrees' | 'disagrees'>();
  for (const checked of checkLesson(doc, id).asks) {
    if (checked.status === 'unchecked') continue;
    const now = checked.status === 'agree' ? 'agrees' : 'disagrees';
    byAsk.set(checked.ask, byAsk.get(checked.ask) === 'disagrees' ? 'disagrees' : now);
  }
  return (askId) => (askId === null ? undefined : byAsk.get(askId)) ?? 'silent';
}

export { matchAnswer };
