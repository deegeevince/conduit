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

/** A line of marks' words that has been taken, so that the next mark whose words would meet them goes down a line. */
interface Taken {
  readonly from: number;
  readonly to: number;
  readonly row: number;
}

/** Words over a plot are set with a halo in the ground, so a gridline or a candle does not strike through them. */
function halo(ctx: CanvasRenderingContext2D, theme: ChartTheme, text: string, x: number, y: number, alpha: number): void {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = rgba(theme.ground, 0.85 * alpha);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = rgba(theme.ink, alpha);
  ctx.fillText(text, x, y);
}

function drawMarks(ctx: CanvasRenderingContext2D, scene: Scene, width: number, plotTop: number): void {
  const { state, geometry } = scene;
  const theme = state.theme;
  const px = theme.fontPx;
  ctx.font = fontOf(theme, px);
  ctx.textBaseline = 'alphabetic';
  const taken: Taken[] = [];
  const step = px + 4;
  for (const mark of state.marks) {
    const alpha = mark.arrived;
    if (alpha <= 0) continue;
    if (mark.x !== null && mark.y === null) eventMark(ctx, scene, mark, geometry, width, plotTop, taken, step);
    else if (mark.x === null && mark.y !== null && scene.hasScale) levelMark(ctx, scene, mark, geometry, width, plotTop);
    else if (mark.x !== null && mark.y !== null && scene.hasScale) pointMark(ctx, scene, mark, geometry, width, plotTop);
  }
}

function eventMark(ctx: CanvasRenderingContext2D, scene: Scene, mark: ChartMark, geometry: Geometry, width: number, plotTop: number, taken: Taken[], step: number): void {
  const theme = scene.state.theme;
  const x = mark.x === null ? null : geometry.xOf(mark.x);
  if (x === null || x < 0 || x > width) return;
  const px = Math.round(x) + 0.5;
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(theme.crosshair, 0.9 * mark.arrived);
  ctx.beginPath();
  ctx.moveTo(px, plotTop);
  ctx.lineTo(px, scene.axisBottom);
  ctx.stroke();
  // the words go to whichever side of the line has room, and are cut with an ellipsis if neither has enough
  const roomRight = width - px - 10;
  const roomLeft = px - 10;
  const full = ctx.measureText(mark.label).width;
  const flip = full > roomRight && roomLeft > roomRight;
  const text = fitText(ctx, mark.label, Math.max(40, flip ? roomLeft : roomRight));
  const w = ctx.measureText(text).width;
  const from = flip ? px - 5 - w : px + 5;
  // two events whose words would meet: the later one goes down a line
  let row = 0;
  while (taken.some((t) => t.row === row && from < t.to + 6 && from + w > t.from - 6)) row += 1;
  taken.push({ from, to: from + w, row });
  ctx.textAlign = flip ? 'right' : 'left';
  halo(ctx, theme, text, flip ? px - 5 : px + 5, plotTop + theme.fontPx + 2 + row * step, mark.arrived);
  ctx.textAlign = 'left';
}

function levelMark(ctx: CanvasRenderingContext2D, scene: Scene, mark: ChartMark, geometry: Geometry, width: number, plotTop: number): void {
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
  ctx.textAlign = 'left';
  halo(ctx, theme, mark.label, 8, py - 5, mark.arrived);
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
