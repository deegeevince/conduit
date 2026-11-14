// Checks of the rules that decide whether a fix is shown (language/src/review.ts), on cases that went wrong in real use.
// Run by `pnpm timeline`.
import { contentOf, EMPTY_STAGE, fixKeeps, LineNormalizer, LineReader, TurnScore } from '../src/index';

function build(lines: readonly string[], base?: TurnScore): TurnScore {
  const score = base ?? new TurnScore(EMPTY_STAGE);
  const reader = new LineReader();
  let auto = 100;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  let seq = base === undefined ? 0 : 1000;
  for (const raw of lines) {
    const read = reader.read(raw);
    if (read.kind !== 'line') throw new Error(`review check: line does not parse: ${raw}`);
    const normalized = normalizer.normalize(read.line);
    if (normalized.line === null) throw new Error(`review check: line dropped: ${raw}`);
    seq += 1;
    score.push(normalized.line, seq, 0);
  }
  return score;
}

export function reviewChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: boolean, want: boolean): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  REVIEW CHECK FAILED: ${what} (got ${got}, wanted ${want})\n`);
    }
  };
  // "which model are you?": the draft ends on a choice; the fix overwrote it with the answer sentence (v2.1 review, P1-1).
  const draft = build([
    'scene layout=caption mood=calm pace=steady',
    'say x9 strong | I am Claude Opus 5.5, running at low effort.',
    'say x10 | You can switch with /model and /effort.',
    "say x11 choice | what's the difference between them?",
  ]);
  const draftContent = contentOf(draft.schedule);
  expect('a draft with a choice counts it', draftContent.choices?.length === 1, true);
  const reword = build(['revise x11 | I am Claude Opus 5.5, at low effort. Switch with /model and /effort.'], draft.fork());
  expect('a fix that rewords a choice is refused', fixKeeps(draftContent, contentOf(reword.schedule)).keeps, false);
  const cancel = build(['cancel x11'], draft.fork());
  expect('a fix that cancels a choice is refused', fixKeeps(draftContent, contentOf(cancel.schedule)).keeps, false);
  const untouched = build(['move x9 40,40'], draft.fork());
  expect('a fix that leaves the choice alone is kept', fixKeeps(draftContent, contentOf(untouched.schedule)).keeps, true);
  const added = build(["say x12 choice | and what is effort?"], draft.fork());
  expect('a fix that adds a choice is kept', fixKeeps(draftContent, contentOf(added.schedule)).keeps, true);
  return ok;
}
