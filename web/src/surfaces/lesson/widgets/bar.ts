// A bar model. `parts`: one bar cut into pieces; tap a piece to add it into the sum. `of`/`n`: equal bars, one more a tap. The sum is
// said as work ("6 + 2 = 8") and its total goes through `seal`.

import { h } from '../dom';
import type { VisualSpec } from '../types';
import { numberOf, numbersOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'bar' }>;

export const bar: Widget<Spec> = {
  interactions: ['tap a piece to add it in', 'add another equal bar', 'start again'],
  draw(spec, ctx) {
    if (spec.parts.length > 0) {
      const lit = numbersOf(ctx.get('lit'));
      const row = h('div', { class: 'bar' });
      spec.parts.forEach((value, i) => {
        const on = lit.includes(i);
        row.append(h('button', { type: 'button', class: `seg s${i % 3}${on ? ' lit' : ''}`, style: `flex:${Math.max(1, value)} 1 0`, 'data-act': `seg:${i}`, 'aria-pressed': on, onclick: () => ctx.set('lit', on ? lit.filter((x) => x !== i) : [...lit, i]) }, ctx.seal(value)));
      });
      const taken = [...lit].sort((a, b) => a - b).map((i) => spec.parts[i] ?? 0);
      const sum = taken.length === 0 ? 'Tap the pieces to add them up' : taken.length === 1 ? `${taken[0]}` : `${taken.join(' + ')} = ${ctx.seal(taken.reduce((a, b) => a + b, 0))}`;
      return h('div', { class: 'vis vis-bar' }, row, readout(sum), h('div', { class: 'controls' }, lit.length > 0 ? press('Start again', 'again', () => ctx.set('lit', [])) : null));
    }
    const more = numberOf(ctx.get('more'), 0);
    const shown = Math.min(spec.n, 1 + more);
    const row = h('div', { class: 'bar equal' });
    for (let i = 0; i < shown; i += 1) row.append(h('span', { class: `seg s${i % 3}`, style: 'flex:1 1 0' }, ctx.seal(spec.of)));
    const said = shown === 1 ? `1 bar of ${ctx.seal(spec.of)}` : `${shown} bars of ${ctx.seal(spec.of)} = ${ctx.seal(shown * spec.of)}`;
    return h(
      'div',
      { class: 'vis vis-bar' },
      row,
      readout(said),
      h('div', { class: 'controls' }, shown < spec.n ? press('Add another bar', 'add', () => ctx.set('more', more + 1), 'main') : null, shown > 1 ? press('Start again', 'again', () => ctx.set('more', 0)) : null),
    );
  },
};
