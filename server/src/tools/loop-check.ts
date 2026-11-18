// pnpm check's feedback-loop group: no model, no browser. The measure, the server's own retry and the brief are run for real, with a scripted brain
// standing in for the model. Four things the owner saw go wrong in a lesson on an iPad (820x971), each held here:
//
//   crossed   a label an earlier turn left is struck through by a box or guide line a later turn drew: the stage measures it (`crossed`), and a label
//             inside a filled shape, with no line through its words, is not flagged
//   retry     a fix that is thrown out is told back to the brain with what it would have left wrong, and a second try that is better is the one shown;
//             a try is not asked for when the pass's time is spent, or when the last one came no nearer
//   owed      a critic's blocking finding that no repair mended is kept and said in the next brief, by id, until it is told twice or its element is gone
//   move      `move <id> x,y` on a `near=` label is taken (it lets the label go to that place, no leader), and a label drawn again beside the old one is refused
//
// And, named for the backlog row fb-062 (`pnpm check --only fb-062`), a lesson in column addition whose title stands on its answer (below: `fb062Problems`).
//
// Run by `pnpm check` (as the `loop` group) and standalone: `tsx loop-check.ts`.

import { EMPTY_STAGE, FULL_CAPABILITIES, LEAD_WINDOW, REFERENCE_SCREEN, REVIEW_POLICY, blockingCount, buildTurnBrief, contentOf, describeSight, fixKeeps, fixLineAllowed, parseLine, repairKeeps, settle, worthAFix } from '@conduit/language';
import type { CriticFinding, Line, OwedFinding, Sight, StageBase, TurnContext } from '@conduit/language';
import { ENGINE_VERSION, scoreOfCase } from '@conduit/web/engine';
import type { Brain, BrainEvent, ReviewRequest } from '../domain/brain';
import { oweFindings, owedToTell } from '../domain/memory';
import { createDraftGate, reviewTurn } from '../domain/review';
import type { ReviewRecord, ReviewStep } from '../domain/review';
import { measureDraft, tryFix } from '../domain/stage-facts';
import type { MeasureSession } from '../domain/stage-facts';
import type { CheckResult } from './smoke';


/** An iPad held upright, as the lesson that went wrong ran on one. */
const IPAD = { screen: { width: 820, height: 971, dpr: 2, reducedMotion: false }, capabilities: { looks: [], engine: ENGINE_VERSION }, tables: [], held: {} } as unknown as MeasureSession;

/** Turn one: a title, a practice box with its guide, a label "your turn" placed by the stage under it, and one "again" the brain pinned where the next box's guide will run. Turn two draws that box. */
const FIRST = ['scene layout=figure', 'say x12 title | Write it', 'rect p1 52,5 44x44 stroke=accent thick=1', 'line x16 74,5 74,49 stroke=dim', 'line x17 52,27 96,27 stroke=dim', 'say x20 label near=p1:below | your turn', 'say x21 label at=72,58 | again'];
const SECOND = ['rect p2 52,54 44x44 stroke=accent thick=1', 'line x18 74,54 74,98 stroke=dim', 'line x19 52,76 96,76 stroke=dim'];

type Scored = ReturnType<typeof scoreOfCase>;

function numbered(texts: readonly string[], from = 0): { seq: number; text: string; floor: number }[] {
  return texts.map((text, at) => ({ seq: from + at + 1, text, floor: 0 }));
}

/** The stage the first turn leaves, and the second turn's score on top of it, as the server holds them. */
function twoTurns(): { readonly base: StageBase; readonly second: Scored } {
  const one = scoreOfCase({ id: 'one', base: null, opened: 'prompt', lines: numbered(FIRST) });
  const base = settle(one.schedule, one.base, one.schedule.end + 1);
  return { base, second: scoreOfCase({ id: 'two', base, opened: 'prompt', lines: numbered(SECOND, 100) }) };
}

