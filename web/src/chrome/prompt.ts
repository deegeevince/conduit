import { PROMPT_MAX_CHARS, UPLOAD_LIMITS } from '@conduit/language';
import { mountPhotoTray } from './photos';
import type { Photo, PhotoPort } from './photos';
import { mountVoice } from './voice';
import type { Voice, VoicePort } from './voice';
import { mountComposerMenu } from './menu';
import type { ComposerMenu } from './menu';

export interface PromptBar {
  /**
   * What the link and the turn are doing, in words: connecting, thinking, playing, stopped. A routine, short status goes into the field's own
   * placeholder (ready is "Ask anything"); only what needs saying (an error, an export under way, a long sentence) is shown, as a small line above the bar.
   * Only a status that asks to be announced reaches a screen reader (routine playing/thinking changes do not; the transcript's log carries the content).
   */
  setStatus(text: string, announce?: boolean): void;
  /** while a turn is playing the submit button becomes Stop */
  setBusy(busy: boolean): void;
  /** while an export runs the line above the bar offers Cancel; null removes it */
  setCancel(cancel: (() => void) | null): void;
  /** puts words (and the photos that went with them) back in the field after they could not be sent, unless the user has typed something new */
  restore(text: string, photos?: readonly Photo[]): void;
  /** the [+] menu: a photo, Draw, Save, the Transcript, the model, Copy answer, About. Other parts of the chrome add their entries to it. */
  readonly menu: ComposerMenu;
  /** the small line above the bar: the status when it has something to say, and the buttons that come and go with a turn (Show all, Cancel, Mute) */
  readonly top: HTMLElement;
  /** where panels and live regions that belong to the bar but are not in the line go (the transcript's panel); takes no room */
  readonly extra: HTMLElement;
  /** a slot above the status for what the agent is doing */
  readonly activity: HTMLElement;
  focus(): void;
  dispose(): void;
}

let counter = 0;

/** What the menu says under "Add a photo or PDF". */
const PHOTO_GIST = `up to ${UPLOAD_LIMITS.perTurn}, JPEG, PNG, WebP, HEIC or PDF`;

const ICON = (path: string): string => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const PLUS = ICON('<path d="M12 5v14M5 12h14"/>');
const SEND = ICON('<path d="M12 19V6M6 12l6-6 6 6"/>');
const STOP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>';

/** The longest status the placeholder takes; anything longer is shown as the line above the bar. */
const PLACEHOLDER_CHARS = 16;
const ASK = 'Ask anything';

/** The most of the viewport the field may grow to before it scrolls. */
const MAX_FIELD_VIEWPORT = 0.4;

