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
//   fill    a plate: the ground a menu's list stands on, and the one a control stands on when it is placed with `at=`
//           (or given a `fill`), so that its words are never read straight off a drawing
//   bar     `accent`, filled: the stretch of a slider before its knob, a toggle that is on.
//           EXCEPT a `bar` whose part name begins `ring`: that is a stroked
//           2 px outline in `accent`, the focus ring, round the whole control.
//   marker  `ink`, filled: a knob, a chosen option's ground, a pressed button's ground, a caret
//   line    a stroke in `ink`: a chevron, a hairline under an input
//   words   text in `ink`: every word a control says (a label, an option, what is typed); a slider's number is bold
//   value   text in `dim`: a toggle's state, the name that is not true, a placeholder
//
// Text that sits over a `marker` shape of the same owner (a chosen option, a
// pressed button) is set in the ground's colour, so the pair reads inverted.
// The part named `caret` blinks once a second; the engine only places it.
//
// Hover and focus never move or resize anything. The size of every zone, and
// so of every target, is at least `minTarget` on its shorter side.

import { controlShare } from '@conduit/language';
import type { ControlSpec, ControlValue } from '@conduit/language';
import type { BlockLook, BlockPart, MeasuredText, TextSpec } from '../../contracts/blocks';
import type { ControlEngine, ControlInput, ControlKey, ControlLayout, ControlZone } from '../../contracts/controls';
import type { Box } from '../../contracts/space';
import { atLeast, chevron, circleLine, inflate, rectLine, segment, shapePart, textPart } from './shapes';

const LABEL: TextSpec = { size: 'm', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 };
const FINE: TextSpec = { size: 's', weight: 'normal', face: null, letterCase: 'asis', shrink: 1 };
/** a slider's number: heavier than its label, so that it reads as the value and not as a second label */
const VALUE: TextSpec = { size: 'm', weight: 'bold', face: null, letterCase: 'asis', shrink: 1 };

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
  const pad = grid ? cellW * 2 : Math.round(look.body * 0.35);
  const gap = grid ? cellW : Math.max(4, Math.round(look.body * 0.3));
  const wanted = look.body * 1.15 + pad;
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

function ring(sheet: Sheet, w: number, h: number, radius: number, mood: ControlInput['mood']): void {
  if (!mood.focus) return;
  const box = inflate({ x: 0, y: 0, width: w, height: h }, 3);
  sheet.shape('ring', 'bar', (dx, dy) => [rectLine({ x: box.x + dx, y: box.y + dy, width: box.width, height: box.height }, radius + 3)]);
}

/** How far a plate runs past the control's own box. */
const PLATE_MARGIN = 2;

/**
 * The ground under a control, first of its parts, when the control is not in the flow: a control placed with `at=`
 * stands on the drawing, and one the brain gave a `fill` wants it. Its words and its outline are read on this.
 * A control in the flow stands on the stage's own ground and is left bare.
 */
function plate(sheet: Sheet, input: ControlInput, m: Metrics, w: number, h: number, radius: number): void {
  if (input.control.style.at === null && input.control.style.fill === 'none') return;
  const box = inflate({ x: 0, y: 0, width: w, height: h }, PLATE_MARGIN);
  sheet.shape('ground', 'fill', (dx, dy) => [rectLine({ x: box.x + dx, y: box.y + dy, width: box.width, height: box.height }, m.grid ? 0 : radius + PLATE_MARGIN)]);
}

// ---------------------------------------------------------------- words