const noted = (sight: Sight | null, id: string): readonly string[] => sight?.items.find((item) => item.id === id)?.notes ?? [];

/** What a scripted brain writes for each look it is given, in order (the last repeats); it records every request, and takes `each` ms of the clock a look. */
function scripted(tries: readonly (readonly string[])[], seen: ReviewRequest[], clock: { now: number }, each = 0): Brain {
  let at = 0;
  return {
    id: 'replay',
    respond: async function* (): AsyncGenerator<BrainEvent> {},
    review: async function* (request: ReviewRequest): AsyncGenerator<BrainEvent> {
      seen.push(request);
      clock.now += each;
      for (const text of tries[Math.min(at, tries.length - 1)] ?? []) {
        const read = parseLine(text);
        if (read.kind === 'line') yield { type: 'line', line: read.line as Line } as BrainEvent;
      }
      at += 1;
    },
  } as unknown as Brain;
}

async function look(brain: Brain, second: Scored, clock: { now: number }, session: MeasureSession = IPAD): Promise<{ steps: ReviewStep[]; record: ReviewRecord | null }> {
  const steps: ReviewStep[] = [];
  let record: ReviewRecord | null = null;
  const generator = reviewTurn({
    brain,
    policy: REVIEW_POLICY,
    gate: createDraftGate(),
    turn: 't2',
    session: 'loop',
    input: { kind: 'prompt', text: 'draw the next practice box' },
    styles: () => [],
    drafts: true,
    state: () => ({ schedule: second.schedule, rejects: 0, lastSeq: 200, problems: [] }),
    signal: new AbortController().signal,
    // every look at the clock takes 200 ms of a pretend one, so the picture's short grace runs out at once and a look's time is the brain's alone
    now: () => (clock.now += 200),
    measure: () => measureDraft(second, session),
    tryFix: (_pass, tried) => tryFix(second, tried, session),
  });
  for await (const step of generator) {
    steps.push(step);
    if (step.type === 'record') record = step.record;
  }
  return { steps, record };
}

