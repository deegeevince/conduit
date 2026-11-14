// The exploration harness: a battery of prompts and scripted conversations
// across the uses this medium might be good for, run through a brain (several
// times each, in one or more prompt variants), judged by a model that looks at
// the final picture, and laid out for review side by side. These types cross
// from the runner (a server-side tool) to the review page (in the browser), so
// they live here, together with the pure functions both sides use to turn an
// answer into verdicts and verdicts into pass rates.

import type { ReviewOutcome } from './context';
import type { Issue } from './types';
import type { StageBase } from './schedule';
import type { SightNote } from './sight';
import type { ChartKind, ControlKind, ElementKind, LookId, StructureKind } from './vocabulary';
import { PROMPT_VARIANTS } from './prompt';
import type { BriefForm, PromptVariant } from './prompt';
import type { TurnEndReason } from './wire';

/**
 * What kind of answer a prompt is fishing for. `plain` prompts check that the brain does NOT stage a fact.
 * `structure`: the answer names a structure (a flow, a table, a chart …) instead of placing boxes by coordinates.
 * `explorable`: the answer hands over at least one control that drives something on stage.
 * `chart`: the answer is a chart drawn by the charting engine, judged against professional chart quality.
 */
export type ExploreExpectation = 'plain' | 'drawn' | 'pixels' | 'scene' | 'type' | 'motion' | 'any' | 'structure' | 'explorable' | 'chart';

/**
 * What a prompt belongs to when scores are added up. The quality bar is set per
 * family (PLAN-v2.md): a rise in one may not be paid for by a fall in another.
 */
export type ExploreFamily = 'diagram' | 'chart' | 'explorable' | 'mechanism' | 'scene' | 'type' | 'plain' | 'pixels' | 'paint' | 'motion' | 'open';

/**
 * Which set a battery file is, by who may see it.
 * `tune`: anyone, including the improvement loop's critic and builder; failures here are what they read.
 * `tune-b`: v2's held-out set (`explore/tune-b.json`), read by people and by the prompt's authors since v2: a second tune set, never a held-out one.
 * `heldout`: v2.1's, written fresh by a writer that had read neither the seeds nor the tune sets, and kept outside the repository (`BATTERY_SEALED_DIR`).
 *   It decides whether an experiment is kept. The critic and the builder never see its prompts, its answers or its stills, only its scores.
 * `vault`: kept outside the repository by the steward and run rarely, to catch a system that has learned the held-out set by being selected on it.
 */
export type ExplorePool = 'tune' | 'tune-b' | 'heldout' | 'vault';

/** The teachings of the prompt a run can set side by side (`PROMPT_VARIANT`). One exists; see `PromptVariant`. */
export type ExploreVariant = PromptVariant;
export const EXPLORE_VARIANTS: readonly ExploreVariant[] = PROMPT_VARIANTS;

export interface ExplorePrompt {
  /** short and stable: file names and URLs are built from it */
  readonly id: string;
  /** the candidate use this prompt stands for, in a few words */
  readonly useCase: string;
  readonly prompt: string;
  readonly expects: ExploreExpectation;
  /** when true the runner also asks a plain-English model the same thing, to compare substance and cost */
  readonly baseline: boolean;
  /** true when no worked example in the system prompt is of this kind: a fair test of what the language teaches rather than of what it recites */
  readonly heldOut?: boolean;
  /** an explanation or a diagram: the prompts `--variant column,hero` compares, and the ones held to the baseline's substance */
  readonly information?: boolean;
  /** how long the prompt asks the answer to play, when it says; the answer should come within about a third of it */
  readonly statedSeconds?: number;
  /** how many lines about the medium itself are tolerated (the open invitation may say one thing); default 0 */
  readonly mayDescribeMedium?: number;
  /** the family its scores are added up under; absent: worked out from `expects` */
  readonly family?: ExploreFamily;
  /** the structure a good answer names, when the prompt has an obvious one: the check is that it was named, and that nothing was placed by coordinates in its stead */
  readonly structure?: StructureKind;
  /** the least number of controls a good answer hands over (an `explorable` prompt: at least 1) */
  readonly controls?: number;
  /** true when the first draft is expected to need a look: a free drawing with many labelled parts. The run reports the judge's score before and after the look. */
  readonly needsLook?: boolean;
}

/** One step of a scripted conversation. */
export type ExploreCaseTurn =
  | {
      readonly do: 'prompt';
      readonly text: string;
      /** before this turn the viewer switches to this look */
      readonly look?: LookId;
      /** before this turn the window changes to this size */
      readonly screen?: 'phone' | 'desktop';
      /** the viewer cuts this answer off this many ms after its first line, by speaking again */
      readonly interruptAfterMs?: number;
    }
  /** the viewer taps the first choice the previous answer left on stage */
  | { readonly do: 'tap' }
  /** the viewer says: look at what you drew and fix it. The brain gets the sight report and the picture of the stage. */
  | { readonly do: 'fix'; readonly text?: string }
  /**
   * The viewer works a control the previous answer left on stage: the first one, or the one with this id. `to` is where it is put:
   * a slider to its `min`, `mid` or `max`; a toggle is `flip`ped; a pick goes to its `next` option. No turn opens unless the control sends.
   * The run records the still before and after, whether pixels changed, and the `control` back event.
   */
  | { readonly do: 'control'; readonly id?: string; readonly to: 'min' | 'mid' | 'max' | 'flip' | 'next' }
  /** the viewer presses the first button the previous answer left on stage: a turn opens with an `act` input carrying every control's value */
  | { readonly do: 'press'; readonly id?: string };

export interface ExploreCase {
  readonly id: string;
  readonly useCase: string;
  /** what this conversation exists to catch */
  readonly why: string;
  readonly turns: readonly ExploreCaseTurn[];
  readonly heldOut?: boolean;
  /** the answer the judge scores, and the prompt it is told was asked; for a fix case the first and the last answer are both judged */
  readonly judged?: boolean;
}

export interface ExploreBattery {
  readonly version: number;
  /** which set this file is; absent means `tune` */
  readonly pool?: ExplorePool;
  readonly prompts: readonly ExplorePrompt[];
  readonly cases?: readonly ExploreCase[];
}

export interface ExploreUsage {
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly inputTokens: number | null;
  readonly costUsd: number | null;
}

/** What can be told about an answer without looking at it. The review page shows these; a person or a model judges the rest. */
export interface ExploreChecks {
  readonly lines: number;
  readonly rejects: number;
  readonly warnings: number;
  /** elements put on stage, by kind */
  readonly kinds: Readonly<Partial<Record<ElementKind, number>>>;
  /** words of text shown */
  readonly words: number;
  readonly scenes: number;
  readonly cameraMoves: number;
  /** layers other than `mid` that hold something */
  readonly depthLayers: number;
  /** share of lines that use an exact value (`@N`, `dur=`, `over=`, `stay=Ns`) */
  readonly handLevel: number;
  /** text that talks about the stage, the medium or the act of drawing instead of answering */
  readonly aboutTheMedium: readonly string[];
  /** seconds the answer takes to play */
  readonly playSeconds: number;
  /** did it do what the prompt was fishing for, as far as counting can tell */
  readonly meetsExpectation: boolean;
  /** the verb of the first line, null when there was none */
  readonly opening?: string | null;
  /** shapes drawn */
  readonly shapes?: number;
  /** text placed against something or inside a group (`near=`, `group=`, `at=`): a label, not a line of the flow */
  readonly labels?: number;
  /** the median, over scenes that are not `page`, of in-flow text lines in a scene; null when there is no such scene */
  readonly inFlowMedian?: number | null;
  /** distinct frames of the sprites drawn (the most any one sprite has) */
  readonly spriteFrames?: number;
  /** structures named, by kind */
  readonly structures?: Readonly<Partial<Record<StructureKind, number>>>;
  /** nodes and rows written inside structures */
  readonly parts?: number;
  /** controls put on stage, and how many of them a `bind` or a `{…}` follows */
  readonly controls?: number;
  readonly bound?: number;
  /** for a chart: its kind, how many points and series it has, how many marks, and what `chartModelOf` found wrong with its rows */
  readonly chart?: { readonly kind: ChartKind; readonly points: number; readonly series: number; readonly marks: number; readonly approx: boolean; /** its points come by reference (`data=`), not as its own rows */ readonly data: boolean; readonly problems: readonly string[] } | null;
  /** labels with a leader line (`callout`) */
  readonly callouts?: number;
  /** text placed at a canvas point (`at=x,y`) outside a structure: what a blind writer gets wrong, and what structures and callouts are meant to replace */
  readonly placedByHand?: number;
}

