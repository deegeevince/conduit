// The improvement loop from the command line. Not part of the server.
//
//   pnpm improve --dry-run                       what a run would do, what confines each agent, what each call may cost; runs nothing
//   pnpm improve --budget 12 --experiments 3 [--minutes 180] [--kinds technique,block] [--samples 3] [--rounds 2] [--base <branch>] --yes
//   pnpm improve --stand-in [--base <branch>] [--reviewer objects] [--uncalibrated]
//                                                the whole loop with a scripted agent and arithmetic for a battery, on a scratch repository
//   pnpm improve --gates                         the five safety gates, each tried on a scratch repository; PASS or FAIL for each
//   pnpm improve --resample [--trials 2000]      how often the keep rule keeps two identical runs, and a run with a true +1.0 on one family
//   pnpm improve status                          what is awaiting the steward, and the last entries of the ledger
//   pnpm improve approve <id> [--into <branch>]   the steward's verdict; merges into the integration branch
//   pnpm improve refuse <id> --why "..."         the steward's refusal; the experiment's branch is deleted
//   pnpm improve vault --file <path> [--budget 4] --yes   run the vault set (kept outside the repository) on the integration branch and on main
//
// The loop proposes; the steward decides. A kept technique stays an overlay file until the steward moves it into techniques/seed.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_COMMANDS, agentArguments } from '../loop/agents';
import { Meter } from '../loop/budget';
import type { Reservation } from '../loop/budget';
import { realDeps } from '../loop/deps';
import { KEEP_RULE, PROTECTED_PATHS, SEALED_PATHS, isProtected } from '../loop/guard';
import { runGates } from '../loop/gates';
import { resampleReport } from '../loop/resample';
import { branchAt, branches, checkout, currentBranch, dropBranch, dropTree, filesBetween, head, initScratch, isDirty, mergeBranch, measuringTree, worktrees } from '../loop/git';
import { appendChangelog, appendLedger, readLedger, verdictEntry } from '../loop/ledger';
import type { LedgerLine } from '../loop/ledger';
import { exploreMeasurer, interleave } from '../loop/measure';
import { exec } from '../loop/proc';
import { DEFAULTS, allowances, runLoop } from '../loop/runner';
import { standInAgents, standInDeps } from '../loop/standin';
import { EXPERIMENT_ORDER, LOOP_ROLES, MIN_SAMPLES } from '../loop/types';
import type { ExperimentKind, ExperimentRecord, LoopBudget } from '../loop/types';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const fail = (text: string): never => {
  process.stderr.write(`improve: ${text}\n`);
  return process.exit(2);
};

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const number = (name: string, fallback: number): number => {
  const text = flag(name);
  if (text === undefined) return fallback;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : fail(`--${name} must be a positive number`);
};

function budgetOf(): LoopBudget {
  return { usd: number('budget', 12), experiments: Math.floor(number('experiments', 3)), minutes: number('minutes', 180) };
}

function kindsOf(): ExperimentKind[] {
  const text = flag('kinds');
  if (text === undefined) return [...EXPERIMENT_ORDER];
  const kinds = text.split(',').map((kind) => kind.trim());
  for (const kind of kinds) if (!EXPERIMENT_ORDER.includes(kind as ExperimentKind)) fail(`--kinds: unknown kind ${kind}`);
  return kinds as ExperimentKind[];
}

