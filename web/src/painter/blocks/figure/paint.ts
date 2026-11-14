// The figure as finished frames (PLAN-visuals 2(a), (d), (f)): shapes and words the painter already draws, in the leaf's own pixels (origin at its
// corner). No renderer learns anything: a gradient fill, an outline, a `soft=` shadow, an open line, a line of type. Dots are ordinary shapes at a
// place that is a function of the ambient clock.
//
//   shading   every fill: a darker outline of the same hue, a top light (the gradient, and a soft highlight kept inside the part), and a contact
//             shadow under it (`soft=`)
//   motion    only direction, order, cause or change of state: chevrons along each route (always), one dot or more riding the stretch a step runs,
//             and a part's light easing out over about 250 ms between steps. Reduced motion draws no dots and eases nothing.
//   steps     the named parts stay lit; the rest dim to about 35% (their labels to 50%, so every word stays readable)
//
// Pure: no DOM, no clock (the clock is an argument).

import type { Polyline } from '@conduit/language';
import type { Colour, ElementFrame, FigureFrame, RunFrame, ShapeFrame } from '../../../contracts/frame';
import { IDENTITY } from '../../../contracts/frame';
import { foldText } from '../../../fonts/fold';
import { prefixEm } from '../../../fonts/measure';
import { mix } from '../../../looks/colour-math';
import { bounds, dist, edgeDistance, hatch, inside } from './geometry';
import type { Poly, Rect } from './geometry';
import { shadeFor, shadowInk } from './palette';
import type { Shade } from './palette';
import { chevronPoints, chevronsOn, dotsOn, stretchOf } from './routes';
import type { FigureLayout, LaidPart } from './layout';
import { litParts } from './layout';
import type { Pt } from './types';

/** The share a part keeps when a step is not about it. */
export const DIM = 0.35;
/** Its label keeps more, so the words stay readable. */
export const LABEL_DIM = 0.5;
/** A highlight eases out over this long. */
export const EASE_SECONDS = 0.25;

export interface PaintOptions {
  /** seconds on the ambient clock: dots are a function of it */
  readonly ambient: number;
  /** false: reduced motion, or at rest: chevrons only */
  readonly motion: boolean;
  /** a step just changed: where the light was and how far it has come (0..1). Absent: it is where it should be. */
  readonly ease?: { readonly from: number; readonly t: number };
}

/** A word the painted figure shows, for the census. */
export interface PaintedWord {
  readonly part: string;
  readonly text: string;
  readonly box: Rect;
  readonly px: number;
  /** which role the colour is */
  readonly ink: 'ink' | 'dim';
  readonly colour: Colour;
  readonly on: Colour;
}

export interface Painted {
  readonly figures: readonly FigureFrame[];
  readonly elements: readonly ElementFrame[];
  readonly words: readonly PaintedWord[];
}

const CELL = 1.4;

function hashOf(pts: readonly Pt[]): number {
  let h = 0;
  pts.forEach((p, i) => (h = (h + Math.round(p.x * 4) * (i + 1) + Math.round(p.y * 4) * (i + 7)) % 1_000_000_007));
  return h;
}

const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

