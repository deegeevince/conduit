// The pen on a document (PLAN-v3-core: the ink module on the lesson's writing slot). The lesson draws a blank paper (`data-ink-slot`) and tells the
// page where it is (`slot`, in the frame's own pixels); this lays the ink module's `overlayOn` over that rectangle, with one region, `answer`, and
// `on {node, ask}`. A hand drawn there is read by the server (`readInk`: a cheap model only transcribes), and the words go back to the lesson as her
// try, where the document's own matcher says whether it is right. Nothing here knows a worksheet: any ask with a slot gets a pen.

import { overlayOn } from '../ink';
import type { Overlay } from '../ink';
import type { DocNode, Document, LessonAsk, NodeId } from '@conduit/language';

export interface InkSlot {
  readonly node: NodeId;
  readonly ask: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DocumentInkOptions {
  /** the element the lesson frame fills: slot rectangles are in its pixels */
  readonly mount: HTMLElement;
  readonly document: () => Document | null;
  /** keeps the picture of the ink; resolves with its upload id */
  readonly upload: (png: Blob) => Promise<string>;
  /** reads what was written: lines as she wrote them */
  readonly read: (request: { readonly image: string; readonly node: string; readonly ask: string }) => Promise<{ readonly lines: readonly string[]; readonly unclear: boolean }>;
  /** what came of Check: her working as text for the ask, or null (and a sentence for her) */
  readonly answer: (node: NodeId, ask: string, text: string | null, said?: string) => void;
  readonly note: (text: string) => void;
}

export interface DocumentInk {
  /** where the writing slot is now, or null when there is none on screen */
  slot(slot: InkSlot | null): void;
  /** Check was pressed: read the ink for this ask and answer */
  check(node: NodeId, ask: string): Promise<void>;
  /** a clean sheet */
  clear(node: NodeId, ask: string): void;
  /** how many strokes wait on the paper now (for the browser checks) */
  strokes(): number;
  dispose(): void;
}

function askOf(doc: Document | null, node: NodeId, ask: string): { readonly node: DocNode; readonly step: LessonAsk } | null {
  const found = doc?.nodes[node];
  if (found === undefined || found.body === null || found.body.kind !== 'lesson') return null;
  const step = found.body.steps.find((candidate): candidate is LessonAsk => candidate.kind === 'ask' && candidate.id === ask);
  return step === undefined ? null : { node: found, step };
}

/** What her lines are, as one try: a working is all of its lines; a single answer is what she ended on (after the last equals sign). */
export function tryText(lines: readonly string[], working: boolean): string {
  if (working) return lines.join('\n');
  const last = lines[lines.length - 1] ?? '';
  const after = last.split('=').pop() ?? last;
  return after.trim() === '' ? last : after.trim();
}

export function createDocumentInk(options: DocumentInkOptions): DocumentInk {
  const { mount } = options;
  if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';
  mount.style.overflow = 'hidden';
  const box = document.createElement('div');
  box.className = 'document-ink';
  box.style.cssText = 'position:absolute;display:none;z-index:6;';
  mount.append(box);
  let current: { readonly key: string; readonly slot: InkSlot; overlay: Overlay } | null = null;
  /** what is written on a paper that has gone out of sight (scrolled away, the lesson drawn again), by ask, for when it is back */
  const kept = new Map<string, ReturnType<Overlay['ink']['document']>>();

  const drop = (): void => {
    if (current !== null && current.overlay.ink.model.strokes.length > 0) kept.set(current.key, current.overlay.ink.document());
    else if (current !== null) kept.delete(current.key);
    current?.overlay.dispose();
    current = null;
    box.style.display = 'none';
  };

  return {
    slot(slot) {
      if (slot === null || slot.w < 40 || slot.h < 40) {
        // off screen, or moving (the lesson scrolls, or is drawn again): the pen is put away, not thrown away, so Check still reads what is on it
        if (current !== null) {
          current.overlay.setActive(false);
          box.style.display = 'none';
        }
        return;
      }
      const key = `${slot.node}\u0000${slot.ask}`;
      if (current !== null && current.key === key && Math.abs(current.slot.w - slot.w) < 2 && Math.abs(current.slot.h - slot.h) < 2) {
        Object.assign(box.style, { display: 'block', left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.w}px`, height: `${slot.h}px` });
        current = { ...current, slot };
        current.overlay.setActive(true);
        return;
      }
      Object.assign(box.style, { display: 'block', left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.w}px`, height: `${slot.h}px` });
      drop();
      const document_ = kept.get(key) ?? null;
      Object.assign(box.style, { display: 'block', left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.w}px`, height: `${slot.h}px` });
      const found = askOf(options.document(), slot.node, slot.ask);
      const overlay = overlayOn(box, {
        space: { w: slot.w, h: slot.h },
        regions: [{ id: 'answer', kind: 'answer', label: 'her answer', box: { x: 0, y: 0, w: slot.w, h: slot.h } }],
        on: { node: slot.node, ask: slot.ask, label: found === null ? 'her answer' : `her handwritten answer to: ${found.step.prompt.slice(0, 80)}` },
        fingerDraws: true,
        penSize: 7,
        announce: options.note,
      });
      overlay.container.setAttribute('data-document-ink', slot.ask);
      if (document_ !== null) overlay.ink.load(document_);
      current = { key, slot, overlay };
    },
    async check(node, ask) {
      const here = current;
      if (here === null || here.key !== `${node}\u0000${ask}` || here.overlay.ink.model.strokes.length === 0) {
        options.answer(node, ask, null, 'Write your answer in the box first, then press Check.');
        return;
      }
      const ink = here.overlay.ink;
      try {
        const picture = await ink.picture();
        if (picture === null) return options.answer(node, ask, null, 'Write your answer in the box first, then press Check.');
        const image = await options.upload(picture.blob);
        const read = await options.read({ image, node, ask });
        const found = askOf(options.document(), node, ask);
        if (read.lines.length === 0) return options.answer(node, ask, null, 'I could not read that. Try writing it bigger, or press Type it.');
        // her page is read once: what she wrote is now her try, kept as text in her tries
        ink.reset();
        options.answer(node, ask, tryText(read.lines, found?.step.check === 'working'));
      } catch (cause) {
        options.answer(node, ask, null, cause instanceof Error && cause.message !== '' ? `I could not read that (${cause.message}). Press Type it to type your answer.` : 'I could not read that. Press Type it to type your answer.');
      }
    },
    clear(node, ask) {
      if (current?.key === `${node}\u0000${ask}`) current.overlay.ink.reset();
    },
    strokes: () => current?.overlay.ink.model.strokes.length ?? 0,
    dispose() {
      drop();
      box.remove();
    },
  };
}
