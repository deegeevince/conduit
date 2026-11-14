// The two things the owner keeps by hand, in the shell: what the model calls have used (a block in the [+] menu's About view) and the kill switch
// (the header's overflow, behind a confirm). Both are the old page's own: `/usage` and `/stop-all` (chrome/command-runner.ts), which this calls; nothing
// here decides what stopping means.

import { API } from '@conduit/language';
import type { StageApp } from '../app/stage-app';
import { runCommand } from '../chrome/command-runner';
import type { UsageView } from '../link/http-link';

const MORE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';

const money = (amount: number): string => (amount >= 100 ? `$${Math.round(amount)}` : amount >= 1 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(3)}`);

/** The usage as three plain lines: the hour against the cap, today, the week. */
export function usageLines(usage: UsageView): string[] {
  const { capUsd, spentLastHourUsd, state } = usage.throttle;
  const hour =
    capUsd === null
      ? `This hour: ${money(spentLastHourUsd)}. No hourly cap is set.`
      : `This hour: ${money(spentLastHourUsd)} of the ${money(capUsd)} an hour you set (${Math.round((spentLastHourUsd / capUsd) * 100)}%)${state === 'near' || state === 'over' ? ': the critic and the lessons have stopped, your answers have not' : ''}.`;
  const today = usage.days[usage.days.length - 1];
  const week = usage.days.reduce((sum, day) => sum + day.costUsd, 0);
  return [hour, `Today: ${money(today?.costUsd ?? 0)} over ${today?.calls ?? 0} ${today?.calls === 1 ? 'call' : 'calls'}.`, `Last 7 days: ${money(week)}. Cost-equivalent: what the same tokens cost on the API.`];
}

/** Fills the About view's usage block, now and each time the [+] menu is opened. */
export function mountUsage(body: HTMLElement, app: StageApp, opener: HTMLElement): void {
  const block = document.createElement('section');
  block.className = 'about__usage';
  block.setAttribute('aria-label', 'Model use');
  const heading = document.createElement('h3');
  heading.className = 'about__heading';
  heading.textContent = 'Model use';
  const lines = document.createElement('div');
  lines.className = 'about__usage-lines';
  lines.setAttribute('aria-live', 'polite');
  block.append(heading, lines);
  body.append(block);
  const put = (texts: readonly string[]): void => {
    lines.replaceChildren(
      ...texts.map((text) => {
        const line = document.createElement('p');
        line.className = 'about__line';
        line.textContent = text;
        return line;
      }),
    );
  };
  let latest = 0;
  const refresh = (): void => {
    latest += 1;
    const mine = latest;
    app.link.usage().then(
      (usage) => {
        if (mine === latest) put(usageLines(usage));
      },
      () => {
        if (mine === latest) put(['Usage could not be read just now.']);
      },
    );
  };
  put(['Reading…']);
  refresh();
  opener.addEventListener('click', refresh);
}

async function killState(): Promise<boolean> {
  try {
    const response = await fetch(API.kill, { cache: 'no-store' });
    if (!response.ok) return false;
    return ((await response.json()) as { engaged?: unknown }).engaged === true;
  } catch {
    return false;
  }
}

/**
 * The header's overflow: a button that opens one short menu. Stop everything asks first; its Cancel is the default, and Escape is a no.
 * While agent tools are off from an earlier stop, the one entry says so and switches them back on.
 */
export function mountOverflow(bar: HTMLElement, app: StageApp): { dispose(): void } {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sh-btn shell-bar__more';
  button.setAttribute('aria-label', 'More');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = MORE;
  const popover = document.createElement('div');
  popover.className = 'shell-more';
  popover.setAttribute('role', 'menu');
  popover.hidden = true;
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'shell-more__item';
  stop.setAttribute('role', 'menuitem');
  const gist = document.createElement('span');
  gist.className = 'shell-more__gist';
  popover.append(stop);
  bar.append(button, popover);

  let engaged = false;
  const label = (): void => {
    stop.replaceChildren(document.createTextNode(engaged ? 'Switch agent tools back on' : 'Stop everything'));
    gist.textContent = engaged ? 'agent tools are off after a stop' : 'ends the answer, closes questions, kills helpers';
    stop.append(gist);
  };
  label();

  const dialog = document.createElement('dialog');
  dialog.className = 'dialog permit shell-confirm';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-labelledby', 'shell-confirm-title');
  dialog.setAttribute('aria-describedby', 'shell-confirm-body');
  dialog.innerHTML = `
    <form class="dialog__form" method="dialog">
      <h2 class="dialog__title" id="shell-confirm-title">Stop everything?</h2>
      <p class="permit__what" id="shell-confirm-body">This ends the answer being made, refuses any question waiting for you, kills the helper processes the brain started, and switches agent tools off until you turn them back on. What was said stays.</p>
      <div class="dialog__buttons">
        <button type="button" class="shell-confirm__cancel" autofocus>Cancel</button>
        <button type="button" class="dialog__go shell-confirm__go">Stop everything</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const cancel = dialog.querySelector<HTMLButtonElement>('.shell-confirm__cancel');
  const go = dialog.querySelector<HTMLButtonElement>('.shell-confirm__go');
  if (cancel === null || go === null) throw new Error('The confirm could not be built.');

  const close = (focus: boolean): void => {
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  };
  const open = (): void => {
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    void killState().then((now) => {
      engaged = now;
      label();
    });
    stop.focus();
  };
  button.addEventListener('click', () => (popover.hidden ? open() : close(true)));
  stop.addEventListener('click', () => {
    close(false);
    if (engaged) {
      void runCommand(app, '/stop-all resume', () => undefined).then(() => {
        engaged = false;
        label();
      });
      button.focus();
      return;
    }
    dialog.showModal();
  });
  cancel.addEventListener('click', () => {
    dialog.close();
    button.focus();
  });
  dialog.addEventListener('cancel', () => button.focus());
  go.addEventListener('click', () => {
    dialog.close();
    button.focus();
    engaged = true;
    label();
    void runCommand(app, '/stop-all', () => undefined);
  });
  const onDocument = (event: Event): void => {
    if (!popover.hidden && event.target instanceof Node && !popover.contains(event.target) && !button.contains(event.target)) close(false);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !popover.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  document.addEventListener('pointerdown', onDocument);
  document.addEventListener('keydown', onKey, true);
  return {
    dispose() {
      document.removeEventListener('pointerdown', onDocument);
      document.removeEventListener('keydown', onKey, true);
      button.remove();
      popover.remove();
      dialog.remove();
    },
  };
}
