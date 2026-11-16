// The art bake-off (PLAN-art.md, section 4): the same subjects drawn several ways, every one rendered by the real painter in the paper look,
// laid on one blind contact sheet for the owner to judge. Dev only; nothing in the app imports this.
//
//   pnpm bakeoff --dry-run                       the projection (calls, time, cost-equivalent); spends nothing
//   pnpm bakeoff                                 every subject, arms A, A+, B, C, D
//   pnpm bakeoff --subjects "house|rocket"       other subjects, separated by |  (a slug is made from the first words; seeds are <slug>.svg)
//   pnpm bakeoff --arms B,D --looks 2            a subset of arms; D's looks per subject (default 6; at most 6)
//   pnpm bakeoff --seeds <dir>                   arm C reads <dir>/<slug>.svg; with no folder, arm C shows "no seed" tiles
//   pnpm bakeoff --max-usd 15 --yes              a run projected over --max-usd refuses to start without --yes
//   pnpm bakeoff --check-converter               feeds the converter a few hostile SVGs and says whether each was refused
//
// Arms. A: the shipped brain through `pnpm explore` (the real server path), its drawing alone. A+: the same lines with the page loaded with
// ?shade=1. B: one `ask()` of the strongest model at high effort, one strict SVG. C: a hand-picked SVG from --seeds. D: the staged illustrator,
// a server-driven loop of `ask()` calls that each get the rendered picture back. B, C and D go through the converter (art/svg.ts).
// Everything runs on the owner's `claude` login (`ask()` starts the CLI; no API key is read or sent anywhere).

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EMPTY_STAGE, parseLine, serializeLine } from '@conduit/language';
import type { Line } from '@conduit/language';
import { ask } from '../judge/ask';
import type { Asked, JudgeSettings, JudgeUsage, Picture } from '../judge/ask';
import { spawnTracked } from '../brains/claude-cli/process';
import { processEnvironment } from '../env';
import { openEyes, repoRoot } from './explore-browser';
import type { Eyes } from './explore-browser';
import { convertSvg } from '../art/svg';

// ---- options ----

const DEFAULT_OUT = '/tmp/conduit/bakeoff/';
const ARMS = ['A', 'A+', 'B', 'C', 'D'] as const;
type Arm = (typeof ARMS)[number];
const WEB_PORT = 4876;
const VIEW = 800;
const SIDE = 640;

const DEFAULT_SUBJECTS: readonly string[] = [
  'fox sitting, facing left',
  'a friendly woodland monster (original, not a named character)',
  'house',
  'child standing',
  'rocket',
  'oak tree',
  'a heart cutaway with four chambers',
];
const DEFAULT_SLUGS = ['fox', 'monster', 'house', 'child', 'rocket', 'oak-tree', 'heart'];

interface Options {
  readonly subjects: readonly { readonly slug: string; readonly text: string }[];
  readonly arms: readonly Arm[];
  readonly seeds: string | null;
  readonly out: string;
  readonly looks: number;
  readonly minutes: number;
  readonly dryRun: boolean;
  readonly maxUsd: number;
  readonly yes: boolean;
  readonly model: string | null;
  readonly aModel: string;
  readonly seed: number;
  readonly checkConverter: boolean;
}

const slugOf = (text: string): string => text.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 3).join('-') || 'subject';

function usageError(message: string): never {
  process.stderr.write(`bakeoff: ${message}\n`);
  process.exit(2);
}

function parseArguments(argv: readonly string[]): Options {
  let subjects = DEFAULT_SUBJECTS.map((text, at) => ({ slug: DEFAULT_SLUGS[at] ?? slugOf(text), text }));
  let arms: Arm[] = [...ARMS];
  let seeds: string | null = null;
  let out = DEFAULT_OUT;
  let looks = 6;
  let minutes = 8;
  let dryRun = false;
  let maxUsd = 15;
  let yes = false;
  let model: string | null = null;
  let aModel = processEnvironment()['CLAUDE_MODEL'] ?? 'sonnet';
  let seed = Date.now() % 100000;
  let checkConverter = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const value = (): string => argv[(i += 1)] ?? usageError(`${flag} needs a value`);
    if (flag === '--subjects') subjects = value().split('|').map((t) => t.trim()).filter((t) => t !== '').map((text) => ({ slug: slugOf(text), text }));
    else if (flag === '--arms') {
      arms = value().split(',').map((a) => a.trim().toUpperCase()).filter((a) => a !== '') as Arm[];
      const bad = arms.filter((a) => !(ARMS as readonly string[]).includes(a));
      if (bad.length > 0) usageError(`unknown arm ${bad.join(', ')} (known: ${ARMS.join(', ')})`);
    } else if (flag === '--seeds') seeds = resolve(value());
    else if (flag === '--out') out = resolve(value());
    else if (flag === '--looks') looks = Math.min(6, Math.max(1, Number(value())));
    else if (flag === '--minutes') minutes = Number(value());
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--max-usd') maxUsd = Number(value());
    else if (flag === '--yes') yes = true;
    else if (flag === '--model') model = value();
    else if (flag === '--a-model') aModel = value();
    else if (flag === '--shuffle-seed') seed = Number(value());
    else if (flag === '--check-converter') checkConverter = true;
    else usageError(`unknown option ${flag}`);
  }
  if (subjects.length === 0) usageError('no subjects');
  if (arms.length === 0) usageError('no arms');
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) usageError('--max-usd must be a positive number');
  return { subjects, arms, seeds, out, looks, minutes, dryRun, maxUsd, yes, model, aModel, seed, checkConverter };
}

