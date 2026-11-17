// "Show the language": the pane that makes the stream visible. The model writes lines of Series; the page reads each one as its newline
// arrives and draws it. This pane is that reading, shown: the line being written is typed in a live row at its end (the stage never hears of it), each finished line is a row of its own, the one being drawn is lit by the
// painter's own schedule and playhead, and pointing at something on stage (hover or tap) lights the line that made it. Nothing is drawn
// over the stage itself.
//
// The stage keeps the rest of the room: the page's grid gives the pane a column (a row, on a phone) and the stage, resized by the page's own
// observer, lays itself out in what is left. The pane knows nothing of how the stage draws; it reads `painter.snapshot()` and the log.

import type { StageApp } from '../app/stage-app';
import { shownNote } from '../app/lang-log';
import type { LangEntry } from '../app/lang-log';
import { ensureMono, paletteOf, tokenize } from '../app/lang-style';
import type { PanePalette } from '../app/lang-style';
import type { ComposerMenu } from './menu';

const STORE = 'conduit.lines';
/** How long a tapped line (or tapped element) stays lit. */
const PIN_MS = 2600;
/** The line being drawn stays lit this long past the end of its drawing, and one that takes no time this long: enough to be seen. */
const HOLD = 0.4;

export interface LangPane {
  dispose(): void;
}

function remembered(): boolean {
  try {
    return window.localStorage.getItem(STORE) === 'on';
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    window.localStorage.setItem(STORE, on ? 'on' : 'off');
  } catch {
    // a private window: the switch simply starts off next time
  }
}

