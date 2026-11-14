// The chat shell's browser check: drives headless Chrome over DevTools against a running server's /chat (real brain), at a phone or a desk size.
//   node web/scripts/shell-check.mjs <base-url> <phone|desk> <out-dir> <photo.jpg> <devtools-port>      (SCHEME=light|dark forces the system's colour scheme)
// Three messages (one with a photo), the canvas opened from a reply, a reload, a switch between conversations; a picture at every step, and at every step
// the computed contrast of every text in the shell (4.5 floor). Nothing here is part of the server.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [, , base, screen, outDir, photo, cdpPort] = process.argv;
const CDP = Number(cdpPort);
const phone = screen === 'phone';
const W = phone ? 390 : 1920;
const H = phone ? 844 : 825;
mkdirSync(`${outDir}/profile-${screen}`, { recursive: true });
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run', '--no-sandbox', '--no-default-browser-check', `--user-data-dir=${outDir}/profile-${screen}`, `--window-size=${W},${H}`, 'about:blank'],
  { stdio: 'ignore' },
);
process.on('exit', () => chrome.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {}
  await sleep(200);
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
const logs = [];
const failed = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) {
    waiting.get(d.id)(d);
    waiting.delete(d.id);
  } else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(`${d.params.type}: ` + d.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (d.method === 'Runtime.exceptionThrown') logs.push('exception: ' + JSON.stringify(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
  else if (d.method === 'Network.responseReceived' && d.params.response.status >= 400) failed.push(`${d.params.response.status} ${d.params.response.url}`);
};
const send = (method, params = {}) => new Promise((r) => { id += 1; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
  return r.result.result.value;
};
let shotN = 0;
const shot = async (name) => {
  shotN += 1;
  const file = `${outDir}/${screen}-${String(shotN).padStart(2, '0')}-${name}.png`;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log('shot', file);
};
const point = (selector) => ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const click = async (selector) => {
  const p = await point(selector);
  if (p === null) throw new Error('no ' + selector);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: 'left', clickCount: 1 });
};
const key = async (k, code = k) => {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 }[k] ?? 0, ...(k === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
};
const type = async (text) => {
  await ev(`document.querySelector('.pill__field').focus()`);
  await send('Input.insertText', { text });
};

// every text in the shell must read 4.5:1 on what is behind it (computed styles); the stage is the stage's own
const CONTRAST = `(() => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const mix = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const backOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (const l of layers.reverse()) base = mix(l, base); return base; };
  const worst = []; let count = 0;
  const walker = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode; const text = node.textContent.trim(); if (!text) continue;
    const el = node.parentElement; if (!el) continue;
    if (el.closest('[data-theme-root], .vh, .visually-hidden, script, style, svg')) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || r.width < 1 || r.height < 1) continue;
    let hidden = false; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || e.hidden) { hidden = true; break; } } if (hidden) continue;
    if (el.closest('button:disabled, [disabled]')) continue;
    const fg = parse(cs.color); if (!fg) continue; const bg = backOf(el); const f = mix(fg, bg);
    const [a, b] = [lum(f), lum(bg)]; const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); count += 1;
    if (ratio < 4.5) worst.push({ text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, cls: el.className });
  }
  return { checked: count, below: worst.slice(0, 8), scheme: document.documentElement.dataset.theme };
})()`;
const contrast = async (label) => {
  const r = await ev(CONTRAST);
  console.log(`contrast[${label}] checked=${r.checked} scheme=${r.scheme} below4.5=${r.below.length}`, r.below.length ? JSON.stringify(r.below) : '');
  return r;
};
const waitRest = async (what, ms = 240000) => {
  const t0 = Date.now();
  for (;;) {
    await sleep(500);
    const s = await ev(`(() => { const last = [...document.querySelectorAll('.msg--reply')].pop(); const st = window.__stage.state(); return { turnOpen: st.turn !== null, thinking: !!(last && last.querySelector('.reply__thinking')), stop: document.querySelector('.pill__send').getAttribute('aria-label') }; })()`);
    if (!s.turnOpen && !s.thinking && s.stop === 'Send') break;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what + ' ' + JSON.stringify(s));
  }
  await sleep(1500); // the still is kept a beat after rest
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
if (phone) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
if (process.env.SCHEME) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: process.env.SCHEME }] });
await send('Page.navigate', { url: `${base}/chat` });
await sleep(1500);
await ev('window.__stage.ready');
await sleep(500);
const results = {};

