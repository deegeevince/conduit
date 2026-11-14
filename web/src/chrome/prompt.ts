import { PROMPT_MAX_CHARS } from '@conduit/language';
import { PHOTO_RULES, mountPhotoTray } from './photos';
import type { Photo, PhotoPort } from './photos';
import { mountVoice } from './voice';
import type { Voice, VoicePort } from './voice';

export interface PromptBar {
  /** shows what the link and the turn are doing, in words: connecting, thinking, playing, stopped. Only a status that asks to be announced reaches a screen reader (routine playing/thinking changes do not; the transcript's log carries the content) */
  setStatus(text: string, announce?: boolean): void;
  /** while a turn is playing the submit button becomes Stop */
  setBusy(busy: boolean): void;
  /** while an export runs the status line offers Cancel; null removes it */
  setCancel(cancel: (() => void) | null): void;
  /** puts words (and the photos that went with them) back in the field after they could not be sent, unless the user has typed something new */
  restore(text: string, photos?: readonly Photo[]): void;
  /** the row with the status line: Show all and Cancel sit beside it */
  readonly top: HTMLElement;
  /** the row of the bar's own controls: the brain picker, the transcript, Save */
  readonly extra: HTMLElement;
  /** a slot above the status for what the agent is doing */
  readonly activity: HTMLElement;
  focus(): void;
  dispose(): void;
}

let counter = 0;

const CAMERA = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const PICTURE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/></svg>';

/** The most of the viewport the field may grow to before it scrolls. */
const MAX_FIELD_VIEWPORT = 0.4;

/** The one input: a labelled text area that grows with what is typed, a submit/stop button and a status line. Enter submits, Shift+Enter breaks the line; Escape stops. */
export function mountPromptBar(
  host: HTMLElement,
  handlers: {
    /** `photos` are the ids of the photos kept for these words, `held` the same photos as the tray shows them. Answer false when the words were not a turn (a command): the photos stay. */
    readonly onSubmit: (text: string, photos: readonly string[], held: readonly Photo[], voice: readonly string[]) => boolean;
    readonly onStop: () => void;
    /** how a photo gets to the server and back; absent: the bar has no photo button */
    readonly photos?: PhotoPort;
    /** how a voice note gets read on the owner's Mac; absent: the bar has no microphone button */
    readonly voice?: VoicePort;
  },
): PromptBar {
  counter += 1;
  const inputId = `prompt-input-${counter}`;
  const root = document.createElement('div');
  root.className = 'prompt';
  root.innerHTML = `
    <div class="prompt__activity"></div>
    <div class="prompt__top">
      <p class="prompt__status"></p>
      <button class="prompt__cancel" type="button" hidden>Cancel</button>
      <p class="visually-hidden prompt__notice" role="status"></p>
    </div>
    <div class="prompt__extra"></div>
    <form class="prompt__form" autocomplete="off">
      <label class="visually-hidden" for="${inputId}">Ask anything</label>
      ${
        handlers.photos === undefined
          ? ''
          : `<button class="prompt__photo prompt__photo--camera" type="button" aria-label="Take a photo" title="Take a photo">${CAMERA}</button>
      <button class="prompt__photo prompt__photo--pick" type="button" aria-label="Add a photo" title="Add a photo. ${PHOTO_RULES}">${PICTURE}</button>
      <input class="visually-hidden" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" data-photos="pick" />
      <input class="visually-hidden" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" data-photos="camera" />`
      }
      ${handlers.voice === undefined ? '' : '<button class="prompt__photo prompt__voice" type="button" aria-label="Record a voice note" aria-pressed="false" title="Record a voice note: tap to start and stop, or hold while you speak. It is read on your Mac and goes nowhere else."></button>'}
      <textarea class="prompt__input" id="${inputId}" name="prompt" rows="1" placeholder="Ask anything" aria-describedby="${inputId}-hint" enterkeyhint="send" maxlength="${PROMPT_MAX_CHARS}" autocomplete="off" autocapitalize="sentences" spellcheck="true"></textarea>
      <span class="visually-hidden" id="${inputId}-hint">You can also paste a link or a long text. Lines starting with a slash are commands: /help lists them.</span>
      <button class="prompt__button" type="button">Send</button>
    </form>`;
  host.append(root);

  const status = root.querySelector<HTMLElement>('.prompt__status');
  const notice = root.querySelector<HTMLElement>('.prompt__notice');
  const top = root.querySelector<HTMLElement>('.prompt__top');
  const activity = root.querySelector<HTMLElement>('.prompt__activity');
  const cancel = root.querySelector<HTMLButtonElement>('.prompt__cancel');
  const extra = root.querySelector<HTMLElement>('.prompt__extra');
  const form = root.querySelector<HTMLFormElement>('.prompt__form');
  const input = root.querySelector<HTMLTextAreaElement>('.prompt__input');
  const button = root.querySelector<HTMLButtonElement>('.prompt__button');
  const tray = handlers.photos === undefined || form === null ? null : mountPhotoTray(form, handlers.photos, () => undefined);
  const mic = root.querySelector<HTMLButtonElement>('.prompt__voice');
  let voice: Voice | null = null;
  if (status === null || top === null || activity === null || notice === null || extra === null || cancel === null || form === null || input === null || button === null) {
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

  // The photo buttons open the camera or the library (a phone) or the file picker (a desktop); what they pick goes where a paste or a drop goes.
  const camera = root.querySelector<HTMLButtonElement>('.prompt__photo--camera');
  const pick = root.querySelector<HTMLButtonElement>('.prompt__photo--pick');
  for (const [trigger, kind] of [[camera, 'camera'], [pick, 'pick']] as const) {
    const file = root.querySelector<HTMLInputElement>(`input[data-photos="${kind}"]`);
    if (trigger === null || file === null || tray === null) continue;
    trigger.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      tray.add([...(file.files ?? [])]);
      // the same photo may be chosen again after it was removed
      file.value = '';
    });
  }

  const submit = (): void => {
    const typed = input.value.trim();
    const photos = tray?.ids() ?? [];
    if (tray !== null && tray.busy()) {
      tray.say('A photo is still being sent. One moment.');
      return;
    }
    if (typed === '' && photos.length === 0) return;
    const text = typed === '' ? (photos.length === 1 ? 'Please look at this photo.' : 'Please look at these photos.') : typed;
    const held = tray?.held() ?? [];
    const spoken = voice?.ids() ?? [];
    input.value = '';
    fit();
    const accepted = handlers.onSubmit(text, photos, held, spoken);
    if (accepted !== false) {
      tray?.clear();
      voice?.clear();
    }
  };

  // The microphone: what is said comes back as words in the field, to be checked before sending (or sent at once when the owner chose that).
  if (mic !== null && handlers.voice !== undefined) {
    voice = mountVoice(mic, form, input, handlers.voice, {
      onWords: (words, send) => {
        const there = input.value.trim();
        input.value = there === '' ? words : `${there} ${words}`;
        fit();
        if (send) submit();
        else input.focus({ preventScroll: true });
      },
    });
  }

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
    top,
    extra,
    activity,
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
    restore(text, photos) {
      if (input.value === '') {
        input.value = text;
        fit();
      }
      if (photos !== undefined && photos.length > 0 && tray !== null && tray.held().length === 0) tray.putBack(photos);
    },
    focus() {
      input.focus({ preventScroll: true });
    },
    dispose() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', fit);
      tray?.dispose();
      voice?.dispose();
      root.remove();
    },
  };
}
