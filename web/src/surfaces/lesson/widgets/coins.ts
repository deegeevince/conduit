// Coins. Interactions: tap a coin to put it in the tray, tap one in the tray to put it back. What is in the tray is said as work
// ("50c + 20c") and its total goes through `seal`.

import { h } from '../dom';
import type { VisualSpec } from '../types';
import { numbersOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'coins' }>;

export function money(cents: number): string {
  return cents >= 100 ? `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}` : `${cents}c`;
}

export const coins: Widget<Spec> = {
  interactions: ['tap a coin to put it in the tray', 'tap a coin in the tray to put it back'],
  draw(spec, ctx) {
    const tray = numbersOf(ctx.get('tray'));
    const coin = (index: number, inTray: boolean): HTMLButtonElement => {
      const value = spec.coins[index] ?? 0;
      return h('button', { type: 'button', class: `coin v${value >= 100 ? 'big' : value >= 20 ? 'mid' : 'small'}`, 'data-act': `${inTray ? 'untray' : 'coin'}:${index}`, 'aria-label': `${money(value)} coin${inTray ? ', in the tray' : ''}`, onclick: () => ctx.set('tray', inTray ? tray.filter((x) => x !== index) : [...tray, index]) }, ctx.seal(money(value)));
    };
    const purse = h('div', { class: 'purse' });
    spec.coins.forEach((_, i) => {
      if (!tray.includes(i)) purse.append(coin(i, false));
    });
    const dish = h('div', { class: 'tray' });
    tray.forEach((i) => dish.append(coin(i, true)));
    if (tray.length === 0) dish.append(h('span', { class: 'tray-note' }, 'The tray is empty'));
    const values = tray.map((i) => spec.coins[i] ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    const said = values.length === 0 ? 'Tap the coins you want in the tray' : values.length === 1 ? `In the tray: ${money(values[0] ?? 0)}` : `${values.map(money).join(' + ')} = ${ctx.seal(money(total))}`;
    return h('div', { class: 'vis vis-coins' }, purse, dish, readout(said), h('div', { class: 'controls' }, tray.length > 0 ? press('Empty the tray', 'again', () => ctx.set('tray', [])) : null));
  },
};
