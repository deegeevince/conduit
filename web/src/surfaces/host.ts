// The surface host: the sandbox. A surface is a document the brain (or, for the lesson view, our own code) wrote, run in an iframe laid exactly
// over the room the stage plan gave it. The stage's placeholder is drawn underneath for as long as it loads and for every picture taken of the
// stage; this file is everything that makes running someone else's code here safe: the frame, the policy, the protocol, the watchdog.
//
// FRAME. `sandbox="allow-scripts"` and nothing else: no `allow-same-origin` (the document has an opaque origin: no cookies, no storage, no way
// to read this page or the app's origin, ever), no forms, popups, top navigation, downloads, modals or pointer lock. `allow=""` (no camera,
// microphone, location, clipboard, payment) and `referrerpolicy="no-referrer"`. The document goes in by `srcdoc`, never from our origin.
// POLICY. In the document, first (`document.ts`): no network at all. In the page (`PAGE_FRAME_POLICY`, a meta in index.html): a frame may hold
// nothing but an inline document, so a surface cannot navigate itself to an address with data in it. A frame that loads a second time is removed.
// PROTOCOL. Up: ready, pong, save, emit, size, fault, still. Down: ping, shoot, data (the look). None of them acts. A message is believed only
// when it comes from the frame's own window, from the opaque origin, carries the secret the page was built with, and has exactly one of these
// shapes at a bounded size and rate. Everything else is dropped and counted.
// WATCHDOG. A ping a second; three missed replaces the surface with its still. A mark is set before a surface runs and cleared on its first reply,
// so one that froze the tab does not run again by itself.

import type { AppTokens } from '../contracts/app';
import type { SurfaceEmit, SurfaceHold, SurfaceHost, SurfaceProbe, SurfaceSpec } from '../contracts/surface';
import { SURFACE_LIMITS, SURFACE_SOURCE_MAX, buildStandalonePage, buildSurfaceDocument } from './document';
import { loadShelf, shelfKey, shelfText } from './shelf';

export interface SurfaceHostOptions {
  /** the element the surfaces' layer goes in (the stage) */
  readonly stage: HTMLElement;
  /** what a surface said it did (`conduit.send` and `conduit.ask`) */
  readonly onEmit: (emit: SurfaceEmit) => void;
  /** a surface's saved state, a moment after it stops changing and once more as it leaves; `json` is the state as the surface kept it */
  readonly onSave?: (save: { readonly key: string; readonly id: string; readonly json: string }) => void;
  /** a line for the status line: a fault, a surface that stopped */
  readonly onNote?: (text: string) => void;
  /** a picture for what an app asked for in words (`conduit.picture`): a `data:` address and the credit line to show, or null. The frame can reach nothing itself; the page asks the server's picture service on its behalf. Absent: every ask is answered with none. */
  readonly onPicture?: (ask: { readonly query: string; readonly aspect: number }) => Promise<{ readonly url: string; readonly credit: string } | null>;
  /** the hostile bench only: leave the boot script's own removals out, so the policy and the sandbox are seen holding alone */
  readonly withoutDepth?: boolean;
}

/** Messages a frame may send, as the host reads them. */
export type FromSurface =
  | { readonly type: 'ready' }
  | { readonly type: 'pong'; readonly n: number }
  | { readonly type: 'emit'; readonly name: string; readonly value: string | number | boolean; readonly ask: boolean }
  | { readonly type: 'save'; readonly json: string }
  | { readonly type: 'size'; readonly height: number; readonly width: number | null }
  | { readonly type: 'fault'; readonly message: string }
  | { readonly type: 'picture'; readonly id: number; readonly query: string; readonly aspect: number }
  | { readonly type: 'still'; readonly id: number; readonly failed: string | null; readonly how: 'own' | 'dom' | null; readonly w: number; readonly h: number; readonly data: string | null };

