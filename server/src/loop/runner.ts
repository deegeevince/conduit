// One run of the loop, from the critic to the records. Everything that touches a model, a battery, the machine's
// package manager or the owner's scores is handed in (`Deps`), so the same function runs with stand-ins.
//
// What it guarantees, whatever the deps do:
//   - money is set aside before a call is started and counted from what the call reports (budget.ts);
//   - the builder works in a worktree of its own, with the sealed paths absent, and its diff is checked by code
//     (protected paths, battery text, the kind's own folders, typecheck, prompt budget) before anything is measured;
//   - baseline and candidate are measured interleaved on the held-out set, by one judge, and a gain no bigger than
//     the baseline's own round-to-round spread is no gain;
//   - the loop does not steer by a judge the owner has not checked (the taste floor);
//   - every experiment writes both records, whatever happened to it;
//   - when it returns, or is interrupted, no worktree it made and no process it started is left.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASTE_FLOOR } from '@conduit/language';
import type { TasteAgreement } from '@conduit/language';
import type { Agents, AgentCall, AgentKind } from './agents';
import { Meter } from './budget';
import { KEEP_RULE, decide, leaksBattery, outsideKind, touchesProtected, SEALED_PATHS } from './guard';
import { changesIn, commitAll, currentBranch, dropTree, head, makeTree, measuringTree, patchOf } from './git';
import type { Tree } from './git';
import { appendLedger, record } from './ledger';
import { interleave, noiseOf, pool } from './measure';
import type { Measurer } from './measure';
import { builderPrompt, criticPrompt, readProposals, readVerdict, reviewerPrompt } from './prompts';
import { EXPERIMENT_ORDER, LOOP_ROLES } from './types';
import type { ExperimentKind, ExperimentRecord, LoopBudget, Measure, Proposal, Verdict } from './types';

export interface Deps {
  readonly repo: string;
  readonly agents: Agents;
  readonly measurer: Measurer;
  /** installs what a fresh worktree needs to run; nothing for a stand-in */
  readonly prepare: (tree: string) => Promise<void>;
  /** typecheck and the prompt budget, run in a tree: the reasons it fails, none when it passes */
  readonly checks: (tree: string) => Promise<readonly string[]>;
  /** the judge against the owner's own scores, for the rubric in use */
  readonly taste: (rubric: string) => Promise<TasteAgreement | null>;
  /** distinctive runs of words from every pool's prompts, the sealed ones included: the runner may read them, no agent may */
  readonly phrases: () => Promise<readonly string[]>;
  /** writes the critic's briefing (tune-set material only) into a folder and names the files */
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
  const alive: { path: string; branch?: string; keepBranch: boolean }[] = [];
  const records: ExperimentRecord[] = [];
  const share = allowances(options.budget);
  let stoppedBecause = 'finished';

