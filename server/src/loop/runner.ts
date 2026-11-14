// One run of the loop, from the critic to the records. Everything that touches a model, a battery, the machine's
// package manager or the owner's scores is handed in (`Deps`), so the same function runs with stand-ins.
//
// What it guarantees, whatever the deps do:
//   - money is set aside before a call is started and counted from what the call reports (budget.ts);
//   - the loop never deletes a branch it did not make: every tree it measures or checks is DETACHED, so there is no branch to
//     remove, and a branch is deleted only if this run made it and its name starts `loop/` (git.ts);
//   - the builder works in an EXPORT of the base commit, outside the repository, with no `.git`, no sealed path and no shell
//     (agents.ts); what it wrote is compared with an untouched export by code (export.ts), checked by file rules (guard.ts), and
//     only then turned into a commit by git plumbing; typecheck, timeline and the prompt budget are run FOR it, by the runner,
//     from the base commit's scripts, on a detached copy of the candidate;
//   - both arms are measured by the BASE commit's harness: every protected path (the battery, its counters, the sight and geometry
//     they stand on, the judge, the library, the barrel) is put back as the base has it in the tree that is measured;
//   - the held-out set is read from `BATTERY_SEALED_DIR`, outside every tree; no tree holds it;
//   - baseline and candidate are measured interleaved on the held-out set, at least three samples a prompt, by one judge, and
//     PAIRED by prompt: the gain and every veto must each clear their own standard error (guard.ts `decide`);
//   - the loop does not steer by a judge the owner has not checked (the taste floor); with no sheet at all it proposes and builds nothing;
//   - every experiment writes both records, whatever happened to it;
//   - when it returns, or is interrupted, no worktree it made, no export it made and no process it started is left.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASTE_FLOOR } from '@conduit/language';
import type { TasteAgreement } from '@conduit/language';
import type { Agents, AgentCall, AgentKind } from './agents';
import { Meter } from './budget';
import { decide, leaksBattery, outsideKind, isProtected, touchesProtected, SEALED_PATHS } from './guard';
import { changesOf, dropExport, exportTree } from './export';
import type { Export } from './export';
import { commitChanges, currentBranch, dropBranch, dropTree, head, measuringTree, patchBetween } from './git';
import type { Tree } from './git';
import { appendLedger, record } from './ledger';
import { compare, interleave, pool } from './measure';
import type { Measurer } from './measure';
import { builderPrompt, criticPrompt, readProposals, readVerdict, reviewerPrompt } from './prompts';
import { EXPERIMENT_ORDER, LOOP_ROLES, MIN_SAMPLES } from './types';
import type { ExperimentKind, ExperimentRecord, LoopBudget, Measure, Proposal, Verdict } from './types';

export interface Deps {
  readonly repo: string;
  readonly agents: Agents;
  readonly measurer: Measurer;
  /** installs what a fresh detached tree needs to run; nothing for a stand-in */
  readonly prepare: (tree: string) => Promise<void>;
  /** typecheck, timeline and the prompt budget, run BY THE RUNNER in a detached copy of the candidate, from the base commit's scripts: the reasons it fails, none when it passes */
  readonly checks: (tree: string) => Promise<readonly string[]>;
  /** the folder, outside every tree, that holds the held-out set; null when there is none */
  readonly sealedDir: string | null;
  /** the judge against the owner's own scores, for the rubric in use */
  readonly taste: (rubric: string) => Promise<TasteAgreement | null>;
  /** distinctive runs of words from every pool's prompts, the sealed ones included: the runner may read them, no agent may */
  readonly phrases: () => Promise<readonly string[]>;
  /** writes the critic's briefing (tune-set material and the findings queued from real use; never held-out material) into a folder and names the files */
  readonly briefing: (folder: string, baseline: Measure, tree: string) => Promise<readonly string[]>;
  readonly log: (line: string) => void;
}

export interface RunOptions {
  readonly budget: LoopBudget;
  readonly kinds: readonly ExperimentKind[];
  /** samples per prompt in each battery run (the quality bar's three) */
  readonly samples: number;
  /** how many times each arm is run on the held-out set, interleaved */
  readonly rounds: number;
  /** a builder is given one more try when its diff is refused by the guard */
  readonly attempts: number;
  /** the branch merged into; the base every experiment starts from */
  readonly base?: string;
}

export const DEFAULTS = { samples: 3, rounds: 2, attempts: 2 } as const;

export interface Allowance {
  readonly critic: number;
  readonly tuneBaseline: number;
  readonly perExperiment: number;
  readonly builder: number;
  readonly measure: number;
  readonly reviewer: number;
}

