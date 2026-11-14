// The stage's own controls beyond the prompt: "Show all" for the viewer's
// time, and what can be taken away from an answer.

import type { ExportRequest } from '../contracts/export';
import type { StageApp } from '../app/stage-app';

export interface Actions {
  dispose(): void;
}

/** What the actions need of the transcript: to open at the turn the viewer skipped through. */
export interface TranscriptView {
  revealTurn(turn: string): void;
}

type Formats = Awaited<ReturnType<StageApp['formats']>>;

const NO_FORMATS: Formats = { video: [], frames: false, svg: false };

const SIZES = [
  { id: 'landscape', label: '1920 by 1080, landscape', width: 1920, height: 1080 },
  { id: 'portrait', label: '1080 by 1920, portrait', width: 1080, height: 1920 },
  { id: 'square', label: '1080 by 1080, square', width: 1080, height: 1080 },
] as const;

let counter = 0;

function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

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
 * - **Take away**: a menu button with: Copy script, Save script, Play a
 *   script (a textarea in a dialog; sends input kind `script`), Save picture
 *   (PNG, SVG), Save film (the formats `Exporter.formats()` offers, at
 *   1920x1080 or 1080x1920 or 1080x1080, 30 or 60 fps) with a progress bar
 *   and Cancel, Save frames. Enabled once a turn has ended.
 *
 * All of it works from the keyboard, announces what it did in the status
 * line, and follows the chrome rules in DESIGN.md.
 */
