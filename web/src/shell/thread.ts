// The thread: the person's words, photos and voice notes on one side, Conduit's replies on the other. A reply that can open the canvas has a button for it (a card with
// the resting picture when it drew). Plain DOM, selectable text, and a list a screen reader can walk message by message.

import type { Message, ReplyChoice, ReplyMessage } from './model';

export interface ThreadHandlers {
  readonly onOpenCanvas: (reply: ReplyMessage, opener: HTMLElement) => void;
  readonly onChoice: (choice: ReplyChoice, reply: ReplyMessage) => void;
  readonly onCopied: (text: string) => void;
}

export interface Thread {
  /** replaces the whole thread; `note` is a sentence set after the last message (a past conversation says how it goes on) */
  setMessages(messages: readonly Message[], note?: string | null): void;
  /** changes one message in place, or adds it at the end */
  put(message: Message): void;
  remove(id: string): void;
  /** the reply whose canvas is open, marked on its card */
  setOpenTurn(turn: string | null): void;
  scrollToEnd(): void;
  /** a message's own element, for a test or a focus */
  elementOf(id: string): HTMLElement | null;
}

const MIC = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/></svg>';
const CANVAS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className !== undefined) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

export function mountThread(host: HTMLElement, handlers: ThreadHandlers): Thread {
  const list = el('ol', 'thread');
  list.setAttribute('aria-label', 'Messages');
  host.append(list);
  const rows = new Map<string, HTMLLIElement>();
  const replies = new Map<string, ReplyMessage>();
  let note: HTMLElement | null = null;
  let openTurn: string | null = null;

  const nearEnd = (): boolean => host.scrollHeight - host.scrollTop - host.clientHeight < 96;
  const scrollToEnd = (): void => {
    host.scrollTop = host.scrollHeight;
  };

  const userRow = (message: Extract<Message, { role: 'user' }>): HTMLLIElement => {
    const row = el('li', `msg msg--user${message.quiet ? ' msg--quiet' : ''}`);
    row.append(el('h3', 'vh', message.quiet ? 'You did this' : 'You said'));
    const bubble = el('div', 'bubble');
    if (message.photos.length > 0) {
      const photos = el('ul', 'bubble__photos');
      photos.setAttribute('aria-label', message.photos.length === 1 ? 'Photo' : 'Photos');
      for (const photo of message.photos) {
        const item = el('li');
        const image = el('img');
        image.src = photo.url;
        image.alt = photo.alt;
        image.loading = 'lazy';
        item.append(image);
        photos.append(item);
      }
      bubble.append(photos);
    }
    if (message.voice || message.inked) {
      const tag = el('p', 'bubble__tag');
      tag.insertAdjacentHTML('beforeend', message.voice ? MIC : PENCIL);
      tag.append(el('span', undefined, message.voice ? 'Voice note, read on this Mac' : 'With a drawing'));
      bubble.append(tag);
    }
    bubble.append(document.createTextNode(message.said));
    row.append(bubble);
    return row;
  };

  const replyRow = (message: ReplyMessage): HTMLLIElement => {
    const row = el('li', 'msg msg--reply');
    row.append(el('h3', 'vh', 'Conduit replied'));
    const body = el('div', 'reply');
    const { words, choices, drew } = message.reply;
    if (message.state === 'working' && words.length === 0 && drew.length === 0) {
      const thinking = el('p', 'reply__thinking');
      thinking.setAttribute('role', 'status');
      const dots = el('span', 'reply__dots');
      dots.setAttribute('aria-hidden', 'true');
      dots.append(el('i'), el('i'), el('i'));
      thinking.append(dots, el('span', undefined, 'Thinking'));
      body.append(thinking);
    }
    for (const line of words) body.append(el('p', undefined, line));
    if (message.note !== null) {
      const sentence = el('p', message.state === 'failed' ? 'reply__note' : 'reply__note reply__note--quiet', message.note);
      if (message.state === 'failed') sentence.setAttribute('role', 'alert');
      body.append(sentence);
    }
    if (choices.length > 0) {
      const chips = el('ul', 'reply__choices');
      chips.setAttribute('aria-label', 'Ways to go on');
      choices.forEach((choice, index) => {
        const item = el('li');
        const chip = el('button', 'chip', choice.text);
        chip.type = 'button';
        chip.dataset['focus'] = `choice-${index}`;
        chip.disabled = !choice.open;
        chip.addEventListener('click', () => handlers.onChoice(choice, message));
        item.append(chip);
        chips.append(item);
      });
      body.append(chips);
    }
    const canOpen = message.turn !== null;
    if (canOpen && drew.length > 0) {
      const card = el('button', 'card');
      card.type = 'button';
      card.dataset['focus'] = 'card';
      if (openTurn === message.turn) card.setAttribute('aria-current', 'true');
      if (message.still !== null) {
        const thumb = el('img', 'card__thumb');
        thumb.src = message.still;
        thumb.alt = '';
        card.append(thumb);
      }
      const text = el('span', 'card__text');
      text.append(el('span', 'card__label', 'Open canvas'));
      if (drew.length > 0) text.append(el('span', 'card__kinds', drew.join(', ')));
      card.append(text);
      card.addEventListener('click', () => handlers.onOpenCanvas(message, card));
      body.append(card);
    }
    const tools = el('div', 'reply__tools');
    if (canOpen && drew.length === 0) {
      const open = el('button', 'sh-btn sh-btn--text');
      open.type = 'button';
      open.dataset['focus'] = 'open';
      if (openTurn === message.turn) open.setAttribute('aria-current', 'true');
      open.insertAdjacentHTML('beforeend', CANVAS);
      open.append(el('span', undefined, 'Open canvas'));
      open.addEventListener('click', () => handlers.onOpenCanvas(message, open));
      tools.append(open);
    }
    if (words.length > 0 && message.state !== 'working') {
      const copy = el('button', 'sh-btn sh-btn--text');
      copy.type = 'button';
      copy.dataset['focus'] = 'copy';
      copy.insertAdjacentHTML('beforeend', COPY);
      copy.append(el('span', undefined, 'Copy'));
      copy.addEventListener('click', () => handlers.onCopied(words.join('\n\n')));
      tools.append(copy);
    }
    if (tools.childElementCount > 0) body.append(tools);
    row.append(body);
    return row;
  };

  const build = (message: Message): HTMLLIElement => {
    const row = message.role === 'user' ? userRow(message) : replyRow(message);
    row.dataset['id'] = message.id;
    if (message.role === 'reply') replies.set(message.id, message);
    return row;
  };

  const empty = (): HTMLLIElement => {
    const row = el('li', 'thread__empty');
    row.append(el('h2', undefined, 'Ask anything'));
    row.append(el('p', undefined, 'Type, add a photo, or speak. Each reply can open on the canvas beside this conversation.'));
    return row;
  };

  const sync = (): void => {
    const first = list.firstElementChild;
    if (rows.size === 0 && first === null) list.append(empty());
    else if (rows.size > 0 && first instanceof HTMLElement && first.classList.contains('thread__empty')) first.remove();
  };

  const keepFocus = (row: HTMLElement, replace: () => void): void => {
    const active = document.activeElement;
    const key = active instanceof HTMLElement && row.contains(active) ? active.dataset['focus'] : undefined;
    replace();
    if (key !== undefined) row.parentElement?.querySelector<HTMLElement>(`[data-id="${CSS.escape(row.dataset['id'] ?? '')}"] [data-focus="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  };

  return {
    setMessages(messages, after = null) {
      list.replaceChildren();
      rows.clear();
      replies.clear();
      note = null;
      for (const message of messages) {
        const row = build(message);
        rows.set(message.id, row);
        list.append(row);
      }
      if (after !== null) {
        const item = el('li');
        note = el('p', 'thread__note', after);
        item.append(note);
        list.append(item);
      }
      sync();
      scrollToEnd();
    },
    put(message) {
      const follow = nearEnd();
      const had = rows.get(message.id);
      const row = build(message);
      if (had !== undefined) {
        keepFocus(had, () => had.replaceWith(row));
      } else {
        list.append(row);
      }
      rows.set(message.id, row);
      sync();
      if (follow || had === undefined) scrollToEnd();
    },
    remove(id) {
      rows.get(id)?.remove();
      rows.delete(id);
      replies.delete(id);
      sync();
    },
    setOpenTurn(turn) {
      openTurn = turn;
      for (const [id, message] of replies) {
        const row = rows.get(id);
        const mark = row?.querySelector<HTMLElement>('[data-focus="card"], [data-focus="open"]');
        if (mark === undefined || mark === null) continue;
        if (turn !== null && message.turn === turn) mark.setAttribute('aria-current', 'true');
        else mark.removeAttribute('aria-current');
      }
    },
    scrollToEnd,
    elementOf: (id) => rows.get(id) ?? null,
  };
}
