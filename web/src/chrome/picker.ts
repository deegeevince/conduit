// The brain picker: one small button in the bar that says what is answering ("opus · medium · agent") and opens a panel
// to change the model, the effort and the mode, and to switch the check of the drawing. Native radio groups and a native
// checkbox, so every part of it works from the keyboard with a name, a role and a value; nothing is announced but the
// change the viewer makes.

import { BRAIN_EFFORTS, BRAIN_MODELS, BRAIN_MODES } from '@conduit/language';
import type { BrainChange, BrainChoice } from '@conduit/language';
import type { StageApp } from '../app/stage-app';
import { brainLabel } from './commands';

export interface Picker {
  /** the picker's own copy of what the brain is set to changed elsewhere (`/model`) */
  show(choice: BrainChoice): void;
  dispose(): void;
}

const MODE_GISTS: Readonly<Record<string, string>> = {
  plain: 'no tools: it only draws and writes',
  agent: 'it can act, and asks you first',
  steward: 'the steward answers',
};

let counter = 0;

export function mountPicker(host: HTMLElement, app: StageApp): Picker {
  counter += 1;
  const panelId = `brain-panel-${counter}`;
  const group = document.createElement('div');
  group.className = 'picker';
  group.innerHTML = `
    <button class="action action--brain" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="${panelId}" hidden>Brain</button>
    <div class="picker__panel" id="${panelId}" role="dialog" aria-label="Brain settings" hidden></div>`;
  host.prepend(group);
  const button = group.querySelector<HTMLButtonElement>('.action--brain');
  const panel = group.querySelector<HTMLElement>('.picker__panel');
  if (button === null || panel === null) throw new Error('The brain picker could not be built.');

  let choice: BrainChoice | null = null;
  let open = false;
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
    const modes = choice?.modes ?? [];
    if (choice !== null && modes.length > 1) {
      parts.push(radios('mode', 'Mode', BRAIN_MODES.filter((mode) => modes.includes(mode)), choice.mode ?? null, MODE_GISTS));
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
    note.textContent = 'A change starts the next answer fresh. Also: /model, /effort, /brain, /review.';
    parts.push(note);
    panel.replaceChildren(...parts);
    const label = choice === null ? null : brainLabel(choice);
    button.textContent = label ?? 'Settings';
    button.hidden = choice === null || (label === null && !review.available && modes.length < 2);
    group.hidden = button.hidden;
  };

  const setOpen = (next: boolean, focus = false): void => {
    open = next;
    panel.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    if (next) {
      draw();
      if (focus) (panel.querySelector<HTMLInputElement>('input:checked') ?? panel.querySelector<HTMLInputElement>('input'))?.focus();
    }
  };

  button.addEventListener('click', () => setOpen(!open, true));
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
          : field === 'mode' && BRAIN_MODES.some((mode) => mode === target.value)
            ? { mode: BRAIN_MODES.find((mode) => mode === target.value) }
            : null;
    if (change === null) return;
    busy = true;
    app.link.setBrain(change).then(
      (next) => {
        busy = false;
        choice = next;
        draw();
        // The panel was drawn again: the viewer's place in it is kept.
        if (open) panel.querySelector<HTMLInputElement>(`input[data-field="${field}"]:checked`)?.focus();
        app.announce(`${field === 'mode' ? 'Brain' : field === 'model' ? 'Model' : 'Effort'}: ${target.value} (the next answer starts fresh)`);
      },
      (cause: unknown) => {
        busy = false;
        draw();
        app.announce(cause instanceof Error ? cause.message : String(cause));
      },
    );
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.focus();
    } else if (event.key === 'Tab') {
      // Tabbing out of the panel closes it, as leaving a menu does.
      const inputs = [...panel.querySelectorAll<HTMLInputElement>('input')];
      const last = inputs[inputs.length - 1];
      const first = inputs[0];
      if ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first)) setOpen(false);
    }
  });
  const onPointer = (event: PointerEvent): void => {
    if (open && event.target instanceof Node && !group.contains(event.target)) setOpen(false);
  };
  document.addEventListener('pointerdown', onPointer);

  // The review switch is offered once the server has said it can; the choice is read again when the panel opens.
  const timer = setInterval(() => {
    if (!open) draw();
  }, 2000);
  draw();

  return {
    show(next) {
      choice = next;
      draw();
    },
    dispose() {
      clearInterval(timer);
      document.removeEventListener('pointerdown', onPointer);
      group.remove();
    },
  };
}
