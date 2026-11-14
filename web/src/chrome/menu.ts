// The composer's [+] menu: the one place the bar's less-used controls live (a photo, Draw, Save, the Transcript, the model, Copy answer, About),
// so that the bar itself can be one line. Other parts of the chrome add their own entries and views; this file knows nothing of what they do.
//
// The menu is a popover that opens upwards from the [+] button. Its entries are real buttons in the page's own tab order (the popover sits right
// after the button in the DOM), they also answer the arrow keys, Home and End, and Escape closes it and gives the focus back to [+]. An entry may
// open a *view* of its own (Save's list, the model picker, About) in place of the list, with a Back button; a view's content is whatever
// its owner puts there.

export interface MenuEntry {
  readonly id: string;
  readonly label: string;
  /** one short line under the label; keep it to a few words */
  readonly gist?: string;
  /** where it sits in its list: lower first */
  readonly order: number;
  /** a switch (`menuitemcheckbox`) rather than a command */
  readonly check?: boolean;
  readonly checked?: boolean;
  readonly hidden?: boolean;
  /** still there and focusable, but it says why it will not work when pressed (`aria-disabled`) */
  readonly disabled?: boolean;
  /** opens this view instead of running anything */
  readonly view?: string;
  /** what pressing it does; the menu is closed first, and the focus is back on [+] unless this moves it */
  readonly run?: () => void;
  /** a press that is refused (disabled) says this */
  readonly refusal?: () => void;
}

export interface MenuEntryHandle {
  readonly el: HTMLButtonElement;
  set(patch: Partial<Omit<MenuEntry, 'id' | 'order'>>): void;
  remove(): void;
}

export interface ComposerMenu {
  /** the [+] button */
  readonly button: HTMLButtonElement;
  /** adds an entry to the list of `view` (the root list by default; a view that does not exist yet is made, titled by its id) */
  add(entry: MenuEntry, view?: string): MenuEntryHandle;
  /** makes a view with a title and returns its body, for its owner to fill */
  addView(id: string, title: string): HTMLElement;
  open(view?: string): void;
  close(returnFocus?: boolean): void;
  readonly isOpen: boolean;
  /** a small mark on [+] (a count of what waits in the menu's care, such as strokes drawn); null removes it */
  badge(text: string | null): void;
  dispose(): void;
}

interface Row {
  readonly entry: { -readonly [K in keyof MenuEntry]: MenuEntry[K] };
  readonly el: HTMLButtonElement;
  readonly label: HTMLElement;
  readonly gist: HTMLElement;
  readonly view: string;
}

interface View {
  readonly id: string;
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  /** the entry that opened it, to give the focus back to on Back */
  openedBy: HTMLButtonElement | null;
}

let counter = 0;

/**
 * `button` is the [+] already in the bar; the popover is put right after it. `scope` is the element that holds both and in which a
 * click, a focus or a keystroke counts as "still in the composer".
 */