/** How a budget is split before a call is made, so that the last experiment is not starved by the first. */
export function allowances(budget: LoopBudget): Allowance {
  const critic = budget.usd * 0.1;
  const tuneBaseline = budget.usd * 0.1;
  const perExperiment = (budget.usd - critic - tuneBaseline) / Math.max(1, budget.experiments);
  return { critic, tuneBaseline, perExperiment, builder: perExperiment * 0.3, measure: perExperiment * 0.55, reviewer: perExperiment * 0.15 };
}

export interface RunResult {
  readonly records: readonly ExperimentRecord[];
  readonly spent: number;
  readonly stoppedBecause: string;
}

const MINUTE = 60_000;

export async function runLoop(deps: Deps, options: RunOptions, outer: AbortSignal): Promise<RunResult> {
  const { repo, log } = deps;
  const loopDir = join(repo, 'loop');
  const meter = new Meter(options.budget);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
  const scratch = join(loopDir, 'runs', stamp);
  const stop = new AbortController();
  const onOuter = (): void => stop.abort();
  outer.addEventListener('abort', onOuter, { once: true });
  const deadline = setTimeout(() => stop.abort(), options.budget.minutes * MINUTE);
  deadline.unref();
  /** detached trees this run made: none has a branch */
  const trees: string[] = [];
  /** exports this run made for builders */
  const exports: Export[] = [];
  /** the branches this run made, and of those the ones to keep for the steward: the only branches this run will ever delete */
  const made = new Set<string>();
  const kept = new Set<string>();
  const records: ExperimentRecord[] = [];
  const share = allowances(options.budget);
  let stoppedBecause = 'finished';

  const tree = async (make: () => Promise<Tree>): Promise<Tree> => {
    const built = await make();
    trees.push(built.path);
    await deps.prepare(built.path);
    return built;
  };
  const release = async (path: string): Promise<void> => {
    await dropTree(repo, path);
    const at = trees.indexOf(path);
    if (at >= 0) trees.splice(at, 1);
  };

  const call = async (kind: AgentKind, label: string, want: number, prompt: string, cwd: string): Promise<{ text: string; failed: string | null } | string> => {
    const reservation = meter.reserve(label, want, 0.05);
    if (typeof reservation === 'string') return reservation;
    const request: AgentCall = { kind, role: LOOP_ROLES[kind], prompt, cwd, reservation, signal: stop.signal, timeoutMs: Math.min(30 * MINUTE, Math.max(MINUTE, meter.minutesLeft * MINUTE)) };
    const reply = await deps.agents.run(request);
    meter.settle(reservation, reply.usd);
    return { text: reply.text, failed: reply.failed };
  };

  try {
    await mkdir(scratch, { recursive: true });
    if (options.samples < MIN_SAMPLES) return finish(`${options.samples} sample(s) a prompt is fewer than ${MIN_SAMPLES}: a run on fewer measures the draw, not the change`);
    if (options.rounds < 2) return finish('one round an arm gives no noise to hold a gain against: at least two');
    const baseRef = options.base ?? (await currentBranch(repo));
    const baseCommit = await head(repo, baseRef);
    log(`run ${stamp}: base ${baseRef} at ${baseCommit.slice(0, 8)}, budget $${options.budget.usd.toFixed(2)}, ${options.budget.experiments} experiments, ${options.budget.minutes} minutes`);

    // 0. the baseline is a detached checkout of the base commit: it has no branch, so nothing can delete one through it, and no sealed set in it
    const baseline = await tree(() => measuringTree(repo, join(scratch, 'baseline'), baseCommit, baseCommit, isProtected));

    // 1. measure the tune set: this is all the critic will ever see of the measurements
    const tuneEstimate = await deps.measurer.estimate(baseline.path, 'tune', options.samples);
    const tuneReservation = meter.reserve('tune baseline', Math.min(share.tuneBaseline, tuneEstimate), tuneEstimate);
    if (typeof tuneReservation === 'string') return finish(`the tune set cannot be measured within the budget: ${tuneReservation}`);
    const tune = await deps.measurer.measure(baseline.path, { pool: 'tune', samples: options.samples, capUsd: tuneReservation.cap, signal: stop.signal, label: 'tune baseline', sealedDir: null });
    meter.settle(tuneReservation, typeof tune === 'string' ? null : tune.usd);
    if (typeof tune === 'string') return finish(`could not measure the tune set: ${tune}`);

    // The judge must have been checked against the owner before the loop is allowed to steer by it. With no sheet at all (the owner has not
    // scored twenty answers yet) the loop PROPOSES and builds nothing: every record says so, and what it proposed waits for a calibrated judge.
    const taste = await deps.taste(tune.rubric);
    const uncalibrated = taste === null;
    if (taste !== null && (taste.n < TASTE_FLOOR.n || taste.agreement < TASTE_FLOOR.agreement || taste.kappa < TASTE_FLOOR.kappa)) {
      return finish(`the judge agrees with the owner too little to steer by (${Math.round(taste.agreement * 100)}% on ${taste.n}, kappa ${taste.kappa.toFixed(2)}; the floor is ${Math.round(TASTE_FLOOR.agreement * 100)}% and ${TASTE_FLOOR.kappa})`);
    }
    if (uncalibrated) log('UNCALIBRATED: no taste sheet for this rubric; the loop will propose and build nothing');

    // 2. the critic
    const briefFolder = join(scratch, 'briefing');
    await mkdir(briefFolder, { recursive: true });
    const files = await deps.briefing(briefFolder, tune, baseline.path);
    const phrases = await deps.phrases();
    const asked = await call('critic', 'critic', share.critic, criticPrompt(options.budget.experiments, files), briefFolder);
    if (typeof asked === 'string') return finish(`the critic could not be asked: ${asked}`);
    if (asked.failed !== null) return finish(`the critic failed: ${asked.failed}`);
    const read = readProposals(asked.text, stamp, options.budget.experiments, phrases);
    for (const why of read.dropped) log(`critic: ${why}`);
    const proposals = read.proposals.filter((proposal) => options.kinds.includes(proposal.kind));
    if (proposals.length === 0) return finish('the critic proposed nothing that could be built');
    log(`critic: ${proposals.length} proposal(s): ${proposals.map((proposal) => `${proposal.kind}: ${proposal.title}`).join(' | ')}`);

    if (uncalibrated) {
      for (const proposal of proposals) {
        records.push({ id: proposal.id, started: new Date().toISOString(), proposal, branch: '', diff: [], refused: [], before: null, after: null, decision: null, verdicts: [], taste: null, uncalibrated: true, usd: 0, outcome: 'proposed' });
      }
      return finish('proposed only: the judge has not been checked against the owner, so nothing was built');
    }

    // 3 to 9. each proposal, cheapest kind first, each to its own end
    for (const proposal of proposals) {
      if (stop.signal.aborted) {
        stoppedBecause = outer.aborted ? 'interrupted' : 'out of time';
        break;
      }
      const result = await experiment(proposal);
      records.push(result.record);
      if (result.stop !== null) {
        stoppedBecause = result.stop;
        break;
      }
    }
    return finish(stoppedBecause);

    async function experiment(proposal: Proposal): Promise<{ record: ExperimentRecord; stop: string | null }> {
      const started = new Date().toISOString();
      const spentBefore = meter.spent;
      let refused: string[] = [];
      const history: string[] = [];
      let diff: ExperimentRecord['diff'] = [];
      let before: Measure | null = null;
      let after: Measure | null = null;
      let decision: ExperimentRecord['decision'] = null;
      const verdicts: Verdict[] = [];
      let outcome: ExperimentRecord['outcome'] = 'failed';
      let stopped: string | null = null;
      let built: { readonly branch: string; readonly commit: string; readonly tree: Tree } | null = null;
      const branchOf = (attempt: number): string => (attempt === 1 ? `loop/${proposal.id}` : `loop/${proposal.id}-b${attempt}`);
      try {
        // BUILD, and BUILD AGAIN when the guard refuses the diff
        for (let attempt = 1; attempt <= options.attempts; attempt++) {
          const mine = await exportTree(repo, baseCommit, SEALED_PATHS);
          exports.push(mine);
          const said = await call('builder', `build ${proposal.id}#${attempt}`, share.builder, builderPrompt(proposal, refused), mine.work);
          if (typeof said === 'string') {
            stopped = said;
            refused = [];
            outcome = 'failed';
            break;
          }
          const changed = await changesOf(mine);
          diff = changed.files.map(({ file, added, removed }) => ({ file, added, removed }));
          const reasons: string[] = [];
          if (said.failed !== null) reasons.push(`the builder failed: ${said.failed}`);
          if (changed.files.length === 0) reasons.push('the builder changed nothing');
          for (const file of changed.odd) reasons.push(`it made something that is not a regular file: ${file}`);
          const names = changed.files.map((change) => change.file);
          for (const file of touchesProtected(names)) reasons.push(`it changed a protected path: ${file}`);
          for (const file of outsideKind(proposal.kind, names)) reasons.push(`it changed ${file}, which a ${proposal.kind} experiment does not change`);
          // counted, never quoted: this line goes back to the builder and into the changelog
          const leaked = leaksBattery(changed.addedText, phrases);
          if (leaked.length > 0) reasons.push(`it carries text taken from ${leaked.length} battery prompt(s); teach the kind of answer, not the question`);
          let candidate: { branch: string; commit: string; tree: Tree } | null = null;
          if (reasons.length === 0) {
            // what it wrote becomes a commit by plumbing, then a DETACHED copy of that commit, with the base's harness put back, is what is checked
            const branch = branchOf(attempt);
            const commit = await commitChanges(repo, baseCommit, branch, mine.work, changed.files, `loop ${proposal.id}: ${proposal.title}`);
            made.add(branch);
            const folder = join(scratch, `${proposal.id}-b${attempt}`);
            const copy = await tree(() => measuringTree(repo, folder, commit, baseCommit, isProtected));
            for (const failure of await deps.checks(copy.path)) reasons.push(`it fails ${failure}`);
            if (reasons.length === 0) candidate = { branch, commit, tree: copy };
            else {
              await release(copy.path);
              await dropBranch(repo, branch, made);
              made.delete(branch);
            }
          }
          if (candidate !== null) {
            built = candidate;
            refused = [];
            break;
          }
          refused = reasons;
          history.push(`attempt ${attempt}: ${reasons.join('; ')}`);
          log(`${proposal.id}: attempt ${attempt} refused: ${reasons.join('; ')}`);
          await dropExport(mine);
          exports.splice(exports.indexOf(mine), 1);
          if (said.failed !== null && said.failed.startsWith('stopped')) break;
        }
        if (built === null) {
          outcome = history.length > 0 && refused.length > 0 ? 'refused' : 'failed';
          return { record: finalise(), stop: stopped };
        }
        const candidate = built;
        for (const handed of exports.splice(0)) await dropExport(handed);

        // RE-MEASURE: baseline and candidate on the held-out set, interleaved, both by the base commit's harness
        const estimate = await deps.measurer.estimate(candidate.tree.path, 'heldout', options.samples);
        const runs = interleave(options.rounds);
        const total = estimate * runs.length;
        // the budget holds on measurement: what an honest measurement needs must fit the experiment's own share and what is left, or it is not run cheaper
        if (total > Math.min(share.measure, meter.remaining) + 1e-9) {
          refused = [];
          stopped = `an honest measurement of ${proposal.id} needs about $${total.toFixed(2)} (its share is $${share.measure.toFixed(2)}, $${meter.remaining.toFixed(2)} is left)`;
          outcome = 'failed';
          return { record: finalise(), stop: stopped };
        }
        const arms: Record<'baseline' | 'candidate', Measure[]> = { baseline: [], candidate: [] };
        for (const [index, arm] of runs.entries()) {
          if (stop.signal.aborted) break;
          const reservation = meter.reserve(`measure ${proposal.id} ${arm} ${index + 1}`, estimate, estimate);
          if (typeof reservation === 'string') {
            stopped = reservation;
            break;
          }
          const got = await deps.measurer.measure(arm === 'baseline' ? baseline.path : candidate.tree.path, { pool: 'heldout', samples: options.samples, capUsd: reservation.cap, signal: stop.signal, label: `${proposal.id} ${arm} ${index + 1}`, sealedDir: deps.sealedDir });
          meter.settle(reservation, typeof got === 'string' ? null : got.usd);
          if (typeof got === 'string') {
            log(`${proposal.id}: ${got}`);
            stopped = got;
            break;
          }
          if (got.usd > reservation.cap * 1.05 + 1e-9) {
            stopped = `the battery spent $${got.usd.toFixed(2)} on a call capped at $${reservation.cap.toFixed(2)}: the run is stopped so that the budget holds`;
            arms[arm].push(got);
            break;
          }
          arms[arm].push(got);
        }
        if (stopped !== null || arms.baseline.length < 2 || arms.candidate.length < 2) {
          stopped = stopped ?? 'the measurement was cut short';
          outcome = 'failed';
          return { record: finalise(), stop: stopped };
        }
        const pooledBefore = pool(arms.baseline);
        const pooledAfter = pool(arms.candidate);
        const comparison = compare(arms.baseline, arms.candidate);
        if (typeof pooledBefore === 'string' || typeof pooledAfter === 'string' || typeof comparison === 'string') {
          outcome = 'failed';
          log(`${proposal.id}: ${typeof pooledBefore === 'string' ? pooledBefore : typeof pooledAfter === 'string' ? pooledAfter : String(comparison)}`);
          return { record: finalise(), stop: null };
        }
        before = pooledBefore;
        after = pooledAfter;

        // DECIDE: the gain and every veto must clear their own standard error, paired by prompt
        decision = decide(proposal, comparison);
        if (!decision.keep) {
          outcome = 'discarded';
          return { record: finalise(), stop: null };
        }

        // REVIEW: a cold reader looks for the test being gamed
        const reviewFolder = join(scratch, `${proposal.id}-review`);
        await mkdir(reviewFolder, { recursive: true });
        await writeFile(join(reviewFolder, 'diff.patch'), await patchBetween(repo, baseCommit, candidate.commit));
        await writeFile(join(reviewFolder, 'numbers.md'), numbersFor(before, after, decision.reasons));
        await writeFile(join(reviewFolder, 'proposal.md'), `${proposal.title}\n\n${proposal.hypothesis}\n\n${proposal.brief}\n`);
        const reviewed = await call('reviewer', `review ${proposal.id}`, share.reviewer, reviewerPrompt(proposal), reviewFolder);
        if (typeof reviewed === 'string') {
          // an experiment nobody could check is not kept
          verdicts.push({ by: 'reviewer', approve: false, why: `no review was possible: ${reviewed}` });
          stopped = reviewed;
          outcome = 'discarded';
          return { record: finalise(), stop: stopped };
        }
        const verdict = reviewed.failed === null ? readVerdict(reviewed.text) : { approve: false, why: `the reviewer failed: ${reviewed.failed}` };
        verdicts.push({ by: 'reviewer', ...verdict });
        outcome = verdict.approve ? 'awaiting-steward' : 'discarded';
        if (outcome === 'awaiting-steward') kept.add(candidate.branch);
        return { record: finalise(), stop: null };
      } finally {
        for (const path of [...trees]) if (path !== baseline.path) await release(path);
        for (const handed of exports.splice(0)) await dropExport(handed);
        for (const branch of [...made]) {
          if (kept.has(branch)) continue;
          await dropBranch(repo, branch, made);
          made.delete(branch);
        }
      }

      function finalise(): ExperimentRecord {
        const result: ExperimentRecord = {
          id: proposal.id,
          started,
          proposal,
          branch: built?.branch ?? '',
          diff,
          refused: history,
          before,
          after,
          decision,
          verdicts,
          taste,
          ...(uncalibrated ? { uncalibrated: true } : {}),
          usd: meter.spent - spentBefore,
          outcome,
        };
        return result;
      }
    }

    async function finish(why: string): Promise<RunResult> {
      stoppedBecause = why;
      return { records, spent: meter.spent, stoppedBecause };
    }
  } finally {
    clearTimeout(deadline);
    outer.removeEventListener('abort', onOuter);
    stop.abort();
    for (const path of [...trees]) await dropTree(repo, path);
    for (const handed of exports.splice(0)) await dropExport(handed);
    for (const branch of [...made]) if (!kept.has(branch)) await dropBranch(repo, branch, made);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    // the records are written last of all and whatever happened: an interrupted run still says what it did
    for (const result of records) await record(loopDir, result);
    await appendLedger(loopDir, { kind: 'run', at: new Date().toISOString(), spent: meter.spent, budget: options.budget.usd, stoppedBecause, experiments: records.length });
    log(`spent $${meter.spent.toFixed(2)} of $${options.budget.usd.toFixed(2)}; stopped because: ${stoppedBecause}`);
    if (meter.overrun > 0) log(`WARNING: the budget was passed by $${meter.overrun.toFixed(2)}`);
  }
}

function numbersFor(before: Measure, after: Measure, reasons: readonly string[]): string {
  const rows = Object.keys({ ...before.families, ...after.families }).map((family) => {
    const was = before.families[family as keyof typeof before.families];
    const is = after.families[family as keyof typeof after.families];
    return `| ${family} | ${was === undefined ? '-' : was.coherence.toFixed(2)} | ${is === undefined ? '-' : is.coherence.toFixed(2)} | ${was === undefined ? '-' : Math.round(was.correct * 100)}% | ${is === undefined ? '-' : Math.round(is.correct * 100)}% | ${was === undefined ? '-' : Math.round(was.tokens)} | ${is === undefined ? '-' : Math.round(is.tokens)} |`;
  });
  return ['# Held-out, baseline against candidate', '', '| family | coherence before | after | correct before | after | tokens before | after |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows, '', 'The rule said:', ...reasons.map((reason) => `- ${reason}`), ''].join('\n');
}

export { EXPERIMENT_ORDER };
