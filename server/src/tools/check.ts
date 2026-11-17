// pnpm check: the free browser check. No model, no account, no network beyond localhost.
//
//   pnpm check [--url http://127.0.0.1:<port>] [--out <dir>] [--screens 1280x720,390x844] [--timeout <seconds>] [--allow-plain] [--sequential] [--quiet]
//
// With no --url it starts the server from the current build (run `pnpm build` first) on a free port with BRAIN=replay and a throwaway data folder, and
// stops it again. Then, in headless Chrome on each screen, it drives the page the way smoke does (smoke's own `Tab` and checks, not new ones):
//
//   welcome            the first-visit welcome (language/demos/overture.series) plays and settles with its intro line and every starter, found by the
//                      script's own words; it settles under reduced motion too
//   choice             a real tap on a starter is sent as a turn and the replay brain answers it, to rest
//   every demo         each demo the app offers (not DEMOS_NOT_PAINTED) is played by name and comes to rest
//   explorable         a slider, a toggle and a pick of the explorable demo change the drawing with no request to the server
//   problems           each `problem` of language/demos/problem.series is played at its own turn: the question is on the screen exactly as written, "What do we know?"
//                      lights its numbers, every way draws and its stepper adds a piece a step, a typed wrong then right answer is marked so (no turn sent, no model),
//                      and nothing overlaps or is cut off
//   ask                (tablet 1180x820 at two pixels, touch, the lens off and on) a finger tap on an ask's blank focuses its input, also under the Draw layer after a pen stroke;
//                      a short pen tap too, a pen drag writes; `fill` puts a wrong or right answer in the blank and opens the next stage; Send drawing names the ask (ask-check.ts)
//   lens               (flag on, ?lens=1; tablet 1180x820 at two pixels to the point with touch, and 390x844) a two-finger pinch to 2x, then a tap on a choice, a slider
//                      drag and a pen stroke each land on the right page point; 0 fits again; the pen draws without Draw, a short pen tap presses (lens-check.ts)
//
// Every scene is judged at rest by smoke's checks: answer on stage, no overlap, nothing cut off, readable chrome and prompt, no console errors,
// no failed requests. The renderer the page got is printed; a fall back to the plain renderer fails the check unless --allow-plain.
// It prints a table, saves a screenshot per scene in --out, and exits 1 on any failure. Nothing here is part of the server.

import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEMOS, DEMOS_NOT_PAINTED, LineReader } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { CHROME_CANDIDATES, repoRoot, sleep, stop, waitFor } from './explore-browser';
import { Conversation, Tab } from './smoke';
import { LENS_SCREENS, lensGroup } from './lens-check';
import { ASK_SCREEN, askGroup } from './ask-check';
import { DRAW_SCREEN, drawGroup } from './draw-check';
import { ART_FAKE_MS, ART_SCREEN, artGroup } from './art-check';
import { CONTINUE_SCREEN, continueFixtures, continueGroup } from './continue-check';
import { MEMORY_SCREEN, memoryGroup } from './memory-check';
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
}

