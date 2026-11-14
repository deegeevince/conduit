// The ink toolbar: pen, highlighter, colours, eraser, undo, redo, clear, and the send button (with an optional words field). Every target is 44 px,
// every control a real button with its state in `aria-pressed`, and the whole bar works from the keyboard.

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
}

export interface InkBar {
  readonly element: HTMLElement;
  /** says something in the bar's status line */
  say(text: string): void;
  setSending(sending: boolean): void;
  focusWords(): void;
  dispose(): void;
}

const ICON = {
  pen: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/><path d="M14.5 6.5l3 3"/></svg>',
  highlighter: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 14l6-9 5 4-7 8z"/><path d="M9 14l-3 5h5l2-2"/><path d="M4 21h16" opacity=".5"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M8 20h11"/><path d="M5 15l8-9a2 2 0 013 0l3 3a2 2 0 010 3l-6 6H9z"/><path d="M9 11l6 6"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 7L4 12l5 5"/><path d="M4 12h9a6 6 0 010 12" transform="translate(0 -4)"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M15 7l5 5-5 5"/><path d="M20 12h-9a6 6 0 000 12" transform="translate(0 -4)"/></svg>',
  clear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
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

  const tools = document.createElement('div');
  tools.className = 'ink-bar__group';
  const toolButtons = new Map<InkToolName, HTMLButtonElement>();
  for (const [name, label] of [['pen', 'Pen'], ['highlighter', 'Highlighter'], ['eraser', 'Eraser']] as const) {
    const b = button(label, ICON[name]);
    b.setAttribute('aria-pressed', String(ink.tool === name));
    b.dataset['tool'] = name;
    b.addEventListener('click', () => {
      ink.tool = name;
      sync();
    });
    toolButtons.set(name, b);
    tools.append(b);
  }

  const colours = document.createElement('div');
  colours.className = 'ink-bar__group';
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
      sync();
    });
    swatches.push(s);
    colours.append(s);
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

  const send = document.createElement('div');
  send.className = 'ink-bar__group';
  send.style.flex = '1 1 auto';
  let words: HTMLInputElement | null = null;
  if (options.words !== false) {
    words = document.createElement('input');
    words.type = 'text';
    words.className = 'ink-bar__words';
    words.placeholder = options.wordsPlaceholder ?? 'Add words (optional)';
    words.setAttribute('aria-label', 'Words to send with the drawing');
    words.enterKeyHint = 'send';
    words.autocapitalize = 'sentences';
    send.append(words);
  }
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'ink-btn ink-btn--send';
  go.textContent = options.sendLabel ?? 'Send';
  send.append(go);

  const status = document.createElement('p');
  status.className = 'ink-bar__status';
  status.setAttribute('role', 'status');
  bar.append(tools, colours, history, send, status);
  host.append(bar);

  let sending = false;
  function sync(): void {
    for (const [name, b] of toolButtons) b.setAttribute('aria-pressed', String(ink.tool === name));
    for (const s of swatches) s.setAttribute('aria-pressed', String(ink.tool !== 'eraser' && ink.color === s.dataset['color']));
    undo.disabled = !ink.model.canUndo;
    redo.disabled = !ink.model.canRedo;
    clear.disabled = ink.model.strokes.length === 0;
    go.disabled = sending || ink.model.strokes.length === 0;
  }
  const off = ink.onChange(sync);
  sync();

  const doSend = async (): Promise<void> => {
    if (sending || ink.model.strokes.length === 0) return;
    sending = true;
    sync();
    status.textContent = 'Sending…';
    try {
      await options.onSend((options.readWords?.() ?? words?.value ?? '').trim());
      if (words !== null) words.value = '';
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
      bar.remove();
    },
  };
}