/** Everything that went wrong, in words; empty when the loop holds. */
export async function loopProblems(): Promise<string[]> {
  const problems: string[] = [];
  const { base, second } = twoTurns();

  // crossed: x21 was written by turn one at a point turn two's guide line then runs through
  const measured = measureDraft(second, IPAD);
  if (measured === null) return ['the draft could not be measured'];
  if (!noted(measured.sight, 'x21').includes('crossed')) problems.push(`crossed: a label struck through by a later turn's guide line is not said to be (x21 notes: ${noted(measured.sight, 'x21').join(', ') || 'none'})`);
  const firstOnly = measureDraft(scoreOfCase({ id: 'one', base: null, opened: 'prompt', lines: numbered(FIRST) }), IPAD);
  if (['x20', 'x21'].some((id) => noted(firstOnly?.sight ?? null, id).includes('crossed'))) problems.push('crossed: a label clear of every line was said to be crossed');
  // a label inside a filled shape, with no stroke through it, is a label on a drawing and not a fault
  const filled = measureDraft(scoreOfCase({ id: 'f', base: null, opened: 'prompt', lines: numbered(['scene layout=figure', 'rect card 20,20 80x50 fill=#335577', 'say lab label near=card | inside the card']) }), IPAD);
  if (noted(filled?.sight ?? null, 'lab').includes('crossed') || noted(filled?.sight ?? null, 'lab').includes('collides')) problems.push('crossed: a label standing on a filled shape with no line through it was flagged');

  // retry: the first try lands worse (it puts shapes off the screen), the second moves the label clear
  const fixed = ['move x21 25,70'];
  const worse = ['rect gone 900,900 20x20 fill=#ff0000', 'rect gone2 950,900 20x20 fill=#ff0000', 'rect gone3 900,950 20x20 fill=#ff0000'];
  const seen: ReviewRequest[] = [];
  const run = await look(scripted([worse, fixed], seen, { now: 0 }), second, { now: 0 });
  const fixes = run.record?.fixes ?? [];
  if (seen.length !== 2) problems.push(`retry: the brain was asked ${seen.length} time${seen.length === 1 ? '' : 's'}, not twice, after a fix was thrown out`);
  else {
    const told = (seen[1]?.problems ?? []).map((problem) => `${problem.raw} ${problem.why}`).join(' | ');
    if (!/thrown out/.test(told) || !/landed worse/.test(told)) problems.push(`retry: the second try was not told why the first was thrown out (${told.slice(0, 120)})`);
    if (!/gone: off-canvas/.test(told)) problems.push(`retry: the second try was not told what the first left wrong (${told.slice(0, 200)})`);
  }
  if (fixes.length !== 2 || fixes[0]?.shown !== false || fixes[0]?.retried !== true || fixes[1]?.shown !== true) problems.push(`retry: the log should hold a thrown-out try then a shown one (${fixes.map((fix) => `${fix.shown ? 'shown' : 'refused'}${fix.retried === true ? '+again' : ''}`).join(', ')})`);
  if (run.record?.result !== 'fixed') problems.push(`retry: the second, better try was not kept (result ${run.record?.result ?? 'none'})`);
  const refusedSteps = run.steps.filter((step) => step.type === 'pass' && step.state === 'refused').length;
  if (refusedSteps !== 0) problems.push(`retry: a throw-out that was followed by a second try was announced as the end of the look (${refusedSteps} refused)`);
  const shown = run.steps.filter((step) => step.type === 'line').length;
  if (shown !== fixed.length) problems.push(`retry: ${shown} lines were shown, the accepted try had ${fixed.length}`);

  // time: the first try took most of the pass (25 s of 30), so no second is asked for and the draft stands
  const hurriedSeen: ReviewRequest[] = [];
  const hurriedClock = { now: 0 };
  const hurried = await look(scripted([worse, fixed], hurriedSeen, hurriedClock, 25_000), second, hurriedClock);
  if (hurriedSeen.length !== 1 || hurried.record?.result === 'fixed') problems.push(`retry: with the pass's time spent, a second try was asked for anyway (${hurriedSeen.length} asks, ${hurried.record?.result ?? 'none'})`);
  // a try that comes no nearer than the last is not followed by a third, and a worse fix is never shown
  const sameSeen: ReviewRequest[] = [];
  const stuck = await look(scripted([worse], sameSeen, { now: 0 }), second, { now: 0 });
  if (sameSeen.length > 2) problems.push(`retry: a brain that wrote the same thrown-out fix was asked ${sameSeen.length} times`);
  if (stuck.record?.result === 'fixed') problems.push('retry: a fix that landed worse was shown');

  // owed: a skipped repair's blocking finding rides in the next brief by id, twice at most, and not once its element is gone
  const finding = {
    problems: [
      { id: 'x20', what: 'Move the "YOUR TURN" label clear of the box; the guide line runs through its letters.', weight: 'blocks', gate: 'no-overlap', tier: 1, raised: true },
      { id: 'x22', what: 'A label that is only polish.', weight: 'polish', gate: 'polish', tier: 3, raised: false },
    ],
  } as unknown as Pick<CriticFinding, 'problems'>;
  const session = { owed: [] as { finding: OwedFinding; told: number }[], stage: base };
  oweFindings(session, 't2', finding);
  const brief = (owed: readonly OwedFinding[]): string =>
    buildTurnBrief({ screen: REFERENCE_SCREEN, capabilities: FULL_CAPABILITIES, services: { paint: false, sight: 'report', review: false }, lead: LEAD_WINDOW, stage: base, history: [], heard: [], ...(owed.length === 0 ? {} : { owed }) } as TurnContext, { kind: 'prompt', text: 'carry on' });
  const first = brief(owedToTell(session));
  if (!/x20 \[no-overlap\]/.test(first) || /x22/.test(first)) problems.push(`owed: the next brief does not name the one blocking finding by id (${/x20/.test(first) ? 'x20 there' : 'x20 missing'}${/x22/.test(first) ? ', the polish one too' : ''})`);
  owedToTell(session);
  if (owedToTell(session).length !== 0) problems.push('owed: a finding was told three times');
  if (/CRITIC WHO CAN SEE FOUND/.test(brief([]))) problems.push('owed: a brief with nothing owed carries the block');
  const gone = { owed: [] as { finding: OwedFinding; told: number }[], stage: EMPTY_STAGE };
  oweFindings(gone, 't2', finding);
  if (owedToTell(gone).length !== 0) problems.push('owed: a finding about something no longer on stage was told');

  // move: allowed on a near= label, takes it away from where it stood, leaves one label, and is not the duplicate a second `say` would be
  const parsed = parseLine('move x20 25,70');
  if (parsed.kind !== 'line') problems.push('move: the line does not read');
  else if (!fixLineAllowed(parsed.line as Line, second.schedule).allowed) problems.push('move: a near= label cannot be moved in a fix');
  const moved = tryFix(second, ['move x20 25,70'], IPAD);
  const before = measured.placed.find((item) => item.id === 'x20')?.box;
  const after = moved?.measured.placed.find((item) => item.id === 'x20')?.box;
  if (moved === null || moved.rejects.length > 0) problems.push('move: moving a near= label was rejected on the stage');
  if (before === undefined || after === undefined || (Math.abs(before.x - after.x) < 3 && Math.abs(before.y - after.y) < 3)) problems.push(`move: the label did not go where it was sent (${JSON.stringify(before)} then ${JSON.stringify(after)})`);
  const draftContent = contentOf(second.schedule);
  if ((moved?.measured.content.dupes ?? 1) !== 0 || (moved?.measured.content.words ?? 0) !== draftContent.words) problems.push('move: moving a label changed how many words are on stage');
  const again = tryFix(second, ['say x40 label near=p1:below | your turn'], IPAD);
  const kept = again === null ? null : fixKeeps(draftContent, again.measured.content);
  if (kept === null || kept.keeps || !/second copy/.test(kept.why ?? '')) problems.push(`move: a label drawn again beside the old one was not refused (${kept?.why ?? 'not tried'})`);
  return problems;
}

