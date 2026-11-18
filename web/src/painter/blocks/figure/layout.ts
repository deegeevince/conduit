// The figure's layout: everything the kit decides, in the pixels of the box it is given, from the typed input.
//
//   fit        the subject (its parts' union) is fitted to 55-75% of the stage, the largest share at which every label has room for its gutter
//   labels     boundary labels (`boundary.ts`): outside the subject, on the side nearest the part, no two leaders crossing; at most seven a
//              view, `optional` parts dropped first
//   refit      a part `in=` a closed shape is shrunk toward its centre until it sits inside (`refit.ts`)
//   routes     along an open part's line, through a closed part's centre (`routes.ts`)
//   modes      `cutaway` hatches cut faces; `exploded` offsets parts along one axis, with guide lines
//   chrome     a caption band inside the figure's own box that never retires (the title at rest, a step's words at a step), and a stepper in it
//              of at least 44 points
//
// Pure: no DOM, no clock. The same input, step and box give the same layout.

import { placeBoundary } from './boundary';
import type { BoundaryLabel, PlacedLabel, Side } from './boundary';
import { bounds, shift, unionOf } from './geometry';
import type { Poly, Rect } from './geometry';
import { shadeFor } from './palette';
import type { FigureLook, Shade } from './palette';
import { resolveParts } from './refit';
import type { Resolved } from './refit';
import { buildRoute } from './routes';
import type { LaidRoute } from './routes';
import type { FigureInput, FigureNote, Pt } from './types';

export const MAX_LABELS = 7;
export const SHARES: readonly number[] = [0.75, 0.7, 0.65, 0.6, 0.55];
/** a finger needs this much, in points */
export const TARGET = 44;
const BUTTON = 48;
const COUNTER = 76;

export interface FigureEnv {
  /** the width of one line of text at this size, in px */
  readonly measure: (text: string, px: number, bold: boolean) => number;
  /** the least a word may be set at on this screen */
  readonly floor: number;
  /** the stage's own body size and small size on this screen, px: the strip's words are set in the body size and the labels in the small one (as far as the room can hold them), whatever the figure's own scale */
  readonly body?: number;
  readonly small?: number;
  readonly look: FigureLook;
}

export interface LaidPart {
  readonly id: string;
  readonly index: number;
  readonly parent: string | null;
  readonly poly: Poly;
  readonly shade: Shade;
  /** a closed part with no hue is a neutral */
  readonly hue: string | undefined;
  /** an open part's thickness, px */
  readonly thick: number;
  readonly cut: boolean;
}

export interface LaidLabel {
  readonly part: string;
  readonly lines: readonly string[];
  readonly px: number;
  readonly lineHeight: number;
  readonly side: Side;
  readonly align: 'left' | 'right' | 'center';
  readonly box: Rect;
  readonly anchor: Pt;
  readonly leader: readonly [Pt, Pt];
}

export interface Chrome {
  /** the plate behind the caption and the stepper */
  readonly band: Rect;
  readonly px: number;
  readonly lineHeight: number;
  readonly caption: { readonly lines: readonly string[]; readonly box: Rect; readonly bold: boolean };
  /** null when the figure has no steps */
  readonly stepper: null | {
    readonly prev: Rect;
    readonly next: Rect;
    readonly counter: { readonly text: string; readonly box: Rect };
  };
}

export interface FigureLayout {
  readonly id: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly input: FigureInput;
  readonly step: number;
  readonly scale: number;
  /** where the figure's own space lands: a point at (x, y) of it is at (x * scale + offset.x, y * scale + offset.y) px. What a turn that goes on with the figure keeps (`FigureKeep`). */
  readonly offset: Pt;
  /** the subject's box, px */
  readonly subject: Rect;
  readonly stage: Rect;
  readonly parts: readonly LaidPart[];
  readonly labels: readonly LaidLabel[];
  readonly dropped: readonly string[];
  readonly routes: readonly LaidRoute[];
  /** exploded: the dashed guide along the axis */
  readonly guide: null | { readonly from: Pt; readonly to: Pt };
  readonly chrome: Chrome;
  /** the parts a step lights, or null at rest */
  readonly lit: ReadonlySet<string> | null;
  readonly notes: readonly FigureNote[];
  /** how big the label type was set, px: what fit asked for */
  readonly labelPx: number;
  /** the share of the stage the subject takes along its longer side */
  readonly share: number;
  readonly look: FigureLook;
}

