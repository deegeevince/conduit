// pnpm check: the free browser check. No model, no account, no network beyond localhost.
//
//   pnpm check [--url http://127.0.0.1:<port>] [--out <dir>] [--screens 1280x720,390x844] [--timeout <seconds>] [--allow-plain] [--sequential] [--quiet] [--only <groups>] [--jobs <n>] [--list] [--webkit]
//
//   --only art-maker,memory   run just those groups (a name, or the start of one: `demo` is every demo); --list prints the names
//   --jobs <n>                how many groups run side by side, each in its own Chrome (default min(8, cpus/2)); --sequential is --jobs 1
//
// With no --url it starts the server from the current build (run `pnpm build` first) on a free port with BRAIN=replay and a throwaway data folder, and
// stops it again. Then, in headless Chrome on each screen, it drives the page the way smoke does (smoke's own `Tab` and checks, not new ones):
//
//   welcome            the first-visit welcome (language/demos/overture.series) plays and settles with its intro line and every starter, found by the
//                      script's own words; it settles under reduced motion too
//   choice             a real tap on a starter is sent as a turn and the replay brain answers it, to rest
//   every demo         each demo (`problem` has its own scenes) is played by name and comes to rest, the ones the app does not offer yet (`DEMOS_NOT_PAINTED`) too: not offered is not unjudged
//   explorable         a slider and a pick of the explorable demo change the drawing with no request to the server (a higher sun stands higher and throws a shorter shadow, away from it)
//   problems           each `problem` of language/demos/problem.series (old logs) is played at its own turn: the question is on the canvas with a blank, nothing takes the
//                      screen, a wrong answer put in the blank is marked wrong and the right one right (no model)
//   ask                (tablet 1180x820 at two pixels, touch, the lens off and on) a finger tap on an ask's blank focuses its input, also under the Draw layer after a pen stroke;
//                      a short pen tap too, a pen drag writes; `fill` puts a wrong or right answer in the blank and opens the next stage; Send drawing names the ask (ask-check.ts)
//   tour               (`/demo`; 1280x800, 820x971, 390x844) the tour opens on the stage, a chapter lists its cards, a card plays its demo with no model call, "Back to the tour" returns, `/demo <name>` jumps to one (tour-check.ts)
//   fb-055             a label the brain drew (`say callout near=x`, a figure part's `label=`) is tapped to ask about what it names: one act that names the part, none for a drag, a click on
//                      the drawn part or on plain words; with a mouse and a finger; the journey's `tap | Brakes` finds "brake disc" (label-check.ts)
//   fb-064             the Undo chip puts the answer before back whole: the car's labels (and a click on one asks about it), its words and its choice, and nothing of the answer it
//                      undid stands over it (undo-check.ts)
//   lens               (flag on, ?lens=1; tablet 1180x820 at two pixels to the point with touch, and 390x844) a two-finger pinch to 2x, then a tap on a choice, a slider
//                      drag and a pen stroke each land on the right page point; 0 fits again; the pen draws without Draw, a short pen tap presses (lens-check.ts)
//
//   fb-023, fb-002     the demo audit's checks with no browser (`pnpm timeline demos`, `pnpm demo-checks`), named by the backlog row they guard (docs/feedback.md): the reading rule, a chart that is what it says, a control
//                      that changes something; a drawing past its canvas, parts that come apart in a move, a morphed shape that is moved. Their page-side twins run in every demo scene (server/src/tools/demo-check.ts):
//                      fb-004 the tour's bar (a tour demo plays with it up, and nothing meets it), fb-023 what the scene wrote is on the stage, fb-030 no line let go, fb-037 a label on the side it was written, fb-005 the
//                      crosshair's tag
//   hard               language/demos/hard.series: the failures real sessions turned up, one scene each (a 400-character line, CJK, a flowchart, words beside strokes, digits lined up, crowded labels,
//                      many lines, a dark ground, a photo with callouts); judged like a demo, each scene with its own question
//   stream             a turn at 80 characters a second has its first element on stage long before its last line is sent; a recorded stream-json turn comes out line by line
//   flows, photo       `pnpm flows` and `pnpm photo-check` (no model), run as groups
//
// Every scene of every demo (split at its `scene` lines, each sought to its rest) is judged, not only the last. Beyond smoke's checks each gets the pixel judges of real-check.ts: ink in the box (a share of
// it), the stage is what is at its centre and corners (not an overlay), and, for scenes with words on drawings, each line of words hidden in turn (footprints). Every scene is judged at rest by smoke's checks: answer on stage, no overlap, nothing cut off, readable chrome and prompt, no console errors,
// no failed requests. The renderer the page got is printed; a fall back to the plain renderer fails the check unless --allow-plain.
// It prints a table, saves a screenshot per scene in --out, and exits 1 on any failure. Nothing here is part of the server.

import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cutScenes, declaredAtRest, DEMOS, DEMOS_NOT_PAINTED, LineReader, playSource, TOUR_CHAPTERS, digestFull } from '@conduit/language';
import type { Attention, Declared, Observation } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { CHROME_CANDIDATES, repoRoot, sleep, stop, waitFor } from './explore-browser';
import { claimPort, releasePort } from './check-ports';
import { filmGroup } from './film-check';
import { Conversation, Tab } from './smoke';
import { LENS_SCREENS, lensGroup } from './lens-check';
import { ASK_SCREEN, askGroup } from './ask-check';
import { DRAW_SCREEN, drawGroup } from './draw-check';
import { ART_FAKE_MS, ART_SCREEN, artGroup } from './art-check';
import { CONTINUE_SCREEN, continueFixtures, continueGroup } from './continue-check';
import { journeyGroup } from './journey-check';
import { labelGroup } from './label-check';
import { undoGroup } from './undo-check';
import { MEMORY_SCREEN, memoryGroup } from './memory-check';
import { chartBars, checkAxisTags, checkDeclared, checkLabels, checkNoEarlierChip, checkTourBar, scriptGroup } from './demo-check';
import type { LabelWant } from './demo-check';
import { fb062Group, loopGroup } from './loop-check';
import { TOUR_SCREENS, tourGroup } from './tour-check';
import { printWebkit, webkitGroup, webkitMissing } from './webkit-check';
import { driftGroup } from './drift-check';
import { mathsGroup } from './math-check';
import { checkGlyphs, checkInk, checkListings, checkSlideWords, checkTakeover, flowsGroup, footprintJudge, photoGroup, sceneFactsOf, streamBrainCheck, streamFixtureCheck, testPattern } from './real-check';
import type { Footprint } from './real-check';
import type { Answer, CheckResult, Options, Probe, Step, Verdict } from './smoke';

// ---------------------------------------------------------------------------------------------------------------------------------
// Arguments

interface Args {
  readonly url: string | null;
  readonly out: string;
  readonly screens: readonly { readonly name: string; readonly width: number; readonly height: number }[];
  readonly timeoutMs: number;
  readonly allowPlain: boolean;
  readonly sequential: boolean;
  readonly quiet: boolean;
  /** the groups to run (names or the starts of names); null: all */
  readonly only: readonly string[] | null;
  readonly jobs: number;
  readonly list: boolean;
  readonly webkit: boolean;
}