/** A number with its unit: a space before a unit that is a word (`20 deg`, `3 kg`), none before a sign (`40%`, `20°`), none when the brain wrote its own. */
export function withUnit(text: string, unit: string | null): string {
  if (unit === null || unit === '') return text;
  return /^[\s%°′″'"]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

/** What a slider says it holds, with the space the unit needs. */
function sliderWords(spec: ControlSpec, value: number): string {
  return withUnit(String(Number(value.toFixed(4))), spec.unit);
}

/** `Summer / Winter`: a toggle named for both of its states, off first. Null for any other words. */
export function stateNames(label: string): readonly [string, string] | null {
  const parts = label.split(' / ').map((part) => part.trim());
  const [off, on] = parts;
  return parts.length === 2 && off !== undefined && on !== undefined && off !== '' && on !== '' ? [off, on] : null;
}

interface Beside {
  /** the label's own box, from the top-left of the block */
  readonly label: Box;
  /** where the tail goes */
  readonly tail: Box;
  readonly width: number;
  readonly height: number;
  readonly labelText: MeasuredText;
}

/**
 * A label and, after it, a short tail (a slider's value, a toggle's state): on the label's last line when the two
 * fit across `room`, on a line below it when they do not. The tail is measured at its widest, so a number that
 * grows as it is dragged never moves the label or the tail.
 */
function beside(input: ControlInput, m: Metrics, label: string, labelSpec: TextSpec, tailWidest: string, tailSpec: TextSpec, room: number): Beside {
  const tail = input.measure(tailWidest, tailSpec, room);
  if (label === '') return { label: { x: 0, y: 0, width: 0, height: 0 }, tail: { x: 0, y: 0, width: tail.width, height: tail.height }, width: tail.width, height: tail.height, labelText: { width: 0, height: 0, lineHeight: 0, lines: [] } };
  const text = input.measure(label, labelSpec, Math.max(m.cellW, room));
  const last = text.lines[text.lines.length - 1];
  const lastWidth = last === undefined ? text.width : last.width;
  const gap = m.gap * 2;
  if (lastWidth + gap + tail.width <= room) {
    return {
      label: { x: 0, y: 0, width: text.width, height: text.height },
      tail: { x: lastWidth + gap, y: text.height - text.lineHeight + (text.lineHeight - tail.height) / 2, width: tail.width, height: tail.height },
      width: Math.max(text.width, lastWidth + gap + tail.width),
      height: Math.max(text.height, tail.height),
      labelText: text,
    };
  }
  return {
    label: { x: 0, y: 0, width: text.width, height: text.height },
    tail: { x: 0, y: text.height, width: tail.width, height: tail.height },
    width: Math.max(text.width, tail.width),
    height: text.height + tail.height,
    labelText: text,
  };
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
  plate(sheet, input, m, width, height, input.look.radius);
  const pressed = input.mood.pressed === 'press';
  if (pressed) fillBox(sheet, 'ground', 'marker', box, input.look.radius);
  else outline(sheet, 'box', box, input.look.radius, lit(input));
  sheet.text('label', 'words', label, centre({ x: m.pad, y: 0, width: width - 2 * m.pad, height }, text.height), LABEL, 'center');
  ring(sheet, width, height, input.look.radius, input.mood);
  sheet.zone('press', box, false);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

// ---------------------------------------------------------------- toggle

function layoutToggle(input: ControlInput, m: Metrics): ControlLayout {
  const on = heldValue(input) === true;
  const label = input.control.text;
  const names = stateNames(label);
  // the mark: a track and a knob, or `[x]` in the fixed-pitch looks
  const trackH = Math.round(m.body * 1.15);
  const markW = m.grid ? 3 * m.cellW : Math.round(trackH * 1.8);
  const markH = m.grid ? m.row : trackH;
  const wordsRoom = Math.max(m.cellW, input.maxWidth - markW - m.gap);

  // both names, the track between them: the one that is true now is in ink, the other dim
  const pair = names === null ? null : { off: input.measure(names[0], LABEL, Math.max(m.cellW, (wordsRoom - m.gap) / 2)), on: input.measure(names[1], LABEL, Math.max(m.cellW, (wordsRoom - m.gap) / 2)) };
  // one name and the state after it
  const single = pair === null ? beside(input, m, label, LABEL, 'off', FINE, wordsRoom) : null;

  const wordsWidth = pair !== null ? pair.off.width + m.gap + pair.on.width + m.gap : single === null ? 0 : single.width + m.gap;
  const width = Math.max(input.minTarget, Math.min(input.maxWidth, markW + (pair === null && label === '' && single !== null ? single.width + m.gap : wordsWidth)));
  const wordsHeight = pair !== null ? Math.max(pair.off.height, pair.on.height) : single === null ? 0 : single.height;
  const height = m.grid ? Math.max(m.row, snapUp(m, wordsHeight)) : Math.max(m.row, Math.ceil(wordsHeight));
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  plate(sheet, input, m, width, height, m.grid ? 0 : input.look.radius);

  const markX = pair === null ? 0 : pair.off.width + m.gap;
  const markY = (height - markH) / 2;
  if (m.grid) {
    sheet.text('mark', on ? 'words' : 'value', on ? '[x]' : '[ ]', { x: markX, y: 0, width: markW, height }, LABEL, 'left');
    if (input.mood.hover || input.mood.pressed !== null) outline(sheet, 'hover', { x: -m.cellW / 2, y: 0, width: width + m.cellW, height }, 0, true);
  } else {
    const track = { x: markX, y: markY, width: markW, height: trackH };
    const r = trackH / 2;
    const knobR = r - Math.max(2, m.stroke * 1.5);
    if (on) fillBox(sheet, 'track', 'bar', track, r);
    else outline(sheet, 'track', track, r, lit(input));
    const kx = on ? track.x + markW - r : track.x + r;
    sheet.shape('knob', 'marker', (dx, dy) => [circleLine(kx + dx, track.y + r + dy, knobR)]);
  }
  if (pair !== null && names !== null) {
    sheet.text('off-name', on ? 'value' : 'words', names[0], { x: 0, y: (height - pair.off.height) / 2, width: pair.off.width, height: pair.off.height }, LABEL, 'left');
    sheet.text('on-name', on ? 'words' : 'value', names[1], { x: markX + markW + m.gap, y: (height - pair.on.height) / 2, width: pair.on.width, height: pair.on.height }, LABEL, 'left');
  } else if (single !== null) {
    const x = markW + m.gap;
    const y = (height - single.height) / 2;
    sheet.text('label', 'words', label, { x, y: y + single.label.y, width: Math.min(single.label.width, width - x), height: single.label.height }, LABEL, 'left');
    // the state is said in words as well as drawn: a toggle that is only a mark names neither of its states
    sheet.text('state', 'value', on ? 'on' : 'off', { x: x + single.tail.x, y: y + single.tail.y, width: Math.min(single.tail.width, width - x - single.tail.x), height: single.tail.height }, FINE, 'left');
  }
  ring(sheet, width, height, m.grid ? 0 : trackH / 2, input.mood);
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
  if (spec.step !== null && spec.step > 0) return Math.min(6, Math.max(places(spec.step), places(spec.min)));
  const span = Math.abs(spec.max - spec.min);
  return span === 0 || !Number.isFinite(span) ? 0 : Math.min(6, Math.max(0, Math.ceil(-Math.log10(span / 1000))));
}

/**
 * A number put on the slider's grid: its step counted from `min`, never outside its ends (whichever end is the
 * larger: a slider written `10 0` runs down), free of float noise. Not a number: where the slider starts.
 */
export function snapSlider(spec: ControlSpec, raw: number): number {
  if (!Number.isFinite(raw)) return spec.min;
  const lo = Math.min(spec.min, spec.max);
  const hi = Math.max(spec.min, spec.max);
  let v = Math.min(hi, Math.max(lo, raw));
  if (spec.step !== null && spec.step > 0 && Number.isFinite(spec.step)) v = Math.min(hi, Math.max(lo, spec.min + Math.round((v - spec.min) / spec.step) * spec.step));
  return Number(v.toFixed(decimalsOf(spec)));
}

function layoutSlider(input: ControlInput, m: Metrics): ControlLayout {
  const spec = input.spec;
  const value = heldValue(input);
  const number = typeof value === 'number' ? value : spec.min;
  const shown = sliderWords(spec, number);
  // wide enough for the label and its value on one line when the room allows, and never wider than the room
  const oneLine = input.measure(input.control.text, LABEL, 1e6).width + 2 * m.gap + Math.max(input.measure(sliderWords(spec, spec.min), VALUE, 1e6).width, input.measure(sliderWords(spec, spec.max), VALUE, 1e6).width, input.measure(shown, VALUE, 1e6).width);
  const width = Math.min(input.maxWidth, Math.max(SLIDER_MIN_WIDTH, 12 * m.body, oneLine));
  // the value sits by the label, on its last line, and is placed for the widest number the slider can hold
  const widest = [sliderWords(spec, spec.min), sliderWords(spec, spec.max), shown].reduce((a, b) => (input.measure(b, VALUE, width).width > input.measure(a, VALUE, width).width ? b : a));
  const head = beside(input, m, input.control.text, LABEL, widest, VALUE, width);
  const headHeight = Math.max(head.height, m.body);
  const height = snapUp(m, headHeight + input.minTarget);
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  plate(sheet, input, m, width, height, input.look.radius);
  const trackY = headHeight + input.minTarget / 2;
  const geo = sliderGeo(width, m);
  const share = controlShare(spec, number);
  const kx = geo.x0 + share * (geo.x1 - geo.x0);
  const r = m.knob / 2;
  const hot = lit(input);
  const x0 = geo.x0 + width / 2;
  const fx = kx + width / 2;
  // ticks first so the track and the knob lie over them
  if (spec.step !== null && spec.step > 0 && spec.max !== spec.min) {
    const stops = Math.round(Math.abs(spec.max - spec.min) / spec.step) + 1;
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
  sheet.text('label', 'words', input.control.text, { x: head.label.x, y: head.label.y, width: Math.min(head.label.width, width), height: head.label.height }, LABEL, 'left');
  sheet.text('value', 'words', shown, { x: head.tail.x, y: head.tail.y, width: Math.min(head.tail.width, Math.max(0, width - head.tail.x)), height: head.tail.height }, VALUE, 'left');
  ring(sheet, width, height, 0, input.mood);
  const target = Math.max(input.minTarget, m.knob);
  sheet.zone('knob', { x: fx - target / 2, y: trackY - target / 2, width: target, height: target }, true);
  sheet.zone('track', { x: 0, y: headHeight, width, height: input.minTarget }, true);
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
  plate(sheet, input, m, width, height, input.look.radius);
  const chosen = pickIndex(input);
  packed.cells.forEach((cell, i) => {
    const n = i + 1;
    const on = n === chosen;
    // an option row that is taller than its neighbours keeps its text in the middle of its own box
    if (on) fillBox(sheet, `chosen`, 'marker', cell.box, input.look.radius);
    else if (!tabs) outline(sheet, `option:${n}`, cell.box, input.look.radius, lit(input) || input.mood.pressed === `option:${n}`);
    const room = { x: cell.box.x + m.pad, y: cell.box.y, width: cell.box.width - 2 * m.pad, height: cell.box.height };
    sheet.text(`words:${n}`, 'words', input.spec.options[i] ?? '', centre(room, cell.text.height), LABEL, 'center');
    sheet.zone(`option:${n}`, cell.box, false);
  });
  if (tabs) {
    const y = packed.height + m.gap / 2;
    sheet.shape('rule', lit(input) ? 'frame' : 'grid', (dx, dy) => [segment(dx, y + dy, width + dx, y + dy)]);
  }
  ring(sheet, width, height, input.look.radius, input.mood);
  return { width, height, parts: sheet.parts, zones: sheet.zones };
}

function layoutMenu(input: ControlInput, m: Metrics): ControlLayout {
  const options = input.spec.options;
  const chevronBox = input.minTarget * 0.7;
  const widest = options.reduce((w, o) => Math.max(w, input.measure(o, LABEL, input.maxWidth).width), 0);
  const width = Math.min(input.maxWidth, Math.max(input.minTarget * 2, snapUp(m, widest + 2 * m.pad + chevronBox)));
  const height = m.row;
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  plate(sheet, input, m, width, height, input.look.radius);
  const chosen = pickIndex(input);
  const field = { x: 0, y: 0, width, height };
  const current = options[chosen - 1] ?? '';
  const text = input.measure(current, LABEL, Math.max(m.cellW, width - 2 * m.pad - chevronBox));
  outline(sheet, 'field', field, input.look.radius, lit(input) || input.mood.open);
  sheet.text('words', 'words', current, centre({ x: m.pad, y: 0, width: width - 2 * m.pad - chevronBox, height }, text.height), LABEL, 'left');
  const s = m.body * 0.45;
  sheet.shape('chevron', 'line', (dx, dy) => [chevron(width - m.pad - s + dx, height / 2 + dy, s, 'down')]);
  ring(sheet, width, height, input.look.radius, input.mood);
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
      sheet.text(`words:${n}`, 'words', option, centre({ x: m.pad, y: cell.y, width: width - 2 * m.pad, height: m.row }, t.height), LABEL, 'left');
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
  plate(sheet, input, m, width, height, input.look.radius);
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
  sheet.text('words', 'words', options[chosen - 1] ?? '', { x: cx, y: top + counterBox.height + m.gap, width: middle, height: name.height }, LABEL, 'center');
  ring(sheet, width, height, input.look.radius, input.mood);
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

/** The head of `text` that fits `room`, with an ellipsis after it when it was cut: a placeholder is read from its start. */
function head(input: ControlInput, text: string, room: number): string {
  if (input.measure(text, LABEL, 1e6).width <= room) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (input.measure(`${text.slice(0, mid)}…`, LABEL, 1e6).width <= room) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

function layoutInput(input: ControlInput, m: Metrics): ControlLayout {
  const held = typeof heldValue(input) === 'string' ? (heldValue(input) as string) : '';
  // wide enough for its own prompt (it is read before it is typed in), and the same width whatever is typed, so that it never moves under the hand
  const prompt = input.measure(input.control.text, LABEL, 1e6).width + 2 * m.gap;
  const width = Math.min(input.maxWidth, Math.max(input.minTarget * 2, INPUT_WIDTH, prompt));
  const height = m.row;
  const sheet = new Sheet(input.control.key, -width / 2, -height / 2);
  plate(sheet, input, m, width, height, input.look.radius);
  const room = Math.max(m.cellW, width - 2 * m.gap);
  const shown = held === '' ? head(input, input.control.text, room) : tail(input, held, room);
  const text = input.measure(shown, LABEL, 1e6);
  const line = height - m.stroke;
  sheet.shape('rule', input.mood.focus || input.mood.hover ? 'line' : 'grid', (dx, dy) => [segment(dx, line + dy, width + dx, line + dy)]);
  sheet.text('words', held === '' ? 'value' : 'words', shown, centre({ x: m.gap, y: 0, width: room, height }, text.height), LABEL, 'left');
  if (input.mood.focus) {
    const caretX = m.gap + (held === '' ? 0 : Math.min(room, text.width)) + m.stroke;
    const caretH = Math.round(m.body * 1.1);
    fillBox(sheet, 'caret', 'marker', { x: caretX, y: (height - caretH) / 2, width: Math.max(1.5, m.stroke * 1.25), height: caretH }, 0);
  }
  ring(sheet, width, height, 0, input.mood);
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
      const raw = heldValue(input);
      const held = typeof raw === 'number' && Number.isFinite(raw) ? raw : spec.min;
      const span = Math.abs(spec.max - spec.min);
      if (!(span > 0)) return null;
      const stepped = spec.step !== null && spec.step > 0 && Number.isFinite(spec.step);
      const unit = stepped && spec.step !== null ? spec.step : span / 20;
      const big = stepped ? unit * 10 : span / 5;
      // towards `max` is "more", whichever end of the number line `max` is
      const toward = spec.max >= spec.min ? 1 : -1;
      // a stepped slider goes to the next stop in the direction pressed, even from a value that is between stops
      const by = (sign: 1 | -1, stops: number): number => {
        if (!stepped) return snapSlider(spec, held + sign * toward * (stops === 1 ? unit : big));
        const at = ((held - spec.min) * toward) / unit;
        const k = sign > 0 ? Math.floor(at + 1e-9) + stops : Math.ceil(at - 1e-9) - stops;
        return snapSlider(spec, spec.min + toward * k * unit);
      };
      const next =
        key === 'less' ? by(-1, 1)
        : key === 'more' ? by(1, 1)
        : key === 'page-less' ? by(-1, 10)
        : key === 'page-more' ? by(1, 10)
        : key === 'first' ? snapSlider(spec, spec.min)
        : key === 'last' ? snapSlider(spec, spec.max)
        : null;
      return next === null || next === held ? null : next;
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
