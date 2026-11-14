// The figure kind's fixtures, written as the typed structure (`FigureInput`) the language round will produce. The first is the plan's heart
// (PLAN-visuals 2(a), turn t6 of the owner's heart prompt): the same parts, the same words, no coordinate for a label, a route or a step.

import type { FigureInput, FigurePart, Pt } from './types';

const poly = (id: string, points: readonly [number, number][], rest: Omit<FigurePart, 'id' | 'shape'> = {}): FigurePart => ({ id, shape: { kind: 'poly', points: points.map(([x, y]) => ({ x, y })) }, ...rest });
const line = (id: string, points: readonly [number, number][], rest: Omit<FigurePart, 'id' | 'shape'> = {}): FigurePart => ({ id, shape: { kind: 'line', points: points.map(([x, y]) => ({ x, y })) }, ...rest });
const path = (id: string, d: string, rest: Omit<FigurePart, 'id' | 'shape'> = {}): FigurePart => ({ id, shape: { kind: 'path', d }, ...rest });
const ellipse = (id: string, cx: number, cy: number, rx: number, ry: number, rest: Omit<FigurePart, 'id' | 'shape'> = {}): FigurePart => ({ id, shape: { kind: 'ellipse', cx, cy, rx, ry }, ...rest });
const rect = (id: string, x: number, y: number, w: number, h: number, r: number, rest: Omit<FigurePart, 'id' | 'shape'> = {}): FigurePart => ({ id, shape: { kind: 'rect', x, y, w, h, r }, ...rest });

/** The plan's heart, line for line. */
export const HEART: FigureInput = {
  id: 'heart',
  title: 'How the heart pumps blood',
  mode: 'cutaway',
  parts: [
    path('body', 'M52 14 C74 10 90 30 84 54 C78 76 60 90 46 94 C28 84 12 62 16 38 C20 20 36 12 52 14 Z', { fill: 'muscle' }),
    poly('ra', [[24, 30], [38, 26], [42, 40], [30, 46]], { smooth: true, in: 'body', fill: 'blue', label: 'right atrium' }),
    poly('rv', [[26, 52], [44, 48], [46, 84], [34, 78]], { smooth: true, in: 'body', fill: 'blue', label: 'right ventricle' }),
    poly('la', [[56, 26], [74, 28], [76, 42], [58, 42]], { smooth: true, in: 'body', fill: 'red', label: 'left atrium' }),
    poly('lv', [[54, 48], [76, 50], [70, 74], [48, 90]], { smooth: true, in: 'body', fill: 'red', label: 'left ventricle' }),
    path('vena', 'M30 2 V28', { stroke: 'blue', thick: 4, label: 'from the body' }),
    path('pulm', 'M36 50 C34 20 20 12 8 14', { stroke: 'blue', thick: 4, label: 'to the lungs' }),
    path('veins', 'M96 30 H72', { stroke: 'red', thick: 4, label: 'from the lungs', optional: true }),
    path('aorta', 'M62 50 C60 8 82 4 88 18', { stroke: 'red', thick: 5, label: 'aorta' }),
  ],
  routes: [
    { id: 'tired', ink: 'blue', via: ['vena', 'ra', 'rv', 'pulm'] },
    { id: 'fresh', ink: 'red', via: ['veins', 'la', 'lv', 'aorta'] },
  ],
  steps: [
    { show: ['vena', 'ra'], words: 'Used blood from the body fills the right atrium.' },
    { show: ['rv', 'pulm'], words: 'The right ventricle squeezes it out to the lungs.' },
    { show: ['veins', 'la'], words: 'Fresh blood comes back into the left atrium.' },
    { show: ['lv', 'aorta'], words: 'The left ventricle, the thickest wall, sends it to the whole body.' },
  ],
};

