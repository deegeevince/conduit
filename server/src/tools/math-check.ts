// pnpm check's maths group (PLAN-maths M2): written methods laid out on the page's own painter, and the painted boxes read back. No model, no browser.
//
//   place      the digits of one place share one x (within a pixel), across every row and the answer row
//   blanks     every blank is a box of at least 44 on each side, with nothing written in it
//   sealed     with the answer blank, no painted word is the answer (or any cell of the answer row)
//   fill       `fill` writes its digits into the blanks, by place
//   rule       the rule spans every column of the sum
//   clear      no two cells overlap, and the block is on the screen
//
// The page's half is `web/src/bench/math-bench.ts` (the real painter, a renderer that keeps the last frame). Run by `pnpm check` and standalone (`tsx math-check.ts`).
//
// The input half (PLAN-maths M3, M4) is worked in a real headless Chrome with a real finger, a real pen and real keys, at 820x971 (dpr 2) and 390x844 (dpr 3), on a server
// this group starts itself (BRAIN=replay, INK_READER=fake: no model):
//
//   keys    a finger tap focuses a cell inside the gesture; `2` moves to the carry then the tens; Backspace, Tab and the arrows walk the sum; Enter marks it;
//           under a stubbed short visual viewport the active cell stays in view
//   hint    Hint lights the next cell and says its step without its digit; Show me is offered only after a wrong try and fills one cell, marked as shown
//   fill    `fill m1 | 72` and `fill m1.ans-ones | 2` put digits in the cells, marked
//   pen     (M4) a pen stroke with Draw closed is one stroke owned by its cell; across two cells it goes to the larger share; a finger drag leaves no ink; the fake reader's
//           digit shows and Check marks it; a misread is corrected by a tap and a typed digit
//   mixed   pen in one cell and keys in the next
//   live    one real handwriting read on a server with the Claude brain, to time it (`--live`, and in `pnpm check` only when MATHS_LIVE=1)

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maths } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { claimPort, releasePort } from './check-ports';
import { repoRoot, sleep, stop, waitFor } from './explore-browser';
import { Conversation, Tab } from './smoke';
import { Hands } from './lens-check';
import type { Point } from './lens-check';
import type { CheckResult, Options } from './smoke';