function usage(message: string): never {
  process.stderr.write(`check: ${message}\nusage: pnpm check [--url http://127.0.0.1:<port>] [--out <dir>] [--screens 1280x720,390x844] [--timeout <seconds>] [--allow-plain] [--sequential] [--quiet] [--only <groups>] [--jobs <n>] [--list] [--webkit]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) usage(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (['allow-plain', 'sequential', 'quiet', 'list', 'webkit'].includes(name)) flags.set(name, 'true');
    else {
      const value = argv[i + 1];
      if (!['url', 'out', 'screens', 'timeout', 'only', 'jobs'].includes(name)) usage(`unknown flag --${name}`);
      if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
      flags.set(name, value);
      i += 1;
    }
  }
  const screens = (flags.get('screens') ?? '1280x720,390x844').split(',').map((text) => {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(text.trim());
    if (match === null) usage(`bad screen ${text}: say 1280x720`);
    return { name: text.trim(), width: Number(match[1]), height: Number(match[2]) };
  });
  const url = flags.get('url');
  return {
    url: url === undefined ? null : url.replace(/\/+$/, ''),
    out: resolve(flags.get('out') ?? join(tmpdir(), 'conduit-check', new Date().toISOString().replace(/[:.]/g, '-'))),
    screens,
    // the longest demo (maths) plays for about 105 s at the pace of the stage: a demo is given 150 s to come to rest
    timeoutMs: Number(flags.get('timeout') ?? 150) * 1000,
    allowPlain: flags.has('allow-plain'),
    sequential: flags.has('sequential'),
    quiet: flags.has('quiet'),
    only: flags.has('only') ? (flags.get('only') as string).split(',').map((name) => name.trim()).filter((name) => name !== '') : null,
    jobs: flags.has('sequential') ? 1 : Math.max(1, Math.floor(Number(flags.get('jobs') ?? defaultJobs())) || defaultJobs()),
    list: flags.has('list'),
    webkit: flags.has('webkit'),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The server this check starts

interface Started {
  readonly url: string;
  stop(): Promise<void>;
}

/** The folder of session logs of each server this check started, by its address: what a check reads back to see what the brain was told. A server it was only given has none (unless CHECK_LOG_DIR names it). */
const LOG_DIRS = new Map<string, string>();

/** The server from the current build: BRAIN=replay, its own data folder and skills folder, a free port. Stopped by its handle. */
async function startServer(extra: Readonly<Record<string, string>> = {}): Promise<Started> {
  const root = repoRoot();
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('there is no build to check: run "pnpm build" first (or pass --url of a running server)');
  const scratch = await mkdtemp(join(tmpdir(), 'conduit-check-'));
  await mkdir(join(scratch, 'skills'), { recursive: true });
  const port = await claimPort('a server');
  let log = '';
  const child: ChildProcess = spawnTracked(process.execPath, ['--import', 'tsx', 'src/main.ts'], undefined, {
    cwd: join(root, 'server'),
    env: {
      NODE_ENV: 'production',
      BRAIN: 'replay',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: join(scratch, 'data'),
      SKILL_ROOTS: join(scratch, 'skills'),
      LIBRARY: 'seed',
      READ_LINKS: 'off',
      LOG_LEVEL: 'warn',
      // a faster pen than a model's, so a demo's text arrives quickly; the page's own timing is unchanged
      REPLAY_CPS: '3000',
      ...extra,
    },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => (log = (log + chunk.toString()).slice(-4000)));
  const url = `http://127.0.0.1:${port}`;
  LOG_DIRS.set(url, join(scratch, 'data', 'logs'));
  const stopAll = async (): Promise<void> => {
    LOG_DIRS.delete(url);
    await stop(child);
    releasePort(port);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitFor('the server', 60_000, async () => {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}:\n${log}`);
      return (await fetch(`${url}/api/health`)).ok ? true : null;
    });
  } catch (error) {
    await stopAll();
    throw new Error(`the server did not start: ${error instanceof Error ? error.message : String(error)}\n${log}`);
  }
  return { url, stop: stopAll };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the welcome must hold, read from its own script

interface Welcome {
  readonly intro: readonly string[];
  readonly starters: readonly string[];
}

/** The words of the last scene of overture.series: the lines said, and which of them are starters (`choice`). */
function readWelcome(): Welcome {
  const source = readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/overture.series')), 'utf8');
  const scenes = source.split(/^scene\b/m);
  const last = scenes[scenes.length - 1] ?? '';
  const intro: string[] = [];
  const starters: string[] = [];
  for (const raw of last.split('\n')) {
    const match = /^say\b([^|]*)\|\s*(.+?)\s*$/.exec(raw);
    if (match === null) continue;
    (/\bchoice\b/.test(match[1] ?? '') ? starters : intro).push(match[2] as string);
  }
  if (starters.length === 0 || intro.length === 0) throw new Error('could not read the welcome from overture.series: the check needs its intro line and starters');
  return { intro, starters };
}

/** how many starters the welcome offers (the README and the script's own comment say seven) */
const STARTERS = 7;

/** the lines of a script text that the language rejects, by line number */
function rejectedLinesOf(source: string): string[] {
  const reader = new LineReader();
  const bad: string[] = [];
  source.split('\n').forEach((raw, index) => {
    const result = reader.read(raw);
    if (result.kind === 'reject') bad.push(`line ${index + 1} "${raw.slice(0, 50)}": ${result.issues.map((issue) => issue.message).join('; ')}`);
  });
  return bad;
}

/** the lines of a demo script that the language rejects, by line number: the page skips such a line without a word, so the script itself is read the way `pnpm timeline` reads it */
function rejectedLines(name: string): string[] {
  const source = readFileSync(fileURLToPath(import.meta.resolve(`@conduit/language/demos/${name}.series`)), 'utf8');
  const reader = new LineReader();
  const bad: string[] = [];
  source.split('\n').forEach((raw, index) => {
    const result = reader.read(raw);
    if (result.kind === 'reject') bad.push(`line ${index + 1} "${raw.slice(0, 50)}": ${result.issues.map((issue) => issue.message).join('; ')}`);
  });
  return bad;
}

/** the demos whose scenes put words on drawings (or lay many lines out): each line of words in them is hidden in turn and judged by what it paints (real-check.ts) */
const FOOTPRINT_DEMOS = ['sketchbook', 'diagrams', 'art', 'iterate', 'scripts', 'overture', 'titles', 'plainly', 'toolkit', 'explorable', 'richness', 'charts', 'styles', 'controls', 'code', 'deck'];

/** the demos whose scenes are also asked what the script wrote in them: the code blocks (each row, as written and really drawn), the lines said, the tables (real-check.ts `sceneFactsOf`) */
const FACT_DEMOS = ['code', 'deck'];

/** the position of a hard-cases scene in its file, by its id */
function hardOrder(id: string): number {
  const source = readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/hard.series')), 'utf8');
  return source.split('\n').flatMap((raw) => /^scene\s+(\S+)/.exec(raw)?.[1] ?? []).indexOf(id) + 1;
}

/** the land and the sea of the fb-026 map fixtures (hard.series): literal colours, so that a screenshot can say what was drawn where */
const LAND_RGB: readonly number[] = [0xe8, 0xb8, 0x4a];
const SEA_RGB: readonly number[] = [0x1b, 0x4f, 0x9c];

/** the spots of the photo scene, as a percent of the photo's width and height (the same as `pnpm photo-check` uses) */
const PHOTO_SPOTS: readonly (readonly [string, number, number])[] = [['c1', 8, 10], ['c2', 92, 12], ['c3', 50, 50], ['c4', 20, 78], ['c5', 81, 90], ['c6', 50, 8], ['c7', 3, 50], ['c8', 97, 55]];

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** the two problem scenes this check plays (the others test the same thing): an ordinary sum (p3), and p11, whose own words hold its answer */
const PROBLEMS_PLAYED = ['p3', 'p11'];

/** the scenes of language/demos/problem.series that are played: each is one script to play, with the question and the answer it says */
function problemScenes(): { readonly id: string; readonly script: string; readonly question: string; readonly answer: string }[] {
  const source = readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/problem.series')), 'utf8');
  return source
    .split(/^scene\b/m)
    .slice(1)
    .flatMap((part) => {
      const found = /^problem\s+(\S+)\s+(?:[^|\n]*?)answer=(\S+)[^|\n]*\|\s*(.+?)\s*$/m.exec(part);
      if (found === null || !PROBLEMS_PLAYED.includes(found[1] as string)) return [];
      return [{ id: found[1] as string, script: `scene${part}`, question: found[3] as string, answer: (found[2] as string).split(',')[0]?.replaceAll('_', ' ') as string }];
    });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One screen

/** What the page's host says of a running app (`AppProbe`, the part a check reads). */
interface AppFacts {
  readonly id: string;
  readonly running: boolean;
  readonly loaded: boolean;
  readonly shown: boolean;
  readonly crashes: number;
  readonly blank: boolean | null;
}

export interface Scene {
  readonly name: string;
  readonly seconds: number;
  readonly picture: string;
  readonly results: CheckResult[];
}

interface ScreenRun {
  readonly screen: Args['screens'][number];
  readonly scenes: Scene[];
  readonly renderer: string;
  readonly gpu: string;
  readonly seconds: number;
  readonly aborted: string | null;
}

/** the first-load demo's snapshot upload, addressed to its local turn id */
const KNOWN_FAILURE = /\/turns\/local-first-load\/snapshot answered 404/;

const ANY: Step = { n: 1, say: null, name: 'check', expects: 'any' };

interface Stage {
  readonly id: string;
  readonly kind: string;
  readonly text?: string;
  readonly phase: string;
  readonly opacity: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** what a scene's judgement can be asked besides the painter's own account: see `Screen.judge` */
interface JudgeOptions {
  readonly earlier?: boolean;
  readonly footprints?: boolean;
  readonly photo?: boolean;
  /** the things the scene's lines wrote that must be on the stage at its rest (fb-023); also asks that no line was let go (fb-030) */
  readonly declared?: readonly Declared[];
  /** a tour demo: the tour's bar must be up and nothing meet it (fb-004); false: it must not be there */
  readonly tourBar?: boolean;
  /** the labels written `near=<id>:<side>` (fb-037) */
  readonly labels?: readonly LabelWant[];
  /** hover every chart on stage: the crosshair's tag on the bottom axis is a written label or a year in the data (fb-005) */
  readonly axisTags?: boolean;
}

/** the demos the tour offers a card for: they are played the way the tour plays them, with its bar */
const TOUR_DEMOS: ReadonlySet<string> = new Set(TOUR_CHAPTERS.flatMap((chapter) => chapter.cards.flatMap((card) => (card.kind === 'demo' ? [card.name] : []))));

class Screen {
  readonly scenes: Scene[] = [];
  renderer = 'unknown';
  gpu = '';

  constructor(
    private readonly args: Args,
    public base: string,
    private readonly screen: Args['screens'][number],
    private readonly dir: string,
    private readonly welcome: Welcome,
  ) {}

  private note(text: string): void {
    if (!this.args.quiet) process.stdout.write(`[${this.screen.name}] ${text}\n`);
  }

  /** A tab on the page, ready. A page that never comes ready (a Chrome that stalled on start-up) is given up on after a minute and opened once more in a new tab. */
  private async open(page: string, demo: boolean, restMs = 0): Promise<{ tab: Tab; talk: Conversation }> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let opened: Tab | null = null;
      for (let tries = 0; tries < 3 && opened === null; tries += 1) opened = await Tab.open(this.screen.width, this.screen.height).catch(() => null);
      if (opened === null) throw new Error('Chrome would not start (three tries)');
      const options: Options = { url: this.base, screens: [this.screen], out: this.args.out, turns: new Set(), timeoutMs: Math.max(this.args.timeoutMs, restMs), parallel: false, demo, quiet: true, page, say: null, chat: 'off' };
      const talk = new Conversation(opened, options, this.screen, this.dir);
      try {
        await opened.send('DOM.enable');
        await talk.start();
        return { tab: opened, talk };
      } catch (error) {
        last = error;
        this.note(`the page did not come ready (${error instanceof Error ? error.message : String(error)}); opening it again`);
        await opened.close().catch(() => undefined);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private async look(tab: Tab): Promise<void> {
    const state = await tab.eval<{ renderer: string }>('window.__stage.state()');
    if (this.renderer === 'unknown') {
      this.renderer = String(state.renderer);
      this.gpu = await tab.eval<string>(`(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); if (!g) return 'no WebGL context'; const e = g.getExtension('WEBGL_debug_renderer_info'); return String(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)); })()`).catch(() => '');
    }
  }

  /** the footprints of the last scene judged with them (what hiding each line of words showed), for a scene's own questions */
  feet = new Map<string, Footprint>();

  /**
   * the judgement every scene gets, at rest: smoke's own checks, then the pixels. `report`: the scene's turn ended and is on stage (a demo or an answer; the local welcome has no report).
   * `earlier`: a scene before the last of a turn, seen by seeking the clock there: what the turn's report says is about the last scene, so only what the screen shows is judged.
   * `footprints`: also hide each line of words in turn and judge what it really paints (real-check.ts).
   */
  private async judge(tab: Tab, talk: Conversation, name: string, results: CheckResult[], began: number, report: boolean, prompt: boolean, options: JudgeOptions = {}): Promise<Scene> {
    talk.current = this.scenes.length + 1;
    const picture = await tab.shot();
    const file = `${this.screen.name}-${name.replace(/[^\w-]+/g, '-')}.png`;
    await writeFile(join(this.dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
    const answer = await tab.call<Answer>('answer');
    const earlier = options.earlier === true;
    const said = earlier ? { ...answer, report: null } : answer;
    if (report && !earlier) await talk.checkAnswer(ANY, answer, picture, results);
    if (prompt && !earlier) await talk.checkPrompt(results);
    if (!earlier) await talk.checkChrome(picture, results);
    talk.checkOverlap(ANY, said, results);
    await talk.checkCutOff(said, results);
    const add = (check: string, verdict: Verdict, detail: string): void => talk.add(results, check, verdict, detail);
    await checkInk(tab, add, picture, answer.live, tab.dpr);
    await checkTakeover(tab, add);
    // what the scene's own lines wrote, and the chrome that stands over the stage (docs/demo-audit.md part 4; server/src/tools/demo-check.ts)
    if (options.tourBar !== undefined) {
      const found = await checkTourBar(tab, options.tourBar);
      add('fb-004-tour-bar', found.length === 0 ? 'PASS' : 'FAIL', found.length === 0 ? (options.tourBar ? 'the tour bar is up and nothing on the stage or over it meets it' : 'no tour bar here') : found.join('; '));
    }
    if (options.declared !== undefined) {
      const found = await checkDeclared(tab, options.declared);
      add('fb-023-declared-on-screen', found.length === 0 ? 'PASS' : 'FAIL', found.length === 0 ? `all ${options.declared.length} things the scene wrote are on the stage, seen` : found.join('; '));
      const chip = await checkNoEarlierChip(tab);
      add('fb-030-no-line-let-go', chip.length === 0 ? 'PASS' : 'FAIL', chip.length === 0 ? 'no line of the scene was let go' : chip.join('; '));
    }
    if (options.axisTags === true) {
      const found = await checkAxisTags(tab);
      add('fb-005-axis-tag', found.length === 0 ? 'PASS' : 'FAIL', found.length === 0 ? 'the crosshair\'s tag on the bottom axis is a written label or a year in the data, at three hover points' : found.join('; '));
    }
    if (options.labels !== undefined) {
      const found = await checkLabels(tab, options.labels);
      add('fb-037-label-on-its-part', found.length === 0 ? 'PASS' : 'FAIL', found.length === 0 ? `${options.labels.length} labels stand on the side of their part they were written on` : found.join('; '));
    }
    // a photo's callouts are looked at with a long reach (their leaders run to their spots) and their spots asked for
    const spots = new Map<string, { x: number; y: number }>();
    if (options.photo === true) {
      const box = answer.live.find((e) => e.id === 'p1')?.box;
      if (box !== undefined) for (const [id, x, y] of PHOTO_SPOTS) spots.set(id, { x: box.x + (x / 100) * box.width, y: box.y + (y / 100) * box.height });
    }
    this.feet = options.footprints === true ? await footprintJudge(tab, add, { scale: tab.dpr, spots }) : new Map();
    const drained = tab.drain();
    // KNOWN: the page uploads the stage's snapshot for the first-load demo under its local turn id, which the server does not know (404). Harmless, and said in the detail.
    const known = drained.failedRequests.filter((entry) => KNOWN_FAILURE.test(entry.text));
    const logged = { consoleErrors: drained.consoleErrors.filter((entry) => !(known.length > 0 && /404/.test(entry.text) && /Failed to load resource/.test(entry.text))), failedRequests: drained.failedRequests.filter((entry) => !KNOWN_FAILURE.test(entry.text)) };
    talk.add(results, 'no-console-errors', logged.consoleErrors.length === 0 ? 'PASS' : 'FAIL', logged.consoleErrors.length === 0 ? 'nothing logged as an error' : `${logged.consoleErrors.length}: ${[...new Set(logged.consoleErrors.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
    talk.add(results, 'no-failed-requests', logged.failedRequests.length === 0 ? 'PASS' : 'FAIL', logged.failedRequests.length === 0 ? `every request answered${known.length > 0 ? ' (the first-load snapshot upload answered 404: known, ignored)' : ''}` : `${logged.failedRequests.length}: ${[...new Set(logged.failedRequests.map((entry) => entry.text))].slice(0, 3).join(' | ')}`);
    const scene: Scene = { name, seconds: (Date.now() - began) / 1000, picture: file, results };
    this.scenes.push(scene);
    for (const result of results) if (result.verdict === 'FAIL') this.note(`  FAIL ${name} ${result.check}: ${result.detail.slice(0, 200)}`);
    return scene;
  }

  /** the times the scenes of the turn on stage open, on its clock (a `scene` line's start) */
  private async sceneStarts(tab: Tab): Promise<number[]> {
    return tab.eval<number[]>(`window.__stage.lines().filter((l) => /^scene\\b/.test(l.text)).map((l) => l.start)`);
  }

  /** each scene before the last, at rest: the clock is sought to the moment before the next scene opens, so what is on screen is the end of this one */
  private async earlierScenes(tab: Tab, talk: Conversation, base: string, starts: readonly number[], footprints: boolean, names?: readonly string[], then?: (index: number, scene: Scene) => Promise<void>, before?: (index: number) => Promise<void>, extra?: (index: number) => JudgeOptions): Promise<void> {
    for (let index = 0; index + 1 < starts.length; index += 1) {
      const at = Date.now();
      const name = `${base}#${names?.[index] ?? index + 1}`;
      this.note(name);
      await tab.eval(`window.__stage.seek(${Math.max(0, (starts[index + 1] as number) - 0.02)})`);
      await sleep(250);
      // a scene's apps are made afresh by the seek: they are let to load, and to be looked at, before the scene is judged
      if (before !== undefined) await before(index);
      const results: CheckResult[] = [];
      const scene = await this.judge(tab, talk, name, results, at, false, false, { earlier: true, footprints, photo: names?.[index] === 'photo', ...extra?.(index) });
      if (then !== undefined) await then(index, scene);
    }
  }

  private static add(results: CheckResult[], check: string, problems: readonly string[], good: string): void {
    results.push({ turn: 0, check, verdict: problems.length === 0 ? 'PASS' : 'FAIL', detail: problems.length === 0 ? good : problems.join('; ') });
  }

  private static restResult(note: string, began: number): CheckResult {
    return { turn: 0, check: 'rest', verdict: note === '' ? 'PASS' : 'FAIL', detail: note === '' ? `at rest ${((Date.now() - began) / 1000).toFixed(0)} s after the start` : note };
  }

  /** the intro line and every starter, found by the script's own words, on stage and on screen */
  private async welcomeWords(tab: Tab, results: CheckResult[]): Promise<void> {
    const live = await tab.eval<Stage[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, box: e.box }))');
    const shown = live.filter((element) => element.kind === 'text' && element.phase === 'on' && element.opacity > 0.3);
    const view = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    const problems: string[] = [];
    if (this.welcome.starters.length !== STARTERS) problems.push(`the welcome promises ${STARTERS} starters but overture.series holds ${this.welcome.starters.length}`);
    for (const [kind, words] of [['intro line', this.welcome.intro], ['starter', this.welcome.starters]] as const) {
      for (const want of words) {
        const found = shown.find((element) => norm(element.text ?? '') === norm(want));
        if (found === undefined) problems.push(`${kind} missing: "${want}"`);
        else if (found.box.x < -2 || found.box.y < -2 || found.box.x + found.box.width > view.w + 2 || found.box.y + found.box.height > view.h + 2) problems.push(`${kind} off screen: "${want}"`);
      }
    }
    Screen.add(results, 'welcome-words', problems, `the intro line and all ${STARTERS} starters are on screen`);
  }

  async welcomeScene(reduced: boolean): Promise<void> {
    const name = reduced ? 'welcome-reduced-motion' : 'welcome';
    const began = Date.now();
    this.note(name);
    const { tab, talk } = await this.open(reduced ? 'motion=reduced' : '', true);
    try {
      await this.look(tab);
      const results: CheckResult[] = [Screen.restResult(await talk.rest(null, false), began)];
      await this.welcomeWords(tab, results);
      await this.judge(tab, talk, name, results, began, false, !reduced);
      if (reduced) return;
      await this.choiceScene(tab, talk);
    } finally {
      await tab.close();
    }
  }

  /** a real tap on a starter: the page sends it as a turn, and the replay brain's answer comes to rest */
  private async choiceScene(tab: Tab, talk: Conversation): Promise<void> {
    const want = this.welcome.starters[1] ?? (this.welcome.starters[0] as string);
    const began = Date.now();
    this.note(`choice: "${want}"`);
    const results: CheckResult[] = [];
    const live = await tab.eval<Stage[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, box: e.box }))');
    const target = live.find((element) => element.kind === 'text' && element.phase === 'on' && norm(element.text ?? '') === norm(want));
    if (target === undefined) {
      results.push({ turn: 0, check: 'choice-sent', verdict: 'FAIL', detail: `no starter "${want}" on stage to tap` });
      await this.judge(tab, talk, 'choice', results, began, false, false);
      return;
    }
    const before = tab.posted.length;
    talk.seenReports = new Set((await tab.call<Probe>('probe')).reports);
    await tab.tap(target.box.x + target.box.width / 2, target.box.y + target.box.height / 2);
    let sent: (typeof tab.posted)[number] | undefined;
    for (let waited = 0; waited < 8000 && sent === undefined; waited += 200) {
      sent = tab.posted.slice(before)[0];
      if (sent === undefined) await sleep(200);
    }
    Screen.add(results, 'choice-sent', sent === undefined ? ['a real tap on the starter sent no turn'] : sent.text !== null && norm(sent.text) !== norm(want) ? [`the tap sent "${sent.text}", not the starter's words`] : [], `the tap sent a ${sent?.kind ?? 'turn'} turn`);
    results.push(Screen.restResult(sent === undefined ? 'the turn never started' : await talk.rest(true), began));
    await this.judge(tab, talk, 'choice', results, began, true, false);
  }

  /** every demo the app offers, played by name through the app's own hook, one after another on one page */
  async demoScenes(names: readonly string[], first: boolean): Promise<void> {
    const { tab, talk } = await this.open('', false);
    try {
      await this.look(tab);
      for (const demo of DEMOS.filter((candidate) => names.includes(candidate.name))) {
        const began = Date.now();
        this.note(`demo ${demo.name}`);
        talk.seenReports = new Set((await tab.call<Probe>('probe')).reports);
        tab.drain();
        const results: CheckResult[] = [];
        const tour = TOUR_DEMOS.has(demo.name);
        const started = await tab.eval<string | null>(`Promise.resolve(window.__stage.${tour ? 'tourDemo' : 'demo'}(${JSON.stringify(demo.name)})).then(() => null, (e) => String(e && e.message || e))`);
        const bad = rejectedLines(demo.name);
        Screen.add(results, 'script-lines', bad.slice(0, 3), 'every line of the script reads');
        results.push(Screen.restResult(started !== null ? `the demo would not start: ${started}` : await talk.rest(true), began));
        if (demo.name === 'explorable') await this.explorable(tab, talk, results);
        if (demo.name === 'richness') await this.richness(tab, results);
        if (demo.name === 'art') await this.art(tab, results);
        if (demo.name === 'scripts') await this.scripts(tab, results);
        const starts = await this.sceneStarts(tab);
        const base = `demo-${demo.name}`;
        const footprints = FOOTPRINT_DEMOS.includes(demo.name);
        // what each scene's lines wrote, from the language's own reading of the script; skipped when the page and the schedule do not agree on how many scenes there are
        const cuts = cutScenes(playSource(readFileSync(fileURLToPath(import.meta.resolve(`@conduit/language/demos/${demo.name}.series`)), 'utf8')));
        const agree = cuts.length === starts.length && !DEMOS_NOT_PAINTED.includes(demo.name);
        const sceneOptions = (index: number): JudgeOptions => {
          const cut = cuts[index];
          const charts = demo.name === 'charts' ? { axisTags: true } : {};
          if (!agree || cut === undefined) return { ...charts, ...(tour ? { tourBar: true } : {}) };
          const labels = cut.elements.flatMap((element): LabelWant[] => (element.kind === 'text' && element.style.near !== null && !element.style.leader && element.style.near.part === undefined && element.exit === null ? [{ text: element.text, target: element.style.near.id, side: element.style.near.side as LabelWant['side'] }] : []));
          return { declared: declaredAtRest(cut), labels: labels.filter((label) => ['above', 'below', 'left', 'right'].includes(label.side)), ...charts, ...(tour ? { tourBar: true } : {}) };
        };
        const facts = FACT_DEMOS.includes(demo.name) ? sceneFactsOf(readFileSync(fileURLToPath(import.meta.resolve(`@conduit/language/demos/${demo.name}.series`)), 'utf8')) : null;
        const last = await this.judge(tab, talk, starts.length > 1 ? `${base}#${starts.length}` : base, results, began, true, first, { footprints, ...sceneOptions(starts.length - 1) });
        if (facts !== null) await this.sceneFacts(tab, talk, facts, starts.length, starts.length - 1, last.results);
        if (demo.name === 'scripts') await this.scriptGlyphs(tab, talk, results);
        if (starts.length > 1) await this.earlierScenes(tab, talk, base, starts, footprints, undefined, facts === null ? undefined : (index, scene) => this.sceneFacts(tab, talk, facts, starts.length, index, scene.results), undefined, sceneOptions);
        first = false;
      }
    } finally {
      await tab.close();
    }
  }

  /**
   * What a scene's script wrote in it, found on stage at its rest: the lines it says and the tables it makes, and each code block (on stage in a box of a real size, every row
   * as written and really drawn: real-check.ts). The painter's own account of a block it cannot draw is a structure with no box; a judge that only asks the boxes it is given
   * never meets it, so the script is asked what should be there.
   */
  private async sceneFacts(tab: Tab, talk: Conversation, facts: ReturnType<typeof sceneFactsOf>, scenes: number, index: number, results: CheckResult[]): Promise<void> {
    const before = results.length;
    const add = (check: string, verdict: Verdict, detail: string): void => talk.add(results, check, verdict, detail);
    if (facts.length !== scenes) add('scenes', 'FAIL', `the script has ${facts.length} scenes but the turn has ${scenes}`);
    const here = facts[index];
    if (here !== undefined) {
      await checkSlideWords(tab, add, here);
      await checkListings(tab, add, here.listings, tab.dpr);
    }
    for (const result of results.slice(before)) if (result.verdict === 'FAIL') this.note(`  FAIL scene ${index + 1} ${result.check}: ${result.detail.slice(0, 200)}`);
  }

  /**
   * language/demos/hard.series: the failures real sessions and reviews turned up, each as a scene, written again in our own words. Played like a demo (one turn, every scene),
   * every scene judged at rest with the footprints, and each scene asked what its bug would break: the end of a long line, the CJK glyphs, a flowchart's parts, digits that line up
   * on their right edge, words clear of strokes, every line of many kept, and a photo's callouts on their spots (a generated test pattern is put up as the photo first).
   */
  async hardScenes(): Promise<void> {
    const source = readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/hard.series')), 'utf8');
    const ids = source.split('\n').flatMap((raw) => {
      const found = /^scene\s+(\S+)/.exec(raw);
      return found?.[1] === undefined ? [] : [found[1]];
    });
    // one long turn: the script plays for a minute and a half on a machine at its ease, and the rest is waited for as long as that takes
    const { tab, talk } = await this.open('', false, 180_000);
    try {
      await this.look(tab);
      const began = Date.now();
      this.note('demo hard');
      tab.drain();
      // the photo of the last scene: a test pattern, kept by the server for this page's session as u1
      const session = await tab.eval<string | null>(`(() => { for (const r of performance.getEntriesByType('resource')) { const m = /\\/api\\/sessions\\/([^/]+)\\//.exec(r.name); if (m) return m[1]; } return null; })()`);
      let photo = 'no session to put the photo in';
      if (session !== null) {
        const sent = await fetch(`${this.base}/api/sessions/${session}/uploads`, { method: 'POST', body: new Uint8Array(testPattern(900, 600)), headers: { 'content-type': 'image/png' } }).catch(() => null);
        photo = sent !== null && sent.status === 201 ? '' : `the server kept no photo (${sent === null ? 'no answer' : sent.status})`;
      }
      const results: CheckResult[] = [];
      Screen.add(results, 'script-lines', rejectedLinesOf(source).slice(0, 3), 'every line of the script reads');
      const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(source)})).then(() => null, (e) => String(e && e.message || e))`);
      // the script is one long turn that plays in real time (a minute and a half of the clock now, and a busy machine plays it slower): it is given as long as four demos
      results.push(Screen.restResult(played !== null ? `the demo would not start: ${played}` : await talk.rest(true, true, Math.max(Math.round(this.args.timeoutMs * 1.5), 240_000)), began));
      const starts = await this.sceneStarts(tab);
      if (starts.length !== ids.length) results.push({ turn: 0, check: 'scenes', verdict: 'FAIL', detail: `the script has ${ids.length} scenes but the turn has ${starts.length}` });
      const last = ids.length - 1;
      await this.judge(tab, talk, `demo-hard#${ids[last]}`, results, began, true, false, { footprints: true, photo: ids[last] === 'photo' });
      await this.hardAsserts(ids[last] as string, tab, talk, results, photo);
      await this.earlierScenes(tab, talk, 'demo-hard', starts, true, ids, async (index, scene) => this.hardAsserts(ids[index] as string, tab, talk, scene.results, photo), async (index) => {
        if (/^fb-02[56]/.test(ids[index] as string)) await this.appsLooked(tab);
      });
      await this.briefHolds(tab, talk, session, results);
    } finally {
      await tab.close();
    }
  }

  /** what each scene of hard.series says its own bug would break */
  private async hardAsserts(id: string, tab: Tab, talk: Conversation, results: CheckResult[], photo: string): Promise<void> {
    const add = (check: string, verdict: Verdict, detail: string): void => talk.add(results, check, verdict, detail);
    const live = await tab.eval<{ id: string; kind: string; text: string; phase: string; opacity: number; fontPx: number; contrast: number; box: { x: number; y: number; width: number; height: number } }[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, fontPx: e.fontPx, contrast: e.contrast, box: e.box }))');
    const texts = live.filter((e) => e.kind === 'text' && e.phase === 'on' && e.opacity > 0.3);
    const said = (words: string): boolean => texts.some((e) => norm(e.text) === norm(words));
    const problems: string[] = [];
    let good = '';
    switch (id) {
      case 'long': {
        // the painter may set one say as several lines of words; together they hold every word, the last included
        const said = texts.map((e) => e.text).join(' ');
        const closing = texts.find((e) => /\bzebra\.?$/.test(e.text.trim()));
        if (said.length < 380) problems.push(`only ${said.length} of the about 400 characters of the long line are on stage`);
        if (closing === undefined) problems.push(`the long line's last word is not on stage: the longest line ends "...${(texts.find((e) => e.text.length > 100)?.text ?? '').slice(-30)}"`);
        else if (this.feet.get(closing.id)?.drawn === null) problems.push('the last words of the long line are on stage but not drawn');
        good = `the long line is whole on stage (${said.length} characters, ending on its last word, drawn)`;
        break;
      }
      case 'scripts': {
        const here: CheckResult[] = [];
        await this.scriptGlyphs(tab, talk, here, 'hard');
        for (const result of here) add(result.check, result.verdict, result.detail);
        return;
      }
      case 'flow': {
        const nodes = live.filter((e) => e.kind === 'node' && e.phase === 'on').length;
        const links = live.filter((e) => e.kind === 'link' && e.phase === 'on').length;
        if (nodes !== 14) problems.push(`the flowchart has ${nodes} of its 14 nodes on stage`);
        if (links < 14) problems.push(`the flowchart has ${links} of its 14 connectors on stage`);
        good = `the flowchart's 14 nodes and ${links} connectors are on stage`;
        break;
      }
      case 'beside': {
        for (const words of ['the old road', 'the river bend', 'the fence line', 'the well', 'The narration must stand clear of every line drawn here.']) if (!said(words)) problems.push(`"${words.slice(0, 30)}" is not on stage`);
        good = 'the four labels and the narration are on stage, each clear of the strokes (the footprints say so)';
        break;
      }
      case 'digits': {
        const rights = ['h', 'd1', 'd2', 'd3', 'd4', 'd5'].flatMap((name) => {
          const drawn = this.feet.get(name)?.drawn;
          return drawn === null || drawn === undefined ? [] : [{ name, right: drawn.x + drawn.w }];
        });
        if (rights.length < 6) problems.push(`only ${rights.length} of the 6 right-aligned lines are drawn`);
        else {
          const spread = Math.max(...rights.map((r) => r.right)) - Math.min(...rights.map((r) => r.right));
          // a digit's own side bearing is a pixel or two; a line that is left-aligned or centred is many pixels off
          if (spread > 4) problems.push(`the right edges of the digits are ${spread.toFixed(1)} px apart: ${rights.map((r) => `${r.name} ${r.right.toFixed(0)}`).join(', ')}`);
          good = `six right-aligned lines end within ${spread.toFixed(1)} px of one edge`;
        }
        break;
      }
      case 'crowd': {
        for (const words of ['eye', 'mouth', 'ear']) if (!said(words)) problems.push(`the label "${words}" is not on stage`);
        good = 'three labels round one part, none on another or on a stroke (the footprints say so)';
        break;
      }
      case 'many': {
        const lines = texts.filter((e) => /line of eight\.$/.test(e.text)).length;
        if (lines !== 8) problems.push(`${lines} of the 8 lines are on stage`);
        good = 'all 8 lines are on stage';
        break;
      }
      case 'dark': {
        const faint = texts.filter((e) => e.contrast < 3 || e.fontPx < 9);
        if (faint.length > 0) problems.push(`hard to read on the dark ground: ${faint.slice(0, 3).map((e) => `"${e.text.slice(0, 20)}" ${e.contrast.toFixed(1)}:1 at ${e.fontPx.toFixed(0)} px`).join(', ')}`);
        good = `${texts.length} notes read on the dark ground (contrast 3:1 or more)`;
        break;
      }
      case 'fb-051': {
        // fb-051: a slider bound to a move to a point moved nothing (the painter never read where a bound move went). A real drag along the track, at both ends and the middle:
        // every shape the slider names must have moved, be half way at half way, and come back; the toggle whose only bind changes nothing is told, the slider is not.
        const ids = ['fbdot', 'fbring', 'fbbar', 'fbleaf', 'fbpair'];
        interface Held { readonly id: string; readonly min: number; readonly max: number; readonly value: number; readonly parts: readonly { part: string; box: { x: number; y: number; width: number; height: number } }[]; readonly box: { x: number; y: number; width: number; height: number } }
        const held = async (): Promise<Held | undefined> => (await tab.eval<Held[]>('window.__stage.controls().map((c) => ({ id: c.id, min: c.min, max: c.max, value: c.value, parts: c.parts, box: c.box }))')).find((c) => c.id === 'fbspin');
        const centres = async (): Promise<Map<string, { x: number; y: number }>> => {
          const out = new Map<string, { x: number; y: number }>();
          for (const e of await tab.eval<{ id: string; box: { x: number; y: number; width: number; height: number } }[]>('window.__stage.elements().map((e) => ({ id: e.id, box: e.box }))')) out.set(e.id, { x: e.box.x + e.box.width / 2, y: e.box.y + e.box.height / 2 });
          return out;
        };
        const slider = await held();
        if (slider === undefined) {
          problems.push('the slider fbspin is not on stage');
          break;
        }
        const track = slider.parts.find((p) => p.part === 'track')?.box ?? slider.box;
        const y = track.y + track.height / 2;
        const at = (share: number): { x: number; y: number } => ({ x: track.x + 2 + (track.width - 4) * share, y });
        const sent = tab.posted.length;
        const start = await centres();
        await tab.drag(at(0), at(1));
        const end = await centres();
        const full = (await held())?.value;
        await tab.drag(at(1), at(0.5));
        const middle = await centres();
        const half = (await held())?.value;
        await tab.drag(at(0.5), at(0));
        const home = await centres();
        if (full !== slider.max) problems.push(`a drag to the end of the track left the slider at ${String(full)}, not ${slider.max}`);
        if (typeof half !== 'number' || Math.abs(half - (slider.min + slider.max) / 2) > 0.1 * (slider.max - slider.min)) problems.push(`a drag to the middle of the track left the slider at ${String(half)}`);
        for (const id of ids) {
          const a = start.get(id);
          const b = end.get(id);
          const m = middle.get(id);
          const h = home.get(id);
          if (a === undefined || b === undefined || m === undefined || h === undefined) {
            problems.push(`${id} is not on stage`);
            continue;
          }
          const run = Math.hypot(b.x - a.x, b.y - a.y);
          if (run < 8) {
            problems.push(`dragging the slider to its end moved ${id} by ${run.toFixed(1)} px: a bound move to a point must carry it there`);
            continue;
          }
          // linear: half way across the slider is half way along the move, never eased
          const off = Math.hypot(m.x - (a.x + b.x) / 2, m.y - (a.y + b.y) / 2);
          if (off > Math.max(6, 0.12 * run)) problems.push(`${id} stood ${off.toFixed(1)} px from the middle of its ${run.toFixed(0)} px move with the slider half way`);
          if (Math.hypot(h.x - a.x, h.y - a.y) > 3) problems.push(`${id} did not come back when the slider did (${Math.hypot(h.x - a.x, h.y - a.y).toFixed(1)} px off)`);
        }
        if (tab.posted.length !== sent) problems.push(`dragging the slider sent ${tab.posted.length - sent} turn(s): a bound change needs no round trip`);
        // the toggle's only bind sets what is already set: dead. The slider's four work: it is not.
        const dead = (await tab.eval<{ token: string | null }[]>(`window.__stage.lines().flatMap((l) => l.issues.filter((i) => i.code === 'dead-bind').map((i) => ({ token: i.token || null })))`)).map((i) => i.token);
        if (!dead.includes('fbmark')) problems.push(`no dead-bind warning for the toggle fbmark, whose only bind sets what is already set (${dead.length === 0 ? 'no dead-bind at all' : `told of ${dead.join(', ')}`})`);
        if (dead.includes('fbspin')) problems.push('the slider fbspin, whose binds all move something, was called dead');
        good = `a real drag moved ${ids.length} bound things (${ids.join(', ')}) to their targets, each half way at half way and back at the start; the control whose only bind does nothing was told`;
        break;
      }
      case 'fb-071': {
        // fb-071: a chart whose cells follow a slider rescaled its axis as the slider moved, so a bar barely seemed to grow as the value rose (the thinking distance, 3 m to 30 m, even
        // shrank). A real drag along the track from one end to the other, the bars measured in pixels in a picture of the page at five places: the axis labels do not change, and every
        // bar rises, never shrinks, and by enough to see; the bars share one scale (the total is the thinking and the braking together).
        interface Held { readonly id: string; readonly min: number; readonly max: number; readonly value: number; readonly parts: readonly { part: string; box: { x: number; y: number; width: number; height: number } }[]; readonly box: { x: number; y: number; width: number; height: number } }
        const held = async (): Promise<Held | undefined> => (await tab.eval<Held[]>('window.__stage.controls().map((c) => ({ id: c.id, min: c.min, max: c.max, value: c.value, parts: c.parts, box: c.box }))')).find((c) => c.id === 'fbspeed');
        const slider = await held();
        if (slider === undefined) {
          problems.push('the slider fbspeed is not on stage');
          break;
        }
        const track = slider.parts.find((p) => p.part === 'track')?.box ?? slider.box;
        const y = track.y + track.height / 2;
        const at = (share: number): { x: number; y: number } => ({ x: track.x + 2 + (track.width - 4) * share, y });
        // the bars' colour is learnt with the speed at the top (a bar is then most of the chart), and the slider put back
        await tab.eval(`window.__stage.control('fbspeed', ${slider.max})`);
        await sleep(900);
        const learnt = await chartBars(tab, 'fbstop', null);
        if (typeof learnt === 'string') {
          problems.push(learnt);
          break;
        }
        await tab.eval(`window.__stage.control('fbspeed', ${slider.min})`);
        await sleep(900);
        const shares = [0, 0.25, 0.5, 0.75, 1];
        const seen: { value: number | undefined; bars: Awaited<ReturnType<typeof chartBars>>; ticks: string }[] = [];
        for (const [index, share] of shares.entries()) {
          if (index > 0) {
            await tab.drag(at(shares[index - 1] as number), at(share));
            await sleep(500);
          }
          const ticks = (await tab.eval<{ ticks: { y: string[] } }>(`window.__stage.chart('fbstop', { reset: true })`)).ticks.y.join(' ');
          seen.push({ value: (await held())?.value, bars: await chartBars(tab, 'fbstop', learnt.colour), ticks });
        }
        const words = seen.map((one) => `${String(one.value)}: ${typeof one.bars === 'string' ? one.bars : one.bars.heights.map((h) => `${h}`).join('/')} px`).join(', ');
        if (seen[0]?.value !== slider.min || (seen[seen.length - 1]?.value ?? 0) < slider.max - 1) problems.push(`the drag went from ${String(seen[0]?.value)} to ${String(seen[seen.length - 1]?.value)}, not from ${slider.min} to ${slider.max}`);
        if (new Set(seen.map((one) => one.ticks)).size > 1) problems.push(`the axis changed as the speed did: ${seen.map((one) => `${String(one.value)}: ${one.ticks}`).join(' | ')}`);
        const readings = seen.flatMap((one) => (typeof one.bars === 'string' ? [] : [one.bars]));
        if (readings.length !== seen.length || readings.some((one) => one.heights.length !== 3)) problems.push(`three bars were not read at each place: ${words}`);
        else {
          const height = (readings[0] as { box: { height: number } }).box.height;
          const least = Math.max(4, 0.015 * height);
          for (const [bar, name] of ['Thinking', 'Braking', 'Total'].entries()) {
            const run = readings.map((one) => one.heights[bar] as number);
            const shrank = run.findIndex((value, index) => index > 0 && value < (run[index - 1] as number) - 1);
            if (shrank > 0) problems.push(`the ${name} bar shrank as the speed rose: ${run.join(' > ')} px`);
            else if ((run[run.length - 1] as number) - (run[0] as number) < least) problems.push(`the ${name} bar grew from ${run[0]} to ${run[run.length - 1]} px, less than the ${least.toFixed(0)} px a person sees`);
          }
          const last = (readings[readings.length - 1] as { heights: readonly number[] }).heights;
          const share = (last[2] as number) / Math.max(1, last[1] as number);
          // 530 m total against 500 m braking at 100 km/h
          if (share < 0.95 || share > 1.17) problems.push(`the bars do not stand on one scale: the Total is ${share.toFixed(2)} of the Braking at the top, 1.06 by the sentence's numbers`);
        }
        good = `dragging the slider from ${slider.min} to ${slider.max}, the axis (${seen[0]?.ticks.split(' ').join(', ') ?? ''}) did not change and every bar rose (${words})`;
        break;
      }
      case 'orbit-lap': {
        // a bound ride along a closed outline: one whole range is one lap from where the Earth was drawn (3 o'clock), clockwise: 6 at a quarter, 9 at half, 12 at three quarters, 3 again at the end
        const centreOf = async (id: string): Promise<{ x: number; y: number } | null> =>
          tab.eval<{ x: number; y: number } | null>(`(() => { const e = window.__stage.elements().find((c) => c.id === ${JSON.stringify(id)}); return e ? { x: e.box.x + e.box.width / 2, y: e.box.y + e.box.height / 2 } : null; })()`);
        const controls = await tab.eval<{ id: string; min: number; max: number }[]>('window.__stage.controls().map((c) => ({ id: c.id, min: c.min, max: c.max }))');
        const slider = controls.find((c) => c.id === 'olmonth');
        if (slider === undefined) {
          problems.push('the slider olmonth is not on stage');
          break;
        }
        await tab.eval(`window.__stage.control('olmonth', ${slider.min})`);
        await sleep(600);
        const sun = await centreOf('olring');
        const home = await centreOf('olearth');
        if (sun === null || home === null) {
          problems.push('the ring or the Earth is not on stage');
          break;
        }
        const radius = Math.hypot(home.x - sun.x, home.y - sun.y);
        if (!(home.x > sun.x + radius * 0.9 && Math.abs(home.y - sun.y) < radius * 0.1)) problems.push(`the Earth is not drawn at 3 o'clock: it stands ${Math.round(home.x - sun.x)} right and ${Math.round(home.y - sun.y)} down of the ring's middle`);
        const names = ['3', '6', '9', '12', '3'];
        const where: string[] = [];
        for (const [index, share] of [0, 0.25, 0.5, 0.75, 1].entries()) {
          await tab.eval(`window.__stage.control('olmonth', ${slider.min + share * (slider.max - slider.min)})`);
          await sleep(600);
          const earth = await centreOf('olearth');
          if (earth === null) {
            problems.push('the Earth left the stage');
            break;
          }
          // on screen, y runs down, so a turn clockwise from 3 o'clock goes down first
          const want = { x: sun.x + radius * Math.cos(share * 2 * Math.PI), y: sun.y + radius * Math.sin(share * 2 * Math.PI) };
          const off = Math.hypot(earth.x - want.x, earth.y - want.y);
          where.push(`${names[index]} o'clock`);
          if (off > Math.max(4, radius * 0.08)) problems.push(`at ${Math.round(share * 100)}% of the range the Earth should be at ${names[index]} o'clock (${Math.round(want.x)},${Math.round(want.y)}); it is at ${Math.round(earth.x)},${Math.round(earth.y)}, ${Math.round(off)} px off`);
        }
        good = `the Earth drawn at 3 o'clock went round clockwise as the slider went from ${slider.min} to ${slider.max}: ${where.join(', ')}`;
        break;
      }
      case 'fb-054': {
        // fb-054: a choice revised by id came back as plain words nobody could tap
        const words = await tab.eval<{ text: string; phase: string; opacity: number; tappable: boolean }[]>('window.__stage.elements().filter((e) => e.kind === "text").map((e) => ({ text: String(e.text || ""), phase: e.phase, opacity: e.opacity, tappable: e.tappable }))');
        for (const wanted of ['Spec the bindable transforms first', 'Which matters most to you?']) {
          const found = words.find((e) => norm(e.text) === norm(wanted) && e.phase === 'on' && e.opacity > 0.3);
          if (found === undefined) problems.push(`the revised choice "${wanted}" is not on stage`);
          else if (!found.tappable) problems.push(`"${wanted}" is on stage but is plain words: the revised choice lost its tap`);
        }
        for (const old of ['Spec the sphere', 'Write the test']) if (words.some((e) => norm(e.text) === norm(old) && e.phase === 'on' && e.opacity > 0.3)) problems.push(`the words "${old}" are still on stage after they were revised`);
        good = 'both revised choices show their new words and are still taps';
        break;
      }
      case 'photo': {
        if (photo !== '') return add('photo-spots', 'SKIP', photo);
        const box = live.find((e) => e.id === 'p1')?.box;
        if (box === undefined) problems.push('the photo p1 is not on stage');
        else {
          for (const [name] of PHOTO_SPOTS) {
            const gap = this.feet.get(`${name}/leader`)?.spotGap;
            if (gap === undefined || gap === null) problems.push(`${name} has no leader to its spot`);
            else if (gap > 0.02 * box.width) problems.push(`${name}'s leader stops ${gap.toFixed(0)} px (${((100 * gap) / box.width).toFixed(1)}% of the photo's width) short of its spot`);
          }
        }
        good = 'all 8 callouts paint to within 2% of the photo width of their spots';
        break;
      }
      case 'fb-058': {
        // docs/feedback.md fb-058: the column sum is the painter's `math` block, laid out as on paper; the brain wrote no digit, so no word on stage is a bare number
        // and none holds what the open block seals; the sum the person is to work stands with its boxes empty, and an ask that waits draws nothing
        const blocks = live.filter((e) => e.kind === 'structure' && e.phase === 'on' && /^written method column/.test(e.text) && e.box.width > 50 && e.box.height > 50);
        if (blocks.length !== 2) problems.push(`${blocks.length} of the 2 written methods (the worked example and her own sum) are on stage`);
        const bare = texts.filter((e) => /^[\d\s.,+\-\u00d7\u00f7=]+$/.test(e.text.trim()));
        if (bare.length > 0) problems.push(`digits placed by hand on stage: ${bare.slice(0, 3).map((e) => `"${e.text}"`).join(', ')}`);
        const sealed = texts.filter((e) => e.text.replace(/[\s,]/g, '').includes('6281'));
        if (sealed.length > 0) problems.push(`the sealed answer 6281 is in words on stage: "${sealed[0]?.text.slice(0, 40)}"`);
        const cells = await tab.eval<{ part: string; value: string }[]>(`window.__stage.maths().flatMap((b) => b.id === 'm1' ? b.cells.map((c) => ({ part: c.part, value: String(c.value ?? '') })) : [])`);
        if (!cells.some((c) => c.part === 'ans-ones')) problems.push('her own sum has no answer boxes');
        const filled = cells.filter((c) => c.value !== '');
        if (filled.length > 0) problems.push(`her boxes are not empty: ${filled.map((c) => `${c.part}=${c.value}`).join(', ')}`);
        const asks = await tab.eval<string[]>(`window.__stage.controls().filter((c) => c.ask).map((c) => c.id)`);
        if (asks.join(',') !== 'q1') problems.push(`the asks drawn are ${JSON.stringify(asks)}, wanted only q1 (q2 waits)`);
        good = 'a worked example and her own sum are laid out by the painter (no digit in any word, the answer sealed, her boxes empty), q1 is open and q2 draws nothing';
        break;
      }
      case 'fb-059': {
        // docs/feedback.md fb-059: a title with no at= in a free scene stands at the top of the stage, over nothing
        const title = live.find((e) => e.id === 't1');
        const rest = live.filter((e) => e.id !== 't1' && e.phase === 'on' && e.box.width > 0 && e.box.height > 0);
        const view = await tab.eval<{ h: number }>('({ h: innerHeight })');
        if (title === undefined) problems.push('the title is not on stage');
        else {
          const over = rest.filter((e) => title.box.x < e.box.x + e.box.width && title.box.x + title.box.width > e.box.x && title.box.y < e.box.y + e.box.height && title.box.y + title.box.height > e.box.y);
          if (over.length > 0) problems.push(`the title lies over ${over.slice(0, 3).map((e) => `${e.id} "${e.text.slice(0, 20)}"`).join(', ')}`);
          const lowest = Math.min(...rest.map((e) => e.box.y));
          if (title.box.y + title.box.height > lowest + 1) problems.push(`the title (${title.box.y.toFixed(0)}..${(title.box.y + title.box.height).toFixed(0)}) is not above everything else (which starts at ${lowest.toFixed(0)})`);
          if (title.box.y + title.box.height / 2 > view.h / 3) problems.push(`the title is not at the top of the stage (its middle is at ${(title.box.y + title.box.height / 2).toFixed(0)} of ${view.h})`);
        }
        good = `the title stands at the top of the stage, above and clear of the worked answer and every other line`;
        break;
      }
      case 'fb-060': {
        // docs/feedback.md fb-060: asks 2 and 3 wait for ask 1, so they draw nothing: not on stage as controls, no number, no blank, no box
        const controls = await tab.eval<{ id: string; locked: boolean; parts: string[] }[]>(`window.__stage.controls().filter((c) => c.ask).map((c) => ({ id: c.id, locked: c.askState.locked, parts: c.parts.map((p) => p.part) }))`);
        const waiting = controls.filter((c) => c.locked);
        if (waiting.length > 0) problems.push(`${waiting.length} ask(s) that wait are drawn: ${waiting.map((c) => c.id).join(', ')}`);
        if (controls.map((c) => c.id).join(',') !== 'q1') problems.push(`the asks drawn are ${JSON.stringify(controls.map((c) => c.id))}, wanted only q1`);
        const boxed = live.filter((e) => e.kind === 'control' && e.id !== 'q1' && e.box.width > 0 && e.box.height > 0);
        if (boxed.length > 0) problems.push(`${boxed.map((e) => e.id).join(', ')} stand on the stage with a box (${boxed.map((e) => `${e.box.width.toFixed(0)}x${e.box.height.toFixed(0)}`).join(', ')})`);
        const numbers = texts.filter((e) => /^\d\.$/.test(e.text.trim()));
        if (numbers.length > 0) problems.push(`a bare number is drawn: ${numbers.map((e) => e.text).join(', ')}`);
        good = 'only ask 1 is drawn: asks 2 and 3 draw no number, no blank and take no place on the stage';
        break;
      }
      case 'fb-061': {
        // docs/feedback.md fb-061: `is=6,281,6` (the answer with its thousands comma, and a step of the working) plays as an ask for 6281, and the hint that names a step is kept
        // (the turn holds every scene's lines, and the ids repeat from one scene to the next: only this scene's own are read)
        const whole = await tab.eval<string[]>('window.__stage.lines().map((l) => l.text)');
        const lines = whole.slice(Math.max(0, whole.findIndex((line) => /^scene fb-061\b/.test(line))));
        const ask = lines.find((line) => /^ask q1\b/.test(line));
        const accepted = /\bis=(\S+)/.exec(ask ?? '')?.[1];
        if (ask === undefined) problems.push('the ask q1 did not play');
        else if (accepted !== '6281') problems.push(`ask q1 accepts "${accepted}", wanted only 6281`);
        if (!lines.some((line) => /^hint in=q1\b/.test(line))) problems.push('the hint of ask q1 was dropped');
        const parts = await tab.eval<string[]>(`(window.__stage.controls().find((c) => c.id === 'q1')?.parts ?? []).map((p) => p.part)`);
        if (!parts.includes('hint')) problems.push('ask q1 has no Hint to tap');
        good = 'ask q1 accepts the one answer 6281 (the thousands comma kept in its number, the step dropped) and its hint is on it';
        break;
      }
      case 'fb-025': {
        // fb-025: an app that reaches for d3 and never says `uses=`: the library is loaded for it (d3-geo too), so the globe is drawn, and nothing it ran threw
        const app = await this.appWhen(tab, 'globe', (one) => one.blank !== null);
        if (app === null) problems.push('the globe app is not running');
        else {
          if (!app.loaded) problems.push('the globe app never loaded');
          if (app.crashes > 0) problems.push(`the globe app threw ${app.crashes} time${app.crashes === 1 ? '' : 's'}: the library its code reaches for was not in its page`);
          if (app.blank === true) problems.push('the globe app drew nothing');
          else if (app.blank === null) problems.push('the globe app was never looked at for something visible');
        }
        good = 'the globe is drawn: d3 reached an app that never asked for it, nothing threw, and the picture of it shows something';
        break;
      }
      case 'fb-025-throws': {
        // an app that throws is reported by its frame, and the server holds it as a blocking observation (the brief carries it: see `briefHolds`)
        const app = await this.appWhen(tab, 'fixthrow', (one) => one.crashes > 0);
        if (app === null || app.crashes === 0) problems.push('the app threw on purpose and its frame did not tell the page');
        const heard = await this.observed(tab, (text) => /surface fixthrow \[blocking\]: app fixthrow threw: "Error: fixture: thrown on purpose" \(line 8\)/.test(text));
        if (heard !== null) problems.push(`the page's report of the crash did not reach the server's feed as a blocking observation with the app's words and its line: ${heard}`);
        good = 'the throw is told: the frame said so, the server holds `app fixthrow threw: "Error: fixture: thrown on purpose" (line 8)` as blocking';
        break;
      }
      case 'fb-025-blank': {
        // no error and nothing drawn but a flat ground: looked at three seconds after it loaded, and told
        const app = await this.appWhen(tab, 'fixblank', (one) => one.blank !== null);
        if (app === null || app.blank !== true) problems.push(`an app that shows only a flat ground was not found blank (${app === null ? 'not running' : app.blank === null ? 'never looked at' : 'looked at: something is visible'})`);
        if (app !== null && app.crashes > 0) problems.push('the blank fixture threw, and it is meant to throw nothing');
        const heard = await this.observed(tab, (text) => /surface fixblank \[blocking\]: app fixblank drew nothing/.test(text));
        if (heard !== null) problems.push(`the page's report that the app drew nothing did not reach the server's feed: ${heard}`);
        good = 'the empty frame is told: the host found nothing visible three seconds after it loaded, and the server holds `app fixblank drew nothing` as blocking';
        break;
      }
      case 'fb-026': {
        // fb-026: the world's land is real. The app draws `World.land` (the shelf's Natural Earth outlines) with D3; the screenshot is read for its literal colours, where they fall and how much there is
        // of them. The globe is turned to centre on 30E 10N, so Africa is not the middle pixel.
        const app = await this.appWhen(tab, 'earth', (one) => one.blank !== null);
        if (app === null) problems.push('the map app is not running');
        else {
          if (!app.loaded) problems.push('the map app never loaded');
          if (app.crashes > 0) problems.push(`the map app threw ${app.crashes} time${app.crashes === 1 ? '' : 's'}: \`World\` was not in its page`);
          if (app.blank === true) problems.push('the map app drew nothing');
        }
        if (app !== null && app.loaded) problems.push(...(await this.landLooks(tab)));
        good = 'the globe turned to 30E 10N shows the land: its fill is a good part of the disc, land is where the Congo basin, Zambia, Chad and Arabia are, and sea is where the mid-Atlantic, the Arabian Sea and the Indian Ocean are';
        break;
      }
      case 'fb-026-inferred': {
        // an app that never named `maps` and reaches for `World.land` is given it, whole and frozen: its block is land-coloured only if so (and the log's `uses-inferred` warning is read in the brief check)
        const app = await this.appWhen(tab, 'world', (one) => one.blank !== null);
        if (app === null) problems.push('the world app is not running');
        else {
          if (!app.loaded) problems.push('the world app never loaded');
          if (app.crashes > 0) problems.push(`the world app threw ${app.crashes} time${app.crashes === 1 ? '' : 's'}: \`World\` was not in its page`);
        }
        if (app !== null && app.loaded) {
          const frame = await tab.eval<{ x: number; y: number; w: number; h: number } | null>(
            `(() => { const f = [...document.querySelectorAll('iframe')].filter((one) => one.style.visibility === 'visible'); if (f.length !== 1) return null; const r = f[0].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
          );
          if (frame === null) problems.push('not one frame is showing, so there is nothing to read');
          else {
            const [seen] = await tab.call<(number[] | null)[]>('colourAt', await tab.shot(), [{ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }], tab.dpr);
            if (seen === null || seen === undefined || LAND_RGB.reduce((far, channel, at) => far + Math.abs((seen[at] ?? 0) - channel), 0) > 48) problems.push(`the middle of the world app should be the land colour (World.land whole and frozen) and is ${seen === null || seen === undefined ? 'outside the picture' : `rgb(${seen.join(', ')})`}`);
          }
        }
        good = 'the land reached an app that never asked for it: World.land is a MultiPolygon of over a hundred polygons and frozen, so the page shows its land-coloured block';
        break;
      }
      default:
        return;
    }
    add(`hard-${id}`, problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? good : problems.join('; '));
  }

  /**
   * fb-026: what the screenshot shows of the globe app's frame. The fixture draws the land in LAND_RGB over SEA_RGB, nothing else in either colour. The globe is an orthographic one centred on
   * 30E 10N (`d3.geoOrthographic().rotate([-30, -10])`, a disc of 0.45 of the frame's shorter side): how much of the middle is land, then the colour at a few points that are land (inland, away
   * from a coast) and a few that are sea. The problems it found, none when the map is real.
   */
  private async landLooks(tab: Tab): Promise<string[]> {
    const frame = await tab.eval<{ x: number; y: number; w: number; h: number } | null>(
      `(() => { const f = [...document.querySelectorAll('iframe')].filter((one) => one.style.visibility === 'visible'); if (f.length !== 1) return null; const r = f[0].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    );
    if (frame === null) return ['not one map frame is showing, so there is nothing to read'];
    const picture = await tab.shot();
    const cx = frame.x + frame.w / 2;
    const cy = frame.y + frame.h / 2;
    const radius = 0.45 * Math.min(frame.w, frame.h);
    const where = (lon: number, lat: number): { x: number; y: number } | null => {
      const rad = Math.PI / 180;
      const [lon0, lat0] = [30 * rad, 10 * rad];
      const [l, p] = [lon * rad, lat * rad];
      if (Math.sin(lat0) * Math.sin(p) + Math.cos(lat0) * Math.cos(p) * Math.cos(l - lon0) <= 0.05) return null;
      return { x: cx + radius * Math.cos(p) * Math.sin(l - lon0), y: cy - radius * (Math.cos(lat0) * Math.sin(p) - Math.sin(lat0) * Math.cos(p) * Math.cos(l - lon0)) };
    };
    const lands: readonly (readonly [string, number, number])[] = [['the Congo basin', 20, 0], ['Zambia', 25, -15], ['Chad', 15, 15], ['Arabia', 45, 25]];
    const seas: readonly (readonly [string, number, number])[] = [['the mid-Atlantic', -30, 0], ['the Arabian Sea', 62, 12], ['the Indian Ocean', 75, -15]];
    const problems: string[] = [];
    // the middle of the picture: the square inside the disc holds a good share of land fill
    const half = radius / Math.SQRT2;
    const [share] = await tab.call<number[]>('colourShare', picture, [{ x: cx - half, y: cy - half, w: 2 * half, h: 2 * half }], LAND_RGB, 48, tab.dpr);
    if ((share ?? 0) < 0.15) problems.push(`only ${(100 * (share ?? 0)).toFixed(1)}% of the middle of the globe is the land fill (a real one is about a third or more)`);
    const probes = [...lands.map(([name, lon, lat]) => ({ name, lon, lat, want: LAND_RGB, kind: 'land' })), ...seas.map(([name, lon, lat]) => ({ name, lon, lat, want: SEA_RGB, kind: 'sea' }))];
    const spots = probes.map((probe) => where(probe.lon, probe.lat));
    const seen = await tab.call<(number[] | null)[]>('colourAt', picture, spots.map((spot) => spot ?? { x: -10, y: -10 }), tab.dpr);
    probes.forEach((probe, index) => {
      const got = seen[index];
      if (spots[index] === null) problems.push(`${probe.name} is not on the visible side of the globe, so the check cannot read it`);
      else if (got === null || got === undefined) problems.push(`${probe.name} falls outside the picture`);
      else if (probe.want.reduce((far, channel, at) => far + Math.abs((got[at] ?? 0) - channel), 0) > 48) problems.push(`${probe.name} (${probe.lon}, ${probe.lat}) should be ${probe.kind} and is rgb(${got.join(', ')})`);
    });
    return problems;
  }

  /** The apps the page's host runs, as it probes them (`window.__stage.apps()`). */
  private async appsOf(tab: Tab): Promise<AppFacts[]> {
    return tab.eval<AppFacts[]>('window.__stage.apps()');
  }

  /** One app once `ready` says so (its frame has loaded, it has been looked at, it has thrown); what there is of it after `waitMs` if not; null when it is not running at all. */
  private async appWhen(tab: Tab, id: string, ready: (app: AppFacts) => boolean, waitMs = 9000): Promise<AppFacts | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const app = (await this.appsOf(tab)).find((one) => one.id === id && one.running);
      if (app !== undefined && app.loaded && ready(app)) return app;
      if (Date.now() > until) return app ?? null;
      await sleep(300);
    }
  }

  /** Every app on stage loaded and looked at (the look three seconds after it loaded, thrown or not), or the wait is out: so that a scene's picture is taken of apps that have settled. */
  private async appsLooked(tab: Tab, waitMs = 9000): Promise<void> {
    const until = Date.now() + waitMs;
    for (;;) {
      const apps = (await this.appsOf(tab)).filter((one) => one.running);
      if (apps.every((one) => one.loaded && one.blank !== null) || Date.now() > until) return;
      await sleep(300);
    }
  }

  /** The id of this page's session, from the addresses it has asked for. */
  private async sessionOf(tab: Tab): Promise<string | null> {
    return tab.eval<string | null>(`(() => { for (const r of performance.getEntriesByType('resource')) { const m = /\\/api\\/sessions\\/([^/]+)\\//.exec(r.name); if (m) return m[1]; } return null; })()`);
  }

  /**
   * What the server holds of what the page's eyes reported (the canvas tool `canvas_observe`, blocking items): null once `want` holds of its words, or what it said when the wait was out.
   * The page tells the server at most once a second, so a report is waited for.
   */
  private async observed(tab: Tab, want: (text: string) => boolean, waitMs = 8000): Promise<string | null> {
    const session = await this.sessionOf(tab);
    if (session === null) return 'the page has no session';
    const until = Date.now() + waitMs;
    let said = '';
    for (;;) {
      said = await fetch(`${this.base}/api/sessions/${session}/canvas/canvas_observe?severity=blocking&since=0&limit=30`)
        .then((response) => response.json() as Promise<{ text?: string }>)
        .then((body) => body.text ?? '')
        .catch((error: unknown) => `no answer (${error instanceof Error ? error.message : String(error)})`);
      if (want(said)) return null;
      if (Date.now() > until) return said.replace(/\s+/g, ' ').slice(0, 300);
      await sleep(400);
    }
  }

  /**
   * fb-025: what the fixtures that threw and drew nothing came to in the brain's brief. A short turn is played, so that a brief is built; its `attention` record (the fingerprints of the urgent
   * items its digest printed) and the `obs` records, in the session's own log, are read back. The digest is made again from those records by the function the brief uses, and says the words.
   */
  private async briefHolds(tab: Tab, talk: Conversation, session: string | null, results: CheckResult[]): Promise<void> {
    const add = (verdict: Verdict, detail: string): void => talk.add(results, 'hard-fb-025-brief', verdict, detail);
    const logs = LOG_DIRS.get(this.base) ?? process.env['CHECK_LOG_DIR'];
    if (logs === undefined) return add('SKIP', 'the server is not this check\'s own, so its session log cannot be read (CHECK_LOG_DIR names one)');
    if (session === null) return add('FAIL', 'the page has no session');
    const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript('say fb | A short turn, so that the brain is given a brief.')).then(() => null, (e) => String(e && e.message || e))`);
    if (played !== null) return add('FAIL', `the short turn would not start: ${played}`);
    await talk.rest(true);
    interface LogRecord {
      readonly type: string;
      readonly shown?: string[];
      readonly rev?: [number, number];
      readonly obs?: Observation;
      readonly text?: string;
      readonly issues?: readonly { readonly code: string; readonly token?: string }[];
    }
    let inferred: string[] = [];
    const wanted: readonly (readonly [string, RegExp])[] = [['the app that threw', /^surface\|fixthrow\|app fixthrow threw: /], ['the app that drew nothing', /^surface\|fixblank\|app fixblank drew nothing/]];
    const until = Date.now() + 12_000;
    let shown: readonly string[] = [];
    let noted: Observation[] = [];
    let attention: Attention | null = null;
    for (;;) {
      const file = existsSync(logs) ? readdirSync(logs).find((name) => name.endsWith(`-${session}.jsonl`)) : undefined;
      const records = file === undefined ? [] : readFileSync(join(logs, file), 'utf8').split('\n').flatMap((line) => {
        try {
          return line.trim() === '' ? [] : [JSON.parse(line) as LogRecord];
        } catch {
          return [];
        }
      });
      const told = records.filter((record) => record.type === 'attention' && Array.isArray(record.shown));
      shown = told.flatMap((record) => record.shown ?? []);
      noted = records.flatMap((record) => (record.type === 'obs' && record.obs !== undefined ? [record.obs] : []));
      // the lines that carry a `uses-inferred` warning: the log shows that a library was loaded for an app that did not ask
      inferred = records.flatMap((record) => (record.type === 'line' && (record.issues ?? []).some((issue) => issue.code === 'uses-inferred') ? [`${(record.text ?? '').slice(0, 24)} (${(record.issues ?? []).filter((issue) => issue.code === 'uses-inferred').map((issue) => issue.token).join(',')})`] : []));
      const last = told[told.length - 1];
      if (last !== undefined) attention = { rev: last.rev?.[1] ?? 0, wrote: last.rev?.[0] ?? 0, screen: '1280x720 desktop', engine: 'ok', clean: null, watch: [], ignore: [], tools: false };
      if (wanted.every(([, pattern]) => shown.some((fingerprint) => pattern.test(fingerprint))) || Date.now() > until) break;
      await sleep(400);
    }
    const problems: string[] = [];
    for (const [what, pattern] of wanted) if (!shown.some((fingerprint) => pattern.test(fingerprint))) problems.push(`no brief listed ${what} among its urgent items (${shown.length} urgent item${shown.length === 1 ? '' : 's'} shown over the session)`);
    // fb-025: the globe's first row that reaches for d3 says so in the log, once; fb-026: so does the world app's first row that reaches for `World`, once; no other app is said to (the rest reach for nothing, or name what they use)
    if (inferred.length !== 2 || !/^row globe \| .*\(charts\)$/.test(inferred[0] as string) || !/^row world \| .*\(maps\)$/.test(inferred[1] as string)) problems.push(`the log should hold two \`uses-inferred\` warnings, one on a row of the globe naming charts and one on a row of the world app naming maps: ${inferred.length === 0 ? 'none' : inferred.join('; ')}`);
    // the words the brain reads: the digest, made from the logged observations by the shared function
    const digest = attention === null ? '' : digestFull(noted.filter((one) => one.severity === 'blocking'), attention).text;
    if (!/app fixthrow threw: "Error: fixture: thrown on purpose" \(line 8\)/.test(digest)) problems.push(`the digest does not say how the app threw: ${digest.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (!/app fixblank drew nothing/.test(digest)) problems.push('the digest does not say the app drew nothing');
    add(problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `the next brief lists both as urgent: \`app fixthrow threw: "Error: fixture: thrown on purpose" (line 8)\` and \`app fixblank drew nothing\`; the log holds the globe's \`uses-inferred\` warning (${inferred[0] ?? ''})` : problems.join('; '));
  }

  /**
   * A turn streamed at about 80 characters a second (the pace of a model writing, not the 3000 the other groups use): the first element is on stage while the turn is still
   * being written, long before its last line has been sent. A page that holds the stage back until the whole turn has come would show nothing for half a minute.
   */
  async streamScene(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const total = readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/diagrams.series')), 'utf8').split('\n').filter((raw) => raw.trim() !== '' && !raw.startsWith('#')).length;
    const { tab } = await this.open('', false);
    try {
      const began = Date.now();
      await tab.eval(`Promise.resolve(window.__stage.demo('diagrams')).then(() => null, () => null)`);
      let first: { at: number; lines: number; open: boolean } | null = null;
      while (first === null && Date.now() - began < 40_000) {
        const now = await tab.eval<{ shown: number; lines: number; open: boolean }>(`({ shown: window.__stage.elements().filter((e) => e.phase === 'on' || e.phase === 'entering').length, lines: window.__stage.lines().length, open: window.__stage.state().turn !== null })`);
        if (now.shown > 0) first = { at: (Date.now() - began) / 1000, lines: now.lines, open: now.open };
        else await sleep(100);
      }
      const problems: string[] = [];
      if (first === null) problems.push('nothing was on stage after 40 s of a turn streaming at 80 characters a second');
      else {
        if (!first.open) problems.push('the turn had ended before its first element was on stage');
        if (first.lines > total / 2) problems.push(`the first element came only when ${first.lines} of the ${total} lines had been sent`);
        if (first.at > 12) problems.push(`the first element came after ${first.at.toFixed(1)} s`);
      }
      Screen.add(results, 'stream-first-element', problems, `the first element was on stage after ${first?.at.toFixed(1)} s, with ${first?.lines} of the ${total} lines sent and the turn still being written`);
    } finally {
      await tab.close();
    }
    return results;
  }

  /**
   * "Show the language" follows what is drawn: a long answer (a loop and a move early, then five long lines and fifteen dots) is played with the pane on, and while it plays
   * the line lit as being drawn stays inside the pane's own rect, though the pane is several pages long and the lines arrive ahead of the drawing. The pane's scroll
   * is not at the end while it follows; what keeps moving is marked; a wheel turn in the pane stops the following and shows "Follow", which resumes it.
   * Frames at about half a second are kept in `<screen>/follow/`.
   */
  async followScene(): Promise<void> {
    const name = 'follow';
    const began = Date.now();
    this.note(name);
    const { tab, talk } = await this.open('', false);
    try {
      await this.look(tab);
      const frames = join(this.dir, 'follow');
      await mkdir(frames, { recursive: true });
      await tab.eval(`(() => { try { localStorage.setItem('conduit.lines', 'on'); } catch (e) {} return true; })()`);
      await tab.send('Page.reload');
      for (let waited = 0; waited < 40_000 && !(await tab.eval<boolean>('Boolean(window.__stage)').catch(() => false)); waited += 250) await sleep(250);
      await tab.eval('window.__stage.ready.then(() => true)');
      tab.drain();
      const results: CheckResult[] = [];
      const lines: string[] = ['look paper', 'scene long stack lines=3 brisk', 'circle beacon 12,20 3 fill=accent loop=pulse', 'circle ball 12,60 3 fill=ink', 'move ball 140,60 over=6s'];
      for (let n = 1; n <= 5; n += 1) {
        for (let dot = 0; dot < 3; dot += 1) lines.push(`circle d${n}x${dot} ${20 + dot * 6},${10 + n * 3} 0.6 fill=dim`);
        lines.push(`say | Line ${n} of a long answer, written well ahead of its drawing, so the pane runs on and the line being drawn stays in view.`);
      }
      lines.push('wait 1');
      await tab.eval(`(window.__follow = window.__stage.playScript(${JSON.stringify(lines.join('\n'))}), true)`);
      type Sample = { readonly at: number; readonly pane: { top: number; bottom: number } | null; readonly row: { top: number; bottom: number; index: number } | null; readonly rows: number; readonly away: number; readonly moving: number; readonly marked: number };
      const read = (): Promise<Sample> =>
        tab.eval<Sample>(`(() => { const list = document.querySelector('.lang__body'); if (!list) return { at: Date.now(), pane: null, row: null, rows: 0, away: 0, moving: 0, marked: 0 }; const box = list.getBoundingClientRect(); const rows = [...list.querySelectorAll('.lang__row')]; const now = list.querySelector('.lang__row.is-now'); const r = now ? now.getBoundingClientRect() : null; return { at: Date.now(), pane: { top: box.top, bottom: box.bottom }, row: r ? { top: r.top, bottom: r.bottom, index: rows.indexOf(now) } : null, rows: rows.length, away: list.scrollHeight - list.scrollTop - list.clientHeight, moving: list.querySelectorAll('.is-moving').length, marked: list.querySelectorAll('.is-moving--lead').length }; })()`);
      const samples: Sample[] = [];
      let frame = 0;
      let quiet = 0;
      const t0 = Date.now();
      let nextFrame = 0;
      while (Date.now() - t0 < 85_000 && quiet < 20) {
        const sample = await read();
        samples.push(sample);
        // done: no line is being drawn any more, or the last row has been the lit one for three seconds (it stays lit when the script ends)
        quiet = samples.length > 8 && (sample.row === null || sample.row.index >= sample.rows - 1) ? quiet + 1 : 0;
        if (Date.now() - t0 >= nextFrame && sample.row !== null) {
          nextFrame += 500;
          frame += 1;
          const picture = await tab.shot();
          await writeFile(join(frames, `${this.screen.name}-follow-${String(frame).padStart(3, '0')}.png`), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
        }
        await sleep(150);
      }
      const drawn = samples.filter((sample) => sample.row !== null && sample.pane !== null);
      const inView = (sample: Sample): boolean => sample.row !== null && sample.pane !== null && sample.row.top >= sample.pane.top - 2 && sample.row.bottom <= sample.pane.bottom + 2;
      const seen = drawn.filter(inView).length;
      const problems: string[] = [];
      const rowsMax = Math.max(0, ...samples.map((sample) => sample.rows));
      if (rowsMax < 20) problems.push(`the pane listed ${rowsMax} rows, expected the 25 lines of the script`);
      // the drawn line is in the pane's rect in nearly every sample (a smooth scroll may lag one sample behind a new line)
      if (drawn.length < 10) problems.push(`only ${drawn.length} samples had a line being drawn`);
      else if (seen / drawn.length < 0.85) problems.push(`the drawn line was inside the pane in ${seen} of ${drawn.length} samples`);
      const awayFromEnd = drawn.filter((sample) => inView(sample) && sample.away > 60).length;
      if (awayFromEnd < 3) problems.push(`the pane was never scrolled to a drawn line short of its end (${awayFromEnd} samples)`);
      if (!samples.some((sample) => sample.moving > 0 && sample.marked > 0)) problems.push('no row was marked as moving while the loop and the move ran');
      Screen.add(results, 'follow', problems, `the drawn line stayed inside the pane in ${seen} of ${drawn.length} samples, ${awayFromEnd} of them with the pane scrolled short of its end; moving rows marked; ${frame} frames kept`);
      // the person's own scrolling ends the following and offers "Follow", which resumes it
      const own: string[] = [];
      const chipState = (): Promise<{ hidden: boolean; top: number }> => tab.eval(`(() => { const c = document.querySelector('.lang__follow'); return { hidden: !c || c.hidden, top: document.querySelector('.lang__body').scrollTop }; })()`);
      const before = await chipState();
      if (!before.hidden) own.push('the Follow chip shows while the pane follows');
      await tab.eval(`(() => { const l = document.querySelector('.lang__body'); l.scrollTop = 0; l.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })); return true; })()`);
      await sleep(400);
      const left = await chipState();
      if (left.hidden) own.push('a wheel turn in the pane did not show the Follow chip');
      await tab.eval(`document.querySelector('.lang__follow').click()`);
      await sleep(900);
      const back = await chipState();
      if (!back.hidden) own.push('tapping Follow left the chip showing');
      Screen.add(results, 'follow-chip', own, 'a wheel turn shows Follow; tapping it resumes');
      results.push(Screen.restResult(await talk.rest(true), began));
      await this.judge(tab, talk, name, results, began, true, false);
    } finally {
      await tab.close();
    }
  }

  /**
   * The maths questions of problem.series: old logs hold `problem` lines, and they still play, as ordinary canvas content: the question as words and an `ask` blank
   * for its answer. Nothing takes the screen. A wrong answer put in the blank is marked wrong, the right one right.
   */
  async problemScenes(): Promise<void> {
    const { tab, talk } = await this.open('', false);
    try {
      await this.look(tab);
      for (const scene of problemScenes()) {
        const began = Date.now();
        const name = `problem-${scene.id}`;
        this.note(name);
        tab.drain();
        const results: CheckResult[] = [];
        const problems: string[] = [];
        const play = (script: string): Promise<string | null> => tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
        const played = await play(scene.script);
        results.push(Screen.restResult(played !== null ? `the script would not play: ${played}` : await talk.rest(true), began));
        const sent = tab.posted.length;
        const verdict = (): Promise<string> => tab.eval<string>(`(window.__stage.controls().find((c) => c.id === ${JSON.stringify(scene.id)}) || { askState: { verdict: 'none' } }).askState.verdict`);
        await checkTakeover(tab, (check, verdict, detail) => talk.add(results, check, verdict, detail));
        const words = norm(scene.question.replace(/_{2,}|□/g, ' '));
        const said = norm((await tab.eval<string>(`window.__stage.elements().map((e) => e.text).concat(window.__stage.controls().map((c) => c.label)).join(' ')`)).replaceAll('…', ' '));
        if (!said.includes(words.split(' ').slice(0, 6).join(' '))) problems.push(`the question is not on the canvas: "${scene.question}"`);
        if ((await verdict()) === 'none') problems.push('there is no blank to answer in');
        else {
          await play(`fill ${scene.id} | 7777777`);
          await talk.rest(true);
          const wrong = await verdict();
          if (wrong !== 'wrong') problems.push(`a wrong answer in the blank was marked "${wrong}"`);
          await play(`fill ${scene.id} | ${scene.answer}`);
          // the last ask answered right tells the brain (a turn), and the replay brain then answers: it is marked right the moment the fill lands
          let right = await verdict();
          for (let waited = 0; waited < 4000 && right !== 'right' && !tab.posted.slice(sent).some((turn) => /right/.test(turn.text ?? '')); waited += 200) {
            await sleep(200);
            right = await verdict();
          }
          if (right !== 'right' && !tab.posted.slice(sent).some((turn) => /right/.test(turn.text ?? ''))) problems.push(`the right answer in the blank was marked "${right}"`);
        }
        const picture = await tab.shot();
        const file = `${this.screen.name}-${name}.png`;
        await writeFile(join(this.dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
        await checkInk(tab, (check, verdict, detail) => talk.add(results, check, verdict, detail), picture, (await tab.call<Answer>('answer')).live, tab.dpr);
        Screen.add(results, 'problem', problems, 'the question is on the canvas with a blank, nothing takes the screen, a wrong answer is marked wrong and the right one right');
        const scenery: Scene = { name, seconds: (Date.now() - began) / 1000, picture: file, results };
        this.scenes.push(scenery);
        for (const result of results) if (result.verdict === 'FAIL') this.note(`  FAIL ${name} ${result.check}: ${result.detail.slice(0, 300)}`);
      }
    } finally {
      await tab.close();
    }
  }

  /** the CJK lines of a script, found by their own characters: each character must be its own picture (not one "?" or one box repeated) */
  private async scriptGlyphs(tab: Tab, talk: Conversation, results: CheckResult[], file = 'scripts'): Promise<void> {
    const source = readFileSync(fileURLToPath(import.meta.resolve(`@conduit/language/demos/${file}.series`)), 'utf8');
    const lines = source.split('\n').flatMap((raw) => {
      const found = /^say [^|]*\| (.+)$/.exec(raw);
      return found?.[1] !== undefined && /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(found[1]) ? [found[1].replace(/\s+/g, ' ').trim()] : [];
    });
    if (lines.length === 0) return;
    await checkGlyphs(tab, (check, verdict, detail) => talk.add(results, check, verdict, detail), this.feet, lines, tab.dpr);
  }

  /**
   * the scripts demo: every line of every language is kept whole by the fold (no `?`, no accent stripped, nothing dropped), is on stage at rest, on screen, and has ink in
   * its box in the picture (the device's own font drew it: a missing glyph shows as a blank or a box, which the check cannot tell, so the pictures are looked at too)
   */
  private async scripts(tab: Tab, results: CheckResult[]): Promise<void> {
    const source = readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/scripts.series')), 'utf8');
    const lines = source.split('\n').flatMap((raw) => {
      const found = /^say \S+ \| (.+)$/.exec(raw);
      return found?.[1] === undefined ? [] : [found[1]];
    });
    const folded = (await import(pathToFileURL(join(repoRoot(), 'web/src/fonts/fold.ts')).href)) as { foldText: (text: string) => string };
    const changed = lines.filter((line) => folded.foldText(line) !== line.normalize('NFC').replace(/ {2,}/g, ' '));
    Screen.add(results, 'scripts-kept', lines.length < 10 ? [`the demo has ${lines.length} lines, expected 10`] : changed.map((line) => `the fold changed "${line}" to "${folded.foldText(line)}"`), `all ${lines.length} lines pass the fold whole: no "?", no stripped accent`);
    const live = await tab.eval<Stage[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, box: e.box }))');
    const view = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    const shown = live.filter((element) => element.kind === 'text' && element.phase === 'on' && element.opacity > 0.3);
    const problems: string[] = [];
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const named: string[] = [];
    for (const line of lines) {
      const found = shown.find((element) => norm(element.text ?? '') === norm(line));
      if (found === undefined) problems.push(`not on stage at rest: "${line}"`);
      else if (found.box.x < -2 || found.box.y < -2 || found.box.x + found.box.width > view.w + 2 || found.box.y + found.box.height > view.h + 2) problems.push(`off screen: "${line}"`);
      else {
        boxes.push({ x: found.box.x, y: found.box.y, w: found.box.width, h: found.box.height });
        named.push(line);
      }
    }
    if (boxes.length > 0) {
      const marks = await tab.call<{ px: number; share: number }[]>('inkIn', await tab.shot(), boxes, tab.dpr);
      marks.forEach((mark, index) => {
        if (mark.share < 0.01) problems.push(`no ink in the box of "${named[index] ?? ''}"`);
      });
    }
    Screen.add(results, 'scripts-drawn', problems, `all ${lines.length} lines are on stage at rest, on screen and inked`);
  }

  /** the richness demo: the painting the renderer makes itself is on stage at rest, developed, and inked in the screenshot (it was absent from the resting picture once) */
  private async richness(tab: Tab, results: CheckResult[]): Promise<void> {
    const live = await tab.eval<Stage[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, box: e.box }))');
    const art = live.find((element) => element.kind === 'picture');
    if (art === undefined) return void Screen.add(results, 'richness', ['the painting "art" is not on stage at rest'], '');
    const picture = await tab.shot();
    const marks = await tab.call<{ px: number; share: number }[]>('inkIn', picture, [{ x: art.box.x, y: art.box.y, w: art.box.width, h: art.box.height }], tab.dpr);
    const share = marks[0]?.share ?? 0;
    Screen.add(results, 'richness', art.opacity < 0.3 ? [`the painting is on stage but faint (opacity ${art.opacity})`] : share < 0.05 ? [`the painting's box holds almost no ink (${(share * 100).toFixed(1)}%)`] : [], `the painting shows at rest, ${(share * 100).toFixed(0)}% of its box inked`);
  }

  /**
   * the art demo, played through the server's line path (the server expands each `draw`): the parts of the fox, the child and the mirrored fox are on stage,
   * the label sits by the fox's tail, the whole of the child moved, and the okapi the shelf does not hold is a quiet placeholder, not an error.
   */
  private async art(tab: Tab, results: CheckResult[]): Promise<void> {
    const live = await tab.eval<Stage[]>('window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || ""), phase: e.phase, opacity: e.opacity, box: e.box }))');
    const problems: string[] = [];
    const partsOf = (group: string): Stage[] => live.filter((element) => element.id.startsWith(`${group}-`));
    for (const [group, least] of [['fox1', 10], ['kid1', 10], ['fox2', 10]] as const) {
      const parts = partsOf(group);
      if (parts.length < least) problems.push(`${group} has ${parts.length} parts on stage, expected at least ${least}`);
      else if (parts.some((part) => part.opacity < 0.05)) problems.push(`a part of ${group} is on stage but invisible`);
    }
    const tail = live.find((element) => element.id === 'fox1-tail');
    const label = live.find((element) => element.kind === 'text' && (element.text ?? '').trim() === 'tail');
    if (tail === undefined) problems.push('fox1-tail is not on stage');
    else if (label === undefined) problems.push('the label "tail" is not on stage');
    else {
      const gap = Math.hypot(label.box.x + label.box.width / 2 - (tail.box.x + tail.box.width / 2), label.box.y + label.box.height / 2 - (tail.box.y + tail.box.height / 2));
      const reach = Math.max(tail.box.width, tail.box.height) * 1.2 + label.box.height * 2;
      if (gap > reach) problems.push(`the label "tail" is ${gap.toFixed(0)} px from fox1-tail's middle (more than ${reach.toFixed(0)})`);
    }
    const holder = live.find((element) => element.id === 'kid1');
    const kidBody = live.find((element) => element.id === 'kid1-body');
    if (holder === undefined || kidBody === undefined) problems.push('the group kid1 or its body is not on stage');
    const mirrored = live.find((element) => element.id === 'fox2-head');
    const original = live.find((element) => element.id === 'fox1-head');
    if (mirrored === undefined || original === undefined) problems.push('a fox head is missing');
    const soft = live.find((element) => element.id === 'okapi1-soft');
    if (soft === undefined) problems.push('the okapi has no placeholder on stage');
    else if (partsOf('okapi1').length !== 1) problems.push(`the okapi is a placeholder of one soft shape, but ${partsOf('okapi1').length} parts are on stage`);
    Screen.add(results, 'art', problems, `fox1 ${partsOf('fox1').length}, kid1 ${partsOf('kid1').length} and the mirrored fox2 ${partsOf('fox2').length} parts on stage, the label by the tail, a quiet placeholder for the okapi`);
  }

  /** a slider and a pick of the explorable demo: the drawing changes (a higher sun stands higher and throws a shorter shadow, away from it), the sentence says the number, and no request is made */
  private async explorable(tab: Tab, talk: Conversation, results: CheckResult[]): Promise<void> {
    interface Control {
      readonly id: string;
      readonly control: string;
      readonly label: string;
      readonly options: readonly string[];
      readonly min: number;
      readonly value: unknown;
      readonly valueText: string;
      readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    }
    const controls = (): Promise<Control[]> => tab.eval<Control[]>('window.__stage.controls().map((c) => ({ id: c.id, control: c.control, label: c.label, options: c.options, min: c.min, value: c.value, valueText: c.valueText, box: c.box }))');
    // the drawing as numbers: where, how opaque and what colour every drawn thing is; a control that does something changes them
    const drawing = (): Promise<string> => tab.eval<string>('JSON.stringify(window.__stage.elements().filter((e) => e.kind !== "control").map((e) => [e.id, Math.round(e.box.x), Math.round(e.box.y), Math.round(e.box.width), Math.round(e.box.height), Math.round(e.opacity * 100), e.colour || null]))');
    // at rest: the stage's own rest, then the drawing standing still for three looks in a row
    const settled = async (): Promise<string> => {
      await talk.rest(null, false);
      let last = await drawing();
      for (let still = 0; still < 3; ) {
        await sleep(250);
        const now = await drawing();
        still = now === last ? still + 1 : 0;
        last = now;
      }
      return last;
    };
    const list = await controls();
    const slider = list.find((control) => control.control === 'slider');
    const pick = list.find((control) => control.control === 'pick');
    const problems: string[] = [];
    if (slider === undefined || pick === undefined) {
      Screen.add(results, 'explorable', [`the explorable demo should hold a slider and a pick; found ${list.map((control) => control.control).join(', ') || 'nothing'}`], '');
      return;
    }
    const sent = tab.posted.length;
    const requests = (): number => tab.pending();
    const start = await settled();
    // fb-029: the sun and its shadow at the two ends of the slider. A higher sun stands higher, throws a shorter shadow, and the shadow falls away from the sun.
    const sun = async (): Promise<{ readonly sun: { x: number; y: number; width: number; height: number } | null; readonly shadow: { x: number; y: number; width: number; height: number } | null; readonly said: string }> =>
      tab.eval(`(() => { const live = window.__stage.elements(); const box = (id) => { const e = live.find((c) => c.id === id); return e ? { x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height } : null; }; const said = live.find((c) => c.kind === 'text' && /^Sun /.test(String(c.text || ''))); return { sun: box('sun'), shadow: box('shadow'), said: said ? String(said.text) : '' }; })()`);
    await tab.eval(`window.__stage.control(${JSON.stringify(slider.id)}, 20)`);
    const low = await settled().then(sun);
    await tab.eval(`window.__stage.control(${JSON.stringify(slider.id)}, 80)`);
    const afterSlider = await settled();
    const high = await sun();
    if (low.sun === null || low.shadow === null || high.sun === null || high.shadow === null) problems.push('the sun or its shadow is not on stage');
    else {
      if (!(high.sun.y < low.sun.y - 10)) problems.push(`a higher sun must stand higher: the sun's top is at ${Math.round(low.sun.y)} at 20 and ${Math.round(high.sun.y)} at 80`);
      if (!(high.shadow.width < low.shadow.width - 20)) problems.push(`a higher sun must throw a shorter shadow: ${Math.round(low.shadow.width)} px at 20, ${Math.round(high.shadow.width)} px at 80`);
      if (!(low.shadow.x + low.shadow.width / 2 > low.sun.x + low.sun.width / 2)) problems.push('the shadow must fall away from the sun, and it falls on the same side');
    }
    // the shadow all the way along the slider (it is bound over four parts of the range, chained): it only ever shortens as the sun goes up, and at 45 degrees it is the length the sentence says
    // (2 m against 5.5 m at 20 degrees: a ratio of 0.36)
    const along = [20, 26, 32, 38, 45, 50, 56, 62, 68, 74, 80];
    const lengths: number[] = [];
    for (const angle of along) {
      await tab.eval(`window.__stage.control(${JSON.stringify(slider.id)}, ${angle})`);
      await settled();
      lengths.push((await sun()).shadow?.width ?? 0);
    }
    const grew = lengths.findIndex((length, at) => at > 0 && length > (lengths[at - 1] as number) + 4);
    if (grew > 0) problems.push(`the shadow grew again as the sun went up: ${along.map((angle, at) => `${angle} ${Math.round(lengths[at] as number)}`).join(', ')}`);
    const ratio = (lengths[4] as number) / Math.max(1, lengths[0] as number);
    if (ratio < 0.3 || ratio > 0.43) problems.push(`the shadow at 45 degrees is ${ratio.toFixed(2)} of its length at 20; a 2 m post throws 2 m against 5.5 m (0.36)`);
    await tab.eval(`window.__stage.control(${JSON.stringify(slider.id)}, 80)`);
    await settled();
    if (!/Sun 20\D*\bup\b/.test(low.said) || !/Sun 80\D*\bup\b/.test(high.said)) problems.push(`the live sentence does not say the angle: "${low.said}" at 20 and "${high.said}" at 80`);
    if (afterSlider === start) problems.push(`moving the slider "${slider.label}" changed nothing in the drawing`);
    const afterToggle = afterSlider;
    // the pick: another option (a pick is set by its 1-based position)
    const shown = (await controls()).find((control) => control.id === pick.id)?.valueText ?? '';
    const next = Math.max(1, pick.options.findIndex((option) => option !== shown) + 1);
    await tab.eval(`window.__stage.control(${JSON.stringify(pick.id)}, ${next})`);
    const afterPick = await settled();
    const other = pick.options[next - 1];
    const took = (await controls()).find((control) => control.id === pick.id)?.valueText;
    if (took !== other) problems.push(`choosing "${String(other)}" in the pick "${pick.id}" left it at "${String(took)}"`);
    else if (afterPick === afterToggle) problems.push(`choosing "${String(other)}" in the pick "${pick.id}" changed nothing in the drawing`);
    if (tab.posted.length !== sent) problems.push(`working the controls sent ${tab.posted.length - sent} turn(s) to the server: they must not need a round trip`);
    if (requests() !== 0) problems.push(`${requests()} request(s) still in flight after working the controls`);
    Screen.add(results, 'explorable-controls', problems, 'the slider moved the sun and shortened its shadow, away from it, the sentence said the angle, and the pick changed the drawing, with no turn sent');
  }
}

