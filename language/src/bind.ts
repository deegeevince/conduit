// What `bind` means: how far along a bound change is, given what its control
// holds. Defined once, here, so that the painter (which evaluates it every
// frame), the film (which evaluates it for an export) and the battery (which
// checks that a control drives something) agree.

import { numberOf } from './expr';
import type { ControlSpec } from './schedule';
import type { BindOn, ControlValue } from './types';

/** Where a control stands across its whole range, 0..1. A toggle is 0 or 1; a pick is its option's place among the options; an input and a button have no range and stand at 0. */
export function controlShare(spec: ControlSpec, value: ControlValue | null): number {
  if (spec.control === 'toggle') return value === true ? 1 : 0;
  if (spec.control === 'slider') {
    const held = typeof value === 'number' ? value : spec.min;
    return spec.max === spec.min ? 0 : Math.min(1, Math.max(0, (held - spec.min) / (spec.max - spec.min)));
  }
  if (spec.control === 'pick') {
    const count = spec.options.length;
    const index = typeof value === 'number' ? value : 1;
    return count <= 1 ? 0 : Math.min(1, Math.max(0, (index - 1) / (count - 1)));
  }
  return 0;
}

/** Whether a control holds `wanted`: `on`/`off` for a toggle, an option's number or its words for a pick, a number for a slider, the text for an input. Words are compared without case. */
export function controlHolds(spec: ControlSpec, value: ControlValue | null, wanted: string): boolean {
  const asked = wanted.trim().toLowerCase();
  if (spec.control === 'toggle') return (value === true) === (asked === 'on' || asked === 'yes' || asked === 'true' || asked === '1');
  if (spec.control === 'pick') {
    const index = typeof value === 'number' ? value : 1;
    if (/^\d+$/.test(asked)) return Number(asked) === index;
    return (spec.options[index - 1] ?? '').trim().toLowerCase().replace(/\s+/g, '-') === asked || (spec.options[index - 1] ?? '').trim().toLowerCase() === asked;
  }
  if (spec.control === 'slider') return numberOf(value) === Number(asked);
  return String(value ?? '').trim().toLowerCase() === asked;
}

/**
 * How far along a bound change is, 0..1, before any easing.
 * `whole` and `range` follow the control continuously, so a dragged slider
 * scrubs the change. `is` is 1 while the control holds the value and 0
 * otherwise; the painter eases between the two over `BOUND_SECONDS` on the
 * ambient clock, so a toggle moves the stage rather than snapping it.
 */
export function bindProgress(on: BindOn, spec: ControlSpec, value: ControlValue | null): number {
  if (on.kind === 'whole') return controlShare(spec, value);
  if (on.kind === 'is') return controlHolds(spec, value, on.value) ? 1 : 0;
  const held = spec.control === 'toggle' ? (value === true ? 1 : 0) : numberOf(value ?? spec.min);
  if (on.to === on.from || Number.isNaN(held)) return 0;
  return Math.min(1, Math.max(0, (held - on.from) / (on.to - on.from)));
}

/** A control's value as words: what `{name}` shows in text, what the transcript says, what the brain is told the user set. */
export function controlText(spec: ControlSpec, value: ControlValue | null): string {
  if (spec.control === 'toggle') return value === true ? 'on' : 'off';
  if (spec.control === 'pick') return spec.options[(typeof value === 'number' ? value : 1) - 1] ?? '';
  if (spec.control === 'slider') return `${String(typeof value === 'number' ? Number(value.toFixed(4)) : spec.min)}${spec.unit ?? ''}`;
  return String(value ?? '');
}

/**
 * What a control can hold of a value it was handed (the user's, as the painter
 * reported it): a slider's number kept within its ends, a toggle's state, a
 * pick's option number kept within the options, an input's text. Null when the
 * value is not the kind this control holds, or the control holds none.
 */
export function holdControl(spec: ControlSpec, value: ControlValue | undefined): ControlValue | null {
  if (value === undefined) return null;
  if (spec.control === 'slider' && typeof value === 'number' && Number.isFinite(value)) return Math.min(spec.max, Math.max(spec.min, value));
  if (spec.control === 'toggle' && typeof value === 'boolean') return value;
  if (spec.control === 'pick' && typeof value === 'number' && Number.isFinite(value) && spec.options.length > 0) return Math.min(spec.options.length, Math.max(1, Math.round(value)));
  if (spec.control === 'input' && typeof value === 'string') return value;
  return null;
}
