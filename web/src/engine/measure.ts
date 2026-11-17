// The one measurement of a stage, for the page and the server alike: no DOM, no Vite, no clock.
import { contentOf, EMPTY_STAGE, LineNormalizer, NO_SIGHT, parseLine, TurnScore as Score } from '@conduit/language';
import type { ContentCount, ControlValues, DataTable, Issue, Line, LookId, PlacedBox, Schedule, Sight, StageBase, TurnOpening, TurnScore } from '@conduit/language';
import { createRuntime } from '../painter/bound';
import { controlSpecOf } from '../painter/bound';
import { withAsks } from '../painter/controls/ask-state';
import type { AskFacts } from '../painter/controls/ask-state';
import { createControlStore } from '../painter/controls/store';
import { withTarget } from '../painter/target';
import type { ChartData } from '../painter/charts';
import type { Painting } from '../painter/figures';
import { placedOf, sightOf } from '../painter/sight';
import { buildTimeline, settledAfter } from '../painter/timeline';
import type { TimelineContext } from '../painter/timeline';
import { hashOf } from './version';

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface EngineView {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly pointer: 'fine' | 'coarse';
  readonly reducedMotion: boolean;
  readonly look: LookId;
  readonly lockLook: LookId | null;
  readonly insets: Insets;
  /** PLAN-canvas step 2: lay the scene out as the page does with `?lens=1`, on a page as tall as it needs when it would be squeezed; absent: the screen is the page */
  readonly grow?: boolean;
}

export interface EngineInputs {
  /** what each control holds, by element id */
  readonly held: ControlValues;
  /** the data that has come for each chart, by element key */
  readonly charts: ReadonlyMap<string, DataTable>;
  /** a photo's size, by element key */
  readonly pictures: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  /** the chart kinds the page can draw; absent: all five */
  readonly chartKinds?: readonly string[];
  /**
   * What the page itself keeps outside the score: the least a tappable thing measures (css px) and what the hand has done to the asks. The page
   * leaves both absent (its own are read); a server measuring what the page measured is given the page's (`PageFacts`).
   */
  readonly target?: number;
  readonly asks?: AskFacts;
}

export interface StageFacts {
  readonly view: EngineView;
  readonly sight: Sight;
  readonly placed: readonly (PlacedBox & { readonly key: string })[];
  readonly content: ContentCount;
  /** digest of the placed boxes, rounded to 0.01 */
  readonly boxes: string;
  /** PLAN-canvas step 2: the page the answer rests on when it has grown past the screen (stage units, its top-left the screen's); absent while the screen is the page */
  readonly page?: { readonly width: number; readonly height: number };
  /** a leaf threw: what it said; the other facts are empty */
  readonly fault: string | null;
}

export interface LineProblem {
  readonly index: number;
  readonly text: string;
  readonly issues: readonly Issue[];
}

export const CHART_KINDS: readonly string[] = ['line', 'area', 'columns', 'candles', 'ohlc'];
const EMPTY_CONTENT: ContentCount = { structures: 0, parts: 0, drawn: 0, controls: 0, words: 0 };

const round = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

export function digestOf(placed: readonly PlacedBox[]): string {
  const rows = placed.map((p) => `${p.id}|${p.kind}|${p.parent ?? ''}|${round(p.box.x)}|${round(p.box.y)}|${round(p.box.w)}|${round(p.box.h)}`);
  return hashOf(rows.join('\n'));
}

function contextOf(view: EngineView, inputs: EngineInputs, schedule: Schedule): TimelineContext {
  const store = createControlStore();
  const runtime = createRuntime(store);
  for (const element of schedule.elements) {
    const spec = controlSpecOf(element);
    if (spec === null) continue;
    store.declare(element.key, element.id, spec);
    const value = inputs.held[element.id];
    if (value !== undefined) store.set(element.key, value);
  }
  const paintings = new Map<string, Painting>();
  for (const [key, size] of inputs.pictures) paintings.set(key, { status: 'ready', url: null, since: 0, aspect: size.height > 0 ? size.width / size.height : 1 });
  const data = new Map<string, ChartData>();
  for (const [key, table] of inputs.charts) data.set(key, { table, since: 0 });
  return {
    viewport: { width: view.width, height: view.height, dpr: view.dpr },
    reducedMotion: view.reducedMotion,
    lockLook: view.lockLook,
    paintings,
    arrivals: new Map(),
    controls: runtime,
    charts: { kinds: inputs.chartKinds ?? CHART_KINDS, data },
    ...(view.grow === true ? { grow: true } : {}),
  };
}

