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
 * `heldout`: decides whether an experiment is kept. The critic and the builder never see its prompts, its answers or its stills, only its scores.
 * `vault`: kept outside the repository by the steward and run rarely, to catch a system that has learned the held-out set by being selected on it.
 */
export type ExplorePool = 'tune' | 'heldout' | 'vault';

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

/** What the painter measured about the final stage, with no model in the loop: geometry a judge cannot be talked out of. */
export interface ExploreGeometry {
  /** pairs of resting text boxes that overlap */
  readonly textOverlaps: number;
  /** resting labels a drawn stroke runs through */
  readonly crossedLabels: number;
  /** connectors that pass through a node that is not one of their ends */
  readonly linksThroughNodes: number;
  /** resting things with any part outside the safe frame */
  readonly clipped: number;
  /** the sight notes of the final stage, counted */
  readonly notes: Readonly<Partial<Record<SightNote, number>>>;
}

/** How look-and-fix went for one answer in a run: what was decided and why, what it cost, and whether the picture got better. */
export interface ExploreReview extends ReviewOutcome {
  /** from the end of the draft to the first line of the fix; null when there was no fix */
  readonly firstLineMs: number | null;
  /** how much longer the viewer waited because of the look: the end of the last pass against the end of the draft's own playing; never below 0 */
  readonly addedWaitMs: number;
  /** the judge's coherence for the draft alone and for the answer as it ended; null where the judge did not run */
  readonly before: number | null;
  readonly after: number | null;
  readonly costUsd: number | null;
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
  }[];
  /** one entry per control worked */
  readonly controls: readonly {
    readonly id: string;
    readonly kind: ControlKind;
    /** something on stage follows it */
    readonly bound: boolean;
    /** the share of the picture's pixels that differ between its two ends (a slider's min and max, a toggle's off and on); null for a button */
    readonly changed: number | null;
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
  readonly kind: 'prompt' | 'tap' | 'fix';
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
  /** what the run was projected to cost before it began, and what it did */
  readonly projection?: { readonly calls: number; readonly usd: number | null } | null;
  readonly spentUsd?: number | null;
  /** what one call of each kind cost on average in this run: the next run's projection starts from these */
  readonly measured?: { readonly firstTurnUsd: number | null; readonly laterTurnUsd: number | null; readonly judgeUsd: number | null; readonly baselineUsd: number | null } | null;
}

// -- verdicts ---------------------------------------------------------------

