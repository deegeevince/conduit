// Screens, stood side by side and scaled together to their room (PLAN-v2.2 E13). Several screens are one thing: a
// journey. They stand at their true proportions, in the order written, as large as the room lets them all be; `from=`
// draws the arrow. When the room is too narrow for them all to be read (a phone), the board shows one screen large and
// the rest as a strip of small ones, and a tap on a small one brings it forward.
//
// Pure: it takes the screens' shapes and the room and gives shapes in the room's own pixels.

import type { UiTokens } from './lang';
import { deviceShape } from './device';
import type { DeviceShape } from './device';
import type { UiMeasure } from './measure';
import type { UiClip, UiPart, UiScreenLayout } from './types';

export interface BoardPlacement {
  readonly id: string;
  readonly index: number;
  /** the device's outer top-left in the room, pixels */
  readonly x: number;
  readonly y: number;
  /** pixels per point */
  readonly scale: number;
  /** where the screen's own top-left is, pixels */
  readonly contentX: number;
  readonly contentY: number;
  readonly width: number;
  readonly height: number;
}

export interface Board {
  readonly parts: readonly UiPart[];
  readonly placements: readonly BoardPlacement[];
  readonly mode: 'overview' | 'focus';
  readonly focus: number;
  /** the smallest scale any screen is drawn at: what the type's smallest size is a share of */
  readonly scale: number;
}

export interface BoardOptions {
  readonly mode: 'overview' | 'focus';
  readonly focus: number;
  readonly margin: number;
}

const LABEL_H = 24;
const GAP = 52;

/** A shape's own clip (a row that moves keeps what is in it inside its box), moved and scaled with it. */
function scaleClip<T extends UiPart>(p: T, s: number, ox: number, oy: number): T {
  return p.clip === undefined ? p : { ...p, clip: { x: ox + p.clip.x * s, y: oy + p.clip.y * s, w: p.clip.w * s, h: p.clip.h * s } };
}

/** The part of two boxes they share. */
function overlap(a: UiClip, b: UiClip): UiClip {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x0), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y0) };
}

/** Moves and scales one shape from points to pixels. */
export function scalePart(p: UiPart, s: number, ox: number, oy: number): UiPart {
  switch (p.kind) {
    case 'rect':
      return {
        ...scaleClip(p, s, ox, oy),
        x: ox + p.x * s,
        y: oy + p.y * s,
        w: p.w * s,
        h: p.h * s,
        radius: p.radius * s,
        edge: p.edge === null ? null : { ...p.edge, width: p.edge.width * s, ...(p.edge.dash === undefined ? {} : { dash: [p.edge.dash[0] * s, p.edge.dash[1] * s] as const }) },
        ...(p.shadow === undefined ? {} : { shadow: { ...p.shadow, dy: p.shadow.dy * s, blur: p.shadow.blur * s } }),
      };
    case 'path':
      return { ...scaleClip(p, s, ox, oy), outline: p.outline.map((l) => ({ closed: l.closed, points: l.points.map((q) => ({ x: ox + q.x * s, y: oy + q.y * s })) })), stroke: p.stroke === null ? null : { ...p.stroke, width: p.stroke.width * s } };
    case 'picture':
      return { ...scaleClip(p, s, ox, oy), x: ox + p.x * s, y: oy + p.y * s, w: p.w * s, h: p.h * s };
    case 'text':
      return { ...scaleClip(p, s, ox, oy), x: ox + p.x * s, y: oy + p.y * s, w: p.w * s, h: p.h * s, size: p.size * s, line: p.line * s, lines: p.lines.map((l) => ({ text: l.text, width: l.width * s })) };
  }
}

interface Card {
  readonly layout: UiScreenLayout;
  readonly shape: DeviceShape;
}

function bestGrid(sizes: readonly { w: number; h: number }[], room: { w: number; h: number }, margin: number): { cols: number; scale: number } {
  let best = { cols: 1, scale: 0 };
  for (let cols = 1; cols <= sizes.length; cols++) {
    const rows = Math.ceil(sizes.length / cols);
    let widest = 0;
    let tall = 0;
    for (let r = 0; r < rows; r++) {
      const row = sizes.slice(r * cols, r * cols + cols);
      widest = Math.max(widest, row.reduce((s, z) => s + z.w, 0));
      tall += Math.max(...row.map((z) => z.h));
    }
    // gaps are 64 points between devices and 64 between rows, and scale with them; labels are a fixed 24 pixels
    const gapsW = (cols - 1) * GAP;
    const gapsH = (rows - 1) * GAP;
    const sw = (room.w - 2 * margin) / (widest + gapsW);
    const sh = (room.h - 2 * margin - rows * LABEL_H) / (tall + gapsH);
    const scale = Math.min(sw, sh, 1);
    if (scale > best.scale + 1e-9) best = { cols, scale };
  }
  return best;
}