  const tree = async (folder: string, make: () => Promise<Tree>, keepBranch = false): Promise<Tree> => {
    const made = await make();
    alive.push({ path: made.path, branch: made.branch, keepBranch });
    await deps.prepare(made.path);
    return made;
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
    const baseRef = options.base ?? (await currentBranch(repo));
    const baseCommit = await head(repo, baseRef);
    log(`run ${stamp}: base ${baseRef} at ${baseCommit.slice(0, 8)}, budget $${options.budget.usd.toFixed(2)}, ${options.budget.experiments} experiments, ${options.budget.minutes} minutes`);

    // 0. the baseline is a clean checkout of the base, with the sealed sets brought in: the measurer may read what the builder may not
    const baseline = await tree(
      'baseline',
      () => measuringTree(repo, join(scratch, 'baseline'), baseRef, repo, SEALED_PATHS.filter((path) => path !== 'explore/runs/')),
    );

    // 1. measure the tune set: this is all the critic will ever see of the measurements
    const tuneEstimate = await deps.measurer.estimate(baseline.path, 'tune', options.samples);
    const tuneReservation = meter.reserve('tune baseline', Math.min(share.tuneBaseline, tuneEstimate), tuneEstimate);
    if (typeof tuneReservation === 'string') return finish(`the tune set cannot be measured within the budget: ${tuneReservation}`);
    const tune = await deps.measurer.measure(baseline.path, { pool: 'tune', samples: options.samples, capUsd: tuneReservation.cap, signal: stop.signal, label: 'tune baseline' });
    meter.settle(tuneReservation, typeof tune === 'string' ? null : tune.usd);
    if (typeof tune === 'string') return finish(`could not measure the tune set: ${tune}`);

    // the judge must have been checked against the owner before the loop is allowed to steer by it
    const taste = await deps.taste(tune.rubric);
    if (taste === null || taste.n < TASTE_FLOOR.n || taste.agreement < TASTE_FLOOR.agreement || taste.kappa < TASTE_FLOOR.kappa) {
      return finish(
        taste === null
          ? 'the judge has not been checked against the owner for this rubric: score twenty answers on the taste page first'
          : `the judge agrees with the owner too little to steer by (${Math.round(taste.agreement * 100)}% on ${taste.n}, kappa ${taste.kappa.toFixed(2)}; the floor is ${Math.round(TASTE_FLOOR.agreement * 100)}% and ${TASTE_FLOOR.kappa})`,
      );
    }

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
      const branch = `loop/${proposal.id}`;
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
      let built: Tree | null = null;
      try {
        // BUILD, and BUILD AGAIN when the guard refuses the diff
        for (let attempt = 1; attempt <= options.attempts; attempt++) {
          const folder = join(scratch, `${proposal.id}-b${attempt}`);
          const mine = await tree(folder, () => makeTree(repo, folder, attempt === 1 ? branch : `${branch}-b${attempt}`, baseRef, SEALED_PATHS));
          const said = await call('builder', `build ${proposal.id}#${attempt}`, share.builder, builderPrompt(proposal, refused), mine.path);
          if (typeof said === 'string') {
            stopped = said;
            refused = [];
            outcome = 'failed';
            break;
          }
          const changed = await changesIn(mine);
          diff = changed.files;
          const reasons: string[] = [];
          if (said.failed !== null) reasons.push(`the builder failed: ${said.failed}`);
          if (changed.files.length === 0) reasons.push('the builder changed nothing');
          const names = changed.files.map((change) => change.file);
          for (const file of touchesProtected(names)) reasons.push(`it changed a protected path: ${file}`);
          for (const file of outsideKind(proposal.kind, names)) reasons.push(`it changed ${file}, which a ${proposal.kind} experiment does not change`);
          for (const phrase of leaksBattery(changed.addedText, phrases)) reasons.push(`it carries battery text: "${phrase}"`);
          if (reasons.length === 0) {
            const failures = await deps.checks(mine.path);
            for (const failure of failures) reasons.push(`it fails ${failure}`);
          }
          if (reasons.length === 0) {
            await commitAll(mine, `loop ${proposal.id}: ${proposal.title}`);
            built = mine;
            refused = [];
            break;
          }
          refused = reasons;
          history.push(`attempt ${attempt}: ${reasons.join('; ')}`);
          log(`${proposal.id}: attempt ${attempt} refused: ${reasons.join('; ')}`);
          // a refused diff is discarded unmeasured: its worktree and branch go now
          await dropTree(repo, mine, true);
          alive.splice(alive.findIndex((entry) => entry.path === mine.path), 1);
          if (said.failed !== null && said.failed.startsWith('stopped')) break;
        }
        if (built === null) {
          outcome = history.length > 0 && refused.length > 0 ? 'refused' : 'failed';
          return { record: finalise(), stop: stopped };
        }

        // RE-MEASURE: baseline and candidate on the held-out set, interleaved
        const folder = join(scratch, `${proposal.id}-measure`);
        const measured = await tree(folder, () => measuringTree(repo, folder, built!.branch, repo, SEALED_PATHS.filter((path) => path !== 'explore/runs/')));
        const estimate = await deps.measurer.estimate(measured.path, 'heldout', options.samples);
        const runs = interleave(options.rounds);
        if (estimate * runs.length > share.measure + 1e-9 && estimate * runs.length > meter.remaining) {
          // measuring cheaper than the bar would be measuring worse; the experiment is not run instead
          refused = [];
          stopped = `an honest measurement of ${proposal.id} needs about $${(estimate * runs.length).toFixed(2)} and $${meter.remaining.toFixed(2)} is left`;
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
          const got = await deps.measurer.measure(arm === 'baseline' ? baseline.path : measured.path, { pool: 'heldout', samples: options.samples, capUsd: reservation.cap, signal: stop.signal, label: `${proposal.id} ${arm} ${index + 1}` });
          meter.settle(reservation, typeof got === 'string' ? null : got.usd);
          if (typeof got === 'string') {
            log(`${proposal.id}: ${got}`);
            stopped = got;
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
        if (typeof pooledBefore === 'string' || typeof pooledAfter === 'string') {
          outcome = 'failed';
          log(`${proposal.id}: ${typeof pooledBefore === 'string' ? pooledBefore : String(pooledAfter)}`);
          return { record: finalise(), stop: null };
        }
        before = pooledBefore;
        after = pooledAfter;

        // DECIDE, then hold the gain to the noise the baseline itself showed
        decision = decide(proposal, before, after);
        const noise = noiseOf(arms.baseline);
        if (decision.keep && noise >= KEEP_RULE.gain) {
          decision = { keep: false, reasons: [...decision.reasons, `the baseline moved by ${noise.toFixed(2)} between its own rounds, as much as the gain asked for: the result cannot be told from chance`] };
        } else if (decision.keep) {
          decision = { keep: true, reasons: [...decision.reasons, `the baseline's own rounds differed by ${noise.toFixed(2)}`] };
        }
        if (!decision.keep) {
          outcome = 'discarded';
          return { record: finalise(), stop: null };
        }

        // REVIEW: a cold reader looks for the test being gamed
        const reviewFolder = join(scratch, `${proposal.id}-review`);
        await mkdir(reviewFolder, { recursive: true });
        await writeFile(join(reviewFolder, 'diff.patch'), await patchOf(built));
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
        return { record: finalise(), stop: null };
      } finally {
        for (const entry of [...alive]) {
          if (entry.path === baseline.path) continue;
          const keep = entry.keepBranch || (outcome === 'awaiting-steward' && entry.branch === built?.branch);
          await dropTree(repo, entry, !keep);
          alive.splice(alive.indexOf(entry), 1);
        }
      }

      function finalise(): ExperimentRecord {
        const result: ExperimentRecord = {
          id: proposal.id,
          started,
          proposal,
          branch: built?.branch ?? branch,
          diff,
          refused: history,
          before,
          after,
          decision,
          verdicts,
          taste,
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
    for (const entry of [...alive]) await dropTree(repo, entry, !entry.keepBranch && !records.some((entry2) => entry2.outcome === 'awaiting-steward' && entry2.branch === entry.branch));
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
