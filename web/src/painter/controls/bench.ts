// A bench for the control engine, run under tsx (no browser):
//   cd language && pnpm exec tsx ../web/src/painter/controls/bench.ts
// Draws every kind in every state in nine looks' metrics at both screens,
// checks targets, bounds and overlaps, exercises valueAt/valueAfter round
// trips, the store, `driven` and `template`, and times layout.

import { bindProgress, parseTemplate } from '@conduit/language';
import type { ControlKind, ControlSpec, ControlValue, ElementSpan, PickForm } from '@conduit/language';
import type { BlockLook, TextMeasure } from '../../contracts/blocks';
import type { ControlInput, ControlKey, ControlLayout, ControlMood } from '../../contracts/controls';
import { CALM } from '../../contracts/controls';
import type { Box } from '../../contracts/space';
import { layoutCard } from './card';
import { applyDriven, boundAmount, drivenLayers, nextEases } from './driven';
import { controlEngine, snapSlider } from './engine';
import { createControlStore } from './store';
import { compileTemplate, renderTemplate } from './template';

let failures = 0;
let checks = 0;
function check(ok: boolean, what: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${what}`);
  }
}

// the nine looks, as the metrics an engine is given: [stroke, radius, grid cell, body at 1440 and at 375]
const LOOKS: readonly { name: string; stroke: number; radius: number; cell: [number, number] | null; body: [number, number] }[] = [
  { name: 'paper', stroke: 1.4, radius: 6, cell: null, body: [20, 16] },
  { name: 'night', stroke: 1.2, radius: 6, cell: null, body: [20, 16] },
  { name: 'chalk', stroke: 2.2, radius: 4, cell: null, body: [22, 17] },
  { name: 'blueprint', stroke: 1, radius: 0, cell: null, body: [19, 15] },
  { name: 'riso', stroke: 2.8, radius: 8, cell: null, body: [21, 16] },
  { name: 'phosphor', stroke: 1.6, radius: 0, cell: [12, 22], body: [20, 14] },
  { name: 'pixel', stroke: 2.8, radius: 0, cell: [10, 20], body: [20, 14] },
  { name: 'teletext', stroke: 2, radius: 0, cell: [16, 24], body: [24, 16] },
  { name: 'printout', stroke: 1.6, radius: 0, cell: [11, 20], body: [18, 14] },
];

function lookOf(i: number, screen: 0 | 1): BlockLook {
  const l = LOOKS[i] as (typeof LOOKS)[number];
  const body = l.cell === null ? l.body[screen] : Math.round(l.body[screen]);
  return {
    body: l.cell === null ? body : l.cell[1] * (screen === 0 ? 1 : 0.8),
    minShrink: 0.7,
    stroke: l.stroke,
    radius: l.radius,
    grid: l.cell === null ? null : { cell: { width: l.cell[0] * (screen === 0 ? 1 : 0.8), height: l.cell[1] * (screen === 0 ? 1 : 0.8) } },
  };
}

function measureFor(look: BlockLook): TextMeasure {
  const adv = look.grid !== null ? look.grid.cell.width : look.body * 0.55;
  return (text, spec, maxWidth) => {
    const scale = spec.size === 's' ? 0.85 : 1;
    const w = adv * scale;
    const per = Math.max(1, Math.floor(maxWidth / w));
    const lines: { text: string; width: number }[] = [];
    let rest = text;
    while (rest.length > per) {
      lines.push({ text: rest.slice(0, per), width: per * w });
      rest = rest.slice(per);
    }
    lines.push({ text: rest, width: rest.length * w });
    const lineHeight = look.body * 1.25 * scale;
    return { width: Math.max(...lines.map((l) => l.width)), height: lines.length * lineHeight, lineHeight, lines };
  };
}

function spec(control: ControlKind, over: Partial<ControlSpec> = {}): ControlSpec {
  return { control, form: null, options: [], min: 0, max: 1, step: null, unit: null, value: null, send: false, ...over };
}

const SPECS: { name: string; spec: ControlSpec; label: string }[] = [
  { name: 'button', spec: spec('button'), label: 'Run the simulation again' },
  { name: 'toggle', spec: spec('toggle', { value: false }), label: 'Show the air resistance' },
  { name: 'slider', spec: spec('slider', { min: 0, max: 90, step: 5, unit: ' deg', value: 45 }), label: 'Launch angle' },
  { name: 'slider-free', spec: spec('slider', { min: 0.5, max: 12.5, value: 3 }), label: 'Rate' },
  { name: 'row', spec: spec('pick', { form: 'row', options: ['Sine', 'Square', 'Saw', 'Triangle'], value: 2 }), label: '' },
  { name: 'row-many', spec: spec('pick', { form: 'row', options: ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus'], value: 3 }), label: '' },
  { name: 'tabs', spec: spec('pick', { form: 'tabs', options: ['Overview', 'Detail', 'Notes'], value: 1 }), label: '' },
  { name: 'menu', spec: spec('pick', { form: 'menu', options: ['Linear', 'Logarithmic', 'Square root', 'Exponential'], value: 2 }), label: '' },
  { name: 'steps', spec: spec('pick', { form: 'steps', options: ['Read the input', 'Hash it', 'Compare', 'Accept'], value: 2 }), label: '' },
  { name: 'input', spec: spec('input', { value: '' }), label: 'Ask a question' },
  { name: 'input-long', spec: spec('input', { value: 'a very long line of text that the field cannot possibly hold in one go at all' }), label: 'Ask' },
];

function element(label: string, s: ControlSpec): ElementSpan {
  return { key: `c@1`, id: 'c', kind: 'control', text: label, figure: { kind: 'control', ...s } } as unknown as ElementSpan;
}

const MOODS: readonly ControlMood[] = [CALM, { ...CALM, hover: true }, { ...CALM, focus: true }, { ...CALM, pressed: 'press' }, { ...CALM, open: true, focus: true }];
const SCREENS: readonly { w: number; h: number }[] = [
  { w: 1440, h: 900 },
  { w: 375, h: 667 },
];

function within(inner: Box, outer: Box, slack = 0.5): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
}

function inputFor(s: (typeof SPECS)[number], i: number, screen: 0 | 1, mood: ControlMood, value: ControlValue | null = null): ControlInput {
  const look = lookOf(i, screen);
  const sc = SCREENS[screen] as (typeof SCREENS)[number];
  return { control: element(s.label, s.spec), spec: s.spec, value, maxWidth: sc.w - 2 * 32, measure: measureFor(look), look, minTarget: 44, mood };
}

let layouts = 0;
let micros = 0;
for (let i = 0; i < LOOKS.length; i += 1) {
  for (const screen of [0, 1] as const) {
    for (const s of SPECS) {
      for (const mood of MOODS) {
        const input = inputFor(s, i, screen, mood);
        const t0 = performance.now();
        const layout = controlEngine.layout(input);
        micros += (performance.now() - t0) * 1000;
        layouts += 1;
        const tag = `${s.name} ${LOOKS[i]?.name} ${screen === 0 ? 'wide' : 'narrow'}`;
        check(layout.width > 0 && layout.height > 0, `${tag}: empty`);
        check(layout.width <= input.maxWidth + 0.5, `${tag}: wider than its room (${layout.width} > ${input.maxWidth})`);
        check(layout.zones.length > 0, `${tag}: no zones`);
        const body: Box = { x: -layout.width / 2, y: -layout.height / 2, width: layout.width, height: layout.height };
        for (const z of layout.zones) {
          const outsideOk = z.part === 'list' || z.part.startsWith('option:') && s.spec.form === 'menu';
          check(Math.min(z.box.width, z.box.height) >= 44 - 0.01 || z.part === 'knob', `${tag}: zone ${z.part} is ${z.box.width}x${z.box.height}`);
          if (!outsideOk) check(within(z.box, body, 1), `${tag}: zone ${z.part} leaves the control`);
        }
        for (const p of layout.parts) if (p.kind === 'text') check(within(p.box, mood.open ? { ...body, height: body.height + 400 } : body, 1), `${tag}: text "${p.text}" leaves the control`);
        // zones of one kind of control do not overlap, except knob over track
        for (const a of layout.zones) {
          for (const b of layout.zones) {
            if (a === b || a.part === 'list' || b.part === 'list' || a.part === 'field' && b.part.startsWith('option') || b.part === 'field' && a.part.startsWith('option')) continue;
            if ((a.part === 'knob' && b.part === 'track') || (a.part === 'track' && b.part === 'knob')) continue;
            const ox = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
            const oy = Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
            check(!(ox > 0.5 && oy > 0.5), `${tag}: zones ${a.part} and ${b.part} overlap`);
          }
        }
        // determinism
        check(JSON.stringify(controlEngine.layout(input)) === JSON.stringify(layout), `${tag}: layout is not deterministic`);
      }
    }
  }
}

// valueAt: sliders end to end, snapped; picks by zone; toggle flips
{
  const s = SPECS.find((x) => x.name === 'slider') as (typeof SPECS)[number];
  const input = inputFor(s, 0, 0, CALM, 45);
  const layout: ControlLayout = controlEngine.layout(input);
  const track = layout.zones.find((z) => z.part === 'track') as ControlLayout['zones'][number];
  check(controlEngine.valueAt(input, layout, track, { x: -9999, y: 0 }) === 0, 'slider far left is min');
  check(controlEngine.valueAt(input, layout, track, { x: 9999, y: 0 }) === 90, 'slider far right is max');
  const mid = controlEngine.valueAt(input, layout, track, { x: 0, y: 0 });
  check(mid === 45, `slider centre is 45, got ${String(mid)}`);
  check(controlEngine.valueAt(input, layout, track, { x: 7, y: 0 }) !== null, 'slider value');
  const free = inputFor(SPECS.find((x) => x.name === 'slider-free') as (typeof SPECS)[number], 0, 0, CALM, 3);
  const fl = controlEngine.layout(free);
  const v = controlEngine.valueAt(free, fl, fl.zones.find((z) => z.part === 'track') as ControlLayout['zones'][number], { x: 13, y: 0 });
  check(typeof v === 'number' && v >= 0.5 && v <= 12.5 && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, `free slider value clean: ${String(v)}`);
  check(snapSlider(spec('slider', { min: 0, max: 1, step: 0.1 }), 0.30000000000000004) === 0.3, 'step snap has no float noise');
  check(snapSlider(spec('slider', { min: 0, max: 10, step: 3 }), 10) === 9 || snapSlider(spec('slider', { min: 0, max: 10, step: 3 }), 10) === 10, 'step never past max');
}
// keyboard: every slider and pick can reach every value by keys
{
  const keys: ControlKey[] = ['less', 'more', 'first', 'last', 'page-less', 'page-more', 'act'];
  for (const s of SPECS) {
    const input = inputFor(s, 0, 0, CALM, s.spec.value);
    for (const key of keys) {
      const next = controlEngine.valueAfter(input, key);
      if (s.spec.control === 'button' || s.spec.control === 'input') check(next === null, `${s.name} ${key} means nothing`);
      if (next !== null) check(next !== (s.spec.value ?? null) || false, `${s.name} ${key} returned the same value`);
    }
  }
  const sl = SPECS.find((x) => x.name === 'slider') as (typeof SPECS)[number];
  let value: ControlValue | null = controlEngine.valueAfter(inputFor(sl, 0, 0, CALM, 0), 'first');
  check(value === null, 'slider at min, first: no change');
  let at = 0;
  let steps = 0;
  for (; steps < 100; steps += 1) {
    value = controlEngine.valueAfter(inputFor(sl, 0, 0, CALM, at), 'more');
    if (value === null) break;
    at = value as number;
  }
  check(at === 90 && steps === 18, `slider walks 0..90 by 5 in 18 presses (at ${at}, ${steps})`);
  const pk = SPECS.find((x) => x.name === 'steps') as (typeof SPECS)[number];
  check(controlEngine.valueAfter(inputFor(pk, 0, 0, CALM, 4), 'more') === null, 'pick stops at the last option');
  check(controlEngine.valueAfter(inputFor(pk, 0, 0, CALM, 2), 'last') === 4, 'pick last');
  const tg = SPECS.find((x) => x.name === 'toggle') as (typeof SPECS)[number];
  check(controlEngine.valueAfter(inputFor(tg, 0, 0, CALM, false), 'act') === true, 'toggle act flips');
  const tl = controlEngine.layout(inputFor(tg, 0, 0, CALM, false));
  check(controlEngine.valueAt(inputFor(tg, 0, 0, CALM, false), tl, tl.zones[0] as ControlLayout['zones'][number], { x: 0, y: 0 }) === true, 'toggle tap flips');
  for (const form of ['row', 'tabs', 'menu', 'steps'] as PickForm[]) {
    const s = SPECS.find((x) => x.spec.form === form) as (typeof SPECS)[number];
    const input = inputFor(s, 0, 0, { ...CALM, open: true }, 1);
    const l = controlEngine.layout(input);
    const reach = new Set<number>();
    for (const z of l.zones) {
      const n = controlEngine.valueAt(input, l, z, { x: z.box.x + z.box.width / 2, y: z.box.y + z.box.height / 2 });
      if (typeof n === 'number') reach.add(n);
    }
    // by pointer every option is reachable (a steps pick by back/next one at a time)
    check(form === 'steps' ? reach.size >= 1 : reach.size === s.spec.options.length - (form === 'menu' ? 0 : 0), `${form}: options reachable by pointer: ${[...reach].join(',')}`);
  }
}

// bindings: progress, easing, composition
{
  const sl = spec('slider', { min: 0, max: 10, value: 5 });
  const change = {
    seq: 1,
    control: 'k',
    on: { kind: 'whole' } as const,
    effect: { kind: 'set', props: { opacity: 0, ink: '#ff0000' } } as const,
    since: 0,
  };
  const base = { size: 'm', ink: 'ink', weight: 'normal', face: null, fill: 'none', stroke: 'ink', opacity: 1, scale: null, rot: 0, thick: null, soft: 0, at: null, near: null } as never;
  const stateOf = (v: number) => (key: string) => (key === 'k' ? { spec: sl, value: v } : null);
  const at = (v: number) => applyDriven(base, drivenLayers([change], stateOf(v), new Map(), 0));
  check(at(0).style.opacity === 1, 'driven: slider at 0 changes nothing');
  check(Math.abs(at(5).style.opacity - 0.5) < 1e-9, 'driven: slider at half is half');
  check(at(10).style.opacity === 0 && at(10).style.ink === '#ff0000', 'driven: slider at the end is the line');
  check(drivenLayers([change], () => null, new Map(), 0).length === 0, 'driven: control gone, nothing applied');
  // order: two changes compose in the order written
  const second = { ...change, seq: 2, on: { kind: 'whole' } as const, effect: { kind: 'set', props: { opacity: 0.5 } } as const };
  const both = applyDriven(base, drivenLayers([change, second], stateOf(10), new Map(), 0)).style.opacity;
  check(both === 0.5, `driven: written order composes (got ${both})`);
  // `is` eases over BOUND_SECONDS
  const tog = spec('toggle', { value: false });
  const isChange = { seq: 3, control: 't', on: { kind: 'is', value: 'on' } as const, effect: { kind: 'set', props: { opacity: 0 } } as const, since: 0 };
  const st = (v: boolean) => (key: string) => (key === 't' ? { spec: tog, value: v } : null);
  let eases = nextEases([isChange], st(false), new Map(), 0);
  check(drivenLayers([isChange], st(false), eases, 0)[0]?.amount === 0, 'is: starts settled');
  eases = nextEases([isChange], st(true), eases, 10);
  const a = (t: number) => drivenLayers([isChange], st(true), eases, t)[0]?.amount ?? -1;
  check(a(10) === 0 && Math.abs(a(10.125) - 0.5) < 1e-9 && a(10.25) === 1 && a(11) === 1, 'is: eases over a quarter of a second');
  const turned = nextEases([isChange], st(false), eases, 10.125);
  check(Math.abs(boundAmount(turned.get('3:t') as never, 10.125) - 0.5) < 1e-9, 'is: an interrupted ease turns round from where it was');
  check(bindProgress(isChange.on, tog, true) === 1, 'bindProgress agrees');
  // move and text
  const mv = { seq: 4, control: 'k', on: { kind: 'whole' } as const, effect: { kind: 'move', to: 'top', along: null } as const, since: 0 };
  const tx = { seq: 5, control: 'k', on: { kind: 'is', value: '10' } as const, effect: { kind: 'text', text: 'done', emphasis: [] } as const, since: 0 };
  const view = applyDriven(base, drivenLayers([mv, tx], stateOf(10), new Map(), 0));
  check(view.moves.length === 1 && view.moves[0]?.t === 1 && view.text?.text === 'done', 'driven: move and text');
}

// the store
{
  const store = createControlStore();
  const slider = spec('slider', { min: 0, max: 10, value: 5 });
  store.declare('a@1', 'vol', slider);
  store.set('a@1', 7);
  store.declare('a@9', 'vol', slider);
  check(store.get('a@9') === 7, 'store: value survives a redeclaration of the same id, kind and range');
  store.declare('a@20', 'vol', spec('slider', { min: 0, max: 100, value: 5 }));
  check(store.get('a@20') === undefined, 'store: a different range starts afresh');
  store.declare('b@1', 'vol', spec('toggle'));
  check(store.get('b@1') === undefined, 'store: a different kind starts afresh');
  const r = store.revision;
  store.set('a@9', 7);
  check(store.revision === r, 'store: no change, no revision');
  check(store.values(new Map([['vol', 'a@9']])).vol === 7, 'store: values by id');
  store.drop('a@9');
  check(store.get('a@9') === undefined && store.revision === r + 1, 'store: drop');
}

// templates
{
  const lookup = (id: string) => (id === 'n' ? { spec: spec('slider', { min: 0, max: 10, unit: ' kg', value: 3 }), value: 4 } : id === 'mode' ? { spec: spec('pick', { options: ['a', 'b'] }), value: 2 } : null);
  const known = (id: string) => lookup(id) !== null;
  const plain = compileTemplate('no braces {here', known);
  check(!plain.reactive, 'template: plain text is not reactive');
  const t = compileTemplate('a *{n}* and {n * 2} then {mode} {n/3:2} {zz}', known);
  const out = renderTemplate(t, 'a *{n}* and {n * 2} then {mode} {n/3:2} {zz}', [{ start: 3, end: 6 }], lookup);
  check(out.text === 'a *4 kg* and 8 then b 1.33 {zz}', `template: "${out.text}"`);
  check(out.emphasis[0]?.start === 3 && out.text.slice(out.emphasis[0]?.start, out.emphasis[0]?.end) === '4 kg', 'template: emphasis moves with the text');
  void parseTemplate;
}

// card
{
  const look = lookOf(0, 0);
  const card = layoutCard({ owner: 'card@1', title: 'Controls', inner: { x: 0, y: 0, width: 200, height: 100 }, measure: measureFor(look), look });
  check(card.outer.width > 200 && card.outer.height > 100 && card.parts.length === 2, 'card frames its parts');
}

console.log(`${layouts} layouts (9 looks x 2 screens x ${SPECS.length} controls x ${MOODS.length} moods), mean ${(micros / layouts).toFixed(1)} us each`);
console.log(`${checks} checks, ${failures} failed`);
if (failures > 0) throw new Error(`${failures} checks failed`);
