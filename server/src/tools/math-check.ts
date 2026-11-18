// pnpm check's maths group: written methods laid out on the page's own painter, and the painted boxes read back. No model, no browser.
//
//   place      the digits of one place share one x (within a pixel), across every row and the answer row
//   blanks     every blank is a box of at least 44 on each side, with nothing written in it
//   sealed     with the answer blank, no painted word is the answer (or any cell of the answer row)
//   fill       `fill` writes its digits into the blanks, by place
//   rule       the rule spans every column of the sum
//   clear      no two cells overlap, and the block is on the screen
//   no marks   nothing of the app's own checking is painted: no Check, Hint or Show me, no tick, cross or ring, no line of hint, no digit read from the pen (owner: write, then send)
//
// The page's half is `web/src/bench/math-bench.ts` (the real painter, a renderer that keeps the last frame). Run by `pnpm check` and standalone (`tsx math-check.ts`).
//
// The input half is worked in a real headless Chrome with a real finger, a real pen and real keys, at 820x971 (dpr 2) and 390x844 (dpr 3), on a server
// this group starts itself (BRAIN=replay: no model):
//
//   keys    a finger tap focuses a cell inside the gesture; `2` moves to the carry then the tens; Backspace, Tab and the arrows walk the sum; Enter puts the keyboard away and
//           marks nothing; under a stubbed short visual viewport the active cell stays in view
//   fill    `fill m1 | 72` and `fill m1.ans-ones | 2` put digits in the cells, unmarked
//   pen     (M4) a pen stroke with Draw closed is one stroke owned by its cell; across two cells it goes to the larger share; a finger drag leaves no ink; nothing is read; a
//           typed digit over the ink dims it, and the ✕ takes it off
//   send    fb-104 (owner: write, then send). Pen-write in an answer box and press Send: one drawing turn goes up, on the sum's id, with every stroke; no reader request is
//           made, and no Check or Hint is in the page or the painter

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
import { Hands, line } from './lens-check';
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
    // 4a. no marks (fb-104, owner: write, then send): nothing of the app's own checking is painted, whatever was typed or filled: no Check, Hint or Show me button or its words,
    // no line of hint, no digit read from the pen, no tick, cross or ring, no tint of a cell found wrong, lit by a hint or being read
    const checking = [...figures.map((f) => partOf(f.key)), ...elements.map((e) => partOf(e.key))].filter((name) => /^(btn:|bt:|ok:|bad:|hint$|r:|mark:(wrong|hint|reading)-)/.test(name));
    if (checking.length > 0) problems.push(`${where}: the app's own checking is painted (${[...new Set(checking)].join(', ')})`);
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
  // fb-104. What is written on a sum goes up as a drawing turn: the replay brain answers it with a pause, so the page holds as it was (each turn once a session, so many)
  const acts = join(scratch, 'acts.json');
  await writeFile(acts, JSON.stringify({ turns: Array.from({ length: 300 }, () => ({ match: 'Please look at what I drew.', script: 'wait 0.2s' })) }));
  let log = '';
  const child: ChildProcess = spawnTracked(process.execPath, ['--import', 'tsx', 'src/main.ts'], undefined, {
    cwd: join(root, 'server'),
    env: { NODE_ENV: 'production', BRAIN: 'replay', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: join(scratch, 'data'), SKILL_ROOTS: join(scratch, 'skills'), LIBRARY: 'seed', READ_LINKS: 'off', LOG_LEVEL: 'warn', REPLAY_CPS: '3000', REPLAY_CASE: acts, ...extra },
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
  readonly optional: boolean;
  readonly order: number | null;
  readonly active: boolean;
  readonly ink: boolean;
  readonly dim: boolean;
  readonly clear: { x: number; y: number; width: number; height: number } | null;
}
interface BlockView {
  readonly key: string;
  readonly id: string;
  readonly box: { x: number; y: number; width: number; height: number };
  readonly cells: CellView[];
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

  static async open(base: string, screen: InputScreen, dir: string, timeoutMs: number, page = ''): Promise<MathsTab> {
    const tab = await Tab.open(screen.width, screen.height, { dpr: screen.dpr, touch: true });
    const options: Options = { url: base, screens: [], out: dir, turns: new Set(), timeoutMs, parallel: false, demo: false, quiet: true, page, say: null, chat: 'off' };
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

  /** the acts the page told the brain, as text: none now, a written method tells the brain nothing of its own (fb-104) */
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

/** What this screen's keys, fill, pen and send checks found, as problems by check. */
interface Problems {
  readonly [check: string]: string[];
}

/** The keyboard: a finger tap focuses a cell inside the gesture, digits walk the sum in working order, Backspace, Tab and the arrows, Enter puts the keyboard away and marks nothing, the keyboard never covers the cell. */
async function keysScene(mine: MathsTab, dir: string, problems: Problems): Promise<string[]> {
  const list = problems['keys'] as string[];
  const { screen } = mine;
  const played = await mine.play(SUM);
  if (played !== '') {
    list.push(played);
    return [];
  }
  const block = await mine.block('m1');
  if (block === undefined) {
    list.push('the sum has no cells to write in');
    return [];
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
  // 5. Enter is the keyboard's Done: it goes, and nothing is marked or told (fb-104: the person writes, then sends). A finger on a cell is not also "the user pointed at" the sum (fb-093)
  await mine.hands.finger([await mine.centre(ones.box)]);
  // a tap on a machine busy with other groups can be lost to the browser's own gesture handling: once more, as a person would
  if ((await mine.focused()) === '') {
    (problems['notes'] as string[]).push(`maths-keys tap retried at ${screen.name}`);
    await sleep(400);
    await mine.hands.finger([await mine.centre(ones.box)]);
  }
  await mine.type('212');
  const typed = await mine.shot(dir, `${screen.name}-maths-typed.png`);
  await mine.press('Enter');
  await sleep(200);
  if ((await mine.focused()) !== '') list.push(`Enter left the keyboard in "${await mine.focused()}", wanted it put away`);
  const kept = (await mine.block('m1'))?.cells.map((cell) => `${cell.part}=${cell.value}`).join(' ');
  if (kept !== 'ans-ones=2 carry-tens=1 ans-tens=2') list.push(`after typing 2, 1, 2 and Enter the cells hold "${kept}"`);
  const acts = await mine.acts();
  if (acts.length !== 0) list.push(`the brain was told ${JSON.stringify(acts)} of the typing, wanted nothing: a written method tells it nothing of its own`);
  const pointed = await mine.tab.eval<number>(`window.__stage.events().filter((e) => e.type === 'tap' && e.id === 'm1').length`);
  if (pointed !== 0) list.push(`${pointed} finger press(es) on the written method were also told as taps on it ("the user pointed at m1"), wanted none`);
  await mine.blur();
  await sleep(200);
  return [typing, typed];
}


/**
 * fb-104 (owner: write, then send). A sum is written on with the pen and sent: pen-write 344 into 43 x 8's boxes and press the ink bar's Send. Exactly one drawing turn goes
 * up, with `on.element` the sum's id, the strokes counted right and the picture of the stage with the writing on it; no handwriting read is asked for, and neither Check, Hint
 * nor Show me is in the page or in what the painter says the block has. The picture the model is given is saved to look at.
 */
async function sendScene(mine: MathsTab, dir: string, problems: Problems): Promise<string> {
  const list = problems['send'] as string[];
  const { tab, hands, screen } = mine;
  // (what the scenes before this one wrote is still on the layer: the drawing starts empty here)
  await tab.eval('window.__inkClear()');
  await mine.blur();
  const played = await mine.play(['scene layout=stack mood=calm', 'math m9 times | 43 × 8'].join('\n'));
  if (played !== '') {
    list.push(played);
    return '';
  }
  const block = await mine.block('m9');
  if (block === undefined) {
    list.push('43 × 8 has no cells to write in');
    return '';
  }
  // 1. nothing of the app's own checking: not in the painter's account of the block, not a button or a label in the page
  if ('buttons' in block || 'hint' in block || 'verdict' in block) list.push(`the painter still says the block has ${['buttons', 'hint', 'verdict'].filter((name) => name in block).join(', ')}`);
  const checking = await tab.eval<string[]>(`[...document.querySelectorAll('button, [role="button"], [aria-label]')].map((n) => ((n.textContent || '') + '|' + (n.getAttribute('aria-label') || '')).trim()).filter((t) => /(^|\\|)\\s*(check|hint|show me)\\b/i.test(t))`);
  if (checking.length > 0) list.push(`Check, Hint or Show me is in the page: ${JSON.stringify(checking.slice(0, 4))}`);
  // 2. what leaves the page is watched: every fetch, and every turn
  await tab.eval(`window.__fetched = []; const was = window.fetch; window.fetch = function (input, init) { try { window.__fetched.push((init && init.method || 'GET') + ' ' + String(input && input.url || input)); } catch (e) {} return was.apply(this, arguments); }`);
  const turnsBefore = tab.posted.length;
  const stroke = async (part: string, from: [number, number], to: [number, number], n = 10): Promise<void> => {
    const box = (await mine.cell('m9', part))?.box;
    if (box === undefined) throw new Error(`no cell m9.${part}`);
    await hands.pen(line(await mine.centre(box, { x: from[0], y: from[1] }), await mine.centre(box, { x: to[0], y: to[1] }), n));
  };
  // 3. 344, as a child might: a 3 in the ones' column is a bar and a curve (two strokes), a 4 in the tens two (one down, one across), another 3 in the hundreds one
  const parts = block.cells.map((cell) => cell.part).filter((part) => /^ans-/.test(part));
  const [ones, tens, hundreds] = ['ans-ones', 'ans-tens', 'ans-hundreds'];
  if (!parts.includes(ones as string) || !parts.includes(tens as string) || !parts.includes(hundreds as string)) {
    list.push(`43 × 8 has the answer boxes ${parts.join(', ')}, wanted ans-ones, ans-tens and ans-hundreds`);
    return '';
  }
  const written: [string, [number, number], [number, number]][] = [
    [ones as string, [0.3, 0.2], [0.7, 0.3]],
    [ones as string, [0.7, 0.3], [0.4, 0.8]],
    [tens as string, [0.3, 0.15], [0.3, 0.8]],
    [tens as string, [0.2, 0.55], [0.8, 0.55]],
    [hundreds as string, [0.3, 0.2], [0.7, 0.8]],
  ];
  for (const [part, from, to] of written) await stroke(part, from, to);
  const here = await tab.eval<number>('window.__penWrite ? window.__penWrite.owners().filter((o) => o.key.startsWith("m9")).length : -1');
  if (here !== written.length) list.push(`${written.length} pen strokes in the answer boxes are ${here} owned by the sum`);
  const picture = await mine.shot(dir, `${screen.name}-maths-written.png`);
  // 4. a Send is on the screen with the writing (the ink bar's, and on a phone, where that bar is folded behind its pen, the prompt bar's, which is enabled for ink alone): it was
  // hidden for strokes in a sum's boxes before. Nothing has gone up, and nothing has been read
  const button = await tab.eval<{ x: number; y: number; which: string } | null>(`(() => {
    const seen = (b) => { if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.closest('[hidden]') && !b.disabled ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; };
    const ink = seen(document.querySelector('.ink-btn--send'));
    if (ink) return Object.assign(ink, { which: 'the ink bar' });
    const prompt = seen(document.querySelector('.prompt__button'));
    return prompt ? Object.assign(prompt, { which: 'the prompt bar' }) : null;
  })()`);
  if (button === null) {
    list.push('the strokes written in the sum leave no Send on the screen');
    return picture;
  }
  if (tab.posted.length !== turnsBefore) list.push('a turn went up before Send was pressed');
  // a finger that comes within half a second of the pen is a palm: the wait is the guard's grace
  await sleep(700);
  await hands.finger([{ x: button.x, y: button.y }]);
  await waitFor('the drawing turn', 10_000, async () => (tab.posted.length > turnsBefore ? true : null)).catch(() => undefined);
  await sleep(600);
  const turns = tab.posted.slice(turnsBefore);
  if (turns.length !== 1) {
    list.push(`Send posted ${turns.length} turn(s) (${JSON.stringify(turns.map((turn) => `${turn.kind}:${turn.text}`))}), wanted exactly one`);
    return picture;
  }
  const sent = JSON.parse(turns[0]?.body ?? '{}') as { input?: { kind?: string; text?: string; marks?: { image?: string; on?: { element?: string; node?: string }; strokes?: unknown[]; regions?: unknown[] } } };
  const marks = sent.input?.marks;
  if (sent.input?.kind !== 'prompt') list.push(`the turn is a ${sent.input?.kind}, wanted a drawing turn (a prompt with marks)`);
  if (sent.input?.text !== 'Please look at what I drew.') list.push(`the words are "${sent.input?.text}", wanted Draw's own`);
  if (marks === undefined) list.push('the turn carries no marks (the picture and the strokes)');
  else {
    if (marks.on?.element !== 'm9') list.push(`the ink says it was drawn on element "${marks.on?.element}", wanted the sum's id m9`);
    if ((marks.strokes ?? []).length !== written.length) list.push(`the turn carries ${(marks.strokes ?? []).length} strokes, wanted ${written.length}`);
    if (!/^u[1-9][0-9]*$/.test(marks.image ?? '')) list.push(`the picture is "${marks.image}", wanted an upload id`);
  }
  // 5. what the model is shown: the picture of the stage with the writing on it, kept to be looked at (the stage's own digits and boxes under the ink, not ink on white)
  const picked = marks?.image;
  if (picked !== undefined && /^u[1-9][0-9]*$/.test(picked)) {
    const kept = await fetch(String(turns[0]?.url ?? '').replace(/\/turns$/, `/uploads/${picked}`)).catch(() => null);
    if (kept === null || !kept.ok) list.push(`the picture ${picked} the turn carries was not kept by the server`);
    else await writeFile(join(dir, `${screen.name}-maths-sent.png`), Buffer.from(await kept.arrayBuffer()));
  }
  const fetched = await tab.eval<string[]>('window.__fetched');
  const reads = fetched.filter((request) => /read-ink/.test(request));
  if (reads.length > 0) list.push(`a handwriting read was asked for: ${JSON.stringify(reads)}`);
  if ((await tab.eval<number>('(window.__mathReads || []).length')) !== 0) list.push('the page logged a handwriting read');
  // 6. the writing went up with the turn: none is left on the stage, and the sum is still there to be answered on
  if ((await hands.strokes())?.strokes.length !== 0) list.push(`${(await hands.strokes())?.strokes.length} stroke(s) are still on the stage after Send`);
  if ((await mine.acts()).length !== 0) list.push(`the brain was also told ${JSON.stringify(await mine.acts())} as an act`);
  return picture;
}

/** `fill m1 | 72` and `fill m1.ans-ones | 2` put digits in the cells, once, and mark nothing; a hand after a fill wins. */
async function fillScene(mine: MathsTab, problems: Problems): Promise<void> {
  const list = problems['fill'] as string[];
  const first = await mine.play([SUM, 'fill m1 | 72'].join('\n'));
  if (first !== '') return void list.push(first);
  const whole = (await mine.block('m1'))?.cells.map((cell) => `${cell.part}=${cell.value}:${cell.by}`).join(' ');
  if (whole !== 'ans-ones=2:fill carry-tens=: ans-tens=7:fill') list.push(`fill m1 | 72 left the cells "${whole}"`);
  const second = await mine.play(['scene layout=stack mood=calm', 'math m3 column | 12+12', 'fill m3.ans-ones | 9', 'fill m3.ans-tens | 2'].join('\n'));
  if (second !== '') return void list.push(second);
  const part = (await mine.block('m3'))?.cells.map((cell) => `${cell.part}=${cell.value}`).join(' ');
  if (part !== 'ans-ones=9 ans-tens=2') list.push(`fill m3.ans-ones | 9 and fill m3.ans-tens | 2 left "${part}", wanted both written as the line gave them (nothing says the 9 is wrong)`);
  // a hand that writes after the fill wins: the 4 typed over the filled 9
  const ones = (await mine.cell('m3', 'ans-ones'))?.box;
  if (ones !== undefined) {
    await mine.hands.finger([await mine.centre(ones)]);
    await mine.press('4');
    const now = await mine.cell('m3', 'ans-ones');
    if (now?.value !== '4' || now.by !== 'key') list.push(`a 4 typed over a filled 9 left "${now?.value}" by ${now?.by}`);
  }
}


interface PenHook {
  owners(): { stroke: string; key: string; part: string }[];
  free(): string[];
  colours(): string[];
}

/** The pen: no Draw, one stroke owned by its cell, the larger share wins, a finger leaves no ink, nothing is read, a typed digit over the ink dims it and the ✕ takes it off. */
async function penScene(mine: MathsTab, dir: string, problems: Problems): Promise<string> {
  const list = problems['pen'] as string[];
  const { tab, hands, screen } = mine;
  const owners = (): Promise<PenHook['owners'] extends () => infer R ? R : never> => tab.eval('window.__penWrite ? window.__penWrite.owners() : []');
  const strokes = async (): Promise<number> => (await hands.strokes())?.strokes.length ?? 0;
  const stroke = async (id: string, part: string, from: [number, number], to: [number, number], n = 10): Promise<void> => {
    const box = (await mine.cell(id, part))?.box;
    if (box === undefined) throw new Error(`no cell ${id}.${part}`);
    await hands.pen(line(await mine.centre(box, { x: from[0], y: from[1] }), await mine.centre(box, { x: to[0], y: to[1] }), n));
  };
  const wait = async (what: string, until: () => Promise<boolean>, ms = 6000): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (await until()) return true;
      await sleep(200);
    }
    list.push(`never: ${what}`);
    return false;
  };
  const played = await mine.play(['scene layout=stack mood=calm', 'math m4 column | 12+12'].join('\n'));
  if (played !== '') {
    list.push(played);
    return '';
  }
  if (await hands.drawToggle()) list.push('Draw is open at the start');
  // 0. no pen seen yet: a finger drag across the cells leaves no ink, and a short pen tap is a press (it focuses the cell and leaves no ink)
  const tens = (await mine.cell('m4', 'ans-tens'))?.box as { x: number; y: number; width: number; height: number };
  const ones = (await mine.cell('m4', 'ans-ones'))?.box as { x: number; y: number; width: number; height: number };
  await mine.upFocus();
  await hands.pen([await mine.centre(tens), await mine.centre(tens)]);
  if ((await strokes()) !== 0) list.push('a short pen tap on a cell left ink');
  if ((await mine.focused()) !== 'ans-tens') list.push(`a short pen tap on the tens cell focused "${(await mine.focused()) || 'nothing'}": a tap is still a press`);
  else if (!(await mine.upFocus()).includes('ans-tens')) list.push('the focus after a pen tap came after the tap, not inside it');
  await mine.blur();
  await hands.finger(line(await mine.centre(tens, { x: 0.1, y: 0.2 }), await mine.centre(ones, { x: 0.9, y: 0.8 }), 12));
  if ((await strokes()) !== 0) list.push(`a finger drag across the cells left ${await strokes()} stroke(s) of ink`);
  // a palm (a wide contact) is ignored once a pen has been seen: it does not take the keyboard
  const palm = await mine.centre(tens);
  await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: palm.x, y: palm.y, id: 1, radiusX: 80, radiusY: 80 }] });
  await sleep(60);
  await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  if ((await mine.focused()) !== '') list.push(`a palm (a contact 160 wide) took the keyboard into "${await mine.focused()}"`);
  // 1. a pen stroke with Draw closed is one stroke, owned by the cell it is in
  await stroke('m4', 'ans-tens', [0.25, 0.2], [0.75, 0.8]);
  if (await hands.drawToggle()) list.push('writing with the pen opened Draw');
  const first = await owners();
  if ((await strokes()) !== 1 || first.length !== 1 || first[0]?.part !== 'ans-tens') list.push(`one pen stroke in the tens cell is ${await strokes()} stroke(s), owned by ${JSON.stringify(first)}`);
  // 2. a stroke over two cells goes to the cell with the larger share: from the tens cell's middle across to well into the ones cell
  const tensCentre = tens.x + tens.width / 2;
  const reach = ones.x + ones.width * 0.8;
  await hands.pen(line(await hands.onScreen({ x: tensCentre, y: ones.y + ones.height / 2 }), await hands.onScreen({ x: reach, y: ones.y + ones.height / 2 }), 14));
  const second = await owners();
  if (second.length !== 2 || second[1]?.part !== 'ans-ones') list.push(`a stroke from the tens cell's middle to the ones cell's right is owned by "${second[1]?.part}", wanted ans-ones (the larger share)`);
  // 2b. ink on the sum's upper rows, inside no cell, is free working: a stroke on the stage, outside every cell (the pen writes only on a written method, and the ink bar is up by now
  // over the top of the stage, so the spot is the sum's own rows, which stand clear of it)
  const sum = (await mine.block('m4'))?.box as { x: number; y: number; width: number; height: number };
  const band = { x: sum.x + sum.width * 0.3, y: sum.y + sum.height * 0.42 };
  const drawn = await strokes();
  await hands.pen(line(await hands.onScreen(band), await hands.onScreen({ x: band.x + 50, y: band.y + 6 }), 8));
  const third = await owners();
  if ((await strokes()) !== drawn + 1) list.push(`a stroke below the sum added ${(await strokes()) - drawn} stroke(s) of ink, wanted 1`);
  if (third.length !== 2) list.push(`ink far from every cell was given to a cell (${JSON.stringify(third)}), wanted free working`);
  // 3. more strokes: the tens cell holds two, the ones cell four. Nothing reads them, and nothing marks them: the ink stays where it is written
  await stroke('m4', 'ans-tens', [0.2, 0.7], [0.8, 0.3]);
  for (const [a, b] of [[[0.2, 0.2], [0.3, 0.8]], [[0.5, 0.2], [0.6, 0.8]], [[0.75, 0.2], [0.8, 0.8]]] as [number, number][][]) await stroke('m4', 'ans-ones', a as [number, number], b as [number, number], 6);
  const held = (await owners()).filter((o) => o.key.startsWith('m4'));
  const counts = held.reduce<Record<string, number>>((out, o) => ({ ...out, [o.part]: (out[o.part] ?? 0) + 1 }), {});
  if (counts['ans-tens'] !== 2 || counts['ans-ones'] !== 4) list.push(`the sum's cells own ${JSON.stringify(counts)}, wanted ans-tens 2 and ans-ones 4`);
  await sleep(1200);
  const penned = await mine.shot(dir, `${screen.name}-maths-pen.png`);
  const quiet = (await mine.block('m4'))?.cells.map((cell) => `${cell.part}=${cell.value}:${cell.by}:${cell.ink}`).sort().join(' ');
  if (quiet !== 'ans-ones=::true ans-tens=::true') list.push(`after the pen wrote the cells hold "${quiet}", wanted ink in the ones and the tens and no digit read into either`);
  if ((await tab.eval<number>('(window.__mathReads || []).length')) !== 0) list.push('the page read the pen\'s writing');
  // 5. a typed digit over the ink: the digit stands, the ink goes faint, and the ✕ takes the ink off and keeps the digit
  const r = await mine.play(['scene layout=stack mood=calm', 'math m6 column | 12+12'].join('\n'));
  if (r !== '') list.push(r);
  else {
    for (const [a, b] of [[[0.2, 0.2], [0.3, 0.8]], [[0.5, 0.2], [0.6, 0.8]], [[0.75, 0.2], [0.8, 0.8]]] as [number, number][][]) await stroke('m6', 'ans-ones', a as [number, number], b as [number, number], 6);
    await wait('the three strokes to be the ones cell\'s ink', async () => (await mine.cell('m6', 'ans-ones'))?.ink === true);
    const cell = (await mine.cell('m6', 'ans-ones'))?.box as { x: number; y: number; width: number; height: number };
    await sleep(500);
    await mine.upFocus();
    await hands.finger([await mine.centre(cell)]);
    const selected = await tab.eval<string>(`(() => { const a = document.activeElement; return a && a.dataset && a.dataset.mathCell === 'ans-ones' ? a.value + ':' + a.selectionStart + '-' + a.selectionEnd : 'none'; })()`);
    if (selected !== ':0-0') list.push(`a tap on the cell with ink opened "${selected}", wanted its input empty (nothing was read from the ink)`);
    await mine.press('4');
    const typed = await mine.cell('m6', 'ans-ones');
    if (typed?.value !== '4' || typed.by !== 'key' || !typed.dim) list.push(`a 4 typed over the ink left "${typed?.value}" by ${typed?.by}, dim ${typed?.dim}: the digit should stand and the ink dim`);
    await sleep(300);
    const colours = await tab.eval<string[]>('window.__penWrite.colours()');
    if (colours.filter((colour) => colour === '#b9b3a8').length !== 3) list.push(`the three strokes under the typed digit are not all faint (${colours.join(',')})`);
    // ✕ takes the ink off the cell
    const cross = (await mine.cell('m6', 'ans-ones'))?.clear;
    if (cross === null || cross === undefined) list.push('a cell with ink shows no ✕');
    else {
      await mine.blur();
      await hands.finger([await mine.centre(cross)]);
      await wait('the ✕ to take the ink off', async () => (await tab.eval<number>('window.__penWrite.owners().filter((o) => o.key.startsWith("m6")).length')) === 0);
      const cleared = await mine.cell('m6', 'ans-ones');
      if (cleared?.ink !== false || cleared.value !== '4') list.push(`after ✕ the cell holds ink ${cleared?.ink} and "${cleared?.value}", wanted no ink and the typed 4 kept`);
    }
  }
  // 6. mixed: the pen in the ones cell, keys in the tens cell. The tens holds its digit, the ones none (the ink is the answer's, and it is read by whoever it is sent to)
  const x = await mine.play(['scene layout=stack mood=calm', 'math m7 column | 12+12'].join('\n'));
  if (x !== '') list.push(x);
  else {
    for (const [a, b] of [[[0.2, 0.2], [0.3, 0.8]], [[0.4, 0.2], [0.45, 0.8]], [[0.6, 0.2], [0.65, 0.8]], [[0.75, 0.2], [0.8, 0.8]]] as [number, number][][]) await stroke('m7', 'ans-ones', a as [number, number], b as [number, number], 6);
    await sleep(500);
    await mine.hands.finger([await mine.centre((await mine.cell('m7', 'ans-tens'))?.box as { x: number; y: number; width: number; height: number })]);
    await mine.press('2');
    await wait('the pen and the keys to be in their cells', async () => (await mine.cell('m7', 'ans-ones'))?.ink === true && (await mine.cell('m7', 'ans-tens'))?.value === '2');
    await mine.press('Enter');
    await sleep(300);
    const mixed = (await mine.block('m7'))?.cells.filter((cell) => cell.part !== 'carry-tens').map((cell) => `${cell.part}=${cell.value}:${cell.by}:${cell.ink}`).sort().join(' ');
    if (mixed !== 'ans-ones=::true ans-tens=2:key:false') list.push(`the pen in the ones and keys in the tens left "${mixed}"`);
  }
  // 7. fb-097: the working a sum had written leaves with the sum. A new sum under the same id starts clean (no ink owned, none in its boxes), and a scene with no written
  // method takes the ink off as well
  const own = async (id: string): Promise<number> => (await owners()).filter((o) => o.key.startsWith(id)).length;
  const inkA = await mine.play(['scene layout=stack mood=calm', 'math m11 column | 12+12'].join('\n'));
  if (inkA !== '') list.push(inkA);
  else {
    // (a stroke written far above every box, earlier, is free working and stays: the count is against what stood before)
    const base = await strokes();
    await stroke('m11', 'ans-ones', [0.3, 0.2], [0.35, 0.8], 6);
    if ((await own('m11')) !== 1) list.push(`a stroke in m11 is owned by ${await own('m11')} stroke(s), wanted 1`);
    const inkB = await mine.play(['scene layout=stack mood=calm', 'math m11 column | 13+13'].join('\n'));
    if (inkB !== '') list.push(inkB);
    else {
      await sleep(400);
      if ((await own('m11')) !== 0) list.push(`a new sum under the id m11 kept the old sum's ink (${await own('m11')} stroke(s) owned)`);
      if ((await mine.cell('m11', 'ans-ones'))?.ink !== false) list.push("the new sum's ones box still says it holds ink");
      if ((await strokes()) !== base) list.push(`${(await strokes()) - base} stroke(s) of the old working are still drawn under the new sum`);
      await stroke('m11', 'ans-ones', [0.3, 0.2], [0.35, 0.8], 6);
      const inkC = await mine.play(['scene layout=stack mood=calm', 'say r1 | No sum here.'].join('\n'));
      if (inkC !== '') list.push(inkC);
      else {
        await sleep(400);
        if ((await own('m11')) !== 0 || (await strokes()) !== base) list.push(`a scene with no written method left ${(await strokes()) - base} stroke(s) of its working drawn and ${await own('m11')} owned`);
      }
    }
  }
  return penned;
}



