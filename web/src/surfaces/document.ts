// The page a surface runs in (a live app today, the lesson view next). One pure function turns the brain's document, the look's tokens and the app's saved state into the
// string handed to a sandboxed iframe's `srcdoc`. Everything that makes the page safe is here, in one place, so it can be read and tested
// without a browser:
//
//  - the Content-Security-Policy is the first thing in the document, so nothing the brain wrote runs before it. It allows inline script and
//    style and data: or blob: pictures, and nothing else: no fetch, no WebSocket, no external script, font, picture, frame, form or base;
//  - the brain's markup is stripped of what could change the page's own rules (another policy, a refresh, a base address, a second <html>);
//  - the bridge is the only script the host writes: it gives the app `conduit`, and it speaks to the host by postMessage and nothing else.
//
// The frame itself is `sandbox="allow-scripts"` and nothing more (see live-app.ts): the document has an opaque origin, so it has no cookies,
// no storage, no same-origin access to the host, and cannot navigate the host, open a window, submit a form or start a download.

import type { AppTokens as SurfaceTokens } from '../contracts/app';

/**
 * The policy, as PLAN-v3-core 2.6 states it. Nothing is allowed that reaches the network: the only sources are the document itself and data: or
 * blob: pictures, fonts and media. `connect-src`, `frame-src` and `worker-src` are said as well as implied, so the page does not depend on a
 * browser's reading of a fallback; `base-uri` and `form-action` are listed because `default-src` does not cover them.
 */
export const SURFACE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'";
/**
 * The policy the PAGE carries (a `<meta>` in index.html, or a header): a frame in this page may load nothing but an inline document of the
 * page's own. This is what stops a surface from navigating itself to an address with data in it, which the document's own policy cannot say.
 */
export const PAGE_FRAME_POLICY = "frame-src about: blob:";

/** The most of a document the host will run: the language already cuts at this; this is the host's own check of what it was handed. */
/** The most of a surface's document the host will run. The brain's own apps are held to the language's (smaller) limit before they get here; this is the guard for the lesson player, which is our own packed program (the exact maths checker and the matcher are in it). */
export const SURFACE_SOURCE_MAX = 160_000;
/** The most saved state a surface may keep, and the most one event may carry, characters. */
export const SURFACE_LIMITS = { state: 64_000, event: 2_000 } as const;

/** The names of the CSS variables the look arrives as, for the brain's chapter and for the test. */
export const SURFACE_VARIABLES = ['--ink', '--ground', '--accent', '--on-accent', '--alt', '--dim', '--line', '--good', '--bad', '--font', '--font-px', '--radius', '--gap'] as const;

/** The look's tokens as one CSS rule on :root. Values come from the painter's own look (never from the brain), and are still escaped. */
export function tokenCss(tokens: SurfaceTokens): string {
  const safe = (value: string): string => value.replace(/[<>{};\\]/g, '');
  const rules: Record<(typeof SURFACE_VARIABLES)[number], string> = {
    '--ink': tokens.ink,
    '--ground': tokens.ground,
    '--accent': tokens.accent,
    '--on-accent': tokens.onAccent,
    '--alt': tokens.alt,
    '--dim': tokens.dim,
    '--line': tokens.line,
    '--good': tokens.good,
    '--bad': tokens.bad,
    '--font': tokens.font,
    '--font-px': `${tokens.fontPx}px`,
    '--radius': `${tokens.radius}px`,
    '--gap': `${tokens.gap}px`,
  };
  return `:root{${SURFACE_VARIABLES.map((name) => `${name}:${safe(rules[name])}`).join(';')};color-scheme:${tokens.dark ? 'dark' : 'light'}}`;
}

/**
 * What the brain's markup may bring into the page: its body, its styles and its scripts. A page-level tag is dropped (its content stays), and
 * so is anything that could set rules for the page or reach outside it. The policy stops each of the latter on its own; this keeps the page's
 * own text honest as well.
 */
