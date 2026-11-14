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
import type { Sight, SightNote } from './sight';
import { BACKDROP_LAYERS } from './vocabulary';

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
export const BLOCKING_NOTES: readonly SightNote[] = ['clipped', 'off-canvas', 'covered', 'overlaps', 'collides', 'crossed', 'faint', 'tiny', 'crowded'];

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
  return /^(?:ok|okay|keep|kept)[.!]?$/i.test(raw.trim());
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
}

/**
 * The message a brain is given when it is shown its draft. It is the same
 * for every brain and every turn apart from what the painter reported, so a
 * measured gain belongs to the mechanism and not to a phrasing tuned on one
 * prompt. It asks for the smallest repair: what the viewer has not reached
 * yet is fixed quietly (`revise`), what they have seen is fixed in front of
 * them, and a redraw is the last resort.
 */
export function buildReviewBrief(input: ReviewBriefInput): string {
  const rows: string[] = [];
  if (input.sight !== null) for (const line of describeSight(input.sight)) rows.push(`  ${line}`);
  for (const problem of input.problems) rows.push(`  ${problem.kind === 'rejected' ? 'REJECTED' : 'REPAIRED'} \`${problem.raw}\`: ${problem.why}`);
  const seen = input.picture ? 'The picture attached is the stage as the lines you have just written will leave it.' : 'No picture could be taken; go by the report.';
  return [
    `LOOK. This is not the user: it is the stage, showing you your own answer so far. ${seen}`,
    rows.length === 0 ? 'THE PAINTER REPORTS: nothing wrong that it can measure.' : `THE PAINTER REPORTS:\n${rows.join('\n')}`,
    `THE USER ASKED: ${input.asked}`,
    [
      `If it reads right and answers what was asked, write the one line \`${REVIEW_KEEP}\` and nothing else.`,
      'If not, fix it now, in as few lines as it takes:',
      '- patch what is there: `set`, `move`, `drop`, a shape declared again under its id, `correct`; `revise <id>` changes quietly anything the viewer has not reached yet;',
      '- words crossed, crowded or beside the wrong thing: move the words, or let the painter place them (`say callout near=<id>`, or a structure in place of boxes placed by hand);',
      '- only when it cannot be patched, open a new `scene` and draw it again, better;',
      '- add nothing the user did not ask for, and say nothing about the fix.',
      'Start at once.',
    ].join('\n'),
  ].join('\n\n');
}
