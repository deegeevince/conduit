// Map: pins where the brain put them, each labelled in the first of eight
// places round it that is clear, else out along a leader no longer than three
// body lines. The route is one line through the pins in order, under them.

import type { Point, Polyline } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import type { Box } from '../../contracts/space';
import { box, circle, contains, inflate, open, overlaps, polylineHitsBox, right, bottom, union } from './geom';
import type { Draft, Note } from './kit';
import { Env, fit, wordsOf } from './kit';

export function layoutMap(input: StructureInput): StructureLayout {
  return fit(input, input.look.stroke, (env) => buildMap(env));
}

function buildMap(env: Env): Draft {
  const input = env.input;
  const room = input.room;
  const body = env.body;
  const r = Math.max(3.5, env.stroke * 0.75);
  const pins = input.nodes.map((el) => {
    const v = el.figure?.kind === 'node' ? el.figure.values : [];
    const w = wordsOf(el, input.scope);
    const x = input.canvas.origin.x + (v[0] ?? 0) * input.canvas.unit;
    const y = input.canvas.origin.y + (v[1] ?? 0) * input.canvas.unit;
    return { el, text: w.text, emphasis: w.emphasis, p: { x, y }, m: env.measure(w.text) };
  });
  const f = input.structure.figure;
  const route: Polyline | null = f?.kind === 'structure' && f.route && pins.length > 1 ? open(pins.map((p) => p.p)) : null;
  const dots = pins.map((p) => box(p.p.x - r, p.p.y - r, 2 * r, 2 * r));
  const lines: Polyline[] = route ? [route] : [];
  const placed: Box[] = [];
  const titleText = input.structure.text.trim();
  if (titleText) {
    const tm = env.measure(titleText, room.width, { ...env.spec, size: 'l' });
    placed.push(box(room.x, room.y, tm.width, tm.height));
  }
  const leaders: Polyline[] = [];
  const notes: Note[] = [];
  const labelAt: ({ b: Box; lead: Polyline | null; side: number } | null)[] = [];
  const pad = 2;
  let bad = 0;

  pins.forEach((pin, idx) => {
    const { w, h } = { w: pin.m.width, h: pin.m.height };
    const d0 = r + 0.4 * body;
    const dirs = [
      (d: number) => box(pin.p.x + d, pin.p.y - h / 2, w, h),
      (d: number) => box(pin.p.x + d * 0.7, pin.p.y - d * 0.7 - h, w, h),
      (d: number) => box(pin.p.x - w / 2, pin.p.y - d - h, w, h),
      (d: number) => box(pin.p.x - d * 0.7 - w, pin.p.y - d * 0.7 - h, w, h),
      (d: number) => box(pin.p.x - d - w, pin.p.y - h / 2, w, h),
      (d: number) => box(pin.p.x - d * 0.7 - w, pin.p.y + d * 0.7, w, h),
      (d: number) => box(pin.p.x - w / 2, pin.p.y + d, w, h),
      (d: number) => box(pin.p.x + d * 0.7, pin.p.y + d * 0.7, w, h),
    ];
    const cost = (b: Box, lead: Polyline | null): number => {
      let n = 0;
      const g = inflate(b, pad);
      if (!contains(room, b, 0.5)) n += 4;
      dots.forEach((dt, j) => {
        if (j !== idx && overlaps(g, dt)) n += 1;
        if (j === idx && overlaps(g, inflate(dt, 1))) n += 1;
      });
      for (const o of placed) if (overlaps(g, o)) n += 1;
      for (const o of input.obstacles) if (overlaps(g, o)) n += 1;
      for (const l of lines) if (polylineHitsBox(l, g)) n += 1;
      for (const l of leaders) if (polylineHitsBox(l, g)) n += 1;
      if (lead) {
        for (const o of placed) if (polylineHitsBox(lead, inflate(o, 1))) n += 1;
        dots.forEach((dt, j) => {
          if (j !== idx && polylineHitsBox(lead, dt)) n += 1;
        });
        for (const o of input.obstacles) if (polylineHitsBox(lead, o)) n += 1;
        for (const l of lines) if (l !== route) n += 0;
      }
      return n;
    };
    let best: { b: Box; lead: Polyline | null; n: number; side: number } | null = null;
    const tryAll = (): void => {
      for (let k = 0; k <= 3 && (!best || best.n > 0); k += 1) {
        const d = d0 + k * body;
        for (let s = 0; s < 8; s += 1) {
          const b = (dirs[s] as (d: number) => Box)(d);
          let lead: Polyline | null = null;
          if (k > 0) {
            const nx = Math.max(b.x, Math.min(pin.p.x, right(b)));
            const ny = Math.max(b.y, Math.min(pin.p.y, bottom(b)));
            const ang = Math.atan2(ny - pin.p.y, nx - pin.p.x);
            lead = open([{ x: pin.p.x + Math.cos(ang) * r, y: pin.p.y + Math.sin(ang) * r }, { x: nx, y: ny }]);
          }
          const n = cost(b, lead);
          if (!best || n < best.n) best = { b, lead, n, side: s };
          if (n === 0) return;
        }
      }
    };
    tryAll();
    const pick = best as { b: Box; lead: Polyline | null; n: number; side: number } | null;
    if (!pick) {
      labelAt.push(null);
      return;
    }
    if (pick.n > 0) {
      bad += 1;
      notes.push({ key: pin.el.key, note: 'collides' });
    }
    placed.push(pick.b);
    if (pick.lead) leaders.push(pick.lead);
    labelAt.push(pick);
  });
  for (const p of pins) if (!contains(room, box(p.p.x - r, p.p.y - r, 2 * r, 2 * r), 0.5)) notes.push({ key: p.el.key, note: 'clipped' });

  const finish = (): ReturnType<Draft['finish']> => {
    const boxes = new Map<string, Box>();
    const parts: BlockPart[] = [];
    const key = input.structure.key;
    const title = input.structure.text.trim();
    if (title) {
      const m = env.measure(title, room.width, { ...env.spec, size: 'l' });
      parts.push({ kind: 'text', owner: key, part: 'title', text: title, emphasis: [], box: box(room.x, room.y, m.width, m.height), spec: { ...env.spec, size: 'l' }, align: 'left', role: 'title', plate: false });
    }
    if (route) parts.push({ kind: 'shape', owner: key, part: 'route', outline: [route], role: 'line' });
    pins.forEach((pin, i) => {
      const lab = labelAt[i];
      parts.push({ kind: 'shape', owner: pin.el.key, part: 'dot', outline: [circle(pin.p.x, pin.p.y, r)], role: 'marker' });
      let all = dots[i] as Box;
      if (lab) {
        if (lab.lead) parts.push({ kind: 'shape', owner: pin.el.key, part: 'leader', outline: [lab.lead], role: 'line' });
        const side = lab.side;
        const align: 'left' | 'right' | 'center' = side === 0 || side === 1 || side === 7 ? 'left' : side === 4 || side === 3 || side === 5 ? 'right' : 'center';
        parts.push({ kind: 'text', owner: pin.el.key, part: 'label', text: pin.text, emphasis: pin.emphasis, box: lab.b, spec: env.spec, align, role: 'label', plate: false });
        all = union([all, lab.b]);
      }
      boxes.set(pin.el.key, all);
    });
    return { parts, boxes, routes: new Map<string, Polyline>(), notes };
  };
  return { width: bad > 0 ? room.width + 1 : 0, height: 0, finish };
}

export type { Point };