const NAME = /^[A-Za-z0-9_.:-]{1,32}$/;
const PICTURE_MAX = 4_000_000;
/** The most messages a frame may send in a second before the rest are dropped; the most events in a minute. */
const RATE = { perSecond: 20, emitsPerMinute: 120 } as const;
const STILL_AFTER_LOAD_MS = 500;
const STILL_AFTER_ACT_MS = 700;
const SAVE_TELL_MS = 2500;
/** A ping a second; three missed in a row and the surface is replaced by its still. */
const PING_MS = 1000;
const MISSED_LIMIT = 3;
/** An app whose content is larger than its room is laid out in a bigger frame and scaled down to the room; never below this (past it the frame scrolls). Never scaled up. */
const FIT_MIN = 0.6;
/** how long a size reading must stand unchanged before the fit acts on it */
const FIT_SETTLE_MS = 250;
/** how long a box must stand still, away from its rest place, before the live frame is shown in it */
const BOX_STILL_MS = 300;
/** The most pictures one app may ask for, and the most characters of a `data:` address handed back (about 300 kB of picture). */
const PICTURE_ASKS = 4;
const PICTURE_URL_MAX = 420_000;
const STORE = 'conduit.surface.';
const MARK = 'conduit.surface.mark.';

/** The sandbox attribute every frame is made with. A test reads it back; nothing widens it. */
export const SURFACE_SANDBOX = 'allow-scripts';

/** A short fingerprint of a document: what its saved state and its freeze mark are filed under. */
export function fingerprint(text: string): string {
  let a = 5381;
  let b = 52711;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = ((a << 5) + a + c) | 0;
    b = (b * 33) ^ c;
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${text.length.toString(36)}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The one place a message from a frame is read. Anything that is not exactly one of the shapes is null. */
export function readFromSurface(raw: unknown, channel: string): FromSurface | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (data['conduit'] !== 1 || data['ch'] !== channel) return null;
  const type = data['type'];
  if (type === 'ready') return { type };
  if (type === 'pong') {
    const n = data['n'];
    return typeof n === 'number' && Number.isInteger(n) ? { type, n } : null;
  }
  if (type === 'emit') {
    const name = data['name'];
    const value = data['value'];
    const ask = data['ask'];
    if (typeof name !== 'string' || !NAME.test(name) || typeof ask !== 'boolean') return null;
    // an event is at most 2 kB: the value is cut to what the bridge itself allows, and anything larger is refused
    if (JSON.stringify(raw).length > SURFACE_LIMITS.event) return null;
    if (typeof value === 'string') return { type, name, value: value.slice(0, 300), ask };
    if (typeof value === 'number' && Number.isFinite(value)) return { type, name, value, ask };
    if (typeof value === 'boolean') return { type, name, value, ask };
    return null;
  }
  if (type === 'save') {
    const json = data['json'];
    if (typeof json !== 'string' || json.length > SURFACE_LIMITS.state) return null;
    try {
      JSON.parse(json);
    } catch {
      return null;
    }
    return { type, json };
  }
  if (type === 'size') {
    const height = data['height'];
    const width = data['width'];
    const wide = typeof width === 'number' && Number.isFinite(width) && width >= 0 && width <= 20_000 ? Math.round(width) : null;
    return typeof height === 'number' && Number.isFinite(height) && height >= 0 && height <= 20_000 ? { type, height: Math.round(height), width: wide } : null;
  }
  if (type === 'picture') {
    const id = data['id'];
    const query = data['query'];
    const w = data['w'];
    const h = data['h'];
    if (typeof id !== 'number' || !Number.isInteger(id) || typeof query !== 'string' || query.length > 80 || query.trim() === '') return null;
    const aspect = typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? Math.max(0.25, Math.min(4, w / h)) : 16 / 9;
    return { type, id, query: query.trim(), aspect };
  }
  if (type === 'fault') {
    const message = data['message'];
    return typeof message === 'string' ? { type, message: message.slice(0, 200) } : null;
  }
  if (type === 'still') {
    const id = data['id'];
    if (typeof id !== 'number' || !Number.isInteger(id)) return null;
    const failed = data['failed'];
    if (typeof failed === 'string') return { type, id, failed: failed.slice(0, 120), how: null, w: 0, h: 0, data: null };
    const how = data['how'];
    const w = data['w'];
    const h = data['h'];
    const picture = data['data'];
    if ((how !== 'own' && how !== 'dom') || typeof w !== 'number' || typeof h !== 'number' || typeof picture !== 'string') return null;
    if (!(w >= 1 && w <= 4096 && h >= 1 && h <= 4096) || picture.length > PICTURE_MAX || !picture.startsWith('data:image/png;base64,')) return null;
    return { type, id, failed: null, how, w: Math.round(w), h: Math.round(h), data: picture };
  }
  return null;
}