// ---- the projection ----

/** Rough cost-equivalent dollars and seconds per call: to be replaced by the numbers of a real run (the sheet's table records them). */
const GUESS = { aUsd: 0.2, aSec: 70, bUsd: 0.45, bSec: 120, dLowUsd: 0.25, dHighUsd: 0.5, dLowSec: 60, dHighSec: 110, scoreUsd: 0.05, scoreSec: 20 };

function project(options: Options): { calls: number; seconds: number; usd: number; notes: string[] } {
  const n = options.subjects.length;
  const has = (arm: Arm): boolean => options.arms.includes(arm);
  let calls = 0;
  let seconds = 0;
  let usd = 0;
  const notes: string[] = [];
  if (has('A') || has('A+')) {
    calls += n;
    seconds += n * GUESS.aSec;
    usd += n * GUESS.aUsd;
    notes.push(`A (and A+, no model): ${n} shipped-brain turns`);
  }
  if (has('B')) {
    calls += n;
    seconds += n * GUESS.bSec;
    usd += n * GUESS.bUsd;
    notes.push(`B: ${n} calls`);
  }
  if (has('D')) {
    const low = Math.min(2, options.looks);
    const high = options.looks - low;
    const per = low * GUESS.dLowUsd + high * GUESS.dHighUsd + GUESS.scoreUsd;
    calls += n * (options.looks + 1);
    seconds += n * Math.min(options.minutes * 60, low * GUESS.dLowSec + high * GUESS.dHighSec + GUESS.scoreSec);
    usd += n * per;
    notes.push(`D: up to ${options.looks} looks and one scoring call per subject, the loop stopping at ${options.minutes} minutes`);
  }
  if (has('C')) notes.push('C: no model calls');
  return { calls, seconds, usd, notes };
}

// ---- model calls, tallied ----

interface Tally {
  calls: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
}
const newTally = (): Tally => ({ calls: 0, ms: 0, inputTokens: 0, outputTokens: 0, usd: null });
function tally(into: Tally, usage: JudgeUsage): void {
  into.calls += 1;
  into.ms += usage.ms;
  into.inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  into.outputTokens += usage.outputTokens + (usage.thinkingTokens ?? 0);
  if (usage.costUsd !== null) into.usd = (into.usd ?? 0) + usage.costUsd;
}

// ---- prompts ----

const STYLE = `You are a picture-book illustrator. You answer with exactly one SVG document and nothing else (no prose, no code fence unless it wraps the SVG).

The picture: a children's picture-book illustration, warm and simple, readable at a glance, drawn to be looked at from across a room.

The SVG:
- <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">. The subject fills about 80% of the box, centred, with a little ground or shadow under it if it stands or sits. No background rectangle.
- Only these elements: path, circle, ellipse, rect, polygon, polyline, line, g. No text, no gradients, no filters, no clip paths, no masks, no <defs>, no <use>, no <style>, no images, no url(...) anywhere.
- Only these attributes: the geometry, id, fill, stroke, stroke-width, opacity, transform. Colours are #rrggbb or none.
- 8 to 24 parts in all, each with a short unique id naming what it is (for example "body", "tail", "left-ear"), ordered back to front.
- Fills come from a small palette of at most 8 colours: a main hue, a lighter and a darker shade of it, one or two accents, a cream, a deep ink for outlines. Use shade shapes (darker parts, lighter highlights) for form, not outlines alone.
- The outer silhouette of the subject is drawn heavier (stroke-width 1.4 to 2.2, in the deep ink or a dark tone of the part); inner lines are lighter (0.5 to 1).
- Prefer a few confident curves (path with C and Q) over many small segments. One path per part; do not make compound paths with holes.`;