export function mountComposerMenu(button: HTMLButtonElement, scope: HTMLElement): ComposerMenu {
  counter += 1;
  const popoverId = `composer-menu-${counter}`;
  const popover = document.createElement('div');
  popover.className = 'composer__menu';
  popover.id = popoverId;
  popover.hidden = true;
  button.after(popover);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', popoverId);

  const badge = document.createElement('span');
  badge.className = 'composer__badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.hidden = true;
  button.append(badge);

  const views = new Map<string, View>();
  const rows: Row[] = [];
  let current = 'root';
  let opened = false;

  const makeView = (id: string, title: string): View => {
    const root = document.createElement('div');
    root.className = 'composer__view';
    root.dataset['view'] = id;
    root.hidden = id !== 'root';
    const body = document.createElement('div');
    body.className = 'composer__list';
    if (id === 'root') {
      root.setAttribute('role', 'menu');
      root.setAttribute('aria-label', 'More');
      root.append(body);
    } else {
      counter += 1;
      const heading = `composer-view-${counter}`;
      root.setAttribute('role', 'group');
      root.setAttribute('aria-labelledby', heading);
      const head = document.createElement('div');
      head.className = 'composer__head';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'composer__back';
      back.setAttribute('aria-label', 'Back to the menu');
      back.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
      back.addEventListener('click', () => show('root', true));
      const text = document.createElement('h2');
      text.className = 'composer__title';
      text.id = heading;
      text.textContent = title;
      head.append(back, text);
      root.append(head, body);
    }
    popover.append(root);
    const view: View = { id, root, body, openedBy: null };
    views.set(id, view);
    return view;
  };
  makeView('root', 'More');

  const viewOf = (id: string): View => views.get(id) ?? makeView(id, id);

  /** the things in the shown view that take the arrow keys: its entries and its Back button */
  const stops = (): HTMLButtonElement[] => {
    const view = views.get(current);
    if (view === undefined) return [];
    return [...view.root.querySelectorAll<HTMLButtonElement>('.composer__back, .composer__item')].filter((el) => !el.hidden);
  };

  function show(id: string, back = false): void {
    const from = views.get(current);
    current = id;
    for (const view of views.values()) view.root.hidden = view.id !== id;
    if (!opened) return;
    const view = views.get(id);
    if (view === undefined) return;
    if (back) (from?.openedBy ?? stops()[0])?.focus({ preventScroll: true });
    else (view.root.querySelector<HTMLElement>('input:checked, input, .composer__item, .composer__back, button, a') ?? view.root).focus({ preventScroll: true });
  }

  const sort = (view: string): void => {
    const list = viewOf(view).body;
    const mine = rows.filter((row) => row.view === view).sort((a, b) => a.entry.order - b.entry.order);
    for (const row of mine) list.append(row.el);
  };

  const paint = (row: Row): void => {
    const { entry, el } = row;
    el.hidden = entry.hidden === true;
    row.label.textContent = entry.label;
    row.gist.textContent = entry.gist ?? '';
    row.gist.hidden = entry.gist === undefined || entry.gist === '';
    el.setAttribute('role', entry.check === true ? 'menuitemcheckbox' : 'menuitem');
    if (entry.check === true) el.setAttribute('aria-checked', String(entry.checked === true));
    else el.removeAttribute('aria-checked');
    el.setAttribute('aria-disabled', String(entry.disabled === true));
    if (entry.view !== undefined) el.setAttribute('aria-haspopup', 'true');
  };

  const close = (returnFocus = false): void => {
    if (!opened) return;
    opened = false;
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('composer__plus--open');
    if (returnFocus) button.focus({ preventScroll: true });
    show('root');
  };

  const open = (view = 'root', focus = true): void => {
    if (opened) {
      show(view);
      return;
    }
    opened = true;
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('composer__plus--open');
    show(view);
    if (focus) (stops()[0] ?? button).focus({ preventScroll: true });
  };

  const press = (row: Row): void => {
    const { entry } = row;
    if (entry.disabled === true) {
      entry.refusal?.();
      return;
    }
    if (entry.view !== undefined) {
      const target = viewOf(entry.view);
      target.openedBy = row.el;
      show(entry.view);
      return;
    }
    close(false);
    button.focus({ preventScroll: true });
    entry.run?.();
  };

  button.addEventListener('click', () => (opened ? close(true) : open()));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      open('root', false);
      const list = stops();
      (event.key === 'ArrowUp' ? list[list.length - 1] : list[0])?.focus({ preventScroll: true });
    } else if (event.key === 'Escape' && opened) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  });
  popover.addEventListener('keydown', (event) => {
    const list = stops();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const typing = event.target instanceof HTMLInputElement;
    switch (event.key) {
      case 'ArrowDown':
        if (typing) return;
        event.preventDefault();
        list[(index + 1) % list.length]?.focus({ preventScroll: true });
        break;
      case 'ArrowUp':
        if (typing) return;
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus({ preventScroll: true });
        break;
      case 'Home':
        if (typing) return;
        event.preventDefault();
        list[0]?.focus({ preventScroll: true });
        break;
      case 'End':
        if (typing) return;
        event.preventDefault();
        list[list.length - 1]?.focus({ preventScroll: true });
        break;
      case 'ArrowLeft':
        if (current !== 'root' && !typing) {
          event.preventDefault();
          show('root', true);
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      default:
    }
  });
  popover.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const el = event.target.closest<HTMLButtonElement>('.composer__item');
    const row = el === null ? undefined : rows.find((candidate) => candidate.el === el);
    if (row !== undefined) press(row);
  });

  // leaving the composer by any road closes the menu: a click elsewhere, a Tab past its last entry
  const onPointer = (event: PointerEvent): void => {
    if (opened && event.target instanceof Node && !scope.contains(event.target)) close(false);
  };
  document.addEventListener('pointerdown', onPointer);
  scope.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (opened && next instanceof Node && !popover.contains(next) && next !== button) close(false);
  });

  return {
    button,
    add(entry, view = 'root') {
      counter += 1;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'composer__item';
      el.dataset['item'] = entry.id;
      const label = document.createElement('span');
      label.className = 'composer__label';
      const gist = document.createElement('span');
      gist.className = 'composer__gist';
      gist.id = `composer-gist-${counter}`;
      el.setAttribute('aria-describedby', gist.id);
      el.append(label, gist);
      const row: Row = { entry: { ...entry }, el, label, gist, view };
      rows.push(row);
      viewOf(view);
      paint(row);
      sort(view);
      return {
        el,
        set(patch) {
          Object.assign(row.entry, patch);
          paint(row);
        },
        remove() {
          const at = rows.indexOf(row);
          if (at >= 0) rows.splice(at, 1);
          el.remove();
        },
      };
    },
    addView(id, title) {
      const existing = views.get(id);
      if (existing !== undefined) return existing.body;
      return makeView(id, title).body;
    },
    open: (view) => open(view),
    close,
    get isOpen() {
      return opened;
    },
    badge(text) {
      badge.hidden = text === null;
      badge.textContent = text ?? '';
    },
    dispose() {
      document.removeEventListener('pointerdown', onPointer);
      popover.remove();
      badge.remove();
    },
  };
}
