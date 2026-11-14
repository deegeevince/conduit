// The agent's confirm control. When the brain wants to do something that needs the owner's yes, the stage stops and asks, on a
// native modal dialog (focus is held inside it and the rest of the page is inert, by the browser): what, how risky, Allow once
// and Deny, and a visible countdown. Deny holds the focus first, so a held key never allows anything. There is no "always", and
// no answer is a no: when the time is up the control sends the no itself, as the server will.

import type { ActionRisk } from '@conduit/language';
import type { AgentNote, StageApp } from '../app/stage-app';

export interface PermissionControl {
  dispose(): void;
}

type Request = Extract<AgentNote, { readonly type: 'permission' }>;

const RISK_WORDS: Readonly<Record<ActionRisk, string>> = {
  read: 'read something',
  write: 'change something',
  run: 'run a command',
  send: 'send something',
  buy: 'spend money',
  delete: 'delete something',
  publish: 'publish something',
  signin: 'sign in',
};

/** What allowing does not do for the owner: the parts only their own hands can. */
const OWN_HANDS: Readonly<Partial<Record<ActionRisk, string>>> = {
  buy: 'Allowing lets it try. A payment is yours to make, and the brain will say so.',
  signin: 'Allowing lets it try. A sign-in or a code is yours to enter, and the brain will say so.',
};

let counter = 0;

export function mountPermission(app: StageApp): PermissionControl {
  counter += 1;
  const id = `permit-${counter}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog permit';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-body`);
  dialog.innerHTML = `
    <form class="dialog__form" method="dialog">
      <h2 class="dialog__title" id="${id}-title"></h2>
      <div id="${id}-body" class="permit__body">
        <p class="permit__what"></p>
        <p class="permit__risk"></p>
        <p class="permit__hands" hidden></p>
        <pre class="permit__detail" tabindex="0" aria-label="The whole call, scrollable" hidden></pre>
      </div>
      <p class="permit__count"><progress class="permit__bar" max="1" value="1" aria-hidden="true"></progress><span class="permit__time"></span></p>
      <div class="dialog__buttons">
        <button type="button" class="permit__deny">Deny</button>
        <button type="button" class="dialog__go permit__allow">Allow once</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const part = <T extends HTMLElement>(selector: string): T => {
    const found = dialog.querySelector<T>(selector);
    if (found === null) throw new Error('The confirm control could not be built.');
    return found;
  };
  const title = part('.dialog__title');
  const what = part('.permit__what');
  const risk = part('.permit__risk');
  const hands = part('.permit__hands');
  const detail = part('.permit__detail');
  const bar = part<HTMLProgressElement>('.permit__bar');
  const time = part('.permit__time');
  const deny = part<HTMLButtonElement>('.permit__deny');
  const allow = part<HTMLButtonElement>('.permit__allow');

  const queue: { readonly request: Request; readonly until: number }[] = [];
  let showing: { readonly request: Request; readonly until: number } | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let before: Element | null = null;

  /** How long both buttons are dead after a request appears: a tap or a double-click already on its way must never land on a request nobody has read. */
  const ARM_MS = 600;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    clearTimeout(armTimer);
    allow.disabled = true;
    deny.disabled = true;
  };
  const arm = (request: string): void => {
    disarm();
    armTimer = setTimeout(() => {
      // Only if it is still the same request on show.
      if (showing?.request.request !== request) return;
      allow.disabled = false;
      deny.disabled = false;
      deny.focus();
    }, ARM_MS);
  };

  /** `bound` is the request the click was made on, read from the button itself; an answer for any other request than the one showing is nothing. */
  const answer = (allowed: boolean, bound: string | null = null): void => {
    const current = showing;
    if (current === null) return;
    if (bound !== null && bound !== current.request.request) return;
    disarm();
    showing = null;
    clearInterval(timer);
    app.permit(current.request.turn, current.request.request, allowed);
    app.announce(allowed ? `Allowed once: ${current.request.tool}` : `Denied: ${current.request.tool}`);
    next();
  };

  const tick = (): void => {
    const current = showing;
    if (current === null) return;
    const left = Math.max(0, current.until - Date.now());
    bar.value = Math.min(1, left / Math.max(1, current.request.expiresMs));
    time.textContent = left > 0 ? `No answer in ${Math.ceil(left / 1000)} s is a no.` : 'Out of time: denied.';
    if (left <= 0) answer(false, current.request.request);
  };

  function next(): void {
    const upcoming = queue.shift();
    if (upcoming === undefined) {
      if (dialog.open) dialog.close();
      if (before instanceof HTMLElement && document.contains(before)) before.focus({ preventScroll: true });
      before = null;
      return;
    }
    showing = upcoming;
    const { request } = upcoming;
    title.textContent = queue.length > 0 ? `The brain asks (1 of ${queue.length + 1})` : 'The brain asks';
    what.textContent = `${request.tool}: ${request.summary}`;
    risk.textContent = `This would ${RISK_WORDS[request.risk]}.`;
    const note = OWN_HANDS[request.risk];
    hands.hidden = note === undefined;
    hands.textContent = note ?? '';
    // The whole call, never cut: a summary is not what the owner is consenting to. Scrollable; plain text, never markup.
    detail.hidden = request.detail === undefined || request.detail === '';
    detail.textContent = request.detail ?? '';
    detail.scrollTop = 0;
    allow.dataset['request'] = request.request;
    deny.dataset['request'] = request.request;
    if (!dialog.open) {
      before = document.activeElement;
      dialog.showModal();
    }
    arm(request.request);
    tick();
    clearInterval(timer);
    timer = setInterval(tick, 250);
  }

  deny.addEventListener('click', () => answer(false, deny.dataset['request'] ?? ''));
  allow.addEventListener('click', () => answer(true, allow.dataset['request'] ?? ''));
  // Escape closes a modal dialog: that is a no, never a yes.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    answer(false);
  });

  const hear = (note: AgentNote): void => {
    if (note.type === 'permission') {
      queue.push({ request: note, until: Date.now() + note.expiresMs });
      if (showing === null) next();
      return;
    }
    if (note.type !== 'over') return;
    // The answer's turn has ended or been stopped: the server has already said no, so nobody is asked.
    const gone = (entry: { readonly request: Request }): boolean => note.turn === null || entry.request.turn === note.turn;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];
      if (entry !== undefined && gone(entry)) queue.splice(index, 1);
    }
    if (showing !== null && gone(showing)) {
      showing = null;
      disarm();
      clearInterval(timer);
      next();
    }
  };
  const off = app.onAgent(hear);

  return {
    dispose() {
      off();
      clearInterval(timer);
      clearTimeout(armTimer);
      dialog.remove();
    },
  };
}
