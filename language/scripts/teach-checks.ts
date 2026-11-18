// Checks of what the brain is taught about documents (split by GEN1a): the DOCUMENT chapter is neutral and short and names every
// line; the technique cards that write documents (a young learner, a recipe, a review, a plan) fold with nothing refused or repaired; a card with
// parts brings the chapter; and the DOCUMENT and HERE blocks at the start, mid-document and on a sheet of thirty questions. Run by `pnpm timeline`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DOCUMENT_CHAPTER,
  EMPTY_STAGE,
  FULL_CAPABILITIES,
  LEAD_WINDOW,
  LESSON_VERB,
  LESSON_VERBS,
  REFERENCE_SCREEN,
  VISUAL_KINDS,
  advance,
  buildTurnBrief,
  documentText,
  estimateTokens,
  foldSource,
  hereText,
  initialState,
  lintLesson,
  nodeOf,
  techniquesText,
} from '../src/index';
import type { DocState, Document, TechniqueCard, TurnContext, TurnInput } from '../src/index';

let passed = 0;
let ok = true;

function expect(what: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    passed += 1;
    return;
  }
  ok = false;
  process.stdout.write(`  TEACH CHECK FAILED: ${what}\n      got    ${a}\n      wanted ${b}\n`);
}

const prompt = (text: string, images?: readonly string[]): TurnInput => ({ kind: 'prompt', text, ...(images === undefined ? {} : { images }) });

function checkChapter(): void {
  for (const verb of LESSON_VERBS) expect(`chapter has the form of ${verb}`, DOCUMENT_CHAPTER.includes(LESSON_VERB[verb].form), true);
  for (const id of VISUAL_KINDS) expect(`chapter names ${id}`, DOCUMENT_CHAPTER.includes(id), true);
  expect('chapter says what an ask seals', /SEALED/.test(DOCUMENT_CHAPTER), true);
  expect('chapter teaches outline then fill', /OUTLINE, THEN FILL/.test(DOCUMENT_CHAPTER), true);
  expect('chapter teaches for=, check=any and check=done', [DOCUMENT_CHAPTER.includes('for=<ask>'), DOCUMENT_CHAPTER.includes('check=any'), DOCUMENT_CHAPTER.includes('check=done')], [true, true, true]);
  expect('chapter is neutral: no child, no she, no maths ways', /\b(child|young|learner|she|her|homework|worksheet)\b|draw-it|count-on/i.test(DOCUMENT_CHAPTER), false);
  const tokens = estimateTokens(DOCUMENT_CHAPTER);
  expect(`chapter within 1,300 estimated tokens (is ${tokens})`, tokens <= 1300, true);
  process.stdout.write(`  document chapter: ${DOCUMENT_CHAPTER.length} characters, about ${tokens} tokens\n`);
}

/** The cards that write a document: every fenced example of a seed file with a `part` line. */
function cards(): { readonly file: string; readonly lines: readonly string[] }[] {
  const dir = fileURLToPath(new URL('../../techniques/seed/', import.meta.url));
  const out: { file: string; lines: string[] }[] = [];
  for (const file of ['teach-young-learner.md', 'recipe-steps.md', 'review-a-document.md', 'plan-a-trip.md']) {
    const block = /```series\n([\s\S]*?)```/.exec(readFileSync(`${dir}${file}`, 'utf8'));
    out.push({ file, lines: (block?.[1] ?? '').split('\n').filter((line) => line.trim() !== '') });
  }
  return out;
}

