// The stage's Draw toggle: an entry in the composer's [+] menu that lays the ink layer over the stage. What is drawn goes up with the next prompt (the prompt bar's
// Send, or the ink bar's own), cropped to the inked part, over a picture of the stage as it was, with the turn it was drawn on named.

import type { InkMarks } from '@conduit/language';
import type { InkBackdrop } from './export';
import { createInk } from './layer';
import type { Ink } from './layer';
import type { ComposerMenu } from '../chrome/menu';
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
}

export interface StageInk {
  /** whether there is ink waiting to go up with the next prompt */
  pending(): boolean;
  /** the marks to send with the next prompt: the picture is uploaded now. Null when there is no ink. */
  take(): Promise<InkMarks | null>;
  /** the ink went up: forget it and put the layer away */
  sent(): void;
  readonly ink: Ink;
  /** the layer is over the stage (the Draw toggle, or the work mode) */
  isOpen(): boolean;
  /** lays the layer over the stage, or puts it away; what is drawn is kept */
  show(open: boolean): void;
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

export function mountStageInk(stage: HTMLElement, menu: ComposerMenu, app: StageInkApp): StageInk {
  injectInkStyles(document);
  const toggle = menu.add({ id: 'draw', label: 'Draw', gist: 'on the stage; it goes up with your next message', order: 30, check: true, checked: false, run: () => set(layer.hidden !== false) });

  const layer = document.createElement('div');
  layer.className = 'ink-stage';
  layer.hidden = true;
  if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
  stage.append(layer);

  let backdrop: InkBackdrop | null = null;
  const ink = createInk(layer, {
    space: { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) },
    on: { element: 'stage', label: 'the stage, as the user saw it' },
    backdrop: async () => backdrop,
    announce: app.announce,
  });

  const take = async (): Promise<InkMarks | null> => {
    if (ink.model.strokes.length === 0) return null;
    const turn = app.lastTurn();
    ink.setOn({ element: 'stage', ...(turn === null ? {} : { node: turn }), label: 'the stage, as the user saw it' });
    return prepareMarks(ink, app.upload);
  };
  const set = (open: boolean): void => {
    layer.hidden = !open;
    toggle.set({ checked: open });
    if (!open) return;
    // the ink's space is the stage as it is now, unless there is ink already (then it keeps its own)
    if (ink.model.strokes.length === 0) ink.setBackground(null, { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
    ink.refresh();
    ink.root.focus({ preventScroll: true });
    void app.capture(1280).then(async (url) => {
      const image = url === null ? null : await loadImage(url);
      backdrop = image === null ? null : { kind: 'image', image };
    });
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

  ink.onChange(() => {
    const n = ink.model.strokes.length;
    menu.badge(n === 0 ? null : String(n));
    toggle.set({ label: n === 0 ? 'Draw' : `Draw (${n} stroke${n === 1 ? '' : 's'} waiting)` });
  });

  return {
    pending: () => ink.model.strokes.length > 0,
    take,
    sent,
    ink,
    isOpen: () => layer.hidden === false,
    show: set,
    dispose() {
      bar.dispose();
      ink.dispose();
      layer.remove();
      toggle.remove();
    },
  };
}
