// Teaching (PLAN-v3-core WS7): what the brain is told so that it writes a lesson and not an answer.
//
// Nothing here is in the fixed system prompt, which is at its budget. The TEACH chapter rides in the turn's brief on its cues, as `tune` and
// the interface chapter do; the DOCUMENT and HERE blocks ride in every brief of a conversation that has a document. The chapter is built
// from the lesson tables (`LESSON_VERB`, `TECHNIQUE`, `VISUAL`, `LESSON_LIMITS`), so a word added to a table is taught without anyone
// remembering to; and its worked example is parsed by `pnpm timeline`, so it cannot rot.
//
// The learner is a young child (early primary). The brain gives approaches, not answers. Nobody here is named or described.

import type { DocNode, DocState, Document, NodeId } from './document';
import { askView, findNode, nodeOf, openAsks, pathOf, progressOf, revealed, ROOT, stopOf } from './document';
import { LESSON_VERB, TECHNIQUE, VISUAL } from './vocabulary';
import type { VisualKind } from './vocabulary';
import type { LessonAsk, LessonStep } from './lesson';
import { accepts, showTokens } from './lesson';
import type { TurnContext } from './context';
import type { TurnInput } from './wire';

// ---------------------------------------------------------------------------------------------------------------------------------
// the cues: when the chapter is carried
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The user's words ask for a lesson: working out, a lesson, a worksheet, homework, a child to be helped through something. "Teach me how a
 * clock works" is an explanation to watch and stays on the painted stage; the words here are a person who is to try it herself.
 */
const LESSON_WORDS =
  /\b(work(?:ing)?[- ]?outs?|working it out|work (?:it|this|that|these|them) out|show (?:the|her|his|their|my|your|me the) (?:working|work)|show (?:the )?working|(?:not|no) (?:the )?(?:solution|answer)|work(?:s|ing)? (?:her|him|them|me|us|my \w+) through|walk (?:her|him|them|me|us) through|work through|worksheets?|work ?sheets?|homework|lessons?|tutor(?:ing)?|practi[cs]e (?:sheet|questions|sums)|times tables?|number bonds?|sums?|(?:a |an |the )?\d{1,2}[- ]?(?:year|yr)s?[- ]?olds?|(?:grade|year|class) ?\d{1,2}|kindergarten|reception|early primary|primary school|first grade|second grade|third grade)\b/i;

/** With a photo attached, the words that make it a sheet to be worked through and not a picture to be looked at. */
const SHEET_WORDS = /\b(help|helps?|work(?:ing)?|through|page|sheet|homework|worksheets?|questions?|solve|sums?|maths?|math|check|answers?|exercise|practi[cs]e|teach|learn|explain|do(?:ing)?)\b/i;

/** Whether the words of this turn ask for a lesson. Photos with a question about a page count; photos alone, or of other things, do not. */
export function asksForLesson(input: TurnInput): boolean {
  if (input.kind !== 'prompt') return false;
  if (LESSON_WORDS.test(input.text)) return true;
  return (input.images?.length ?? 0) > 0 && SHEET_WORDS.test(input.text);
}

/** Whether the conversation has a document of parts: a lesson to go on with. Painted scenes alone are not one. */
export function hasLesson(context: Pick<TurnContext, 'document'>): boolean {
  const held = context.document;
  if (held === undefined) return false;
  const { document } = held;
  if (document.root !== ROOT) return true;
  return Object.values(document.nodes).some((node) => node.body !== null && node.body.kind === 'lesson');
}