// ------------------------------------------------------------------ text

export function wrapWords(text: string, px: number, maxWidth: number, bold: boolean, measure: FigureEnv['measure']): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measure(next, px, bold) > maxWidth) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line !== '') out.push(line);
  return out.length === 0 ? [''] : out;
}

/** The text split in two at the word nearest the middle, or null when it is one word. */
function balanced(text: string, px: number, measure: FigureEnv['measure']): string[] | null {
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length < 2) return null;
  let best: string[] | null = null;
  let widest = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const w = Math.max(measure(pair[0] as string, px, false), measure(pair[1] as string, px, false));
    if (w < widest) {
      widest = w;
      best = pair;
    }
  }
  return best;
}

// ------------------------------------------------------------------ exploded

function explode(parts: readonly Resolved[], axisIn: 'x' | 'y' | undefined): { readonly parts: readonly Resolved[]; readonly guide: { from: Pt; to: Pt } | null } {
  const all = unionOf(parts.map((p) => bounds(p.poly.pts)));
  const axis = axisIn ?? (all.width >= all.height ? 'x' : 'y');
  const lo = (r: Rect): number => (axis === 'x' ? r.x : r.y);
  const ext = (r: Rect): number => (axis === 'x' ? r.width : r.height);
  const byId = new Map(parts.map((p) => [p.part.id, p]));
  const rootOf = (p: Resolved): string => {
    let at = p;
    for (let n = 0; at.parent !== null && n < 12; n += 1) at = byId.get(at.parent) ?? at;
    return at.part.id;
  };
  const groups = new Map<string, Resolved[]>();
  for (const p of parts) groups.set(rootOf(p), [...(groups.get(rootOf(p)) ?? []), p]);
  const boxes = [...groups.entries()].map(([id, members]) => ({ id, box: unionOf(members.map((m) => bounds(m.poly.pts))) }));
  boxes.sort((a, b) => lo(a.box) + ext(a.box) / 2 - (lo(b.box) + ext(b.box) / 2));
  if (boxes.length < 2) return { parts, guide: null };
  const mean = boxes.reduce((n, g) => n + ext(g.box), 0) / boxes.length;
  const gap = 0.16 * mean;
  const offset = new Map<string, number>();
  let cursor = lo((boxes[0] as (typeof boxes)[number]).box);
  for (const g of boxes) {
    offset.set(g.id, cursor - lo(g.box));
    cursor += ext(g.box) + gap;
  }
  const moved = parts.map((p) => {
    const d = offset.get(rootOf(p)) ?? 0;
    return { ...p, poly: { pts: axis === 'x' ? shift(p.poly.pts, d, 0) : shift(p.poly.pts, 0, d), closed: p.poly.closed } };
  });
  const after = unionOf(moved.map((p) => bounds(p.poly.pts)));
  const margin = 0.04 * Math.max(after.width, after.height);
  // the guide runs through the middle of the parts, across the axis
  const mid = boxes.reduce((n, g) => n + (axis === 'x' ? g.box.y + g.box.height / 2 : g.box.x + g.box.width / 2), 0) / boxes.length;
  const guide = axis === 'x' ? { from: { x: after.x - margin, y: mid }, to: { x: after.x + after.width + margin, y: mid } } : { from: { x: mid, y: after.y - margin }, to: { x: mid, y: after.y + after.height + margin } };
  return { parts: moved, guide };
}