/** A petal: a smooth teardrop from the centre outward at an angle. */
function petal(id: string, angle: number, label?: string): FigurePart {
  const a = (angle * Math.PI) / 180;
  const at = (r: number, off: number): [number, number] => [50 + r * Math.cos(a) - off * Math.sin(a), 34 + r * Math.sin(a) + off * Math.cos(a)];
  return poly(id, [at(6, 0), at(14, -6.5), at(25, -4.5), at(28, 0), at(25, 4.5), at(14, 6.5)], { smooth: true, fill: 'petal', ...(label === undefined ? {} : { label }) });
}

export const FLOWER: FigureInput = {
  id: 'flower',
  title: 'The parts of a flower',
  mode: 'plain',
  parts: [
    line('stem', [[50, 118], [49, 96], [51, 74], [50, 50]], { smooth: true, stroke: 'stem', thick: 2.6, label: 'stem' }),
    path('leaf', 'M50 98 C60 82 80 80 92 88 C82 102 62 104 50 98 Z', { fill: 'leaf', label: 'leaf' }),
    path('sepal', 'M36 46 C38 62 62 62 64 46 C58 52 42 52 36 46 Z', { fill: 'green', label: 'sepal' }),
    petal('petal1', -90, 'petal'),
    petal('petal2', -18),
    petal('petal3', 54),
    petal('petal4', 126),
    petal('petal5', 198),
    line('filament', [[50, 34], [58, 22]], { stroke: 'tan', thick: 1.4, label: 'stamen' }),
    ellipse('anther', 58.5, 21, 2.6, 2.2, { fill: 'gold' }),
    ellipse('pistil', 50, 34, 5, 5, { fill: 'orange', label: 'pistil' }),
  ],
  routes: [{ id: 'pollen', ink: 'gold', via: ['anther', 'pistil'] }],
  steps: [
    { show: ['petal1', 'petal2', 'petal3', 'petal4', 'petal5'], words: 'The petals are bright, to draw insects in.' },
    { show: ['filament', 'anther'], words: 'The stamen carries the pollen on its tip.' },
    { show: ['pollen', 'pistil'], words: 'Pollen lands on the pistil, and a seed can start.' },
  ],
};

export const BICYCLE: FigureInput = {
  id: 'bicycle',
  title: 'How a bicycle moves you',
  mode: 'plain',
  parts: [
    ellipse('rear_tyre', 24, 52, 19, 19, { fill: 'rubber', label: 'rear wheel' }),
    ellipse('rear_rim', 24, 52, 13.5, 13.5, { in: 'rear_tyre', fill: 'paper' }),
    ellipse('rear_hub', 24, 52, 3.2, 3.2, { in: 'rear_rim', fill: 'steel' }),
    ellipse('front_tyre', 88, 52, 19, 19, { fill: 'rubber', label: 'front wheel' }),
    ellipse('front_rim', 88, 52, 13.5, 13.5, { in: 'front_tyre', fill: 'paper' }),
    ellipse('front_hub', 88, 52, 3.2, 3.2, { in: 'front_rim', fill: 'steel' }),
    line('chain_stay', [[24, 52], [50, 52]], { stroke: 'red', thick: 1.8 }),
    line('seat_stay', [[24, 52], [42, 24]], { stroke: 'red', thick: 1.8 }),
    line('seat_tube', [[50, 52], [42, 22]], { stroke: 'red', thick: 2 }),
    line('top_tube', [[42, 25], [78, 25]], { stroke: 'red', thick: 2, label: 'frame' }),
    line('down_tube', [[50, 52], [78, 25]], { stroke: 'red', thick: 2.2 }),
    line('fork', [[78, 25], [88, 52]], { stroke: 'steel', thick: 1.8, label: 'fork', optional: true }),
    line('bars', [[70, 12], [78, 13], [86, 17]], { smooth: true, stroke: 'iron', thick: 1.8, label: 'handlebar' }),
    line('stem', [[78, 25], [78, 13]], { stroke: 'iron', thick: 1.6 }),
    poly('saddle', [[34, 18], [46, 18], [49, 21.5], [36, 21.5]], { smooth: true, fill: 'brown', label: 'saddle' }),
    ellipse('chainring', 50, 52, 7, 7, { fill: 'steel', label: 'chainring' }),
    line('crank', [[50, 52], [56, 62]], { stroke: 'iron', thick: 1.8 }),
    rect('pedal', 52.5, 61.5, 9, 3.4, 1, { fill: 'black', label: 'pedal' }),
  ],
  routes: [{ id: 'power', ink: 'orange', via: ['pedal', 'chainring', 'rear_hub'] }],
  steps: [
    { show: ['pedal', 'chainring'], words: 'Your legs push the pedals round, and the chainring turns with them.' },
    { show: ['chainring', 'rear_hub'], words: 'A chain carries that turn back to the hub of the rear wheel.' },
    { show: ['rear_tyre'], words: 'The rear tyre grips the road and pushes the bicycle forward.' },
  ],
};