const TOKEN_FLAG = 1500;
const FIRST_LINE_BAR_MS = 4000;

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
    out.push(
      { label: 'painter: no overlapping text', ok: geometry.textOverlaps === 0, detail: `${geometry.textOverlaps} pairs` },
      { label: 'painter: no connector through a node', ok: geometry.linksThroughNodes === 0, detail: `${geometry.linksThroughNodes}` },
      { label: 'painter: no label crossed', ok: geometry.crossedLabels === 0, detail: `${geometry.crossedLabels}` },
    );
  }
  if (checks.chart != null) {
    out.push({ label: 'chart: approx when it has no DATA', ok: checks.chart.data || checks.chart.approx, detail: checks.chart.data ? 'draws DATA' : checks.chart.approx ? 'says approx' : 'its own numbers, not marked approx' });
    out.push({ label: 'chart: rows read cleanly', ok: checks.chart.problems.length === 0, detail: checks.chart.problems.join(' / ') || 'nothing wrong' });
  }
  const drive = result.drive;
  if (drive !== undefined) {
    for (const control of drive.controls) {
      out.push({ label: 'control: its event was sent', ok: control.reported, detail: `${control.kind} ${control.id}` });
      if (control.changed !== null) out.push({ label: 'control: the picture changes at its two ends', ok: control.changed > 0.005, detail: `${control.id}: ${(control.changed * 100).toFixed(2)}% of pixels` });
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

/** The family a prompt's scores are added up under. */
export function familyOf(prompt: ExplorePrompt): ExploreFamily {
  if (prompt.family !== undefined) return prompt.family;
  switch (prompt.expects) {
    case 'structure':
      return 'diagram';
    case 'chart':
      return 'chart';
    case 'explorable':
      return 'explorable';
    case 'drawn':
      return prompt.information === true ? 'diagram' : 'mechanism';
    case 'plain':
    case 'type':
    case 'pixels':
    case 'scene':
    case 'motion':
      return prompt.expects;
    case 'any':
      return 'open';
  }
}

/** One measure: a share (0..1) or a mean, over `n` answers. Null where nothing could be measured. */
export interface Measure {
  readonly value: number | null;
  readonly n: number;
}

/** What a family's answers came to, in the terms of the quality bar (PLAN-v2.md section 3). Each field names its row. */
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
  /** row 8: of charts, the share that mark `approx` when they have no DATA and read cleanly */
  readonly chartHygiene: Measure;
  /** rows 15 to 17 */
  readonly controlEvents: Measure;
  readonly sliderChanges: Measure;
  readonly responds: Measure;
  /** row 10 */
  readonly chartRead: Measure;
  /** row 4, counted over every answer that names a structure: totals, which must all be 0 */
  readonly overlaps: number;
  readonly throughNodes: number;
  readonly crossed: number;
  /** rows 11 and 12 (the look): the mean of the judge's gain over the draft, and answers worse after */
  readonly lookGain: Measure;
  readonly lookWorse: Measure;
  /** row 28 */
  readonly cost: { readonly usd: number | null };
}

/** What `pnpm explore` writes beside the run's index, and the loop reads: scores, never answers. */
export interface ExploreSummary {
  readonly run: string;
  readonly pool: ExplorePool;
  readonly battery: string;
  readonly rubric: string | null;
  readonly brain: string;
  readonly model: string | null;
  readonly samples: number;
  readonly spentUsd: number | null;
  readonly families: Readonly<Partial<Record<ExploreFamily, FamilyScore>>>;
  /** per prompt id, the mean coherence over its samples and how many checks failed: enough to say which prompts moved, and nothing the critic could learn an answer from */
  readonly prompts: readonly { readonly id: string; readonly family: ExploreFamily; readonly coherence: number | null; readonly failed: number; readonly checked: number }[];
}

const measure = (flags: readonly boolean[]): Measure => ({ value: flags.length === 0 ? null : flags.filter(Boolean).length / flags.length, n: flags.length });
const average = (values: readonly number[]): Measure => ({ value: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length, n: values.length });

/** The answers of one family, with the prompt each answers. Cases that fix an answer are counted by `lookGain` only. */
export function scoreFamily(family: ExploreFamily, answers: readonly ExploreResult[]): FamilyScore {
  const judged = answers.filter((answer) => answer.judge != null && answer.judge.failure === null);
  const judges = judged.map((answer) => answer.judge as ExploreJudgement);
  const charts = answers.filter((answer) => answer.checks.chart != null);
  const named = answers.filter((answer) => answer.prompt.structure !== undefined);
  const withStructure = answers.filter((answer) => answer.geometry !== undefined && Object.keys(answer.checks.structures ?? {}).length > 0);
  const controls = answers.flatMap((answer) => answer.drive?.controls ?? []);
  const qualities = judges.flatMap((j) => (j.chartQuality == null ? [] : [j.chartQuality]));
  const reviews = answers.flatMap((answer) => (answer.review?.before != null && answer.review.after != null ? [answer.review.after - answer.review.before] : []));
  const sum = (pick: (g: ExploreGeometry) => number): number => withStructure.reduce((total, answer) => total + (answer.geometry === undefined ? 0 : pick(answer.geometry)), 0);
  const costs = answers.flatMap((answer) => (answer.usage?.costUsd == null ? [] : [answer.usage.costUsd]));
  return {
    family,
    answers: answers.length,
    judged: judged.length,
    coherence: average(judges.map((j) => j.coherence)),
    coherenceFour: measure(judges.map((j) => j.coherence >= 4)),
    textReadable: measure(judges.map((j) => j.textProblem === null)),
    labelsRight: measure(judges.map((j) => j.wrongLabel === null)),
    drawingCorrect: measure(judges.map((j) => j.correct)),
    structureNamed: measure(named.map((answer) => (answer.checks.structures?.[answer.prompt.structure as StructureKind] ?? 0) > 0 && (answer.checks.placedByHand ?? 0) === 0)),
    chartQuality: average(qualities),
    chartQualityLowest: qualities.length === 0 ? null : Math.min(...qualities),
    chartHygiene: measure(charts.map((answer) => { const chart = answer.checks.chart; return chart != null && (chart.data || chart.approx) && chart.problems.length === 0; })),
    controlEvents: measure(controls.map((control) => control.reported && control.answered !== false)),
    sliderChanges: measure(controls.flatMap((control) => (control.changed === null ? [] : [control.changed > 0.005]))),
    responds: measure(judges.flatMap((j) => (j.responds == null ? [] : [j.responds]))),
    chartRead: measure(answers.flatMap((answer) => (answer.drive?.charts ?? []).map((chart) => chart.crosshair && chart.zoomed && chart.silent))),
    overlaps: sum((g) => g.textOverlaps),
    throughNodes: sum((g) => g.linksThroughNodes),
    crossed: sum((g) => g.crossedLabels),
    lookGain: average(reviews),
    lookWorse: measure(reviews.map((gain) => gain < 0)),
    cost: { usd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0) },
  };
}

/** The summary of a run, from its answers by prompt id. */
export function summaryOf(
  meta: Omit<ExploreSummary, 'families' | 'prompts'>,
  answers: readonly ExploreResult[],
): ExploreSummary {
  const byFamily = new Map<ExploreFamily, ExploreResult[]>();
  for (const answer of answers) {
    const family = familyOf(answer.prompt);
    byFamily.set(family, [...(byFamily.get(family) ?? []), answer]);
  }
  const families: Partial<Record<ExploreFamily, FamilyScore>> = {};
  for (const [family, group] of byFamily) families[family] = scoreFamily(family, group);
  const byPrompt = new Map<string, ExploreResult[]>();
  for (const answer of answers) byPrompt.set(answer.prompt.id, [...(byPrompt.get(answer.prompt.id) ?? []), answer]);
  const prompts = [...byPrompt].map(([id, group]) => {
    const scores = group.flatMap((answer) => (answer.judge != null && answer.judge.failure === null ? [answer.judge.coherence] : []));
    const verdicts = group.flatMap((answer) => answer.verdicts ?? []);
    return { id, family: familyOf((group[0] as ExploreResult).prompt), coherence: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length, failed: verdicts.filter((v) => !v.ok).length, checked: verdicts.length };
  });
  return { ...meta, families, prompts };
}