interface Stage {
  readonly name: string;
  readonly effort: 'low' | 'high';
  readonly brief: string;
}
const STAGES: readonly Stage[] = [
  { name: 'gesture', effort: 'low', brief: 'GESTURE. Five to eight loose, flat shapes that catch the pose, the lean and the overall silhouette. Two or three colours. Do not add detail.' },
  { name: 'blocking', effort: 'low', brief: 'BLOCKING. Settle the proportions and the big shapes: head to body, limb lengths, the size of each major part against the box. Keep the parts few; fix whatever the picture shows is wrong.' },
  { name: 'forms', effort: 'high', brief: 'REFINED FORMS. Replace blocks with real contours: curves for the back, belly, ears, roof lines, whatever the subject has. Give the outer silhouette its heavier outline. Keep ids stable so parts can be tracked from round to round.' },
  { name: 'colour', effort: 'high', brief: 'COLOUR AND LIGHT. Settle the palette (at most 8 colours). Add one shade shape and one highlight shape to the big forms, light from the upper left, and a soft ground shadow.' },
  { name: 'detail', effort: 'high', brief: 'DETAIL. The small things that make it a character: eyes, nose, mouth, doors and windows, texture marks, a few fur or leaf marks. Stay at or under 24 parts: merge or drop the least useful.' },
  { name: 'polish', effort: 'high', brief: 'POLISH. One last look: fix whatever still reads wrong (overlaps, gaps, awkward edges), and stop adding.' },
];
const CHECKLIST: Readonly<Record<string, string>> = {
  gesture: 'Does the silhouette read as the subject at a glance? Is the pose right (facing, sitting, standing)? Is it centred and big enough?',
  blocking: 'Are proportions believable? Does anything float, detach or overlap wrongly? Is the front/back order of parts right?',
  forms: 'Are contours smooth and confident? Is the outer line heavier than inner lines? Any hard polygon corners that should be curves?',
  colour: 'Is the palette small and harmonious? Do light and shade follow one light? Is there contrast between neighbouring parts?',
  detail: 'Is the face or the key feature charming and clear? Is any detail noise rather than meaning? Still within 24 parts?',
  polish: 'Anything still wrong at a glance? If not, write DONE.',
};

const D_SYSTEM = `${STYLE}

You work in rounds on one picture, as an illustrator does at the desk. Each round you are told the stage; after the first you are shown the picture as it was last drawn (a rendered image) and the SVG behind it, and a short checklist.

Answer each round in this exact form:
SEEN: <a score from 1 to 10 for the picture you were shown, judged as a finished children's book illustration of the subject; leave this line out in round 1>
NOTES: <one line: what you will change>
Then either the full revised <svg>...</svg> (always the whole document, never a patch), or the single word DONE on its own line if the picture needs nothing more (then write no SVG).`;

// ---- converting and rendering ----

const PRELUDE = ['look paper', 'scene art layout=free canvas=square'].map((raw) => {
  const parsed = parseLine(raw);
  if (parsed.kind !== 'line') throw new Error(`prelude does not parse: ${raw}`);
  return parsed.line;
});

interface Shot {
  readonly png: string;
  /** a 480 px JPEG, small enough to embed in the sheet */
  readonly thumb: string;
}

/**
 * Where pictures are taken. The harness page keeps what it painted by element id (a second house with a `roof` of its own is drawn over the first one's),
 * so every picture gets a page of its own: a new Chrome tab on the one dev server, closed after.
 */
interface Viewer {
  readonly shot: (lines: readonly Line[], turn: string) => Promise<Shot>;
}

function viewerOn(web: string, query?: string): Viewer {
  return {
    shot: async (lines, turn) => {
      const eyes = await openEyes({ web, port: WEB_PORT, repo: repoRoot(), ...(query === undefined ? {} : { query }) });
      try {
        return await render(eyes, lines, turn);
      } finally {
        await eyes.close().catch(() => undefined);
      }
    },
  };
}

async function render(eyes: Eyes, lines: readonly Line[], turn: string): Promise<Shot> {
  const reply = await eyes.look({
    turn,
    base: EMPTY_STAGE,
    lines: lines.map((line, at) => ({ seq: at + 1, line })),
    viewport: { width: VIEW, height: VIEW, dpr: 1 },
    playhead: null,
    earlier: [],
    judgeSide: SIDE,
    look: 'paper',
  });
  const png = reply.judge[reply.judge.length - 1];
  if (png === undefined) throw new Error('the page took no picture');
  return { png, thumb: reply.thumbs[reply.thumbs.length - 1] ?? png };
}

const svgOf = (reply: string): string | null => /<svg[\s\S]*<\/svg>/i.exec(reply)?.[0] ?? null;

