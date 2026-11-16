// Drives the ink in a real headless Chrome over the DevTools protocol (Node's own WebSocket; no dependency).
//
//   node web/scripts/ink-check.mjs <scenario> [--url http://127.0.0.1:4911] [--out DIR] [--viewport ipad|desk] [--sheet PHOTO.jpg] [--wait SECONDS]
//
// Scenarios:
//   stage    Draw on the stage: palm rejection (touch during a pen stroke), "60" and five circles, undo/redo/erase, then Send with "is this right?"
//   sheet    The worksheet bench over a photo: write an answer in a box and in the scratch area, and read which region each stroke landed in
//   latency  Draw a long run of pen strokes and print the page's own latency numbers
//
// Pen: Input.dispatchMouseEvent with pointerType 'pen', force and tilt. Touch: Input.dispatchTouchEvent. Both reach the page as real pointer events.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const scenario = args[0] ?? 'stage';
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const URL_BASE = opt('url', 'http://127.0.0.1:4911');
const OUT = opt('out', join(tmpdir(), 'conduit-ink'));
const VIEW = opt('viewport', 'ipad');
const SHEET = opt('sheet', '');
const WAIT = Number(opt('wait', '150'));
const PORT = Number(opt('cdp', '4919'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ a minimal CDP client
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'ink-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--mute-audio', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu-vsync', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
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
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
    }
  };
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
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
const send = cdp.send;

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};

async function shot(name, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`picture ${file}`);
}

// ------------------------------------------------------------------ input
let penTime = 0;
const pen = {
  async hover(x, y, tiltX = 20, tiltY = 10) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'pen', force: 0, tiltX, tiltY });
  },
  async stroke(points, { every = 6, tiltX = 25, tiltY = 15, eraser = false } = {}) {
    const [first, ...rest] = points;
    const buttons = eraser ? 32 : 1;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: eraser ? 'none' : 'left', buttons, clickCount: 1, pointerType: 'pen', force: first.f ?? 0.4, tiltX, tiltY });
    for (const p of rest) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: eraser ? 'none' : 'left', buttons, pointerType: 'pen', force: p.f ?? 0.5, tiltX, tiltY });
      await sleep(every);
    }
    const last = points[points.length - 1];
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: eraser ? 'none' : 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0, tiltX, tiltY });
    penTime += 1;
  },
};
const mouse = {
  async stroke(points, every = 6) {
    const [first, ...rest] = points;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1 });
    for (const p of rest) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
      await sleep(every);
    }
    const last = points[points.length - 1];
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 });
  },
  async click(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  },
};
const touch = {
  async stroke(points, { every = 8, id = 1, radius = 12 } = {}) {
    const tp = (p) => [{ x: p.x, y: p.y, id, radiusX: radius, radiusY: radius, force: 0.5 }];
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(points[0]) });
    for (const p of points.slice(1)) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(p) });
      await sleep(every);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  },
  async tap(x, y) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 10, radiusY: 10, force: 0.5 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  },
};

// ------------------------------------------------------------------ shapes: hand-written "60" and circles, with pressure that rises and falls
const ease = (t) => 0.25 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
function along(curve, n, force = ease) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const [x, y] = curve(t);
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, f: force(t) };
  });
}
/** a smooth curve through key points (Catmull-Rom), parameter 0..1 */
const through = (pts) => (t) => {
  const n = pts.length - 1;
  const f = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
};
/** a "6": starts top right, sweeps down the left and round into a closed loop at the bottom */
const six = (x, y, h) => {
  const P = (a, b) => [x + h * a, y + h * b];
  return along(through([P(0.34, 0.02), P(0.14, 0.2), P(0.02, 0.5), P(0.04, 0.8), P(0.2, 0.98), P(0.38, 0.8), P(0.3, 0.58), P(0.14, 0.56), P(0.04, 0.68)]), 80);
};
/** a "0": a tall oval */
const zero = (x, y, h) => along((t) => {
  const a = -Math.PI / 2 + t * Math.PI * 2.08;
  return [x + h * 0.22 * Math.cos(a), y + h * 0.5 + h * 0.5 * Math.sin(a)];
}, 60);
const circle = (cx, cy, r) => along((t) => {
  const a = -Math.PI / 2 + t * Math.PI * 2.1;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}, 36);

