// Checks of what the brain is taught about lessons (PLAN-v3-core WS7): the cues of the TEACH chapter, its worked example (it reads, and
// nothing in it is refused), the chapter's size and what it names, and the DOCUMENT and HERE blocks at the start, mid-lesson and on a
// sheet of thirty questions. Run by `pnpm timeline`.
import {
  EMPTY_STAGE,
  FULL_CAPABILITIES,
  LEAD_WINDOW,
  LESSON_VERB,
  LESSON_VERBS,
  REFERENCE_SCREEN,
  TEACH_CHAPTER,
  TEACH_EXAMPLE,
  TECHNIQUES,
  VISUAL_KINDS,
  advance,
  asksForLesson,
  buildTurnBrief,
  documentText,
  estimateTokens,
  foldSource,
  hereText,
  initialState,
  lintLesson,
  nodeOf,
} from '../src/index';
import type { DocState, Document, TurnContext, TurnInput } from '../src/index';

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

/** [the words, whether a photo is attached, whether they ask for a lesson] */
const CUES: readonly (readonly [string, boolean, boolean])[] = [
  ['a florist had 3 kinds of flowers for 5 vases, 6 yellow, 2 blue and 4 green in each vase, how many altogether? show the working out not the solution, for a 7 year old', false, true],
  ['help her work through this page', true, true],
  ['help her work through this page', false, true],
  ['can you check her homework', false, true],
  ['do question 3 now', true, true],
  ['make me a lesson on adding tens', false, true],
  ['what is the capital of France', false, false],
  ['teach me how a clock works', false, false],
  ['draw a cat on a wall', false, false],
  ['what breed is this dog', true, false],
  ['', true, false],
  ['show the price of copper this year', false, false],
];

function checkCues(): void {
  for (const [text, photo, want] of CUES) expect(`cue: ${text === '' ? '(no words)' : text.slice(0, 50)}${photo ? ' + photo' : ''}`, asksForLesson(prompt(text, photo ? ['u1'] : undefined)), want);
  expect('cue: a tap is not a request for a lesson', asksForLesson({ kind: 'tap', id: 'x', text: 'help' }), false);
}

function checkChapter(): void {
  for (const verb of LESSON_VERBS) expect(`chapter has the form of ${verb}`, TEACH_CHAPTER.includes(LESSON_VERB[verb].form), true);
  for (const id of [...TECHNIQUES, ...VISUAL_KINDS]) expect(`chapter names ${id}`, TEACH_CHAPTER.includes(id), true);
  expect('chapter says never to lead with the answer', /NEVER LEAD WITH THE ANSWER/.test(TEACH_CHAPTER), true);
  expect('chapter has the routing card', TEACH_CHAPTER.includes('WHICH FORM'), true);
  expect('chapter is for a young learner', /young child/.test(TEACH_CHAPTER), true);
  const tokens = estimateTokens(TEACH_CHAPTER);
  expect(`chapter within 2,600 estimated tokens, the interface chapter being 1,692 (is ${tokens})`, tokens <= 2600, true);
  process.stdout.write(`  teach chapter: ${TEACH_CHAPTER.length} characters, about ${tokens} tokens\n`);
}

function checkExample(): void {
  const folded = foldSource(TEACH_EXAMPLE.join('\n'), 'prompt');
  expect('example: nothing refused or repaired', folded.issues.map((found) => `${found.text}: ${found.issue.message}`), []);
  const { document } = folded;
  expect('example: the sheet, a question, two ways and an outlined question', Object.keys(document.nodes).sort(), ['w1', 'w1/q1', 'w1/q1/q1a', 'w1/q1/q1b', 'w1/q2']);
  expect('example: the second question is an outline', nodeOf(document, 'w1/q2')?.body, null);
  const ways = (['w1/q1/q1a', 'w1/q1/q1b'] as const).map((id) => nodeOf(document, id));
  expect('example: both ways are lessons with an ask', ways.map((way) => way?.body?.kind === 'lesson' && way.body.steps.some((step) => step.kind === 'ask')), [true, true]);
  expect('example: both ways are tagged', ways.map((way) => way?.tag), ['draw-it', 'count-on-a-line']);
  for (const way of ways) {
    if (way?.body?.kind !== 'lesson') continue;
    expect(`example: no spoiler in ${way.id}`, lintLesson(way.body.steps, { question: [nodeOf(document, 'w1/q1')?.title ?? ''], way: way.title }), []);
  }
  expect('example: the thread sentence is kept', Object.values(folded.replies), ['Three bags of four, counted by fours and then hopped along a line.']);
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
  const lesson = buildTurnBrief(context(null, null), prompt('show the working out for 5 x 12, for a 7 year old'));
  expect('brief: a lesson ask carries the chapter', lesson.includes('TEACH (a lesson'), true);
  const plain = buildTurnBrief(context(null, null), prompt('draw a cat on a wall'));
  expect('brief: an ordinary ask does not', plain.includes('TEACH (') || plain.includes('DOCUMENT  '), false);
  const going = buildTurnBrief(context(document, state), prompt('next question please'));
  expect('brief: a lesson under way carries the chapter and both blocks', [going.includes('TEACH ('), going.includes('DOCUMENT  '), going.includes('\nHERE  ')], [true, true, true]);
  expect('brief: the blocks come before NOW', going.indexOf('\nHERE  ') < going.indexOf('\nNOW: '), true);
}

/** Run by `pnpm timeline`. */
export function teachChecks(): boolean {
  checkCues();
  checkChapter();
  checkExample();
  checkBlocks();
  checkBrief();
  process.stdout.write(`\nteach checks: ${passed} held${ok ? '' : ', some failed'}\n`);
  return ok;
}
