// The text layer (PLAN-v2.1 A2): the stage's words as real text, laid over the picture where each drawn line is. The picture is WebGL and cannot be
// selected; this can, so a drag selects, a right-click or a long-press offers Copy, and a screen reader reads the stage. The text is transparent: it
// is the twin of what is drawn, and only its selection is seen. It is built from the painter's `text` event (which comes when the stage is at
// rest) and kept out of the way while things move. It takes no tap away from anything: a choice, a control and a mock-up's live parts are not
// selectable, and the rest of the stage's pointer path is the stage's own (the layer's events bubble to it like any other).

import type { TextSpanView } from '../contracts/text-layer';
import { answerMarkdown } from './answer-markdown';
import { selectionAnchors } from './text-anchors';
import type { TextAnchor } from './text-anchors';

export interface TextLayer {
  /** the element the lines are in: over the stage, in front of the picture */
  readonly root: HTMLElement;
  /** the words now on stage, in reading order; empty while things move */
  update(spans: readonly TextSpanView[], turn: string | null): void;
  /** the stage as Markdown: the turn's, as it came to rest, or the latest */
  markdown(turn?: string | null): string;
  /** the current selection as anchors into the stage's elements */
  anchors(): TextAnchor[];
  dispose(): void;
}

const MAX_TURNS = 40;

function fix(value: number): string {
  return `${Math.round(value * 10) / 10}px`;
}

