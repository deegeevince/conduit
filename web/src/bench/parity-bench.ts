// The page's half of `pnpm parity` (server/src/tools/parity.ts drives it over DevTools). It runs the engine's `measureStage`, posts the same
// inputs to the server's dev route and compares what comes back; it also probes the loaded font faces against the advance tables.
// Dev only: the route it posts to answers only with ENGINE_DEV=1.

import { ENGINE_VERSION, measureStage, planWall, scoreOfCase, wallNodesOfTurns } from '../engine';
import type { EngineCase, EngineView, StageFacts, WallNode, WallPlan, WallShape, WallTurn } from '../engine';
import { FACES } from '../fonts/faces';
import { GLYPHS } from '../fonts/glyphs';
import { FONTS } from '../fonts';
import { clearMeasureCache, measureEm } from '../fonts/measure';
import type { Face, LookId, Weight } from '@conduit/language';

const TOLERANCE = 0.01;
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

interface Screen {
  readonly width: number;
  readonly height: number;
}

const viewOf = (screen: Screen, look: LookId): EngineView => ({ ...screen, dpr: 1, pointer: 'fine', reducedMotion: false, look, lockLook: look, insets: NO_INSETS });
const inputsOf = { held: {}, charts: new Map(), pictures: new Map() };

interface ServerReply {
  readonly version: string;
  readonly ms: number;
  readonly facts: StageFacts;
}

