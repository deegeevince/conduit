import { PROMPT_MAX_CHARS } from '@conduit/language';

export interface PromptBar {
  /** shows what the link and the turn are doing, in words: connecting, thinking, playing, stopped. Only a status that asks to be announced reaches a screen reader (routine playing/thinking changes do not; the transcript's log carries the content) */
  setStatus(text: string, announce?: boolean): void;
  /** while a turn is playing the submit button becomes Stop */
  setBusy(busy: boolean): void;
  /** while an export runs the status line offers Cancel; null removes it */
  setCancel(cancel: (() => void) | null): void;
  /** puts words back in the field after they could not be sent, unless the user has typed something new */
  restore(text: string): void;
  /** a slot beside the status line, for the transcript toggle */
  readonly extra: HTMLElement;
  focus(): void;
  dispose(): void;
}

let counter = 0;

/** The most of the viewport the field may grow to before it scrolls. */
const MAX_FIELD_VIEWPORT = 0.4;

/** The one input: a labelled text area that grows with what is typed, a submit/stop button and a status line. Enter submits, Shift+Enter breaks the line; Escape stops. */
export function mountPromptBar(
  host: HTMLElement,
  handlers: { readonly onSubmit: (text: string) => void; readonly onStop: () => void },
): PromptBar {
  counter += 1;
  const inputId = `prompt-input-${counter}`;
  const root = document.createElement('div');
  root.className = 'prompt';
  root.innerHTML = `
    <div class="prompt__top">
      <p class="prompt__status"></p>
      <button class="prompt__cancel" type="button" hidden>Cancel</button>
      <p class="visually-hidden prompt__notice" role="status"></p>
      <div class="prompt__extra"></div>
    </div>
    <form class="prompt__form" autocomplete="off">
      <label class="visually-hidden" for="${inputId}">Ask anything</label>
      <textarea class="prompt__input" id="${inputId}" name="prompt" rows="1" placeholder="Ask anything, or paste a link or a long text" enterkeyhint="send" maxlength="${PROMPT_MAX_CHARS}" autocomplete="off" autocapitalize="sentences" spellcheck="true"></textarea>
      <button class="prompt__button" type="button">Send</button>
    </form>`;
  host.append(root);

  const status = root.querySelector<HTMLElement>('.prompt__status');
  const notice = root.querySelector<HTMLElement>('.prompt__notice');
  const cancel = root.querySelector<HTMLButtonElement>('.prompt__cancel');
  const extra = root.querySelector<HTMLElement>('.prompt__extra');
  const form = root.querySelector<HTMLFormElement>('.prompt__form');
  const input = root.querySelector<HTMLTextAreaElement>('.prompt__input');
  const button = root.querySelector<HTMLButtonElement>('.prompt__button');
  if (status === null || notice === null || extra === null || cancel === null || form === null || input === null || button === null) {
    throw new Error('The prompt bar could not be built.');
  }

  const fit = (): void => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, Math.floor(window.innerHeight * MAX_FIELD_VIEWPORT))}px`;
  };
  input.addEventListener('input', fit);
  window.addEventListener('resize', fit);

  let busy = false;
  let onCancel: (() => void) | null = null;
  cancel.addEventListener('click', () => {
    onCancel?.();
    if (!window.matchMedia('(pointer: coarse)').matches) input.focus({ preventScroll: true });
  });

  const submit = (): void => {
    const text = input.value.trim();
    if (text === '') return;
    input.value = '';
    fit();
    handlers.onSubmit(text);
  };

  const refocus = (): void => {
    if (!window.matchMedia('(pointer: coarse)').matches) input.focus();
  };

  // Enter in the field sends. With text, that sends it and so interrupts whatever is playing; the button is the only thing that reads Stop.
  form.addEventListener('submit', (event) => event.preventDefault());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
    refocus();
  });

  button.addEventListener('click', () => {
    if (busy) handlers.onStop();
    else submit();
    refocus();
  });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || !busy || document.querySelector('dialog[open]') !== null) return;
    event.preventDefault();
    handlers.onStop();
  };
  document.addEventListener('keydown', onKey);

  return {
    extra,
    setStatus(text, announce = false) {
      if (status.textContent === text) return;
      status.textContent = text;
      notice.textContent = announce ? text : '';
    },
    setCancel(next) {
      onCancel = next;
      cancel.hidden = next === null;
    },
    setBusy(next) {
      if (next === busy) return;
      busy = next;
      button.textContent = next ? 'Stop' : 'Send';
      button.classList.toggle('prompt__button--stop', next);
      button.setAttribute('aria-keyshortcuts', next ? 'Escape' : '');
    },
    restore(text) {
      if (input.value === '') {
        input.value = text;
        fit();
      }
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    dispose() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', fit);
      root.remove();
    },
  };
}
