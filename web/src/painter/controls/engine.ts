// The control engine: layout, `valueAt` and `valueAfter` for the five kinds.
// Pure. Text is measured through the function it is handed, nothing is read
// from a clock or a DOM, and the same input draws the same control in a
// browser, in an exported film and under `tsx`.
//
// HOW A CONTROL IS DRAWN (the painter's half of the bargain)
//
// A control is `BlockPart`s in its own coordinates (origin at its centre),
// each owned by the control's key. The roles decide colour, as for every
// structure, with these meanings:
//
//   grid    a hairline in `dim`: a resting outline, a track, a tick
//   frame   a stroke in `ink`: an outline under the pointer or the finger
//   fill    a plate: the ground a menu's list stands on
//   bar     `accent`, filled: the stretch of a slider before its knob, a toggle that is on.
//           EXCEPT a `bar` whose part name begins `ring`: that is a stroked
//           2 px outline in `accent`, the focus ring, round the whole control.
//   marker  `ink`, filled: a knob, a chosen option's ground, a pressed button's ground, a caret
//   line    a stroke in `ink`: a chevron, a hairline under an input
//   words   text in `ink`; label: text in `ink`; value: text in `dim`
//
// Text that sits over a `marker` shape of the same owner (a chosen option, a
// pressed button) is set in the ground's colour, so the pair reads inverted.
// The part named `caret` blinks once a second; the engine only places it.
//
// Hover and focus never move or resize anything. The size of every zone, and
// so of every target, is at least `minTarget` on its shorter side.

import { controlText, controlShare } from '@conduit/language';
import type { ControlSpec, ControlValue } from '@conduit/language';
import type { BlockLook, BlockPart, TextSpec } from '../../contracts/blocks';
import type { ControlEngine, ControlInput, ControlKey, ControlLayout, ControlZone } from '../../contracts/controls';
import type { Box } from '../../contracts/space';
import { atLeast, chevron, circleLine, inflate, rectLine, segment, shapePart, textPart } from './shapes';

const LABEL: TextSpec = { size: 'm', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 };
const FINE: TextSpec = { size: 's', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 };

/** Ticks are drawn only for a stepped slider with fewer stops than this. */
const MAX_TICKS = 12;
const SLIDER_MIN_WIDTH = 240;
const INPUT_WIDTH = 280;

interface Metrics {
  readonly body: number;
  readonly stroke: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly grid: boolean;
  readonly pad: number;
  readonly gap: number;
  /** a row of controls: at least a finger tall */
  readonly row: number;
  /** a slider's knob diameter */
  readonly knob: number;
}

function metricsOf(input: ControlInput): Metrics {
  const look: BlockLook = input.look;
  const grid = look.grid !== null;
  const cellW = look.grid?.cell.width ?? 1;
  const cellH = look.grid?.cell.height ?? 1;
  const pad = grid ? cellW * 2 : Math.round(look.body * 0.6);
  const gap = grid ? cellW : Math.max(4, Math.round(look.body * 0.35));
  const wanted = look.body * 1.3 + pad;
  const row = Math.max(input.minTarget, grid ? Math.ceil(wanted / cellH) * cellH : Math.ceil(wanted));
  // two strokes larger than the track is the floor; a knob must also be big enough to see and to aim at
  const knob = Math.max(3 * look.stroke, Math.round(look.body * 0.85));
  return { body: look.body, stroke: look.stroke, cellW, cellH, grid, pad, gap, row, knob: grid ? Math.ceil(knob / cellW) * cellW : knob };
}

function snapUp(m: Metrics, width: number): number {
  return m.grid ? Math.ceil(width / m.cellW) * m.cellW : Math.ceil(width);
}

function heldValue(input: ControlInput): ControlValue | null {
  return input.value ?? input.spec.value;
}

