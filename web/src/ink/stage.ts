// The stage's Draw toggle: an entry in the composer's [+] menu that lays the ink layer over the stage. What is drawn goes up with the next prompt (the prompt bar's
// Send, or the ink bar's own), cropped to the inked part, over a picture of the stage as it was, with the turn it was drawn on named.

import type { InkMarks, InkRegionDef } from '@conduit/language';
import type { InkBackdrop } from './export';
import { createInk } from './layer';
import type { Ink } from './layer';
import type { ComposerMenu } from '../chrome/menu';
import { PalmGuard } from './palm';
import { prepareMarks } from './send';
import { injectInkStyles } from './styles';
import { mountInkBar } from './toolbar';
import type { InkBar } from './toolbar';

/** What the stage ink needs of the app. */
export interface StageInkApp {
  /** keeps the picture of the ink; resolves with its id */
  upload(png: Blob): Promise<string>;
  /** the id of the turn on stage, or the last that ended; null before the first */
  lastTurn(): string | null;
  /** a picture of the stage as it is, as a data URL; null when there is none */
  capture(maxSide: number): Promise<string | null>;
  /** starts a turn with these words and marks */
  prompt(words: string, marks: InkMarks): Promise<unknown>;
  announce(text: string): void;
  /** the blanks of the asks still open on the stage, each as an answer box named by its ask: the marks then say which blank the writing covers */
  answerBoxes?(): readonly InkRegionDef[];
}

export interface StageInk {
  /** whether there is ink waiting to go up with the next prompt */
  pending(): boolean;
  /** the marks to send with the next prompt: the picture is uploaded now. Null when there is no ink. */
  take(): Promise<InkMarks | null>;
  /** the ink went up: forget it and put the layer away */
  sent(): void;
  readonly ink: Ink;
  /** the layer is over the stage (the Draw toggle, or the work mode) and takes every pointer */
  isOpen(): boolean;
  /** lays the layer over the stage, or puts it away; what is drawn is kept */
  show(open: boolean): void;
  /**
   * PLAN-canvas, behind `?lens=1`. On: the layer stays over the stage but lets every pointer through, so a pen on a device that has shown one can
   * draw without Draw being switched on (the lens hands it the pen's first touch with `penDown`), and what is drawn waits for the next message with
   * the same toolbar, which shows once there is a stroke to send. Off: the layer is shown only when Draw is on, as it always was.
   */
  through(on: boolean): void;
  /** The pen went down on the stage, outside the layer: the layer begins its stroke. Only while `through` is on and Draw is not. */
  penDown(event: PointerEvent): void;
  /** Throws away the stroke a pointer has begun. */
  abort(pointerId: number): void;
  /** Which strokes are written in a written method's cells (`app/pen-write.ts`): they are not a drawing waiting to be sent, so the bar does not show for them alone. */
  setOwned(owned: (strokeId: string) => boolean): void;
  /** The lens the stage is looked through: strokes stay in page units. Null: none. */
  setView(view: { readonly x: number; readonly y: number; readonly scale: number } | null): void;
  dispose(): void;
}

export const DRAW_WORDS = 'Please look at what I drew.';

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export interface StageInkOptions {
  /** the palm guard the lens shares, so a pen seen by one is seen by both */
  readonly guard?: PalmGuard;
}

