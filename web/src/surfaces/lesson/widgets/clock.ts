// A clock face she sets. Interactions: tap a number to point the minute hand at it; an hour on, an hour back; five minutes on or back.
// The time it shows, in words and digits, goes through `seal`.

import { atWidth, h, s } from '../dom';
import type { VisualSpec } from '../types';
import { numberOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'clock' }>;
const DAY = 720;

export function clockText(minutes: number): string {
  const m = ((minutes % DAY) + DAY) % DAY;
  const hour = Math.floor(m / 60) % 12 === 0 ? 12 : Math.floor(m / 60) % 12;
  return `${hour}:${String(m % 60).padStart(2, '0')}`;
}

export const clock: Widget<Spec> = {
  interactions: ['tap a number to point the minute hand at it', 'move the hour on or back', 'move five minutes on or back'],
  draw(spec, ctx) {
    const minutes = numberOf(ctx.get('minutes'), spec.minutes);
    const set = (next: number): void => ctx.set('minutes', ((next % DAY) + DAY) % DAY);
    const face = h('div', { class: 'face' });
    atWidth(face, (width) => {
      const size = Math.min(width, 330);
      const c = size / 2;
      const r = c - 6;
      const svg = s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `A clock showing ${clockText(minutes)}` });
      svg.append(s('circle', { cx: c, cy: c, r, class: 'ck-face' }));
      for (let n = 1; n <= 12; n += 1) {
        const a = (n / 12) * Math.PI * 2;
        const x = c + Math.sin(a) * (r - 28);
        const y = c - Math.cos(a) * (r - 28);
        const tap = s('g', { class: 'ck-tap', 'data-act': `num:${n}`, onclick: () => set(Math.floor(minutes / 60) * 60 + (n % 12) * 5) });
        tap.append(s('circle', { cx: x, cy: y, r: 24, class: 'ck-hit' }), s('text', { x, y: y + 7, class: 'ck-num', 'text-anchor': 'middle' }, String(n)));
        svg.append(tap);
      }
      const hourAngle = ((minutes / 60) % 12) * 30;
      const minuteAngle = (minutes % 60) * 6;
      svg.append(
        s('line', { x1: c, y1: c, x2: c + Math.sin((hourAngle * Math.PI) / 180) * (r * 0.42), y2: c - Math.cos((hourAngle * Math.PI) / 180) * (r * 0.42), class: 'ck-hour' }),
        s('line', { x1: c, y1: c, x2: c + Math.sin((minuteAngle * Math.PI) / 180) * (r * 0.66), y2: c - Math.cos((minuteAngle * Math.PI) / 180) * (r * 0.66), class: 'ck-minute' }),
        s('circle', { cx: c, cy: c, r: 7, class: 'ck-pin' }),
      );
      face.replaceChildren(svg);
    });
    const controls = h(
      'div',
      { class: 'controls grid2' },
      press('1 hour back', 'hour-', () => set(minutes - 60)),
      press('1 hour on', 'hour+', () => set(minutes + 60)),
      press('5 minutes back', 'min-', () => set(minutes - 5)),
      press('5 minutes on', 'min+', () => set(minutes + 5)),
    );
    return h('div', { class: 'vis vis-clock' }, face, readout(`The clock says ${ctx.seal(clockText(minutes))}`), controls);
  },
};