/** Whether this turn carries the TEACH chapter: the words ask for a lesson, or a lesson is under way and the person is going on with it. */
export function carriesTeaching(context: Pick<TurnContext, 'document'>, input: TurnInput): boolean {
  return asksForLesson(input) || hasLesson(context);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the chapter
// ---------------------------------------------------------------------------------------------------------------------------------

/** The pictures a step may show, one line each, from the table: `numberline a..b mark= hops= step=`. */
function visualsText(): string {
  return (Object.keys(VISUAL) as VisualKind[])
    .map((name) => {
      const spec = VISUAL[name];
      const keys = Object.keys(spec.keys).map((key) => `${key}=`).join(' ');
      return `${name}${spec.range ? ' a..b' : ''}${keys === '' ? '' : ` ${keys}`}: ${spec.gist.replace(/^an? /, '')}`;
    })
    .join('; ');
}

/** The ways of going at a question, from the table. */
function techniquesText(): string {
  return Object.entries(TECHNIQUE)
    .map(([id, gist]) => `${id} (${gist})`)
    .join('; ');
}

/**
 * The routing card: which form an ask takes. It is the first thing in the chapter, because the fixed prompt teaches a painted answer and
 * the chapter must turn the brain away from it before anything else is read.
 */
export const ROUTING_CARD =
  'WHICH FORM: write it as the DOCUMENT (the lines below), because she is to try each small step herself; never `scene`, `say`, shapes or a mock-up for it, the lesson page draws it. Something to watch (a diagram, a chart, an explanation) stays painted. A photo that is not a sheet is answered from what you see, painted.';
  'WHICH FORM: a lesson, working-out, a worksheet or a photo of homework is written as the DOCUMENT (the lines below), because the learner is to try each small step herself. Never `scene`, `say`, shapes or a mock-up for it: the lesson page draws it. A picture to watch, a diagram, a chart or an explanation she only reads stays on the painted stage as always. A photo that is not a sheet (a drawing, a place, a thing) is answered from what you see, painted. If the ask is both (a worked sum, and a diagram of the idea), write the lesson, and show the idea with `show=`.';

/**
 * The worked example the chapter ends on. Every line parses; `pnpm timeline` reads it, refuses nothing in it and holds it to the rules the
 * chapter states. The sums are small and made up: nothing here is from a learner's page.
 */
export const TEACH_EXAMPLE: readonly string[] = [
  'part w1 | Sheet 1',
  'part q1 in=w1 | Ben has 3 bags with 4 apples in each. How many apples in all?',
  'part q1a in=q1 tag=draw-it | Draw the bags',
  'step in=q1a show=groups count=3 each=4 label=apples | Here are the 3 bags. Tap the apples in one bag to count them.',
  'step in=q1a | Every bag is the same. Count on by fours as you tap each bag: 4, then 8, then...',
  'ask a1 in=q1a is=12 pick=10,12,14 | How many apples in all 3 bags?',
  'hint in=a1 | Tap the bags one at a time and say the fours as you go.',
  'hint in=a1 | You counted 4, then 8. Add one more four.',
  'part q1b in=q1 tag=count-on-a-line | Hop along a number line',
  'step in=q1b show=numberline 0..16 step=4 | Each hop is one bag: 4 apples. We start at 0.',
  'ask a1 in=q1b is=12 | Hop 3 times. Where do you land?',
  'hint in=a1 | The first hop lands on 4. Where does the next hop land?',
  'part q2 in=w1 | Ben has 12 apples and eats 5. How many are left?',
  'reply | Three bags of four, counted by fours and then hopped along a line.',
];

/**
 * The TEACH chapter, said on a turn that asks for a lesson and while one goes on (never in the system prompt, which is full). It names the
 * form, how to read a sheet, how to build a way, and the rule that is kept by structure and taught here too: never lead with the answer.
 */
export function teachChapter(): string {
  const forms = Object.values(LESSON_VERB)
    .map((verb) => `  ${verb.form}`)
    .join('\n');
  return [
    'TEACH (a lesson, working-out, or help with a sheet or a photo of homework). The learner is a young child in her first years of school: short words, small steps, warm and plain. Give APPROACHES, never answers: the way there, in steps she does herself.',
    ROUTING_CARD,
    `LINES (each stands alone):\n${forms}`,
    `\`show=\` pictures: ${visualsText()}. A \`?\` in a list is a gap she fills. No picture fits: words only.`,
    `\`tag=\` ways: ${techniquesText()}.`,
    [
      'HOW:',
      '1. A sheet or photo: read all of it first. Reply with the OUTLINE: a `part` for the sheet, one for each section heading, one for EVERY question titled with the question as printed (unreadable: say so in the title, with "?"), titles only. Then fill only the FIRST question; the rest are written when she reaches them.',
      '2. A question gets three to five ways (`part <id> in=<question> tag=<way>`), each a different approach, three to six small steps and at least one `ask`. Start with the one she most likely knows.',
      '3. A step is one small thing, about twelve words she can read alone, and a `show=` when a picture helps. It sets up or does one piece (a group counted, one hop); the ask is the next piece. Say what to do ("Tap each flower"), never the result.',
      `4. NEVER LEAD WITH THE ANSWER. An \`ask\` seals its \`is=\`: nothing on the page before it, nor the ask's own words, may hold an answer it accepts: not a step's words ("5 x 12 = 60" beside the choices 50, 60, 70), not a number a \`show=\` is told (the hop that lands on it, \`parts=\` that add up to it), not a way's title, an earlier ask or hint. Show partial work ("12 + 12 so far"), never the total. Numbers the question itself holds are no secret. The reader refuses an ask that gives it away; then write the step again, same id, without it, and the ask.`,
      '5. An `ask` is the small question a way builds to, one answer in `is=` (numbers and number words are matched for you: `is=12` takes "twelve" and "12 apples"; add other spellings a child may type, `is=ten_pence,10p`). For a young child give `pick=` with three large choices, one right, instead of typing. Only after a step that sets it up.',
      '6. Two or three `hint in=<ask>`, one per wrong try, each nearer and none holding the answer: the first says where to look, the next the next small move. Never "wrong": say what to try.',
      '7. Finish with `reply | …`, one warm sentence for the thread on what she did and how, never the answer. A correction ("question 7 says 25, not 28") is the `part` written again with the same id.',
    ].join('\n'),
    `Example:\n${TEACH_EXAMPLE.map((line) => `  ${line}`).join('\n')}`,
  ].join('\n');
}

/** The chapter, built once: it is a function of the tables only. */
export const TEACH_CHAPTER: string = teachChapter();

// ---------------------------------------------------------------------------------------------------------------------------------
// the DOCUMENT and HERE blocks
// ---------------------------------------------------------------------------------------------------------------------------------

/** What one brief may say of the document, and how far it reads before it folds. */
export const DOCUMENT_BRIEF = { lines: 40, title: 56, stepsOnStage: 6, words: 90 } as const;

/** The brain's own id of a node: the last segment of its path. */
function shortId(id: NodeId): string {
  const at = id.lastIndexOf('/');
  return at < 0 ? id : id.slice(at + 1);
}

function cut(text: string, most: number): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain.length > most ? `${plain.slice(0, most - 1).trimEnd()}…` : plain;
}