function dryRun(): void {
  const budget = budgetOf();
  const share = allowances(budget);
  const spare: Reservation = { label: 'dry', cap: 1, settled: false };
  const base = flag('base');
  out('One run of the improvement loop (nothing is run by this command):');
  out(`  budget      $${budget.usd.toFixed(2)} (the CLI's own usage estimate on the owner's login), ${budget.experiments} experiments, ${budget.minutes} minutes. Money is set aside before each call, each call carries its own cap, and an honest held-out measurement that does not fit its share is not run cheaper: the run stops.`);
  out(`  split       critic $${share.critic.toFixed(2)}, tune baseline $${share.tuneBaseline.toFixed(2)}; each experiment $${share.perExperiment.toFixed(2)} (builder $${share.builder.toFixed(2)}, measurement $${share.measure.toFixed(2)}, reviewer $${share.reviewer.toFixed(2)})`);
  out(`  base        ${base ?? 'the branch the repository is on'}, taken as a commit; every tree the run makes is detached from it, so there is no branch for a clean-up to delete. Branches the run may delete: only the loop/ ones it made.`);
  out('  gate        with a taste sheet for the rubric in use, the judge must agree with the owner (taste floor) or the loop stops before it spends on a critic; with none, the run is UNCALIBRATED: it proposes, writes the proposals down as outcome "proposed", and builds nothing');
  out('  measure     the tune set on the base; its judgements, the findings queued from real turns (loop/queue/findings.jsonl), and nothing of the held-out set, go to the critic');
  out(`  critic      ${LOOP_ROLES.critic.model}, effort ${LOOP_ROLES.critic.effort}: proposes up to ${budget.experiments} experiments (${EXPERIMENT_ORDER.join(', then ')})`);
  out(`  builder     ${LOOP_ROLES.builder.model}, effort ${LOOP_ROLES.builder.effort}, --restricted: works in an EXPORT of the base commit under the system's temporary folder (no .git, no sealed path, nothing of the repository reachable) and has NO shell; a refused diff is rebuilt once (${DEFAULTS.attempts} attempts)`);
  out(`  checks      run by the runner, not the builder, from the base commit's scripts, in a detached copy of the candidate: ${RUNNER_COMMANDS.map((command) => `pnpm ${command.join(' ')}`).join(', ')}`);
  out("  guard       protected path (the harness: battery, counters, sight, geometry, barrel, judge, library), battery text (counted, never quoted), the kind's own folders, the checks: a diff that fails any is discarded unmeasured");
  out(`  re-measure  held-out set (read from BATTERY_SEALED_DIR, in no tree), ${DEFAULTS.rounds} rounds each of baseline and candidate, interleaved (${interleave(DEFAULTS.rounds).join(' ')}), ${DEFAULTS.samples} samples a prompt (never fewer than ${MIN_SAMPLES}); both arms by the BASE commit's harness, each with its own LIBRARY_OVERLAY, asserted loaded before any money is spent; one judge, same rubric hash or no comparison`);
  out(`  decide      paired by prompt. Kept only if an aimed family rises by ${KEEP_RULE.gain} with its lower confidence bound (the mean less t standard errors) still there, and no family's coherence (fall ${KEEP_RULE.slip}), correct answers (${KEEP_RULE.correctSlip}), own measure (chartQuality, responds, readable), collisions (+${KEEP_RULE.collisionRise}), tokens (+${Math.round(KEEP_RULE.tokenGrowth * 100)}%) or first line (+${KEEP_RULE.firstLineSlip} ms) worsens by its allowance with a difference clear of chance (only a metric the harness reports per prompt can be); a family with nothing judged is absent; a tie is a discard`);
  out(`  reviewer    ${LOOP_ROLES.reviewer.model}, effort ${LOOP_ROLES.reviewer.effort}: reads a kept diff cold; no answer in the form is an objection`);
  out('  steward     `pnpm improve approve|refuse <id>`: merges an approved branch into the integration branch; a kept technique stays an overlay file');
  out('  records     loop/ledger.jsonl and loop/CHANGELOG.md, every experiment, written even when the run is interrupted');
  out(`\nProtected paths: ${PROTECTED_PATHS.join('  ')}  (and package.json, tsconfig*.json, vite.config.* wherever they are)`);
  out(`Never put in any tree the builder or the critic can reach: ${SEALED_PATHS.join('  ')}`);
  out('\nWhat confines each agent (the CLI flags, not a request):');
  for (const kind of ['critic', 'builder', 'reviewer'] as const) out(`  ${kind}: claude ${agentArguments({ kind, role: LOOP_ROLES[kind], reservation: spare }).join(' ').slice(0, 900)}`);
  out(`\nA real run needs --yes, because it spends:  pnpm improve --budget ${budget.usd} --experiments ${budget.experiments}${base === undefined ? '' : ` --base ${base}`} --yes`);
}