export function arrangeBoard(layouts: readonly UiScreenLayout[], tokens: UiTokens, measure: UiMeasure, room: { readonly w: number; readonly h: number }, options: BoardOptions): Board {
  const cards: Card[] = layouts.map((layout) => ({ layout, shape: deviceShape(layout.device as Parameters<typeof deviceShape>[0], layout.name, layout.tokens, measure, layout.id, layout.height) }));
  const parts: UiPart[] = [];
  const placements: BoardPlacement[] = [];
  const dark = lum(tokens.colour.ground) < 0.35;
  const labelInk = dark ? '#a3acbf' : '#4a5160';
  const arrowInk = dark ? '#6f7a90' : '#8a93a3';
  const emit = (card: Card, index: number, x: number, y: number, s: number): void => {
    const cx = x + card.shape.inset.x * s;
    const cy = y + card.shape.inset.y * s;
    for (const p of card.shape.under) parts.push(scalePart(p, s, x, y));
    // a screen is glass: what a long page has below the fold is not drawn outside it
    const clip = { x: cx, y: cy, w: card.layout.width * s, h: card.layout.height * s };
    for (const p of card.layout.parts) {
      const scaled = scalePart(p, s, cx, cy);
      parts.push({ ...scaled, clip: scaled.clip === undefined ? clip : overlap(scaled.clip, clip) });
    }
    for (const p of card.shape.over) parts.push(scalePart(p, s, x, y));
    placements.push({ id: card.layout.id, index, x, y, scale: s, contentX: cx, contentY: cy, width: card.shape.width * s, height: card.shape.height * s });
  };
  const label = (card: Card, x: number, y: number, s: number): void => {
    const name = card.layout.name === '' ? card.layout.id : card.layout.name;
    const text = name.toUpperCase();
    parts.push({ kind: 'text', key: `${card.layout.id}/label`, owner: card.layout.id, x, y: y - LABEL_H + 2, w: card.shape.width * s, h: 20, lines: [{ text, width: measure.width(text, 12, 'bold') * 1.06 }], size: 12, line: 20, weight: 'bold', colour: labelInk, align: 'left' });
  };

  // a thumbnail is a picture to point at, not to read: it is named under it at the label's own size, which is the floor
  const thumbLabel = (card: Card, x: number, y: number, s: number, limit = 100): void => {
    const name = (card.layout.name === '' ? card.layout.id : card.layout.name).toUpperCase();
    const room = Math.max(card.shape.width * s, limit);
    let cut = name;
    while (cut.length > 1 && measure.width(cut, 12, 'bold') * 1.06 > room) cut = `${cut.slice(0, -2).trimEnd()}\u2026`;
    const w = measure.width(cut, 12, 'bold') * 1.06;
    parts.push({ kind: 'text', key: `${card.layout.id}/label`, owner: card.layout.id, x: x + (card.shape.width * s - w) / 2, y: y + card.shape.height * s + 2, w, h: 20, lines: [{ text: cut, width: w }], size: 12, line: 20, weight: 'bold', colour: labelInk, align: 'left' });
  };

  if (options.mode === 'overview' || layouts.length <= 1) {
    const sizes = cards.map((c) => ({ w: c.shape.width, h: c.shape.height }));
    const { cols, scale: s } = bestGrid(sizes, room, options.margin);
    const rows = Math.ceil(cards.length / cols);
    const rowSizes = Array.from({ length: rows }, (_, r) => {
      const slice = sizes.slice(r * cols, r * cols + cols);
      return { w: slice.reduce((a, z) => a + z.w, 0) * s + (slice.length - 1) * GAP * s, h: Math.max(...slice.map((z) => z.h)) * s };
    });
    const total = rowSizes.reduce((a, r) => a + r.h + LABEL_H, 0) + (rows - 1) * GAP * s;
    let y = (room.h - total) / 2 + LABEL_H;
    const where = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (let r = 0; r < rows; r++) {
      const rs = rowSizes[r];
      if (rs === undefined) continue;
      let x = (room.w - rs.w) / 2;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const card = cards[i];
        if (card === undefined) break;
        label(card, x, y, s);
        emit(card, i, x, y, s);
        where.set(card.layout.id, { x, y, w: card.shape.width * s, h: card.shape.height * s });
        x += (card.shape.width + GAP) * s;
      }
      y += rs.h + LABEL_H + GAP * s;
    }
    return { parts: [...parts, ...arrows(layouts, where, arrowInk, labelInk, measure, s)], placements, mode: 'overview', focus: options.focus, scale: s };
  }

  // one screen large, the rest small
  const n = cards.length;
  if (room.w >= room.h * 1.3 && n > 1) {
    // a room that is wider than it is tall: the rest stand in a column beside the large one, so that it has the whole height
    const at = Math.max(0, Math.min(n - 1, options.focus));
    const lead = cards[at];
    if (lead === undefined) return { parts, placements, mode: 'focus', focus: 0, scale: 1 };
    const column = 120;
    const others = cards.map((c, i) => ({ c, i })).filter(({ i }) => i !== at);
    const sLead = Math.min(1.2, (room.w - column - 3 * options.margin) / lead.shape.width, (room.h - 2 * options.margin - LABEL_H) / lead.shape.height);
    const total = lead.shape.width * sLead + options.margin + column;
    const lx = (room.w - total) / 2;
    const ly = (room.h - lead.shape.height * sLead + LABEL_H) / 2;
    label(lead, lx, ly, sLead);
    emit(lead, at, lx, ly, sLead);
    const gap = 28;
    const sThumb = Math.min(column / Math.max(...others.map(({ c }) => c.shape.width)), ((room.h - 2 * options.margin - (others.length - 1) * gap) / others.length) / Math.max(...others.map(({ c }) => c.shape.height)), 0.2);
    const heights = others.reduce((a, { c }) => a + c.shape.height * sThumb, 0) + (others.length - 1) * gap;
    let ty = (room.h - heights) / 2;
    const tx = lx + lead.shape.width * sLead + options.margin;
    for (const { c, i } of others) {
      const thumbX = tx + (column - c.shape.width * sThumb) / 2;
      emit(c, i, thumbX, ty, sThumb);
      thumbLabel(c, thumbX, ty, sThumb);
      ty += c.shape.height * sThumb + gap;
    }
    return { parts, placements, mode: 'focus', focus: at, scale: sLead };
  }
  const stripH = Math.min(128, Math.max(88, room.h * 0.14));
  const main = cards[Math.max(0, Math.min(n - 1, options.focus))];
  if (main === undefined) return { parts, placements, mode: 'focus', focus: 0, scale: 1 };
  const sMain = Math.min(1.2, (room.w - 2 * options.margin) / main.shape.width, (room.h - stripH - 2 * options.margin - LABEL_H) / main.shape.height);
  const mx = (room.w - main.shape.width * sMain) / 2;
  const my = options.margin / 2 + LABEL_H;
  label(main, mx, my, sMain);
  emit(main, Math.max(0, Math.min(n - 1, options.focus)), mx, my, sMain);
  const thumbs = cards.map((c, i) => ({ c, i })).filter(({ i }) => i !== Math.max(0, Math.min(n - 1, options.focus)));
  const th = stripH - 20;
  const maxH = Math.max(...cards.map((c) => c.shape.height));
  const maxW = Math.max(...cards.map((c) => c.shape.width));
  const sThumb = Math.min(th / maxH, (room.w - 2 * options.margin - (n - 2) * 10) / ((n - 1) * maxW));
  // each thumbnail has a slot as wide as its name needs, up to 120, so the names stand apart
  const slot = Math.min(120, (room.w - 2 * options.margin) / Math.max(1, thumbs.length));
  let tx = (room.w - slot * thumbs.length) / 2;
  const ty = room.h - stripH + 8;
  for (const { c, i } of thumbs) {
    const x = tx + (slot - c.shape.width * sThumb) / 2;
    emit(c, i, x, ty, sThumb);
    thumbLabel(c, x, ty, sThumb, slot - 6);
    tx += slot;
  }
  return { parts, placements, mode: 'focus', focus: Math.max(0, Math.min(n - 1, options.focus)), scale: sMain };
}

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The arrow from each screen to the one it was reached from, as a line with a head and the words written on it. */
function arrows(layouts: readonly UiScreenLayout[], where: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>, ink: string, labelInk: string, measure: UiMeasure, s: number): UiPart[] {
  const out: UiPart[] = [];
  for (const layout of layouts) {
    if (layout.from === null) continue;
    const meta = { from: layout.from, label: layout.fromLabel };
    const a = where.get(meta.from);
    const b = where.get(layout.id);
    if (a === undefined || b === undefined) continue;
    const head = Math.max(6, 9 * Math.min(1, s * 1.6));
    const pts: { x: number; y: number }[] = [];
    let dir = { x: 1, y: 0 };
    let below = false;
    const lo = Math.min(a.x + a.w, b.x + b.w);
    const hi = Math.max(a.x, b.x);
    const between = [...where].some(([id, o]) => id !== meta.from && id !== layout.id && Math.abs(o.y - a.y) < 2 && o.x >= lo - 1 && o.x + o.w <= hi + 1);
    if (Math.abs(a.y - b.y) < 2 && between) {
      // a screen stands between them: the arrow goes round under the row, never across the screen in the way
      const drop = Math.max(10, 18 * s);
      const y = a.y + a.h + drop;
      pts.push({ x: a.x + a.w / 2, y: a.y + a.h + 6 }, { x: a.x + a.w / 2, y }, { x: b.x + b.w / 2, y }, { x: b.x + b.w / 2, y: b.y + b.h + 6 });
      dir = { x: 0, y: -1 };
      below = true;
    } else if (Math.abs(a.y - b.y) < 2) {
      const y = a.y + a.h / 2;
      if (b.x > a.x) pts.push({ x: a.x + a.w + 6, y }, { x: b.x - 6, y });
      else {
        pts.push({ x: a.x - 6, y }, { x: b.x + b.w + 6, y });
        dir = { x: -1, y: 0 };
      }
    } else if (b.y > a.y) {
      const mx = a.x + a.w / 2;
      const midY = a.y + a.h + (b.y - a.y - a.h) / 2;
      pts.push({ x: mx, y: a.y + a.h + 6 }, { x: mx, y: midY }, { x: b.x + b.w / 2, y: midY }, { x: b.x + b.w / 2, y: b.y - 6 });
      dir = { x: 0, y: 1 };
    } else {
      pts.push({ x: a.x - 6, y: a.y + a.h / 2 }, { x: b.x + b.w + 6, y: b.y + b.h / 2 });
      dir = { x: -1, y: 0 };
    }
    const end = pts[pts.length - 1];
    if (end === undefined) continue;
    const back = { x: end.x - dir.x * head, y: end.y - dir.y * head };
    const side = { x: -dir.y * head * 0.6, y: dir.x * head * 0.6 };
    out.push({ kind: 'path', key: `${layout.id}/arrow`, owner: layout.id, outline: [{ closed: false, points: pts.slice(0, -1).concat([back]) }], fill: null, stroke: { colour: ink, width: 2 } });
    out.push({ kind: 'path', key: `${layout.id}/head`, owner: layout.id, outline: [{ closed: true, points: [end, { x: back.x + side.x, y: back.y + side.y }, { x: back.x - side.x, y: back.y - side.y }] }], fill: ink, stroke: null });
    if (meta.label !== null) {
      const mid = pts[Math.floor(pts.length / 2) - 1] ?? end;
      const next = pts[Math.floor(pts.length / 2)] ?? end;
      const text = meta.label;
      const w = measure.width(text, 12, 'normal');
      out.push({ kind: 'text', key: `${layout.id}/arrow-label`, owner: layout.id, x: (mid.x + next.x) / 2 - w / 2, y: (mid.y + next.y) / 2 + (below ? 4 : -24), w, h: 20, lines: [{ text, width: w }], size: 12, line: 20, weight: 'normal', colour: labelInk, align: 'left' });
    }
  }
  return out;
}

/** The screen under a point of the room, and the point in that screen's own points. */
export function locate(board: Board, px: number, py: number): { readonly index: number; readonly id: string; readonly x: number; readonly y: number; readonly inScreen: boolean } | null {
  for (let i = board.placements.length - 1; i >= 0; i--) {
    const p = board.placements[i];
    if (p === undefined) continue;
    if (px >= p.x && px <= p.x + p.width && py >= p.y && py <= p.y + p.height) return { index: p.index, id: p.id, x: (px - p.contentX) / p.scale, y: (py - p.contentY) / p.scale, inScreen: true };
  }
  return null;
}
