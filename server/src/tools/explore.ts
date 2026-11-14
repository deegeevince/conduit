// Runs the evaluation battery through a brain and writes a run to disk. Not part of the server.
//
//   pnpm explore                          every prompt and every scripted conversation, 3 samples each
//   pnpm explore --dry-run                only print the plan: calls, estimated dollars
//   pnpm explore --only id,id             just these prompts or cases
//   pnpm explore --pool tune|tune-b|heldout   the tune set (explore/battery.json, the default), v2's former held-out set (explore/tune-b.json),
//                                         or the held-out set in BATTERY_SEALED_DIR (outside the repository; refused when that is unset; never printed)
//   pnpm explore --screen 390x844         lay the answers out and picture them for this window (default 1280x720)
//   pnpm explore --replay <run> --looks all --screen 390x844   geometry only, no model, no judge: every logged answer of a run laid out in each look
//   pnpm explore --brain shipped          the configuration the owner runs: whatever .env says, one sample (the battery's own brain is sonnet at effort low)
//   pnpm explore --compare <run> <run>    two runs of the same prompts, paired by prompt: the difference, its standard error, what moved
//   pnpm explore --write-heldout          a cold writer makes thirty fresh prompts into BATTERY_SEALED_DIR/heldout.json; prints counts, never the prompts
//   pnpm explore --battery <file>         any battery file (the vault); its own `pool` field says which set it is
//   pnpm explore --held-out               just the prompts and cases that no worked example mirrors
//   pnpm explore --samples 5              samples per prompt (default 3); each check gets a pass rate
//   pnpm explore --variant column,hero    teach the diagram two ways (PROMPT_VARIANT) on the information prompts
//   pnpm explore --no-cases               single-turn prompts only
//   pnpm explore --no-judge               skip the model that looks at the final still
//   pnpm explore --judge-model sonnet     the judge's model (default sonnet); --judge-effort low|medium|high (default medium)
//   pnpm explore --judge-frames 3         show the judge the final still and two earlier ones (default 1: the final still)
//   pnpm explore --brain replay           through the replay brain (no model, no judge, no cases): to work on the review page
//   pnpm explore --no-baseline            skip the plain-English comparison
//   pnpm explore --model haiku            the claude-cli model for this run (default: CLAUDE_MODEL)
//   pnpm explore --timeout 120            seconds a turn may take before it is recorded as a timeout (default 180)
//   pnpm explore --max-usd 5 --yes        a run projected over --max-usd (default 5) refuses to start without --yes
//   pnpm explore --web http://127.0.0.1:4661   use this running web dev server for the judge's pictures (default: start one)
//
// For each prompt, variant and sample: a TurnRequest over an empty stage is handed to the brain exactly as the
// conductor would (LineNormalizer, TurnScore), with a fresh conversation. Every line is recorded with the
// millisecond it was complete. The final still of the answer (made by the painter's own engine in a headless Chrome:
// explore-browser.ts) goes with the prompt to a judge (explore-judge.ts). Scripted conversations (explore-case.ts)
// are played turn by turn on one brain session with the stage, memory and picture carried between turns.
//
// Writes explore/runs/<run>/index.json (an ExploreRun) and one <prompt>_<variant>_s<n>.json per prompt answer
// (an ExploreResult) or <case>_<variant>_s<n>.json per conversation (an ExploreCaseResult). Prompts run one at a time
// (timings are the measurement); judges run beside the next prompt. Ctrl-C stops after the current unit; a second
// abandons it too.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  EMPTY_STAGE,
  LANGUAGE,
  LEAD_WINDOW,
  CHANGE_FLOOR,
  LOOK_IDS,
  REFERENCE_SCREEN,
  EXPLORE_VARIANTS,
  TurnScore,
  barRows,
  buildSystemPrompt,
  contentOf,
  fixKeeps,
  pairedDifference,
  parseLine,
  passRates,
  summaryOf,
  unfiled,
  verdictsOf,
} from '@conduit/language';
import type {
  TurnInput,
  ExploreBaseline,
  ExploreBattery,
  ExploreCase,
  ExploreCaseResult,
  ExploreIndexEntry,
  ExplorePool,
  ExploreSummary,
  Measure,
  ExplorePrompt,
  ExploreResult,
  ExploreRun,
  ExploreVariant,
  ExploreVerdict,
  Line,
  LookId,
  ScreenFacts,
  Services,
  StageBase,
} from '@conduit/language';
import type { Brain } from '../domain/brain';
import { createBrains } from '../brains/registry';
import { runClaude } from '../brains/claude-cli/process';
import { failureOf, parseStreamLine, textDeltaOf } from '../brains/claude-cli/stream-json';
import { RelayHub } from '../brains/relay/relay-hub';
import { loadEnv, processEnvironment } from '../env';
import type { Env } from '../env';
import { createLogger } from '../log';
import { openEyes, repoRoot } from './explore-browser';
import type { Eyes } from './explore-browser';
import { PHONE_SCREEN, playCase } from './explore-case';
import { HELDOUT_COUNTS, promptsOf, writeHeldout } from './explore-heldout';
import { answersOf, replayRun, writeReplay } from './explore-replay';
import { callsOf, perCallFor, projectUsd } from './explore-cost';
import type { Plan } from './explore-cost';
import type { JudgeSettings } from './explore-judge';
import { EMPTY, STRIP, compareStills, slots, techniquesFor } from './explore-rig';
import { inspect } from './explore-inspect';
import { rubricOf } from './explore-judge';
import { createLibrary } from '../library/registry';
import type { Rig, Running } from './explore-rig';
import { playTurn, unreadable } from './explore-turn';

interface Options {
  readonly only: readonly string[] | null;
  readonly heldOut: boolean;
  /** which set to play: `tune` (explore/battery.json) or `heldout` (explore/sealed/heldout.json) */
  readonly pool: ExplorePool | null;
  /** v2.1. The window answers are laid out and pictured for */
  readonly screen: { readonly width: number; readonly height: number };
  /** v2.1. A replay pass over a logged run (no model): the run's name or folder */
  readonly replay: string | null;
  /** v2.1. The looks a replay pass lays the answers out in: every one, or these */
  readonly looks: readonly LookId[] | 'chosen';
  /** v2.1. `battery`: sonnet at effort low, comparable with v2. `shipped`: the owner's `.env` as it stands */
  readonly configuration: 'battery' | 'shipped';
  readonly compare: readonly [string, string] | null;
  readonly writeHeldout: boolean;
  /** v2.1. Works the scripted explorable (language/demos/explorable.series) through the painter: a slider, a toggle and a pick must each register */
  readonly selfCheck: boolean;
  /** a battery file instead (the vault, a loop candidate's set) */
  readonly batteryFile: string | null;
  readonly brain: string | null;
  readonly model: string | null;
  readonly baseline: boolean;
  readonly timeoutMs: number;
  readonly samples: number;
  readonly variants: readonly ExploreVariant[];
  readonly cases: boolean;
  readonly judge: boolean;
  readonly judgeModel: string;
  /** look and fix: the brain is shown its draft and fixes it (on by default with the claude-cli brain) */
  readonly review: boolean;
  readonly judgeEffort: 'low' | 'medium' | 'high';
  readonly judgeFrames: number;
  readonly dryRun: boolean;
  readonly maxUsd: number;
  readonly yes: boolean;
  readonly web: string | null;
}

