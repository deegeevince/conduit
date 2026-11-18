// pnpm wall-check: the wall in the main view, proved in a real browser against a running server with a real brain.
//
//   pnpm wall-check --url http://127.0.0.1:4997 [--out <dir>] [--screens 390x844,1280x720] [--throttle 4] [--only converse,off,reduced]
//
// The server is started by the caller (BRAIN=claude-cli, DATA_DIR in a scratch folder). This tool opens `/?wall=1&demo=none` in headless Chrome at
// each screen, slows the CPU, and drives it with real touch, wheel, key and mouse events over DevTools:
//   converse   six turns (two subjects, taps on stage choices, in-place follow-ups), then: frames and lanes, the follow-ups made no frame and no flight,
//              a tap on turn 2 in the transcript, a pinch-pan-pinch to frame 3 marking turn 3, the map with titles, Previous and Next, ten idle seconds
//   reduced    reduced motion emulated (the system's setting), and the shell's own "Motion: fade": no frame of travel
//   off        `/` without `?wall=1`: no wall layer, no hook, touch-action as before
// The numbers come from the page's per-frame trace of the lens (`window.__wall.traceStart/traceStop`).

import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnTracked } from '../brains/claude-cli/process';
import { Cdp, CHROME_CANDIDATES, sleep, stop, waitFor } from './explore-browser';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? (args[at + 1] as string) : fallback;
};

interface Config {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
}

interface Info {
  tiles: { node: string; index: number; lane: number; slot: number; title: string }[];
  lanes: number;
  digest: string;
  turns: { turn: string; kind: string; said: string; frame: string | null; lines: number }[];
  focus: number | null;
  live: string | null;
  layer: string;
  kind: string;
  lens: { x: number; y: number; scale: number } | null;
  map: { x: number; y: number; scale: number } | null;
  following: boolean;
  chip: string | null;
  marked: string | null;
  stageTurn: string | null;
  busy: boolean;
  screen: { width: number; height: number };
  motion: string;
  touchAction: string;
  drawn: number;
}

interface Trace {
  marks: number[][];
  drawn: number;
  kinds: string[];
  layers: string[];
}

class Tab {
  private constructor(
    readonly browser: Cdp,
    readonly sessionId: string,
  ) {}

  static async open(browser: Cdp): Promise<Tab> {
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(browser, sessionId);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    return tab;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async eval<T>(expression: string): Promise<T> {
    const out = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result.value as T;
  }

  info(): Promise<Info> {
    return this.eval<Info>('window.__wall.info()');
  }

  call<T>(fn: string, ...a: unknown[]): Promise<T> {
    return this.eval<T>(`window.__wall.${fn}(${a.map((x) => JSON.stringify(x)).join(',')})`);
  }

  async touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]): Promise<void> {
    await this.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 4, radiusY: 4, force: 0.5 })) });
  }

  async tap(x: number, y: number, hold = 60): Promise<void> {
    await this.touch('touchStart', [{ x, y, id: 1 }]);
    await sleep(hold);
    await this.touch('touchEnd', []);
  }

  /** two fingers about (cx, cy): their distance goes d0 to d1 and the middle by (dx, dy) over ms */
  async twoFingers(cx: number, cy: number, d0: number, d1: number, dx: number, dy: number, ms: number): Promise<void> {
    const at = (k: number): { x: number; y: number; id: number }[] => {
      const d = d0 + (d1 - d0) * k;
      return [
        { x: cx + dx * k - d / 2, y: cy + dy * k, id: 1 },
        { x: cx + dx * k + d / 2, y: cy + dy * k, id: 2 },
      ];
    };
    const first = at(0);
    await this.touch('touchStart', [first[0] as { x: number; y: number; id: number }]);
    await this.touch('touchStart', first);
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i += 1) {
      await sleep(ms / steps);
      await this.touch('touchMove', at(i / steps));
    }
    await this.touch('touchEnd', at(1).slice(1));
    await this.touch('touchEnd', []);
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number, ctrl = false): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: ctrl ? 2 : 0 });
  }

  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async key(key: string, code: string, vk: number): Promise<void> {
    const text = key.length === 1 ? key : undefined;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(text === undefined ? {} : { text }) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  }

  async shot(path: string): Promise<void> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(data, 'base64'));
  }
}

const f2 = (v: number): string => v.toFixed(2);
const say = (text: string): void => void process.stdout.write(`${text}\n`);

