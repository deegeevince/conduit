// The server's own measurement of a draft (SA2): the same engine the page runs (`@conduit/web/engine`), on the turn's score, for the screen
// the page said it has and the look in force. Nothing here waits for the browser.

import { ENGINE_VERSION, digestOf, measureStage, scoreOfCase, tryLines } from '@conduit/web/engine';
import type { EngineInputs, EngineView, LineProblem } from '@conduit/web/engine';
import type { Capabilities, ContentCount, ControlValues, DataTable, PlacedBox, Schedule, ScreenFacts, Sight, TurnScore } from '@conduit/language';

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

/** A draft that holds a photo the user gave is sized by the page (the server has not loaded it), so only the page can measure it. */
export function measurable(schedule: Schedule): boolean {
  return !schedule.elements.some((element) => element.figure?.kind === 'picture' && element.figure.from !== undefined && element.figure.from !== null);
}

function viewOf(s: MeasureSession, look: EngineView['look']): EngineView {
  // The page's own view, as `engineView` builds it: the pointer is not a layout input and the shell's insets are zero.
  const looks = s.capabilities.looks;
  return { width: s.screen.width, height: s.screen.height, dpr: s.screen.dpr, pointer: 'fine', reducedMotion: s.screen.reducedMotion, look, lockLook: looks.length === 1 ? (looks[0] ?? null) : null, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
}

function inputsOf(s: MeasureSession): EngineInputs {
  const charts = new Map<string, DataTable>();
  for (const table of s.tables) charts.set(table.id, table);
  return { held: s.held, charts, pictures: new Map(), chartKinds: s.capabilities.charts };
}

/** `null` when a leaf of the engine threw: the caller falls back to the page's report. */
export function measureDraft(score: TurnScore, s: MeasureSession): Measured | null {
  const started = performance.now();
  const facts = measureStage(score.schedule, score.base, viewOf(s, score.base.look), inputsOf(s));
  if (facts.fault !== null) return null;
  return { sight: facts.sight, placed: facts.placed.map(({ key: _key, ...item }) => item), content: facts.content, boxes: facts.boxes, ms: performance.now() - started };
}

/** The lines tried on a copy of the score; the score is not touched. `null` as above. */
export function tryFix(score: TurnScore, lines: readonly string[], s: MeasureSession): { readonly measured: Measured; readonly rejects: readonly LineProblem[] } | null {
  const started = performance.now();
  const { facts, rejects } = tryLines(score, lines, viewOf(s, score.base.look), inputsOf(s));
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

export { digestOf, ENGINE_VERSION };