function isWay(node: DocNode): boolean {
  return node.body !== null && node.body.kind === 'lesson';
}

/** Whether anything under `node` has been written (a body). `…` in the block is a part that has none. */
function written(doc: Document, node: DocNode): boolean {
  if (node.body !== null) return true;
  return node.children.some((child) => {
    const held = nodeOf(doc, child);
    return held !== null && written(doc, held);
  });
}

function lessonAsks(node: DocNode): readonly LessonAsk[] {
  return node.body !== null && node.body.kind === 'lesson' ? node.body.steps.filter((step): step is LessonAsk => step.kind === 'ask') : [];
}

/** Whether each ask of a way was right on the first try: every one with tries, every first try accepted. Null when nothing was tried. */
function firstTry(node: DocNode, state: DocState): boolean | null {
  const progress = progressOf(state, node.id);
  const asks = lessonAsks(node).filter((ask) => (progress.tries[ask.id]?.length ?? 0) > 0);
  if (asks.length === 0) return null;
  return asks.every((ask) => accepts(ask, progress.tries[ask.id]?.[0] ?? ''));
}

/** Whether she has reached the end of a way: every ask of it holds an accepted try. */
function wayDone(node: DocNode, state: DocState): boolean {
  if (progressOf(state, node.id).done) return true;
  const asks = lessonAsks(node);
  if (asks.length === 0) return false;
  const progress = progressOf(state, node.id);
  return asks.every((ask) => (progress.tries[ask.id] ?? []).some((text) => accepts(ask, text)));
}