interface Gate {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const PROMPTS = {
  one: 'Explain how a four-stroke engine works with a labelled diagram. One scene only. End with two tappable choices worded as a new drawing each: "Draw the diesel cycle afresh" and "Draw the two-stroke afresh".',
  three: 'Something different: how do ocean tides work? One scene, a drawing of the moon and the earth. End with two tappable choices worded as a new drawing each: "Draw spring tides afresh" and "Draw neap tides afresh".',
  five: 'Make the moon larger.',
  six: 'Add one short caption saying why tides matter.',
} as const;

async function waitQuiet(tab: Tab, headings: number, limitMs = 360_000): Promise<void> {
  const until = Date.now() + limitMs;
  let quietSince = 0;
  for (;;) {
    const state = await tab.eval<{ n: number; open: boolean }>(`(() => { const s = window.__stage.state(); return { n: document.querySelectorAll('.transcript__turn[data-turn]').length, open: s.turn !== null }; })()`);
    if (state.n >= headings && !state.open) {
      if (quietSince === 0) quietSince = Date.now();
      if (Date.now() - quietSince > 2500) return;
    } else quietSince = 0;
    if (Date.now() > until) throw new Error(`the turn did not finish in ${limitMs / 1000}s (headings ${state.n}/${headings}, open ${String(state.open)})`);
    await sleep(500);
  }
}

async function send(tab: Tab, text: string): Promise<void> {
  await tab.eval(`(() => { const t = document.querySelector('.prompt__input'); t.focus(); t.value = ''; })()`);
  await tab.send('Input.insertText', { text });
  await sleep(100);
  await tab.key('Enter', 'Enter', 13);
}

async function openTranscript(tab: Tab): Promise<void> {
  const shown = await tab.eval<boolean>(`!document.querySelector('.transcript__panel').hidden`);
  if (shown) return;
  await tab.eval(`document.querySelector('.composer__plus').click()`);
  await sleep(250);
  await tab.eval(`[...document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"]')].find((b) => /Transcript/.test(b.textContent)).click()`);
  await sleep(250);
}

async function closeTranscript(tab: Tab): Promise<void> {
  const shown = await tab.eval<boolean>(`!document.querySelector('.transcript__panel').hidden`);
  if (!shown) return;
  await tab.eval(`document.querySelector('.composer__plus').click()`);
  await sleep(250);
  await tab.eval(`[...document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"]')].find((b) => /Transcript/.test(b.textContent)).click()`);
  await sleep(250);
}

async function waitRest(tab: Tab, limit = 5000): Promise<void> {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    const lens = await tab.call<{ kind: string }>('lens');
    if (lens.kind === 'rest') return;
    await sleep(40);
  }
}

/** how a trace of a glide went: the farthest the lens got along the line from where it began to where it ended, as a share of that line (1.0 is no overshoot) */
function overshoot(marks: number[][]): { share: number; points: number; seconds: number; maxZoomRate: number } {
  const moving = marks.filter((m, i) => i === 0 || m[1] !== marks[i - 1]?.[1] || m[2] !== marks[i - 1]?.[2] || m[3] !== marks[i - 1]?.[3]);
  const first = moving[0];
  const last = moving[moving.length - 1];
  if (first === undefined || last === undefined || moving.length < 2) return { share: 0, points: moving.length, seconds: 0, maxZoomRate: 0 };
  const dx = (last[1] ?? 0) - (first[1] ?? 0);
  const dy = (last[2] ?? 0) - (first[2] ?? 0);
  const len2 = dx * dx + dy * dy;
  let share = 0;
  let maxZoomRate = 0;
  for (let i = 0; i < moving.length; i += 1) {
    const m = moving[i];
    if (m === undefined) continue;
    if (len2 > 1e-9) share = Math.max(share, (((m[1] ?? 0) - (first[1] ?? 0)) * dx + ((m[2] ?? 0) - (first[2] ?? 0)) * dy) / len2);
    const p = moving[i - 1];
    if (p !== undefined && (m[0] ?? 0) > (p[0] ?? 0)) maxZoomRate = Math.max(maxZoomRate, Math.abs(Math.log((m[3] ?? 1) / (p[3] ?? 1))) / (((m[0] ?? 0) - (p[0] ?? 0)) / 1000));
  }
  return { share, points: moving.length, seconds: ((last[0] ?? 0) - (first[0] ?? 0)) / 1000, maxZoomRate };
}