// ---------------------------------------------------------------- fb-062: a title over text, and a fix that dodges it

/** The owner's laptop: 1344x866 at 2x, a mouse. */
const LAPTOP = { screen: { width: 1344, height: 866, dpr: 2, reducedMotion: false, pointer: 'fine' }, capabilities: { looks: [], engine: ENGINE_VERSION }, tables: [], held: {} } as unknown as MeasureSession;

/**
 * A lesson in column addition on a free layout, in the shape of the one that went wrong (the words and sums are made up): a title told the middle of the stage
 * (`at=center`), a worked sum and its steps pinned to points, a line of words in ink too pale to read, and a line to close on. A title with no `at=` goes to the
 * top of a free scene now (fb-059), and one pinned to a point is made room round, but a title told an anchor keeps it: it stands where the steps are, and the
 * steps are the words it runs into.
 */
const TITLE_OVER_STEPS = [
  'scene layout=free canvas=square',
  'say t1 title at=center | Adding big numbers',
  'say k1 aside at=8,14 | Carries',
  'say k2 aside at=40,14 align=right face=mono | 1 1 1',
  'say r1 at=40,24 align=right face=mono | 3719',
  'say r2 at=40,34 align=right face=mono | 2845',
  'say rp at=22,34 align=right face=mono | +',
  'path rule stroke=ink | M20,40 L42,40',
  'say r3 at=40,48 align=right ink=accent face=mono | 6564',
  'say s1 aside at=75,22 | 1. Line the columns up.',
  'say s2 aside at=75,32 | 2. Add from the right: 9+5=14.',
  'say s3 aside at=75,42 | 3. Write 4, carry the 1 above.',
  'say s4 aside at=75,52 | 4. Each column adds its carry too.',
  'say fa aside at=75,84 opacity=0.25 | Check each column twice.',
  'say go strong | Now you try.',
];

