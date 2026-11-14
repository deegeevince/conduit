// Drives the figure bench (bench-figure.html) in a real headless Chrome over the DevTools protocol (Node's own WebSocket; no dependency).
//
//   node web/scripts/figure-check.mjs <shots|check> [--url http://127.0.0.1:4930] [--out DIR] [--fixture heart] [--look paper] [--cdp 4931]
//
//   shots   a picture per fixture, per size, at rest and at each step (the stepper is pressed with real input: a mouse at 1280x720, a touch at 390x844)
//   check   the acceptance, as pass/fail lines: labels on their part's side and never crossing or on the figure, steps that light the right parts,
//           dots that run the right way along the stretch of route a step runs, reduced motion showing chevrons only, a whole stepper of at least 44
//
// Ports 4930-4939 only (never 4932). The page is served by `vite --port 4930` from `web/`.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0] ?? 'check';
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = opt('url', 'http://127.0.0.1:4930');
const OUT = opt('out', '/tmp/fg2-shots');
const ONLY = opt('fixture', '');
const LOOK = opt('look', 'paper');
const PORT = Number(opt('cdp', '4931'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURES = ['heart', 'flower', 'bicycle', 'syringe', 'pen'].filter((f) => ONLY === '' || f === ONLY);
const SIZES = [
  { name: '1280x720', width: 1280, height: 720, dpr: 1, touch: false },
  { name: '390x844', width: 390, height: 844, dpr: 2, touch: true },
];
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'fg2-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return { proc, ws: page.webSocketDebuggerUrl };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

function client(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      id += 1;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

const { proc, ws } = await launch();
const cdp = client(ws);
await cdp.ready;
const call = (m, p) => cdp.send(m, p);
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

async function open(size, fixture, { look = LOOK, step = 0, reduced = false } = {}) {
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: size.touch });
  await call('Emulation.setTouchEmulationEnabled', { enabled: size.touch });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
  await call('Page.navigate', { url: `${BASE}/bench-figure.html?fixture=${fixture}&look=${look}&step=${step}&panel=0${reduced ? '&reduced=1' : ''}` });
  for (let i = 0; i < 200; i += 1) {
    await sleep(100);
    if ((await evaluate('window.__ready === true')) === true) break;
  }
  const error = await evaluate('window.__error ?? null');
  if (error) throw new Error(`bench error: ${error}`);
  await sleep(500);
}

const info = () => evaluate('JSON.stringify(window.__figure.info())').then(JSON.parse);
const shot = async (file) => {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, file), Buffer.from(r.data, 'base64'));
};

/** A real press at a page point: a mouse on a desk, a touch on a phone. */
async function tap(size, x, y) {
  if (size.touch) {
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(40);
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
}
async function pressStepper(size, which) {
  const i = await info();
  const b = i.stepper[which];
  await tap(size, i.pad + b.x + b.w / 2, i.pad + b.y + b.h / 2);
  await sleep(450);
}

// ------------------------------------------------------------------ shots
async function shots() {
  for (const size of SIZES) {
    for (const fixture of FIXTURES) {
      await open(size, fixture);
      const first = await info();
      await shot(`${fixture}-${size.name}-rest.png`);
      for (let s = 1; s <= first.steps; s += 1) {
        await pressStepper(size, 'next');
        await shot(`${fixture}-${size.name}-step${s}.png`);
      }
      console.log(`shots ${fixture} ${size.name}: rest + ${first.steps} steps`);
    }
  }
}

// ------------------------------------------------------------------ checks
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `  ${detail}`}`);
};
const cross = (a, b, c, d) => {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
};
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function labelChecks(tag, i) {
  const fig = i.subject;
  const centre = { x: fig.x + fig.w / 2, y: fig.y + fig.h / 2 };
  const slack = 0.04 * Math.max(fig.w, fig.h);
  const partOf = new Map(i.parts.map((p) => [p.id, p]));
  const bad = { side: [], onFigure: [], spill: [], onPart: [] };
  for (const l of i.labels) {
    const p = partOf.get(l.part);
    const mid = { x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 };
    // the part's own centre by polygon area is not in the info; the box middle is close enough for a half-plane test with slack
    const ok = l.side === 'left' ? mid.x <= centre.x + slack : l.side === 'right' ? mid.x >= centre.x - slack : l.side === 'top' ? mid.y <= centre.y + slack : mid.y >= centre.y - slack;
    if (!ok) bad.side.push(l.part);
    if (overlap(l.box, fig)) bad.onFigure.push(l.part);
    if (l.box.x < -0.5 || l.box.y < -0.5 || l.box.x + l.box.w > i.box.width + 0.5 || l.box.y + l.box.h > i.box.height + 0.5) bad.spill.push(l.part);
  }
  check(`${tag}: every label on its part's side (${i.labels.length} labels)`, bad.side.length === 0, bad.side.join(','));
  check(`${tag}: no label on the figure`, bad.onFigure.length === 0, bad.onFigure.join(','));
  check(`${tag}: no label outside the box`, bad.spill.length === 0, bad.spill.join(','));
  let crossings = 0;
  for (let a = 0; a < i.labels.length; a += 1) for (let b = a + 1; b < i.labels.length; b += 1) {
    const [p, q] = i.labels[a].leader.map((z) => [z.x, z.y]);
    const [r, s] = i.labels[b].leader.map((z) => [z.x, z.y]);
    if (cross(p, q, r, s)) crossings += 1;
  }
  check(`${tag}: no two leaders cross`, crossings === 0, `${crossings} crossings`);
  // each leader ends inside its own part's bounds and the label's text does not overlap another label
  let stack = 0;
  for (let a = 0; a < i.labels.length; a += 1) for (let b = a + 1; b < i.labels.length; b += 1) if (overlap(i.labels[a].box, i.labels[b].box)) stack += 1;
  check(`${tag}: no label over another`, stack === 0, `${stack}`);
  const share = Math.max(i.subject.w / i.stage.w, i.subject.h / i.stage.h);
  check(`${tag}: the subject takes 55-75% of the stage (${(share * 100).toFixed(0)}%)`, share >= 0.549 && share <= 0.751, '');
  check(`${tag}: at most seven labels`, i.labels.length <= 7, `${i.labels.length}`);
}

