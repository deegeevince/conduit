// About, in the composer's [+] menu: what this is, the keys, and the credit the charting engine's licence asks for (it is on every chart as well).

import type { StageApp } from '../app/stage-app';
import { AUDIENCES, AUDIENCE_BARS } from '../core/contracts';
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
  // who the screen is for: raises the type and the targets in the lesson view and the floor the stage is held to
  const who = document.createElement('div');
  who.className = 'about__audience';
  who.setAttribute('role', 'radiogroup');
  who.setAttribute('aria-label', 'Who is this for');
  const heading = document.createElement('p');
  heading.className = 'about__heading';
  heading.textContent = 'Who is this for';
  const options: HTMLButtonElement[] = [];
  for (const audience of AUDIENCES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'about__choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('data-audience', audience);
    button.textContent = AUDIENCE_BARS[audience].name;
    button.addEventListener('click', () => {
      app.audience.set(audience);
      mark();
    });
    options.push(button);
    who.append(button);
  }
  const mark = (): void => {
    for (const button of options) button.setAttribute('aria-checked', String(button.getAttribute('data-audience') === app.audience.value));
  };
  mark();
  body.append(heading, who);
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
  const fresh = menu.add({
    id: 'new-conversation',
    label: 'New conversation',
    gist: 'start clean; documents stay in My documents',
    order: 75,
    run: () => {
      const url = new URL(window.location.href);
      url.searchParams.set('fresh', '1');
      window.location.assign(url.toString());
    },
  });
  const entry = menu.add({ id: 'about', label: 'About', gist: 'keys, commands, credits', order: 80, view: 'about' });
  return {
    dispose() {
      entry.remove();
      fresh.remove();
      body.remove();
    },
  };
}
