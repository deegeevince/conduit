// The stage's own controls beyond the prompt: "Show all" for the viewer's
// time, and what can be saved from an answer.

import type { StageApp } from '../app/stage-app';
import type { ExportRequest } from '../contracts/export';
import type { ComposerMenu, MenuEntryHandle } from './menu';
import { SIZES, copyAnswer, copyScript, saveBlob, saveMidi, saveScript, saveStill } from './files';

export interface Actions {
  dispose(): void;
}

/** What the actions need of the transcript: to open at the turn the viewer skipped through. */
export interface TranscriptView {
  revealTurn(turn: string): void;
}

/** Where the actions go: Show all in the small line above the bar, Save and Copy answer in the composer's [+] menu. */
export interface ActionSlots {
  readonly top: HTMLElement;
  readonly menu: ComposerMenu;
}

type Formats = Awaited<ReturnType<StageApp['formats']>>;

const NO_FORMATS: Formats = { video: [], svg: false, pdf: false };

let counter = 0;

function sceneCount(lines: readonly { readonly text: string }[]): number {
  return lines.filter((line) => /^scene(\s|$)/.test(line.text)).length;
}

/**
 * Mounts, in `host` (the prompt bar's extra slot):
 *
 * - **Show all**: a button, and the key `.` while the stage itself has focus
 *   (never in a field or elsewhere on the page, so a single-character
 *   shortcut cannot catch anyone typing: WCAG 2.1.4). Visible while a turn is open or playing; calls
 *   `painter.showAll()`. If the answer had more than one scene, the
 *   transcript opens at this turn, because the stage can only rest on the
 *   last one (on a narrow screen it says so in the status line instead, because the
 *   sheet would cover the stage).
 * - **Save**: an entry of the composer's [+] menu that opens a list of: Copy script, Save script, Play a
 *   script (a textarea in a dialog; sends input kind `script`), Save picture
 *   (PNG, SVG), Save film (the latest answer: the prompt it began with and
 *   the taps and controls that carried it on; the formats `Exporter.formats()`
 *   offers, at 1920x1080 or 1080x1920 or 1080x1080, 30 or 60 fps) and Save
 *   whole conversation (a WebM of every turn in order, each after a title card
 *   of what was asked, at most ten minutes, with the music of any tunes), both
 *   with progress in the status line and Cancel. Each item says in a line what it does. Enabled
 *   once a turn has ended.
 * - **Copy answer**: an entry of the [+] menu itself (the words of the answer, as Markdown).
 *
 * (The charting engine's credit is on the chart itself, and in the menu's About.)
 *
 * All of it works from the keyboard, announces what it did in the status
 * line, and follows the chrome rules in DESIGN.md.
 */
