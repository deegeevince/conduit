// "‹ earlier": the lines the layout let go of to make room are not on the stage at rest, but they are never only gone. When some are held back, a small
// control stands at the top of the words' column; a tap lays them over the column to be read, in the order they were said, and a tap on it again, or
// on the control, puts them away. The page never scrolls: the sheet is the column's own size and holds what it holds.

import type { RetiredView } from '../contracts/painter';

export interface Earlier {
  update(view: RetiredView): void;
  dispose(): void;
}

export function createEarlier(stage: HTMLElement): Earlier {
  const button = document.createElement('button');
  button.type = 'button';
  button.hidden = true;
  button.setAttribute('data-earlier', '');
  button.style.cssText =
    'position:absolute;z-index:6;min-height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:600 14px system-ui;cursor:pointer;pointer-events:auto';
  const sheet = document.createElement('div');
  sheet.hidden = true;
  sheet.setAttribute('data-earlier-sheet', '');
  sheet.setAttribute('role', 'region');
  sheet.setAttribute('aria-label', 'Earlier lines');
  sheet.style.cssText =
    'position:absolute;z-index:6;box-sizing:border-box;overflow:auto;padding:12px 14px;border-radius:12px;border:1px solid var(--stage-dim,#888);background:var(--look-ground,var(--stage-ground,#fff));color:var(--stage-ink,#111);font:16px/1.4 system-ui;pointer-events:auto';
  stage.append(button, sheet);
  let open = false;
  const show = (): void => {
    sheet.hidden = !open;
    button.textContent = open ? 'close ›' : `‹ earlier${count > 1 ? ` (${count})` : ''}`;
    button.setAttribute('aria-expanded', String(open));
  };
  let count = 0;
  button.addEventListener('click', () => {
    open = !open;
    show();
  });
  sheet.addEventListener('click', () => {
    open = false;
    show();
  });
  return {
    update(view) {
      count = view.lines.length;
      if (count === 0 || view.column === null) {
        open = false;
        button.hidden = true;
        sheet.hidden = true;
        return;
      }
      const { x, y, width, height } = view.column;
      sheet.replaceChildren(
        ...view.lines.map((line) => {
          const p = document.createElement('p');
          p.style.cssText = 'margin:0 0 8px';
          p.textContent = line.text;
          return p;
        }),
      );
      sheet.style.cssText = sheet.style.cssText.replace(/(left|top|width|height):[^;]+;?/g, '');
      sheet.style.left = `${x}px`;
      sheet.style.top = `${y}px`;
      sheet.style.width = `${width}px`;
      sheet.style.height = `${height}px`;
      button.hidden = false;
      // above the column when the margin has room for it, else at its top edge, on the right
      button.style.right = '';
      button.style.left = `${x + width - 110}px`;
      button.style.top = `${Math.max(2, y - 30)}px`;
      show();
    },
    dispose() {
      button.remove();
      sheet.remove();
    },
  };
}
