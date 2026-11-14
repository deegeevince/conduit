// The composer: one pill. `+` (a menu: photo, camera, draw, save), a field that rests at one line and grows only while typing, the microphone, and Send
// (which reads Stop while a reply is being made). It takes no row of its own for a status: what needs saying (a refusal, a stop, a failure) sits above the
// pill for as long as it is true, and the photos being sent and the voice strip appear there only while they are in use.
// Photos and voice notes are the chrome's own pieces (chrome/photos.ts, chrome/voice.ts); this file only gives them a place.

import { PROMPT_MAX_CHARS } from '@conduit/language';
import { mountPhotoTray } from '../chrome/photos';
import type { Photo, PhotoPort, PhotoTray } from '../chrome/photos';
import { mountVoice } from '../chrome/voice';
import type { Voice, VoicePort } from '../chrome/voice';

export interface ComposerHandlers {
  /** `photos` are the ids kept for these words, `held` the tray's photos, `voice` the notes the words came from. False: the words were not a turn (a command), so the photos stay. */
  readonly onSubmit: (text: string, photos: readonly string[], held: readonly Photo[], voice: readonly string[]) => boolean;
  readonly onStop: () => void;
  /** something other than words waits to be sent (ink drawn on the canvas): an empty field may still send */
  readonly hasExtra: () => boolean;
  readonly photos: PhotoPort;
  readonly voice: VoicePort;
  readonly onDraw: () => void;
  readonly onSave: () => void;
}

export interface Composer {
  setBusy(busy: boolean): void;
  /** a line above the pill while it is true; null takes it away. `announce` says it to a screen reader; `cancel` adds a Cancel to it. */
  setStatus(text: string | null, options?: { readonly announce?: boolean; readonly cancel?: (() => void) | null }): void;
  /** the words (and photos) of a turn that was not accepted, put back unless something new has been typed */
  restore(text: string, held?: readonly Photo[]): void;
  /** the words in the field now, for the shell to look at */
  value(): string;
  /** the ink or the field changed: Send looks again at whether there is something to send */
  refresh(): void;
  focus(): void;
  readonly tray: PhotoTray;
  dispose(): void;
}

let counter = 0;

const PLUS = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const SEND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
const STOP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const PHOTO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/></svg>';
const CAMERA = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/></svg>';
const SAVE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>';