/** How a schedule WILL land, as it rests: nothing is waited for, nothing on stage is touched. Total: a leaf that throws is a `fault`. */
export function measureStage(schedule: Schedule, base: StageBase, view: EngineView, inputs: EngineInputs): StageFacts {
  const asked = (): StageFacts => (inputs.asks === undefined ? measureOnce(schedule, base, view, inputs) : withAsks(inputs.asks, () => measureOnce(schedule, base, view, inputs)));
  return inputs.target === undefined ? asked() : withTarget(inputs.target, asked);
}

function measureOnce(schedule: Schedule, base: StageBase, view: EngineView, inputs: EngineInputs): StageFacts {
  try {
    const stage = view.lockLook === null || base.look === view.lockLook ? base : { ...base, look: view.lockLook };
    const at = buildTimeline(schedule, stage, contextOf(view, inputs, schedule));
    const built = at.schedule;
    const when = Math.max(built.end, settledAfter(at, view.lockLook, stage.scene.mood)) + 1e-6;
    const sight = sightOf(at, built, stage, when, false);
    // only what is on the stage when it rests
    const keys = new Set(built.elements.filter((element) => element.exit === null || element.exit.start > when).map((element) => element.key));
    const placed = placedOf(at, built, when, keys);
    const page = at.pageAt(when);
    return { view, sight, placed, content: contentOf(built), boxes: digestOf(placed), ...(page === null ? {} : { page: { width: page.width, height: page.height } }), fault: null };
  } catch (error) {
    return { view, sight: NO_SIGHT, placed: [], content: EMPTY_CONTENT, boxes: digestOf([]), fault: error instanceof Error ? error.message : String(error) };
  }
}

/** The lines pushed on a COPY of the score, then measured; the score itself is not touched. */
export function tryLines(score: TurnScore, lines: readonly string[], view: EngineView, inputs: EngineInputs): { facts: StageFacts; rejects: readonly LineProblem[] } {
  const copy = score.fork();
  const rejects: LineProblem[] = [];
  let counter = 0;
  const normalizer = new LineNormalizer(() => `try${(counter += 1)}`);
  let seq = copy.score.reduce((most, entry) => Math.max(most, entry.seq), 0);
  const floor = copy.score.reduce((most, entry) => Math.max(most, entry.floor), 0);
  lines.forEach((text, index) => {
    const parsed = parseLine(text);
    if (parsed.kind !== 'line') {
      if (parsed.kind === 'reject') rejects.push({ index, text, issues: parsed.issues });
      return;
    }
    const normalized = normalizer.normalize(parsed.line as Line);
    if (normalized.line === null) {
      rejects.push({ index, text, issues: normalized.issues });
      return;
    }
    seq += 1;
    const pushed = copy.push(normalized.line, seq, floor);
    if (pushed.issues.length > 0) rejects.push({ index, text, issues: pushed.issues });
  });
  return { facts: measureStage(copy.schedule, copy.base, view, inputs), rejects };
}

/** A turn to measure, as plain data: the stage it began from, how it was opened, and the lines as they arrived. */
export interface EngineCase {
  readonly id: string;
  readonly base: StageBase | null;
  readonly opened: string;
  readonly lines: readonly { readonly seq: number; readonly text: string; readonly floor: number }[];
}

/** The score a case adds up to, the way the painter hears it. The page and the server both build it here. */
export function scoreOfCase(item: EngineCase): TurnScore {
  const score = new Score(item.base ?? EMPTY_STAGE, item.opened as TurnOpening);
  let counter = 0;
  const normalizer = new LineNormalizer(() => `cx${(counter += 1)}`);
  for (const entry of item.lines) {
    const parsed = parseLine(entry.text);
    if (parsed.kind !== 'line') continue;
    const normalized = normalizer.normalize(parsed.line);
    if (normalized.line === null) continue;
    score.push(normalized.line, entry.seq, entry.floor);
  }
  return score;
}
