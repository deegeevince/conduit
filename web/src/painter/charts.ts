// Charts on stage. A chart is not drawn from shapes: it is read into a model from its rows (or from DATA that came by reference), themed
// from the look, and handed to the charting engine's surface as a `ChartFrame`, which says where the surface goes and what to show. This
// file is the pure half: (schedule, time, data) in, frames out. The engine, and the DOM it lives in, belong to the app.

import { CHART_REVEAL_SECONDS, cachedChartModel, readNumber, readWhen, styleAt } from '@conduit/language';
import type { ChartModel, DataTable, ElementSpan, Scope, Schedule, StructureRow } from '@conduit/language';
import type { ChartMark, ChartState, ChartTheme } from '../contracts/chart';
import type { ChartFrame } from '../contracts/frame';
import type { LookSpec } from '../contracts/look';
import { layerZ, planeScale, projectToScreen, REST_POSE } from '../contracts/space';
import type { Box, CameraPose, Viewport } from '../contracts/space';
import { chartThemeOf } from '../render/chart/theme';
import type { CanvasFit } from './canvas';
import { clamp01 } from './affine';

/** What has come of the DATA a chart asked for, by id. A table is there; null: it could not be had; absent: still on its way. */
export interface ChartData {
  readonly table: DataTable | null;
  /** ambient seconds at which it arrived: the reveal runs from here */
  readonly since: number;
}

export interface ChartEnv {
  readonly viewport: Viewport;
  readonly reducedMotion: boolean;
  readonly camera: CameraPose;
  readonly kinds: readonly string[];
  readonly data: ReadonlyMap<string, ChartData>;
  readonly scope: Scope;
  readonly fitOf: (element: ElementSpan) => CanvasFit;
  /** v2.1: the room the stage plan gave the chart at this instant (eased between layout epochs), reading-plane stage units; null: it has none */
  readonly roomOf: (element: ElementSpan) => Box | null;
}

const themes = new WeakMap<LookSpec, Map<string, ChartTheme>>();
const states = new Map<string, { readonly signature: string; readonly state: ChartState }>();

/** The theme of a look at this viewport: the label size is the stage's own, so a phone's chart is not a desk's. */
function themeOf(look: LookSpec, viewport: Viewport): ChartTheme {
  let bySize = themes.get(look);
  if (bySize === undefined) {
    bySize = new Map();
    themes.set(look, bySize);
  }
  const key = `${viewport.width}x${viewport.height}`;
  let found = bySize.get(key);
  if (found === undefined) {
    found = chartThemeOf(look, viewport);
    bySize.set(key, found);
  }
  return found;
}

function rowsOfTable(table: DataTable): StructureRow[] {
  return [{ cells: table.columns, at: 0 }, ...table.rows.map((cells) => ({ cells, at: 0 }))];
}

/** The place on the model's own x axis that a mark's `x=` names: a row's label as written, else a time or a number. */
function markX(model: ChartModel, text: string): number | null {
  const wanted = text.trim().toLowerCase();
  const point = model.points.find((candidate) => candidate.label.trim().toLowerCase() === wanted);
  if (point !== undefined) return point.x;
  if (model.x === 'time') return readWhen(text);
  if (model.x === 'number') return readNumber(text)?.value ?? null;
  return null;
}

