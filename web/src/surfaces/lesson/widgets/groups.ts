// Groups of counters (vases of flowers, pots, bags). Interactions: tap a group to count it (its counters number off, and the running
// sum grows: 12 + 12 + 12); add another group. The sum goes through `seal`, so it can show 12 + 12 + 12 = 36 and never the last total.

import { h } from '../dom';
import type { VisualSpec } from '../types';
import { numberOf, numbersOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'groups' }>;

export const groups: Widget<Spec> = {
  interactions: ['tap a group to count it', 'add another group'],
  draw(spec, ctx) {
    const added = numberOf(ctx.get('added'), 0);
    const shown = Math.min(spec.groups, spec.start + added);
    const counted = numbersOf(ctx.get('counted')).filter((i) => i < shown);
    const tiles = h('div', { class: 'tiles' });
    for (let i = 0; i < shown; i += 1) {
      const on = counted.includes(i);
      const counters = h('div', { class: 'counters', style: `--cols:${Math.min(spec.of, spec.of > 8 ? 4 : spec.of > 4 ? 3 : spec.of)}` });
      let n = 0;
      const parts = spec.parts.length === 0 ? [spec.of] : spec.parts;
      parts.forEach((count, part) => {
        for (let c = 0; c < count; c += 1) {
          n += 1;
          counters.append(h('span', { class: `counter p${part % 3}` }, on ? ctx.seal(n) : null));
        }
      });
      const tile = h(
        'button',
        { type: 'button', class: `tile${on ? ' counted' : ''}${ctx.fresh === 'counted' && counted[counted.length - 1] === i ? ' pop' : ''}`, 'data-act': `group:${i}`, 'aria-pressed': on, onclick: () => ctx.set('counted', on ? counted.filter((c) => c !== i) : [...counted, i]) },
        counters,
        h('span', { class: 'tile-note' }, on ? `${ctx.seal(spec.of)} ${spec.thing}s` : `${spec.noun} ${i + 1}: tap to count`),
      );
      tiles.append(tile);
    }
    const terms = counted.map(() => String(spec.of));
    const total = counted.length * spec.of;
    const sum = counted.length === 0 ? null : counted.length === 1 ? `1 ${spec.noun}: ${ctx.seal(total)}` : `${terms.join(' + ')} = ${ctx.seal(total)}`;
    const controls = h('div', { class: 'controls' }, shown < spec.groups ? press(`Add another ${spec.noun}`, 'add', () => ctx.set('added', added + 1), 'main') : null, counted.length > 0 ? press('Count again', 'again', () => ctx.set('counted', [])) : null);
    return h('div', { class: 'vis vis-groups' }, tiles, readout(sum ?? `Tap a ${spec.noun} to count what is in it`), controls);
  },
};
