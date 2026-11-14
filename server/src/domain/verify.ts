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

import { TECHNIQUE, accepts, evalExpr, lintLesson, matchAnswer, nodeOf, parseExpr, parseInterface, parseQuantity, pathOf, serializeLine, spoilerMessage } from '@conduit/language';
import type { DocNode, Document, LessonAsk, LessonContext, LessonStep, NodeId } from '@conduit/language';

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
// the solver: arithmetic in the words of a question or an ask
// ---------------------------------------------------------------------------------------------------------------------------------

const UNIT_WORDS =
  'millimetres?|millimeters?|centimetres?|centimeters?|kilometres?|kilometers?|metres?|meters?|kilograms?|kilos?|grams?|millilitres?|milliliters?|centilitres?|litres?|liters?|seconds?|secs?|minutes?|mins?|hours?|pence|pounds?|dollars?|cents?|mm|cm|km|kg|ml|cl|m|g|l|p';

type Token =
  | { readonly t: 'num'; readonly text: string; readonly value: number; readonly dim: string; readonly factor: number }
  | { readonly t: 'gap'; readonly dim: string; readonly factor: number }
  | { readonly t: 'op'; readonly op: '+' | '-' | '*' | '/' }
  | { readonly t: 'eq' }
  | { readonly t: 'less' | 'more' | 'double' | 'half' }
  | { readonly t: 'paren'; readonly open: boolean }
  | { readonly t: 'other' };

const SCAN = new RegExp(
  [
    String.raw`(?<gap>\[\s*\]|_{2,}|□|\(\s*\)|\?)(?:\s*(?<gapunit>${UNIT_WORDS})\b)?`,
    String.raw`(?<num>[£$€]?\d[\d,]*(?:\.\d+)?(?:\s*(?:${UNIT_WORDS})\b)?)`,
    String.raw`(?<less>\b(?:less|fewer|smaller) than\b)`,
    String.raw`(?<more>\b(?:more|greater|bigger) than\b)`,
    String.raw`(?<double>\b(?:double|twice)\b)`,
    String.raw`(?<half>\bhalf of\b|\bhalf\b)`,
    String.raw`(?<op>[-+*/])`,
    String.raw`(?<eq>=)`,
    String.raw`(?<open>\()`,
    String.raw`(?<close>\))`,
    String.raw`(?<space>\s+)`,
    String.raw`(?<other>[\s\S])`,
  ].join('|'),
  'gi',
);

function unitInfo(word: string): { readonly dim: string; readonly factor: number } {
  const q = parseQuantity(`1 ${word}`);
  return q === null ? { dim: 'none', factor: 1 } : { dim: q.dim, factor: q.base };
}

function tokenize(source: string): Token[] {
  const text = source
    // the words a child's page uses for the signs
    .replace(/\b(?:plus|add(?:ed to)?)\b/gi, '+')
    .replace(/\b(?:minus|take away|subtract(?:ed from)?|takeaway)\b/gi, '-')
    .replace(/\b(?:times|multiplied by|lots of|groups of|rows of)\b/gi, '*')
    .replace(/\b(?:divided by|shared by|over)\b/gi, '/')
    .replace(/\b(?:equals?|is equal to|makes|make)\b/gi, '=')
    .replace(/[−–—]/g, '-')
    .replace(/[×✕✖]/g, '*')
    .replace(/÷/g, '/')
    .replace(/(?<=[\d\])\s])\s*[x·]\s*(?=[\d[(£$€_□?])/gi, ' * ')
    .replace(/(?<=\d)\s*:\s*(?=\d)/g, ':');
  const tokens: Token[] = [];
  for (const match of text.matchAll(SCAN)) {
    const g = match.groups ?? {};
    if (g['gap'] !== undefined) {
      const unit = g['gapunit'] === undefined ? { dim: 'none', factor: 1 } : unitInfo(g['gapunit']);
      tokens.push({ t: 'gap', ...unit });
    } else if (g['num'] !== undefined) {
      const q = parseQuantity(g['num'].replace(/,/g, ''));
      if (q === null) tokens.push({ t: 'other' });
      else tokens.push({ t: 'num', text: g['num'], value: q.base, dim: q.dim, factor: q.dim === 'none' ? 1 : q.base / q.written || 1 });
    } else if (g['less'] !== undefined) tokens.push({ t: 'less' });
    else if (g['more'] !== undefined) tokens.push({ t: 'more' });
    else if (g['double'] !== undefined) tokens.push({ t: 'double' });
    else if (g['half'] !== undefined) tokens.push({ t: 'half' });
    else if (g['op'] !== undefined) tokens.push({ t: 'op', op: g['op'] as '+' | '-' | '*' | '/' });
    else if (g['eq'] !== undefined) tokens.push({ t: 'eq' });
    else if (g['open'] !== undefined) tokens.push({ t: 'paren', open: true });
    else if (g['close'] !== undefined) tokens.push({ t: 'paren', open: false });
    else if (g['space'] !== undefined) continue;
    else tokens.push({ t: 'other' });
  }
  return tokens;
}

