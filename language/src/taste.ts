// Taste calibration: whose eye the judge stands in for.
//
// The improvement loop steers by a model's score. That is only worth doing if
// the model's score agrees with the owner's own eye. So the owner scores a
// small set of answers once (thumbs up or down, and a word), and the agreement
// between those and the judge's scores is worked out here and shown wherever
// the judge is used. These types cross from the page to the server and to the
// loop, so they live in the shared package with the one function all three use.

import type { ExploreFamily } from './explore';

/** One answer set before the owner: enough to show it and to find the judge's reading of it. */
export interface TasteItem {
  /** the run and the file stem of the answer (`<prompt>_<variant>_s<n>`) */
  readonly run: string;
  readonly answer: string;
  readonly prompt: string;
  readonly family: ExploreFamily;
  /** the judge's coherence for it, 1 to 5; hidden from the owner until they have scored it */
  readonly judge: number;
}

/** What the owner said about one answer. */
export interface TasteScore {
  readonly run: string;
  readonly answer: string;
  readonly up: boolean;
  /** one word, or a few: why. Free text; it is read by people and by the loop's critic. */
  readonly word: string;
  /** ISO time it was given */
  readonly at: string;
}

/** One sitting: the answers that were shown and what was said about them. Saved as `explore/taste/<stamp>.json`. */
export interface TasteSheet {
  readonly id: string;
  /** the judge's rubric hash when the items were judged: agreement is about that judge and no other */
  readonly rubric: string;
  readonly items: readonly TasteItem[];
  readonly scores: readonly TasteScore[];
}

export interface TasteAgreement {
  /** answers scored by both */
  readonly n: number;
  /** the judge's coherence at or above which it is taken to mean thumbs up: the cut that agrees best with the owner, 2 to 5 */
  readonly cut: number;
  /** share of answers on which the judge, at that cut, and the owner agree, 0..1 */
  readonly agreement: number;
  /** Cohen's kappa for the same: agreement beyond what chance would give; 1 perfect, 0 chance */
  readonly kappa: number;
  /** thumbs up the judge scored below the cut, and thumbs down it scored at or above it: where the two eyes differ */
  readonly missed: readonly { readonly answer: string; readonly judge: number; readonly up: boolean; readonly word: string }[];
  /** agreement by family, where a family has at least three scored answers */
  readonly byFamily: Readonly<Partial<Record<ExploreFamily, number>>>;
}

/** The least agreement at which the loop may steer by the judge. Below it the loop stops and asks for the rubric to be looked at. */
export const TASTE_FLOOR = { agreement: 0.75, kappa: 0.4, n: 16 } as const;

/** How far the judge agrees with the owner over one or more sheets. Null when nothing was scored. */
export function agreementOf(sheets: readonly TasteSheet[]): TasteAgreement | null {
  const pairs: { answer: string; judge: number; up: boolean; word: string; family: ExploreFamily }[] = [];
  for (const sheet of sheets) {
    for (const score of sheet.scores) {
      const item = sheet.items.find((candidate) => candidate.run === score.run && candidate.answer === score.answer);
      if (item !== undefined) pairs.push({ answer: `${item.run}/${item.answer}`, judge: item.judge, up: score.up, word: score.word, family: item.family });
    }
  }
  if (pairs.length === 0) return null;
  const at = (cut: number): number => pairs.filter((pair) => pair.judge >= cut === pair.up).length / pairs.length;
  let cut = 4;
  for (const candidate of [2, 3, 4, 5]) if (at(candidate) > at(cut)) cut = candidate;
  const agreement = at(cut);
  const ownerUp = pairs.filter((pair) => pair.up).length / pairs.length;
  const judgeUp = pairs.filter((pair) => pair.judge >= cut).length / pairs.length;
  const chance = ownerUp * judgeUp + (1 - ownerUp) * (1 - judgeUp);
  const byFamily: Partial<Record<ExploreFamily, number>> = {};
  for (const family of new Set(pairs.map((pair) => pair.family))) {
    const mine = pairs.filter((pair) => pair.family === family);
    if (mine.length >= 3) byFamily[family] = mine.filter((pair) => pair.judge >= cut === pair.up).length / mine.length;
  }
  return {
    n: pairs.length,
    cut,
    agreement,
    kappa: chance >= 1 ? 1 : (agreement - chance) / (1 - chance),
    missed: pairs.filter((pair) => pair.judge >= cut !== pair.up).map(({ answer, judge, up, word }) => ({ answer, judge, up, word })),
    byFamily,
  };
}

/** One line for a run's footer and the loop's changelog. */
export function agreementLine(found: TasteAgreement | null): string {
  if (found === null) return 'the judge has not been checked against the owner: run the taste page once';
  const enough = found.n >= TASTE_FLOOR.n && found.agreement >= TASTE_FLOOR.agreement && found.kappa >= TASTE_FLOOR.kappa;
  return `the judge agrees with the owner on ${Math.round(found.agreement * found.n)} of ${found.n} answers (${Math.round(found.agreement * 100)}%, kappa ${found.kappa.toFixed(2)}, thumbs up from ${found.cut})${enough ? '' : ': below the floor; do not steer by it'}`;
}