async function realRun(): Promise<void> {
  const budget = budgetOf();
  if (!has('yes')) {
    dryRun();
    fail('this would spend up to the budget above; add --yes to run it');
  }
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  const base = flag('base');
  const result = await runLoop(
    realDeps(repo, out),
    { budget, kinds: kindsOf(), samples: Math.floor(number('samples', DEFAULTS.samples)), rounds: Math.floor(number('rounds', DEFAULTS.rounds)), attempts: DEFAULTS.attempts, ...(base === undefined ? {} : { base }) },
    stop.signal,
  );
  out(`\n${result.records.length} experiment(s): ${result.records.map((record) => `${record.id} ${record.outcome}`).join(', ') || 'none'}; spent $${result.spent.toFixed(2)}; ${result.stoppedBecause}`);
}

async function standIn(): Promise<void> {
  const folder = await mkdtemp(join(process.env['LOOP_SCRATCH'] ?? tmpdir(), 'conduit-loop-'));
  const scratch = join(folder, 'repo');
  try {
    await initScratch(scratch, {
      'explore/battery.json': '{"version":1,"prompts":[{"id":"a","prompt":"Explain how a bill becomes a law as a flow of steps","expects":"drawn","baseline":false}]}\n',
      'explore/sealed/heldout.json': '{"version":1,"pool":"heldout","prompts":[{"id":"h","prompt":"a distinctive held out prompt sentence","expects":"drawn","baseline":false}]}\n',
      'techniques/seed/example.md': '# Example\n',
      'loop/CHANGELOG.md': await readFile(join(repo, 'loop', 'CHANGELOG.md'), 'utf8'),
      'language/src/prompt.ts': '// prompt\n',
    });
    // a branch to base the run on that is NOT the one checked out: a run that deleted or moved it would show
    await branchAt(scratch, 'integration', 'main');
    const base = flag('base');
    const before = await branches(scratch);
    const agents = standInAgents(flag('reviewer') === 'objects' ? 'objects' : 'approves');
    const result = await runLoop(
      standInDeps(scratch, out, agents, !has('uncalibrated')),
      { budget: { usd: Number(flag('budget') ?? 6), experiments: 2, minutes: 20 }, kinds: [...EXPERIMENT_ORDER], samples: 3, rounds: 2, attempts: 2, ...(base === undefined ? {} : { base }) },
      new AbortController().signal,
    );
    out('\n--- loop/ledger.jsonl ---');
    out(await readFile(join(scratch, 'loop', 'ledger.jsonl'), 'utf8'));
    out('--- loop/CHANGELOG.md ---');
    out(await readFile(join(scratch, 'loop', 'CHANGELOG.md'), 'utf8'));
    const trees = (await worktrees(scratch)).filter((path) => path !== scratch && !scratch.endsWith(path) && !path.endsWith('/repo'));
    const after = await branches(scratch);
    out('--- what is left behind ---');
    out(`agent calls: ${agents.calls.join(', ')}`);
    out(`worktrees other than the repository: ${trees.length === 0 ? 'none' : trees.join(', ')}`);
    out(`git branch before: ${before.join(', ')}`);
    out(`git branch after:  ${after.join(', ')}${after.join() === before.join() ? '   (unchanged)' : "   (an approved experiment's loop/ branch is kept until the steward decides)"}`);
    out(`spent $${result.spent.toFixed(2)} of $${flag('budget') ?? '6'}; stopped because: ${result.stoppedBecause}`);
    if (trees.length > 0 || before.some((branch) => !after.includes(branch))) process.exitCode = 1;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function folded(lines: readonly LedgerLine[]): { record: ExperimentRecord; verdict: Extract<LedgerLine, { kind: 'verdict' }> | null }[] {
  const experiments = lines.filter((line): line is Extract<LedgerLine, { kind: 'experiment' }> => line.kind === 'experiment');
  return experiments.map((record) => ({ record, verdict: lines.find((line): line is Extract<LedgerLine, { kind: 'verdict' }> => line.kind === 'verdict' && line.id === record.id) ?? null }));
}

async function status(): Promise<void> {
  const lines = await readLedger(join(repo, 'loop'));
  const all = folded(lines);
  const waiting = all.filter((entry) => entry.record.outcome === 'awaiting-steward' && entry.verdict === null);
  out(waiting.length === 0 ? 'Nothing is awaiting the steward.' : 'Awaiting the steward:');
  for (const { record } of waiting) out(`  ${record.id}${record.uncalibrated === true ? ' [UNCALIBRATED]' : ''}  ${record.proposal.kind}: ${record.proposal.title}  (branch ${record.branch}; ${record.decision?.reasons.join('; ') ?? ''})`);
  out('\nLast entries:');
  for (const { record, verdict } of all.slice(-8)) out(`  ${record.started.slice(0, 16)}  ${record.id}  ${record.outcome}${verdict === null ? '' : `, steward ${verdict.approve ? 'approved' : 'refused'}`}  $${record.usd.toFixed(2)}  ${record.proposal.title}`);
  const runs = lines.filter((line): line is Extract<LedgerLine, { kind: 'run' }> => line.kind === 'run');
  const spent = runs.reduce((sum, run) => sum + run.spent, 0);
  out(`\n${runs.length} run(s), $${spent.toFixed(2)} spent in all.`);
}

async function pending(id: string | undefined): Promise<ExperimentRecord> {
  if (id === undefined) return fail('which experiment? `pnpm improve status` lists them');
  const found = folded(await readLedger(join(repo, 'loop'))).find((entry) => entry.record.id === id);
  if (found === undefined) return fail(`no experiment ${id} in the ledger`);
  if (found.record.outcome !== 'awaiting-steward') return fail(`${id} is ${found.record.outcome}, not awaiting the steward`);
  if (found.verdict !== null) return fail(`${id} already has a verdict (${found.verdict.approve ? 'approved' : 'refused'})`);
  return found.record;
}

async function verdict(approve: boolean): Promise<void> {
  const id = argv[1];
  const found = await pending(id);
  const why = flag('why') ?? (approve ? 'approved' : fail('refuse needs --why "..."'));
  const loopDir = join(repo, 'loop');
  let merged: string | null = null;
  if (approve) {
    const into = flag('into') ?? (await currentBranch(repo));
    if (into === 'main') fail('the loop never merges into main: that is the owner\'s');
    if (await isDirty(repo, ['loop'])) fail('loop/ has uncommitted changes; commit or stash them first');
    if (into !== (await currentBranch(repo))) await checkout(repo, into);
    const files = await filesBetween(repo, into, found.branch);
    merged = await mergeBranch(repo, found.branch, `Merge experiment ${found.id}: ${found.proposal.title}`);
    out(`merged ${found.branch} into ${into} as ${merged.slice(0, 8)}`);
    const techniques = files.filter((file) => file.startsWith('techniques/overlay/'));
    for (const file of techniques) out(`kept as ${file}; to make it permanent, move it into techniques/seed/ and commit it`);
    await dropBranch(repo, found.branch, new Set([found.branch]));
  } else {
    const gone = await dropBranch(repo, found.branch, new Set([found.branch]));
    out(gone ? `refused ${found.id}; branch ${found.branch} deleted` : `refused ${found.id}; branch ${found.branch} was not deleted (it is not a loop/ branch)`);
  }
  await appendLedger(loopDir, { kind: 'verdict', id: found.id, at: new Date().toISOString(), by: 'steward', approve, why, merged });
  await appendChangelog(loopDir, verdictEntry(found.id, { by: 'steward', approve, why }, merged));
}

async function vault(): Promise<void> {
  const given = flag('file') ?? fail('vault needs --file <path to the vault battery>');
  // `pnpm improve` runs in the server's folder; a relative path means relative to where the person typed it
  const file = resolve(process.env['INIT_CWD'] ?? process.cwd(), given);
  if (file.startsWith(repo)) fail('the vault set must be kept outside the repository');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return fail(`cannot read the vault set at ${file}`);
  const budget = number('budget', 4);
  if (!has('yes')) fail(`this would measure the vault set on main and on the integration branch, spending up to $${budget.toFixed(2)}; add --yes to run it`);
  const meter = new Meter({ usd: budget, experiments: 1, minutes: 60 });
  const integration = await currentBranch(repo);
  // both arms are measured by the integration branch's harness, whatever main holds
  const harness = await head(repo, integration);
  const measurer = exploreMeasurer();
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const trees: string[] = [];
  const arms: { baseline: Awaited<ReturnType<typeof measurer.measure>>[]; candidate: Awaited<ReturnType<typeof measurer.measure>>[] } = { baseline: [], candidate: [] };
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
  try {
    for (const [name, ref] of [['baseline', 'main'], ['candidate', integration]] as const) {
      const path = join(repo, 'loop', 'runs', `vault-${stamp}-${name}`);
      const tree = await measuringTree(repo, path, await head(repo, ref), harness, isProtected);
      trees.push(tree.path);
      await exec({ bin: 'pnpm', args: ['install', '--offline', '--frozen-lockfile'], cwd: tree.path, timeoutMs: 300_000 });
      await writeFile(join(tree.path, 'explore', 'vault.json'), text);
    }
    const estimate = await measurer.estimate(trees[0] as string, 'vault', DEFAULTS.samples);
    for (const arm of interleave(1)) {
      const reservation = meter.reserve(`vault ${arm}`, estimate, estimate);
      if (typeof reservation === 'string') return fail(reservation);
      const got = await measurer.measure(trees[arm === 'baseline' ? 0 : 1] as string, { pool: 'vault', samples: DEFAULTS.samples, capUsd: reservation.cap, signal: stop.signal, label: `vault ${arm}`, sealedDir: null });
      meter.settle(reservation, typeof got === 'string' ? null : got.usd);
      arms[arm].push(got);
    }
  } finally {
    for (const path of trees) await dropTree(repo, path);
  }
  const [was, is] = [arms.baseline[0], arms.candidate[0]];
  if (was === undefined || is === undefined || typeof was === 'string' || typeof is === 'string') return fail(`the vault could not be measured: ${typeof was === 'string' ? was : typeof is === 'string' ? is : 'no run'}`);
  out(`vault, main against ${integration} (judge ${was.rubric === is.rubric ? 'the same' : 'DIFFERENT: not comparable'}):`);
  for (const family of Object.keys({ ...was.families, ...is.families })) {
    const a = was.families[family as keyof typeof was.families];
    const b = is.families[family as keyof typeof is.families];
    out(`  ${family.padEnd(12)} ${a === undefined ? '-' : a.coherence.toFixed(2)} -> ${b === undefined ? '-' : b.coherence.toFixed(2)}`);
  }
  out('A rise on the tune and held-out sets that is absent here is a system that learned the tests; tell the owner.');
}

const command = argv[0];
if (has('dry-run')) dryRun();
else if (has('stand-in')) await standIn();
else if (has('gates')) await runGates(out);
else if (has('resample')) out(resampleReport(Math.floor(number('trials', 2000))));
else if (command === 'status') await status();
else if (command === 'approve') await verdict(true);
else if (command === 'refuse') await verdict(false);
else if (command === 'vault') await vault();
else if (command === undefined || command.startsWith('--')) await realRun();
else fail(`unknown command ${command}`);
