// What is drawn over the plot, on the chart's own canvas so that its still carries it: the header, marks (an event is a
// labelled vertical line, a level a labelled horizontal one, a point a marker), the starred point, the live point, the
// words of the waiting and failed states, and the frame of a look whose chart is a panel. Pure canvas work: the engine
// gives it where things are (`Geometry`) and it draws.

import type { ChartMark, ChartState, ChartTheme } from '../../contracts/chart';
import { fitText, fontOf, paintHeader } from './header';
import type { Header, Readout } from './header';
import type { Drawn, Plot } from './plot';
import { rgba } from './tint';

/** Where things are on the chart, in CSS pixels; null where the engine cannot say (off the scale, before the first layout). */
export interface Geometry {
  /** a place on the model's own x axis; fractions are laid between the neighbouring slots */
  xOf(x: number): number | null;
  /** the middle of a slot */
  slotX(slot: number): number | null;
  /** a price on the main scale */
  yOf(price: number): number | null;
}

export interface Scene {
  readonly state: ChartState;
  readonly plot: Plot;
  readonly drawn: Drawn | null;
  readonly header: Header;
  readonly readout: Readout | null;
  readonly geometry: Geometry;
  /** the bottom of the plot, where the time axis begins */
  readonly axisBottom: number;
  readonly hasScale: boolean;
  readonly now: number;
}

/** A rectangle some words have taken, so that the next mark's words stand clear of it. */
interface Taken {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Words over a plot are set with a halo in the ground, so a gridline or a candle does not strike through them. */
function halo(ctx: CanvasRenderingContext2D, theme: ChartTheme, text: string, x: number, y: number, alpha: number): void {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = rgba(theme.ground, 0.92 * alpha);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = rgba(theme.ink, alpha);
  ctx.fillText(text, x, y);
}

/** The words set in lines no wider than `width`; a word wider than that is cut with an ellipsis as a last resort. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, most: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const tryLine = line === '' ? word : `${line} ${word}`;
    if (line !== '' && ctx.measureText(tryLine).width > width) {
      lines.push(line);
      line = word;
    } else line = tryLine;
  }
  if (line !== '') lines.push(line);
  const kept = lines.slice(0, most);
  if (lines.length > most) kept[most - 1] = fitText(ctx, `${kept[most - 1] ?? ''} ${lines.slice(most).join(' ')}`, width);
  return kept.map((l) => fitText(ctx, l, width));
}

/** The data as short straight segments in CSS pixels: what words must not be laid across. */
function dataSegments(scene: Scene): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  const { plot, geometry } = scene;
  const out: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  for (const series of plot.series) {
    if (series.colour < 0) continue;
    let last: { x: number; y: number } | null = null;
    plot.axis.kept.forEach((slot, j) => {
      const v = series.values[plot.axis.keptPoint[j] ?? 0];
      const x = geometry.slotX(slot);
      const y = v === null || v === undefined ? null : geometry.yOf(v);
      if (x === null || y === null) {
        last = null;
        return;
      }
      const here = { x, y };
      if (last !== null) out.push({ a: last, b: here });
      last = here;
    });
  }
  return out;
}

