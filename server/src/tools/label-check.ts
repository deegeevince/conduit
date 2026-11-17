// pnpm check's fb-055 group: a label the brain drew can be tapped to ask about what it names (web/src/app/stage-app.ts, text-out.ts, text-layer.ts), judged with a real
// mouse and a real finger over the DevTools protocol, on the replay brain (no model). A car is drawn the way the brain draws one (`say callout near=<part> | brake disc`,
// `say label near=<part>`) and a heart as a figure (`label=` on its parts):
//
//   words     `tap | Brakes` finds "brake disc", "brakes" and "Brake" by their words, and never an unrelated label (pure, no browser)
//   hover     a label that can be tapped shows it at rest (a dotted underline) and lights when the pointer is over it; words that cannot be tapped do not
//   tap       a real click on a label is exactly one `act` that names the part (the label's words, its id, what it names); a click on a figure's label too
//   part      a click on the drawn part itself, on plain words, and on the empty ground sends nothing (a label is the target, not a big drawn area)
//   drag      a pointer that goes down on a label and travels, that crosses a label, or that comes back to it after travelling, sends nothing; the same label is then
//             tapped with a little wobble and does send one (so the nothing before it is not for want of a live label)
//   touch     the same with a finger on a tablet, with the lens off and on: a drag over a label sends nothing, a tap sends one act
//   journey   `/?journey=labels` taps "Brakes" on a stage it did not see drawn: the step's tap landed on "brake disc" and the act reached the server
//
// Run by `pnpm check` (as `fb-055`) and standalone: `tsx label-check.ts --url <server>`, with smoke's own Tab and Conversation.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { Conversation, Tab } from './smoke';
import type { CheckResult, Options, Posted } from './smoke';
import { Hands } from './lens-check';
import type { LensScene, LensScreen, Point } from './lens-check';
import { likeness } from '../../../web/src/app/journey-words';
import type { JourneyState } from '../../../web/src/app/journey-script';

export const LABEL_SCREEN = { name: '1280x800', width: 1280, height: 800 };
const TOUCH_SCREEN: LensScreen = { name: '1180x820', width: 1180, height: 820, dpr: 2 };

/** a car as the brain draws one: parts by coordinates, and a label with a leader to each part it names */
export const CAR = [
  'scene layout=caption canvas=wide lines=2',
  'color steel=#9aa5b1 sky=#bcd9ea red=#c8452f rubber=#2b2b2b',
  'line road 5,78 155,78 stroke=dim thick=0.6',
  'path body fill=steel stroke=ink thick=0.8 | M15 62 L17 46 C20 42 30 40 40 40 L58 38 C66 26 78 20 92 20 L108 20 C118 20 126 30 132 38 L140 40 C145 43 146 54 145 62 Z',
  'poly win1 62,38 72,25 90,24 90,38 fill=sky',
  'rect engine 23,42 23x14 fill=red',
  'circle front 38,66 11 fill=rubber',
  'circle rear 118,66 11 fill=rubber',
  'circle disc1 38,66 5 fill=steel',
  'say x1 callout near=engine | engine',
  'say x2 callout near=disc1 | brake disc',
  'say x3 label near=rear:below | rear wheel',
  'say x4 | The words beside a part can be tapped to ask about it.',
  'say x5 choice | Show an electric car',
].join('\n');

/** a figure, whose parts carry their own labels */
export const HEART = [
  'scene layout=figure canvas=square',
  'figure heart cutaway | How the heart pumps blood',
  'path body fill=muscle | M52 14 C74 10 90 30 84 54 C78 76 60 90 46 94 C28 84 12 62 16 38 C20 20 36 12 52 14 Z',
  'poly ra smooth 24,30 38,26 42,40 30,46 in=body fill=blue label="right atrium"',
  'poly lv smooth 54,48 76,50 70,74 48,90 in=body fill=red label="left ventricle"',
  'end',
].join('\n');

