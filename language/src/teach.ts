// The document chapter (PLAN-v3-core WS7, split by GEN1a): what the brain is told so that it writes a document of parts, and nothing about whom it is for.
//
// Nothing here is in the fixed system prompt. The DOCUMENT chapter rides in the turn's brief whenever a document of parts exists, or a technique
// card the library chose writes one (`usesParts`). What a particular kind of document teaches (a lesson for a young learner, a recipe, a review,
// a plan) is a technique card in `techniques/seed/`, chosen by `selectTechniques` like every other: no English is matched here. The chapter is built
// from the lesson tables (`LESSON_VERB`, `VISUAL`, `LESSON_LIMITS`), so a word added to a table is taught without anyone remembering to; the cards'
// examples are parsed by `pnpm timeline`, so they cannot rot. Nobody here is named or described.

import type { DocNode, DocState, Document, NodeId } from './document';
import { askView, findNode, nodeOf, openAsks, pathOf, progressOf, revealed, ROOT, stopOf } from './document';
import { LESSON_VERB, VISUAL } from './vocabulary';
import type { VisualKind } from './vocabulary';
import type { LessonAsk, LessonStep } from './lesson';
import { accepts, showTokens } from './lesson';
import type { TechniqueCard, TurnContext } from './context';

// ---------------------------------------------------------------------------------------------------------------------------------
// when the chapter is carried
// ---------------------------------------------------------------------------------------------------------------------------------

/** Whether the conversation has a document of parts: a document to go on with. Painted scenes alone are not one. */
export function hasLesson(context: Pick<TurnContext, 'document'>): boolean {
  const held = context.document;
  if (held === undefined) return false;
  const { document } = held;
  if (document.root !== ROOT) return true;
  return Object.values(document.nodes).some((node) => node.body !== null && node.body.kind === 'lesson');
}

/** Whether a technique card writes a document of parts: its example has a `part` line. */
export function usesParts(cards: readonly TechniqueCard[] | undefined): boolean {
  return (cards ?? []).some((card) => card.example.some((line) => /^\s*part\s/.test(line)));
}

/** Whether this turn carries the DOCUMENT chapter: a document of parts exists, or a card the library chose writes one. */
export function carriesDocument(context: Pick<TurnContext, 'document' | 'techniques'>): boolean {
  return hasLesson(context) || usesParts(context.techniques);
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
      return `${name}${spec.range ? ' a..b' : ''}${keys === '' ? '' : ` ${keys}`}`;
    })
    .join('; ');
}

/**
 * The DOCUMENT chapter: short and neutral. It teaches the parts, the asks, sealing, outline then fill and "the person". Who the person is and
 * what a good document for them looks like is the technique card's to say.
 */
export function documentChapter(): string {
  const forms = Object.values(LESSON_VERB)
    .map((verb) => `  ${verb.form}`)
    .join('\n');
  return [
    'DOCUMENT (parts the person works through one at a time: items to do, steps to follow, clauses to review, days to plan). Write it as the lines below, never as a painted scene; the page draws it. Something to watch (a diagram, a chart) stays painted. Say "the person" in anything you write for the page, and take their level, pace and words from the TECHNIQUES chosen for this turn.',
    `LINES (each stands alone):\n${forms}`,
    `\`show=\` pictures: ${visualsText()}. A \`?\` in a list is a gap they fill. No picture fits: words only.`,
    [
      'HOW:',
      '1. OUTLINE, THEN FILL. A source (a sheet, a photo, a brief, a document) is read all the way first. Reply with the outline: a `part` for the whole and one for each section and each item, titled as the source words it, titles only (unreadable: say so in the title, with "?"). For a photo, give each item\'s box on it, `crop=x,y,w,h` in whole percents of its width and height from the top left, around the item and what it is about (`from=<photo id>` when there are several). Then write only the FIRST item; the rest are written for you as the person nears them.',
      '2. A part is one unit of work: an `ask` the person answers, `step`s that reveal as they go, `hint`s they pull. Help for an ask is its own parts, each `for=<ask>`; `tag=` is any one word for what kind of help (a way, a variation, a clause explained). Help is asked for, never shown first.',
      '3. SEALED. An `ask` seals its `is=`: nothing before it may hold an answer it accepts (not a step\'s words, a `show=` value, a title, an earlier ask or hint). Show partial work, never the total. The reader refuses an ask that gives it away: write the part again, same id, without it. `is=` takes every accepted spelling (numbers and number words are matched for you).',
      '4. No single right answer: `ask <id> check=any pick=<a>,<b>,<c> | <question>` (one word an option, `_` for a space) is a choice that opens the next part once something is chosen (no `is=`); `ask <id> check=done | <step>` is a tick for "done". Neither is checked.',
      '5. A step is one small thing the person can read alone, and a `show=` when a picture helps: say what to do, never the result.',
      '6. Finish with `reply | …`, one sentence for the thread on what they did and how.',
      '7. WHERE A PART GOES. A new document (another sheet, recipe or plan) is a top-level `part` with no `in=`, under new ids: never `in=` a part of another document. `in=` names only a part of the same document, already written. A document asked for again is written again under the SAME ids (it opens again). To go on with a document, refer to its parts by their ids (`part q3a in=q3`, `ask in=q3`).',
    ].join('\n'),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the ask on the stage (HI1)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Whether a technique card writes an ask that stands on the stage: its example has an `ask` line and no `part`. */
export function usesStageAsk(cards: readonly TechniqueCard[] | undefined): boolean {
  return (cards ?? []).some((card) => card.example.some((line) => /^\s*ask\s/.test(line)) && !card.example.some((line) => /^\s*part\s/.test(line)));
}


/** Whether this turn carries the ASK chapter: an ask stands on the stage, or a card the library chose writes one. Never matched on the user's words. */
export function carriesAsk(context: Pick<TurnContext, 'techniques'>, onStage: boolean): boolean {
  return onStage || usesStageAsk(context.techniques);
}

/**
 * The ASK chapter: something the person works out or chooses, set on the stage, checked on a press. Neutral: it says what the lines mean and what
 * holds, and nothing about a subject, a level or whom it is for (the technique card says that). The forms of `ask` and `hint` are the DOCUMENT
 * chapter's when it is carried too, and are printed once.
 */
export function askChapter(withDocument: boolean): string {
  return [
    'ASK ON THE STAGE (for the person to work out or choose, set in the picture and checked on their press; never an app): an `ask` with no `part` open, then its `hint`s.',
    withDocument ? '' : 'FORMS: `ask <id> is=<a>,<b> | words with one __ where the answer goes` (typed); `… pick=<x>,<y> | …` (large choices); `ask <id> check=any pick=<x>,<y> | …` (their own choice); `send=yes|no`; `hint | words` (behind a tap).',
    '- Asks open in order, each when the one before is right or given up: write the whole breakdown at once, after a `scene stack` and the words that set the question.',
    '- The key is `is=` (every accepted spelling) and nowhere else: not in a `say`, a hint, a title or another ask\'s words. A line that shows it is refused.',
    '- A hint asks back or says what to try, never the step that gives the answer.',
    '- You hear of their tries on your next turn, and at once when the last ask is done (`send=no` waits, `send=yes` tells you now).',
    '- An answer they give by pen marks, voice or chat goes in with `fill <ask id> | <answer>` (the page shows and checks it): that is the only way a blank gets filled, so never say you filled one otherwise.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The chapter, built once: it is a function of the tables only. */
export const DOCUMENT_CHAPTER: string = documentChapter();
export const ASK_CHAPTER: string = askChapter(false);
export const ASK_CHAPTER_WITH_DOCUMENT: string = askChapter(true);

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
