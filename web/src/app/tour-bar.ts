// The tour's bar: while a demo that /demo played is on stage, two small buttons at the foot of the stage, "Back to the tour" and "Try it yourself" (a real prompt
// for the brain; it is not offered until the demo has come to its end). It goes when the next turn begins. Like the Undo chip it is the stage's own, not a part of
// the drawing, and the stage keeps its room (`Viewport.foot`, fb-004): the bar is up for the whole of a tour demo, so nothing is laid out under it and nothing jumps
// when it appears.

import { TOUR_BACK, TOUR_TRY } from '@conduit/language';
import type { TourAction } from '@conduit/language';

export interface TourBar {
  /** Up, from the start of a demo: the way back, and "Try it yourself" held back until `ready` (`tryText` null: only the way back). `ready`: the demo is at its end. */
  show(tryText: string | null, ready?: boolean): void;
  /** The demo is at its end: "Try it yourself" can be pressed. */
  ready(): void;
  hide(): void;
  visible(): boolean;
  /** CSS pixels from the foot of the stage to the top of the bar, 0 while it is not up: the room the stage keeps for it, which follows the bar's own wrap on a narrow screen */
  occupied(): number;
  /** The bar's row: the Undo button stands in it when both are up. */
  readonly row: HTMLElement;
  dispose(): void;
}

/** CSS pixels the bar stands above the foot of the stage */
const BOTTOM = 64;
/** a little air over the bar's top edge */
const AIR = 6;

const BUTTON =
  'min-height:40px;padding:0 16px;border-radius:20px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:600 14px system-ui;cursor:pointer;pointer-events:auto;white-space:nowrap';

/** `changed`: the bar went up or down, or "Try it yourself" came or went (the room it asks of the stage may be different) */
export function createTourBar(host: HTMLElement, act: (action: TourAction) => void, changed: () => void = () => undefined): TourBar {
  const row = document.createElement('div');
  row.hidden = true;
  row.setAttribute('data-tour-bar', '');
  // `display` is left to the hidden attribute (a style of its own would show the row while it is hidden)
  row.style.cssText = `position:absolute;z-index:6;left:0;right:0;bottom:${BOTTOM}px;justify-content:center;align-items:center;gap:10px;flex-wrap:wrap;padding:0 16px;pointer-events:none`;
  const button = (text: string, action: () => TourAction | null): HTMLButtonElement => {
    const made = document.createElement('button');
    made.type = 'button';
    made.textContent = text;
    made.style.cssText = BUTTON;
    made.addEventListener('click', () => {
      if (made.disabled) return;
      const next = action();
      if (next === null) return;
      flex(false);
      changed();
      act(next);
    });
    return made;
  };
  let tryText: string | null = null;
  const back = button(TOUR_BACK, () => ({ kind: 'tour' }));
  const again = button(TOUR_TRY, () => (tryText === null ? null : { kind: 'try', text: tryText }));
  row.append(back, again);
  host.append(row);
  const flex = (on: boolean): void => {
    row.hidden = !on;
    row.style.display = on ? 'flex' : 'none';
  };
  const hold = (held: boolean): void => {
    again.disabled = held;
    again.style.opacity = held ? '0.45' : '1';
    again.style.cursor = held ? 'default' : 'pointer';
  };
  flex(false);
  return {
    show(text, ready = true) {
      const was = !row.hidden;
      const shownTry = !again.hidden;
      tryText = text;
      again.hidden = text === null;
      hold(!ready);
      flex(true);
      if (!was || shownTry !== !again.hidden) changed();
    },
    ready() {
      hold(false);
    },
    hide() {
      const was = !row.hidden;
      flex(false);
      if (was) changed();
    },
    visible: () => !row.hidden,
    occupied: () => (row.hidden ? 0 : BOTTOM + Math.ceil(row.getBoundingClientRect().height) + AIR),
    row,
    dispose: () => row.remove(),
  };
}
