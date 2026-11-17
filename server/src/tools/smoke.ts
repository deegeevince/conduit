// pnpm smoke: the deploy gate. A candidate build is driven through ONE scripted conversation in a real headless Chrome, the way a person
// does it (real key events into the real prompt box, real pointer or touch events on the page), and judged AT REST after every turn.
//
//   pnpm smoke [--url http://127.0.0.1:<port>] [--screens 1920x825,390x844] [--out <dir>] [--turns 1,2,3,4,5,6,7]
//              [--timeout <seconds a turn may take>] [--parallel] [--demo] [--quiet] [--chat | --no-chat]
//
// A second pass drives the frozen chat shell at /chat, only when asked (`--chat` runs only it, `--with-chat` adds it after the conversation; `--no-chat` is the default and kept for old scripts):
// send a prompt; the reply arrives; the trace under it opens; the canvas opens and the answer is ON IT (the same on-stage, no-overlap and nothing-cut-off checks, scoped to the
// canvas's stage); and the composer is reachable with the canvas open (the pill is on screen, nothing covers it, a real tap and real keys put words in it).
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
//   composer           (turn 1) the bar is ONE line (a pill: [+] the field, the mic, Send), centred at a max width on a desk, with no status row at rest;
//                      the [+] menu opens with a real tap, lists photo / Draw / Save / Transcript / model / Copy answer / About, Draw and the Transcript and
//                      Save's list work from it, Escape closes it and puts the focus back on [+], Shift+Enter makes a line and the field grows and shrinks
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
import { Cdp, CHROME_CANDIDATES, chromeFlags, sleep, stop, waitFor } from './explore-browser';
import { claimPort, portCount, releasePort } from './check-ports';

// ---------------------------------------------------------------------------------------------------------------------------------
// What is asked

