// What just happened on this page, kept small, for "Report a problem": the last minute and a half of taps, pointer downs and ups (with the kind: pen, touch,
// mouse), what the ink layer decided about each (taken, ignored and why), keys, scroll and viewport changes, console errors and failed requests.
//
// It is a ring in memory and nothing else: it is never stored and never sent unless the owner presses Send on the report sheet. Every listener is passive
// and does a few property reads and one array push; pointer MOVES are not recorded at all, so it cannot slow a stroke. Key events record the key's name
// for keys that are not characters (Enter, Escape, Backspace) and only "a character" for the rest: what is typed is never kept.

export interface TraceEvent {
  /** milliseconds before the report was taken (filled in by `snapshot`) */
  readonly ago: number;
  readonly what: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

interface Raw {
  readonly at: number;
  readonly what: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

const KEEP_MS = 90_000;
const MAX_EVENTS = 500;

let ring: Raw[] = [];
let installed = false;

export function trace(what: string, detail?: Readonly<Record<string, string | number | boolean>>): void {
  ring.push({ at: performance.now(), what, ...(detail === undefined ? {} : { detail }) });
  if (ring.length > MAX_EVENTS) ring = ring.slice(ring.length - MAX_EVENTS);
}

/** The last ~90 seconds, oldest first. */
export function snapshot(): TraceEvent[] {
  const now = performance.now();
  return ring.filter((event) => now - event.at <= KEEP_MS).map((event) => ({ ago: Math.round(now - event.at), what: event.what, ...(event.detail === undefined ? {} : { detail: event.detail }) }));
}

/** A short way of saying what an element is, enough to know what a tap hit. */
export function describe(target: EventTarget | null): string {
  if (!(target instanceof Element)) return target === document ? 'document' : 'unknown';
  let el: Element | null = target;
  // the nearest thing a person would call a control or a named part, else the element itself
  const named = target.closest('button, a, input, textarea, select, [role], [data-id], [data-element], [aria-label], canvas, svg');
  if (named !== null) el = named;
  const tag = el.tagName.toLowerCase();
  const id = el.id === '' ? '' : `#${el.id}`;
  const cls = typeof el.className === 'string' && el.className !== '' ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  const label = el.getAttribute('aria-label') ?? (el.tagName === 'BUTTON' || el.tagName === 'A' ? (el.textContent ?? '').trim().slice(0, 40) : '');
  return `${tag}${id}${cls}${label === '' ? '' : ` "${label}"`}`.slice(0, 160);
}

function kindOf(e: PointerEvent): string {
  return e.pointerType === '' ? 'mouse' : e.pointerType;
}

/** Starts listening, once. Call it as early as the page can. */
export function installTrace(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const opts = { capture: true, passive: true } as const;
  const point = (what: string) => (e: Event): void => {
    const p = e as PointerEvent;
    trace(what, { kind: kindOf(p), x: Math.round(p.clientX), y: Math.round(p.clientY), hit: describe(p.target), ...(p.pressure > 0 ? { pressure: Math.round(p.pressure * 100) / 100 } : {}) });
  };
  document.addEventListener('pointerdown', point('pointer down'), opts);
  document.addEventListener('pointerup', point('pointer up'), opts);
  document.addEventListener('pointercancel', point('pointer cancelled'), opts);
  document.addEventListener('click', (e) => trace('click', { x: Math.round(e.clientX), y: Math.round(e.clientY), hit: describe(e.target) }), opts);
  document.addEventListener('keydown', (e) => trace('key', { key: e.key.length === 1 ? 'a character' : e.key, ...(e.metaKey || e.ctrlKey ? { withModifier: true } : {}), in: describe(e.target) }), opts);
  document.addEventListener('ink:note', (e) => trace(`ink: ${String((e as CustomEvent<Record<string, unknown>>).detail['what'])}`, Object.fromEntries(Object.entries((e as CustomEvent<Record<string, unknown>>).detail).filter(([k]) => k !== 'what').map(([k, v]) => [k, v as string | number | boolean]))), opts);
  let scrolled = 0;
  document.addEventListener(
    'scroll',
    (e) => {
      const now = performance.now();
      if (now - scrolled < 400) return;
      scrolled = now;
      const t = e.target;
      trace('scroll', { in: t instanceof Element ? describe(t) : 'page', top: t instanceof Element ? Math.round(t.scrollTop) : Math.round(window.scrollY) });
    },
    opts,
  );
  const view = (): Record<string, number> => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, ...(window.visualViewport === null ? {} : { vvw: Math.round(window.visualViewport.width), vvh: Math.round(window.visualViewport.height), vvTop: Math.round(window.visualViewport.offsetTop) }) });
  let resized = 0;
  const onView = (what: string) => (): void => {
    const now = performance.now();
    if (now - resized < 300) return;
    resized = now;
    trace(what, view());
  };
  window.addEventListener('resize', onView('viewport resized'), { passive: true });
  window.addEventListener('orientationchange', onView('orientation changed'), { passive: true });
  window.visualViewport?.addEventListener('resize', onView('visual viewport changed'), { passive: true });
  trace('trace started', view());
  window.addEventListener('error', (e) => trace('page error', { message: String(e.message).slice(0, 300), where: `${e.filename ?? ''}:${e.lineno ?? 0}`.slice(0, 120) }));
  window.addEventListener('unhandledrejection', (e) => trace('unhandled rejection', { message: String(e.reason instanceof Error ? e.reason.message : e.reason).slice(0, 300) }));
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      trace(`console.${level}`, { message: args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safe(a))).join(' ').slice(0, 300) });
      original(...args);
    };
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = (typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url).replace(/^https?:\/\/[^/]+/, '').slice(0, 160);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    try {
      const response = await nativeFetch(input, init);
      if (!response.ok) trace('request failed', { method, url, status: response.status });
      return response;
    } catch (cause) {
      trace('request failed', { method, url, error: cause instanceof Error ? cause.message.slice(0, 120) : 'failed' });
      throw cause;
    }
  };
}

function safe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