interface Round {
  readonly stage: string;
  readonly svg: string | null;
  readonly rejected: string | null;
  readonly png: string | null;
  readonly thumb: string | null;
  /** the model's own score of this round's picture, given when it was shown it */
  score: number | null;
  readonly notes: string;
}

interface Result {
  readonly arm: Arm;
  readonly png: string | null;
  readonly thumb: string | null;
  readonly svg: string | null;
  readonly message: string | null;
  readonly seconds: number;
  readonly calls: number;
  readonly rounds: number;
  readonly tokens: number;
  readonly usd: number | null;
  readonly progression: readonly Round[];
}

const failed = (arm: Arm, message: string, seconds = 0, t: Tally = newTally()): Result => ({ arm, png: null, thumb: null, svg: null, message, seconds, calls: t.calls, rounds: 0, tokens: t.inputTokens + t.outputTokens, usd: t.usd, progression: [] });

// ---- the arms ----

interface Brain {
  readonly settings: (effort: 'low' | 'medium' | 'high') => JudgeSettings;
  readonly signal: AbortSignal;
  readonly model: string;
}

async function armB(eyes: Viewer, brain: Brain, subject: { slug: string; text: string }): Promise<Result> {
  const t = newTally();
  const started = Date.now();
  const asked = await ask(STYLE, `Draw: ${subject.text}.`, [], brain.settings('high'), brain.signal);
  tally(t, asked.usage);
  if (asked.failure !== null) return failed('B', `the model call failed: ${asked.failure}`, (Date.now() - started) / 1000, t);
  const svg = svgOf(asked.reply);
  if (svg === null) return failed('B', 'the reply held no <svg>', (Date.now() - started) / 1000, t);
  const converted = convertSvg(svg);
  if (!converted.ok) return { ...failed('B', `converter refused: ${converted.reason}`, (Date.now() - started) / 1000, t), svg };
  const shot = await eyes.shot([...PRELUDE, ...converted.lines], `b-${subject.slug}`);
  return { arm: 'B', png: shot.png, thumb: shot.thumb, svg, message: null, seconds: (Date.now() - started) / 1000, calls: t.calls, rounds: 1, tokens: t.inputTokens + t.outputTokens, usd: t.usd, progression: [] };
}

async function armC(eyes: Viewer, options: Options, subject: { slug: string; text: string }): Promise<Result> {
  const file = options.seeds === null ? null : join(options.seeds, `${subject.slug}.svg`);
  if (file === null || !existsSync(file)) return failed('C', 'no seed');
  const svg = await readFile(file, 'utf8');
  const converted = convertSvg(svg);
  if (!converted.ok) return { ...failed('C', `converter refused: ${converted.reason}`), svg };
  const shot = await eyes.shot([...PRELUDE, ...converted.lines], `c-${subject.slug}`);
  return { arm: 'C', png: shot.png, thumb: shot.thumb, svg, message: null, seconds: 0, calls: 0, rounds: 0, tokens: 0, usd: null, progression: [] };
}

