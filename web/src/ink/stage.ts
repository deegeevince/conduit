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
  /** where the stage is, for nothing: the turn on it and how far it has played. Remembered when a drawing begins, so that no picture has to be taken then. */
  moment?(): { readonly turn: string | null; readonly playhead: number };
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
  /** the layer is over the stage (the Draw toggle, or the work mode) and takes every pointer: not once a pen has been seen (then the Pencil alone draws and the rest work the stage), nor with the hand tool */
  isOpen(): boolean;
  /** Draw is on and the Pencil draws on the stage, anywhere, while a finger or a mouse works the stage under the layer (`app/pen-write.ts` begins the pen's strokes) */
  drawing(): boolean;
  /** the hand tool is on: Draw is paused, input goes to the stage, the ink stays on screen and goes with Send */
  hand(): boolean;
  setHand(on: boolean): void;
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
  /**
   * Which strokes are written in a written method's cells (`app/pen-write.ts`). They are a drawing to send like any other (the bar and the badge show for them), but the stage's picture
   * is not taken in the idle moments between them: a render and a read-back of the stage while a person writes a sum is the lag fb-102 took out. It is taken when they are sent.
   */
  setOwned(owned: (strokeId: string) => boolean): void;
  /** What the writing is on, when it is not the stage itself: a written method's sum (`app/pen-write.ts`). Asked when the ink goes up, so the turn says which sum it was written on. */
  setSurface(surface: () => { readonly element: string; readonly label: string } | null): void;
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

/**
 * Whether a picture of the stage came back as nothing: every sampled pixel is black. A graphics stack that cannot hand the stage's pixels over (a phone's, under memory
 * pressure) gives a cleared buffer, and a picture of that must never go to the brain as "the stage as the user saw it", or sit under the ink as a black card.
 */
export function isBlankPicture(image: CanvasImageSource & { readonly naturalWidth?: number }): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return false;
    context.drawImage(image, 0, 0, 32, 32);
    const data = context.getImageData(0, 0, 32, 32).data;
    for (let i = 0; i < data.length; i += 4) if ((data[i] as number) > 6 || (data[i + 1] as number) > 6 || (data[i + 2] as number) > 6) return false;
    return true;
  } catch {
    // a picture that cannot be read back is judged by whoever sends it
    return false;
  }
}

/** After the layer has been painted once (two frames, or the time they would take when the page is not being shown): the stage's picture is not asked for in the frame that opens the layer. */
const afterPaint = (): Promise<void> =>
  new Promise((resolve) => {
    const give = setTimeout(resolve, 300);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(give);
        resolve();
      }),
    );
  });

/** How long the pen has been up when the stage's picture is taken for a drawing waiting to be sent. */
export const PICTURE_AFTER_MS = 700;