interface Running {
  readonly key: string;
  readonly id: string;
  readonly channel: string;
  readonly frame: HTMLIFrameElement;
  readonly source: string;
  /** the libraries it was built with (`shelfKey`) */
  readonly shelf: string;
  /** the libraries' text it was built with, and the pictures it was handed (by the words it asked with): what Save as page puts in the page */
  readonly shelfText: string;
  readonly gotPictures: Map<string, { readonly url: string; readonly credit: string }>;
  readonly fingerprint: string;
  spec: SurfaceSpec;
  loads: number;
  loaded: boolean;
  shown: boolean;
  state: string | null;
  told: string | null;
  height: number | null;
  /** FIT. 1 until the document's content is larger than its room; then the factor it is scaled down by, never below `FIT_MIN` */
  fit: number;
  /** how many pictures it has asked for */
  pictures: number;
  /** the fit is made once for a room: content that grows with the frame (100vh, innerHeight) would otherwise be chased down */
  fitted: boolean;
  /** the room (rest size) the fit was made for: a new room starts again at 1 */
  fitRoom: string;
  /** the last measurement the document sent, and the timer that acts on it once it has stopped changing */
  measured: { readonly height: number; readonly width: number } | null;
  fitTimer: ReturnType<typeof setTimeout> | undefined;
  /** the box the stage last placed it in, and since when it has not moved */
  boxAt: string;
  boxSince: number;
  still: { readonly canvas: HTMLCanvasElement; readonly how: 'own' | 'dom' } | null;
  refused: number;
  emits: number;
  faults: number;
  window: { start: number; count: number };
  minute: { start: number; count: number };
  snaps: Map<number, (done: boolean) => void>;
  snapSeq: number;
  stillTimer: ReturnType<typeof setTimeout> | undefined;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  pinger: ReturnType<typeof setInterval> | undefined;
  pings: number;
  answered: number;
  placed: string;
}