async function armD(eyes: Viewer, brain: Brain, options: Options, subject: { slug: string; text: string }): Promise<Result> {
  const t = newTally();
  const started = Date.now();
  const rounds: Round[] = [];
  let last: { svg: string; png: string } | null = null;
  let complaint: string | null = null;
  let lastIndexShown = -1;
  const budgetMs = options.minutes * 60_000;
  for (let at = 0; at < options.looks; at += 1) {
    if (Date.now() - started > budgetMs) break;
    const stage = STAGES[Math.min(at, STAGES.length - 1)] as Stage;
    const checklist = CHECKLIST[stage.name] ?? '';
    const parts: string[] = [`Subject: ${subject.text}.`, `Round ${at + 1} of at most ${options.looks}. Stage: ${stage.brief}`];
    const pictures: Picture[] = [];
    if (last !== null) {
      parts.push(`The picture as last drawn is attached, and this is the SVG behind it:\n${last.svg}`);
      parts.push(`Checklist for this stage: ${checklist}`);
      pictures.push({ data: last.png, mime: 'image/png' });
    }
    if (complaint !== null) parts.push(`Your last SVG was rejected by the converter and not drawn: ${complaint}. Fix that.`);
    const asked: Asked = await ask(D_SYSTEM, parts.join('\n\n'), pictures, brain.settings(stage.effort), brain.signal);
    tally(t, asked.usage);
    if (asked.failure !== null) {
      rounds.push({ stage: stage.name, svg: null, rejected: `the model call failed: ${asked.failure}`, png: null, thumb: null, score: null, notes: '' });
      break;
    }
    const seen = /SEEN:\s*(\d+(?:\.\d+)?)/i.exec(asked.reply);
    if (seen !== null && lastIndexShown >= 0 && rounds[lastIndexShown] !== undefined) (rounds[lastIndexShown] as Round).score = Number(seen[1]);
    const notes = /NOTES:\s*(.*)/i.exec(asked.reply)?.[1]?.trim() ?? '';
    const svg = svgOf(asked.reply);
    if (svg === null) {
      if (/^\s*DONE\s*$/im.test(asked.reply) && last !== null) break;
      complaint = 'the reply held no <svg>';
      rounds.push({ stage: stage.name, svg: null, rejected: complaint, png: null, thumb: null, score: null, notes });
      continue;
    }
    const converted = convertSvg(svg);
    if (!converted.ok) {
      complaint = converted.reason;
      rounds.push({ stage: stage.name, svg, rejected: converted.reason, png: null, thumb: null, score: null, notes });
      continue;
    }
    complaint = null;
    const shot = await eyes.shot([...PRELUDE, ...converted.lines], `d-${subject.slug}-${at + 1}`);
    rounds.push({ stage: stage.name, svg, rejected: null, png: shot.png, thumb: shot.thumb, score: null, notes });
    lastIndexShown = rounds.length - 1;
    last = { svg, png: shot.png };
  }
  // The last picture drawn has not been looked at by the model yet: one cheap call scores it, so the best round can be chosen fairly.
  const final = rounds[lastIndexShown];
  if (final !== undefined && final.score === null && final.png !== null) {
    const scored = await ask('You score children\'s picture-book illustrations. Reply with one number from 1 to 10 and nothing else.', `Subject: ${subject.text}. Score this picture as a finished illustration of it.`, [{ data: final.png, mime: 'image/png' }], brain.settings('low'), brain.signal);
    tally(t, scored.usage);
    const n = /\d+(?:\.\d+)?/.exec(scored.reply);
    if (scored.failure === null && n !== null) final.score = Number(n[0]);
  }
  const drawn = rounds.filter((r) => r.png !== null);
  if (drawn.length === 0) return { ...failed('D', rounds.map((r) => r.rejected).filter((x) => x !== null).join('; ') || 'no round drew', (Date.now() - started) / 1000, t), progression: rounds };
  // The best round, not the last: the highest self-score, the later one on a tie; with no scores at all, the last.
  let best = drawn[drawn.length - 1] as Round;
  for (const r of drawn) if (r.score !== null && (best.score === null || r.score >= best.score)) best = r;
  return { arm: 'D', png: best.png, thumb: best.thumb, svg: best.svg, message: `kept round ${rounds.indexOf(best) + 1} of ${rounds.length}`, seconds: (Date.now() - started) / 1000, calls: t.calls, rounds: rounds.length, tokens: t.inputTokens + t.outputTokens, usd: t.usd, progression: rounds };
}

/** Arm A: the shipped brain through `pnpm explore` (the real server path), one prompt per subject; its drawing is kept and the text is dropped. */
async function shippedLines(options: Options, subject: { slug: string; text: string }, workdir: string): Promise<{ lines: Line[]; seconds: number; tokens: number; usd: number | null } | string> {
  const started = Date.now();
  const batteryPath = join(workdir, `battery-${subject.slug}.json`);
  const id = `bakeoff-${subject.slug}`;
  await writeFile(batteryPath, JSON.stringify({ version: 4, pool: 'tune', prompts: [{ id, useCase: 'bake-off subject', prompt: `Draw ${/^(a|an|the) /i.test(subject.text) ? '' : 'a '}${subject.text}.`, expects: 'drawn', baseline: false, family: 'scene' }] }));
  const args = ['--filter', '@conduit/server', 'exec', 'tsx', '--env-file-if-exists=../.env', 'src/tools/explore.ts', '--battery', batteryPath, '--brain', 'shipped', '--model', options.aModel, '--samples', '1', '--no-baseline', '--no-cases', '--no-judge', '--yes', '--only', id];
  const child = spawnTracked('pnpm', args, undefined, { cwd: repoRoot(), env: { EXPLORE_WEB_PORT: '4877' } });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => (output = (output + c).slice(-4_000)));
  child.stderr?.on('data', (c: string) => (output = (output + c).slice(-4_000)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 6 * 60_000);
  await new Promise<void>((done) => {
    child.once('close', () => done());
    child.once('error', () => done());
  });
  clearTimeout(timer);
  const run = /run (\S+): \d+ units/.exec(output)?.[1];
  if (run === undefined) return `explore did not start a run: ${output.slice(-300)}`;
  const dir = join(repoRoot(), 'explore', 'runs', run);
  const file = (await readdir(dir).catch(() => [] as string[])).find((name) => name.startsWith(id) && name.endsWith('.json'));
  if (file === undefined) return `explore wrote no result for ${id}: ${output.slice(-300)}`;
  const result = JSON.parse(await readFile(join(dir, file), 'utf8')) as { lines?: { text: string }[]; results?: { lines: { text: string }[]; usage: { outputTokens: number | null; inputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number | null } | null }[]; usage?: { outputTokens: number | null; inputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number | null } | null };
  const body = result.results?.[0] ?? (result as { lines: { text: string }[]; usage: typeof result.usage });
  const lines: Line[] = [];
  for (const entry of body.lines ?? []) {
    const parsed = parseLine(entry.text);
    if (parsed.kind !== 'line') continue;
    // the drawing alone, not the words
    if (parsed.line.verb === 'say' || parsed.line.verb === 'correct') continue;
    lines.push(parsed.line);
  }
  if (lines.length === 0) return 'the shipped brain drew nothing';
  const u = body.usage ?? null;
  return { lines, seconds: (Date.now() - started) / 1000, tokens: (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0) + (u?.outputTokens ?? 0), usd: u?.costUsd ?? null };
}

