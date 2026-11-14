// A strip of cells that cannot hold its words. A row of equal boxes on the canvas (months, days, a number line) each with a word in it is
// squeezed on a phone: the canvas is as wide as the screen, so a cell can be narrower than the word it holds. The rule is that a word never
// leaves its box, so before the type goes down the row wraps into more rows, in reading order, with the cells as wide as the strip allows
// (12 cells become 2 rows of 6). Words set under or over a cell go with it, and what stands below the strip is moved down to make room.
// Pure: a schedule in, a schedule out (the same one when nothing needs to change).

import { CANVAS } from '@conduit/language';
import type { ElementChange, ElementSpan, ElementStyle, Point, Schedule, ShapeGeometry } from '@conduit/language';
import type { LookSpec } from '../contracts/look';
import type { Viewport } from '../contracts/space';
import { measureEm } from '../fonts/measure';
import { fitCanvas } from './canvas';
import { cellOf } from './layout/metrics';

/** a strip has at least this many cells */
const MIN_CELLS = 3;
/** the most rows a strip is wrapped into */
const MAX_ROWS = 4;
/** room a word keeps either side inside its cell, in ems */
const PAD_EM = 0.3;
const EPS = 0.02;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Strip {
  readonly cells: { readonly el: ElementSpan; readonly rect: Rect; readonly word: ElementSpan | null }[];
  readonly gap: number;
}

const cache = new WeakMap<Schedule, { readonly key: string; readonly result: Schedule }>();

function rectOf(el: ElementSpan): Rect | null {
  const f = el.figure;
  if (f === null || f.kind !== 'shape') return null;
  const g = f.geometry;
  if (g.shape !== 'rect' || g.full) return null;
  return { x: g.x, y: g.y, w: g.w, h: g.h };
}

function pointOf(el: ElementSpan): Point | null {
  const at = el.style.at;
  return at !== null && typeof at === 'object' ? at : null;
}

/** words never touched by a change that moves or reshapes them */
const still = (el: ElementSpan): boolean => !el.changes.some((c) => c.kind === 'move' || c.kind === 'morph');

export function wrapStrips(schedule: Schedule, viewport: Viewport, look: LookSpec): Schedule {
  const key = `${viewport.width}x${viewport.height}:`;
  const hit = cache.get(schedule);
  if (hit !== undefined && hit.key === key) return hit.result;
  const result = openRows(rewrite(schedule, viewport, look), viewport, look);
  cache.set(schedule, { key, result });
  return result;
}

function rewrite(schedule: Schedule, viewport: Viewport, look: LookSpec): Schedule {
  const replaced = new Map<string, ElementSpan>();
  for (const scene of schedule.scenes) {
    const here = schedule.elements.filter((el) => el.scene === scene.id && !el.carried);
    const shapes = here.filter((el) => el.kind === 'shape' && el.style.layer === 'mid' && still(el) && rectOf(el) !== null);
    if (shapes.length < MIN_CELLS) continue;
    const words = here.filter((el) => el.kind === 'text' && el.parent === null && still(el) && el.style.group === null && el.style.near === null && pointOf(el) !== null && el.replaces === null);
    const fit = fitCanvas(scene.canvas, scene.layout, viewport, look);
    const unit = fit.unit * 0.92;
    const canvas = CANVAS[scene.canvas];
    // runs of equal cells on one line at an even stride
    const lines = new Map<string, ElementSpan[]>();
    for (const el of shapes) {
      const r = rectOf(el) as Rect;
      const k = `${r.y.toFixed(2)}:${r.w.toFixed(2)}:${r.h.toFixed(2)}`;
      lines.set(k, [...(lines.get(k) ?? []), el]);
    }
    const strips: Strip[] = [];
    for (const group of lines.values()) {
      const sorted = [...group].sort((a, b) => (rectOf(a) as Rect).x - (rectOf(b) as Rect).x);
      let run: ElementSpan[] = [];
      let stride = 0;
      const flush = (): void => {
        if (run.length >= MIN_CELLS) {
          const cells = run.map((el) => {
            const rect = rectOf(el) as Rect;
            const inside = words.filter((w) => {
              const p = pointOf(w) as Point;
              return p.x >= rect.x - EPS && p.x <= rect.x + rect.w + EPS && p.y >= rect.y - EPS && p.y <= rect.y + rect.h + EPS;
            });
            return { el, rect, word: inside.length === 1 ? (inside[0] as ElementSpan) : null, count: inside.length };
          });
          if (cells.every((c) => c.count <= 1) && cells.filter((c) => c.word !== null).length >= MIN_CELLS) {
            const r0 = cells[0]?.rect as Rect;
            strips.push({ cells: cells.map(({ el: e, rect, word }) => ({ el: e, rect, word })), gap: Math.max(0, stride - r0.w) });
          }
        }
        run = [];
      };
      for (const el of sorted) {
        const r = rectOf(el) as Rect;
        const prev = run[run.length - 1];
        if (prev === undefined) {
          run = [el];
          stride = 0;
          continue;
        }
        const pr = rectOf(prev) as Rect;
        const s = r.x - pr.x;
        if (s < r.w - EPS || (run.length > 1 && Math.abs(s - stride) > EPS) || s > 2 * r.w) {
          flush();
          run = [el];
          stride = 0;
        } else {
          stride = s;
          run.push(el);
        }
      }
      flush();
    }
    for (const strip of strips) wrapOne(strip, { schedule, scene: scene.id, unit, canvasH: canvas.height, look, viewport, words, replaced });
  }
  if (replaced.size === 0) return schedule;
  return { ...schedule, elements: schedule.elements.map((el) => replaced.get(el.key) ?? el) };
}

