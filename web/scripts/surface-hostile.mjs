// The hostile check: every fixture in web/src/surfaces/hostile.ts, in a real Chrome, against a server that records every request it is sent.
//   node web/scripts/surface-hostile.mjs <vite url, e.g. http://127.0.0.1:4881> [--chrome <path>] [--only <name>]
// Ports: the fixtures reach for 127.0.0.1:4889 (this script listens there); Chrome's debugger takes a port in 4880-4889's neighbour range chosen at random above 9000.
// Exit status 0 only when every fixture is contained. Each fixture runs twice where it means something to: with the boot script's own removals (as shipped)
// and without them (`policy only`), so the policy and the sandbox are seen to hold by themselves.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args[0] ?? 'http://127.0.0.1:4881';
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const chromePath = flag('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const only = flag('--only');
// --shelf: every fixture runs in an app that asked for the whole library shelf, so the libraries are in the page beside it
const shelf = args.includes('--shelf');
const USES = JSON.stringify(['physics', 'sound', 'maths', 'charts', 'graphs']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hits = [];
const evil = http.createServer((req, res) => { hits.push(req.url ?? ''); res.setHeader('content-type', 'text/html'); res.end('<script>parent.postMessage("pwned","*")</script>'); });
evil.on('upgrade', (req, socket) => { hits.push(req.url ?? ''); socket.destroy(); });
await new Promise((r) => evil.listen(4889, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'surface-hostile-'));
const port = 9100 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ['--headless=new', '--mute-audio', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=900,700', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
}
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed'); return r.result.result.value; };
await send('Page.enable');
await send('Runtime.enable');

let failures = 0;
const rows = [];
async function check(name, depth) {
  hits.length = 0;
  await send('Page.navigate', { url: `${base}/bench-surface.html` });
  await sleep(1200);
  const fixture = (await evaluate('window.__surfaceBench.fixtures')).find((f) => f.name === name);
  const settle = name === 'busy-loop' ? 6500 : 2600;
  const result = JSON.parse(await evaluate(`window.__surfaceBench.run(${JSON.stringify(name)}, ${depth}, ${settle}, undefined, ${shelf ? USES : 'undefined'}).then(function(r){return JSON.stringify(r)})`));
  const must = JSON.parse(await evaluate(`JSON.stringify(window.__surfaceBench.must(${JSON.stringify(name)}))`).catch(() => 'null') ?? 'null');
  const mine = hits.filter((url) => url.startsWith(`/${name}`));
  const said = result.events.filter((e) => e.name === 'result').map((e) => String(e.value));
  const problems = [];
  if (mine.length > 0) problems.push(`the server was asked: ${mine.join(' ')}`);
  if (hits.length > mine.length) problems.push(`the server was asked for something else: ${hits.filter((u) => !u.startsWith(`/${name}`)).join(' ')}`);
  if (result.probe === null && !result.probe?.held) problems.push('the surface is gone without a reason');
  if (result.frames > 1) problems.push(`${result.frames} frames in the page`);
  if (!result.href.includes('bench-surface.html')) problems.push(`the page was navigated: ${result.href}`);
  if (result.probe?.sandbox !== null && result.probe?.sandbox !== 'allow-scripts') problems.push(`the sandbox is "${result.probe.sandbox}"`);
  if (said.some((v) => v.startsWith('RAN:')) && must?.denied) problems.push(`it got through: ${said.join(' ')}`);
  if (must?.ended && result.probe?.held !== must.ended) problems.push(`not ended as ${must.ended}: held is ${result.probe?.held}`);
  if (must?.events !== undefined && result.events.length > must.events) problems.push(`${result.events.length} events reached the stage, at most ${must.events}`);
  if (must?.pictures !== undefined && (result.pictureAsks ?? 0) > must.pictures) problems.push(`${result.pictureAsks} picture asks reached the host, at most ${must.pictures}`);
  if (must?.refused !== undefined && (result.probe?.refused ?? 0) < must.refused) problems.push(`only ${result.probe?.refused ?? 0} messages refused, at least ${must.refused}`);
  const ok = problems.length === 0;
  if (!ok) failures += 1;
  rows.push({ name: `${name}${depth ? '' : ' (policy only)'}`, ok, said: said.join(' ') || '(nothing)', server: mine.length, held: result.probe?.held ?? '-', refused: result.probe?.refused ?? 0, problems });
}

const fixtures = await (async () => { await send('Page.navigate', { url: `${base}/bench-surface.html` }); await sleep(1500); return evaluate('window.__surfaceBench.fixtures'); })();
for (const fixture of fixtures) {
  if (only !== undefined && fixture.name !== only) continue;
  for (const depth of fixture.policyOnly ? [true, false] : [true]) {
    try {
      await check(fixture.name, depth);
    } catch (error) {
      failures += 1;
      rows.push({ name: `${fixture.name}${depth ? '' : ' (policy only)'}`, ok: false, said: '(the check itself failed)', server: hits.filter((u) => u.startsWith(`/${fixture.name}`)).length, held: '-', refused: 0, problems: [String(error?.message ?? error)] });
    }
  }
}
for (const row of rows) console.log(`${row.ok ? 'CONTAINED' : 'BROKE OUT'}  ${row.name.padEnd(34)} server asked ${row.server}x  held ${String(row.held).padEnd(9)} refused ${String(row.refused).padEnd(4)} saw: ${row.said.slice(0, 70)}${row.problems.length ? '\n    ' + row.problems.join('\n    ') : ''}`);
console.log(`\n${rows.length - failures} of ${rows.length} contained`);
chrome.kill();
evil.close();
process.exit(failures === 0 ? 0 : 1);