/**
 * What the battery counted on the composed resting stage, with no model in the loop: geometry a judge cannot be talked out of.
 * v2.1: counted by the battery's own code (`web/src/explore/geometry.ts`) from the placed boxes, the drawn routes of the connectors and,
 * when the painter publishes one, its stage plan; never from the painter's own notes about itself (those stay in `notes`).
 */
export interface ExploreGeometry {
  /** pairs of resting boxes that overlap where one of them holds words: free text, a node, a row, a control, a chart's or a structure's own words, against any other such box */
  readonly textOverlaps: number;
  /** resting labels a connector's drawn route (or any other stroke the engine reports) runs through */
  readonly crossedLabels: number;
  /** connectors whose drawn route passes through a node that is not one of their ends */
  readonly linksThroughNodes: number;
  /** resting things with any part outside the safe frame (the painter's own note: reported, not barred) */
  readonly clipped: number;
  /** the sight notes of the final stage, counted */
  readonly notes: Readonly<Partial<Record<SightNote, number>>>;
  /** v2.1. Resting things with any part outside the picture's canvas, or outside the screen, counted from their boxes */
  readonly outside?: number;
  /** v2.1. Things that stand outside the room the stage plan gave them (0 until the painter publishes a plan: see `planned`) */
  readonly outsideRoom?: number;
  /** v2.1. Whether a stage plan was audited. Without one `outsideRoom` is not a measurement */
  readonly planned?: boolean;
  /** v2.1. Connectors the structure engine did not route: not audited, never guessed at from a straight line, and said */
  readonly unrouted?: number;
  /** v2.1. Which pairs overlapped, `idA | idB`, at most twelve: for the card and for a person to open the picture and see */
  readonly pairs?: readonly string[];
  /** v2.1. The look and the screen the stage was laid out for; absent: the look the answer chose and the reference screen */
  readonly look?: LookId;
  readonly screen?: string;
  /** v2.1. On a follow-up that keeps the scene: elements carried from the stage before, and how many of them moved or entered again at time zero */
  readonly carried?: { readonly kept: number; readonly moved: number };
}

/** One chart as the battery measured it on the resting stage (quality bar, row 9). A null is "not measurable here", never a pass. */
export interface ChartStageCheck {
  readonly id: string;
  /** the type size its theme asks for, CSS pixels, and the stage's own `xs` at the same scale */
  readonly fontPx: number | null;
  readonly xsPx: number | null;
  /** problems found in the ticks as the engine wrote them: not a number, not in order, not evenly spaced, repeated */
  readonly tickProblems: readonly string[];
  /** the share of the chart's room the plot takes, 0..1 */
  readonly plotShare: number | null;
}

/**
 * How look-and-fix went for one answer in a run: what was decided and why, what it cost, and whether the picture got better.
 * `result` is the conductor's own word; `refused` is what v2.1's true revision says of a fix tried out of sight and not shown.
 */
export interface ExploreReview extends Omit<ReviewOutcome, 'result'> {
  readonly result: ReviewOutcome['result'] | 'refused';
  /** v2.1. The fix opened a scene (a redraw): a fix is a diff and must not */
  readonly openedScene?: boolean;
  /** v2.1. The fix, as shown, took away content the draft had (`fixKeeps` says no) */
  readonly tookAway?: boolean;
  /** v2.1. A refused fix changed the stage all the same */
  readonly refusedChanged?: boolean;
  /** from the end of the draft to the first line of the fix; null when there was no fix */
  readonly firstLineMs: number | null;
  /** how much longer the viewer waited because of the look: the end of the last pass against the end of the draft's own playing; never below 0 */
  readonly addedWaitMs: number;
  /** the judge's coherence for the draft alone and for the answer as it ended, from one call that was shown both in an order it was not told; null where the judge did not run */
  readonly before: number | null;
  readonly after: number | null;
  readonly costUsd: number | null;
  /** small JPEG data URLs of the draft as the painter pictured it before the fix, for the review page to set beside the final picture; the judge's first score is `before` */
  readonly draftStills?: readonly string[];
}

/** What happened when the run worked an answer's controls. */
export interface ExploreDrive {
  /** one entry per chart worked: hovered at its middle, then zoomed */
  readonly charts?: readonly {
    readonly id: string;
    /** the crosshair showed a value, formatted as the data was written (the chart engine's own `probe`) */
    readonly crosshair: boolean;
    /** zooming changed the visible range */
    readonly zoomed: boolean;
    /** neither hovering nor zooming opened a turn or sent a `control` event */
    readonly silent: boolean;
    /** v2.1. What the stage showed of the chart: type size, ticks, the plot's share of its room */
    readonly stage?: ChartStageCheck;
  }[];
  /** one entry per control worked */
  readonly controls: readonly {
    readonly id: string;
    readonly kind: ControlKind;
    /** something on stage follows it */
    readonly bound: boolean;
    /** the share of the picture's pixels that differ between its two ends (a slider's min and max, a toggle's off and on), outside the boxes of the controls themselves (v2.1); null for a button */
    readonly changed: number | null;
    /** v2.1. The share that differs inside the controls' own boxes: what the knob and its value did. Reported, never counted as the picture responding */
    readonly ownChanged?: number | null;
    /** a `control` back event with this id and the value set was recorded */
    readonly reported: boolean;
    /** for a button or a control that sends: a turn opened with an `act` input and was answered */
    readonly answered: boolean | null;
  }[];
}

export interface ExploreBaseline {
  readonly text: string;
  readonly words: number;
  readonly totalMs: number;
  readonly usage: ExploreUsage;
  /** from the request to the first character of the plain answer */
  readonly firstTextMs?: number | null;
}

