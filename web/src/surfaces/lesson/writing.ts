// The writing area: where a hand answers an ask. The ink module (PLAN-v3-core, `web/src/ink/**`, built beside this) is a pen area over a part
// that reads what is written; it lands as a module of its own and plugs in here. Until then the typed field is the area: a real input with
// the number keys on a phone. The container carries `data-ink-slot` with the part's id, so the ink module finds the place and a driver can too.

import { h } from './dom';

export interface WritingOptions {
  readonly node: string;
  readonly ask: string;
  readonly initial: string;
  readonly unit: string | null;
  readonly inputmode: 'numeric' | 'decimal' | 'text';
  /** typed text changed: the draft is state, kept as she types */
  readonly onInput: (text: string) => void;
  /** she pressed Check (or Enter) */
  readonly onCheck: (text: string, stamp: number) => void;
}

export interface Writing {
  readonly element: HTMLElement;
  /** what has been written, as text; the ink module answers this after it has read the hand */
  read(): string;
}

/** The fallback: one big field and Check. */
export function typedWriting(options: WritingOptions): Writing {
  const field = h('input', {
    class: 'field',
    'data-act': 'answer',
    type: 'text',
    inputmode: options.inputmode,
    enterkeyhint: 'done',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: false,
    'aria-label': 'Your answer',
    placeholder: 'Type your answer',
  });
  field.value = options.initial;
  field.addEventListener('input', () => options.onInput(field.value));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') options.onCheck(field.value, e.timeStamp);
  });
  const element = h(
    'div',
    { class: 'answer-row', 'data-ink-slot': options.node, 'data-ask': options.ask },
    field,
    options.unit === null ? null : h('span', { class: 'unit' }, options.unit),
    h('button', { type: 'button', class: 'btn main check', 'data-act': 'check', onclick: (e: Event) => options.onCheck(field.value, e.timeStamp) }, 'Check'),
  );
  return { element, read: () => field.value };
}

export interface InkWritingOptions {
  readonly node: string;
  readonly ask: string;
  readonly unit: string | null;
  /** the page is reading what she wrote (Check was pressed) */
  readonly reading: boolean;
  /** a sentence under the paper (the last read could not be made out) */
  readonly note: string | null;
  /** a short line near Check for the last try that was not right (the phone shows it there, where the longer words would be below the fold) */
  readonly verdict?: string | null;
  readonly onCheck: (stamp: number) => void;
  readonly onClear: () => void;
  readonly onType: () => void;
}

/**
 * The paper: a blank, ruled area the page lays its ink layer over (`data-ink-slot` is what the page finds it by; it is the whole of the lesson's side
 * of the pen). Check asks the page to read the hand; start-again clears the page's ink; the typed field is one tap away for a keyboard.
 */
export function inkWriting(options: InkWritingOptions): HTMLElement {
  return h(
    'div',
    { class: 'writing' },
    h('div', { class: 'paper', 'data-ink-slot': options.node, 'data-ask': options.ask, role: 'img', 'aria-label': 'Write your answer here with the pencil' }, h('span', { class: 'paper-hint' }, 'Write here with the pencil')),
    options.note === null ? null : h('p', { class: 'ask-note', role: 'status' }, options.note),
    h(
      'div',
      { class: 'answer-row' },
      options.reading
        ? h('button', { type: 'button', class: 'btn main check', 'data-act': 'check', disabled: true }, 'Reading your writing…')
        : h('button', { type: 'button', class: 'btn main check', 'data-act': 'check', onclick: (e: Event) => options.onCheck(e.timeStamp) }, 'Check'),
      h('button', { type: 'button', class: 'btn soft', 'data-act': 'clear', onclick: () => options.onClear() }, 'Start again'),
      h('button', { type: 'button', class: 'btn soft', 'data-act': 'type', onclick: () => options.onType() }, 'Type it'),
    ),
    options.verdict === undefined || options.verdict === null ? null : h('p', { class: 'vline', role: 'status' }, options.verdict),
  );
}
