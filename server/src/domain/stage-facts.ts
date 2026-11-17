// The server's own measurement of a draft (SA2): the same engine the page runs (`@conduit/web/engine`), on the turn's score, for the screen
// the page said it has and the look in force. Nothing here waits for the browser.

import { ENGINE_VERSION, hasDevice, targetFor, digestOf, measureStage, planWall, scoreOfCase, tryLines } from '@conduit/web/engine';
import type { EngineInputs, EngineView, LineProblem, WallNode, WallPlan, WallShape } from '@conduit/web/engine';
import type { Capabilities, ContentCount, ControlValues, DataTable, PageFacts, PlacedBox, Schedule, ScreenFacts, Sight, TurnScore } from '@conduit/language';

/** What the server holds that a measurement reads, and no more: a session satisfies this. */
export interface MeasureSession {
  readonly screen: ScreenFacts;
  readonly capabilities: Capabilities;
  readonly tables: readonly DataTable[];
  /** what the user last set each control to, by element id (`control` back events) */
  readonly held: Readonly<ControlValues>;
}

export interface Measured {
  readonly sight: Sight;
  readonly placed: readonly PlacedBox[];
  readonly content: ContentCount;
  /** digest of the placed boxes: what the page's `boxes` must equal */
  readonly boxes: string;
  readonly ms: number;
}

/** Why this session's draft is not measured by the server, or null when it is. Only the page's engine version is known up front. */
export function engineMismatch(capabilities: Capabilities): string | null {
  if (capabilities.engine === undefined) return 'the page did not say which engine it measures with';
  if (capabilities.engine !== ENGINE_VERSION) return `the page's engine ${capabilities.engine} is not the server's ${ENGINE_VERSION}`;
  return null;
}

/**
 * What only the page can size, so only the page measures it: a photo the user gave (the server has not loaded it) and a live app (the height
 * its content asks of its frame is the browser's). A turn whose stage holds either is the page's to measure, here and in every later turn that
 * still has it on the stage. Words in a script no shipped face has (Greek, Cyrillic, Arabic, Hebrew, Indic, Thai, Latin Extended...) are the same: the page sets a
 * run in the device's own font and measures it there, the server only estimates it, so such a turn is the page's to measure and costs the conversation nothing.
 */
export function measurable(schedule: Schedule): boolean {
  return !schedule.elements.some((element) => hasDevice(element.text) || (element.figure !== null && element.figure.kind !== 'shape' && hasDevice(JSON.stringify(element.figure))) || (element.figure?.kind === 'picture' && element.figure.from !== undefined && element.figure.from !== null) || (element.figure?.kind === 'structure' && element.figure.structure === 'app'));
}