export function mountActions(host: HTMLElement, app: StageApp, transcript: TranscriptView, stage: HTMLElement, slots: ActionSlots): Actions {
  counter += 1;

  const menu = slots.menu;

  const showButton = document.createElement('button');
  showButton.className = 'action action--show';
  showButton.type = 'button';
  showButton.title = 'Show all (or press . while the stage has focus)';
  showButton.textContent = 'Show all';
  showButton.hidden = true;
  slots.top.append(showButton);

  let formats: Formats = NO_FORMATS;
  let formatsKnown = false;
  let answerReady = false;
  let showable = false;
  let revealedFor: string | null = null;

  // On a phone the transcript is a sheet over the stage: it opens only when the viewer opens it.
  const narrow = window.matchMedia('(max-width: 719px)');
  const reveal = (turn: string): void => {
    if (narrow.matches) app.announce('Earlier scenes are in the Transcript');
    else transcript.revealTurn(turn);
  };

  const refresh = (): void => {
    const status = app.status();
    const snap = app.painter.snapshot();
    showable = status.busy;
    answerReady = !status.busy && app.painter.recording() !== null;
    if (showable) {
      showButton.hidden = false;
      showButton.removeAttribute('aria-disabled');
      showButton.classList.remove('action--idle');
    } else if (document.activeElement === showButton) {
      // Hiding the button under the keyboard user would drop focus on the page; it rests until they move on.
      showButton.setAttribute('aria-disabled', 'true');
      showButton.classList.add('action--idle');
    } else {
      showButton.hidden = true;
    }
    if (snap.showingAll && snap.turn !== null && revealedFor !== snap.turn && sceneCount(snap.lines) > 1) {
      revealedFor = snap.turn;
      reveal(snap.turn);
    }
    if (snap.turn === null) revealedFor = null;
    entries.get('midi')?.set({ hidden: !snap.elements.some((element) => element.kind === 'structure' && element.text.startsWith('tune')) });
    for (const [id, entry] of entries) if (NEEDS_ANSWER.has(id)) entry.set({ disabled: !answerReady });
  };

  const showAll = (): void => {
    if (!showable) return;
    app.showAll();
    const snap = app.painter.snapshot();
    if (snap.turn !== null && revealedFor !== snap.turn && sceneCount(snap.lines) > 1) {
      revealedFor = snap.turn;
      reveal(snap.turn);
    }
    refresh();
  };

  showButton.addEventListener('mousedown', (event) => event.preventDefault());
  showButton.addEventListener('click', showAll);

  // WCAG 2.1.4: the key works only while the stage has focus. The button is always there.
  stage.setAttribute('aria-keyshortcuts', '.');
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== '.' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.target !== stage || !showable) return;
    event.preventDefault();
    showAll();
  };
  stage.addEventListener('keydown', onKey);

  // The menu: Save is a list of its own inside the composer's [+] menu; Copy answer sits in the [+] menu itself.

  const ITEMS = [
    { id: 'copy', label: 'Copy script', gist: 'the answer as lines of Series, on the clipboard', needsAnswer: true },
    { id: 'save-script', label: 'Save script', gist: 'the same lines, as a .series file', needsAnswer: true },
    { id: 'play', label: 'Play a script…', gist: 'paste lines of Series and watch them on the stage', needsAnswer: false },
    { id: 'png', label: 'Save picture (PNG)', gist: 'the picture as it rests, as an image', needsAnswer: true },
    { id: 'svg', label: 'Save picture (SVG)', gist: 'the same picture as a drawing that scales', needsAnswer: true },
    { id: 'midi', label: 'Save MIDI', gist: 'the tune, as a standard MIDI file', needsAnswer: true },
    { id: 'film', label: 'Save film…', gist: 'the latest answer playing, taps and all, as a video', needsAnswer: true },
    { id: 'conversation', label: 'Save whole conversation…', gist: 'every turn in order, each after a title card, as one WebM', needsAnswer: true },
  ] as const;
  type ItemId = (typeof ITEMS)[number]['id'] | 'copy-answer';
  const NEEDS_ANSWER = new Set<string>([...ITEMS.filter((item) => item.needsAnswer).map((item) => item.id), 'copy-answer']);
  const entries = new Map<string, MenuEntryHandle>();
  const refused = (): void => app.announce('Save works once an answer has finished');

  // Dialogs

  const makeDialog = (title: string, body: string): HTMLDialogElement => {
    counter += 1;
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.setAttribute('aria-labelledby', `dialog-title-${counter}`);
    dialog.innerHTML = `<form class="dialog__form" method="dialog"><h2 class="dialog__title" id="dialog-title-${counter}">${title}</h2>${body}</form>`;
    document.body.append(dialog);
    // A click on the backdrop lands on the dialog itself.
    dialog.addEventListener('mousedown', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => menu.button.focus({ preventScroll: true }));
    return dialog;
  };

  const playDialog = makeDialog(
    'Play a script',
    `<label class="dialog__label" for="play-text-${counter + 1}">Lines of Series, one per line</label>
     <textarea class="dialog__text" id="play-text-${counter + 1}" rows="10" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
     <p class="dialog__error" role="alert" hidden></p>
     <div class="dialog__buttons"><button type="button" class="dialog__cancel">Cancel</button><button type="submit" class="dialog__go">Play</button></div>`,
  );
  const playText = playDialog.querySelector<HTMLTextAreaElement>('.dialog__text');
  const playError = playDialog.querySelector<HTMLElement>('.dialog__error');
  const playForm = playDialog.querySelector<HTMLFormElement>('form');
  const playGo = playDialog.querySelector<HTMLButtonElement>('.dialog__go');
  const playCancel = playDialog.querySelector<HTMLButtonElement>('.dialog__cancel');
  if (playText === null || playError === null || playForm === null || playGo === null || playCancel === null) throw new Error('The script dialog could not be built.');

  playCancel.addEventListener('click', () => playDialog.close());
  playForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = playText.value.trim();
    if (text === '') {
      playError.textContent = 'Paste some lines first.';
      playError.hidden = false;
      playText.focus();
      return;
    }
    playGo.disabled = true;
    playError.hidden = true;
    app.playScript(text).then(
      () => {
        playGo.disabled = false;
        playDialog.close();
      },
      (cause: unknown) => {
        playGo.disabled = false;
        playError.textContent = `It could not be played: ${cause instanceof Error ? cause.message : String(cause)}`;
        playError.hidden = false;
      },
    );
  });

  const sizeOptions = SIZES.map((size) => `<option value="${size.id}">${size.label}</option>`).join('');
  const makeExportDialog = (title: string, withFormat: boolean, hint = ''): { dialog: HTMLDialogElement; format: HTMLSelectElement | null; size: HTMLSelectElement; fps: HTMLSelectElement; form: HTMLFormElement; cancel: HTMLButtonElement; error: HTMLElement } => {
    const base = counter + 1;
    const dialog = makeDialog(
      title,
      `${withFormat ? `<label class="dialog__label" for="export-format-${base}">Format</label><select class="dialog__select" id="export-format-${base}" data-field="format"></select>` : ''}
       <label class="dialog__label" for="export-size-${base}">Size</label>
       <select class="dialog__select" id="export-size-${base}" data-field="size">${sizeOptions}</select>
       <label class="dialog__label" for="export-fps-${base}">Frames per second</label>
       <select class="dialog__select" id="export-fps-${base}" data-field="fps"><option value="30">30</option><option value="60">60</option></select>
       ${hint === '' ? '' : `<p class="dialog__hint">${hint}</p>`}
       <p class="dialog__error" role="alert" hidden></p>
       <div class="dialog__buttons"><button type="button" class="dialog__cancel">Cancel</button><button type="submit" class="dialog__go">Start</button></div>`,
    );
    const format = dialog.querySelector<HTMLSelectElement>('[data-field="format"]');
    const size = dialog.querySelector<HTMLSelectElement>('[data-field="size"]');
    const fps = dialog.querySelector<HTMLSelectElement>('[data-field="fps"]');
    const form = dialog.querySelector<HTMLFormElement>('form');
    const cancel = dialog.querySelector<HTMLButtonElement>('.dialog__cancel');
    const error = dialog.querySelector<HTMLElement>('.dialog__error');
    if (size === null || fps === null || form === null || cancel === null || error === null) throw new Error('The export dialog could not be built.');
    cancel.addEventListener('click', () => dialog.close());
    return { dialog, format, size, fps, form, cancel, error };
  };

  const film = makeExportDialog('Save film', true, 'The latest answer as it played: what you asked, and the taps and controls that carried it on. A tune is in the film as sound (WebM).');
  const conversation = makeExportDialog('Save whole conversation', false, 'Every turn since this page opened, in order, each after a card with what you asked. It is a WebM with the sound of any tunes, drawn faster than it plays; Cancel stops it. A film is at most 10 minutes: a longer conversation keeps its latest turns.');

  const sizeOf = (select: HTMLSelectElement): { width: number; height: number } => SIZES.find((size) => size.id === select.value) ?? SIZES[0];

  /** Starts the export; a refusal is shown in the dialog that asked, a finished file is saved. */
  const startExport = (request: ExportRequest, error: HTMLElement, dialog: HTMLDialogElement): void => {
    try {
      const job = app.export(request);
      dialog.close();
      job.done.then(
        ({ blob, fileName, hasSound, note }) => {
          saveBlob(blob, fileName);
          app.announce(`Saved ${fileName}${hasSound === true ? ', with its music' : ''}${note === undefined ? '' : `. ${note}`}`);
        },
        () => undefined,
      );
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
      error.hidden = false;
    }
  };

  film.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const format = film.format?.value === 'mp4' ? 'mp4' : 'webm';
    startExport({ kind: 'video', format, ...sizeOf(film.size), fps: Number(film.fps.value), scope: 'answer' }, film.error, film.dialog);
  });
  conversation.form.addEventListener('submit', (event) => {
    event.preventDefault();
    startExport({ kind: 'video', format: 'webm', ...sizeOf(conversation.size), fps: Number(conversation.fps.value), scope: 'conversation' }, conversation.error, conversation.dialog);
  });

  const openExport = (parts: ReturnType<typeof makeExportDialog>): void => {
    const portrait = app.painter.snapshot().viewport.height > app.painter.snapshot().viewport.width;
    parts.size.value = portrait ? 'portrait' : 'landscape';
    parts.error.hidden = true;
    if (parts.format !== null) {
      parts.format.replaceChildren(
        ...formats.video.map((name) => {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name === 'webm' ? 'WebM' : 'MP4';
          return option;
        }),
      );
    }
    parts.dialog.showModal();
  };

  const run = (id: ItemId): void => {
    switch (id) {
      case 'copy-answer':
        void copyAnswer(app);
        break;
      case 'copy':
        void copyScript(app);
        break;
      case 'save-script':
        saveScript(app);
        break;
      case 'play':
        playError.hidden = true;
        playDialog.showModal();
        playText.focus();
        break;
      case 'png':
        saveStill(app, 'png');
        break;
      case 'svg':
        saveStill(app, 'svg');
        break;
      case 'midi':
        saveMidi(app);
        break;
      case 'film':
        openExport(film);
        break;
      case 'conversation':
        openExport(conversation);
        break;
    }
  };

  menu.addView('save', 'Save');
  entries.set('copy-answer', menu.add({ id: 'copy-answer', label: 'Copy answer', gist: 'the words, as Markdown', order: 70, disabled: true, refusal: refused, run: () => run('copy-answer') }));
  entries.set('save', menu.add({ id: 'save', label: 'Save', gist: 'script, picture, film', order: 40, view: 'save' }));
  ITEMS.forEach((item, index) => {
    entries.set(item.id, menu.add({ id: item.id, label: item.label, gist: item.gist, order: index, disabled: item.needsAnswer, refusal: refused, run: () => run(item.id) }, 'save'));
  });

  const applyFormats = (): void => {
    const hide = (id: ItemId, hidden: boolean): void => entries.get(id)?.set({ hidden });
    hide('svg', formatsKnown && !formats.svg);
    hide('film', formatsKnown && formats.video.length === 0);
    hide('conversation', formatsKnown && !formats.video.includes('webm'));
  };
  app.formats().then(
    (found) => {
      formats = found;
      formatsKnown = true;
      applyFormats();
    },
    () => {
      formats = NO_FORMATS;
      formatsKnown = true;
      applyFormats();
    },
  );

  const offStatus = app.onStatus(refresh);
  const offClock = app.painter.on('clock', refresh);
  const timer = setInterval(refresh, 1000);
  refresh();

  return {
    dispose() {
      clearInterval(timer);
      offStatus();
      offClock();
      stage.removeEventListener('keydown', onKey);
      stage.removeAttribute('aria-keyshortcuts');
      playDialog.remove();
      film.dialog.remove();
      conversation.dialog.remove();
      for (const entry of entries.values()) entry.remove();
      showButton.remove();
    },
  };
}