const BASELINE_SYSTEM = 'Answer in plain English. Be concise and complete.';
const DEFAULT_TIMEOUT_S = 180;
// The web dev server the battery starts for its pictures. `EXPLORE_WEB_PORT` moves it, so two runs (a baseline and a candidate
// of the improvement loop, say) can be up at once; the v2 round keeps everything it starts between 4600 and 4699.
const WEB_PORT = Number(processEnvironment()['EXPLORE_WEB_PORT'] ?? '4661');

/** The window facts the brain is told for a window of this size: the reference screen and the phone are as the app reports them. */
function screenFactsOf(width: number, height: number): ScreenFacts {
  if (width === REFERENCE_SCREEN.width && height === REFERENCE_SCREEN.height) return REFERENCE_SCREEN;
  if (width === PHONE_SCREEN.width && height === PHONE_SCREEN.height) return PHONE_SCREEN;
  return width >= height ? { ...REFERENCE_SCREEN, width, height } : { ...PHONE_SCREEN, width, height };
}

function usageError(message: string): never {
  process.stderr.write(`explore: ${message}\n`);
  process.exit(2);
}

function parseArguments(argv: readonly string[]): Options {
  let only: string[] | null = null;
  let heldOut = false;
  let pool: ExplorePool | null = null;
  let screen = { width: REFERENCE_SCREEN.width, height: REFERENCE_SCREEN.height };
  let replay: string | null = null;
  let looks: readonly LookId[] | 'chosen' = 'chosen';
  let configuration: 'battery' | 'shipped' = 'battery';
  let compare: readonly [string, string] | null = null;
  let writeHeldout = false;
  let selfCheck = false;
  let samplesGiven = false;
  let batteryFile: string | null = null;
  let brain: string | null = null;
  let model: string | null = null;
  let baseline = true;
  let timeoutS = DEFAULT_TIMEOUT_S;
  let samples = 3;
  let variants: ExploreVariant[] | null = null;
  let cases = true;
  let judgeOn = true;
  let reviewOn = true;
  let judgeModel = 'sonnet';
  let judgeEffort: 'low' | 'medium' | 'high' = 'medium';
  let judgeFrames = 1;
  let dryRun = false;
  let maxUsd = 5;
  let yes = false;
  let web: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => argv[++i] ?? usageError(`${String(flag)} needs a value`);
    if (flag === '--only') only = value().split(',').map((id) => id.trim()).filter((id) => id !== '');
    else if (flag === '--held-out') heldOut = true;
    else if (flag === '--pool') {
      const name = value();
      if (name !== 'tune' && name !== 'tune-b' && name !== 'heldout') usageError('--pool must be tune, tune-b or heldout (the vault is played with --battery <file>)');
      pool = name;
    } else if (flag === '--battery') batteryFile = value();
    else if (flag === '--screen') {
      const found = /^(\d{3,4})x(\d{3,4})$/.exec(value());
      if (found === null) usageError('--screen must be like 1280x720 or 390x844');
      screen = { width: Number(found[1]), height: Number(found[2]) };
    } else if (flag === '--replay') replay = value();
    else if (flag === '--looks') {
      const named = value();
      if (named === 'all') looks = LOOK_IDS;
      else if (named === 'chosen') looks = 'chosen';
      else {
        looks = named.split(',').map((name) => LOOK_IDS.find((id) => id === name.trim()) ?? usageError(`unknown look "${name}" (known: ${LOOK_IDS.join(', ')})`));
      }
    } else if (flag === '--compare') compare = [value(), value()];
    else if (flag === '--write-heldout') writeHeldout = true;
    else if (flag === '--self-check') selfCheck = true;
    else if (flag === '--brain') {
      const named = value();
      if (named === 'shipped') configuration = 'shipped';
      else brain = named;
    }
    else if (flag === '--model') model = value();
    else if (flag === '--no-baseline') baseline = false;
    else if (flag === '--timeout') timeoutS = Number(value());
    else if (flag === '--samples') {
      samples = Number(value());
      samplesGiven = true;
    }
    else if (flag === '--variant' || flag === '--variants') {
      variants = value().split(',').map((name) => {
        const found = EXPLORE_VARIANTS.find((item) => item === name.trim());
        return found ?? usageError(`unknown variant "${name}" (known: ${EXPLORE_VARIANTS.join(', ')})`);
      });
    } else if (flag === '--no-cases') cases = false;
    else if (flag === '--no-judge') judgeOn = false;
    else if (flag === '--no-review') reviewOn = false;
    else if (flag === '--judge-model') judgeModel = value();
    else if (flag === '--judge-effort') {
      const effort = value();
      if (effort !== 'low' && effort !== 'medium' && effort !== 'high') usageError('--judge-effort must be low, medium or high');
      judgeEffort = effort;
    } else if (flag === '--judge-frames') judgeFrames = Number(value());
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--max-usd') maxUsd = Number(value());
    else if (flag === '--yes') yes = true;
    else if (flag === '--web') web = value();
    else usageError(`unknown argument "${String(flag)}"`);
  }
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) usageError('--timeout must be a positive number of seconds');
  if (!Number.isInteger(samples) || samples < 1 || samples > 20) usageError('--samples must be a whole number from 1 to 20');
  if (!Number.isInteger(judgeFrames) || judgeFrames < 1 || judgeFrames > 5) usageError('--judge-frames must be a whole number from 1 to 5');
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) usageError('--max-usd must be a positive number');
  if (pool !== null && batteryFile !== null) usageError('--pool and --battery name the same thing twice');
  // The configuration the owner runs is looked at once, unless asked for more: it costs what the owner's own model costs.
  if (configuration === 'shipped' && !samplesGiven) samples = 1;
  return { screen, replay, looks, configuration, compare, writeHeldout, selfCheck, only, heldOut, pool, batteryFile, brain, model, baseline, timeoutMs: timeoutS * 1000, samples, variants: variants ?? ['column'], cases, judge: judgeOn, review: reviewOn, judgeModel, judgeEffort, judgeFrames, dryRun, maxUsd, yes, web };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** The same question put to a plain model: what the answer would have been, and what it would have cost. */
