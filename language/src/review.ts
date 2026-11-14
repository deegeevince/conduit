// Look and fix: the brain is shown what its draft will look like and repairs
// it within the same turn.
//
// The decisions here are pure and shared, because three programs must make
// them identically: the server (in a live turn), the exploration battery (so
// a measured run does what a live turn does) and the improvement loop (which
// may propose a different policy, but may not apply one silently).
//
// What it costs is known: one more model call a turn, six to ten seconds
// before the first line of the fix on the reference machine. So it is never
// spent on plain words, and it is spent while the draft is still playing: the
// painter reports how the draft WILL land as soon as the brain has finished
// writing it, without waiting for the playhead.

import type { LineProblem } from './context';
import type { Schedule } from './schedule';
import { isInFlow } from './schedule';
import { describeSight } from './sight';
import type { PlacedBox, Sight, SightNote } from './sight';
import type { Line } from './types';
import { BACKDROP_LAYERS } from './vocabulary';
import type { ContentCount, CriticFinding } from './wire';

export interface ReviewPolicy {
  readonly enabled: boolean;
  /** fix passes after the draft, at most. One: measured, the first look gives most of the gain and each costs a model call. */
  readonly passes: number;
  /** a draft with fewer free-drawn things than this, and nothing to report, is left alone */
  readonly minDrawn: number;
  /** ms the server waits for the painter's draft report and picture before it gives up on looking */
  readonly draftWaitMs: number;
  /** ms the brain has to write the first line of a fix before the pass is abandoned and the draft kept */
  readonly firstLineMs: number;
  /** ms a whole fix pass may take */
  readonly passMs: number;
}

export const REVIEW_POLICY: ReviewPolicy = { enabled: true, passes: 1, minDrawn: 3, draftWaitMs: 1500, firstLineMs: 12_000, passMs: 30_000 };

/** The notes that mean a viewer cannot read or find something. Any one of them is reason enough to look. */
export const BLOCKING_NOTES: readonly SightNote[] = ['clipped', 'off-canvas', 'covered', 'overlaps', 'collides', 'crossed', 'faint', 'tiny', 'crowded', 'sparse', 'lost'];

/** What can be told about a draft from its lines alone, before the painter has said anything. */
export interface DraftFacts {
  /** shapes, sprites and copies the brain placed by its own coordinates, backdrop left out */
  readonly drawn: number;
  /** structures the painter laid out */
  readonly structures: number;
  readonly controls: number;
  /** text the brain placed itself (`at=x,y`, `near=`, a callout): where a blind writer goes wrong */
  readonly placedText: number;
  /** lines of the draft the parser dropped */
  readonly rejects: number;
}

/** Counts what a draft put on stage. `fromSeq`: only lines after this one count, so a later pass is judged on what it added. */
export function draftFactsOf(schedule: Schedule, rejects: number, fromSeq = 0): DraftFacts {
  let drawn = 0;
  let structures = 0;
  let controls = 0;
  let placedText = 0;
  for (const element of schedule.elements) {
    if (element.carried || element.seq <= fromSeq) continue;
    const backdrop = BACKDROP_LAYERS.includes(element.style.layer);
    if (element.kind === 'shape' || element.kind === 'sprite' || element.kind === 'copy') drawn += backdrop ? 0 : 1;
    else if (element.kind === 'structure') structures += 1;
    else if (element.kind === 'control') controls += 1;
    else if (element.kind === 'text') {
      const scene = schedule.scenes.find((candidate) => candidate.id === element.scene);
      if (scene !== undefined && !isInFlow(element.style, scene.layout) && !backdrop) placedText += 1;
    }
  }
  return { drawn, structures, controls, placedText, rejects };
}

export interface ReviewDecision {
  readonly look: boolean;
  /** why, in a few words: it is logged, and shown on the battery's card */
  readonly why: string;
}