interface Ctx {
  readonly schedule: Schedule;
  readonly scene: string;
  /** screen pixels per canvas unit */
  readonly unit: number;
  readonly canvasH: number;
  readonly look: LookSpec;
  readonly viewport: Viewport;
  readonly words: readonly ElementSpan[];
  readonly replaced: Map<string, ElementSpan>;
}

function widthPx(text: string, px: number, el: ElementSpan, look: LookSpec): number {
  if (look.type.pitch === 'fixed') return text.length * look.type.advance * px;
  return measureEm(text, el.style.face ?? look.type.face, el.style.weight) * px;
}

function wrapOne(strip: Strip, ctx: Ctx): void {
  const { cells, gap } = strip;
  const n = cells.length;
  const first = cells[0]?.rect as Rect;
  const last = cells[n - 1]?.rect as Rect;
  const total = last.x + last.w - first.x;
  // the widest word, at the size it is asked for and at the least it may be set
  let natural = 0;
  let floorW = 0;
  for (const c of cells) {
    if (c.word === null) continue;
    const px = Math.max(ctx.look.type.minFont, cellOf(c.word.style.size, ctx.viewport, ctx.look).fontSize);
    natural = Math.max(natural, widthPx(c.word.text, px, c.word, ctx.look) + 2 * PAD_EM * px);
    floorW = Math.max(floorW, widthPx(c.word.text, ctx.look.type.minFont, c.word, ctx.look) + 2 * PAD_EM * ctx.look.type.minFont);
  }
  const widthFor = (rows: number): number => {
    const per = Math.ceil(n / rows);
    return ((total - gap * (per - 1)) / per) * ctx.unit;
  };
  if (widthFor(1) >= natural) return;
  let rows = 2;
  while (rows < Math.min(MAX_ROWS, n) && widthFor(rows) < natural) rows += 1;
  if (widthFor(rows) < floorW && rows >= Math.min(MAX_ROWS, n)) rows = Math.min(MAX_ROWS, n);
  const per = Math.ceil(n / rows);
  rows = Math.ceil(n / per);
  const cellW = (total - gap * (per - 1)) / per;

  // words set just under or over a cell belong to it and move with it
  const reach = 2.2 * first.h;
  const cellOfWord = new Map<string, number>();
  for (const w of ctx.words) {
    if (cells.some((c) => c.word === w)) continue;
    const p = pointOf(w) as Point;
    const idx = cells.findIndex((c) => p.x >= c.rect.x - EPS && p.x <= c.rect.x + c.rect.w + EPS && ((p.y > c.rect.y + c.rect.h && p.y <= c.rect.y + c.rect.h + reach) || (p.y < c.rect.y && p.y >= c.rect.y - reach)));
    if (idx >= 0) cellOfWord.set(w.key, idx);
  }
  // words under or over a cell stay with it; the rows are kept apart by no more than the pitch of a line, so that what the layout slides about on a small
  // screen is not given a gap to fall into
  const tops: number[] = [];
  let y = first.y;
  for (let r = 0; r < rows; r += 1) {
    if (r > 0) y += gap;
    tops.push(y);
    y += first.h;
  }
  const bottom = (tops[rows - 1] as number) + first.h;
  const was = first.y + first.h;
  const growth = bottom - was;

  const slot = (i: number): { x: number; y: number } => ({ x: first.x + (i % per) * (cellW + gap), y: tops[Math.floor(i / per)] as number });
  const set = (el: ElementSpan, next: ElementSpan): void => {
    ctx.replaced.set(el.key, next);
  };
  const withAt = (el: ElementSpan, f: (p: Point) => Point): ElementSpan => {
    const fix = (s: ElementStyle): ElementStyle => {
      const p = s.at !== null && typeof s.at === 'object' ? s.at : null;
      return p === null ? s : { ...s, at: f(p) };
    };
    const changes: ElementChange[] = el.changes.map((c) => ('style' in c ? { ...c, style: fix(c.style) } : c));
    return { ...el, style: fix(el.style), changes };
  };

  cells.forEach((c, i) => {
    const s = slot(i);
    const g = (c.el.figure as { kind: 'shape'; geometry: ShapeGeometry }).geometry;
    if (g.shape !== 'rect') return;
    const geometry: ShapeGeometry = { ...g, x: s.x, y: s.y, w: cellW };
    set(c.el, { ...c.el, figure: { kind: 'shape', geometry } as ElementSpan['figure'] });
    if (c.word !== null) {
      const dx = s.x + cellW / 2 - (pointOf(c.word) as Point).x;
      const dy = s.y - c.rect.y;
      set(c.word, withAt(c.word, (p) => ({ x: p.x + dx, y: p.y + dy })));
    }
  });
  for (const [k, idx] of cellOfWord) {
    const w = ctx.words.find((e) => e.key === k) as ElementSpan;
    const c = cells[idx] as Strip['cells'][number];
    const s = slot(idx);
    const oldMid = c.rect.x + c.rect.w / 2;
    const dx = s.x + cellW / 2 - oldMid;
    const dy = s.y - c.rect.y;
    set(w, withAt(w, (p) => ({ x: p.x + dx, y: p.y + dy })));
  }

  // what stands below the strip moves down to make room; when the canvas has not the room, what is below is set closer together
  if (growth <= 0) return;
  const room = ctx.canvasH - was;
  const k = room > growth ? Math.max(0.55, (room - growth - 2) / room) : 0.55;
  const mapY = (v: number): number => (v < was - EPS ? v : was + growth + (v - was) * k);
  for (const w of ctx.words) {
    if (ctx.replaced.has(w.key)) continue;
    const p = pointOf(w) as Point;
    if (p.y < was) continue;
    set(w, withAt(w, (pt) => ({ x: pt.x, y: mapY(pt.y) })));
  }
  const taken = new Set(cells.map((c) => c.el.key));
  for (const el of ctx.schedule.elements) {
    if (el.scene !== ctx.scene || el.kind !== 'shape' || taken.has(el.key) || !still(el)) continue;
    const r = rectOf(el);
    if (r === null || r.y < was - EPS) continue;
    const y0 = mapY(r.y);
    const y1 = mapY(r.y + r.h);
    const g = (el.figure as { kind: 'shape'; geometry: ShapeGeometry }).geometry;
    if (g.shape !== 'rect') continue;
    set(el, { ...el, figure: { kind: 'shape', geometry: { ...g, y: y0, h: y1 - y0 } } as ElementSpan['figure'] });
  }
}


