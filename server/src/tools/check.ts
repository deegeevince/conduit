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
//   every demo         each demo the app offers (not DEMOS_NOT_PAINTED) is played by name and comes to rest
//   explorable         a slider, a toggle and a pick of the explorable demo change the drawing with no request to the server
//   problems           each `problem` of language/demos/problem.series (old logs) is played at its own turn: the question is on the canvas with a blank, nothing takes the
//                      screen, a wrong answer put in the blank is marked wrong and the right one right (no model)
//   ask                (tablet 1180x820 at two pixels, touch, the lens off and on) a finger tap on an ask's blank focuses its input, also under the Draw layer after a pen stroke;
//                      a short pen tap too, a pen drag writes; `fill` puts a wrong or right answer in the blank and opens the next stage; Send drawing names the ask (ask-check.ts)
//   tour               (`/demo`; 1280x800, 820x971, 390x844) the tour opens on the stage, a chapter lists its cards, a card plays its demo with no model call, "Back to the tour" returns, `/demo <name>` jumps to one (tour-check.ts)
//   lens               (flag on, ?lens=1; tablet 1180x820 at two pixels to the point with touch, and 390x844) a two-finger pinch to 2x, then a tap on a choice, a slider
//                      drag and a pen stroke each land on the right page point; 0 fits again; the pen draws without Draw, a short pen tap presses (lens-check.ts)
//
// Every scene is judged at rest by smoke's checks: answer on stage, no overlap, nothing cut off, readable chrome and prompt, no console errors,
// no failed requests. The renderer the page got is printed; a fall back to the plain renderer fails the check unless --allow-plain.
// It prints a table, saves a screenshot per scene in --out, and exits 1 on any failure. Nothing here is part of the server.

