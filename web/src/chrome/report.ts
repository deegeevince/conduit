// "Report a problem", in the [+] menu. A small sheet with one optional note; Send takes a picture of what is on screen (the stage, and any ink over it),
// the last minute and a half of what happened (`trace.ts`) and where the page stands, and posts it to this server, which keeps it in its data folder
// (`POST /api/reports`, no model). The picture and the events are taken the moment the menu item is pressed, not when Send is, so they show the problem
// and not the sheet. Nothing leaves this machine's server.

import type { StageApp } from '../app/stage-app';
import type { ComposerMenu } from './menu';
import { describe, snapshot } from './trace';
import type { TraceEvent } from './trace';

declare const __BUILD_COMMIT__: string | undefined;

/** The longest side of a picture in the report, in pixels. */
const SIDE = 1800;

export interface ReportControl {
  dispose(): void;
}

interface Taken {
  readonly events: TraceEvent[];
  readonly context: Record<string, unknown>;
  readonly pictures: Promise<Record<string, string>>;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function visible(el: Element): boolean {
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : (el as HTMLElement).offsetParent !== null;
}

/** Every ink layer on screen (the stage's, a lesson's or a document's), drawn where it is, into a fresh canvas the size of the page; null when none shows ink. */
function inkOnScreen(scale: number): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(window.innerWidth * scale));
  canvas.height = Math.max(1, Math.round(window.innerHeight * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  let any = false;
  for (const layer of document.querySelectorAll('.ink')) {
    if (!visible(layer)) continue;
    for (const part of layer.querySelectorAll('canvas')) {
      if (!visible(part)) continue;
      const box = part.getBoundingClientRect();
      try {
        ctx.drawImage(part, box.left * scale, box.top * scale, box.width * scale, box.height * scale);
        any = true;
      } catch {
        // a canvas that cannot be read is left out
      }
    }
  }
  return any ? canvas : null;
}

const toDataUrl = (canvas: HTMLCanvasElement): string => canvas.toDataURL('image/png');

function contextOf(app: StageApp): Record<string, unknown> {
  const root = document.documentElement;
  let state: Record<string, unknown> = {};
  try {
    state = app.hook.state() as unknown as Record<string, unknown>;
  } catch {
    // the stage has nothing to say yet
  }
  const pick = (...keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
  const strokes = (): number => {
    const stats = (window as unknown as { __inkStrokes?: () => number }).__inkStrokes;
    return typeof stats === 'function' ? stats() : 0;
  };
  return {
    at: new Date().toISOString(),
    session: app.link.session,
    turn: app.lastTurn(),
    build: typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__ !== '' ? __BUILD_COMMIT__ : null,
    page: window.location.pathname,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, ...(window.visualViewport === null ? {} : { visual: { w: Math.round(window.visualViewport.width), h: Math.round(window.visualViewport.height) } }) },
    screen: { w: window.screen.width, h: window.screen.height },
    userAgent: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints,
    theme: root.dataset['theme'] ?? null,
    look: state['look'] ?? null,
    stage: pick('scene', 'renderer', 'quality', 'fps', 'clock', 'hidden'),
    bodyClasses: [...document.body.classList],
    inkStrokesWaiting: strokes(),
    inkOpen: [...document.querySelectorAll('.ink')].filter(visible).map((layer) => describe(layer)),
    status: app.status().text,
  };
}

/** Takes what is on screen and what just happened, now. */
function take(app: StageApp, host: HTMLElement): Taken {
  const scale = Math.min(window.devicePixelRatio || 1, 2, SIDE / Math.max(window.innerWidth, window.innerHeight));
  const ink = inkOnScreen(scale);
  const events = snapshot();
  const context = contextOf(app);
  const pictures = (async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const stageUrl = await app.capture(SIDE, 'image/png').catch(() => null);
    if (stageUrl !== null) out['stage'] = stageUrl;
    if (ink !== null) out['ink'] = toDataUrl(ink);
    // the screen: the stage's picture where the stage is, the ink over it where the ink is
    const image = stageUrl === null ? null : await loadImage(stageUrl);
    if (image !== null || ink !== null) {
      const page = document.createElement('canvas');
      page.width = Math.max(1, Math.round(window.innerWidth * scale));
      page.height = Math.max(1, Math.round(window.innerHeight * scale));
      const ctx = page.getContext('2d');
      if (ctx !== null) {
        ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff';
        ctx.fillRect(0, 0, page.width, page.height);
        if (image !== null) {
          const box = host.getBoundingClientRect();
          const fit = Math.min(box.width / image.width, box.height / image.height);
          const w = image.width * fit;
          const h = image.height * fit;
          ctx.drawImage(image, (box.left + (box.width - w) / 2) * scale, (box.top + (box.height - h) / 2) * scale, w * scale, h * scale);
        }
        if (ink !== null) ctx.drawImage(ink, 0, 0);
        out['screen'] = toDataUrl(page);
      }
    }
    return out;
  })();
  return { events, context, pictures };
}

export function mountReport(menu: ComposerMenu, app: StageApp, stage: HTMLElement): ReportControl {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog report';
  dialog.setAttribute('aria-labelledby', 'report-title');
  const title = document.createElement('h2');
  title.id = 'report-title';
  title.className = 'report__title';
  title.textContent = 'Report a problem';
  const help = document.createElement('p');
  help.className = 'report__help';
  help.textContent = 'Saves a picture of what was on screen and what just happened, for fixing. A note is optional.';
  const note = document.createElement('textarea');
  note.className = 'report__note';
  note.rows = 4;
  note.maxLength = 4000;
  note.placeholder = 'What went wrong? (optional)';
  note.setAttribute('aria-label', 'What went wrong');
  const status = document.createElement('p');
  status.className = 'report__status';
  status.setAttribute('role', 'status');
  const row = document.createElement('div');
  row.className = 'report__row';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'report__button';
  cancel.textContent = 'Cancel';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'report__button report__button--send';
  send.textContent = 'Send';
  row.append(cancel, send);
  dialog.append(title, help, note, status, row);
  document.body.append(dialog);

  let taken: Taken | null = null;
  let done = false;
  const close = (): void => {
    if (dialog.open) dialog.close();
  };
  cancel.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    taken = null;
  });

  send.addEventListener('click', () => {
    if (done) return close();
    const now = taken;
    if (now === null) return;
    send.disabled = true;
    status.textContent = 'Sending.';
    void (async () => {
      try {
        const images = await now.pictures;
        const response = await fetch('/api/reports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: now.context['session'], turn: now.context['turn'], note: note.value, context: now.context, events: now.events, images }),
        });
        if (!response.ok) throw new Error(`the server said ${response.status}`);
        done = true;
        status.textContent = 'Sent. Thanks';
        note.hidden = true;
        cancel.hidden = true;
        send.textContent = 'Close';
      } catch (cause) {
        status.textContent = `Not sent: ${cause instanceof Error ? cause.message : 'something failed'}. Try again.`;
      } finally {
        send.disabled = false;
      }
    })();
  });

  const entry = menu.add({
    id: 'report',
    label: 'Report a problem',
    gist: 'saves what is on screen and what just happened',
    order: 78,
    run: () => {
      taken = take(app, stage);
      done = false;
      note.value = '';
      note.hidden = false;
      cancel.hidden = false;
      send.textContent = 'Send';
      send.disabled = false;
      status.textContent = '';
      dialog.showModal();
      note.focus({ preventScroll: true });
    },
  });
  return {
    dispose() {
      entry.remove();
      dialog.remove();
    },
  };
}