async function askBaseline(prompt: string, bin: string, model: string, effort: 'low' | 'medium' | 'high', signal: AbortSignal): Promise<ExploreBaseline | null> {
  const started = performance.now();
  let text = '';
  let firstTextMs: number | null = null;
  let result: Record<string, unknown> | null = null;
  let failure: string | null = null;
  for await (const raw of runClaude({ bin, model, effort, systemPrompt: BASELINE_SYSTEM, userMessage: prompt }, signal)) {
    const event = parseStreamLine(raw);
    if (event === null) continue;
    const delta = textDeltaOf(event);
    if (delta !== null) {
      text += delta;
      firstTextMs ??= Math.round(performance.now() - started);
    }
    if (event.type === 'result') {
      failure = failureOf(event);
      result = event as unknown as Record<string, unknown>;
    }
  }
  if (signal.aborted) return null;
  if (failure !== null) throw new Error(failure);
  const totalMs = Math.round(performance.now() - started);
  if (text === '' && typeof result?.result === 'string') text = result.result;
  const used = (result?.usage ?? {}) as Record<string, unknown>;
  const details = used['output_tokens_details'];
  const thinking = typeof details === 'object' && details !== null ? asNumber((details as Record<string, unknown>)['thinking_tokens']) : null;
  return {
    text: text.trim(),
    words: wordCount(text),
    totalMs,
    firstTextMs,
    usage: {
      outputTokens: asNumber(used['output_tokens']),
      thinkingTokens: thinking,
      cacheReadTokens: asNumber(used['cache_read_input_tokens']),
      cacheWriteTokens: asNumber(used['cache_creation_input_tokens']),
      inputTokens: asNumber(used['input_tokens']),
      costUsd: asNumber(result?.total_cost_usd),
    },
  };
}

type Unit =
  | { readonly kind: 'prompt'; readonly prompt: ExplorePrompt; readonly variant: ExploreVariant; readonly sample: number }
  | { readonly kind: 'case'; readonly case: ExploreCase; readonly variant: ExploreVariant; readonly sample: number };

const stemOf = (unit: Unit): string => `${unit.kind === 'prompt' ? unit.prompt.id : unit.case.id}_${unit.variant}_s${unit.sample}`;

function unitsOf(battery: ExploreBattery, options: Options): Unit[] {
  const wanted = (id: string, heldOut: boolean | undefined): boolean => (options.only === null || options.only.includes(id)) && (!options.heldOut || heldOut === true);
  const units: Unit[] = [];
  for (const prompt of battery.prompts) {
    if (!wanted(prompt.id, prompt.heldOut)) continue;
    // Variants differ in how a diagram is taught: only the information prompts run under more than one.
    const variants = prompt.information === true ? options.variants : options.variants.slice(0, 1);
    for (let sample = 1; sample <= options.samples; sample += 1) for (const variant of variants) units.push({ kind: 'prompt', prompt, variant, sample });
  }
  if (options.cases) {
    for (const scripted of battery.cases ?? []) {
      if (!wanted(scripted.id, scripted.heldOut)) continue;
      for (let sample = 1; sample <= options.samples; sample += 1) units.push({ kind: 'case', case: scripted, variant: options.variants[0] ?? 'column', sample });
    }
  }
  return units;
}

function planOf(units: readonly Unit[], battery: ExploreBattery, options: Options, judging: boolean, baselines: boolean): Plan {
  let firstTurns = 0;
  let laterTurns = 0;
  let judgeCalls = 0;
  const baselined = new Set<string>();
  for (const unit of units) {
    if (unit.kind === 'prompt') {
      firstTurns += 1;
      if (judging) judgeCalls += 1;
      if (baselines && unit.prompt.baseline) baselined.add(unit.prompt.id);
    } else {
      firstTurns += 1;
      laterTurns += unit.case.turns.length - 1;
      if (judging && unit.case.judged !== false) judgeCalls += unit.case.turns.filter((turn, at) => !(turn.do === 'prompt' && turn.interruptAfterMs !== undefined && at < unit.case.turns.length - 1)).length;
    }
  }
  void battery;
  return { firstTurns, laterTurns, judgeCalls, extraImages: judgeCalls * (options.judgeFrames - 1), baselines: baselined.size };
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `$${value.toFixed(4)}`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const secondsText = (ms: number | null): string => (ms === null ? '-' : (ms / 1000).toFixed(1));

function stamp(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function tabulate(header: readonly string[], rows: readonly (readonly string[])[], numeric: ReadonlySet<number>): string {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)));
  const format = (row: readonly string[]): string => row.map((cell, column) => pad(cell, widths[column] ?? 0, numeric.has(column))).join('  ').trimEnd();
  return [format(header), format(widths.map((width) => '-'.repeat(width))), ...rows.map(format)].join('\n');
}

interface Recorded {
  readonly unit: Unit;
  readonly stem: string;
  readonly results: readonly ExploreResult[];
  readonly verdicts: readonly ExploreVerdict[];
}