// ---------------------------------------------------------------------------
// Rows of words set on a drawn table. A table drawn by hand (a box, rules, and a word at the middle of each cell) is spaced for a canvas as wide
// as a desk; on a phone the canvas is small and the rows are closer together than a line of words is tall, so they stand on one another. The
// rows keep their own height: the table's band is stretched up and down until one row clears the next, and what is below it moves down.

const ROW_TOL = 0.5;
const PITCH_TOL = 1.6;
const NEED = 1.0;
const MAX_STRETCH = 2;

type Mapper = (y: number) => number;

function mapStyleAt(style: ElementStyle, f: Mapper): ElementStyle {
  const at = style.at;
  return at !== null && typeof at === 'object' ? { ...style, at: { x: at.x, y: f(at.y) } } : style;
}

function mapGeometry(g: ShapeGeometry, f: Mapper): ShapeGeometry | null {
  switch (g.shape) {
    case 'rect': {
      if (g.full) return g;
      const y0 = f(g.y);
      return { ...g, y: y0, h: f(g.y + g.h) - y0 };
    }
    case 'circle':
      return { ...g, cy: f(g.cy) };
    case 'ellipse':
      return { ...g, cy: f(g.cy) };
    case 'line':
    case 'poly':
      return { ...g, points: g.points.map((p) => ({ x: p.x, y: f(p.y) })) };
    default:
      return null;
  }
}