/**
 * Every demo this check judges: all of them, the ones the app does not offer yet (`DEMOS_NOT_PAINTED`) too. The list used to leave those out, and `code` was among them: its
 * painter did not exist, the demo was never played, and the tour offered it all the same. `problem` is left out: it plays problem.series again, which the `problems` scenes
 * already judge (it stays a demo for `/demo`).
 */
const judgedDemos = (): string[] => DEMOS.filter((candidate) => candidate.name !== 'problem').map((candidate) => candidate.name as string);

/** the demos the tour plays by name that no demo group judges: there must be none (the tour check starts a card's demo and leaves its judging to the demo groups) */
const tourDemosUnjudged = (): string[] => [...new Set(TOUR_CHAPTERS.flatMap((chapter) => chapter.cards.flatMap((card) => (card.kind === 'demo' ? [card.name] : []))))].filter((name) => name !== 'problem' && !judgedDemos().includes(name));

// ---------------------------------------------------------------------------------------------------------------------------------
// The report

const COLUMNS: readonly (readonly [string, string])[] = [
  ['rest', 'rest'],
  ['script-lines', 'lines'],
  ['welcome-words', 'words'],
  ['choice-sent', 'sent'],
  ['explorable-controls', 'ctrls'],
  ['problem', 'problem'],
  ['follow', 'follow'],
  ['follow-chip', 'chip'],
  ['art', 'art'],
  ['answer-on-stage', 'stage'],
  ['no-overlap', 'overlap'],
  ['nothing-cut-off', 'cutoff'],
  ['ink-in-box', 'ink'],
  ['stage-not-covered', 'top'],
  ['footprints', 'feet'],
  ['code-block', 'code'],
  ['code-rows', 'rows'],
  ['slide-words', 'slides'],
  ['glyphs', 'glyph'],
  ['hard', 'hard'],
  ['chrome-readable', 'chrome'],
  ['prompt-readable', 'prompt'],
  ['no-console-errors', 'console'],
  ['no-failed-requests', 'net'],
  ['renderer', 'gl'],
];

