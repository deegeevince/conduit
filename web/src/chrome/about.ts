// About, in the composer's [+] menu: what this is, the keys, and the credit the charting engine's licence asks for (it is on every chart as well).

import type { StageApp } from '../app/stage-app';
import type { ComposerMenu } from './menu';

export function mountAbout(menu: ComposerMenu, app: StageApp, extra?: (body: HTMLElement) => void): { dispose(): void } {
  const body = menu.addView('about', 'About');
  body.classList.add('about');
  const lines: [string, string][] = [
    ['p', 'Conduit answers through an animated stage instead of plain text.'],
    ['p', 'Enter sends. Shift and Enter make a new line. Escape stops the answer. A slash starts a command: /help lists them. Photos can be pasted or dropped anywhere.'],
  ];
  for (const [tag, text] of lines) {
    const item = document.createElement(tag);
    item.className = 'about__line';
    item.textContent = text;
    body.append(item);
  }
  if (app.attribution !== null) {
    const credit = document.createElement('a');
    credit.className = 'about__credit';
    credit.href = app.attribution.href;
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    credit.textContent = app.attribution.text;
    body.append(credit);
  }
  extra?.(body);
  const entry = menu.add({ id: 'about', label: 'About', gist: 'keys, commands, credits', order: 80, view: 'about' });
  return {
    dispose() {
      entry.remove();
      body.remove();
    },
  };
}