/** What the page keeps while the lag check writes: each pen-down with when its first ink was drawn and the frame that showed it, the stage read-backs (a render and a pixel read of the stage, which is what a picture of it costs), and every request to read handwriting (there are none: nothing reads the pen). */
const PEN_LAG_PROBE = `(() => {
  const now = () => performance.now();
  const P = { downs: [], cancels: 0, readbacks: [], reads: [] };
  window.__penlag = P;
  const f = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (/read-ink/.test(url)) P.reads.push({ began: now(), url });
    return f(input, init);
  };
  let pending = null;
  const fill = CanvasRenderingContext2D.prototype.fill;
  CanvasRenderingContext2D.prototype.fill = function (...args) {
    if (pending !== null && pending.drawn === null && this.canvas.classList.contains('ink__live')) pending.drawn = now();
    return fill.apply(this, args);
  };
  for (const gl of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!gl) continue;
    const read = gl.prototype.readPixels;
    gl.prototype.readPixels = function (...args) { P.readbacks.push(now()); return read.apply(this, args); };
  }
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return;
    const rec = { at: now(), stamp: e.timeStamp, drawn: null, frame: null };
    pending = rec;
    P.downs.push(rec);
    const poll = (n) => requestAnimationFrame(() => {
      if (rec.drawn !== null) rec.frame = now();
      else if (n < 60) poll(n + 1);
    });
    poll(0);
  }, true);
  window.addEventListener('pointercancel', (e) => { if (e.pointerType === 'pen') P.cancels += 1; }, true);
})()`;

