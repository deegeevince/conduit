// The work mode: a question the person is to work out (an `ask` on the stage) takes the whole screen. The composer steps back to a small "Ask"
// button, the ink layer is laid over the stage and takes the pen, and one "Done" button puts it all away. A finger or a mouse presses what is under the
// layer (Check, a hint, a choice); only the pen writes. What she drew stays put while a hint, a choice of layout or a new step changes the stage under it.

import type { StageInk } from '../ink/stage';
import { exportPng } from '../ink';
import { setPen } from '../painter/controls/pen';
import { tryText } from './document-ink';
import { createProblemView, problemKey } from '../painter/problem/view';
import type { ProblemView } from '../painter/problem/view';
import type { OnStage } from './problem-lines';

export interface WorkModeOptions {
  readonly stage: HTMLElement;
  readonly bar: HTMLElement;
  readonly ink: StageInk;
  /** the controls on the stage now (the stage hook's own list) */
  readonly controls: () => readonly { readonly id: string; readonly ask?: boolean }[];
  /** the question's own words, as the stage says them (for the reader of her handwriting) */
  readonly question: () => string;
  /** keeps the picture of the ink; resolves with its upload id */
  readonly upload: (png: Blob) => Promise<string>;
  /** reads what was written (a small Claude process server side; refused on a server without the Claude brain) */
  readonly read: (request: { readonly image: string; readonly node: string; readonly ask: string; readonly question: string; readonly prompt: string }) => Promise<{ readonly lines: readonly string[] }>;
  /** the painter redraws: Check is ready now that the pen has written (or not) */
  readonly penChanged: () => void;
  /** the maths questions on stage (`problem` lines): each takes the whole screen, drawn by the painter's problem workspace */
  readonly problems: () => readonly OnStage[];
  /** the person's setting asks for no motion */
  readonly calm: () => boolean;
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

  // a short line for her when a reading did not work: it goes by itself
  const note = document.createElement('div');
  note.className = 'work-note';
  note.hidden = true;
  document.body.append(note);
  let noteTimer: number | undefined;
  const say = (words: string): void => {
    note.textContent = words;
    note.hidden = false;
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => (note.hidden = true), 6000);
  };
  // the pen's writing is her answer: Check reads it (`painter/controls/pen.ts`), the typed field stays as the fallback
  // strokes already read are her last try: Check reads again only when she has written more
  let readAt = 0;
  setPen({
    has: () => on && ink.ink.model.strokes.length > (ink.ink.model.strokes.length < readAt ? 0 : readAt),
    read: async () => {
      try {
        const made = await exportPng(ink.ink.model.document(), {});
        if (made === null) return null;
        const count = ink.ink.model.strokes.length;
        const image = await options.upload(made.blob);
        const problem = options.problems()[0];
        const ask = problem?.spec.id ?? options.controls().find((control) => control.ask === true)?.id ?? 'a1';
        const read = await options.read({ image, node: '', ask, question: problem === undefined ? options.question() : problem.spec.question.replace(/_{2,}/g, '(blank)'), prompt: problem === undefined ? '' : 'She writes the number that goes in the blank.' });
        if (read.lines.length === 0) {
          say('I could not read that. Write it bigger, or type it.');
          return null;
        }
        readAt = count;
        options.penChanged();
        return tryText(read.lines, false);
      } catch {
        say('I could not read that. Type your answer instead.');
        return null;
      }
    },
  });
  ink.ink.onChange(() => options.penChanged());

  const signature = (): string =>
    [
      ...options
        .controls()
        .filter((control) => control.ask === true)
        .map((control) => control.id)
        .sort(),
      ...options.problems().slice(0, 1).map((entry) => `problem:${problemKey(entry.spec)}`),
    ].join(',');

  // a maths question takes the screen: its workspace is built once and kept, so what she did to it (tries, a picture open) survives Done and back
  const views = new Map<string, ProblemView>();
  let shown: ProblemView | null = null;
  const sync = (): void => {
    const entry = on ? (options.problems()[0] ?? null) : null;
    if (entry === null) {
      shown?.element.remove();
      shown = null;
      return;
    }
    const key = `${problemKey(entry.spec)}|${entry.said.join('\u0001')}`;
    let view = views.get(key);
    if (view === undefined) {
      view = createProblemView({ spec: entry.spec, said: entry.said, calm: options.calm });
      views.set(key, view);
    }
    if (shown === view) return;
    shown?.element.remove();
    shown = view;
    stage.append(view.element);
    view.relayout();
  };

  function enter(): void {
    on = true;
    body.classList.add('work');
    body.classList.remove('work--ask');
    exit.hidden = false;
    asking.hidden = false;
    asking.textContent = 'Ask';
    ink.show(true);
    sync();
  }
  function leave(dismiss: boolean): void {
    if (dismiss) dismissed = signature();
    on = false;
    body.classList.remove('work', 'work--ask');
    exit.hidden = true;
    asking.hidden = true;
    ink.show(false);
    sync();
  }

  // a finger or a mouse goes through the layer to what is under it; the pen writes
  // a pen that goes down on a button of the workspace presses it (a child holds a pen, not a finger): a stroke that starts on one writes nothing
  const penPress = new Map<number, Element>();
  const pressable = (x: number, y: number): Element | null => {
    const layer = ink.ink.root.closest<HTMLElement>('.ink-stage');
    if (layer === null) return null;
    layer.style.pointerEvents = 'none';
    const under = document.elementFromPoint(x, y)?.closest('.pb button, .pb input, .pb .pb__tok--blank') ?? null;
    layer.style.pointerEvents = '';
    return under;
  };
  const through = (event: PointerEvent): void => {
    if (on && event.pointerType === 'pen' && event.isTrusted && stage.querySelector('.pb') !== null) {
      if (event.type === 'pointerdown' && (event.target as Element | null)?.closest('.ink-bar') === null) {
        const hit = pressable(event.clientX, event.clientY);
        // the blank is the pen's: it writes there; only the buttons are pressed
        if (hit !== null && !hit.classList.contains('pb__tok--blank')) {
          penPress.set(event.pointerId, hit);
          event.stopImmediatePropagation();
          event.preventDefault();
          return;
        }
      }
      const held = penPress.get(event.pointerId);
      if (held !== undefined) {
        event.stopImmediatePropagation();
        event.preventDefault();
        if (event.type === 'pointerup') {
          penPress.delete(event.pointerId);
          if (held instanceof HTMLElement) {
            if (held.tagName === 'INPUT') held.focus();
            else held.click();
          }
        }
        return;
      }
    }
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
    else if (on) sync();
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
      note.remove();
      for (const view of views.values()) view.dispose();
      setPen(null);
    },
  };
}