function viewOf(s: MeasureSession, look: EngineView['look'], page?: PageFacts): EngineView {
  // The page's own view, as `engineView` builds it: the pointer is not a layout input and the shell's insets are zero. A page that says what
  // screen it measured on is believed over the last `ready`: a resize may have moved it since.
  const looks = s.capabilities.looks;
  const screen = page === undefined ? s.screen : { ...s.screen, ...page.view };
  return { width: screen.width, height: screen.height, dpr: screen.dpr, pointer: 'fine', reducedMotion: s.screen.reducedMotion, look, lockLook: looks.length === 1 ? (looks[0] ?? null) : null, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
}

function inputsOf(s: MeasureSession, page?: PageFacts): EngineInputs {
  const charts = new Map<string, DataTable>();
  for (const table of s.tables) charts.set(table.id, table);
  const base = { held: page?.controls ?? s.held, charts, pictures: new Map<string, { width: number; height: number }>(), chartKinds: s.capabilities.charts };
  // The page's own target (the pointer and the audience) and the hand's work on its asks: nothing else says them. Without them, the server's are the defaults.
  return page === undefined ? { ...base, target: targetOf(s.screen) } : { ...base, target: page.target, asks: page.asks };
}

/** The least a tappable thing measures when the page has not said: the adult's, for the pointer the screen reports. */
export function targetOf(screen: ScreenFacts): number {
  return targetFor('adult', screen.pointer);
}

/** The score as the page scheduled it: each line pushed again at the playhead the page pushed it at, where the page said it. `upto` is how many of the server's pushes to take. */
export function pageScore(score: TurnScore, page: PageFacts | undefined, upto?: number): TurnScore {
  if (page === undefined || page.floors.length === 0) return upto === undefined || upto >= score.pushes ? score : score.refloored(() => undefined, upto);
  const floors = new Map(page.floors);
  return score.refloored((seq) => floors.get(seq), upto);
}

/** `null` when a leaf of the engine threw: the caller falls back to the page's report. `page`: what the page measured with, when it said (a draft's or a report's `facts`). */
export function measureDraft(score: TurnScore, s: MeasureSession, page?: PageFacts, upto?: number): Measured | null {
  const started = performance.now();
  score = pageScore(score, page, upto);
  const facts = measureStage(score.schedule, score.base, viewOf(s, score.base.look, page), inputsOf(s, page));
  if (facts.fault !== null) return null;
  return { sight: facts.sight, placed: facts.placed.map(({ key: _key, ...item }) => item), content: facts.content, boxes: facts.boxes, ms: performance.now() - started };
}

/** The lines tried on a copy of the score; the score is not touched. `null` as above. */
export function tryFix(score: TurnScore, lines: readonly string[], s: MeasureSession, page?: PageFacts): { readonly measured: Measured; readonly rejects: readonly LineProblem[] } | null {
  const started = performance.now();
  const { facts, rejects } = tryLines(pageScore(score, page), lines, viewOf(s, score.base.look, page), inputsOf(s, page));
  if (facts.fault !== null) return null;
  return { measured: { sight: facts.sight, placed: facts.placed.map(({ key: _key, ...item }) => item), content: facts.content, boxes: facts.boxes, ms: performance.now() - started }, rejects };
}

/** Runs the engine once on a small diagram so the first real draft does not pay for a cold start (the first measure of a flowchart costs about three times a warm one). */
export function warmEngine(): number {
  const started = performance.now();
  const lines = ['scene s1 layout=caption canvas=wide', 'flow x1 down | Warm', ...['a', 'b', 'c', 'd'].map((id, at) => `node ${id}${at === 0 ? '' : ` from=${['a', 'b', 'c', 'd'][at - 1]}`} in=x1 | Step ${id} of the warm run`)].map((text, index) => ({ seq: index + 1, text, floor: 0 }));
  const score = scoreOfCase({ id: 'warm', base: null, opened: 'prompt', lines });
  const view: EngineView = { width: 390, height: 776, dpr: 2, pointer: 'fine', reducedMotion: false, look: score.base.look, lockLook: null, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
  const inputs: EngineInputs = { held: {}, charts: new Map(), pictures: new Map() };
  for (let run = 0; run < 3; run += 1) measureStage(score.schedule, score.base, view, inputs);
  return performance.now() - started;
}

const WALL_PLANS = 64;
const wallPlans = new Map<string, WallPlan>();

/**
 * The wall's plan at a document revision for a view, derived by the same `planWall` the page calls and kept by (`rev`, `viewKey`) so a brief
 * and a turn do not plan twice. `nodes` is what the revision holds (before the v3 merge: `wallNodesOfTurns` of the folded log). Nothing is
 * stored but this cache: it is never read back as truth, and a rev that comes again with other nodes is the caller's mistake.
 */
export function wallAt(rev: string | number, viewKey: string, nodes: readonly WallNode[], shape: WallShape): WallPlan {
  const key = `${rev}|${viewKey}`;
  const have = wallPlans.get(key);
  if (have !== undefined) {
    wallPlans.delete(key);
    wallPlans.set(key, have);
    return have;
  }
  const plan = planWall(nodes, shape);
  wallPlans.set(key, plan);
  if (wallPlans.size > WALL_PLANS) wallPlans.delete(wallPlans.keys().next().value as string);
  return plan;
}

export { digestOf, ENGINE_VERSION };