/** The judge's reading of the final picture: a model that was shown the still and the prompt. */
export interface ExploreJudgement {
  readonly model: string;
  /** does the picture show what was asked */
  readonly asked: boolean;
  /** text that cannot be read or lies over other text; null when none */
  readonly textProblem: string | null;
  /** a label that points at the wrong thing; null when none */
  readonly wrongLabel: string | null;
  /** is the drawing right, factually and visually */
  readonly correct: boolean;
  /** what is wrong with it; null when nothing */
  readonly mistake: string | null;
  /** 1 (does not hold together) to 5 (reads as one composed picture) */
  readonly coherence: number;
  readonly why: string;
  readonly costUsd: number | null;
  readonly ms: number;
  /** the pictures the judge saw, small JPEG data URLs: the last one is the final still */
  readonly stills: readonly string[];
  /**
   * For an answer with controls, when the judge was shown the stage with a control at each end: does the picture change with
   * the control in the way the request needs (the right thing moves, in the right direction)? Null when it was not asked.
   */
  readonly responds?: boolean | null;
  /** one sentence on what changes between the pictures, or what should have and did not */
  readonly respondsWhy?: string | null;
  /**
   * For a chart: how it stands against a professional charting product, 1 (clip art: a picture of a chart) to 5 (could be a
   * screenshot of a trading terminal or a newspaper's data desk): axes with sensibly formatted ticks, gridlines that recede,
   * series told apart, a legend when there is more than one, units, nothing overlapping, nothing decorative. Null when the
   * answer was not a chart.
   */
  readonly chartQuality?: number | null;
  readonly chartWhy?: string | null;
  /** v2.1. The owner's "wrong": the picture, taken as an answer to the request, says or shows something untrue or answers another question, however neatly it is drawn. A sentence, or null */
  readonly wrong?: string | null;
  /** v2.1. The owner's "boring": the timid default where the request invited something; true when it is */
  readonly boring?: boolean;
  /** a hash of the judge's instructions and model: two scores are comparable only when it is the same */
  readonly rubric?: string;
  /** set when the judge could not give a verdict; every other field is then neutral */
  readonly failure: string | null;
}