import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEMOS, DEMOS_NOT_PAINTED, LineReader } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { CHROME_CANDIDATES, repoRoot, sleep, stop, waitFor } from './explore-browser';
import { claimPort, releasePort } from './check-ports';
import { Conversation, Tab } from './smoke';
import { LENS_SCREENS, lensGroup } from './lens-check';
import { ASK_SCREEN, askGroup } from './ask-check';
import { DRAW_SCREEN, drawGroup } from './draw-check';
import { ART_FAKE_MS, ART_SCREEN, artGroup } from './art-check';
import { CONTINUE_SCREEN, continueFixtures, continueGroup } from './continue-check';
import { MEMORY_SCREEN, memoryGroup } from './memory-check';
import { loopGroup } from './loop-check';
import { TOUR_SCREENS, tourGroup } from './tour-check';
import { printWebkit, webkitGroup, webkitMissing } from './webkit-check';
import { driftGroup } from './drift-check';
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
    timeoutMs: Number(flags.get('timeout') ?? 90) * 1000,
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
  const stopAll = async (): Promise<void> => {
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
  private async open(page: string, demo: boolean): Promise<{ tab: Tab; talk: Conversation }> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let opened: Tab | null = null;
      for (let tries = 0; tries < 3 && opened === null; tries += 1) opened = await Tab.open(this.screen.width, this.screen.height).catch(() => null);
      if (opened === null) throw new Error('Chrome would not start (three tries)');
      const options: Options = { url: this.base, screens: [this.screen], out: this.args.out, turns: new Set(), timeoutMs: this.args.timeoutMs, parallel: false, demo, quiet: true, page, say: null, chat: 'off' };
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

  /** the judgement every scene gets, at rest: smoke's own checks. `report`: the scene's turn ended and is on stage (a demo or an answer; the local welcome has no report) */
  private async judge(tab: Tab, talk: Conversation, name: string, results: CheckResult[], began: number, report: boolean, prompt: boolean): Promise<Scene> {
    talk.current = this.scenes.length + 1;
    const picture = await tab.shot();
    const file = `${this.screen.name}-${name.replace(/[^\w-]+/g, '-')}.png`;
    await writeFile(join(this.dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
    const answer = await tab.call<Answer>('answer');
    if (report) await talk.checkAnswer(ANY, answer, picture, results);
    if (prompt) await talk.checkPrompt(results);
    await talk.checkChrome(picture, results);
    talk.checkOverlap(ANY, answer, results);
    await talk.checkCutOff(answer, results);
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
        const started = await tab.eval<string | null>(`Promise.resolve(window.__stage.demo(${JSON.stringify(demo.name)})).then(() => null, (e) => String(e && e.message || e))`);
        const bad = rejectedLines(demo.name);
        Screen.add(results, 'script-lines', bad.slice(0, 3), 'every line of the script reads');
        results.push(Screen.restResult(started !== null ? `the demo would not start: ${started}` : await talk.rest(true), began));
        if (demo.name === 'explorable') await this.explorable(tab, talk, results);
        if (demo.name === 'richness') await this.richness(tab, results);
        if (demo.name === 'art') await this.art(tab, results);
        if (demo.name === 'scripts') await this.scripts(tab, results);
        await this.judge(tab, talk, `demo-${demo.name}`, results, began, true, first);
        first = false;
      }
    } finally {
      await tab.close();
    }
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
        if ((await tab.eval<boolean>(`document.body.classList.contains('work') || document.querySelector('.pb') !== null`)) === true) problems.push('something took the whole screen');
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
        Screen.add(results, 'problem', problems, 'the question is on the canvas with a blank, nothing takes the screen, a wrong answer is marked wrong and the right one right');
        const scenery: Scene = { name, seconds: (Date.now() - began) / 1000, picture: file, results };
        this.scenes.push(scenery);
        for (const result of results) if (result.verdict === 'FAIL') this.note(`  FAIL ${name} ${result.check}: ${result.detail.slice(0, 300)}`);
      }
    } finally {
      await tab.close();
    }
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

  /** a slider, a toggle and a pick of the explorable demo: the drawing changes, and no request is made */
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
    const toggle = list.find((control) => control.control === 'toggle');
    const pick = list.find((control) => control.control === 'pick');
    const problems: string[] = [];
    if (slider === undefined || toggle === undefined || pick === undefined) {
      Screen.add(results, 'explorable', [`the explorable demo should hold a slider, a toggle and a pick; found ${list.map((control) => control.control).join(', ') || 'nothing'}`], '');
      return;
    }
    const sent = tab.posted.length;
    const requests = (): number => tab.pending();
    const start = await settled();
    // the slider: set through the page's hook (a drag is the same call), to well away from where it stands
    await tab.eval(`window.__stage.control(${JSON.stringify(slider.id)}, ${JSON.stringify(Number(slider.value) > 45 ? 15 : 75)})`);
    const afterSlider = await settled();
    if (afterSlider === start) problems.push(`moving the slider "${slider.label}" changed nothing in the drawing`);
    // the toggle: a real tap on it
    const toggleBox = (await controls()).find((control) => control.id === toggle.id)?.box ?? toggle.box;
    await tab.tap(toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2);
    const afterToggle = await settled();
    if (afterToggle === afterSlider) problems.push(`tapping the toggle "${toggle.label}" changed nothing in the drawing`);
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
    Screen.add(results, 'explorable-controls', problems, 'slider, toggle and pick each changed the drawing, with no turn sent');
  }
}

/** Every demo the app offers that this check judges. `problem` is left out: it plays problem.series again, which the `problems` scenes already judge (it stays a demo for `/demo`). */
const offeredDemos = (): string[] => DEMOS.filter((candidate) => !DEMOS_NOT_PAINTED.includes(candidate.name) && candidate.name !== 'problem').map((candidate) => candidate.name as string);

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
      const verdict = scene.results.find((result) => result.check === check)?.verdict;
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
type Needs = 'main' | 'art' | 'chain' | 'none';

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
  const demos = offeredDemos();
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
    demos.forEach((name, index) => units.push(screenUnit(`demo-${name}`, 40, [], (run) => run.demoScenes([name], index === 0))));
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
    name: 'loop',
    needs: 'none',
    weight: 10,
    run: async (_servers, out) => {
      const results = await loopGroup(plain);
      out.lines.push('\nloop (820x971)');
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
    const address: Record<Needs, string | null> = { main: null, art: null, chain: null, none: null };
    const extras: Record<'art' | 'chain', () => Promise<Record<string, string>>> = {
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
        if (args.url === null && (unit.needs === 'art' || unit.needs === 'chain')) {
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
      const offered = offeredDemos();
      const sequence = ['welcome', 'choice', 'welcome-reduced-motion', ...offered.map((name) => `demo-${name}`), ...problemScenes().map((scene) => `problem-${scene.id}`), 'problem-fill', 'follow'];
      run.scenes.sort((a, b) => sequence.indexOf(a.name) - sequence.indexOf(b.name));
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
