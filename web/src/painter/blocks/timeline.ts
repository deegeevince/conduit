// Timeline: one axis to scale with ticks at round numbers. An event is a dot
// with its words above or below (alternating) joined by a short tick, stacked
// in tiers when dates crowd; a span is a bar. On a portrait room the axis is
// vertical and the words are to its right.

import type { Point, Polyline } from '@conduit/language';
import { EMPTY_STRUCTURE_LAYOUT } from '../../contracts/blocks';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, circle, open, overlaps, packOrdered, polylineHitsBox, roundedRect, union } from './geom';
import type { Draft, Note } from './kit';
import { Env, fit, niceStep, wordsOf } from './kit';

interface Item {
  readonly key: string;
  readonly text: string;
  readonly emphasis: readonly { start: number; end: number }[];
  readonly t0: number;
  readonly t1: number | null;
}

interface Slot {
  /** label extents along the axis and across it */
  eu: number;
  ev: number;
  box: Box | null;
  u: number;
  lead: Point[];
  v0: number;
}

export function layoutTimeline(input: StructureInput): StructureLayout {
  if (input.nodes.length === 0) return EMPTY_STRUCTURE_LAYOUT;
  return fit(input, input.look.stroke, (env) => buildTimeline(env));
}

function tickText(v: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const s = Math.abs(v).toFixed(Math.min(6, decimals));
  const [i, f] = s.split('.');
  const grouped = Math.abs(v) >= 10000 ? (i as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : (i as string);
  return `${v < 0 ? '-' : ''}${grouped}${f ? `.${f}` : ''}`;
}

function buildTimeline(env: Env): Draft {
  const input = env.input;
  const room = input.room;
  const vertical = room.height > room.width;
  const body = env.body;
  const small = env.small();
  const ER = Math.max(4, env.stroke * 1.5);

  const items: Item[] = [];
  let lastT = 0;
  for (const el of input.nodes) {
    const vals = el.figure?.kind === 'node' ? el.figure.values : [];
    const a = vals[0];
    const b = vals[1];
    const t0 = a !== undefined && Number.isFinite(a) ? (b !== undefined ? Math.min(a, b) : a) : lastT;
    const t1 = a !== undefined && b !== undefined && b !== a ? Math.max(a, b) : null;
    lastT = t1 ?? t0;
    const w = wordsOf(el, input.scope);
    items.push({ key: el.key, text: w.text, emphasis: w.emphasis, t0, t1 });
  }
  items.sort((x, y) => x.t0 - y.t0);
  const tmin = items.length ? Math.min(...items.map((i) => i.t0)) : 0;
  const tmax = items.length ? Math.max(...items.map((i) => i.t1 ?? i.t0)) : 1;

  const title = input.structure.text.trim();
  const titleM = title ? env.measure(title, input.room.width, { ...env.spec, size: 'l' }) : null;
  const titleH = titleM ? titleM.height + body : 0;
  const U = vertical ? room.height - titleH : room.width;
  const ext = (m: { width: number; height: number }): { eu: number; ev: number } => (vertical ? { eu: m.height, ev: m.width } : { eu: m.width, ev: m.height });
  const maxTiers = Math.max(2, items.length);
  const minShrinkNow = env.shrink <= input.look.minShrink + 1e-6;

  const attempt = (wrap: number) => {
    const meas = items.map((i) => env.measure(i.text, wrap));
    const padU = Math.max(0, ...meas.map((m) => ext(m).eu)) / 2;
    const sampleM = env.measure('0000', 1e9, small);
    const tickEu = vertical ? sampleM.height : sampleM.width;
    const L = Math.max(10, U - 2 * padU);
    const raw = (tmax - tmin) / Math.max(2, Math.min(9, Math.floor(L / (tickEu * 2.4))));
    const step = tmax > tmin ? niceStep(raw) : 1;
    let lo = Math.floor(tmin / step + 1e-9) * step;
    let hi = Math.ceil(tmax / step - 1e-9) * step;
    if (hi <= lo) hi = lo + step;
    if (lo === tmin && tmax > tmin && false) lo -= step;
    const uOf = (t: number): number => padU + ((t - lo) / (hi - lo)) * L;
    const tickLen = 0.35 * body;
    const ticks: { t: number; u: number; text: string; m: { width: number; height: number; lineHeight: number; lines: unknown } }[] = [];
    for (let t = lo; t <= hi + step * 1e-6; t += step) {
      const text = tickText(Math.round(t / step * 1e6) / 1e6 * step, step);
      ticks.push({ t, u: uOf(t), text, m: env.measure(text, 1e9, small) as never });
    }
    const tickBoxes: Box[] = [];
    const toBox = (u: number, v: number, eu: number, ev: number): Box => (vertical ? box(v, u, ev, eu) : box(u, v, eu, ev));
    // tick labels sit on the near side: below a horizontal axis, left of a vertical one
    const tickEv = Math.max(...ticks.map((tk) => ext(tk.m).ev));
    for (const tk of ticks) {
      const e = ext(tk.m);
      const v = vertical ? -(tickLen + 0.3 * body + e.ev) : tickLen + 0.3 * body;
      tickBoxes.push(toBox(tk.u - e.eu / 2, v, e.eu, e.ev));
    }
    const below0 = vertical ? ER + 0.8 * body : tickLen + 0.3 * body + tickEv + 0.7 * body;
    const above0 = ER + 0.8 * body;
    const maxEv = Math.max(0, ...meas.map((m) => ext(m).ev));
    const tierStep = maxEv + 0.6 * body;
    // two events on one date would sit on one dot: the later is moved along by a dot's width
    const dotU: number[] = [];
    items.forEach((it, idx) => {
      const want = it.t1 === null ? uOf(it.t0) : (uOf(it.t0) + uOf(it.t1)) / 2;
      const prev = dotU[idx - 1];
      dotU.push(prev !== undefined && items[idx - 1]?.t1 === null && it.t1 === null ? Math.max(want, prev + 2 * ER + 2) : want);
    });
    const placed: Box[] = [];
    const leads: Polyline[] = [];
    const slots: Slot[] = [];
    const notes: Note[] = [];
    const gap = 0.35 * body;
    // A vertical axis: the words stand in one column to its right, in the order of their dates, as near their dots as they can be
    // with room between them; each leader runs from its dot to its words, and leaders in one order never cross.
    let needU = U;
    let column: number[] | null = null;
    if (vertical && items.length > 0) {
      const eus = meas.map((m) => ext(m).eu);
      const spacing = eus.slice(1).map((e, i) => (e + (eus[i] as number)) / 2 + gap);
      const packed = packOrdered(dotU, spacing, items.map(() => 1));
      const first = (packed[0] as number) - (eus[0] as number) / 2;
      const last = (packed[packed.length - 1] as number) + (eus[eus.length - 1] as number) / 2;
      const span = last - first;
      let shift = 0;
      if (first < 0) shift = -first;
      else if (last > U) shift = Math.max(-first, U - last);
      column = packed.map((p) => p + shift);
      needU = Math.max(U, span);
    }
    items.forEach((it, idx) => {
      const m = meas[idx] as (typeof meas)[number];
      const e = ext(m);
      const uc = dotU[idx] as number;
      const uLo = Math.max(0, Math.min(uc - e.eu / 2, U - e.eu));
      const first = idx % 2 === 0 ? 1 : -1;
      const order: { side: 1 | -1; tier: number }[] = [];
      for (let tier = 0; tier < maxTiers; tier += 1) {
        if (vertical) order.push({ side: 1, tier });
        else {
          order.push({ side: first as 1 | -1, tier });
          order.push({ side: -first as 1 | -1, tier });
        }
      }
      if (column !== null) {
        const centre = column[idx] as number;
        const b = toBox(centre - e.eu / 2, below0, e.eu, e.ev);
        const lead: Point[] = [{ x: ER, y: uc }, { x: below0 - 0.25 * body, y: centre }];
        placed.push(b);
        leads.push({ points: lead, closed: false });
        slots.push({ eu: e.eu, ev: e.ev, box: b, u: uc, lead, v0: 0 });
        return;
      }
      let best: { b: Box; lead: Point[]; bad: number } | null = null;
      for (const o of order) {
        const base = o.side === 1 ? below0 : above0;
        const v0 = o.side === 1 ? base + o.tier * tierStep : -(base + o.tier * tierStep) - e.ev;
        const b = toBox(uLo, v0, e.eu, e.ev);
        const near = o.side === 1 ? v0 : v0 + e.ev;
        const lead: Point[] = vertical
          ? [{ x: o.side === 1 ? ER : -ER, y: uc }, { x: near, y: uc }]
          : [{ x: uc, y: o.side === 1 ? ER : -ER }, { x: uc, y: near }];
        const line: Polyline = { points: lead, closed: false };
        let bad = 0;
        for (const p of placed) if (overlaps(b, p, gap)) bad += 1;
        for (const l of leads) if (polylineHitsBox(l, box(b.x - 1, b.y - 1, b.width + 2, b.height + 2))) bad += 1;
        for (const p of placed) if (polylineHitsBox(line, box(p.x - 1, p.y - 1, p.width + 2, p.height + 2))) bad += 1;
        for (const tb of tickBoxes) {
          if (overlaps(b, tb, gap)) bad += 1;
          if (polylineHitsBox(line, box(tb.x - 1, tb.y - 1, tb.width + 2, tb.height + 2))) bad += 1;
        }
        if (!best || bad < best.bad) best = { b, lead, bad };
        if (bad === 0) break;
      }
      const pick = best as { b: Box; lead: Point[]; bad: number };
      if (pick.bad > 0) notes.push({ key: it.key, note: 'collides' });
      placed.push(pick.b);
      leads.push({ points: pick.lead, closed: false });
      slots.push({ eu: e.eu, ev: e.ev, box: pick.b, u: uc, lead: pick.lead, v0: 0 });
    });
    const everything = [...placed, ...tickBoxes, toBox(0, -ER, U, 2 * ER)];
    const bounds = union(everything);
    return { dotU, lo, hi, meas, slots, notes, step, ticks, tickBoxes, bounds, uOf, bad: notes.length, tickLen, toBox, wrap, needU };
  };

  const wide = vertical ? Math.max(env.wrapWidth, Math.min(room.width * 0.6, env.wrapWidth * 1.8)) : env.wrapWidth;
  let r = attempt(wide);
  if (r.bad > 0) {
    const narrow = attempt(Math.max(body * 4, wide * 0.62));
    if (narrow.bad < r.bad || (narrow.bad === r.bad && (vertical ? narrow.bounds.width < r.bounds.width : narrow.bounds.height < r.bounds.height))) r = narrow;
  }
  void minShrinkNow;
  const bounds = r.bounds;
  const width = vertical ? bounds.width : U;
  const height = (vertical ? r.needU : bounds.height) + titleH;

  const finish = (rm: Box): ReturnType<Draft['finish']> => {
    // `u` runs from the room's start; `v` is centred in what the title leaves.
    const content = (vertical ? rm.width : rm.height) - (vertical ? 0 : titleH);
    void content;
    const vShift = vertical ? rm.x + (rm.width - bounds.width) / 2 - bounds.x : rm.y + titleH + (rm.height - titleH - bounds.height) / 2 - bounds.y;
    const uShift = vertical ? rm.y + titleH : rm.x;
    const T = (p: Point): Point => (vertical ? { x: p.x + vShift, y: p.y + uShift } : { x: p.x + uShift, y: p.y + vShift });
    const TB = (b: Box): Box => (vertical ? box(b.x + vShift, b.y + uShift, b.width, b.height) : box(b.x + uShift, b.y + vShift, b.width, b.height));
    const boxes = new Map<string, Box>();
    const parts: BlockPart[] = [];
    const key = input.structure.key;
    const along = (u: number, v: number): Point => T(vertical ? { x: v, y: u } : { x: u, y: v });
    if (titleM)
      parts.push({ kind: 'text', owner: key, part: 'title', text: title, emphasis: [], box: box(rm.x, rm.y, titleM.width, titleM.height), spec: { ...env.spec, size: 'l' }, align: 'left', role: 'title', plate: false });
    parts.push({ kind: 'shape', owner: key, part: 'axis', outline: [open([along(r.uOf(r.lo), 0), along(r.uOf(r.hi), 0)])], role: 'line' });
    r.ticks.forEach((tk, i) => {
      parts.push({ kind: 'shape', owner: key, part: `tick:${i}`, outline: [open([along(tk.u, 0), along(tk.u, vertical ? -r.tickLen : r.tickLen)])], role: 'grid' });
      const tb = TB(r.tickBoxes[i] as Box);
      parts.push({ kind: 'text', owner: key, part: `tick:${i}`, text: tk.text, emphasis: [], box: tb, spec: env.small(), align: vertical ? 'right' : 'center', role: 'tick', plate: false });
    });
    items.forEach((it, i) => {
      const s = r.slots[i] as Slot;
      const lb = TB(s.box as Box);
      const lead = s.lead.map(T);
      let mark: Box;
      if (it.t1 === null) {
        const c = along(r.dotU[i] as number, 0);
        mark = box(c.x - ER, c.y - ER, 2 * ER, 2 * ER);
        parts.push({ kind: 'shape', owner: it.key, part: 'dot', outline: [circle(c.x, c.y, ER)], role: 'marker' });
      } else {
        const a = along(r.uOf(it.t0), 0);
        const b = along(r.uOf(it.t1), 0);
        const th = Math.max(ER, env.stroke * 1.5);
        mark = vertical ? box(a.x - th, a.y, 2 * th, b.y - a.y) : box(a.x, a.y - th, b.x - a.x, 2 * th);
        parts.push({ kind: 'shape', owner: it.key, part: 'bar', outline: [roundedRect(mark, input.look.radius > 0 ? th / 2 : 0)], role: 'bar' });
      }
      parts.push({ kind: 'shape', owner: it.key, part: 'leader', outline: [open(lead)], role: 'line' });
      parts.push({
        kind: 'text',
        owner: it.key,
        part: 'words',
        text: it.text,
        emphasis: it.emphasis,
        box: lb,
        spec: env.spec,
        align: vertical ? 'left' : 'center',
        role: 'words',
        plate: false,
      });
      boxes.set(it.key, union([mark, lb]));
    });
    return { parts, boxes, routes: new Map(), notes: r.notes };
  };
  return { width, height, finish };
}