export function createSurfaceHost(options: SurfaceHostOptions): SurfaceHost {
  const { stage } = options;
  const layer = document.createElement('div');
  layer.className = 'stage__apps';
  layer.setAttribute('aria-label', 'Live apps');
  stage.append(layer);
  const running = new Map<string, Running>();
  /** surfaces that are on stage but not running, and why */
  const held = new Map<string, { readonly id: string; readonly why: SurfaceHold; readonly print: string | null }>();
  /** the last picture of a surface that is no longer running: a snapshot still shows how it stood */
  const stills = new Map<string, { readonly canvas: HTMLCanvasElement; readonly how: 'own' | 'dom' }>();
  /** saved state by document: survives a frame being rebuilt, and (for this tab) a page reload */
  const states = new Map<string, string>();
  /** the surfaces the last `sync` named: what a kill ends, started or not */
  let named: readonly string[] = [];
  let disposed = false;

  const stored = (print: string): string | null => {
    const kept = states.get(print);
    if (kept !== undefined) return kept;
    try {
      return window.sessionStorage.getItem(STORE + print);
    } catch {
      return null;
    }
  };
  const keep = (print: string, json: string): void => {
    states.set(print, json);
    try {
      window.sessionStorage.setItem(STORE + print, json);
    } catch {
      // storage that is not there is not a loss: the state is held for as long as the page is
    }
  };
  const marked = (print: string): boolean => {
    try {
      return window.sessionStorage.getItem(MARK + print) !== null;
    } catch {
      return false;
    }
  };
  const mark = (print: string, on: boolean): void => {
    try {
      if (on) window.sessionStorage.setItem(MARK + print, String(Date.now()));
      else window.sessionStorage.removeItem(MARK + print);
    } catch {
      // without storage there is no mark: the watchdog is still there
    }
  };

  const post = (run: Running, message: Record<string, unknown>): void => {
    try {
      run.frame.contentWindow?.postMessage({ conduit: 1, ch: run.channel, ...message }, '*');
    } catch {
      // a frame that has gone
    }
  };

  /** Asks the surface for a picture of itself. Resolves true when one came. */
  const requestStill = (run: Running, ms = 1500): Promise<boolean> => {
    if (!run.loaded || disposed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      run.snapSeq += 1;
      const id = run.snapSeq;
      const timer = setTimeout(() => {
        run.snaps.delete(id);
        resolve(false);
      }, ms);
      run.snaps.set(id, (done) => {
        clearTimeout(timer);
        run.snaps.delete(id);
        resolve(done);
      });
      post(run, { type: 'shoot', id });
    });
  };

  const scheduleStill = (run: Running, after: number): void => {
    clearTimeout(run.stillTimer);
    run.stillTimer = setTimeout(() => void requestStill(run), after);
  };

  const tellSave = (run: Running): void => {
    clearTimeout(run.saveTimer);
    if (run.state === null || run.state === run.told) return;
    run.told = run.state;
    options.onSave?.({ key: run.key, id: run.id, json: run.state });
  };

  const destroy = (run: Running, why: SurfaceHold | null): void => {
    tellSave(run);
    clearTimeout(run.stillTimer);
    clearTimeout(run.fitTimer);
    clearInterval(run.pinger);
    for (const done of [...run.snaps.values()]) done(false);
    if (run.still !== null) stills.set(run.key, run.still);
    run.frame.remove();
    running.delete(run.key);
    mark(run.fingerprint, false);
    if (why !== null) held.set(run.key, { id: run.id, why, print: run.fingerprint });
  };

  const place = (run: Running, spec: SurfaceSpec): void => {
    const rest = spec.rest;
    const style = run.frame.style;
    const scaleX = rest.width > 0 ? spec.box.width / rest.width : 1;
    const scaleY = rest.height > 0 ? spec.box.height / rest.height : 1;
    // The frame is laid out at the size it has at rest and moved by the camera: a transform, never a new layout.
    const room = `${rest.width.toFixed(1)}x${rest.height.toFixed(1)}`;
    if (room !== run.fitRoom) {
      run.fitRoom = room;
      run.fit = 1;
      run.fitted = false;
      // the last reading may be of the old room: it is looked at again after the frame has been resized and has reported
      if (run.measured !== null) {
        clearTimeout(run.fitTimer);
        run.fitTimer = setTimeout(() => settleFit(run), FIT_SETTLE_MS);
      }
    }
    const fit = run.fit;
    const placed = `${room}@${fit.toFixed(3)}`;
    if (placed !== run.placed) {
      // FIT: at a fit below 1 the frame is laid out larger by 1/fit and scaled by fit, so the room is filled and nothing is clipped
      style.width = `${rest.width / fit}px`;
      style.height = `${rest.height / fit}px`;
      // a surface that was drawn at another size has a picture of the wrong shape: it draws itself again once it has settled in the new room
      if (run.placed !== '' && run.loaded) scheduleStill(run, STILL_AFTER_ACT_MS);
      run.placed = placed;
    }
    style.transform = `translate(${spec.box.x}px, ${spec.box.y}px) scale(${scaleX * fit}, ${scaleY * fit})`;
    style.zIndex = String(Math.round(spec.z));
    // It is shown only when the camera is at rest and it has fully arrived: otherwise the stage's own picture of it is what is seen, which moves with the camera.
    const atRest = Math.abs(spec.box.x - rest.x) < 2 && Math.abs(spec.box.y - rest.y) < 2 && Math.abs(spec.box.width - rest.width) < 2 && Math.abs(spec.box.height - rest.height) < 2;
    // A box that has stood still for a moment is as good as at rest: if the stage and its plan ever settle a hair apart (`rest` is where the camera at home would put it),
    // the app must not stay a picture for good, with its presses going to the stage as taps.
    const here = `${spec.box.x.toFixed(1)}|${spec.box.y.toFixed(1)}|${spec.box.width.toFixed(1)}|${spec.box.height.toFixed(1)}`;
    const now = performance.now();
    if (here !== run.boxAt) {
      run.boxAt = here;
      run.boxSince = now;
    }
    const still = now - run.boxSince >= BOX_STILL_MS;
    const show = run.loaded && (atRest || still) && spec.opacity > 0.02 && rest.width >= 120 && rest.height >= 80;
    run.shown = show;
    style.visibility = show ? 'visible' : 'hidden';
    style.opacity = show ? String(Math.min(1, spec.opacity)) : '0';
    style.pointerEvents = show && spec.opacity > 0.9 ? 'auto' : 'none';
  };

  const create = (spec: SurfaceSpec, shelf: string): Running => {
    const channel = randomToken();
    const source = spec.source.slice(0, SURFACE_SOURCE_MAX);
    const library = shelfKey(spec.uses);
    const print = fingerprint(library === '' ? source : `${library}\u0000${source}`);
    const state = stored(print);
    const frame = document.createElement('iframe');
    // The sandbox: scripts, and nothing else. It is set before the document is, and never widened.
    frame.setAttribute('sandbox', SURFACE_SANDBOX);
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'eager');
    frame.setAttribute('title', spec.title === '' ? 'Live app' : spec.title);
    frame.setAttribute('data-surface', spec.id);
    frame.className = 'stage__app';
    frame.style.visibility = 'hidden';
    frame.style.opacity = '0';
    const run: Running = {
      key: spec.key, id: spec.id, channel, frame, source: spec.source, shelf: library, shelfText: shelf, gotPictures: new Map(), fingerprint: print, spec, loads: 0, loaded: false, shown: false, state, told: state, height: null, fit: 1, pictures: 0, fitted: false, fitRoom: '', measured: null, fitTimer: undefined, boxAt: '', boxSince: 0, still: stills.get(spec.key) ?? null,
      refused: 0, emits: 0, faults: 0, window: { start: 0, count: 0 }, minute: { start: 0, count: 0 }, snaps: new Map(), snapSeq: 0, stillTimer: undefined, saveTimer: undefined, pinger: undefined, pings: 0, answered: 0, placed: '',
    };
    // a frame that loads a second time has navigated itself (a script, a link): it is removed, and what it was reaching for was never allowed to answer
    frame.addEventListener('load', () => {
      run.loads += 1;
      if (run.loads > 1 && running.get(run.key) === run) {
        destroy(run, 'navigated');
        options.onNote?.(`The app "${run.spec.title === '' ? run.id : run.spec.title}" tried to load another page and was ended.`);
      }
    });
    mark(print, true);
    frame.srcdoc = buildSurfaceDocument({ source, tokens: spec.tokens, channel, state, ...(shelf === '' ? {} : { shelf }), ...(options.withoutDepth === true ? { depth: false } : {}) });
    running.set(spec.key, run);
    // it has its room before its script runs (still hidden): an app that measures itself at the start sees its real size, not a frame of no size
    place(run, spec);
    layer.append(frame);
    return run;
  };

  const startWatch = (run: Running): void => {
    clearInterval(run.pinger);
    run.pings = 0;
    run.answered = 0;
    run.pinger = setInterval(() => {
      if (disposed || running.get(run.key) !== run) return;
      // a hidden tab throttles timers: silence then is not a freeze
      if (document.hidden) return;
      if (run.pings - run.answered >= MISSED_LIMIT) {
        destroy(run, 'frozen');
        options.onNote?.(`The app "${run.spec.title === '' ? run.id : run.spec.title}" stopped answering and was replaced by its picture.`);
        return;
      }
      run.pings += 1;
      post(run, { type: 'ping', n: run.pings });
    }, PING_MS);
  };

  /** FIT. What the document measures is in the frame's own pixels, laid out `rest / fit` large. Content past that is scaled down to the room (the parent sets the frame's size and transform; nothing reaches into the frame). */
  const settleFit = (run: Running): void => {
    if (disposed || running.get(run.key) !== run || run.measured === null) return;
    const rest = run.spec.rest;
    const layoutW = rest.width / run.fit;
    const layoutH = rest.height / run.fit;
    const { height, width } = run.measured;
    if (!run.fitted && run.spec.page !== true && rest.width > 0 && rest.height > 0 && (height > layoutH + 1 || width > layoutW + 1)) {
      // a hair under the exact fit, so a content that is one pixel over does not leave a scrollbar
      const next = Math.max(FIT_MIN, Math.min(run.fit, rest.height / height, width > 0 ? rest.width / width : 1) * 0.99);
      if (next < run.fit - 0.01) {
        run.fit = next;
        run.fitted = true;
        place(run, run.spec);
        scheduleStill(run, STILL_AFTER_ACT_MS);
      }
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    let from: Running | undefined;
    for (const run of running.values()) {
      if (run.frame.contentWindow !== null && run.frame.contentWindow === event.source) {
        from = run;
        break;
      }
    }
    // Not one of our frames (the page's own messages, an extension, another window): not ours to judge, and not counted.
    if (from === undefined) return;
    // A sandboxed document without allow-same-origin has the opaque origin, which a message carries as the string "null".
    if (event.origin !== 'null') {
      from.refused += 1;
      return;
    }
    const now = performance.now();
    if (now - from.window.start > 1000) from.window = { start: now, count: 0 };
    from.window.count += 1;
    if (from.window.count > RATE.perSecond) {
      from.refused += 1;
      return;
    }
    const message = readFromSurface(event.data, from.channel);
    if (message === null) {
      from.refused += 1;
      return;
    }
    const run = from;
    switch (message.type) {
      case 'ready':
        run.loaded = true;
        // the first reply clears the mark: it ran, and did not freeze the page
        mark(run.fingerprint, false);
        startWatch(run);
        place(run, run.spec);
        scheduleStill(run, STILL_AFTER_LOAD_MS);
        return;
      case 'pong':
        run.answered = Math.max(run.answered, message.n);
        return;
      case 'size': {
        run.height = message.height;
        // FIT: a measurement is acted on once it has stopped changing. A reading sent from the old frame size can arrive after the frame was moved to a new room; acted on at once it
        // looks like content far wider than the room and scales the app to the floor, to half size for nothing. The frame reports again when it is resized, so the last word is the true one.
        run.measured = { height: message.height, width: message.width ?? 0 };
        clearTimeout(run.fitTimer);
        run.fitTimer = setTimeout(() => settleFit(run), FIT_SETTLE_MS);
        return;
      }
      case 'emit': {
        if (now - run.minute.start > 60_000) run.minute = { start: now, count: 0 };
        run.minute.count += 1;
        if (run.minute.count > RATE.emitsPerMinute) {
          run.refused += 1;
          return;
        }
        run.emits += 1;
        options.onEmit({ key: run.key, id: run.id, name: message.name, value: message.value, ask: message.ask });
        scheduleStill(run, STILL_AFTER_ACT_MS);
        return;
      }
      case 'save':
        run.state = message.json;
        keep(run.fingerprint, message.json);
        clearTimeout(run.saveTimer);
        run.saveTimer = setTimeout(() => tellSave(run), SAVE_TELL_MS);
        scheduleStill(run, STILL_AFTER_ACT_MS);
        return;
      case 'still': {
        const done = run.snaps.get(message.id);
        if (message.data === null || message.how === null) {
          done?.(false);
          return;
        }
        const image = new Image();
        const how = message.how;
        image.onload = () => {
          if (disposed) return;
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext('2d')?.drawImage(image, 0, 0);
          run.still = { canvas, how };
          done?.(true);
        };
        image.onerror = () => done?.(false);
        image.src = message.data;
        return;
      }
      case 'picture': {
        run.pictures += 1;
        const reply = (found: { readonly url: string; readonly credit: string } | null): void => post(run, found === null ? { type: 'picture', id: message.id, url: null } : { type: 'picture', id: message.id, url: found.url, credit: found.credit });
        if (run.pictures > PICTURE_ASKS || options.onPicture === undefined) {
          run.refused += run.pictures > PICTURE_ASKS ? 1 : 0;
          reply(null);
          return;
        }
        void options.onPicture({ query: message.query, aspect: message.aspect }).then(
          (found) => {
            if (disposed || running.get(run.key) !== run) return;
const good = found !== null && found.url.startsWith('data:image/') && found.url.length <= PICTURE_URL_MAX ? { url: found.url, credit: found.credit.slice(0, 300) } : null;
            if (good !== null) run.gotPictures.set(message.query, good);
            reply(good);
          },
          () => reply(null),
        );
        return;
      }
      case 'fault':
        run.faults += 1;
        if (run.faults <= 3) options.onNote?.(`The app "${run.spec.title === '' ? run.id : run.spec.title}" hit an error: ${message.message}`);
        return;
    }
  };
  window.addEventListener('message', onMessage);

  /** the libraries being fetched from the build (one chunk each), and the ones that could not be */
  const loadingShelf = new Set<string>();
  const missingShelf = new Set<string>();
  let lastSpecs: readonly SurfaceSpec[] = [];

  const api: SurfaceHost = {
    sync(specs) {
      if (disposed) return;
      lastSpecs = specs;
      const wanted = new Set(specs.map((spec) => spec.key));
      named = specs.map((spec) => spec.key);
      for (const run of [...running.values()]) if (!wanted.has(run.key)) destroy(run, null);
      for (const key of [...held.keys()]) if (!wanted.has(key)) held.delete(key);
      for (const spec of specs) {
        if (held.has(spec.key) || !spec.ready || spec.source === '') continue;
        let run = running.get(spec.key);
        // a surface written again in place is a new document: it starts afresh (its saved state is kept under the old text)
        if (run !== undefined && (run.source !== spec.source || run.shelf !== shelfKey(spec.uses))) {
          destroy(run, null);
          run = undefined;
        }
        if (run === undefined) {
          // the libraries it asked for come from the build as lazy chunks: it starts when they are in hand, and this is told again then
          const library = shelfKey(spec.uses);
          let shelf = '';
          if (library !== '') {
            const text = shelfText(spec.uses);
            if (text === null && !missingShelf.has(library)) {
              if (!loadingShelf.has(library)) {
                loadingShelf.add(library);
                void loadShelf(spec.uses).then((ok) => {
                  loadingShelf.delete(library);
                  if (!ok) {
                    missingShelf.add(library);
                    options.onNote?.(`The app "${spec.title === '' ? spec.id : spec.title}" asked for a library (${library}) that this build does not have.`);
                  }
                  if (!disposed) api.sync(lastSpecs);
                });
              }
              continue;
            }
            shelf = text ?? '';
          }
          const print = fingerprint(library === '' ? spec.source.slice(0, SURFACE_SOURCE_MAX) : `${library}\u0000${spec.source.slice(0, SURFACE_SOURCE_MAX)}`);
          if (marked(print)) {
            held.set(spec.key, { id: spec.id, why: 'marked', print });
            options.onNote?.(`The app "${spec.title === '' ? spec.id : spec.title}" froze this page last time, so it does not run by itself.`);
            continue;
          }
          run = create(spec, shelf);
        }
        if (run.spec.tokens !== spec.tokens) {
          post(run, { type: 'data', tokens: spec.tokens satisfies AppTokens });
          scheduleStill(run, STILL_AFTER_ACT_MS);
        }
        run.spec = spec;
        place(run, spec);
      }
    },
    exportPage() {
      // the app on stage that is running and has loaded (the last one, when there are several)
      const run = [...running.values()].filter((candidate) => candidate.loaded).pop();
      if (run === undefined) return null;
      const title = run.spec.title.trim() === '' ? run.id : run.spec.title.trim();
      return { title, html: buildStandalonePage({ source: run.source, tokens: run.spec.tokens, shelf: run.shelfText, title, pictures: Object.fromEntries(run.gotPictures) }) };
    },
    still(key) {
      return running.get(key)?.still?.canvas ?? stills.get(key)?.canvas ?? null;
    },
    async refresh(ms) {
      const asked = [...running.values()].filter((run) => run.loaded).map((run) => requestStill(run, ms));
      if (asked.length > 0) await Promise.all(asked);
    },
    killAll() {
      let ended = 0;
      for (const run of [...running.values()]) {
        destroy(run, 'killed');
        ended += 1;
      }
      for (const key of named) if (!held.has(key)) held.set(key, { id: key.split('@')[0] ?? key, why: 'killed', print: null });
      return ended;
    },
    run(key) {
      const was = held.get(key);
      if (was === undefined || was.why === 'killed') return;
      held.delete(key);
      if (was.print !== null) mark(was.print, false);
    },
    probe(): readonly SurfaceProbe[] {
      const live = [...running.values()].map((run) => ({
        key: run.key,
        id: run.id,
        running: true,
        loaded: run.loaded,
        shown: run.shown,
        held: null,
        box: run.spec.rest,
        state: run.state,
        height: run.height,
        fit: run.fit,
        still: run.still === null ? null : { how: run.still.how, width: run.still.canvas.width, height: run.still.canvas.height },
        refused: run.refused,
        emits: run.emits,
        faults: run.faults,
        sandbox: run.frame.getAttribute('sandbox'),
      }));
      const off = [...held].map(([key, entry]) => ({ key, id: entry.id, running: false, loaded: false, shown: false, held: entry.why, box: null, state: null, height: null, fit: 1, still: null, refused: 0, emits: 0, faults: 0, sandbox: null }));
      return [...live, ...off];
    },
    dispose() {
      disposed = true;
      window.removeEventListener('message', onMessage);
      for (const run of [...running.values()]) destroy(run, null);
      layer.remove();
    },
  };
  return api;
}
