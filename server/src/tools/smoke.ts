// pnpm smoke: the deploy gate. A candidate build is driven through ONE scripted conversation in a real headless Chrome, the way a person
// does it (real key events into the real prompt box, real pointer or touch events on the page), and judged AT REST after every turn.
//
//   pnpm smoke [--url http://127.0.0.1:<port>] [--screens 1920x825,390x844] [--out <dir>] [--turns 1,2,3,4,5,6,7]
//              [--timeout <seconds a turn may take>] [--parallel] [--demo] [--quiet]
//
// The conversation (PLAN: the deploy gate): 1 a lighthouse at dusk; 2 a flowchart; 3 a stock chart; 4 a sign-in mock-up (the kit's screens, not a live app); 5 type into its
// fields, flip its toggle and press its button with real events; 6 an insurance home page; 7 /new.
// After each turn it waits for the page's own rest (the status line says `ready`, no turn open, nothing entering or leaving, no request in
// flight, the stage unchanged for a moment) and then checks:
//
//   prompt-registers   the typed words are in the box, Enter sends them (a turn is POSTed with them)
//   rest               the turn ended and the page came to rest, no fault, the brain did not fail
//   answer-on-stage    what the report says rests on the stage IS on the stage at rest (on screen, opaque, inked in the screenshot);
//                      what was asked for is there (a `screen` structure for a mock-up, a chart for a chart)
//   prompt-readable    the prompt box's text and placeholder: computed contrast >= 4.5, and as rendered in pixels with real typing
//   chrome-readable    every visible chrome button's label: computed contrast >= 4.5 (icons 3), and as rendered in pixels
//   no-overlap         no words on words: the stage's text boxes, the words of a mock-up, the painter's own sight notes
//   nothing-cut-off    nothing outside the stage, no page scrollbars, no chrome off the screen
//   no-console-errors  nothing logged as an error, nothing thrown
//   no-failed-requests no request failed or answered 4xx/5xx
//   interactions       (turn 5) typing changes a field, a tap changes state, the button press reaches the server as an `act`
//
// It saves a screenshot per turn and a contact sheet per screen, prints PASS/FAIL per check per turn and exits 1 on any FAIL.
// Nothing here is part of the server. Chrome is started here and stopped on exit.

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NEW_COMMAND_TEXT } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { Cdp, CHROME_CANDIDATES, sleep, stop, waitFor } from './explore-browser';

// ---------------------------------------------------------------------------------------------------------------------------------
// What is asked

