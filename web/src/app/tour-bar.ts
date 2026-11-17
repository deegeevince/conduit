// The tour's bar: after a demo that /demo played, two small buttons at the foot of the stage, "Back to the tour" and "Try it yourself" (a real prompt
// for the brain). It goes when the next turn begins. Like the Undo chip it is the stage's own, not a part of the drawing.

import { TOUR_BACK, TOUR_TRY } from '@conduit/language';
import type { TourAction } from '@conduit/language';

export interface TourBar {
  /** `tryText` null: only the way back */
  show(tryText: string | null): void;
  hide(): void;
  dispose(): void;
}

const BUTTON =
  'min-height:40px;padding:0 16px;border-radius:20px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:600 14px system-ui;cursor:pointer;pointer-events:auto;white-space:nowrap';

export function createTourBar(host: HTMLElement, act: (action: TourAction) => void): TourBar {
  const row = document.createElement('div');
  row.hidden = true;
  row.setAttribute('data-tour-bar', '');
  // `display` is left to the hidden attribute (a style of its own would show the row while it is hidden)
  row.style.cssText = 'position:absolute;z-index:6;left:0;right:0;bottom:64px;justify-content:center;gap:10px;flex-wrap:wrap;padding:0 16px;pointer-events:none';
  const button = (text: string, action: () => TourAction | null): HTMLButtonElement => {
    const made = document.createElement('button');
    made.type = 'button';
    made.textContent = text;
    made.style.cssText = BUTTON;
    made.addEventListener('click', () => {
      const next = action();
      if (next === null) return;
      flex(false);
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
  flex(false);
  return {
    show(text) {
      tryText = text;
      again.hidden = text === null;
      flex(true);
    },
    hide() {
      flex(false);
    },
    dispose: () => row.remove(),
  };
}
