// The five gates, each tried where it can be tried without a model and without money, on scratch repositories made for the purpose.
// `pnpm improve --gates` prints PASS or FAIL for each check and exits 1 if any fails. This is not a test suite: it is the loop
// saying, before a run, that the things it promises are still true of the code that would run.

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_COMMANDS, agentArguments } from './agents';
import { changesOf, dropExport, exportTree } from './export';
import { isProtected, SEALED_PATHS, clearOfNoise } from './guard';
import { branchAt, branches, commitChanges, dropBranch, dropTree, head, initScratch, measuringTree, worktrees } from './git';
import { assertOverlayLoaded, compare, measurementEnvironment, readSummary } from './measure';
import { exec } from './proc';
import { runLoop } from './runner';
import { standInAgents, standInDeps } from './standin';
import { keepRate, DEFAULT_SPEC } from './resample';

const here = fileURLToPath(new URL('../../../', import.meta.url));

type Say = (line: string) => void;

export async function runGates(out: Say): Promise<void> {
  let failed = 0;
  const check = (gate: string, what: string, ok: boolean, detail = ''): void => {
    if (!ok) failed += 1;
    out(`${ok ? 'PASS' : 'FAIL'}  ${gate}  ${what}${detail === '' ? '' : `  [${detail}]`}`);
  };
  const folder = await mkdtemp(join(process.env['LOOP_SCRATCH'] ?? tmpdir(), 'conduit-gates-'));
  try {
    const files = {
      'explore/battery.json': '{"version":1,"prompts":[{"id":"a","prompt":"Explain how a bill becomes a law as a flow of steps","expects":"drawn","baseline":false}]}\n',
      'explore/sealed/heldout.json': '{"version":1,"pool":"heldout","prompts":[{"id":"h","prompt":"a distinctive held out prompt sentence","expects":"drawn","baseline":false}]}\n',
      'explore/taste/sheet.json': '{"sealed":true}\n',
      'techniques/seed/example.md': '# Example\n',
      'language/src/prompt.ts': '// prompt\n',
      'language/src/sight.ts': '// the base sight\n',
      'language/src/geometry.ts': '// the base geometry\n',
      'language/src/index.ts': '// the base barrel\n',
      'server/src/tools/explore-checks.ts': '// the base counters\n',
      'web/src/painter/index.ts': '// painter\n',
      'package.json': '{"scripts":{"typecheck":"echo base typecheck"}}\n',
    };

    // ---- P1-32: a measuring tree is detached and has no branch to delete ----
    const repoA = join(folder, 'a');
    await initScratch(repoA, files);
    await branchAt(repoA, 'integration', 'main');
    await branchAt(repoA, 'precious', 'main');
    const baseCommit = await head(repoA, 'integration');
    const tree = await measuringTree(repoA, join(folder, 'a-tree'), baseCommit, baseCommit, isProtected);
    const symbolic = await exec({ bin: 'git', args: ['symbolic-ref', '-q', 'HEAD'], cwd: tree.path });
    check('P1-32', 'a measuring tree is detached (HEAD names no branch)', symbolic.code !== 0);
    check('P1-32', 'a tree has no branch field to delete', !('branch' in tree));
    await dropTree(repoA, tree.path);
    check('P1-32', 'dropBranch refuses a branch that is not loop/', !(await dropBranch(repoA, 'integration', new Set(['integration']))));
    check('P1-32', 'dropBranch refuses a loop/ branch this run did not make', !(await dropBranch(repoA, 'loop/theirs', new Set())));
    const before = await branches(repoA);
    const objecting = standInAgents('objects');
    const run = await runLoop(standInDeps(repoA, () => undefined, objecting), { budget: { usd: 6, experiments: 2, minutes: 20 }, kinds: ['technique', 'block', 'style', 'prompt'], samples: 3, rounds: 2, attempts: 2, base: 'integration' }, new AbortController().signal);
    const after = await branches(repoA);
    const left = (await worktrees(repoA)).filter((path) => !repoA.endsWith(path) && path !== repoA && !path.endsWith('/a'));
    check('P1-32', 'git branch is unchanged after a run with --base on a branch that is not checked out', before.join() === after.join(), `${before.join(',')} -> ${after.join(',')}; ${run.stoppedBecause}`);
    check('P1-32', 'no worktree is left behind', left.length === 0, left.join(','));

    // ---- P1-29: the builder's folder, its tools, and what it wrote ----
    const exported = await exportTree(repoA, baseCommit, SEALED_PATHS);
    const walked = await exec({ bin: 'find', args: [exported.work, '-name', '.git'], cwd: folder });
    check('P1-29', 'the builder\'s folder is outside the repository', !exported.work.startsWith(repoA) && !exported.work.startsWith(here));
    check('P1-29', 'it has no .git in it', walked.stdout.trim() === '');
    const sealedThere = await Promise.all(SEALED_PATHS.map((path) => lstat(join(exported.work, path)).then(() => true, () => false)));
    check('P1-29', 'it holds none of the sealed paths', sealedThere.every((there) => !there));
    check('P1-29', 'it holds the rest of the base commit', (await readFile(join(exported.work, 'explore', 'battery.json'), 'utf8')).includes('bill becomes a law'));
    const builderArgs = agentArguments({ kind: 'builder', role: { model: 'sonnet', effort: 'high' }, reservation: { label: 'gate', cap: 1, settled: false } });
    check('P1-29', 'the builder runs under --restricted', builderArgs.includes('--restricted'));
    const tools = builderArgs[builderArgs.indexOf('--tools') + 1] ?? '';
    check('P1-29', 'the builder has no shell tool and no Bash allowance', !/Bash|PowerShell/.test(tools) && !builderArgs.some((arg) => arg.startsWith('Bash(')), tools);
    check('P1-29', 'the runner, not the builder, runs the three pnpm commands', RUNNER_COMMANDS.map((command) => command.join(' ')).join(' | ') === 'typecheck | timeline | prompt count');
    // what a builder wrote is found by comparing with an untouched export, never by running git in its folder
    await writeFile(join(exported.work, 'techniques', 'new.md'), '# New\n');
    await writeFile(join(exported.work, 'language', 'src', 'prompt.ts'), '// prompt\n// changed\n');
    await rm(join(exported.work, 'web', 'src', 'painter', 'index.ts'));
    await symlink('/etc/hosts', join(exported.work, 'link')).catch(() => undefined);
    const changed = await changesOf(exported);
    const by = Object.fromEntries(changed.files.map((change) => [change.file, change.status]));
    check('P1-29', 'new, edited and deleted files are found by comparison with the untouched export', by['techniques/new.md'] === 'added' && by['language/src/prompt.ts'] === 'modified' && by['web/src/painter/index.ts'] === 'deleted', JSON.stringify(by));
    check('P1-29', 'a link the builder made is reported and would be refused', changed.odd.includes('link'));
    await dropExport(exported);

    // ---- P1-30: the harness is the base commit's ----
    const refusedBranch = await commitChanges(repoA, baseCommit, 'integration-2', join(folder, 'cheat-work'), [], 'x').then(() => false, () => true);
    check('P1-30', 'commitChanges makes a loop/ branch only', refusedBranch);
    const work = join(folder, 'cheat-work');
    for (const [name, text] of Object.entries({ 'language/src/sight.ts': '// CHEATING sight\n', 'language/src/geometry.ts': '// CHEATING geometry\n', 'language/src/index.ts': '// CHEATING barrel\n', 'server/src/tools/explore-checks.ts': '// CHEATING counters\n', 'package.json': '{"scripts":{"typecheck":"echo CHEAT"}}\n', 'explore/extra.json': '{}\n', 'web/src/painter/index.ts': '// a real change\n' })) {
      await mkdir(join(work, name, '..'), { recursive: true });
      await writeFile(join(work, name), text);
    }
    const planted = ['language/src/sight.ts', 'language/src/geometry.ts', 'language/src/index.ts', 'server/src/tools/explore-checks.ts', 'package.json', 'explore/extra.json', 'web/src/painter/index.ts'].map((file) => ({ file, status: file === 'explore/extra.json' ? ('added' as const) : ('modified' as const), added: 1, removed: 1, executable: false }));
    const candidate = await commitChanges(repoA, baseCommit, 'loop/cheat', work, planted, 'a candidate that edited its own harness');
    const measuring = await measuringTree(repoA, join(folder, 'cheat-tree'), candidate, baseCommit, isProtected);
    const read = (path: string): Promise<string> => readFile(join(measuring.path, path), 'utf8').catch(() => '(absent)');
    check('P1-30', 'sight and geometry are the base commit\'s in the measured tree', (await read('language/src/sight.ts')).includes('base sight') && (await read('language/src/geometry.ts')).includes('base geometry'));
    check('P1-30', 'the barrel (language/src/index.ts) and the counters are the base commit\'s', (await read('language/src/index.ts')).includes('base barrel') && (await read('server/src/tools/explore-checks.ts')).includes('base counters'));
    check('P1-30', 'package.json (so what `pnpm` runs) is the base commit\'s', (await read('package.json')).includes('base typecheck'));
    check('P1-30', 'a file the candidate added under a protected path is taken out', (await read('explore/extra.json')) === '(absent)');
    check('P1-30', 'the candidate\'s own change to the painter stays', (await read('web/src/painter/index.ts')).includes('a real change'));
    check('P1-30', 'sight, geometry, the barrel and the judge are named protected paths', ['language/src/sight.ts', 'language/src/geometry.ts', 'language/src/index.ts', 'server/src/judge/rubric.ts', 'web/package.json', 'server/tsconfig.json'].every(isProtected));
    await dropTree(repoA, measuring.path);
    await dropBranch(repoA, 'loop/cheat', new Set(['loop/cheat']));

    // ---- P1-31: the overlay is set and asserted loaded ----
    const one = measurementEnvironment('/trees/candidate', 'heldout', '/outside/sealed');
    const two = measurementEnvironment('/trees/baseline', 'tune', '/outside/sealed');
    check('P1-31', 'each arm\'s environment names its own tree\'s overlay', one['LIBRARY_OVERLAY'] === '/trees/candidate/techniques/overlay' && two['LIBRARY_OVERLAY'] === '/trees/baseline/techniques/overlay');
    check('P1-31', 'the held-out folder is named for the held-out pool only', one['BATTERY_SEALED_DIR'] === '/outside/sealed' && two['BATTERY_SEALED_DIR'] === '');
    const overlay = join(folder, 'overlay-tree');
    await mkdir(join(overlay, 'techniques', 'overlay'), { recursive: true });
    await writeFile(join(overlay, 'techniques', 'overlay', 'gate.md'), '# A gate technique\n\nsummary: for the gate check\n\nWhen asked for a gate, draw a gate.\n');
    const good = await assertOverlayLoaded(here.replace(/\/$/, ''), { ...measurementEnvironment(overlay, 'tune', null), LIBRARY_OVERLAY: join(overlay, 'techniques', 'overlay') });
    check('P1-31', 'an overlay the library loads passes the assertion', good === null, good ?? '');
    // the same folder, but the library is told to hold none: the assertion must refuse
    const bad = await assertOverlayLoaded(here.replace(/\/$/, ''), { ...measurementEnvironment(overlay, 'tune', null), LIBRARY_OVERLAY: join(overlay, 'techniques', 'overlay'), LIBRARY: 'none' });
    check('P1-31', 'an overlay the library did not load is refused before any money is spent', bad !== null && bad.includes('not loaded'), bad ?? '');

    // ---- P1-11: samples, pairing, standard errors, absent families ----
    const summary = (extra: Record<string, unknown>): string => JSON.stringify({ run: 'r', pool: 'heldout', rubric: 'x', samples: 3, usd: 0, families: { diagram: { n: 6, coherence: 3, correct: 0.5, readable: 0.5, asked: 0.5, collisions: 0, tokens: 1, firstLineMs: 1 }, chart: { n: 3, coherence: 0, correct: 0, readable: 0, asked: 0, collisions: 0, tokens: 0, firstLineMs: 0, bar: { judged: 0 } } }, prompts: [], ...extra });
    check('P1-11', 'a run with fewer than three samples is refused', typeof readSummary(summary({ samples: 2 }), 'heldout') === 'string');
    const parsed = readSummary(summary({}), 'heldout');
    check('P1-11', 'a family with nothing judged is absent, not zero', typeof parsed !== 'string' && parsed.families.chart === undefined && parsed.families.diagram !== undefined);
    const mk = (shift: number, label: string): string => summary({ run: label, prompts: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, family: 'diagram', coherence: 3 + i * 0.1 + shift + (label.endsWith('2') ? 0.01 : 0), failed: 0, checked: 1 })) });
    const arm = (shift: number, tag: string): ReturnType<typeof readSummary>[] => [readSummary(mk(shift, `${tag}1`), 'heldout'), readSummary(mk(shift, `${tag}2`), 'heldout')];
    const baseRounds = arm(0, 'b').filter((m): m is Exclude<typeof m, string> => typeof m !== 'string');
    const candRounds = arm(1, 'c').filter((m): m is Exclude<typeof m, string> => typeof m !== 'string');
    const compared = compare(baseRounds, candRounds);
    const estimate = typeof compared === 'string' ? undefined : compared.families.diagram?.metrics.coherence;
    check('P1-11', 'two arms are paired by prompt, with a standard error', estimate !== undefined && estimate.paired === 'prompts' && estimate.df === 3 && Math.abs(estimate.delta - 1) < 0.02, estimate === undefined ? '' : `${estimate.delta.toFixed(2)} +/- ${estimate.se.toFixed(3)}`);
    check('P1-11', 'a metric paired only by round never clears chance', estimate !== undefined && !clearOfNoise({ ...estimate, paired: 'rounds' }));
    const spec = { ...DEFAULT_SPEC, trials: 400 };
    const identical = keepRate(spec, 0);
    const rose = keepRate(spec, 1);
    check('P1-11', 'two identical runs are kept in under 1% of 400 resamplings', identical.kept / identical.trials < 0.01, `${identical.kept} of ${identical.trials}`);
    check('P1-11', 'a true +1.0 on one family is kept most of the time', rose.kept / rose.trials > 0.5, `${rose.kept} of ${rose.trials}`);
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
  out(failed === 0 ? '\nAll gates hold.' : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exitCode = 1;
}