function usage(message: string): never {
  process.stderr.write(`check: ${message}\nusage: pnpm check [--url http://127.0.0.1:<port>] [--out <dir>] [--screens 1280x720,390x844] [--timeout <seconds>] [--allow-plain] [--sequential] [--quiet]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) usage(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (['allow-plain', 'sequential', 'quiet'].includes(name)) flags.set(name, 'true');
    else {
      const value = argv[i + 1];
      if (!['url', 'out', 'screens', 'timeout'].includes(name)) usage(`unknown flag --${name}`);
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
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The server this check starts

interface Started {
  readonly url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

/** The server from the current build: BRAIN=replay, its own data folder and skills folder, a free port. Stopped by its handle. */
async function startServer(extra: Readonly<Record<string, string>> = {}): Promise<Started> {
  const root = repoRoot();
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('there is no build to check: run "pnpm build" first (or pass --url of a running server)');
  const scratch = await mkdtemp(join(tmpdir(), 'conduit-check-'));
  await mkdir(join(scratch, 'skills'), { recursive: true });
  const port = await freePort();
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

/** the scenes of language/demos/problem.series: each is one script to play, with the question and the answer it says */
function problemScenes(): { readonly id: string; readonly script: string; readonly question: string; readonly answer: string }[] {
  const source = readFileSync(fileURLToPath(import.meta.resolve('@conduit/language/demos/problem.series')), 'utf8');
  return source
    .split(/^scene\b/m)
    .slice(1)
    .flatMap((part) => {
      const found = /^problem\s+(\S+)\s+(?:[^|\n]*?)answer=(\S+)[^|\n]*\|\s*(.+?)\s*$/m.exec(part);
      if (found === null) return [];
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
    private readonly base: string,
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
   * The maths questions of problem.series, each as its own turn: the whole-screen workspace the page draws from one `problem` line.
   * Judged by what is on the page (its DOM), for what a person sees and presses; the generic checks do not see a workspace.
   */
  async problemScenes(): Promise<void> {
    const { tab, talk } = await this.open('', false);
    const q = (selector: string): Promise<unknown> => tab.eval(`document.querySelector(${JSON.stringify(selector)}) !== null`);
    const click = (selector: string): Promise<unknown> => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const read = <T>(expression: string): Promise<T> => tab.eval<T>(expression);
    try {
      await this.look(tab);
      for (const scene of problemScenes()) {
        const began = Date.now();
        const name = `problem-${scene.id}`;
        this.note(name);
        tab.drain();
        const results: CheckResult[] = [];
        const problems: string[] = [];
        const played = await tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(scene.script)})).then(() => null, (e) => String(e && e.message || e))`);
        results.push(Screen.restResult(played !== null ? `the script would not play: ${played}` : await talk.rest(true), began));
        const sent = tab.posted.length;
        // the workspace comes up by itself (work mode), full screen
        let up = false;
        for (let waited = 0; waited < 6000 && !up; waited += 200) {
          up = (await q('.pb')) === true;
          if (!up) await sleep(200);
        }
        if (!up) {
          results.push({ turn: 0, check: 'problem', verdict: 'FAIL', detail: 'no workspace came up for the problem line' });
          this.scenes.push({ name, seconds: (Date.now() - began) / 1000, picture: '', results });
          continue;
        }
        const picture = await tab.shot();
        const file = `${this.screen.name}-${name}.png`;
        await writeFile(join(this.dir, file), Buffer.from(picture.split(',')[1] ?? '', 'base64'));
        // 1. the hero question, exactly (the blank as ___)
        const hero = await read<string>(`[...document.querySelectorAll('.pb__question [data-kind]')].map((n) => (n.classList.contains('pb__tok--gap') ? ' ' : '') + (n.dataset.kind === 'blank' ? '___' : n.textContent)).join('')`);
        const want = scene.question.replace(/\\s+/g, ' ').trim();
        const got = hero.replace(/\\s+/g, ' ').trim();
        // spaced thousands and a sentence's marks are the question's own: compare as the question is written, with a word problem's final marks free
        const tidy = (text: string): string => text.replace(/\\s+([?.,!])/g, '$1').replace(/(\\d) (\\d{3})(?!\\d)/g, '$1$2');
        if (tidy(got) !== tidy(want)) problems.push(`the question on screen is "${got}", not "${want}"`);
        const heroBox = await read<{ readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly px: number }>(`(() => { const r = document.querySelector('.pb__question').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, px: parseFloat(getComputedStyle(document.querySelector('.pb__question')).fontSize) }; })()`);
        if (heroBox.px < 20) problems.push(`the question is set at ${heroBox.px.toFixed(0)} px: not large`);
        if (Math.abs(heroBox.x + heroBox.w / 2 - this.screen.width / 2) > 6) problems.push('the question is not centred');
        const blank = (await q('.pb__tok--blank')) === true;
        if (!blank) problems.push('the question has no blank');
        const supported = (await q('.pb__ways')) === true && (await read<boolean>(`!document.querySelector('.pb__ways').hidden`));
        // 2. "What do we know?" lights the numbers
        await click('[data-act=hint]');
        await click('[data-hint=know]');
        const lit = await read<{ readonly lit: readonly string[]; readonly nums: readonly string[] }>(`({ lit: [...document.querySelectorAll('.pb__question .is-lit')].map((n) => n.dataset.kind + ':' + n.textContent), nums: [...document.querySelectorAll('.pb__question [data-kind=num], .pb__question [data-kind=frac]')].map((n) => n.dataset.kind + ':' + n.textContent) })`);
        for (const number of lit.nums) if (!lit.lit.includes(number)) problems.push(`"What do we know?" did not light ${number}`);
        if (lit.lit.some((entry) => entry.startsWith('blank'))) problems.push('"What do we know?" lit the blank');
        await click('[data-hint=find]');
        const found = await read<string[]>(`[...document.querySelectorAll('.pb__question .is-lit')].map((n) => n.dataset.kind)`);
        if (found.join() !== 'blank') problems.push(`"What are we finding?" lit ${found.join(', ') || 'nothing'}, not the blank`);
        // 3. every way draws, and each step adds a piece
        const ways = await read<string[]>(`[...document.querySelectorAll('.pb [data-way]')].map((b) => b.dataset.way)`);
        if (supported && ways.length === 0) problems.push('a sum it can read offers no way');
        if (!supported && ways.length > 0) problems.push('a question it cannot read offers ways');
        for (const way of ways) {
          await click(`.pb [data-way=${way}]`);
          await sleep(250);
          const steps = Number(await read<string>(`document.querySelector('.pb').dataset.steps`));
          let before = 0;
          for (let step = 1; step <= steps; step += 1) {
            const pieces = await read<number>(`document.querySelectorAll('.pb__svg [data-step]:not(.pw-off)').length`);
            if (pieces <= before) problems.push(`${way}: step ${step} of ${steps} added no piece`);
            before = pieces;
            if (step < steps) {
              await click('.pb [data-act=next]');
              await sleep(60);
            }
          }
          if (steps < 2) problems.push(`${way}: only ${steps} step`);
          // the unknown is a "?" and the answer is never drawn: no text of the picture is the answer
          const words = await read<string[]>(`[...document.querySelectorAll('.pb__svg text:not(.pw-off)')].map((n) => n.textContent)`);
          if (words.some((word) => scene.answer !== '' && word.replace(/\\s/g, '') === scene.answer.replace(/\\s/g, '') && !scene.question.replace(/\\s/g, '').includes(scene.answer.replace(/\\s/g, '')))) problems.push(`${way}: the picture says the answer`);
          if (!words.some((word) => word.startsWith('?')) && steps > 0 && !['column'].includes(way)) problems.push(`${way}: the unknown is not a "?"`);
          // no overlap, nothing cut off: the picture's words at the last step
          const bad = await read<string[]>(`(() => { const svg = document.querySelector('.pb__svg').getBoundingClientRect(); const t = [...document.querySelectorAll('.pb__svg text:not(.pw-off)')].map((n) => ({ s: n.textContent, r: n.getBoundingClientRect() })); const out = []; for (const a of t) if (a.r.left < svg.left - 2 || a.r.right > svg.right + 2 || a.r.top < svg.top - 2 || a.r.bottom > svg.bottom + 2) out.push('cut off: ' + a.s); for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) { const a = t[i].r, b = t[j].r; const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (w > 3 && h > 3) out.push('overlap: ' + t[i].s + ' / ' + t[j].s); } return out; })()`);
          problems.push(...bad.map((entry) => `${way}: ${entry}`));
          await click(`.pb [data-way=${way}]`);
        }
        // 3b. the keyboard: a real tap (a finger on a phone, a click on a desk) on "Type it" and on the blank puts the focus on the real field, inside the gesture
        const centreOf = (selector: string): Promise<{ readonly x: number; readonly y: number } | null> => read<{ x: number; y: number } | null>(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n || n.hidden) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const focused = (): Promise<boolean> => read<boolean>(`document.activeElement && document.activeElement.classList.contains('pb__input')`);
        const typeAt = await centreOf('[data-act=type]');
        if (typeAt === null) problems.push('no Type it button');
        else {
          await tab.tap(typeAt.x, typeAt.y);
          if (!(await focused())) problems.push('a tap on Type it did not focus the field (no keyboard would open)');
          await click('[data-act=type]');
          const blankAt = await centreOf('.pb__tok--blank');
          if (blankAt !== null) {
            await tab.tap(blankAt.x, blankAt.y);
            if (!(await focused())) problems.push('a tap on the blank did not focus the field (no keyboard would open)');
          }
          await tab.eval(`document.activeElement && document.activeElement.blur()`);
        }
        // 4. a wrong then a right answer, typed: marked here, no turn sent
        if (await read<boolean>(`document.querySelector('.pb__input').hidden`)) await click('[data-act=type]');
        await tab.eval(`document.querySelector('.pb__input').focus()`);
        await tab.type('1');
        await click('[data-act=check]');
        await sleep(150);
        const wrong = await read<string>(`document.querySelector('.pb').dataset.verdict || ''`);
        if (wrong !== 'wrong') problems.push(`a wrong answer was marked "${wrong}"`);
        if (supported && (await read<boolean>(`document.querySelector('[data-act=show]').hidden`))) problems.push('Show me is not offered after a wrong try');
        await tab.eval(`document.querySelector('.pb__input').value = ''`);
        await tab.eval(`document.querySelector('.pb__input').focus()`);
        await tab.type(scene.answer);
        await click('[data-act=check]');
        await sleep(150);
        const right = await read<string>(`document.querySelector('.pb').dataset.verdict || ''`);
        if (right !== 'right') problems.push(`the right answer "${scene.answer}" was marked "${right}"`);
        if (tab.posted.length !== sent) problems.push(`marking sent ${tab.posted.length - sent} turn(s): it must not call a model`);
        // 5. the screen as it rests: nothing overlaps the question or the blank, nothing is cut off, the pen's toolbar and the buttons are clear
        const layout = await read<string[]>(`(() => { const vw = innerWidth, vh = innerHeight; const out = []; const boxes = {}; const get = (name, sel) => { const n = document.querySelector(sel); if (n && !n.hidden && n.getClientRects().length) boxes[name] = n.getBoundingClientRect(); }; get('question', '.pb__question'); get('line', '.pb__line'); get('controls', '.pb__controls'); get('hints', '.pb__hints'); get('ways', '.pb__ways'); get('stepper', '.pb__stepper'); get('done', '.work-button--done'); get('ask', '.work-button--ask'); get('pen', '.ink-stage__bar'); for (const [k, r] of Object.entries(boxes)) if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) out.push(k + ' is cut off'); const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2; const blank = document.querySelector('.pb__tok--blank').getBoundingClientRect(); const names = Object.keys(boxes); for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (hit(boxes[names[i]], boxes[names[j]])) out.push(names[i] + ' overlaps ' + names[j]); for (const k of ['controls', 'done', 'ask', 'pen', 'hints', 'ways']) if (boxes[k] && hit(boxes[k], blank)) out.push(k + ' covers the blank'); const q = document.querySelector('.pb__question'); if (q.scrollWidth > q.clientWidth + 2) out.push('the question is wider than the screen'); for (const b of document.querySelectorAll('.pb button')) { const r = b.getBoundingClientRect(); if (b.getClientRects().length && (r.height < 40 || r.width < 40)) out.push('a target is smaller than 40 px: ' + b.textContent); } return out; })()`);
        problems.push(...layout);
        // the message box stays where a person can reach it: visible, on screen, clear of the workspace, and typing into it works
        const box = await read<{ readonly ok: boolean; readonly why: string }>(`(() => { const i = document.querySelector('.prompt__input'); if (!i) return { ok: false, why: 'no message box' }; const r = i.getBoundingClientRect(); const pb = document.querySelector('.pb').getBoundingClientRect(); if (!r.width || !r.height) return { ok: false, why: 'the message box is hidden' }; if (r.bottom > innerHeight + 1 || r.top < 0) return { ok: false, why: 'the message box is off screen' }; if (Math.min(r.right, pb.right) - Math.max(r.left, pb.left) > 2 && Math.min(r.bottom, pb.bottom) - Math.max(r.top, pb.top) > 2) return { ok: false, why: 'the workspace covers the message box' }; return { ok: true, why: '' }; })()`);
        if (!box.ok) problems.push(box.why);
        else {
          await tab.eval(`document.querySelector('.prompt__input').focus()`);
          await tab.type('hello');
          const typed = await read<string>(`document.querySelector('.prompt__input').value`);
          if (typed !== 'hello') problems.push(`typing in the message box gave "${typed}" while a problem was on stage`);
          await tab.eval(`(() => { const i = document.querySelector('.prompt__input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`);
        }
        Screen.add(results, 'problem', problems.slice(0, 6), `question exact, numbers lit by the hint, ${ways.length === 0 ? 'plain workspace' : `${ways.length} way${ways.length === 1 ? '' : 's'} drawn step by step`}, wrong then right marked with no turn sent, nothing overlaps or is cut off`);
        const drained = tab.drain();
        Screen.add(results, 'no-console-errors', drained.consoleErrors.map((entry) => entry.text).slice(0, 3), 'nothing logged as an error');
        const scenery: Scene = { name, seconds: (Date.now() - began) / 1000, picture: file, results };
        this.scenes.push(scenery);
        for (const result of results) if (result.verdict === 'FAIL') this.note(`  FAIL ${name} ${result.check}: ${result.detail.slice(0, 300)}`);
      }
      // the brain puts an answer the person gave into the blank, in a later turn: `fill p3 | …`. It shows there and is marked locally, like a typed one; no model is asked
      const target = problemScenes().find((scene) => scene.id === 'p3') ?? problemScenes()[0];
      if (target !== undefined) {
        const began = Date.now();
        const name = 'problem-fill';
        this.note(name);
        tab.drain();
        const results: CheckResult[] = [];
        const problems: string[] = [];
        const play = (script: string): Promise<string | null> => tab.eval<string | null>(`Promise.resolve(window.__stage.playScript(${JSON.stringify(script)})).then(() => null, (e) => String(e && e.message || e))`);
        // a page of its own: the questions above were answered in this one, and what she did to a problem stays with it
        await tab.send('Page.reload');
        for (let waited = 0; waited < 40_000 && !(await tab.eval<boolean>('Boolean(window.__stage)').catch(() => false)); waited += 250) await sleep(250);
        await tab.eval('window.__stage.ready.then(() => true)');
        await play(target.script);
        for (let waited = 0; waited < 6000 && (await q('.pb')) !== true; waited += 200) await sleep(200);
        await talk.rest(true);
        await play(`fill ${target.id} | 1`);
        await talk.rest(true);
        await sleep(500);
        const afterWrong = await read<{ readonly up: boolean; readonly verdict: string; readonly blank: string }>(`({ up: !!document.querySelector('.pb'), verdict: (document.querySelector('.pb') || { dataset: {} }).dataset.verdict || '', blank: (document.querySelector('.pb .pb__written') || {}).textContent || '' })`);
        if (!afterWrong.up) problems.push('the workspace went away when the brain answered in a later turn');
        if (afterWrong.verdict !== 'wrong') problems.push(`fill of a wrong answer was marked "${afterWrong.verdict}"`);
        if (afterWrong.blank !== '1') problems.push(`the blank shows "${afterWrong.blank}", not what the brain put in it`);
        await play(`fill ${target.id} | ${target.answer}`);
        await talk.rest(true);
        await sleep(500);
        const afterRight = await read<{ readonly verdict: string; readonly blank: string }>(`({ verdict: (document.querySelector('.pb') || { dataset: {} }).dataset.verdict || '', blank: (document.querySelector('.pb .pb__written') || {}).textContent || '' })`);
        if (afterRight.verdict !== 'right') problems.push(`fill of the right answer was marked "${afterRight.verdict}"`);
        if (afterRight.blank !== target.answer) problems.push(`the blank shows "${afterRight.blank}", not "${target.answer}"`);
        // a run of underscores is not a blank: plain words never draw one
        await play('scene stack\nsay a | 2. ______ and 3. ________\nsay b | keep this');
        await talk.rest(true);
        await sleep(300);
        const fake = await read<string[]>(`window.__stage.elements().filter((e) => /_{3,}/.test(String(e.text || ''))).map((e) => e.text)`);
        if (fake.length > 0) problems.push(`a run of underscores was drawn as a blank: "${fake[0]}"`);
        Screen.add(results, 'problem', problems, 'a filled answer shows in the blank and is marked locally; a run of underscores is not drawn as a blank');
        this.scenes.push({ name, seconds: (Date.now() - began) / 1000, picture: '', results });
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

/** The demos the app offers, dealt out to `JOBS` tabs that run side by side (each demo takes the time its own script takes, so they are what the check waits for). */
const DEMO_JOBS = 3;

async function runScreen(args: Args, base: string, screen: Args['screens'][number], welcome: Welcome): Promise<ScreenRun> {
  const dir = join(args.out, screen.name);
  await mkdir(dir, { recursive: true });
  const began = Date.now();
  const run = new Screen(args, base, screen, dir, welcome);
  const offered = DEMOS.filter((candidate) => !DEMOS_NOT_PAINTED.includes(candidate.name)).map((candidate) => candidate.name as string);
  const jobs: { readonly name: string; readonly go: () => Promise<void> }[] = [
    { name: 'the welcome', go: () => run.welcomeScene(false) },
    { name: 'the welcome under reduced motion', go: () => run.welcomeScene(true) },
    { name: 'problems', go: () => run.problemScenes() },
    ...Array.from({ length: DEMO_JOBS }, (_, job) => ({ name: `demos ${job + 1}`, names: offered.filter((_name, index) => index % DEMO_JOBS === job) })).map((job, index) => ({ name: job.name, go: () => run.demoScenes(job.names, index === 0) })),
  ];
  const stopped: string[] = [];
  await Promise.all(
    jobs.map((job) =>
      job.go().catch((error: unknown) => {
        const why = `${job.name}: ${error instanceof Error ? error.message : String(error)}`;
        stopped.push(why);
        process.stdout.write(`[${screen.name}] ABORTED ${why}\n`);
      }),
    ),
  );
  // the order a reader expects: the welcome, the choice, the reduced-motion welcome, then the demos as the app lists them
  const order = ['welcome', 'choice', 'welcome-reduced-motion', ...offered.map((name) => `demo-${name}`), ...problemScenes().map((scene) => `problem-${scene.id}`), 'problem-fill'];
  run.scenes.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  if (run.renderer !== 'unknown') {
    const webgl = run.renderer === 'three';
    run.scenes[0]?.results.push({ turn: 0, check: 'renderer', verdict: webgl || args.allowPlain ? 'PASS' : 'FAIL', detail: webgl ? 'the page got WebGL (three)' : `the page fell back to the "${run.renderer}" renderer: WebGL did not run in this Chrome` });
  }
  return { screen, scenes: run.scenes, renderer: run.renderer, gpu: run.gpu, seconds: (Date.now() - began) / 1000, aborted: stopped.length === 0 ? null : stopped.join(' | ') };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The report

const COLUMNS: readonly (readonly [string, string])[] = [
  ['rest', 'rest'],
  ['script-lines', 'lines'],
  ['welcome-words', 'words'],
  ['choice-sent', 'sent'],
  ['explorable-controls', 'ctrls'],
  ['problem', 'problem'],
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!CHROME_CANDIDATES.some((path) => existsSync(path))) usage('no Chrome found: set CHROME_BIN to a Chrome or Chromium executable');
  const welcome = readWelcome();
  await mkdir(args.out, { recursive: true });
  const began = Date.now();
  let server: Started | null = null;
  let failures = 0;
  const stopServer = async (): Promise<void> => {
    const running = server;
    server = null;
    await running?.stop();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      process.stderr.write(`check: stopped by ${signal}\n`);
      void stopServer().finally(() => process.exit(2));
    });
  }
  try {
    server = args.url === null ? await startServer() : null;
    const base = args.url ?? (server as Started | null)?.url;
    if (base === undefined) throw new Error('no server to check');
    if (args.url !== null && !(await fetch(`${base}/api/health`).then((response) => response.ok, () => false))) usage(`nothing answers at ${base}/api/health`);
    process.stdout.write(`check: ${base}${args.url === null ? ' (started here, BRAIN=replay)' : ''}, screens ${args.screens.map((screen) => screen.name).join(', ')}, pictures in ${args.out}\n`);
    const runs: ScreenRun[] = [];
    if (args.sequential) for (const screen of args.screens) runs.push(await runScreen(args, base, screen, welcome));
    else runs.push(...(await Promise.all(args.screens.map((screen) => runScreen(args, base, screen, welcome)))));
    const summary: unknown[] = [];
    for (const run of runs) {
      process.stdout.write(`\n${table(run)}\n`);
      for (const scene of run.scenes) {
        for (const result of scene.results) {
          if (result.verdict === 'FAIL') {
            failures += 1;
            process.stdout.write(`  FAIL ${run.screen.name} ${scene.name} ${result.check}: ${result.detail}\n`);
          }
        }
      }
      if (run.aborted !== null) {
        failures += 1;
        process.stdout.write(`  FAIL ${run.screen.name} stopped: ${run.aborted}\n`);
      }
      process.stdout.write(`  ${run.screen.name}: ${run.seconds.toFixed(0)} s, ${run.scenes.length} scenes\n`);
      summary.push({ screen: run.screen.name, renderer: run.renderer, gpu: run.gpu, aborted: run.aborted, seconds: run.seconds, scenes: run.scenes });
    }
    // the lens group: the flag is on for these, and only these
    const lens: unknown[] = [];
    for (const screen of LENS_SCREENS) {
      const dir = join(args.out, `lens-${screen.name}`);
      try {
        const scenes = await lensGroup(base, screen, dir, args.timeoutMs, (text) => (args.quiet ? undefined : process.stdout.write(`[lens ${screen.name}] ${text}\n`)));
        process.stdout.write(`\nlens ${screen.name} (dpr ${screen.dpr}, touch)\n`);
        for (const scene of scenes) {
          for (const result of scene.results) {
            process.stdout.write(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${scene.name} ${result.check}: ${result.detail}\n`);
            if (result.verdict === 'FAIL') failures += 1;
          }
        }
        lens.push({ screen: screen.name, scenes });
      } catch (error) {
        failures += 1;
        process.stdout.write(`  FAIL lens ${screen.name} stopped: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    // the ask group: a staged chain worked by a finger and a pen on the tablet, and filled in by the brain's `fill` lines
    const asks: unknown[] = [];
    try {
      const scenes = await askGroup(base, ASK_SCREEN, join(args.out, 'ask'), args.timeoutMs, (text) => (args.quiet ? undefined : process.stdout.write(`[ask] ${text}\n`)));
      process.stdout.write(`\nask ${ASK_SCREEN.name} (dpr ${ASK_SCREEN.dpr}, touch)\n`);
      for (const scene of scenes) {
        for (const result of scene.results) {
          process.stdout.write(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${scene.name} ${result.check}: ${result.detail}\n`);
          if (result.verdict === 'FAIL') failures += 1;
        }
      }
      asks.push({ screen: ASK_SCREEN.name, scenes });
    } catch (error) {
      failures += 1;
      process.stdout.write(`  FAIL ask stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    // the draw group: Draw opened on a phone held in landscape (719x356 at three pixels to the point), with the lens off and on; the screen must stay lit
    try {
      process.stdout.write(`\ndraw ${DRAW_SCREEN.name} (dpr ${DRAW_SCREEN.dpr}, touch)\n`);
      for (const page of ['', 'lens=1']) {
        const scenes = await drawGroup(base, DRAW_SCREEN, join(args.out, 'draw'), args.timeoutMs, (text) => (args.quiet ? undefined : process.stdout.write(`[draw] ${text}\n`)), page);
        for (const scene of scenes) {
          for (const result of scene.results) {
            process.stdout.write(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${scene.name} ${result.check}: ${result.detail}\n`);
            if (result.verdict === 'FAIL') failures += 1;
          }
        }
      }
    } catch (error) {
      failures += 1;
      process.stdout.write(`  FAIL draw stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    // the art-maker group: a server of its own whose studio has a fake maker (no model), so a drawing the shelf lacks arrives a few seconds after its placeholder
    const arts: unknown[] = [];
    let artServer: Started | null = null;
    try {
      artServer = args.url === null ? await startServer({ ART_MAKER: 'fake', ART_FAKE_MS: String(ART_FAKE_MS), ART_FAKE_STAGES: 'on' }) : null;
      const artBase = artServer?.url ?? process.env['ART_CHECK_URL'] ?? null;
      if (artBase === null) process.stdout.write('\nart-maker: skipped (--url was given and ART_CHECK_URL names no server with ART_MAKER=fake)\n');
      else {
        const scenes = await artGroup(artBase, ART_SCREEN, join(args.out, 'art-maker'), args.timeoutMs, (text) => (args.quiet ? undefined : process.stdout.write(`[art] ${text}\n`)));
        process.stdout.write(`\nart-maker ${ART_SCREEN.name}\n`);
        for (const scene of scenes) {
          for (const result of scene.results) {
            process.stdout.write(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${scene.name} ${result.check}: ${result.detail}\n`);
            if (result.verdict === 'FAIL') failures += 1;
          }
        }
        arts.push({ screen: ART_SCREEN.name, scenes });
      }
    } catch (error) {
      failures += 1;
      process.stdout.write(`  FAIL art-maker stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      await artServer?.stop();
    }
    // the drawing-memory group: scripts played as turns of the server's own path; undo and restore give the boxes back, parts of two turns mix
    try {
      const scenes = await memoryGroup(base, MEMORY_SCREEN, join(args.out, 'memory'), args.timeoutMs, (text) => (args.quiet ? undefined : process.stdout.write(`[${text}]\n`)));
      process.stdout.write(`\nmemory ${MEMORY_SCREEN.name}\n`);
      for (const scene of scenes) {
        for (const result of scene.results) {
          process.stdout.write(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${scene.name} ${result.check}: ${result.detail}\n`);
          if (result.verdict === 'FAIL') failures += 1;
        }
      }
    } catch (error) {
      failures += 1;
      process.stdout.write(`  FAIL memory stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    // the continuation group: a fake brain ends its answer with `refine | what next` five times; the server runs it again each time; a message or Stop takes over
    if (args.url === null) {
      let chain: Started | null = null;
      try {
        chain = await startServer({ REFINE: 'on', REPLAY_CASE: await continueFixtures() });
        const scenes = await continueGroup(chain.url, CONTINUE_SCREEN, join(args.out, 'continue'), args.timeoutMs, (text) => (args.quiet ? undefined : process.stdout.write(`[${text}]\n`)));
        process.stdout.write(`\ncontinue ${CONTINUE_SCREEN.name}\n`);
        for (const scene of scenes) {
          for (const result of scene.results) {
            process.stdout.write(`  ${result.verdict === 'PASS' ? 'ok  ' : result.verdict} ${scene.name} ${result.check}: ${result.detail}\n`);
            if (result.verdict === 'FAIL') failures += 1;
          }
        }
      } catch (error) {
        failures += 1;
        process.stdout.write(`  FAIL continue stopped: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        await chain?.stop();
      }
    }
    await writeFile(join(args.out, 'check.json'), JSON.stringify({ url: base, at: new Date().toISOString(), failures, screens: summary, lens, asks, arts }, null, 2));
  } catch (error) {
    failures += 1;
    process.stdout.write(`check: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await stopServer();
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
