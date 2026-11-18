import { AMBIENT_KINDS } from '@conduit/language';
import type { Painter, TranscriptEvent } from '../contracts/painter';
import type { ComposerMenu, MenuEntryHandle } from './menu';

export interface Transcript {
  /** shows or hides the visible panel; the live region is always present */
  setOpen(open: boolean): void;
  /** opens the panel with the given turn's heading at the top; focus does not move */
  revealTurn(turn: string): void;
  /** The wall (WL3): marks the turn whose frame the camera has settled on, and brings its heading into view if the panel is open. null clears the mark. */
  markTurn(turn: string | null): void;
  /** What a turn has said so far, read from the transcript's own lines: the words still standing, the choices it offers (with the key that taps one), and what it drew. The chat shell's reply text. */
  replyOf(turn: string): TranscriptReply;
  dispose(): void;
}

export interface TranscriptReply {
  readonly words: readonly string[];
  readonly choices: readonly { readonly key: string; readonly text: string; readonly open: boolean }[];
  readonly drawn: readonly string[];
}

const LIVE_LIMIT = 200;

/** How a drawn thing is described (`describeFigure`), for the moment the painter's snapshot has not caught up with the event. */
const DRAWN_TEXT = /^((circle|ellipse|rect|line|poly|path) \d+x\d+ at |sprite \d+x\d+|group$|copy of )/;
const PANEL_LIMIT = 4000;
/** names the brain chose, as against the `x6` the stage gives something unnamed */
const UNNAMED = /^(x\d+|-|)$/;
const NAMES_SHOWN = 10;
const DRAWN_QUIET_MS = 700;

/** One drawing, however many shapes it took: what is announced and listed instead of each shape's geometry. */
interface Drawing {
  readonly item: HTMLElement;
  readonly text: HTMLElement;
  readonly names: string[];
  unnamed: number;
  /** names not yet spoken to the live region */
  fresh: string[];
  freshUnnamed: number;
}

function say(names: readonly string[], unnamed: number): string {
  const shown = names.slice(0, NAMES_SHOWN);
  const parts = [...shown];
  const more = names.length - shown.length;
  if (more > 0) parts.push(`${more} more`);
  if (unnamed > 0) parts.push(unnamed === 1 ? 'one unnamed mark' : `${unnamed} unnamed marks`);
  if (parts.length === 0) return '';
  const last = parts.pop() ?? '';
  return parts.length === 0 ? last : `${parts.join(', ')} and ${last}`;
}

interface Entry {
  readonly paragraph: HTMLElement;
  readonly text: HTMLElement;
  readonly button: HTMLButtonElement | null;
}

let counter = 0;

/**
 * The words, always available as text. Everything the stage shows is appended
 * here as it appears: to a polite live region for screen readers and to a
 * panel anyone can open. Struck text stays, marked as struck. Choices are
 * real buttons, so the stage can be driven from the keyboard.
 */