interface PenLag {
  downs: { at: number; stamp: number; drawn: number | null; frame: number | null }[];
  cancels: number;
  readbacks: number[];
  reads: { began: number; url: string }[];
}

/**
 * fb-102. The Pencil writes three digits into a sum with a hand's pauses between the strokes, one pause as long as the read that used to follow it (nothing reads the pen now,
 * fb-104, and a read request would be a failure). Every stroke is taken (none dropped, cancelled or made a tap), each shows its first ink within 50 ms of the pen going down (at the
 * desk), and no picture of the stage is taken while the pen writes in a cell (a render and a read-back of the stage, on the main thread, at the pen-down of the first stroke of every
 * sum, was the lag a person felt).
 * A stroke that is free working (to be sent as a drawing) has its picture taken after the pen has lifted, not while it is down.
 */
async function penLagScene(mine: MathsTab, problems: Problems): Promise<void> {
  const list = problems['penlag'] as string[];
  const { tab, hands, screen } = mine;
  const desk = screen.width >= 800;
  // (the free working of the scenes before this one is still on the layer, and the stage's picture for it taken: the drawing starts empty here)
  await tab.eval('window.__inkClear()');
  await mine.blur();
  const played = await mine.play(['scene layout=stack mood=calm', 'math m12 column | 123+456'].join('\n'));
  if (played !== '') return void list.push(played);
  await sleep(500);
  await tab.eval(PEN_LAG_PROBE);
  const owners = (): Promise<{ stroke: string; key: string; part: string }[]> => tab.eval('window.__penWrite ? window.__penWrite.owners() : []');
  const inked = async (): Promise<number> => (await hands.strokes())?.strokes.length ?? 0;
  const base = await inked();
  const probe = (): Promise<PenLag> => tab.eval<PenLag>('JSON.parse(JSON.stringify(window.__penlag))');
  const digits: Record<string, readonly { ms: number; pts: readonly (readonly [number, number])[] }[]> = {
    '9': [{ ms: 250, pts: [[0.62, 0.3], [0.5, 0.18], [0.36, 0.28], [0.38, 0.46], [0.54, 0.52], [0.66, 0.4], [0.66, 0.62], [0.62, 0.82], [0.5, 0.92], [0.36, 0.9]] }],
    '7': [{ ms: 95, pts: [[0.28, 0.2], [0.5, 0.19], [0.74, 0.2]] }, { ms: 150, pts: [[0.74, 0.2], [0.62, 0.5], [0.5, 0.72], [0.44, 0.9]] }],
    '5': [{ ms: 90, pts: [[0.72, 0.2], [0.5, 0.2], [0.32, 0.22]] }, { ms: 230, pts: [[0.32, 0.22], [0.3, 0.46], [0.5, 0.42], [0.7, 0.54], [0.72, 0.76], [0.52, 0.9], [0.3, 0.84]] }],
  };
  /** one stroke as a Pencil sends it: pressed, moved on the hand's own pace, lifted */
  const write = async (part: string, shape: { ms: number; pts: readonly (readonly [number, number])[] }): Promise<void> => {
    const box = (await mine.cell('m12', part))?.box;
    if (box === undefined) throw new Error(`no cell m12.${part}`);
    const path: Point[] = [];
    for (let at = 0; at < shape.pts.length - 1; at += 1) {
      const a = shape.pts[at] as readonly [number, number];
      const b = shape.pts[at + 1] as readonly [number, number];
      path.push(...line(await mine.centre(box, { x: a[0], y: a[1] }), await mine.centre(box, { x: b[0], y: b[1] }), Math.max(2, Math.round(shape.ms / 16 / (shape.pts.length - 1)))).slice(at === 0 ? 0 : 1));
    }
    const first = path[0] as Point;
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, pointerType: 'pen' });
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
    for (const p of path.slice(1)) {
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
      await sleep(Math.max(0, shape.ms / path.length - 4));
    }
    const last = path[path.length - 1] as Point;
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  };
  // the ones, the tens (two strokes), a long pause (a read used to begin in it), then the hundreds (two strokes)
  const plan: readonly [string, number, string, number][] = [['9', 0, 'ans-ones', 0], ['7', 0, 'ans-tens', 450], ['7', 1, 'ans-tens', 180], ['5', 0, 'ans-hundreds', 1000], ['5', 1, 'ans-hundreds', 150]];
  for (const [digit, which, part, gap] of plan) {
    await sleep(gap);
    await write(part, (digits[digit] as (typeof digits)[string])[which] as (typeof digits)[string][number]);
  }
  await sleep(300);
  const drawn = await probe();
  const taken = (await inked()) - base;
  const mine12 = (await owners()).filter((o) => o.key.startsWith('m12'));
  if (taken !== plan.length) list.push(`${plan.length} strokes were written and the ink holds ${taken}: ${plan.length - taken} dropped or made taps`);
  const byPart = (part: string): number => mine12.filter((o) => o.part === part).length;
  if (byPart('ans-ones') !== 1 || byPart('ans-tens') !== 2 || byPart('ans-hundreds') !== 2) list.push(`the strokes went to the cells as ones ${byPart('ans-ones')}, tens ${byPart('ans-tens')}, hundreds ${byPart('ans-hundreds')}, wanted 1, 2 and 2`);
  if (drawn.cancels !== 0) list.push(`${drawn.cancels} pen stream(s) were cancelled`);
  if (drawn.downs.length !== plan.length) list.push(`the page saw ${drawn.downs.length} pen-downs for ${plan.length} strokes`);
  if ((await mine.focused()) !== '') list.push(`a stroke was taken as a tap: the keyboard is in "${await mine.focused()}"`);
  // nothing reads what the pen wrote: not after a pause, not while more is written (fb-104)
  if (drawn.reads.length > 0) list.push(`${drawn.reads.length} request(s) to read the handwriting were made while the pen wrote in the cells (${drawn.reads.map((read) => read.url).join(', ')})`);
  // the first ink of each stroke: drawn in the pen-down's own task, and shown in the next frame
  for (const [at, down] of drawn.downs.entries()) {
    if (down.drawn === null || down.frame === null) list.push(`stroke ${at + 1} drew no ink in the frames after its pen-down`);
    else if (desk && down.frame - down.stamp > 50) list.push(`stroke ${at + 1}: first ink ${Math.round(down.frame - down.stamp)} ms after the pen went down, wanted 50 or less`);
  }
  // no picture of the stage while writing in a cell: no read-back of the stage from the first pen-down to now
  const early = drawn.readbacks.filter((t) => t >= (drawn.downs[0]?.at ?? 0) - 5);
  if (early.length > 0) list.push(`${early.length} read-back(s) of the stage while the pen wrote in the cells (a picture of the stage is taken for nothing the cells use)`);
  // free working, to be sent as a drawing: its picture comes after the pen has lifted, and does come
  const before = drawn.readbacks.length;
  const tens = (await mine.cell('m12', 'ans-tens'))?.box;
  if (tens !== undefined) {
    // on the sum's upper rows, in no cell (the pen writes only on a written method)
    const sum = (await mine.block('m12'))?.box as { x: number; y: number; width: number; height: number };
    const from = await hands.onScreen({ x: sum.x + sum.width * 0.3, y: sum.y + sum.height * 0.42 });
    const to = await hands.onScreen({ x: sum.x + sum.width * 0.3 + 60, y: sum.y + sum.height * 0.42 + 8 });
    await tab.eval('window.__penlag.mark = performance.now()');
    await hands.pen(line(from, to, 8));
    const during = (await probe()).readbacks.length - before;
    if (during !== 0) list.push(`${during} read-back(s) of the stage within 300 ms of the pen lifting from free working: its picture is taken after the pen has been up a while`);
    await sleep(2200);
    const after = (await probe()).readbacks.length - before;
    if (after === 0) list.push('the stage was never photographed for the free working that waits to be sent');
  }
}

