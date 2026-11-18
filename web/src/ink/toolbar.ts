// The ink toolbar: pen, highlighter, colours, eraser, undo, redo, clear, and the send button (with an optional words field). Every target is 44 px,
// every control a real button with its state in `aria-pressed`, and the whole bar works from the keyboard.
//
// The stage's bar can be docked two ways (`dock: true`): across the top (a row that wraps), or down the right-hand edge (one column of 44 px buttons, vertically centred, that scrolls inside
// itself when the stage is short). In the column the colours fold into one swatch that opens a small popover, and the words field folds behind a button; Send is an arrow. The choice is kept
// on this device (`conduit.ink.dock`); with none made, a wide landscape screen starts down the side and anything else across the top.

import type { Ink, InkToolName } from './layer';
import { injectInkStyles } from './styles';

export interface InkBarOptions {
  /** the send button's label: "Send", or "Check my working" (default "Send") */
  readonly sendLabel?: string;
  /** a field for words to go with the ink (default true) */
  readonly words?: boolean;
  readonly wordsPlaceholder?: string;
  /** called with the words; resolve when sent, reject with a sentence a person can read. The bar shows the progress. */
  readonly onSend: (words: string) => Promise<void>;
  /** the words the field starts with, and read back when the host is the one holding the field (the prompt bar) */
  readonly readWords?: () => string;
  readonly allowEmptyWords?: boolean;
  /** the finger-draws toggle on touch screens (default true) */
  readonly fingerToggle?: boolean;
  /** the bar can fold down to one small pen button (the stage's bar, which floats over the work); the choice is remembered on this device. Default false. */
  readonly collapsible?: boolean;
  /** the dock toggle (the stage's bar): across the top, or down the right-hand edge. Default false: the bar stays a row. */
  readonly dock?: boolean;
  /** The hand tool (the stage's bar): Draw paused, so that the page under the ink takes the taps; the ink stays, and Send still sends it. Choosing the pen, the highlighter or the eraser again is the way back. */
  readonly hand?: { readonly on: () => boolean; readonly set: (on: boolean) => void };
}

export type InkDock = 'horizontal' | 'vertical';

export interface InkBar {
  readonly element: HTMLElement;
  /** where the bar is docked now ('horizontal' unless it was built with `dock` and the column was chosen or suggested) */
  dock(): InkDock;
  /** shows the state of the tools again (the hand tool was changed from outside) */
  refresh(): void;
  /** says something in the bar's status line */
  say(text: string): void;
  setSending(sending: boolean): void;
  focusWords(): void;
  dispose(): void;
}

const FOLD_KEY = 'conduit.ink.bar';

/** Whether the bar starts folded: what this device chose last, else folded on a phone or any short window, and open on an iPad or a desktop. */
function startsFolded(): boolean {
  try {
    const kept = localStorage.getItem(FOLD_KEY);
    if (kept === 'collapsed') return true;
    if (kept === 'open') return false;
  } catch {
    // a browser that will not remember is not a problem
  }
  // a short window (a phone held sideways) is mostly bar if the bar is open: it waits behind its pen button until it is asked for
  if (window.innerHeight < 520) return true;
  const small = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  return window.matchMedia('(pointer: coarse)').matches ? small < 600 : window.innerWidth < 640;
}

function keepFolded(folded: boolean): void {
  try {
    localStorage.setItem(FOLD_KEY, folded ? 'collapsed' : 'open');
  } catch {
    // as above
  }
}

const DOCK_KEY = 'conduit.ink.dock';

/** what this device chose last, or null when it never has (or will not remember) */
function keptDock(): InkDock | null {
  try {
    const kept = localStorage.getItem(DOCK_KEY);
    if (kept === 'vertical' || kept === 'horizontal') return kept;
  } catch {
    // a browser that will not remember is not a problem
  }
  return null;
}

function keepDock(dock: InkDock): void {
  try {
    localStorage.setItem(DOCK_KEY, dock);
  } catch {
    // as above
  }
}

/** With no choice made: down the side on a landscape screen wider than 900 px that is tall enough for the column (a phone held across is not), across the top otherwise. */
export function suggestedDock(): InkDock {
  return window.innerWidth > 900 && window.innerWidth > window.innerHeight && window.innerHeight >= 600 ? 'vertical' : 'horizontal';
}