interface LabelView {
  readonly label: string;
  readonly id: string;
  readonly on: string | null;
  readonly group: string;
  readonly lit: string | null;
  readonly underline: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** the words of the pure checks: what each asked-for label is expected to find among the labels of a car */
export function wordsResults(): CheckResult[] {
  const labels = ['engine', 'brake disc', 'rear wheel', 'driveshaft', 'fuel tank'];
  const best = (wanted: string): string | null => {
    let found: { label: string; score: number } | null = null;
    for (const label of labels) {
      const score = likeness(label, wanted);
      if (score >= 0 && (found === null || score < found.score)) found = { label, score };
    }
    return found?.label ?? null;
  };
  const problems: string[] = [];
  const expect = (wanted: string, label: string | null): void => {
    const got = best(wanted);
    if (got !== label) problems.push(`"${wanted}" found ${got === null ? 'nothing' : `"${got}"`}, not ${label === null ? 'nothing' : `"${label}"`}`);
  };
  expect('Brakes', 'brake disc');
  expect('brakes', 'brake disc');
  expect('Brake', 'brake disc');
  expect('Engine', 'engine');
  expect('wheels', 'rear wheel');
  expect('Driveshaft', 'driveshaft');
  expect('Gearbox', null);
  expect('How does the engine work?', null);
  if (likeness('brakes', 'Brakes') !== 0) problems.push('the same words are not the closest');
  if (!(likeness('brake', 'brakes') < likeness('brake disc', 'brakes'))) problems.push('"brake" is not closer to "brakes" than "brake disc" is');
  return [{ turn: 0, check: 'fb-055-words', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? '"Brakes", "brakes" and "Brake" find "brake disc"; "Engine" finds "engine"; "Gearbox" and a sentence find nothing' : problems.join('; ') }];
}

const shot = async (tab: Tab, dir: string, name: string): Promise<string> => {
  await writeFile(join(dir, name), Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64'));
  return name;
};

const labelsOf = (tab: Tab): Promise<LabelView[]> =>
  tab.eval<LabelView[]>(`[...document.querySelectorAll('.stage__text-block--ask')].map((holder) => {
    const line = holder.querySelector('.stage__text-line');
    const r = line.getBoundingClientRect();
    return { label: holder.dataset.ask, id: holder.dataset.askId, on: holder.dataset.askOn || null, group: holder.dataset.askGroup, lit: holder.dataset.lit || null, underline: getComputedStyle(line).borderBottomStyle, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  })`);

const acts = (tab: Tab, mark: number): Posted[] => tab.posted.slice(mark).filter((turn) => turn.kind === 'act');

const partOf = (turn: Posted): { id: string; label: string; on: string | null; text: string } | null => {
  try {
    const input = (JSON.parse(turn.body) as { input?: { id?: string; text?: string; part?: { label?: string; on?: string | null } } }).input;
    if (input?.part?.label === undefined) return null;
    return { id: String(input.id), label: input.part.label, on: input.part.on ?? null, text: String(input.text) };
  } catch {
    return null;
  }
};

/** a mouse that goes down, travels the points and comes up (the last point), as a hand's would */
async function mouse(tab: Tab, path: readonly Point[]): Promise<void> {
  const first = path[0] as Point;
  const last = path[path.length - 1] as Point;
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, pointerType: 'mouse' });
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(40);
  for (const p of path.slice(1)) {
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(14);
  }
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
}

const steps = (a: Point, b: Point, n: number): Point[] => Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));

/** how long to wait for a second act that a wrong tap would send after the first */
const SETTLE_MS = 1400;