export function mountStageInk(stage: HTMLElement, menu: ComposerMenu, app: StageInkApp, options: StageInkOptions = {}): StageInk {
  injectInkStyles(document);
  const toggle = menu.add({ id: 'draw', label: 'Draw', gist: 'on the stage; it goes up with your next message', order: 30, check: true, checked: false, run: () => set(!explicit) });

  const layer = document.createElement('div');
  layer.className = 'ink-stage';
  layer.hidden = true;
  if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
  stage.append(layer);

  let backdrop: InkBackdrop | null = null;
  /** Draw (or the work mode) has the layer open and taking every pointer */
  let explicit = false;
  /** the lens's pen-through mode (see `through`) */
  let throughOn = false;
  /** the strokes that belong to a cell of a written method */
  let owned: (strokeId: string) => boolean = () => false;
  const ink = createInk(layer, {
    ...(options.guard === undefined ? {} : { guard: options.guard }),
    space: { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) },
    on: { element: 'stage', label: 'the stage, as the user saw it' },
    backdrop: async () => backdrop,
    announce: app.announce,
  });

  const freeStrokes = (): number => ink.model.strokes.filter((stroke) => !owned(stroke.id)).length;
  const take = async (): Promise<InkMarks | null> => {
    if (freeStrokes() === 0) return null;
    const turn = app.lastTurn();
    ink.setOn({ element: 'stage', ...(turn === null ? {} : { node: turn }), label: 'the stage, as the user saw it' });
    // the blanks of the open asks are the boxes the writing is reported against, only for this one turn
    const boxes = app.answerBoxes?.() ?? [];
    if (boxes.length === 0) return prepareMarks(ink, app.upload);
    ink.setRegions(boxes);
    try {
      return await prepareMarks(ink, app.upload);
    } finally {
      ink.setRegions([]);
    }
  };
  const captureBackdrop = (): void => {
    void app.capture(1280).then(async (url) => {
      const image = url === null ? null : await loadImage(url);
      backdrop = image === null ? null : { kind: 'image', image };
    });
  };
  /** the layer is shown when Draw has it, or when the lens lets the pen through it; the bar shows with Draw, or once a pen stroke waits */
  const refresh = (): void => {
    layer.hidden = !(explicit || throughOn);
    layer.classList.toggle('ink-stage--through', throughOn && !explicit);
    if (throughOn) bar.element.hidden = !explicit && !ink.model.strokes.some((stroke) => !owned(stroke.id));
  };
  const set = (open: boolean): void => {
    explicit = open;
    refresh();
    toggle.set({ checked: open });
    if (!open) return;
    // the ink's space is the stage as it is now, unless there is ink already (then it keeps its own)
    if (ink.model.strokes.length === 0) ink.setBackground(null, { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
    ink.refresh();
    ink.root.focus({ preventScroll: true });
    captureBackdrop();
  };
  const sent = (): void => {
    ink.reset();
    set(false);
  };

  const bar: InkBar = mountInkBar(layer, ink, {
    sendLabel: 'Send drawing',
    collapsible: true,
    wordsPlaceholder: 'Say what you mean (optional)',
    onSend: async (words) => {
      const marks = await take();
      if (marks === null) return;
      await app.prompt(words === '' ? DRAW_WORDS : words, marks);
      sent();
    },
  });
  bar.element.classList.add('ink-stage__bar');

  const tell = (): void => {
    if (throughOn) refresh();
    const n = freeStrokes();
    menu.badge(n === 0 ? null : String(n));
    toggle.set({ label: n === 0 ? 'Draw' : `Draw (${n} stroke${n === 1 ? '' : 's'} waiting)` });
  };
  ink.onChange(tell);

  return {
    pending: () => freeStrokes() > 0,
    take,
    sent,
    ink,
    isOpen: () => explicit,
    show: set,
    through(on) {
      if (on === throughOn) return;
      throughOn = on;
      refresh();
      if (!on) bar.element.hidden = false;
    },
    penDown(event) {
      if (!throughOn || explicit) return;
      if (ink.model.strokes.length === 0) {
        // the stage as it is now is what the drawing is on: its space is the page, and its picture is taken now
        ink.setBackground(null, { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
        ink.refresh();
        captureBackdrop();
      }
      ink.pointerDown(event);
    },
    abort: (pointerId) => ink.abort(pointerId),
    setOwned(next) {
      owned = next;
      tell();
    },
    setView: (view) => ink.setView(view),
    dispose() {
      bar.dispose();
      ink.dispose();
      layer.remove();
      toggle.remove();
    },
  };
}