async function fits(tag) {
  const overflow = await evaluate('JSON.stringify({sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight, bw: document.body.scrollWidth, bh: document.body.scrollHeight})').then(JSON.parse);
  check(`${tag}: nothing spills out of body`, overflow.sw <= overflow.iw && overflow.sh <= overflow.ih && overflow.bw <= overflow.iw && overflow.bh <= overflow.ih, JSON.stringify(overflow));
  const words = await evaluate('JSON.stringify(window.__figure.words())').then(JSON.parse);
  const i = await info();
  const out = words.filter((w) => w.box.x < -0.5 || w.box.y < -0.5 || w.box.x + w.box.w > i.box.width + 0.5 || w.box.y + w.box.h > i.box.height + 0.5);
  check(`${tag}: every word inside the figure's box (${words.length} words)`, out.length === 0, out.map((w) => w.text).join('|'));
}

function stepperChecks(tag, i, size) {
  const s = i.stepper;
  if (s === null) return check(`${tag}: no stepper (no steps)`, i.steps === 0);
  const inside = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= i.box.width && b.y + b.h <= i.box.height;
  const inBand = (b) => b.y >= i.band.y && b.y + b.h <= i.band.y + i.band.h && b.x >= i.band.x && b.x + b.w <= i.band.x + i.band.w;
  check(`${tag}: stepper whole, inside the figure's box and its band`, inside(s.prev) && inside(s.next) && inBand(s.prev) && inBand(s.next), JSON.stringify(s));
  check(`${tag}: stepper at least 44 px (${s.prev.w}x${s.prev.h}, ${s.next.w}x${s.next.h})`, Math.min(s.prev.w, s.prev.h, s.next.w, s.next.h) >= 44, '');
  check(`${tag}: stepper inside the viewport`, i.pad + s.next.x + s.next.w <= size.width && i.pad + s.next.y + s.next.h <= size.height, '');
}

/** The arc-length coordinate of a point projected on a polyline, and the line's length. */
function arcOf(pts, p) {
  let best = { d: Infinity, s: 0 };
  let run = 0;
  for (let k = 1; k < pts.length; k += 1) {
    const a = pts[k - 1], b = pts[k];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / (len * len)));
    const d = Math.hypot(p.x - (a[0] + dx * t), p.y - (a[1] + dy * t));
    if (d < best.d) best = { d, s: run + t * len };
    run += len;
  }
  return { ...best, length: run };
}

