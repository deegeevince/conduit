// Checks of the owner's feedback that the language settles (docs/feedback.md), each named by its row. Run by `pnpm timeline`.
//
//   fb-058  the brain is taught the `math` line for a column sum (no digits placed by hand), it is carried when the words are the owner's, and it never holds the answer
//   fb-008  a markdown bullet or numbered item that is no Series ("- **Mercury** …", "* x", "1. First") is said as text, marker and emphasis off, with a warning that says so, not refused
//   ro-3a   (PLAN-romer 3a) "show me the maths" is a request to SEE a calculation, not to be coached through one: the chapter the words carry opens by saying which case is which,
//           and coaches only the learner who will do the working; the formula line it teaches reads
//   fb-061  an `ask` accepts the ways of writing ONE answer: a thousands comma or space is part of a number; a step of the working that was listed with the answer is
//           dropped with a reason; a hint is refused only when it shows what the ask really accepts
//
// (fb-059, a title in a free scene, and fb-060, an ask that waits, are the painter's: `pnpm check --only fb-059`, `fb-060`.) Nothing here names a learner or copies a log.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_STAGE,
  FULL_CAPABILITIES,
  LEAD_WINDOW,
  MATHS_CHAPTER,
  REFERENCE_SCREEN,
  accepts,
  answerValues,
  asksForMaths,
  buildSystemPrompt,
  buildTurnBrief,
  matchAnswer,
  parseLine,
  parseScript,
  LineReader,
  textHolds,
} from '../src/index';
import type { TechniqueCard, TurnContext } from '../src/index';

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
  process.stdout.write(`  FEEDBACK CHECK FAILED: ${what}\n      got    ${a}\n      wanted ${b}\n`);
}

const SENTENCE = 'show me how to add two big numbers and then ask some questions for me to work out';

function contextWith(techniques: readonly TechniqueCard[] = []): TurnContext {
  return {
    screen: REFERENCE_SCREEN,
    capabilities: FULL_CAPABILITIES,
    services: { paint: false, sight: 'report', review: false, uploads: true },
    lead: LEAD_WINDOW,
    stage: EMPTY_STAGE,
    history: [],
    heard: [],
    techniques,
  };
}

