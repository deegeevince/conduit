// The taste page. Built for a thumb on a phone: one answer fills the screen, two big buttons sit under it, and a word
// is one tap on a chip (or a few letters). Scoring moves straight on to the next. The judge's score is not on this page
// until the twenty are done. Everything is saved on the server after each tap, so leaving and coming back is safe.

import { API } from '@conduit/language';
import type { ExploreResult, TasteCard, TasteRequest, TasteState } from '@conduit/language';
import { h } from '../explore/dom';
import { REFERENCE, play } from './play';
import type { Playing } from './play';

const WORDS = ['clear', 'lovely', 'messy', 'boring', 'wrong', 'cramped'] as const;

async function send(body: TasteRequest | null): Promise<TasteState> {
  const response = await fetch(API.taste, body === null ? { headers: { accept: 'application/json' } } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()) as TasteState;
}

const results = new Map<string, Promise<ExploreResult>>();
function resultOf(card: TasteCard): Promise<ExploreResult> {
  const key = `${card.run}/${card.answer}`;
  let found = results.get(key);
  if (found === undefined) {
    found = fetch(API.exploreResult(card.run, card.answer)).then((response) => {
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json() as Promise<ExploreResult>;
    });
    results.set(key, found);
    found.catch(() => results.delete(key));
  }
  return found;
}

export function startPage(): void {
  const mount = document.getElementById('app');
  if (mount === null) return;
  const root: HTMLElement = mount;
  let state: TasteState | null = null;
  let playing: Playing | null = null;
  let shown = '';
  let word = '';
  let busy = false;

  const stop = (): void => {
    playing?.dispose();
    playing = null;
  };

  const message = (text: string, action?: { label: string; run: () => void }): void => {
    stop();
    shown = '';
    root.replaceChildren(
      h('main', { class: 'plain' }, h('p', { class: 'big', text }), action === undefined ? null : h('button', { class: 'go', text: action.label, attrs: { type: 'button' }, on: { click: action.run } })),
    );
  };

  const apply = (next: TasteState): void => {
    state = next;
    word = '';
    draw();
  };

  const failed = (): void => message('The server did not answer. Is it running?', { label: 'Try again', run: () => void load() });

  async function load(): Promise<void> {
    try {
      apply(await send(null));
    } catch {
      failed();
    }
  }

  async function answer(up: boolean, said: string): Promise<void> {
    const current = state;
    if (busy || current === null || current.next === null) return;
    busy = true;
    try {
      apply(await send({ id: current.id, run: current.next.run, answer: current.next.answer, up, word: said.trim() }));
    } catch {
      failed();
    } finally {
      busy = false;
    }
  }

  async function undo(): Promise<void> {
    const current = state;
    if (busy || current === null || current.scored === 0) return;
    busy = true;
    try {
      apply(await send({ id: current.id, undo: true }));
    } catch {
      failed();
    } finally {
      busy = false;
    }
  }

  function done(finished: TasteState): void {
    stop();
    shown = '';
    const result = finished.result;
    if (result === null) return;
    root.replaceChildren(
      h(
        'main',
        { class: 'plain' },
        h('p', { class: 'big', text: result.line }),
        result.differ.length === 0 ? h('p', { class: 'quiet', text: 'You and the judge agreed on every one.' }) : h('h2', { text: 'Where you and the judge differ' }),
        h(
          'ul',
          { class: 'differ' },
          ...result.differ.map((item) =>
            h(
              'li',
              {},
              h('p', { class: 'said', text: item.prompt }),
              h('p', { class: 'quiet', text: `you ${item.up ? 'liked' : 'did not like'} it${item.word === '' ? '' : ` ("${item.word}")`}; the judge gave ${item.judge} of 5` }),
            ),
          ),
        ),
        h('button', { class: 'go', text: 'Another twenty', attrs: { type: 'button' }, on: { click: () => void send({ new: true }).then(apply, failed) } }),
      ),
    );
  }

  function draw(): void {
    const current = state;
    if (current === null) return;
    if (current.empty !== null) return message(current.empty);
    const card = current.next;
    if (card === null) return done(current);
    for (const ahead of current.ahead) void resultOf(ahead).catch(() => undefined);

    const key = `${card.run}/${card.answer}/${current.scored}`;
    if (key === shown) return;
    shown = key;
    stop();

    const stage = h('div', { class: 'stage', attrs: { role: 'img', 'aria-label': 'The answer, playing. Tap to play it again.' } });
    const screen = h('div', { class: 'screen' }, stage);
    const note = h('p', { class: 'quiet note', text: 'loading' });
    screen.append(note);
    const fit = (): void => {
      stage.style.transform = `scale(${screen.clientWidth / REFERENCE.width})`;
    };
    new ResizeObserver(fit).observe(screen);

    const field = h('input', { class: 'word', attrs: { type: 'text', placeholder: 'a word, if you like', maxlength: '40', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'A word about it' } });
    field.addEventListener('input', () => {
      word = field.value;
      for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.textContent === word));
    });
    const chips = WORDS.map((text) =>
      h('button', {
        class: 'chip',
        text,
        attrs: { type: 'button', 'aria-pressed': 'false' },
        on: {
          click: () => {
            word = word === text ? '' : text;
            field.value = word;
            for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.textContent === word));
          },
        },
      }),
    );
    const down = h('button', { class: 'thumb down', attrs: { type: 'button', 'aria-label': 'Thumbs down' } }, h('span', { class: 'icon', text: '\u{1F44E}', attrs: { 'aria-hidden': 'true' } }));
    const up = h('button', { class: 'thumb up', attrs: { type: 'button', 'aria-label': 'Thumbs up' } }, h('span', { class: 'icon', text: '\u{1F44D}', attrs: { 'aria-hidden': 'true' } }));
    down.addEventListener('click', () => void answer(false, word));
    up.addEventListener('click', () => void answer(true, word));
    const back = h('button', { class: 'link', text: 'undo', attrs: { type: 'button' }, on: { click: () => void undo() } });
    back.hidden = current.scored === 0;

    root.replaceChildren(
      h('progress', { class: 'bar', attrs: { max: String(current.total), value: String(current.scored), 'aria-label': 'Answers scored' } }),
      h(
        'main',
        { class: 'sheet' },
        h('p', { class: 'count', text: `${current.scored + 1} of ${current.total}` }),
        screen,
        h('p', { class: 'prompt', text: card.prompt }),
        h('div', { class: 'chips' }, ...chips),
        field,
      ),
      h('footer', { class: 'thumbs' }, down, up, back),
    );
    fit();

    void resultOf(card)
      .then(async (result) => {
        if (shown !== key) return;
        const live = await play(stage, result);
        if (shown !== key) return live.dispose();
        playing = live;
        note.remove();
        screen.addEventListener('click', () => live.replay());
      })
      .catch((error: unknown) => {
        console.warn('taste: could not play', card.answer, error);
        note.textContent = 'This answer could not be shown here. Score it from the prompt, or skip it by tapping a thumb.';
      });
  }

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) {
      if (event.key === 'Enter') event.target.blur(); // the keyboard's own "done" must not count as a thumb
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      void answer(true, word);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void answer(false, word);
    }
  });

  message('Loading');
  void load();
}
