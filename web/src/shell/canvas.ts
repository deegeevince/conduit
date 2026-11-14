// The canvas: the room the stage lives in. A side panel on a desk, the whole screen on a phone. Inside it the stage is today's stage, unchanged; around it is the
// shell's own header (title, close, and the chrome's words, draw and save) and a navigator below (previous, next, replay, show all).
//
// The room is the stage's theme root (`data-theme-root`): whatever colours the stage takes it writes here and nowhere above, so nothing of it reaches the shell.
// What goes the other way is a box: `insets()` is the room the shell takes around the stage, which is all the stage needs to know of the shell.

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Canvas {
  readonly root: HTMLElement;
  /** the stage's theme root and the box the stage fills */
  readonly room: HTMLElement;
  readonly stageHost: HTMLElement;
  /** where the chrome's Words, Draw and Save go */
  readonly tools: HTMLElement;
  /** where Show all goes */
  readonly navTop: HTMLElement;
  setTitle(text: string): void;
  setNav(state: { readonly position: string; readonly prev: boolean; readonly next: boolean; readonly replay: boolean }): void;
  focusTitle(): void;
  /** the room the shell leaves the stage: what is between the canvas's edge and the stage's, which is the header, the navigator and the safe areas */
  insets(): Insets;
  dispose(): void;
}

export interface CanvasHandlers {
  readonly onClose: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onReplay: () => void;
}

const CLOSE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PREV = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const NEXT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
const REPLAY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/></svg>';

export function mountCanvas(host: HTMLElement, handlers: CanvasHandlers): Canvas {
  host.classList.add('shell-canvas');
  host.setAttribute('role', 'complementary');
  host.setAttribute('aria-label', 'Canvas');
  host.innerHTML = `
    <header class="shell-canvas__head">
      <button type="button" class="sh-btn" data-close aria-label="Close canvas">${CLOSE}</button>
      <h2 class="shell-canvas__title" tabindex="-1">Canvas</h2>
      <div class="shell-canvas__tools"></div>
    </header>
    <div class="shell-canvas__room" data-theme-root>
      <div class="stage" id="stage" aria-label="Stage" tabindex="0"></div>
    </div>
    <nav class="shell-canvas__nav" aria-label="Replies on the canvas">
      <button type="button" class="sh-btn" data-prev aria-label="Previous reply">${PREV}</button>
      <span class="shell-canvas__where" aria-live="polite"></span>
      <button type="button" class="sh-btn" data-next aria-label="Next reply">${NEXT}</button>
      <button type="button" class="sh-btn sh-btn--text" data-replay>${REPLAY}<span>Replay</span></button>
      <span class="shell-canvas__top"></span>
    </nav>`;
  const part = <T extends HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector);
    if (found === null) throw new Error('The canvas could not be built.');
    return found;
  };
  const head = part('.shell-canvas__head');
  const title = part('.shell-canvas__title');
  const tools = part('.shell-canvas__tools');
  const room = part('.shell-canvas__room');
  const stageHost = part('.stage');
  const nav = part('.shell-canvas__nav');
  const where = part('.shell-canvas__where');
  const prev = part<HTMLButtonElement>('[data-prev]');
  const next = part<HTMLButtonElement>('[data-next]');
  const replay = part<HTMLButtonElement>('[data-replay]');
  const navTop = part('.shell-canvas__top');
  part<HTMLButtonElement>('[data-close]').addEventListener('click', handlers.onClose);
  prev.addEventListener('click', handlers.onPrev);
  next.addEventListener('click', handlers.onNext);
  replay.addEventListener('click', handlers.onReplay);

  return {
    root: host,
    room,
    stageHost,
    tools,
    navTop,
    setTitle(text) {
      title.textContent = text;
      title.title = text;
    },
    setNav(state) {
      where.textContent = state.position;
      prev.disabled = !state.prev;
      next.disabled = !state.next;
      replay.hidden = !state.replay;
    },
    focusTitle() {
      title.focus({ preventScroll: true });
    },
    insets() {
      const outer = host.getBoundingClientRect();
      const inner = stageHost.getBoundingClientRect();
      const round = (value: number): number => Math.max(0, Math.round(value));
      return { top: round(inner.top - outer.top), right: round(outer.right - inner.right), bottom: round(outer.bottom - inner.bottom), left: round(inner.left - outer.left) };
    },
    dispose() {
      head.remove();
      room.remove();
      nav.remove();
    },
  };
}