export function cleanMarkup(source: string, defer = true): string {
  return source
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed|frame|frameset|applet)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    // an inline script is written inert and set going by the bridge once the frame has a layout (see `release` in the bridge)
    .replace(/<script\b([^>]*)>/gi, (tag: string, attrs: string) => (!defer || /\b(?:src|type)\s*=/i.test(attrs) ? tag : `<script${attrs} type="application/x-conduit-app">`))
    .replace(/<form\b/gi, '<div data-was-form')
    .replace(/<\/form\s*>/gi, '</div>');
}

/** JSON that is safe to write inside a <script>: no `</script`, no `<!--`, no line separators. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * The bridge, as source text. `__BOOT__` is replaced with `{ ch, state, tokens }`. It is written in plain old JavaScript with no dependencies, and is
 * the only thing the host puts in the page besides the look's variables. It never receives anything but a snapshot request and the look's tokens.
 */
const BRIDGE = String.raw`(function () {
  var boot = __BOOT__;
  var state = boot.state;
  var shooter = null;
  var pictureAsks = 0;
  var pictureWaits = {};
  // Side doors the policy cannot close (WebRTC reaches the network without asking it): the constructors are removed before any of the app's
  // code runs. Depth, not a wall; the frame has no second realm to take them back from (frames and workers are refused by policy).
  var doors = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'WebTransport', 'EventSource', 'WebSocket', 'XMLHttpRequest', 'fetch', 'Worker', 'SharedWorker'];
  if (boot.depth !== false) for (var d = 0; d < doors.length; d++) { try { delete window[doors[d]]; } catch (e) {} try { if (window[doors[d]] !== undefined) Object.defineProperty(window, doors[d], { value: undefined, configurable: false, writable: false }); } catch (e) {} }
  if (boot.depth !== false) try { if (navigator.sendBeacon) Object.defineProperty(Navigator.prototype, 'sendBeacon', { value: undefined, configurable: false }); } catch (e) {}
  function post(type, body) {
    var message = body || {};
    message.conduit = 1;
    message.ch = boot.ch;
    message.type = type;
    try { parent.postMessage(message, '*'); } catch (e) {}
  }
  function plain(value) {
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.slice(0, 300);
    if (value === null || value === undefined) return '';
    try { return JSON.stringify(value).slice(0, 300); } catch (e) { return String(value).slice(0, 300); }
  }
  function name(value) { return String(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 32) || 'act'; }
  var api = {
    // tells the stage what the user did; it reaches the mind on its next turn
    send: function (what, value) { post('emit', { name: name(what), value: plain(value), ask: false }); },
    // the same, and asks the mind for a new answer now
    ask: function (what, value) { post('emit', { name: name(what), value: plain(value), ask: true }); },
    // conduit.state(obj) saves the app's state; conduit.state() returns it (null when nothing is saved)
    state: function (next) {
      if (arguments.length === 0) { return state === null || state === undefined ? null : JSON.parse(JSON.stringify(state)); }
      try {
        var text = JSON.stringify(next);
        if (text === undefined || text.length > __STATE_MAX__) return;
        state = JSON.parse(text);
        post('save', { json: text });
      } catch (e) {}
    },
    // conduit.snapshot(function () { return canvas; }): the app draws its own picture, when the document cannot be copied faithfully
    snapshot: function (draw) { shooter = typeof draw === 'function' ? draw : null; },
    // await conduit.picture('words', { w, h }): a photograph for the words, as { url: a data: address, credit: the line to show }, or null (no picture service, none found, too many asked for). The page asks on the app's behalf; the frame reaches nothing.
    picture: function (query, size) {
      return new Promise(function (resolve) {
        if (pictureAsks >= 4 || typeof query !== 'string' || query.replace(/\s+/g, '') === '') { resolve(null); return; }
        pictureAsks += 1;
        var ask = pictureAsks;
        var o = size && typeof size === 'object' ? size : {};
        pictureWaits[ask] = resolve;
        post('picture', { id: ask, query: query.slice(0, 80), w: +o.w > 0 ? Math.min(+o.w, 4000) : 0, h: +o.h > 0 ? Math.min(+o.h, 4000) : 0 });
        setTimeout(function () { if (pictureWaits[ask]) { delete pictureWaits[ask]; resolve(null); } }, 25000);
      });
    },
    tokens: boot.tokens
  };
  Object.freeze(api);
  Object.defineProperty(window, 'conduit', { value: api, writable: false, configurable: false });

  function wear(tokens) {
    var root = document.documentElement.style;
    var names = { ink: '--ink', ground: '--ground', accent: '--accent', onAccent: '--on-accent', alt: '--alt', dim: '--dim', line: '--line', good: '--good', bad: '--bad', font: '--font' };
    for (var key in names) if (typeof tokens[key] === 'string') { root.setProperty(names[key], tokens[key]); api.tokens[key] = tokens[key]; }
    if (typeof tokens.fontPx === 'number') { root.setProperty('--font-px', tokens.fontPx + 'px'); api.tokens.fontPx = tokens.fontPx; }
    if (typeof tokens.radius === 'number') { root.setProperty('--radius', tokens.radius + 'px'); api.tokens.radius = tokens.radius; }
    if (typeof tokens.gap === 'number') { root.setProperty('--gap', tokens.gap + 'px'); api.tokens.gap = tokens.gap; }
    if (typeof tokens.dark === 'boolean') root.colorScheme = tokens.dark ? 'dark' : 'light';
  }

  // A picture of the surface, for the stage's snapshots and exports. The app may draw itself (conduit.snapshot). Otherwise the document is
  // drawn as it stands: copied, written out as an SVG with the page inside a foreignObject, and drawn into a canvas.
  function sized() { return { w: Math.max(1, document.documentElement.clientWidth), h: Math.max(1, document.documentElement.clientHeight) }; }
  function finish(id, canvas, how) {
    try { post('still', { id: id, how: how, w: canvas.width, h: canvas.height, data: canvas.toDataURL('image/png') }); }
    catch (e) { post('still', { id: id, failed: 'the picture could not be read back' }); }
  }
  function fromDom(id, size) {
    var scale = Math.min(1, 960 / size.w);
    var root = document.documentElement.cloneNode(true);
    var scripts = root.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) scripts[i].remove();
    var from = document.querySelectorAll('canvas');
    var to = root.querySelectorAll('canvas');
    for (var c = 0; c < from.length && c < to.length; c++) {
      try {
        var img = document.createElement('img');
        img.setAttribute('src', from[c].toDataURL('image/png'));
        var attrs = ['id', 'class', 'style', 'width', 'height'];
        for (var a = 0; a < attrs.length; a++) if (from[c].hasAttribute(attrs[a])) img.setAttribute(attrs[a], from[c].getAttribute(attrs[a]));
        to[c].parentNode.replaceChild(img, to[c]);
      } catch (e) {}
    }
    var live = document.querySelectorAll('input,textarea,select');
    var copy = root.querySelectorAll('input,textarea,select');
    for (var f = 0; f < live.length && f < copy.length; f++) {
      var tag = live[f].tagName;
      if (tag === 'TEXTAREA') copy[f].textContent = live[f].value;
      else if (tag === 'SELECT') { for (var o = 0; o < live[f].options.length; o++) { if (live[f].options[o].selected) copy[f].options[o].setAttribute('selected', 'selected'); else copy[f].options[o].removeAttribute('selected'); } }
      else if (live[f].type === 'checkbox' || live[f].type === 'radio') { if (live[f].checked) copy[f].setAttribute('checked', 'checked'); else copy[f].removeAttribute('checked'); }
      else copy[f].setAttribute('value', live[f].value);
    }
    var xml = new XMLSerializer().serializeToString(root);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size.w + '" height="' + size.h + '"><foreignObject x="0" y="0" width="100%" height="100%">' + xml + '</foreignObject></svg>';
    var picture = new Image();
    picture.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(size.w * scale);
      canvas.height = Math.round(size.h * scale);
      var context = canvas.getContext('2d');
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ground') || '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(picture, 0, 0, canvas.width, canvas.height);
      finish(id, canvas, 'dom');
    };
    picture.onerror = function () { post('still', { id: id, failed: 'the document could not be drawn' }); };
    picture.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function shoot(id) {
    var size = sized();
    if (shooter !== null) {
      try {
        Promise.resolve(shooter()).then(function (drawn) {
          if (drawn && typeof drawn.toDataURL === 'function' && drawn.width > 0) finish(id, drawn, 'own');
          else fromDom(id, size);
        }, function () { fromDom(id, size); });
        return;
      } catch (e) {}
    }
    try { fromDom(id, size); } catch (e) { post('still', { id: id, failed: 'the document could not be copied' }); }
  }

  addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.conduit !== 1 || data.ch !== boot.ch) return;
    if (data.type === 'ping' && typeof data.n === 'number') post('pong', { n: data.n });
    else if (data.type === 'shoot' && typeof data.id === 'number') shoot(data.id);
    else if (data.type === 'picture' && typeof data.id === 'number') { var wait = pictureWaits[data.id]; if (wait) { delete pictureWaits[data.id]; wait(typeof data.url === 'string' && data.url.indexOf('data:image/') === 0 ? { url: data.url, credit: String(data.credit || '').slice(0, 300) } : null); } }
    else if (data.type === 'data' && data.tokens && typeof data.tokens === 'object') wear(data.tokens);
  });
  addEventListener('error', function (event) { post('fault', { message: String(event.message || 'error').slice(0, 200) }); });
  addEventListener('unhandledrejection', function (event) { post('fault', { message: String((event.reason && event.reason.message) || event.reason || 'rejected').slice(0, 200) }); });
  var started = false;
  var lastHeight = 0;
  var lastWidth = 0;
  function ready() { if (started) return; started = true; post('ready', {}); report(); setInterval(report, 700); }
  function report() { var h = Math.ceil(document.documentElement.scrollHeight); var w = Math.ceil(document.documentElement.scrollWidth); if (h !== lastHeight || w !== lastWidth) { lastHeight = h; lastWidth = w; post('size', { height: h, width: w }); } }
  addEventListener('resize', function () { if (started) report(); });
  // The app's own scripts were written inert (cleanMarkup) and run here, once the frame has a layout: a script that measures its room as it starts
  // (a canvas sized from its box) reads zero in a frame that has only just been made. Order is kept; the events it may have missed are told again.
  var sawDom = false;
  var sawLoad = false;
  var released = false;
  addEventListener('DOMContentLoaded', function () { sawDom = true; });
  addEventListener('load', function () { sawLoad = true; });
  function release() {
    if (released) return;
    released = true;
    var held = document.querySelectorAll('script[type="application/x-conduit-app"]');
    for (var i = 0; i < held.length; i++) {
      var live = document.createElement('script');
      live.textContent = held[i].textContent;
      held[i].parentNode.replaceChild(live, held[i]);
    }
    if (sawDom) { try { document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true })); } catch (e) {} }
    if (sawLoad) { try { window.dispatchEvent(new Event('load')); } catch (e) {} }
    ready();
  }
  function laidOut(tries) {
    var box = document.body && document.body.getBoundingClientRect();
    if ((box && box.width > 0) || tries > 60) release();
    else setTimeout(function () { laidOut(tries + 1); }, 8);
  }
  function begin() { laidOut(0); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
  else begin();
})();`;