const ICON = {
  dockRight: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M15.5 5v14"/><path d="M18 9h.01M18 12h.01M18 15h.01" stroke-width="2.4"/></svg>',
  dockTop: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 7.3h.01M11 7.3h.01M14 7.3h.01" stroke-width="2.4"/></svg>',
  words: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M5 6h14a1 1 0 011 1v8a1 1 0 01-1 1h-8l-4 3.5V16H5a1 1 0 01-1-1V7a1 1 0 011-1z"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  fold: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>',
  pen: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/><path d="M14.5 6.5l3 3"/></svg>',
  highlighter: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 14l6-9 5 4-7 8z"/><path d="M9 14l-3 5h5l2-2"/><path d="M4 21h16" opacity=".5"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M8 20h11"/><path d="M5 15l8-9a2 2 0 013 0l3 3a2 2 0 010 3l-6 6H9z"/><path d="M9 11l6 6"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 7L4 12l5 5"/><path d="M4 12h9a6 6 0 010 12" transform="translate(0 -4)"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M15 7l5 5-5 5"/><path d="M20 12h-9a6 6 0 000 12" transform="translate(0 -4)"/></svg>',
  finger: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 11V5a1.5 1.5 0 013 0v5l4 1a2 2 0 011.5 2.3L16.5 19a2 2 0 01-2 1.5H11a3 3 0 01-2.4-1.2L5.5 15.5a1.5 1.5 0 012.2-2L9 14.5"/></svg>',
  clear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  hand: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M5 4l13 7-6 1.5L9.5 19z"/></svg>',
} as const;

function button(label: string, icon: string, extra = ''): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `ink-btn ${extra}`.trim();
  el.setAttribute('aria-label', label);
  el.title = label;
  el.innerHTML = icon;
  return el;
}

