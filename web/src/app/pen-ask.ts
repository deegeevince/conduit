// The pen on a canvas ask: what the person writes on the stage with the pen is her answer to an `ask`. Check reads the handwriting (`painter/controls/pen.ts`)
// into the blank, and marks it as if she had typed it. Nothing here takes the screen: a question is drawn on the canvas like everything else, and a short
// tap with a pen or a finger on an open ask's blank, Check or Hint goes to the stage under the Draw layer.

import type { StageInk } from '../ink/stage';
import { exportPng } from '../ink';
import { setPen } from '../painter/controls/pen';
import { tryText } from './document-ink';

export interface PenAskOptions {
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
  /** whether a screen point is on a part of an open ask (its blank, Check, Hint, a choice) */
  readonly askAt: (clientX: number, clientY: number) => boolean;
}

export interface PenAsk {
  dispose(): void;
}

export function mountPenAsk(options: PenAskOptions): PenAsk {
  const { ink } = options;
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
    has: () => ink.ink.model.strokes.length > (ink.ink.model.strokes.length < readAt ? 0 : readAt),
    read: async () => {
      try {
        const made = await exportPng(ink.ink.model.document(), {});
        if (made === null) return null;
        const count = ink.ink.model.strokes.length;
        const image = await options.upload(made.blob);
        const ask = options.controls().find((control) => control.ask === true)?.id ?? 'a1';
        const read = await options.read({ image, node: '', ask, question: options.question(), prompt: '' });
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

  // The Draw layer is over an ordinary stage: a short tap, by a finger or by the pen, on an open ask's blank, Check or Hint is that ask's (it goes to the
  // stage under the layer, down and up at the same place, as the work mode hands on a finger). A pen that travels is still writing, and a finger that travels is
  // still the layer's. The stroke the tap began is thrown away; the press is made inside the tap's own handler, so the keyboard comes up for the blank.
  const TAP_TRAVEL = 8;
  const TAP_MS = 800;
  const taps = new Map<number, { readonly x: number; readonly y: number; readonly at: number; travel: number }>();
  const askTap = (event: PointerEvent): void => {
    if (!event.isTrusted || event.pointerType === 'mouse' || !ink.isOpen()) return;
    if (event.type === 'pointerdown') {
      if ((event.target as Element | null)?.closest('.ink-bar') !== null || event.button !== 0) return;
      if (options.askAt(event.clientX, event.clientY)) taps.set(event.pointerId, { x: event.clientX, y: event.clientY, at: event.timeStamp, travel: 0 });
      return;
    }
    const down = taps.get(event.pointerId);
    if (down === undefined) return;
    if (event.type === 'pointermove') {
      down.travel = Math.max(down.travel, Math.hypot(event.clientX - down.x, event.clientY - down.y));
      return;
    }
    taps.delete(event.pointerId);
    if (event.type !== 'pointerup' || Math.max(down.travel, Math.hypot(event.clientX - down.x, event.clientY - down.y)) > TAP_TRAVEL || event.timeStamp - down.at > TAP_MS) return;
    ink.abort(event.pointerId);
    const layer = ink.ink.root.closest<HTMLElement>('.ink-stage');
    if (layer === null) return;
    layer.style.pointerEvents = 'none';
    const under = document.elementFromPoint(event.clientX, event.clientY);
    layer.style.pointerEvents = '';
    if (under === null) return;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: true, button: 0, buttons: 1 };
    under.dispatchEvent(new PointerEvent('pointerdown', init));
    under.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  };
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel']) ink.ink.root.addEventListener(type, askTap as EventListener, true);

  return {
    dispose() {
      note.remove();
      setPen(null);
    },
  };
}