export interface ExploreVerdict {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What a turn of a conversation was and how the brain was spoken to. Set on every turn of a case. */
export interface ExploreTurnMeta {
  readonly case: string;
  /** 1-based */
  readonly index: number;
  readonly kind: 'prompt' | 'tap' | 'fix' | 'act';
  readonly said: string;
  /** `since`: the process still held the conversation. `full`: it was told everything. null when the brain does not say. */
  readonly form: BriefForm | 'script' | null;
  /** share of input tokens read from the prompt cache, 0..1 */
  readonly cacheReadShare: number | null;
  /** the brief carried a picture of the stage */
  readonly withSnapshot: boolean;
  /** this answer was cut off at this many ms by the next turn; null when it ran to its end */
  readonly interruptedAtMs: number | null;
  /** what changed in the viewer's window before this turn */
  readonly changed: string | null;
  /** why this turn could not be played as scripted (no choice to tap); null when it was */
  readonly problem: string | null;
}

/** One answer of one prompt, with everything needed to replay it in a browser without a brain. */
export interface ExploreResult {
  readonly prompt: ExplorePrompt;
  /** canonical lines in arrival order, with the milliseconds since the request at which each was complete */
  readonly lines: readonly { readonly seq: number; readonly text: string; readonly ms: number; readonly issues: readonly Issue[] }[];
  readonly rejects: readonly { readonly raw: string; readonly ms: number; readonly issues: readonly Issue[] }[];
  readonly end: TurnEndReason;
  readonly message: string | null;
  /** from the request to the first line that puts something on stage; null when nothing was */
  readonly firstVisibleMs: number | null;
  readonly totalMs: number;
  readonly usage: ExploreUsage | null;
  readonly checks: ExploreChecks;
  readonly baseline: ExploreBaseline | null;
  /** the prompt variant the brain was taught with; absent in runs from before variants */
  readonly variant?: ExploreVariant;
  /** 1-based sample number of this prompt and variant */
  readonly sample?: number;
  /** from the request to the first character of text, as the brain measured it */
  readonly firstTextMs?: number | null;
  /** what the viewer waits for at reading speed: the later of the last line arriving and the answer finishing playing from its first line */
  readonly viewerWaitMs?: number | null;
  /** the stage this answer started from; absent means an empty stage */
  readonly base?: StageBase;
  readonly turn?: ExploreTurnMeta;
  readonly judge?: ExploreJudgement | null;
  readonly verdicts?: readonly ExploreVerdict[];
  /** what the painter measured about the final stage */
  readonly geometry?: ExploreGeometry;
  /** how look-and-fix went; absent when the run had it off */
  readonly review?: ExploreReview;
  /** what happened when the run worked the answer's controls; absent when it left none */
  readonly drive?: ExploreDrive;
  /** the ids of the techniques the brief carried */
  readonly techniques?: readonly string[];
}

/** A scripted conversation, played once: its turns in order, each a full result that starts from the stage the one before left. */
export interface ExploreCaseResult {
  readonly case: ExploreCase;
  readonly variant: ExploreVariant;
  readonly sample: number;
  readonly turns: readonly ExploreResult[];
  /** for a case with a `fix` turn: did the second look score higher than the first */
  readonly fix?: { readonly before: number | null; readonly after: number | null; readonly improved: boolean | null } | null;
  /** checks of the whole conversation, with the same shape as a prompt's verdicts */
  readonly verdicts: readonly ExploreVerdict[];
}

/** One line of the run's index: a file (prompt id, `<id>_<variant>_s<n>`). */
export interface ExploreIndexEntry {
  /** the file stem under the run's folder; what `API.exploreResult` is asked for */
  readonly id: string;
  readonly useCase: string;
  readonly end: TurnEndReason;
  readonly meetsExpectation: boolean;
  /** the prompt or the case this is an answer to; absent in runs from before samples */
  readonly promptId?: string;
  readonly kind?: 'prompt' | 'case';
  readonly variant?: ExploreVariant;
  readonly sample?: number;
  readonly heldOut?: boolean;
  /** verdicts that failed, by label (including the judge's); lets the index show pass rates without reading every file */
  readonly failed?: readonly string[];
  readonly checked?: readonly string[];
  readonly costUsd?: number | null;
}

/** The index of one run of the battery. */
export interface ExploreRun {
  /** `YYYYMMDD-HHMMSS-<brain>`, also the folder name under `explore/runs/` */
  readonly id: string;
  readonly started: string;
  readonly brain: string;
  readonly model: string | null;
  readonly language: number;
  /** characters in the system prompt the brain was given */
  readonly promptChars: number;
  readonly prompts: readonly ExploreIndexEntry[];
  readonly samples?: number;
  readonly variants?: readonly ExploreVariant[];
  readonly judgeModel?: string | null;
  /** which set this run played, and the file it was read from (relative to the repository) */
  readonly pool?: ExplorePool;
  readonly battery?: string;
  /** the hash of the judge's instructions and model: scores of two runs are comparable only when it is the same */
  readonly rubric?: string | null;
  /** v2.1. `battery`, `shipped` or `replay`: which brain the run was made with, and the window it was laid out for */
  readonly configuration?: 'battery' | 'shipped' | 'replay';
  readonly effort?: string | null;
  readonly screen?: string;
  /** what the run was projected to cost before it began, and what it did */
  readonly projection?: { readonly calls: number; readonly usd: number | null } | null;
  readonly spentUsd?: number | null;
  /** what one call of each kind cost on average in this run: the next run's projection starts from these */
  readonly measured?: { readonly firstTurnUsd: number | null; readonly laterTurnUsd: number | null; readonly judgeUsd: number | null; readonly baselineUsd: number | null } | null;
}

// -- verdicts ---------------------------------------------------------------

const TOKEN_FLAG = 1500;
const FIRST_LINE_BAR_MS = 4000;
/** the least a chart's labels may be set in, CSS pixels (D10); the least share of its room its plot may take (row 9) */
export const MIN_CHART_PX = 11;
export const MIN_PLOT_SHARE = 0.6;
/** the share of a picture's pixels that must differ, outside the controls' own boxes, for a control to have changed the picture (P2-19) */
export const CHANGE_FLOOR = 0.003;

/** Whether the prompt asked for a stated length and the answer kept to it, within a third (and never off by less than two seconds). */
function keptDuration(prompt: ExplorePrompt, played: number): { ok: boolean; detail: string } | null {
  if (prompt.statedSeconds === undefined) return null;
  const slack = Math.max(2, prompt.statedSeconds / 3);
  return {
    ok: Math.abs(played - prompt.statedSeconds) <= slack,
    detail: `asked for ${prompt.statedSeconds} s, plays for ${played.toFixed(1)} s`,
  };
}

/** Every automatic check, then the judge's, for one answer. Failed ones first. */
export function verdictsOf(result: ExploreResult): ExploreVerdict[] {
  const { checks, prompt } = result;
  const opening = checks.opening ?? null;
  const out: ExploreVerdict[] = [
    { label: 'meets expectation', ok: checks.meetsExpectation, detail: `the prompt expects: ${prompt.expects}` },
    { label: 'finished', ok: result.end === 'done' || result.turn?.interruptedAtMs != null, detail: result.end + (result.message === null ? '' : `: ${result.message}`) },
    { label: 'no rejected line', ok: result.rejects.length === 0, detail: `${result.rejects.length} rejected, ${checks.warnings} warnings` },
    {
      label: 'silent about the medium',
      ok: checks.aboutTheMedium.length <= (prompt.mayDescribeMedium ?? 0),
      detail: checks.aboutTheMedium.length === 0 ? 'nothing' : checks.aboutTheMedium.join(' / '),
    },
    { label: 'few exact times', ok: checks.handLevel < 0.1, detail: `${Math.round(checks.handLevel * 100)}% of lines` },
  ];
  // A later turn of a conversation may go on from what is on stage with a plain `set` or `revise`.
  if (result.turn === undefined || result.turn.index === 1) {
    out.push({ label: 'starts with look or scene', ok: opening === 'look' || opening === 'scene', detail: opening === null ? 'no lines' : `starts with ${opening}` });
  }
  if (result.firstVisibleMs !== null) {
    out.push({ label: 'first line within 4 s', ok: result.firstVisibleMs <= FIRST_LINE_BAR_MS, detail: `${(result.firstVisibleMs / 1000).toFixed(1)} s` });
  }
  if (prompt.information === true && checks.labels !== undefined) out.push({ label: 'diagram has two labels', ok: checks.labels >= 2, detail: `${checks.labels} labels, ${checks.shapes ?? 0} shapes` });
  const inFlow = checks.inFlowMedian ?? null;
  if (inFlow !== null) out.push({ label: 'four in-flow lines or fewer', ok: inFlow <= 4, detail: `median ${inFlow} in a scene` });
  const kept = keptDuration(prompt, checks.playSeconds);
  if (kept !== null) out.push({ label: 'stated length kept', ok: kept.ok, detail: kept.detail });
  const tokens = result.usage?.outputTokens ?? null;
  if (tokens !== null) {
    const base = result.baseline?.usage.outputTokens ?? null;
    if (prompt.expects === 'plain' && base !== null && base > 0) {
      out.push({ label: 'within 1.3x the plain answer', ok: tokens <= base * 1.3, detail: `${tokens} against ${base} tokens` });
    } else if (prompt.baseline && base !== null && base > 0) {
      out.push({ label: 'within 2x the plain answer', ok: tokens <= base * 2, detail: `${tokens} against ${base} tokens` });
    } else {
      out.push({ label: `under ${TOKEN_FLAG} tokens`, ok: tokens <= TOKEN_FLAG, detail: `${tokens} output tokens` });
    }
  }
  const turn = result.turn;
  if (turn !== undefined && turn.index > 1) {
    if (turn.form !== null) out.push({ label: 'warm (brief was since)', ok: turn.form === 'since', detail: `form ${turn.form}` });
    if (turn.cacheReadShare !== null) out.push({ label: 'cache reads over 80%', ok: turn.cacheReadShare > 0.8, detail: `${Math.round(turn.cacheReadShare * 100)}%` });
    if (turn.problem !== null) out.push({ label: 'turn could be played', ok: false, detail: turn.problem });
  }
  // Structures: named when the prompt has an obvious one, and nothing placed by hand in its stead.
  if (prompt.structure !== undefined) {
    const named = (checks.structures?.[prompt.structure] ?? 0) > 0;
    const byHand = checks.placedByHand ?? 0;
    out.push({ label: 'structure named, nothing placed by hand', ok: named && byHand === 0, detail: `${prompt.structure}: ${named ? 'named' : 'not named'}, ${byHand} placed by coordinates` });
  }
  const geometry = result.geometry;
  if (geometry !== undefined && Object.keys(checks.structures ?? {}).length > 0) {
    // Counted by the battery from the composed stage (row 4), not by the painter about itself.
    out.push(
      { label: 'stage: no text over other text, a chart, a structure or a control', ok: geometry.textOverlaps === 0, detail: geometry.textOverlaps === 0 ? 'none' : `${geometry.textOverlaps}: ${(geometry.pairs ?? []).slice(0, 4).join('; ')}` },
      { label: 'stage: no connector through a node', ok: geometry.linksThroughNodes === 0, detail: `${geometry.linksThroughNodes}` },
      { label: 'stage: no label crossed', ok: geometry.crossedLabels === 0, detail: `${geometry.crossedLabels}` },
    );
    if (geometry.outside !== undefined) out.push({ label: 'stage: nothing outside the screen or its room', ok: geometry.outside === 0 && (geometry.outsideRoom ?? 0) === 0, detail: `${geometry.outside} outside${geometry.planned === true ? `, ${geometry.outsideRoom ?? 0} outside their rooms` : ''}` });
  }
  if (checks.chart != null) {
    out.push({ label: 'chart: approx when it has no DATA', ok: checks.chart.data || checks.chart.approx, detail: checks.chart.data ? 'draws DATA' : checks.chart.approx ? 'says approx' : 'its own numbers, not marked approx' });
    out.push({ label: 'chart: rows read cleanly', ok: checks.chart.problems.length === 0, detail: checks.chart.problems.join(' / ') || 'nothing wrong' });
    for (const stage of result.drive?.charts ?? []) {
      const seen = stage.stage;
      if (seen === undefined) continue;
      if (seen.fontPx !== null) out.push({ label: 'chart: label text at least 11 px and the stage’s xs', ok: seen.fontPx >= MIN_CHART_PX && (seen.xsPx === null || seen.fontPx >= seen.xsPx - 0.5), detail: `${seen.fontPx.toFixed(1)} px${seen.xsPx === null ? '' : ` against xs ${seen.xsPx.toFixed(1)}`}` });
      out.push({ label: 'chart: every tick label is its tick', ok: seen.tickProblems.length === 0, detail: seen.tickProblems.join(' / ') || 'nothing wrong' });
      if (seen.plotShare !== null) out.push({ label: 'chart: the plot fills at least 60% of its room', ok: seen.plotShare >= MIN_PLOT_SHARE, detail: `${Math.round(seen.plotShare * 100)}%` });
    }
  }
  const drive = result.drive;
  if (drive !== undefined) {
    for (const control of drive.controls) {
      out.push({ label: 'control: its event was sent', ok: control.reported, detail: `${control.kind} ${control.id}` });
      if (control.changed !== null) out.push({ label: 'control: the picture changes at its two ends', ok: control.changed > CHANGE_FLOOR, detail: `${control.id}: ${(control.changed * 100).toFixed(2)}% of pixels outside the controls${control.ownChanged == null ? '' : `, ${(control.ownChanged * 100).toFixed(2)}% on them`}` });
      if (control.answered !== null) out.push({ label: 'control: its turn was answered', ok: control.answered, detail: control.id });
    }
    for (const chart of drive.charts ?? []) {
      out.push({ label: 'chart: crosshair shows a formatted value', ok: chart.crosshair, detail: chart.id }, { label: 'chart: zoom changes the range', ok: chart.zoomed, detail: chart.id }, { label: 'chart: reading opens no turn', ok: chart.silent, detail: chart.id });
    }
  }
  const judge = result.judge ?? null;
  if (judge !== null && judge.failure === null && judge.responds != null) out.push({ label: 'judge: the picture responds', ok: judge.responds, detail: judge.respondsWhy ?? '' });
  if (judge !== null && judge.failure === null && judge.chartQuality != null) out.push({ label: 'judge: chart quality 3 or more', ok: judge.chartQuality >= 3, detail: `${judge.chartQuality} of 5: ${judge.chartWhy ?? ''}` });
  if (judge !== null && judge.failure === null) {
    out.push(
      { label: 'judge: shows what was asked', ok: judge.asked, detail: judge.asked ? 'it does' : judge.why },
      { label: 'judge: text readable', ok: judge.textProblem === null, detail: judge.textProblem ?? 'nothing wrong' },
      { label: 'judge: labels point right', ok: judge.wrongLabel === null, detail: judge.wrongLabel ?? 'nothing wrong' },
      { label: 'judge: drawing correct', ok: judge.correct, detail: judge.mistake ?? 'nothing wrong' },
      { label: 'judge: coherence 4 or more', ok: judge.coherence >= 4, detail: `${judge.coherence} of 5: ${judge.why}` },
    );
    if (judge.wrong !== undefined) out.push({ label: 'judge: not wrong', ok: judge.wrong === null, detail: judge.wrong ?? 'nothing wrong' });
    if (judge.boring !== undefined) out.push({ label: 'judge: not boring', ok: !judge.boring, detail: judge.boring ? 'the timid default' : 'it has an idea of its own' });
  }
  const review = result.review;
  if (review !== undefined) {
    if (review.openedScene === true) out.push({ label: 'look: a fix opens no scene', ok: false, detail: 'the fix redrew the answer' });
    if (review.tookAway === true) out.push({ label: 'look: a fix shown takes nothing away', ok: false, detail: 'it took content the draft had' });
    if (review.refusedChanged === true) out.push({ label: 'look: a refused fix changes nothing', ok: false, detail: 'the stage changed all the same' });
  }
  return out.sort((a, b) => Number(a.ok) - Number(b.ok));
}

/** Pass counts per check label over a set of verdict lists (the samples of one prompt and variant). */
export function passRates(sets: readonly (readonly ExploreVerdict[])[]): { label: string; passed: number; of: number }[] {
  const order: string[] = [];
  const tally = new Map<string, { passed: number; of: number }>();
  for (const verdicts of sets) {
    for (const verdict of verdicts) {
      let entry = tally.get(verdict.label);
      if (entry === undefined) {
        entry = { passed: 0, of: 0 };
        tally.set(verdict.label, entry);
        order.push(verdict.label);
      }
      entry.of += 1;
      if (verdict.ok) entry.passed += 1;
    }
  }
  return order.map((label) => ({ label, ...(tally.get(label) ?? { passed: 0, of: 0 }) }));
}

/** The time the viewer waits at reading speed. Lines arrive as `lineMs`; the answer plays for `playSeconds` from its first. */
export function viewerWaitOf(firstLineMs: number | null, lastLineMs: number | null, playSeconds: number): number | null {
  if (firstLineMs === null || lastLineMs === null) return null;
  return Math.round(Math.max(lastLineMs, firstLineMs + playSeconds * 1000));
}


// -- families and the summary the loop reads ---------------------------------

/**
 * The family a prompt's scores are added up under: what the prompt says it is (P2-18). Never guessed from `expects`: that put a free drawing,
 * an ad and a chart in "diagram" and "mechanism". A prompt with no family is `open`, and the runner refuses a battery that has one
 * (`unfiled`), so a file cannot be read the way it was not written.
 */
export function familyOf(prompt: ExplorePrompt): ExploreFamily {
  return prompt.family ?? 'open';
}

/** The prompts of a battery that name no family. A battery with any is not run. */
export function unfiled(prompts: readonly ExplorePrompt[]): readonly string[] {
  return prompts.filter((prompt) => prompt.family === undefined).map((prompt) => prompt.id);
}

/**
 * One measure: a share (0..1) or a mean over `n` answers, with its standard error. The unit of the error is the prompt, not the answer: the
 * samples of one prompt are not independent of each other, so a family of eight prompts at three samples is eight observations, not twenty-four.
 * Null where nothing could be measured (a family with nothing judged is absent, never zero), and `se` is null where there is no spread to read
 * (one prompt, one answer).
 */
export interface Measure {
  readonly value: number | null;
  readonly n: number;
  readonly se: number | null;
}

/** One reading and the prompt it came from. */
export interface Reading {
  readonly group: string;
  readonly x: number;
}

const NO_MEASURE: Measure = { value: null, n: 0, se: null };

/** The mean of the readings, its standard error over prompts (the mean of each prompt's own readings), and n. */
export function meanOf(readings: readonly Reading[]): Measure {
  if (readings.length === 0) return NO_MEASURE;
  const total = readings.reduce((sum, reading) => sum + reading.x, 0);
  const value = total / readings.length;
  const groups = new Map<string, number[]>();
  for (const reading of readings) groups.set(reading.group, [...(groups.get(reading.group) ?? []), reading.x]);
  const means = [...groups.values()].map((values) => values.reduce((a, b) => a + b, 0) / values.length);
  if (means.length < 2) {
    // One prompt: the spread of its own samples, when it has more than one.
    if (readings.length < 2) return { value, n: readings.length, se: null };
    const spread = Math.sqrt(readings.reduce((sum, reading) => sum + (reading.x - value) ** 2, 0) / (readings.length - 1));
    return { value, n: readings.length, se: spread / Math.sqrt(readings.length) };
  }
  const centre = means.reduce((a, b) => a + b, 0) / means.length;
  const spread = Math.sqrt(means.reduce((sum, mean) => sum + (mean - centre) ** 2, 0) / (means.length - 1));
  return { value, n: readings.length, se: spread / Math.sqrt(means.length) };
}

/** A share of passes, as a measure. At the edges (all pass, none pass) the error is the adjusted-Wald one, so that a clean sheet of three is not "certain". */
export function shareOf(flags: readonly { readonly group: string; readonly ok: boolean }[]): Measure {
  if (flags.length === 0) return NO_MEASURE;
  const readings = flags.map((flag) => ({ group: flag.group, x: flag.ok ? 1 : 0 }));
  const measured = meanOf(readings);
  const passes = readings.reduce((sum, reading) => sum + reading.x, 0);
  const adjusted = (passes + 2) / (flags.length + 4);
  const wald = Math.sqrt((adjusted * (1 - adjusted)) / (flags.length + 4));
  return { value: measured.value, n: flags.length, se: measured.se === null ? wald : Math.max(measured.se, wald) };
}

/** A count over the answers: `n` is how many answers were counted. */
export interface Count {
  readonly total: number;
  readonly n: number;
}

/** What a family's answers came to, in the terms of the quality bar (PLAN-v2.1.md section 3). Each field names its row. */
export interface FamilyScore {
  readonly family: ExploreFamily;
  /** answers (samples of prompts, and the turns of cases that are single answers) */
  readonly answers: number;
  readonly judged: number;
  /** rows 1, 6, 26, 27: the judge's coherence */
  readonly coherence: Measure;
  /** row 1: share scoring 4 or more */
  readonly coherenceFour: Measure;
  /** row 2 */
  readonly textReadable: Measure;
  readonly labelsRight: Measure;
  /** row 3 */
  readonly drawingCorrect: Measure;
  /** row 5: of the prompts that name a structure */
  readonly structureNamed: Measure;
  /** row 7 */
  readonly chartQuality: Measure;
  readonly chartQualityLowest: number | null;
  /** row 9: of charts, the share whose every measured check passed (below), `approx` when there is no DATA, rows read cleanly */
  readonly chartHygiene: Measure;
  readonly chartFont: Measure;
  readonly chartTicks: Measure;
  readonly chartPlot: Measure;
  readonly chartApprox: Measure;
  /** rows 15 to 17: every control worked sends its event; a slider, a pick and a toggle each change the picture beyond their own redraw */
  readonly controlEvents: Measure;
  readonly sliderChanges: Measure;
  readonly pickChanges: Measure;
  readonly toggleChanges: Measure;
  readonly responds: Measure;
  /** row 10 of v2 */
  readonly chartRead: Measure;
  /** row 4, counted over every answer that has geometry: totals, which must all be 0 */
  readonly overlaps: number;
  readonly throughNodes: number;
  readonly crossed: number;
  /** row 5: things outside the screen or the room the plan gave them */
  readonly outside: number;
  /** row 11 (the look): the mean of the judge's gain over the draft on answers that were looked at (fixed, kept or refused: never skipped), and the share worse after */
  readonly lookGain: Measure;
  readonly lookWorse: Measure;
  /** row 11, apart: gain of the fixes that were shown; the shares of looked-at answers shown and refused */
  readonly lookShownGain: Measure;
  readonly lookShown: Measure;
  readonly lookRefused: Measure;
  /** row 10: of fixes shown, those that opened a scene and those that took something away; of refused fixes, those that changed the stage */
  readonly fixOpenedScene: Measure;
  readonly fixTookAway: Measure;
  readonly refusedChanged: Measure;
  /** row 12: milliseconds the look added to what the viewer waits, over answers that were looked at */
  readonly addedWait: { readonly median: number | null; readonly p90: number | null; readonly n: number };
  /** row 13 */
  readonly carryMoved: Count;
  /** row 25: the owner's "boring" and "wrong", as the judge reads them */
  readonly boring: Measure;
  readonly wrong: Measure;
  /** the cost of the family's answers */
  readonly cost: { readonly usd: number | null };
}

/** The numbers the improvement loop compares, with the bar's rows beside them. */
export interface FamilyLine {
  readonly n: number;
  /** mean judge coherence, 1 to 5 (0 when nothing was judged) */
  readonly coherence: number;
  /** v2.1. Its standard error over prompts; null when it has none to give */
  readonly coherenceSe?: number | null;
  /** shares of judged answers: the drawing is right, the text is readable, it shows what was asked */
  readonly correct: number;
  readonly readable: number;
  readonly asked: number;
  /** collisions per answer counted by the battery on the composed stage: text over anything, crossed labels, links through nodes */
  readonly collisions: number;
  /** medians: output tokens, ms to the first visible line */
  readonly tokens: number;
  readonly firstLineMs: number;
  readonly bar: FamilyScore;
}

/** What `pnpm explore` writes beside the run's index, and the loop reads: scores, never answers. */
export interface ExploreSummary {
  readonly run: string;
  readonly pool: ExplorePool;
  readonly battery: string;
  /** the judge's rubric hash; empty when the run had no judge */
  readonly rubric: string;
  readonly brain: string;
  readonly model: string | null;
  /** v2.1. `battery`: the battery's own brain (sonnet, effort low: comparable with v2). `shipped`: whatever the owner's `.env` says */
  readonly configuration?: 'battery' | 'shipped' | 'replay';
  readonly effort?: string | null;
  /** v2.1. The screen the answers were laid out and pictured for, `1280x720` */
  readonly screen?: string;
  readonly samples: number;
  readonly spentUsd: number | null;
  /** dollars the run spent, brain and judge */
  readonly usd: number;
  /** per family: the loop's own numbers (shape of `FamilyScore` in server/src/loop/types.ts) and, under `bar`, every row of the quality bar */
  readonly families: Readonly<Partial<Record<ExploreFamily, FamilyLine>>>;
  /** per prompt id, the mean coherence over its samples and how many checks failed: enough to say which prompts moved, and nothing the critic could learn an answer from */
  readonly prompts: readonly { readonly id: string; readonly family: ExploreFamily; readonly coherence: number | null; readonly failed: number; readonly checked: number; readonly samples?: number }[];
}

const group = (answer: ExploreResult): string => answer.prompt.id;

/** The middle value, or the share of the way through the sorted values asked for (`0.9` is the 90th percentile, nearest rank). */
export function quantile(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (share === 0.5) {
    const at = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[at] ?? null) : ((sorted[at - 1] ?? 0) + (sorted[at] ?? 0)) / 2;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? null;
}

/** The measures of the charts an answer's drive worked, at the stage. */
function chartStageOf(answer: ExploreResult): readonly ChartStageCheck[] {
  return (answer.drive?.charts ?? []).flatMap((chart) => (chart.stage === undefined ? [] : [chart.stage]));
}

function fontOk(stage: ChartStageCheck): boolean {
  return stage.fontPx !== null && stage.fontPx >= MIN_CHART_PX && (stage.xsPx === null || stage.fontPx >= stage.xsPx - 0.5);
}

/** The answers of one family, with the prompt each answers. Cases that fix an answer are counted by `lookGain` only. */
export function scoreFamily(family: ExploreFamily, answers: readonly ExploreResult[]): FamilyScore {
  const judged = answers.filter((answer) => answer.judge != null && answer.judge.failure === null);
  const withJudge = judged.map((answer) => ({ answer, judge: answer.judge as ExploreJudgement }));
  const charts = answers.filter((answer) => answer.checks.chart != null);
  const named = answers.filter((answer) => answer.prompt.structure !== undefined);
  const controls = answers.flatMap((answer) => (answer.drive?.controls ?? []).map((control) => ({ group: group(answer), control })));
  const geometries = answers.flatMap((answer) => (answer.geometry === undefined ? [] : [answer.geometry]));
  const sum = (pick: (g: ExploreGeometry) => number): number => geometries.reduce((total, g) => total + pick(g), 0);
  const costs = answers.flatMap((answer) => (answer.usage?.costUsd == null ? [] : [answer.usage.costUsd]));
  const looked = answers.flatMap((answer) => {
    const review = answer.review;
    return review !== undefined && review.result !== 'skipped' ? [{ answer, review, gain: review.before != null && review.after != null ? review.after - review.before : null }] : [];
  });
  const gains = looked.flatMap((entry) => (entry.gain === null ? [] : [{ ...entry, gain: entry.gain }]));
  const fixed = looked.filter((entry) => entry.review.result === 'fixed');
  const refused = looked.filter((entry) => entry.review.result === 'refused');
  const qualities = withJudge.flatMap(({ answer, judge }) => (judge.chartQuality == null ? [] : [{ group: group(answer), x: judge.chartQuality }]));
  const stages = charts.flatMap((answer) => chartStageOf(answer).map((stage) => ({ group: group(answer), stage })));
  const kindOf = (kind: ControlKind): readonly { readonly group: string; readonly ok: boolean }[] =>
    controls.flatMap(({ group: g, control }) => (control.kind === kind && control.changed !== null ? [{ group: g, ok: control.changed > CHANGE_FLOOR }] : []));
  return {
    family,
    answers: answers.length,
    judged: judged.length,
    coherence: meanOf(withJudge.map(({ answer, judge }) => ({ group: group(answer), x: judge.coherence }))),
    coherenceFour: shareOf(withJudge.map(({ answer, judge }) => ({ group: group(answer), ok: judge.coherence >= 4 }))),
    textReadable: shareOf(withJudge.map(({ answer, judge }) => ({ group: group(answer), ok: judge.textProblem === null }))),
    labelsRight: shareOf(withJudge.map(({ answer, judge }) => ({ group: group(answer), ok: judge.wrongLabel === null }))),
    drawingCorrect: shareOf(withJudge.map(({ answer, judge }) => ({ group: group(answer), ok: judge.correct }))),
    structureNamed: shareOf(named.map((answer) => ({ group: group(answer), ok: (answer.checks.structures?.[answer.prompt.structure as StructureKind] ?? 0) > 0 && (answer.checks.placedByHand ?? 0) === 0 }))),
    chartQuality: meanOf(qualities),
    chartQualityLowest: qualities.length === 0 ? null : Math.min(...qualities.map((reading) => reading.x)),
    chartHygiene: shareOf(
      charts.map((answer) => {
        const chart = answer.checks.chart;
        const measured = chartStageOf(answer);
        const ok =
          chart != null &&
          (chart.data || chart.approx) &&
          chart.problems.length === 0 &&
          measured.every((stage) => (stage.fontPx === null || fontOk(stage)) && stage.tickProblems.length === 0 && (stage.plotShare === null || stage.plotShare >= MIN_PLOT_SHARE));
        return { group: group(answer), ok };
      }),
    ),
    chartFont: shareOf(stages.filter(({ stage }) => stage.fontPx !== null).map(({ group: g, stage }) => ({ group: g, ok: fontOk(stage) }))),
    chartTicks: shareOf(stages.map(({ group: g, stage }) => ({ group: g, ok: stage.tickProblems.length === 0 }))),
    chartPlot: shareOf(stages.filter(({ stage }) => stage.plotShare !== null).map(({ group: g, stage }) => ({ group: g, ok: (stage.plotShare ?? 0) >= MIN_PLOT_SHARE }))),
    chartApprox: shareOf(charts.map((answer) => ({ group: group(answer), ok: answer.checks.chart != null && (answer.checks.chart.data || answer.checks.chart.approx) }))),
    controlEvents: shareOf(controls.map(({ group: g, control }) => ({ group: g, ok: control.reported && control.answered !== false }))),
    sliderChanges: shareOf(kindOf('slider')),
    pickChanges: shareOf(kindOf('pick')),
    toggleChanges: shareOf(kindOf('toggle')),
    responds: shareOf(withJudge.flatMap(({ answer, judge }) => (judge.responds == null ? [] : [{ group: group(answer), ok: judge.responds }]))),
    chartRead: shareOf(answers.flatMap((answer) => (answer.drive?.charts ?? []).map((chart) => ({ group: group(answer), ok: chart.crosshair && chart.zoomed && chart.silent })))),
    overlaps: sum((g) => g.textOverlaps),
    throughNodes: sum((g) => g.linksThroughNodes),
    crossed: sum((g) => g.crossedLabels),
    outside: sum((g) => (g.outside ?? 0) + (g.outsideRoom ?? 0)),
    lookGain: meanOf(gains.map((entry) => ({ group: group(entry.answer), x: entry.gain }))),
    lookWorse: shareOf(gains.map((entry) => ({ group: group(entry.answer), ok: entry.gain < 0 }))),
    lookShownGain: meanOf(gains.filter((entry) => entry.review.result === 'fixed').map((entry) => ({ group: group(entry.answer), x: entry.gain }))),
    lookShown: shareOf(looked.map((entry) => ({ group: group(entry.answer), ok: entry.review.result === 'fixed' }))),
    lookRefused: shareOf(looked.map((entry) => ({ group: group(entry.answer), ok: entry.review.result === 'refused' }))),
    fixOpenedScene: shareOf(fixed.map((entry) => ({ group: group(entry.answer), ok: entry.review.openedScene === true }))),
    fixTookAway: shareOf(fixed.map((entry) => ({ group: group(entry.answer), ok: entry.review.tookAway === true }))),
    refusedChanged: shareOf(refused.map((entry) => ({ group: group(entry.answer), ok: entry.review.refusedChanged === true }))),
    addedWait: {
      median: quantile(looked.map((entry) => entry.review.addedWaitMs), 0.5),
      p90: quantile(looked.map((entry) => entry.review.addedWaitMs), 0.9),
      n: looked.length,
    },
    carryMoved: { total: geometries.reduce((total, g) => total + (g.carried?.moved ?? 0), 0), n: geometries.filter((g) => g.carried !== undefined).length },
    boring: shareOf(withJudge.flatMap(({ answer, judge }) => (judge.boring === undefined ? [] : [{ group: group(answer), ok: judge.boring }]))),
    wrong: shareOf(withJudge.flatMap(({ answer, judge }) => (judge.wrong === undefined ? [] : [{ group: group(answer), ok: judge.wrong !== null }]))),
    cost: { usd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0) },
  };
}

