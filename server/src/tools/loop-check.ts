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
// Run by `pnpm check` (as the `loop` group) and standalone: `tsx loop-check.ts`.

import { EMPTY_STAGE, FULL_CAPABILITIES, LEAD_WINDOW, REFERENCE_SCREEN, REVIEW_POLICY, buildTurnBrief, contentOf, fixKeeps, fixLineAllowed, parseLine, settle } from '@conduit/language';
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

async function look(brain: Brain, second: Scored, clock: { now: number }): Promise<{ steps: ReviewStep[]; record: ReviewRecord | null }> {
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
    measure: () => measureDraft(second, IPAD),
    tryFix: (_pass, tried) => tryFix(second, tried, IPAD),
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
  loopGroup().then((results) => {
    for (const result of results) process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
    process.exit(results.every((result) => result.verdict === 'PASS') ? 0 : 1);
  });
}
