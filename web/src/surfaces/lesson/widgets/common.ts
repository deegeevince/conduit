// The six widgets (PLAN-v3-core section 3): each is a picture she works by hand. Each declares its interactions, keeps its state in the
// lesson's `held` (so a reload, going back and coming again all find it as she left it) and says every number it shows through `ctx.seal`,
// so a readout can show partial work ("12 + 12 = 24") and never an open answer.

import { h } from '../dom';
import type { Held, VisualKind, VisualSpec } from '../types';

export interface WidgetCtx {
  /** the figure's own key: its state is `<key>.<name>` in the lesson's held values */
  readonly key: string;
  readonly get: (name: string) => Held | undefined;
  readonly set: (name: string, value: Held) => void;
  /** a number or word the widget is about to show, as it may be shown now: the mask when it says an open answer */
  readonly seal: (value: string | number) => string;
  /** what she just changed, so it can arrive with a small movement */
  readonly fresh: string | null;
}

export interface Widget<S extends VisualSpec> {
  /** what a hand can do to it: the plan's "declared interactions", kept for the teaching and the check */
  readonly interactions: readonly string[];
  readonly draw: (spec: S, ctx: WidgetCtx) => HTMLElement;
}
export type Widgets = { readonly [K in VisualKind]: Widget<Extract<VisualSpec, { kind: K }>> };

/** A tappable button: always at least 56 pixels tall, and a `data-act` for the census and a driver. */
export function press(label: string, act: string, onTap: () => void, kind: 'main' | 'soft' = 'soft', disabled = false): HTMLButtonElement {
  const button = h('button', { type: 'button', class: `btn ${kind}`, 'data-act': act, onclick: () => onTap() }, label);
  if (disabled) button.disabled = true;
  return button;
}

export function readout(text: string | null, ...extra: string[]): HTMLElement {
  return h('p', { class: 'readout', 'aria-live': 'polite' }, text ?? ' ', ...extra);
}

export function numbersOf(held: Held | undefined): readonly number[] {
  return Array.isArray(held) ? held.filter((x): x is number => typeof x === 'number') : [];
}
export function numberOf(held: Held | undefined, fallback: number): number {
  return typeof held === 'number' ? held : fallback;
}