function table(run: ScreenRun): string {
  const lines = [`${run.screen.name}  renderer: ${run.renderer}${run.gpu === '' ? '' : ` (${run.gpu})`}`];
  lines.push(`${'scene'.padEnd(26)}${COLUMNS.map(([, label]) => label.padEnd(9)).join('')}secs`);
  for (const scene of run.scenes) {
    const cells = COLUMNS.map(([check]) => {
      const verdict = (scene.results.find((result) => result.check === check && result.verdict === 'FAIL') ?? scene.results.find((result) => result.check === check || (check === 'hard' && result.check.startsWith('hard-'))))?.verdict;
      return (verdict === undefined ? '-' : verdict === 'PASS' ? 'ok' : verdict).padEnd(9);
    });
    lines.push(`${scene.name.padEnd(26)}${cells.join('')}${scene.seconds.toFixed(0)}`);
  }
  return lines.join('\n');
}

async function webkitHook(base: string, out: string, timeoutMs: number, quiet: boolean): Promise<number> {
  const missing = webkitMissing();
  if (missing !== null) {
    process.stdout.write(`\nwebkit: SKIPPED, ${missing}\n`);
    return 0;
  }
  try {
    const scenes = await webkitGroup(base, join(out, 'webkit'), timeoutMs, (text) => (quiet ? undefined : process.stdout.write(`[${text}]\n`)));
    process.stdout.write('\nwebkit (iPhone landscape, iPhone, iPad)\n');
    return printWebkit(scenes, (text) => process.stdout.write(text));
  } catch (error) {
    process.stdout.write(`  FAIL webkit stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The groups, and how they are run

/** which server a group plays against: the main one (shared: every tab here has its own Chrome profile, so its own session), one with a fake art maker, or one that chains `refine` */
type Needs = 'main' | 'art' | 'chain' | 'slow' | 'none';

/** what one group wrote: its lines for the report, how many problems, and what check.json keeps */
interface Output {
  readonly lines: string[];
  failures: number;
  json?: { readonly key: 'lens' | 'asks' | 'arts'; readonly value: unknown };
}

interface Unit {
  /** the name `--only` and `--list` use (several units may share one: the same group on another screen) */
  readonly name: string;
  /** other names that pick this unit (the choice scene is played in the welcome's tab) */
  readonly also?: readonly string[];
  readonly needs: Needs;
  /** a rough length in seconds: the longest start first, so the last one to finish is not a long one begun late */
  readonly weight: number;
  readonly run: (servers: Readonly<Record<Needs, string | null>>, out: Output) => Promise<void>;
}

const sceneLines = (out: Output, scenes: readonly { readonly name: string; readonly results: readonly CheckResult[] }[]): void => {
  for (const scene of scenes) {
    for (const result of scene.results) {
      out.lines.push(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${scene.name} ${result.check}: ${result.detail}`);
      if (result.verdict === 'FAIL') out.failures += 1;
    }
  }
};