export function mountTranscript(host: HTMLElement, painter: Painter, handlers: { /** the composer's [+] menu: the Transcript is one of its entries */ readonly menu: ComposerMenu; readonly onChoice: (key: string) => void; /** copies the words of a turn's answer as Markdown; absent: no button */ readonly onCopyAnswer?: (turn: string) => void; /** the wall: a turn's heading was tapped (not its Copy button) and the camera should fly to its frame; absent: headings are only text */ readonly onTurnTap?: (turn: string) => void; /** the wall restages an older frame as a page of the app's own: that page is not said again in the transcript */ readonly skipPages?: boolean }): Transcript {
  counter += 1;
  const panelId = `transcript-panel-${counter}`;

  const panel = document.createElement('section');
  panel.className = 'transcript__panel';
  panel.id = panelId;
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Transcript');
  panel.setAttribute('role', 'region');

  const body = document.createElement('div');
  body.className = 'transcript__body';
  const empty = document.createElement('p');
  empty.className = 'transcript__empty';
  empty.textContent = 'Nothing has been said yet.';
  body.append(empty);
  panel.append(body);

  const live = document.createElement('div');
  live.className = 'visually-hidden';
  live.setAttribute('role', 'log');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-relevant', 'additions');
  live.setAttribute('aria-label', 'Spoken text');

  host.append(panel, live);
  const toggle: MenuEntryHandle = handlers.menu.add({ id: 'transcript', label: 'Transcript', gist: 'everything said, as text', order: 50, check: true, checked: false, run: () => setOpen(!open) });

  const entries = new Map<string, Entry>();
  const headings = new Map<string, HTMLElement>();
  /** paintings whose fate is not yet known: key to the line to complete */
  const waiting = new Map<string, { readonly text: HTMLElement; readonly base: string }>();
  let watcher: ReturnType<typeof setInterval> | undefined;
  let open = false;
  let kindCache: Map<string, string> | null = null;
  /** the drawing the next drawn thing joins; any words, choice or heading ends it */
  let drawing: Drawing | null = null;
  let drawnTimer: ReturnType<typeof setTimeout> | undefined;

  const kindOf = (key: string): string | null => {
    if (kindCache === null) {
      kindCache = new Map(painter.snapshot().elements.map((element) => [element.key, element.kind]));
      queueMicrotask(() => {
        kindCache = null;
      });
    }
    return kindCache.get(key) ?? null;
  };

  const watchPaintings = (): void => {
    const views = painter.snapshot().elements;
    for (const [key, entry] of [...waiting]) {
      const view = views.find((element) => element.key === key);
      if (view === undefined) {
        // gone before its fate was known: the sketch is all that was ever seen
        entry.text.textContent = `${entry.base} (sketch only)`;
        waiting.delete(key);
      } else if (view.painting === 'unpainted') {
        entry.text.textContent = `${entry.base} (sketch only)`;
        waiting.delete(key);
      } else if (view.painting === 'painted') {
        waiting.delete(key);
      }
    }
    if (waiting.size === 0 && watcher !== undefined) {
      clearInterval(watcher);
      watcher = undefined;
    }
  };

  const revealTurn = (turn: string): void => {
    setOpen(true);
    const heading = headings.get(turn);
    if (heading !== undefined) body.scrollTop = Math.max(0, heading.offsetTop - body.offsetTop);
  };

  let marked: string | null = null;
  const markTurn = (turn: string | null): void => {
    if (marked !== null) {
      const old = headings.get(marked);
      old?.classList.remove('transcript__turn--here');
      old?.removeAttribute('aria-current');
    }
    marked = turn;
    if (turn === null) return;
    const heading = headings.get(turn);
    if (heading === undefined) return;
    heading.classList.add('transcript__turn--here');
    heading.setAttribute('aria-current', 'true');
    if (open) {
      const top = heading.offsetTop - body.offsetTop;
      if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - heading.offsetHeight) body.scrollTop = Math.max(0, top - 8);
    }
  };

  const setOpen = (next: boolean): void => {
    open = next;
    panel.hidden = !next;
    toggle.set({ checked: next });
    if (next) body.scrollTop = body.scrollHeight;
  };
  // No tab stop of its own: the panel is a labelled region, and the scrolling body is focusable by the browser when it has nothing focusable inside.
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    setOpen(false);
    handlers.menu.button.focus();
  };
  panel.addEventListener('keydown', closeOnEscape);

  const bar = host.closest<HTMLElement>('.bar');
  const measure = (): void => {
    const height = bar?.getBoundingClientRect().height ?? 0;
    panel.style.setProperty('--bar-height', `${Math.ceil(height)}px`);
  };
  measure();
  const observer = typeof ResizeObserver === 'undefined' || bar === null ? null : new ResizeObserver(measure);
  if (bar !== null) observer?.observe(bar);

  const stickToEnd = (add: () => void): void => {
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    add();
    if (atEnd && open) body.scrollTop = body.scrollHeight;
  };

  let partsFresh: string[] = [];
  let partsTimer: ReturnType<typeof setTimeout> | undefined;
  const flushParts = (): void => {
    clearTimeout(partsTimer);
    partsTimer = undefined;
    if (partsFresh.length === 0) return;
    const shown = partsFresh.slice(0, NAMES_SHOWN);
    const more = partsFresh.length - shown.length;
    partsFresh = [];
    announce(`Parts: ${say(shown, 0)}${more > 0 ? ` and ${more} more` : ''}.`);
  };

  /** Speaks what has been drawn since the last time, as one sentence, once the drawing pauses. */
  const flushDrawn = (): void => {
    clearTimeout(drawnTimer);
    drawnTimer = undefined;
    const current = drawing;
    if (current === null || (current.fresh.length === 0 && current.freshUnnamed === 0)) return;
    const sentence = `Drawn: ${say(current.fresh, current.freshUnnamed)}.`;
    current.fresh = [];
    current.freshUnnamed = 0;
    const item = document.createElement('p');
    item.textContent = sentence;
    live.append(item);
    while (live.childElementCount > LIVE_LIMIT) live.firstElementChild?.remove();
  };

  const announce = (text: string): void => {
    flushDrawn();
    const item = document.createElement('p');
    item.textContent = text;
    live.append(item);
    while (live.childElementCount > LIVE_LIMIT) live.firstElementChild?.remove();
  };

  const trim = (): void => {
    while (body.childElementCount > PANEL_LIMIT) {
      const first = body.firstElementChild;
      if (first === null) break;
      // what leaves the panel leaves the maps too
      if (first instanceof HTMLElement) {
        const turn = first.dataset['turn'];
        if (turn !== undefined) headings.delete(turn);
        for (const holder of first.matches('[data-key]') ? [first] : first.querySelectorAll<HTMLElement>('[data-key]')) {
          const key = holder.dataset['key'];
          if (key !== undefined) {
            entries.delete(key);
            waiting.delete(key);
          }
        }
      }
      first.remove();
    }
  };

  /** inside a page the wall put up to show an older frame: nothing it says is said again */
  let inPage = false;
  const onEvent = (event: TranscriptEvent): void => {
    if (handlers.skipPages === true) {
      if (event.kind === 'turn') inPage = event.turn.startsWith('local-page-');
      if (inPage) return;
    }
    switch (event.kind) {
      case 'turn': {
        empty.remove();
        flushDrawn();
        drawing = null;
        const heading = document.createElement('h2');
        heading.className = 'transcript__turn';
        heading.dataset['turn'] = event.turn;
        const said = event.input.kind === 'prompt' ? 'You said' : event.input.kind === 'tap' ? 'You chose' : event.input.kind === 'act' ? (event.input.part === undefined ? 'You pressed' : 'You tapped') : event.input.kind === 'script' ? 'You played' : event.input.kind === 'refine' ? 'You went on' : event.input.kind === 'repair' ? 'Tidied' : 'Demo';
        const text = event.input.kind === 'act' && event.input.part !== undefined ? event.input.part.label : event.input.kind === 'prompt' || event.input.kind === 'tap' || event.input.kind === 'act' ? event.input.text : event.input.kind === 'script' ? 'a script' : event.input.kind === 'refine' ? event.input.note : event.input.kind === 'repair' ? 'the last answer' : event.input.script;
        const line = `${said}: ${text}`;
        heading.textContent = line;
        if (handlers.onCopyAnswer !== undefined) {
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'transcript__copy';
          copy.textContent = 'Copy answer';
          copy.setAttribute('aria-label', `Copy the answer to: ${text}`);
          const turn = event.turn;
          copy.addEventListener('click', () => handlers.onCopyAnswer?.(turn));
          heading.append(' ', copy);
        }
        if (handlers.onTurnTap !== undefined) {
          const turn = event.turn;
          heading.classList.add('transcript__turn--tappable');
          heading.tabIndex = 0;
          heading.setAttribute('role', 'button');
          heading.setAttribute('aria-label', `Go to the frame for: ${text}`);
          heading.addEventListener('click', (click) => {
            if (click.target instanceof Element && click.target.closest('.transcript__copy') !== null) return;
            handlers.onTurnTap?.(turn);
          });
          heading.addEventListener('keydown', (key) => {
            if ((key.key !== 'Enter' && key.key !== ' ') || key.target !== heading) return;
            key.preventDefault();
            handlers.onTurnTap?.(turn);
          });
        }
        headings.set(event.turn, heading);
        stickToEnd(() => body.append(heading));
        announce(line);
        trim();
        return;
      }
      case 'shown': {
        empty.remove();
        const kind = kindOf(event.key);
        const picture = kind === 'picture' || event.text.startsWith('painting: ');
        // Weather is a line of its own however early it is heard about: "Weather: fireflies", never a bare description or an unnamed mark.
        const weather = kind === 'field' ? AMBIENT_KINDS.find((name) => event.text === name || event.text.startsWith(`${name},`)) : kind === null ? AMBIENT_KINDS.find((name) => event.text.startsWith(`${name}, `) && !event.tappable) : undefined;
        if (weather !== undefined) {
          flushDrawn();
          drawing = null;
          const paragraph = document.createElement('p');
          paragraph.className = 'transcript__line';
          paragraph.dataset['key'] = event.key;
          const text = document.createElement('span');
          text.textContent = `Weather: ${weather}`;
          paragraph.append(text);
          entries.set(event.key, { paragraph, text, button: null });
          stickToEnd(() => body.append(paragraph));
          announce(`Weather: ${weather}`);
          trim();
          return;
        }
        // A structure, its parts and a control are told in the painter's own words (`flow, 5 nodes`, `node: Pump`, `slider 0 to 10`), not as
        // unnamed marks: what a diagram or an instrument holds is what a reader needs.
        if (!event.tappable && (kind === 'structure' || kind === 'node' || kind === 'link' || kind === 'control')) {
          const word = kind === 'structure' ? 'Diagram' : kind === 'control' ? 'Control' : kind === 'node' ? 'Part' : 'Link';
          const cleaned = event.text.replace(/^(node|link|control): /, '');
          flushDrawn();
          drawing = null;
          const item = document.createElement('li');
          item.className = 'transcript__thing';
          item.dataset['key'] = event.key;
          const text = document.createElement('span');
          text.textContent = `${word}: ${cleaned}`;
          item.append(text);
          entries.set(event.key, { paragraph: item, text, button: null });
          let list = body.lastElementChild;
          stickToEnd(() => {
            if (!(list instanceof HTMLUListElement) || !list.classList.contains('transcript__things')) {
              list = document.createElement('ul');
              list.className = 'transcript__things';
              list.setAttribute('aria-label', 'Drawn');
              body.append(list);
            }
            list.append(item);
          });
          // parts are spoken together, once the diagram pauses; a structure or a control is told when it appears
          if (kind === 'node' || kind === 'link') {
            partsFresh.push(cleaned);
            clearTimeout(partsTimer);
            partsTimer = setTimeout(flushParts, DRAWN_QUIET_MS);
          } else {
            announce(`${word}: ${cleaned}`);
          }
          trim();
          return;
        }
        const drawn = kind === null ? DRAWN_TEXT.test(event.text) : kind !== 'text';
        if (!event.tappable && (drawn || picture)) {
          const addToList = (item: HTMLElement): void => {
            let list = body.lastElementChild;
            if (!(list instanceof HTMLUListElement) || !list.classList.contains('transcript__things')) {
              list = document.createElement('ul');
              list.className = 'transcript__things';
              list.setAttribute('aria-label', 'Drawn');
              body.append(list);
            }
            list.append(item);
          };
          if (picture) {
            flushDrawn();
            drawing = null;
            const item = document.createElement('li');
            item.className = 'transcript__thing';
            item.dataset['key'] = event.key;
            const text = document.createElement('span');
            const base = event.text;
            text.textContent = base;
            item.append(text);
            if (event.replaces !== null) entries.get(event.replaces)?.paragraph.classList.add('transcript__line--replaced');
            entries.set(event.key, { paragraph: item, text, button: null });
            stickToEnd(() => addToList(item));
            announce(base);
            waiting.set(event.key, { text, base });
            watcher ??= setInterval(watchPaintings, 400);
            trim();
            return;
          }
          // Shapes, sprites and groups are one drawing: the names the brain chose, not their geometry.
          let current = drawing;
          if (current === null || !current.item.isConnected) {
            const item = document.createElement('li');
            item.className = 'transcript__thing';
            const text = document.createElement('span');
            item.append(text);
            current = { item, text, names: [], unnamed: 0, fresh: [], freshUnnamed: 0 };
            drawing = current;
            const made = current;
            stickToEnd(() => addToList(made.item));
          }
          if (UNNAMED.test(event.id)) {
            current.unnamed += 1;
            current.freshUnnamed += 1;
          } else if (!current.names.includes(event.id)) {
            current.names.push(event.id);
            current.fresh.push(event.id);
          }
          current.text.textContent = `Drawn: ${say(current.names, current.unnamed)}.`;
          clearTimeout(drawnTimer);
          drawnTimer = setTimeout(flushDrawn, DRAWN_QUIET_MS);
          trim();
          return;
        }
        flushDrawn();
        drawing = null;
        const paragraph = document.createElement('p');
        paragraph.className = 'transcript__line';
        paragraph.dataset['key'] = event.key;
        const text = document.createElement('span');
        text.textContent = event.text;
        paragraph.append(text);
        let button: HTMLButtonElement | null = null;
        if (event.tappable) {
          button = document.createElement('button');
          button.type = 'button';
          button.className = 'transcript__choice';
          button.textContent = event.text;
          const key = event.key;
          button.addEventListener('click', () => handlers.onChoice(key));
          paragraph.replaceChildren(button);
        }
        if (event.replaces !== null) {
          const old = entries.get(event.replaces);
          old?.paragraph.classList.add('transcript__line--replaced');
        }
        entries.set(event.key, { paragraph, text, button });
        stickToEnd(() => body.append(paragraph));
        announce(event.tappable ? `Choice: ${event.text}` : event.text);
        trim();
        return;
      }
      case 'told': {
        // a diagram whose cells follow a control: its line keeps saying what the cells show
        const entry = entries.get(event.key);
        if (entry !== undefined && entry.paragraph.classList.contains('transcript__thing') && !entry.paragraph.classList.contains('transcript__line--struck')) entry.text.textContent = `Diagram: ${event.text}`;
        return;
      }
      case 'struck': {
        const entry = entries.get(event.key);
        if (entry === undefined || entry.paragraph.classList.contains('transcript__line--struck')) return;
        entry.paragraph.classList.add('transcript__line--struck');
        const target = entry.button ?? entry.text;
        const strike = document.createElement('s');
        strike.append(...target.childNodes);
        const note = document.createElement('span');
        note.className = 'visually-hidden';
        note.textContent = ' (struck out)';
        target.append(strike, note);
        return;
      }
      case 'gone': {
        const entry = entries.get(event.key);
        if (entry?.button) {
          entry.button.disabled = true;
          entry.button.setAttribute('aria-disabled', 'true');
        }
        return;
      }
    }
  };

  const off = painter.on('transcript', onEvent);
  // What the viewer set a control to is part of the record, as a line and to a screen reader. A press is the turn it opens.
  const offBack = painter.on('back', (event) => {
    if (event.type !== 'control' || event.send) return;
    const view = painter.snapshot().controls.find((candidate) => candidate.id === event.id);
    if (view?.control === 'button') return;
    const paragraph = document.createElement('p');
    paragraph.className = 'transcript__line';
    const text = document.createElement('span');
    const label = view === undefined || view.label === '' ? event.id : view.label;
    text.textContent = `Set ${label} to ${event.text}.`;
    paragraph.append(text);
    stickToEnd(() => body.append(paragraph));
    announce(text.textContent);
    trim();
  });

  const replyOf = (turn: string): TranscriptReply => {
    const words: string[] = [];
    const choices: { key: string; text: string; open: boolean }[] = [];
    const drawn: string[] = [];
    let at: Element | null = headings.get(turn)?.nextElementSibling ?? null;
    for (; at !== null && at.tagName !== 'H2'; at = at.nextElementSibling) {
      if (at instanceof HTMLUListElement) {
        for (const item of at.querySelectorAll('li')) drawn.push(item.textContent?.trim() ?? '');
        continue;
      }
      if (!(at instanceof HTMLElement) || !at.classList.contains('transcript__line')) continue;
      const choice = at.querySelector<HTMLButtonElement>('.transcript__choice');
      if (choice !== null) {
        choices.push({ key: at.dataset['key'] ?? '', text: choice.textContent?.trim() ?? '', open: !choice.disabled });
        continue;
      }
      if (at.classList.contains('transcript__line--replaced') || at.classList.contains('transcript__line--struck')) continue;
      const text = at.textContent?.trim() ?? '';
      if (text !== '') words.push(text);
    }
    return { words, choices, drawn: drawn.filter((text) => text !== '') };
  };

  return {
    setOpen,
    revealTurn,
    markTurn,
    replyOf,
    dispose() {
      off();
      offBack();
      clearTimeout(partsTimer);
      clearTimeout(drawnTimer);
      clearInterval(watcher);
      observer?.disconnect();
      toggle.remove();
      panel.remove();
      live.remove();
    },
  };
}