export function paintFigure(layout: FigureLayout, options: PaintOptions): Painted {
  const { look } = layout;
  const figures: FigureFrame[] = [];
  const elements: ElementFrame[] = [];
  const words: PaintedWord[] = [];
  let z = 0;
  const unit = Math.min(layout.size.width, layout.size.height);
  const hairline = Math.max(1, unit / 420);

  // how lit each part is now: 1, or DIM, eased from where the last step left it
  const target = (set: ReadonlySet<string> | null, id: string): number => (set === null || set.has(id) ? 1 : DIM);
  const from = options.ease === undefined ? null : litParts(layout.input, Math.round(options.ease.from));
  const eased = options.ease === undefined || !options.motion ? 1 : easeOut(options.ease.t);
  const light = (id: string): number => {
    const now = target(layout.lit, id);
    if (options.ease === undefined || eased >= 1) return now;
    const before = target(from, id);
    return before + (now - before) * eased;
  };

  const shape = (key: string, owner: string, lines: readonly (readonly Pt[])[], closed: readonly boolean[], fill: ShapeFrame['fill'], stroke: ShapeFrame['stroke'], opacity: number, soft?: number): void => {
    const all = lines.flat();
    if (all.length === 0) return;
    const b = bounds(all);
    const mx = b.x + b.width / 2;
    const my = b.y + b.height / 2;
    const outline: Polyline[] = lines.map((pts, i) => ({ closed: closed[i] ?? false, points: pts.map((p) => ({ x: p.x - mx, y: p.y - my })) }));
    figures.push({
      kind: 'shape',
      key: `${layout.id}/${key}`,
      id: owner,
      layer: 'mid',
      z: z++,
      outline,
      geometryKey: `fig:${key}:${Math.round(b.width)}x${Math.round(b.height)}:${all.length}:${hashOf(all)}`,
      transform: { ...IDENTITY, e: mx, f: my },
      fill,
      stroke,
      opacity,
      bleed: false,
      tappable: false,
      ...(soft === undefined || soft <= 0 ? {} : { soft }),
    });
  };
  const flat = (colour: Colour, alpha = 1, to: Colour | null = null): ShapeFrame['fill'] => ({ colour, to, opacity: alpha });
  const edge = (colour: Colour, width: number): ShapeFrame['stroke'] => ({ colour, width: Math.max(1, width), progress: 1, character: 'clean' });
  const closedShape = (key: string, owner: string, pts: readonly Pt[], fill: ShapeFrame['fill'], stroke: ShapeFrame['stroke'], opacity: number, soft?: number): void => shape(key, owner, [pts], [true], fill, stroke, opacity, soft);
  const lineShape = (key: string, owner: string, pts: readonly Pt[], stroke: ShapeFrame['stroke'], opacity: number, soft?: number): void => shape(key, owner, [pts], [false], null, stroke, opacity, soft);
  const circle = (c: Pt, r: number): Pt[] => Array.from({ length: 20 }, (_, i) => ({ x: c.x + r * Math.cos((i / 20) * Math.PI * 2), y: c.y + r * Math.sin((i / 20) * Math.PI * 2) }));
  const roundRect = (r: Rect, radius: number): Pt[] => {
    const k = Math.min(radius, r.width / 2, r.height / 2);
    const pts: Pt[] = [];
    const corner = (cx: number, cy: number, a0: number): void => {
      for (let i = 0; i <= 5; i += 1) pts.push({ x: cx + k * Math.cos(a0 + (i / 5) * (Math.PI / 2)), y: cy + k * Math.sin(a0 + (i / 5) * (Math.PI / 2)) });
    };
    corner(r.x + r.width - k, r.y + k, -Math.PI / 2);
    corner(r.x + r.width - k, r.y + r.height - k, 0);
    corner(r.x + k, r.y + r.height - k, Math.PI / 2);
    corner(r.x + k, r.y + k, Math.PI);
    return pts;
  };

  const text = (key: string, owner: string, line: string, box: { x: number; y: number; width: number }, size: number, bold: boolean, colour: Colour, align: 'left' | 'right' | 'center', opacity: number, lineHeight: number): Rect => {
    const folded = foldText(line);
    const weight = bold ? 'bold' : 'normal';
    const prefix = prefixEm(folded, 'sans', weight);
    const total = (prefix[folded.length] ?? 0) * size;
    const x0 = align === 'left' ? box.x : align === 'center' ? box.x + (box.width - total) / 2 : box.x + box.width - total;
    const runs: RunFrame[] = [];
    let index = 0;
    const cell = size * CELL;
    for (const word of folded.split(' ')) {
      if (word.length > 0) {
        const a = (prefix[index] ?? 0) * size;
        const b = (prefix[index + word.length] ?? 0) * size;
        runs.push({ text: word, x: -total / 2 + a, y: -cell / 2, width: b - a, colour, opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 });
      }
      index += word.length + 1;
    }
    const yc = box.y + lineHeight / 2;
    elements.push({
      key: `${layout.id}/${key}`,
      id: owner,
      layer: 'mid',
      z: z++,
      face: 'sans',
      x: x0 + total / 2,
      y: yc,
      width: total,
      height: cell,
      fontSize: size,
      stretch: 1,
      weight,
      opacity,
      scale: 1,
      rotation: 0,
      runs,
      lines: [{ x: -total / 2, y: -cell / 2, width: total, height: cell }],
      mark: 'none',
      markColour: colour,
      strike: 0,
      ghost: false,
      tappable: false,
      plate: 0,
    });
    return { x: x0, y: yc - lineHeight / 2, width: total, height: lineHeight };
  };

  // ---------------------------------------------------------------- the guide, then each part back to front
  if (layout.guide !== null) {
    const a = layout.guide.from;
    const b = layout.guide.to;
    const length = dist(a, b);
    const on = Math.max(5, unit / 70);
    const off = on * 0.8;
    const dashes: Pt[][] = [];
    for (let d = 0; d < length; d += on + off) {
      const t0 = d / length;
      const t1 = Math.min(1, (d + on) / length);
      dashes.push([{ x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 }, { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 }]);
    }
    shape('guide', 'guide', dashes, dashes.map(() => false), null, edge(look.dim, hairline * 1.4), 0.8);
  }

  const shadow = shadowInk(look);
  const contact = Math.max(1.5, unit / 190);
  for (const part of layout.parts) {
    const opacity = light(part.id);
    const s = part.shade;
    if (part.poly.closed) paintClosed(part, s, opacity);
    else paintOpen(part, s, opacity);
  }

  function paintClosed(part: LaidPart, s: Shade, opacity: number): void {
    const pts = part.poly.pts;
    const b = bounds(pts);
    const depth = part.parent === null ? contact * 1.6 : contact;
    // the contact shadow: the shape's own, a little lower and softened
    closedShape(`${part.id}~shadow`, part.id, pts.map((p) => ({ x: p.x, y: p.y + depth })), flat(shadow, part.parent === null ? 0.3 : 0.24), null, opacity, depth * 1.6);
    closedShape(part.id, part.id, pts, flat(s.top, 1, s.bottom), edge(s.outline, Math.max(1.4, unit / 300)), opacity);
    if (part.cut) {
      const lines = hatch(pts, Math.max(5, unit / 60));
      if (lines.length > 0) shape(`${part.id}~cut`, part.id, lines, lines.map(() => false), null, edge(s.hatch, hairline), opacity * 0.9);
    }
    // the top light: a soft oval high on the shape, drawn only where it stays inside it
    if (Math.min(b.width, b.height) >= 22) {
      const c0 = { x: b.x + b.width * 0.46, y: b.y + b.height * 0.3 };
      let rx = b.width * 0.26;
      let ry = b.height * 0.14;
      const oval = (f: number): Pt[] => Array.from({ length: 16 }, (_, i) => ({ x: c0.x + rx * f * Math.cos((i / 16) * Math.PI * 2), y: c0.y + ry * f * Math.sin((i / 16) * Math.PI * 2) }));
      let f = 1;
      const margin = Math.max(3, Math.min(b.width, b.height) * 0.05);
      while (f > 0.3 && !oval(f).every((p) => inside(p, pts) && edgeDistance(p, pts) >= margin)) f -= 0.1;
      if (f > 0.3) {
        rx *= f;
        ry *= f;
        closedShape(`${part.id}~light`, part.id, oval(1).map((p) => ({ x: p.x, y: p.y })), flat(s.light, 0.42), null, opacity, Math.max(2, ry * 0.8));
      }
    }
  }

  function paintOpen(part: LaidPart, s: Shade, opacity: number): void {
    const pts = part.poly.pts;
    const w = part.thick;
    const edgeW = Math.max(1.4, unit / 300) * 1.4;
    lineShape(`${part.id}~shadow`, part.id, pts.map((p) => ({ x: p.x, y: p.y + contact })), edge(shadow, w + edgeW * 2), opacity * 0.22, contact * 1.4);
    lineShape(`${part.id}~edge`, part.id, pts, edge(s.lineEdge, w + edgeW * 2), opacity);
    lineShape(part.id, part.id, pts, edge(s.line, w), opacity);
    if (w >= 5) lineShape(`${part.id}~light`, part.id, pts.map((p) => ({ x: p.x, y: p.y - w * 0.22 })), edge(s.light, Math.max(1.2, w * 0.2)), opacity * 0.5);
  }

  // ---------------------------------------------------------------- routes: a faint line, chevrons always, dots when there is motion
  const chevron = Math.max(5, unit / 70);
  const dotR = Math.max(4, unit / 75);
  for (const route of layout.routes) {
    const shade = shadeFor(route.ink, look);
    const stretch = stretchOf(route, layout.lit === null ? null : new Set(layout.lit));
    const inStretch = (arc: number): boolean => stretch !== null && arc >= stretch.from - 1e-6 && arc <= stretch.to + 1e-6;
    const quiet = layout.lit !== null;
    const poly: Poly = route.poly;
    // the way itself, then the part of it that runs now
    lineShape(`route:${route.id}`, `route:${route.id}`, poly.pts, edge(shade.outline, Math.max(1.6, unit / 260)), quiet ? DIM * 0.7 : 0.75);
    const chevrons = chevronsOn(route, Math.max(34, Math.min(64, unit * 0.14)));
    chevrons.forEach((c, i) => {
      const pts = chevronPoints(c, chevron);
      lineShape(`route:${route.id}:chevron:${i}`, `route:${route.id}`, pts, edge(shade.outline, Math.max(2.2, unit / 190)), inStretch(c.arc) || !quiet ? 1 : DIM);
    });
    if (options.motion && stretch !== null) {
      const spacing = Math.max(80, Math.min(layout.subject.width, layout.subject.height) * 0.6);
      dotsOn(route, stretch, options.ambient, spacing).forEach((d, i) => {
        closedShape(`route:${route.id}:dot:${i}~halo`, `route:${route.id}`, circle(d.at, dotR + 2.2), flat(look.ground, 0.9), null, 1);
        closedShape(`route:${route.id}:dot:${i}`, `route:${route.id}`, circle(d.at, dotR), flat(shade.top, 1, shade.bottom), edge(shade.outline, 1.6), 1);
      });
    }
  }

  // ---------------------------------------------------------------- labels: a leader, a dot where it lands, the words
  for (const label of layout.labels) {
    // a label keeps more than its part: the part is at DIM when unlit, the words at LABEL_DIM
    const opacity = LABEL_DIM + (1 - LABEL_DIM) * ((light(label.part) - DIM) / (1 - DIM));
    const a = label.leader[0];
    const b = label.leader[1];
    lineShape(`label:${label.part}:leader`, label.part, [a, b], edge(look.ink, Math.max(1.2, unit / 400)), opacity * 0.8);
    closedShape(`label:${label.part}:end`, label.part, circle(b, Math.max(2.4, unit / 230)), flat(look.ink), edge(look.ground, 1), opacity);
    label.lines.forEach((line, i) => {
      const y = label.box.y + i * label.lineHeight;
      const box = text(`label:${label.part}:${i}`, label.part, line, { x: label.box.x, y, width: label.box.width }, label.px, false, look.ink, label.align, opacity, label.lineHeight);
      words.push({ part: `label:${label.part}`, text: line, box, px: label.px, ink: 'ink', colour: look.ink, on: look.ground });
    });
  }

  // ---------------------------------------------------------------- the band: the caption that never retires, and the stepper in the same box
  const { chrome } = layout;
  if (chrome.band.height > 0) {
    const plate = mix(look.ground, look.ink, 0.07);
    const rim = mix(look.ground, look.ink, 0.22);
    const b = { x: chrome.band.x + 1, y: chrome.band.y + 1, width: chrome.band.width - 2, height: chrome.band.height - 2 };
    closedShape('band', 'band', roundRect(b, 10), flat(plate), edge(rim, 1), 1);
    chrome.caption.lines.forEach((line, i) => {
      const box = text(`caption:${i}`, 'caption', line, { x: chrome.caption.box.x, y: chrome.caption.box.y + i * chrome.lineHeight, width: chrome.caption.box.width }, chrome.px, chrome.caption.bold, look.ink, 'left', 1, chrome.lineHeight);
      words.push({ part: 'caption', text: line, box, px: chrome.px, ink: 'ink', colour: look.ink, on: plate });
    });
    if (chrome.stepper !== null) {
      const { prev, next, counter } = chrome.stepper;
      const last = layout.input.steps.length;
      const button = (key: 'prev' | 'next', box: Rect, enabled: boolean): void => {
        const hot = key === 'next' && layout.step === 0;
        closedShape(`stepper:${key}`, `stepper:${key}`, roundRect(box, 12), flat(mix(look.ground, look.ink, hot ? 0.2 : 0.12)), edge(mix(look.ground, look.ink, hot ? 0.7 : 0.4), hot ? 2 : 1.2), enabled ? 1 : 0.35);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const k = Math.min(box.width, box.height) * 0.17;
        const dir = key === 'prev' ? -1 : 1;
        lineShape(`stepper:${key}:glyph`, `stepper:${key}`, [{ x: cx - dir * k * 0.6, y: cy - k * 1.3 }, { x: cx + dir * k * 0.7, y: cy }, { x: cx - dir * k * 0.6, y: cy + k * 1.3 }], edge(look.ink, 2.6), enabled ? 1 : 0.35);
      };
      button('prev', prev, layout.step > 0);
      button('next', next, layout.step < last);
      const lh = Math.round(chrome.px * 1.3);
      const box = text('stepper:counter', 'stepper:counter', counter.text, { x: counter.box.x, y: counter.box.y + (counter.box.height - lh) / 2, width: counter.box.width }, chrome.px, false, look.ink, 'center', 1, lh);
      words.push({ part: 'stepper:counter', text: counter.text, box, px: chrome.px, ink: 'ink', colour: look.ink, on: plate });
    }
  }
  return { figures, elements, words };
}