async function serverMeasure(item: EngineCase, view: EngineView): Promise<ServerReply> {
  const response = await fetch('/api/engine/measure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ case: item, view, held: {}, charts: [], pictures: [] }),
  });
  if (!response.ok) throw new Error(`the engine route answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as ServerReply;
}

export interface Compared {
  readonly id: string;
  readonly look: string;
  readonly screen: string;
  readonly boxes: number;
  readonly serverBoxes: number;
  readonly maxDelta: number;
  readonly withinTolerance: boolean;
  readonly digestEqual: boolean;
  readonly sightEqual: boolean;
  readonly contentEqual: boolean;
  readonly faults: readonly string[];
  readonly versionEqual: boolean;
  readonly pageMs: number;
  readonly serverMs: number;
}

function compare(id: string, screen: Screen, look: string, page: StageFacts, server: ServerReply, pageMs: number): Compared {
  const a = new Map(page.placed.map((p) => [p.id, p]));
  const b = new Map(server.facts.placed.map((p) => [p.id, p]));
  let maxDelta = 0;
  let within = a.size === b.size;
  for (const [key, left] of a) {
    const right = b.get(key);
    if (right === undefined || right.kind !== left.kind) {
      within = false;
      continue;
    }
    for (const side of ['x', 'y', 'w', 'h'] as const) {
      const delta = Math.abs(left.box[side] - right.box[side]);
      if (!(delta <= TOLERANCE)) within = false;
      if (Number.isFinite(delta)) maxDelta = Math.max(maxDelta, delta);
    }
  }
  const faults = [page.fault, server.facts.fault].filter((fault): fault is string => fault !== null);
  return {
    id,
    look,
    screen: `${screen.width}x${screen.height}`,
    boxes: a.size,
    serverBoxes: b.size,
    maxDelta,
    withinTolerance: within,
    digestEqual: page.boxes === server.facts.boxes,
    sightEqual: JSON.stringify(page.sight) === JSON.stringify(server.facts.sight),
    contentEqual: JSON.stringify(page.content) === JSON.stringify(server.facts.content),
    faults,
    versionEqual: server.version === ENGINE_VERSION,
    pageMs,
    serverMs: server.ms,
  };
}

const known = new Map<string, EngineCase>();
const caseOf = (id: string): EngineCase => {
  const found = known.get(id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

async function runCase(item: EngineCase, screen: Screen, look: LookId): Promise<Compared> {
  const score = scoreOfCase(item);
  const view = viewOf(screen, look);
  const started = performance.now();
  const page = measureStage(score.schedule, score.base, view, inputsOf);
  const pageMs = performance.now() - started;
  return compare(item.id, screen, look, page, await serverMeasure(item, view), pageMs);
}

const timed = (id: string, screen: Screen, look: LookId, runs: number): number[] => timing(caseOf(id), screen, look, runs);

/** measureStage alone, on a fresh schedule each time, after a warm-up: milliseconds in the order run. */
function timing(item: EngineCase, screen: Screen, look: LookId, runs: number): number[] {
  const view = viewOf(screen, look);
  const times: number[] = [];
  for (let i = 0; i < runs + 5; i += 1) {
    const score = scoreOfCase(item);
    const started = performance.now();
    measureStage(score.schedule, score.base, view, inputsOf);
    if (i >= 5) times.push(performance.now() - started);
  }
  return times;
}

interface ProbeRow {
  readonly font: string;
  readonly face: string;
  readonly weight: string;
  readonly loaded: number;
  readonly table: number;
  readonly error: number;
}

/** Each font file: the whole GLYPHS string, measured by the browser with the loaded face, against the table's sum. */
async function probe(): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  const seen = new Set<string>();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no canvas 2d context');
  for (const [face, spec] of Object.entries(FACES) as [Face, (typeof FACES)[Face]][]) {
    for (const [font, weight] of [[spec.font, 'normal'], [spec.boldFont, 'bold']] as const) {
      if (font === null || seen.has(font)) continue;
      seen.add(font);
      const entry = FONTS[font];
      if (entry === undefined) continue;
      const loaded = await new FontFace(entry.family, `url(${entry.url})`).load();
      document.fonts.add(loaded);
      context.font = `100px "${entry.family}"`;
      context.fontKerning = 'none';
      const measured = context.measureText(GLYPHS).width / 100;
      const table = measureEm(GLYPHS, face, weight as Weight);
      rows.push({ font, face, weight, loaded: measured, table, error: Math.abs(measured - table) / table });
    }
  }
  return rows;
}

/** Plants one wrong advance on this side (the space of the sans face), runs the cases, puts it back. */
async function planted(ids: readonly string[], screen: Screen, look: LookId): Promise<{ found: boolean; differing: number; of: number }> {
  const metrics = FACES.sans.metrics;
  if (metrics === null) throw new Error('sans has no table');
  const table = metrics.advance as Record<string, number>;
  const was = table[' '] ?? 0;
  table[' '] = was + 0.05;
  clearMeasureCache();
  let differing = 0;
  try {
    for (const id of ids) {
      const result = await runCase(caseOf(id), screen, look);
      if (!result.digestEqual || !result.withinTolerance) differing += 1;
    }
  } finally {
    table[' '] = was;
    clearMeasureCache();
  }
  return { found: differing > 0, differing, of: ids.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The wall (WL1): the page plans, the server plans, and the two plans must be equal, tile for tile.

export interface WallCase {
  readonly id: string;
  readonly shape: WallShape;
  readonly nodes?: readonly WallNode[];
  readonly turns?: readonly WallTurn[];
}

/** The plans of these cases on the page and on the server. `plant` changes one node's lane on the page's side only (a wrong read of the same input). */
async function wall(cases: readonly WallCase[], plant: boolean): Promise<{ of: number; equal: number; different: string[]; digests: number }> {
  const response = await fetch('/api/engine/wall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cases }) });
  if (!response.ok) throw new Error(`the wall route answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const served = new Map(((await response.json()) as { plans: { id: string; plan: WallPlan }[] }).plans.map((p) => [p.id, p.plan]));
  let equal = 0;
  let digests = 0;
  const different: string[] = [];
  for (const item of cases) {
    let nodes = item.nodes ?? wallNodesOfTurns(item.turns ?? []);
    if (plant && nodes.length > 1) nodes = nodes.map((node, i) => (i === nodes.length - 1 ? { ...node, lane: node.lane === null ? (nodes[0]?.id ?? null) : null } : node));
    const mine = planWall(nodes, item.shape);
    const theirs = served.get(item.id);
    if (theirs !== undefined && theirs.digest === mine.digest) digests += 1;
    if (theirs !== undefined && JSON.stringify(theirs) === JSON.stringify(mine)) equal += 1;
    else different.push(item.id);
  }
  return { of: cases.length, equal, different: different.slice(0, 10), digests };
}

(window as unknown as { __parity: unknown }).__parity = {
  ready: true,
  version: ENGINE_VERSION,
  setCases: (items: readonly EngineCase[]): void => {
    known.clear();
    for (const item of items) known.set(item.id, item);
  },
  run: (id: string, screen: Screen, look: LookId): Promise<Compared> => runCase(caseOf(id), screen, look),
  timing: timed,
  probe,
  planted,
  wall,
};