// ------------------------------------------------------------------ the page
const SIZES = { ipad: { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true, touch: true }, desk: { width: 1920, height: 825, deviceScaleFactor: 1, mobile: false, touch: false } };
const size = SIZES[VIEW];
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor, mobile: size.mobile });
if (size.touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const open = async (path) => {
  await send('Page.navigate', { url: `${URL_BASE}${path}` });
  await sleep(1500);
};

const rectOf = async (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const strokeCount = () => evaluate(`window.__inkProbe ? window.__inkProbe.count() : -1`);

let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
};

try {
  if (scenario === 'stage' || scenario === 'latency' || scenario === 'tools') {
    await open('/?demo=none');
    await evaluate(`window.__stage.ready.then(() => true)`);
    // a way for the page to say how many strokes the stage ink holds (the page's own state, read back)
    await evaluate(`window.__inkProbe = { count: () => document.querySelectorAll('.ink-stage canvas.ink__base').length ? Number(document.querySelector('.composer__badge')?.textContent || 0) : 0 }`);
    // Draw is an entry of the composer's [+] menu
    await mouse.click(...Object.values(centre(await rectOf('.composer__plus'))));
    await sleep(250);
    await mouse.click(...Object.values(centre(await rectOf('[data-item="draw"]'))));
    await sleep(500);
    const stage = await rectOf('.ink-stage');
    check('Draw opens the ink layer over the stage', stage.w > 500 && stage.h > 300, `${Math.round(stage.w)}x${Math.round(stage.h)}`);
    await shot(`stage-${VIEW}-1-open`);

    if (scenario === 'tools') {
      // the highlighter lies under the pen, and two highlighter strokes do not go darker where they cross
      const gx = stage.x + stage.w * 0.25;
      const gy = stage.y + stage.h * 0.3;
      await pen.stroke(zero(gx, gy, 140));
      await mouse.click(...Object.values(centre(await rectOf('button[aria-label="Highlighter"]'))));
      await mouse.click(...Object.values(centre(await rectOf('button[data-color="#2e7d32"]'))));
      await pen.stroke(along((t) => [gx - 60 + t * 300, gy + 40 + t * 10], 30), { every: 6 });
      await pen.stroke(along((t) => [gx + 90 + t * 20, gy - 20 + t * 150], 30), { every: 6 });
      await mouse.click(...Object.values(centre(await rectOf('button[aria-label="Pen"]'))));
      await mouse.click(...Object.values(centre(await rectOf('button[data-color="#1565c0"]'))));
      await pen.stroke(six(gx + 200, gy, 140));
      await sleep(200);
      check('three strokes of two tools and two colours', (await strokeCount()) === 4, `${await strokeCount()}`);
      await shot(`stage-${VIEW}-tools`);
    } else if (scenario === 'latency') {
      for (let i = 0; i < 30; i += 1) {
        const y = stage.y + 120 + (i % 10) * 40;
        const f = along((t) => [stage.x + 100 + t * 800, y + 25 * Math.sin(t * 9 + i)], 120);
        await pen.stroke(f, { every: 4 });
      }
      await sleep(300);
      console.log('latency', JSON.stringify(await evaluate(`JSON.stringify(window.__inkStats?.())`)));
      await shot(`stage-${VIEW}-latency`);
    } else {
      // --- palm rejection: the pen goes down, a finger lands and drags during the stroke; the finger draws nothing
      const x0 = stage.x + stage.w * 0.2;
      const y0 = stage.y + stage.h * 0.45;
      const before = await strokeCount();
      await pen.hover(x0, y0);
      await sleep(30);
      const penStroke = along((t) => [x0 + t * 260, y0 + 30 * Math.sin(t * 6)], 60);
      // interleave: start the pen, then a touch during it
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: penStroke[0].x, y: penStroke[0].y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5, tiltX: 20, tiltY: 10 });
      for (let i = 1; i < 25; i += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: penStroke[i].x, y: penStroke[i].y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5, tiltX: 20, tiltY: 10 });
        await sleep(6);
      }
      const palm = !size.touch ? [] : along((t) => [x0 + 40 + t * 200, y0 + 140 + t * 30], 25).map((p) => ({ ...p }));
      const palmDraw = size.touch ? touch.stroke(palm, { every: 8, id: 7, radius: 40 }) : Promise.resolve();
      for (let i = 25; i < penStroke.length; i += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: penStroke[i].x, y: penStroke[i].y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5, tiltX: 20, tiltY: 10 });
        await sleep(6);
      }
      await palmDraw;
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: penStroke[penStroke.length - 1].x, y: penStroke[penStroke.length - 1].y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
      await sleep(200);
      const afterPalm = await strokeCount();
      check(size.touch ? 'palm rejection: a touch during a pen stroke draws nothing' : 'a pen stroke draws (no touch on a desk)', afterPalm === before + 1, `strokes ${before} -> ${afterPalm}`);
      await shot(`stage-${VIEW}-2-palm`);

      // touch right after the pen lifted (a palm settling): still ignored, because a pen has been seen
      if (size.touch) await touch.stroke(along((t) => [x0 + t * 150, y0 + 200], 12), { every: 8, id: 3 });
      await sleep(100);
      if (size.touch) check('a finger after the pen draws nothing either (a pen is about)', (await strokeCount()) === afterPalm, `${await strokeCount()}`);
      await mouse.click(x0 + 400, y0 + 120); // the mouse still draws a dot
      await evaluate('new Promise(r => setTimeout(r, 600))');
      // undo the mouse's dot and the first line
      const undoBtn = await rectOf('button[aria-label="Undo"]');
      await mouse.click(...Object.values(centre(undoBtn)));
      await sleep(100);

      // --- start over: clear, then write "60" and five circles
      const clearBtn = await rectOf('button[aria-label="Clear everything"]');
      await mouse.click(...Object.values(centre(clearBtn)));
      await sleep(150);
      check('clear empties the layer', (await strokeCount()) === 0);
      const undoAfter = await rectOf('button[aria-label="Undo"]');
      await mouse.click(...Object.values(centre(undoAfter)));
      await sleep(100);
      check('undo brings the cleared ink back', (await strokeCount()) >= 1, `${await strokeCount()}`);
      await mouse.click(...Object.values(centre(clearBtn)));
      await sleep(100);

      const gx = stage.x + stage.w * 0.3;
      const gy = stage.y + stage.h * 0.28;
      await pen.stroke(six(gx, gy, 140));
      await pen.stroke(zero(gx + 95, gy, 140));
      // a red pen for the circles
      const red = await rectOf('button[data-color="#c62828"]');
      await mouse.click(...Object.values(centre(red)));
      for (let i = 0; i < 5; i += 1) await pen.stroke(circle(stage.x + stage.w * 0.22 + i * 105, gy + 260, 40));
      await sleep(200);
      const drawn = await strokeCount();
      check('"60" and five circles are seven strokes', drawn === 7, `${drawn}`);
      await shot(`stage-${VIEW}-3-drawn`);

      // erase one circle with the pen's eraser end (buttons 32), and undo it
      // (CDP cannot press a pen's eraser button, so the eraser tool is chosen)
      await mouse.click(...Object.values(centre(await rectOf('button[aria-label="Eraser"]'))));
      await pen.stroke(along((t) => [stage.x + stage.w * 0.22 + 2 * 105 - 44 + t * 88, gy + 260], 20));
      await mouse.click(...Object.values(centre(await rectOf('button[aria-label="Pen"]'))));
      await sleep(100);
      check('the eraser erases a whole stroke', (await strokeCount()) === 6, `${await strokeCount()}`);
      await mouse.click(...Object.values(centre(await rectOf('button[aria-label="Undo"]'))));
      await sleep(100);
      check('undo puts the erased stroke back', (await strokeCount()) === 7, `${await strokeCount()}`);
      await shot(`stage-${VIEW}-4-erase-undo`);

      // --- send with words
      const words = await rectOf('.ink-stage .ink-bar__words');
      await mouse.click(...Object.values(centre(words)));
      await send('Input.insertText', { text: 'is this right?' });
      const sendBtn = await rectOf('.ink-stage .ink-btn--send');
      await mouse.click(...Object.values(centre(sendBtn)));
      console.log('sent; waiting for the brain');
      const t0 = Date.now();
      let script = '';
      for (let i = 0; i < WAIT; i += 1) {
        await sleep(1000);
        const state = await evaluate(`JSON.stringify({clock: window.__stage.state().clock, lines: window.__stage.lines().length})`);
        const s = JSON.parse(state);
        if (i % 10 === 0) console.log(`  ${i}s ${state}`);
        if (s.lines > 3 && (s.clock === 'idle' || s.clock === 'paused')) {
          script = await evaluate(`window.__stage.script()`);
          break;
        }
      }
      console.log(`answer after ${Math.round((Date.now() - t0) / 1000)}s`);
      writeFileSync(join(OUT, `stage-${VIEW}-answer.txt`), script);
      console.log('--- the brain\'s answer (Series lines) ---\n' + script + '\n---');
      await sleep(1500);
      await shot(`stage-${VIEW}-5-answer`);
      console.log('latency', await evaluate(`JSON.stringify(window.__inkStats?.())`));
    }
  } else if (scenario === 'sheet') {
    await open('/bench-ink.html');
    const input = await send('DOM.getDocument');
    const found = await send('DOM.querySelector', { nodeId: input.root.nodeId, selector: '#photo' });
    await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [SHEET] });
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      if (await evaluate(`!!window.__ink.sheet`)) break;
    }
    check('the worksheet opened over the photo', await evaluate(`!!window.__ink.sheet`));
    await sleep(800);
    const sheetRect = await rectOf('.ink');
    // the page is the photo's 1200x1600 scaled to the sheet's width
    const k = sheetRect.w / 1200;
    const at = (px, py) => ({ x: sheetRect.x + px * k, y: sheetRect.y + py * k });
    await evaluate('window.scrollTo(0, 0)');
    const view = await evaluate(`({ w: innerWidth, h: innerHeight })`);
    // scroll so the top of the sheet (question 1) is in view
    const boxTop = at(395, 100).y;
    if (boxTop > view.h - 150) await evaluate(`window.scrollTo(0, ${Math.round(boxTop - 200)})`);
    const r2 = await rectOf('.ink');
    const at2 = (px, py) => ({ x: r2.x + px * k, y: r2.y + py * k });
    await shot(`sheet-${VIEW}-1-open`);
    if (size.touch) {
      // before any pen is seen a finger draws; after the pen has been about it scrolls and draws nothing
      const f0 = at2(700, 760);
      await touch.stroke(along((t) => [f0.x + t * 120, f0.y + 20 * Math.sin(t * 6)], 20), { every: 8, id: 1, radius: 10 });
      await sleep(150);
      const first = JSON.parse(await evaluate(`JSON.stringify(window.__ink.sheet.ink.document().strokes.length)`));
      check('a finger draws when no pen has been seen', first === 1, `${first} stroke`);
      await mouse.click(...Object.values(centre(await rectOf('button[aria-label="Undo"]'))));
      await pen.hover(f0.x, f0.y);
      await sleep(700);
      const y0 = await evaluate('scrollY');
      await touch.stroke(along((t) => [f0.x, f0.y + 100 - t * 300], 20), { every: 10, id: 2, radius: 10 });
      await sleep(200);
      const y1 = await evaluate('scrollY');
      const after = await evaluate(`window.__ink.sheet.ink.document().strokes.length`);
      check('with a pen about, a finger scrolls the sheet and draws nothing', y1 > y0 + 100 && after === 0, `scrollY ${y0} -> ${y1}, strokes ${after}`);
      await evaluate('window.scrollTo(0, 0)');
      await sleep(100);
    }
    // write "11" in the answer box of question 1, with the pen
    const p = at2(430, 105);
    const one = (x, y) => along(through([[x - k * 12, y + k * 14], [x, y], [x + 1, y + k * 25], [x + 1, y + k * 50]]), 30);
    await pen.stroke(one(p.x + k * 10, p.y + k * 5)); // "1"
    await pen.stroke(one(p.x + k * 50, p.y + k * 5)); // "1"

    // scroll the working area into view (a pen cannot write below the screen), then write 61 - 50 in the scratch area
    const docTop = (await evaluate('scrollY')) + r2.y;
    await evaluate(`window.scrollTo(0, ${Math.round(docTop + 700 * k - 260)})`);
    await sleep(200);
    const r3 = await rectOf('.ink');
    const at3 = (px, py) => ({ x: r3.x + px * k, y: r3.y + py * k });
    const s = at3(680, 740);
    await pen.stroke(six(s.x, s.y, k * 70));
    await pen.stroke(along((t) => [s.x + k * 55 + k * 12 * t, s.y + k * 10 + k * 55 * t], 20));
    await pen.stroke(along((t) => [s.x + k * 100 + k * 45 * t, s.y + k * 40], 12));
    // a stroke that is outside every box
    await pen.stroke(along((t) => [at3(300, 600).x + k * 40 * t, at3(300, 600).y + k * 40 * t], 10));
    await sleep(300);
    const report = await evaluate(`JSON.stringify(window.__ink.sheet.ink.regionReport())`);
    const parsed = JSON.parse(report);
    console.log('regions', JSON.stringify(parsed.regions.map((r) => ({ id: r.id, strokes: r.strokes }))), 'outside', JSON.stringify(parsed.outside));
    const answer = parsed.regions.find((r) => r.id === 'q1-answer');
    const scratch = parsed.regions.find((r) => r.id === 'scratch');
    check('the answer box holds the two strokes of "11"', answer.strokes.length === 2, answer.strokes.join(','));
    check('the scratch area holds the working', scratch.strokes.length === 3, scratch.strokes.join(','));
    check('a stroke in no box is reported outside', parsed.outside.length === 1, parsed.outside.join(','));
    const landed = await evaluate(`JSON.stringify(window.__ink.region)`);
    console.log('as drawn', landed);
    await shot(`sheet-${VIEW}-2-written`);
    // send: Check my working
    const words = await rectOf('.ink-bar__words');
    await mouse.click(...Object.values(centre(words)));
    await send('Input.insertText', { text: 'is this right?' });
    await mouse.click(...Object.values(centre(await rectOf('.ink-btn--send'))));
    const t0 = Date.now();
    for (let i = 0; i < WAIT; i += 1) {
      await sleep(1000);
      if (await evaluate(`window.__ink.ended`)) break;
    }
    console.log(`answer after ${Math.round((Date.now() - t0) / 1000)}s`);
    const lines = await evaluate(`window.__ink.lines.join('\\n')`);
    writeFileSync(join(OUT, `sheet-${VIEW}-answer.txt`), lines);
    console.log('--- the brain\'s answer ---\n' + lines + '\n---');
    const marks = await evaluate(`JSON.stringify({ image: window.__ink.marks.image, crop: window.__ink.marks.crop, strokes: window.__ink.marks.strokes.length, regions: window.__ink.marks.regions.map(r => [r.id, r.strokes.length]), outside: window.__ink.marks.outside, on: window.__ink.marks.on, background: window.__ink.marks.background })`);
    console.log('marks sent', marks);
    await shot(`sheet-${VIEW}-3-sent`);
  }
} catch (cause) {
  console.error('ERROR', cause);
  failed = true;
}
cdp.close();
proc.kill();
process.exit(failed ? 1 : 0);