export function mountComposer(host: HTMLElement, handlers: ComposerHandlers): Composer {
  counter += 1;
  const id = `composer-${counter}`;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  host.classList.add('composer');
  host.innerHTML = `
    <div class="composer__status" hidden><span class="composer__text"></span><button type="button" class="composer__cancel" hidden>Cancel</button></div>
    <p class="vh composer__announce" role="status"></p>
    <form class="pill" autocomplete="off">
      <button type="button" class="pill__btn pill__plus" aria-label="Add photos and more" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}-menu">${PLUS}</button>
      <div class="menu" id="${id}-menu" role="menu" aria-label="Add" hidden>
        <button type="button" class="menu__item" role="menuitem" data-do="photo">${PHOTO}<span>Add a photo</span></button>
        <button type="button" class="menu__item" role="menuitem" data-do="camera"${coarse ? '' : ' hidden'}>${CAMERA}<span>Take a photo</span></button>
        <button type="button" class="menu__item" role="menuitem" data-do="draw">${PENCIL}<span>Draw on the canvas</span></button>
        <button type="button" class="menu__item" role="menuitem" data-do="save">${SAVE}<span>Save this answer</span></button>
      </div>
      <input class="vh" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" data-photos="pick" />
      <input class="vh" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" data-photos="camera" />
      <label class="vh" for="${id}-field">Ask anything</label>
      <textarea class="pill__field" id="${id}-field" name="prompt" rows="1" placeholder="Ask anything" enterkeyhint="send" maxlength="${PROMPT_MAX_CHARS}" autocomplete="off" autocapitalize="sentences" spellcheck="true" aria-describedby="${id}-hint"></textarea>
      <span class="vh" id="${id}-hint">You can paste a photo or a link. Lines starting with a slash are commands: /help lists them.</span>
      <button type="button" class="pill__btn pill__voice" aria-label="Record a voice note" aria-pressed="false" title="Record a voice note: tap to start and stop, or hold while you speak. It is read on your Mac and goes nowhere else."></button>
      <button type="button" class="pill__send" aria-label="Send" aria-disabled="true">${SEND}</button>
    </form>`;
  const part = <T extends HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector);
    if (found === null) throw new Error('The composer could not be built.');
    return found;
  };
  const statusRow = part('.composer__status');
  const statusText = part('.composer__text');
  const cancel = part<HTMLButtonElement>('.composer__cancel');
  const announcer = part('.composer__announce');
  const form = part<HTMLFormElement>('.pill');
  const plus = part<HTMLButtonElement>('.pill__plus');
  const menu = part('.menu');
  const field = part<HTMLTextAreaElement>('.pill__field');
  const mic = part<HTMLButtonElement>('.pill__voice');
  const send = part<HTMLButtonElement>('.pill__send');

  const tray = mountPhotoTray(form, handlers.photos, () => refresh());
  let voice: Voice | null = null;
  let busy = false;
  let onCancel: (() => void) | null = null;

  const fit = (): void => {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, Math.floor(window.innerHeight * 0.4))}px`;
  };
  const hasSomething = (): boolean => field.value.trim() !== '' || tray.ids().length > 0 || handlers.hasExtra();
  function refresh(): void {
    send.setAttribute('aria-disabled', String(!busy && !hasSomething()));
    send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    send.innerHTML = busy ? STOP : SEND;
    if (busy) send.setAttribute('aria-keyshortcuts', 'Escape');
    else send.removeAttribute('aria-keyshortcuts');
  }
  field.addEventListener('input', () => {
    fit();
    refresh();
  });
  window.addEventListener('resize', fit);

  // The menu: arrows move, Escape and Tab leave, a choice closes it and does its one thing.
  const items = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('.menu__item')].filter((item) => !item.hidden);
  const setMenu = (open: boolean, focus = false): void => {
    menu.hidden = !open;
    plus.setAttribute('aria-expanded', String(open));
    if (open) items()[0]?.focus();
    else if (focus) plus.focus();
  };
  plus.addEventListener('click', () => setMenu(menu.hidden === true));
  plus.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setMenu(true);
    }
  });
  menu.addEventListener('keydown', (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') all[(at + 1) % all.length]?.focus();
    else if (event.key === 'ArrowUp') all[(at - 1 + all.length) % all.length]?.focus();
    else if (event.key === 'Home') all[0]?.focus();
    else if (event.key === 'End') all[all.length - 1]?.focus();
    else if (event.key === 'Escape') setMenu(false, true);
    else if (event.key === 'Tab') setMenu(false);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
  });
  const onOutside = (event: Event): void => {
    if (!menu.hidden && event.target instanceof Node && !form.contains(event.target)) setMenu(false);
  };
  document.addEventListener('pointerdown', onOutside);

  const pick = part<HTMLInputElement>('input[data-photos="pick"]');
  const camera = part<HTMLInputElement>('input[data-photos="camera"]');
  for (const file of [pick, camera]) {
    file.addEventListener('change', () => {
      tray.add([...(file.files ?? [])]);
      file.value = '';
    });
  }
  menu.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.menu__item') : null;
    if (item === null) return;
    setMenu(false);
    const what = item.dataset['do'];
    if (what === 'photo') pick.click();
    else if (what === 'camera') camera.click();
    else if (what === 'draw') handlers.onDraw();
    else if (what === 'save') handlers.onSave();
  });

  const submit = (): void => {
    const typed = field.value.trim();
    const photos = tray.ids();
    if (tray.busy()) {
      tray.say('A photo is still being sent. One moment.');
      return;
    }
    const extra = handlers.hasExtra();
    if (typed === '' && photos.length === 0 && !extra) return;
    const text = typed === '' ? (extra && photos.length === 0 ? '' : photos.length === 1 ? 'Please look at this photo.' : 'Please look at these photos.') : typed;
    const held = tray.held();
    const spoken = voice?.ids() ?? [];
    field.value = '';
    fit();
    const accepted = handlers.onSubmit(text, photos, held, spoken);
    if (accepted !== false) {
      tray.clear();
      voice?.clear();
    }
    refresh();
  };

  const refocus = (): void => {
    if (!coarse) field.focus();
  };
  form.addEventListener('submit', (event) => event.preventDefault());
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
    refocus();
  });
  send.addEventListener('click', () => {
    if (busy) handlers.onStop();
    else submit();
    refocus();
  });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || !busy || document.querySelector('dialog[open]') !== null || !menu.hidden) return;
    event.preventDefault();
    handlers.onStop();
  };
  document.addEventListener('keydown', onKey);

  voice = mountVoice(mic, form, field, handlers.voice, {
    onWords: (words, now) => {
      const there = field.value.trim();
      field.value = there === '' ? words : `${there} ${words}`;
      fit();
      refresh();
      if (now) submit();
      else field.focus({ preventScroll: true });
    },
  });

  cancel.addEventListener('click', () => onCancel?.());
  refresh();

  return {
    tray,
    setBusy(next) {
      if (next === busy) return;
      busy = next;
      refresh();
    },
    setStatus(text, options = {}) {
      onCancel = options.cancel ?? null;
      cancel.hidden = onCancel === null;
      statusRow.hidden = text === null;
      statusText.textContent = text ?? '';
      if (text !== null && options.announce === true && announcer.textContent !== text) announcer.textContent = text;
      if (text === null) announcer.textContent = '';
    },
    restore(text, held) {
      if (field.value === '') {
        field.value = text;
        fit();
      }
      if (held !== undefined && held.length > 0 && tray.held().length === 0) tray.putBack(held);
      refresh();
    },
    value: () => field.value,
    refresh,
    focus() {
      field.focus({ preventScroll: true });
    },
    dispose() {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      window.removeEventListener('resize', fit);
      tray.dispose();
      voice?.dispose();
      host.replaceChildren();
    },
  };
}