/** The summary of a run, from its answers by prompt id. */
export function summaryOf(
  meta: Omit<ExploreSummary, 'families' | 'prompts' | 'usd'>,
  answers: readonly ExploreResult[],
): ExploreSummary {
  const byFamily = new Map<ExploreFamily, ExploreResult[]>();
  for (const answer of answers) {
    const family = familyOf(answer.prompt);
    byFamily.set(family, [...(byFamily.get(family) ?? []), answer]);
  }
  const families: Partial<Record<ExploreFamily, FamilyLine>> = {};
  for (const [family, members] of byFamily) {
    const bar = scoreFamily(family, members);
    const judges = members.flatMap((answer) => (answer.judge != null && answer.judge.failure === null ? [answer.judge] : []));
    families[family] = {
      n: members.length,
      coherence: bar.coherence.value ?? 0,
      coherenceSe: bar.coherence.se,
      correct: bar.drawingCorrect.value ?? 0,
      readable: bar.textReadable.value ?? 0,
      asked: judges.length === 0 ? 0 : judges.filter((j) => j.asked).length / judges.length,
      collisions: members.length === 0 ? 0 : (bar.overlaps + bar.throughNodes + bar.crossed) / members.length,
      tokens: quantile(members.flatMap((answer) => (answer.usage?.outputTokens == null ? [] : [answer.usage.outputTokens])), 0.5) ?? 0,
      firstLineMs: quantile(members.flatMap((answer) => (answer.firstVisibleMs === null ? [] : [answer.firstVisibleMs])), 0.5) ?? 0,
      bar,
    };
  }
  const byPrompt = new Map<string, ExploreResult[]>();
  for (const answer of answers) byPrompt.set(answer.prompt.id, [...(byPrompt.get(answer.prompt.id) ?? []), answer]);
  const prompts = [...byPrompt].map(([id, members]) => {
    const scores = members.flatMap((answer) => (answer.judge != null && answer.judge.failure === null ? [answer.judge.coherence] : []));
    const verdicts = members.flatMap((answer) => answer.verdicts ?? []);
    return { id, family: familyOf((members[0] as ExploreResult).prompt), coherence: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length, failed: verdicts.filter((v) => !v.ok).length, checked: verdicts.length, samples: members.length };
  });
  return { ...meta, usd: meta.spentUsd ?? 0, families, prompts };
}

