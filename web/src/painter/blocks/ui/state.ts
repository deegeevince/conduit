// What a tap does (PLAN-v2.2 E13): "the controls the language already has are the kit's live parts, so a mock-up is a
// prototype: its tabs switch and its fields take text". A control's value is a function of the taps it has had; the
// screen is a function of the tree and that value. This is the one place a tap becomes a change of value. Pure.

import type { UiAction, UiHit, UiState } from './types';

/** The new state after `action` is used at point (x, y) of its screen. Unchanged when the action changes nothing. */
export function applyAction(state: UiState, action: UiAction, hit: UiHit, x: number): UiState {
  switch (action.kind) {
    case 'tab':
      return { ...state, tab: { ...state.tab, [action.bar]: action.index }, focus: null };
    case 'pick':
      return { ...state, pick: { ...state.pick, [action.control]: action.index }, focus: null };
    case 'toggle':
      return { ...state, toggle: { ...state.toggle, [action.control]: !action.on }, focus: null };
    case 'field':
      // the first key typed replaces what the field was given (a hint, or a value to overwrite): the words stay as they are until then
      return { ...state, focus: action.control };
    case 'slider':
      return { ...state, slider: { ...state.slider, [action.control]: sliderAt(hit, x) }, focus: null };
    case 'flip':
      return { ...state, toggle: { ...state.toggle, [action.control]: !action.on }, focus: null };
    case 'scroll':
      // a row that is dragged follows the finger (ui-stage holds the gesture); a bare use of it changes nothing
      return state;
    case 'press':
      return { ...state, pressed: action.control, focus: null };
  }
}

/** A slider's knob is 24 points across and its centre stays 12 points inside the track's ends: the value a point of the track is. */
export const SLIDER_INSET = 12;

export function sliderAt(hit: { readonly x: number; readonly w: number }, x: number): number {
  return Math.max(0, Math.min(1, (x - hit.x - SLIDER_INSET) / Math.max(1, hit.w - 2 * SLIDER_INSET)));
}

/** Keys into the field that has focus. */
export function typeInto(state: UiState, key: string): UiState {
  const f = state.focus;
  if (f === null) return state;
  const current = state.text[f] ?? '';
  if (key === 'Backspace') return { ...state, text: { ...state.text, [f]: current.slice(0, -1) } };
  if (key === 'Enter' || key === 'Escape') return { ...state, focus: null };
  if (key.length === 1) return { ...state, text: { ...state.text, [f]: current + key } };
  return state;
}

/** The hit under a point of a screen, the topmost. */
export function hitAt(hits: readonly UiHit[], x: number, y: number): UiHit | undefined {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h !== undefined && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
  }
  return undefined;
}
