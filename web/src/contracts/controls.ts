// Controls: the contract between the painter and the engine that draws and
// works a button, a toggle, a slider, a pick and an input.
//
// A control is declared by the brain in one line and drawn by the painter in
// the look, from the same shapes and text as everything else on stage: it is
// in every snapshot the brain is shown, in every exported film, and under the
// camera like any other element. Nothing about it is a DOM widget. (The app
// lays an invisible real form control over each one for the keyboard and for
// screen readers; see `ControlView` in contracts/painter.ts.)
//
// Like a structure engine, the control engine is pure: layout in, shapes and
// text out, no DOM, no clock, no state of its own. What a control HOLDS is
// state, and it lives in one place: the painter's `ControlStore`.

import type { ControlSpec, ControlValue, ControlValues, ElementSpan } from '@conduit/language';
import type { BlockLook, BlockPart, TextMeasure } from './blocks';
import type { Box } from './space';

/** What the pointer or the keyboard is doing to a control right now. It changes how the control is drawn and nothing else. */
export interface ControlMood {
  readonly hover: boolean;
  /** the part being held, if any (`knob`, `option:2`, `next`) */
  readonly pressed: string | null;
  readonly focus: boolean;
  /** a menu's list is showing */
  readonly open: boolean;
}

export const CALM: ControlMood = { hover: false, pressed: null, focus: false, open: false };

export interface ControlInput {
  /** the control element; its `figure.kind` is `control` */
  readonly control: ElementSpan;
  readonly spec: ControlSpec;
  /** what it holds now: the user's value, which may differ from the `spec.value` the brain wrote */
  readonly value: ControlValue | null;
  /** the widest it may be, stage units: the flow column's width, or the room left at its `at=` */
  readonly maxWidth: number;
  readonly measure: TextMeasure;
  readonly look: BlockLook;
  /** the smallest side a target may have, stage units: 44 CSS pixels on screen at the control's layer */
  readonly minTarget: number;
  readonly mood: ControlMood;
  /**
   * How closely a column that did not fit sets its controls. Absent or 0: as they like. 1: tight, a slider's track sits close under its label.
   * 2: tight, and a slider's label stands on one line beside its value, cut with an ellipsis where it is too long (the control's accessible name stays whole).
   */
  readonly compact?: 0 | 1 | 2;
}

/** A part of a control that the pointer can work, in the control's own coordinates (origin at its centre, stage units). */
export interface ControlZone {
  /** `press` (a button), `switch` (a toggle), `track` and `knob` (a slider), `option:<n>`, `back`, `next`, `field`, `list` */
  readonly part: string;
  readonly box: Box;
  /** a drag here follows the pointer (a slider's knob and track); anything else acts on release */
  readonly drag: boolean;
}

export interface ControlLayout {
  /** its natural size, stage units; the painter centres it where the layout or `at=` puts it */
  readonly width: number;
  readonly height: number;
  /** what to draw, back to front, in the control's own coordinates. `owner` is the control's key. */
  readonly parts: readonly BlockPart[];
  readonly zones: readonly ControlZone[];
}

/** A key, as a control understands it. The app translates the browser's keys; the engine never sees a KeyboardEvent. */
export type ControlKey = 'less' | 'more' | 'first' | 'last' | 'act' | 'page-less' | 'page-more';

export interface ControlEngine {
  layout(input: ControlInput): ControlLayout;
  /**
   * The value a pointer at `point` (the control's own coordinates) means on
   * `zone`: a slider's number under the pointer, snapped to its step; the
   * option under it; the toggle flipped. Null when the pointer there means
   * no change (a button: its press is an event, not a value).
   */
  valueAt(input: ControlInput, layout: ControlLayout, zone: ControlZone, point: { readonly x: number; readonly y: number }): ControlValue | null;
  /** The value after a key. Null when the key means nothing to this control. `act` on a button returns null: it is a press. */
  valueAfter(input: ControlInput, key: ControlKey): ControlValue | null;
}

/**
 * What every control on stage holds. One per painter. It is the only state on
 * the stage that the user, not the brain, writes; the timeline reads it every
 * frame exactly as it reads which paintings have arrived, so a frame stays a
 * pure function of (time, paintings, control values).
 *
 * Keys are element KEYS, not ids: a control declared again is a new control.
 * A value the user set survives a redeclaration only when the new control has
 * the same id, kind and range, which is how a brain can restyle a slider
 * without snapping it back.
 */
export interface ControlStore {
  /** the value held for a control, or undefined when the user has not touched it (the painter then uses the value the brain wrote) */
  get(key: string): ControlValue | undefined;
  set(key: string, value: ControlValue): void;
  /** forget a control that has left the stage */
  drop(key: string): void;
  /** every value by element id, for the report, for an `act` and for `{…}` */
  values(byId: ReadonlyMap<string, string>): ControlValues;
  /** increases on every change: a timeline built for one revision is stale at the next */
  readonly revision: number;
}