interface Painted {
  readonly elements: readonly { readonly key: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly text: string }[];
  readonly figures: readonly { readonly key: string; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[];
}
interface Capture {
  readonly screen: { readonly name: string; readonly width: number; readonly height: number };
  readonly lines: readonly string[];
  readonly painted: Painted;
}

async function capture(): Promise<Capture[]> {
  const child = spawnTracked('pnpm', ['--filter', '@conduit/language', 'exec', 'tsx', '--import', '../web/src/bench/node-register.mjs', '../web/src/bench/math-bench.ts'], undefined, { cwd: repoRoot(), quiet: false });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const code = await new Promise<number | null>((done) => child.once('close', done));
  if (code !== 0) throw new Error(`the page's maths bench stopped (${code}): ${err.slice(-600)}`);
  return JSON.parse(out.slice(out.indexOf('['))) as Capture[];
}

const partOf = (key: string): string => key.slice(key.indexOf('/') + 1);

export function mathProblems(captures: readonly Capture[]): { problems: string[]; blocks: number; blanks: number } {
  const problems: string[] = [];
  let blocks = 0;
  let blanks = 0;
  for (const one of captures) {
    const method = /^math \S+ (\S+)/.exec(one.lines[0] ?? '')?.[1] ?? '';
    const where = `${one.screen.name} ${one.lines[0]}`;
    const { elements, figures } = one.painted;
    if (elements.length + figures.length === 0) {
      problems.push(`${where}: nothing was painted`);
      continue;
    }
    blocks += 1;
    const worked = /\bworked\b/.test(one.lines[0] ?? '');
    const typedBy = one.lines.some((line) => line.startsWith('type '));
    const filled = one.lines.some((line) => line.startsWith('fill '));
    const isGrid = method === 'column' || method === 'times' || method === 'split' || method === 'bond';
    // 1. place: every digit cell of one place, in any row, stands on one x (carries and exchanges are set smaller, in the same column)
    if (isGrid) {
      const byPlace = new Map<string, number[]>();
      for (const e of elements) {
        const m = /^c:(?:r\d+|ans)-(.+)$/.exec(partOf(e.key));
        if (m?.[1] === undefined || method === 'split' || method === 'bond') continue;
        byPlace.set(m[1], [...(byPlace.get(m[1]) ?? []), e.x]);
      }
      for (const [place, xs] of byPlace) if (Math.max(...xs) - Math.min(...xs) > 1) problems.push(`${where}: the digits of ${place} are not on one x (${xs.map((x) => x.toFixed(1)).join(', ')})`);
    }
    // 2. blanks: boxes of a fingertip, empty unless filled
    const written = new Set(elements.map((e) => partOf(e.key)));
    for (const f of figures) {
      const name = partOf(f.key);
      if (!name.startsWith('f:')) continue;
      blanks += 1;
      if (f.x1 - f.x0 < 44 - 0.01 || f.y1 - f.y0 < 44 - 0.01) problems.push(`${where}: blank ${name} is ${(f.x1 - f.x0).toFixed(1)}x${(f.y1 - f.y0).toFixed(1)}, under 44`);
      if (written.has(`c:${name.slice(2)}`) && !filled && !typedBy) problems.push(`${where}: blank ${name} is not empty`);
    }
    if (isGrid && !worked && method !== 'bond' && !figures.some((f) => partOf(f.key).startsWith('f:ans'))) problems.push(`${where}: no blank answer cells`);
    // 3. sealed: with the answer blank (and nothing filled), no answer cell is painted and no painted word is the answer
    const [id] = (one.lines[0] ?? '').split(' ').slice(1);
    const sum = /\|\s*(.+)$/.exec(one.lines[0] ?? '')?.[1] ?? '';
    const read = id === undefined ? null : maths.readSum(method as never, sum);
    if (!worked && !filled && !typedBy) {
      if (elements.some((e) => partOf(e.key).startsWith('c:ans'))) problems.push(`${where}: an answer cell shows a value while the answer is blank`);
      if (read?.ok) for (const answer of maths.answerOf(read.sum)) if (elements.some((e) => e.text.trim() === answer && answer.length > 1)) problems.push(`${where}: the answer ${answer} is painted`);
    }
    // 4. fill: its digits are in the blanks by place
    if (filled && method === 'column') {
      const tens = elements.find((e) => partOf(e.key) === 'c:ans-tens')?.text;
      const ones = elements.find((e) => partOf(e.key) === 'c:ans-ones')?.text;
      if (tens !== '2' || ones !== '4') problems.push(`${where}: fill 24 put "${tens}" and "${ones}" in the tens and ones`);
    }
    // 4b. typed: a digit a keyboard wrote stands in its cell, typeset (a text part of the block, centred in the box), and the answer is not drawn elsewhere
    for (const line of one.lines.filter((text) => text.startsWith('type '))) {
      const m = /^type \S+\.(\S+) \| (\d+)$/.exec(line);
      if (m?.[1] === undefined) continue;
      const word = elements.find((e) => partOf(e.key) === `c:${m[1]}`);
      const frame = figures.find((f) => partOf(f.key) === `f:${m[1]}`);
      if (word === undefined || frame === undefined) problems.push(`${where}: the digit typed in ${m[1]} is not drawn in its cell`);
      else if (word.text.trim() !== m[2] || Math.abs(word.x - (frame.x0 + frame.x1) / 2) > 2 || Math.abs(word.y - (frame.y0 + frame.y1) / 2) > frame.y1 - frame.y0) problems.push(`${where}: the digit typed in ${m[1]} reads "${word.text}" at ${word.x.toFixed(0)},${word.y.toFixed(0)}, not typeset in its cell`);
    }
    // 5. rule: spans the columns of every digit and sign
    const rule = figures.find((f) => partOf(f.key) === 'rule');
    if (isGrid && method !== 'split' && method !== 'bond') {
      const cells = elements.filter((e) => /^c:(?:r\d+|ans|sign)/.test(partOf(e.key)));
      const left = Math.min(...cells.map((e) => e.x - e.width / 2));
      const right = Math.max(...cells.map((e) => e.x + e.width / 2));
      if (rule === undefined) problems.push(`${where}: no rule`);
      else if (rule.x0 > left + 1 || rule.x1 < right - 1) problems.push(`${where}: the rule (${rule.x0.toFixed(0)}..${rule.x1.toFixed(0)}) does not span the columns (${left.toFixed(0)}..${right.toFixed(0)})`);
    }
    // 6. clear: no two words overlap, and all of it is on the screen
    const boxes = elements.filter((e) => e.text.trim() !== '');
    for (let i = 0; i < boxes.length; i += 1) {
      const a = boxes[i];
      if (a === undefined) continue;
      if (a.x - a.width / 2 < -one.screen.width / 2 - 1 || a.x + a.width / 2 > one.screen.width / 2 + 1 || a.y - a.height / 2 < -one.screen.height / 2 - 1 || a.y + a.height / 2 > one.screen.height / 2 + 1) problems.push(`${where}: ${partOf(a.key)} is off the screen`);
      for (let j = i + 1; j < boxes.length; j += 1) {
        const b = boxes[j];
        if (b === undefined || isGrid === false) continue;
        const w = Math.min(a.x + a.width / 2, b.x + b.width / 2) - Math.max(a.x - a.width / 2, b.x - b.width / 2);
        // a line box is taller than the digits in it: the ink is about 0.6 of it
        const h = Math.min(a.y + a.height * 0.3, b.y + b.height * 0.3) - Math.max(a.y - a.height * 0.3, b.y - b.height * 0.3);
        if (w > 1 && h > 1) problems.push(`${where}: ${partOf(a.key)} overlaps ${partOf(b.key)}`);
      }
    }
  }
  return { problems, blocks, blanks };
}


// ---------------------------------------------------------------------------------------------------------------------------------
// The input half: a real Chrome, a finger, a pen, keys

export interface InputScreen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}
export const INPUT_SCREENS: readonly InputScreen[] = [
  { name: '820x971', width: 820, height: 971, dpr: 2 },
  { name: '390x844', width: 390, height: 844, dpr: 3 },
];

