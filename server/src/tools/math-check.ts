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

import { maths } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { repoRoot } from './explore-browser';
import type { CheckResult } from './smoke';

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
      if (written.has(`c:${name.slice(2)}`) && !filled) problems.push(`${where}: blank ${name} is not empty`);
    }
    if (isGrid && !worked && method !== 'bond' && !figures.some((f) => partOf(f.key).startsWith('f:ans'))) problems.push(`${where}: no blank answer cells`);
    // 3. sealed: with the answer blank (and nothing filled), no answer cell is painted and no painted word is the answer
    const [id] = (one.lines[0] ?? '').split(' ').slice(1);
    const sum = /\|\s*(.+)$/.exec(one.lines[0] ?? '')?.[1] ?? '';
    const read = id === undefined ? null : maths.readSum(method as never, sum);
    if (!worked && !filled) {
      if (elements.some((e) => partOf(e.key).startsWith('c:ans'))) problems.push(`${where}: an answer cell shows a value while the answer is blank`);
      if (read?.ok) for (const answer of maths.answerOf(read.sum)) if (elements.some((e) => e.text.trim() === answer && answer.length > 1)) problems.push(`${where}: the answer ${answer} is painted`);
    }
    // 4. fill: its digits are in the blanks by place
    if (filled && method === 'column') {
      const tens = elements.find((e) => partOf(e.key) === 'c:ans-tens')?.text;
      const ones = elements.find((e) => partOf(e.key) === 'c:ans-ones')?.text;
      if (tens !== '2' || ones !== '4') problems.push(`${where}: fill 24 put "${tens}" and "${ones}" in the tens and ones`);
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

/** The group as `pnpm check` runs it. */
export async function mathsGroup(note: (text: string) => void = () => undefined): Promise<CheckResult[]> {
  note('maths');
  try {
    const { problems, blocks, blanks } = mathProblems(await capture());
    return [{ turn: 0, check: 'maths-layout', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? `${blocks} blocks at three screens: one x a place, ${blanks} blanks at least 44 and empty, no answer painted, the rule spans the columns, nothing overlaps` : problems.slice(0, 12).join('; ') }];
  } catch (error) {
    return [{ turn: 0, check: 'maths-layout', verdict: 'FAIL', detail: `stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` }];
  }
}

if (process.argv[1] !== undefined && /math-check\.ts$/.test(process.argv[1])) {
  mathsGroup().then((results) => {
    for (const result of results) process.stdout.write(`${result.verdict} ${result.check}: ${result.detail}\n`);
    process.exit(results.every((result) => result.verdict === 'PASS') ? 0 : 1);
  });
}
