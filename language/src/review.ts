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

import type { LineProblem, OwedFinding } from './context';
import type { Schedule } from './schedule';
import { isInFlow } from './schedule';
import { describeSight } from './sight';
import type { PlacedBox, Sight, SightNote } from './sight';
import type { Line } from './types';
import { BACKDROP_LAYERS } from './vocabulary';
import type { ContentCount, CriticFinding, CriticProblem } from './wire';

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

export const REVIEW_POLICY: ReviewPolicy = { enabled: true, passes: 1, minDrawn: 3, draftWaitMs: 8000, firstLineMs: 12_000, passMs: 30_000 };

/** The notes that mean a viewer cannot read or find something. Any one of them is reason enough to look. */
export const BLOCKING_NOTES: readonly SightNote[] = ['clipped', 'off-canvas', 'covered', 'overlaps', 'collides', 'crossed', 'spills', 'tangled', 'wrong-part', 'faint', 'tiny', 'crowded', 'sparse', 'lost'];

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

const NO_SHELF: ReadonlySet<string> = new Set();

/** Counts what a draft put on stage. `shelf`: the ids of figures the server drew from the art shelf (the figure, its parts, its placeholder); they are not free drawing, and a fix has nothing to say about them. `fromSeq`: only lines after this one count, so a later pass is judged on what it added. */
export function draftFactsOf(schedule: Schedule, rejects: number, fromSeq = 0, shelf: ReadonlySet<string> = NO_SHELF): DraftFacts {
  let drawn = 0;
  let structures = 0;
  let controls = 0;
  let placedText = 0;
  for (const element of schedule.elements) {
    if (element.carried || element.seq <= fromSeq) continue;
    if (shelf.has(element.id) || (element.parent !== null && shelf.has(element.parent))) continue;
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

/** How many things the painter's measure says do not land. */
export function blockingCount(sight: Sight | null): number {
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
  const wrong = blockingCount(sight);
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
  /** SA4. The canvas tools are on: with no picture attached, `canvas_look` can ask the page for one, and they are the only tools there are */
  readonly canvas?: boolean;
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
  /** v3. `repair`: the brain's own EYES digest, what the stage and the person have shown since it last wrote */
  readonly eyes?: string | null;
  /** v3, `repair`: the lines of the answer as they were written, so a fix can name what it changes even when the process has forgotten them */
  readonly written?: readonly string[];
}

/** v3. The most lines of the answer a repair brief repeats. */
export const REPAIR_LINES_SHOWN = 120;

/** The most boxes a brief lists: the largest things first. Past this a brain reads the picture. */
const PLACED_IN_BRIEF = 24;

/** One placed thing as the brief prints it, and as `canvas_stage` prints it: the one printer for a box. */
export function placedLine(item: PlacedBox): string {
  return `${item.id} (${item.kind}${item.parent === null ? '' : ` in ${item.parent}`}): ${Math.round(item.box.w)}x${Math.round(item.box.h)} at ${Math.round(item.box.x)},${Math.round(item.box.y)}`;
}

function placedRows(placed: readonly PlacedBox[]): string[] {
  return [...placed]
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
    .slice(0, PLACED_IN_BRIEF)
    .map((item) => `  ${placedLine(item)}`);
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
  const seen = input.picture ? 'The picture attached is the stage as the lines you have written will leave it.' : (input.canvas === true ? 'No picture is attached. The canvas tools are the only tools you have, and only canvas_look fetches a picture; otherwise go by the measurements.' : 'No picture is attached and none can be fetched: use no tool, go by the measurements.');
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
  if (form === 'repair') {
    const raised = (critic?.problems ?? []).filter((problem) => problem.raised !== false);
    const named = raised.map((problem) => `  - ${problem.id === null ? '(no one element)' : problem.id}${problem.gate === undefined ? '' : ` [${problem.gate}${problem.owner === undefined ? '' : `, ${problem.owner}`}]`}: ${problem.what}${problem.evidence === undefined || problem.evidence === '' ? '' : `\n      seen: ${problem.evidence}`}`);
    return [
      `REPAIR. This is not the user and nothing new was asked: the answer you wrote is on the stage at rest, and a critic who can see it found it broken. ${seen}`,
      `THE CRITIC FOUND:\n${named.length === 0 ? '  (nothing it could name)' : named.join('\n')}`,
      rows.length === 0 ? 'THE STAGE MEASURES: nothing wrong that it can measure.' : `THE STAGE MEASURES:\n${rows.join('\n')}`,
      input.eyes === undefined || input.eyes === null || input.eyes.trim() === '' ? null : `EYES (what has been seen since you last wrote):\n${input.eyes}`,
      where,
      input.written === undefined || input.written.length === 0 ? null : `THE LINES YOU WROTE FOR IT, in order:\n${input.written.slice(0, REPAIR_LINES_SHOWN).map((line) => `  ${line.length > 220 ? `${line.slice(0, 219)}…` : line}`).join('\n')}${input.written.length > REPAIR_LINES_SHOWN ? `\n  … and ${input.written.length - REPAIR_LINES_SHOWN} more` : ''}`,
      input.asked === '' ? null : `THE USER ASKED: ${input.asked}`,
      input.standing === undefined || input.standing.length === 0 ? null : `AND ASKED EARLIER, FOR EVERY REPLY:\n${input.standing.map((ask) => `  - ${ask}`).join('\n')}`,
      [
        'Write fix lines for what the critic found, not a new answer. You have one try. It is tried out of sight and kept only if fewer things on THE STAGE MEASURES list still do not land than now (and it takes nothing away): clear as many of those as you can, and never move one thing onto another.',
        '- change a thing by its id: `set <id> size=... fill=...`, `move <id> x,y` (or the same through the canvas tools\' own intents), `revise <id> | shorter words`, `drop <id>` for a thing that only gets in the way;',
        '- a table or grid that is empty or mis-sized is opened again by its id with what differs;',
        '- a label made with `say callout near=<id>` is placed by the stage: name the right part in `near=`, or `move <id> x,y` to free it and put it there; never add a second label for words already on stage;',
        '- never `scene`, never the lines that were right, never fewer parts than before (that fix is thrown out);',
        '- before you write, check the lines you mean to write with `canvas_fits` (one line per line): it says whether they add anything that would not land, and what they clear. Write only lines it says fit, and fewer things that do not land than now; it is the only tool you have;',
        '- say nothing about the fix.',
        `Write \`${REVIEW_KEEP}\` and nothing else only if no line at all could help.`,
        'Start at once.',
      ].join('\n'),
    ]
      .filter((part): part is string => part !== null)
      .join('\n\n');
  }
  const found = critic === null || critic.problems.length === 0 ? null : `A CRITIC WHO CAN SEE IT SAYS:\n${critic.problems.map((problem) => `  ${problem.id === null ? '' : `${problem.id}: `}${problem.what}`).join('\n')}`;
  return [
    `LOOK. This is not the user: it is the stage, showing you your own answer so far. ${seen}`,
    rows.length === 0 ? 'THE STAGE MEASURES: nothing wrong that it can measure.' : `THE STAGE MEASURES:\n${rows.join('\n')}`,
    found,
    where,
    `THE USER ASKED: ${input.asked}`,
    input.standing === undefined || input.standing.length === 0 ? null : `AND ASKED EARLIER, FOR EVERY REPLY:\n${input.standing.map((ask) => `  - ${ask}`).join('\n')}`,
    [
      `If it reads right, answers what was asked and keeps to what was asked for every reply, write the one line \`${REVIEW_KEEP}\` and nothing else.`,
      'If not, change only what is wrong, in as few lines as it takes. What you write now is tried out of sight and shown only if it is better:',
      '- change a thing by its id: `set` (`set <id> | new words` too), `move`, `cancel <id>`, or its own line again with what differs;',
      '- words crossed by a line, or on other words, are `move`d (`move <id> x,y`, which also frees a label from its `near=`) or `set <id> | shorter words`: never draw them again as a new label, that leaves the old one standing;',
      '- if a try of yours is listed above as thrown out, it was measured: read why, and write a different fix;',
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
//   1. A fix is a diff. It changes what is there (`set`, `move`, `cancel`, `drop`, a thing declared again under its id with
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
export type ReviewForm = 'fix' | 'refine' | 'repair';

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
export function fixLineAllowed(line: Line, _schedule?: Schedule): { readonly allowed: boolean; readonly why: string | null } {
  if (line.verb === 'scene') return { allowed: false, why: 'a fix changes what is there; it never opens a new scene' };
  if (line.verb === 'look') return { allowed: false, why: 'a fix does not change the look' };
  if (line.verb === 'wait') return { allowed: false, why: null };
  // `move <id> x,y` on a label placed by `near=` is allowed: the schedule lets the label go from its anchor and stand where it is moved to (and drops its leader)
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
  const said = new Set<string>();
  let dupes = 0;
  let dupeOf: string | undefined;
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
      else {
        words += element.text.length;
        // the same words twice on one stage: a label drawn again beside the one it was meant to replace
        const same = element.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (same.length >= 3) {
          if (said.has(same)) {
            dupes += 1;
            dupeOf ??= element.text.trim();
          } else said.add(same);
        }
      }
    }
  }
  return { structures, parts, drawn, controls, words, choices, dupes, ...(dupeOf === undefined ? {} : { dupeOf }) };
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
  if ((candidate.dupes ?? 0) > (draft.dupes ?? 0)) return { keeps: false, why: `it added a second copy of words already on stage ("${(candidate.dupeOf ?? '').slice(0, 40)}"): change the first with set, move or cancel, never draw it again` };
  if (candidate.drawn < Math.ceil(draft.drawn * policy.keepDrawn)) return { keeps: false, why: `drawing was removed (${draft.drawn} things before, ${candidate.drawn} after)` };
  if (candidate.words < Math.floor(draft.words * policy.keepWords)) return { keeps: false, why: `words were removed (${draft.words} characters before, ${candidate.words} after)` };
  return { keeps: true, why: null };
}

/** Rule two: by the painter's own measure the candidate lands with no more wrong than the draft. A candidate the painter did not report on in time is not shown. */
export function landsNoWorse(draft: Sight | null, candidate: Sight | null): { readonly ok: boolean; readonly why: string | null } {
  if (candidate === null) return { ok: false, why: 'the painter did not say how the fix would land' };
  const before = blockingCount(draft);
  const after = blockingCount(candidate);
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

// ---------------------------------------------------------------- v3: critic-driven repair
//
// The critic sees the picture an answer left at rest and says what is broken (a finding with gates, tiers, evidence and owners). Until now
// nothing came of it: the answer stayed broken on the screen. A repair is one pass on the warm brain after that finding: it is shown what
// the critic found and writes fix lines, which are tried on the server and kept only by the rules below. Pure, like the three rules above:
// the server, the battery and the loop must decide identically.

/** The tier-1 gates a repair is for: whether the answer can be read at all. */
export const REPAIR_GATES: readonly string[] = ['on-stage', 'readable', 'no-overlap'];
/** Who may own a failure that is still the brain's to work around: its own, or the painter's or the kit's (it can move, shorten or drop). */
export const REPAIR_OWNERS: readonly string[] = ['brain', 'painter', 'kit'];

export interface RepairWorth {
  readonly wanted: boolean;
  /** the raised tier-1 problems a repair is asked to mend, in the critic's order */
  readonly problems: readonly CriticProblem[];
  /** their gates, once each */
  readonly gates: readonly string[];
  readonly why: string;
}

/** Whether a critic's finding calls for a repair: a raised tier-1 failure (`on-stage`, `readable`, `no-overlap`) the brain, or a painter or kit failure it can work around, owns. */
export function repairWorth(finding: Pick<CriticFinding, 'problems'>): RepairWorth {
  const problems = finding.problems.filter((problem) => problem.raised !== false && problem.tier === 1 && REPAIR_GATES.includes(problem.gate ?? '') && REPAIR_OWNERS.includes(problem.owner ?? 'brain'));
  if (problems.length === 0) return { wanted: false, problems, gates: [], why: 'no raised tier-1 failure the brain can work around' };
  return { wanted: true, problems, gates: [...new Set(problems.map((problem) => problem.gate ?? ''))], why: `${problems.length} raised problem${problems.length === 1 ? '' : 's'}: ${[...new Set(problems.map((problem) => problem.gate ?? ''))].join(', ')}` };
}

/**
 * Whether a repair is kept. The three tests, all of them: it takes nothing away (`fixKeeps`), it lands no worse (`landsNoWorse`), and by the
 * painter's own measure it is strictly better (fewer things that do not land than before, which is also what "nothing new is blocking" comes to: no more). A repair the measure cannot tell from the draft is not kept: the measure is the only judge that is fast enough to be in the loop.
 */
export function repairKeeps(
  draft: { readonly content: ContentCount; readonly sight: Sight | null },
  candidate: { readonly content: ContentCount | null; readonly sight: Sight | null },
  policy: FixPolicy = FIX_POLICY,
): { readonly keeps: boolean; readonly why: string | null } {
  if (candidate.content === null || candidate.sight === null) return { keeps: false, why: 'it could not be tried' };
  const kept = fixKeeps(draft.content, candidate.content, policy);
  if (!kept.keeps) return { keeps: false, why: `it took something away: ${kept.why ?? ''}`.trim() };
  const lands = landsNoWorse(draft.sight, candidate.sight);
  if (!lands.ok) return { keeps: false, why: `it landed worse: ${lands.why ?? ''}`.trim() };
  const before = blockingCount(draft.sight);
  const after = blockingCount(candidate.sight);
  if (after >= before) return { keeps: false, why: before === 0 ? 'the stage measures nothing wrong, so it cannot tell that the repair is better' : `no better by the stage's measure: ${after} thing${after === 1 ? '' : 's'} do not land, against ${before} before` };
  return { keeps: true, why: null };
}


// ---------------------------------------------------------------- the loop: a fix thrown out is told back; a critic's finding is not lost

const RETRY_ROWS = 6;

/** What a fix that was thrown out left wrong, as rows the brain can act on: id, then what did not land. */
function wrongRows(sight: Sight | null): string[] {
  if (sight === null) return [];
  return sight.items.filter((item) => item.notes.some((note) => BLOCKING_NOTES.includes(note))).slice(0, RETRY_ROWS).map((item) => `${item.id}: ${item.notes.filter((note) => BLOCKING_NOTES.includes(note)).join(', ')}`);
}

/**
 * The brain's own try, thrown out, as the next try is told of it: the lines it wrote, why they were refused, and what they would have left wrong.
 * It rides in the brief as a rejected line, so every brain prints it and none has to know about retries.
 */
export function retryProblem(attempt: number, lines: readonly string[], refusal: string, sight: Sight | null): LineProblem {
  const rows = wrongRows(sight);
  const written = lines.length === 0 ? 'nothing it could use' : lines.join(' / ');
  return {
    raw: `try ${attempt}: ${written.length > 110 ? `${written.slice(0, 109)}…` : written}`,
    kind: 'rejected',
    why: `thrown out, not shown: ${refusal}.${rows.length === 0 ? '' : ` It would have left these not landing: ${rows.join('; ')}.`} Write a different fix.`,
  };
}


/** The critic's raised, blocking problems, as owed. */
export function owedFrom(turn: string, finding: Pick<CriticFinding, 'problems'>): OwedFinding[] {
  return finding.problems
    .filter((problem) => problem.raised !== false && problem.weight === 'blocks')
    .map((problem) => ({ turn, id: problem.id, gate: problem.gate ?? null, what: problem.what.replace(/\s+/g, ' ').slice(0, 220) }));
}

const OWED_LIMIT = 4;

/** Findings still standing: those that name something still on stage (or no one), the newest few. */
export function owedStanding(owed: readonly OwedFinding[], live: ReadonlySet<string>): OwedFinding[] {
  return owed.filter((item) => item.id === null || live.has(item.id)).slice(-OWED_LIMIT);
}

/** The block of the brief that carries them. Null when nothing is owed. */
export function owedText(owed: readonly OwedFinding[]): string | null {
  if (owed.length === 0) return null;
  const rows = owed.map((item) => `  - ${item.id === null ? '(no one element)' : item.id}${item.gate === null ? '' : ` [${item.gate}]`}: ${item.what}`);
  return `A CRITIC WHO CAN SEE FOUND THESE BROKEN IN AN EARLIER ANSWER, AND NOTHING HAS MENDED THEM:\n${rows.join('\n')}\nMend them when you next touch that drawing (\`set\`, \`move\`, \`cancel\`, \`revise\` by the id named): never draw the thing again beside the old one.`;
}