export function createTextLayer(stage: HTMLElement): TextLayer {
  const root = document.createElement('div');
  root.className = 'stage__text';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Words on the stage');
  stage.append(root);

  let current: readonly TextSpanView[] = [];
  /** each turn's words as they last came to rest, for "copy answer" on a turn of the transcript */
  const answers = new Map<string, string>();

  const build = (spans: readonly TextSpanView[]): void => {
    const fragment = document.createDocumentFragment();
    const lines: { readonly element: HTMLElement; readonly rotation: number; readonly width: number; readonly height: number; readonly x: number; readonly y: number }[] = [];
    for (const span of spans) {
      if (!span.placed || span.lines.length === 0) continue;
      const holder = document.createElement(span.role === 'heading' ? `h${Math.min(6, span.level + 1)}` : 'p');
      holder.className = `stage__text-block stage__text-block--${span.role}`;
      holder.dataset['key'] = span.key;
      holder.dataset['role'] = span.role;
      holder.dataset['element'] = span.id;
      const slash = span.key.indexOf('/');
      if (slash >= 0) holder.dataset['part'] = span.key.slice(slash + 1);
      if (span.within !== null) holder.dataset['structure'] = span.within.key;
      let offset = 0;
      if (span.within !== null) {
        holder.dataset['row'] = String(span.within.row);
        holder.dataset['column'] = String(span.within.column);
      }
      // what a tap works is not selectable text: the stage's own pointer path has it
      if (span.role === 'choice' || span.role === 'control') holder.setAttribute('aria-hidden', 'true');
      for (const line of span.lines) {
        const element = document.createElement('span');
        element.dataset['start'] = String(offset);
        offset += line.text.length + 1;
        element.className = 'stage__text-line';
        element.textContent = line.text;
        element.style.font = `${span.bold ? 700 : 400} ${fix(span.fontPx)}/${fix(line.box.height)} ${span.family}`;
        element.style.height = fix(line.box.height);
        holder.append(element);
        lines.push({ element, rotation: span.rotation, width: line.box.width, height: line.box.height, x: line.box.x + line.box.width / 2, y: line.box.y + line.box.height / 2 });
      }
      fragment.append(holder);
    }
    root.replaceChildren(fragment);
    // The glyphs the browser has are not the ones that are drawn, so each line is set to its natural width and then stretched to the drawn width:
    // its selection then covers the drawn words, not a near miss. One pass reads every width, a second writes every place.
    const natural = lines.map((line) => line.element.offsetWidth);
    lines.forEach((line, index) => {
      const own = Math.max(1, natural[index] ?? 1);
      const style = line.element.style;
      style.width = fix(own);
      style.left = fix(line.x - own / 2);
      style.top = fix(line.y - line.height / 2);
      const scale = line.width / own;
      style.transform = `${Math.abs(line.rotation) > 0.05 ? `rotate(${Math.round(line.rotation * 100) / 100}deg) ` : ''}scaleX(${Math.round(scale * 1000) / 1000})`;
    });
  };

  /** The words of a selection as they were written: the lines of one element joined as the sentence they are, elements on lines of their own, a table's cells by tabs. */
  const onCopy = (event: ClipboardEvent): void => {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed || event.clipboardData === null) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== root) return;
    const out: string[] = [];
    let last: HTMLElement | null = null;
    /** where the last stretch of a listing's line ended, in columns: the next stretch of that line is put that far on, spaces between */
    let ends = 0;
    for (const block of root.querySelectorAll<HTMLElement>('.stage__text-block')) {
      if (!range.intersectsNode(block)) continue;
      const parts: string[] = [];
      for (const line of block.querySelectorAll<HTMLElement>('.stage__text-line')) {
        const node = line.firstChild;
        if (node === null || !range.intersectsNode(node)) continue;
        const text = node.textContent ?? '';
        const from = range.startContainer === node ? range.startOffset : 0;
        const to = range.endContainer === node ? range.endOffset : text.length;
        if (to > from) parts.push(text.slice(from, to));
      }
      if (parts.length === 0) continue;
      const code = block.dataset['role'] === 'code';
      const joined = parts.join(code ? '\n' : ' ');
      const sameRow = last !== null && block.dataset['row'] !== undefined && last.dataset['row'] === block.dataset['row'] && (block.dataset['role'] === 'cell' || (code && last.dataset['role'] === 'code' && last.dataset['structure'] === block.dataset['structure']));
      const column = Number(block.dataset['column'] ?? 0);
      // a listing: the stretches of one line stand at their columns, the lines of it on lines of their own
      if (out.length > 0) out.push(sameRow ? (code ? ' '.repeat(Math.max(0, column - ends)) : '\t') : '\n');
      if (code && !sameRow && block.dataset['row'] !== undefined) out.push(' '.repeat(column));
      out.push(joined);
      ends = column + joined.length;
      last = block;
    }
    if (out.length === 0) return;
    event.clipboardData.setData('text/plain', out.join(''));
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy);

  // A drag that began on a word is a selection. The pointer then crosses gaps with nothing under it but the picture, and the browser would drop the
  // selection there; so while the button is down the layer as a whole takes the pointer, and the selection runs to the nearest word.
  const endSelecting = (): void => {
    delete root.dataset['selecting'];
    window.removeEventListener('pointerup', endSelecting, true);
    window.removeEventListener('pointercancel', endSelecting, true);
  };
  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.pointerType !== 'mouse' || !(event.target instanceof Element) || !event.target.classList.contains('stage__text-line')) return;
    root.dataset['selecting'] = '';
    window.addEventListener('pointerup', endSelecting, true);
    window.addEventListener('pointercancel', endSelecting, true);
  };
  root.addEventListener('pointerdown', onDown);

  return {
    root,
    update(spans, turn) {
      if (spans.length === 0) {
        // things are moving: the lines stay where they are, unseen and out of reach, until the stage comes to rest again
        root.dataset['moving'] = '';
        root.setAttribute('aria-busy', 'true');
        return;
      }
      delete root.dataset['moving'];
      root.removeAttribute('aria-busy');
      current = spans;
      build(spans);
      if (turn !== null) {
        answers.delete(turn);
        answers.set(turn, answerMarkdown(spans));
        while (answers.size > MAX_TURNS) answers.delete(answers.keys().next().value as string);
      }
    },
    anchors: () => selectionAnchors(root),
    markdown(turn) {
      if (turn !== undefined && turn !== null) return answers.get(turn) ?? '';
      return answerMarkdown(current);
    },
    dispose() {
      document.removeEventListener('copy', onCopy);
      endSelecting();
      root.remove();
    },
  };
}