// -- two runs, paired by prompt -----------------------------------------------

/** The mean difference between two runs of the same prompts, and its standard error over the prompts both have. */
export interface PairedDifference {
  readonly n: number;
  readonly mean: number | null;
  readonly se: number | null;
  /** the prompts that moved most, by id, biggest first: what to open */
  readonly moved: readonly { readonly id: string; readonly difference: number }[];
}

/**
 * The candidate against the baseline, prompt by prompt: only the prompts both runs scored count, each contributes the difference of its mean
 * coherence, and the error is the spread of those differences. A difference that does not clear its own error is not a difference (P1-11).
 * `family` narrows it to one family's prompts.
 */
export function pairedDifference(baseline: ExploreSummary, candidate: ExploreSummary, family: ExploreFamily | null = null): PairedDifference {
  const was = new Map(baseline.prompts.flatMap((prompt) => (prompt.coherence === null || (family !== null && prompt.family !== family) ? [] : [[prompt.id, prompt.coherence] as const])));
  const differences = candidate.prompts.flatMap((prompt) => {
    const before = was.get(prompt.id);
    return before === undefined || prompt.coherence === null || (family !== null && prompt.family !== family) ? [] : [{ id: prompt.id, difference: prompt.coherence - before }];
  });
  if (differences.length === 0) return { n: 0, mean: null, se: null, moved: [] };
  const mean = differences.reduce((sum, entry) => sum + entry.difference, 0) / differences.length;
  const se = differences.length < 2 ? null : Math.sqrt(differences.reduce((sum, entry) => sum + (entry.difference - mean) ** 2, 0) / (differences.length - 1) / differences.length);
  return { n: differences.length, mean, se, moved: [...differences].sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, 5) };
}

