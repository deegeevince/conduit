// The work mode: a question the person is to work out (an `ask` on the stage) takes the whole screen. The composer steps back to a small "Ask"
// button, the ink layer is laid over the stage and takes the pen, and one "Done" button puts it all away. A finger or a mouse presses what is under the
// layer (Check, a hint, a choice); only the pen writes. What she drew stays put while a hint, a choice of layout or a new step changes the stage under it.

import type { StageInk } from '../ink/stage';

export interface WorkModeOptions {
  readonly stage: HTMLElement;
  readonly bar: HTMLElement;
  readonly ink: StageInk;
  /** the controls on the stage now (the stage hook's own list) */
  readonly controls: () => readonly { readonly id: string; readonly ask?: boolean }[];
}

export interface WorkMode {
  readonly on: () => boolean;
  dispose(): void;
}

export function mountWorkMode(options: WorkModeOptions): WorkMode {
  const { stage, bar, ink } = options;
  const body = document.body;
  let on = false;
  let dismissed = '';
  const button = (label: string, className: string, run: () => void): HTMLButtonElement => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `work-button ${className}`;
    element.textContent = label;
    element.hidden = true;
    element.addEventListener('click', run);
    document.body.append(element);
    return element;
  };
  const exit = button('Done', 'work-button--done', () => leave(true));
  const asking = button('Ask', 'work-button--ask', () => {
    const open = body.classList.toggle('work--ask');
    asking.textContent = open ? 'Back' : 'Ask';
  });

  const signature = (): string =>
    options
      .controls()
      .filter((control) => control.ask === true)
      .map((control) => control.id)
      .sort()
      .join(',');

  function enter(): void {
    on = true;
    body.classList.add('work');
    body.classList.remove('work--ask');
    exit.hidden = false;
    asking.hidden = false;
    asking.textContent = 'Ask';
    ink.show(true);
  }
  function leave(dismiss: boolean): void {
    if (dismiss) dismissed = signature();
    on = false;
    body.classList.remove('work', 'work--ask');
    exit.hidden = true;
    asking.hidden = true;
    ink.show(false);
  }

  // a finger or a mouse goes through the layer to what is under it; the pen writes
  const through = (event: PointerEvent): void => {
    if (!on || event.pointerType === 'pen' || !event.isTrusted) return;
    const layer = ink.ink.root.closest<HTMLElement>('.ink-stage');
    if (layer === null) return;
    if ((event.target as Element | null)?.closest('.ink-bar') !== null) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    layer.style.pointerEvents = 'none';
    const under = document.elementFromPoint(event.clientX, event.clientY);
    layer.style.pointerEvents = '';
    if (under === null) return;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: true, button: event.button, buttons: event.buttons };
    under.dispatchEvent(new PointerEvent(event.type, init));
    if (event.type === 'pointerup') {
      under.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY }));
      if (under instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(under.tagName)) under.focus();
    }
  };
  for (const type of ['pointerdown', 'pointerup', 'pointermove']) ink.ink.root.addEventListener(type, through as EventListener, true);

  const timer = window.setInterval(() => {
    const now = signature();
    if (!on && now !== '' && now !== dismissed) enter();
    else if (on && now === '') leave(false);
    if (now === '') dismissed = '';
  }, 400);
  void stage;
  void bar;
  return {
    on: () => on,
    dispose() {
      window.clearInterval(timer);
      exit.remove();
      asking.remove();
    },
  };
}