// 1. empty
await shot('empty');
results.emptyContrast = await contrast('empty');
results.pillHeight = await ev(`document.querySelector('.pill').getBoundingClientRect().height`);
results.composerRowsAboveAndBelow = await ev(`(() => { const c = document.querySelector('.composer').getBoundingClientRect(); return { composerH: c.height, statusHidden: document.querySelector('.composer__status').hidden }; })()`);

// 2. message one
await type('draw a lighthouse at dusk');
await shot('typed');
await key('Enter');
await sleep(800);
await shot('sending');
await waitRest('message 1');
await shot('reply-1');
results.afterOne = await ev(`({ state: window.__shell.state(), cards: document.querySelectorAll('.card').length, replies: document.querySelectorAll('.msg--reply').length, replyText: document.querySelector('.msg--reply .reply')?.innerText.slice(0, 160), scheme: window.__shell.scheme(), canvas: document.getElementById('shell').dataset.canvas })`);
console.log(JSON.stringify(results.afterOne));
await contrast('after-1');

// 3. message two, with a photo
await send('DOM.enable');
const doc = await send('DOM.getDocument', { depth: 1 });
const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[data-photos="pick"]' });
await send('DOM.setFileInputFiles', { files: [photo], nodeId: node.result.nodeId });
await sleep(2500);
await shot('photo-in-tray');
results.trayAbovePill = await ev(`(() => { const t = document.querySelector('.prompt__photos'); const p = document.querySelector('.pill'); return t && !t.hidden ? t.getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 1 : false; })()`);
await type('what do you see in this photo? answer in one short sentence');
await key('Enter');
await sleep(1500);
await shot('sending-photo');
await waitRest('message 2');
await shot('reply-2');

// 4. message three
await type('in one short sentence, what is a lighthouse for?');
await key('Enter');
await waitRest('message 3');
await shot('reply-3');
results.afterThree = await ev(`({ users: document.querySelectorAll('.msg--user').length, replies: document.querySelectorAll('.msg--reply').length, photos: document.querySelectorAll('.bubble__photos img').length, photoLoaded: [...document.querySelectorAll('.bubble__photos img')].map((i) => i.naturalWidth), cards: document.querySelectorAll('.card').length, openButtons: document.querySelectorAll('.reply__tools [data-focus=open]').length, thumbs: [...document.querySelectorAll('.card__thumb')].map((i) => i.naturalWidth) })`);
console.log(JSON.stringify(results.afterThree));
await contrast('after-3');
if (phone) {
  await ev(`document.querySelector('.shell-scroll').scrollTop = 0`);
  await sleep(300);
  await shot('thread-top');
}

// 5. open the canvas from the first reply (the keyboard way: focus the card and press Enter)
await ev(`document.querySelector('.msg--reply [data-focus=card], .msg--reply [data-focus=open]').scrollIntoView({ block: 'center' })`);
await ev(`document.querySelector('.msg--reply [data-focus=card], .msg--reply [data-focus=open]').focus()`);
await key('Enter');
await sleep(2500);
await shot('canvas-from-reply-1');
results.canvas1 = await ev(`({ state: window.__shell.state(), insets: window.__shell.insets(), scheme: window.__shell.scheme(), title: document.querySelector('.shell-canvas__title').textContent, focus: document.activeElement.className, where: document.querySelector('.shell-canvas__where').textContent, stage: (() => { const r = document.querySelector('.stage').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(), inertMain: document.getElementById('shell-main').hasAttribute('inert') })`);
console.log(JSON.stringify(results.canvas1));
await contrast('canvas-open');
// next reply's canvas
await click('[data-next]');
await sleep(2500);
await shot('canvas-next-reply');
results.canvas2 = await ev(`({ state: window.__shell.state(), title: document.querySelector('.shell-canvas__title').textContent, where: document.querySelector('.shell-canvas__where').textContent })`);
console.log(JSON.stringify(results.canvas2));
// words panel and save menu
await click('.transcript__toggle');
await sleep(500);
await shot('canvas-words');
results.words = await ev(`document.querySelector('.transcript__body').innerText.slice(0, 200)`);
await contrast('canvas-words');
await click('.transcript__toggle');
// Escape closes the canvas and returns focus
await ev(`document.querySelector('.shell-canvas__title').focus()`);
await key('Escape');
await sleep(600);
results.afterClose = await ev(`({ canvas: document.getElementById('shell').dataset.canvas, focus: document.activeElement.className + ' | ' + (document.activeElement.textContent || '').slice(0, 30), scheme: window.__shell.scheme() })`);
console.log(JSON.stringify(results.afterClose));
await shot('canvas-closed');