// -- the bar, row by row -------------------------------------------------------

/** One row of the quality bar as a run measured it. `met` follows the rule: a mean less one standard error clears the bar; a count of faults is exactly 0. Null: not measured. */
export interface BarRow {
  readonly row: number;
  readonly what: string;
  readonly family: ExploreFamily | 'all';
  readonly value: number | null;
  readonly se: number | null;
  readonly n: number;
  readonly bar: string;
  readonly met: boolean | null;
}

/** The mean of several measures, weighted by n; its error is the pooled one. Used where a row is over every family. */
function pooled(measures: readonly Measure[]): Measure {
  const used = measures.filter((measure) => measure.value !== null && measure.n > 0);
  const n = used.reduce((total, measure) => total + measure.n, 0);
  if (n === 0) return NO_MEASURE;
  const value = used.reduce((total, measure) => total + (measure.value ?? 0) * measure.n, 0) / n;
  const variance = used.reduce((total, measure) => total + ((measure.se ?? 0) * measure.n) ** 2, 0) / (n * n);
  return { value, n, se: used.every((measure) => measure.se === null) ? null : Math.sqrt(variance) };
}

function atLeast(measure: Measure, bar: number, row: number, what: string, family: ExploreFamily | 'all', text: string): BarRow {
  const met = measure.value === null ? null : measure.value - (measure.se ?? 0) >= bar;
  return { row, what, family, value: measure.value, se: measure.se, n: measure.n, bar: text, met };
}