// ---- the sheet ----

interface Row {
  readonly subject: { slug: string; text: string };
  readonly results: readonly Result[];
  readonly order: readonly Arm[];
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const esc = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const img = (thumb: string | null): string => (thumb === null ? '' : `<img src="data:image/jpeg;base64,${thumb}" alt="">`);

function sheetHtml(rows: readonly Row[], arms: readonly Arm[], stamp: string): string {
  const cols = Math.max(...rows.map((r) => r.order.length), 1);
  const body = rows
    .map((row) => {
      const tiles = row.order
        .map((arm, at) => {
          const r = row.results.find((x) => x.arm === arm);
          const inner = r?.thumb != null ? img(r.thumb) : `<div class="none">${esc(r?.message === 'no seed' ? 'no seed' : r?.message ?? 'no picture')}</div>`;
          return `<figure><span class="n">${at + 1}</span>${inner}</figure>`;
        })
        .join('');
      return `<section><h2>${esc(row.subject.text)}</h2><div class="row" style="grid-template-columns:repeat(${cols},1fr)">${tiles}</div></section>`;
    })
    .join('\n');
  const table = rows
    .flatMap((row) => row.order.map((arm, at) => ({ row, arm, at, r: row.results.find((x) => x.arm === arm) })))
    .map(({ row, arm, at, r }) => `<tr><td>${esc(row.subject.slug)}</td><td>${at + 1}</td><td>${arm}</td><td>${r === undefined ? '' : r.seconds.toFixed(0)}</td><td>${r?.calls ?? ''}</td><td>${r?.rounds ?? ''}</td><td>${r?.tokens ?? ''}</td><td>${r?.usd == null ? '' : `$${r.usd.toFixed(2)}`}</td><td>${esc(r?.message ?? '')}</td></tr>`)
    .join('\n');
  const strips = rows
    .filter((row) => (row.results.find((x) => x.arm === 'D')?.progression.length ?? 0) > 0)
    .map((row) => {
      const d = row.results.find((x) => x.arm === 'D') as Result;
      const tiles = d.progression.map((round, at) => `<figure><span class="n">${at + 1}</span>${round.thumb === null ? `<div class="none">${esc(round.rejected ?? 'no picture')}</div>` : img(round.thumb)}<figcaption>${esc(round.stage)}${round.score === null ? '' : `, self-score ${round.score}`}</figcaption></figure>`).join('');
      return `<h3>${esc(row.subject.text)}</h3><div class="strip">${tiles}</div>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Art bake-off ${esc(stamp)}</title>
<style>
:root{--bg:#f4f1ea;--fg:#222;--line:#cfc8b8;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--fg:#eee;--line:#444}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
h1{font-size:20px}h2{font-size:16px;margin:24px 0 8px}h3{font-size:14px}
.row{display:grid;gap:8px}.strip{display:flex;gap:8px;overflow-x:auto}.strip figure{flex:0 0 240px}
figure{margin:0;position:relative;border:1px solid var(--line);background:#fff;border-radius:6px;overflow:hidden}
figure img{display:block;width:100%;height:auto}.n{position:absolute;left:6px;top:6px;background:#000c;color:#fff;border-radius:12px;padding:0 8px;font-weight:700}
.none{display:grid;place-items:center;aspect-ratio:1;color:#888;font-style:italic;background:var(--bg)}
figcaption{padding:4px 8px;font-size:12px;color:#444}
table{border-collapse:collapse;font-size:13px}td,th{border:1px solid var(--line);padding:3px 8px;text-align:left}
details{margin-top:32px}
@media (max-width:700px){.row{grid-template-columns:repeat(2,1fr)!important}}
</style></head><body>
<h1>Art bake-off, ${esc(stamp)}</h1>
<p>Each row is one subject. The pictures are labelled 1 to ${cols} and the order is shuffled per row. Judge first; open the key after.</p>
${body}
<details><summary>Key, costs and D's progression (open after judging)</summary>
<p>Arms in this run: ${arms.join(', ')}. The same key is in key.json.</p>
<table><tr><th>subject</th><th>#</th><th>arm</th><th>seconds</th><th>calls</th><th>rounds</th><th>tokens</th><th>cost-equivalent</th><th>note</th></tr>
${table}</table>
<h2>D, round by round</h2>
${strips || '<p>No D run.</p>'}
</details></body></html>`;
}

// ---- the converter's own check ----

function checkConverter(): never {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="wall" x="20" y="40" width="60" height="40" fill="#c97" stroke="#432" stroke-width="1.5"/></svg>';
  const cases: [string, string, boolean][] = [
    ['a clean document', ok, true],
    ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', false],
    ['an onload handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect x="1" y="1" width="5" height="5"/></svg>', false],
    ['an external href on an image', '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example/x.png" width="10" height="10"/></svg>', false],
    ['a use with xlink:href', '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="#a"/></svg>', false],
    ['a use element', '<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>', false],
    ['a style element with url()', '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(http://evil.example/a)}</style><rect x="1" y="1" width="5" height="5"/></svg>', false],
    ['a fill with url()', '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="5" height="5" fill="url(#g)"/></svg>', false],
    ['a DOCTYPE with an entity', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="5" height="5"/></svg>', false],
    ['text', '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="1">hi</text></svg>', false],
    ['a foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>', false],
    ['a style attribute', '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="5" height="5" style="fill:red"/></svg>', false],
    ['25 parts', `<svg xmlns="http://www.w3.org/2000/svg">${'<circle cx="5" cy="5" r="2"/>'.repeat(25)}</svg>`, false],
    ['over 64 KB', `<svg xmlns="http://www.w3.org/2000/svg">${'<!-- -->'.repeat(9000)}<rect x="1" y="1" width="5" height="5"/></svg>`, false],
    ['401 path commands', `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0${' L1 1'.repeat(400)}"/></svg>`, false],
  ];
  let bad = 0;
  for (const [name, svg, accept] of cases) {
    const got = convertSvg(svg);
    const right = got.ok === accept;
    if (!right) bad += 1;
    process.stdout.write(`${right ? 'ok  ' : 'FAIL'} ${name}: ${got.ok ? `accepted, ${got.parts} part(s): ${got.text[1]?.slice(0, 70)}` : `refused (${got.reason})`}\n`);
  }
  process.exit(bad === 0 ? 0 : 1);
}

// ---- main ----

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.checkConverter) checkConverter();
  const plan = project(options);
  process.stdout.write(
    `plan: ${options.subjects.length} subjects x arms ${options.arms.join(', ')}; about ${plan.calls} model calls, ${(plan.seconds / 60).toFixed(0)} minutes, $${plan.usd.toFixed(2)} cost-equivalent of subscription usage (a guess: the sheet's table records the real numbers; no paid API)\n` +
      `${plan.notes.map((n) => `  ${n}\n`).join('')}`,
  );
  if (options.dryRun) return;
  if (plan.usd > options.maxUsd && !options.yes) usageError(`projected $${plan.usd.toFixed(2)} is over --max-usd ${options.maxUsd}; narrow --subjects/--arms/--looks, or pass --yes`);

  const env = processEnvironment();
  const bin = env['CLAUDE_BIN'] ?? 'claude';
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const needsModel = options.arms.includes('B') || options.arms.includes('D');
  let model = options.model ?? 'opus';
  if (needsModel && options.model === null) {
    // The strongest model the login offers: Fable if it answers, else Opus.
    const probe = await ask('Reply with the single word ok.', 'ok?', [], { bin, model: 'fable', effort: 'low', timeoutMs: 90_000 }, controller.signal);
    model = probe.failure === null && probe.reply.trim() !== '' ? 'fable' : 'opus';
    process.stdout.write(`model: ${model}${model === 'opus' ? ' (fable is not offered on this login)' : ''}\n`);
  }
  const brain: Brain = { model, signal: controller.signal, settings: (effort) => ({ bin, model, effort, timeoutMs: 300_000 }) };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(options.out, `bakeoff-${stamp}`);
  await mkdir(join(dir, 'png'), { recursive: true });
  await mkdir(join(dir, 'work'), { recursive: true });
  process.stdout.write(`out: ${dir}\nstarting the headless browser ...\n`);
  // This one starts the dev server (and holds it); the pictures are taken on pages of their own.
  const host = await openEyes({ web: null, port: WEB_PORT, repo: repoRoot() });
  const web = `http://127.0.0.1:${WEB_PORT}`;
  const eyes = viewerOn(web);
  const shaded = options.arms.includes('A+') ? viewerOn(web, 'shade=1') : null;

  const rows: Row[] = [];
  const key: Record<string, Record<string, string>> = {};
  const save = async (): Promise<void> => {
    await writeFile(join(dir, 'sheet.html'), sheetHtml(rows, options.arms, stamp));
    await writeFile(join(dir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
    const table = rows.flatMap((row) => row.results.map((r) => ({ subject: row.subject.slug, arm: r.arm, seconds: Math.round(r.seconds), calls: r.calls, rounds: r.rounds, tokens: r.tokens, costEquivalentUsd: r.usd, note: r.message })));
    await writeFile(join(dir, 'table.json'), `${JSON.stringify(table, null, 2)}\n`);
  };
  try {
    for (const [index, subject] of options.subjects.entries()) {
      process.stdout.write(`\n== ${subject.text}\n`);
      const results: Result[] = [];
      const guard = async (arm: Arm, work: () => Promise<Result>): Promise<void> => {
        const t0 = Date.now();
        try {
          const r = await work();
          results.push(r);
          process.stdout.write(`  ${arm}: ${r.png === null ? `no picture (${r.message ?? ''})` : `done${r.message === null ? '' : ` (${r.message})`}`} in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${r.calls} calls\n`);
        } catch (error) {
          results.push(failed(arm, `error: ${error instanceof Error ? error.message : String(error)}`, (Date.now() - t0) / 1000));
          process.stdout.write(`  ${arm}: error ${error instanceof Error ? error.message : String(error)}\n`);
        }
        const last = results[results.length - 1];
        if (last?.png != null) await writeFile(join(dir, 'png', `${subject.slug}-${arm.replace('+', 'plus')}.png`), Buffer.from(last.png, 'base64'));
        for (const [at, round] of (last?.progression ?? []).entries()) if (round.png !== null) await writeFile(join(dir, 'png', `${subject.slug}-D-round${at + 1}.png`), Buffer.from(round.png, 'base64'));
        if (last?.svg != null) await writeFile(join(dir, 'work', `${subject.slug}-${arm.replace('+', 'plus')}.svg`), last.svg);
      };
      if (options.arms.includes('A') || options.arms.includes('A+')) {
        const drawn = await shippedLines(options, subject, join(dir, 'work'));
        if (typeof drawn === 'string') {
          for (const arm of ['A', 'A+'] as const) if (options.arms.includes(arm)) results.push(failed(arm, drawn));
          process.stdout.write(`  A: ${drawn}\n`);
        } else {
          await writeFile(join(dir, 'work', `${subject.slug}-A.series`), `${drawn.lines.map((l) => serializeLine(l)).join('\n')}\n`);
          const shown = async (viewer: Viewer, arm: Arm): Promise<void> => {
            await guard(arm, async () => {
              const shot = await viewer.shot(drawn.lines, `a-${subject.slug}`);
              return { arm, png: shot.png, thumb: shot.thumb, svg: null, message: arm === 'A+' ? 'same lines, ?shade=1' : null, seconds: arm === 'A' ? drawn.seconds : 0, calls: arm === 'A' ? 1 : 0, rounds: arm === 'A' ? 1 : 0, tokens: arm === 'A' ? drawn.tokens : 0, usd: arm === 'A' ? drawn.usd : null, progression: [] };
            });
          };
          if (options.arms.includes('A')) await shown(eyes, 'A');
          if (options.arms.includes('A+') && shaded !== null) await shown(shaded, 'A+');
        }
      }
      if (options.arms.includes('B')) await guard('B', () => armB(eyes, brain, subject));
      if (options.arms.includes('C')) await guard('C', () => armC(eyes, options, subject));
      if (options.arms.includes('D')) await guard('D', () => armD(eyes, brain, options, subject));
      const order = shuffled(options.arms, options.seed + index * 7919);
      key[subject.slug] = Object.fromEntries(order.map((arm, at) => [String(at + 1), arm]));
      rows.push({ subject, results, order });
      await save();
    }
  } finally {
    await host.close().catch(() => undefined);
  }
  await save();
  process.stdout.write(`\nsheet: ${join(dir, 'sheet.html')}\nkey: ${join(dir, 'key.json')}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`bakeoff: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
