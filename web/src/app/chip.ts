// "Choices below" and "New below" (PLAN-canvas step 2): when a page has grown past the screen, the choices stand at its end, and a small chip at the foot of the screen says so
// until they are in view. A lens that the person has taken hold of and left says "New below" when the newest line is out of view. A tap goes there. The chip is the
// screen's own (it does not move with the page), and the page never scrolls.

import type { Box, LensView } from '../contracts/space';

export interface PageChipInfo {
  /** the page, host CSS pixels from the screen's top-left; null while the screen is the page */
  readonly page: Box | null;
  /** where the choices stand at the end of the page, if there are any */
  readonly foot: Box | null;
  /** the newest line */
  readonly newest: Box | null;
  /** the person has taken the lens: it does not follow */
  readonly free: boolean;
}

export interface PageChip {
  /** what the stage is, as the painter says it */
  set(info: PageChipInfo): void;
  /** where the lens is (null at rest) */
  update(view: LensView | null): void;
  dispose(): void;
}

/** a box this much of which is in the window counts as in view (the least of its height, or this many pixels) */
const SEEN_PX = 24;

export function createPageChip(host: HTMLElement, screen: () => { width: number; height: number }, go: (box: Box) => void): PageChip {
  const button = document.createElement('button');
  button.type = 'button';
  button.hidden = true;
  button.setAttribute('data-page-chip', '');
  button.style.cssText =
    'position:absolute;z-index:6;left:50%;bottom:64px;transform:translateX(-50%);min-height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:600 14px system-ui;cursor:pointer;pointer-events:auto;white-space:nowrap';
  host.append(button);
  let info: PageChipInfo = { page: null, foot: null, newest: null, free: false };
  let view: LensView | null = null;
  let target: Box | null = null;
  const below = (box: Box): boolean => {
    const s = screen();
    const bottom = view === null ? s.height : view.y + view.height / view.scale;
    return box.y + Math.min(box.height, SEEN_PX) > bottom;
  };
  const refresh = (): void => {
    target = null;
    let text = '';
    if (info.page !== null) {
      if (info.foot !== null && below(info.foot)) {
        target = info.foot;
        text = 'Choices below';
      } else if (info.free && info.newest !== null && below(info.newest)) {
        target = info.newest;
        text = 'New below';
      }
    }
    button.hidden = target === null;
    if (text !== '' && button.textContent !== text) button.textContent = text;
  };
  button.addEventListener('click', () => {
    if (target !== null) go(target);
  });
  return {
    set(next) {
      info = next;
      refresh();
    },
    update(next) {
      view = next;
      refresh();
    },
    dispose() {
      button.remove();
    },
  };
}