export function mountInkBar(host: HTMLElement, ink: Ink, options: InkBarOptions): InkBar {
  injectInkStyles(host.getRootNode() instanceof ShadowRoot ? (host.getRootNode() as ShadowRoot) : host.ownerDocument);
  const bar = document.createElement('div');
  bar.className = 'ink-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Drawing tools');

  // The popovers of the column (the colours, the words field): one at a time, drawn beside the bar by CSS from `data-pop`, level with the button that opened them.
  let pop: 'colours' | 'words' | null = null;
  function closePop(): void {
    if (pop === null) return;
    pop = null;
    bar.removeAttribute('data-pop');
    currentColour.setAttribute('aria-expanded', 'false');
    wordsButton?.setAttribute('aria-expanded', 'false');
  }
  function openPop(which: 'colours' | 'words', trigger: HTMLElement, lift: number): void {
    closePop();
    pop = which;
    bar.dataset['pop'] = which;
    trigger.setAttribute('aria-expanded', 'true');
    // level with the button, whatever the column has been scrolled to
    const top = trigger.getBoundingClientRect().top - bar.getBoundingClientRect().top - bar.clientTop - lift;
    bar.style.setProperty('--pop-top', `${Math.max(0, Math.round(top))}px`);
  }

  const tools = document.createElement('div');
  tools.className = 'ink-bar__group';
  const toolButtons = new Map<InkToolName, HTMLButtonElement>();
  for (const [name, label] of [['pen', 'Pen'], ['highlighter', 'Highlighter'], ['eraser', 'Eraser']] as const) {
    const b = button(label, ICON[name]);
    b.setAttribute('aria-pressed', String(ink.tool === name));
    b.dataset['tool'] = name;
    b.addEventListener('click', () => {
      // a drawing tool is the way back from the hand
      options.hand?.set(false);
      ink.tool = name;
      sync();
    });
    toolButtons.set(name, b);
    tools.append(b);
  }
  let hand: HTMLButtonElement | null = null;
  if (options.hand !== undefined) {
    const control = options.hand;
    hand = button('Hand: use the page', ICON.hand, 'ink-btn--hand');
    hand.dataset['tool'] = 'hand';
    hand.title = 'Pause drawing: taps, choices and sliders work the page under your drawing, which stays. Tap a pen to draw again.';
    hand.addEventListener('click', () => {
      control.set(!control.on());
      sync();
    });
    tools.prepend(hand);
  }

  const colours = document.createElement('div');
  colours.className = 'ink-bar__group';
  // down the side the colours fold into one swatch (the colour in use) that opens the four as a small popover; across the top the swatches stand in the row as they always did
  const currentColour = document.createElement('button');
  currentColour.type = 'button';
  currentColour.className = 'ink-swatch ink-swatch--current';
  currentColour.setAttribute('aria-label', 'Colours');
  currentColour.title = 'Colours';
  currentColour.setAttribute('aria-haspopup', 'true');
  currentColour.setAttribute('aria-expanded', 'false');
  currentColour.innerHTML = '<span class="ink-swatch__dot"></span>';
  const currentDot = currentColour.firstElementChild as HTMLElement;
  const swatchPop = document.createElement('div');
  swatchPop.className = 'ink-bar__swatches';
  colours.append(currentColour, swatchPop);
  const swatches: HTMLButtonElement[] = [];
  for (const colour of ink.colors) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'ink-swatch';
    s.dataset['color'] = colour;
    s.setAttribute('aria-label', `Colour ${colour}`);
    s.title = `Colour ${colour}`;
    s.innerHTML = `<span class="ink-swatch__dot" style="background:${colour}"></span>`;
    s.addEventListener('click', () => {
      ink.color = colour;
      if (ink.tool === 'eraser') ink.tool = 'pen';
      closePop();
      sync();
    });
    swatches.push(s);
    swatchPop.append(s);
  }

  const history = document.createElement('div');
  history.className = 'ink-bar__group';
  const undo = button('Undo', ICON.undo);
  const redo = button('Redo', ICON.redo);
  const clear = button('Clear everything', ICON.clear);
  undo.addEventListener('click', () => ink.undo());
  redo.addEventListener('click', () => ink.redo());
  clear.addEventListener('click', () => ink.clear());
  history.append(undo, redo, clear);

  // On a touch screen: whether a finger draws or scrolls. With a pen about it scrolls; this is the way to say otherwise (a phone, a finger-only drawing).
  let finger: HTMLButtonElement | null = null;
  if (navigator.maxTouchPoints > 0 && options.fingerToggle !== false) {
    finger = button('Finger draws', ICON.finger, 'ink-btn--finger');
    finger.addEventListener('click', () => {
      ink.setFingerDraws(!ink.fingerDraws());
      sync();
    });
    history.append(finger);
  }

  const send = document.createElement('div');
  send.className = 'ink-bar__group ink-bar__send';
  let words: HTMLInputElement | null = null;
  let wordsButton: HTMLButtonElement | null = null;
  if (options.words !== false) {
    words = document.createElement('input');
    words.type = 'text';
    words.className = 'ink-bar__words';
    words.placeholder = options.wordsPlaceholder ?? 'Add words (optional)';
    words.setAttribute('aria-label', 'Words to send with the drawing');
    words.enterKeyHint = 'send';
    words.autocapitalize = 'sentences';
    send.append(words);
    // down the side the field folds behind this button (a dot on it says there are words waiting)
    wordsButton = button('Add words', ICON.words, 'ink-btn--words');
    wordsButton.setAttribute('aria-haspopup', 'true');
    wordsButton.setAttribute('aria-expanded', 'false');
    send.prepend(wordsButton);
    const field = words;
    field.addEventListener('input', () => wordsButton?.setAttribute('data-filled', String(field.value.trim() !== '')));
  }
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'ink-btn ink-btn--send';
  // across the top the button says its label; down the side it is an arrow (the label stays for a screen reader and for anything that reads the button's text)
  const sendLabel = options.sendLabel ?? 'Send';
  go.setAttribute('aria-label', sendLabel);
  go.innerHTML = `<span class="ink-btn__label"></span><span class="ink-btn__icon" aria-hidden="true">${ICON.send}</span>`;
  (go.firstElementChild as HTMLElement).textContent = sendLabel;
  send.append(go);

  const status = document.createElement('p');
  status.className = 'ink-bar__status';
  status.setAttribute('role', 'status');
  // The dock (the stage's bar): across the top, or down the right-hand edge. What this device chose wins; with no choice the screen suggests one, and follows it when the screen turns.
  let chosen: InkDock | null = options.dock === true ? keptDock() : null;
  let docked: InkDock = 'horizontal';
  let dockButton: HTMLButtonElement | null = null;
  const applyDock = (next: InkDock): void => {
    docked = next;
    bar.classList.toggle('ink-bar--vertical', next === 'vertical');
    bar.dataset['dock'] = next;
    if (dockButton !== null) {
      const to = next === 'vertical' ? 'across the top' : 'down the right-hand side';
      dockButton.innerHTML = next === 'vertical' ? ICON.dockTop : ICON.dockRight;
      dockButton.setAttribute('aria-label', `Dock the tools ${to}`);
      dockButton.title = `Dock the tools ${to}`;
    }
    closePop();
  };
  let lastWidth = window.innerWidth;
  const onResize = (): void => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    if (chosen === null) applyDock(suggestedDock());
  };
  if (options.dock === true) {
    dockButton = button('', ICON.dockRight, 'ink-btn--dock');
    applyDock(chosen ?? suggestedDock());
    dockButton.addEventListener('click', () => {
      chosen = docked === 'vertical' ? 'horizontal' : 'vertical';
      keepDock(chosen);
      applyDock(chosen);
    });
    window.addEventListener('resize', onResize);
  }
  currentColour.addEventListener('click', () => (pop === 'colours' ? closePop() : openPop('colours', currentColour, 6)));
  wordsButton?.addEventListener('click', () => {
    if (pop === 'words') return closePop();
    openPop('words', wordsButton as HTMLElement, 0);
    words?.focus();
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || pop === null) return;
    e.preventDefault();
    e.stopPropagation();
    const from = pop === 'words' ? wordsButton : currentColour;
    closePop();
    from?.focus({ preventScroll: true });
  });
  const outside = (e: Event): void => {
    if (pop !== null && !e.composedPath().includes(bar)) closePop();
  };
  host.ownerDocument.addEventListener('pointerdown', outside, true);

  // Everything but the pen pill and the status line stands in one scroller: across the top it is `display: contents` (the bar's own row), down the side it is the column, and it scrolls
  // inside itself when the stage is shorter than the column.
  const scroller = document.createElement('div');
  scroller.className = 'ink-bar__scroll';
  const head = document.createElement('div');
  head.className = 'ink-bar__group ink-bar__fold';
  // Folding: one small pen pill that never covers more than itself, and a fold button at the head of the open bar. The layer still draws either way.
  if (options.collapsible === true) {
    const pill = button('Show drawing tools', ICON.pen, 'ink-btn--pill');
    const fold = button('Hide drawing tools', ICON.fold, 'ink-btn--fold');
    pill.setAttribute('aria-expanded', 'false');
    fold.setAttribute('aria-expanded', 'true');
    head.append(fold);
    if (dockButton !== null) head.append(dockButton);
    const apply = (folded: boolean): void => {
      bar.classList.toggle('ink-bar--collapsed', folded);
      pill.hidden = !folded;
      head.hidden = folded;
      if (folded) {
        status.textContent = '';
        closePop();
      }
    };
    pill.addEventListener('click', () => {
      keepFolded(false);
      apply(false);
      fold.focus({ preventScroll: true });
    });
    fold.addEventListener('click', () => {
      keepFolded(true);
      apply(true);
      pill.focus({ preventScroll: true });
    });
    scroller.append(head, tools, colours, history, send);
    bar.append(pill, scroller, status);
    apply(startsFolded());
  } else {
    if (dockButton !== null) {
      head.append(dockButton);
      scroller.append(head);
    }
    scroller.append(tools, colours, history, send);
    bar.append(scroller, status);
  }
  host.append(bar);

  let sending = false;
  function sync(): void {
    const paused = options.hand?.on() === true;
    for (const [name, b] of toolButtons) b.setAttribute('aria-pressed', String(!paused && ink.tool === name));
    hand?.setAttribute('aria-pressed', String(paused));
    currentDot.style.background = ink.color;
    for (const s of swatches) s.setAttribute('aria-pressed', String(!paused && ink.tool !== 'eraser' && ink.color === s.dataset['color']));
    undo.disabled = !ink.model.canUndo;
    redo.disabled = !ink.model.canRedo;
    clear.disabled = ink.model.strokes.length === 0;
    if (finger !== null) {
      finger.setAttribute('aria-pressed', String(ink.fingerDraws()));
      finger.title = ink.fingerDraws() ? 'A finger draws. Tap to let a finger scroll instead.' : 'A finger scrolls. Tap to let a finger draw.';
      finger.setAttribute('aria-label', 'Finger draws');
    }
    go.disabled = sending || ink.model.strokes.length === 0;
  }
  const off = ink.onChange(sync);
  sync();

  const doSend = async (): Promise<void> => {
    if (sending || ink.model.strokes.length === 0) return;
    closePop();
    sending = true;
    sync();
    status.textContent = 'Sending…';
    try {
      await options.onSend((options.readWords?.() ?? words?.value ?? '').trim());
      if (words !== null) words.value = '';
      wordsButton?.setAttribute('data-filled', 'false');
      status.textContent = '';
    } catch (cause) {
      status.textContent = cause instanceof Error ? cause.message : 'That could not be sent. Your drawing is still here.';
    } finally {
      sending = false;
      sync();
    }
  };
  go.addEventListener('click', () => void doSend());
  words?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void doSend();
    }
  });

  return {
    element: bar,
    dock: () => docked,
    refresh: sync,
    say(text) {
      status.textContent = text;
    },
    setSending(next) {
      sending = next;
      sync();
    },
    focusWords: () => words?.focus(),
    dispose() {
      off();
      window.removeEventListener('resize', onResize);
      host.ownerDocument.removeEventListener('pointerdown', outside, true);
      bar.remove();
    },
  };
}