const distinctLenses = (marks: number[][]): number => new Set(marks.map((m) => `${m[1]}|${m[2]}|${m[3]}`)).size;

async function main(): Promise<void> {
  const base = flag('url', 'http://127.0.0.1:4997');
  const out = resolve(flag('out', join(tmpdir(), 'wall-check-out')));
  await mkdir(out, { recursive: true });
  const rate = Number(flag('throttle', '4'));
  const only = new Set(flag('only', 'converse,reduced,off').split(','));
  const configs: Config[] = flag('screens', '390x844,1280x720')
    .split(',')
    .map((s) => {
      const [w, h] = s.split('x').map(Number);
      return { name: s, width: w ?? 390, height: h ?? 844, phone: (w ?? 0) < 700 };
    });
  const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (chrome === undefined) throw new Error('no Chrome found: set CHROME_BIN');
  const profile = await mkdtemp(join(tmpdir(), 'conduit-wall-check-'));
  const child: ChildProcess = spawnTracked(chrome, ['--headless=new', '--mute-audio', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], undefined, { quiet: true });
  const results: Record<string, unknown> = { rate, when: new Date().toISOString(), base };
  const gates: Gate[] = [];
  const gate = (config: Config, name: string, ok: boolean, detail: string): void => {
    gates.push({ name: `${config.name} ${name}`, ok, detail });
    say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };
  try {
    const endpoint = await waitFor('Chrome', 20_000, async () => {
      const [p, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      return p !== undefined && path !== undefined ? `ws://127.0.0.1:${p}${path}` : null;
    });
    const browser = await Cdp.open(endpoint);
    say((await browser.send<{ product: string }>('Browser.getVersion')).product);

    const openPage = async (config: Config, query: string, wait: 'wall' | 'stage'): Promise<Tab> => {
      const tab = await Tab.open(browser);
      await tab.send('Emulation.setDeviceMetricsOverride', { width: config.width, height: config.height, deviceScaleFactor: 2, mobile: config.phone });
      await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await tab.send('Page.navigate', { url: `${base}/?${query}` });
      await waitFor('the stage', 60_000, async () => ((await tab.eval<boolean>('Boolean(window.__stage)').catch(() => false)) ? true : null));
      await tab.eval('window.__stage.ready.then(() => true)');
      if (wait === 'wall') await waitFor('the wall', 30_000, async () => ((await tab.eval<boolean>('Boolean(window.__wall && window.__wall.ready)').catch(() => false)) ? true : null));
      await sleep(800);
      return tab;
    };

    for (const config of configs) {
      const dir = join(out, config.name);
      await mkdir(dir, { recursive: true });
      const res: Record<string, unknown> = {};
      results[config.name] = res;
      say(`\n=== ${config.name}`);

      if (only.has('converse')) {
        const tab = await openPage(config, 'wall=1&demo=none', 'wall');
        await tab.send('Emulation.setCPUThrottlingRate', { rate });
        await openTranscript(tab);
        const W = config.width;
        const H = config.height;
        const rect = async (): Promise<{ left: number; top: number; width: number; height: number }> => tab.call('hostRect');

        const turnNo = { n: 0 };
        const converse = async (what: string, text: string | null, tapText: string | null): Promise<void> => {
          turnNo.n += 1;
          const began = Date.now();
          if (tapText !== null) {
            const found = await tab.eval<{ x: number; y: number } | null>(`(() => { const e = window.__stage.elements().find((el) => el.tappable && (el.text + ' ' + el.id).toLowerCase().includes(${JSON.stringify(tapText.toLowerCase())})); if (!e) return null; const r = window.__wall.hostRect(); return { x: r.left + e.box.x + e.box.width / 2, y: r.top + e.box.y + e.box.height / 2 }; })()`);
            if (found === null) throw new Error(`no tappable choice "${tapText}" on stage for turn ${turnNo.n}`);
            await closeTranscript(tab);
            await tab.tap(found.x, found.y);
            await openTranscript(tab);
          } else await send(tab, text ?? '');
          await waitQuiet(tab, turnNo.n);
          const info = await tab.info();
          say(`  turn ${turnNo.n} (${what}): ${((Date.now() - began) / 1000).toFixed(0)}s; frames ${info.tiles.length}, lanes ${info.lanes}; lens ${info.kind}, layer ${info.layer}, focus ${String(info.focus)}`);
        };

        // ---- the conversation
        await converse('prompt, subject one', PROMPTS.one, null);
        await tab.shot(join(dir, '01-first-frame.png'));
        await converse('tap a choice', null, 'diesel');
        // a reached frame is left to settle, and its picture to arrive
        await converse('prompt, subject two', PROMPTS.three, null);
        await converse('tap a choice', null, 'spring');
        // the in-place follow-ups: the camera must not move, no frame must be made
        await tab.call('traceStart');
        const before = await tab.info();
        await converse('follow-up in place', PROMPTS.five, null);
        await converse('follow-up in place', PROMPTS.six, null);
        const quiet = await tab.call<Trace>('traceStop');
        const after = await tab.info();
        res['info'] = after;
        say(`  turns→frames: ${after.turns.map((t) => `${t.turn}:${t.kind}→${t.frame ?? '-'}`).join('  ')}`);
        say(`  tiles: ${after.tiles.map((t) => `#${t.index + 1}[lane ${t.lane + 1}, slot ${t.slot + 1}] "${t.title.slice(0, 40)}"`).join(' | ')}`);

        gate(config, 'frames and lanes', after.tiles.length === 4 && after.lanes === 2, `${after.tiles.length} frames in ${after.lanes} lanes`);
        gate(config, 'follow-ups make no frame', after.tiles.length === before.tiles.length, `${before.tiles.length} before the two follow-ups, ${after.tiles.length} after`);
        gate(config, 'follow-ups make no flight', quiet.kinds.every((k) => k === 'rest') && quiet.drawn === 0 && distinctLenses(quiet.marks) === 1, `lens kinds [${quiet.kinds.join(',')}], frames drawn ${quiet.drawn}, distinct lens values ${distinctLenses(quiet.marks)} over ${quiet.marks.length} frames`);
        gate(config, 'touch-action none on the room', after.touchAction === 'none', `"${after.touchAction}"`);
        gate(config, 'arrived on the last frame, live', after.focus === after.tiles.length - 1 && after.layer === 'away', `focus ${String(after.focus)}, layer ${after.layer}`);
        await tab.shot(join(dir, '02-arrived-last-frame.png'));

        // ---- the pictures: every frame has the server's snapshot
        const stills = await tab.eval<number>(`(async () => { let ok = 0; for (const t of window.__wall.info().turns) { const s = await fetch('/api/sessions/' + (window.__stage.state().session ?? '') + '/turns/' + t.turn + '/snapshot').then((r) => r.status).catch(() => 0); if (s === 200) ok += 1; } return ok; })()`).catch(() => -1);
        res['snapshotsServed'] = stills;

        // ---- the map
        await closeTranscript(tab);
        await tab.eval(`document.querySelector('.wall-nav button:last-of-type').click()`);
        await waitRest(tab);
        await sleep(900);
        const mapInfo = await tab.info();
        const labelTexts = await tab.eval<string[]>(`[...document.querySelectorAll('.wall-label')].filter((e) => e.style.display !== 'none').map((e) => e.textContent)`);
        gate(config, 'the map shows every frame with a title', mapInfo.layer === 'on' && labelTexts.length === after.tiles.length && labelTexts.every((t) => t.trim().length > 4), `${labelTexts.length} labels: ${labelTexts.map((t) => `"${t.slice(0, 28)}"`).join(', ')}`);
        await tab.shot(join(dir, '03-map.png'));
        const mapPoint = async (i: number) => tab.call<{ x: number; y: number; w: number; visible: boolean } | null>('tilePoint', i);

        // ---- a tap on a far frame goes there (real touch), mid-glide shot
        const target = 0;
        const p0 = await mapPoint(target);
        if (p0 === null) throw new Error('no tile 0');
        await tab.call('traceStart');
        await tab.tap(p0.x, p0.y);
        const sawGlide = await waitFor('a glide', 4000, async () => ((await tab.call<{ kind: string }>('lens')).kind === 'glide' ? true : null)).catch(() => null);
        await sleep(120);
        if (sawGlide) await tab.shot(join(dir, '04-mid-glide.png'));
        await waitRest(tab, 6000);
        await sleep(700);
        const tapTrace = await tab.call<Trace>('traceStop');
        const tapInfo = await tab.info();
        const o1 = overshoot(tapTrace.marks);
        gate(config, 'a tap on a far frame arrives on it', tapInfo.focus === target && tapInfo.layer === 'away', `focus ${String(tapInfo.focus)}, layer ${tapInfo.layer}, marked ${String(tapInfo.marked)}`);
        gate(config, 'the glide has no overshoot', o1.share <= 1.001 && o1.points > 3, `farthest ${f2(o1.share)} of the way, ${o1.points} distinct lens values, ${f2(o1.seconds)} s, fastest zoom ${f2(o1.maxZoomRate)}/s`);
        res['glideTap'] = o1;
        await tab.shot(join(dir, '05-arrived-frame-1.png'));

        // ---- the transcript: tap turn 2 -> its frame; the card marked
        await openTranscript(tab);
        const turn2 = after.turns[1];
        if (turn2 === undefined) throw new Error('no turn 2');
        const head2 = await tab.eval<{ x: number; y: number } | null>(`(() => { const h = document.querySelector('.transcript__turn[data-turn="${turn2.turn}"]'); if (!h) return null; h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); return { x: r.left + 24, y: r.top + r.height / 2 }; })()`);
        if (head2 === null) throw new Error('no heading for turn 2');
        await sleep(200);
        await tab.call('traceStart');
        await tab.tap(head2.x, head2.y);
        await waitFor('a move', 3000, async () => ((await tab.call<{ kind: string }>('lens')).kind !== 'rest' ? true : null)).catch(() => null);
        await waitRest(tab, 6000);
        await sleep(900);
        const t2Trace = await tab.call<Trace>('traceStop');
        const t2 = await tab.info();
        const frameOf2 = t2.tiles.findIndex((t) => t.node === turn2.frame);
        const heading = await tab.eval<{ here: string | null; current: string | null }>(`(() => { const h = document.querySelector('.transcript__turn--here'); return { here: h ? h.dataset.turn : null, current: h ? h.getAttribute('aria-current') : null }; })()`);
        gate(config, 'tapping turn 2 in the transcript lands on its frame', t2.focus === frameOf2 && frameOf2 >= 0 && t2.layer === 'away', `frame ${frameOf2 + 1} (turn 2 is frame ${turn2.frame ?? '-'}), focus ${String(t2.focus)}, lens ${t2.kind}`);
        gate(config, 'and marks that turn', heading.here === turn2.turn && heading.current === 'true', `marked ${String(heading.here)} (turn 2 is ${turn2.turn})`);
        res['glideTranscript'] = overshoot(t2Trace.marks);
        await tab.shot(join(dir, '06-transcript-turn-2.png'));

        // ---- pan to frame 3 with real fingers: pinch out, two-finger pan, pinch in
        const frame3 = 2;
        await closeTranscript(tab);
        await tab.call('traceStart');
        const cx = W / 2;
        const cy = (await rect()).top + (await rect()).height / 2;
        await tab.twoFingers(cx, cy, Math.min(W * 0.6, 220), Math.min(W * 0.16, 60), 0, 0, 500);
        await waitRest(tab, 4000);
        await sleep(200);
        const p3 = await mapPoint(frame3);
        if (p3 === null) throw new Error('no tile 3');
        const sideways = cx - p3.x;
        const down = cy - p3.y;
        // a drag too long for the screen is made in steps
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(sideways) / (W * 0.3), Math.abs(down) / (H * 0.25))));
        for (let i = 0; i < steps; i += 1) {
          await tab.twoFingers(cx, cy, Math.min(W * 0.16, 60), Math.min(W * 0.16, 60), sideways / steps, down / steps, 350);
          await waitRest(tab, 4000);
        }
        await sleep(200);
        await tab.twoFingers(cx, cy, Math.min(W * 0.16, 60), Math.min(W * 0.7, 300), 0, 0, 500);
        await waitFor('the lens to settle', 8000, async () => ((await tab.call<{ kind: string }>('lens')).kind === 'rest' ? true : null));
        await sleep(900);
        const panTrace = await tab.call<Trace>('traceStop');
        const pan = await tab.info();
        const turn3 = after.turns[2];
        gate(config, 'panning to frame 3 settles on it', pan.focus === frame3 && pan.layer === 'away', `focus ${String(pan.focus)} (frame ${(pan.focus ?? -1) + 1}), layer ${pan.layer}`);
        gate(config, 'and marks turn 3', turn3 !== undefined && pan.marked === turn3.turn, `marked ${String(pan.marked)} (turn 3 is ${turn3?.turn ?? '?'})`);
        res['pan'] = { kinds: panTrace.kinds, drawn: panTrace.drawn };
        await openTranscript(tab);
        await sleep(300);
        await tab.shot(join(dir, '07-pan-frame-3-marked.png'));
        await closeTranscript(tab);

        // ---- previous and next: a glide between frames, no overshoot
        await tab.call('traceStart');
        await tab.eval(`document.querySelector('.wall-nav button[aria-label="Previous reply"]').click()`);
        await waitFor('a move', 3000, async () => ((await tab.call<{ kind: string }>('lens')).kind !== 'rest' ? true : null)).catch(() => null);
        await waitRest(tab, 6000);
        await sleep(600);
        const prevTrace = await tab.call<Trace>('traceStop');
        const prev = await tab.info();
        const o2 = overshoot(prevTrace.marks);
        gate(config, 'Previous flies to the previous reply\'s frame', prev.focus !== null && prev.focus < pan.focus!, `focus ${String(prev.focus)}, marked ${String(prev.marked)}, nav "${await tab.call<string>('navText')}"`);
        gate(config, 'Previous glides with no overshoot', o2.share <= 1.001, `farthest ${f2(o2.share)}, ${f2(o2.seconds)} s`);
        res['glidePrevious'] = o2;
        // keys: Escape for the map and back
        await tab.key('Escape', 'Escape', 27);
        await waitRest(tab, 4000);
        const escMap = await tab.eval<boolean>('window.__wall.info().layer === "on"');
        await tab.key('0', 'Digit0', 48);
        await waitRest(tab, 4000);
        await sleep(500);
        const back = await tab.info();
        gate(config, 'Escape gives the map and 0 brings it back', escMap && back.layer === 'away', `map shown ${String(escMap)}, back at focus ${String(back.focus)}, layer ${back.layer}`);

        // ---- wheel: ctrl+wheel zooms out, wheel pans
        await tab.wheel(W / 2, cy, 0, 300, true);
        await sleep(600);
        const zoomed = await tab.call<{ scale: number }>('lens');
        await waitRest(tab, 3000);
        gate(config, 'ctrl+wheel zooms the lens out', zoomed.scale < 0.9, `scale ${zoomed.scale.toFixed(3)}`);
        await tab.key('Escape', 'Escape', 27);
        await waitRest(tab, 4000);
        await tab.key('Escape', 'Escape', 27);
        await waitRest(tab, 4000);

        // ---- ten idle seconds: the lens is constant, nothing is drawn
        await sleep(1500);
        await tab.call('traceStart');
        await sleep(10_000);
        const idle = await tab.call<Trace>('traceStop');
        gate(config, 'idle for 10 s the lens is still', distinctLenses(idle.marks) === 1 && idle.drawn === 0, `${idle.marks.length} frames, ${distinctLenses(idle.marks)} distinct lens value(s), ${idle.drawn} wall frames drawn`);
        res['idle'] = { frames: idle.marks.length, distinct: distinctLenses(idle.marks), drawn: idle.drawn };

        // ---- the chip: move the lens while an answer is being made
        await tab.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        turnNo.n += 1;
        await send(tab, 'Now a quick one: how does a rainbow form? One scene.');
        // the person moves the lens after sending, before the first line: following ends, the stream will not move the camera
        await waitFor('the turn to open', 60_000, async () => ((await tab.eval<number>(`document.querySelectorAll('.transcript__turn[data-turn]').length`)) >= turnNo.n ? true : null));
        await tab.eval(`window.__wall.map()`);
        await waitFor('the answer to arrive', 240_000, async () => {
          const i = await tab.info();
          return i.tiles.length > after.tiles.length ? i : null;
        });
        const chipInfo = await tab.info();
        gate(config, 'moved away: a new frame shows the chip, the camera stays', chipInfo.chip !== null && chipInfo.following === false && chipInfo.layer === 'on', `chip "${String(chipInfo.chip)}", following ${String(chipInfo.following)}, lens ${chipInfo.kind}`);
        await tab.shot(join(dir, '08-answer-arriving-chip.png'));
        await tab.eval(`document.querySelector('.wall-chip').click()`);
        await waitFor('the lens to land', 8000, async () => ((await tab.call<{ kind: string }>('lens')).kind === 'rest' ? true : null));
        await sleep(500);
        await waitQuiet(tab, turnNo.n);
        const went = await tab.info();
        gate(config, 'Go flies to the new frame', went.focus === went.tiles.length - 1, `focus ${String(went.focus)} of ${went.tiles.length}`);
        await tab.send('Page.close').catch(() => undefined);
      }

      if (only.has('reduced')) {
        say('  -- reduced motion');
        const tab = await openPage(config, 'wall=1&demo=none', 'wall');
        // a conversation for the fade: three scripted frames the stage can play with no brain
        const script = (n: number): string => `scene caption\nsay a${n} | Frame ${n}\nsay b${n} | Words for frame ${n}`;
        for (let i = 1; i <= 3; i += 1) {
          await tab.eval(`window.__stage.playScript(${JSON.stringify(script(i))})`);
          await waitFor(`script turn ${i}`, 60_000, async () => (await tab.eval<boolean>('window.__stage.state().turn === null')) ? true : null);
          await sleep(1500);
        }
        const info = await tab.info();
        say(`  frames ${info.tiles.length}, lanes ${info.lanes}, focus ${String(info.focus)}`);
        await sleep(Number(flag('idle-before-map', '0')));
        await tab.call('map');
        await sleep(2500);
        const pic = (await tab.info()) as Info & { pictures: boolean[]; held: number; cacheStats: unknown };
        say(`  pictures ${JSON.stringify(pic.pictures)}, held ${pic.held}, err ${String((pic as unknown as { lastProbeError: string }).lastProbeError)}, stats ${JSON.stringify(pic.cacheStats)}`);
        await tab.shot(join(dir, '09-map-script-frames.png'));
        await tab.call('map');
        await sleep(1500);
        await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await sleep(300);
        await tab.send('Emulation.setCPUThrottlingRate', { rate });
        await tab.call('traceStart');
        await tab.call('step', -1);
        await sleep(800);
        await waitRest(tab, 3000);
        const fade = await tab.call<Trace>('traceStop');
        const fadeLenses = distinctLenses(fade.marks.filter((m) => m[4] !== undefined));
        const moved = fade.marks.filter((m) => (m[4] ?? -1) >= 0).length;
        gate(config, 'reduced motion (system): no frame of travel', fadeLenses <= 2 && moved > 2, `${fadeLenses} distinct lens value(s) (the old one and the new one), ${moved} cross-fade frames`);
        await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        await sleep(300);
        await tab.eval(`localStorage.setItem('conduit.wallMotion', 'fade')`);
        await tab.call('setMotion', 'fade');
        await tab.call('traceStart');
        await tab.call('step', 1);
        await sleep(800);
        await waitRest(tab, 3000);
        const fade2 = await tab.call<Trace>('traceStop');
        gate(config, 'Motion: fade (the shell\'s setting): no frame of travel', distinctLenses(fade2.marks) <= 2, `${distinctLenses(fade2.marks)} distinct lens value(s)`);
        await tab.eval(`localStorage.removeItem('conduit.wallMotion')`);
        await tab.send('Page.close').catch(() => undefined);
      }

      if (only.has('off')) {
        say('  -- the wall off');
        const tab = await openPage(config, 'demo=none', 'stage');
        const off = await tab.eval<{ layer: boolean; hook: boolean; touch: string; nav: boolean }>(`({ layer: Boolean(document.querySelector('.wall-layer')), hook: Boolean(window.__wall), touch: document.querySelector('#stage').style.touchAction, nav: Boolean(document.querySelector('.wall-nav')) })`);
        gate(config, 'with ?wall=1 off nothing of the wall is there', !off.layer && !off.hook && !off.nav && off.touch === 'pinch-zoom', `layer ${String(off.layer)}, hook ${String(off.hook)}, nav ${String(off.nav)}, touch-action "${off.touch}"`);
        await tab.send('Page.close').catch(() => undefined);
      }
    }
    await writeFile(join(out, 'wall-check.json'), `${JSON.stringify({ results, gates }, null, 2)}\n`);
    say(`\n${gates.filter((g) => g.ok).length} of ${gates.length} gates pass.`);
    for (const g of gates.filter((x) => !x.ok)) say(`  FAIL ${g.name}: ${g.detail}`);
    process.exitCode = gates.every((g) => g.ok) ? 0 : 1;
  } finally {
    await stop(child);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