function touched(node: DocNode, state: DocState): boolean {
  const progress = progressOf(state, node.id);
  return progress.seen > 0 || Object.keys(progress.tries).length > 0 || progress.done;
}

type Mark = '✓' | '▸' | '·' | '…';

interface Row {
  readonly depth: number;
  readonly mark: Mark;
  readonly text: string;
  /** the node, and whether it is on the way to where she is: the rows that are never folded away */
  readonly node: NodeId;
  readonly near: boolean;
}

/** `q2a "number line", step 3 of 5; tried "40", hint 1 shown`: where she is in a way, in a line. */
function wayLine(doc: Document, state: DocState, way: DocNode): string {
  const steps = way.body !== null && way.body.kind === 'lesson' ? way.body.steps : [];
  const at = state.cursor.node === way.id ? (stopOf(state.cursor) ?? 0) + 1 : Math.max(progressOf(state, way.id).seen, 0);
  const ask = openAskIn(doc, state, way);
  const tried = ask === null ? '' : (ask.tries.length === 0 ? '' : `; tried ${ask.tries.map((text) => `"${cut(text, 20)}"`).join(', ')}${ask.accepted ? ' (right)' : ask.wrong > 0 ? `, hint ${Math.min(ask.wrong, ask.ask.hints.length)} shown` : ''}`);
  return `way ${shortId(way.id)} "${cut(way.title, 30)}"${way.tag === null ? '' : ` (${way.tag})`}, step ${Math.min(Math.max(at, 1), Math.max(steps.length, 1))} of ${steps.length}${tried}`;
}

/** The ask she is on in a way: the newest ask at or before where she has reached. Null when there is none. */
function openAskIn(doc: Document, state: DocState, way: DocNode): ReturnType<typeof askView> {
  const reach = state.cursor.node === way.id ? (stopOf(state.cursor) ?? 0) : Math.max(progressOf(state, way.id).seen - 1, 0);
  const steps = way.body !== null && way.body.kind === 'lesson' ? way.body.steps : [];
  for (let at = Math.min(reach, steps.length - 1); at >= 0; at -= 1) {
    const step = steps[at];
    if (step?.kind === 'ask') return askView(doc, state, way.id, step.id);
  }
  return null;
}