function summary(recorded: readonly Recorded[], planned: number): string {
  const groups = new Map<string, Recorded[]>();
  for (const item of recorded) {
    const id = item.unit.kind === 'prompt' ? item.unit.prompt.id : item.unit.case.id;
    const key = `${id}\u0000${item.unit.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const rows: string[][] = [];
  for (const [key, items] of groups) {
    const [id = '', variant = ''] = key.split('\u0000');
    const answers = items.flatMap((item) => item.results);
    const first = items.flatMap((item) => (item.unit.kind === 'case' ? item.results.slice(0, 1) : item.results));
    const verdictSets = items.map((item) => item.verdicts);
    const rates = passRates(verdictSets);
    const passed = rates.reduce((sum, rate) => sum + rate.passed, 0);
    const of = rates.reduce((sum, rate) => sum + rate.of, 0);
    const coherence = mean(answers.flatMap((r) => (r.judge != null && r.judge.failure === null ? [r.judge.coherence] : [])));
    rows.push([
      id + (items[0]?.unit.kind === 'case' ? ' (case)' : ''),
      variant,
      String(items.length),
      items.every((item) => item.results.every((r) => r.end === 'done' || r.turn?.interruptedAtMs != null)) ? 'done' : 'NOT DONE',
      secondsText(median(first.flatMap((r) => (r.firstVisibleMs === null ? [] : [r.firstVisibleMs])))),
      secondsText(median(first.flatMap((r) => (r.firstTextMs == null ? [] : [r.firstTextMs])))),
      secondsText(median(first.map((r) => r.totalMs))),
      secondsText(median(first.flatMap((r) => (r.viewerWaitMs == null ? [] : [r.viewerWaitMs])))),
      String(Math.round(median(first.flatMap((r) => (r.usage?.outputTokens == null ? [] : [r.usage.outputTokens]))) ?? 0)),
      money(mean(items.map((item) => item.results.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0)))),
      of === 0 ? '-' : `${passed}/${of}`,
      coherence === null ? '-' : coherence.toFixed(1),
    ]);
  }
  const header = ['prompt', 'variant', 'n', 'end', 'vis s', '1st word s', 'last word s', 'viewer s', 'out tok', '$ per sample', 'checks', 'judge'];
  const numeric = new Set([2, 4, 5, 6, 7, 8, 9, 10, 11]);

  // Pass rate per check over everything, worst first.
  const everything = passRates(recorded.map((item) => item.verdicts));
  const weak = everything.filter((rate) => rate.passed < rate.of).sort((a, b) => a.passed / a.of - b.passed / b.of);
  const rateLines = weak.map((rate) => `  ${pad(`${rate.passed}/${rate.of}`, 7)} ${rate.label}`);

  // Like for like: only the prompts that have a baseline, with the mean over their samples.
  const compared = [...groups.values()]
    .filter((items) => items[0]?.unit.kind === 'prompt' && items.some((item) => item.results.some((r) => r.baseline !== null)))
    .map((items) => {
      const answers = items.flatMap((item) => item.results);
      const base = answers.find((r) => r.baseline !== null)?.baseline ?? null;
      return {
        tokens: mean(answers.flatMap((r) => (r.usage?.outputTokens == null ? [] : [r.usage.outputTokens]))),
        cost: mean(answers.flatMap((r) => (r.usage?.costUsd == null ? [] : [r.usage.costUsd]))),
        wait: mean(answers.flatMap((r) => (r.viewerWaitMs == null ? [] : [r.viewerWaitMs]))),
        baseTokens: base?.usage.outputTokens ?? null,
        baseCost: base?.usage.costUsd ?? null,
        baseMs: base?.totalMs ?? null,
      };
    })
    .filter((row) => row.baseTokens !== null && row.tokens !== null);
  const sum = (pick: (row: (typeof compared)[number]) => number | null): number => compared.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const like =
    compared.length === 0
      ? ''
      : `\nlike for like, ${compared.length} prompts with a plain baseline (mean of their samples): output tokens ${Math.round(sum((r) => r.tokens))} against ${sum((r) => r.baseTokens)}, ` +
        `cost ${money(sum((r) => r.cost))} against ${money(sum((r) => r.baseCost))}, viewer's wait ${(sum((r) => r.wait) / 1000).toFixed(0)} s against ${(sum((r) => r.baseMs) / 1000).toFixed(0)} s generation`;

  const total = recorded.reduce((sumUsd, item) => sumUsd + item.results.reduce((s, r) => s + (r.usage?.costUsd ?? 0) + (r.judge?.costUsd ?? 0), 0), 0);
  return [
    tabulate(header, rows, numeric),
    '',
    rateLines.length === 0 ? 'every check passed in every sample' : `checks that did not pass every time (passed/ran):\n${rateLines.join('\n')}`,
    like,
    `\n${recorded.length} of ${planned} units ran; brain and judge cost ${money(total)}`,
  ].join('\n');
}

/**
 * `--self-check`: the scripted explorable of the language's demos, worked through the painter the way the battery works every answer. A slider, a
 * toggle and a pick must each change the picture beyond their own redraw and each send its event. No model is called.
 */
async function selfCheckMain(options: Options): Promise<void> {
  const text = await readFile(join(repoRoot(), 'language', 'demos', 'explorable.series'), 'utf8');
  const lines: { seq: number; line: Line }[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const parsed = parseLine(raw);
    if (parsed.kind === 'line') lines.push({ seq: lines.length + 1, line: parsed.line });
  }
  const eyes: Eyes = await openEyes({ web: options.web, port: WEB_PORT, repo: repoRoot() }).catch((error: unknown) => usageError(`no browser: ${error instanceof Error ? error.message : String(error)}`));
  try {
    const window = { width: options.screen.width, height: options.screen.height, dpr: 1 };
    const driven = await eyes.drive({ turn: 'self-check', base: EMPTY_STAGE, lines, viewport: window, side: 512 });
    const rows = driven.controls.map((control) => [control.kind, control.id, control.bound ? 'bound' : 'not bound', control.reported ? 'event heard' : 'NO EVENT', control.changed === null ? '-' : `${(control.changed * 100).toFixed(2)}%`, control.ownChanged === null ? '-' : `${(control.ownChanged * 100).toFixed(2)}%`]);
    process.stdout.write(`${lines.length} lines of language/demos/explorable.series, worked at ${window.width}x${window.height}\n${tabulate(['control', 'id', 'bound', 'event', 'picture changed (beyond controls)', 'on the controls themselves'], rows, new Set([4, 5]))}\n`);
    const bad = driven.controls.filter((control) => control.kind !== 'button' && (!control.reported || control.changed === null || control.changed <= CHANGE_FLOOR));
    for (const control of bad) process.stdout.write(`FAILED: ${control.kind} ${control.id}\n`);
    process.exitCode = bad.length === 0 ? 0 : 1;
  } finally {
    await eyes.close().catch(() => undefined);
  }
}

/** `--replay`: every answer of a logged run laid out again, in the looks and windows asked for, and counted. No brain, no judge, no model. */
async function replayMain(options: Options, exploreDir: string): Promise<void> {
  const dir = runFolder(exploreDir, options.replay ?? '');
  if (!existsSync(join(dir, 'index.json'))) usageError(`no run at ${dir}`);
  const screens = [options.screen];
  const eyes: Eyes = await openEyes({ web: options.web, port: WEB_PORT, repo: repoRoot() }).catch((error: unknown) => usageError(`no browser: ${error instanceof Error ? error.message : String(error)}`));
  try {
    const count = (await answersOf(dir, options.only)).length;
    process.stdout.write(`replay of ${dir}: ${count} answers, ${options.looks === 'chosen' ? 'the look each chose' : `${options.looks.length} looks`}, at ${screens.map((screen) => `${screen.width}x${screen.height}`).join(', ')}; no model is called\n`);
    const report = await replayRun(eyes, { dir, looks: options.looks, screens, only: options.only }, (line) => process.stdout.write(`${line}\n`));
    const table = await writeReplay(dir, report, screens.map((screen) => `${screen.width}x${screen.height}`));
    process.stdout.write(`\n${table}\n`);
    for (const failure of report.failed.slice(0, 8)) process.stdout.write(`could not lay out ${failure.answer}: ${failure.why}\n`);
    const first = report.colliding.filter((entry) => entry.look === (options.looks === 'chosen' ? 'chosen' : (options.looks[0] ?? 'chosen')));
    const names = [...new Set(first.map((entry) => entry.answer))];
    process.stdout.write(`\n${names.length} answers collide in ${options.looks === 'chosen' ? 'their own look' : (options.looks[0] ?? '')}: ${names.slice(0, 24).join(', ')}${names.length > 24 ? ', ...' : ''}\nwritten to ${dir}\n`);
  } finally {
    await eyes.close().catch(() => undefined);
  }
}

/** The rows of the bar this run could fill, with n and standard error; a row is met only when its mean less one error clears it. */
function barTable(scored: ExploreSummary): string {
  const rows = barRows(scored).map((row) => [String(row.row), row.what, row.value === null ? '-' : Number.isInteger(row.value) ? String(row.value) : row.value.toFixed(2), row.se === null ? '' : `±${row.se.toFixed(2)}`, String(row.n), row.bar, row.met === null ? 'not measured' : row.met ? 'met' : 'NOT MET']);
  return `the bar, as this run measured it (${scored.configuration ?? 'battery'}, ${scored.screen ?? '1280x720'}, pool ${scored.pool}; met = mean less one standard error clears it):\n${tabulate(['row', 'what', 'value', 'se', 'n', 'bar', ''], rows, new Set([0, 2, 3, 4]))}`;
}

function familyTable(scored: ExploreSummary): string {
  const pct = (m: Measure): string => (m.value === null ? '-' : `${Math.round(m.value * 100)}%${m.se === null ? '' : `±${Math.round(m.se * 100)}`}`);
  const num = (m: Measure): string => (m.value === null ? '-' : `${m.value.toFixed(2)}${m.se === null ? '' : `±${m.se.toFixed(2)}`}`);
  const rows = Object.values(scored.families).map((line) => line.bar).map((f) => [f.family, String(f.answers), num(f.coherence), pct(f.coherenceFour), pct(f.textReadable), pct(f.labelsRight), pct(f.drawingCorrect), pct(f.structureNamed), num(f.chartQuality), pct(f.responds), `${f.overlaps}/${f.throughNodes}/${f.crossed}`]);
  return `families (pool ${scored.pool}, judge rubric ${scored.rubric === '' ? 'none' : scored.rubric}):\n${tabulate(['family', 'n', 'coher.', '>=4', 'text ok', 'labels', 'correct', 'named', 'chart q', 'responds', 'overlap/thru/cross'], rows, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))}`;
}

/** A run's folder, given as its name or as a path. */
function runFolder(exploreDir: string, name: string): string {
  return /[\\/]/.test(name) ? resolve(name) : join(exploreDir, 'runs', name);
}

async function readSummary(dir: string): Promise<ExploreSummary> {
  return JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as ExploreSummary;
}

/** Two runs of the same prompts, paired by prompt (P1-11): the difference in coherence with its own standard error, by family, and what moved most. */
async function compareRuns(exploreDir: string, a: string, b: string): Promise<void> {
  const [was, is] = await Promise.all([readSummary(runFolder(exploreDir, a)), readSummary(runFolder(exploreDir, b))]);
  const note = was.rubric === is.rubric ? '' : `\nWARNING: the judge's rubric differs (${was.rubric || 'none'} against ${is.rubric || 'none'}): the scores are not comparable`;
  const rows: string[][] = [];
  for (const family of [null, ...new Set([...was.prompts, ...is.prompts].map((prompt) => prompt.family))]) {
    const found = pairedDifference(was, is, family);
    if (found.n === 0) continue;
    const clears = found.mean !== null && found.se !== null && Math.abs(found.mean) > found.se;
    rows.push([family ?? 'all', String(found.n), found.mean === null ? '-' : found.mean.toFixed(2), found.se === null ? '-' : found.se.toFixed(2), clears ? 'clears its error' : 'inside its error', found.moved.slice(0, 3).map((entry) => `${entry.id} ${entry.difference > 0 ? '+' : ''}${entry.difference.toFixed(1)}`).join(', ')]);
  }
  process.stdout.write(`${tabulate(['family', 'prompts', 'mean diff', 'se', 'reading', 'moved most'], rows, new Set([1, 2, 3]))}${note}\n`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const source: Record<string, string | undefined> = { ...processEnvironment() };
  if (options.compare !== null) {
    await compareRuns(loadEnv({ ...source, NODE_ENV: undefined, BRAIN: 'replay' }).exploreDir, options.compare[0], options.compare[1]);
    return;
  }
  source.NODE_ENV = undefined;
  // The battery's own brain is sonnet at effort low, so a run compares with v2's; the shipped configuration is the owner's `.env` as it stands.
  if (options.configuration === 'battery' && options.brain === null) {
    if (options.model === null) source.CLAUDE_MODEL = 'sonnet';
    source.BRAIN_EFFORT = 'low';
  }
  source.BRAIN = options.replay !== null ? 'replay' : (options.brain ?? (options.model !== null ? 'claude-cli' : source.BRAIN) ?? 'claude-cli');
  if (source.BRAIN === 'relay') usageError('the relay brain needs a person on the other end; use --brain replay or --brain claude-cli');
  if (source.BRAIN === 'replay') source.REPLAY_SCRIPT = undefined;
  if (options.model !== null) source.CLAUDE_MODEL = options.model;
  const env: Env = loadEnv(source);
  const replaying = env.brain.kind === 'replay';
  const claudeBin = env.brain.kind === 'claude-cli' ? env.brain.bin : (source['CLAUDE_BIN'] ?? 'claude');

  if (options.writeHeldout) {
    if (env.sealedDir === null) usageError('BATTERY_SEALED_DIR is not set: the held-out set lives outside the repository, and there is nowhere to write it');
    const existing = await promptsOf([join(env.exploreDir, 'battery.json'), join(env.exploreDir, 'tune-b.json')]);
    const made = await writeHeldout({ dir: env.sealedDir, bin: claudeBin, model: options.model ?? 'sonnet', effort: 'medium', existing, overwrite: options.yes }, new AbortController().signal);
    const counts = Object.entries(made.counts).map(([family, count]) => `${family} ${count}`).join(', ');
    process.stdout.write(`held-out set written to ${made.path}: ${made.total} prompts (${counts}) in ${made.rounds} round${made.rounds === 1 ? '' : 's'}, ${made.dropped} dropped as repeats. Nothing was printed; planned counts: ${Object.entries(HELDOUT_COUNTS).map(([family, count]) => `${family} ${count}`).join(', ')}\n`);
    return;
  }
  if (options.replay !== null) {
    await replayMain(options, env.exploreDir);
    return;
  }
  if (options.selfCheck) {
    await selfCheckMain(options);
    return;
  }
  if (options.pool === 'heldout' && env.sealedDir === null) usageError('--pool heldout reads only BATTERY_SEALED_DIR, which is not set. The held-out set is not in the repository (make one with --write-heldout)');
  const batteryPath =
    options.batteryFile !== null
      ? resolve(options.batteryFile)
      : options.pool === 'heldout'
        ? join(env.sealedDir ?? '', 'heldout.json')
        : options.pool === 'tune-b'
          ? join(env.exploreDir, 'tune-b.json')
          : join(env.exploreDir, 'battery.json');
  const battery = JSON.parse(await readFile(batteryPath, 'utf8').catch(() => usageError(`no battery at ${options.pool === 'heldout' ? 'BATTERY_SEALED_DIR/heldout.json' : batteryPath}`))) as ExploreBattery;
  const filed = unfiled(battery.prompts);
  if (filed.length > 0) usageError(`${filed.length} prompt${filed.length === 1 ? '' : 's'} of ${options.pool === 'heldout' ? 'the held-out set' : relative(repoRoot(), batteryPath)} name no family (${options.pool === 'heldout' ? 'not listed' : filed.slice(0, 6).join(', ')}): a family is what the prompt says it is, never guessed from \`expects\``);
  const pool: ExplorePool = battery.pool ?? options.pool ?? 'tune';
  const batteryLabel = pool === 'heldout' && options.batteryFile === null ? 'BATTERY_SEALED_DIR/heldout.json' : relative(repoRoot(), batteryPath);
  const known = new Set([...battery.prompts.map((p) => p.id), ...(battery.cases ?? []).map((c) => c.id)]);
  if (options.only !== null) {
    const missing = options.only.filter((id) => !known.has(id));
    if (missing.length > 0) usageError(`no such prompt or case: ${missing.join(', ')}${pool === 'heldout' ? '' : ` (known: ${[...known].join(', ')})`}`);
  }
  // A replay brain plays a fixture whatever it is asked: there is nothing to judge and no conversation to carry.
  const judging = options.judge && !replaying;
  const casesOn = options.cases && !replaying;
  const units = unitsOf(battery, { ...options, cases: casesOn });
  const baselines = options.baseline && env.brain.kind === 'claude-cli';
  const plan = planOf(units, battery, options, judging, baselines);
  const model = env.brain.kind === 'claude-cli' ? env.brain.model : null;

  const runsDir = join(env.exploreDir, 'runs');
  const earlier: ExploreRun[] = [];
  for (const name of await readdir(runsDir).catch(() => [] as string[])) {
    try {
      earlier.push(JSON.parse(await readFile(join(runsDir, name, 'index.json'), 'utf8')) as ExploreRun);
    } catch {
      // not a run
    }
  }
  earlier.sort((a, b) => (a.started < b.started ? 1 : -1));
  const per = perCallFor(model, earlier, judging ? options.judgeModel : null);
  const projected = replaying ? 0 : projectUsd(plan, per);
  process.stdout.write(
    `plan: ${units.length} units (${units.filter((u) => u.kind === 'case').length} conversations), ${callsOf(plan)} model calls ` +
      `(${plan.firstTurns} cold turns, ${plan.laterTurns} warm turns, ${plan.judgeCalls} judge, ${plan.baselines} baseline), ` +
      `estimated ${replaying ? '$0 (replay)' : `$${projected.toFixed(2)}`}${replaying ? '' : ` from ${per.source}`}\n`,
  );
  if (options.dryRun) return;
  if (units.length === 0) usageError('nothing to run');
  if (projected > options.maxUsd && !options.yes) usageError(`projected $${projected.toFixed(2)} is over --max-usd ${options.maxUsd}; narrow it with --only/--held-out/--samples, or pass --yes`);
  if (replaying && casesOn === false && options.cases && (battery.cases?.length ?? 0) > 0) process.stdout.write('  (the replay brain plays fixtures: scripted conversations and the judge are skipped)\n');

  // One brain per prompt variant, made when first needed from an environment that names the variant (`PROMPT_VARIANT`),
  // so whatever way the server reads it, the brain was taught the way the card says.
  const log = createLogger('error');
  const made = new Map<ExploreVariant, { readonly brains: ReturnType<typeof createBrains>; readonly brain: Brain }>();
  const brainFor = (variant: ExploreVariant): Brain => {
    let found = made.get(variant);
    if (found === undefined) {
      const forVariant = loadEnv({ ...source, PROMPT_VARIANT: variant });
      const brains = createBrains({ settings: forVariant.brain, log, relayHub: new RelayHub({ log, now: () => Date.now(), idleTimeoutMs: 1_000 }) });
      found = { brains, brain: brains.configured };
      made.set(variant, found);
    }
    return found.brain;
  };
  const brain = brainFor(options.variants[0] ?? 'column');
  const reviewing = options.review && !replaying && env.review.enabled && brain.review !== undefined;
  const services: Services = { paint: env.images.kind !== 'none', sight: 'snapshot', review: reviewing };

  const started = new Date();
  const baseId = `${stamp(started)}-${brain.id}`;
  let id = baseId;
  for (let n = 2; existsSync(join(runsDir, id)); n += 1) id = `${baseId}-${n}`;
  const dir = join(runsDir, id);
  await mkdir(dir, { recursive: true });

  // The page is always opened: what the painter can do (the brain is taught exactly that), what it measures about every answer,
  // and the pictures all come from it. A run with no page measures nothing worth keeping, so it does not start.
  process.stdout.write('  starting the headless browser ...');
  const eyes: Eyes = await openEyes({ web: options.web, port: WEB_PORT, repo: repoRoot() }).catch((error: unknown) => usageError(`no browser: ${error instanceof Error ? error.message : String(error)}`));
  const window = { width: options.screen.width, height: options.screen.height, dpr: 1 };
  const screenFacts = screenFactsOf(window.width, window.height);
  const judgeSide = Math.max(window.width, window.height);
  const capabilities = await eyes.capabilities(window).catch(() => null);
  if (capabilities === null) {
    await eyes.close().catch(() => undefined);
    usageError('the page did not say what its painter can do');
  }
  process.stdout.write(` ready (structures: ${capabilities.structures.join(',') || 'none'}; charts: ${capabilities.charts.join(',') || 'none'}; controls: ${capabilities.controls.join(',') || 'none'})\n`);
  // Techniques are chosen as the server chooses them: from memory (the seed, the cache, an overlay), never over the network.
  const library = createLibrary(env.library, log, () => Date.now());

  const promptChars = buildSystemPrompt({ capabilities, services }).length;
  process.stdout.write(`run ${id}: ${units.length} units through ${brain.id}${model === null ? '' : ` (${model})`}${judging ? `, judged by ${options.judgeModel}` : ''}, samples ${options.samples}, variants ${options.variants.join(',')}, pool ${pool}\n`);

  const judgeSettings: JudgeSettings | null = judging ? { bin: claudeBin, model: options.judgeModel, effort: options.judgeEffort, timeoutMs: 120_000 } : null;

  const index: { entries: ExploreIndexEntry[] } = { entries: [] };
  const recorded: Recorded[] = [];
  const measured = { first: [] as number[], later: [] as number[], judge: [] as number[], baseline: [] as number[] };
  let current: Running | null = null;
  let stopping = false;
  let firstStop = 0;
  const variantChecked = new Set<ExploreVariant>();
  const baselineCache = new Map<string, ExploreBaseline | null>();

  const writeIndex = async (): Promise<void> => {
    const run: ExploreRun = {
      id,
      started: started.toISOString(),
      brain: brain.id,
      model,
      language: LANGUAGE.version,
      promptChars,
      prompts: index.entries,
      samples: options.samples,
      variants: options.variants,
      judgeModel: judging ? options.judgeModel : null,
      pool,
      battery: batteryLabel,
      rubric: judging ? rubricOf({ model: options.judgeModel, effort: options.judgeEffort }) : null,
      configuration: replaying ? 'replay' : options.configuration,
      effort: env.brain.kind === 'claude-cli' ? env.brain.effort : null,
      screen: `${window.width}x${window.height}`,
      projection: { calls: callsOf(plan), usd: replaying ? null : Number(projected.toFixed(4)) },
      spentUsd: recorded.reduce((sum, item) => sum + item.results.reduce((s, r) => s + (r.usage?.costUsd ?? 0) + (r.judge?.costUsd ?? 0), 0), 0),
      measured: { firstTurnUsd: mean(measured.first), laterTurnUsd: mean(measured.later), judgeUsd: mean(measured.judge), baselineUsd: mean(measured.baseline) },
    };
    await writeFile(join(dir, 'index.json'), `${JSON.stringify(run, null, 2)}\n`);
  };

  process.on('SIGINT', () => {
    // pnpm and tsx each pass the signal on, so one Ctrl-C can arrive more than once within a moment.
    if (!stopping) {
      stopping = true;
      firstStop = Date.now();
      process.stderr.write('\nexplore: stopping after this unit (Ctrl-C again to stop it now)\n');
      return;
    }
    if (Date.now() - firstStop < 1_000) return;
    if (current !== null) {
      current.reason = 'interrupted';
      current.controller.abort();
    }
  });

  const record = async (unit: Unit, results: readonly ExploreResult[], verdicts: readonly ExploreVerdict[], file: unknown, meets: boolean): Promise<void> => {
    const stem = stemOf(unit);
    await writeFile(join(dir, `${stem}.json`), `${JSON.stringify(file, null, 2)}\n`);
    recorded.push({ unit, stem, results, verdicts });
    const spent = results.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0) + (r.judge?.costUsd ?? 0), 0);
    const target = unit.kind === 'prompt' ? unit.prompt : unit.case;
    index.entries.push({
      id: stem,
      useCase: target.useCase,
      end: results.find((r) => r.end !== 'done' && r.turn?.interruptedAtMs == null)?.end ?? 'done',
      meetsExpectation: meets,
      promptId: target.id,
      kind: unit.kind,
      variant: unit.variant,
      sample: unit.sample,
      heldOut: target.heldOut === true,
      failed: verdicts.filter((v) => !v.ok).map((v) => v.label),
      checked: verdicts.map((v) => v.label),
      costUsd: spent,
    });
    for (const r of results) if (r.judge?.costUsd != null) measured.judge.push(r.judge.costUsd);
    await writeIndex();
  };

  const pending = new Set<Promise<void>>();
  const later = (work: Promise<void>): void => {
    const tracked = work.finally(() => pending.delete(tracked));
    pending.add(tracked);
  };

  try {
    for (const unit of units) {
      if (stopping) break;
      current = { controller: new AbortController(), reason: null };
      const running = current;
      const unitBrain = brainFor(unit.variant);
      const rig: Rig = {
        runId: id,
        brain: unitBrain,
        services,
        capabilities,
        library,
        emptyStage: EMPTY,
        timeoutMs: options.timeoutMs,
        running,
        stopped: () => stopping,
        judgeSettings,
        judgeEarlier: Array.from({ length: options.judgeFrames - 1 }, (_, at) => (at + 1) / options.judgeFrames),
        judgeSide,
        screen: screenFacts,
        judgeSlots: judgeSlotsShared,
      };
      const label = stemOf(unit);
      process.stdout.write(`  ${label} ...`);
      const t0 = performance.now();

      if (unit.kind === 'prompt') {
        const prompt = unit.prompt;
        if (baselines && prompt.baseline && !baselineCache.has(prompt.id) && env.brain.kind === 'claude-cli') {
          try {
            const base = await askBaseline(prompt.prompt, env.brain.bin, env.brain.model, env.brain.effort, running.controller.signal);
            baselineCache.set(prompt.id, base);
            if (base?.usage.costUsd != null) measured.baseline.push(base.usage.costUsd);
          } catch (error) {
            baselineCache.set(prompt.id, null);
            process.stderr.write(`explore: baseline for ${prompt.id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        const session = `explore-${id}-${label}`;
        unitBrain.open?.({ session, capabilities, screen: screenFacts, services });
        const input: TurnInput = unitBrain.id === 'replay' ? { kind: 'demo', script: replayDemo(prompt) } : { kind: 'prompt', text: prompt.prompt };
        const chosen = techniquesFor(rig, input);
        const played = await playTurn({
          prompt,
          session,
          turn: `${session}-t1`,
          idPrefix: 'x',
          input,
          context: { screen: screenFacts, capabilities, services, lead: LEAD_WINDOW, stage: EMPTY_STAGE, history: [], heard: [], techniques: chosen.cards },
          snapshot: null,
          brain: unitBrain,
          timeoutMs: options.timeoutMs,
          interruptAfterMs: null,
          signal: running.controller.signal,
          why: () => running.reason,
          ...(reviewing
            ? {
                look: {
                  policy: env.review,
                  styles: () => [],
                  draft: (lines) => eyes.look({ turn: `${session}-t1`, base: EMPTY_STAGE, lines, viewport: window, playhead: null, earlier: [], judgeSide, strip: STRIP }),
                },
              }
            : {}),
        });
        unitBrain.release?.(session);
        if (played.system !== null && !variantChecked.has(unit.variant)) {
          variantChecked.add(unit.variant);
          if (played.system !== buildSystemPrompt({ capabilities, services, variant: unit.variant })) {
            process.stderr.write(`explore: WARNING the brain's system prompt is not the "${unit.variant}" prompt: PROMPT_VARIANT did not reach it, so the variants are not being compared\n`);
          }
        }
        if (played.result.usage?.costUsd != null) measured.first.push(played.result.usage.costUsd);
        const bad = unreadable(played.result);
        if (bad > 0) process.stderr.write(`explore: ${bad} lines of ${label} do not re-parse\n`);
        const base: ExploreResult = { ...played.result, variant: unit.variant, sample: unit.sample, baseline: baselineCache.get(prompt.id) ?? null, ...(chosen.ids.length > 0 ? { techniques: chosen.ids } : {}) };

        // The final still, what the painter measured, the controls and charts worked, and the judge, while the next prompt is being written.
        let judgement: Promise<ExploreResult['judge']> = Promise.resolve(null);
        let measured2: Pick<ExploreResult, 'geometry' | 'drive'> = {};
        if (base.end === 'done' && base.lines.length > 0) {
          try {
            const seen = await inspect(
              rig,
              eyes,
              {
                turn: `${session}-t1`,
                base: EMPTY_STAGE,
                lines: base.lines.map((line, at) => ({ seq: line.seq, line: played.accepted[at] as Line })),
                viewport: window,
                playhead: null,
                earlier: rig.judgeEarlier,
                judgeSide,
                strip: STRIP,
              },
              prompt.prompt,
              base,
              judgeSettings !== null,
            );
            judgement = seen.judgement;
            measured2 = { geometry: seen.geometry, ...(seen.drive === null ? {} : { drive: seen.drive }) };
          } catch (error) {
            process.stderr.write(`explore: no picture for ${label}: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        // Did looking help? A fix is measured by ONE call that is shown the draft and the answer as it ended in an order it is not told (P1-9), and
        // only an answer that was looked at counts. What the fix did is counted from the lines: whether it opened a scene, whether it took something away.
        const looked = played.looked;
        const afterPicture = looked !== undefined && looked.draft !== null && looked.review.result === 'fixed' && judgeSettings !== null ? await eyes.look({ turn: `${session}-t1`, base: EMPTY_STAGE, lines: base.lines.map((line, at) => ({ seq: line.seq, line: played.accepted[at] as Line })), viewport: window, playhead: null, earlier: [], judgeSide, strip: STRIP }).catch(() => null) : null;
        const compared =
          looked !== undefined && looked.draft !== null && afterPicture !== null && looked.review.result === 'fixed' ? compareStills(rig, prompt.prompt, looked.draft, afterPicture) : Promise.resolve(null);
        later(
          (async () => {
            const judge = await judgement;
            const versus = await compared;
            const same = judge?.failure === null ? (judge?.coherence ?? null) : null;
            const review: ExploreResult['review'] =
              looked === undefined
                ? undefined
                : {
                    ...looked.review,
                    ...fixFacts(looked.review.result, looked.draftLines, played.accepted, base.base ?? EMPTY_STAGE),
                    before: looked.review.result === 'fixed' ? (versus?.failure === null ? (versus?.draft ?? null) : null) : same,
                    after: looked.review.result === 'fixed' ? (versus?.failure === null ? (versus?.final ?? null) : null) : same,
                  };
            const finished: ExploreResult = { ...base, ...measured2, ...(judge === null ? {} : { judge }), ...(review === undefined ? {} : { review }) };
            const verdicts = verdictsOf(finished);
            const result: ExploreResult = { ...finished, verdicts };
            await record(unit, [result], verdicts, result, result.checks.meetsExpectation);
          })(),
        );
        process.stdout.write(` ${base.end}${base.message === null ? '' : ` (${base.message})`}, ${base.totalMs} ms\n`);
      } else {
        const done = await playCase(rig, unit.case, unit.variant, unit.sample, eyes);
        const first = done.result.turns[0];
        if (first?.usage?.costUsd != null) measured.first.push(first.usage.costUsd);
        for (const turn of done.result.turns.slice(1)) if (turn.usage?.costUsd != null) measured.later.push(turn.usage.costUsd);
        later(
          done.settled.then(async (final) => {
            await record(unit, final.turns, final.verdicts, final as ExploreCaseResult, final.turns.every((turn) => turn.end === 'done' || turn.turn?.interruptedAtMs != null));
          }),
        );
        process.stdout.write(` ${done.result.turns.length} turns, ${Math.round(performance.now() - t0)} ms\n`);
      }
      current = null;
      while (pending.size > 3) await Promise.race(pending);
    }
    await Promise.all(pending);
  } finally {
    await Promise.all(pending).catch(() => undefined);
    await writeIndex();
    await eyes.close().catch(() => undefined);
    for (const found of made.values()) await found.brains.close();
  }

  // The summary the loop reads: scores by family in the terms of the quality bar, never an answer.
  const answers = recorded.flatMap((item) => (item.unit.kind === 'prompt' ? item.results : item.results.slice(0, 1)));
  const scored = summaryOf(
    { run: id, pool, battery: batteryLabel, rubric: judging ? rubricOf({ model: options.judgeModel, effort: options.judgeEffort }) : '', brain: brain.id, model, configuration: replaying ? 'replay' : options.configuration, effort: env.brain.kind === 'claude-cli' ? env.brain.effort : null, screen: `${window.width}x${window.height}`, samples: options.samples, spentUsd: recorded.reduce((sum, item) => sum + item.results.reduce((s2, r) => s2 + (r.usage?.costUsd ?? 0) + (r.judge?.costUsd ?? 0), 0), 0) },
    answers,
  );
  await writeFile(join(dir, 'summary.json'), `${JSON.stringify(scored, null, 2)}\n`);
  process.stdout.write(`\n${summary(recorded, units.length)}\n\n${familyTable(scored)}\n\n${barTable(scored)}\n\nwritten to ${dir}\n`);
  if (stopping) process.stdout.write(`stopped early: ${recorded.length} of ${units.length} units ran\n`);
}

/** What a fix did, counted from the lines and not from the painter's word: whether it opened a scene, whether what it left takes something the draft had. */
function fixFacts(result: NonNullable<ExploreResult['review']>['result'], draftLines: number, accepted: readonly Line[], base: StageBase): Pick<NonNullable<ExploreResult['review']>, 'openedScene' | 'tookAway' | 'refusedChanged'> {
  const fix = accepted.slice(draftLines);
  if (result === 'refused') return { refusedChanged: fix.length > 0 };
  if (result !== 'fixed') return {};
  const draft = new TurnScore(base);
  accepted.slice(0, draftLines).forEach((line, at) => draft.push(line, at + 1, 0));
  const final = new TurnScore(base);
  accepted.forEach((line, at) => final.push(line, at + 1, 0));
  return { openedScene: fix.some((line) => line.verb === 'scene'), tookAway: !fixKeeps(contentOf(draft.schedule), contentOf(final.schedule)).keeps };
}

const judgeSlotsShared = slots(2);


/** For the replay brain only: a fixture that stands in for the prompt, so the review page has plain text, drawings, a scene and type to show. */
function replayDemo(prompt: ExplorePrompt): string {
  const byExpectation: Readonly<Record<ExplorePrompt['expects'], string>> = {
    plain: 'plainly',
    drawn: 'sketchbook',
    motion: 'sketchbook',
    pixels: 'overture',
    scene: 'overture',
    any: 'overture',
    type: 'titles',
    structure: 'sketchbook',
    explorable: 'sketchbook',
    chart: 'sketchbook',
  };
  return byExpectation[prompt.expects];
}

try {
  await main();
} catch (error) {
  process.stderr.write(`explore: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
// Nothing may hold the process open once the run is written: a warm claude process, a timer, a pipe, a browser.
process.exit(process.exitCode ?? 0);