function pickIndex(input: ControlInput): number {
  const held = heldValue(input);
  const count = input.spec.options.length;
  const index = typeof held === 'number' ? Math.round(held) : 1;
  return Math.min(Math.max(1, count), Math.max(1, index));
}

/** What the engine builds into, in the control's own coordinates once `finish` has shifted it. */
class Sheet {
  readonly parts: BlockPart[] = [];
  readonly zones: ControlZone[] = [];
  constructor(
    readonly owner: string,
    private readonly ox: number,
    private readonly oy: number,
  ) {}
  /** boxes are given from the top-left of the control; they are shifted to its centre here */
  at(box: Box): Box {
    return { x: box.x + this.ox, y: box.y + this.oy, width: box.width, height: box.height };
  }
  shape(part: string, role: Parameters<typeof shapePart>[2], build: (dx: number, dy: number) => Parameters<typeof shapePart>[3]): void {
    this.parts.push(shapePart(this.owner, part, role, build(this.ox, this.oy)));
  }
  text(part: string, role: Parameters<typeof textPart>[2], text: string, box: Box, spec: TextSpec, align: 'left' | 'center' | 'right'): void {
    if (text === '') return;
    this.parts.push(textPart(this.owner, part, role, text, this.at(box), spec, align));
  }
  zone(part: string, box: Box, drag: boolean): void {
    this.zones.push({ part, box: this.at(atLeast(box, 0)), drag });
  }
  shift(dx: number, dy: number): { x: number; y: number } {
    return { x: dx + this.ox, y: dy + this.oy };
  }
}

function centre(box: Box, height: number): Box {
  return { x: box.x, y: box.y + (box.height - height) / 2, width: box.width, height };
}

function ring(sheet: Sheet, m: Metrics, w: number, h: number, radius: number, mood: ControlInput['mood']): void {
  if (!mood.focus) return;
  const box = inflate({ x: 0, y: 0, width: w, height: h }, 3);
  sheet.shape('ring', 'bar', (dx, dy) => [rectLine({ x: box.x + dx, y: box.y + dy, width: box.width, height: box.height }, radius + 3)]);
  void m;
}

/** A box outline at rest in `dim`, and in `ink` when the pointer or finger is on the control. */
function outline(sheet: Sheet, part: string, box: Box, radius: number, lit: boolean): void {
  sheet.shape(part, lit ? 'frame' : 'grid', (dx, dy) => [rectLine({ x: box.x + dx, y: box.y + dy, width: box.width, height: box.height }, radius)]);
}

function fillBox(sheet: Sheet, part: string, role: 'marker' | 'bar' | 'fill', box: Box, radius: number): void {
  sheet.shape(part, role, (dx, dy) => [rectLine({ x: box.x + dx, y: box.y + dy, width: box.width, height: box.height }, radius)]);
}

function lit(input: ControlInput): boolean {
  return input.mood.hover || input.mood.focus || input.mood.pressed !== null;
}

// ---------------------------------------------------------------- button

