// A ruler she slides along straight roads between places, and reads the length off. It is a ruler and not a slider that reports a number: the
// ruler is a strip with centimetre and millimetre marks that she drags (a finger or a pen, real pointer events); its zero clicks onto a place when
// it is brought close; the length is whatever mark lies at the other place, which she reads herself. The lengths (`mm=`) are only ever drawn, never
// written: no readout says where a road ends, so nothing here can hold an answer. State in `held`: `leg` (the road she is measuring) and `at<i>`
// (where the ruler's zero is on road i, in millimetres from the road's first place).

import { h, s } from '../dom';
import type { VisualSpec } from '../types';
import { numberOf, press, readout } from './common';
import type { Widget } from './common';

type Spec = Extract<VisualSpec, { kind: 'ruler' }>;

const TOWNS = 'ABCDEFG';
const MARGIN = 28;
const RULER_MM = 180;

export const ruler: Widget<Spec> = {
  interactions: ['choose a road', 'drag the ruler along it (its zero clicks onto a place)', 'read the mark at the other place'],
  draw(spec, ctx) {
    const leg = Math.min(spec.mm.length - 1, Math.max(0, numberOf(ctx.get('leg'), 0)));
    const total = Math.max(...spec.mm);
    const slide = h('div', { class: 'vis-ruler-slide' });
    const paint = (width: number): void => {
      const mm = (width - 2 * MARGIN) / Math.max(total, RULER_MM / 2.2);
      const length = spec.mm[leg] ?? 0;
      const at = numberOf(ctx.get(`at${leg}`), -Math.round(RULER_MM / 3));
      const height = 190;
      const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `A road from ${TOWNS[leg]} to ${TOWNS[leg + 1]} and a ruler to slide along it`, class: 'ruler-svg' });
      const roadY = 52;
      svg.append(s('line', { x1: MARGIN, y1: roadY, x2: MARGIN + length * mm, y2: roadY, class: 'ruler-road' }));
      for (const [i, x] of [MARGIN, MARGIN + length * mm].entries()) {
        svg.append(s('circle', { cx: x, cy: roadY, r: 10, class: 'ruler-town' }));
        svg.append(s('text', { x, y: roadY - 20, class: 'ruler-name', 'text-anchor': 'middle' }, TOWNS[leg + i] ?? '?'));
      }
      // the ruler: a strip with a mark every millimetre, a longer one every five and a number every centimetre, in a group that moves as one
      const top = 86;
      const g = s('g', { class: 'ruler-g', transform: `translate(${MARGIN + at * mm},0)` });
      g.append(s('rect', { x: 0, y: top, width: RULER_MM * mm, height: 74, rx: 6, class: 'ruler-body', 'data-act': 'ruler' }));
      for (let m = 0; m <= RULER_MM; m += 1) {
        const x = m * mm;
        const cm = m % 10 === 0;
        const half = m % 5 === 0;
        if (mm < 2.4 && !half) continue;
        g.append(s('line', { x1: x, y1: top, x2: x, y2: top + (cm ? 30 : half ? 21 : 13), class: 'ruler-mark' }));
        if (cm) g.append(s('text', { x, y: top + 54, class: 'ruler-num', 'text-anchor': 'middle' }, String(m / 10)));
      }
      g.append(s('text', { x: RULER_MM * mm - 8, y: top + 70, class: 'ruler-unit', 'text-anchor': 'end' }, 'cm'));
      g.append(s('line', { x1: 0, y1: top - 4, x2: 0, y2: roadY + 12, class: 'ruler-guide' }));
      svg.append(g);
      slide.replaceChildren(svg);

      // dragged without redrawing (a redraw would drop the pointer); committed when the hand lets go
      const snap = Math.min(5, 12 / mm);
      let grab: { readonly id: number; readonly from: number; readonly start: number; now: number } | null = null;
      const clientToMm = (e: PointerEvent): number => {
        const box = svg.getBoundingClientRect();
        return ((e.clientX - box.left) * (width / Math.max(1, box.width)) - MARGIN) / mm;
      };
      svg.addEventListener('pointerdown', (e) => {
        const box = svg.getBoundingClientRect();
        const y = (e.clientY - box.top) * (height / Math.max(1, box.height));
        if (y < top - 6) return;
        grab = { id: e.pointerId, from: clientToMm(e), start: at, now: at };
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      svg.addEventListener('pointermove', (e) => {
        if (grab === null || e.pointerId !== grab.id) return;
        let next = grab.start + (clientToMm(e) - grab.from);
        next = Math.max(-RULER_MM + 10, Math.min(total + 10, next));
        // its zero clicks onto a place when it comes close: a ruler is laid on a thing, not left near it
        for (const place of [0, length]) if (Math.abs(next - place) <= snap) next = place;
        grab.now = next;
        g.setAttribute('transform', `translate(${MARGIN + next * mm},0)`);
      });
      const end = (e: PointerEvent): void => {
        if (grab === null || e.pointerId !== grab.id) return;
        const done = grab.now;
        grab = null;
        ctx.set(`at${leg}`, Math.round(done * 2) / 2);
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
    };
    const tabs = h(
      'div',
      { class: 'controls' },
      ...spec.mm.map((_, i) => press(`${TOWNS[i]} to ${TOWNS[i + 1]}`, `road:${i}`, () => ctx.set('leg', i), i === leg ? 'main' : 'soft')),
    );
    const here = numberOf(ctx.get(`at${leg}`), -1);
    const lined = here === 0;
    const wrap = h('div', { class: 'vis vis-ruler' }, tabs, slide, readout(lined ? 'The ruler starts at the first place. What number is at the other place?' : 'Drag the ruler so its 0 sits on the first place.'));
    // drawn at the width the box has, and again when that changes
    let last = -1;
    const run = (): void => {
      const width = Math.max(240, Math.round(slide.clientWidth > 0 ? slide.clientWidth : 320));
      if (width === last) return;
      last = width;
      paint(width);
    };
    queueMicrotask(run);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => requestAnimationFrame(run)).observe(slide);
    return wrap;
  },
};
