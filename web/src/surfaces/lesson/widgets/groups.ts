// Groups of counters (vases of flowers, pots, bags). Interaction: tap a group to count it (its counters number off, and the running sum
// grows: 12 + 12 + 12). The sum goes through `seal`, so it can show 12 + 12 + 12 = 36 and never the last total.

import { h } from '../dom';
import type { VisualSpec } from '../types';
import { numbersOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'groups' }>;

export const groups: Widget<Spec> = {
  interactions: ['tap a group to count it', 'count again'],
  draw(spec, ctx) {
    const counted = numbersOf(ctx.get('counted')).filter((i) => i < spec.count);
    const tiles = h('div', { class: 'tiles' });
    const cols = spec.each > 8 ? 4 : spec.each > 4 ? 3 : spec.each;
    for (let i = 0; i < spec.count; i += 1) {
      const on = counted.includes(i);
      const counters = h('div', { class: 'counters', style: `--cols:${cols}` });
      const parts = spec.parts.length === 0 ? [spec.each] : spec.parts;
      let n = 0;
      parts.forEach((size, part) => {
        for (let c = 0; c < size; c += 1) {
          n += 1;
          counters.append(h('span', { class: `counter p${part % 3}` }, on ? ctx.seal(n) : null));
        }
      });
      tiles.append(
        h(
          'button',
          { type: 'button', class: `tile${on ? ' counted' : ''}${ctx.fresh === 'counted' && counted[counted.length - 1] === i ? ' pop' : ''}`, 'data-act': `group:${i}`, 'aria-pressed': on, onclick: () => ctx.set('counted', on ? counted.filter((c) => c !== i) : [...counted, i]) },
          counters,
          h('span', { class: 'tile-note' }, on ? `${ctx.seal(spec.each)} ${spec.label}` : spec.count === 1 ? 'Tap to count' : `Group ${i + 1}: tap to count`),
        ),
      );
    }
    const total = counted.length * spec.each;
    const sum = counted.length === 0 ? null : counted.length === 1 ? `1 group: ${ctx.seal(total)}` : `${counted.map(() => String(spec.each)).join(' + ')} = ${ctx.seal(total)}`;
    const controls = h('div', { class: 'controls' }, counted.length > 0 ? press('Count again', 'again', () => ctx.set('counted', [])) : null);
    return h('div', { class: 'vis vis-groups' }, tiles, readout(sum ?? (spec.count === 1 ? 'Tap the group to count what is in it' : 'Tap a group to count what is in it')), controls);
  },
};