/** What a brain that mended only the pale words writes: it leaves the title on the steps. */
const MENDS_THE_PALE_WORDS = ['set fa opacity=1'];
/** What a brain that took the title out of sight writes, and mended the pale words besides: nothing is left to run into. */
const HIDES_THE_TITLE = ['set t1 opacity=0', 'set fa opacity=1'];
/** What a brain that sent the worked answer to the right of the canvas writes: nothing runs into it there. */
const PARKS_THE_ANSWER = ['move r3 130,48', 'set fa opacity=1'];
/** What mends it: the title up at the top, smaller, and the pale words dark. */
const MOVES_THE_TITLE = ['set t1 size=m', 'move t1 50,3', 'set fa opacity=1'];

/** Everything wrong in how a title standing on words is measured and mended, in words; empty when it holds. */
export async function fb062Problems(): Promise<string[]> {
  const problems: string[] = [];
  const score = scoreOfCase({ id: 'fb062', base: null, opened: 'prompt', lines: numbered(TITLE_OVER_STEPS) });
  const measured = measureDraft(score, LAPTOP);
  if (measured === null) return ['fb-062: the draft could not be measured'];
  const notes = (id: string): readonly string[] => noted(measured.sight, id);
  const standing = measured.sight.items.filter((item) => item.id !== 't1' && item.notes.includes('collides'));
  if (standing.length === 0) return [`fb-062: the fixture no longer puts the title on other words (free-layout title placement changed): put the title where the steps are in TITLE_OVER_STEPS (server/src/tools/loop-check.ts) and run this again; the title's notes: ${notes('t1').join(', ') || 'none'}`];

  // 1. measured: the title is the one standing on words, so it is said to be, and blocking, and it names what it stands on; so does each line it covers
  if (!notes('t1').includes('collides')) problems.push(`fb-062 measure: the title stands on ${standing.map((item) => item.id).join(', ')} and is not said to run into other words (t1 notes: ${notes('t1').join(', ') || 'none'})`);
  const lines = describeSight(measured.sight).join('\n');
  const titleRow = lines.split('\n').find((row) => /^\s*t1 \(text\)/.test(row)) ?? '';
  if (!standing.every((item) => titleRow.includes(item.id)) || !titleRow.includes('run into')) problems.push(`fb-062 brief: the title's row does not name the words it runs into (${titleRow.trim() || 'no row for t1'})`);
  const coveredRow = lines.split('\n').find((row) => new RegExp(`^\\s*${standing[0]?.id ?? 'none'} \\(text\\)`).test(row)) ?? '';
  if (!coveredRow.includes('t1')) problems.push(`fb-062 brief: the words the title stands on do not name it (${coveredRow.trim() || 'no row'})`);
  if (!worthAFix({ drawn: 1, structures: 0, controls: 0, placedText: 10, rejects: 0 }, measured.sight, false).look) problems.push('fb-062 fast pass: the draft review would not look at it');

  // 2. mended: a repair that leaves the title where it is, or hides it, or parks the answer off the canvas, is not kept; the one that moves the title is
  const repair = (fix: readonly string[]): { readonly keeps: boolean; readonly why: string | null } => {
    const tried = tryFix(score, fix, LAPTOP);
    return tried === null ? { keeps: false, why: 'not tried' } : repairKeeps({ content: measured.content, sight: measured.sight }, { content: tried.measured.content, sight: tried.measured.sight });
  };
  const leaves = repair(MENDS_THE_PALE_WORDS);
  if (leaves.keeps) problems.push('fb-062 gate: a repair that mended the pale words and left the title on the steps was kept');
  const hides = repair(HIDES_THE_TITLE);
  if (hides.keeps || !/hid t1/.test(hides.why ?? '')) problems.push(`fb-062 gate: a repair that hid the title to dodge the overlap was ${hides.keeps ? 'kept' : 'refused without saying "hid t1"'} (${hides.why ?? 'no reason'})`);
  const parks = repair(PARKS_THE_ANSWER);
  if (parks.keeps || !/moved r3 off the canvas/.test(parks.why ?? '')) problems.push(`fb-062 gate: a repair that sent the answer off the canvas was ${parks.keeps ? 'kept' : 'refused without saying "moved r3 off the canvas"'} (${parks.why ?? 'no reason'})`);
  const mends = repair(MOVES_THE_TITLE);
  if (!mends.keeps) problems.push(`fb-062 gate: the repair that moves the title to the top was refused (${mends.why ?? 'no reason'})`);

  // 3. the fast pass: the first fix mends only the pale words, so it is thrown out and told what still runs into what; the second moves the title and is shown, in the same look
  const seen: ReviewRequest[] = [];
  const run = await look(scripted([MENDS_THE_PALE_WORDS, MOVES_THE_TITLE], seen, { now: 0 }), score, { now: 0 }, LAPTOP);
  const fixes = run.record?.fixes ?? [];
  if (seen.length !== 2) problems.push(`fb-062 fast pass: the brain was asked ${seen.length} time${seen.length === 1 ? '' : 's'}, not twice: a fix that left the title on the steps was ${fixes[0]?.shown === true ? 'shown' : 'not retried'}`);
  else {
    const told = (seen[1]?.problems ?? []).map((problem) => `${problem.raw} ${problem.why}`).join(' | ');
    if (!/t1/.test(told) || !/still run into/.test(told)) problems.push(`fb-062 fast pass: the second try was not told the title still runs into words (${told.slice(0, 200)})`);
  }
  if (fixes.length !== 2 || fixes[0]?.shown !== false || fixes[1]?.shown !== true || run.record?.result !== 'fixed') problems.push(`fb-062 fast pass: the look should throw out the first try and show the second (${fixes.map((fix) => (fix.shown ? 'shown' : 'refused')).join(', ') || 'no fixes'}, result ${run.record?.result ?? 'none'})`);
  const afterwards = tryFix(score, MOVES_THE_TITLE, LAPTOP);
  if (afterwards !== null && blockingCount(afterwards.measured.sight) !== 0) problems.push(`fb-062 fast pass: the fix that is shown still leaves ${blockingCount(afterwards.measured.sight)} things not landing`);
  return problems;
}