function checkCards(): void {
  for (const { file, lines } of cards()) {
    const folded = foldSource(lines.join('\n'), 'prompt');
    expect(`${file}: nothing refused or repaired`, folded.issues.map((found) => `${found.text}: ${found.issue.message}`), []);
    expect(`${file}: at most 24 lines`, lines.length <= 24, true);
    for (const id of Object.keys(folded.document.nodes)) {
      const node = nodeOf(folded.document, id);
      if (node?.body?.kind !== 'lesson') continue;
      const question = node.parent === null ? [] : [nodeOf(folded.document, node.parent)?.title ?? ''];
      expect(`${file}: no spoiler in ${node.id}`, lintLesson(node.body.steps, { question, way: node.for === null ? null : node.title }), []);
    }
    expect(`${file}: its example says no name`, /\bTammy\b/.test(lines.join(' ')), false);
  }
  const young = cards().find((card) => card.file === 'teach-young-learner.md');
  const folded = foldSource((young?.lines ?? []).join('\n'), 'prompt').document;
  const helps = Object.values(folded.nodes).filter((node) => node.for !== null);
  expect('young learner: two ways, each for the ask on the question', helps.map((node) => node.for), ['a0', 'a0']);
  const q1 = nodeOf(folded, 'w1/q1');
  const ask = q1?.body?.kind === 'lesson' ? q1.body.steps.find((step) => step.kind === 'ask') : undefined;
  expect('young learner: the ladder is facts first, with the facts marked', [ask?.kind === 'ask' ? /\[[^\]]+\]/.test(ask.hints[0] ?? '') : null, ask?.kind === 'ask' ? ask.hints.length : 0], [true, 3]);
  const recipe = foldSource((cards().find((card) => card.file === 'recipe-steps.md')?.lines ?? []).join('\n'), 'prompt').document;
  const kinds = Object.values(recipe.nodes).flatMap((node) => (node.body?.kind === 'lesson' ? node.body.steps.flatMap((step) => (step.kind === 'ask' ? [step.check ?? 'answer'] : [])) : []));
  expect('recipe: a done tick and a choice, neither sealed', [kinds.includes('done'), kinds.includes('any')], [true, true]);
}

function context(document: Document | null, state: DocState | null): TurnContext {
  return {
    screen: REFERENCE_SCREEN,
    capabilities: FULL_CAPABILITIES,
    services: { paint: false, sight: 'report', review: false, uploads: true },
    lead: LEAD_WINDOW,
    stage: EMPTY_STAGE,
    history: [],
    heard: [],
    ...(document === null || state === null ? {} : { document: { document, state } }),
  };
}

function sheetOf(count: number): string {
  const lines = ['part w1 | Sheet 1', 'part s1 in=w1 | Take away tens'];
  for (let n = 1; n <= count; n += 1) lines.push(`part q${n} in=s1 | ${60 + n} - 30 =`);
  lines.push('part q1a in=q1 tag=count-on-a-line | Hop back along a number line');
  lines.push('step in=q1a show=numberline 0..70 mark=61 hops=-10,-10,-10 | Thirty is three tens. Hop back ten, three times.');
  lines.push('ask a1 in=q1a is=31 | Where did you land?');
  lines.push('hint in=a1 | Start at 61. One hop back is ten less.');
  lines.push('hint in=a1 | Say each landing place: 51, 41...');
  return lines.join('\n');
}