/** A sum in a dark look, written in by key and by pen: the learner's digits in pencil, the ink where it is written, nothing marked. A picture to look at (the colours are the look's own). */
async function darkScene(base: string, screen: InputScreen, dir: string, timeoutMs: number, problems: Problems): Promise<string> {
  const list = problems['keys'] as string[];
  const dark = await MathsTab.open(base, screen, dir, timeoutMs, 'look=night');
  try {
    const played = await dark.play(SUM);
    if (played !== '') {
      list.push(`dark look: ${played}`);
      return '';
    }
    const ones = (await dark.cell('m1', 'ans-ones'))?.box;
    const tens = (await dark.cell('m1', 'ans-tens'))?.box;
    if (ones === undefined || tens === undefined) return '';
    await dark.hands.finger([await dark.centre(ones)]);
    await dark.type('2');
    await dark.blur();
    await sleep(700);
    await dark.hands.pen(line(await dark.centre(tens, { x: 0.3, y: 0.2 }), await dark.centre(tens, { x: 0.7, y: 0.8 }), 8));
    await sleep(300);
    return await dark.shot(dir, `${screen.name}-maths-typed-night.png`);
  } finally {
    await dark.close();
  }
}

/** One screen's whole input run. */
async function inputScreen(base: string, screen: InputScreen, dir: string, timeoutMs: number, note: (text: string) => void): Promise<{ results: CheckResult[]; pictures: string[] }> {
  const problems: Problems = { keys: [], fill: [], pen: [], penlag: [], send: [], notes: [] };
  const pictures: string[] = [];
  note(`maths input: ${screen.name}`);
  const mine = await MathsTab.open(base, screen, dir, timeoutMs);
  try {
    pictures.push(...(await keysScene(mine, dir, problems)));
    await fillScene(mine, problems);
    pictures.push(await penScene(mine, dir, problems));
    await penLagScene(mine, problems);
    pictures.push(await sendScene(mine, dir, problems));
    pictures.push(await darkScene(base, screen, dir, timeoutMs, problems));
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
  // not a failure: how often a tap was lost and made again, so that it can be watched
  for (const text of problems['notes'] ?? []) results.push({ turn: 0, check: 'maths-note', verdict: 'PASS', detail: `note: ${text}` });
  add('keys', 'a finger tap focuses a cell inside the gesture; 2 moves to the carry then the tens; Backspace, Tab and the arrows walk the sum; Enter puts the keyboard away and marks nothing; the active cell stays above a short visual viewport');
  add('send', 'pen-written 344 in 43 x 8 and Send: one drawing turn on the sum\'s id with every stroke and its picture; no handwriting read; no Check, Hint or Show me in the page or the painter');
  add('fill', 'fill m1 | 72 and fill m1.ans-ones | 2 put the digits in the cells, marked by nothing, and a later hand wins');
  add('penlag', 'three digits of five strokes, with a hand\'s pauses: every stroke taken (none dropped, cancelled or made a tap), first ink within 50 ms of the pen-down at the desk, no picture of the stage taken while the pen writes in a cell, and no handwriting read asked for (free working is photographed after the pen has lifted)');
  add('pen', 'with Draw closed a pen stroke is one stroke owned by its cell, the larger share wins, a finger and a palm leave no ink, a short pen tap is a press; nothing is read; a typed digit over the ink dims it and the ✕ takes it off; pen and keys mix');
  return { results, pictures };
}

/** The input half of the group: its own server, a tab per screen. Failures are `FAIL` results, never throws. */
export async function mathsInputGroup(dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  let server: Started | null = null;
  const results: CheckResult[] = [];
  try {
    server = await startMathsServer();
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
    results.push({ turn: 0, check: 'maths-layout', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? `${blocks} blocks at three screens: one x a place, ${blanks} blanks at least 44 and empty, no answer painted, the rule spans the columns, nothing overlaps, nothing of the app's own checking painted` : problems.slice(0, 12).join('; ') });
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