// ------------------------------------------------------------------ the layout

/** The parts a step lights (a route's name lights the parts it passes), or null when every part is lit: at rest, or a step that names nothing here. */
export function litParts(input: FigureInput, step: number): ReadonlySet<string> | null {
  if (step < 1 || step > input.steps.length) return null;
  const ids = new Set(input.parts.map((p) => p.id));
  const set = new Set<string>();
  for (const name of (input.steps[step - 1] as (typeof input.steps)[number]).show) {
    const route = input.routes.find((r) => r.id === name);
    if (ids.has(name)) set.add(name);
    else if (route !== undefined) for (const v of route.via) if (ids.has(v)) set.add(v);
  }
  return set.size === 0 ? null : set;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const lastOf = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

/**
 * How a figure was set the last time it was laid out: a figure the next turn of its scene goes on with (a part swapped, the words round it changed) is set the same way when its labels
 * still fit, so the drawing stays where it was and as big as it was. Never a coordinate the brain wrote: the kit's own fit, kept.
 */
export interface FigureKeep {
  readonly scale: number;
  readonly offset: Pt;
}

interface Fit {
  readonly scale: number;
  readonly offset: Pt;
  readonly share: number;
  readonly labelPx: number;
  readonly placed: ReadonlyMap<string, PlacedLabel>;
  readonly bad: readonly string[];
  readonly crossings: number;
}

export function layoutFigure(input: FigureInput, held: { readonly step: number }, size: { readonly width: number; readonly height: number }, env: FigureEnv, keep?: FigureKeep): FigureLayout {
  const W = Math.max(1, size.width);
  const H = Math.max(1, size.height);
  const notes: FigureNote[] = [];
  const step = clamp(Math.round(held.step), 0, input.steps.length);

  // the parts: refit, then offset when exploded
  const resolved = resolveParts(input);
  notes.push(...resolved.notes);
  const exploded = input.mode === 'exploded' ? explode(resolved.parts, input.axis) : { parts: resolved.parts, guide: null };
  const placed = exploded.parts;
  const sub = unionOf([...placed.map((p) => bounds(p.poly.pts)), ...(exploded.guide === null ? [] : [bounds([exploded.guide.from, exploded.guide.to])])]);

  // the chrome: type sizes, then the band
  const unit = Math.min(W, H);
  const phone = W < 520;
  // The strip's words are the stage's body size, the same as the words beside the figure; the figure's own scale (a 36th of its short side, at most 20 px)
  // only ever adds to that, and a room too small for the body size (a seventh of its short side) holds less of it.
  const captionPx = Math.round(Math.max(clamp(unit / (phone ? 24 : 36), env.floor + 2, 20), Math.min(env.body ?? 0, unit / 14)));
  const pad = phone ? 12 : 16;
  const hasSteps = input.steps.length > 0;
  const texts = [input.title, ...input.steps.map((s) => s.words)].filter((t) => t.trim() !== '');
  // the counter ("6 steps", "3 / 6") is in the strip's own type, so its box is as wide as that type needs
  const counterW = Math.max(COUNTER, Math.ceil(Math.max(env.measure(`${input.steps.length} steps`, captionPx, false), env.measure(`${input.steps.length} / ${input.steps.length}`, captionPx, false))) + 16);
  const textW = Math.max(8, hasSteps && !phone ? W - 3 * pad - (2 * BUTTON + counterW) : W - 2 * pad);
  const linesFor = (at: number): number => Math.max(1, ...texts.map((t) => wrapWords(t, at, textW, false, env.measure).length));
  let px = captionPx;
  // a long step is set in up to three lines, smaller as it must be but never below three quarters of the stage's body size; past that it takes more lines (up to five) before it goes smaller
  const stripFloor = env.body === undefined ? env.floor : Math.max(env.floor, Math.round(captionPx * 0.75));
  while (linesFor(px) > 3 && px > stripFloor) px -= 1;
  while (env.body !== undefined && linesFor(px) > 5 && px > env.floor) px -= 1;
  const lineHeight = Math.round(px * 1.3);
  const textH = texts.length === 0 ? 0 : linesFor(px) * lineHeight;
  const padV = phone ? 8 : 10;
  const bandH = texts.length === 0 && !hasSteps ? 0 : hasSteps ? (phone ? textH + BUTTON + 3 * padV : Math.max(BUTTON, textH) + 2 * padV) : textH + 2 * padV;
  const band: Rect = { x: 0, y: H - bandH, width: W, height: bandH };
  const stepText = step === 0 ? input.title : (input.steps[step - 1] as (typeof input.steps)[number]).words;
  const captionLines = wrapWords(stepText, px, textW, step === 0, env.measure);
  const counterText = step === 0 ? `${input.steps.length} step${input.steps.length === 1 ? '' : 's'}` : `${step} / ${input.steps.length}`;
  let stepper: Chrome['stepper'] = null;
  let captionBox: Rect = { x: pad, y: band.y + padV, width: textW, height: textH };
  if (hasSteps) {
    if (phone) {
      const y = band.y + padV + textH + padV;
      stepper = {
        prev: { x: pad, y, width: BUTTON, height: BUTTON },
        next: { x: W - pad - BUTTON, y, width: BUTTON, height: BUTTON },
        counter: { text: counterText, box: { x: pad + BUTTON, y, width: W - 2 * pad - 2 * BUTTON, height: BUTTON } },
      };
    } else {
      const y = band.y + (bandH - BUTTON) / 2;
      const right = W - pad;
      stepper = {
        next: { x: right - BUTTON, y, width: BUTTON, height: BUTTON },
        counter: { text: counterText, box: { x: right - BUTTON - counterW, y, width: counterW, height: BUTTON } },
        prev: { x: right - 2 * BUTTON - counterW, y, width: BUTTON, height: BUTTON },
      };
      captionBox = { x: pad, y: band.y + (bandH - textH) / 2, width: textW, height: textH };
    }
  }
  const chrome: Chrome = { band, px, lineHeight, caption: { lines: captionLines, box: captionBox, bold: step === 0 }, stepper };

  // the stage above the band, and the room labels may stand in
  const stage: Rect = { x: 0, y: 0, width: W, height: Math.max(1, H - bandH - (bandH > 0 ? pad / 2 : 0)) };
  const inset = Math.min(8, unit * 0.02);
  const room: Rect = { x: stage.x + inset, y: stage.y + inset, width: Math.max(1, stage.width - 2 * inset), height: Math.max(1, stage.height - 2 * inset) };

  // the labels there may be: at most seven, optional parts dropped first
  const dropped: string[] = [];
  let active = placed.filter((p) => p.part.label !== undefined && p.part.label.trim() !== '');
  const drop = (victim: Resolved, why: string): void => {
    active = active.filter((p) => p !== victim);
    dropped.push(victim.part.id);
    notes.push({ kind: 'label-dropped', part: victim.part.id, detail: `the label of "${victim.part.id}" was dropped: ${why}` });
  };
  while (active.length > MAX_LABELS) drop(lastOf(active.filter((p) => p.part.optional === true)) ?? (lastOf(active) as Resolved), `more than ${MAX_LABELS} labels in one view`);

  const centreX = sub.x + sub.width / 2;
  const centreY = sub.y + sub.height / 2;
  const centred = (scale: number): Pt => ({ x: room.x + room.width / 2 - centreX * scale, y: room.y + room.height / 2 - centreY * scale });
  const toPx = (scale: number, p: Pt, offset: Pt = centred(scale)): Pt => ({ x: p.x * scale + offset.x, y: p.y * scale + offset.y });
  const pxPoly = (poly: Poly, scale: number, offset: Pt = centred(scale)): Poly => ({ pts: poly.pts.map((p) => toPx(scale, p, offset)), closed: poly.closed });
  const fitScale = (share: number): number => Math.min((share * room.width) / Math.max(1e-6, sub.width), (share * room.height) / Math.max(1e-6, sub.height));

  const sizesFor = (text: string, labelPx: number): { w: number; h: number }[] => {
    const lh = Math.round(labelPx * 1.25);
    const out = [{ w: Math.ceil(env.measure(text, labelPx, false)) + 2, h: lh }];
    const two = balanced(text, labelPx, env.measure);
    if (two !== null) out.push({ w: Math.ceil(Math.max(env.measure(two[0] as string, labelPx, false), env.measure(two[1] as string, labelPx, false))) + 2, h: lh * 2 });
    return out;
  };

  // The labels start at the stage's small size (what the words beside call small), bounded the same way; they go down a step at a time only as far as they must to stand clear
  const labelPx0 = Math.max(env.floor, Math.round(Math.max(captionPx * 0.82, Math.min(env.small ?? 0, unit / 16))));
  const ladder: number[] = [];
  for (let s = labelPx0; s >= env.floor; s -= s > 18 ? 2 : 1) ladder.push(s);
  if (ladder[ladder.length - 1] !== env.floor) ladder.push(env.floor);

  // one try at a scale, a place and a label size: where the labels would stand, and whether they stand clear
  const attempt = (scale: number, share: number, labelPx: number, offset: Pt): { readonly tried: Fit; readonly subject: Rect } => {
    const corner = toPx(scale, { x: sub.x, y: sub.y }, offset);
    const subject: Rect = { x: corner.x, y: corner.y, width: sub.width * scale, height: sub.height * scale };
    const pxParts = new Map(placed.map((p) => [p.part.id, pxPoly(p.poly, scale, offset)]));
    const labels: BoundaryLabel[] = active.map((p) => ({
      key: p.part.id,
      sizes: sizesFor(p.part.label as string, labelPx),
      poly: pxParts.get(p.part.id) as Poly,
      // what is drawn after it and closed, and what it holds: its anchor keeps out of them, so its leader ends on IT
      covers: placed.filter((q) => q !== p && q.poly.closed && (q.index > p.index || q.parent === p.part.id)).map((q) => (pxParts.get(q.part.id) as Poly).pts),
    }));
    const result = placeBoundary({ labels, figure: subject, room, gap: Math.max(8, labelPx * 0.8), sep: Math.max(3, labelPx * 0.3), sepX: Math.max(14, labelPx * 1.2) });
    return { tried: { scale, offset, share, labelPx, placed: result.placed, bad: result.bad, crossings: result.crossings }, subject };
  };

  let fit: Fit | null = null;
  for (let guard = 0; guard < 16 && fit === null; guard += 1) {
    // the figure as it stood a turn ago, when it is still being gone on with: the same scale in the same place, if every label still has its room there
    if (keep !== undefined) {
      for (const labelPx of ladder) {
        const { tried, subject } = attempt(keep.scale, Math.max((sub.width * keep.scale) / room.width, (sub.height * keep.scale) / room.height), labelPx, keep.offset);
        const inside = subject.x >= room.x - 0.5 && subject.y >= room.y - 0.5 && subject.x + subject.width <= room.x + room.width + 0.5 && subject.y + subject.height <= room.y + room.height + 0.5;
        if (inside && tried.bad.length === 0 && tried.crossings === 0) {
          fit = tried;
          break;
        }
      }
      if (fit !== null) break;
    }
    let best: Fit | null = null;
    outer: for (const labelPx of ladder) {
      for (const share of SHARES) {
        const scale = fitScale(share);
        const { tried } = attempt(scale, share, labelPx, centred(scale));
        if (tried.bad.length === 0 && tried.crossings === 0) {
          fit = tried;
          break outer;
        }
        if (best === null || tried.bad.length < best.bad.length || (tried.bad.length === best.bad.length && tried.crossings < best.crossings)) best = tried;
      }
    }
    if (fit !== null) break;
    if (active.length === 0) {
      fit = { scale: fitScale(SHARES[0] as number), offset: centred(fitScale(SHARES[0] as number)), share: SHARES[0] as number, labelPx: labelPx0, placed: new Map(), bad: [], crossings: 0 };
      break;
    }
    // it will not fit: an optional label that is in the way goes first, then any optional, then one that is in the way, then the last
    const bad = new Set(best?.bad ?? []);
    const victim = lastOf(active.filter((p) => p.part.optional === true && bad.has(p.part.id))) ?? lastOf(active.filter((p) => p.part.optional === true)) ?? lastOf(active.filter((p) => bad.has(p.part.id))) ?? (lastOf(active) as Resolved);
    drop(victim, 'no room for it beside the figure');
  }
  const settled = fit ?? { scale: fitScale(SHARES[SHARES.length - 1] as number), offset: centred(fitScale(SHARES[SHARES.length - 1] as number)), share: SHARES[SHARES.length - 1] as number, labelPx: labelPx0, placed: new Map<string, PlacedLabel>(), bad: [], crossings: 0 };
  if (settled.labelPx < labelPx0 && active.length > 0) notes.push({ kind: 'label-crowded', part: '', detail: `label type was set at ${settled.labelPx}px to fit (${labelPx0}px asked)` });

  // the parts and routes, in px
  const laid: LaidPart[] = placed.map((p) => {
    const poly = pxPoly(p.poly, settled.scale, settled.offset);
    const hue = p.poly.closed ? p.part.fill : (p.part.stroke ?? p.part.fill);
    const holds = placed.some((q) => q.parent === p.part.id);
    return {
      id: p.part.id,
      index: p.index,
      parent: p.parent,
      poly,
      shade: shadeFor(hue, env.look),
      hue,
      thick: poly.closed ? 0 : Math.max(2.5, (p.part.thick ?? 1.5) * settled.scale),
      cut: input.mode === 'cutaway' && poly.closed && (p.part.cut ?? holds),
    };
  });
  const byId = new Map(laid.map((p) => [p.id, { id: p.id, poly: p.poly }]));
  const routes = input.routes.map((r) => buildRoute(r, byId)).filter((r): r is LaidRoute => r !== null);
  const labels: LaidLabel[] = [];
  for (const p of active) {
    const at = settled.placed.get(p.part.id);
    if (at === undefined) continue;
    const text = p.part.label as string;
    const lh = Math.round(settled.labelPx * 1.25);
    const lines = at.box.height > lh * 1.5 ? (balanced(text, settled.labelPx, env.measure) ?? [text]) : [text];
    labels.push({ part: p.part.id, lines, px: settled.labelPx, lineHeight: lh, side: at.side, align: at.align, box: at.box, anchor: at.anchor, leader: at.leader });
  }

  // which parts a step lights
  const lit = litParts(input, step);
  if (step > 0) {
    for (const name of (input.steps[step - 1] as (typeof input.steps)[number]).show) {
      if (!byId.has(name) && !input.routes.some((r) => r.id === name)) notes.push({ kind: 'unknown-part', part: name, detail: `step ${step} shows "${name}", which is not a part of this figure` });
    }
  }

  const guide = exploded.guide === null ? null : { from: toPx(settled.scale, exploded.guide.from, settled.offset), to: toPx(settled.scale, exploded.guide.to, settled.offset) };
  const subject = unionOf([...laid.map((p) => bounds(p.poly.pts)), ...(guide === null ? [] : [bounds([guide.from, guide.to])])]);
  return { id: input.id, size: { width: W, height: H }, input, step, scale: settled.scale, offset: settled.offset, subject, stage, parts: laid, labels, dropped, routes, guide, chrome, lit, notes, labelPx: settled.labelPx, share: settled.share, look: env.look };
}
