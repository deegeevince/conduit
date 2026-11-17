// pnpm check's continuation group: the brain keeps working at will. A fake brain (the replay brain's REPLAY_CASE) ends its answer with `refine | what next`
// five times and then stops; the server runs it again at once each time, as a turn of its own, and the page's elements are read back:
//
//   chain     six turns in all: the first answer and five continuations, each shown in place (the first drawing stays, a mark is added by each), then
//             `restore undo` steps back one continuation, because each is a version
//   person    a message from the person while it is going on takes over: its own drawing arrives, and the brain's chain goes no further
//   stop      Stop (`interrupt`) ends the chain too
//
// Run by `pnpm check` (which starts the server with REFINE=on) and standalone: `tsx continue-check.ts --url <server>`.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from './explore-browser';
import { MEMORY_SCREEN, digest, standing, withTab } from './memory-check';
import type { Live } from './memory-check';
import type { CheckResult } from './smoke';
import type { LensScene, LensScreen } from './lens-check';

export const CONTINUE_SCREEN: LensScreen = MEMORY_SCREEN;

const DRAW = ['scene hills canvas=wide', 'color sky=#1b2a49 grass=#336644', 'rect sky1 0,0 160x90 fill=sky', 'circle sun 120,20 10 fill=#ffcc00', 'rect hill1 0,60 160x30 fill=grass', 'refine | add the stars', 'wait 1'].join('\n');
const MARK = (n: number, more: boolean, stall = 0): string => [...(stall > 0 ? [`#! stall ${stall}`] : []), `circle m${n} ${10 * n},30 3 fill=#ff0000`, ...(more ? [`refine | mark ${n + 1}`] : []), 'wait 0.5'].join('\n');

/** The case file the replay brain answers from: the drawing, then five continuations, the third waiting a while before it writes (a model thinking). */
export async function continueFixtures(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conduit-continue-'));
  const file = join(dir, 'case.json');
  const turns = [DRAW, MARK(1, true), MARK(2, true, 3), MARK(3, true), MARK(4, true), MARK(5, false)].map((script, at) => ({ match: at === 0 ? 'paint a hill' : 'kind:refine', script }));
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

const ids = (live: readonly Live[]): string[] => standing(live).map((element) => element.id);

async function ask(tab: { eval<T>(expression: string): Promise<T> }, live: () => Promise<Live[]>, text: string): Promise<void> {
  await tab.eval<string>(`window.__stage.prompt(${JSON.stringify(text)})`);
  let last = '';
  let steady = 0;
  for (let i = 0; i < 80 && steady < 4; i += 1) {
    await sleep(300);
    const now = digest(await live());
    steady = now === last ? steady + 1 : 0;
    last = now;
  }
}

async function until(live: () => Promise<Live[]>, done: (ids: string[]) => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 400) {
    if (done(ids(await live()))) return true;
    await sleep(400);
  }
  return done(ids(await live()));
}

export async function continueGroup(base: string, screen: LensScreen, dir: string, timeoutMs: number, note: (text: string) => void = () => undefined): Promise<LensScene[]> {
  await mkdir(dir, { recursive: true });
  const scenes: LensScene[] = [];
  const result = (name: string, began: number, problems: readonly string[], saw: string): void => {
    const results: CheckResult[] = [{ turn: 0, check: 'continue', verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? saw : problems.join('; ') }];
    scenes.push({ name, picture: '', results, seconds: (Date.now() - began) / 1000 });
  };

  let began = Date.now();
  note('continue: chain');
  try {
    await withTab(base, screen, dir, timeoutMs, async (tab, live, play) => {
      const problems: string[] = [];
      await ask(tab, live, 'paint a hill');
      if (!(await until(live, (now) => now.includes('m5'), 90_000))) problems.push('the chain did not reach its sixth turn');
      await sleep(1500);
      const after = ids(await live());
      for (const id of ['sun', 'hill1', 'm1', 'm2', 'm3', 'm4', 'm5']) if (!after.includes(id)) problems.push(`${id} is missing: each continuation should add to the drawing in place`);
      await sleep(5000);
      if (ids(await live()).includes('m6')) problems.push('it went on past the turn that did not write refine');
      // each continuation is a version
      await play('restore undo');
      const undone = ids(await live());
      if (undone.includes('m5') || !undone.includes('m4')) problems.push(`undo did not step back one continuation (${undone.join(' ')})`);
      result('continue-chain', began, problems, 'the answer and five continuations ran, each shown in place, it stopped when it stopped writing refine, and undo stepped back one');
    });
  } catch (error) {
    result('continue-chain', began, [`stopped: ${error instanceof Error ? error.message : String(error)}`], '');
  }

  began = Date.now();
  note('continue: person');
  try {
    await withTab(base, screen, dir, timeoutMs, async (tab, live, play) => {
      const problems: string[] = [];
      await ask(tab, live, 'paint a hill');
      if (!(await until(live, (now) => now.includes('m1'), 40_000))) problems.push('the first continuation never arrived');
      // the third turn is waiting on its stall: the person speaks
      await play('circle zz 5,5 2 fill=#ffffff\nwait 0.1');
      await sleep(9000);
      const after = ids(await live());
      if (!after.includes('zz')) problems.push('the person\'s turn did not draw');
      if (after.includes('m3') || after.includes('m4')) problems.push(`the brain went on after the person spoke (${after.join(' ')})`);
      result('continue-person', began, problems, 'a message from the person took over, and the chain went no further');
    });
  } catch (error) {
    result('continue-person', began, [`stopped: ${error instanceof Error ? error.message : String(error)}`], '');
  }

  began = Date.now();
  note('continue: stop');
  try {
    await withTab(base, screen, dir, timeoutMs, async (tab, live) => {
      const problems: string[] = [];
      await ask(tab, live, 'paint a hill');
      if (!(await until(live, (now) => now.includes('m1'), 40_000))) problems.push('the first continuation never arrived');
      await tab.eval('window.__stage.interrupt()');
      await sleep(9000);
      const after = ids(await live());
      if (after.includes('m3') || after.includes('m4')) problems.push(`the brain went on after Stop (${after.join(' ')})`);
      result('continue-stop', began, problems, 'Stop ended the chain');
    });
  } catch (error) {
    result('continue-stop', began, [`stopped: ${error instanceof Error ? error.message : String(error)}`], '');
  }
  return scenes;
}

if (process.argv[1] !== undefined && /continue-check\.ts$/.test(process.argv[1])) {
  const at = process.argv.indexOf('--url');
  const url = at >= 0 ? process.argv[at + 1] : undefined;
  if (url === undefined) {
    process.stderr.write('usage: tsx continue-check.ts --url <server with BRAIN=replay REFINE=on REPLAY_CASE=<file from continueFixtures>>\n');
    process.exit(2);
  }
  void continueGroup(url, CONTINUE_SCREEN, '/tmp/continue-check', 120_000, (text) => process.stdout.write(`${text}\n`)).then((scenes) => {
    let failed = 0;
    for (const scene of scenes) for (const r of scene.results) {
      process.stdout.write(`${r.verdict} ${scene.name} ${r.check}: ${r.detail}\n`);
      if (r.verdict === 'FAIL') failed += 1;
    }
    process.exit(failed === 0 ? 0 : 1);
  });
}
