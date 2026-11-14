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