export async function labelGroup(base: string, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  const push = (name: string, began: number, results: CheckResult[], picture = ''): void => void scenes.push({ name, picture, results, seconds: (Date.now() - began) / 1000 });
  const result = (results: CheckResult[], check: string, problems: readonly string[], good: string): void => void results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });

  push('fb-055-words', Date.now(), wordsResults());

  // ---- a mouse, on a desktop
  let began = Date.now();
  note('fb-055: mouse');
  const mouseResults: CheckResult[] = [];
  let picture = '';
  try {
    const tab = await Tab.open(LABEL_SCREEN.width, LABEL_SCREEN.height);
    try {
      const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
      const conv = new Conversation(tab, options, LABEL_SCREEN, dir);
      await tab.send('DOM.enable');
      await conv.start();
      const play = async (script: string): Promise<string> => {
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
        return played !== null ? `the script would not play: ${played}` : conv.rest(true);
      };
      const drawn = async (script: string, problems: string[]): Promise<LabelView[]> => {
        const rest = await play(script);
        if (rest !== '') problems.push(rest);
        // the text layer is built when the stage has been still for a moment
        for (let waited = 0; waited < 4000; waited += 200) {
          const found = await labelsOf(tab);
          if (found.length > 0) return found;
          await sleep(200);
        }
        return [];
      };
      const named = (labels: readonly LabelView[], words: string): LabelView | undefined => labels.find((label) => label.label === words);

      // hover and what can be tapped
      const hover: string[] = [];
      const tap: string[] = [];
      let labels = await drawn(CAR, hover);
      const disc = named(labels, 'brake disc');
      const engine = named(labels, 'engine');
      const wheel = named(labels, 'rear wheel');
      if (disc === undefined || engine === undefined || wheel === undefined) hover.push(`the labels that can be tapped are ${labels.map((label) => `"${label.label}"`).join(', ') || 'none'}: "engine", "brake disc" and "rear wheel" should be there`);
      else {
        if (disc.id !== 'x2' || disc.on !== 'disc1') hover.push(`the brake disc label says it is ${disc.id} naming ${disc.on}, not x2 naming disc1`);
        if (labels.some((label) => label.label === 'Show an electric car' || label.label.startsWith('The words beside'))) hover.push('a choice or a plain line of words can be tapped as a label');
        if (disc.underline === 'none') hover.push('a label that can be tapped shows nothing at rest');
        const plain = await tab.eval<string>(`(() => { const line = [...document.querySelectorAll('.stage__text-block')].find((block) => !block.dataset.ask && /The words beside/.test(block.textContent)); return line ? getComputedStyle(line.querySelector('.stage__text-line')).borderBottomStyle : 'no such words'; })()`);
        if (plain !== 'none') hover.push(`plain words have an underline too (${plain})`);
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: disc.x - 40, y: disc.y - 40, pointerType: 'mouse' });
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: disc.x, y: disc.y, pointerType: 'mouse' });
        await sleep(250);
        const over = named(await labelsOf(tab), 'brake disc');
        const other = named(await labelsOf(tab), 'engine');
        if (over?.lit !== 'hot') hover.push(`the pointer over the brake disc label lights ${over?.lit === null || over === undefined ? 'nothing' : `"${over.lit}"`}, not "hot"`);
        if (other?.lit !== null) hover.push('a label the pointer is not over is lit too');
        picture = await shot(tab, dir, `${LABEL_SCREEN.name}-fb-055-hover.png`);
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400, pointerType: 'mouse' });
        await sleep(200);
        if (named(await labelsOf(tab), 'brake disc')?.lit !== null) hover.push('the label stays lit when the pointer has gone');
      }
      result(mouseResults, 'fb-055-hover', hover, 'labels carry a dotted underline at rest, the one under the pointer lights, plain words and choices are not labels');

      // the drag, first: nothing may be sent (and the same label is then tapped, with a wobble, to show it was alive)
      const drag: string[] = [];
      if (disc !== undefined) {
        const mark = tab.posted.length;
        await mouse(tab, steps({ x: disc.x, y: disc.y }, { x: disc.x + 90, y: disc.y + 70 }, 12));
        await mouse(tab, [...steps({ x: disc.x - 200, y: disc.y + 90 }, { x: disc.x, y: disc.y }, 14), { x: disc.x + 1, y: disc.y }]);
        await mouse(tab, [...steps({ x: disc.x, y: disc.y }, { x: disc.x + 60, y: disc.y }, 6), ...steps({ x: disc.x + 60, y: disc.y }, { x: disc.x, y: disc.y }, 6)]);
        await sleep(SETTLE_MS);
        const sent = acts(tab, mark);
        if (sent.length > 0) drag.push(`${sent.length} act${sent.length === 1 ? ' was' : 's were'} sent by drags that began on, crossed or came back to the label: ${sent.map((turn) => turn.text ?? '').join(' / ')}`);
        const again = tab.posted.length;
        await mouse(tab, [{ x: disc.x, y: disc.y }, { x: disc.x + 2, y: disc.y + 1 }, { x: disc.x + 3, y: disc.y }, { x: disc.x + 3, y: disc.y }]);
        await sleep(SETTLE_MS);
        const tapped = acts(tab, again);
        if (tapped.length !== 1) drag.push(`a click with a wobble of 3 px sent ${tapped.length} acts, not 1: the label was not live, so the drags above prove nothing`);
        else if (partOf(tapped[0] as Posted)?.label !== 'brake disc') drag.push('the click with a wobble did not name the brake disc');
        const rest = await conv.rest(true);
        if (rest !== '') drag.push(rest);
      } else drag.push('no label to drag over');
      result(mouseResults, 'fb-055-drag', drag, 'a drag from, across or back to a label sent nothing; a click with a 3 px wobble on it sent one act');

      // the tap: exactly one act that names the part
      labels = await drawn(CAR, tap);
      const target = named(labels, 'brake disc');
      if (target === undefined) tap.push('no brake disc label to tap');
      else {
        const mark = tab.posted.length;
        await tab.tap(target.x, target.y);
        await sleep(SETTLE_MS);
        const sent = acts(tab, mark);
        if (sent.length !== 1) tap.push(`a click on the brake disc label sent ${sent.length} acts, not 1 (posted: ${tab.posted.slice(mark).map((turn) => turn.kind ?? '?').join(', ') || 'nothing'})`);
        else {
          const part = partOf(sent[0] as Posted);
          if (part === null) tap.push('the act does not say which part');
          else {
            if (part.label !== 'brake disc' || part.id !== 'x2' || part.on !== 'disc1') tap.push(`the act names "${part.label}" (${part.id}, on ${part.on}), not "brake disc" (x2, on disc1)`);
            if (!part.text.includes('brake disc') || !part.text.includes('x2') || !part.text.includes('disc1')) tap.push(`the act's words are "${part.text}"`);
          }
        }
        const rest = await conv.rest(true);
        if (rest !== '') tap.push(rest);
      }
      // a label of the other kind (`say label near=`), and a figure's own
      const wheelNow = named(await drawn(CAR, tap), 'rear wheel');
      if (wheelNow === undefined) tap.push('no rear wheel label to tap');
      else {
        const mark = tab.posted.length;
        await tab.tap(wheelNow.x, wheelNow.y);
        await sleep(SETTLE_MS);
        const sent = acts(tab, mark);
        const part = sent.length === 1 ? partOf(sent[0] as Posted) : null;
        if (part === null || part.label !== 'rear wheel' || part.id !== 'x3' || part.on !== 'rear') tap.push(`a click on a "say label near=rear" label sent ${sent.length} acts naming ${part === null ? 'nothing' : `"${part.label}" (${part.id}, on ${part.on})`}`);
        await conv.rest(true);
      }
      const figure = await drawn(HEART, tap);
      const ventricle = named(figure, 'left ventricle');
      if (ventricle === undefined) tap.push(`the figure's labels that can be tapped are ${figure.map((label) => `"${label.label}"`).join(', ') || 'none'}: "left ventricle" should be there`);
      else {
        picture = await shot(tab, dir, `${LABEL_SCREEN.name}-fb-055-figure.png`);
        const mark = tab.posted.length;
        await tab.tap(ventricle.x, ventricle.y);
        await sleep(SETTLE_MS);
        const sent = acts(tab, mark);
        const part = sent.length === 1 ? partOf(sent[0] as Posted) : null;
        if (part === null || part.label !== 'left ventricle' || part.id !== 'lv' || part.on !== 'heart') tap.push(`a click on a figure's label sent ${sent.length} acts naming ${part === null ? 'nothing' : `"${part.label}" (${part.id}, on ${part.on})`}, not "left ventricle" (lv, on heart)`);
        await conv.rest(true);
      }
      result(mouseResults, 'fb-055-tap', tap, 'a click on a callout, a label and a figure part\'s label is one act each, naming the label, its id and what it names');

      // the part itself, plain words and the ground send nothing
      const part: string[] = [];
      await drawn(CAR, part);
      const around = await tab.eval<{ part: Point | null; words: Point | null; ground: Point }>(`(() => {
        const stage = document.getElementById('stage').getBoundingClientRect();
        const box = (id) => { const e = window.__stage.elements().find((item) => item.id === id); return e ? { x: stage.left + e.box.x + e.box.width / 2, y: stage.top + e.box.y + e.box.height / 2 } : null; };
        return { part: box('engine'), words: box('x4'), ground: { x: stage.left + 40, y: stage.top + 40 } };
      })()`);
      const mark = tab.posted.length;
      for (const [what, at] of [['the drawn engine', around.part], ['plain words', around.words], ['the empty ground', around.ground]] as const) {
        if (at === null) {
          part.push(`${what} is not on stage to tap`);
          continue;
        }
        await tab.tap(at.x, at.y);
        await sleep(500);
      }
      await sleep(SETTLE_MS);
      const stray = acts(tab, mark);
      if (stray.length > 0) part.push(`${stray.length} act${stray.length === 1 ? '' : 's'} sent by taps on the drawn part, plain words or the ground: ${stray.map((turn) => turn.text ?? '').join(' / ')}`);
      if (tab.posted.slice(mark).some((turn) => turn.kind === 'tap')) part.push('a tap on plain words or a drawn part was taken for a choice');
      result(mouseResults, 'fb-055-part', part, 'a click on the drawn part, on plain words and on the ground sends nothing');

      const drained = tab.drain();
      const errors = [...drained.consoleErrors, ...drained.failedRequests].map((entry) => entry.text);
      result(mouseResults, 'fb-055-console', errors.slice(0, 3), 'no console errors or failed requests');
    } finally {
      await tab.close();
    }
  } catch (error) {
    result(mouseResults, 'fb-055-mouse', [error instanceof Error ? error.message : String(error)], '');
  }
  push('fb-055-mouse', began, mouseResults, picture);

  // ---- a finger, on a tablet, with the lens off and on (`?lens=1`: the finger is the lens's to pan with, and a tap when it lifts)
  for (const variant of [{ name: 'touch', page: '' }, { name: 'touch-lens', page: 'lens=1' }]) {
    began = Date.now();
    note(`fb-055: finger${variant.page === '' ? '' : ' with the lens'}`);
    const touchResults: CheckResult[] = [];
    try {
      const tab = await Tab.open(TOUCH_SCREEN.width, TOUCH_SCREEN.height, { dpr: TOUCH_SCREEN.dpr, touch: true });
      try {
        const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: variant.page, say: null, chat: 'off' };
        const conv = new Conversation(tab, options, { name: TOUCH_SCREEN.name, width: TOUCH_SCREEN.width, height: TOUCH_SCREEN.height }, dir);
        await tab.send('DOM.enable');
        await conv.start();
        const hands = new Hands(tab);
        const problems: string[] = [];
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(CAR)})).then(() => null, (e) => String(e && e.message || e))`);
        const rest = played !== null ? `the script would not play: ${played}` : await conv.rest(true);
        if (rest !== '') problems.push(rest);
        let labels: LabelView[] = [];
        for (let waited = 0; waited < 4000 && labels.length === 0; waited += 200) {
          labels = await labelsOf(tab);
          if (labels.length === 0) await sleep(200);
        }
        const disc = labels.find((label) => label.label === 'brake disc');
        if (disc === undefined) problems.push('no brake disc label on the tablet');
        else {
          const at = { x: disc.x, y: disc.y };
          const mark = tab.posted.length;
          await hands.finger(steps({ x: at.x, y: at.y }, { x: at.x + 90, y: at.y + 70 }, 10));
          await hands.finger(steps({ x: at.x - 160, y: at.y + 90 }, at, 12));
          await sleep(SETTLE_MS);
          const sent = acts(tab, mark);
          if (sent.length > 0) problems.push(`${sent.length} act${sent.length === 1 ? ' was' : 's were'} sent by a finger dragged from, or onto, the label`);
          // the page may have moved under the drags (the lens pans): the label is found again where it now is
          const now = (await labelsOf(tab)).find((label) => label.label === 'brake disc');
          const again = tab.posted.length;
          await hands.finger([now === undefined ? at : { x: now.x, y: now.y }]);
          await sleep(SETTLE_MS);
          const tapped = acts(tab, again);
          const part = tapped.length === 1 ? partOf(tapped[0] as Posted) : null;
          if (part === null || part.label !== 'brake disc') problems.push(`a finger tap on the label sent ${tapped.length} acts naming ${part === null ? 'nothing' : `"${part.label}"`}, not one naming "brake disc"`);
        }
        result(touchResults, `fb-055-${variant.name}`, problems, 'a finger dragged from or onto a label sent nothing; a finger tap on it sent one act naming the brake disc');
      } finally {
        await tab.close();
      }
    } catch (error) {
      result(touchResults, `fb-055-${variant.name}`, [error instanceof Error ? error.message : String(error)], '');
    }
    push(`fb-055-${variant.name}`, began, touchResults);
  }

  // ---- the journey
  began = Date.now();
  note('fb-055: journey');
  const journeyResults: CheckResult[] = [];
  try {
    const tab = await Tab.open(LABEL_SCREEN.width, LABEL_SCREEN.height);
    try {
      // a journey that cannot find "Brakes" gives up after 25 s, not the minute it would wait for a person's own
      await tab.send('Page.navigate', { url: `${base}/?journey=labels&journeywait=25` });
      // the journey waits for something to tap: this draws the car while it does
      let status: string | null = null;
      for (let waited = 0; waited < 30_000 && status !== 'running'; waited += 250) {
        await sleep(250);
        status = await tab.eval<string | null>('window.__journey ? window.__journey.status : null').catch(() => null);
      }
      const problems: string[] = [];
      if (status !== 'running') problems.push(`the journey is ${status ?? 'not there'}, not running`);
      else {
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(CAR)})).then(() => null, (e) => String(e && e.message || e))`);
        if (played !== null) problems.push(`the script would not play: ${played}`);
      }
      let journey: JourneyState | null = null;
      for (let waited = 0; waited < Math.max(timeoutMs, 90_000); waited += 250) {
        await sleep(250);
        const now = await tab.eval<string | null>('window.__journey ? window.__journey.status : null').catch(() => null);
        if (now === 'done' || now === 'stopped') break;
      }
      journey = await tab.eval<JourneyState | null>('JSON.parse(JSON.stringify(window.__journey || null))');
      const step = journey?.steps[0];
      if (journey === null || step === undefined) problems.push('the journey has no steps');
      else {
        if (journey.status !== 'done') problems.push(`the journey ended ${journey.status}: ${journey.message ?? 'no message'}`);
        if (step.tapped === null || !/^brake disc$/i.test(step.tapped)) problems.push(`"Brakes" tapped ${step.tapped === null ? 'nothing' : `"${step.tapped}"`}, not "brake disc"`);
        if (step.turn === null) problems.push('the tap opened no turn');
      }
      const sent = acts(tab, 0);
      const part = sent.length === 1 ? partOf(sent[0] as Posted) : null;
      if (part === null || part.label !== 'brake disc') problems.push(`the server was sent ${sent.length} acts naming ${part === null ? 'nothing' : `"${part.label}"`}, not one naming "brake disc"`);
      result(journeyResults, 'fb-055-journey', problems, `\`tap | Brakes\` landed on "${step?.tapped ?? ''}" and the server was sent one act naming it`);
    } finally {
      await tab.close();
    }
  } catch (error) {
    result(journeyResults, 'fb-055-journey', [error instanceof Error ? error.message : String(error)], '');
  }
  push('fb-055-journey', began, journeyResults);
  return scenes;
}

const flag = process.argv.indexOf('--url');
if (import.meta.url === `file://${process.argv[1]}` && flag > 0) {
  const base = (process.argv[flag + 1] ?? '').replace(/\/+$/, '');
  void labelGroup(base, process.env['LABEL_OUT'] ?? '/tmp/conduit-label-check', 90_000, (text) => process.stdout.write(`${text}\n`)).then((scenes) => {
    let failed = 0;
    for (const scene of scenes) for (const outcome of scene.results) {
      process.stdout.write(`${outcome.verdict} ${outcome.check}: ${outcome.detail}\n`);
      if (outcome.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  });
}