/** Stage one, from the lines alone: is it worth asking the painter how this draft lands? Plain words never are, so a plain answer is never held up. */
export function worthALook(facts: DraftFacts, policy: ReviewPolicy = REVIEW_POLICY): ReviewDecision {
  if (!policy.enabled || policy.passes < 1) return { look: false, why: 'look and fix is off' };
  if (facts.drawn + facts.structures + facts.controls + facts.placedText === 0) return { look: false, why: 'nothing drawn: plain words are not held up' };
  return { look: true, why: 'something was drawn' };
}

function blocking(sight: Sight | null): number {
  if (sight === null) return 0;
  return sight.items.filter((item) => item.notes.some((note) => BLOCKING_NOTES.includes(note))).length;
}

/**
 * Stage two, with the painter's draft report: is it worth a model call?
 * A free drawing always is when there is a picture, because only a look can
 * say whether it reads. A structure the painter laid out cleanly is not: its
 * geometry is the painter's and was checked when it was placed.
 */
export function worthAFix(facts: DraftFacts, sight: Sight | null, picture: boolean, policy: ReviewPolicy = REVIEW_POLICY): ReviewDecision {
  if (sight === null && !picture) return { look: false, why: 'the painter sent no draft report in time' };
  const wrong = blocking(sight);
  if (wrong > 0) return { look: true, why: `${wrong} thing${wrong === 1 ? '' : 's'} did not land` };
  if (facts.rejects > 0) return { look: true, why: `${facts.rejects} line${facts.rejects === 1 ? ' was' : 's were'} dropped` };
  if (facts.drawn >= policy.minDrawn && picture) return { look: true, why: 'a free drawing: only a look can say whether it reads' };
  if (facts.structures + facts.controls > 0) return { look: false, why: 'laid out by the painter, and it landed clean' };
  return { look: false, why: 'small, and it landed clean' };
}

/** What the brain writes, alone on a line, when it has looked and would change nothing. */
export const REVIEW_KEEP = 'ok';