function layoutButton(input: ControlInput, m: Metrics): ControlLayout {
  const label = input.control.text;
  const room = Math.max(m.cellW, input.maxWidth - 2 * m.pad);
  const text = input.measure(label, LABEL, room);
  const width = Math.min(Math.max(input.maxWidth, input.minTarget), Math.max(input.minTarget, snapUp(m, text.width + 2 * m.pad)));
  const height = Math.max(m.row, snapUp(m, text.height + m.pad));
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  const box = { x: 0, y: 0, width: width, height };
  const pressed = input.mood.pressed === 'press';
  if (pressed) fillBox(sheet, 'ground', 'marker', box, input.look.radius);
  else outline(sheet, 'box', box, input.look.radius, lit(input));
  sheet.text('label', 'label', label, centre({ x: m.pad, y: 0, width: width - 2 * m.pad, height }, text.height), LABEL, 'center');
  ring(sheet, m, width, height, input.look.radius, input.mood);
  sheet.zone('press', box, false);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

// ---------------------------------------------------------------- toggle

function layoutToggle(input: ControlInput, m: Metrics): ControlLayout {
  const on = heldValue(input) === true;
  const label = input.control.text;
  const room = Math.max(m.cellW, input.maxWidth - 3 * m.cellW - m.gap);
  if (m.grid) {
    // `[x] label` and `[ ] label`, in the face
    const mark = on ? '[x]' : '[ ]';
    const box = 3 * m.cellW;
    const text = input.measure(label, LABEL, Math.max(m.cellW, input.maxWidth - box - m.cellW));
    const width = Math.max(input.minTarget, Math.min(input.maxWidth, box + (label === '' ? 0 : m.cellW + text.width)));
    const height = Math.max(m.row, snapUp(m, text.height));
    const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
    sheet.text('mark', on ? 'label' : 'value', mark, { x: 0, y: 0, width: box, height }, LABEL, 'left');
    sheet.text('label', 'label', label, { x: box + m.cellW, y: 0, width: width - box - m.cellW, height }, LABEL, 'left');
    if (input.mood.hover || input.mood.pressed !== null) outline(sheet, 'hover', { x: -m.cellW / 2, y: 0, width: width + m.cellW, height }, 0, true);
    ring(sheet, m, width, height, 0, input.mood);
    sheet.zone('switch', { x: 0, y: 0, width, height }, false);
    return { width, height, parts: sheet.parts, zones: sheet.zones };
  }
  const trackH = Math.round(m.body * 1.15);
  const trackW = Math.round(trackH * 1.8);
  const text = input.measure(label, LABEL, room);
  const width = Math.max(input.minTarget, Math.min(input.maxWidth, trackW + (label === '' ? 0 : m.gap + text.width)));
  const height = Math.max(m.row, Math.ceil(text.height));
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  const track = { x: 0, y: (height - trackH) / 2, width: trackW, height: trackH };
  const r = trackH / 2;
  const knobR = r - Math.max(2, m.stroke * 1.5);
  if (on) fillBox(sheet, 'track', 'bar', track, r);
  else outline(sheet, 'track', track, r, lit(input));
  const kx = on ? track.x + trackW - r : track.x + r;
  sheet.shape('knob', 'marker', (dx, dy) => [circleLine(kx + dx, track.y + r + dy, knobR)]);
  sheet.text('label', 'label', label, { x: trackW + m.gap, y: 0, width: width - trackW - m.gap, height }, LABEL, 'left');
  ring(sheet, m, width, height, r, input.mood);
  sheet.zone('switch', { x: 0, y: 0, width, height }, false);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

// ---------------------------------------------------------------- slider

interface SliderGeo {
  readonly x0: number;
  readonly x1: number;
}

/** The ends of the travel of a slider's knob centre, in the control's own coordinates. */
function sliderGeo(width: number, m: Metrics): SliderGeo {
  const r = m.knob / 2;
  return { x0: -width / 2 + r, x1: width / 2 - r };
}

function decimalsOf(spec: ControlSpec): number {
  const places = (n: number): number => {
    const text = String(Number(n.toPrecision(10)));
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
  };
  if (spec.step !== null) return Math.min(6, Math.max(places(spec.step), places(spec.min)));
  const span = Math.abs(spec.max - spec.min);
  return span === 0 ? 0 : Math.min(6, Math.max(0, Math.ceil(-Math.log10(span / 1000))));
}

/** A number put on the slider's grid: its step from its lower end, never outside its ends, free of float noise. */
export function snapSlider(spec: ControlSpec, raw: number): number {
  const lo = Math.min(spec.min, spec.max);
  const hi = Math.max(spec.min, spec.max);
  let v = Math.min(hi, Math.max(lo, raw));
  if (spec.step !== null && spec.step > 0) v = Math.min(hi, spec.min + Math.round((v - spec.min) / spec.step) * spec.step);
  return Number(v.toFixed(decimalsOf(spec)));
}

function layoutSlider(input: ControlInput, m: Metrics): ControlLayout {
  const spec = input.spec;
  const value = heldValue(input);
  const width = Math.min(input.maxWidth, Math.max(SLIDER_MIN_WIDTH, Math.min(input.maxWidth, 12 * m.body)));
  const shown = controlText(spec, typeof value === 'number' ? value : spec.min);
  const valueText = input.measure(shown, FINE, width);
  const labelText = input.measure(input.control.text, LABEL, Math.max(m.cellW, width - valueText.width - m.gap));
  const head = Math.max(labelText.height, valueText.height, m.body);
  const height = snapUp(m, head + input.minTarget);
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  const trackY = head + input.minTarget / 2;
  const geo = sliderGeo(width, m);
  const share = controlShare(spec, typeof value === 'number' ? value : spec.min);
  const kx = geo.x0 + share * (geo.x1 - geo.x0);
  const r = m.knob / 2;
  const hot = lit(input);
  const x0 = geo.x0 + width / 2;
  const fx = kx + width / 2;
  // ticks first so the track and the knob lie over them
  if (spec.step !== null && spec.step > 0 && spec.max > spec.min) {
    const stops = Math.round((spec.max - spec.min) / spec.step) + 1;
    if (stops >= 2 && stops < MAX_TICKS) {
      const tick = Math.max(3, m.body * 0.3);
      sheet.shape('ticks', 'grid', (dx, dy) =>
        Array.from({ length: stops }, (_, i) => {
          const x = x0 + (i / (stops - 1)) * (geo.x1 - geo.x0) + dx;
          return segment(x, trackY - tick + dy, x, trackY + tick + dy);
        }),
      );
    }
  }
  sheet.shape('track', hot ? 'frame' : 'grid', (dx, dy) => [segment(x0 + dx, trackY + dy, geo.x1 + width / 2 + dx, trackY + dy)]);
  if (fx > x0) fillBox(sheet, 'filled', 'bar', { x: x0, y: trackY - m.stroke, width: fx - x0, height: 2 * m.stroke }, m.stroke);
  sheet.shape('knob', 'marker', (dx, dy) => [circleLine(fx + dx, trackY + dy, r)]);
  sheet.text('label', 'label', input.control.text, { x: 0, y: 0, width: Math.max(m.cellW, width - valueText.width - m.gap), height: head }, LABEL, 'left');
  sheet.text('value', 'value', shown, { x: width - valueText.width, y: 0, width: valueText.width, height: head }, FINE, 'right');
  ring(sheet, m, width, height, 0, input.mood);
  const target = Math.max(input.minTarget, m.knob);
  sheet.zone('knob', { x: fx - target / 2, y: trackY - target / 2, width: target, height: target }, true);
  sheet.zone('track', { x: 0, y: head, width, height: input.minTarget }, true);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

// ---------------------------------------------------------------- pick

interface Cell {
  readonly box: Box;
  readonly text: ReturnType<ControlInput['measure']>;
}

/** Options side by side, wrapped onto further rows when they do not all fit. */
function packOptions(input: ControlInput, m: Metrics): { cells: Cell[]; width: number; height: number } {
  const cells: Cell[] = [];
  let x = 0;
  let y = 0;
  let rowH = m.row;
  let width = 0;
  const room = input.maxWidth;
  for (const option of input.spec.options) {
    const text = input.measure(option, LABEL, Math.max(m.cellW, room - 2 * m.pad));
    const w = Math.min(room, Math.max(input.minTarget, snapUp(m, text.width + 2 * m.pad)));
    const h = Math.max(m.row, snapUp(m, text.height + m.pad));
    if (x > 0 && x + w > room) {
      x = 0;
      y += rowH + m.gap;
      rowH = m.row;
    }
    rowH = Math.max(rowH, h);
    cells.push({ box: { x, y, width: w, height: h }, text });
    x += w + m.gap;
    width = Math.max(width, x - m.gap);
  }
  return { cells, width, height: y + rowH };
}

function layoutRowOrTabs(input: ControlInput, m: Metrics): ControlLayout {
  const tabs = input.spec.form === 'tabs';
  const packed = packOptions(input, m);
  const width = Math.max(packed.width, input.minTarget);
  const rule = tabs ? m.gap + m.stroke : 0;
  const height = Math.max(packed.height + rule, input.minTarget);
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  const chosen = pickIndex(input);
  packed.cells.forEach((cell, i) => {
    const n = i + 1;
    const on = n === chosen;
    // an option row that is taller than its neighbours keeps its text in the middle of its own box
    if (on) fillBox(sheet, `chosen`, 'marker', cell.box, input.look.radius);
    else if (!tabs) outline(sheet, `option:${n}`, cell.box, input.look.radius, lit(input) || input.mood.pressed === `option:${n}`);
    const room = { x: cell.box.x + m.pad, y: cell.box.y, width: cell.box.width - 2 * m.pad, height: cell.box.height };
    sheet.text(`words:${n}`, 'label', input.spec.options[i] ?? '', centre(room, cell.text.height), LABEL, 'center');
    sheet.zone(`option:${n}`, cell.box, false);
  });
  if (tabs) {
    const y = packed.height + m.gap / 2;
    sheet.shape('rule', lit(input) ? 'frame' : 'grid', (dx, dy) => [segment(dx, y + dy, width + dx, y + dy)]);
  }
  ring(sheet, m, width, height, input.look.radius, input.mood);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

function layoutMenu(input: ControlInput, m: Metrics): ControlLayout {
  const options = input.spec.options;
  const chevronBox = input.minTarget * 0.7;
  const widest = options.reduce((w, o) => Math.max(w, input.measure(o, LABEL, input.maxWidth).width), 0);
  const width = Math.min(input.maxWidth, Math.max(input.minTarget * 2, snapUp(m, widest + 2 * m.pad + chevronBox)));
  const height = m.row;
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  const chosen = pickIndex(input);
  const field = { x: 0, y: 0, width, height };
  const current = options[chosen - 1] ?? '';
  const text = input.measure(current, LABEL, Math.max(m.cellW, width - 2 * m.pad - chevronBox));
  outline(sheet, 'field', field, input.look.radius, lit(input) || input.mood.open);
  sheet.text('words', 'label', current, centre({ x: m.pad, y: 0, width: width - 2 * m.pad - chevronBox, height }, text.height), LABEL, 'left');
  const s = m.body * 0.45;
  sheet.shape('chevron', 'line', (dx, dy) => [chevron(width - m.pad - s + dx, height / 2 + dy, s, 'down')]);
  ring(sheet, m, width, height, input.look.radius, input.mood);
  if (input.mood.open) {
    // the list hangs below the field and is not part of the control's own box
    const list = { x: 0, y: height + m.stroke, width, height: options.length * m.row };
    sheet.shape('plate', 'fill', (dx, dy) => [rectLine({ x: list.x + dx, y: list.y + dy, width: list.width, height: list.height }, input.look.radius)]);
    sheet.shape('plate-edge', 'frame', (dx, dy) => [rectLine({ x: list.x + dx, y: list.y + dy, width: list.width, height: list.height }, input.look.radius)]);
    options.forEach((option, i) => {
      const n = i + 1;
      const cell = { x: 0, y: list.y + i * m.row, width, height: m.row };
      if (n === chosen) fillBox(sheet, 'chosen', 'marker', cell, input.look.radius);
      const t = input.measure(option, LABEL, Math.max(m.cellW, width - 2 * m.pad));
      sheet.text(`words:${n}`, 'label', option, centre({ x: m.pad, y: cell.y, width: width - 2 * m.pad, height: m.row }, t.height), LABEL, 'left');
      sheet.zone(`option:${n}`, cell, false);
    });
    sheet.zone('list', list, false);
  }
  sheet.zone('field', field, false);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

function layoutSteps(input: ControlInput, m: Metrics): ControlLayout {
  const options = input.spec.options;
  const count = options.length;
  const chosen = pickIndex(input);
  const button = Math.max(input.minTarget, m.row);
  const nameRoom = Math.max(m.cellW, input.maxWidth - 2 * button - 2 * m.gap);
  const widest = options.reduce((w, o) => Math.max(w, input.measure(o, LABEL, nameRoom).width), 0);
  const counter = `${chosen} of ${count}`;
  const counterBox = input.measure(counter, FINE, nameRoom);
  const middle = Math.min(nameRoom, Math.max(widest, counterBox.width));
  const width = 2 * button + 2 * m.gap + middle;
  const name = input.measure(options[chosen - 1] ?? '', LABEL, middle);
  const height = Math.max(button, snapUp(m, counterBox.height + name.height + m.gap));
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  const s = m.body * 0.5;
  const arrow = (part: 'back' | 'next', x: number, enabled: boolean): void => {
    const box = { x, y: (height - button) / 2, width: button, height: button };
    const hot = enabled && (input.mood.pressed === part || lit(input));
    outline(sheet, `${part}-box`, box, input.look.radius, hot);
    sheet.shape(part, enabled ? 'line' : 'grid', (dx, dy) => [chevron(x + button / 2 + dx, height / 2 + dy, s, part === 'back' ? 'left' : 'right')]);
    sheet.zone(part, box, false);
  };
  arrow('back', 0, chosen > 1);
  arrow('next', width - button, chosen < count);
  const cx = button + m.gap;
  const top = (height - counterBox.height - name.height - m.gap) / 2;
  sheet.text('counter', 'value', counter, { x: cx, y: top, width: middle, height: counterBox.height }, FINE, 'center');
  sheet.text('words', 'label', options[chosen - 1] ?? '', { x: cx, y: top + counterBox.height + m.gap, width: middle, height: name.height }, LABEL, 'center');
  ring(sheet, m, width, height, input.look.radius, input.mood);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

function layoutPick(input: ControlInput, m: Metrics): ControlLayout {
  if (input.spec.options.length === 0) return layoutButton({ ...input, control: input.control }, m);
  if (input.spec.form === 'menu') return layoutMenu(input, m);
  if (input.spec.form === 'steps') return layoutSteps(input, m);
  return layoutRowOrTabs(input, m);
}

// ---------------------------------------------------------------- input

/** The tail of `text` that fits `room`, with an ellipsis in front when it was cut. */
function tail(input: ControlInput, text: string, room: number): string {
  if (input.measure(text, LABEL, 1e6).width <= room) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (input.measure(`…${text.slice(text.length - mid)}`, LABEL, 1e6).width <= room) lo = mid;
    else hi = mid - 1;
  }
  return `…${text.slice(text.length - lo)}`;
}

function layoutInput(input: ControlInput, m: Metrics): ControlLayout {
  const held = typeof heldValue(input) === 'string' ? (heldValue(input) as string) : '';
  const width = Math.min(input.maxWidth, Math.max(input.minTarget * 2, INPUT_WIDTH));
  const height = m.row;
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  const room = Math.max(m.cellW, width - 2 * m.gap);
  const shown = held === '' ? input.control.text : tail(input, held, room);
  const text = input.measure(shown, LABEL, 1e6);
  const line = height - m.stroke;
  sheet.shape('rule', input.mood.focus || input.mood.hover ? 'line' : 'grid', (dx, dy) => [segment(dx, line + dy, width + dx, line + dy)]);
  sheet.text('words', held === '' ? 'value' : 'label', shown, centre({ x: m.gap, y: 0, width: room, height }, text.height), LABEL, 'left');
  if (input.mood.focus) {
    const caretX = m.gap + (held === '' ? 0 : Math.min(room, text.width)) + m.stroke;
    const caretH = Math.round(m.body * 1.1);
    fillBox(sheet, 'caret', 'marker', { x: caretX, y: (height - caretH) / 2, width: Math.max(1.5, m.stroke * 1.25), height: caretH }, 0);
  }
  ring(sheet, m, width, height, 0, input.mood);
  sheet.zone('field', { x: 0, y: 0, width, height }, false);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

// ---------------------------------------------------------------- the engine

function layout(input: ControlInput): ControlLayout {
  const m = metricsOf(input);
  switch (input.spec.control) {
    case 'button':
      return layoutButton(input, m);
    case 'toggle':
      return layoutToggle(input, m);
    case 'slider':
      return layoutSlider(input, m);
    case 'pick':
      return layoutPick(input, m);
    case 'input':
      return layoutInput(input, m);
  }
}

function valueAt(input: ControlInput, controlLayout: ControlLayout, zone: ControlZone, point: { readonly x: number; readonly y: number }): ControlValue | null {
  const spec = input.spec;
  switch (spec.control) {
    case 'button':
    case 'input':
      return null;
    case 'toggle':
      return zone.part === 'switch' ? heldValue(input) !== true : null;
    case 'slider': {
      if (zone.part !== 'track' && zone.part !== 'knob') return null;
      const geo = sliderGeo(controlLayout.width, metricsOf(input));
      const share = geo.x1 === geo.x0 ? 0 : Math.min(1, Math.max(0, (point.x - geo.x0) / (geo.x1 - geo.x0)));
      return snapSlider(spec, spec.min + share * (spec.max - spec.min));
    }
    case 'pick': {
      const count = spec.options.length;
      const at = pickIndex(input);
      if (zone.part.startsWith('option:')) {
        const n = Number(zone.part.slice(7));
        return Number.isInteger(n) && n >= 1 && n <= count ? n : null;
      }
      if (zone.part === 'back') return at > 1 ? at - 1 : null;
      if (zone.part === 'next') return at < count ? at + 1 : null;
      return null;
    }
  }
}

function valueAfter(input: ControlInput, key: ControlKey): ControlValue | null {
  const spec = input.spec;
  switch (spec.control) {
    case 'button':
    case 'input':
      return null;
    case 'toggle': {
      const on = heldValue(input) === true;
      if (key === 'act') return !on;
      if (key === 'more' || key === 'last' || key === 'page-more') return on ? null : true;
      return on ? false : null;
    }
    case 'slider': {
      const held = typeof heldValue(input) === 'number' ? (heldValue(input) as number) : spec.min;
      const unit = spec.step !== null && spec.step > 0 ? spec.step : Math.abs(spec.max - spec.min) / 20;
      const dir = spec.max >= spec.min ? 1 : -1;
      const big = spec.step !== null && spec.step > 0 ? spec.step * 10 : Math.abs(spec.max - spec.min) / 5;
      const next =
        key === 'less' ? held - dir * unit
        : key === 'more' ? held + dir * unit
        : key === 'page-less' ? held - dir * big
        : key === 'page-more' ? held + dir * big
        : key === 'first' ? spec.min
        : key === 'last' ? spec.max
        : null;
      if (next === null) return null;
      const snapped = snapSlider(spec, next);
      return snapped === held ? null : snapped;
    }
    case 'pick': {
      const count = spec.options.length;
      if (count === 0) return null;
      const at = pickIndex(input);
      const next =
        key === 'less' || key === 'page-less' ? at - 1
        : key === 'more' || key === 'page-more' ? at + 1
        : key === 'first' ? 1
        : key === 'last' ? count
        : null;
      if (next === null) return null;
      const clamped = Math.min(count, Math.max(1, next));
      return clamped === at ? null : clamped;
    }
  }
}

export const controlEngine: ControlEngine = { layout, valueAt, valueAfter };