type Verdict = 'PASS' | 'FAIL' | 'SKIP';
interface CheckResult {
  readonly turn: number;
  readonly check: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

interface Step {
  readonly n: number;
  /** what is typed (`/new` is a command: the page turns it into a turn of its own) */
  readonly say: string | null;
  readonly name: string;
  /** what the answer must put on stage */
  readonly expects: 'drawing' | 'structure' | 'chart' | 'screen' | 'interact' | 'any';
}

const STEPS: readonly Step[] = [
  { n: 1, say: 'draw a lighthouse at dusk', name: 'lighthouse', expects: 'drawing' },
  { n: 2, say: 'explain how a bill becomes a law, as a flowchart', name: 'flowchart', expects: 'structure' },
  { n: 3, say: "show Apple's stock over 2024 as a chart", name: 'chart', expects: 'chart' },
  // "mock-up" with its hyphen: the live-app block taught since v2.1-app takes "mock up … I can click through" for a request for something that works, and this turn judges the interface kit
  { n: 4, say: 'mock up a sign-in screen I can click through', name: 'sign-in', expects: 'screen' },
  { n: 5, say: null, name: 'interact', expects: 'interact' },
  { n: 6, say: 'mock up the home page for an insurance company', name: 'insurance-home', expects: 'screen' },
  { n: 7, say: '/new', name: 'new', expects: 'any' },
];

const CHECKS = ['prompt-registers', 'rest', 'answer-on-stage', 'prompt-readable', 'chrome-readable', 'no-overlap', 'nothing-cut-off', 'no-console-errors', 'no-failed-requests', 'interactions'] as const;

const TEXT_CONTRAST = 4.5;
const ICON_CONTRAST = 3;
/** pixels carry anti-aliasing: thin type never reaches its full colour, so the rendered measure is held to a little less than the computed one */
const PIXEL_CONTRAST = 3;
/** how long the stage must stand unchanged, with nothing in flight, to be at rest */
const STABLE_MS = 2200;

// ---------------------------------------------------------------------------------------------------------------------------------
// Arguments

interface Options {
  readonly url: string;
  readonly screens: readonly { readonly name: string; readonly width: number; readonly height: number }[];
  readonly out: string;
  readonly turns: ReadonlySet<number>;
  readonly timeoutMs: number;
  readonly parallel: boolean;
  readonly demo: boolean;
  readonly quiet: boolean;
}

function usage(message: string): never {
  process.stderr.write(`smoke: ${message}\nusage: pnpm smoke [--url http://127.0.0.1:<port>] [--screens 1920x825,390x844] [--out <dir>] [--turns 1,2,3,4,5,6,7] [--timeout <seconds>] [--parallel] [--demo] [--quiet]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) usage(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (['parallel', 'demo', 'quiet'].includes(name)) flags.set(name, 'true');
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
      flags.set(name, value);
      i += 1;
    }
  }
  const screens = (flags.get('screens') ?? '1920x825,390x844').split(',').map((text) => {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(text.trim());
    if (match === null) usage(`bad screen ${text}: say 1920x825`);
    return { name: text.trim(), width: Number(match[1]), height: Number(match[2]) };
  });
  const turns = new Set((flags.get('turns') ?? STEPS.map((step) => step.n).join(',')).split(',').map(Number));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    url: (flags.get('url') ?? process.env['SMOKE_URL'] ?? 'http://127.0.0.1:4870').replace(/\/+$/, ''),
    screens,
    out: resolve(flags.get('out') ?? join(tmpdir(), 'conduit-smoke', stamp)),
    turns,
    timeoutMs: Number(flags.get('timeout') ?? 240) * 1000,
    parallel: flags.has('parallel'),
    demo: flags.has('demo'),
    quiet: flags.has('quiet'),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The page's half: small, pure measuring functions the gate hands to the page once. They read what the page really is: computed styles,
// the painter's own hook (`window.__stage`) and the pixels of a screenshot. Written as text so that no compiler helper is in it.

const PAGE_LIB = String.raw`(() => {
  if (window.__smoke) return;
  const cv = document.createElement('canvas');
  cv.width = 1; cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bottom) => { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]; };
  const hex = (c) => '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // what is really behind an element: its own and its ancestors' background colours laid over one another (a gradient or an image is flagged)
  const behind = (el) => {
    const stack = [];
    let image = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') image = true;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) { stack.push(c); if (c[3] >= 0.999) break; }
    }
    let base = [255, 255, 255, 1];
    if (!(stack.length > 0 && stack[stack.length - 1][3] >= 0.999)) {
      const root = rgba(getComputedStyle(document.documentElement).backgroundColor);
      if (root[3] > 0) base = over(root, base);
    }
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return { rgb: base, image };
  };
  const opacityOf = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  // the colour the words are painted in: the text fill, at the opacity the element and its ancestors have, over what is behind
  const inkOf = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    let css = cs.color;
    const fill = cs.webkitTextFillColor;
    if (fill && fill !== '' && fill !== css) css = fill;
    const c = rgba(css);
    const bg = behind(el);
    const o = opacityOf(el) * c[3];
    const fg = over([c[0], c[1], c[2], o], bg.rgb);
    return { fg, bg: bg.rgb, image: bg.image, ratio: ratio(fg, bg.rgb), colour: css };
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    if (el.closest('[hidden]') || el.closest('[data-access]') || el.closest('[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
  };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

  const probe = () => {
    const s = window.__stage;
    if (!s) return { ready: false };
    const st = s.state();
    const status = (document.querySelector('.prompt__status') || {}).textContent || '';
    // what is on stage and in what phase, not where: ambient loops (a glow that breathes, a beam that pulses) never stand still
    const els = st.elements.map((e) => [e.id, e.kind, e.phase]);
    const reports = s.events().filter((e) => e.type === 'report').map((e) => e.report.turn);
    return {
      ready: true, status, turn: st.turn, clock: st.clock, anticipating: st.anticipating, fault: st.fault, stall: st.glyphStall,
      reports, sig: JSON.stringify(els), moving: els.some((e) => e[2] === 'entering' || e[2] === 'leaving'), count: els.length,
      charts: st.charts.length, look: st.look, viewport: st.viewport, mockups: typeof s.mockups === 'function' ? s.mockups().length : -1,
    };
  };

  const promptInfo = () => {
    const el = document.querySelector('.prompt__input');
    if (!el) return null;
    const typed = inkOf(el, null);
    const placeholder = inkOf(el, '::placeholder');
    return { rect: rectOf(el), value: el.value, typed: { ratio: typed.ratio, colour: hex(typed.fg), bg: hex(typed.bg), image: typed.image, css: typed.colour }, placeholder: { ratio: placeholder.ratio, colour: hex(placeholder.fg), css: placeholder.colour } };
  };

  const chromeButtons = () => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('button, [role="button"], a[href], summary, select, input[type="button"], input[type="submit"]')) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const iconOnly = text === '';
      const i = inkOf(el, null);
      out.push({ label: text || aria || el.className || el.tagName.toLowerCase(), iconOnly, rect: rectOf(el), ratio: i.ratio, colour: hex(i.fg), bg: hex(i.bg), image: i.image, status: el.classList.contains('prompt__status') });
    }
    return out;
  };

  const answer = () => {
    const s = window.__stage;
    const reports = s.events().filter((e) => e.type === 'report');
    const last = reports[reports.length - 1];
    const live = s.elements().map((e) => ({ id: e.id, kind: e.kind, text: e.text.slice(0, 70), phase: e.phase, opacity: e.opacity, box: e.box, layer: e.layer, contrast: e.contrast, fontPx: e.fontPx, painting: e.painting }));
    const base = { live, charts: s.charts().map((c) => ({ id: c.id, kind: c.kind, waiting: c.waiting, points: c.points, box: c.box })), controls: s.controls().map((c) => ({ id: c.id, control: c.control, label: c.label, enabled: c.enabled, box: c.box })), script: s.script(), viewport: s.state().viewport, hasHook: typeof s.mockups === 'function', mockups: typeof s.mockups === 'function' ? s.mockups() : [] };
    if (!last) return Object.assign({ report: null }, base);
    const r = last.report;
    return Object.assign({
      report: {
        turn: r.turn, outcome: r.outcome,
        shown: r.shown.map((x) => ({ id: x.id, kind: x.kind, text: String(x.text).slice(0, 60), struck: x.struck, partial: x.partial, part: !!x.part })),
        sight: r.sight.items.map((i) => ({ id: i.id, kind: i.kind, resting: i.resting, notes: i.notes })),
        stage: r.stage.elements.map((e) => ({ id: e.id, kind: e.kind, struck: e.struck, parent: e.parent, structure: e.figure && e.figure.kind === 'structure' ? e.figure.structure : null, rows: e.figure && e.figure.kind === 'structure' ? e.figure.rows.length : 0 })),
      },
    }, base);
  };

  const load = (url) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('picture did not load')); i.src = url; });
  const pixelsOf = async (url) => {
    const img = await load(url);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { g, width: img.width, height: img.height };
  };
  const modal = (d) => {
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) { const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); hist.set(k, (hist.get(k) || 0) + 1); }
    let best = 0, key = 0;
    for (const [k, n] of hist) if (n > best) { best = n; key = k; }
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); if (k === key) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; } }
    return [r / n, gg / n, b / n, 1];
  };
  // how a region of a picture reads: the colour most of it is (its ground), and the colour its marks are (the ones farthest from the ground)
  const analyse = async (url, rects, scale) => {
    const { g, width, height } = await pixelsOf(url);
    return rects.map((r) => {
      const x = Math.max(0, Math.floor(r.x * scale)), y = Math.max(0, Math.floor(r.y * scale));
      const w = Math.min(width - x, Math.ceil(r.w * scale)), h = Math.min(height - y, Math.ceil(r.h * scale));
      if (w <= 0 || h <= 0) return { blank: true, ratio: 0, ink: 0, outside: true };
      const d = g.getImageData(x, y, w, h).data;
      const bg = modal(d);
      const dist = new Float32Array(d.length / 4);
      let max = 0, differing = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) { const v = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]); dist[p] = v; if (v > max) max = v; if (v > 60) differing++; }
      const total = w * h;
      if (differing < Math.max(4, 0.002 * total)) return { blank: true, ratio: 1, ink: differing / total, bg: hex(bg) };
      let r2 = 0, g2 = 0, b2 = 0, n = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) if (dist[p] >= 0.75 * max) { r2 += d[i]; g2 += d[i + 1]; b2 += d[i + 2]; n++; }
      const fg = [r2 / n, g2 / n, b2 / n, 1];
      return { blank: false, ratio: ratio(fg, bg), ink: differing / total, fg: hex(fg), bg: hex(bg) };
    });
  };
  // how many pixels of each region are unlike the stage's own ground: whether something is drawn there at all
  const inkIn = async (url, rects, scale) => {
    const { g, width, height } = await pixelsOf(url);
    const sample = g.getImageData(0, 0, width, height).data;
    const small = [];
    for (let i = 0; i < sample.length; i += 16) small.push(sample[i], sample[i + 1], sample[i + 2], 255);
    const ground = modal(small);
    return rects.map((r) => {
      const x = Math.max(0, Math.floor(r.x * scale)), y = Math.max(0, Math.floor(r.y * scale));
      const w = Math.min(width - x, Math.ceil(r.w * scale)), h = Math.min(height - y, Math.ceil(r.h * scale));
      if (w <= 0 || h <= 0) return { px: 0, share: 0, outside: true };
      const d = g.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - ground[0]) + Math.abs(d[i + 1] - ground[1]) + Math.abs(d[i + 2] - ground[2]) > 36) n++;
      return { px: n, share: n / (w * h) };
    });
  };
  // the share of pixels that differ between two pictures of one region
  const changed = async (a, b) => {
    const pa = await pixelsOf(a), pb = await pixelsOf(b);
    if (pa.width !== pb.width || pa.height !== pb.height) return 1;
    const da = pa.g.getImageData(0, 0, pa.width, pa.height).data, db = pb.g.getImageData(0, 0, pb.width, pb.height).data;
    let n = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
    return n / (pa.width * pa.height);
  };
  const page = () => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: window.innerWidth, ih: window.innerHeight, bw: document.body.scrollWidth, bh: document.body.scrollHeight });
  window.__smoke = { probe, promptInfo, chromeButtons, answer, analyse, inkIn, changed, page };
})();`;

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Logged {
  readonly at: number;
  readonly text: string;
}

interface Posted {
  readonly at: number;
  readonly url: string;
  readonly kind: string | null;
  readonly text: string | null;
  /** what was posted, as sent */
  readonly body: string;
}

/** One headless Chrome with one page, driven over the DevTools protocol, and everything it reported: console errors, failed requests, requests in flight, turns POSTed. */
class Tab {
  readonly consoleErrors: Logged[] = [];
  readonly failedRequests: Logged[] = [];
  readonly posted: Posted[] = [];
  /** the pictures of the resting stage the page has sent the server, by turn: what the brain is shown next turn */
  readonly snapshots = new Map<string, string>();
  private readonly flying = new Map<string, string>();
  private consumed = { consoleErrors: 0, failedRequests: 0 };

  private constructor(
    readonly browser: Cdp,
    readonly session: string,
    private readonly child: ChildProcess,
    private readonly profile: string,
    readonly width: number,
    readonly height: number,
    readonly mobile: boolean,
    readonly dpr: number,
  ) {
    browser.onEvent((event) => {
      if (event.sessionId !== session) return;
      const p = event.params as Record<string, any>;
      const now = Date.now();
      switch (event.method) {
        case 'Runtime.consoleAPICalled':
          if (p['type'] === 'error' || p['type'] === 'assert') this.consoleErrors.push({ at: now, text: (p['args'] as { value?: unknown; description?: string }[]).map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 300) });
          break;
        case 'Runtime.exceptionThrown':
          this.consoleErrors.push({ at: now, text: `uncaught: ${String(p['exceptionDetails']?.exception?.description ?? p['exceptionDetails']?.text ?? '').split('\n')[0]?.slice(0, 300)}` });
          break;
        case 'Log.entryAdded':
          // a failed request is counted once, as a failed request
          if (p['entry']?.level === 'error' && p['entry']?.source !== 'network') this.consoleErrors.push({ at: now, text: `${p['entry']?.source}: ${String(p['entry']?.text).slice(0, 300)}` });
          break;
        case 'Network.requestWillBeSent': {
          const request = p['request'] as { url: string; method: string; postData?: string };
          if (!/\/stream(\?|$)/.test(request.url) && !/^(blob|data):/.test(request.url)) this.flying.set(String(p['requestId']), request.url);
          const snap = /\/api\/sessions\/[^/]+\/turns\/([^/]+)\/snapshot$/.exec(request.url);
          if (request.method === 'POST' && snap !== null) this.snapshots.set(snap[1] as string, request.url);
          if (request.method === 'POST' && /\/api\/sessions\/[^/]+\/turns$/.test(request.url)) {
            let kind: string | null = null;
            let text: string | null = null;
            try {
              const body = JSON.parse(request.postData ?? '{}') as { input?: { kind?: string; text?: string } };
              kind = body.input?.kind ?? null;
              text = body.input?.text ?? null;
            } catch {
              // a body the gate cannot read is still a turn
            }
            this.posted.push({ at: now, url: request.url, kind, text, body: request.postData ?? '' });
          }
          break;
        }
        case 'Network.loadingFinished':
          this.flying.delete(String(p['requestId']));
          break;
        case 'Network.loadingFailed': {
          const url = this.flying.get(String(p['requestId'])) ?? String(p['requestId']);
          this.flying.delete(String(p['requestId']));
          // a request the page itself gave up on (a stream closed, a fetch aborted) is not a failure of the build
          if (p['canceled'] === true) break;
          this.failedRequests.push({ at: now, text: `${url} ${String(p['errorText'])}` });
          break;
        }
        case 'Network.responseReceived': {
          const response = p['response'] as { url: string; status: number };
          if (response.status >= 400) this.failedRequests.push({ at: now, text: `${response.url} answered ${response.status}` });
          break;
        }
        default:
      }
    });
  }

  static async open(width: number, height: number): Promise<Tab> {
    const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
    if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
    const profile = await mkdtemp(join(tmpdir(), 'conduit-smoke-'));
    const child = spawnTracked(
      chrome,
      ['--headless=new', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'],
      undefined,
      { quiet: true },
    );
    try {
      const endpoint = await waitFor('Chrome', 20_000, async () => {
        const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
        const [port, path] = text.split('\n');
        return port !== undefined && path !== undefined ? `ws://127.0.0.1:${port}${path}` : null;
      });
      const browser = await Cdp.open(endpoint);
      const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const mobile = width < 600;
      const dpr = mobile ? 2 : 1;
      const tab = new Tab(browser, sessionId, child, profile, width, height, mobile, dpr);
      for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await tab.send(`${domain}.enable`);
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
      if (mobile) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_LIB });
      return tab;
    } catch (error) {
      await stop(child);
      await rm(profile, { recursive: true, force: true });
      throw error;
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.session);
  }

  async eval<T>(expression: string): Promise<T> {
    const out = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result.value as T;
  }

  /** a call to one of the page library's functions with JSON arguments */
  call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`window.__smoke.${fn}(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
  }

  pending(): number {
    return this.flying.size;
  }

  pendingUrls(): string[] {
    return [...this.flying.values()].map((url) => url.replace(/^https?:\/\/[^/]+/, '').slice(0, 80));
  }

  /** what the console and the network reported since the last time this was asked */
  drain(): { readonly consoleErrors: readonly Logged[]; readonly failedRequests: readonly Logged[] } {
    const out = { consoleErrors: this.consoleErrors.slice(this.consumed.consoleErrors), failedRequests: this.failedRequests.slice(this.consumed.failedRequests) };
    this.consumed = { consoleErrors: this.consoleErrors.length, failedRequests: this.failedRequests.length };
    return out;
  }

  /** a picture of the page as a data URL (PNG), whole or one region of it in CSS pixels */
  async shot(clip?: Box): Promise<string> {
    const out = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      ...(clip === undefined ? {} : { clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: Math.max(1, clip.width), height: Math.max(1, clip.height), scale: 1 } }),
    });
    return `data:image/png;base64,${out.data}`;
  }

  // ---- real input

  /** a click with a mouse, or a tap with a finger on a phone: the page gets real pointer events either way */
  async tap(x: number, y: number): Promise<void> {
    if (this.mobile) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await sleep(60);
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      await sleep(40);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    }
    await sleep(80);
  }

  async key(key: 'Enter' | 'Backspace'): Promise<void> {
    const code = key === 'Enter' ? 13 : 8;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  }

  async type(text: string): Promise<void> {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await sleep(60);
  }

  async close(): Promise<void> {
    this.browser.close();
    await stop(this.child);
    await rm(this.profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the page tells

interface Probe {
  readonly ready: boolean;
  readonly status: string;
  readonly turn: string | null;
  readonly clock: string;
  readonly anticipating: boolean;
  readonly fault: string | null;
  readonly stall: boolean;
  readonly reports: readonly string[];
  readonly sig: string;
  readonly moving: boolean;
  readonly count: number;
  readonly charts: number;
  readonly look: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly mockups: number;
}

interface PromptInfo {
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly value: string;
  readonly typed: { readonly ratio: number; readonly colour: string; readonly bg: string; readonly image: boolean; readonly css: string };
  readonly placeholder: { readonly ratio: number; readonly colour: string; readonly css: string };
}

interface ButtonInfo {
  readonly label: string;
  readonly iconOnly: boolean;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly ratio: number;
  readonly colour: string;
  readonly bg: string;
  readonly image: boolean;
  readonly status: boolean;
}

interface LiveElement {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly phase: string;
  readonly opacity: number;
  readonly box: Box;
  readonly layer: string;
  readonly contrast: number;
  readonly fontPx: number;
  readonly painting: string | null;
}

interface MockupView {
  readonly screen: string;
  readonly hits: readonly { readonly id: string; readonly part: string; readonly action: string; readonly box: Box; readonly send?: boolean; readonly to?: string }[];
  readonly words: readonly { readonly owner: string; readonly text: string; readonly box: Box }[];
  readonly notes: readonly { readonly kind: string; readonly id: string; readonly message: string }[];
}

interface Answer {
  readonly report: {
    readonly turn: string;
    readonly outcome: string;
    readonly shown: readonly { readonly id: string; readonly kind: string; readonly text: string; readonly struck: boolean; readonly partial: boolean; readonly part: boolean }[];
    readonly sight: readonly { readonly id: string; readonly kind: string; readonly resting: boolean; readonly notes: readonly string[] }[];
    readonly stage: readonly { readonly id: string; readonly kind: string; readonly struck: boolean; readonly parent: string | null; readonly structure: string | null; readonly rows: number }[];
  } | null;
  readonly live: readonly LiveElement[];
  readonly charts: readonly { readonly id: string; readonly kind: string; readonly waiting: boolean; readonly points: number; readonly box: Box }[];
  readonly controls: readonly { readonly id: string; readonly control: string; readonly label: string; readonly enabled: boolean; readonly box: Box }[];
  readonly script: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly hasHook: boolean;
  readonly mockups: readonly MockupView[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One conversation on one screen

interface TurnRecord {
  readonly step: Step;
  readonly said: string;
  readonly picture: string;
  readonly seconds: number;
  readonly results: CheckResult[];
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
const round = (n: number): number => Math.round(n);
const intersection = (a: Box, b: Box): number => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const area = (a: Box): number => Math.max(0, a.width) * Math.max(0, a.height);
const boxText = (b: Box): string => `${round(b.width)}x${round(b.height)} at ${round(b.x)},${round(b.y)}`;
const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

class Conversation {
  private readonly records: TurnRecord[] = [];
  private seenReports = new Set<string>();
  private lastSig = '';
  private stableSince = 0;
  private current = 0;
  private note: (text: string) => void;

  private constructor(
    private readonly tab: Tab,
    private readonly options: Options,
    private readonly screen: Options['screens'][number],
    private readonly dir: string,
  ) {
    this.note = (text) => {
      if (!options.quiet) process.stdout.write(`[${screen.name}] ${text}\n`);
    };
  }

  static async run(options: Options, screen: Options['screens'][number]): Promise<{ readonly records: readonly TurnRecord[]; readonly seconds: number; readonly sheet: string | null; readonly dir: string }> {
    const dir = join(options.out, screen.name);
    await mkdir(dir, { recursive: true });
    const started = Date.now();
    const tab = await Tab.open(screen.width, screen.height);
    try {
      const talk = new Conversation(tab, options, screen, dir);
      await talk.start();
      for (const step of STEPS) {
        if (!options.turns.has(step.n)) continue;
        await talk.turn(step);
      }
      const sheet = await talk.contactSheet();
      return { records: talk.records, seconds: (Date.now() - started) / 1000, sheet, dir };
    } finally {
      await tab.close();
    }
  }

  private add(results: CheckResult[], check: string, verdict: Verdict, detail: string): void {
    results.push({ turn: this.current, check, verdict, detail });
  }

  private async start(): Promise<void> {
    const { tab } = this;
    await tab.send('Page.navigate', { url: `${this.options.url}/${this.options.demo ? '' : '?demo=none'}` });
    await waitFor('the page to be ready', 60_000, async () => {
      const probe = await tab.call<Probe>('probe').catch(() => null);
      return probe !== null && probe.ready ? probe : null;
    });
    await tab.eval('window.__stage.ready');
    const first = await this.rest(null, false);
    this.note(`page ready (${first})`);
    this.seenReports = new Set((await tab.call<Probe>('probe')).reports);
  }

  /** waits for the page's own rest; returns a sentence about how it went (empty when all is well) */
  private async rest(expectReport: boolean | null, requireNewReport = true): Promise<string> {
    const { tab } = this;
    const deadline = Date.now() + this.options.timeoutMs;
    this.lastSig = '';
    this.stableSince = Date.now();
    let problem = '';
    for (;;) {
      await sleep(300);
      const probe = await tab.call<Probe>('probe');
      if (!probe.ready) continue;
      const fresh = probe.reports.filter((turn) => !this.seenReports.has(turn));
      const failed = /^(the brain failed|the brain went quiet|connection lost|stage unavailable)/.test(probe.status);
      if (failed) return probe.status;
      const done = !requireNewReport || expectReport === false || fresh.length > 0;
      const quiet = probe.status === 'ready' && probe.turn === null && !probe.anticipating && !probe.moving && tab.pending() === 0;
      const stage = `${probe.sig}|${probe.count}|${probe.mockups}`;
      if (!(done && quiet) || stage !== this.lastSig) {
        this.lastSig = stage;
        this.stableSince = Date.now();
      }
      if (done && quiet && Date.now() - this.stableSince >= STABLE_MS) {
        for (const turn of probe.reports) this.seenReports.add(turn);
        if (probe.fault !== null) problem = `the painter reports a fault: ${probe.fault}`;
        else if (probe.stall) problem = 'the glyph renderer stalled (words could not be typeset for more than 4 s)';
        return problem;
      }
      if (Date.now() > deadline) {
        return `no rest within ${Math.round(this.options.timeoutMs / 1000)} s (status "${probe.status}", clock ${probe.clock}, turn ${probe.turn ?? 'none'}, new report ${fresh.length > 0 ? 'yes' : 'no'}, ${tab.pending()} requests in flight${tab.pending() > 0 ? ` (${tab.pendingUrls().join(', ')})` : ''}, ${probe.moving ? 'elements still moving' : 'stage still'})`;
      }
    }
  }

  /** a real person's way of speaking: a click in the box, keys, Enter. Returns what went wrong, if anything. */
  private async say(text: string, results: CheckResult[]): Promise<boolean> {
    const { tab } = this;
    const info = await tab.call<PromptInfo | null>('promptInfo');
    if (info === null) {
      this.add(results, 'prompt-registers', 'FAIL', 'there is no prompt box on the page');
      return false;
    }
    const mark = tab.posted.length;
    await tab.tap(info.rect.x + info.rect.w / 2, info.rect.y + info.rect.h / 2);
    await tab.type(text);
    const typed = (await tab.call<PromptInfo>('promptInfo')).value;
    await tab.key('Enter');
    const wanted = text === '/new' ? NEW_COMMAND_TEXT : text;
    let posted: Posted | undefined;
    for (let waited = 0; waited < 8000 && posted === undefined; waited += 200) {
      posted = tab.posted.slice(mark).find((turn) => turn.text === wanted);
      if (posted === undefined) await sleep(200);
    }
    const left = (await tab.call<PromptInfo>('promptInfo')).value;
    const problems: string[] = [];
    if (typed !== text) problems.push(`typed "${text}" but the box held "${typed}"`);
    if (posted === undefined) problems.push(`Enter did not send a turn with "${wanted.slice(0, 40)}"`);
    if (left !== '') problems.push(`the box was not cleared after sending ("${left.slice(0, 30)}")`);
    this.add(results, 'prompt-registers', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `"${text}" typed with ${text.length} key presses, Enter sent a turn` : problems.join('; '));
    return posted !== undefined;
  }

  async turn(step: Step): Promise<void> {
    const { tab } = this;
    this.current = step.n;
    const results: CheckResult[] = [];
    const began = Date.now();
    tab.drain();
    let said = step.say ?? '';
    let restNote = '';
    let sent = true;
    if (step.say !== null) {
      this.note(`turn ${step.n}: ${step.say}`);
      sent = await this.say(step.say, results);
      restNote = sent ? await this.rest(true) : 'the turn never started';
    } else {
      this.note(`turn ${step.n}: work the mock-up`);
      const out = await this.interact(results);
      said = out.said;
      restNote = out.rest;
    }
    this.add(results, 'rest', restNote === '' ? 'PASS' : 'FAIL', restNote === '' ? `at rest ${((Date.now() - began) / 1000).toFixed(0)} s after asking` : restNote);

    // everything below judges the page AT REST
    const picture = await tab.shot();
    const file = `t${step.n}-${step.name}.png`;
    await writeFile(join(this.dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
    const answer = await tab.call<Answer>('answer');
    await writeFile(join(this.dir, file.replace(/\.png$/, '.answer.json')), JSON.stringify({ look: (await tab.call<Probe>('probe')).look, ...answer }, null, 1));
    await this.checkAnswer(step, answer, picture, results);
    await this.checkPrompt(results);
    await this.checkChrome(picture, results);
    this.checkOverlap(step, answer, results);
    await this.checkCutOff(answer, results);
    const logged = tab.drain();
    this.add(results, 'no-console-errors', logged.consoleErrors.length === 0 ? 'PASS' : 'FAIL', logged.consoleErrors.length === 0 ? 'nothing logged as an error' : `${logged.consoleErrors.length}: ${[...new Set(logged.consoleErrors.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
    this.add(results, 'no-failed-requests', logged.failedRequests.length === 0 ? 'PASS' : 'FAIL', logged.failedRequests.length === 0 ? 'every request answered' : `${logged.failedRequests.length}: ${[...new Set(logged.failedRequests.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
    this.records.push({ step, said, picture: file, seconds: (Date.now() - began) / 1000, results });
    for (const result of results) if (result.verdict === 'FAIL') this.note(`  FAIL ${result.check}: ${result.detail.slice(0, 200)}`);
  }

  // ---- answer on stage

  private async checkAnswer(step: Step, answer: Answer, picture: string, results: CheckResult[]): Promise<void> {
    const problems: string[] = [];
    const facts: string[] = [];
    const report = answer.report;
    const view = answer.viewport;
    if (report === null) problems.push('no report: the turn never ended on the page');
    const liveById = new Map<string, LiveElement[]>();
    for (const element of answer.live) liveById.set(element.id, [...(liveById.get(element.id) ?? []), element]);
    if (report !== null) {
      if (report.outcome !== 'finished') problems.push(`the turn ended "${report.outcome}"`);
      // what the report says rests on the stage must be on the stage
      const resting = report.stage.filter((element) => !element.struck && element.parent === null && !['field', 'node', 'link', 'copy'].includes(element.kind));
      const missing: string[] = [];
      const offscreen: string[] = [];
      const inked: LiveElement[] = [];
      for (const element of resting) {
        const lives = liveById.get(element.id) ?? [];
        const here = lives.find((candidate) => candidate.phase === 'on') ?? lives.find((candidate) => candidate.phase !== 'struck' && candidate.phase !== 'leaving');
        if (here === undefined) {
          missing.push(`${element.id} (${element.kind}${element.structure === null ? '' : ` ${element.structure}`})`);
          continue;
        }
        // a drawn thing may run on past the screen's edge (a sea, a sky); words and diagrams may not
        if (['text', 'structure'].includes(here.kind) && intersection(here.box, { x: 0, y: 0, width: view.width, height: view.height }) < 0.9 * area(here.box)) offscreen.push(`${element.id} ${boxText(here.box)}`);
        if (['text', 'structure', 'picture', 'sprite'].includes(here.kind) && area(here.box) > 400) inked.push(here);
      }
      if (missing.length > 0) problems.push(`in the report's resting stage but not on screen at rest: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`);
      if (offscreen.length > 0) problems.push(`outside the screen: ${offscreen.slice(0, 3).join(', ')}`);
      // and it must really be drawn there: pixels, not the painter's say-so
      if (inked.length > 0) {
        const marks = await this.tab.call<{ px: number; share: number }[]>('inkIn', picture, inked.map((element) => ({ x: element.box.x, y: element.box.y, w: element.box.width, h: element.box.height })), this.tab.dpr);
        const blank = inked.filter((_, index) => (marks[index]?.px ?? 0) < 12 * this.tab.dpr * this.tab.dpr);
        if (blank.length > 0) problems.push(`listed on stage but nothing is drawn where it is in the screenshot: ${blank.slice(0, 4).map((element) => `${element.id} (${element.kind}) ${boxText(element.box)}`).join(', ')}`);
        facts.push(`${inked.length - blank.length}/${inked.length} inked`);
      }
      // (words get 24 px of play: a snapshot is drawn a moment after the page was last looked at)
      // the picture the page sent the server for the brain's next brief (the resting stage as a snapshot) must show them too
      if (inked.length > 0) {
        const note = await this.checkSnapshot(report.turn, inked, view);
        if (note.problem !== null) problems.push(note.problem);
        facts.push(note.fact);
      }
      const lost = report.sight.filter((item) => item.resting && item.notes.includes('lost')).map((item) => item.id);
      if (lost.length > 0) problems.push(`the painter says the answer's last line is not on the stage at rest (${lost.join(', ')})`);
      const turnShown = report.shown.filter((item) => !item.part && !item.struck);
      facts.push(`${resting.length} resting, ${turnShown.length} shown this turn`);
      // what was asked for
      const written = /^\s*screen\b/m.test(answer.script);
      const screens = report.stage.filter((element) => element.structure === 'screen');
      const structures = report.stage.filter((element) => element.kind === 'structure' && element.structure !== 'screen');
      switch (step.expects) {
        case 'screen': {
          if (!written) problems.push('a mock-up was asked for but no `screen` was written');
          else {
            if (screens.length === 0) problems.push('a `screen` was written but no screen structure rests on the stage');
            const onStage = answer.live.filter((element) => element.kind === 'structure' && screens.some((screen) => screen.id === element.id));
            if (screens.length > 0 && onStage.length === 0) problems.push('the screen structure is in the resting stage but not on screen');
            if (answer.hasHook && screens.length > 0 && answer.mockups.length === 0) problems.push('the screen structure is on stage but the painter lays out no mock-up (nothing to look at or touch)');
            else if (answer.hasHook && answer.mockups.every((mock) => mock.words.length === 0)) problems.push('the mock-up has no words at all');
            // the smallest type of a mock-up that is being worked must read on the screen as drawn (a wide stage: the census's 12 px desk floor, less a quarter of a pixel
            // for rounding; a phone's room cannot hold a phone's worth of screen at more than about 9 px, which is the least the kit sets)
            const smallest = Math.min(...onStage.map((element) => (element.fontPx > 0 ? element.fontPx : Number.POSITIVE_INFINITY)));
            const floor = view.width < 600 ? 9 : 11.75;
            if (Number.isFinite(smallest) && smallest < floor) problems.push(`the smallest type in the mock-up is ${smallest.toFixed(1)} px on the screen (it must be at least ${floor})`);
            else if (Number.isFinite(smallest)) facts.push(`smallest type ${smallest.toFixed(1)} px`);
            facts.push(`${screens.length} screen(s), ${answer.mockups.reduce((n, mock) => n + mock.hits.length, 0)} live parts`);
          }
          break;
        }
        case 'structure':
          if (structures.length === 0) problems.push('a flowchart was asked for but no structure rests on the stage');
          break;
        case 'chart':
          if (answer.charts.length === 0 && !structures.some((element) => element.structure === 'chart')) problems.push('a chart was asked for but no chart is on the stage');
          else if (answer.charts.length > 0 && answer.charts.every((chart) => chart.points === 0)) problems.push('the chart on stage has no points');
          break;
        case 'drawing':
          if (!report.stage.some((element) => !['text', 'field'].includes(element.kind))) problems.push('a drawing was asked for but only words rest on the stage');
          break;
        default:
      }
    } else if (step.expects === 'interact') facts.push('no turn to report');
    this.add(results, 'answer-on-stage', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? facts.filter((fact) => fact !== '').join('; ') || 'on stage' : problems.join('; '));
  }

  /** the snapshot the server holds for a turn, fetched back by its address, and inked where the elements are */
  private async checkSnapshot(turn: string, inked: readonly LiveElement[], view: { readonly width: number; readonly height: number }): Promise<{ readonly problem: string | null; readonly fact: string }> {
    const { tab } = this;
    for (let waited = 0; waited < 10_000 && !tab.snapshots.has(turn); waited += 250) await sleep(250);
    const address = tab.snapshots.get(turn);
    if (address === undefined) return { problem: `the page sent no snapshot of the resting stage for turn ${turn} (the brain is told nothing of how it landed)`, fact: 'no snapshot' };
    const data = await tab.eval<string | null>(`fetch(${JSON.stringify(address)}).then((r) => r.ok ? r.blob() : null).then((b) => b ? new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); }) : null)`);
    if (data === null) return { problem: `the snapshot of turn ${turn} cannot be fetched back from the server`, fact: 'snapshot missing' };
    const size = await tab.eval<{ w: number; h: number }>(`new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.width, h: i.height }); i.src = ${JSON.stringify(data)}; })`);
    const scale = size.w / view.width;
    const marks = await tab.call<{ px: number }[]>('inkIn', data, inked.map((element) => (element.kind === 'text' ? { x: element.box.x - 24, y: element.box.y - 24, w: element.box.width + 48, h: element.box.height + 48 } : { x: element.box.x, y: element.box.y, w: element.box.width, h: element.box.height })), scale);
    const blank = inked.filter((_, index) => (marks[index]?.px ?? 0) < Math.max(6, 12 * scale * scale));
    if (blank.length > 0) return { problem: `the snapshot of the resting stage (${size.w}x${size.h}, what the brain is shown next) has nothing where ${blank.slice(0, 4).map((element) => `${element.id} (${element.kind})`).join(', ')} ${blank.length === 1 ? 'is' : 'are'}: the answer is not in the picture at rest`, fact: 'snapshot blank' };
    return { problem: null, fact: `snapshot ${size.w}x${size.h} shows all ${inked.length}` };
  }

  // ---- the prompt box

  private async checkPrompt(results: CheckResult[]): Promise<void> {
    const { tab } = this;
    const problems: string[] = [];
    const before = await tab.call<PromptInfo | null>('promptInfo');
    if (before === null) {
      this.add(results, 'prompt-readable', 'FAIL', 'there is no prompt box');
      return;
    }
    // a box with words left in it by an earlier step is cleared first (and said so)
    if (before.value !== '') {
      await tab.tap(before.rect.x + before.rect.w / 2, before.rect.y + before.rect.h / 2);
      for (let i = 0; i < before.value.length + 2; i += 1) await tab.key('Backspace');
    }
    // computed: the colour the words are painted in against what is behind them, for the placeholder and for typed words
    if (before.typed.ratio < TEXT_CONTRAST) problems.push(`typed text ${before.typed.colour} on ${before.typed.bg} is ${fmt(before.typed.ratio)}:1 (needs ${TEXT_CONTRAST})`);
    if (before.placeholder.ratio < TEXT_CONTRAST) problems.push(`placeholder ${before.placeholder.colour} is ${fmt(before.placeholder.ratio)}:1 against the box (needs ${TEXT_CONTRAST})`);
    // rendered: really type, and read the pixels of the box
    const words = 'Hello there check';
    await tab.tap(before.rect.x + before.rect.w / 2, before.rect.y + before.rect.h / 2);
    await tab.type(words);
    const now = await tab.call<PromptInfo>('promptInfo');
    const region = { x: now.rect.x, y: now.rect.y, w: now.rect.w, h: now.rect.h };
    const picture = await tab.shot({ x: region.x, y: region.y, width: region.w, height: region.h });
    const [mark] = await tab.call<{ blank: boolean; ratio: number; outside?: boolean; fg?: string; bg?: string }[]>('analyse', picture, [{ x: 0, y: 0, w: region.w, h: region.h }], tab.dpr);
    const typedOk = now.value === words;
    if (!typedOk) problems.push(`typing "${words}" left "${now.value}" in the box`);
    let seen = 'rendered ' + (mark === undefined ? 'n/a' : mark.blank ? 'nothing visible' : `${fmt(mark.ratio)}:1`);
    if (mark === undefined || mark.blank) problems.push('typed words are invisible: nothing but the box colour is rendered where they are');
    else if (mark.ratio < PIXEL_CONTRAST) problems.push(`typed words render at ${fmt(mark.ratio)}:1 (${mark.fg} on ${mark.bg}, needs ${PIXEL_CONTRAST} as rendered)`);
    else seen += ` (${mark.fg} on ${mark.bg})`;
    for (let i = 0; i < words.length; i += 1) await tab.key('Backspace');
    const cleared = await tab.call<PromptInfo>('promptInfo');
    if (cleared.value !== '') problems.push(`the box could not be cleared again ("${cleared.value}")`);
    this.add(results, 'prompt-readable', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `typed ${fmt(before.typed.ratio)}:1, placeholder ${fmt(before.placeholder.ratio)}:1, ${seen}` : problems.join('; '));
  }

  // ---- the chrome

  private async checkChrome(picture: string, results: CheckResult[]): Promise<void> {
    const buttons = await this.tab.call<ButtonInfo[]>('chromeButtons');
    const marks = await this.tab.call<{ blank: boolean; ratio: number; outside?: boolean; fg?: string; bg?: string }[]>('analyse', picture, buttons.map((button) => button.rect), this.tab.dpr);
    const problems: string[] = [];
    let worst = Number.POSITIVE_INFINITY;
    let worstLabel = '';
    buttons.forEach((button, index) => {
      const need = button.iconOnly ? ICON_CONTRAST : TEXT_CONTRAST;
      const label = button.status ? 'status line' : `"${button.label.slice(0, 24)}"`;
      if (button.ratio < worst) {
        worst = button.ratio;
        worstLabel = label;
      }
      if (button.ratio < need) problems.push(`${label} ${button.colour} on ${button.bg} is ${fmt(button.ratio)}:1 (needs ${need})`);
      const mark = marks[index];
      if (mark !== undefined && !mark.outside && !button.iconOnly) {
        if (mark.blank) problems.push(`${label} renders no visible words`);
        else if (mark.ratio < PIXEL_CONTRAST) problems.push(`${label} renders at ${fmt(mark.ratio)}:1 (${mark.fg} on ${mark.bg})`);
      }
    });
    if (buttons.length === 0) problems.push('no chrome button is visible');
    this.add(results, 'chrome-readable', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `${buttons.length} buttons and labels, the faintest ${worstLabel} at ${fmt(worst)}:1` : problems.slice(0, 4).join('; ') + (problems.length > 4 ? ` and ${problems.length - 4} more` : ''));
  }

  // ---- overlap

  private checkOverlap(step: Step, answer: Answer, results: CheckResult[]): void {
    const problems: string[] = [];
    // words on stage: the painter's boxes for every line of words that is on, and the controls laid among them
    const words = answer.live.filter((element) => element.kind === 'text' && element.phase === 'on' && area(element.box) > 0 && element.opacity > 0.3);
    const pairs: string[] = [];
    for (let i = 0; i < words.length; i += 1) {
      for (let j = i + 1; j < words.length; j += 1) {
        const a = words[i] as LiveElement;
        const b = words[j] as LiveElement;
        const share = intersection(a.box, b.box) / Math.max(1, Math.min(area(a.box), area(b.box)));
        if (share > 0.2) pairs.push(`"${a.text.slice(0, 18)}" over "${b.text.slice(0, 18)}" (${Math.round(share * 100)}%)`);
      }
      for (const control of answer.controls) {
        const a = words[i] as LiveElement;
        const share = intersection(a.box, control.box) / Math.max(1, Math.min(area(a.box), area(control.box)));
        if (share > 0.2 && control.enabled) pairs.push(`"${a.text.slice(0, 18)}" over the ${control.control} "${control.label.slice(0, 18)}"`);
      }
    }
    // free words standing on a diagram (a caption laid over a flowchart's nodes); a chart's own labels are set on it on purpose
    const chartIds = new Set(answer.charts.map((chart) => chart.id));
    const diagrams = answer.live.filter((element) => element.kind === 'structure' && element.phase === 'on' && !chartIds.has(element.id) && area(element.box) > 0);
    const onDiagram: string[] = [];
    for (const text of words) {
      for (const diagram of diagrams) {
        const share = intersection(text.box, diagram.box) / Math.max(1, area(text.box));
        if (share > 0.25) onDiagram.push(`"${text.text.slice(0, 24)}" ${Math.round(share * 100)}% on ${diagram.id}`);
      }
    }
    if (onDiagram.length > 0) problems.push(`words standing on a diagram: ${onDiagram.slice(0, 3).join('; ')}`);
    if (pairs.length > 0) problems.push(`words on words on the stage: ${pairs.slice(0, 3).join('; ')}${pairs.length > 3 ? ` and ${pairs.length - 3} more` : ''}`);
    // the words of a mock-up as the kit drew them: one line of words must not stand on another, whoever owns them
    let screenWords = 0;
    for (const mock of answer.mockups) {
      screenWords += mock.words.length;
      const hit: string[] = [];
      for (let i = 0; i < mock.words.length; i += 1) {
        for (let j = i + 1; j < mock.words.length; j += 1) {
          const a = mock.words[i] as MockupView['words'][number];
          const b = mock.words[j] as MockupView['words'][number];
          if (a.owner === b.owner) continue;
          const share = intersection(a.box, b.box) / Math.max(1, Math.min(area(a.box), area(b.box)));
          if (share > 0.2) hit.push(`"${a.text.slice(0, 22)}" (${a.owner}) over "${b.text.slice(0, 22)}" (${b.owner}) ${Math.round(share * 100)}%`);
        }
      }
      if (hit.length > 0) problems.push(`in the mock-up ${mock.screen}: ${hit.slice(0, 3).join('; ')}${hit.length > 3 ? ` and ${hit.length - 3} more` : ''}`);
      const noted = mock.notes.filter((note) => ['overlap', 'lost-words', 'outside'].includes(note.kind));
      if (noted.length > 0) problems.push(`the kit's own lint on ${mock.screen}: ${noted.slice(0, 3).map((note) => `${note.kind} ${note.id}`).join(', ')}`);
    }
    // the painter's own verdict on how the answer landed
    if (answer.report !== null) {
      const collided = answer.report.sight.filter((item) => item.resting && item.notes.some((note) => ['collides', 'crossed'].includes(note)));
      if (collided.length > 0) problems.push(`the painter's sight says these run into words: ${collided.slice(0, 4).map((item) => `${item.id} (${item.notes.filter((note) => ['collides', 'crossed'].includes(note)).join('/')})`).join(', ')}`);
    }
    if (step.expects === 'screen' && !answer.hasHook) problems.push('this build has no mockups() hook on __stage, so the words of a mock-up cannot be judged');
    this.add(results, 'no-overlap', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `${words.length} lines of words on stage${screenWords > 0 ? `, ${screenWords} in mock-ups` : ''}, none on another` : problems.join('; '));
  }

  // ---- cut off

  private async checkCutOff(answer: Answer, results: CheckResult[]): Promise<void> {
    const problems: string[] = [];
    const { width, height } = answer.viewport;
    const slack = 2;
    const outside: string[] = [];
    for (const element of answer.live) {
      if (!['text', 'structure', 'control', 'node'].includes(element.kind) || element.phase === 'leaving' || element.phase === 'struck' || area(element.box) === 0) continue;
      const b = element.box;
      if (b.x < -slack || b.y < -slack || b.x + b.width > width + slack || b.y + b.height > height + slack) outside.push(`${element.id} (${element.kind}) ${boxText(b)}`);
    }
    if (outside.length > 0) problems.push(`outside the stage (${width}x${height}): ${outside.slice(0, 4).join(', ')}${outside.length > 4 ? ` and ${outside.length - 4} more` : ''}`);
    if (answer.report !== null) {
      const clipped = answer.report.sight.filter((item) => item.resting && ['text', 'control'].includes(item.kind) && (item.notes.includes('clipped') || item.notes.includes('off-canvas')));
      if (clipped.length > 0) problems.push(`the painter's sight says part of it fell outside the screen: ${clipped.slice(0, 4).map((item) => item.id).join(', ')}`);
    }
    const page = await this.tab.call<{ sw: number; sh: number; iw: number; ih: number; bw: number; bh: number }>('page');
    if (page.sw > page.iw + 1 || page.bw > page.iw + 1) problems.push(`the page scrolls sideways (${page.sw} wide in ${page.iw})`);
    if (page.sh > page.ih + 1 || page.bh > page.ih + 1) problems.push(`the page scrolls down (${page.sh} tall in ${page.ih})`);
    const buttons = await this.tab.call<ButtonInfo[]>('chromeButtons');
    const off = buttons.filter((button) => button.rect.x < -1 || button.rect.y < -1 || button.rect.x + button.rect.w > page.iw + 1 || button.rect.y + button.rect.h > page.ih + 1);
    if (off.length > 0) problems.push(`chrome partly off the screen: ${off.slice(0, 3).map((button) => `"${button.label.slice(0, 20)}"`).join(', ')}`);
    this.add(results, 'nothing-cut-off', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `${answer.live.length} elements inside ${width}x${height}, no scrolling` : problems.join('; '));
  }

  // ---- turn 5: work the mock-up like a person

  private async interact(results: CheckResult[]): Promise<{ readonly said: string; readonly rest: string }> {
    const { tab } = this;
    const answer = await tab.call<Answer>('answer');
    if (!answer.hasHook) {
      this.add(results, 'prompt-registers', 'SKIP', 'no typing into the prompt on this turn');
      this.add(results, 'interactions', 'FAIL', 'this build has no mockups() hook on __stage: the live parts of a mock-up cannot be found to touch');
      return { said: 'work the mock-up', rest: '' };
    }
    const mock = answer.mockups[0];
    this.add(results, 'prompt-registers', 'SKIP', 'no typing into the prompt on this turn');
    if (mock === undefined || mock.hits.length === 0) {
      this.add(results, 'interactions', 'FAIL', mock === undefined ? 'no mock-up is on the stage to work' : `the mock-up ${mock.screen} has no live parts: no field, toggle or button to touch`);
      return { said: 'work the mock-up', rest: '' };
    }
    const problems: string[] = [];
    const facts: string[] = [];
    const fields = mock.hits.filter((hit) => hit.action === 'field');
    const toggles = mock.hits.filter((hit) => hit.action === 'toggle');
    const presses = mock.hits.filter((hit) => hit.action === 'press');
    facts.push(`${fields.length} fields, ${toggles.length} toggles, ${presses.length} buttons, ${mock.hits.length - fields.length - toggles.length - presses.length} others`);
    const words = ['ada@example', 'hunter22'];
    const where = (hit: { readonly box: Box }): Box => hit.box;
    const regionOf = (box: Box): Box => ({ x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6 });
    const wordsNow = async (): Promise<readonly MockupView['words'][number][]> => (await tab.call<Answer>('answer')).mockups.flatMap((candidate) => candidate.words);

    // typing: tap the field, press keys; the field must show them
    for (const [index, field] of fields.slice(0, 2).entries()) {
      const typed = words[index] as string;
      const c = centre(where(field));
      await tab.tap(c.x, c.y);
      await sleep(250);
      const before = await tab.shot(regionOf(field.box));
      await tab.type(typed);
      await sleep(350);
      const after = await tab.shot(regionOf(field.box));
      // keys that find no field go where the keyboard is: the prompt box. Said, and cleared again.
      const box = await tab.call<PromptInfo>('promptInfo');
      const stray = box.value.includes(typed);
      if (stray) for (let i = 0; i < box.value.length; i += 1) await tab.key('Backspace');
      const showing = (await wordsNow()).some((word) => word.text.includes(typed));
      const share = await tab.call<number>('changed', before, after);
      if (showing) facts.push(`typed "${typed}" into ${field.id}: shows`);
      else if (share >= 0.015) facts.push(`typed "${typed}" into ${field.id}: the field's pixels changed (${(share * 100).toFixed(1)}%)`);
      else problems.push(`typing "${typed}" into ${field.id} (${field.part}) changed nothing: the words are not in the field and its pixels did not change${stray ? ' (the keys went into the prompt box instead)' : ''}`);
    }
    if (fields.length === 0) facts.push('no field to type into');

    // a toggle: a tap flips it
    const toggle = toggles[0];
    if (toggle !== undefined) {
      const before = await tab.shot(regionOf(toggle.box));
      const c = centre(where(toggle));
      await tab.tap(c.x, c.y);
      await sleep(400);
      const after = await tab.shot(regionOf(toggle.box));
      const share = await tab.call<number>('changed', before, after);
      if (share >= 0.03) facts.push(`toggle ${toggle.id} flipped (${(share * 100).toFixed(1)}% of its pixels)`);
      else problems.push(`tapping the toggle ${toggle.id} changed nothing (${(share * 100).toFixed(1)}% of its pixels)`);
    } else facts.push('no toggle in this mock-up');

    // the button: a button the brain is to hear (no `to=`, or `send`) must reach the server as an act, with the screen's values and never a password's own
    // words; a button that goes to a screen (`to=`) is the prototype's own step: it must bring that screen forward
    const buttons = presses.filter((hit) => /^button/.test(hit.part));
    const heard = buttons.find((hit) => hit.send === true);
    const goes = buttons.find((hit) => hit.send !== true && hit.to !== undefined);
    let rest = '';
    if (heard !== undefined) {
      const mark = tab.posted.length;
      const before = await tab.shot(regionOf(heard.box));
      const c = centre(where(heard));
      await tab.tap(c.x, c.y);
      let act: Posted | undefined;
      for (let waited = 0; waited < 6000 && act === undefined; waited += 200) {
        act = tab.posted.slice(mark).find((turn) => turn.kind === 'act');
        if (act === undefined) await sleep(200);
      }
      const after = await tab.shot(regionOf(heard.box));
      const share = await tab.call<number>('changed', before, after);
      if (act === undefined) problems.push(`pressing the button ${heard.id} ("${heard.part}") sent nothing to the server: no turn of kind act was posted in 6 s${share >= 0.03 ? ' (the button did change its look)' : ''}`);
      else {
        let said: { input?: { text?: string; screen?: string; values?: Record<string, unknown> } } = {};
        try {
          said = JSON.parse(act.body) as typeof said;
        } catch {
          problems.push('the act the button sent could not be read');
        }
        const values = said.input?.values ?? {};
        if (act.body.includes(words[1] as string)) problems.push(`the act carried the password's own words ("${words[1]}"): a password may only be said to be filled`);
        else if (fields.length >= 2 && !Object.values(values).includes('filled')) problems.push(`the act did not say the password is filled (values ${JSON.stringify(values).slice(0, 120)})`);
        else if (fields.length >= 1 && !JSON.stringify(values).includes(words[0] as string)) problems.push(`the act did not carry what was typed in the first field (values ${JSON.stringify(values).slice(0, 120)})`);
        else facts.push(`pressing ${heard.id} reached the server as an act ("${(act.text ?? '').slice(0, 30)}", screen ${said.input?.screen ?? '?'}, ${Object.keys(values).length} values, the password only as filled)`);
        rest = await this.rest(true);
      }
    } else if (goes !== undefined) {
      // nothing here is for the brain to hear: the prototype's own step must still take the finger somewhere
      const whole = { x: 0, y: 0, width: (await tab.call<Answer>('answer')).viewport.width, height: (await tab.call<Answer>('answer')).viewport.height };
      const before = await tab.shot(whole);
      const c = centre(where(goes));
      await tab.tap(c.x, c.y);
      await sleep(900);
      const after = await tab.shot(whole);
      const share = await tab.call<number>('changed', before, after);
      if (share >= 0.03) facts.push(`no button of this mock-up is for the brain (each goes to a screen); pressing ${goes.id} to ${goes.to} changed ${(share * 100).toFixed(0)}% of the stage`);
      else problems.push(`pressing ${goes.id} (to ${goes.to}) took the finger nowhere: ${(share * 100).toFixed(1)}% of the stage changed`);
    } else facts.push('no button in this mock-up');

    this.add(results, 'interactions', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? facts.join('; ') : `${problems.join('; ')} [${facts[0]}]`);
    return { said: 'work the mock-up', rest };
  }

  // ---- the contact sheet

  private async contactSheet(): Promise<string | null> {
    if (this.records.length === 0) return null;
    const { tab } = this;
    const cells: { readonly label: string; readonly verdict: string; readonly data: string }[] = [];
    for (const record of this.records) {
      const failed = record.results.filter((result) => result.verdict === 'FAIL').map((result) => result.check);
      const data = (await readFile(join(this.dir, record.picture))).toString('base64');
      cells.push({ label: `${record.step.n}. ${record.step.name}${record.said === '' ? '' : `: ${record.said}`}`, verdict: failed.length === 0 ? 'PASS' : `FAIL ${failed.join(', ')}`, data: `data:image/png;base64,${data}` });
    }
    // composed in a blank page of the same browser: a grid, each turn's picture at rest with its verdict under it
    const { targetId } = await tab.browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await tab.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const columns = this.screen.width < 600 ? 4 : 2;
    const cellWidth = this.screen.width < 600 ? 300 : 760;
    const script = `(async () => {
      const cells = ${JSON.stringify(cells)};
      const columns = ${columns}, cellWidth = ${cellWidth};
      const images = await Promise.all(cells.map((cell) => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = cell.data; })));
      const caption = 46, gap = 10;
      const heights = images.map((i) => (i ? Math.round(cellWidth * i.height / i.width) : 100));
      const rows = Math.ceil(cells.length / columns);
      const rowHeights = [];
      for (let r = 0; r < rows; r++) rowHeights.push(Math.max(...heights.slice(r * columns, r * columns + columns)) + caption + gap);
      const canvas = document.createElement('canvas');
      canvas.width = columns * (cellWidth + gap) + gap;
      canvas.height = rowHeights.reduce((a, b) => a + b, gap);
      const g = canvas.getContext('2d');
      g.fillStyle = '#222'; g.fillRect(0, 0, canvas.width, canvas.height);
      let y = gap;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
          const index = r * columns + c;
          if (index >= cells.length) break;
          const x = gap + c * (cellWidth + gap);
          const cell = cells[index], image = images[index];
          if (image) g.drawImage(image, x, y + caption, cellWidth, heights[index]);
          g.save();
          g.beginPath(); g.rect(x, y, cellWidth, caption); g.clip();
          g.fillStyle = cell.verdict === 'PASS' ? '#7fd88a' : '#ff8a80';
          g.font = 'bold 14px sans-serif';
          g.fillText(cell.label, x, y + 16);
          g.font = '12px sans-serif';
          g.fillText(cell.verdict, x, y + 34);
          g.restore();
        }
        y += rowHeights[r];
      }
      return canvas.toDataURL('image/png');
    })()`;
    const out = await tab.browser.send<{ result: { value?: string }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }, sessionId);
    await tab.browser.send('Target.closeTarget', { targetId }).catch(() => undefined);
    const url = out.result.value;
    if (url === undefined) return null;
    const path = join(this.dir, 'contact-sheet.png');
    await writeFile(path, Buffer.from(url.split(',')[1] ?? '', 'base64'));
    return path;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The report

function table(screen: string, records: readonly TurnRecord[]): string {
  const turns = records.map((record) => record.step.n);
  const widths = 7;
  const lines: string[] = [];
  lines.push(`${screen}`);
  lines.push(`${'check'.padEnd(20)}${turns.map((n) => `turn ${n}`.padEnd(widths + 1)).join('')}`);
  for (const check of CHECKS) {
    const cells = records.map((record) => record.results.find((result) => result.check === check)?.verdict ?? '-');
    if (cells.every((cell) => cell === '-' || cell === 'SKIP')) continue;
    lines.push(`${check.padEnd(20)}${cells.map((cell) => cell.padEnd(widths + 1)).join('')}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const health = await fetch(`${options.url}/api/health`).then((response) => response.ok, () => false);
  if (!health) usage(`nothing answers at ${options.url}/api/health: start the candidate build (on a spare port, with its own DATA_DIR) and pass --url`);
  await mkdir(options.out, { recursive: true });
  process.stdout.write(`smoke: ${options.url}, screens ${options.screens.map((screen) => screen.name).join(', ')}, pictures in ${options.out}\n`);
  const runs = options.parallel
    ? await Promise.all(options.screens.map((screen) => Conversation.run(options, screen).then((run) => ({ screen, run }))))
    : await (async () => {
        const done: { screen: Options['screens'][number]; run: Awaited<ReturnType<typeof Conversation.run>> }[] = [];
        for (const screen of options.screens) done.push({ screen, run: await Conversation.run(options, screen) });
        return done;
      })();
  let failures = 0;
  const summary: unknown[] = [];
  for (const { screen, run } of runs) {
    process.stdout.write(`\n${table(screen.name, run.records)}\n`);
    for (const record of run.records) {
      for (const result of record.results) {
        if (result.verdict === 'FAIL') {
          failures += 1;
          process.stdout.write(`  FAIL turn ${record.step.n} ${result.check}: ${result.detail}\n`);
        }
      }
    }
    process.stdout.write(`  ${screen.name}: ${run.seconds.toFixed(0)} s, contact sheet ${run.sheet ?? 'none'}\n`);
    summary.push({ screen: screen.name, seconds: run.seconds, sheet: run.sheet, turns: run.records.map((record) => ({ turn: record.step.n, said: record.said, picture: record.picture, seconds: record.seconds, results: record.results })) });
  }
  await writeFile(join(options.out, 'smoke.json'), JSON.stringify({ url: options.url, at: new Date().toISOString(), failures, screens: summary }, null, 2));
  process.stdout.write(`\n${failures === 0 ? 'PASS: the build may go live.' : `FAIL: ${failures} check${failures === 1 ? '' : 's'} failed. The build must not go live.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`smoke: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});