export const SYRINGE: FigureInput = {
  id: 'syringe',
  title: 'How a syringe works',
  mode: 'plain',
  parts: [
    line('needle', [[2, 22], [26, 22]], { stroke: 'steel', thick: 1.6, label: 'needle' }),
    poly('hub', [[24, 18], [33, 14], [33, 30], [24, 26]], { fill: 'plastic' }),
    rect('barrel', 32, 11, 68, 22, 3, { fill: 'glass', label: 'barrel' }),
    rect('medicine', 34, 14, 38, 16, 2, { in: 'barrel', fill: 'water', label: 'medicine' }),
    rect('seal', 72, 14, 8, 16, 1.5, { in: 'barrel', fill: 'rubber', label: 'plunger seal' }),
    line('rod', [[80, 22], [120, 22]], { stroke: 'steel', thick: 3, label: 'plunger rod' }),
    rect('flange', 97, 6, 4.5, 32, 1.5, { fill: 'plastic', label: 'finger flange' }),
    rect('pad', 120, 12, 6, 20, 2, { fill: 'plastic', label: 'thumb pad' }),
  ],
  routes: [{ id: 'push', ink: 'blue', via: ['pad', 'rod', 'seal', 'medicine', 'needle'] }],
  steps: [
    { show: ['pad', 'rod'], words: 'Press the thumb pad: the plunger rod slides in.' },
    { show: ['seal', 'medicine'], words: 'The rubber seal pushes the medicine along the barrel.' },
    { show: ['needle'], words: 'It has only one way out: through the needle.' },
  ],
};

export const PEN: FigureInput = {
  id: 'pen',
  title: 'A click pen, taken apart',
  mode: 'exploded',
  axis: 'x',
  parts: [
    rect('button', 0, 5, 9, 10, 3, { fill: 'steel', label: 'click button' }),
    rect('barrel', 8, 2.5, 92, 15, 5, { fill: 'blue', label: 'barrel' }),
    rect('refill', 14, 8, 106, 4, 2, { fill: 'indigo', label: 'ink refill' }),
    line('spring', [[62, 10], [65, 6.5], [68, 13.5], [71, 6.5], [74, 13.5], [77, 6.5], [80, 13.5], [83, 10]], { stroke: 'iron', thick: 0.9, label: 'spring' }),
    rect('grip', 88, 4, 16, 12, 4, { fill: 'rubber', label: 'grip' }),
    poly('tip', [[102, 5.5], [118, 9], [118, 11], [102, 14.5]], { fill: 'metal', label: 'tip' }),
  ],
  routes: [],
  steps: [
    { show: ['button', 'spring'], words: 'Pressing the button compresses the spring.' },
    { show: ['refill', 'tip'], words: 'That pushes the refill forward until its tip shows.' },
  ],
};

export const FIGURES: Readonly<Record<string, FigureInput>> = { heart: HEART, flower: FLOWER, bicycle: BICYCLE, syringe: SYRINGE, pen: PEN };

export const FIGURE_NAMES: readonly string[] = Object.keys(FIGURES);

export type { Pt };