function checkBlocks(): void {
  const { document } = foldSource(sheetOf(10), 'prompt');
  const start = initialState(document);
  const before = documentText(document, start) ?? '';
  expect('blocks: the document block opens with its key', before.split('\n')[0], 'DOCUMENT  ✓ done  ▸ here  · written, not yet opened  … named, not written');
  expect('blocks: q1 is written, q2 is named only', [/q1 "61 - 30 =": 1 ways? written/.test(before) || /q1 "61 - 30 =": .*written/.test(before), /… q2 "62 - 30 =": named, not written/.test(before)], [true, true]);
  // she opens the way, tries 40, then 31
  let state = advance(document, start, { kind: 'cursor', cursor: { node: 'w1/s1/q1/q1a', play: { at: 1 } } });
  state = advance(document, state, { kind: 'try', node: 'w1/s1/q1/q1a', ask: 'a1', value: '40' });
  const mid = documentText(document, state) ?? '';
  const here = hereText(document, state) ?? '';
  expect('blocks: the question she is in is marked and says where', /▸ q1 "61 - 30 =": way q1a "Hop back along a number line" \(count-on-a-line\), step 2 of 2; tried "40", hint 1 shown/.test(mid), true);
  expect('blocks: HERE names the way and the step', here.startsWith('HERE  q1a "Hop back along a number line" of q1 "61 - 30 =", step 2 of 2.'), true);
  expect('blocks: HERE holds her try and the hints shown', here.includes('a1 = "40" (not yet right; 1 of 2 hints shown)'), true);
  expect('blocks: HERE says an ask is open', here.includes('do not say its answer'), true);
  state = advance(document, state, { kind: 'try', node: 'w1/s1/q1/q1a', ask: 'a1', value: '31' });
  expect('blocks: HERE says it was right once it was', (hereText(document, state) ?? '').includes('(right)'), true);
  state = advance(document, state, { kind: 'done', node: 'w1/s1/q1/q1a', done: true });
  state = advance(document, state, { kind: 'cursor', cursor: { node: 'w1/s1/q2', play: 0 } });
  const after = documentText(document, state) ?? '';
  expect('blocks: a finished question is ticked', /✓ q1 "61 - 30 =": 1 of 1 ways seen; right first try/.test(after) || /✓ q1 /.test(after), true);
  // a sheet of thirty questions folds to forty lines, and the question she is on stays
  const big = foldSource(sheetOf(45), 'prompt').document;
  const bigState = advance(big, initialState(big), { kind: 'cursor', cursor: { node: 'w1/s1/q27', play: 0 } });
  const folded = (documentText(big, bigState) ?? '').split('\n');
  expect(`blocks: forty-five questions fit in forty lines (is ${folded.length})`, folded.length <= 40, true);
  expect('blocks: the question she is on stays in', folded.some((row) => row.includes('q27 ')), true);
  expect('blocks: the far ones are folded into runs', folded.some((row) => /q\d+ … q\d+ \(\d+\)/.test(row)), true);
  // a painted conversation has no document block
  expect('blocks: a flat conversation has none', documentText(foldSource('scene\nsay a | hello', 'prompt').document, initialState(null)), null);
}

function checkBrief(): void {
  const { document } = foldSource(sheetOf(3), 'prompt');
  const state = initialState(document);
  const plain = buildTurnBrief(context(null, null), prompt('draw a cat on a wall'));
  expect('brief: an ordinary ask carries no chapter', plain.includes('DOCUMENT (parts') || plain.includes('DOCUMENT  '), false);
  const going = buildTurnBrief(context(document, state), prompt('next question please'));
  expect('brief: a document under way carries the chapter and both blocks', [going.includes('DOCUMENT (parts'), going.includes('DOCUMENT  '), going.includes('\nHERE  ')], [true, true, true]);
  expect('brief: the blocks come before NOW', going.indexOf('\nHERE  ') < going.indexOf('\nNOW: '), true);
  // a card that writes parts brings the chapter, on any words; a card that does not does not
  const card = (id: string, example: readonly string[]): TechniqueCard => ({ id, title: id, when: 'when', example });
  const withParts = buildTurnBrief({ ...context(null, null), techniques: [card('recipe', ['part r1 | Pancakes', 'ask d1 in=r1 check=done | Done'])] }, prompt('walk me through pancakes'));
  expect('brief: a card with parts carries the chapter', withParts.includes('DOCUMENT (parts'), true);
  const without = buildTurnBrief({ ...context(null, null), techniques: [card('table', ['scene caption', 'say | hi'])] }, prompt('compare two things'));
  expect('brief: a card without parts does not', without.includes('DOCUMENT (parts'), false);
  const big = techniquesText([card('long', ['part r1 | ' + 'x'.repeat(2400), 'ask d1 in=r1 check=done | Done'])]) ?? '';
  expect('brief: a card that writes a document is allowed its room', big.includes('part r1'), true);
}

/** Run by `pnpm timeline`. */
export function teachChecks(): boolean {
  checkChapter();
  checkCards();
  checkBlocks();
  checkBrief();
  process.stdout.write(`\nteach checks: ${passed} held${ok ? '' : ', some failed'}\n`);
  return ok;
}