/** The lines of the tree under `id`, ways folded into their question's line unless she is in that question. */
function rows(doc: Document, state: DocState, id: NodeId, depth: number, path: ReadonlySet<NodeId>, out: Row[]): void {
  const node = nodeOf(doc, id);
  if (node === null || id.startsWith('#')) return;
  const ways = node.children.map((child) => nodeOf(doc, child)).filter((child): child is DocNode => child !== null && isWay(child));
  const sub = node.children.map((child) => nodeOf(doc, child)).filter((child): child is DocNode => child !== null && !isWay(child) && !child.id.startsWith('#'));
  const here = path.has(id);
  if (isWay(node)) return;
  const isQuestion = ways.length > 0 || (sub.length === 0 && node.children.length === 0 && node.parent !== null);
  if (!isQuestion) {
    out.push({ depth, mark: here ? '▸' : '·', text: `${shortId(id)} "${cut(node.title, DOCUMENT_BRIEF.title)}"${sub.length > 0 ? ` (${sub.length})` : ''}`, node: id, near: here });
    for (const child of sub) rows(doc, state, child.id, depth + 1, path, out);
    return;
  }
  const open = ways.filter((way) => touched(way, state));
  const done = progressOf(state, id).done || ways.some((way) => wayDone(way, state));
  const mark: Mark = here ? '▸' : ways.length === 0 || !written(doc, node) ? '…' : done ? '✓' : '·';
  let note: string;
  if (ways.length === 0) note = 'named, not written';
  else if (here) {
    const current = ways.find((way) => path.has(way.id)) ?? ways[0];
    note = current === undefined ? `${ways.length} ways` : `${wayLine(doc, state, current)}; ${ways.length} ways written (${ways.map((way) => shortId(way.id)).join(', ')})`;
  } else if (open.length > 0) {
    const first = open.map((way) => firstTry(way, state)).filter((value): value is boolean => value !== null);
    note = `${open.length} of ${ways.length} ways seen${first.length > 0 && first.every(Boolean) ? '; right first try' : first.some(Boolean) ? '; some tries wrong' : first.length > 0 ? '; not yet right' : ''}`;
  } else note = `${ways.length} ways written, not opened`;
  out.push({ depth, mark, text: `${shortId(id)} "${cut(node.title, DOCUMENT_BRIEF.title)}": ${note}`, node: id, near: here });
  // a question she is not in has its ways in its line; the ones she is in are listed under it
}

/** Folds the far siblings of each run into one line, until the block fits `DOCUMENT_BRIEF.lines`. */
function fold(list: readonly Row[], limit: number): Row[] {
  if (list.length <= limit) return [...list];
  for (let radius = 3; radius >= 0; radius -= 1) {
    const kept: Row[] = [];
    let run: Row[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      if (run.length <= 2) kept.push(...run);
      else {
        const first = run[0];
        const last = run[run.length - 1];
        const marks = new Set(run.map((row) => row.mark));
        const mark: Mark = marks.size === 1 ? (run[0]?.mark ?? '·') : '·';
        if (first !== undefined && last !== undefined) kept.push({ depth: first.depth, mark, text: `${first.text.split(' ')[0] ?? ''} … ${last.text.split(' ')[0] ?? ''} (${run.length})`, node: first.node, near: false });
      }
      run = [];
    };
    const nearIndexes = list.flatMap((row, index) => (row.near ? [index] : []));
    list.forEach((row, index) => {
      const close = nearIndexes.some((at) => Math.abs(at - index) <= radius);
      if (row.near || close) {
        flush();
        kept.push(row);
      } else run.push(row);
    });
    flush();
    if (kept.length <= limit) return kept;
  }
  const head = list.filter((row) => row.near).slice(0, limit - 1);
  return [...head, { depth: 1, mark: '·', text: `and ${list.length - head.length} more`, node: '', near: false }];
}

/** Whether a document is worth a block: it has parts a person made (a sheet, a question), not only painted scenes. */
export function isLessonDocument(document: Document): boolean {
  return document.root !== ROOT || Object.values(document.nodes).some((node) => isWay(node));
}

/**
 * `DOCUMENT`: the tree as the brain last left it and as she has used it, bounded to forty lines with the far siblings folded. The brain is
 * told this in every brief, so a fresh process knows the sheet, which questions are written, and where she is.
 */
export function documentText(document: Document, state: DocState): string | null {
  if (!isLessonDocument(document)) return null;
  const path = new Set(pathOf(document, state.cursor.node).map((node) => node.id));
  const list: Row[] = [];
  const root = nodeOf(document, document.root);
  if (root === null) return null;
  list.push({ depth: 0, mark: path.has(root.id) ? '▸' : '·', text: `${shortId(root.id)} "${cut(root.title, DOCUMENT_BRIEF.title)}"`, node: root.id, near: path.has(root.id) });
  for (const child of root.children) rows(document, state, child, 1, path, list);
  const body = fold(list, DOCUMENT_BRIEF.lines - 1);
  return ['DOCUMENT  ✓ done  ▸ here  · written, not yet opened  … named, not written', ...body.map((row) => `${'  '.repeat(row.depth)}${row.mark} ${row.text}`)].join('\n');
}