export type Verdict = 'PASS' | 'FAIL' | 'SKIP';
export interface CheckResult {
  readonly turn: number;
  readonly check: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

export interface Step {
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

const CHECKS = ['prompt-registers', 'rest', 'composer', 'answer-on-stage', 'prompt-readable', 'chrome-readable', 'no-overlap', 'nothing-cut-off', 'no-console-errors', 'no-failed-requests', 'interactions'] as const;

const TEXT_CONTRAST = 4.5;
const ICON_CONTRAST = 3;
/** pixels carry anti-aliasing: thin type never reaches its full colour, so the rendered measure is held to a little less than the computed one */
const PIXEL_CONTRAST = 3;
/** how long the stage must stand unchanged, with nothing in flight, to be at rest */
const STABLE_MS = 2200;
/** how long one DevTools call may take before the gate calls the browser stuck and says where (a screenshot of a big page is seconds, never a minute) */
const CDP_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// Arguments

export interface Options {
  readonly url: string;
  readonly screens: readonly { readonly name: string; readonly width: number; readonly height: number }[];
  readonly out: string;
  readonly turns: ReadonlySet<number>;
  readonly timeoutMs: number;
  readonly parallel: boolean;
  readonly demo: boolean;
  readonly quiet: boolean;
  /** SA2. Dev flags added to the page's address (`holdDraft=9000`, `engine=stale`); the page honours them only on this machine */
  readonly page: string;
  /** SA2. One prompt in place of the scripted conversation */
  readonly say: string | null;
  /** `only`: the /chat pass alone; `with`: after the conversation; `off` */
  readonly chat: 'only' | 'with' | 'off';
}

function usage(message: string): never {
  process.stderr.write(`smoke: ${message}\nusage: pnpm smoke [--url http://127.0.0.1:<port>] [--screens 1920x825,390x844] [--out <dir>] [--turns 1,2,3,4,5,6,7] [--timeout <seconds>] [--parallel] [--demo] [--quiet] [--page <query>] [--say <prompt>] [--chat | --no-chat]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) usage(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (['parallel', 'demo', 'quiet', 'chat', 'no-chat', 'with-chat'].includes(name)) flags.set(name, 'true');
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
    page: flags.get('page') ?? '',
    say: flags.get('say') ?? null,
    // /chat is frozen (the product is the main view at /), so its pass runs only when asked: `--chat` runs only it, `--with-chat` adds it
    chat: flags.has('chat') ? 'only' : flags.has('with-chat') ? 'with' : 'off',
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The page's half: small, pure measuring functions the gate hands to the page once. They read what the page really is: computed styles,
// the painter's own hook (`window.__stage`) and the pixels of a screenshot. Written as text so that no compiler helper is in it.

export const PAGE_LIB = String.raw`(() => {
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
    const base = { live, charts: s.charts().map((c) => ({ id: c.id, kind: c.kind, waiting: c.waiting, points: c.points, box: c.box })), controls: s.controls().map((c) => ({ id: c.id, control: c.control, label: c.label, enabled: c.enabled, box: c.box })), script: s.script(), viewport: s.state().viewport, page: s.state().page ? { width: s.state().page.width, height: s.state().page.height } : null, hasHook: typeof s.mockups === 'function', squeeze: s.state().squeeze || null, mockups: typeof s.mockups === 'function' ? s.mockups() : [], leaders: typeof s.leaders === 'function' ? s.leaders() : null };
    if (!last) return Object.assign({ report: null }, base);
    const r = last.report;
    return Object.assign({
      report: {
        turn: r.turn, outcome: r.outcome,
        shown: r.shown.map((x) => ({ id: x.id, kind: x.kind, text: String(x.text).slice(0, 60), struck: x.struck, partial: x.partial, part: !!x.part })),
        sight: r.sight.items.map((i) => ({ id: i.id, kind: i.kind, resting: i.resting, notes: i.notes, box: i.box })),
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
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, hidden: !visible(el) }; };
  const composerInfo = () => {
    const box = (sel) => rect(sel);
    const top = document.querySelector('.prompt__top');
    const active = document.activeElement;
    return {
      bar: box('.bar'), composer: box('.composer'), plus: box('.composer__plus'), input: box('.prompt__input'), mic: box('.prompt__voice'), send: box('.prompt__button'),
      topShown: !!top && !top.hidden && getComputedStyle(top).display !== 'none', status: (document.querySelector('.prompt__status') || {}).textContent || '',
      menuOpen: !!document.querySelector('.composer__menu') && !document.querySelector('.composer__menu').hidden,
      items: [...document.querySelectorAll('.composer__view:not([hidden]) .composer__item')].filter((el) => !el.hidden).map((el) => ({ id: el.dataset.item, label: (el.querySelector('.composer__label') || {}).textContent, checked: el.getAttribute('aria-checked') })),
      view: ((document.querySelector('.composer__view:not([hidden])') || {}).dataset || {}).view || null,
      focus: active ? (active.className || active.tagName).toString().slice(0, 60) : null,
      inkOpen: !!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden,
      transcriptOpen: !!document.querySelector('.transcript__panel') && !document.querySelector('.transcript__panel').hidden,
      value: (document.querySelector('.prompt__input') || {}).value, iw: window.innerWidth,
    };
  };
  const page = () => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: window.innerWidth, ih: window.innerHeight, bw: document.body.scrollWidth, bh: document.body.scrollHeight });
  window.__smoke = { rect, composerInfo, probe, promptInfo, chromeButtons, answer, analyse, inkIn, changed, page };
})();`;

// ---------------------------------------------------------------------------------------------------------------------------------
// The browser

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Logged {
  readonly at: number;
  readonly text: string;
}

export interface Posted {
  readonly at: number;
  readonly url: string;
  readonly kind: string | null;
  readonly text: string | null;
  /** what was posted, as sent */
  readonly body: string;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The browsers the tabs live in
//
// A few headless Chromes, each with its own debugging port (from CHECK_PORTS when set), share the tabs: every Tab is a page in a browser context of its own (its own
// storage and session), in a window of its own and brought to the front, with background throttling off, so one tab's clock is not slowed by the others. A browser
// starts with its first tab and stops with its last.

interface Host {
  readonly port: number;
  readonly child: ChildProcess;
  readonly profile: string;
  readonly browser: Cdp;
  tabs: number;
}

const hosts: Host[] = [];
let hostQueue: Promise<unknown> = Promise.resolve();

/** how many browsers share the tabs: four, fewer when CHECK_PORTS leaves room for fewer after the servers' ports */
function hostLimit(): number {
  const ports = portCount();
  return ports === null ? 4 : Math.max(1, Math.min(4, ports - 4));
}

async function startHost(): Promise<Host> {
  const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
  const profile = await mkdtemp(join(tmpdir(), 'conduit-smoke-'));
  // a debugging port from CHECK_PORTS when it is set (0, Chrome's own, when not)
  const port = await claimPort('a Chrome', true);
  const child = spawnTracked(
    chrome,
    [...chromeFlags(), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
    undefined,
    { quiet: true },
  );
  try {
    const endpoint = await waitFor('Chrome', 20_000, async () => {
      // a Chrome given its debugging port writes no DevToolsActivePort file: it is asked for its address
      if (port !== 0) return ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? null;
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const [chosen, path] = text.split('\n');
      return chosen !== undefined && path !== undefined ? `ws://127.0.0.1:${chosen}${path}` : null;
    });
    return { port, child, profile, browser: await Cdp.open(endpoint), tabs: 0 };
  } catch (error) {
    await stop(child);
    releasePort(port);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** a browser for one more tab: a new one while there are fewer than the limit, then the least busy */
function acquireHost(): Promise<Host> {
  const next = hostQueue.then(async () => {
    const least = hosts.reduce<Host | null>((best, host) => (best === null || host.tabs < best.tabs ? host : best), null);
    let host: Host;
    if (least !== null && (hosts.length >= hostLimit() || least.tabs === 0)) host = least;
    else {
      host = await startHost();
      hosts.push(host);
    }
    host.tabs += 1;
    return host;
  });
  hostQueue = next.catch(() => undefined);
  return next;
}

async function releaseHost(host: Host): Promise<void> {
  host.tabs -= 1;
  if (host.tabs > 0 || !hosts.includes(host)) return;
  hosts.splice(hosts.indexOf(host), 1);
  host.browser.close();
  await stop(host.child);
  releasePort(host.port);
  await rm(host.profile, { recursive: true, force: true }).catch(() => undefined);
}

/** One page of a headless Chrome, driven over the DevTools protocol, and everything it reported: console errors, failed requests, requests in flight, turns POSTed. */
export class Tab {
  readonly consoleErrors: Logged[] = [];
  readonly failedRequests: Logged[] = [];
  readonly posted: Posted[] = [];
  /** the pictures of the resting stage the page has sent the server, by turn: what the brain is shown next turn */
  readonly snapshots = new Map<string, string>();
  private readonly flying = new Map<string, string>();
  private consumed = { consoleErrors: 0, failedRequests: 0 };
  /** the address of every script the page has parsed, by id: to say where the page's JavaScript was when the browser stopped answering */
  private readonly scripts = new Map<string, string>();
  private onPaused: ((frames: string) => void) | null = null;

  private constructor(
    readonly browser: Cdp,
    readonly session: string,
    private readonly dispose: () => Promise<void>,
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
        case 'Debugger.scriptParsed':
          this.scripts.set(String(p['scriptId']), String(p['url'] ?? '').replace(/^https?:\/\/[^/]+/, '') || `(script ${String(p['scriptId'])})`);
          break;
        case 'Debugger.paused': {
          const frames = (p['callFrames'] as { functionName: string; location: { scriptId: string; lineNumber: number; columnNumber: number } }[]).slice(0, 10);
          this.onPaused?.(frames.map((frame) => `${frame.functionName === '' ? '(anonymous)' : frame.functionName} ${this.scripts.get(frame.location.scriptId) ?? '?'}:${frame.location.lineNumber + 1}:${frame.location.columnNumber + 1}`).join(' < '));
          break;
        }
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

  /** the page has a touch screen (a phone's size, or asked for): `tap` then uses a finger */
  touch = false;
  /** the page is `?lens=1`: a point of the page is brought into view before it is tapped (`reach`) */
  lens = false;

  /** a point of the stage's page as the screen has it now, client pixels: the lens is moved to it first when it is out of view. With no lens the point is where it is. */
  async reach(x: number, y: number): Promise<{ x: number; y: number }> {
    if (!this.lens) return { x, y };
    const at = await this.eval<{ x: number; y: number } | null>(`window.__stage.reach(${x}, ${y})`);
    return at ?? { x, y };
  }

  static async open(width: number, height: number, emulate: { readonly dpr?: number; readonly touch?: boolean } = {}): Promise<Tab> {
    const host = await acquireHost();
    let context: string | null = null;
    let targetId: string | null = null;
    const dispose = async (): Promise<void> => {
      if (targetId !== null) await host.browser.send('Target.closeTarget', { targetId }).catch(() => undefined);
      if (context !== null) await host.browser.send('Target.disposeBrowserContext', { browserContextId: context }).catch(() => undefined);
      await releaseHost(host);
    };
    try {
      // a context of its own: the page's storage and session are this tab's alone, whatever else the browser holds
      context = (await host.browser.send<{ browserContextId: string }>('Target.createBrowserContext', {})).browserContextId;
      targetId = (await host.browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', width, height, newWindow: true, background: false, browserContextId: context })).targetId;
      const { sessionId } = await host.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const mobile = width < 600;
      const dpr = emulate.dpr ?? (mobile ? 2 : 1);
      const tab = new Tab(host.browser, sessionId, dispose, width, height, mobile, dpr);
      tab.touch = mobile || emulate.touch === true;
      for (const domain of ['Page', 'Runtime', 'Network', 'Log', 'Debugger']) await tab.send(`${domain}.enable`);
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
      if (mobile || emulate.touch === true) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: emulate.touch === true ? 5 : 1 });
      await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_LIB });
      await tab.send('Page.bringToFront').catch(() => undefined);
      return tab;
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  /**
   * A DevTools call that cannot hang the gate. Chrome answers every call unless the page's own thread is stuck (a loop in the page's code) or its
   * compositor is: then a call is never answered, and a gate that waits for it waits for ever, in silence. After `CDP_TIMEOUT_MS` the gate says
   * which call, and where the page's JavaScript is (the debugger is asked to pause it and read the stack).
   */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, limitMs = CDP_TIMEOUT_MS): Promise<T> {
    const call = this.browser.send<T>(method, params, this.session);
    call.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<'stalled'>((resolve) => {
      timer = setTimeout(() => resolve('stalled'), limitMs);
    });
    try {
      const done = await Promise.race([call, limit]);
      if (done !== 'stalled') return done;
    } finally {
      clearTimeout(timer);
    }
    throw new Error(`the browser did not answer ${method} in ${Math.round(limitMs / 1000)} s: ${await this.whereStuck()}`);
  }

  /** where the page's JavaScript is right now: the top of its stack, or the plain fact that it is not running any */
  private async whereStuck(): Promise<string> {
    const stack = new Promise<string>((resolve) => {
      this.onPaused = resolve;
    });
    this.browser.send('Debugger.pause', {}, this.session).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const none = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('the page is running no JavaScript (the renderer or the compositor is stuck, not the page code)'), 4000);
    });
    const found = await Promise.race([stack, none]);
    clearTimeout(timer);
    this.onPaused = null;
    this.browser.send('Debugger.resume', {}, this.session).catch(() => undefined);
    return found.startsWith('the page is') ? found : `the page's JavaScript was inside: ${found}`;
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
  async tap(pageX: number, pageY: number): Promise<void> {
    const { x, y } = await this.reach(pageX, pageY);
    if (this.touch) {
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

  /** a press at `from`, a drag to `to` and a release, with a mouse, or a finger on a phone: the page gets real pointer events, as a person's hand makes them (a slider's knob follows it) */
  async drag(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }, steps = 12): Promise<void> {
    const start = await this.reach(from.x, from.y);
    const end = await this.reach(to.x, to.y);
    const along = (i: number): { x: number; y: number } => ({ x: start.x + ((end.x - start.x) * i) / steps, y: start.y + ((end.y - start.y) * i) / steps });
    if (this.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
      await sleep(40);
      for (let i = 1; i <= steps; i += 1) {
        await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...along(i), id: 1 }] });
        await sleep(16);
      }
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start, pointerType: 'mouse' });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      await sleep(40);
      for (let i = 1; i <= steps; i += 1) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...along(i), button: 'left', buttons: 1, pointerType: 'mouse' });
        await sleep(16);
      }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    }
    await sleep(120);
  }

  async key(key: 'Enter' | 'Backspace' | 'Tab' | 'Escape', modifiers = 0): Promise<void> {
    const code = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27 }[key];
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  }

  async type(text: string): Promise<void> {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    await sleep(60);
  }

  async close(): Promise<void> {
    await this.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the page tells

export interface Probe {
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

export interface PromptInfo {
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

export interface LiveElement {
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

export interface Answer {
  readonly report: {
    readonly turn: string;
    readonly outcome: string;
    readonly shown: readonly { readonly id: string; readonly kind: string; readonly text: string; readonly struck: boolean; readonly partial: boolean; readonly part: boolean }[];
    readonly sight: readonly { readonly id: string; readonly kind: string; readonly resting: boolean; readonly notes: readonly string[]; readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } }[];
    readonly stage: readonly { readonly id: string; readonly kind: string; readonly struck: boolean; readonly parent: string | null; readonly structure: string | null; readonly rows: number }[];
  } | null;
  readonly live: readonly LiveElement[];
  readonly charts: readonly { readonly id: string; readonly kind: string; readonly waiting: boolean; readonly points: number; readonly box: Box }[];
  readonly controls: readonly { readonly id: string; readonly control: string; readonly label: string; readonly enabled: boolean; readonly box: Box }[];
  readonly script: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /** PLAN-canvas step 2: the page the scene is laid out on when it has grown past the screen (host CSS pixels); null otherwise */
  readonly page: { readonly width: number; readonly height: number } | null;
  readonly hasHook: boolean;
  /** what the scene on stage gave up to fit the screen (PLAN-canvas step 0); null on a build that does not say */
  readonly squeeze: { readonly squeezed: boolean; readonly kinds: readonly string[]; readonly facts: readonly { readonly kind: string; readonly key: string | null; readonly why: string }[] } | null;
  readonly mockups: readonly MockupView[];
  /** the leader lines of the callouts (null on a build whose hook does not say) */
  readonly leaders: readonly { readonly label: string; readonly part: string; readonly end: { readonly x: number; readonly y: number }; readonly distance: number; readonly nearer: { readonly id: string; readonly distance: number } | null }[] | null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One conversation on one screen

export interface TurnRecord {
  readonly step: Step;
  readonly said: string;
  readonly picture: string;
  readonly seconds: number;
  readonly results: CheckResult[];
}

/** what a scene squeezed, in a line: `none`, or each kind with how many things it touched */
export function squeezeText(squeeze: Answer['squeeze']): string {
  if (squeeze === null) return 'this build does not report it';
  if (!squeeze.squeezed) return 'none';
  return squeeze.kinds.map((kind) => `${kind} x${squeeze.facts.filter((fact) => fact.kind === kind).length}`).join(', ');
}

export const fmt = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
const round = (n: number): number => Math.round(n);
const intersection = (a: Box, b: Box): number => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const area = (a: Box): number => Math.max(0, a.width) * Math.max(0, a.height);
const boxText = (b: Box): string => `${round(b.width)}x${round(b.height)} at ${round(b.x)},${round(b.y)}`;
const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

export class Conversation {
  readonly records: TurnRecord[] = [];
  seenReports = new Set<string>();
  private lastSig = '';
  private stableSince = 0;
  current = 0;
  /** what the gate is doing now, for the line it prints when one step takes long (so a stall is never silent) */
  private phase = 'starting';
  private phaseSince = Date.now();
  note: (text: string) => void;

  constructor(
    readonly tab: Tab,
    readonly options: Options,
    readonly screen: Options['screens'][number],
    readonly dir: string,
  ) {
    this.note = (text) => {
      if (!options.quiet) process.stdout.write(`[${screen.name}] ${text}\n`);
    };
  }

  at(phase: string): void {
    this.phase = phase;
    this.phaseSince = Date.now();
  }

  static async run(options: Options, screen: Options['screens'][number]): Promise<{ readonly records: readonly TurnRecord[]; readonly seconds: number; readonly sheet: string | null; readonly dir: string; readonly aborted: string | null }> {
    const dir = join(options.out, screen.name);
    await mkdir(dir, { recursive: true });
    const started = Date.now();
    const tab = await Tab.open(screen.width, screen.height);
    try {
      const talk = new Conversation(tab, options, screen, dir);
      // one line when a step takes long, so that a stall is never silent: which turn, which step, how long
      const beat = setInterval(() => {
        const idle = Math.round((Date.now() - talk.phaseSince) / 1000);
        if (idle >= 45) process.stdout.write(`[${screen.name}] still in turn ${talk.current}: ${talk.phase} (${idle} s)\n`);
      }, 15_000);
      let aborted: string | null = null;
      try {
        await talk.start();
        const steps: readonly Step[] = options.say === null ? STEPS : [{ n: 1, say: options.say, name: 'custom', expects: 'any' }];
        for (const step of steps) {
          if (!options.turns.has(step.n)) continue;
          await talk.turn(step);
        }
      } catch (error) {
        // a stuck browser ends this screen's run, with what was judged so far and the reason, not the whole gate with a stack trace
        aborted = `turn ${talk.current}, ${talk.phase}: ${error instanceof Error ? error.message : String(error)}`;
        process.stdout.write(`[${screen.name}] ABORTED in ${aborted}\n`);
      } finally {
        clearInterval(beat);
      }
      const sheet = await talk.contactSheet().catch(() => null);
      return { records: talk.records, seconds: (Date.now() - started) / 1000, sheet, dir, aborted };
    } finally {
      await tab.close();
    }
  }

  add(results: CheckResult[], check: string, verdict: Verdict, detail: string): void {
    results.push({ turn: this.current, check, verdict, detail });
  }

  async start(): Promise<void> {
    const { tab } = this;
    tab.lens = /(^|&)lens=1(&|$)/.test(this.options.page);
    await tab.send('Page.navigate', { url: `${this.options.url}/${this.options.demo ? '' : '?demo=none'}${this.options.page === '' ? '' : `${this.options.demo ? '?' : '&'}${this.options.page}`}` });
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
  async rest(expectReport: boolean | null, requireNewReport = true, limitMs: number = this.options.timeoutMs): Promise<string> {
    const { tab } = this;
    const deadline = Date.now() + limitMs;
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
        return `no rest within ${Math.round(limitMs / 1000)} s (status "${probe.status}", clock ${probe.clock}, turn ${probe.turn ?? 'none'}, new report ${fresh.length > 0 ? 'yes' : 'no'}, ${tab.pending()} requests in flight${tab.pending() > 0 ? ` (${tab.pendingUrls().join(', ')})` : ''}, ${probe.moving ? 'elements still moving' : 'stage still'})`;
      }
    }
  }

  /** a real person's way of speaking: a click in the box, keys, Enter. Returns what went wrong, if anything. */
  async say(text: string, results: CheckResult[]): Promise<boolean> {
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
    this.at('asking');
    if (step.say !== null) {
      this.note(`turn ${step.n}: ${step.say}`);
      sent = await this.say(step.say, results);
      this.at('waiting for the page to rest');
      restNote = sent ? await this.rest(true) : 'the turn never started';
    } else {
      this.note(`turn ${step.n}: work the mock-up`);
      this.at('working the mock-up');
      const out = await this.interact(results);
      said = out.said;
      restNote = out.rest;
    }
    this.add(results, 'rest', restNote === '' ? 'PASS' : 'FAIL', restNote === '' ? `at rest ${((Date.now() - began) / 1000).toFixed(0)} s after asking` : restNote);

    // everything below judges the page AT REST
    this.at('taking the picture');
    const picture = await tab.shot();
    const file = `t${step.n}-${step.name}.png`;
    await writeFile(join(this.dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
    const answer = await tab.call<Answer>('answer');
    await writeFile(join(this.dir, file.replace(/\.png$/, '.answer.json')), JSON.stringify({ look: (await tab.call<Probe>('probe')).look, ...answer }, null, 1));
    this.at('checking the answer');
    await this.checkAnswer(step, answer, picture, results);
    this.at('checking the prompt box');
    await this.checkPrompt(results);
    this.at('checking the chrome');
    await this.checkChrome(picture, results);
    this.checkOverlap(step, answer, results);
    this.at('checking nothing is cut off');
    await this.checkCutOff(answer, results);
    // Information, never a verdict: what the layout gave up to fit this screen (PLAN-canvas step 0)
    this.add(results, 'squeeze', 'PASS', squeezeText(answer.squeeze));
    if (answer.squeeze?.squeezed === true) this.note(`  squeezed (information only): ${squeezeText(answer.squeeze)}`);
    if (step.n === 1) {
      this.at('working the composer');
      await this.checkComposer(results);
    }
    const logged = tab.drain();
    this.add(results, 'no-console-errors', logged.consoleErrors.length === 0 ? 'PASS' : 'FAIL', logged.consoleErrors.length === 0 ? 'nothing logged as an error' : `${logged.consoleErrors.length}: ${[...new Set(logged.consoleErrors.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
    this.add(results, 'no-failed-requests', logged.failedRequests.length === 0 ? 'PASS' : 'FAIL', logged.failedRequests.length === 0 ? 'every request answered' : `${logged.failedRequests.length}: ${[...new Set(logged.failedRequests.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
    this.records.push({ step, said, picture: file, seconds: (Date.now() - began) / 1000, results });
    for (const result of results) if (result.verdict === 'FAIL') this.note(`  FAIL ${result.check}: ${result.detail.slice(0, 200)}`);
  }

  // ---- answer on stage

  async checkAnswer(step: Step, answer: Answer, picture: string, results: CheckResult[]): Promise<void> {
    const problems: string[] = [];
    const facts: string[] = [];
    const report = answer.report;
    // a page that has grown past the screen is judged whole; the screenshot shows only the part of it the lens shows
    const view = answer.page === null ? answer.viewport : { width: answer.page.width, height: answer.page.height };
    const lens = answer.page === null ? null : (await this.tab.eval<{ view: { x: number; y: number; scale: number; width: number; height: number } | null } | null>('window.__stage.lens()'))?.view ?? { x: 0, y: 0, scale: 1, width: answer.viewport.width, height: answer.viewport.height };
    const shot = (box: Box): Box => (lens === null ? box : { x: (box.x - lens.x) * lens.scale, y: (box.y - lens.y) * lens.scale, width: box.width * lens.scale, height: box.height * lens.scale });
    const inFirstView = (box: Box): boolean => lens === null || intersection(shot(box), { x: 0, y: 0, width: lens.width, height: lens.height }) >= 0.9 * area(shot(box));
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
        if (['text', 'structure', 'picture', 'sprite'].includes(here.kind) && area(here.box) > 400 && inFirstView(here.box)) inked.push(here);
      }
      if (missing.length > 0) problems.push(`in the report's resting stage but not on screen at rest: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`);
      if (offscreen.length > 0) problems.push(`outside the screen: ${offscreen.slice(0, 3).join(', ')}`);
      // and it must really be drawn there: pixels, not the painter's say-so
      if (inked.length > 0) {
        const marks = await this.tab.call<{ px: number; share: number }[]>('inkIn', picture, inked.map((element) => ({ x: shot(element.box).x, y: shot(element.box).y, w: shot(element.box).width, h: shot(element.box).height })), this.tab.dpr);
        // a share of its box (a box with a speck in it is not drawn), as check.ts holds every scene to
        const blank = inked.filter((element, index) => (marks[index]?.share ?? 0) < (element.kind === 'text' ? 0.004 : 0.02) && (element.kind === 'text' || (marks[index]?.px ?? 0) < 400 * this.tab.dpr * this.tab.dpr));
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

  async checkPrompt(results: CheckResult[]): Promise<void> {
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

  async checkChrome(picture: string, results: CheckResult[]): Promise<void> {
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

  // ---- the composer

  /** the bar as the owner asked for it (a ChatGPT-like single line), worked with real taps and real keys */
  private async checkComposer(results: CheckResult[]): Promise<void> {
    const { tab } = this;
    interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly hidden: boolean }
    interface Info {
      readonly bar: Rect | null; readonly composer: Rect | null; readonly plus: Rect | null; readonly input: Rect | null; readonly mic: Rect | null; readonly send: Rect | null;
      readonly topShown: boolean; readonly status: string; readonly menuOpen: boolean; readonly items: readonly { readonly id: string; readonly label: string; readonly checked: string | null }[];
      readonly view: string | null; readonly focus: string | null; readonly inkOpen: boolean; readonly transcriptOpen: boolean; readonly value: string; readonly iw: number;
    }
    const problems: string[] = [];
    const facts: string[] = [];
    const info = (): Promise<Info> => tab.call<Info>('composerInfo');
    const tapOn = async (selector: string): Promise<boolean> => {
      const r = await tab.call<Rect | null>('rect', selector);
      if (r === null || r.hidden) return false;
      await tab.tap(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(250);
      return true;
    };
    const wanted = ['photo', 'draw', 'save', 'transcript', 'brain', 'copy-answer', 'about'];

    // 1. one line at rest, centred and no wider than a pill on a desk, no status row
    const at = await info();
    if (at.bar === null || at.composer === null || at.plus === null || at.input === null || at.send === null) {
      this.add(results, 'composer', 'FAIL', `a part of the bar is missing: ${['bar', 'composer', 'plus', 'input', 'send'].filter((key) => (at as unknown as Record<string, unknown>)[key] === null).join(', ')}`);
      return;
    }
    const middle = (r: Rect): number => r.y + r.h / 2;
    const parts = [at.plus, at.input, at.send, ...(at.mic === null || at.mic.hidden ? [] : [at.mic])];
    if (at.bar.h > 80) problems.push(`the bar is ${round(at.bar.h)} px tall at rest (one line is at most 80)`);
    if (parts.some((part) => Math.abs(middle(part) - middle(at.input as Rect)) > 6)) problems.push('the [+], the field, the mic and Send are not on one line');
    if (at.topShown) problems.push(`a status row is showing at rest ("${at.status}")`);
    if (this.screen.width >= 720) {
      if (at.composer.w > 800) problems.push(`the pill is ${round(at.composer.w)} px wide on a desk (it is to sit centred at a max width)`);
      if (Math.abs(at.composer.x + at.composer.w / 2 - at.iw / 2) > 2) problems.push('the pill is not centred');
    } else if (at.composer.x < 0 || at.composer.x + at.composer.w > at.iw || at.composer.w < at.iw - 40) problems.push(`the pill is ${round(at.composer.w)} px in a ${at.iw} px screen`);
    facts.push(`bar ${round(at.bar.h)} px, pill ${round(at.composer.w)} px`);

    // 2. the keyboard: Tab reaches [+] (it is the first stop of the bar), and Shift+Enter makes a new line while Enter would send
    const field = at.input;
    await tab.eval(`document.querySelector('.prompt__input').focus()`);
    await tab.key('Tab', 8);
    await sleep(80);
    if (!(await info()).focus?.includes('composer__plus')) problems.push('Shift+Tab from the field does not land on [+]');
    await tab.eval(`document.querySelector('.prompt__input').focus()`);
    const mark = tab.posted.length;
    await tab.type('first');
    await tab.key('Enter', 8);
    await tab.type('second');
    const multi = await tab.call<PromptInfo>('promptInfo');
    if (multi.value !== 'first\nsecond') problems.push(`Shift+Enter did not make a new line (the field holds ${JSON.stringify(multi.value)})`);
    if (multi.rect.h <= field.h + 8) problems.push(`the field did not grow for a second line (${round(field.h)} -> ${round(multi.rect.h)} px)`);
    if (tab.posted.length !== mark) problems.push('Shift+Enter sent a turn');
    for (let i = 0; i < 'first\nsecond'.length; i += 1) await tab.key('Backspace');
    await sleep(100);
    const back = await tab.call<PromptInfo>('promptInfo');
    if (back.rect.h > field.h + 2) problems.push(`the field did not shrink back to one line (${round(back.rect.h)} px)`);
    else facts.push('Shift+Enter grows the field, and it rests at one line again');

    // 3. the [+] menu, by real taps
    if (!(await tapOn('.composer__plus'))) problems.push('[+] cannot be tapped');
    let now = await info();
    if (!now.menuOpen) problems.push('tapping [+] did not open the menu');
    else {
      const ids = now.items.map((item) => item.id);
      const missing = wanted.filter((id) => !ids.includes(id));
      if (missing.length > 0) problems.push(`the menu has no ${missing.join(', ')} (it has ${ids.join(', ')})`);
      const camera = ids.includes('camera');
      if (this.tab.mobile !== camera) problems.push(camera ? 'the menu offers a camera on a desk' : 'the menu does not offer "Take a photo" on a phone');
      facts.push(`menu: ${now.items.map((item) => item.label).join(', ')}`);
      await tab.key('Escape');
      await sleep(150);
      now = await info();
      if (now.menuOpen) problems.push('Escape did not close the menu');
      else if (!now.focus?.includes('composer__plus')) problems.push(`after Escape the focus is on ${now.focus}, not on [+]`);
    }

    // Draw, from the menu: the layer opens over the stage and closes again
    await tapOn('.composer__plus');
    if (!(await tapOn('[data-item="draw"]'))) problems.push('the menu has no Draw to tap');
    now = await info();
    if (!now.inkOpen) problems.push('Draw in the menu did not open the drawing layer');
    if (now.menuOpen) problems.push('the menu stayed open after Draw');
    await tapOn('.composer__plus');
    await tapOn('[data-item="draw"]');
    if ((await info()).inkOpen) problems.push('Draw in the menu did not close the drawing layer');
    else facts.push('Draw opens and closes from the menu');

    // the Transcript, from the menu
    await tapOn('.composer__plus');
    await tapOn('[data-item="transcript"]');
    if (!(await info()).transcriptOpen) problems.push('Transcript in the menu did not open the transcript');
    await tapOn('.composer__plus');
    await tapOn('[data-item="transcript"]');
    if ((await info()).transcriptOpen) problems.push('Transcript in the menu did not close the transcript');

    // Save opens a list of its own, with Back
    await tapOn('.composer__plus');
    await tapOn('[data-item="save"]');
    now = await info();
    if (now.view !== 'save' || now.items.length < 4) problems.push(`Save in the menu did not open its list (view ${now.view}, ${now.items.length} entries)`);
    await tapOn('.composer__view:not([hidden]) .composer__back');
    now = await info();
    if (now.view !== 'root') problems.push(`Back from Save did not return to the menu (view ${now.view})`);
    await tab.key('Escape');
    await sleep(100);
    now = await info();
    if (now.menuOpen) problems.push('the menu would not close');
    if (now.value !== '') problems.push(`the field was left holding "${now.value}"`);

    this.add(results, 'composer', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? facts.join('; ') : problems.join('; '));
  }

  // ---- overlap

  checkOverlap(step: Step, answer: Answer, results: CheckResult[]): void {
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

  async checkCutOff(answer: Answer, results: CheckResult[], inCanvas = false): Promise<void> {
    const problems: string[] = [];
    // a page that has grown is judged as it is: its own height (the browser's own page still never scrolls)
    const width = answer.page?.width ?? answer.viewport.width;
    const height = answer.page?.height ?? answer.viewport.height;
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
      if (clipped.length > 0) problems.push(`the painter's sight says part of it fell outside the screen: ${clipped.slice(0, 4).map((item) => `${item.id} ${item.box.x},${item.box.y} ${item.box.w}x${item.box.h} [${item.notes.join('/')}]`).join(', ')}`);
    }
    const page = await this.tab.call<{ sw: number; sh: number; iw: number; ih: number; bw: number; bh: number }>('page');
    if (page.sw > page.iw + 1 || page.bw > page.iw + 1) problems.push(`the page scrolls sideways (${page.sw} wide in ${page.iw})`);
    if (page.sh > page.ih + 1 || page.bh > page.ih + 1) problems.push(`the page scrolls down (${page.sh} tall in ${page.ih})`);
    const all = await this.tab.call<ButtonInfo[]>('chromeButtons');
    // in the chat shell the judged chrome is the canvas's own and the composer's; the thread behind a phone's canvas is inert and not the question here
    const zones = inCanvas ? (await Promise.all(['.shell-canvas', '.shell-composer'].map((selector) => this.tab.call<{ x: number; y: number; w: number; h: number; hidden: boolean } | null>('rect', selector)))).flatMap((zone) => (zone === null ? [] : [zone])) : [];
    const buttons = inCanvas ? all.filter((button) => zones.some((zone) => button.rect.x + button.rect.w / 2 >= zone.x && button.rect.x + button.rect.w / 2 <= zone.x + zone.w && button.rect.y + button.rect.h / 2 >= zone.y && button.rect.y + button.rect.h / 2 <= zone.y + zone.h)) : all;
    const off = buttons.filter((button) => button.rect.x < -1 || button.rect.y < -1 || button.rect.x + button.rect.w > page.iw + 1 || button.rect.y + button.rect.h > page.ih + 1);
    if (off.length > 0) problems.push(`chrome partly off the screen: ${off.slice(0, 3).map((button) => `"${button.label.slice(0, 20)}"`).join(', ')}`);
    this.add(results, 'nothing-cut-off', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `${answer.live.length} elements inside ${width}x${height}, no scrolling` : problems.join('; '));
  }

  // ---- the chat shell at /chat

  /** waits until the shell's reply has been made and the stage has stood still for a moment */
  private async chatRest(): Promise<string> {
    const { tab } = this;
    const deadline = Date.now() + this.options.timeoutMs;
    let last = '';
    let since = Date.now();
    for (;;) {
      await sleep(300);
      const now = await tab.eval<{ ready: boolean; busy: boolean; sig: string; fault: string | null; replies: number; thinking: boolean; stopShown: boolean }>(`(() => {
        const s = window.__stage;
        if (!s) return { ready: false, busy: true, sig: '', fault: null, replies: 0, thinking: false, stopShown: false };
        const st = s.state();
        const els = st.elements.map((e) => [e.id, e.kind, e.phase]);
        const reply = [...document.querySelectorAll('.msg--reply')].pop();
        return { ready: true, busy: st.turn !== null || st.anticipating || els.some((e) => e[2] === 'entering' || e[2] === 'leaving'), sig: JSON.stringify(els), fault: st.fault, replies: document.querySelectorAll('.msg--reply').length, thinking: !!(reply && reply.querySelector('.reply__thinking')), stopShown: (document.querySelector('.pill__send') || {}).getAttribute('aria-label') !== 'Send' };
      })()`);
      if (!now.ready) continue;
      if (now.fault !== null) return `the stage reports a fault: ${now.fault}`;
      const quiet = !now.busy && !now.thinking && !now.stopShown && now.replies > 0 && tab.pending() === 0;
      if (!quiet || now.sig !== last) {
        last = now.sig;
        since = Date.now();
      } else if (Date.now() - since >= STABLE_MS) return '';
      if (Date.now() > deadline) return `the reply did not come to rest in ${Math.round(this.options.timeoutMs / 1000)} s`;
    }
  }

  /** the /chat pass on this screen: one prompt, its reply, the trace, the canvas, and the composer with the canvas open */
  private async chat(): Promise<readonly CheckResult[]> {
    const { tab } = this;
    const results: CheckResult[] = [];
    this.current = 101;
    const step: Step = { n: 101, say: 'draw a lighthouse at dusk', name: 'chat', expects: 'drawing' };
    this.at('opening /chat');
    await tab.send('Page.navigate', { url: `${this.options.url}/chat` });
    await waitFor('the chat shell to be ready', 60_000, async () => ((await tab.eval<boolean>('!!window.__stage && !!window.__shell').catch(() => false)) ? true : null));
    await tab.eval('window.__stage.ready');
    await sleep(500);
    tab.drain();

    // send
    this.at('typing the prompt');
    const field = await tab.eval<{ x: number; y: number } | null>(`(() => { const r = (document.querySelector('.pill__field') || {}).getBoundingClientRect?.(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (field === null) {
      this.add(results, 'chat-send', 'FAIL', 'the shell has no composer field');
      return results;
    }
    const sent = tab.posted.length;
    await tab.tap(field.x, field.y);
    await tab.type(step.say ?? '');
    const typed = await tab.eval<string>(`document.querySelector('.pill__field').value`);
    await tab.key('Enter');
    await sleep(600);
    const posted = tab.posted.slice(sent).find((turn) => turn.kind === 'prompt');
    this.add(results, 'chat-send', typed === step.say && posted?.text === step.say ? 'PASS' : 'FAIL', typed !== step.say ? `typing left "${typed}" in the field` : posted === undefined ? 'Enter posted no turn' : `a turn was posted with "${posted.text}"`);

    // the reply arrives
    this.at('waiting for the reply');
    const trouble = await this.chatRest();
    const made = await tab.eval<{ replies: number; users: number; words: number; card: boolean; open: boolean; note: string; state: string | null }>(`(() => {
      const reply = [...document.querySelectorAll('.msg--reply')].pop();
      return { replies: document.querySelectorAll('.msg--reply').length, users: document.querySelectorAll('.msg--user').length, words: reply ? (reply.querySelector('.reply__words, .reply')?.innerText || '').trim().length : 0, card: !!(reply && reply.querySelector('[data-focus=card], [data-focus=open]')), open: window.__shell.state().canvasOpen, note: reply ? (reply.querySelector('.reply__note')?.innerText || '') : '', state: reply ? (reply.querySelector('.reply__thinking') ? 'working' : 'done') : null };
    })()`);
    const replyProblems = [trouble, made.replies !== 1 ? `${made.replies} replies in the thread` : '', made.users !== 1 ? `${made.users} messages from the person` : '', made.note !== '' ? `the reply says: ${made.note}` : '', made.words === 0 && !made.card ? 'the reply has no words and no canvas to open' : ''].filter((text) => text !== '');
    this.add(results, 'chat-reply', replyProblems.length === 0 ? 'PASS' : 'FAIL', replyProblems.length === 0 ? `reply in the thread (${made.words} characters of words${made.card ? ', a card for the canvas' : ''})` : replyProblems.join('; '));
    await this.chatShot('reply');

    // the trace under it
    this.at('opening the trace');
    const toggle = await tab.eval<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('.msg--reply .trace__toggle'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 }; })()`);
    if (toggle === null) this.add(results, 'chat-trace', 'FAIL', 'the reply has no trace line under it');
    else {
      await tab.tap(toggle.x, toggle.y);
      await sleep(500);
      const trace = await tab.eval<{ expanded: boolean; shown: boolean; items: number; text: string; inside: boolean }>(`(() => {
        const b = document.querySelector('.msg--reply .trace__toggle'); const p = document.querySelector('.msg--reply .trace__panel');
        const r = p ? p.getBoundingClientRect() : null;
        return { expanded: b.getAttribute('aria-expanded') === 'true', shown: !!p && !p.hidden && !!r && r.height > 0, items: p ? p.querySelectorAll('.trace__list > li').length : 0, text: p ? p.innerText.slice(0, 80).replace(/\s+/g, ' ') : '', inside: !!r && r.left >= -1 && r.right <= innerWidth + 1 };
      })()`);
      const problems = [trace.expanded ? '' : 'the toggle did not open', trace.shown ? '' : 'the panel is not shown', trace.items === 0 ? 'the timeline has no entries' : '', trace.inside ? '' : 'the timeline runs off the side of the screen'].filter((text) => text !== '');
      this.add(results, 'chat-trace', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `opens, ${trace.items} entries ("${trace.text.slice(0, 40)}")` : problems.join('; '));
      await this.chatShot('trace');
      await tab.tap(toggle.x, toggle.y);
      await sleep(250);
    }

    // the canvas
    this.at('opening the canvas');
    const wasOpen = await tab.eval<boolean>('window.__shell.state().canvasOpen');
    if (!wasOpen) {
      const card = await tab.eval<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('.msg--reply [data-focus=card], .msg--reply [data-focus=open]'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (card !== null) await tab.tap(card.x, card.y);
      await sleep(900);
    }
    const open = await tab.eval<boolean>('window.__shell.state().canvasOpen');
    if (!open) {
      for (const check of ['answer-on-stage', 'no-overlap', 'nothing-cut-off']) this.add(results, check, 'FAIL', 'the canvas would not open from the reply');
    } else {
      // the stage is at rest and the answer is the reply's
      await this.chatRest();
      await sleep(600);
      const stage = await tab.call<{ x: number; y: number; w: number; h: number; hidden: boolean } | null>('rect', '.shell-canvas__room .stage');
      const answer = await tab.call<Answer>('answer');
      const picture = stage === null ? '' : await tab.shot({ x: stage.x, y: stage.y, width: stage.w, height: stage.h });
      const scratch: CheckResult[] = [];
      if (stage === null || stage.hidden) scratch.push({ turn: 101, check: 'answer-on-stage', verdict: 'FAIL', detail: 'the canvas has no visible stage' });
      else await this.checkAnswer(step, answer, picture, scratch);
      // the answer on the canvas is the reply's own: the canvas names this turn
      const shown = await tab.eval<{ turn: string | null; key: string | null }>(`({ turn: window.__shell.state().canvasTurn, key: window.__shell.state().stageKey })`);
      const last = answer.report?.turn ?? null;
      for (const found of scratch) results.push(found.check === 'answer-on-stage' && shown.turn !== last && last !== null ? { ...found, verdict: 'FAIL', detail: `the canvas is on turn ${shown.turn} but the answer is turn ${last}` } : found);
      this.checkOverlap(step, answer, results);
      await this.checkCutOff(answer, results, true);
      // what the person sees of the stage is the room the shell left it, not the whole screen
      await this.chatShot('canvas');
    }

    // the composer, with the canvas open
    this.at('the composer with the canvas open');
    if (open) {
      const pill = await tab.eval<{ x: number; y: number; w: number; h: number; hit: boolean; hitEl: string; inView: boolean; inert: boolean } | null>(`(() => {
        const p = document.querySelector('.pill'); if (!p) return null;
        const r = p.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { x: r.left, y: r.top, w: r.width, h: r.height, hit: !!top && p.contains(top), hitEl: top ? (top.className || top.tagName).toString().slice(0, 40) : 'nothing', inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1, inert: !!p.closest('[inert]') };
      })()`);
      const problems: string[] = [];
      if (pill === null) problems.push('the composer is not on the page');
      else {
        if (!pill.inView) problems.push(`the pill is not on screen (${boxText({ x: pill.x, y: pill.y, width: pill.w, height: pill.h })} in ${this.screen.width}x${this.screen.height})`);
        if (!pill.hit) problems.push(`something covers the pill: ${pill.hitEl}`);
        if (pill.inert) problems.push('the pill is inert while the canvas is open');
        await tab.tap(pill.x + pill.w / 2, pill.y + pill.h / 2);
        await tab.type('ok');
        const after = await tab.eval<{ value: string; canSend: boolean; canvas: boolean }>(`({ value: document.querySelector('.pill__field').value, canSend: !document.querySelector('.pill__send').disabled && document.querySelector('.pill__send').getAttribute('aria-disabled') !== 'true', canvas: window.__shell.state().canvasOpen })`);
        if (after.value !== 'ok') problems.push(`real keys put "${after.value}" in the field, not "ok"`);
        if (!after.canSend) problems.push('Send stays disabled with words in the field');
        if (!after.canvas) problems.push('the canvas closed when the field was used');
        await this.chatShot('composer');
        for (let i = 0; i < after.value.length; i += 1) await tab.key('Backspace');
      }
      this.add(results, 'chat-composer', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? 'the pill is on screen, nothing covers it, a tap and keys put words in it, the canvas stays open' : problems.join('; '));
    } else this.add(results, 'chat-composer', 'FAIL', 'no canvas to check the composer against');

    const drained = tab.drain();
    this.add(results, 'no-console-errors', drained.consoleErrors.length === 0 ? 'PASS' : 'FAIL', drained.consoleErrors.length === 0 ? 'none' : drained.consoleErrors.slice(0, 3).map((entry) => entry.text).join('; '));
    // the page's icon is not the build's: a request for it that fails is not a failure of the shell
    const failed = drained.failedRequests.filter((entry) => !/\/favicon\.ico/.test(entry.text));
    this.add(results, 'no-failed-requests', failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0 ? 'none' : failed.slice(0, 3).map((entry) => entry.text).join('; '));
    return results;
  }

  private async chatShot(name: string): Promise<void> {
    const data = (await this.tab.shot()).split(',')[1] ?? '';
    await writeFile(join(this.dir, `chat-${name}.png`), Buffer.from(data, 'base64'));
  }

  static async runChat(options: Options, screen: Options['screens'][number]): Promise<{ readonly results: readonly CheckResult[]; readonly seconds: number; readonly dir: string; readonly aborted: string | null }> {
    const dir = join(options.out, screen.name);
    await mkdir(dir, { recursive: true });
    const started = Date.now();
    const tab = await Tab.open(screen.width, screen.height);
    try {
      const talk = new Conversation(tab, options, screen, dir);
      let results: readonly CheckResult[] = [];
      let aborted: string | null = null;
      const beat = setInterval(() => {
        const idle = Math.round((Date.now() - talk.phaseSince) / 1000);
        if (idle >= 45) process.stdout.write(`[${screen.name}] still in the /chat pass: ${talk.phase} (${idle} s)\n`);
      }, 15_000);
      try {
        results = await talk.chat();
      } catch (error) {
        aborted = `${talk.phase}: ${error instanceof Error ? error.message : String(error)}`;
        process.stdout.write(`[${screen.name}] ABORTED in the /chat pass, ${aborted}\n`);
      } finally {
        clearInterval(beat);
      }
      return { results, seconds: (Date.now() - started) / 1000, dir, aborted };
    } finally {
      await tab.close();
    }
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
      const viewNow = (await tab.call<Answer>('answer')).viewport;
      if (act === undefined) problems.push(`pressing the button ${heard.id} ("${heard.part}") sent nothing to the server: no turn of kind act was posted in 6 s${share >= 0.03 ? ' (the button did change its look)' : ''}; posted since the tap: ${tab.posted.slice(mark).map((turn) => turn.kind ?? '?').join(', ') || 'nothing'}; the button was at ${boxText(heard.box)} in a ${viewNow.width}x${viewNow.height} stage and the page was at "${(await tab.call<Probe>('probe')).status}"`);
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

  async contactSheet(): Promise<string | null> {
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
    const out = await Promise.race([
      tab.browser.send<{ result: { value?: string }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }, sessionId),
      sleep(CDP_TIMEOUT_MS).then(() => ({ result: {} as { value?: string } })),
    ]);
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
  // the /chat pass starts with the conversation, in tabs of its own: it adds no time of its own when the conversation takes longer
  const chatRuns = options.chat === 'off' ? Promise.resolve([]) : Promise.all(options.screens.map((screen) => Conversation.runChat(options, screen).then((run) => ({ screen, run }))));
  const runs = options.chat === 'only' ? [] : options.parallel
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
    if (run.aborted !== null) {
      failures += 1;
      process.stdout.write(`  FAIL ${screen.name} stopped: ${run.aborted}\n`);
    }
    process.stdout.write(`  ${screen.name}: ${run.seconds.toFixed(0)} s, contact sheet ${run.sheet ?? 'none'}\n`);
    summary.push({ screen: screen.name, aborted: run.aborted, seconds: run.seconds, sheet: run.sheet, turns: run.records.map((record) => ({ turn: record.step.n, said: record.said, picture: record.picture, seconds: record.seconds, results: record.results })) });
  }
  const chat: unknown[] = [];
  for (const { screen, run } of await chatRuns) {
    process.stdout.write(`\n/chat on ${screen.name}\n`);
    for (const result of run.results) process.stdout.write(`${result.check.padEnd(20)}${result.verdict}${result.verdict === 'FAIL' ? `  ${result.detail}` : ''}\n`);
    for (const result of run.results) if (result.verdict === 'FAIL') failures += 1;
    if (run.aborted !== null) {
      failures += 1;
      process.stdout.write(`  FAIL /chat on ${screen.name} stopped: ${run.aborted}\n`);
    }
    process.stdout.write(`  ${screen.name}: ${run.seconds.toFixed(0)} s, pictures in ${run.dir}\n`);
    chat.push({ screen: screen.name, aborted: run.aborted, seconds: run.seconds, results: run.results });
  }
  await writeFile(join(options.out, 'smoke.json'), JSON.stringify({ url: options.url, at: new Date().toISOString(), failures, screens: summary, chat }, null, 2));
  process.stdout.write(`\n${failures === 0 ? 'PASS: the build may go live.' : `FAIL: ${failures} check${failures === 1 ? '' : 's'} failed. The build must not go live.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && /smoke\.ts$/.test(process.argv[1])) {
// A gate that is killed from outside must say so: a silent end after some turns is what a stuck run looks like, and it is not one.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      process.stderr.write(`smoke: stopped by ${signal} (something outside the gate ended it)\n`);
      process.exit(2);
    });
  }
  process.on('exit', (code) => {
    if (code !== 0 && code !== 1) process.stderr.write(`smoke: exit ${code}\n`);
  });
  
  main().catch((error: unknown) => {
    process.stderr.write(`smoke: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  });
  
}