export function isKeep(raw: string): boolean {
  // The brief shows the word in backticks and a model copies them; "Looks good." means the same. Neither is a line to reject and report back.
  return /^[`'"*\s]*(?:ok|okay|keep|kept|keep it|looks? (?:good|right|fine)|no changes?(?: needed)?|nothing to (?:fix|change))[.!]?[`'"*\s]*$/i.test(raw.trim());
}

export interface ReviewBriefInput {
  /** what the user asked, as the turn's brief put it */
  readonly asked: string;
  readonly sight: Sight | null;
  readonly problems: readonly LineProblem[];
  /** a picture of the draft is attached to the message */
  readonly picture: boolean;
  /** the pass about to be written: 2 for the first look */
  readonly pass: number;
  /** v2.1. `fix` (the default) repairs what did not land; `refine` adds to a picture that did ("keep making it better") */
  readonly form?: ReviewForm;
  /** v2.1. Where everything on stage rests, by id, so that a fix can name what it moves: the painter's own boxes, canvas units */
  readonly placed?: readonly PlacedBox[];
  /** v2.1. What a critic that can see made of the picture; its problems are named in a fix, its suggestions in a refine pass */
  readonly critic?: Pick<CriticFinding, 'problems' | 'suggestions'> | null;
  /** v2.1, `refine` only: the passes asked for, for "pass 2 of 4" */
  readonly of?: number;
  /** v2.1. What the user asked to hold on every reply (`TurnContext.standing`): a draft that breaks one is not right, however well it landed */
  readonly standing?: readonly string[];
}

/** The most boxes a brief lists: the largest things first. Past this a brain reads the picture. */
const PLACED_IN_BRIEF = 24;

function placedRows(placed: readonly PlacedBox[]): string[] {
  return [...placed]
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
    .slice(0, PLACED_IN_BRIEF)
    .map((item) => `  ${item.id} (${item.kind}${item.parent === null ? '' : ` in ${item.parent}`}): ${Math.round(item.box.w)}x${Math.round(item.box.h)} at ${Math.round(item.box.x)},${Math.round(item.box.y)}`);
}

/**
 * The message a brain is given when it is shown its draft. It is the same
 * for every brain and every turn apart from what the painter (and, when one
 * looked, the critic) reported, so a measured gain belongs to the mechanism
 * and not to a phrasing tuned on one prompt.
 *
 * v2.1: it asks for a diff and says what becomes of one. What the brain writes
 * now is tried out of sight; it is shown only if it takes nothing away and
 * lands no worse. So the brief no longer offers a new scene at all: in v2 that
 * offer was taken in most fixes, and the viewer watched the answer drawn twice.
 */
export function buildReviewBrief(input: ReviewBriefInput): string {
  const form: ReviewForm = input.form ?? 'fix';
  const rows: string[] = [];
  if (input.sight !== null) for (const line of describeSight(input.sight)) rows.push(`  ${line}`);
  for (const problem of input.problems) rows.push(`  ${problem.kind === 'rejected' ? 'REJECTED' : 'REPAIRED'} \`${problem.raw}\`: ${problem.why}`);
  const seen = input.picture ? 'The picture attached is the stage as the lines you have written will leave it.' : 'No picture could be taken; go by the report.';
  const where = input.placed === undefined || input.placed.length === 0 ? null : `WHERE THINGS ARE (id: size at top-left corner, canvas units):\n${placedRows(input.placed).join('\n')}`;
  const critic = input.critic ?? null;
  if (form === 'refine') {
    const wants = critic === null || critic.suggestions.length === 0 ? null : `A CRITIC WHO CAN SEE IT SAYS it would be better for:\n${critic.suggestions.map((line) => `  - ${line}`).join('\n')}`;
    return [
      `BETTER. This is not the user: it is the stage, showing you the picture as it stands${input.of === undefined ? '' : ` (pass ${Math.max(1, input.pass - 1)} of ${input.of})`}. ${seen}`,
      wants,
      where,
      `THE USER ASKED: ${input.asked}`,
      [
        'Make it better by adding to it. What you write now is tried out of sight and shown only if the picture gains:',
        '- build on what is there: a layer behind it, detail where it is plain, light and shadow, one more thing that belongs;',
        '- change a thing by its id only to improve it (`set`, `move`, the same line again with what differs);',
        '- never `scene`, never draw again what is already there, never take anything away;',
        '- end with one short `say` naming what you added, and nothing about the method.',
        `If nothing would make it better, write the one line \`${REVIEW_KEEP}\` and nothing else.`,
        'Start at once.',
      ].join('\n'),
    ]
      .filter((part): part is string => part !== null)
      .join('\n\n');
  }
  const found = critic === null || critic.problems.length === 0 ? null : `A CRITIC WHO CAN SEE IT SAYS:\n${critic.problems.map((problem) => `  ${problem.id === null ? '' : `${problem.id}: `}${problem.what}`).join('\n')}`;
  return [
    `LOOK. This is not the user: it is the stage, showing you your own answer so far. ${seen}`,
    rows.length === 0 ? 'THE PAINTER REPORTS: nothing wrong that it can measure.' : `THE PAINTER REPORTS:\n${rows.join('\n')}`,
    found,
    where,
    `THE USER ASKED: ${input.asked}`,
    input.standing === undefined || input.standing.length === 0 ? null : `AND ASKED EARLIER, FOR EVERY REPLY:\n${input.standing.map((ask) => `  - ${ask}`).join('\n')}`,
    [
      `If it reads right, answers what was asked and keeps to what was asked for every reply, write the one line \`${REVIEW_KEEP}\` and nothing else.`,
      'If not, change only what is wrong, in as few lines as it takes. What you write now is tried out of sight and shown only if it is better:',
      '- change a thing by its id: `set`, `move`, `revise <id> | new words`, `cancel <id>`, or its own line again with what differs;',
      '- a diagram or a chart in the wrong place or too small: its opening line again with a room (`flow x1 4,6 152x62`); its parts stay as they are;',
      '- words crossed, crowded or beside the wrong thing: `move` them, or let the painter place them (`say callout near=<id>`);',
      '- never `scene`, never the lines that were right, never fewer parts than before: a fix that takes something away is thrown out and the draft stays;',
      '- add nothing the user did not ask for, and say nothing about the fix.',
      'Start at once.',
    ].join('\n'),
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

// ---------------------------------------------------------------- v2.1: true revision
//
// In v2 a fix was a second performance: in most fixes the brain opened a new scene and wrote the whole answer again, the viewer
// watched the same diagram drawn twice, and nothing checked that the second was better (PLAN-v2.1.md, "True revision"). From v2.1:
//
//   1. A fix is a diff. It changes what is there (`set`, `move`, `revise`, `cancel`, `drop`, a thing declared again under its id with
//      something different) and may add to it. It never opens a scene and never says again what has not changed (`fixLineAllowed`,
//      and the schedule's own rule that a line declared again unchanged is nothing).
//   2. A fix is tried before it is shown. Its lines go to the painter as a `candidate`; the painter applies them to a copy of the
//      turn's score and reports how the copy lands. Nothing of it is on stage.
//   3. A fix is shown only if it is no worse: it takes nothing away that the draft had (`fixKeeps`), it lands with no more wrong than
//      the draft did (`landsNoWorse`), and, when a critic is on and answers in time, the critic does not prefer the draft
//      (`criticPrefers`). Otherwise it is refused and the draft stands.
//
// The three rules are pure and are here, beside the two look decisions, for the same reason: the server, the battery and the loop
// must decide identically, and the loop may not change them (this file is protected).

/** Why a fix was not shown, in the words the log, the battery's card and `pass … refused` carry. */
export type FixRefusal = 'it wrote nothing that changes the stage' | 'it took something away' | 'it landed worse than the draft' | 'the critic preferred the draft' | 'it could not be tried in time';

/** What a pass after the draft is for. `fix`: repair what did not land. `refine`: make a picture that landed better ("keep making it better"). */
export type ReviewForm = 'fix' | 'refine';

export interface FixPolicy {
  /** the share of the draft's free-drawn things a fix must leave on stage */
  readonly keepDrawn: number;
  /** the share of the draft's readable words (choices left out) a fix must leave; a fix may shorten, it may not empty */
  readonly keepWords: number;
  /** ms the server waits for the painter's report on a candidate before it gives the fix up */
  readonly candidateWaitMs: number;
  /** ms the critic has, after the fix is already shown, to compare draft and candidate in the background; only logged, never waited for */
  readonly compareMs: number;
}

export const FIX_POLICY: FixPolicy = { keepDrawn: 0.8, keepWords: 0.6, candidateWaitMs: 1500, compareMs: 60_000 };

/**
 * Whether a line may be part of a pass after the draft. `scene` and `look` never are: a fix does not start again and does not change
 * the whole stage's dress. `wait` is dropped without a word: a fix takes no time of its own. `why` is what the brain is told next turn.
 */
export function fixLineAllowed(line: Line): { readonly allowed: boolean; readonly why: string | null } {
  if (line.verb === 'scene') return { allowed: false, why: 'a fix changes what is there; it never opens a new scene' };
  if (line.verb === 'look') return { allowed: false, why: 'a fix does not change the look' };
  if (line.verb === 'wait') return { allowed: false, why: null };
  return { allowed: true, why: null };
}

/**
 * What a schedule leaves on stage once everything in it has played: the count a fix is held to. Counted from elements that never
 * leave (no exit), carried ones included, since a fix may not take away what an earlier turn left either.
 */
export function contentOf(schedule: Schedule): ContentCount {
  let structures = 0;
  let parts = 0;
  let drawn = 0;
  let controls = 0;
  let words = 0;
  const choices: string[] = [];
  const resting = new Set<string>();
  for (const element of schedule.elements) if (element.exit === null) resting.add(element.key);
  for (const element of schedule.elements) {
    if (!resting.has(element.key)) continue;
    if (element.kind === 'structure') {
      structures += 1;
      if (element.figure?.kind === 'structure') parts += element.figure.rows.length;
    } else if (element.kind === 'node' || element.kind === 'link') {
      if (element.parent === null || resting.has(element.parent)) parts += 1;
    } else if (element.kind === 'shape' || element.kind === 'sprite' || element.kind === 'copy' || element.kind === 'picture') drawn += 1;
    else if (element.kind === 'control') controls += 1;
    else if (element.kind === 'text' && !element.struck) {
      if (element.style.tap) choices.push(element.text);
      else words += element.text.length;
    }
  }
  return { structures, parts, drawn, controls, words, choices };
}

/** Rule one of three: the fix takes nothing away. A structure, a part of one, a control or a choice fewer (or reworded) is a refusal outright; drawing and words may shrink a little, not go. */
export function fixKeeps(draft: ContentCount, candidate: ContentCount, policy: FixPolicy = FIX_POLICY): { readonly keeps: boolean; readonly why: string | null } {
  if (candidate.structures < draft.structures) return { keeps: false, why: `a diagram was removed (${draft.structures} before, ${candidate.structures} after)` };
  if (candidate.parts < draft.parts) return { keeps: false, why: `parts of a diagram were removed (${draft.parts} before, ${candidate.parts} after)` };
  if (candidate.controls < draft.controls) return { keeps: false, why: `a control was removed (${draft.controls} before, ${candidate.controls} after)` };
  // A choice is the user's next move: a fix may not drop one or put other words in it (it once overwrote one with the answer sentence).
  const offered = draft.choices ?? [];
  if (offered.length > 0) {
    const left = [...(candidate.choices ?? [])];
    for (const choice of offered) {
      const at = left.indexOf(choice);
      if (at < 0) return { keeps: false, why: `a choice was removed or reworded ("${choice.slice(0, 60)}")` };
      left.splice(at, 1);
    }
  }
  if (candidate.drawn < Math.ceil(draft.drawn * policy.keepDrawn)) return { keeps: false, why: `drawing was removed (${draft.drawn} things before, ${candidate.drawn} after)` };
  if (candidate.words < Math.floor(draft.words * policy.keepWords)) return { keeps: false, why: `words were removed (${draft.words} characters before, ${candidate.words} after)` };
  return { keeps: true, why: null };
}

/** Rule two: by the painter's own measure the candidate lands with no more wrong than the draft. A candidate the painter did not report on in time is not shown. */
export function landsNoWorse(draft: Sight | null, candidate: Sight | null): { readonly ok: boolean; readonly why: string | null } {
  if (candidate === null) return { ok: false, why: 'the painter did not say how the fix would land' };
  const before = blocking(draft);
  const after = blocking(candidate);
  return after > before ? { ok: false, why: `${after} things would not land, against ${before} in the draft` } : { ok: true, why: null };
}

/**
 * Rule three, when a critic looked at both pictures in one call: the draft is kept only when the critic scores it higher. A tie goes to
 * the fix for a `fix` pass (the painter already said it lands no worse) and to the draft for a `refine` pass (no gain is the signal to stop).
 */
export function criticPrefers(draft: Pick<CriticFinding, 'coherence'>, candidate: Pick<CriticFinding, 'coherence'>, form: ReviewForm): 'draft' | 'candidate' {
  if (candidate.coherence > draft.coherence) return 'candidate';
  if (candidate.coherence < draft.coherence) return 'draft';
  return form === 'fix' ? 'candidate' : 'draft';
}

/** "Keep making it better" stops when the critic has nothing worth a pass, when a pass was refused, or when the passes are spent. */
export function refineGoesOn(finding: Pick<CriticFinding, 'suggestions'> | null, passesDone: number, passesAsked: number, lastRefused: boolean): { readonly on: boolean; readonly why: string } {
  if (passesDone >= passesAsked) return { on: false, why: `${passesAsked} passes done` };
  if (lastRefused) return { on: false, why: 'the last pass made it no better' };
  if (finding === null) return { on: false, why: 'the critic could not look' };
  if (finding.suggestions.length === 0) return { on: false, why: 'the critic sees nothing more worth a pass' };
  return { on: true, why: 'the critic sees something to add' };
}