export function mountLangPane(root: HTMLElement, stage: HTMLElement, app: StageApp, menu: ComposerMenu): LangPane {
  const pane = document.createElement('aside');
  pane.className = 'lang';
  pane.hidden = true;
  pane.setAttribute('aria-label', 'The language: the lines of Series the page was sent');
  const head = document.createElement('div');
  head.className = 'lang__head';
  const title = document.createElement('span');
  title.textContent = 'Series';
  const sub = document.createElement('span');
  sub.textContent = 'typed as it arrives \u00b7 bar: on stage now';
  head.append(title, sub);
  const list = document.createElement('ol');
  list.className = 'lang__body';
  list.tabIndex = -1;
  list.setAttribute('aria-label', 'Lines');
  // shown only once the reader has scrolled the pane themselves: following the drawing is then theirs to resume
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'lang__follow';
  chip.textContent = 'Follow';
  chip.title = 'Follow what is being drawn';
  chip.hidden = true;
  pane.append(head, list, chip);
  root.insertBefore(pane, stage);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const rowOf = new Map<number, HTMLLIElement>();
  const entryOf = new WeakMap<HTMLLIElement, LangEntry>();
  let shownTurn: string | null = null;
  let shownCount = 0;
  let empty: HTMLElement | null = null;
  /** follow what is being drawn (or, while nothing is, the line being written) unless the reader has scrolled the pane themselves */
  let following = true;
  /** when a line was last being drawn (performance.now), and the row the pane last came to rest on */
  let lastDrawnAt = -1e9;
  let lastTarget = '';
  let lastRow: HTMLLIElement | null = null;
  const setFollowing = (on: boolean): void => {
    following = on;
    chip.hidden = on;
  };
  const instant = (): ScrollBehavior => (reduced.matches ? 'auto' : 'smooth');
  let pinned: { readonly id: string | null; readonly row: HTMLLIElement | null; readonly until: number } | null = null;
  let hovered: string | null = null;
  let rafHandle = 0;
  let lastTick = 0;

  // ---- colours: the look on stage, held to 4.5:1 on the pane's own ground
  let paletteKey = '';
  const colour = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const paint = (): PanePalette | null => {
    const roles = { ground: colour('--stage-ground'), ink: colour('--stage-ink'), dim: colour('--stage-dim'), accent: colour('--stage-accent') };
    const key = `${roles.ground}|${roles.ink}|${roles.dim}|${roles.accent}`;
    if (key === paletteKey || !roles.ground.startsWith('#') || !roles.ink.startsWith('#') || !roles.dim.startsWith('#') || !roles.accent.startsWith('#')) return null;
    paletteKey = key;
    const palette = paletteOf(roles);
    const style = pane.style;
    style.setProperty('--lang-ground', palette.ground);
    style.setProperty('--lang-edge', palette.edge);
    style.setProperty('--lang-verb', palette.text.verb);
    style.setProperty('--lang-id', palette.text.id);
    style.setProperty('--lang-key', palette.text.key);
    style.setProperty('--lang-value', palette.text.value);
    style.setProperty('--lang-bar', palette.text.bar);
    style.setProperty('--lang-words', palette.text.words);
    style.setProperty('--lang-now', palette.now);
    style.setProperty('--lang-pointed', palette.pointed);
    style.setProperty('--lang-note', palette.note);
    return palette;
  };
  const themeWatch = new MutationObserver(() => paint());
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---- rows
  const makeRow = (entry: LangEntry): HTMLLIElement => {
    const row = document.createElement('li');
    row.className = entry.kind === 'dropped' ? 'lang__row lang__row--dropped' : 'lang__row';
    row.tabIndex = 0;
    if (entry.seq >= 0) row.dataset['seq'] = String(entry.seq);
    if (entry.id !== null) row.dataset['id'] = entry.id;
    if (entry.kind === 'dropped') {
      row.append(entry.text);
    } else {
      for (const token of tokenize(entry.text)) {
        if (token.role === 'plain') row.append(token.text);
        else {
          const span = document.createElement('span');
          span.className = `t-${token.role}`;
          span.textContent = token.text;
          row.append(span);
        }
      }
    }
    const note = shownNote(entry);
    if (note !== null) {
      const quiet = document.createElement('span');
      quiet.className = 'lang__note';
      quiet.textContent = note;
      row.append(quiet);
    }
    entryOf.set(row, entry);
    return row;
  };

  // the live row: what is being written now, as far as it has got, with a cursor. It always sits last and is never an entry.
  let liveRow: HTMLLIElement | null = null;
  let liveText = '';
  const showLive = (): void => {
    const turn = app.lang.turn;
    const live = app.lang.live;
    if (live === null || turn === null || live.turn !== turn) {
      liveRow?.remove();
      liveRow = null;
      liveText = '';
      return;
    }
    if (liveRow === null) {
      liveRow = document.createElement('li');
      liveRow.className = 'lang__row lang__row--live';
      liveRow.setAttribute('aria-hidden', 'true');
      liveText = '';
    }
    if (live.text !== liveText) {
      liveText = live.text;
      const cursor = document.createElement('span');
      cursor.className = 'lang__cursor';
      const parts: (Node | string)[] = [];
      for (const token of tokenize(live.text)) {
        if (token.role === 'plain') parts.push(token.text);
        else {
          const span = document.createElement('span');
          span.className = `t-${token.role}`;
          span.textContent = token.text;
          parts.push(span);
        }
      }
      liveRow.replaceChildren(...parts, cursor);
    }
    if (liveRow.parentNode !== list || liveRow !== list.lastElementChild) list.append(liveRow);
  };

  const scrollEnd = (): void => {
    if (!following) return;
    list.scrollTop = list.scrollHeight;
  };

  /** bring a row to about a third from the top of the pane, unless it already sits comfortably in view */
  const reveal = (row: HTMLLIElement): void => {
    const box = list.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    const top = at.top - box.top;
    if (top >= box.height * 0.1 && at.bottom - box.top <= box.height * 0.7) return;
    list.scrollTo({ top: Math.max(0, list.scrollTop + top - box.height / 3), behavior: instant() });
  };

  const render = (): void => {
    const turn = app.lang.turn;
    const entries = turn === null ? [] : app.lang.entriesOf(turn);
    if (turn !== shownTurn || entries.length < shownCount) {
      list.replaceChildren();
      liveRow = null;
      liveText = '';
      rowOf.clear();
      shownTurn = turn;
      shownCount = 0;
      empty = null;
      setFollowing(true);
      lastDrawnAt = -1e9;
      lastTarget = '';
      lastRow = null;
    }
    if (entries.length === 0 && app.lang.live === null) {
      if (empty === null) {
        empty = document.createElement('li');
        empty.className = 'lang__empty';
        empty.textContent = 'Ask for something. Its lines show here as they arrive.';
        list.append(empty);
      }
      return;
    }
    if (empty !== null) {
      empty.remove();
      empty = null;
    }
    for (let index = shownCount; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const row = makeRow(entry);
      if (entry.seq >= 0) rowOf.set(entry.seq, row);
      if (liveRow !== null && liveRow.parentNode === list) liveRow.before(row);
      else list.append(row);
    }
    shownCount = entries.length;
    showLive();
    // while a line is being drawn the pane stays on it (tick); lines arriving ahead of the drawing do not pull it away
    if (performance.now() - lastDrawnAt > 1200 && (liveRow !== null || lastRow === null)) scrollEnd();
  };

  // the reader's own scrolling (wheel, finger, keys, the scrollbar) ends the following; the programmatic scroll never does
  const leave = (): void => setFollowing(false);
  list.addEventListener('wheel', leave, { passive: true });
  list.addEventListener('touchmove', leave, { passive: true });
  list.addEventListener('pointerdown', (event) => {
    if (event.target === list) leave();
  });
  list.addEventListener('keydown', (event) => {
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) leave();
  });
  chip.addEventListener('click', () => {
    setFollowing(true);
    lastTarget = '';
    if (lastRow !== null && performance.now() - lastDrawnAt <= 1200) reveal(lastRow);
    else if (liveRow !== null || lastRow === null) scrollEnd();
    else reveal(lastRow);
  });

  // ---- what made an element: pointing at something on stage lights its line; nothing is drawn over the stage
  const rowForId = (id: string): HTMLLIElement | null => {
    for (const row of list.querySelectorAll<HTMLLIElement>('.lang__row[data-id]')) {
      const entry = entryOf.get(row);
      if (row.dataset['id'] === id && entry !== undefined && entry.kind === 'line') return row;
    }
    return null;
  };

  const lightFor = (): { readonly id: string | null; readonly row: HTMLLIElement | null } => {
    const now = performance.now();
    if (pinned !== null && pinned.until > now) return pinned;
    pinned = null;
    return { id: hovered, row: hovered === null ? null : rowForId(hovered) };
  };

  // ---- the line being drawn: the painter's schedule against its playhead
  let lastNow = -2;
  let moving: HTMLLIElement[] = [];
  let lead: HTMLLIElement | null = null;
  let lastPointed: HTMLLIElement | null = null;
  const tick = (time: number): void => {
    rafHandle = requestAnimationFrame(tick);
    if (time - lastTick < 60) return;
    lastTick = time;
    paint();
    const snap = app.painter.snapshot();
    let nowSeq = -1;
    for (const line of snap.lines) {
      if (snap.playhead >= line.start && snap.playhead <= Math.max(line.end, line.start + HOLD) + (line.end > line.start ? HOLD : 0)) nowSeq = line.seq;
    }
    if (nowSeq !== lastNow) {
      rowOf.get(lastNow)?.classList.remove('is-now');
      rowOf.get(nowSeq)?.classList.add('is-now');
      lastNow = nowSeq;
    }
    // what keeps moving (a loop, a move under way, a live bind): its line is lit softly, the most recent start a little more
    const rows = new Map<HTMLLIElement, number>();
    for (const motion of snap.motions ?? []) {
      const row = rowOf.get(motion.seq);
      if (row !== undefined) rows.set(row, Math.max(rows.get(row) ?? -1, motion.since));
    }
    let newest: HTMLLIElement | null = null;
    let newestSince = -1;
    for (const [row, since] of rows) {
      if (since >= newestSince) {
        newest = row;
        newestSince = since;
      }
    }
    for (const row of moving) if (!rows.has(row)) row.classList.remove('is-moving');
    for (const row of rows.keys()) row.classList.add('is-moving');
    moving = [...rows.keys()];
    if (lead !== newest) {
      lead?.classList.remove('is-moving--lead');
      newest?.classList.add('is-moving--lead');
      lead = newest;
    }
    // follow: the line being drawn; with none for a moment, the one that began moving last while the turn plays; else the live row (render)
    const now = performance.now();
    if (nowSeq >= 0) lastDrawnAt = now;
    let target: HTMLLIElement | null = null;
    let key = '';
    if (nowSeq >= 0) {
      target = rowOf.get(nowSeq) ?? null;
      key = `n${nowSeq}`;
    } else if (now - lastDrawnAt > 1200 && liveRow === null && snap.turn !== null && newest !== null) {
      target = newest;
      key = `m${newest.dataset['seq'] ?? ''}`;
    }
    if (target !== null && key !== lastTarget) {
      lastTarget = key;
      lastRow = target;
      if (following) reveal(target);
    }
    const light = lightFor();
    if (lastPointed !== light.row) {
      lastPointed?.classList.remove('is-pointed');
      light.row?.classList.add('is-pointed');
      lastPointed = light.row;
    }
  };

  const lineEnter = (event: Event): void => {
    const row = event.target instanceof Element ? event.target.closest<HTMLLIElement>('.lang__row') : null;
    hovered = row?.dataset['id'] ?? null;
  };
  list.addEventListener('pointerover', lineEnter);
  list.addEventListener('focusin', lineEnter);
  list.addEventListener('pointerleave', () => {
    hovered = null;
  });
  list.addEventListener('focusout', () => {
    hovered = null;
  });
  list.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLLIElement>('.lang__row') : null;
    const id = row?.dataset['id'];
    if (row === null || id === undefined) return;
    pinned = { id, row, until: performance.now() + PIN_MS };
  });

  // the other way: the pointer over the stage, or a tap on it, finds the line that made what is under it
  const elementAt = (event: PointerEvent): string | null => {
    const box = stage.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    let best: { id: string; area: number } | null = null;
    for (const element of app.painter.snapshot().elements) {
      if (element.phase === 'struck' || element.opacity < 0.2) continue;
      const b = element.box;
      if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) continue;
      const area = b.width * b.height;
      if (best === null || area <= best.area) best = { id: element.id, area };
    }
    return best === null ? null : best.id;
  };
  let lastHover: string | null = null;
  const onStageMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    hovered = elementAt(event);
    const row = hovered === null ? null : rowForId(hovered);
    if (row !== null && hovered !== lastHover) reveal(row);
    lastHover = hovered;
  };
  const onStageDown = (event: PointerEvent): void => {
    const id = elementAt(event);
    if (id === null) return;
    const row = rowForId(id);
    if (row === null) return;
    reveal(row);
    pinned = { id, row, until: performance.now() + PIN_MS };
  };
  const onStageLeave = (): void => {
    hovered = null;
  };

  // ---- the switch
  const entry = menu.add({
    id: 'lines',
    label: 'Show the language',
    gist: 'the lines, as they arrive',
    order: 55,
    check: true,
    checked: false,
    run: () => app.lang.set(!app.lang.on),
  });

  let running = false;
  const apply = (): void => {
    const on = app.lang.on;
    entry.set({ checked: on });
    pane.hidden = !on;
    if (on) root.dataset['lang'] = 'on';
    else delete root.dataset['lang'];
    if (on && !running) {
      running = true;
      void ensureMono().then(paint);
      paletteKey = '';
      paint();
      render();
      stage.addEventListener('pointermove', onStageMove);
      stage.addEventListener('pointerdown', onStageDown, true);
      stage.addEventListener('pointerleave', onStageLeave);
      rafHandle = requestAnimationFrame(tick);
    } else if (!on && running) {
      running = false;
      cancelAnimationFrame(rafHandle);
      stage.removeEventListener('pointermove', onStageMove);
      stage.removeEventListener('pointerdown', onStageDown, true);
      stage.removeEventListener('pointerleave', onStageLeave);
      hovered = null;
      pinned = null;
    }
    remember(on);
  };
  const off = app.lang.onChange(() => {
    if (app.lang.on !== running) apply();
    else if (running) render();
  });
  if (remembered()) app.lang.set(true);
  else apply();

  return {
    dispose() {
      off();
      themeWatch.disconnect();
      cancelAnimationFrame(rafHandle);
      stage.removeEventListener('pointermove', onStageMove);
      stage.removeEventListener('pointerdown', onStageDown, true);
      stage.removeEventListener('pointerleave', onStageLeave);
      entry.remove();
      pane.remove();
      delete root.dataset['lang'];
    },
  };
}