function none(count: number, n: number, row: number, what: string, family: ExploreFamily | 'all'): BarRow {
  return { row, what, family, value: n === 0 ? null : count, se: null, n, bar: '0', met: n === 0 ? null : count === 0 };
}

/** The rows of section 3 that a run can fill from its own scores, by family, with n and error. A row the run could not measure says so (`met: null`). */
export function barRows(summary: ExploreSummary): readonly BarRow[] {
  const rows: BarRow[] = [];
  const diagram = summary.families.diagram?.bar;
  const mechanism = summary.families.mechanism?.bar;
  const chart = summary.families.chart?.bar;
  const explorable = summary.families.explorable?.bar;
  if (diagram !== undefined) {
    rows.push(
      atLeast(diagram.coherence, 3.8, 1, 'diagram: coherence', 'diagram', '3.8'),
      atLeast(diagram.coherenceFour, 0.6, 1, 'diagram: four or more', 'diagram', '60%'),
      atLeast(diagram.textReadable, 0.9, 2, 'diagram: text readable', 'diagram', '90%'),
      atLeast(diagram.labelsRight, 0.9, 2, 'diagram: labels point right', 'diagram', '90%'),
      atLeast(diagram.drawingCorrect, 0.7, 3, 'diagram: drawing correct', 'diagram', '70%'),
      atLeast(diagram.structureNamed, 0.9, 6, 'structure named when the prompt has one', 'diagram', '90%'),
    );
  }
  const all = Object.values(summary.families).map((line) => line.bar);
  const counted = all.reduce((total, bar) => total + bar.answers, 0);
  rows.push(
    none(all.reduce((total, bar) => total + bar.overlaps, 0), counted, 4, 'text over any other box (stage)', 'all'),
    none(all.reduce((total, bar) => total + bar.throughNodes, 0), counted, 4, 'connectors through nodes (routed)', 'all'),
    none(all.reduce((total, bar) => total + bar.crossed, 0), counted, 4, 'labels crossed', 'all'),
    none(all.reduce((total, bar) => total + bar.outside, 0), counted, 5, 'outside the screen or its room', 'all'),
  );
  if (mechanism !== undefined) rows.push(atLeast(mechanism.coherence, 3.3, 7, 'mechanism: coherence', 'mechanism', '3.3'));
  if (chart !== undefined) {
    rows.push(
      atLeast(chart.chartQuality, 3.6, 8, 'charts: chartQuality', 'chart', '3.6 (4.2 on real data)'),
      { row: 8, what: 'charts: lowest chartQuality', family: 'chart', value: chart.chartQualityLowest, se: null, n: chart.chartQuality.n, bar: '3 or more', met: chart.chartQualityLowest === null ? null : chart.chartQualityLowest >= 3 },
      atLeast(chart.chartHygiene, 1, 9, 'charts: hygiene (type, ticks, plot, approx)', 'chart', '100%'),
    );
  }
  const looks = all.reduce((total, bar) => total + bar.lookGain.n, 0);
  if (looks > 0) {
    rows.push(
      atLeast(pooled(all.map((bar) => bar.lookGain)), 0.3, 11, 'look: coherence gain, answers looked at', 'all', '+0.3'),
      none(all.reduce((total, bar) => total + (bar.lookWorse.value === null ? 0 : Math.round(bar.lookWorse.value * bar.lookWorse.n)), 0), looks, 11, 'look: answers worse after', 'all'),
    );
    const median = quantile(all.flatMap((bar) => (bar.addedWait.median === null ? [] : [bar.addedWait.median])), 0.5);
    const p90 = quantile(all.flatMap((bar) => (bar.addedWait.p90 === null ? [] : [bar.addedWait.p90])), 0.5);
    rows.push(
      { row: 12, what: 'look: wait added, median (ms)', family: 'all', value: median, se: null, n: looks, bar: '2000', met: median === null ? null : median <= 2000 },
      { row: 12, what: 'look: wait added, 90th percentile (ms)', family: 'all', value: p90, se: null, n: looks, bar: '6000', met: p90 === null ? null : p90 <= 6000 },
    );
  }
  if (explorable !== undefined) {
    rows.push(
      atLeast(explorable.controlEvents, 1, 15, 'controls: event sent', 'explorable', '100%'),
      atLeast(explorable.sliderChanges, 0.9, 15, 'sliders change the picture', 'explorable', '90%'),
      atLeast(explorable.pickChanges, 0.9, 15, 'picks change the picture', 'explorable', '90%'),
      atLeast(explorable.toggleChanges, 0.9, 15, 'toggles change the picture', 'explorable', '90%'),
      atLeast(explorable.responds, 0.75, 16, 'judge: the picture responds', 'explorable', '75%'),
    );
  }
  for (const family of ['plain', 'type', 'scene', 'pixels', 'motion'] as const) {
    const bar = summary.families[family]?.bar;
    if (bar === undefined) continue;
    const row = atLeast(bar.coherence, 3.9, 25, `${family}: coherence (n of at least 6)`, family, '3.9');
    rows.push(bar.coherence.n < 6 ? { ...row, met: null } : row);
  }
  return rows;
}
