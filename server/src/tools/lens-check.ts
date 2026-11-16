// pnpm check's lens group (PLAN-canvas step 1, `?lens=1`): real fingers and a real pen, over the DevTools protocol, on a tablet (1180x820 at two pixels
// to the point, touch) and a phone (390x844). Four things are judged, each by what lands where:
//
//   pinch       two touch points spread to twice their distance: the lens reads 2x, about the point between them
//   tap         a finger on a starter of the welcome, at 2x, sends that starter's words
//   slider      a finger dragged along the explorable demo's slider, at 2x, sets the value the page point under the finger names
//   pen         a pen stroke at 2x (no Draw) leaves ink whose points are the page points under the pen, and still there after `0` fits again;
//               a pen drag draws without Draw switched on, and a short pen tap on a starter presses it and leaves no ink
//
// It is run by `pnpm check` and standalone (`tsx lens-check.ts --url <server>`), and uses smoke's own Tab and Conversation.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { CheckResult, Options } from './smoke';

export interface LensScreen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** device pixels to the point; the tablet's is 2 */
  readonly dpr: number;
}

export const LENS_SCREENS: readonly LensScreen[] = [
  { name: '1180x820', width: 1180, height: 820, dpr: 2 },
  { name: '390x844', width: 390, height: 844, dpr: 2 },
];

interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}
interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Point {
  readonly x: number;
  readonly y: number;
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

class Hands {
  constructor(readonly tab: Tab) {}

  async lens(): Promise<{ view: View | null; touched: boolean } | null> {
    return this.tab.eval('window.__stage.lens()');
  }

  /** the stage's own left and top on the page, CSS pixels: stage points are measured from there */
  async origin(): Promise<Point> {
    return this.tab.eval<Point>(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  }

  /** a page point as the screen shows it now (client pixels) */
  async onScreen(page: Point): Promise<Point> {
    const view = (await this.lens())?.view ?? null;
    const o = await this.origin();
    return view === null ? { x: o.x + page.x, y: o.y + page.y } : { x: o.x + (page.x - view.x) * view.scale, y: o.y + (page.y - view.y) * view.scale };
  }

  /** a screen point (client pixels) as the page names it now */
  async onPage(screen: Point): Promise<Point> {
    const view = (await this.lens())?.view ?? null;
    const o = await this.origin();
    return view === null ? { x: screen.x - o.x, y: screen.y - o.y } : { x: view.x + (screen.x - o.x) / view.scale, y: view.y + (screen.y - o.y) / view.scale };
  }

  async pinch(cx: number, cy: number, from: number, to: number): Promise<void> {
    const points = (d: number) => [
      { x: cx - d / 2, y: cy, id: 1 },
      { x: cx + d / 2, y: cy, id: 2 },
    ];
    await this.tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
    for (let i = 1; i <= 30; i += 1) {
      await this.tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + ((to - from) * i) / 30) });
      await sleep(16);
    }
    await this.tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
  }

  async finger(path: readonly Point[]): Promise<void> {
    const first = path[0] as Point;
    await this.tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...first, id: 1 }] });
    await sleep(40);
    for (const p of path.slice(1)) {
      await this.tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, id: 1 }] });
      await sleep(16);
    }
    await this.tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
  }

  async pen(path: readonly Point[]): Promise<void> {
    const first = path[0] as Point;
    await this.tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, pointerType: 'pen' });
    await this.tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
    await sleep(40);
    for (const p of path.slice(1)) {
      await this.tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
      await sleep(14);
    }
    const last = path[path.length - 1] as Point;
    await this.tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
    await sleep(300);
  }

  async key(key: string): Promise<void> {
    await this.tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key });
    await this.tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    // a glide of the lens takes up to a second and a bit
    for (let waited = 0; waited < 3000; waited += 250) {
      await sleep(250);
      if (!(await this.tab.eval<boolean>('window.__lensMoving ? window.__lensMoving() : false'))) break;
    }
  }

  async strokes(): Promise<{ strokes: { points: number[][] }[] } | null> {
    return this.tab.eval('(window.__inkDoc ? window.__inkDoc() : null)');
  }

  async drawToggle(): Promise<boolean> {
    return this.tab.eval<boolean>(`!!document.querySelector('.ink-stage') && !document.querySelector('.ink-stage').hidden && !document.querySelector('.ink-stage').classList.contains('ink-stage--through')`);
  }
}

function line(a: Point, b: Point, n: number): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