/** The page's own base rules: the look's variables are used by them, and a real page says its own over them. */
const BASE_CSS = [
  '*,*::before,*::after{box-sizing:border-box}',
  'html,body{margin:0;min-height:100%}',
  'body{background:var(--ground);color:var(--ink);font:var(--font-px)/1.45 var(--font);-webkit-text-size-adjust:100%}',
  ':where(button,input,select,textarea){font:inherit;color:inherit}',
  ':where(button){min-height:44px;padding:0 calc(var(--gap)*1.4);border:0;border-radius:var(--radius);background:var(--accent);color:var(--on-accent);cursor:pointer}',
  ':where(input,select,textarea){min-height:44px;padding:0 var(--gap);border:1px solid var(--line);border-radius:var(--radius);background:transparent}',
  ':where(a){color:var(--accent)}',
].join('');

/** The page, whole. `channel` is the secret the host and this page share for the life of the frame; `state` is the app's saved state as JSON text, or null. */
/** `depth` false leaves the boot script's own removals out, so a check can see the policy hold alone (the hostile bench only; a host never sets it). */
export function buildSurfaceDocument(input: { readonly source: string; readonly tokens: SurfaceTokens; readonly channel: string; readonly state: string | null; readonly depth?: boolean; readonly shelf?: string }): string {
  const { tokens } = input;
  let restored: unknown = null;
  if (input.state !== null) {
    try {
      restored = JSON.parse(input.state);
    } catch {
      restored = null;
    }
  }
  const boot = scriptJson({
    ch: input.channel,
    depth: input.depth !== false,
    state: restored,
    tokens: { ink: tokens.ink, ground: tokens.ground, accent: tokens.accent, onAccent: tokens.onAccent, alt: tokens.alt, dim: tokens.dim, line: tokens.line, good: tokens.good, bad: tokens.bad, font: tokens.font, fontPx: tokens.fontPx, radius: tokens.radius, gap: tokens.gap, dark: tokens.dark },
  });
  const base = BASE_CSS;
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SURFACE_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${tokenCss(tokens)}${base}</style>`,
    `<script>${BRIDGE.replace('__BOOT__', () => boot).replace('__STATE_MAX__', String(SURFACE_LIMITS.state))}</script>`,
    // the vetted libraries the app asked for (web/src/surfaces/shelf): after the bridge (so its removals have run) and before the app's own script
    ...(input.shelf === undefined || input.shelf === '' ? [] : [input.shelf]),
    '</head><body>',
    cleanMarkup(input.source.slice(0, SURFACE_SOURCE_MAX)),
    '</body></html>',
  ].join('\n');
}

/**
 * A live app as one standalone page, ready to publish: the brain's source, the shelf libraries it used (inlined), pictures it asked for embedded as `data:`
 * addresses with their credits kept, and the bridge replaced by a small stand-in so `conduit.*` calls do not throw: `state` lives in `localStorage` (so a cart survives a
 * reload), `send` and `ask` do nothing, `snapshot` does nothing, and `picture` answers from the pictures already embedded. No policy, no frame: it is the page.
 */
export function buildStandalonePage(input: { readonly source: string; readonly tokens: SurfaceTokens; readonly shelf: string; readonly title: string; readonly pictures: Readonly<Record<string, { readonly url: string; readonly credit: string }>> }): string {
  const title = input.title.trim() === '' ? 'Page' : input.title.trim();
  const safeTitle = title.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
  const credits = Object.values(input.pictures).map((p) => p.credit).filter((c) => c !== '');
  const stub = String.raw`(function () {
  var pictures = __PICTURES__;
  var key = 'conduit.page.' + __KEY__;
  window.conduit = Object.freeze({
    send: function () {},
    ask: function () {},
    state: function (next) {
      try {
        if (arguments.length === 0) { var text = localStorage.getItem(key); return text === null ? null : JSON.parse(text); }
        localStorage.setItem(key, JSON.stringify(next));
      } catch (e) {}
      return arguments.length === 0 ? null : undefined;
    },
    snapshot: function () {},
    picture: function (query) { var found = pictures[String(query)]; return Promise.resolve(found === undefined ? null : found); },
    tokens: __TOKENS__
  });
})();`;
  const tokens = scriptJson({ ink: input.tokens.ink, ground: input.tokens.ground, accent: input.tokens.accent, onAccent: input.tokens.onAccent, alt: input.tokens.alt, dim: input.tokens.dim, line: input.tokens.line, good: input.tokens.good, bad: input.tokens.bad, font: input.tokens.font, fontPx: input.tokens.fontPx, radius: input.tokens.radius, gap: input.tokens.gap, dark: input.tokens.dark });
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    ...(credits.length === 0 ? [] : [`<!-- Picture credits:\n${credits.map((c) => c.replace(/--+/g, '-')).join('\n')}\n-->`]),
    `<style>${tokenCss(input.tokens)}${BASE_CSS}</style>`,
    `<script>${stub.replace('__PICTURES__', () => scriptJson(input.pictures)).replace('__KEY__', () => scriptJson(title)).replace('__TOKENS__', () => tokens)}</script>`,
    ...(input.shelf === '' ? [] : [input.shelf]),
    '</head><body>',
    cleanMarkup(input.source.slice(0, SURFACE_SOURCE_MAX), false),
    '</body></html>',
  ].join('\n');
}