function mapElement(el: ElementSpan, f: Mapper): ElementSpan | null {
  let figure = el.figure;
  if (figure !== null && figure.kind === 'shape') {
    const g = mapGeometry(figure.geometry, f);
    if (g === null) return null;
    figure = { ...figure, geometry: g };
  } else if (figure !== null && figure.kind === 'structure' && figure.box !== null) {
    const y0 = f(figure.box.y);
    figure = { ...figure, box: { ...figure.box, y: y0, h: f(figure.box.y + figure.box.h) - y0 } };
  } else if (figure !== null && figure.kind !== 'structure') {
    return null;
  }
  const changes: ElementChange[] = [];
  for (const c of el.changes) {
    if (c.kind === 'morph') {
      const g = mapGeometry(c.geometry, f);
      if (g === null) return null;
      changes.push({ ...c, geometry: g, style: mapStyleAt(c.style, f) });
    } else if (c.kind === 'move') {
      if (c.along !== null || typeof c.to !== 'object') return null;
      changes.push({ ...c, to: { x: c.to.x, y: f(c.to.y) }, style: mapStyleAt(c.style, f) });
    } else if (c.kind === 'set') {
      changes.push({ ...c, style: mapStyleAt(c.style, f) });
    } else changes.push(c);
  }
  return { ...el, figure, style: mapStyleAt(el.style, f), changes };
}

function openRows(schedule: Schedule, viewport: Viewport, look: LookSpec): Schedule {
  const replaced = new Map<string, ElementSpan>();
  for (const scene of schedule.scenes) {
    const here = schedule.elements.filter((el) => el.scene === scene.id && !el.carried);
    const words = here.filter((el) => el.kind === 'text' && el.parent === null && still(el) && el.style.group === null && el.style.near === null && pointOf(el) !== null && el.replaces === null && ['xs', 's', 'm'].includes(el.style.size));
    if (words.length < 6) continue;
    // rows: words at one height, two or more of them side by side
    const byY = new Map<number, ElementSpan[]>();
    for (const w of words) {
      const y = (pointOf(w) as Point).y;
      const k = [...byY.keys()].find((v) => Math.abs(v - y) <= ROW_TOL);
      if (k === undefined) byY.set(y, [w]);
      else (byY.get(k) as ElementSpan[]).push(w);
    }
    const rows = [...byY.entries()].filter(([, ws]) => new Set(ws.map((w) => Math.round((pointOf(w) as Point).x))).size >= 2).sort((a, b) => a[0] - b[0]);
    if (rows.length < 3) continue;
    // the longest run of rows at an even pitch
    let best: typeof rows = [];
    let run: typeof rows = [];
    for (const row of rows) {
      const prev = run[run.length - 1];
      const before = run[run.length - 2];
      const step = prev === undefined ? 0 : row[0] - prev[0];
      const stepBefore = prev === undefined || before === undefined ? step : prev[0] - before[0];
      if (prev !== undefined && step <= 2.5 * Math.max(stepBefore, 1) && Math.abs(step - stepBefore) <= PITCH_TOL && step > 0) run.push(row);
      else run = prev !== undefined && step > 0 && step <= 14 ? [prev, row] : [row];
      if (run.length > best.length) best = run;
    }
    if (best.length < 3) continue;
    const ys = best.map((r) => r[0]);
    const pitch = (ys[ys.length - 1] as number - (ys[0] as number)) / (ys.length - 1);
    const fit = fitCanvas(scene.canvas, scene.layout, viewport, look);
    const unit = fit.unit * 0.92;
    const line = Math.max(...best.flatMap((r) => r[1]).map((w) => cellOf(w.style.size, viewport, look).height));
    const wanted = (NEED * line) / unit;
    if (pitch >= wanted) continue;
    const s = Math.min(MAX_STRETCH, wanted / pitch);
    const b0 = (ys[0] as number) - pitch / 2;
    const b1 = (ys[ys.length - 1] as number) + pitch / 2;
    const f: Mapper = (y) => (y <= b0 ? y : y >= b1 ? y + (s - 1) * (b1 - b0) : b0 + (y - b0) * s);
    const batch = new Map<string, ElementSpan>();
    let ok = true;
    for (const el of here) {
      if (el.kind === 'text' || el.kind === 'shape') {
        const next = mapElement(el, f);
        if (next === null) {
          ok = false;
          break;
        }
        batch.set(el.key, next);
      }
    }
    if (!ok) continue;
    for (const [k, v] of batch) replaced.set(k, v);
  }
  if (replaced.size === 0) return schedule;
  return { ...schedule, elements: schedule.elements.map((el) => replaced.get(el.key) ?? el) };
}