/** The group `pnpm check --only fb-062` runs: one result. */
export async function fb062Group(note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  note('fb-062');
  try {
    const problems = await fb062Problems();
    return [{ turn: 0, check: 'fb-062', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? 'a title standing on words is measured as blocking, on both, each naming the other; a fix that leaves it, hides the title or parks the answer off the canvas is refused with the reason; the first try is thrown out and the second shown within the same look' : problems.join('; ') }];
  } catch (error) {
    return [{ turn: 0, check: 'fb-062', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }];
  }
}

/** The group as `pnpm check` runs it: one result. */
export async function loopGroup(note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  note('loop');
  try {
    const problems = await loopProblems();
    return [{ turn: 0, check: 'loop', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? 'a crossed label is measured; a thrown-out fix is told back and a better second try is kept; a skipped finding rides in the next brief; move frees a near= label' : problems.join('; ') }];
  } catch (error) {
    return [{ turn: 0, check: 'loop', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }];
  }
}

if (process.argv[1] !== undefined && /loop-check\.ts$/.test(process.argv[1])) {
  Promise.all([loopGroup(), fb062Group()]).then(([loop, fb062]) => {
    const results = [...loop, ...fb062];
    for (const result of results) process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
    process.exit(results.every((result) => result.verdict === 'PASS') ? 0 : 1);
  });
}