/** What a script comes to: its lines as written back, what was refused and what was said of it. */
function played(lines: readonly string[]): { readonly lines: readonly string[]; readonly refused: readonly string[]; readonly said: readonly string[] } {
  const script = parseScript(lines.join('\n'));
  return {
    lines: script.lines.map((line) => (line.verb === 'ask' ? `ask ${line.id} is=${(line.is ?? []).join(',')}` : line.verb)),
    refused: script.rejects.flatMap((reject) => reject.issues.map((issue) => `${issue.code}: ${issue.message}`)),
    said: script.warnings.flatMap((warning) => warning.issues.map((issue) => `${issue.code}: ${issue.message}`)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// fb-058: the column sum is a `math` line, taught, and carried for the words that asked for it

function fb058(): void {
  const chapter = MATHS_CHAPTER;
  // the form, and every way a hand reaches a part of it
  expect('fb-058: the chapter teaches the math line', [chapter.includes('`math m1 column|times|split|bond'), chapter.includes('[worked]'), chapter.includes('blank=all')], [true, true, true]);
  expect('fb-058: the chapter says the painter computes the digits and the brain writes none', [/never digits you place/.test(chapter), /painter computes every digit/.test(chapter), /seals the answer/.test(chapter)], [true, true, true]);
  expect('fb-058: the chapter names the parts and where they work', [chapter.includes('m1.carry-tens'), chapter.includes('near='), chapter.includes('`hit`'), chapter.includes('mark=box'), chapter.includes('`fill m1 |')], [true, true, true, true, true]);
  // the hand-placed recipe is gone: no coordinates for digits, no right edge, no mono face, no free canvas
  expect('fb-058: the chapter teaches no hand-placed column', /align=right|face=mono|layout=free|canvas=square|a row every 10|path.*rule/.test(chapter), false);
  expect('fb-058: the chapter does not teach `problem` or the workspace', /\bproblem\b|workspace/i.test(chapter), false);
  // the brief only grows for what it was asked to say (it was 1,348 characters; PLAN-romer 3a and PLAN-maths M7 added the two cases and the typeset formula: 1,311 then, 1,654 now)
  expect(`fb-058: the maths chapter stays short (is ${chapter.length})`, chapter.length <= 1660, true);
  // and it is carried for the owner's own words (they hold no digit and none of the old cue words), and by the maths card
  expect('fb-058: the owner\'s sentence is read as a maths question', asksForMaths(SENTENCE), true);
  const brief = buildTurnBrief(contextWith(), { kind: 'prompt', text: SENTENCE });
  expect('fb-058: the brief for the owner\'s sentence carries the maths chapter', brief.includes('A column sum, take-away or times as on paper is ONE line'), true);
  const card: TechniqueCard = { id: 'seed:teach-young-learner', title: 'A maths question to work out', when: 'a child needs help with a maths question', example: ['scene stack', 'say title | Flowers', 'ask a1 is=12 | How many flowers? __'] };
  expect('fb-058: the maths card brings the chapter whatever the words', buildTurnBrief(contextWith([card]), { kind: 'prompt', text: 'my daughter is stuck on this' }).includes('A column sum, take-away or times as on paper is ONE line'), true);
  for (const text of ['add a chart of sales', 'add numbers to the title', 'what are the big numbers in the news', 'draw a sun and add clouds']) expect(`fb-058: "${text}" is not a maths question`, asksForMaths(text), false);
  // the card for a young learner teaches `math` too, and no hand-placed digits
  const seed = readFileSync(fileURLToPath(new URL('../../techniques/seed/teach-young-learner.md', import.meta.url)), 'utf8');
  expect('fb-058: the maths card teaches the math line, never hand-placed digits', [seed.includes('`math m1 column | 3486 + 2795`'), /align=right|face=mono|say [a-z0-9]* ?at=/.test(seed)], [true, false]);
  // the fixed prompt no longer tells the brain it may place digits in a column, and does not teach `problem` or a workspace
  const system = buildSystemPrompt({ capabilities: FULL_CAPABILITIES, services: { paint: false, sight: 'snapshot', review: true, critic: true, refine: true, uploads: true, art: true } });
  expect('fb-058: the fixed prompt allows no digits in a column placed by coordinates', /digits in a column/.test(system), false);
  expect('fb-058: the fixed prompt teaches neither `problem` nor a workspace', /`problem|problem <id>|workspace/.test(system), false);
  // what the chapter teaches parses, and the answer it seals is refused in words
  for (const line of ['math m1 column | 3486 + 2795', 'math w1 column worked blank=all | 4768 + 2557', 'math m1 times | 47 × 6', 'set m1.tens mark=box', 'hit m1.carry-tens pulse', 'say near=m1.ans-ones:below | the ones first', 'fill m1 | 6281']) {
    const read = parseLine(line);
    expect(`fb-058: "${line}" reads`, read.kind, 'line');
  }
  const sealed = played(['scene stack', 'math m1 column | 3486 + 2795', 'say | The total is 6281.']);
  expect('fb-058: a say that states the sealed answer is refused', sealed.refused.some((issue) => issue.startsWith('spoiler')), true);
  const quiet = played(['scene stack', 'math w1 column worked | 4768 + 2557', 'say | Your turn: add them the same way.', 'math m1 column | 3486 + 2795', 'ask q1 is=7043 stage=1 | 5079 + 1964 = __']);
  expect('fb-058: a worked example, her own sum and an ask play with nothing refused', [quiet.refused, quiet.said], [[], []]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ro-3a: who does the working. The brain is told the two cases by who is to do the working; the page cannot tell them from the words, so the check holds what the brain is
// told, and the live smoke (a Rømer sentence) holds what it does.

const SEE = "Show me the maths behind Rømer's speed of light, his numbers in. Let me change the delay.";
const COACH = 'show me how to add two big numbers and ask me questions';

function ro3a(): void {
  const chapter = MATHS_CHAPTER;
  const opening = chapter.split('\n')[0] ?? '';
  const [learner = '', see = ''] = opening.split(/The person asks to SEE/);
  expect('ro-3a: the opening is about who does the working, and names both cases', [/WHO DOES THE WORKING/.test(opening), /The learner will/.test(learner), see !== ''], [true, true, true]);
  // what coaches (blanks, an `ask`, a hint, no answer) belongs to the learner's case; the person who asks to see is told to show it whole
  expect('ro-3a: the learner is coached with blanks, an ask and a hint', [/each result blank/.test(learner), /one `ask`/.test(learner), /hint/.test(learner)], [true, true, true]);
  expect('ro-3a: a calculation the person asks to see is shown whole: every step and result, no ask, no blank cell', [/show it whole/.test(see), /every step and result/.test(see), /no `ask`/.test(see), /no blank cell/.test(see)], [true, true, true, true]);
  expect('ro-3a: nothing that coaches is said of the person who asks to see', [/each result blank/.test(see), /is=/.test(see), /hint/.test(see), /coach/.test(see)], [false, false, false, false]);
  // both sets of words carry the chapter, and both are told the same two cases first: the brief says which case is which, the brain reads who it is talking to
  for (const text of [SEE, COACH]) {
    const brief = buildTurnBrief(contextWith(), { kind: 'prompt', text });
    expect(`ro-3a: "${text.slice(0, 40)}…" carries the chapter, its two cases first`, [asksForMaths(text), brief.includes(opening), brief.indexOf(opening) < brief.indexOf('A column sum, take-away or times as on paper is ONE line')], [true, true, true]);
  }
  // a calculation shown whole is a typeset formula, symbols and then the numbers in; the line the chapter teaches reads as written
  const teaches = /`(math f2 formula \| [^`]+)`/.exec(chapter)?.[1] ?? '';
  const read = parseLine(teaches);
  expect('ro-3a: the chapter teaches a formula with its numbers put in, and it reads', [teaches.includes('\\frac{3.0\\times10^{8}'), read.kind === 'line' && read.line.verb === 'math' && read.line.method === 'formula' && read.line.sum.includes('\\approx')], [true, true]);
  expect('ro-3a: a shown-whole formula says nothing to be sealed or worked out', played(['scene stack', 'math f1 formula | c = \\frac{d}{\\Delta t}', teaches, 'say | About 227,000 km/s.']), { lines: ['scene', 'math', 'math', 'say'], refused: [], said: [] });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// fb-061: is= is the one answer, in its spellings

function fb061(): void {
  // a thousands comma is part of a number; a list is a list
  for (const [raw, want] of [
    ['6281,6', ['6281', '6']],
    ['6,281', ['6281']],
    ['6,281,6281', ['6281']],
    ['10,000,ten_thousand', ['10000', 'ten thousand']],
    ['1,250,000', ['1250000']],
    ['£1,250,£1250', ['£1250']],
    ['"6,281","6281"', ['6281']],
    ['100,200', ['100', '200']],
    ['120,000', ['120000']],
    ['2,3,4,6', ['2', '3', '4', '6']],
    ['12,twelve', ['12', 'twelve']],
    ['0,500', ['0', '500']],
  ] as const) expect(`fb-061: is=${raw}`, answerValues(raw), want);
  expect('fb-061: the items of check=order are never merged', answerValues('100,200,300', true), ['100', '200', '300']);
  expect('fb-061: no thousands merge for items such as 1,200', answerValues('1,200', true), ['1', '200']);
  // what a person types is the number whatever the grouping
  const ask = { accepted: ['6281'], unit: null as string | null };
  for (const typed of ['6281', '6,281', '6 281', 'six thousand two hundred and eighty one']) expect(`fb-061: "${typed}" is 6281`, accepts(ask, typed), true);
  for (const typed of ['6', '281', '62 81', '628', '6 2810']) expect(`fb-061: "${typed}" is not 6281`, accepts(ask, typed), false);
  expect('fb-061: 10 000 and 10000 are one answer', [matchAnswer('10000', '10 000'), matchAnswer('10 000', '10000'), matchAnswer('3_000'.replaceAll('_', ' '), '3000')], [true, true, true]);
  expect('fb-061: a space-grouped number in words is the answer it names', [textHolds('the total is 6 281 here', '6281'), textHolds('the total is 6,281 here', '6281'), textHolds('the total is 6 here', '6281')], [true, true, false]);

  // the brain's own attempt: the answer listed with a step of the working (the ones digit)
  const chain = (isList: string): ReturnType<typeof played> =>
    played([
      'scene stack',
      'say s1 | Add 3486 and 2795, the ones first.',
      `ask q1 is=${isList} stage=1 | 3486 + 2795 = __`,
      'hint in=q1 stage=yes | Start right: 6 + 5. Is that more than 9? What do you write, and what do you carry?',
      'ask q2 is=7043,7 stage=2:q1 | 5079 + 1964 = __',
      'hint in=q2 stage=yes | The tens: 7 + 6, plus the carry. What do you get?',
    ]);
  for (const list of ['6281,6', '6,281,6', '6281,"6 281"']) {
    const read = chain(list);
    expect(`fb-061: is=${list} plays, accepting the one answer`, read.lines.filter((line) => line.startsWith('ask')), ['ask q1 is=6281', 'ask q2 is=7043']);
    expect(`fb-061: is=${list}: the hints that name steps are kept`, read.refused, []);
    expect(`fb-061: is=${list}: the step is dropped with a reason`, read.said.some((issue) => /cannot be an answer to it/.test(issue) && /never a step of the working/.test(issue)), true);
  }
  // a clean ask says nothing; a list that is all spellings is kept whole
  expect('fb-061: a clean ask is not touched or told anything', played(['scene stack', 'ask q1 is=6281,six_thousand_two_hundred_and_eighty_one stage=1 | 3486 + 2795 = __']), { lines: ['scene', 'ask q1 is=6281,six thousand two hundred and eighty one'], refused: [], said: [] });
  expect('fb-061: spellings of a sum are all kept', played(['scene stack', 'ask a is=12,twelve | 6 + 6 = __']).lines, ['scene', 'ask a is=12,twelve']);
  // never mends a sum the brain got wrong (no right answer among them), and never touches words it cannot read as a sum
  expect('fb-061: the only answer is never removed', played(['scene stack', 'ask a is=6271 | 3486 + 2795 = __']).lines, ['scene', 'ask a is=6271']);
  expect('fb-061: an ask for the ones digit keeps it', played(['scene stack', 'ask a is=1 | What is the ones digit of 3486 + 2795? __']).lines, ['scene', 'ask a is=1']);
  expect('fb-061: a sum written with spaced thousands is left alone', played(['scene stack', 'ask a is=3000,3_000 | 1 000 = __ ÷ 3']).lines, ['scene', 'ask a is=3000,3 000']);
  // a hint is refused when it shows what the ask accepts, and only then
  const hints = (hint: string): readonly string[] => played(['scene stack', 'ask q1 is=6281 stage=1 | 3486 + 2795 = __', `hint in=q1 stage=yes | ${hint}`]).refused;
  expect('fb-061: a hint that names a step is kept', hints('Start with 6 + 5. Is that more than 9?'), []);
  expect('fb-061: a hint that shows the answer is refused', hints('The total is 6281.').some((issue) => issue.startsWith('spoiler')), true);
  expect('fb-061: a hint that shows it with its thousands comma or space is refused', [hints('It comes to 6,281.').length > 0, hints('It comes to 6 281.').length > 0], [true, true]);
  expect('fb-061: a hint that shows it in words is refused', hints('Six thousand two hundred and eighty one.').length > 0, true);
  // a stray word after the list says why it was let go
  const spaced = played(['scene stack', 'ask q1 is=6281,"6 281" stage=1 | 3486 + 2795 = __']);
  expect('fb-061: the rest of a spaced answer is told it has no place in the list', spaced.said.some((issue) => /has no spaces/.test(issue)), true);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// fb-008: the brain wrote a list in markdown; every bullet was refused and nothing of it reached the stage

/** The lines the reader (as the brain's stream is read) makes of raw text: what was said, what was refused, and the codes of the warnings */
function readRaw(raws: readonly string[]): { readonly said: readonly string[]; readonly refused: readonly string[]; readonly codes: readonly string[] } {
  const reader = new LineReader();
  const said: string[] = [];
  const refused: string[] = [];
  const codes: string[] = [];
  for (const raw of raws) {
    const result = reader.read(raw);
    if (result.kind === 'reject') refused.push(raw);
    if (result.kind !== 'line') continue;
    if (result.line.verb === 'say') said.push(result.line.text);
    codes.push(...result.issues.filter((issue) => issue.severity === 'warn').map((issue) => issue.code));
  }
  return { said, refused, codes };
}

function fb008(): void {
  // the owner's list, as it was written: every line was refused
  const planets = readRaw(['- **Mercury** go round 8 times (about 88 days per orbit)', '- **Venus** go round about 3 times', '- **Uranus and Neptune** barely move']);
  expect('fb-008: a list of bold names is said, marker and emphasis off', planets.said, ['Mercury go round 8 times (about 88 days per orbit)', 'Venus go round about 3 times', 'Uranus and Neptune barely move']);
  expect('fb-008: and none of it is refused', planets.refused, []);
  expect('fb-008: and each says it was only said as text, so it is told and logged', planets.codes, ['said-as-text', 'said-as-text', 'said-as-text']);
  // every marker the brain writes a list with
  expect('fb-008: a star, a bullet point and numbers are markers too', readRaw(['* one thing', '\u2022 another thing', '1. First step', '2) Second step', '12. Twelfth step']).said, ['one thing', 'another thing', 'First step', 'Second step', 'Twelfth step']);
  // a bullet of one word is still something the brain said
  expect('fb-008: a one-word bullet is said', readRaw(['- Mercury']).said, ['Mercury']);
  // the emphasis marks go; the underscores of a name do not
  expect('fb-008: bold, italic, struck and code marks are taken off', readRaw(['- __bold__ and *italic* and _slanted_ and ~~gone~~ and `code`']).said, ['bold and italic and slanted and gone and code']);
  expect('fb-008: the underscores inside a name stay', readRaw(['- the snake_case_name is kept']).said, ['the snake_case_name is kept']);
  // what is not a bullet is not touched
  expect('fb-008: a rule, a lone marker and a minus sign are still refused', readRaw(['---', '- ', '- - -', '-3 apples']).said, []);
  expect('fb-008: a bullet before a real line is that line, as it always was', readRaw(['- say | hi there']).said, ['hi there']);
  expect('fb-008: a bullet whose first word is a verb it cannot be read as is still refused, not made words', readRaw(['- circle c1 to the left']).said, []);
  expect('fb-008: a line that starts with a number but is no list item is not a bullet (it is refused, as before)', readRaw(['3.5 million people live there', '2024. A year']).said, []);
  // a bullet inside a table or a block of code is the block's own row, never a bullet
  expect('fb-008: a table row that begins with a dash stays a row', readRaw(['table t1 | Name | Value', '- | 3']).said, []);
  // a sentence said as text is told the same way, so the conductor can tell the brain's own words from a rescue
  expect('fb-008: a sentence with no verb is said as text with the same code', readRaw(['The planets still are not labelled, so they are coloured dots.']).codes, ['said-as-text']);
  expect('fb-008: words the brain wrote with `say |` carry no such code', readRaw(['say | The planets are dots.']).codes, []);
}

/** Run by `pnpm timeline`. */
export function feedbackChecks(): boolean {
  fb058();
  fb008();
  ro3a();
  fb061();
  process.stdout.write(`\nfeedback checks: ${passed} held${ok ? '' : ', some failed'}\n`);
  return ok;
}