/** The one input: a labelled text area that grows with what is typed, a submit/stop button and a status line. Enter submits, Shift+Enter breaks the line; Escape stops. */
export function mountPromptBar(
  host: HTMLElement,
  handlers: {
    /** `photos` are the ids of the photos kept for these words, `held` the same photos as the tray shows them. Answer false when the words were not a turn (a command): the photos stay. */
    readonly onSubmit: (text: string, photos: readonly string[], held: readonly Photo[], voice: readonly string[]) => boolean;
    readonly onStop: () => void;
    /** something other than words and photos waits to be sent (ink drawn on the stage): an empty field may still send */
    readonly hasExtra?: () => boolean;
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
  // One line at rest: [+] the field, the mic, Send. Above it, only when there is something to say, a small line (the status, Show all, Cancel).
  root.innerHTML = `
    <div class="prompt__float">
      <div class="prompt__activity"></div>
      <div class="prompt__top" hidden>
        <p class="prompt__status"></p>
        <button class="prompt__cancel" type="button" hidden>Cancel</button>
      </div>
      <p class="visually-hidden prompt__notice" role="status"></p>
    </div>
    <div class="prompt__extra"></div>
    <div class="composer">
      <form class="prompt__form" autocomplete="off">
        <button class="composer__btn composer__plus" type="button" aria-label="More: photo, draw, save, transcript, model" title="More">${PLUS}</button>
        <label class="visually-hidden" for="${inputId}">Ask anything</label>
        ${
          handlers.photos === undefined
            ? ''
            : `<input class="visually-hidden" type="file" accept="image/*,application/pdf,.pdf" multiple tabindex="-1" aria-hidden="true" data-photos="pick" />
        <input class="visually-hidden" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" data-photos="camera" />`
        }
        <textarea class="prompt__input" id="${inputId}" name="prompt" rows="1" placeholder="${ASK}" aria-describedby="${inputId}-hint" enterkeyhint="send" maxlength="${PROMPT_MAX_CHARS}" autocomplete="off" autocapitalize="sentences" spellcheck="true"></textarea>
        <span class="visually-hidden" id="${inputId}-hint">Enter sends, Shift and Enter make a new line. You can also paste a link or a long text. Lines starting with a slash are commands: /help lists them.</span>
        ${handlers.voice === undefined ? '' : '<button class="composer__btn prompt__voice" type="button" aria-label="Record a voice note" aria-pressed="false" title="Record a voice note: tap to start and stop, or hold while you speak. It is read on your Mac and goes nowhere else."></button>'}
        <button class="composer__btn prompt__button" type="button" aria-label="Send" title="Send">${SEND}</button>
      </form>
    </div>`;
  host.append(root);

  const status = root.querySelector<HTMLElement>('.prompt__status');
  const notice = root.querySelector<HTMLElement>('.prompt__notice');
  const top = root.querySelector<HTMLElement>('.prompt__top');
  const float = root.querySelector<HTMLElement>('.prompt__float');
  const activity = root.querySelector<HTMLElement>('.prompt__activity');
  const cancel = root.querySelector<HTMLButtonElement>('.prompt__cancel');
  const extra = root.querySelector<HTMLElement>('.prompt__extra');
  const composer = root.querySelector<HTMLElement>('.composer');
  const form = root.querySelector<HTMLFormElement>('.prompt__form');
  const input = root.querySelector<HTMLTextAreaElement>('.prompt__input');
  const button = root.querySelector<HTMLButtonElement>('.prompt__button');
  const plus = root.querySelector<HTMLButtonElement>('.composer__plus');
  const mic = root.querySelector<HTMLButtonElement>('.prompt__voice');
  if (status === null || top === null || float === null || activity === null || notice === null || extra === null || composer === null || cancel === null || form === null || input === null || button === null || plus === null) {
    throw new Error('The prompt bar could not be built.');
  }
  const menu = mountComposerMenu(plus, root);
  const tray = handlers.photos === undefined ? null : mountPhotoTray(form, handlers.photos, () => undefined);
  let voice: Voice | null = null;

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

  // The line above the bar is there only while something in it is: words in the status, or a button that has come with a turn (Show all, Cancel, Mute).
  const settleTop = (): void => {
    const buttons = [...top.querySelectorAll<HTMLElement>('button')].some((el) => !el.hidden);
    const words = !status.classList.contains('prompt__status--quiet') && status.textContent !== '';
    // (not assigned when unchanged: setting an attribute to the value it has is still a mutation, and this is what watches for them)
    const hide = !buttons && !words;
    if (top.hidden !== hide) top.hidden = hide;
  };
  const watcher = typeof MutationObserver === 'undefined' ? null : new MutationObserver(settleTop);
  watcher?.observe(top, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });

  // The menu's photo entries open the camera or the library (a phone) or the file picker (a desktop); what they pick goes where a paste or a drop goes.
  // Any touch screen counts (an iPad with a keyboard and trackpad reports a fine primary pointer, and still has a camera).
  const coarse = window.matchMedia('(any-pointer: coarse)');
  const touch = (): boolean => coarse.matches || (navigator.maxTouchPoints ?? 0) > 0;
  const photoEntries: { readonly kind: 'pick' | 'camera'; readonly set: (hidden: boolean) => void }[] = [];
  if (tray !== null) {
    for (const [kind, label, gist, order] of [
      ['pick', 'Add a photo or PDF', PHOTO_GIST, 10],
      ['camera', 'Take a photo', 'with this phone\'s camera', 20],
    ] as const) {
      const file = root.querySelector<HTMLInputElement>(`input[data-photos="${kind}"]`);
      if (file === null) continue;
      const entry = menu.add({ id: kind === 'pick' ? 'photo' : 'camera', label, gist, order, hidden: kind === 'camera' && !touch(), run: () => file.click() });
      photoEntries.push({ kind, set: (hidden) => entry.set({ hidden }) });
      file.addEventListener('change', () => {
        tray.add([...(file.files ?? [])]);
        // the same photo may be chosen again after it was removed
        file.value = '';
      });
    }
  }
  const onCoarse = (): void => photoEntries.find((entry) => entry.kind === 'camera')?.set(!touch());
  coarse.addEventListener?.('change', onCoarse);

  const submit = (): void => {
    const typed = input.value.trim();
    const photos = tray?.ids() ?? [];
    if (tray !== null && tray.busy()) {
      tray.say('A photo is still being sent. One moment.');
      return;
    }
    const extra = handlers.hasExtra?.() === true;
    if (typed === '' && photos.length === 0 && !extra) return;
    const text = typed === '' ? (extra && photos.length === 0 ? '' : photos.length === 1 ? 'Please look at this photo.' : 'Please look at these photos.') : typed;
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
    mic.innerHTML = '';
    voice = mountVoice(mic, float, input, handlers.voice, {
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
    if (!coarse.matches) input.focus();
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

  /** the placeholder, in the one state it is not "Ask anything": a short routine status while the field is empty */
  const say = (text: string): void => {
    input.placeholder = text;
  };

  return {
    menu,
    top,
    extra,
    activity,
    setStatus(text, announce = false) {
      // The words are always kept (the page's own rest check reads them); whether they are *shown* is the rule above.
      const alreadySet = status.textContent === text;
      status.textContent = text;
      if (!alreadySet) notice.textContent = announce ? text : '';
      const stopped = text === 'stopped';
      const routine = !announce || stopped;
      const short = text.length <= PLACEHOLDER_CHARS;
      const inPlaceholder = text === 'ready' || text === '' || stopped || (routine && short);
      status.classList.toggle('prompt__status--quiet', inPlaceholder);
      say(text === 'ready' || text === '' ? ASK : stopped ? 'Stopped. Ask again' : inPlaceholder ? `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}…` : ASK);
      settleTop();
    },
    setCancel(next) {
      onCancel = next;
      cancel.hidden = next === null;
    },
    setBusy(next) {
      if (next === busy) return;
      busy = next;
      button.innerHTML = next ? STOP : SEND;
      button.setAttribute('aria-label', next ? 'Stop' : 'Send');
      button.title = next ? 'Stop (Escape)' : 'Send';
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
      coarse.removeEventListener?.('change', onCoarse);
      watcher?.disconnect();
      menu.dispose();
      tray?.dispose();
      voice?.dispose();
      root.remove();
    },
  };
}