const checkLines = (out: Output, results: readonly CheckResult[]): void => {
  for (const result of results) {
    out.lines.push(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${result.check}: ${result.detail}`);
    if (result.verdict === 'FAIL') out.failures += 1;
  }
};

function defaultJobs(): number {
  return Math.max(1, Math.min(8, Math.floor(cpus().length / 2)));
}

/** every group, in the order the report prints them */
function buildUnits(args: Args, welcome: Welcome): { readonly units: Unit[]; readonly screens: { readonly screen: Args['screens'][number]; readonly run: Screen; readonly stopped: string[]; began: number; ended: number }[] } {
  const plain = (text: string): void => (args.quiet ? undefined : void process.stdout.write(`[${text}]\n`));
  const units: Unit[] = [];
  const screens = args.screens.map((screen) => ({ screen, run: new Screen(args, '', screen, join(args.out, screen.name), welcome), stopped: [] as string[], began: 0, ended: 0 }));
  const demos = judgedDemos();
  for (const entry of screens) {
    const { screen, stopped } = entry;
    const dir = join(args.out, screen.name);
    const screenUnit = (name: string, weight: number, also: readonly string[], play: (run: Screen) => Promise<void>): Unit => ({
      name,
      also,
      needs: 'main',
      weight,
      run: async (servers) => {
        entry.run.base = servers.main as string;
        if (entry.began === 0) entry.began = Date.now();
        try {
          await mkdir(dir, { recursive: true });
          await play(entry.run);
        } catch (error) {
          const why = `${name}: ${error instanceof Error ? error.message : String(error)}`;
          stopped.push(why);
          process.stdout.write(`[${screen.name}] ABORTED ${why}\n`);
        } finally {
          entry.ended = Date.now();
        }
      },
    });
    units.push(screenUnit('welcome', 40, ['choice'], (run) => run.welcomeScene(false)));
    units.push(screenUnit('welcome-reduced-motion', 25, [], (run) => run.welcomeScene(true)));
    units.push(screenUnit('problems', 30, [], (run) => run.problemScenes()));
    units.push(screenUnit('follow', 45, [], (run) => run.followScene()));
    // fb-001 (docs/feedback.md): code blocks that did not render in the tour's code chapter. `--only fb-001` is the code demo's judging.
    demos.forEach((name, index) => units.push(screenUnit(`demo-${name}`, 40, name === 'code' ? ['fb-001'] : [], (run) => run.demoScenes([name], index === 0))));
    // fb-058 to fb-061 (docs/feedback.md): the big-numbers maths turn. `--only fb-059` is the hard group's judging of its own scene (fb-060, fb-061 and fb-058 likewise; the ask and maths groups too)
    units.push(screenUnit('demo-hard', 60, ['fb-058', 'fb-059', 'fb-060', 'fb-061', 'fb-071', 'orbit-lap'], (run) => run.hardScenes()));
  }
  for (const screen of LENS_SCREENS) {
    units.push({
      name: 'lens',
      needs: 'main',
      weight: 60,
      run: async (servers, out) => {
        const scenes = await lensGroup(servers.main as string, screen, join(args.out, `lens-${screen.name}`), args.timeoutMs, (text) => (args.quiet ? undefined : void process.stdout.write(`[lens ${screen.name}] ${text}\n`)));
        out.lines.push(`\nlens ${screen.name} (dpr ${screen.dpr}, touch)`);
        sceneLines(out, scenes);
        out.json = { key: 'lens', value: { screen: screen.name, scenes } };
      },
    });
  }
  units.push({
    name: 'ask',
    needs: 'main',
    weight: 70,
    run: async (servers, out) => {
      const scenes = await askGroup(servers.main as string, ASK_SCREEN, join(args.out, 'ask'), args.timeoutMs, (text) => (args.quiet ? undefined : void process.stdout.write(`[ask] ${text}\n`)));
      out.lines.push(`\nask ${ASK_SCREEN.name} (dpr ${ASK_SCREEN.dpr}, touch)`);
      sceneLines(out, scenes);
      out.json = { key: 'asks', value: { screen: ASK_SCREEN.name, scenes } };
    },
  });
  ['', 'lens=1'].forEach((page, index) =>
    units.push({
      name: 'draw',
      needs: 'main',
      weight: 25,
      run: async (servers, out) => {
        if (index === 0) out.lines.push(`\ndraw ${DRAW_SCREEN.name} (dpr ${DRAW_SCREEN.dpr}, touch)`);
        sceneLines(out, await drawGroup(servers.main as string, DRAW_SCREEN, join(args.out, 'draw'), args.timeoutMs, (text) => (args.quiet ? undefined : void process.stdout.write(`[draw] ${text}\n`)), page));
      },
    }),
  );
  units.push({
    name: 'art-maker',
    needs: 'art',
    weight: 80,
    run: async (servers, out) => {
      const base = servers.art;
      if (base === null) return void out.lines.push('\nart-maker: skipped (--url was given and ART_CHECK_URL names no server with ART_MAKER=fake)');
      const scenes = await artGroup(base, ART_SCREEN, join(args.out, 'art-maker'), args.timeoutMs, (text) => (args.quiet ? undefined : void process.stdout.write(`[art] ${text}\n`)));
      out.lines.push(`\nart-maker ${ART_SCREEN.name}`);
      sceneLines(out, scenes);
      out.json = { key: 'arts', value: { screen: ART_SCREEN.name, scenes } };
    },
  });
  units.push({
    name: 'journey',
    needs: 'main',
    weight: 50,
    run: async (servers, out) => {
      const scenes = await journeyGroup(servers.main as string, join(args.out, 'journey'), args.timeoutMs, plain);
      out.lines.push('\njourney (1280x800, replay brain: typing, a tap, a drag, an undo and rest, with the hook\'s timings)');
      sceneLines(out, scenes);
    },
  });
  units.push({
    name: 'fb-055',
    needs: 'main',
    weight: 60,
    run: async (servers, out) => {
      const scenes = await labelGroup(servers.main as string, join(args.out, 'fb-055'), args.timeoutMs, plain);
      out.lines.push('\nfb-055 (a label the brain drew is tapped to ask about it: 1280x800 with a mouse, 1180x820 with a finger, the journey\'s fuzzy tap; replay brain)');
      sceneLines(out, scenes);
    },
  });
  units.push({
    name: 'fb-064',
    needs: 'main',
    weight: 30,
    run: async (servers, out) => {
      const scenes = await undoGroup(servers.main as string, join(args.out, 'fb-064'), args.timeoutMs, plain);
      out.lines.push('\nfb-064 (the Undo chip puts the answer before back with its labels and words, and takes everything of the one it undoes; 1280x800, replay brain)');
      sceneLines(out, scenes);
    },
  });
  units.push({
    name: 'memory',
    needs: 'main',
    weight: 80,
    run: async (servers, out) => {
      const scenes = await memoryGroup(servers.main as string, MEMORY_SCREEN, join(args.out, 'memory'), args.timeoutMs, plain);
      out.lines.push(`\nmemory ${MEMORY_SCREEN.name}`);
      sceneLines(out, scenes);
    },
  });
  for (const screen of TOUR_SCREENS) {
    units.push({
      name: 'tour',
      needs: 'main',
      weight: 50,
      run: async (servers, out) => {
        const scenes = await tourGroup(servers.main as string, screen, join(args.out, 'tour'), args.timeoutMs, plain);
        out.lines.push(`\ntour ${screen.name}`);
        sceneLines(out, scenes);
      },
    });
  }
  units.push({
    name: 'stream',
    needs: 'slow',
    weight: 25,
    run: async (servers, out) => {
      out.lines.push('\nstream (a turn at 80 characters a second, a recorded stream-json turn, the same turn through the brain)');
      const results = [...(await streamFixtureCheck()), ...(await streamBrainCheck())];
      if (servers.slow === null) results.push({ turn: 0, check: 'stream-first-element', verdict: 'SKIP', detail: 'skipped (--url was given: this needs a server that streams slowly)' });
      else results.push(...(await new Screen(args, servers.slow, args.screens[0] as Args['screens'][number], join(args.out, 'stream'), welcome).streamScene()));
      checkLines(out, results);
    },
  });
  units.push({
    name: 'demo-tour',
    needs: 'none',
    weight: 1,
    run: async (_servers, out) => {
      const unjudged = tourDemosUnjudged();
      out.lines.push('\ndemo-tour (every demo the tour plays is judged by a demo group)');
      checkLines(out, [{ turn: 0, check: 'demo-tour', verdict: unjudged.length === 0 ? 'PASS' : 'FAIL', detail: unjudged.length === 0 ? 'every demo a tour card plays is judged on pixels by a demo group' : `the tour plays ${unjudged.join(', ')} but no demo group judges ${unjudged.length === 1 ? 'it' : 'them'}` }]);
    },
  });
  units.push({
    name: 'flows',
    needs: 'none',
    weight: 8,
    run: async (_servers, out) => {
      out.lines.push('\nflows (pnpm flows)');
      checkLines(out, await flowsGroup());
    },
  });
  units.push({
    name: 'photo',
    needs: 'none',
    weight: 20,
    run: async (_servers, out) => {
      out.lines.push('\nphoto (pnpm photo-check)');
      checkLines(out, await photoGroup());
    },
  });
  units.push({
    name: 'loop',
    needs: 'none',
    weight: 10,
    run: async (_servers, out) => {
      const results = await loopGroup(plain);
      out.lines.push('\nloop (820x971)');
      checkLines(out, results);
    },
  });
  // fb-062 (docs/feedback.md): the loop missed a title over text and accepted a fix that moved things off the canvas. `--only fb-062` runs just this.
  units.push({
    name: 'fb-062',
    needs: 'none',
    weight: 10,
    run: async (_servers, out) => {
      const results = await fb062Group(plain);
      out.lines.push('\nfb-062 (1344x866: a title on words, and the fixes that dodge it)');
      checkLines(out, results);
    },
  });
  units.push({
    name: 'drift',
    needs: 'none',
    weight: 30,
    run: async (_servers, out) => {
      const results = await driftGroup(plain);
      out.lines.push('\ndrift (six screens)');
      checkLines(out, results);
    },
  });
  // the demo audit's checks that read the schedule and the painter's boxes with no browser, named by the backlog row they guard (docs/demo-audit.md part 4)
  units.push({
    name: 'fb-023',
    also: ['fb-028', 'fb-033', 'fb-042'],
    needs: 'none',
    weight: 8,
    run: async (_servers, out) => {
      out.lines.push('\nfb-023 (pnpm timeline demos): every scene stays up as long as reading it takes and arrives before it leaves; every chart is what it says; every control changes something');
      checkLines(out, await scriptGroup('fb-023', ['timeline', 'demos'], 'the reading rule, the charts and the controls of every demo hold'));
    },
  });
  units.push({
    name: 'fb-002',
    also: ['fb-003', 'fb-029', 'fb-032', 'fb-050'],
    needs: 'none',
    weight: 10,
    run: async (_servers, out) => {
      out.lines.push('\nfb-002 (pnpm demo-checks): no drawing runs past its canvas, no object comes apart in a move');
      checkLines(out, await scriptGroup('fb-002', ['demo-checks'], 'every demo scene and every memory step stays on its canvas and no object comes apart in a move'));
    },
  });
  units.push({
    name: 'maths',
    needs: 'none',
    weight: 60,
    run: async (_servers, out) => {
      out.lines.push('\nmaths (820x971, 390x844, 1280x720; input at 820x971 dpr 2 and 390x844 dpr 3, on a server of its own)');
      checkLines(out, await mathsGroup(plain, join(args.out, 'maths'), args.timeoutMs));
    },
  });
  units.push({
    name: 'film',
    needs: 'none',
    weight: 60,
    run: async (_servers, out) => {
      out.lines.push('\nfilm (the export as the session ran: typing, the panel, cuts, controls, following; a real WebM at 1280x720)');
      checkLines(out, await filmGroup(plain));
    },
  });
  units.push({
    name: 'continue',
    needs: 'chain',
    weight: 60,
    run: async (servers, out) => {
      if (servers.chain === null) return;
      const scenes = await continueGroup(servers.chain, CONTINUE_SCREEN, join(args.out, 'continue'), args.timeoutMs, plain);
      out.lines.push(`\ncontinue ${CONTINUE_SCREEN.name}`);
      sceneLines(out, scenes);
    },
  });
  return { units, screens };
}

/** `--only` picks groups by name, or by the start of a name (`demo` is every demo, `welcome` both welcomes) */
const picks = (unit: Unit, wanted: string): boolean => [unit.name, ...(unit.also ?? [])].some((name) => name === wanted || name.startsWith(wanted));

/** at most `limit` of the tasks at once, in the order given */
async function pool<T>(tasks: readonly T[], limit: number, work: (task: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const at = next;
        next += 1;
        if (at >= tasks.length) return;
        await work(tasks[at] as T);
      }
    }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const welcome = readWelcome();
  const { units, screens } = buildUnits(args, welcome);
  const names = [...new Set(units.map((unit) => unit.name))];
  if (args.list) {
    process.stdout.write(`${names.join('\n')}\n`);
    process.stdout.write('\n--only takes these, comma-separated, or the start of a name (demo = every demo, welcome = both welcomes, choice = the welcome); try: pnpm check --only art-maker,memory\n');
    process.exit(0);
  }
  const chosen = args.only === null ? units : units.filter((unit) => args.only?.some((wanted) => picks(unit, wanted)));
  for (const wanted of args.only ?? []) if (!units.some((unit) => picks(unit, wanted))) usage(`no group called "${wanted}"; the groups are ${names.join(', ')}`);
  if (chosen.some((unit) => unit.needs !== 'none') && !CHROME_CANDIDATES.some((path) => existsSync(path))) usage('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
  await mkdir(args.out, { recursive: true });
  const began = Date.now();
  const servers: Started[] = [];
  let failures = 0;
  const stopServers = async (): Promise<void> => {
    const running = servers.splice(0);
    await Promise.all(running.map((server) => server.stop()));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      process.stderr.write(`check: stopped by ${signal}\n`);
      void stopServers().finally(() => process.exit(2));
    });
  }
  const outputs = new Map<Unit, Output>();
  const timings: string[] = [];
  let base = '';
  try {
    // the main server is up for the whole run; the art and continuation servers (each for one group) are started as their group begins and stopped when it ends,
    // so they hold a port only while they are needed
    const wants = (needs: Needs): boolean => chosen.some((unit) => unit.needs === needs);
    const address: Record<Needs, string | null> = { main: null, art: null, chain: null, slow: null, none: null };
    const extras: Record<'art' | 'chain' | 'slow', () => Promise<Record<string, string>>> = {
      slow: async () => ({ REPLAY_CPS: '80' }),
      art: async () => ({ ART_MAKER: 'fake', ART_FAKE_MS: String(ART_FAKE_MS), ART_FAKE_STAGES: 'on' }),
      chain: async () => ({ REFINE: 'on', REPLAY_CASE: await continueFixtures() }),
    };
    if (args.url === null) {
      if (wants('main')) {
        const server = await startServer();
        servers.push(server);
        address.main = server.url;
      }
    } else {
      address.main = args.url;
      address.art = process.env['ART_CHECK_URL'] ?? null;
      if (!(await fetch(`${args.url}/api/health`).then((response) => response.ok, () => false))) usage(`nothing answers at ${args.url}/api/health`);
    }
    base = address.main ?? args.url ?? '';
    const jobs = args.jobs;
    process.stdout.write(`check: ${base === '' ? 'no server needed' : base}${args.url === null && base !== '' ? ' (started here, BRAIN=replay)' : ''}, screens ${args.screens.map((screen) => screen.name).join(', ')}, ${chosen.length} of ${units.length} groups, ${jobs} at a time, pictures in ${args.out}\n`);
    // the long ones first; each group's output is kept and printed in the report's order
    const order = [...chosen].sort((a, b) => b.weight - a.weight);
    await pool(order, jobs, async (unit) => {
      const out: Output = { lines: [], failures: 0 };
      outputs.set(unit, out);
      const here = { ...address };
      let own: Started | null = null;
      const at = Date.now();
      try {
        if (args.url === null && (unit.needs === 'art' || unit.needs === 'chain' || unit.needs === 'slow')) {
          own = await startServer(await extras[unit.needs]());
          servers.push(own);
          here[unit.needs] = own.url;
        }
        await unit.run(here, out);
      } catch (error) {
        out.failures += 1;
        out.lines.push(`  FAIL ${unit.name} stopped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (own !== null) {
          servers.splice(servers.indexOf(own), 1);
          await own.stop();
        }
        timings.push(`${unit.name} ${((Date.now() - at) / 1000).toFixed(0)}`);
      }
    });
    if (process.env['CHECK_TIMINGS'] !== undefined) process.stdout.write(`\ngroup seconds: ${timings.join(', ')}\n`);
    const summary: unknown[] = [];
    for (const entry of screens) {
      const { run, screen, stopped } = entry;
      if (run.scenes.length === 0 && stopped.length === 0) continue;
      const offered = judgedDemos();
      const sequence = ['welcome', 'choice', 'welcome-reduced-motion', ...offered.map((name) => `demo-${name}`), 'demo-hard', ...problemScenes().map((scene) => `problem-${scene.id}`), 'problem-fill', 'follow'];
      // a demo's scenes keep their own order (`demo-diagrams#1`, `#2`...; the hard cases by the order of the file)
      const place = (name: string): number => sequence.indexOf(name.split('#')[0] as string) + (name.includes('#') ? (Number(name.split('#')[1]) || hardOrder(name.split('#')[1] as string)) / 1000 : 0);
      run.scenes.sort((a, b) => place(a.name) - place(b.name));
      if (run.renderer !== 'unknown') {
        const webgl = run.renderer === 'three';
        run.scenes[0]?.results.push({ turn: 0, check: 'renderer', verdict: webgl || args.allowPlain ? 'PASS' : 'FAIL', detail: webgl ? 'the page got WebGL (three)' : `the page fell back to the "${run.renderer}" renderer: WebGL did not run in this Chrome` });
      }
      const seconds = (entry.ended - entry.began) / 1000;
      const done: ScreenRun = { screen, scenes: run.scenes, renderer: run.renderer, gpu: run.gpu, seconds, aborted: stopped.length === 0 ? null : stopped.join(' | ') };
      process.stdout.write(`\n${table(done)}\n`);
      for (const scene of run.scenes) {
        for (const result of scene.results) {
          if (result.verdict === 'FAIL') {
            failures += 1;
            process.stdout.write(`  FAIL ${screen.name} ${scene.name} ${result.check}: ${result.detail}\n`);
          }
        }
      }
      if (done.aborted !== null) {
        failures += 1;
        process.stdout.write(`  FAIL ${screen.name} stopped: ${done.aborted}\n`);
      }
      process.stdout.write(`  ${screen.name}: ${seconds.toFixed(0)} s, ${run.scenes.length} scenes\n`);
      summary.push({ screen: screen.name, renderer: run.renderer, gpu: run.gpu, aborted: done.aborted, seconds, scenes: run.scenes });
    }
    const json: Record<'lens' | 'asks' | 'arts', unknown[]> = { lens: [], asks: [], arts: [] };
    for (const unit of units) {
      const out = outputs.get(unit);
      if (out === undefined) continue;
      if (out.lines.length > 0) process.stdout.write(`${out.lines.join('\n')}\n`);
      failures += out.failures;
      if (out.json !== undefined) json[out.json.key].push(out.json.value);
    }
    // the WebKit group (--webkit): the bugs only Safari had, in Playwright's WebKit (webkit-check.ts); skipped with a message when that browser is not installed
    if (args.webkit) failures += await webkitHook(base, args.out, args.timeoutMs, args.quiet);
    await writeFile(join(args.out, 'check.json'), JSON.stringify({ url: base, at: new Date().toISOString(), failures, screens: summary, ...json }, null, 2));
  } catch (error) {
    failures += 1;
    process.stdout.write(`check: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await stopServers();
  }
  const verdict: Verdict = failures === 0 ? 'PASS' : 'FAIL';
  process.stdout.write(`\n${verdict}: ${failures === 0 ? 'every scene came to rest and passed' : `${failures} problem${failures === 1 ? '' : 's'}`} (${((Date.now() - began) / 1000).toFixed(0)} s, pictures in ${args.out})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && /check\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`check: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  });
}