/** A segment passes through a rectangle (padded). */
function crosses(a: { x: number; y: number }, b: { x: number; y: number }, r: Taken, pad: number): boolean {
  const x0 = r.x - pad;
  const y0 = r.y - pad;
  const x1 = r.x + r.w + pad;
  const y1 = r.y + r.h + pad;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function drawMarks(ctx: CanvasRenderingContext2D, scene: Scene, width: number, plotTop: number): void {
  const { state, geometry } = scene;
  const theme = state.theme;
  const px = theme.fontPx;
  ctx.font = fontOf(theme, px);
  ctx.textBaseline = 'alphabetic';
  const step = px + 4;
  // the rules first, all of them, so that no rule is drawn over words set after it
  const ruleXs: { mark: ChartMark; x: number }[] = [];
  for (const mark of state.marks) {
    if (mark.arrived <= 0) continue;
    if (mark.x !== null && mark.y === null) {
      const x = geometry.xOf(mark.x);
      if (x === null || x < 0 || x > width) continue;
      const at = Math.round(x) + 0.5;
      ruleXs.push({ mark, x: at });
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(theme.crosshair, 0.9 * mark.arrived);
      ctx.beginPath();
      ctx.moveTo(at, plotTop);
      ctx.lineTo(at, scene.axisBottom);
      ctx.stroke();
    } else if (mark.x === null && mark.y !== null && scene.hasScale) levelRule(ctx, scene, mark, geometry, width, plotTop);
  }
  const segments = dataSegments(scene);
  const taken: Taken[] = [];
  for (const { mark, x } of ruleXs) eventLabel(ctx, scene, mark, x, width, plotTop, taken, step, ruleXs, segments);
  for (const mark of state.marks) {
    if (mark.arrived <= 0) continue;
    if (mark.x === null && mark.y !== null && scene.hasScale) levelLabel(ctx, scene, mark, geometry, plotTop);
    else if (mark.x !== null && mark.y !== null && scene.hasScale) pointMark(ctx, scene, mark, geometry, width, plotTop);
  }
}

/**
 * An event's words go where nothing is: on the side of their rule that has room, on the first row from the top that no other words, no other
 * rule and no stretch of the data crosses; wrapped to two or three lines before they are ever cut.
 */
function eventLabel(ctx: CanvasRenderingContext2D, scene: Scene, mark: ChartMark, px: number, width: number, plotTop: number, taken: Taken[], step: number, rules: readonly { mark: ChartMark; x: number }[], segments: ReturnType<typeof dataSegments>): void {
  const theme = scene.state.theme;
  const roomRight = width - px - 10;
  const roomLeft = px - 10;
  const rows = Math.max(1, Math.floor((scene.axisBottom - plotTop - 8) / step));
  let best: { x: number; y: number; lines: string[]; w: number; h: number; left: boolean; cost: number } | null = null;
  for (const left of roomRight >= roomLeft ? [false, true] : [true, false]) {
    const room = left ? roomLeft : roomRight;
    if (room < 56) continue;
    for (const most of [1, 2, 3]) {
      const lines = wrap(ctx, mark.label, Math.min(room, 300), most);
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const h = lines.length * step;
      for (let row = 0; row + lines.length <= rows; row += 1) {
        const rect: Taken = { x: left ? px - 5 - w : px + 5, y: plotTop + 4 + row * step, w, h };
        let cost = 0;
        if (taken.some((t) => rect.x < t.x + t.w + 6 && rect.x + rect.w > t.x - 6 && rect.y < t.y + t.h + 2 && rect.y + rect.h > t.y - 2)) cost += 100;
        if (rules.some((r) => r.mark !== mark && r.x > rect.x - 3 && r.x < rect.x + rect.w + 3)) cost += 40;
        if (segments.some((s) => crosses(s.a, s.b, rect, 2))) cost += 30;
        // words cut short are worse than words wrapped over more lines
        if (lines.join(' ') !== mark.label.trim().replace(/\s+/g, ' ')) cost += 25;
        cost += (lines.length - 1) * 2 + row * 0.2;
        if (best === null || cost < best.cost) best = { x: rect.x, y: rect.y, lines, w, h, left, cost };
        if (cost < 3) break;
      }
      if (best !== null && best.cost < 3) break;
    }
    if (best !== null && best.cost < 3) break;
  }
  if (best === null) return;
  taken.push({ x: best.x, y: best.y, w: best.w, h: best.h });
  ctx.textAlign = best.left ? 'right' : 'left';
  best.lines.forEach((line, i) => halo(ctx, theme, line, best.left ? best.x + best.w : best.x, best.y + theme.fontPx + 2 + i * step, mark.arrived));
  ctx.textAlign = 'left';
}

function levelRule(ctx: CanvasRenderingContext2D, scene: Scene, mark: ChartMark, geometry: Geometry, width: number, plotTop: number): void {
  const theme = scene.state.theme;
  const y = mark.y === null ? null : geometry.yOf(mark.y);
  if (y === null || y < plotTop || y > scene.axisBottom) return;
  const py = Math.round(y) + 0.5;
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(theme.crosshair, 0.9 * mark.arrived);
  ctx.beginPath();
  ctx.moveTo(0, py);
  ctx.lineTo(width, py);
  ctx.stroke();
}

function levelLabel(ctx: CanvasRenderingContext2D, scene: Scene, mark: ChartMark, geometry: Geometry, plotTop: number): void {
  const theme = scene.state.theme;
  const y = mark.y === null ? null : geometry.yOf(mark.y);
  if (y === null || y < plotTop || y > scene.axisBottom) return;
  ctx.textAlign = 'left';
  halo(ctx, theme, mark.label, 8, Math.round(y) + 0.5 - 5, mark.arrived);
}

function pointMark(ctx: CanvasRenderingContext2D, scene: Scene, mark: ChartMark, geometry: Geometry, width: number, plotTop: number): void {
  const theme = scene.state.theme;
  const x = mark.x === null ? null : geometry.xOf(mark.x);
  const y = mark.y === null ? null : geometry.yOf(mark.y);
  if (x === null || y === null) return;
  ctx.fillStyle = rgba(theme.accent, mark.arrived);
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  const w = ctx.measureText(mark.label).width;
  const flip = x + 8 + w > width - 4;
  const below = y - 12 < plotTop + 4;
  ctx.textAlign = flip ? 'right' : 'left';
  halo(ctx, theme, mark.label, flip ? x - 8 : x + 8, below ? y + theme.fontPx + 4 : y - 8, mark.arrived);
  ctx.textAlign = 'left';
}

function drawPoints(ctx: CanvasRenderingContext2D, scene: Scene, spark: boolean): void {
  const { state, plot, drawn, geometry } = scene;
  if (drawn === null) return;
  const theme = state.theme;
  const first = plot.series.find((s) => s.draw === 'line' || s.draw === 'area');
  if (first === undefined) return;
  const axis = plot.axis;
  // the starred points of a line: the ones that matter
  if (!spark) {
    axis.kept.forEach((slot, j) => {
      const p = axis.keptPoint[j] ?? 0;
      if (state.model.points[p]?.starred !== true || slot > drawn.toSlot) return;
      const x = geometry.slotX(slot);
      const v = first.values[p];
      const y = v === null || v === undefined ? null : geometry.yOf(v);
      if (x === null || y === null) return;
      ctx.fillStyle = theme.accent;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  // the live point: one soft pulse, still in reduced motion
  if (state.words.includes('live') && drawn.landed > 0) {
    const j = drawn.landed - 1;
    const p = axis.keptPoint[j] ?? 0;
    const v = first.values[p];
    const x = geometry.slotX(axis.kept[j] ?? 0);
    const y = v === null || v === undefined ? null : geometry.yOf(v);
    if (x !== null && y !== null && drawn.toSlot >= (axis.kept[j] ?? 0)) {
      const colour = theme.series[0] ?? theme.accent;
      const phase = state.reducedMotion || !state.interactive ? 0 : (scene.now % 1800) / 1800;
      if (phase > 0) {
        ctx.strokeStyle = rgba(colour, 0.5 * (1 - phase));
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 4 + phase * 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Paints everything the engine does not: the context is in CSS pixels. */
export function paintOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, scene: Scene, framed: boolean): void {
  const { state, plot } = scene;
  const theme = state.theme;
  const spark = scene.header.height === 0;
  const plotTop = scene.header.height;
  ctx.save();
  paintHeader(ctx, scene.header, theme, scene.readout);

  if (state.failed || state.waiting || plot.series.length === 0) {
    // between two gridlines, so that a line does not strike through the words
    ctx.font = fontOf(theme, theme.fontPx);
    ctx.fillStyle = theme.crosshair;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const body = scene.axisBottom - plotTop;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i += 1) {
      const gy = Math.round(plotTop + (body * i) / 5) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }
    ctx.fillText(state.failed ? 'the data could not be had' : 'waiting for the rows', 8, plotTop + (body * 2.5) / 5);
  } else {
    drawMarks(ctx, scene, width, plotTop);
    drawPoints(ctx, scene, spark);
  }
  if (framed) {
    ctx.strokeStyle = theme.crosshair;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  }
  ctx.restore();
}