// 6. the + menu
await click('.pill__plus');
await sleep(300);
await shot('plus-menu');
results.menu = await ev(`({ open: !document.querySelector('.menu').hidden, items: [...document.querySelectorAll('.menu__item')].filter((i) => !i.hidden).map((i) => i.textContent.trim()), focus: document.activeElement.textContent.trim() })`);
console.log(JSON.stringify(results.menu));
await contrast('plus-menu');
await key('Escape');

// 7. reload: the conversation is in the list
const convId = await ev(`window.__shell.state().liveId`);
results.convId = convId;
await send('Page.navigate', { url: `${base}/chat` });
await sleep(2000);
await ev('window.__stage.ready');
await sleep(800);
if (phone) {
  await click('.shell-bar__menu');
  await sleep(500);
}
await shot('reload-list');
results.afterReload = await ev(`({ items: [...document.querySelectorAll('.conv')].map((c) => c.innerText.replace(/\\n/g, ' | ')), state: window.__shell.state() })`);
console.log(JSON.stringify(results.afterReload));
await contrast('list');
// open it from the list
await click('.conv:nth-child(1) ~ *, li:nth-child(2) .conv');
await sleep(1500);
await shot('past-conversation');
results.past = await ev(`({ title: document.querySelector('.shell-bar__title').textContent, users: document.querySelectorAll('.msg--user').length, replies: document.querySelectorAll('.msg--reply').length, thumbs: [...document.querySelectorAll('.card__thumb')].map((i) => i.naturalWidth), photos: [...document.querySelectorAll('.bubble__photos img')].map((i) => i.naturalWidth), note: document.querySelector('.thread__note')?.textContent, url: location.search })`);
console.log(JSON.stringify(results.past));
await contrast('past');
// canvas from a past reply (replayed from the log)
await ev(`document.querySelector('.msg--reply [data-focus=card], .msg--reply [data-focus=open]').scrollIntoView({ block: 'center' })`);
await click('.msg--reply [data-focus=card], .msg--reply [data-focus=open]');
await sleep(3000);
await shot('past-canvas');
results.pastCanvas = await ev(`({ state: window.__shell.state(), stageElements: window.__stage.elements().length, canvas: document.getElementById('shell').dataset.canvas })`);
console.log(JSON.stringify(results.pastCanvas));
await click('[data-replay]');
await sleep(1500);
await shot('past-canvas-replaying');
await click('[data-close]');
await sleep(500);

// 8. a new message from a past conversation starts a new one; switch back and forth
if (phone && (await ev(`document.getElementById('shell').dataset.drawer`)) === 'open') await click('.shell-bar__menu');
await type('say hi in two words');
await key('Enter');
await waitRest('message 4');
await shot('new-conversation-reply');
results.afterNew = await ev(`({ state: window.__shell.state(), title: document.querySelector('.shell-bar__title').textContent, users: document.querySelectorAll('.msg--user').length })`);
console.log(JSON.stringify(results.afterNew));
await sleep(1200);
if (phone) {
  await click('.shell-bar__menu');
  await sleep(500);
}
await shot('list-two');
results.list2 = await ev(`[...document.querySelectorAll('.conv')].map((c) => c.innerText.replace(/\\n/g, ' | '))`);
console.log(JSON.stringify(results.list2));
await click('li:nth-child(2) .conv');
await sleep(1500);
await shot('switched-to-first');
results.switched = await ev(`({ title: document.querySelector('.shell-bar__title').textContent, users: document.querySelectorAll('.msg--user').length, active: window.__shell.state().active })`);
console.log(JSON.stringify(results.switched));
if (phone && (await ev(`document.getElementById('shell').dataset.drawer`)) === 'open') await click('.shell-bar__menu');
// light/dark: the canvas drives the one bit
await ev(`window.__stage.ready`);
results.console = logs.slice(-10);
results.failedRequests = failed.slice(-10);
console.log(JSON.stringify({ console: results.console, failed: results.failedRequests }));
writeFileSync(`${outDir}/${screen}-results.json`, JSON.stringify(results, null, 2));
chrome.kill();
process.exit(0);