export function mountActions(host: HTMLElement, app: StageApp, transcript: TranscriptView, stage: HTMLElement): Actions {
  counter += 1;
  const menuId = `take-menu-${counter}`;

  const group = document.createElement('div');
  group.className = 'actions';
  group.innerHTML = `
    <button class="action action--show" type="button" title="Show all (or press . while the stage has focus)" hidden>Show all</button>
    <button class="action action--review" type="button" aria-pressed="true" title="After the first draft, the drawing is checked and fixed" hidden>Check the drawing: on</button>
    <div class="action-menu">
      <button class="action action--take" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">Take away</button>
      <div class="action-menu__list" id="${menuId}" role="menu" aria-label="Take away" hidden></div>
    </div>`;
  host.prepend(group);

  const showButton = group.querySelector<HTMLButtonElement>('.action--show');
  const takeButton = group.querySelector<HTMLButtonElement>('.action--take');
  const menu = group.querySelector<HTMLElement>('.action-menu__list');
  const reviewButton = group.querySelector<HTMLButtonElement>('.action--review');
  if (showButton === null || takeButton === null || menu === null || reviewButton === null) throw new Error('The actions could not be built.');

  // Look and fix: offered only when the server can do it; the choice is remembered for the browser.
  const showReview = (): void => {
    reviewButton.hidden = !app.review.available;
    reviewButton.setAttribute('aria-pressed', String(app.review.on));
    reviewButton.textContent = `Check the drawing: ${app.review.on ? 'on' : 'off'}`;
  };
  reviewButton.addEventListener('click', () => {
    app.review.set(!app.review.on);
    showReview();
  });

  // The charting engine's licence asks for its name and a link on the page.
  let credit: HTMLAnchorElement | null = null;
  if (app.attribution !== null) {
    credit = document.createElement('a');
    credit.className = 'action-credit';
    credit.href = app.attribution.href;
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    credit.textContent = app.attribution.text;
    credit.title = app.attribution.text;
    group.append(credit);
  }

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
    showReview();
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
    for (const item of menu.querySelectorAll<HTMLButtonElement>('[data-needs-answer]')) {
      item.setAttribute('aria-disabled', String(!answerReady));
    }
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

  // The menu

  const ITEMS = [
    { id: 'copy', label: 'Copy script', needsAnswer: true },
    { id: 'save-script', label: 'Save script', needsAnswer: true },
    { id: 'play', label: 'Play a script…', needsAnswer: false },
    { id: 'png', label: 'Save picture (PNG)', needsAnswer: true },
    { id: 'svg', label: 'Save picture (SVG)', needsAnswer: true },
    { id: 'film', label: 'Save film…', needsAnswer: true },
    { id: 'frames', label: 'Save frames…', needsAnswer: true },
  ] as const;
  type ItemId = (typeof ITEMS)[number]['id'];

  for (const item of ITEMS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-menu__item';
    button.setAttribute('role', 'menuitem');
    button.dataset['item'] = item.id;
    if (item.needsAnswer) button.dataset['needsAnswer'] = '';
    button.tabIndex = -1;
    button.textContent = item.label;
    menu.append(button);
  }

  const items = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('.action-menu__item')].filter((item) => !item.hidden);

  const applyFormats = (): void => {
    const hide = (id: ItemId, hidden: boolean): void => {
      const item = menu.querySelector<HTMLButtonElement>(`[data-item="${id}"]`);
      if (item !== null) item.hidden = hidden;
    };
    hide('svg', formatsKnown && !formats.svg);
    hide('film', formatsKnown && formats.video.length === 0);
    hide('frames', formatsKnown && !formats.frames);
  };

  let menuOpen = false;
  const setMenu = (open: boolean, focusFirst = false): void => {
    menuOpen = open;
    menu.hidden = !open;
    takeButton.setAttribute('aria-expanded', String(open));
    if (!open) return;
    refresh();
    applyFormats();
    if (!formatsKnown) {
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
    }
    if (focusFirst) items()[0]?.focus();
  };

  takeButton.addEventListener('click', () => setMenu(!menuOpen, true));
  takeButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setMenu(true);
      const list = items();
      (event.key === 'ArrowUp' ? list[list.length - 1] : list[0])?.focus();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        list[(index + 1) % list.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        list[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        list[list.length - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        setMenu(false);
        takeButton.focus();
        break;
      case 'Tab':
        setMenu(false);
        break;
    }
  });
  const onDocumentPointer = (event: PointerEvent): void => {
    if (menuOpen && event.target instanceof Node && !group.contains(event.target)) setMenu(false);
  };
  document.addEventListener('pointerdown', onDocumentPointer);

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
    dialog.addEventListener('close', () => takeButton.focus({ preventScroll: true }));
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
  const makeExportDialog = (title: string, withFormat: boolean): { dialog: HTMLDialogElement; format: HTMLSelectElement | null; size: HTMLSelectElement; fps: HTMLSelectElement; form: HTMLFormElement; cancel: HTMLButtonElement; error: HTMLElement } => {
    const base = counter + 1;
    const dialog = makeDialog(
      title,
      `${withFormat ? `<label class="dialog__label" for="export-format-${base}">Format</label><select class="dialog__select" id="export-format-${base}" data-field="format"></select>` : ''}
       <label class="dialog__label" for="export-size-${base}">Size</label>
       <select class="dialog__select" id="export-size-${base}" data-field="size">${sizeOptions}</select>
       <label class="dialog__label" for="export-fps-${base}">Frames per second</label>
       <select class="dialog__select" id="export-fps-${base}" data-field="fps"><option value="30">30</option><option value="60">60</option></select>
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

  const film = makeExportDialog('Save film', true);
  const frames = makeExportDialog('Save frames', false);

  const sizeOf = (select: HTMLSelectElement): { width: number; height: number } => SIZES.find((size) => size.id === select.value) ?? SIZES[0];

  const runExport = (request: ExportRequest, error: HTMLElement, dialog: HTMLDialogElement): void => {
    try {
      const job = app.export(request);
      dialog.close();
      job.done.then(
        ({ blob, fileName }) => {
          saveBlob(blob, fileName);
          app.announce(`Saved ${fileName}`);
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
    runExport({ kind: 'video', format, ...sizeOf(film.size), fps: Number(film.fps.value) }, film.error, film.dialog);
  });
  frames.form.addEventListener('submit', (event) => {
    event.preventDefault();
    runExport({ kind: 'frames', ...sizeOf(frames.size), fps: Number(frames.fps.value) }, frames.error, frames.dialog);
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

  const stillSize = (): { width: number; height: number } => {
    const viewport = app.painter.snapshot().viewport;
    const scale = 1920 / Math.max(viewport.width, viewport.height);
    return { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  };

  const saveStill = (format: 'png' | 'svg'): void => {
    try {
      // Infinity: the film clamps it to the moment everything has come to rest.
      const job = app.export({ kind: 'still', format, ...stillSize(), at: Number.POSITIVE_INFINITY });
      job.done.then(
        ({ blob, fileName }) => {
          saveBlob(blob, fileName);
          app.announce(`Saved ${fileName}`);
        },
        () => undefined,
      );
    } catch (cause) {
      app.announce(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const copyScript = async (): Promise<void> => {
    const text = app.script();
    try {
      await navigator.clipboard.writeText(text);
      app.announce('Script copied');
    } catch {
      app.announce('The script could not be copied. Use Save script instead.');
    }
  };

  menu.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLButtonElement>('.action-menu__item');
    if (item === null) return;
    if (item.getAttribute('aria-disabled') === 'true') {
      app.announce('Take away works once an answer has finished');
      return;
    }
    const id = item.dataset['item'] as ItemId | undefined;
    setMenu(false);
    takeButton.focus({ preventScroll: true });
    switch (id) {
      case 'copy':
        void copyScript();
        break;
      case 'save-script':
        saveBlob(new Blob([`${app.script()}\n`], { type: 'text/plain' }), `conduit-${stamp()}.series`);
        app.announce('Saved the script');
        break;
      case 'play':
        playError.hidden = true;
        playDialog.showModal();
        playText.focus();
        break;
      case 'png':
        saveStill('png');
        break;
      case 'svg':
        saveStill('svg');
        break;
      case 'film':
        openExport(film);
        break;
      case 'frames':
        openExport(frames);
        break;
      case undefined:
        break;
    }
  });

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
      document.removeEventListener('pointerdown', onDocumentPointer);
      playDialog.remove();
      film.dialog.remove();
      frames.dialog.remove();
      credit?.remove();
      group.remove();
    },
  };
}
