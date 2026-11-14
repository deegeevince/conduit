// The list of conversations: what the server's logs hold, newest first, with this page's own conversation at the top.

import { shorten, whenWords } from './model';

export interface ListItem {
  /** the log's id, or `live` for the conversation this page is having */
  readonly id: string;
  readonly title: string;
  readonly when: string;
}

export interface ConversationList {
  setItems(items: readonly ListItem[], current: string): void;
  setCurrent(id: string): void;
  /** a sentence under the list when the server could not be asked */
  setProblem(text: string | null): void;
  dispose(): void;
}

export function mountList(host: HTMLElement, handlers: { readonly onPick: (id: string) => void; readonly onNew: () => void }): ConversationList {
  host.innerHTML = `
    <div class="shell-list__head">
      <h2 class="shell-list__name">Conduit</h2>
      <button type="button" class="sh-btn sh-btn--text" data-new>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        <span>New</span>
      </button>
    </div>
    <p class="shell-list__empty" role="status" hidden></p>
    <ul class="shell-list__items" aria-label="Conversations"></ul>`;
  const items = host.querySelector<HTMLUListElement>('.shell-list__items');
  const problem = host.querySelector<HTMLElement>('.shell-list__empty');
  const fresh = host.querySelector<HTMLButtonElement>('[data-new]');
  if (items === null || problem === null || fresh === null) throw new Error('The list could not be built.');
  fresh.addEventListener('click', handlers.onNew);

  let current = 'live';
  const mark = (): void => {
    for (const button of items.querySelectorAll<HTMLButtonElement>('.conv')) {
      if (button.dataset['id'] === current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };

  return {
    setItems(next, now) {
      current = now;
      const keep = document.activeElement instanceof HTMLElement && items.contains(document.activeElement) ? document.activeElement.dataset['id'] : undefined;
      items.replaceChildren(
        ...next.map((item) => {
          const row = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'conv';
          button.dataset['id'] = item.id;
          const title = document.createElement('span');
          title.className = 'conv__title';
          title.textContent = shorten(item.title, 80);
          const when = document.createElement('span');
          when.className = 'conv__when';
          when.textContent = item.when === '' ? 'Now' : whenWords(item.when);
          button.append(title, when);
          button.addEventListener('click', () => handlers.onPick(item.id));
          row.append(button);
          return row;
        }),
      );
      mark();
      if (keep !== undefined) items.querySelector<HTMLButtonElement>(`.conv[data-id="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
    },
    setCurrent(id) {
      current = id;
      mark();
    },
    setProblem(text) {
      problem.hidden = text === null;
      problem.textContent = text ?? '';
    },
    dispose() {
      host.replaceChildren();
    },
  };
}