/** What a sum in words comes to: the number, and the forms a child might be accepted in. */
export interface Solved {
  /** the sum as it was read, for the reason given when it disagrees */
  readonly sum: string;
  readonly value: number;
  readonly candidates: readonly string[];
}

const canonical = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e9) / 1e9));

const CLOCK = String.raw`(\d{1,2}):(\d{2})`;
const SPAN = String.raw`(\d+(?:\.\d+)?|a quarter of an|half an|an?)\s*(minutes?|mins?|hours?|hrs?)`;
const spanMinutes = (amount: string, unit: string): number => {
  const n = /^half/i.test(amount) ? 0.5 : /^a quarter/i.test(amount) ? 0.25 : /^an?$/i.test(amount) ? 1 : Number(amount);
  return Math.round(n * (/^h/i.test(unit) ? 60 : 1));
};
const clockText = (minutes: number): string => {
  const m = ((minutes % 720) + 720) % 720;
  return `${Math.floor(m / 60) === 0 ? 12 : Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

/** A time of day moved by a span (`3:15 + 40 minutes`, `40 minutes after 3:15`, `20 minutes before 4:00`), or the minutes between two (`from 3:15 to 3:45`). Null when the words are neither. */
export function solveClock(text: string): Solved | null {
  const plain = text.replace(/[−–—]/g, '-');
  const forward = new RegExp(`${CLOCK}\\s*(?:am|pm)?\\s*(\\+|plus|and|-|minus)\\s*${SPAN}\\s*(?:=\\s*)?[?.]?\\s*$`, 'i').exec(plain);
  if (forward?.[1] !== undefined && forward[2] !== undefined && forward[3] !== undefined && forward[4] !== undefined && forward[5] !== undefined) {
    const at = Number(forward[1]) * 60 + Number(forward[2]);
    const move = spanMinutes(forward[4], forward[5]);
    const answer = clockText(/^(?:-|minus)$/i.test(forward[3]) ? at - move : at + move);
    return { sum: plain.trim().slice(-80), value: Number.NaN, candidates: [answer] };
  }
  const after = new RegExp(`${SPAN}\\s*(after|later than|past|before|earlier than)\\s*${CLOCK}[^\\d]*$`, 'i').exec(plain);
  if (after?.[1] !== undefined && after[2] !== undefined && after[3] !== undefined && after[4] !== undefined && after[5] !== undefined) {
    const at = Number(after[4]) * 60 + Number(after[5]);
    const move = spanMinutes(after[1], after[2]);
    const answer = clockText(/^(?:before|earlier)/i.test(after[3]) ? at - move : at + move);
    return { sum: plain.trim().slice(-80), value: Number.NaN, candidates: [answer] };
  }
  const between = new RegExp(`from\\s*${CLOCK}\\s*(?:am|pm)?\\s*to\\s*${CLOCK}[^\\d]*$`, 'i').exec(plain);
  if (between?.[1] !== undefined && between[2] !== undefined && between[3] !== undefined && between[4] !== undefined && /\b(?:minutes?|mins?)\b/i.test(plain)) {
    const gap = (Number(between[3]) * 60 + Number(between[4]) - (Number(between[1]) * 60 + Number(between[2])) + 720) % 720;
    return { sum: plain.trim().slice(-80), value: gap, candidates: [String(gap)] };
  }
  return null;
}

/** The sum made of the trailing tokens of a text: `64 - 30 =`, `10 x [ ] = 100`, `50 less than 200 =`, `25 cm + [ ] cm = 1 m`, `double 50`. Null when it is not one this can do. */
export function solve(text: string): Solved | null {
  const clock = solveClock(text);
  if (clock !== null) return clock;
  const all = tokenize(text);
  // the trailing run of tokens that belong to a sum, ignoring the sentence's own full stop and question mark
  let end = all.length;
  while (end > 0 && (all[end - 1]?.t === 'other' || (all[end - 1]?.t === 'gap' && end >= 2 && all[end - 2]?.t === 'num'))) {
    const last = all[end - 1];
    if (last?.t === 'other') end -= 1;
    else break;
  }
  let start = end;
  while (start > 0) {
    const token = all[start - 1];
    if (token === undefined || token.t === 'other') break;
    start -= 1;
  }
  let run = all.slice(start, end);
  // a lone `?` after a plain sum is the sentence's question mark: `What is 6 + 4?`
  if (run.length >= 2 && run[run.length - 1]?.t === 'gap' && run[run.length - 2]?.t === 'num' && !run.some((token) => token.t === 'eq')) run = run.slice(0, -1);
  while (run[0] !== undefined && (run[0].t === 'eq' || run[0].t === 'op' || run[0].t === 'less' || run[0].t === 'more')) run = run.slice(1);
  // `A less than B` is `B - A`; `double A` is `2 * A`; `half of A` is `A / 2`
  const parts: (Token | string)[] = [];
  for (let i = 0; i < run.length; i += 1) {
    const token = run[i];
    const next = run[i + 1];
    const after = run[i + 2];
    if (token === undefined) continue;
    if ((token.t === 'num' || token.t === 'gap') && (next?.t === 'less' || next?.t === 'more') && (after?.t === 'num' || after?.t === 'gap')) {
      parts.push({ t: 'paren', open: true }, after, { t: 'op', op: next.t === 'less' ? '-' : '+' }, token, { t: 'paren', open: false });
      i += 2;
    } else if (token.t === 'double' && (next?.t === 'num' || next?.t === 'gap')) {
      parts.push({ t: 'paren', open: true }, { t: 'num', text: '2', value: 2, dim: 'none', factor: 1 }, { t: 'op', op: '*' }, next, { t: 'paren', open: false });
      i += 1;
    } else if (token.t === 'half' && (next?.t === 'num' || next?.t === 'gap')) {
      parts.push({ t: 'paren', open: true }, next, { t: 'op', op: '/' }, { t: 'num', text: '2', value: 2, dim: 'none', factor: 1 }, { t: 'paren', open: false });
      i += 1;
    } else parts.push(token);
  }
  const flat = parts.filter((part): part is Token => typeof part !== 'string');
  if (flat.some((token) => token.t === 'less' || token.t === 'more' || token.t === 'double' || token.t === 'half')) return null;
  const gaps = flat.filter((token) => token.t === 'gap').length;
  const eqs = flat.filter((token) => token.t === 'eq').length;
  const operators = flat.filter((token) => token.t === 'op' || token.t === 'paren').length;
  if (eqs > 1 || gaps > 1 || flat.filter((token) => token.t === 'num').length < 1) return null;
  // a sum has a sign in it, or is a gap set equal to a number; a number and an equals sign alone is a fragment of something longer
  if (operators === 0 && !(gaps === 1 && eqs === 1 && flat.some((token) => token.t === 'num'))) return null;

  const dims = new Set(flat.flatMap((token) => (token.t === 'num' && token.dim !== 'none' ? [token.dim] : [])));
  if (dims.size > 1) return null;
  const toSource = (tokens: readonly Token[]): string => tokens.map((token) => (token.t === 'num' ? String(token.value) : token.t === 'gap' ? 'x' : token.t === 'op' ? token.op : token.t === 'paren' ? (token.open ? '(' : ')') : '')).join(' ');
  const eqAt = flat.findIndex((token) => token.t === 'eq');
  const left = eqAt < 0 ? flat : flat.slice(0, eqAt);
  const right = eqAt < 0 ? [] : flat.slice(eqAt + 1);
  const value = (tokens: readonly Token[], x: number): number => {
    if (tokens.length === 0) return Number.NaN;
    const expr = parseExpr(toSource(tokens));
    return expr === null ? Number.NaN : evalExpr(expr, { x });
  };
  const gap = flat.find((token): token is Extract<Token, { t: 'gap' }> => token.t === 'gap');
  const firstUnit = flat.find((token): token is Extract<Token, { t: 'num' }> => token.t === 'num' && token.dim !== 'none');
  let result: number;
  let unitFactor = gap !== undefined && gap.dim !== 'none' ? gap.factor : (firstUnit?.factor ?? 1);
  if (gap === undefined) {
    // `A op B =` (with or without a trailing gap): the left side's value
    result = eqAt < 0 ? value(left, 0) : value(left, 0);
    if (eqAt >= 0 && right.length > 0 && !(right.length === 1 && right[0]?.t === 'num')) return null;
    // a sum that is already written with its answer is a statement, not a question
    if (eqAt >= 0 && right.length === 1 && right[0]?.t === 'num') return null;
  } else if (right.length === 1 && right[0]?.t === 'gap') {
    result = value(left, 0);
  } else if (eqAt < 0) {
    return null;
  } else {
    // one gap, in the left side or the right: f(x) = left - right, found from f(0) and f(1) and checked at the root
    const f = (x: number): number => value(left, x) - value(right, x);
    const f0 = f(0);
    const slope = f(1) - f0;
    let root = Number.isFinite(f0) && Number.isFinite(slope) && Math.abs(slope) > 1e-12 ? -f0 / slope : Number.NaN;
    if (!(Math.abs(f(root)) < 1e-7 * Math.max(1, Math.abs(root)))) {
      // not a straight line (the unknown divides something): the whole numbers and halves a child would meet
      root = Number.NaN;
      for (let n = 1; n <= 20_000 && Number.isNaN(root); n += 1) if (Math.abs(f(n)) < 1e-9) root = n;
      for (let n = 0.5; n <= 100 && Number.isNaN(root); n += 1) if (Math.abs(f(n)) < 1e-9) root = n;
    }
    if (!Number.isFinite(root)) return null;
    result = root;
    // an unknown with no unit of its own, among terms with one, is in the unit written first
    if (gap.dim === 'none' && firstUnit === undefined) unitFactor = 1;
  }
  if (!Number.isFinite(result)) return null;
  const inUnit = result / unitFactor;
  const candidates = new Set<string>([canonical(inUnit)]);
  if (dims.size > 0) candidates.add(canonical(result));
  return { sum: text.trim().replace(/\s+/g, ' ').slice(-80), value: inUnit, candidates: [...candidates] };
}

/** The sum a part's title is, with a printed number in front of it taken off (`5. 125 - 50 =`). */
export function solveTitle(title: string): Solved | null {
  return solve(title.replace(/^\s*\(?\d{1,3}[.)]\s+/, ''));
}

/** The sum an ask puts at the end of its words (`What is 6 + 4?`), not a statement earlier in them (`6 + 2 = 8. Now count on the 4 green.`). */
export function solveAsk(prompt: string): Solved | null {
  return solve(prompt);
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

/** What a part was written as: a question with ways, or steps of its own. Null when nothing is written. */
export function profileOf(doc: Document, node: DocNode): 'ways' | 'steps' | null {
  if (isWay(node)) return 'steps';
  const kids = node.children.map((child) => nodeOf(doc, child)).filter((child): child is DocNode => child !== null && !child.id.startsWith('#'));
  return kids.some(isWay) ? 'ways' : null;
}

/** The ways of a part, in order, empty ones (a part sent back to be written) included. */
export function waysOf(doc: Document, node: DocNode): readonly DocNode[] {
  return node.children.map((child) => nodeOf(doc, child)).filter((child): child is DocNode => child !== null && !child.id.startsWith('#') && child.children.length === 0);
}

export const WAYS = { least: 3, most: 5 } as const;

function lessonCheck(doc: Document, node: DocNode): Mechanical {
  const findings: Finding[] = [];
  const profile = profileOf(doc, node);
  const ways = profile === 'steps' ? [node] : waysOf(doc, node);
  const written = ways.filter(isWay);
  let confirmed = 0;
  let recomputed = 0;
  let asks = 0;
  const own = profile === 'steps' ? null : solveTitle(node.title);
  const refuse = (source: FindingSource, at: NodeId, ask: string | null, why: string): void => void findings.push({ severity: 'refuse', source, node: at, ask, why });
  const note = (source: FindingSource, at: NodeId, ask: string | null, why: string): void => void findings.push({ severity: 'note', source, node: at, ask, why });

  if (written.length === 0) refuse('shape', node.id, null, 'nothing is written');
  if (profile === 'ways') {
    if (written.length < WAYS.least) refuse('shape', node.id, null, `${written.length} way${written.length === 1 ? '' : 's'} written, and a question has three to five`);
    if (written.length > WAYS.most) note('shape', node.id, null, `${written.length} ways written; three to five are asked for`);
    const tags = written.flatMap((way) => (way.tag === null ? [] : [way.tag]));
    if (new Set(tags).size < tags.length) note('shape', node.id, null, 'two ways are tagged with the same technique');
    for (const way of ways) if (!isWay(way)) note('shape', way.id, null, `way ${shortId(way.id)} is empty (left from a rewrite)`);
  }
  for (const way of written) {
    const waySteps = stepsOf(way);
    if (profile === 'ways') {
      if (way.tag === null || !Object.hasOwn(TECHNIQUE, way.tag)) refuse('shape', way.id, null, `way ${shortId(way.id)} has no technique tag`);
      if (asksOf(way).length === 0) refuse('shape', way.id, null, `way ${shortId(way.id)} has no ask`);
    }
    if (waySteps.length === 0) refuse('shape', way.id, null, `${shortId(way.id)} has no steps`);
    // no accepted answer on the page before it is tried
    for (const spoiler of lintLesson(waySteps, lessonContext(doc, way.id))) {
      refuse('lint', way.id, spoiler.in, spoilerMessage(spoiler.in ?? '?', [spoiler]));
    }
    let reaches = own === null;
    for (const ask of asksOf(way)) {
      asks += 1;
      for (const hint of ask.hints) if (/\bwrong\b/i.test(hint)) note('shape', way.id, ask.id, `a hint of ${ask.id} says "wrong"`);
      if (ask.hints.length === 0) note('shape', way.id, ask.id, `ask ${ask.id} has no hint`);
      if (ask.pick !== null) {
        const right = ask.pick.filter((choice) => accepts(ask, choice)).length;
        if (right !== 1) refuse('solver', way.id, ask.id, `${right} of the choices ${ask.pick.join(', ')} are accepted by ask ${ask.id}; one should be`);
      }
      const solved = solveAsk(ask.prompt);
      if (solved !== null) {
        recomputed += 1;
        if (solved.candidates.some((candidate) => accepts(ask, candidate))) confirmed += 1;
        else refuse('solver', way.id, ask.id, `"${solved.sum}" is ${solved.candidates[0] ?? '?'}, and the ask accepts ${ask.accepted.join(' or ')}`);
      }
      if (own !== null && own.candidates.some((candidate) => accepts(ask, candidate))) reaches = true;
    }
    if (!reaches && own !== null && asksOf(way).length > 0) {
      refuse('solver', way.id, null, `the question "${own.sum}" is ${own.candidates[0] ?? '?'}, and no ask of way ${shortId(way.id)} accepts that: a way must ask for its question's answer`);
    }
  }
  return { kind: 'lesson', node: node.id, findings, confirmed, recomputed, asks, own: own === null ? null : (own.candidates[0] ?? null) };
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
  const ways = profileOf(doc, node) === 'steps' ? [node] : waysOf(doc, node).filter(isWay);
  for (const way of ways) {
    out.push(`  WAY ${shortId(way.id)}${way.tag === null ? '' : ` [${way.tag}]`}: ${way.title}`);
    for (const step of stepsOf(way)) {
      if (step.kind === 'step') {
        const show = step.show === null ? '' : ` [picture: ${step.show.visual}${step.show.range === null ? '' : ` ${step.show.range[0]}..${step.show.range[1]}`}${Object.entries(step.show.args).map(([key, value]) => ` ${key}=${value}`).join('')}]`;
        out.push(`    step${show}: ${step.words}`);
      } else {
        out.push(`    ASK ${step.id}: ${step.prompt}${step.pick === null ? ' (she types it)' : ` (she taps one of: ${step.pick.join(', ')})`}  ACCEPTED: ${step.accepted.join(' | ')}${step.unit === null ? '' : ` (${step.unit})`}`);
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
  const node = nodeOf(doc, id);
  const ways = node === null ? [] : profileOf(doc, node) === 'steps' ? [node] : waysOf(doc, node);
  const byAsk = new Map<string, LessonAsk>();
  for (const way of ways) for (const ask of asksOf(way)) byAsk.set(ask.id, ask);
  return (askId) => {
    const ask = askId === null ? undefined : byAsk.get(askId);
    if (ask === undefined) return 'silent';
    const solved = solveAsk(ask.prompt);
    if (solved === null) return 'silent';
    return solved.candidates.some((candidate) => accepts(ask, candidate)) ? 'agrees' : 'disagrees';
  };
}

export { matchAnswer };