const near = (a: Point, b: Point, tolerance: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

export interface LensScene {
  readonly name: string;
  readonly picture: string;
  readonly results: CheckResult[];
  readonly seconds: number;
}

/** Runs the lens group on one screen against a server. Returns its scenes; a failure is a `FAIL` result, never a throw. */
export async function lensGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  const open = async (demo: boolean): Promise<{ tab: Tab; hands: Hands; conv: Conversation }> => {
    const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
    const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo, quiet: true, page: 'lens=1', say: null, chat: 'off' };
    const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
    await tab.send('DOM.enable');
    await conv.start();
    return { tab, hands: new Hands(tab), conv };
  };
  const result = (results: CheckResult[], check: string, problems: readonly string[], good: string): void => {
    results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });
  };
  const shot = async (tab: Tab, name: string): Promise<string> => {
    const file = `${screen.name}-lens-${name}.png`;
    await writeFile(join(dir, file), Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64'));
    return file;
  };
  const starters = (tab: Tab): Promise<{ text: string; box: Box }[]> =>
    tab.eval(`window.__stage.elements().filter((e) => e.kind === 'text' && e.phase === 'on' && e.opacity > 0.3 && e.tappable !== false).map((e) => ({ text: String(e.text || ''), box: e.box, tappable: e.tappable })).filter((e) => e.tappable)`);

  // ---------------------------------------------------------------------------------------------------------------------- welcome: pinch, tap, keys, pen
  {
    const began = Date.now();
    const results: CheckResult[] = [];
    note('lens: the welcome');
    const { tab, hands, conv } = await open(true);
    try {
      const all = await starters(tab);
      const first = await hands.lens();
      result(results, 'lens-on', first === null ? ['the page has no lens: ?lens=1 did nothing'] : first.view !== null ? [`the lens is not at rest on arrival (${JSON.stringify(first.view)})`] : [], 'the lens is on and at rest on arrival');
      if (all.length === 0) result(results, 'lens-starters', ['no starter on stage to work'], '');
      else {
        // 1. pinch to 2x about the first starter, which then stays where it is under the fingers
        const o = await hands.origin();
        const first0 = all[0] as { text: string; box: Box };
        const aim = { x: first0.box.x + first0.box.width / 2, y: first0.box.y + first0.box.height / 2 };
        const centre = { x: o.x + aim.x, y: o.y + aim.y };
        await hands.pinch(centre.x, centre.y, 100, 200);
        const zoomed = await hands.lens();
        const view = zoomed?.view ?? null;
        result(results, 'lens-pinch', view === null || Math.abs(view.scale - 2) > 0.15 ? [`two fingers spread to twice the distance read ${view === null ? 'no lens' : `${view.scale.toFixed(2)}x`}, wanted 2x`] : zoomed?.touched !== true ? ['the lens does not know it was touched'] : [], `the lens reads ${view?.scale.toFixed(2)}x`);
        // the page point that was between the fingers is still between them
        const under = await hands.onPage(centre);
        result(results, 'lens-pinch-anchor', near(under, aim, 6) ? [] : [`the page point under the fingers moved to ${Math.round(under.x)},${Math.round(under.y)} from ${Math.round(aim.x)},${Math.round(aim.y)}`], 'the page point between the fingers stayed between them');
        const picture = await shot(tab, 'pinch');

        // 2. a tap on that starter, now twice the size
        const pick = { text: first0.text, at: await hands.onScreen(aim) };
        const before = tab.posted.length;
        await hands.finger([pick.at]);
        let sent: (typeof tab.posted)[number] | undefined;
        for (let waited = 0; waited < 6000 && sent === undefined; waited += 200) {
          sent = tab.posted.slice(before)[0];
          if (sent === undefined) await sleep(200);
        }
        result(results, 'lens-tap', sent === undefined ? [`a finger on "${pick.text}" at 2x sent nothing`] : sent.text !== null && norm(sent.text) !== norm(pick.text) ? [`the tap sent "${sent.text}", not "${pick.text}"`] : [], `a finger on "${pick.text}" at 2x sent it`);
        await conv.rest(true, false).catch(() => undefined);
        void picture;
      }
      scenes.push({ name: 'welcome-pinch-tap', picture: await shot(tab, 'tap'), results, seconds: (Date.now() - began) / 1000 });
    } finally {
      await tab.close();
    }
  }

  {
    const began = Date.now();
    const results: CheckResult[] = [];
    note('lens: the pen on the welcome');
    const { tab, hands } = await open(true);
    try {
      const o = await hands.origin();
      const all = await starters(tab);
      // 3. a pen drag draws without Draw, at rest
      const a = { x: o.x + screen.width * 0.25, y: o.y + 70 };
      const b = { x: o.x + screen.width * 0.6, y: o.y + 110 };
      await hands.pen(line(a, b, 20));
      const doc1 = await hands.strokes();
      const n1 = doc1?.strokes.length ?? 0;
      result(results, 'lens-pen-draws', n1 !== 1 ? [`a pen drag left ${n1} stroke(s) with Draw off, wanted 1`] : (await hands.drawToggle()) ? ['Draw was switched on by the pen'] : [], 'a pen drag drew a stroke without Draw switched on');
      // its points are the page points under the pen
      const p0 = doc1?.strokes[0]?.points[0];
      result(results, 'lens-pen-point', p0 === undefined || !near({ x: p0[0] as number, y: p0[1] as number }, { x: a.x - o.x, y: a.y - o.y }, 3) ? [`the stroke starts at ${p0 === undefined ? 'nothing' : `${Math.round(p0[0] as number)},${Math.round(p0[1] as number)}`}, the pen went down at ${Math.round(a.x - o.x)},${Math.round(a.y - o.y)}`] : [], 'the stroke starts where the pen went down');
      // the toolbar is there for what waits to be sent
      const bar = await tab.eval<boolean>(`(() => { const b = document.querySelector('.ink-stage__bar'); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; })()`);
      result(results, 'lens-pen-bar', bar ? [] : ['the ink toolbar is not shown with a stroke waiting'], 'the toolbar shows once a stroke waits');
      // 4. a short pen tap on a starter presses it, and leaves no ink
      const s = all[0];
      if (s === undefined) result(results, 'lens-pen-tap', ['no starter on stage'], '');
      else {
        const at = { x: o.x + s.box.x + s.box.width / 2, y: o.y + s.box.y + s.box.height / 2 };
        const before = tab.posted.length;
        await hands.pen([at, at]);
        let sent: (typeof tab.posted)[number] | undefined;
        for (let waited = 0; waited < 6000 && sent === undefined; waited += 200) {
          sent = tab.posted.slice(before)[0];
          if (sent === undefined) await sleep(200);
        }
        const n2 = (await hands.strokes())?.strokes.length ?? 0;
        result(results, 'lens-pen-tap', sent === undefined ? [`a short pen tap on "${s.text}" pressed nothing`] : n2 !== n1 ? [`the tap left ink: ${n2} strokes, was ${n1}`] : [], `a short pen tap on "${s.text}" pressed it and left no ink`);
      }
      scenes.push({ name: 'welcome-pen', picture: await shot(tab, 'pen'), results, seconds: (Date.now() - began) / 1000 });
    } finally {
      await tab.close();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------- explorable: slider, pen at 2x, keys
  {
    const began = Date.now();
    const results: CheckResult[] = [];
    note('lens: the explorable demo');
    const { tab, hands, conv } = await open(false);
    try {
      conv.seenReports = new Set();
      const started = await tab.eval<string | null>(`Promise.resolve(window.__stage.demo('explorable')).then(() => null, (e) => String(e && e.message || e))`);
      const rest = started !== null ? `the demo would not start: ${started}` : await conv.rest(true);
      if (rest !== '') result(results, 'lens-rest', [rest], '');
      const controls = (): Promise<{ id: string; control: string; min: number; max: number; value: number; box: Box; parts: { part: string; box: Box }[] }[]> =>
        tab.eval('window.__stage.controls().map((c) => ({ id: c.id, control: c.control, min: c.min, max: c.max, value: c.value, box: c.box, parts: c.parts }))');
      const slider = (await controls()).find((c) => c.control === 'slider');
      if (slider === undefined) result(results, 'lens-slider', ['no slider in the explorable demo'], '');
      else {
        const o = await hands.origin();
        const track = slider.parts.find((p) => p.part === 'track')?.box ?? slider.box;
        const mid = { x: o.x + track.x + track.width / 2, y: o.y + track.y + track.height / 2 };
        await hands.pinch(mid.x, mid.y, 100, 200);
        const view = (await hands.lens())?.view ?? null;
        result(results, 'lens-pinch-demo', view === null || Math.abs(view.scale - 2) > 0.15 ? ['the pinch did not reach 2x on the explorable demo'] : [], 'the lens is at 2x');
        const t = (await controls()).find((c) => c.id === slider.id) as typeof slider;
        const trackNow = t.parts.find((p) => p.part === 'track')?.box ?? t.box;
        const range = t.max - t.min;
        const fractions = [0.25, 0.75];
        const seen: number[] = [];
        for (const f of fractions) {
          const page = { x: trackNow.x + trackNow.width * f, y: trackNow.y + trackNow.height / 2 };
          const startPage = { x: trackNow.x + trackNow.width * (f < 0.5 ? 0.9 : 0.1), y: page.y };
          const from = await hands.onScreen(startPage);
          const to = await hands.onScreen(page);
          await hands.finger(line(from, to, 14));
          const v = ((await controls()).find((c) => c.id === slider.id) as typeof slider).value;
          seen.push(((v as number) - t.min) / range);
        }
        const bad: string[] = [];
        seen.forEach((got, i) => {
          const want = fractions[i] as number;
          if (Math.abs(got - want) > 0.2) bad.push(`dragging to ${Math.round(want * 100)}% of the track set ${Math.round(got * 100)}%`);
        });
        if (seen.length === 2 && (seen[1] as number) <= (seen[0] as number)) bad.push('a drag to the right of a drag to the left set a smaller value');
        result(results, 'lens-slider', bad, `a finger dragged to 25% and 75% of the track at 2x set ${seen.map((v) => `${Math.round(v * 100)}%`).join(' and ')}`);
        const shotName = await shot(tab, 'slider');

        // a pen stroke at 2x, no Draw: its points are the page points under the pen
        const a = { x: o.x + screen.width * 0.3, y: o.y + 90 };
        const b = { x: o.x + screen.width * 0.7, y: o.y + 140 };
        await hands.pen(line(a, b, 24));
        const doc = await hands.strokes();
        const stroke = doc?.strokes[doc.strokes.length - 1];
        const first = stroke?.points[0];
        const last = stroke?.points[stroke.points.length - 1];
        const wantA = await hands.onPage(a);
        const wantB = await hands.onPage(b);
        const problems: string[] = [];
        if (stroke === undefined || first === undefined || last === undefined) problems.push('the pen at 2x left no stroke');
        else {
          if (!near({ x: first[0] as number, y: first[1] as number }, wantA, 3)) problems.push(`the stroke starts at page ${Math.round(first[0] as number)},${Math.round(first[1] as number)}, the pen went down on page ${Math.round(wantA.x)},${Math.round(wantA.y)}`);
          if (!near({ x: last[0] as number, y: last[1] as number }, wantB, 3)) problems.push(`the stroke ends at page ${Math.round(last[0] as number)},${Math.round(last[1] as number)}, the pen came up on page ${Math.round(wantB.x)},${Math.round(wantB.y)}`);
        }
        result(results, 'lens-pen-zoomed', problems, 'a pen stroke at 2x is in page units: its ends are the page points under the pen');
        // 5. `0` fits again, and the stroke is where it was on the page
        await hands.key('0');
        const fitted = await hands.lens();
        result(results, 'lens-fit-key', fitted?.view === null ? [] : [`after 0 the lens still reads ${JSON.stringify(fitted?.view)}`], 'the 0 key fits the page again');
        const again = (await hands.strokes())?.strokes.at(-1)?.points[0];
        result(results, 'lens-ink-stays', again === undefined || first === undefined || !near({ x: again[0] as number, y: again[1] as number }, { x: first[0] as number, y: first[1] as number }, 0.01) ? ['the stroke moved when the lens did'] : [], 'the stroke is the same page points after Fit');
        void shotName;
      }
      scenes.push({ name: 'explorable-slider-pen', picture: await shot(tab, 'explorable'), results, seconds: (Date.now() - began) / 1000 });
    } finally {
      await tab.close();
    }
  }
  return scenes;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Standalone

if (process.argv[1] !== undefined && /lens-check\.ts$/.test(process.argv[1])) {
  const url = process.argv[process.argv.indexOf('--url') + 1];
  const out = process.argv.includes('--out') ? (process.argv[process.argv.indexOf('--out') + 1] as string) : '/tmp/conduit-lens';
  if (url === undefined || !url.startsWith('http')) {
    process.stderr.write('usage: tsx lens-check.ts --url http://127.0.0.1:<port> [--out <dir>]\n');
    process.exit(2);
  }
  void (async () => {
  const all: LensScene[] = [];
    for (const screen of LENS_SCREENS) all.push(...(await lensGroup(url, screen, join(out, screen.name), 90_000, (text) => process.stdout.write(`${screen.name} ${text}\n`))));
    let failed = 0;
    for (const scene of all) for (const r of scene.results) {
      process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  })();
}
