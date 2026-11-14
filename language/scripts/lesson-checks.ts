// Checks of the document's words and types (PLAN-v3-core WS3): the lesson lines read and read back as themselves, the answer matcher's table,
// the spoiler lint, the fold of a log into a document, and `advance`. Run by `pnpm timeline`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEMOS,
  DocumentFolder,
  LESSON_VERBS,
  LESSON_VERB,
  TECHNIQUES,
  VISUAL_KINDS,
  advance,
  askView,
  foldDocument,
  foldSource,
  initialState,
  lintLesson,
  maskSealed,
  matchAnswer,
  nodeOf,
  openAsks,
  parseLine,
  parseScript,
  revealed,
  sealed,
  serializeLine,
} from '../src/index';
import type { DocState, Document, LessonAsk, LessonStep, Line, OpenAsk, RecordLike } from '../src/index';

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
  process.stdout.write(`  LESSON CHECK FAILED: ${what}\n      got    ${a}\n      wanted ${b}\n`);
}

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/lesson/${name}.series`, import.meta.url)), 'utf8');
}

/** [accepted, typed, the ask's unit, whether it is right] */
const MATCHER: readonly (readonly [string, string, string | null, boolean])[] = [
  ['34', '34', null, true],
  ['34', ' 34. ', null, true],
  ['34', 'thirty four', null, true],
  ['34', 'thirty-four', null, true],
  ['34', '35', null, false],
  ['34', '', null, false],
  ['34', '3 + 31', null, false],
  ['60', '60 flowers', null, true],
  ['60', 'sixty', null, true],
  ['60', '5 x 12', null, false],
  ['12', 'twelve', null, true],
  ['100', 'a hundred', null, true],
  ['105', 'one hundred and five', null, true],
  ['40', 'forty', null, true],
  ['1000', '1,000', null, true],
  ['1,000', '1000', null, true],
  ['1.5', '1.50', null, true],
  ['£1.50', '1.50', null, true],
  ['£1.50', '150p', null, true],
  ['£1.50', '£1.5', null, true],
  ['£1.50', '1.05', null, false],
  ['150p', '£1.50', null, true],
  ['150p', '150', null, true],
  ['30', '30 cm', 'cm', true],
  ['30', '0.3 m', 'cm', true],
  ['30', '30 m', 'cm', false],
  ['30', '3 m', 'cm', false],
  ['30', '30 minutes', 'cm', false],
  ['2', '2 kg', null, true],
  ['0.5', '1/2', null, true],
  ['0.5', 'half', null, true],
  ['2.5', '2 1/2', null, true],
  ['2.5', 'two and a half', null, true],
  ['50%', '50', null, true],
  ['50', '50%', null, true],
  ['3:30', '3:30', null, true],
  ['3:30', '3.30', null, true],
  ['3:30', 'half past three', null, true],
  ['3:30', 'half past 4', null, false],
  ['quarter to 4', '3:45', null, true],
  ['5:00', "5 o'clock", null, true],
  ['triangle', 'Triangle', null, true],
  ['triangle', 'a triangle!', null, true],
  ['triangle', 'triangles', null, true],
  ['triangle', 'square', null, false],
  ['odd', 'even', null, false],
  ['ten pence', 'Ten Pence', null, true],
];

function matcherChecks(): void {
  for (const [accepted, given, unit, want] of MATCHER) expect(`matchAnswer(${JSON.stringify(accepted)}, ${JSON.stringify(given)}${unit === null ? '' : `, ${unit}`})`, matchAnswer(accepted, given, unit), want);
  const sixty: readonly OpenAsk[] = [{ id: 'a2', accepted: ['60'], unit: null }];
  expect('sealed 60', sealed(60, sixty), true);
  expect('sealed "60 flowers"', sealed('60 flowers', sixty), true);
  expect('sealed "sixty"', sealed('sixty', sixty), true);
  expect('sealed 12', sealed(12, sixty), false);
  expect('sealed 59.9999', sealed(59.9999, sixty), false);
  expect('sealed with no open ask', sealed(60, []), false);
  expect('mask the readout of 14 November', maskSealed('5 x 12 = 60 flowers', sixty), '5 x 12 = ? flowers');
  expect('mask partial work is let be', maskSealed('2 vases: 12 + 12', sixty), '2 vases: 12 + 12');
  expect('mask a constant expression', maskSealed('{5*12} flowers', sixty), '? flowers');
  expect('mask an expression of controls is let be', maskSealed('{vases*12} flowers', sixty), '{vases*12} flowers');
  expect('mask words', maskSealed('it is a Triangle', [{ id: 'a', accepted: ['triangle'], unit: null }]), 'it is a ?');
}

interface Read {
  readonly lines: readonly Line[];
  readonly refused: readonly { readonly raw: string; readonly codes: readonly string[]; readonly message: string }[];
}

function read(source: string): Read {
  const parsed = parseScript(source);
  return {
    lines: parsed.lines,
    refused: parsed.rejects.map((reject) => ({ raw: reject.raw, codes: reject.issues.map((issue) => issue.code), message: reject.issues.map((issue) => issue.message).join('; ') })),
  };
}

function roundTrips(name: string, lines: readonly Line[]): void {
  for (const line of lines) {
    const written = serializeLine(line);
    const again = parseLine(written);
    expect(`${name}: reads back as itself: ${written}`, again.kind === 'line' ? serializeLine(again.line) : 'does not parse', written);
  }
}

function lessonOf(document: Document, id: string): readonly LessonStep[] {
  const body = nodeOf(document, id)?.body;
  return body !== null && body !== undefined && body.kind === 'lesson' ? body.steps : [];
}

function lineChecks(): void {
  const countBack = read(fixture('count-back'));
  expect('count-back: nothing refused', countBack.refused, []);
  roundTrips('count-back', countBack.lines);
  const written = countBack.lines.map(serializeLine);
  expect('count-back: the part says where it sits', written.slice(0, 5), [
    'part w1 | Sheet 1',
    'part s1 in=w1 | Take away tens',
    'part q1 in=s1 | 64 − 30 =',
    'part q1a in=q1 tag=count-on-a-line | Hop back along a number line',
    'step x1 in=q1a show=numberline 0..70 mark=64 | Find 64 on the line.',
  ]);
  expect('count-back: the ask in the second way has an id of its own, and its hint follows it', written.filter((line) => line.startsWith('ask ') || line.startsWith('hint ')).map((line) => line.split(' ').slice(0, 3).join(' ')), [
    'ask a1 in=q1a',
    'hint in=a1 |',
    'hint in=a1 |',
    'ask a1-2 in=q1b',
    'hint in=a1-2 |',
  ]);

  const vases = read(fixture('vases'));
  expect('vases: nothing refused', vases.refused, []);
  roundTrips('vases', vases.lines);

  // The readout of 14 November, as lesson lines: refused, with its reason, naming the step to write again.
  const readout = read(fixture('readout-refused'));
  expect('readout: exactly one line refused', readout.refused.length, 1);
  expect('readout: it is the ask', readout.refused[0]?.raw.startsWith('ask a2'), true);
  expect('readout: as a spoiler', readout.refused[0]?.codes, ['spoiler']);
  expect('readout: the reason names the step and the answer', /step s2 \("5 x 12 = 60 flowers"\) already shows 60/.test(readout.refused[0]?.message ?? ''), true);
  const repaired = read(`${fixture('readout-refused')}\nstep s2 in=q1a | Twelve flowers in each vase, and five vases.\nask a2 in=q1a is=60 pick=50,60,70 | How many flowers altogether?`);
  expect('readout: written again with the same step id, the ask is let in', repaired.refused.length, 1);
  const hint = read(`${fixture('readout-refused')}\nstep s2 in=q1a | Twelve flowers in each vase, and five vases.\nask a2 in=q1a is=60 pick=50,60,70 | How many flowers altogether?\nhint in=a2 | Twelve and twelve and twelve make 36. Go on.`);
  expect('hint that holds no answer is let in', hint.refused.length, 1);
  const hintSpoils = read(`${fixture('readout-refused')}\nstep s2 in=q1a | Twelve flowers in each vase, and five vases.\nask a2 in=q1a is=60 pick=50,60,70 | How many flowers altogether?\nhint in=a2 | It is sixty.`);
  expect('hint that holds the answer is refused', hintSpoils.refused.map((r) => r.codes), [['spoiler'], ['spoiler']]);

  // The reader keeps the open part, and refuses what has nowhere to go.
  const nested = read('part w1 | A\npart s1 | S\nstep | words\nend\npart s2 | S2\nstep in=s1 | back in the first');
  expect('nesting: end closes a part', nested.lines.map(serializeLine), ['part w1 | A', 'part s1 in=w1 | S', 'step x1 in=s1 | words', 'end', 'part s2 in=w1 | S2', 'step x2 in=s1 | back in the first']);
  expect('a step with no part is refused', read('step | words').refused.map((r) => r.codes), [['no-part']]);
  expect('a step in a part that is not there is refused', read('part w1 | A\nstep in=zz | words').refused.map((r) => r.codes), [['unknown-id']]);
  expect('an ask with no answer is refused', read('part w1 | A\nask a1 in=w1 | 1 + 1?').refused.map((r) => r.codes), [['missing-argument']]);
  expect('an ask whose choices hold no answer is refused', read('part w1 | A\nask a1 in=w1 is=4 pick=1,2,3 | 2 + 2?').refused.map((r) => r.codes), [['bad-ask']]);
  expect('a picture a visual does not have is dropped and the step stays', read('part w1 | A\nstep in=w1 show=numberline 0..9 colour=red | words').refused, []);
  expect('an unknown technique is dropped, the part stays', read('part w1 tag=guess | A').lines.map(serializeLine), ['part w1 | A']);
  expect('values with a space use _', serializeLine(read('part w1 | A\nask a1 in=w1 is=ten_pence | Which coin?').lines[1] ?? { verb: 'end' }), 'ask a1 in=w1 is=ten_pence | Which coin?');
  const spoiled: LessonStep[] = [
    { kind: 'step', id: 's1', show: null, words: 'It is 34.' },
    { kind: 'ask', id: 'a1', prompt: 'Where?', accepted: ['34'], pick: null, unit: null, hints: [] },
  ];
  expect('lintLesson finds the answer on the page', lintLesson(spoiled, { question: ['64 − 30 ='], way: null }).map((found) => found.in), ['s1']);
  expect('lintLesson lets the question own its numbers', lintLesson(spoiled, { question: ['What is 34?'], way: null }), []);
}

function foldChecks(): void {
  const folded = foldSource(fixture('count-back'));
  const { document } = folded;
  expect('fold: the root is the first part', document.root, 'w1');
  expect('fold: its title is the document title', document.title, 'Sheet 1');
  expect('fold: the tree is the parents joined', Object.keys(document.nodes).sort(), ['w1', 'w1/s1', 'w1/s1/q1', 'w1/s1/q1/q1a', 'w1/s1/q1/q1b', 'w1/s1/q2']);
  expect('fold: ways are tagged', ['w1/s1/q1/q1a', 'w1/s1/q1/q1b'].map((id) => nodeOf(document, id)?.tag), ['count-on-a-line', 'break-it-apart']);
  expect('fold: statuses (written and finished, and only named)', ['w1/s1/q1', 'w1/s1/q1/q1a', 'w1/s1/q2'].map((id) => nodeOf(document, id)?.status), ['filled', 'filled', 'outlined']);
  expect('fold: a way is a lesson of steps and an ask', lessonOf(document, 'w1/s1/q1/q1a').map((step) => step.kind), ['step', 'step', 'ask', 'step']);
  const ask = lessonOf(document, 'w1/s1/q1/q1a').find((step): step is LessonAsk => step.kind === 'ask');
  expect('fold: the ask holds its hints', ask?.hints.length, 2);
  expect('fold: the reply is for the thread', folded.replies['t1'], 'Two ways of taking away tens, one on a number line and one with blocks.');
  expect('fold: twice, the same', JSON.stringify(foldSource(fixture('count-back'))), JSON.stringify(folded));
  expect('fold: nothing it had to refuse', folded.issues.filter((item) => item.issue.severity === 'error').length, 0);

  const half = foldSource(`${fixture('count-back')}`).document;
  const live = new DocumentFolder();
  live.apply({ type: 'turn', turn: 't1', input: { kind: 'prompt', text: 'x' } });
  let sawFilling = false;
  for (const raw of fixture('count-back').split('\n')) {
    const parsed = parseLine(raw);
    if (parsed.kind !== 'line') continue;
    live.apply({ type: 'line', turn: 't1', seq: 1, text: raw });
    if (live.node('w1/s1/q1/q1a')?.status === 'filling') sawFilling = true;
  }
  expect('live: a node is filling while its turn is open', sawFilling, true);
  live.apply({ type: 'end', turn: 't1', reason: 'done' });
  expect('live: and filled when it ends', live.node('w1/s1/q1/q1a')?.status, 'filled');
  expect('live: the same document as the fold of the whole', Object.keys(live.document().nodes).sort(), Object.keys(half.nodes).sort());

  // An interrupted turn leaves what it was filling as it was; a node set from outside takes the verifier's word; a reset sends it back.
  const cut = new DocumentFolder();
  cut.applyAll([
    { type: 'turn', turn: 't1', input: { kind: 'prompt', text: 'x' } },
    { type: 'line', turn: 't1', seq: 1, text: 'part w1 | Sheet' },
    { type: 'line', turn: 't1', seq: 2, text: 'part q1 in=w1 | Question' },
    { type: 'line', turn: 't1', seq: 3, text: 'step s1 in=q1 | One thing.' },
    { type: 'end', turn: 't1', reason: 'interrupted' },
  ]);
  expect('interrupted: left filling', cut.node('w1/q1')?.status, 'filling');
  cut.ingest({ type: 'node', node: 'w1/q1', status: 'verified' });
  expect('node record: verified', cut.node('w1/q1')?.status, 'verified');
  cut.ingest({ type: 'node', node: 'w1/q1', status: 'outlined', reset: true });
  expect('node record: reset takes the body away', [cut.node('w1/q1')?.status, cut.node('w1/q1')?.body], ['outlined', null]);

  // Today's demos are flat documents: one root, a scene node to each scene, nothing else.
  for (const demo of DEMOS) {
    const source = readFileSync(fileURLToPath(new URL(`../demos/${demo.name}.series`, import.meta.url)), 'utf8');
    const flat = foldSource(source);
    const root = nodeOf(flat.document, flat.document.root);
    const children = (root?.children ?? []).map((id) => nodeOf(flat.document, id));
    expect(`demo ${demo.name}: a flat document`, [flat.document.root, children.length > 0, children.every((node) => node?.body?.kind === 'scene' && node.children.length === 0), Object.keys(flat.document.nodes).length], ['root', true, true, children.length + 1]);
    expect(`demo ${demo.name}: every scene holds its lines`, children.every((node) => node?.body?.kind === 'scene' && node.body.segments.every((segment) => segment.lines.length > 0 && segment.closed !== null)), true);
    expect(`demo ${demo.name}: folded twice, the same`, JSON.stringify(foldSource(source)), JSON.stringify(flat));
  }
  // A turn with no `scene` line adds a segment to the open scene.
  const two = foldDocument([
    { type: 'turn', turn: 't1', input: { kind: 'prompt', text: 'hello' } },
    { type: 'line', turn: 't1', seq: 1, text: 'scene layout=stack' },
    { type: 'line', turn: 't1', seq: 2, text: 'say x1 | Hello.' },
    { type: 'end', turn: 't1', reason: 'done' },
    { type: 'turn', turn: 't2', input: { kind: 'prompt', text: 'and?' } },
    { type: 'line', turn: 't2', seq: 3, text: 'say x2 | More.' },
    { type: 'end', turn: 't2', reason: 'done' },
  ]);
  const scene = nodeOf(two.document, '#1');
  expect('a turn with no scene line is a segment of the open scene', [Object.keys(two.document.nodes).length, scene?.body?.kind === 'scene' ? scene.body.segments.length : 0], [2, 2]);
  expect('the second segment begins where the first rested', scene?.body?.kind === 'scene' ? (scene.body.segments[1]?.base.elements.length ?? -1) > 0 : false, true);
  expect('the scene is titled by what it first said', scene?.title, 'Hello.');
}

function walk(document: Document, state: DocState, ...events: Parameters<typeof advance>[2][]): DocState {
  return events.reduce((now, event) => advance(document, now, event), state);
}

function advanceChecks(): void {
  const { document } = foldSource(fixture('vases'));
  const way = 'w1/q1/q1a';
  const other = 'w1/q1/q1b';
  const start = initialState(document);
  expect('advance: she begins at the first leaf', start.cursor, { node: way, play: { at: 0 } });
  const stopOf = (state: DocState): unknown => state.cursor.play;
  const at1 = advance(document, start, { kind: 'next' });
  expect('advance: next reveals the next step', [at1.cursor.node, stopOf(at1)], [way, { at: 1 }]);
  expect('advance: the ask is a gate', advance(document, at1, { kind: 'next' }), at1);
  expect('advance: and the answer is open on screen', openAsks(document, at1).map((open) => open.id), ['a1']);
  expect('advance: the choices and the readout are sealed', [sealed(12, openAsks(document, at1)), sealed(14, openAsks(document, at1))], [true, false]);
  const wrong = advance(document, at1, { kind: 'try', node: way, ask: 'a1', value: '11' });
  expect('advance: a wrong try shows its first hint', askView(document, wrong, way, 'a1')?.hint, 'Count the roses, then the tulips, then the daisies.');
  expect('advance: and the gate stays shut', advance(document, wrong, { kind: 'next' }), wrong);
  const wrong2 = advance(document, wrong, { kind: 'try', node: way, ask: 'a1', value: '13' });
  expect('advance: the next wrong try, the next hint', askView(document, wrong2, way, 'a1')?.hint, 'Put the three groups together: six, then two more, then four more.');
  const worn = walk(document, wrong2, { kind: 'try', node: way, ask: 'a1', value: '9' });
  expect('advance: hints used up and still wrong: the next step works it through', [askView(document, worn, way, 'a1')?.exhausted, advance(document, worn, { kind: 'next' }).cursor.play], [true, { at: 2 }]);
  const right = advance(document, wrong2, { kind: 'try', node: way, ask: 'a1', value: 'twelve' });
  expect('advance: right, typed in words', askView(document, right, way, 'a1')?.accepted, true);
  expect('advance: nothing is sealed once it is right', openAsks(document, right).length, 0);
  expect('advance: a try after the right one is not kept', advance(document, right, { kind: 'try', node: way, ask: 'a1', value: '5' }), right);
  const afterTwo = walk(document, right, { kind: 'next' }, { kind: 'next' });
  expect('advance: on to the last ask', [stopOf(afterTwo), revealed(document, afterTwo).length], [{ at: 3 }, 4]);
  const last = advance(document, afterTwo, { kind: 'next' });
  expect('advance: the last stop is the second ask, and 60 is sealed', [stopOf(last), sealed('60 flowers', openAsks(document, last))], [{ at: 4 }, true]);
  expect('advance: next steps she has not reached are not revealed', revealed(document, last).length, 5);
  const done = walk(document, last, { kind: 'try', node: way, ask: 'a2', value: '60' });
  expect('advance: the leaf is done when its last ask is right', done.progress[way]?.done, true);
  const onward = advance(document, done, { kind: 'next' });
  expect('advance: next from the end is the next leaf', [onward.cursor.node, stopOf(onward)], [other, { at: 0 }]);
  const backAgain = advance(document, onward, { kind: 'back' });
  expect('advance: back from its start is where she was', [backAgain.cursor.node, stopOf(backAgain)], [way, { at: 4 }]);
  expect('advance: going back to a stop shows what it showed', revealed(document, advance(document, backAgain, { kind: 'stop', at: 1 })).length, 2);
  expect('advance: a stop beyond a closed gate is refused', advance(document, advance(document, start, { kind: 'stop', at: 1 }), { kind: 'stop', at: 4 }).cursor.play, { at: 1 });
  const resumed = advance(document, walk(document, done, { kind: 'go', node: other }), { kind: 'go', node: way, at: 'resume' });
  expect('advance: resume goes to the furthest stop', stopOf(resumed), { at: 4 });
  expect('advance: held values are state', walk(document, start, { kind: 'held', node: way, key: 'slider', value: 3 }).held, { [way]: { slider: 3 } });
  expect('advance: the same value again changes nothing', (() => {
    const held = walk(document, start, { kind: 'held', node: way, key: 'slider', value: 3 });
    return advance(document, held, { kind: 'held', node: way, key: 'slider', value: 3 }) === held;
  })(), true);
  expect('advance: a node that is not there changes nothing', advance(document, start, { kind: 'try', node: 'nowhere', ask: 'a1', value: '1' }), start);
  expect('advance: the page’s own verdict is not trusted', askView(document, advance(document, at1, { kind: 'try', node: way, ask: 'a1', value: '11', right: true }), way, 'a1')?.accepted, false);
  // A way the verifier disputed is never checked wrong.
  const refused: Document = { ...document, nodes: { ...document.nodes, [way]: { ...(nodeOf(document, way) ?? document.nodes[document.root]!), status: 'refused' } } };
  const stuck = advance(refused, at1, { kind: 'try', node: way, ask: 'a1', value: '11' });
  expect('advance: a refused way is not checked, and its gate is open', [stuck === at1, advance(refused, at1, { kind: 'next' }).cursor.play], [true, { at: 2 }]);
  // Replay: the same events folded from the log give the same state.
  const log = [
    ...vasesLog(),
    { type: 'state', change: { kind: 'cursor', cursor: { node: way, play: { at: 1 } } } },
    { type: 'state', change: { kind: 'try', node: way, ask: 'a1', value: '11', right: false } },
    { type: 'state', change: { kind: 'try', node: way, ask: 'a1', value: '12', right: true } },
    { type: 'state', change: { kind: 'held', node: way, key: 'taps', value: [1, 2] } },
  ];
  const replayed = foldDocument(log);
  expect('replay: the cursor, the tries and what is held come back', [replayed.state.cursor, replayed.state.progress[way]?.tries, replayed.state.held], [{ node: way, play: { at: 1 } }, { a1: ['11', '12'] }, { [way]: { taps: [1, 2] } }]);
  expect('replay: twice, the same', JSON.stringify(foldDocument(log)), JSON.stringify(replayed));

  const scenes = foldSource('scene layout=stack\nsay x1 | Hello.\nsay x2 | And more.\n');
  const sceneStart = initialState(scenes.document);
  expect('advance: a conversation of pictures begins at the end of the newest scene', [sceneStart.cursor.node, sceneStart.cursor.play], ['#1', { at: 0 }]);
  const playing = advance(scenes.document, { ...sceneStart, cursor: { node: '#1', play: 0 } }, { kind: 'tick', seconds: 0.5 });
  expect('advance: play moves with the clock', typeof playing.cursor.play, 'number');
  const rested = advance(scenes.document, playing, { kind: 'tick', seconds: 1000 });
  expect('advance: and holds at the stop that ends the script', rested.cursor.play, { at: 0 });
}

function vasesLog(): RecordLike[] {
  const records: RecordLike[] = [{ type: 'turn', turn: 't1', input: { kind: 'prompt', text: 'a worksheet' } }];
  let seq = 0;
  for (const line of parseScript(fixture('vases')).lines) {
    seq += 1;
    records.push({ type: 'line', turn: 't1', seq, text: serializeLine(line) });
  }
  records.push({ type: 'end', turn: 't1', reason: 'done' });
  return records;
}

function docsChecks(): void {
  const docs = readFileSync(fileURLToPath(new URL('../../docs/language.md', import.meta.url)), 'utf8');
  for (const verb of LESSON_VERBS) expect(`docs/language.md has the form of ${verb}`, docs.includes(LESSON_VERB[verb].form), true);
  for (const id of [...TECHNIQUES, ...VISUAL_KINDS]) expect(`docs/language.md names ${id}`, docs.includes(`\`${id}\``), true);
}

/** Run by `pnpm timeline`. */
export function lessonChecks(): boolean {
  matcherChecks();
  lineChecks();
  foldChecks();
  advanceChecks();
  docsChecks();
  process.stdout.write(`\nlesson checks: ${passed} held${ok ? '' : ', some failed'}\n`);
  return ok;
}