export function chartFrames(schedule: Schedule, tq: number, aq: number, look: LookSpec, env: ChartEnv): ChartFrame[] {
  const out: ChartFrame[] = [];
  const live = new Set<string>();
  for (const element of schedule.elements) {
    const figure = element.figure;
    if (figure === null || figure.kind !== 'structure' || figure.structure !== 'chart' || figure.chart === null) continue;
    if (!env.kinds.includes(figure.chart)) continue;
    const enter = element.enter;
    if (!element.carried && (enter === null || tq < enter.start)) continue;
    const exit = element.exit;
    if (exit !== null && tq >= exit.end) continue;
    const ps = planeScale(element.style.layer, env.viewport);
    const fit = env.fitOf(element);
    const given = env.roomOf(element);
    const room: Box =
      given !== null
        ? { x: given.x / ps, y: given.y / ps, width: given.width / ps, height: given.height / ps }
        : figure.box === null
          ? { x: fit.box.x / ps, y: fit.box.y / ps, width: fit.box.width / ps, height: fit.box.height / ps }
          : { x: (fit.box.x + figure.box.x * fit.unit) / ps, y: (fit.box.y + figure.box.y * fit.unit) / ps, width: (figure.box.w * fit.unit) / ps, height: (figure.box.h * fit.unit) / ps };
    const z = layerZ(element.style.layer, env.viewport);
    const corner = (pose: CameraPose, x: number, y: number) => projectToScreen({ x, y, z }, pose, env.viewport);
    const a = corner(env.camera, room.x, room.y);
    const b = corner(env.camera, room.x + room.width, room.y + room.height);
    const ra = corner(REST_POSE, room.x, room.y);
    const rb = corner(REST_POSE, room.x + room.width, room.y + room.height);
    const box: Box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    const rest: Box = { x: Math.min(ra.x, rb.x), y: Math.min(ra.y, rb.y), width: Math.abs(rb.x - ra.x), height: Math.abs(rb.y - ra.y) };

    // by reference: the rows are the table's, and the chart is waiting, ready or failed
    const byReference = figure.data !== null;
    const arrived = byReference ? env.data.get(figure.data as string) : undefined;
    const waiting = byReference && arrived === undefined;
    const failed = byReference && arrived !== undefined && arrived.table === null;
    const rows = byReference ? (arrived?.table == null ? [] : rowsOfTable(arrived.table)) : figure.rows;
    const owner: object = byReference ? (arrived?.table ?? figure) : figure;
    const model = cachedChartModel(owner, figure.chart, rows, env.scope);

    // how far it is in, and out
    let opacity = 1;
    let coming = false;
    if (enter !== null && tq < enter.end) {
      coming = true;
      opacity = enter.end > enter.start ? clamp01((tq - enter.start) / (enter.end - enter.start)) : 1;
    }
    let going = false;
    if (exit !== null && tq >= exit.start) {
      going = true;
      opacity *= exit.end > exit.start ? 1 - clamp01((tq - exit.start) / (exit.end - exit.start)) : 0;
    }
    opacity *= styleAt(element, tq).opacity;
    if (opacity <= 0.001) continue;

    let reveal: number;
    if (env.reducedMotion) reveal = 1;
    else if (byReference) reveal = arrived === undefined || arrived.table === null ? 0 : clamp01((aq - arrived.since) / CHART_REVEAL_SECONDS);
    else reveal = enter === null ? 1 : clamp01((tq - enter.start) / Math.max(CHART_REVEAL_SECONDS, enter.end - enter.start));
    const landed = byReference ? model.points.length : model.points.filter((point) => point.at <= tq + 1e-9).length;

    const marks: ChartMark[] = [];
    for (const node of schedule.elements) {
      if (node.parent !== element.key || node.kind !== 'node' || node.figure === null || node.figure.kind !== 'node') continue;
      if (node.exit !== null && tq >= node.exit.end) continue;
      const nodeFigure = node.figure;
      const x = nodeFigure.x === undefined ? null : markX(model, nodeFigure.x);
      const y = nodeFigure.y ?? null;
      if (x === null && y === null) continue;
      const from = node.enter?.start ?? 0;
      const span = node.enter === null ? 0 : node.enter.end - node.enter.start;
      marks.push({ key: node.key, x, y, label: node.text, arrived: node.enter === null || span <= 0 ? (tq >= from ? 1 : 0) : clamp01((tq - from) / span) });
    }

    const theme = themeOf(look, env.viewport);
    const interactive = !coming && !going && !waiting && !failed && reveal >= 1 && opacity >= 0.99;
    const signature = [figure.chart, figure.words.join(','), element.text, look.id, look.name, `${env.viewport.width}x${env.viewport.height}`, reveal.toFixed(3), landed, interactive ? 1 : 0, waiting ? 1 : 0, failed ? 1 : 0, env.reducedMotion ? 1 : 0, marks.map((mark) => `${mark.key}:${mark.x}:${mark.y}:${mark.label}:${mark.arrived.toFixed(2)}`).join(';'), model.points.length, model.series.length].join('|');
    live.add(element.key);
    const kept = states.get(element.key);
    let state: ChartState;
    if (kept !== undefined && kept.signature === signature && (kept.state.model === model) && kept.state.theme === theme) state = kept.state;
    else {
      state = { kind: figure.chart, words: figure.words, title: element.text, model, marks, theme, reveal, landed, interactive, waiting, failed, reducedMotion: env.reducedMotion };
      states.set(element.key, { signature, state });
    }
    out.push({ key: element.key, id: element.id, layer: element.style.layer, z: element.order, box, rest, opacity, state, tappable: false });
  }
  if (states.size > 64) for (const key of [...states.keys()]) if (!live.has(key)) states.delete(key);
  return out;
}
