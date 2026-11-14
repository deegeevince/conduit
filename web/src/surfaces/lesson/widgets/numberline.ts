// A number line she hops along. The line is drawn at the width it has, in real pixels, so its numbers are as big on a phone as on a desk.
// Interactions: hop (a button, or tap the line); start again. Landing places go through `seal`, so the last hop can land on a "?".

import { atWidth, h, s } from '../dom';
import type { VisualSpec } from '../types';
import { numberOf, press, readout } from './common';
import type { Widget, WidgetCtx } from './common';

type Spec = Extract<VisualSpec, { kind: 'numberline' }>;

function landings(spec: Spec): number[] {
  const out = [spec.mark ?? spec.from];
  for (const hop of spec.hops) out.push((out[out.length - 1] ?? 0) + hop);
  return out;
}

function paint(host: HTMLElement, width: number, spec: Spec, took: number, ctx: WidgetCtx): void {
  const pad = 28;
  const span = spec.to - spec.from;
  const x = (v: number): number => pad + ((v - spec.from) / span) * (width - 2 * pad);
  const lines = landings(spec);
  const lineY = 104;
  const svg = s('svg', { width, height: 200, viewBox: `0 0 ${width} 200`, role: 'img', 'aria-label': `A number line from ${spec.from} to ${spec.to}`, 'data-act': 'line' });
  svg.append(s('line', { x1: x(spec.from), y1: lineY, x2: x(spec.to), y2: lineY, class: 'nl-line' }));
  // label every k ticks so labels sit at least 52 pixels apart
  const per = (width - 2 * pad) / (span / spec.tick);
  const k = Math.max(1, Math.ceil(52 / per));
  for (let v = spec.from, i = 0; v <= spec.to + 1e-9; v += spec.tick, i += 1) {
    const major = i % k === 0;
    svg.append(s('line', { x1: x(v), y1: lineY - (major ? 12 : 7), x2: x(v), y2: lineY + (major ? 12 : 7), class: 'nl-tick' }));
    if (major) {
      const shown = ctx.seal(v);
      if (shown !== '?') svg.append(s('text', { x: x(v), y: lineY + 36, class: 'nl-num', 'text-anchor': 'middle' }, shown));
    }
  }
  const done = Math.min(took, spec.hops.length);
  for (let i = 0; i < done; i += 1) {
    const a = x(lines[i] ?? 0);
    const b = x(lines[i + 1] ?? 0);
    const peak = lineY - 50 - Math.min(18, Math.abs(b - a) / 6);
    svg.append(s('path', { d: `M${a},${lineY - 6} Q${(a + b) / 2},${peak} ${b},${lineY - 6}`, class: `nl-hop${ctx.fresh === 'hop' && i === done - 1 ? ' pop' : ''}` }));
    const amount = spec.hops[i] ?? 0;
    svg.append(s('text', { x: (a + b) / 2, y: peak - 6, class: 'nl-amount', 'text-anchor': 'middle' }, `${amount < 0 ? '−' : '+'}${Math.abs(amount)}`));
  }
  const now = lines[done] ?? lines[0] ?? 0;
  svg.append(s('circle', { cx: x(now), cy: lineY, r: 12, class: `nl-dot${ctx.fresh === 'hop' ? ' pop' : ''}` }));
  const spacing = Math.abs(x(lines[1] ?? 0) - x(lines[0] ?? 0));
  for (let i = 0; i <= done; i += 1) {
    const edge = i === 0 || i === done;
    if (!edge && spacing < 36) continue;
    svg.append(s('text', { x: x(lines[i] ?? 0), y: lineY + 74, class: 'nl-land', 'text-anchor': 'middle' }, ctx.seal(lines[i] ?? 0)));
  }
  host.replaceChildren(svg);
}

export const numberline: Widget<Spec> = {
  interactions: ['hop along the line, one hop a tap', 'start again'],
  draw(spec, ctx) {
    const took = Math.min(numberOf(ctx.get('hop'), 0), spec.hops.length);
    const canvas = h('div', { class: 'nl' });
    const hop = (): void => {
      if (took < spec.hops.length) ctx.set('hop', took + 1);
    };
    canvas.addEventListener('click', hop);
    atWidth(canvas, (width) => paint(canvas, width, spec, took, { ...ctx, fresh: ctx.fresh }));
    const next = spec.hops[took];
    const words = next === undefined ? 'No more hops' : `Hop ${next < 0 ? 'back' : 'on'} ${Math.abs(next)}`;
    const here = landings(spec)[took] ?? 0;
    const controls = h(
      'div',
      { class: 'controls' },
      spec.hops.length > 0 ? press(words, 'hop', hop, 'main', next === undefined) : null,
      took > 0 ? press('Start again', 'again', () => ctx.set('hop', 0)) : null,
    );
    return h('div', { class: 'vis vis-numberline' }, canvas, readout(spec.hops.length > 0 || spec.mark !== null ? `You are on ${ctx.seal(here)}` : null), controls);
  },
};
