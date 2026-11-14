// Tens and ones, as rods and cubes. Interactions: tap a rod or a cube to take it away (tap again to put it back); break a ten into
// ones (to take away what a tens-and-ones sum needs). What is left is said as tens and ones; the number it makes goes through `seal`.

import { h } from '../dom';
import type { VisualSpec } from '../types';
import { numberOf, numbersOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'blocks' }>;

export const blocks: Widget<Spec> = {
  interactions: ['tap a ten or a one to take it away', 'break a ten into ones'],
  draw(spec, ctx) {
    const broken = Math.min(numberOf(ctx.get('broken'), 0), spec.tens);
    const takenT = numbersOf(ctx.get('takenT'));
    const takenO = numbersOf(ctx.get('takenO'));
    const rods = spec.tens - broken;
    const cubes = spec.ones + broken * 10;
    const tens = h('div', { class: 'rods' });
    for (let i = 0; i < rods; i += 1) {
      const gone = takenT.includes(i);
      const rod = h('span', { class: 'rod' });
      for (let c = 0; c < 10; c += 1) rod.append(h('i'));
      tens.append(h('button', { type: 'button', class: `blk${gone ? ' gone' : ''}`, 'data-act': `ten:${i}`, 'aria-pressed': gone, 'aria-label': gone ? 'a ten, taken away' : 'a ten', onclick: () => ctx.set('takenT', gone ? takenT.filter((x) => x !== i) : [...takenT, i]) }, rod));
    }
    const ones = h('div', { class: 'cubes' });
    for (let i = 0; i < cubes; i += 1) {
      const gone = takenO.includes(i);
      ones.append(h('button', { type: 'button', class: `blk one${gone ? ' gone' : ''}`, 'data-act': `one:${i}`, 'aria-pressed': gone, 'aria-label': gone ? 'a one, taken away' : 'a one', onclick: () => ctx.set('takenO', gone ? takenO.filter((x) => x !== i) : [...takenO, i]) }, h('i')));
    }
    const leftT = rods - takenT.filter((i) => i < rods).length;
    const leftO = cubes - takenO.filter((i) => i < cubes).length;
    const said = `Left: ${leftT} ${leftT === 1 ? 'ten' : 'tens'} and ${leftO} ${leftO === 1 ? 'one' : 'ones'}`;
    const touched = takenT.length + takenO.length + broken > 0;
    const controls = h(
      'div',
      { class: 'controls' },
      rods - takenT.filter((i) => i < rods).length > 0 && rods > 0 ? press('Break a ten into ones', 'break', () => ctx.set('broken', broken + 1)) : null,
      touched ? press('Put them all back', 'again', () => { ctx.set('takenT', []); ctx.set('takenO', []); ctx.set('broken', 0); }) : null,
    );
    return h('div', { class: 'vis vis-blocks' }, h('div', { class: 'blocks-row' }, tens, ones), readout(`${said} = ${ctx.seal(leftT * 10 + leftO)}`), controls);
  },
};
