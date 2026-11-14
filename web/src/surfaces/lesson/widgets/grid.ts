// A shape on a square grid, as the writer transcribed it from the page (`cells=`: rows from the top, `x` a whole square, `h` a half square, `o`
// empty). She taps a square to tick it (one tick is one square, a ticked half is half), and the count she has ticked so far is beside it, big.
// The cells are the question's own figure; the count is her own tally and goes through `seal` like every number a widget shows.

import { h } from '../dom';
import type { VisualSpec } from '../types';
import { numbersOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'grid' }>;

export const grid: Widget<Spec> = {
  interactions: ['tap a square to tick it', 'tap again to take the tick away'],
  draw(spec, ctx) {
    const ticked = numbersOf(ctx.get('ticks'));
    const width = Math.max(...spec.rows.map((row) => row.length));
    const board = h('div', { class: 'gridfig', style: `--cols:${width}` });
    let count = 0;
    spec.rows.forEach((row, y) => {
      for (let x = 0; x < width; x += 1) {
        const kind = row[x] ?? 'o';
        const at = y * width + x;
        if (kind === 'o') {
          board.append(h('span', { class: 'gcell empty' }));
          continue;
        }
        const on = ticked.includes(at);
        if (on) count += kind === 'h' ? 0.5 : 1;
        board.append(h('button', { type: 'button', class: `gcell ${kind === 'h' ? 'half' : 'whole'}${on ? ' on' : ''}`, 'data-act': `cell:${x},${y}`, 'aria-pressed': on, 'aria-label': `${kind === 'h' ? 'half square' : 'square'}, ${on ? 'ticked' : 'not ticked'}`, onclick: () => ctx.set('ticks', on ? ticked.filter((t) => t !== at) : [...ticked, at]) }, on ? '✓' : ''));
      }
    });
    const says = `Squares ticked: ${ctx.seal(count)}`;
    return h('div', { class: 'grid-widget' }, board, readout(says), ticked.length > 0 ? press('Start again', 'again', () => ctx.set('ticks', [])) : null);
  },
};