function describeStep(step: LessonStep, index: number, state: DocState, doc: Document, node: NodeId): string {
  if (step.kind === 'step') {
    const show = step.show === null ? '' : ` [${showTokens(step.show).join(' ')}]`;
    return `step ${index + 1}${show}${step.words === '' ? '' : ` "${cut(step.words, DOCUMENT_BRIEF.words)}"`}`;
  }
  const view = askView(doc, state, node, step.id);
  const status = view === null ? '' : view.accepted ? ', answered' : view.open ? ', open' : ', open, not yet tried';
  return `ask ${step.id} "${cut(step.prompt, DOCUMENT_BRIEF.words)}"${step.pick === null ? '' : ` (choices ${step.pick.join(', ')})`}${status}`;
}

/**
 * `HERE`: where she is and what is in front of her, from the document and her state. A lesson's stage is the steps shown so far; the brain
 * is told each, her tries and the hint she has been shown, so that "I don't get it" is answered about the step she is looking at.
 */
export function hereText(document: Document, state: DocState): string | null {
  if (!isLessonDocument(document)) return null;
  const node = nodeOf(document, state.cursor.node);
  if (node === null) return null;
  if (!isWay(node)) {
    const kind = node.children.length > 0 ? 'on the page of' : 'at';
    return `HERE  ${kind} ${shortId(node.id)} "${cut(node.title, DOCUMENT_BRIEF.title)}"; she has not opened a way yet.`;
  }
  const steps = revealed(document, state, node.id);
  const shown = steps.slice(-DOCUMENT_BRIEF.stepsOnStage);
  const first = steps.length - shown.length;
  const parent = node.parent === null ? null : nodeOf(document, node.parent);
  const asks = steps.filter((step): step is LessonAsk => step.kind === 'ask');
  const held = asks.flatMap((ask) => {
    const view = askView(document, state, node.id, ask.id);
    if (view === null || view.tries.length === 0) return [];
    return [`${ask.id} = ${view.tries.map((text) => `"${cut(text, 24)}"`).join(', ')}${view.accepted ? ' (right)' : ` (not yet right; ${Math.min(view.wrong, ask.hints.length)} of ${ask.hints.length} hints shown)`}`];
  });
  const sealedNow = openAsks(document, state, node.id);
  return [
    `HERE  ${shortId(node.id)} "${cut(node.title, 40)}"${parent === null ? '' : ` of ${shortId(parent.id)} "${cut(parent.title, 40)}"`}, step ${Math.max(steps.length, 1)} of ${node.body !== null && node.body.kind === 'lesson' ? node.body.steps.length : 0}. On stage: ${shown.map((step, at) => describeStep(step, first + at, state, document, node.id)).join('; ')}.`,
    `  Held: ${held.length === 0 ? 'nothing tried yet' : held.join('; ')}.${sealedNow.length > 0 ? ' She is working on an open ask: do not say its answer.' : ''}`,
  ].join('\n');
}

/** The block pair the brief carries, or null for a conversation with no document of parts. */
export function documentBlocks(context: Pick<TurnContext, 'document'>): string | null {
  const held = context.document;
  if (held === undefined) return null;
  const tree = documentText(held.document, held.state);
  if (tree === null) return null;
  const here = hereText(held.document, held.state);
  return here === null ? tree : `${tree}\n${here}`;
}

/** Looks a way up by the short id the brain wrote. For the checks. */
export function wayByShortId(document: Document, short: string): DocNode | null {
  return findNode(document, short);
}