export interface Started {
  readonly url: string;
  stop(): Promise<void>;
}

/** A server from the current build in a scratch folder of its own (under TMPDIR), on a port of CHECK_PORTS: BRAIN=replay unless `extra` says otherwise. */
export async function startMathsServer(extra: Readonly<Record<string, string>> = {}): Promise<Started> {
  const root = repoRoot();
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('there is no build to check: run "pnpm build" first');
  const scratch = await mkdtemp(join(tmpdir(), 'conduit-maths-'));
  await mkdir(join(scratch, 'skills'), { recursive: true });
  const port = await claimPort('a maths server');
  let log = '';
  const child: ChildProcess = spawnTracked(process.execPath, ['--import', 'tsx', 'src/main.ts'], undefined, {
    cwd: join(root, 'server'),
    env: { NODE_ENV: 'production', BRAIN: 'replay', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: join(scratch, 'data'), SKILL_ROOTS: join(scratch, 'skills'), LIBRARY: 'seed', READ_LINKS: 'off', LOG_LEVEL: 'warn', REPLAY_CPS: '3000', ...extra },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => (log = (log + chunk.toString()).slice(-4000)));
  const url = `http://127.0.0.1:${port}`;
  const stopAll = async (): Promise<void> => {
    await stop(child);
    releasePort(port);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitFor('the maths server', 60_000, async () => {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}:\n${log}`);
      return (await fetch(`${url}/api/health`)).ok ? true : null;
    });
  } catch (error) {
    await stopAll();
    throw new Error(`the server did not start: ${error instanceof Error ? error.message : String(error)}\n${log}`);
  }
  return { url, stop: stopAll };
}

interface CellView {
  readonly part: string;
  readonly label: string;
  readonly box: { x: number; y: number; width: number; height: number };
  readonly value: string;
  readonly by: string;
  readonly mark: string;
  readonly optional: boolean;
  readonly order: number | null;
  readonly lit: boolean;
  readonly active: boolean;
  readonly read: string;
  readonly reading: boolean;
  readonly ink: boolean;
  readonly dim: boolean;
  readonly clear: { x: number; y: number; width: number; height: number } | null;
}
interface BlockView {
  readonly key: string;
  readonly id: string;
  readonly verdict: string;
  readonly cells: CellView[];
  readonly buttons: { name: string; label: string; box: { x: number; y: number; width: number; height: number } }[];
  readonly hint: string;
}

const KEY_CODES: Readonly<Record<string, { readonly vk: number; readonly text?: string }>> = {
  Backspace: { vk: 8 },
  Tab: { vk: 9 },
  Enter: { vk: 13, text: '\r' },
  ArrowLeft: { vk: 37 },
  ArrowUp: { vk: 38 },
  ArrowRight: { vk: 39 },
  ArrowDown: { vk: 40 },
};

/** One tab on the page, with the hands that work it. */
export class MathsTab {
  readonly hands: Hands;
  private constructor(readonly tab: Tab, readonly conv: Conversation, readonly screen: InputScreen) {
    this.hands = new Hands(tab);
  }

  static async open(base: string, screen: InputScreen, dir: string, timeoutMs: number): Promise<MathsTab> {
    const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
    const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
    const conv = new Conversation(tab, options, { name: screen.name, width: screen.width, height: screen.height }, dir);
    await tab.send('DOM.enable');
    await conv.start();
    const mine = new MathsTab(tab, conv, screen);
    // what had the focus at the moment each pointer-up had been handled: a phone raises its keyboard only for a focus made inside the gesture
    await tab.eval(`window.__upFocus = []; document.addEventListener('pointerup', () => { const a = document.activeElement; window.__upFocus.push(a && a.dataset && a.dataset.mathCell ? a.dataset.mathCell : ''); })`);
    return mine;
  }

  async play(script: string): Promise<string> {
    const played = await this.tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
    return played !== null ? `the script would not play: ${played}` : this.conv.rest(true);
  }

  blocks(): Promise<BlockView[]> {
    return this.tab.eval<BlockView[]>('window.__stage.maths()');
  }

  async block(id: string): Promise<BlockView | undefined> {
    return (await this.blocks()).find((candidate) => candidate.id === id);
  }

  async cell(id: string, part: string): Promise<CellView | undefined> {
    return (await this.block(id))?.cells.find((cell) => cell.part === part);
  }

  /** the middle of a cell or button as the screen has it */
  async centre(box: { x: number; y: number; width: number; height: number }, at = { x: 0.5, y: 0.5 }): Promise<Point> {
    return this.hands.onScreen({ x: box.x + box.width * at.x, y: box.y + box.height * at.y });
  }

  focused(): Promise<string> {
    return this.tab.eval<string>(`(() => { const a = document.activeElement; return a && a.dataset && a.dataset.mathCell ? a.dataset.mathCell : ''; })()`);
  }

  upFocus(): Promise<string[]> {
    return this.tab.eval<string[]>('window.__upFocus.splice(0)');
  }

  blur(): Promise<unknown> {
    return this.tab.eval('document.activeElement && document.activeElement.blur()');
  }

  /** a key, as the browser gets it from a keyboard (a digit types it) */
  async press(key: string, modifiers = 0): Promise<void> {
    const known = KEY_CODES[key];
    const down = known === undefined ? { type: 'keyDown', key, code: /^\d$/.test(key) ? `Digit${key}` : key, text: key, unmodifiedText: key, windowsVirtualKeyCode: key.charCodeAt(0), modifiers } : { type: known.text === undefined ? 'rawKeyDown' : 'keyDown', key, code: key, windowsVirtualKeyCode: known.vk, modifiers, ...(known.text === undefined ? {} : { text: known.text, unmodifiedText: known.text }) };
    await this.tab.send('Input.dispatchKeyEvent', down);
    await this.tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: down.code, windowsVirtualKeyCode: down.windowsVirtualKeyCode, modifiers });
    await sleep(120);
  }

  async type(text: string): Promise<void> {
    for (const character of text) await this.press(character);
  }

  /** the acts the page told the brain, as text */
  acts(): Promise<string[]> {
    return this.tab.eval<string[]>(`window.__stage.events().filter((e) => e.type === 'control' && e.ask === true).map((e) => e.text)`);
  }

  async shot(dir: string, name: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), Buffer.from((await this.tab.shot()).split(',')[1] ?? '', 'base64'));
    return name;
  }

  close(): Promise<void> {
    return this.tab.close();
  }
}

export const SUM = ['scene layout=stack mood=calm', 'math m1 column | 12+12+12+12+12+12'].join('\n');

/** What this screen's keys, hint and fill checks found, as problems by check. */
interface Problems {
  readonly [check: string]: string[];
}

/** The keyboard: a finger tap focuses a cell inside the gesture, digits walk the sum in working order, Backspace, Tab and the arrows, Enter marks it, the keyboard never covers the cell. */
async function keysScene(mine: MathsTab, dir: string, problems: Problems): Promise<string> {
  const list = problems['keys'] as string[];
  const { screen } = mine;
  const played = await mine.play(SUM);
  if (played !== '') {
    list.push(played);
    return '';
  }
  const block = await mine.block('m1');
  if (block === undefined) {
    list.push('the sum has no cells to write in');
    return '';
  }
  const order = [...block.cells].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map((cell) => cell.part);
  if (order.join(',') !== 'ans-ones,carry-tens,ans-tens') list.push(`the working order is ${order.join(',')}, wanted ans-ones,carry-tens,ans-tens`);
  for (const cell of block.cells) if (cell.box.width < 43.9 || cell.box.height < 43.9) list.push(`${cell.part} takes a finger on ${cell.box.width.toFixed(0)}x${cell.box.height.toFixed(0)}, under 44`);
  // the real inputs stand exactly on their cells
  const fields = await mine.tab.eval<{ part: string; x: number; y: number; w: number; h: number; mode: string; max: number; auto: string }[]>(`[...document.querySelectorAll('input[data-math-cell]')].map((n) => { const r = n.getBoundingClientRect(); const o = document.getElementById('stage').getBoundingClientRect(); return { part: n.dataset.mathCell, x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height, mode: n.inputMode, max: n.maxLength, auto: n.autocomplete }; })`);
  for (const cell of block.cells) {
    const field = fields.find((candidate) => candidate.part === cell.part);
    if (field === undefined) list.push(`no real input over ${cell.part}`);
    else {
      if (Math.abs(field.x - cell.box.x) > 1 || Math.abs(field.y - cell.box.y) > 1 || Math.abs(field.w - cell.box.width) > 1 || Math.abs(field.h - cell.box.height) > 1) list.push(`the input over ${cell.part} (${field.x.toFixed(0)},${field.y.toFixed(0)} ${field.w.toFixed(0)}x${field.h.toFixed(0)}) is not on its cell (${cell.box.x.toFixed(0)},${cell.box.y.toFixed(0)} ${cell.box.width.toFixed(0)}x${cell.box.height.toFixed(0)})`);
      if (field.mode !== 'numeric' || field.max !== 1 || field.auto !== 'off') list.push(`${cell.part} is inputmode=${field.mode} maxlength=${field.max} autocomplete=${field.auto}, wanted numeric, 1, off`);
    }
  }
  // 1. a finger tap on the first cell: the focus is on its input at the moment the finger lifts
  await mine.upFocus();
  const ones = block.cells.find((cell) => cell.part === 'ans-ones') as CellView;
  await mine.hands.finger([await mine.centre(ones.box)]);
  const got = await mine.focused();
  const inGesture = (await mine.upFocus()).includes('ans-ones');
  if (got !== 'ans-ones') list.push(`a finger tap on the ones cell focused "${got || 'nothing'}": no keyboard would open`);
  else if (!inGesture) list.push('the focus came after the tap, not inside it: a phone would not raise its keyboard');
  // 2. typing 2 goes to the carry, 1 to the tens, 7 stays there (no cell after it)
  await mine.press('2');
  if ((await mine.focused()) !== 'carry-tens') list.push(`after typing 2 in the ones the keyboard is in "${await mine.focused()}", wanted carry-tens`);
  await mine.press('1');
  if ((await mine.focused()) !== 'ans-tens') list.push(`after typing 1 in the carry the keyboard is in "${await mine.focused()}", wanted ans-tens`);
  const typing = await mine.shot(dir, `${screen.name}-maths-typing.png`);
  const held = await mine.block('m1');
  const values = held?.cells.map((cell) => `${cell.part}=${cell.value}`).join(' ');
  if (values !== 'ans-ones=2 carry-tens=1 ans-tens=') list.push(`typed 2 and 1, the cells hold "${values}"`);
  // 3. Backspace on an empty cell goes back (and takes the digit off the cell it goes to); Tab follows working order; the arrows follow the grid
  await mine.press('Backspace');
  if ((await mine.focused()) !== 'carry-tens' || (await mine.cell('m1', 'carry-tens'))?.value !== '') list.push(`Backspace on an empty tens cell went to "${await mine.focused()}" and left the carry "${(await mine.cell('m1', 'carry-tens'))?.value}"`);
  await mine.press('Tab');
  if ((await mine.focused()) !== 'ans-tens') list.push(`Tab from the carry went to "${await mine.focused()}", wanted ans-tens`);
  await mine.press('Tab', 8);
  if ((await mine.focused()) !== 'carry-tens') list.push(`Shift+Tab from the tens went to "${await mine.focused()}", wanted carry-tens`);
  await mine.press('ArrowDown');
  if ((await mine.focused()) !== 'ans-tens') list.push(`ArrowDown from the carry went to "${await mine.focused()}", wanted ans-tens (the cell below it)`);
  await mine.press('ArrowRight');
  if ((await mine.focused()) !== 'ans-ones') list.push(`ArrowRight from the tens went to "${await mine.focused()}", wanted ans-ones`);
  await mine.press('ArrowLeft');
  if ((await mine.focused()) !== 'ans-tens') list.push(`ArrowLeft from the ones went to "${await mine.focused()}", wanted ans-tens`);
  await mine.press('ArrowUp');
  if ((await mine.focused()) !== 'carry-tens') list.push(`ArrowUp from the tens went to "${await mine.focused()}", wanted carry-tens`);
  // 4. the keyboard never covers the cell: under a short visual viewport the active cell is lifted into view, and put back when the keyboard goes
  await mine.press('Tab');
  const before = await mine.tab.eval<{ top: number; bottom: number }>(`(() => { const r = document.activeElement.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
  const short = Math.round(before.top + 24);
  await mine.tab.eval(`(() => { const vv = window.visualViewport; Object.defineProperty(vv, 'height', { configurable: true, get: () => ${short} }); vv.dispatchEvent(new Event('resize')); })()`);
  await sleep(200);
  const lifted = await mine.tab.eval<{ top: number; bottom: number }>(`(() => { const r = document.activeElement.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
  if (lifted.bottom > short - 8 + 1 || lifted.top < 0) list.push(`under a visual viewport ${short}px tall the active cell stands at ${lifted.top.toFixed(0)}..${lifted.bottom.toFixed(0)}: the keyboard would cover it`);
  await mine.tab.eval(`(() => { const vv = window.visualViewport; delete vv.height; vv.dispatchEvent(new Event('resize')); })()`);
  await mine.blur();
  await sleep(200);
  const back = await mine.tab.eval<string>(`document.getElementById('stage').style.transform`);
  if (back !== '') list.push(`the page stays lifted (${back}) after the keyboard has gone`);
  // 5. Enter marks: the right digits are ticked, and the brain is told in one act
  await mine.hands.finger([await mine.centre(ones.box)]);
  await mine.type('212');
  await mine.press('Enter');
  const marked = await mine.block('m1');
  const marks = marked?.cells.map((cell) => `${cell.part}=${cell.mark}`).join(' ');
  if (marks !== 'ans-ones=right carry-tens=right ans-tens=wrong') list.push(`after typing 2, 1, 2 and Enter the marks are "${marks}"`);
  const acts = await mine.acts();
  if (!acts.some((act) => /^m1: ones right, carry tens right, tens wrong \(2\)$/.test(act))) list.push(`the brain was told ${JSON.stringify(acts)}, wanted one act "m1: ones right, carry tens right, tens wrong (2)"`);
  return typing;
}


/** Hint lights the next cell and says its step without its digit; Show me is offered only after a wrong try, fills one cell and marks it as shown. Checked at 820x971 and read in the screenshots. */
async function hintScene(mine: MathsTab, dir: string, problems: Problems): Promise<{ readonly checked: string; readonly hinted: string }> {
  const list = problems['hint'] as string[];
  const { screen } = mine;
  const press = async (name: string): Promise<boolean> => {
    const button = (await mine.block('m2'))?.buttons.find((candidate) => candidate.name === name);
    if (button === undefined) return false;
    await mine.hands.finger([await mine.centre(button.box)]);
    return true;
  };
  const played = await mine.play(['scene layout=stack mood=calm', 'math m2 column | 12+12+12+12+12+12'].join('\n'));
  if (played !== '') {
    list.push(played);
    return { checked: '', hinted: '' };
  }
  const names = (await mine.block('m2'))?.buttons.map((button) => button.name).join(',');
  if (names !== 'check,hint') list.push(`before any try the buttons are "${names}", wanted check,hint (Show me comes only after a wrong try)`);
  // a wrong try: the tens left empty is ringed (not wrong), the ones written wrong is crossed
  await mine.hands.finger([await mine.centre((await mine.cell('m2', 'ans-ones'))?.box ?? { x: 0, y: 0, width: 1, height: 1 })]);
  await mine.type('9');
  if (!(await press('check'))) list.push('no Check button');
  await sleep(250);
  const marked = (await mine.block('m2'))?.cells.map((cell) => `${cell.part}=${cell.mark}`).join(' ');
  if (marked !== 'ans-ones=wrong carry-tens= ans-tens=empty') list.push(`after a 9 in the ones and Check the marks are "${marked}", wanted the ones crossed, the carry left alone and the tens ringed`);
  const checked = await mine.shot(dir, `${screen.name}-maths-checked.png`);
  const acts = await mine.acts();
  if (!acts.some((act) => act === 'm2: ones wrong (9), tens empty')) list.push(`the brain was told ${JSON.stringify(acts.slice(-3))}, wanted "m2: ones wrong (9), tens empty"`);
  if (!(await mine.block('m2'))?.buttons.some((button) => button.name === 'show')) list.push('Show me was not offered after a wrong try');
  // Hint: the first cell not yet right, in working order (the ones), and its step in words, never the digit it takes
  if (!(await press('hint'))) list.push('no Hint button');
  await sleep(250);
  const after = await mine.block('m2');
  const lit = after?.cells.filter((cell) => cell.lit).map((cell) => cell.part).join(',');
  if (lit !== 'ans-ones') list.push(`Hint lit "${lit}", wanted ans-ones`);
  const words = after?.hint ?? '';
  if (!/ones/.test(words) || !/2\+2\+2\+2\+2\+2/.test(words)) list.push(`the hint says "${words}", wanted the step in words ("add the ones: 2+2+2+2+2+2")`);
  if (/\b72\b|=|\b12\b/.test(words)) list.push(`the hint "${words}" gives the answer away`);
  const hinted = await mine.shot(dir, `${screen.name}-maths-hint.png`);
  // Show me fills one cell, in working order, marked as shown
  if (!(await press('show'))) list.push('no Show me button');
  await sleep(250);
  const shown = (await mine.block('m2'))?.cells.map((cell) => `${cell.part}=${cell.value}:${cell.by}:${cell.mark}`).join(' ');
  if (shown !== 'ans-ones=2:shown:shown carry-tens=:: ans-tens=::empty') list.push(`after Show me the cells are "${shown}", wanted only the ones filled (2) as shown`);
  return { checked, hinted };
}

/** `fill m1 | 72` and `fill m1.ans-ones | 2` put digits in the cells, once, marked as a Check marks them; a hand after a fill wins. */
async function fillScene(mine: MathsTab, problems: Problems): Promise<void> {
  const list = problems['fill'] as string[];
  const first = await mine.play([SUM, 'fill m1 | 72'].join('\n'));
  if (first !== '') return void list.push(first);
  const whole = (await mine.block('m1'))?.cells.map((cell) => `${cell.part}=${cell.value}:${cell.by}:${cell.mark}`).join(' ');
  if (whole !== 'ans-ones=2:fill:right carry-tens=:: ans-tens=7:fill:right') list.push(`fill m1 | 72 left the cells "${whole}"`);
  if ((await mine.block('m1'))?.verdict !== 'right') list.push(`after a right fill the sum is "${(await mine.block('m1'))?.verdict}", wanted right`);
  const second = await mine.play(['scene layout=stack mood=calm', 'math m3 column | 12+12', 'fill m3.ans-ones | 9', 'fill m3.ans-tens | 2'].join('\n'));
  if (second !== '') return void list.push(second);
  const part = (await mine.block('m3'))?.cells.map((cell) => `${cell.part}=${cell.value}:${cell.mark}`).join(' ');
  if (part !== 'ans-ones=9:wrong ans-tens=2:right') list.push(`fill m3.ans-ones | 9 and fill m3.ans-tens | 2 left "${part}", wanted the ones wrong and the tens right`);
  // a hand that writes after the fill wins: the 4 typed over the filled 9
  const ones = (await mine.cell('m3', 'ans-ones'))?.box;
  if (ones !== undefined) {
    await mine.hands.finger([await mine.centre(ones)]);
    await mine.press('4');
    const now = await mine.cell('m3', 'ans-ones');
    if (now?.value !== '4' || now.by !== 'key' || now.mark !== '') list.push(`a 4 typed over a filled 9 left "${now?.value}" by ${now?.by} marked "${now?.mark}"`);
  }
}

/** One screen's whole input run. */
async function inputScreen(base: string, screen: InputScreen, dir: string, timeoutMs: number, note: (text: string) => void): Promise<{ results: CheckResult[]; pictures: string[] }> {
  const problems: Problems = { keys: [], hint: [], fill: [] };
  const pictures: string[] = [];
  note(`maths input: ${screen.name}`);
  const mine = await MathsTab.open(base, screen, dir, timeoutMs);
  try {
    pictures.push(await keysScene(mine, dir, problems));
    const { checked, hinted } = await hintScene(mine, dir, problems);
    pictures.push(checked, hinted);
    await fillScene(mine, problems);
  } catch (error) {
    (problems['keys'] as string[]).push(`stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    await mine.close();
  }
  const results: CheckResult[] = [];
  const add = (name: string, good: string): void => {
    const list = problems[name] ?? [];
    results.push({ turn: 0, check: `maths-${name}-${screen.name}`, verdict: list.length === 0 ? 'PASS' : 'FAIL', detail: list.length === 0 ? good : list.slice(0, 8).join('; ') });
  };
  add('keys', 'a finger tap focuses a cell inside the gesture; 2 moves to the carry then the tens; Backspace, Tab and the arrows walk the sum; Enter marks it; the active cell stays above a short visual viewport');
  add('hint', 'Hint lights the next cell and says its step without its digit; Show me comes only after a wrong try and fills one cell as shown');
  add('fill', 'fill m1 | 72 and fill m1.ans-ones | 2 put marked digits in the cells, and a later hand wins');
  return { results, pictures };
}

/** The input half of the group: its own server, a tab per screen. Failures are `FAIL` results, never throws. */
export async function mathsInputGroup(dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  let server: Started | null = null;
  const results: CheckResult[] = [];
  try {
    server = await startMathsServer({ INK_READER: 'fake' });
    for (const screen of INPUT_SCREENS) results.push(...(await inputScreen(server.url, screen, dir, timeoutMs, note)).results);
  } catch (error) {
    results.push({ turn: 0, check: 'maths-input', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` });
  } finally {
    await server?.stop();
  }
  return results;
}

/** The group as `pnpm check` runs it: the layout (no browser), then the input half (a real Chrome). */
export async function mathsGroup(note: (text: string) => void = () => undefined, dir = join(tmpdir(), 'conduit-maths-out'), timeoutMs = 90_000): Promise<CheckResult[]> {
  note('maths');
  const results: CheckResult[] = [];
  try {
    const { problems, blocks, blanks } = mathProblems(await capture());
    results.push({ turn: 0, check: 'maths-layout', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? `${blocks} blocks at three screens: one x a place, ${blanks} blanks at least 44 and empty, no answer painted, the rule spans the columns, nothing overlaps` : problems.slice(0, 12).join('; ') });
  } catch (error) {
    results.push({ turn: 0, check: 'maths-layout', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` });
  }
  results.push(...(await mathsInputGroup(dir, timeoutMs, note)));
  return results;
}

if (process.argv[1] !== undefined && /math-check\.ts$/.test(process.argv[1])) {
  const out = process.argv.includes('--out') ? (process.argv[process.argv.indexOf('--out') + 1] as string) : join(tmpdir(), 'conduit-maths-out');
  mathsGroup((text) => process.stdout.write(`${text}\n`), out).then((results) => {
    for (const result of results) process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
    process.exit(results.every((result) => result.verdict === 'PASS') ? 0 : 1);
  });
}