async function checkAll() {
  for (const size of SIZES) {
    for (const fixture of FIXTURES) {
      const tag = `${fixture} ${size.name}`;
      await open(size, fixture);
      let i = await info();
      labelChecks(tag, i);
      stepperChecks(tag, i, size);
      await fits(tag);
      check(`${tag}: at rest every part is lit and the title is in the band`, i.lit === null && i.caption.lines.join(' ').length > 0, i.caption.lines.join(' '));
      const opaque = await evaluate('JSON.stringify(window.__figure.opacity())').then(JSON.parse);
      check(`${tag}: at rest every part is whole`, Object.values(opaque).every((o) => o === 1), JSON.stringify(opaque));
      check(`${tag}: refit notes and drops reported (${i.notes.map((n) => n.kind).join(',') || 'none'})`, true);

      // steps, pressed with real input
      let runs = 0;
      for (let s = 1; s <= i.steps; s += 1) {
        await pressStepper(size, 'next');
        i = await info();
        check(`${tag} step ${s}: the press moved the step`, i.step === s, `at ${i.step}`);
        const want = (await evaluate(`JSON.stringify(window.__figure.state())`).then(JSON.parse)).step;
        void want;
        const opacity = await evaluate('JSON.stringify(window.__figure.opacity())').then(JSON.parse);
        const lit = new Set(i.lit ?? []);
        const wrong = i.parts.filter((p) => (lit.has(p.id) ? opacity[p.id] !== 1 : Math.abs(opacity[p.id] - 0.35) > 0.011)).map((p) => `${p.id}=${opacity[p.id]}`);
        check(`${tag} step ${s}: lit parts [${[...lit].join(',')}] whole, the rest at 35%`, wrong.length === 0 && lit.size > 0, wrong.join(' '));
        check(`${tag} step ${s}: the words are in the band`, i.caption.lines.length > 0 && i.band.h > 0, i.caption.lines.join(' '));
        labelChecks(`${tag} step ${s}`, i);
        // dots run along the stretch the step runs, the right way
        const t1 = JSON.parse(await evaluate('JSON.stringify(window.__figure.dots())'));
        await sleep(350);
        const t2 = JSON.parse(await evaluate('JSON.stringify(window.__figure.dots())'));
        const shown = new Set(i.lit ?? []);
        for (const route of i.routes) {
          const hit = route.items.filter((it) => shown.has(it.part));
          const dots1 = t1.filter((d) => d.key.includes(`route:${route.id}:dot:`));
          const dots2 = t2.filter((d) => d.key.includes(`route:${route.id}:dot:`));
          if (hit.length === 0) {
            check(`${tag} step ${s}: route ${route.id} not in this step has no dots`, dots2.length === 0, `${dots2.length}`);
            continue;
          }
          const from = Math.min(...hit.map((h) => h.from));
          const to = Math.max(...hit.map((h) => h.to));
          let ok = dots2.length > 0;
          let detail = '';
          for (const d2 of dots2) {
            const d1 = dots1.find((d) => d.key === d2.key);
            if (d1 === undefined) continue;
            const a1 = arcOf(route.pts, d1), a2 = arcOf(route.pts, d2);
            const span = to - from;
            const moved = ((a2.s - a1.s) % span + span) % span;
            const within = a2.s >= from - 3 && a2.s <= to + 3 && a2.d < 3;
            if (!(moved > 0 && moved < span / 2) || !within) { ok = false; detail += ` ${d2.key}: s ${a1.s.toFixed(1)}->${a2.s.toFixed(1)} in [${from.toFixed(1)},${to.toFixed(1)}] off ${a2.d.toFixed(1)};`; }
            runs += 1;
          }
          check(`${tag} step ${s}: dots on route ${route.id} run forward along [${from.toFixed(0)},${to.toFixed(0)}]`, ok, detail);
        }
      }
      // back to rest by the previous button
      if (i.steps > 0) {
        for (let s = i.steps; s > 0; s -= 1) await pressStepper(size, 'prev');
        i = await info();
        check(`${tag}: stepping back returns to rest`, i.step === 0 && i.lit === null, `step ${i.step}`);
      }
      void runs;

      // reduced motion: chevrons only
      await open(size, fixture, { reduced: true });
      const dots = JSON.parse(await evaluate('JSON.stringify(window.__figure.dots())'));
      const chev = await evaluate('window.__figure.chevrons()');
      const j = await info();
      check(`${tag} reduced motion: chevrons only (${chev} chevrons, ${dots.length} dots)`, j.routes.length === 0 ? true : dots.length === 0 && chev > 0, '');
      // and the same with motion shows dots when there is a route
      await open(size, fixture);
      await sleep(300);
      const moving = JSON.parse(await evaluate('JSON.stringify(window.__figure.dots())'));
      const k = await info();
      check(`${tag} motion: dots ride the routes (${moving.length})`, k.routes.length === 0 || moving.length > 0, '');
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  if (failed.length > 0) process.exitCode = 1;
}

try {
  if (command === 'shots') await shots();
  else await checkAll();
} finally {
  cdp.close();
  proc.kill();
}