export interface StageInkOptions {
  /** the palm guard the lens shares, so a pen seen by one is seen by both */
  readonly guard?: PalmGuard;
  /** In Draw, once a pen has been seen, the layer lets a finger and a mouse through to the stage and only the Pencil draws (default true; false with the lens, which has its own hands) */
  readonly penPasses?: boolean;
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
  /** the hand tool: Draw is paused and the stage takes the input */
  let handOn = false;
  /** a pen has touched or hovered over this page (this or any other listener's guard) */
  let penSeen = options.guard?.seenPen === true;
  /** the strokes that belong to a cell of a written method */
  let owned: (strokeId: string) => boolean = () => false;
  /** what the ink is on when not the stage: the sum the pen wrote in */
  let surface: () => { readonly element: string; readonly label: string } | null = () => null;
  const ink = createInk(layer, {
    ...(options.guard === undefined ? {} : { guard: options.guard }),
    space: { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) },
    on: { element: 'stage', label: 'the stage, as the user saw it' },
    backdrop: async () => {
      await pictureNow();
      return backdrop;
    },
    announce: app.announce,
  });

  /** the strokes outside a written method's cells: the drawing whose picture of the stage is taken once the pen has been up a while */
  const freeStrokes = (): number => ink.model.strokes.filter((stroke) => !owned(stroke.id)).length;
  const take = async (): Promise<InkMarks | null> => {
    if (ink.model.strokes.length === 0) return null;
    // the turn the drawing began on, not the one the stage has come to since
    const turn = began?.turn ?? app.lastTurn();
    const on = surface();
    ink.setOn({ element: on?.element ?? 'stage', ...(turn === null ? {} : { node: turn }), label: on?.label ?? 'the stage, as the user saw it' });
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
  let captures = 0;
  /**
   * What the drawing began on, remembered for nothing: the turn on the stage and how far it had played. The stage's picture is not taken when the pen goes down (a render and a read-back
   * of the stage, on the main thread, in the first stroke of a sum and of every drawing: fb-102); it is taken once the pen has been up for a while, or when the drawing is sent.
   */
  let began: { readonly turn: string | null; readonly playhead: number } | null = null;
  const remember = (): void => {
    if (began === null) began = app.moment?.() ?? { turn: app.lastTurn(), playhead: 0 };
  };
  /** the stage still shows what the drawing began on: a picture of it now is a picture of what the person saw (the turn may have played on) */
  const sameStage = (): boolean => began !== null && (app.moment?.().turn ?? app.lastTurn()) === began.turn;
  let taking: Promise<void> | null = null;
  /**
   * The picture the drawing is on, taken once the layer is up and the frame that showed it has been presented: off screen (the stage's own still path: a render target of its own,
   * read in the same task it is drawn in, never the visible canvas). One that fails, or comes back blank, is no backdrop at all: the picture that goes up is then the ink on white.
   */
  const captureBackdrop = (): Promise<void> => {
    captures += 1;
    const mine = captures;
    const made: Promise<void> = afterPaint()
      .then(() => app.capture(1280))
      .then(async (url) => {
        const image = url === null ? null : await loadImage(url);
        if (mine !== captures) return;
        backdrop = image === null || isBlankPicture(image) ? null : { kind: 'image', image };
      })
      .catch(() => {
        if (mine === captures) backdrop = null;
      })
      .then(() => {
        if (taking === made) taking = null;
      });
    taking = made;
    return made;
  };
  /** the picture, now, for a drawing that is being sent: the one taken already, the one being taken, or one taken now (when the stage is still what the drawing began on) */
  const pictureNow = async (): Promise<void> => {
    if (backdrop === null && taking === null && ink.model.strokes.length > 0 && sameStage()) void captureBackdrop();
    await taking;
  };
  let idle: ReturnType<typeof setTimeout> | undefined;
  /** the pointers that are on the layer now while Draw has it */
  const touching = new Set<number>();
  /** After the pen has been up for a moment, and only for a drawing outside the cells (what is written in a sum's cells has its picture taken when it is sent, never between strokes). */
  const pictureLater = (): void => {
    clearTimeout(idle);
    if (backdrop !== null || taking !== null || freeStrokes() === 0) return;
    idle = setTimeout(() => {
      if (penHeld.size > 0 || touching.size > 0) return pictureLater();
      if (backdrop === null && taking === null && freeStrokes() > 0 && sameStage()) void captureBackdrop();
    }, PICTURE_AFTER_MS);
  };
  /** nothing is waiting to be sent: what was remembered and taken is let go */
  const forget = (): void => {
    clearTimeout(idle);
    captures += 1;
    backdrop = null;
    began = null;
    taking = null;
  };
  /** the pens that are down on the stage right now with no Draw: the layer must be there to take what they write */
  const penHeld = new Set<number>();
  /**
   * The layer is over the stage while Draw has it, or while there is ink to show (strokes the pen wrote with no Draw, a method's cells), or while a pen stroke is being begun. An idle layer
   * is not on screen at all: it would be a stage-sized transparent plane (two canvases of the stage's size in pixels) that does nothing, on a phone that has no pen.
   */
  const refresh = (): void => {
    const inked = throughOn && (penHeld.size > 0 || ink.model.strokes.length > 0);
    layer.hidden = !(explicit || inked);
    layer.classList.toggle('ink-stage--through', passing());
    // While Draw is on, the stage under the layer takes the Pencil with no gesture of the browser's to wait for (`touch-action: none`), as a sum's stage does (`app/pen-write.ts`): once a
    // pen has been seen the layer lets every pointer through, and a pen that went down on a stage that may still be panned or zoomed is the browser's to judge first. Not with the hand
    // tool, which gives the page back to the fingers.
    stage.classList.toggle('ink-stage-host--draw', explicit && !handOn);
    if (throughOn) bar.element.hidden = !explicit && ink.model.strokes.length === 0;
  };
  /**
   * Whether the layer lets the pointers through to the stage under it: when Draw is not on (it shows only the ink); with the hand tool; and, once a pen has been seen, in Draw
   * itself, where a finger and a mouse work the stage (a button, a choice, a slider) and only the Pencil draws (its strokes are begun from the stage, `penDown`, as the maths pen's
   * are). A finger that has been told to draw (the bar's "Finger draws") takes the layer back.
   */
  const passing = (): boolean => throughOn && (!explicit || handOn || (options.penPasses !== false && (penSeen || options.guard?.seenPen === true) && !ink.fingerDraws()));
  const sawPen = (event: PointerEvent): void => {
    if (event.pointerType !== 'pen' || penSeen) return;
    penSeen = true;
    refresh();
  };
  window.addEventListener('pointerdown', sawPen as EventListener, true);
  window.addEventListener('pointermove', sawPen as EventListener, true);
  const penLeft = (event: PointerEvent): void => {
    touching.delete(event.pointerId);
    if (!penHeld.delete(event.pointerId)) return;
    // after the layer's own handler has taken the stroke into the document
    setTimeout(refresh, 0);
  };
  window.addEventListener('pointerup', penLeft);
  window.addEventListener('pointercancel', penLeft);
  const set = (open: boolean): void => {
    explicit = open;
    handOn = false;
    bar.refresh();
    refresh();
    toggle.set({ checked: open });
    if (!open) return;
    // the ink's space is the stage as it is now, unless there is ink already (then it keeps its own)
    if (ink.model.strokes.length === 0) ink.setBackground(null, { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
    ink.refresh();
    ink.root.focus({ preventScroll: true });
    remember();
  };
  // a pointer that goes down on the layer while Draw has it: the drawing has begun on what the stage shows now
  layer.addEventListener(
    'pointerdown',
    (event) => {
      touching.add(event.pointerId);
      remember();
    },
    true,
  );
  const sent = (): void => {
    ink.reset();
    forget();
    set(false);
  };
  const setHand = (on: boolean): void => {
    if (on === handOn || !explicit) return;
    handOn = on;
    refresh();
    bar.refresh();
    app.announce(on ? 'The page takes your taps. Your drawing stays.' : 'Drawing again.');
  };

  const bar: InkBar = mountInkBar(layer, ink, {
    sendLabel: 'Send drawing',
    collapsible: true,
    dock: true,
    hand: { on: () => handOn, set: (on) => setHand(on) },
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
    const n = ink.model.strokes.length;
    if (n === 0) forget();
    else pictureLater();
    menu.badge(n === 0 ? null : String(n));
    toggle.set({ label: n === 0 ? 'Draw' : `Draw (${n} stroke${n === 1 ? '' : 's'} waiting)` });
  };
  ink.onChange(tell);

  return {
    pending: () => ink.model.strokes.length > 0,
    take,
    sent,
    ink,
    isOpen: () => explicit && !passing(),
    drawing: () => explicit && !handOn && passing(),
    hand: () => handOn,
    setHand,
    show: set,
    through(on) {
      if (on === throughOn) return;
      throughOn = on;
      refresh();
      if (!on) bar.element.hidden = false;
    },
    penDown(event) {
      if (!throughOn || (explicit && !passing())) return;
      penHeld.add(event.pointerId);
      refresh();
      // the stage as it is now is what the drawing is on: remembered (a turn and a playhead), not photographed; its picture comes after the pen has lifted, if the stroke is to be sent
      remember();
      // (`setBackground` lays the canvases out for the space it is given, once the layer is on screen)
      if (ink.model.strokes.length === 0) ink.setBackground(null, { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
      ink.pointerDown(event);
    },
    abort(pointerId) {
      ink.abort(pointerId);
      if (penHeld.delete(pointerId)) refresh();
    },
    setOwned(next) {
      owned = next;
      tell();
    },
    setSurface(next) {
      surface = next;
    },
    setView: (view) => ink.setView(view),
    dispose() {
      clearTimeout(idle);
      window.removeEventListener('pointerdown', sawPen as EventListener, true);
      window.removeEventListener('pointermove', sawPen as EventListener, true);
      window.removeEventListener('pointerup', penLeft);
      window.removeEventListener('pointercancel', penLeft);
      bar.dispose();
      ink.dispose();
      stage.classList.remove('ink-stage-host--draw');
      layer.remove();
      toggle.remove();
    },
  };
}
