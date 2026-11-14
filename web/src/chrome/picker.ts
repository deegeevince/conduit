// The brain picker: an entry of the composer's [+] menu, "Model and effort", that says what is answering ("opus · medium · agent") and opens a panel
// to change the model, the effort and the mode, and to switch the check of the drawing. Native radio groups and a native
// checkbox, so every part of it works from the keyboard with a name, a role and a value; nothing is announced but the
// change the viewer makes.

import { BRAIN_EFFORTS, BRAIN_MODELS } from '@conduit/language';
import type { BrainChange, BrainChoice } from '@conduit/language';
import type { StageApp } from '../app/stage-app';
import { brainLabel } from './commands';
import type { ComposerMenu } from './menu';

export interface Picker {
  /** the picker's own copy of what the brain is set to changed elsewhere (`/model`) */
  show(choice: BrainChoice): void;
  dispose(): void;
}

let counter = 0;

export function mountPicker(menu: ComposerMenu, app: StageApp): Picker {
  counter += 1;
  const panelId = `brain-panel-${counter}`;
  const panel = menu.addView('brain', 'Model and effort');
  panel.classList.add('picker__panel');
  panel.id = panelId;
  const entry = menu.add({ id: 'brain', label: 'Model and effort', order: 60, view: 'brain', hidden: true });

  let choice: BrainChoice | null = null;
  let busy = false;

  const radios = (name: string, legend: string, values: readonly string[], current: string | null, gists?: Readonly<Record<string, string>>): HTMLFieldSetElement => {
    const set = document.createElement('fieldset');
    set.className = 'picker__group';
    const title = document.createElement('legend');
    title.textContent = legend;
    set.append(title);
    const all = current !== null && !values.includes(current) ? [current, ...values] : values;
    for (const value of all) {
      counter += 1;
      const label = document.createElement('label');
      label.className = 'picker__option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `${name}-${panelId}`;
      input.value = value;
      input.checked = value === current;
      input.id = `${name}-${counter}`;
      input.dataset['field'] = name;
      const text = document.createElement('span');
      text.textContent = value;
      label.append(input, text);
      const gist = gists?.[value];
      if (gist !== undefined) {
        const note = document.createElement('span');
        note.className = 'picker__gist';
        note.id = `${input.id}-gist`;
        note.textContent = gist;
        input.setAttribute('aria-describedby', note.id);
        label.append(note);
      }
      set.append(label);
    }
    return set;
  };

  const draw = (): void => {
    const review = app.review;
    const parts: HTMLElement[] = [];
    if (choice !== null && choice.configurable) {
      parts.push(radios('model', 'Model', BRAIN_MODELS, choice.model), radios('effort', 'Effort (how hard it thinks)', BRAIN_EFFORTS, choice.effort));
    }
    if (review.available) {
      const row = document.createElement('label');
      row.className = 'picker__option picker__option--check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = review.on;
      input.dataset['field'] = 'review';
      const text = document.createElement('span');
      text.textContent = 'Check the drawing';
      const gist = document.createElement('span');
      gist.className = 'picker__gist';
      gist.id = `review-gist-${panelId}`;
      gist.textContent = 'after the first draft, look at it and fix what is wrong';
      input.setAttribute('aria-describedby', gist.id);
      row.append(input, text, gist);
      parts.push(row);
    }
    const note = document.createElement('p');
    note.className = 'picker__note';
    note.textContent = 'A change starts the next answer fresh. Also: /model, /effort, /review.';
    parts.push(note);
    panel.replaceChildren(...parts);
    const label = choice === null ? null : brainLabel(choice);
    entry.set({ label: label === null ? 'Settings' : 'Model and effort', ...(label === null ? {} : { gist: label }), hidden: choice === null || (label === null && !review.available) });
  };

  panel.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = target.dataset['field'];
    if (field === 'review') {
      app.review.set(target.checked);
      app.announce(`Check the drawing: ${target.checked ? 'on' : 'off'}`);
      return;
    }
    if (busy) return;
    const change: BrainChange | null =
      field === 'model' && BRAIN_MODELS.some((model) => model === target.value)
        ? { model: BRAIN_MODELS.find((model) => model === target.value) }
        : field === 'effort' && BRAIN_EFFORTS.some((effort) => effort === target.value)
          ? { effort: BRAIN_EFFORTS.find((effort) => effort === target.value) }
          : null;
    if (change === null) return;
    busy = true;
    app.link.setBrain(change).then(
      (next) => {
        busy = false;
        choice = next;
        draw();
        // The panel was drawn again: the viewer's place in it is kept.
        if (panel.contains(document.activeElement) || document.activeElement === document.body) panel.querySelector<HTMLInputElement>(`input[data-field="${field}"]:checked`)?.focus();
        app.announce(`${field === 'mode' ? 'Brain' : field === 'model' ? 'Model' : 'Effort'}: ${target.value} (the next answer starts fresh)`);
      },
      (cause: unknown) => {
        busy = false;
        draw();
        app.announce(cause instanceof Error ? cause.message : String(cause));
      },
    );
  });
  // The review switch is offered once the server has said it can; the choice is read again when the panel opens.
  const timer = setInterval(() => {
    if (!panel.contains(document.activeElement)) draw();
  }, 2000);
  draw();

  return {
    show(next) {
      choice = next;
      draw();
    },
    dispose() {
      clearInterval(timer);
      entry.remove();
      panel.remove();
    },
  };
}
