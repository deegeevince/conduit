// The thread: the person's words, photos and voice notes on one side, Conduit's replies on the other. A reply that can open the canvas has a button for it (a card with
// the resting picture when it drew). Plain DOM, selectable text, and a list a screen reader can walk message by message.

import type { Message, ReplyChoice, ReplyMessage } from './model';
import { phaseKind, span as spanOf, summaryLine, timelineOf } from './trace';
import type { Entry } from './trace';

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
  // one polite voice for the whole thread: it says what a reply being made has moved on to (drawing, looking, fixing), never counts or times
  const voice = el('div', 'vh');
  voice.setAttribute('role', 'status');
  voice.setAttribute('aria-live', 'polite');
  host.append(voice);
  const spoken = new Map<string, string>();
  /** per reply: whether "how it was made" is open, and which raw-lines boxes in it are */
  const traceUi = new Map<string, { open: boolean; raw: Set<string>; scroll: Map<string, number> }>();
  const uiOf = (id: string): { open: boolean; raw: Set<string>; scroll: Map<string, number> } => {
    let held = traceUi.get(id);
    if (held === undefined) {
      held = { open: false, raw: new Set(), scroll: new Map() };
      traceUi.set(id, held);
    }
    return held;
  };
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

  const entryNode = (message: ReplyMessage, entry: Entry): HTMLLIElement => {
    const ui = uiOf(message.id);
    const item = el('li', `trace__item${entry.tone === undefined || entry.tone === 'plain' ? '' : ` trace__item--${entry.tone}`}`);
    const when = el('span', 'trace__at');
    if (entry.at !== null) {
      when.append(el('span', 'vh', 'At '), document.createTextNode(spanOf(entry.at)));
    } else {
      when.setAttribute('aria-hidden', 'true');
    }
    const what = el('div', 'trace__what');
    what.append(el('p', 'trace__title', entry.title));
    if (entry.detail !== undefined) what.append(el('p', 'trace__detail', entry.detail));
    if (entry.raw !== undefined) what.append(el('code', 'trace__line', entry.raw));
    if (entry.lines !== undefined) {
      const key = `${message.id}:${entry.key}`;
      const boxId = `trace-raw-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      const open = ui.raw.has(entry.key);
      const button = el('button', 'trace__more');
      button.type = 'button';
      button.dataset['focus'] = `raw-${entry.key}`;
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-controls', boxId);
      button.textContent = open ? `Hide the raw ${entry.lines.label}` : `Show the raw ${entry.lines.label}`;
      const box = el('pre', 'trace__raw', entry.lines.text);
      box.id = boxId;
      box.tabIndex = 0;
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', `Raw Series ${entry.lines.label}`);
      box.dataset['scrollKey'] = entry.key;
      box.hidden = !open;
      button.addEventListener('click', () => {
        const now = button.getAttribute('aria-expanded') !== 'true';
        if (now) ui.raw.add(entry.key);
        else ui.raw.delete(entry.key);
        button.setAttribute('aria-expanded', String(now));
        button.textContent = now ? `Hide the raw ${entry.lines?.label ?? ''}` : `Show the raw ${entry.lines?.label ?? ''}`;
        box.hidden = !now;
      });
      what.append(button, box);
    }
    item.append(when, what);
    return item;
  };

  /** the quiet line under a reply, and the timeline behind it */
  const traceNode = (message: ReplyMessage): HTMLElement | null => {
    const trace = message.trace;
    if (trace === null) return null;
    const ui = uiOf(message.id);
    const wrap = el('div', `trace${message.state === 'working' ? ' trace--live' : ''}`);
    const panelId = `trace-${message.id}`;
    const button = el('button', 'trace__toggle');
    button.type = 'button';
    button.dataset['focus'] = 'trace';
    button.setAttribute('aria-expanded', String(ui.open));
    button.setAttribute('aria-controls', panelId);
    const chevron = el('span', 'trace__chev');
    chevron.setAttribute('aria-hidden', 'true');
    button.append(chevron, el('span', 'trace__summary', summaryLine(trace, message.state === 'working' ? message.elapsedMs : null)));
    const panel = el('div', 'trace__panel');
    panel.id = panelId;
    panel.hidden = !ui.open;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'How this reply was made');
    const fill = (): void => {
      const entries = timelineOf(trace);
      const listing = el('ol', 'trace__list');
      for (const entry of entries) listing.append(entryNode(message, entry));
      panel.replaceChildren(listing);
      for (const box of panel.querySelectorAll<HTMLElement>('pre[data-scroll-key]')) box.scrollTop = ui.scroll.get(box.dataset['scrollKey'] ?? '') ?? 0;
    };
    if (ui.open) fill();
    button.addEventListener('click', () => {
      ui.open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(ui.open));
      panel.hidden = !ui.open;
      if (ui.open) fill();
    });
    wrap.append(button, panel);
    return wrap;
  };

  const speak = (message: ReplyMessage): void => {
    if (message.trace === null) return;
    if (message.state !== 'working') {
      spoken.delete(message.id);
      return;
    }
    const kind = phaseKind(message.trace);
    if (spoken.get(message.id) === kind) return;
    const first = !spoken.has(message.id);
    spoken.set(message.id, kind);
    if (!first) voice.textContent = `Conduit is ${kind}`;
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
    const how = traceNode(message);
    if (how !== null) body.append(how);
    speak(message);
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
      traceUi.clear();
      spoken.clear();
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
      const before = replies.get(message.id);
      // only the trace moved (an event of the turn, a tick of the clock): that one node is swapped, so a reader's place in the row stays
      if (had !== undefined && before !== undefined && message.role === 'reply') {
        const strip = (reply: ReplyMessage): string => JSON.stringify({ ...reply, trace: null, elapsedMs: null });
        const old = had.querySelector<HTMLElement>('.trace');
        if (old !== null && strip(before) === strip(message)) {
          for (const box of old.querySelectorAll<HTMLElement>('pre[data-scroll-key]')) uiOf(message.id).scroll.set(box.dataset['scrollKey'] ?? '', box.scrollTop);
          replies.set(message.id, message);
          const fresh = traceNode(message);
          if (fresh !== null) keepFocus(had, () => old.replaceWith(fresh));
          speak(message);
          return;
        }
      }
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
      traceUi.delete(id);
      spoken.delete(id);
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
