// A bar model: a whole cut into pieces, a piece possibly a gap ("?"). Interactions: tap a piece to add it into the sum; start again.
// The sum is said as work ("6 + 2 = 8") and every total goes through `seal`.

import { h } from '../dom';
import type { VisualSpec } from '../types';
import { numbersOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'bar' }>;

export const bar: Widget<Spec> = {
  interactions: ['tap a piece to add it in', 'start again'],
  draw(spec, ctx) {
    const lit = numbersOf(ctx.get('lit')).filter((i) => i < spec.parts.length);
    const row = h('div', { class: 'bar' });
    spec.parts.forEach((value, i) => {
      const on = lit.includes(i);
      const label = value === null ? '?' : ctx.seal(value);
      row.append(h('button', { type: 'button', class: `seg s${i % 3}${on ? ' lit' : ''}`, style: `flex:${Math.max(1, value ?? 1)} 1 0`, 'data-act': `seg:${i}`, 'aria-pressed': on, onclick: () => ctx.set('lit', on ? lit.filter((x) => x !== i) : [...lit, i]) }, label));
    });
    const taken = [...lit].sort((a, b) => a - b).flatMap((i) => spec.parts[i] ?? []);
    const sum = taken.length === 0 ? 'Tap the pieces to add them up' : taken.length === 1 ? `${ctx.seal(taken[0] ?? 0)}` : `${taken.join(' + ')} = ${ctx.seal(taken.reduce((a, b) => a + b, 0))}`;
    return h(
      'div',
      { class: 'vis vis-bar' },
      row,
      spec.total === null ? null : h('p', { class: 'whole' }, `The whole bar: ${ctx.seal(spec.total)}`),
      readout(sum),
      h('div', { class: 'controls' }, lit.length > 0 ? press('Start again', 'again', () => ctx.set('lit', [])) : null),
    );
  },
};
