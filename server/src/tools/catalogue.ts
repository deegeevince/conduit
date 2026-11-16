// pnpm catalogue: the failure catalogue. Every real failure we have met is a case (catalogue/cases/*.json); the cases run as one command and the result is a scoreboard.
//
//   pnpm catalogue                         replay every case at 1280x720 and 390x844 on the build in this checkout (deterministic, free)
//   pnpm catalogue --live [--url <server>] [--max-usd 3]   send each case's prompt to a real brain; the same checks plus the critic's tier-1 gates
//   pnpm catalogue record                  (re)build <DATA_DIR>/catalogue/recordings/*.json from the owner's logs (read only) and the scenario fixtures
//   pnpm catalogue prepare <branch> [name] a throwaway worktree of a branch head, installed, built, with the replay brain laid over it (prints its path)
//   pnpm catalogue matrix <label,label,..> the per-branch matrix from catalogue/results/<label>.json, written to catalogue/MATRIX.md
//
//   --only a,b      only these cases          --screens 1280x720,390x844       --label head   the name of this run (catalogue/results/<label>.json)
//   --build <dir>   run the server of another worktree (a branch under test); the browser and the checks are always this checkout's
//   --port 4870     the replay server's port (4870-4879)       --jobs 3  tabs at once       --compare <label|file>   which cases flipped since that run
//   --no-board      do not rewrite catalogue/SCOREBOARD.md     --data <dir>    the data dir (default DATA_DIR)
//
// What goes where. The repo holds only what is not private: the case files (neutral prompts, family, checks, date found) and verdict-only results. The brain's recorded lines
// can echo private content, so they live under <DATA_DIR>/catalogue/recordings/ and so do each run's pictures and check details (<DATA_DIR>/catalogue/runs/).
//
// A cell: PASS (everything the case asks and every general gate), OWN (the case's own checks pass but a general gate is red), FAIL, ERR (the run broke), NOREC (no recording).
// A case is green when it PASSES at both sizes (and live, when a live run exists).

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Conversation, Tab } from './smoke';
import type { Answer, CheckResult, LiveElement, Options, Probe } from './smoke';
import { repoRoot, sleep, waitFor } from './explore-browser';

// ---------------------------------------------------------------------------------------------------------------------------------
// Cases

interface Source {
  readonly log?: string;
  readonly turns?: readonly string[];
  readonly scenario?: string;
  readonly index?: number;
  readonly logs?: 'qa';
  /** the lines the brain wrote in its first pass as it wrote them, the refused ones too (a turn whose trouble was in what was refused) */
  readonly asWritten?: boolean;
}
type Spec = { readonly k: string } & Record<string, unknown>;
type Action = { readonly a: string } & Record<string, unknown>;
interface CaseTurn {
  /** what is said; with `tap`, only what the turn is called */
  readonly say: string;
  /** a real tap on the choice (or control) on the stage with this label, instead of typing `say` */
  readonly tap?: string;
  readonly source: Source;
  /** actions before the turn begins (put the open document away so the stage can be tapped; SK1: hold a skill from the [+] menu) */
  readonly pre?: readonly Action[];
  readonly do?: readonly Action[];
  /** HI1. What is done in a live run instead of `do`: a live brain's ids and answers are its own */
  readonly liveDo?: readonly Action[];
  /** HI1. The checks of a live run, when they differ from the replay's (the brain's own breakdown has its own number of steps) */
  readonly liveCheck?: readonly Spec[];
  readonly check?: readonly Spec[];
}
interface Case {
  readonly id: string;
  readonly title: string;
  readonly family: string;
  readonly owner: string;
  readonly kind: 'draw' | 'flow' | 'ui';
  readonly found: string;
  readonly note: string;
  /** the checks that are this case's own: its per-turn `check` entries and these general ones */
  readonly own: readonly string[];
  /** false: the case reloads or leaves the stage, so the general gates do not apply */
  readonly generic?: boolean;
  /** `chat`: the frozen /chat surface; not run unless --chat */
  readonly surface?: 'main' | 'chat';
  readonly priority?: 'core' | 'low';
  /** SK1. `only`: the case reads what a real brain was sent (the brief), so a replay cannot run it; it is left out of replays and run with `--live` */
  readonly live?: 'only';
  readonly turns: readonly CaseTurn[];
}

interface Args {
  readonly sub: 'run' | 'record' | 'prepare' | 'matrix';
  readonly rest: readonly string[];
  readonly mode: 'replay' | 'live';
  readonly only: readonly string[] | null;
  readonly screens: readonly { readonly name: string; readonly width: number; readonly height: number }[];
  readonly label: string;
  readonly build: string;
  readonly port: number;
  readonly jobs: number;
  readonly compare: string | null;
  readonly board: boolean;
  readonly data: string;
  readonly url: string | null;
  readonly maxUsd: number;
  readonly logs: string;
  readonly qaLogs: string | null;
  readonly chat: boolean;
  readonly timeoutMs: number;
}

const root = repoRoot();
const casesDir = join(root, 'catalogue', 'cases');
const resultsDir = join(root, 'catalogue', 'results');

function usage(message: string): never {
  process.stderr.write(`catalogue: ${message}\nusage: pnpm catalogue [record|prepare <branch>|matrix <labels>] [--live] [--only a,b] [--label head] [--build <dir>] [--port 4870] [--jobs 3] [--compare <label>] [--max-usd 3] [--url <server>] [--no-board]\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (['live', 'replay', 'no-board', 'quiet', 'chat'].includes(name)) flags.set(name, 'true');
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
      flags.set(name, value);
      i += 1;
    }
  }
  const sub = rest[0] === 'record' || rest[0] === 'prepare' || rest[0] === 'matrix' ? rest.shift() : 'run';
  const screens = (flags.get('screens') ?? '1280x720,390x844').split(',').map((text) => {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(text.trim());
    if (match === null) usage(`bad screen ${text}`);
    return { name: text.trim(), width: Number(match[1]), height: Number(match[2]) };
  });
  const port = Number(flags.get('port') ?? 4870);
  if (port < 4870 || port > 4879) usage('--port must be 4870-4879');
  return {
    sub: sub as Args['sub'],
    rest,
    mode: flags.has('live') ? 'live' : 'replay',
    only: flags.has('only') ? (flags.get('only') as string).split(',').map((s) => s.trim()) : null,
    screens,
    label: flags.get('label') ?? (flags.has('live') ? 'live' : 'head'),
    build: resolve(flags.get('build') ?? root),
    port,
    jobs: Number(flags.get('jobs') ?? 3),
    compare: flags.get('compare') ?? null,
    board: !flags.has('no-board'),
    data: resolve(flags.get('data') ?? process.env['DATA_DIR'] ?? join(homedir(), '.conduit-catalogue')),
    url: flags.get('url')?.replace(/\/+$/, '') ?? null,
    maxUsd: Number(flags.get('max-usd') ?? 3),
    logs: resolve(flags.get('logs') ?? join(homedir(), 'Library', 'Application Support', 'Conduit', 'logs')),
    qaLogs: flags.get('qa-logs') ?? process.env['QA_LOGS'] ?? null,
    chat: flags.has('chat'),
    timeoutMs: Number(flags.get('timeout') ?? 180) * 1000,
  };
}

/**
 * Two cases may carry the same prompt with different recorded answers, and the replay brain plays the first recording whose words match: the second case would then be shown
 * the first one's answer. In a replay each such prompt carries one invisible zero-width space more than the case before it, in the prompt sent and in the recording it matches.
 */
function twinMark(caseId: string, say: string): string {
  const all = readdirSync(casesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(casesDir, name), 'utf8')) as Case);
  const earlier = all.slice(0, Math.max(0, all.findIndex((candidate) => candidate.id === caseId))).filter((candidate) => candidate.turns.some((turn) => turn.say === say));
  return '\u200b'.repeat(earlier.length);
}

function loadCases(only: readonly string[] | null, chat = true, liveRun = false): Case[] {
  const all = readdirSync(casesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(casesDir, name), 'utf8')) as Case);
  const unknown = (only ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) usage(`no case ${unknown.join(', ')}`);
  return all.filter((c) => (only === null || only.includes(c.id)) && (chat || c.surface !== 'chat' || (only?.includes(c.id) ?? false)) && (liveRun || c.live !== 'only'));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Recordings: the brain's lines per case turn, private, outside the repo

interface Recorded {
  readonly id: string;
  readonly turns: readonly { readonly match: string; readonly script: string }[];
}
const recDir = (args: Args): string => join(args.data, 'catalogue', 'recordings');

async function recordAll(args: Args): Promise<void> {
  await mkdir(recDir(args), { recursive: true });
  const logCache = new Map<string, Record<string, unknown>[]>();
  const readLog = (session: string): Record<string, unknown>[] => {
    let rows = logCache.get(session);
    if (rows === undefined) {
      const file = session.startsWith('/') ? `${session}.jsonl` : join(args.logs, `${session}.jsonl`);
      rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
      logCache.set(session, rows);
    }
    return rows;
  };
  let wrote = 0;
  for (const c of loadCases(args.only, true, true)) {
    const turns: { match: string; script: string }[] = [];
    let missing = '';
    for (const turn of c.turns) {
      let script = '';
      if (turn.source.log !== undefined) {
        let wanted = turn.source.turns?.[0] ?? '';
        const session = turn.source.logs === 'qa' ? `${args.qaLogs ?? ''}/${turn.source.log}`.replace(/^\/+/, '/') : turn.source.log;
        if (turn.source.logs === 'qa') {
          if (args.qaLogs === null) {
            missing = 'qa logs (--qa-logs <dir>)';
            continue;
          }
          const first = readLog(session).find((row) => row['type'] === 'turn' && (row['input'] as { kind?: string } | undefined)?.kind === 'prompt');
          wanted = String(first?.['turn'] ?? '');
        }
        if (turn.source.asWritten === true) {
          const rows = readLog(session).filter((row) => row['turn'] === wanted);
          const end = rows.findIndex((row) => row['type'] === 'usage' && row['pass'] === 1);
          script = (end < 0 ? rows : rows.slice(0, end))
            .filter((row) => (row['type'] === 'line' && (row['pass'] === 1 || row['pass'] === undefined)) || row['type'] === 'reject')
            .map((row) => String(row['type'] === 'reject' ? row['raw'] : row['text']))
            .join('\n');
        } else
        script = readLog(session)
          .filter((row) => row['type'] === 'line' && row['turn'] === wanted && (row['pass'] === 1 || row['pass'] === undefined))
          .map((row) => String(row['text']))
          .join('\n');
      } else if (turn.source.scenario !== undefined) {
        const file = join(root, 'server', 'src', 'tools', 'scenarios', `${turn.source.scenario}.json`);
        script = existsSync(file) ? ((JSON.parse(readFileSync(file, 'utf8')) as { turns: { script: string }[] }).turns[turn.source.index ?? 0]?.script ?? '') : '';
      }
      if (script.trim() === '') missing = `${turn.source.log ?? turn.source.scenario}/${turn.source.turns?.[0] ?? turn.source.index}`;
      turns.push({ match: turn.say, script: `${script}\n` });
    }
    if (missing !== '') {
      process.stdout.write(`record ${c.id}: NO LINES for ${missing} (the log is not on this machine?)\n`);
      continue;
    }
    await writeFile(join(recDir(args), `${c.id}.json`), JSON.stringify({ id: c.id, turns } satisfies Recorded, null, 1));
    wrote += 1;
    process.stdout.write(`record ${c.id}: ${turns.map((t) => `${t.script.split('\n').length - 1} lines`).join(' + ')}\n`);
  }
  process.stdout.write(`recorded ${wrote} case(s) into ${recDir(args)}\n`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The page, read

interface Ctl {
  readonly id: string;
  readonly control: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly min: number;
  readonly value: unknown;
  readonly valueText: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** how a pick shows its options, and the painter's own box for each part of the control (`option:<n>`, `back`, `next`) */
  readonly form?: string | null;
  readonly parts?: readonly { readonly part: string; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }[];
  /** HI1. An ask of the stage: how it stands (what a test reads; never what it accepts) */
  readonly askState?: { readonly verdict: 'open' | 'wrong' | 'right' | 'shown'; readonly tries: number; readonly hints: number; readonly chosen: number; readonly locked: boolean };
}
interface Cx {
  readonly tab: Tab;
  readonly c: Conversation;
  readonly screen: Args['screens'][number];
  readonly dir: string;
  readonly mobile: boolean;
  answer: Answer;
  picture: string;
  /** what the page showed at the moment of a mid-turn watch */
  readonly watched: { showAllOver: string | null; pillSeen: number };
  before: string;
  words: string;
  early: string[];
  /** what the screen held when the turn began (`screenSig`) */
  sig: string;
}
type Verdict = 'PASS' | 'FAIL' | 'SKIP';
interface Res {
  readonly check: string;
  readonly verdict: Verdict;
  readonly detail: string;
}
const area = (b: { width: number; height: number }): number => Math.max(0, b.width) * Math.max(0, b.height);
const inter = (a: LiveElement['box'], b: LiveElement['box']): number => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const centre = (b: LiveElement['box']): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const shown = (a: Answer): LiveElement[] => a.live.filter((e) => e.kind === 'text' && e.phase === 'on' && e.opacity > 0.3 && area(e.box) > 0);
const res = (check: string, bad: readonly string[], good: string): Res => ({ check, verdict: bad.length === 0 ? 'PASS' : 'FAIL', detail: bad.length === 0 ? good : bad.slice(0, 4).join('; ') + (bad.length > 4 ? ` and ${bad.length - 4} more` : '') });
const floorOf = (cx: Cx): number => (cx.mobile ? 9 : 11.75);

async function controls(tab: Tab): Promise<Ctl[]> {
  return tab.eval<Ctl[]>(`window.__stage.controls().map((c) => ({ id: c.id, control: c.control, label: c.label, options: c.options, min: c.min, value: c.value, valueText: c.valueText, box: c.box, form: c.form, parts: c.parts, askState: c.askState }))`);
}

/** What a person sees, as one string: the open document's words when the lesson view is up, else the painted stage's words and its choices. */
async function screenSig(tab: Tab): Promise<string> {
  return tab.eval<string>(
    `(() => { const d = document.querySelector('.stage__document'); const r = d ? d.getBoundingClientRect() : null; const up = !!d && getComputedStyle(d).display !== 'none' && r.width > 4 && r.height > 4 && !!d.querySelector('iframe'); if (up) return 'document:open'; const w = (window.__stage.elements() || []).filter((e) => e.phase === 'on' && e.opacity > 0.3).map((e) => String(e.text || '')).join('|'); return 'stage:' + w; })()`,
  );
}

/** every general gate: the words are in their shapes, labels on their part's side, nothing over anything, readable, whole */
async function generic(cx: Cx): Promise<Res[]> {
  const out: Res[] = [];
  // first, while the page is as the answer left it: the other checks measure and tap, and an app is judged as a person would meet it
  out.push(await appWorks(cx));
  const rows: CheckResult[] = [];
  const step = { n: 1, say: null, name: 'case', expects: 'any' } as const;
  await cx.c.checkAnswer(step, cx.answer, cx.picture, rows);
  cx.c.checkOverlap(step, cx.answer, rows);
  await cx.c.checkCutOff(cx.answer, rows);
  const pick = (name: string): CheckResult | undefined => rows.find((r) => r.check === name);
  const a = pick('answer-on-stage');
  if (a !== undefined) out.push({ check: 'answer-on-stage', verdict: a.verdict, detail: a.detail });
  const o = pick('no-overlap');
  if (o !== undefined) out.push({ check: 'no-overlap', verdict: o.verdict, detail: o.detail });
  const cut = pick('nothing-cut-off');
  if (cut !== undefined) out.push({ check: 'nothing-cut-off', verdict: cut.verdict, detail: cut.detail });
  out.push(legible(cx));
  out.push(labelsSide(cx));
  out.push(wordsInShapes(cx));
  out.push(await earlierWorks(cx));
  const picks = await pickConsistent(cx);
  if (picks !== null) out.push(picks);
  return out;
}

const squashed = (text: string): string => text.trim().toLowerCase().replace(/[\s-]+/g, '');
const plainWords = (text: string): string => text.replace(/\*/g, '').replace(/\s+/g, ' ').trim();

/**
 * `pick-consistent`, for every case with a pick: each option is tapped with a real tap, and everything the answer binds to it holds on the stage after it: the words of a bound
 * `correct` are what is drawn, the rows a `set <table>.row<n> mark=...` marks are marked, a bound `set` has its values. It ends back on the first option, which must hold too.
 * What is bound is read from the answer's own lines, so a bind that came before the thing it changes, or a plain line written after it, is judged the same.
 */
async function pickConsistent(cx: Cx): Promise<Res | null> {
  const name = 'pick-consistent';
  const picks = (await controls(cx.tab)).filter((c) => c.control === 'pick' && c.options.length > 1);
  if (picks.length === 0) return null;
  const binds = cx.answer.script
    .split('\n')
    .map((line) => /^bind\s+(\S+?)=(?:"([^"]*)"|(.+?))\s*\|\s*(.*)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ control: m[1] as string, option: (m[2] ?? m[3] ?? '').trim(), change: (m[4] ?? '').trim() }));
  const bad: string[] = [];
  let tapped = 0;
  let judged = 0;
  let unreachable = 0;
  const view = cx.screen;
  for (const pick of picks) {
    const form = pick.form ?? null;
    const reach = async (want: number): Promise<boolean> => {
      for (let guard = 0; guard < pick.options.length + 2; guard += 1) {
        const now = (await controls(cx.tab)).find((c) => c.id === pick.id);
        if (now === undefined) return false;
        const at = typeof now.value === 'number' ? now.value : 1;
        if (at === want) return true;
        const part = form === 'steps' ? (at < want ? 'next' : 'back') : `option:${want}`;
        const box = (now.parts ?? []).find((p) => p.part === part)?.box;
        if (box === undefined || box.x < 0 || box.y < 0 || box.x + box.width > view.width || box.y + box.height > view.height) return false;
        await cx.tab.tap(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(700);
        if (form !== 'steps') return ((await controls(cx.tab)).find((c) => c.id === pick.id)?.value ?? 0) === want;
      }
      return false;
    };
    for (const index of [...pick.options.keys(), 0]) {
      const want = index + 1;
      if (!(await reach(want))) {
        unreachable += 1;
        continue;
      }
      tapped += 1;
      await sleep(500);
      const named = pick.options[index] ?? '';
      const mine = binds.filter((b) => b.control === pick.id && (squashed(b.option) === squashed(named) || b.option.trim() === String(want)));
      const bound = await cx.tab.eval<{ id: string; words: string | null; marks: string[]; sets: string[] }[]>(`window.__stage.bindings()`);
      const live = await cx.tab.eval<{ id: string; text: string; phase: string }[]>(`window.__stage.elements().map((e) => ({ id: e.id, text: e.text, phase: e.phase }))`);
      for (const b of mine) {
        const corrected = /^correct\s+(\S+)\s*\|\s*(.*)$/.exec(b.change);
        const marked = /^set\s+(\S+?)\.(row\d+|cell\S*)\s+(.*)$/.exec(b.change);
        const set = /^set\s+(\S+)\s+(.*)$/.exec(b.change);
        if (corrected !== null) {
          const drawn = live.filter((e) => e.id === corrected[1] && e.phase === 'on').map((e) => plainWords(e.text));
          if (drawn.length === 0) continue;
          judged += 1;
          const expected = plainWords(corrected[2] ?? '');
          if (!drawn.some((d) => d === expected || d.includes(expected) || expected.includes(d))) bad.push(`option "${named}": ${corrected[1]} shows "${(drawn[0] ?? '').slice(0, 40)}" not "${expected.slice(0, 40)}"`);
        } else if (marked !== null) {
          const mark = /mark=(\w+)/.exec(marked[3] ?? '')?.[1] ?? 'box';
          if (mark === 'none') continue;
          judged += 1;
          const held = bound.find((e) => e.id === marked[1]);
          if (held === undefined || !held.marks.some((m) => m === `${marked[2]}:${mark}`)) bad.push(`option "${named}": ${marked[1]}.${marked[2]} is not marked ${mark}`);
        } else if (set !== null) {
          const keys = [...(set[2] ?? '').matchAll(/(\w+)=/g)].map((m) => m[1] as string);
          const held = bound.find((e) => e.id === set[1]);
          if (held === undefined) continue;
          judged += 1;
          const missing = keys.filter((k) => !held.sets.some((v) => v.startsWith(`${k}=`)));
          if (missing.length > 0) bad.push(`option "${named}": ${set[1]} lacks ${missing.join(', ')}`);
        }
      }
    }
  }
  if (tapped === 0) return { check: name, verdict: 'PASS', detail: `no option was in reach to tap (${unreachable}); nothing judged` };
  return res(name, bad, `${tapped} real taps over ${picks.length} pick(s), ${judged} bound effects held${unreachable > 0 ? ` (${unreachable} options out of reach)` : ''}`);
}

/**
 * "A live app on stage works": a real click on its first button (or, with no button, a real drag of its first draggable) changes the app, and the stage does not log
 * it as its own tap. The app is in a sandboxed frame the page cannot read, so it is read here through the browser's own debugging door for that frame (its buttons and where
 * they are), and pressed with real input at the screen point they are at.
 */
async function appWorks(cx: Cx): Promise<Res> {
  const name = 'app-works';
  const { tab } = cx;
  const page = await tab.eval<{ app: { id: string; text: string } | null; frame: { x: number; y: number; width: number; height: number; scale: number; pe: string; vis: string } | null; taps: number }>(
    `(() => { const el = (window.__stage.elements() || []).find((e) => e.kind === 'structure' && e.phase === 'on' && /^live app/.test(String(e.text))); const f = document.querySelector('iframe[data-surface]'); const r = f ? f.getBoundingClientRect() : null; const cs = f ? getComputedStyle(f) : null; return { app: el ? { id: el.id, text: String(el.text) } : null, frame: f ? { x: r.left, y: r.top, width: r.width, height: r.height, scale: f.offsetWidth > 0 ? r.width / f.offsetWidth : 1, pe: cs.pointerEvents, vis: cs.visibility } : null, taps: window.__stage.events().filter((e) => e.type === 'tap').length }; })()`,
  );
  if (page.app === null && page.frame === null) return { check: name, verdict: 'PASS', detail: 'no live app on stage' };
  // the frame may still be settling into its room (it re-lays-out when the words arrive beside it): it is read again until two readings agree
  const frameRect = (): Promise<string> => tab.eval<string>(`(() => { const f = document.querySelector('iframe[data-surface]'); if (!f) return ''; const r = f.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, f.style.transform].join('|'); })()`);
  for (let i = 0, last = await frameRect(); i < 10; i += 1) {
    await sleep(300);
    const now = await frameRect();
    if (now === last) break;
    last = now;
  }
  const settled = await tab.eval<{ x: number; y: number; width: number; height: number; scale: number; pe: string; vis: string } | null>(
    `(() => { const f = document.querySelector('iframe[data-surface]'); if (!f) return null; const r = f.getBoundingClientRect(); const cs = getComputedStyle(f); return { x: r.left, y: r.top, width: r.width, height: r.height, scale: f.offsetWidth > 0 ? r.width / f.offsetWidth : 1, pe: cs.pointerEvents, vis: cs.visibility }; })()`,
  );
  if (settled !== null) page.frame = settled;
  if (page.frame === null || page.frame.vis !== 'visible' || page.frame.pe === 'none') return { check: name, verdict: 'FAIL', detail: `the page is at rest but the live app is still its picture, not the running frame (${page.frame === null ? 'no frame' : `pointer-events ${page.frame.pe}, ${page.frame.vis}`}): presses go to the stage as its own taps` };
  const { frame } = page;
  const kids: { sessionId: string; type: string }[] = [];
  const stopListening = tab.browser.onEvent((event) => {
    if (event.method !== 'Target.attachedToTarget') return;
    const info = event.params['targetInfo'] as { type: string };
    kids.push({ sessionId: String(event.params['sessionId']), type: info.type });
  });
  try {
    await tab.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(600);
    const kid = kids.find((k) => k.type === 'iframe');
    if (kid === undefined) return { check: name, verdict: 'FAIL', detail: 'the live app\'s frame could not be reached to be pressed' };
    type Spot = { label: string; x: number; y: number; width: number; height: number; kind: 'button' | 'drag' };
    const read = await tab.browser.send<{ result: { value?: string } }>(
      'Runtime.evaluate',
      {
        returnByValue: true,
        expression: `(() => { const seen = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.right > 0 && r.bottom > 0 ? r : null; }; const pick = (list, kind) => list.map((e) => ({ e, r: seen(e) })).filter((o) => o.r).map((o) => ({ label: (o.e.textContent || o.e.getAttribute('aria-label') || o.e.className || o.e.tagName).toString().trim().slice(0, 24), x: o.r.x, y: o.r.y, width: o.r.width, height: o.r.height, kind })); const buttons = pick([...document.querySelectorAll('button, [role=button], input[type=button], summary')], 'button'); const drags = pick([...document.querySelectorAll('[draggable=true], body *')].filter((e) => e.getAttribute('draggable') === 'true' || (getComputedStyle(e).cursor === 'grab' || getComputedStyle(e).cursor === 'move')), 'drag'); return JSON.stringify({ buttons, drags, inner: [innerWidth, innerHeight] }); })()`,
      },
      kid.sessionId,
    );
    const found = JSON.parse(read.result.value ?? '{"buttons":[],"drags":[]}') as { buttons: Spot[]; drags: Spot[] };
    const target = found.buttons[0] ?? found.drags[0];
    if (target === undefined) return { check: name, verdict: 'PASS', detail: 'the live app has no button or draggable to press' };
    const at = { x: frame.x + (target.x + target.width / 2) * frame.scale, y: frame.y + (target.y + target.height / 2) * frame.scale };
    const px = Math.min(target.width, target.height) * frame.scale;
    const bad: string[] = [];
    if (at.x < frame.x || at.y < frame.y || at.x > frame.x + frame.width || at.y > frame.y + frame.height) bad.push(`its first ${target.kind} "${target.label}" lies outside the app's own frame (cut off)`);
    if (at.x < 0 || at.y < 0 || at.x > cx.screen.width || at.y > cx.screen.height) bad.push(`its first ${target.kind} "${target.label}" is off the screen`);
    if (bad.length > 0) return { check: name, verdict: 'FAIL', detail: bad.join('; ') };
    const clip = { x: frame.x, y: Math.max(0, frame.y), width: Math.min(frame.width, cx.screen.width - frame.x), height: Math.min(frame.height, cx.screen.height - frame.y) };
    const before = await tab.shot(clip);
    const sent = await tab.eval<number>('window.__stage.events().filter((e) => e.type === "control" && e.app === true).length').catch(() => 0);
    await tab.browser.send('Runtime.evaluate', { expression: "window.__got = []; ['pointerdown','pointerup','click','mousedown'].forEach((t) => document.addEventListener(t, (e) => window.__got.push(t + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' on ' + (e.target.textContent || e.target.tagName).slice(0, 12)), true)); window.__got.push('hidden=' + document.hidden + ' focus=' + document.hasFocus());" }, kid.sessionId);
    const under = await tab.eval<string>(`(() => { const f = document.querySelector('iframe[data-surface]'); const e = document.elementFromPoint(${at.x}, ${at.y}); const cs = f ? getComputedStyle(f) : null; return (e ? e.tagName + '.' + String(e.className).slice(0, 30) : 'nothing') + ' pe=' + (cs ? cs.pointerEvents : '?') + ' vis=' + (cs ? cs.visibility : '?') + ' op=' + (cs ? cs.opacity : '?'); })()`);
    if (target.kind === 'button') {
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, pointerType: 'mouse' });
      // a person's pointer is over a button a moment before it presses (a press in the same instant as the move into a sandboxed frame is lost by the browser itself)
      await sleep(250);
      await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      await sleep(40);
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    }
    else {
      const to = { x: Math.min(cx.screen.width - 2, Math.max(2, frame.x + frame.width / 2)), y: Math.min(cx.screen.height - 2, Math.max(2, frame.y + frame.height / 2)) };
      const point = (x: number, y: number) => ({ x, y, id: 1 });
      if (tab.mobile) {
        await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(at.x, at.y)] });
        for (let i = 1; i <= 8; i += 1) await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(at.x + ((to.x - at.x) * i) / 8, at.y + ((to.y - at.y) * i) / 8)] });
        await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, pointerType: 'mouse' });
        await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
        for (let i = 1; i <= 8; i += 1) await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + ((to.x - at.x) * i) / 8, y: at.y + ((to.y - at.y) * i) / 8, button: 'left', buttons: 1, pointerType: 'mouse' });
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
      }
    }
    // an app may answer on its next tick (a timer starts counting a second later): it is looked at again for up to two seconds before it is called unchanged
    let after = before;
    for (let waited = 0; waited < 2400 && after === before; waited += 400) {
      await sleep(400);
      after = await tab.shot(clip);
    }
    const now = await tab.eval<{ taps: number; sent: number }>('({ taps: window.__stage.events().filter((e) => e.type === "tap").length, sent: window.__stage.events().filter((e) => e.type === "control" && e.app === true).length })');
    const got = await tab.browser.send<{ result: { value?: string } }>('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify(window.__got)' }, kid.sessionId).then((r) => r.result.value ?? '?').catch(() => 'unreadable');
    if (after === before) {
      await writeFile(join(cx.dir, `${cx.screen.name}-app-works-before.png`), Buffer.from(before.split(',')[1] ?? '', 'base64'));
      await writeFile(join(cx.dir, `${cx.screen.name}-app-works-after.png`), Buffer.from(after.split(',')[1] ?? '', 'base64'));
    }
    if (now.taps > page.taps) bad.push(`the stage logged the press as its own tap (${now.taps - page.taps}) instead of the app taking it`);
    if (after === before && now.sent <= sent) bad.push(`a real ${target.kind === 'button' ? 'click' : 'drag'} on its first ${target.kind} "${target.label}" changed nothing in the app (the frame heard ${got}; under the press: ${under}; pressed at ${Math.round(at.x)},${Math.round(at.y)}; the frame is ${Math.round(frame.width)}x${Math.round(frame.height)} at ${Math.round(frame.x)},${Math.round(frame.y)}, scale ${frame.scale.toFixed(2)})`);
    return res(name, bad, `a real ${target.kind === 'button' ? 'click' : 'drag'} on "${target.label}" (${Math.round(px)} px on screen) changed the app, and the stage logged no tap`);
  } finally {
    stopListening();
    await tab.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
  }
}

/** "‹ earlier": when lines are held back, the control is on the screen, a real tap lays them over the column (inside the screen, not empty), and a second tap puts them away */
async function earlierWorks(cx: Cx): Promise<Res> {
  const name = 'earlier-works';
  const box = await cx.tab.eval<{ x: number; y: number; width: number; height: number } | null>(
    `(() => { const b = document.querySelector('[data-earlier]'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`,
  );
  if (box === null) return { check: name, verdict: 'PASS', detail: 'no lines held back' };
  const bad: string[] = [];
  if (box.x < -1 || box.y < -1 || box.x + box.width > cx.screen.width + 1 || box.y + box.height > cx.screen.height + 1) bad.push('the control stands off the screen');
  const tap = async (): Promise<void> => {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cx.tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
    await cx.tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await cx.tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(350);
  };
  await tap();
  const open = await cx.tab.eval<{ shown: boolean; lines: number; inside: boolean }>(
    `(() => { const s = document.querySelector('[data-earlier-sheet]'); if (!s || s.hidden) return { shown: false, lines: 0, inside: false }; const r = s.getBoundingClientRect(); return { shown: true, lines: s.querySelectorAll('p').length, inside: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 }; })()`,
  );
  if (!open.shown) bad.push('a tap on it showed nothing');
  else {
    if (open.lines === 0) bad.push('the sheet it opens is empty');
    if (!open.inside) bad.push('the sheet runs off the screen');
  }
  await tap();
  const closed = await cx.tab.eval<boolean>(`(() => { const s = document.querySelector('[data-earlier-sheet]'); return !s || s.hidden; })()`);
  if (!closed) bad.push('a second tap did not put the lines away');
  return res(name, bad, `${open.lines} held-back line(s): a tap shows them, another puts them away`);
}

function legible(cx: Cx): Res {
  const words = shown(cx.answer);
  const faint = words.filter((e) => e.contrast > 0 && e.contrast < 4.5);
  const small = words.filter((e) => e.fontPx > 0 && e.fontPx < floorOf(cx));
  const bad: string[] = [];
  if (faint.length > 0) bad.push(`${faint.length} line(s) under 4.5:1 ("${faint[0]?.text.slice(0, 24)}" ${faint[0]?.contrast.toFixed(1)}:1)`);
  if (small.length > 0) bad.push(`${small.length} line(s) under ${floorOf(cx)} px ("${small[0]?.text.slice(0, 24)}" ${small[0]?.fontPx.toFixed(1)} px)`);
  return res('legible', bad, `${words.length} lines, all at 4.5:1 or better and at least ${floorOf(cx)} px`);
}

/** a leader's end this close to its part's outline (px) touches it */
const LEADER_TOUCH = 6;

/** a label anchored with `near=part` must lie nearest its own part and not inside another anchored part */
function labelsSide(cx: Cx): Res {
  const anchors: { label: string; part: string }[] = [];
  for (const line of cx.answer.script.split('\n')) {
    const m = /^say (\S+)[^|]*\bnear=(\S+)/.exec(line);
    if (m !== null) anchors.push({ label: m[1] as string, part: (m[2] as string).split(/[,;]/)[0] as string });
  }
  const by = (id: string): LiveElement | undefined => cx.answer.live.find((e) => e.id === id && e.phase === 'on');
  const parts = [...new Set(anchors.map((a) => a.part))].map((id) => by(id)).filter((e): e is LiveElement => e !== undefined);
  if (anchors.length < 2 || parts.length < 2) return { check: 'labels-side', verdict: 'PASS', detail: `${anchors.length} anchored label(s): nothing to compare` };
  const dist = (p: LiveElement, l: LiveElement): number => {
    const c = centre(l.box);
    const dx = Math.max(p.box.x - c.x, 0, c.x - (p.box.x + p.box.width));
    const dy = Math.max(p.box.y - c.y, 0, c.y - (p.box.y + p.box.height));
    return Math.hypot(dx, dy);
  };
  const bad: string[] = [];
  // a label with a leader is judged by where its line ends: on its own part (within a few px), and not nearer another labelled part; one without a leader by the nearness of its words
  const lines = cx.answer.leaders ?? [];
  const led = new Set<string>();
  for (const { label, part } of anchors) {
    const line = lines.find((candidate) => candidate.label === label && candidate.part === part);
    const l = by(label);
    if (line === undefined || l === undefined) continue;
    led.add(label);
    if (line.distance > LEADER_TOUCH) bad.push(`"${l.text.slice(0, 18)}" has a leader that ends ${Math.round(line.distance)} px from ${part}`);
    else if (line.nearer !== null) bad.push(`"${l.text.slice(0, 18)}" has a leader that reaches ${line.nearer.id} first, not ${part}`);
  }
  for (const { label, part } of anchors) {
    if (led.has(label)) continue;
    const l = by(label);
    const own = by(part);
    if (l === undefined || own === undefined) continue;
    const other = parts.filter((p) => p.id !== part && inter(l.box, p.box) > 0.3 * area(l.box));
    if (other.length > 0) bad.push(`"${l.text.slice(0, 18)}" lies on ${other[0]?.id}, not ${part}`);
    else {
      const nearest = parts.reduce((best, p) => (dist(p, l) < dist(best, l) ? p : best), parts[0] as LiveElement);
      if (nearest.id !== part && dist(nearest, l) + 4 < dist(own, l)) bad.push(`"${l.text.slice(0, 18)}" is nearer ${nearest.id} than its own ${part}`);
    }
  }
  // a label reads as naming the part it is level with: never level with another labelled part (and not with its own) while a place level with its own part was free
  const boxes = cx.answer.live.filter((e) => e.phase === 'on' && area(e.box) > 0 && area(e.box) < 0.4 * cx.screen.width * cx.screen.height);
  const overlapLen = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const levelWith = (l: LiveElement['box'], p: LiveElement['box']): boolean => {
    const row = overlapLen(l.y, l.y + l.height, p.y, p.y + p.height) >= 0.5 * l.height && overlapLen(l.x, l.x + l.width, p.x, p.x + p.width) === 0;
    const col = overlapLen(l.x, l.x + l.width, p.x, p.x + p.width) >= 0.5 * Math.min(l.width, p.width) && overlapLen(l.y, l.y + l.height, p.y, p.y + p.height) === 0;
    return row || col;
  };
  for (const { label, part } of anchors) {
    const l = by(label);
    const own = by(part);
    if (l === undefined || own === undefined || levelWith(l.box, own.box) || inter(l.box, own.box) > 0) continue;
    const other = parts.find((p) => p.id !== part && levelWith(l.box, p.box) && dist(p, l) <= dist(own, l));
    if (other === undefined) continue;
    const w = l.box.width;
    const h = l.box.height;
    const gap = 4;
    const o = own.box;
    const places = [
      { x: o.x + o.width + gap, y: o.y + o.height / 2 - h / 2 },
      { x: o.x - gap - w, y: o.y + o.height / 2 - h / 2 },
      { x: o.x + o.width / 2 - w / 2, y: o.y - gap - h },
      { x: o.x + o.width / 2 - w / 2, y: o.y + o.height + gap },
    ].map((q) => ({ ...q, width: w, height: h }));
    const free = places.find((q) => q.x >= 0 && q.y >= 0 && q.x + w <= cx.screen.width && q.y + h <= cx.screen.height && !boxes.some((e) => e.id !== label && e.id !== part && inter(q, e.box) > 0));
    if (free !== undefined) bad.push(`"${l.text.slice(0, 18)}" is level with ${other.id} while its own row at ${part} was free`);
  }
  return res('labels-side', bad, `${anchors.length} labels, ${led.size} by their leaders, the rest each nearest its own part`);
}

/** words that belong to a shape (`in=`) are inside its box at rest */
function wordsInShapes(cx: Cx): Res {
  const report = cx.answer.report;
  if (report === null) return { check: 'words-in-shapes', verdict: 'PASS', detail: 'no report' };
  const bad: string[] = [];
  let n = 0;
  for (const e of report.stage) {
    if (e.parent === null || e.kind !== 'text') continue;
    const word = cx.answer.live.find((l) => l.id === e.id && l.phase === 'on');
    const home = cx.answer.live.find((l) => l.id === e.parent && l.phase === 'on');
    if (word === undefined || home === undefined || area(home.box) === 0) continue;
    n += 1;
    if (inter(word.box, home.box) < 0.85 * area(word.box)) bad.push(`"${word.text.slice(0, 16)}" is outside its ${e.parent}`);
  }
  return res('words-in-shapes', bad, `${n} words with a home, all inside it`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The checks a case asks for

const wordBoxes = (cx: Cx, words: readonly string[] | undefined, match: string | undefined): LiveElement[] => {
  const re = match === undefined ? null : new RegExp(match);
  return shown(cx.answer).filter((e) => (words !== undefined && words.includes(e.text.trim())) || (re !== null && re.test(e.text.trim())));
};

function gridBox(cx: Cx, of: string | undefined, matched: readonly LiveElement[]): LiveElement['box'] | null {
  const shapes = cx.answer.live.filter((e) => (e.kind === 'shape' || e.kind === 'structure') && e.phase !== 'struck' && area(e.box) > 0 && area(e.box) < 0.85 * cx.screen.width * cx.screen.height);
  if (of === 'cells') {
    // the cells of a strip: the box that holds all of the shapes sitting among the words
    const near = cx.answer.live.filter((e) => e.kind === 'shape' && e.phase !== 'struck' && area(e.box) > 0 && matched.some((m) => Math.abs(centre(e.box).y - centre(m.box).y) < 3 * m.box.height));
    if (near.length === 0) return null;
    const x0 = Math.min(...near.map((s) => s.box.x));
    const y0 = Math.min(...near.map((s) => s.box.y));
    return { x: x0, y: y0, width: Math.max(...near.map((s) => s.box.x + s.box.width)) - x0, height: Math.max(...near.map((s) => s.box.y + s.box.height)) - y0 };
  }
  // the shape or table that holds the most of the words (a grid, whatever kind the painter calls it)
  const holds = (b: LiveElement['box']): number => matched.filter((m) => { const c = centre(m.box); return c.x >= b.x - 3 && c.x <= b.x + b.width + 3 && c.y >= b.y - 3 && c.y <= b.y + b.height + 3; }).length;
  const best = shapes.sort((a, b) => holds(b.box) - holds(a.box) || area(b.box) - area(a.box))[0];
  return best === undefined ? null : best.box;
}


// ---------------------------------------------------------------------------------------------------------------------------------
// Type that follows the stage: an app's text and a figure's labels are read against the words the stage sets beside them

/** read inside an app's frame (a sandboxed frame is a process of its own, so this runs there, over the DevTools protocol): every visible piece of text with its size, and every target with its size, in the frame's own pixels */
const FRAME_READ = String.raw`(() => {
  const px = (el) => parseFloat(getComputedStyle(el).fontSize);
  const texts = []; const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = walker.nextNode())) { const t = n.textContent.trim(); const el = n.parentElement; if (!t || !el || seen.has(el) || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(el.tagName)) continue; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0 || cs.visibility === 'hidden') continue; seen.add(el); const svg = !!el.closest('svg'); let size = px(el); if (svg) { const m = el.getScreenCTM && el.getScreenCTM(); if (m) size = size * Math.hypot(m.a, m.b); } texts.push({ t: t.slice(0, 18), px: size, svg }); }
  for (const el of document.querySelectorAll('input:not([type=hidden]),select,textarea,button')) { if (seen.has(el)) continue; const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && !/^(range|checkbox|radio)$/.test(el.type || '')) texts.push({ t: (el.value || el.tagName).slice(0, 18), px: px(el), svg: false }); }
  const taps = [];
  const cands = [...document.querySelectorAll('button,[role=button],a[href],input:not([type=hidden]),select,textarea,summary,[onclick]')];
  for (const el of document.body.querySelectorAll('*')) { const cur = getComputedStyle(el).cursor; if ((cur === 'pointer' || cur === 'grab' || cur === 'move') && el.parentElement && getComputedStyle(el.parentElement).cursor !== cur && !cands.includes(el)) cands.push(el); }
  for (const el of cands) { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0 || cs.display === 'inline' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue; taps.push({ t: (el.textContent || el.tagName).trim().slice(0, 14), w: r.width, h: r.height }); }
  const root = getComputedStyle(document.documentElement);
  return { innerW: innerWidth, texts, taps, body: parseFloat(root.getPropertyValue('--font-body')) || null };
})()`;

interface FrameRead {
  readonly innerW: number;
  readonly texts: readonly { readonly t: string; readonly px: number; readonly svg: boolean }[];
  readonly taps: readonly { readonly t: string; readonly w: number; readonly h: number }[];
  readonly body: number | null;
  /** on screen px per frame px: the frame is laid out larger and scaled down to its room when its content is large (FIT) */
  readonly scale: number;
}

/** the live apps' frames, read from inside, each with the scale it is shown at */
async function frameReads(cx: Cx): Promise<FrameRead[]> {
  const shownFrames = await cx.tab.eval<{ offsetWidth: number; width: number }[]>(`[...document.querySelectorAll('iframe')].map((f) => ({ offsetWidth: f.offsetWidth, width: f.getBoundingClientRect().width })).filter((f) => f.width > 50)`);
  const targets = await cx.tab.browser.send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets');
  const out: FrameRead[] = [];
  for (const target of targets.targetInfos.filter((t) => t.type === 'iframe')) {
    const attached = await cx.tab.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const got = await cx.tab.browser.send<{ result?: { value?: Omit<FrameRead, 'scale'> } }>('Runtime.evaluate', { expression: FRAME_READ, returnByValue: true }, attached.sessionId);
    const value = got.result?.value;
    if (value === undefined) continue;
    const mine = shownFrames.find((f) => Math.abs(f.offsetWidth - value.innerW) <= 1);
    if (mine === undefined) continue;
    out.push({ ...value, scale: mine.width / Math.max(1, mine.offsetWidth) });
  }
  return out;
}

/** the stage's body size, measured off the stage's own words: the plain narration on stage (a `say` with no role word), else the choices (set at body size), else null */
function stageBody(cx: Cx): number | null {
  const lines = [...cx.answer.script.matchAll(/^say (\S+)((?: [^|\s=]+(?:=\S+)?)*) \|/gm)];
  const sizeOf = (ids: readonly string[]): number | null => {
    const sizes = ids.map((id) => shown(cx.answer).find((e) => e.id === id)?.fontPx ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
    return sizes.length === 0 ? null : (sizes[Math.floor(sizes.length / 2)] as number);
  };
  const plain = lines.filter((m) => !/\b(title|strong|aside|choice|label|caption|small)\b/.test(m[2] as string) && !/size=/.test(m[2] as string)).map((m) => m[1] as string);
  const choices = lines.filter((m) => /\bchoice\b/.test(m[2] as string) && !/size=/.test(m[2] as string)).map((m) => m[1] as string);
  return sizeOf(plain) ?? sizeOf(choices);
}

async function runCheck(cx: Cx, spec: Spec): Promise<Res> {
  const name = spec.k;
  const words = spec['words'] as string[] | undefined;
  const match = spec['match'] as string | undefined;
  switch (name) {
    case 'any': {
      // one of several good answers: `{ "k": "any", "of": [spec, spec] }` passes when any of them passes (a list on stage, or the same list as stops to tap)
      const tried: Res[] = [];
      for (const sub of spec['of'] as Spec[]) {
        const r = await runCheck(cx, sub);
        if (r.verdict === 'PASS') return { check: (spec['of'] as Spec[]).map((s) => s.k).join('|'), verdict: 'PASS', detail: `${r.check}: ${r.detail}` };
        tried.push(r);
      }
      return { check: tried.map((r) => r.check).join('|'), verdict: 'FAIL', detail: tried.map((r) => `${r.check}: ${r.detail}`).join('; or ') };
    }
    case 'words-in-card': {
      // every words said `in=` a card stand wholly inside that card's frame, and none of them is left at the stage's corner
      const report = cx.answer.report;
      if (report === null) return { check: name, verdict: 'FAIL', detail: 'no report' };
      const bad: string[] = [];
      let n = 0;
      for (const e of report.stage) {
        if (e.parent === null || e.kind !== 'text') continue;
        const word = cx.answer.live.find((l) => l.id === e.id && l.phase === 'on');
        const home = cx.answer.live.find((l) => l.id === e.parent?.split('@')[0] && l.kind === 'group' && l.phase === 'on');
        if (word === undefined || home === undefined || area(home.box) === 0) continue;
        n += 1;
        if (inter(word.box, home.box) < 0.98 * area(word.box)) bad.push(`"${word.text.slice(0, 16)}" is not inside its ${e.parent}`);
      }
      if (n === 0) return { check: name, verdict: 'FAIL', detail: 'no words with a card to stand in were found on stage' };
      return res(name, bad, `${n} words, each inside its own card`);
    }
    case 'words-in-grid': {
      const found = wordBoxes(cx, words, match);
      if (found.length === 0) return { check: name, verdict: 'FAIL', detail: 'none of the words are on stage' };
      const box = gridBox(cx, spec['of'] as string | undefined, found);
      if (box === null) return { check: name, verdict: 'FAIL', detail: 'no grid or cell shape on stage to hold the words' };
      const pad = 3;
      const inside = (e: LiveElement): boolean => {
        const c = centre(e.box);
        return !(c.x < box.x - pad || c.x > box.x + box.width + pad || c.y < box.y - pad || c.y > box.y + box.height + pad);
      };
      // a word may also stand elsewhere (a result echoing a cell): it is out only when none of its copies is in the grid
      const texts = [...new Set(found.map((e) => e.text.trim()))];
      const out = texts.filter((t) => !found.some((e) => e.text.trim() === t && inside(e)));
      return res(name, out.map((t) => `"${t.slice(0, 14)}" is outside the grid`), `${texts.length} words all inside the grid`);
    }
    case 'row-aligned': {
      const order = spec['order'] as string[];
      const picked = order.map((w) => shown(cx.answer).find((e) => e.text.trim() === w || e.text.trim().startsWith(w)));
      const missing = order.filter((_, i) => picked[i] === undefined);
      if (missing.length > 0) return { check: name, verdict: 'FAIL', detail: `not on stage: ${missing.join(', ')}` };
      const boxes = picked as LiveElement[];
      const lineH = Math.max(...boxes.map((e) => e.box.height));
      const bad: string[] = [];
      // One row where it fits. A strip too narrow for its words wraps into rows (2 x 6, 3 x 4): the check then asks each row to be level and in
      // order left to right, and the rows to follow one another top to bottom, the next row beginning at the left of where the last one ended.
      const rows: number[][] = [];
      boxes.forEach((e, i) => {
        const last = rows[rows.length - 1];
        const y = centre(e.box).y;
        if (last !== undefined && Math.abs(y - centre((boxes[last[0] as number] as LiveElement).box).y) <= 0.6 * lineH) last.push(i);
        else rows.push([i]);
      });
      const widths = rows.map((r) => r.length);
      const even = widths.slice(0, -1).every((n) => n === widths[0]) && (widths[widths.length - 1] as number) <= (widths[0] as number);
      if (rows.length > 1 && (!even || rows.length > 4)) bad.push(`the labels stand in ${rows.length} rows of ${widths.join('/')}, not one row or an even wrap`);
      rows.forEach((r, ri) => {
        r.forEach((i, k) => {
          const e = boxes[i] as LiveElement;
          const prev = k > 0 ? (boxes[r[k - 1] as number] as LiveElement) : undefined;
          if (prev !== undefined && centre(e.box).x <= centre(prev.box).x) bad.push(`${order[i]} is not to the right of ${order[r[k - 1] as number]}`);
          if (ri > 0 && k === 0) {
            const above = boxes[(rows[ri - 1] as number[])[0] as number] as LiveElement;
            if (centre(e.box).y <= centre(above.box).y) bad.push(`${order[i]} is not below the row before it`);
          }
        });
      });
      return res(name, bad, rows.length === 1 ? `${order.length} labels on one row, in order` : `${order.length} labels in ${rows.length} rows of ${widths[0]}, in reading order`);
    }
    case 'min-font': {
      const found = wordBoxes(cx, words, match);
      const px = cx.mobile ? Number(spec['phonePx'] ?? spec['px']) : Number(spec['px']);
      if (found.length === 0) return { check: name, verdict: 'FAIL', detail: 'the words are not on stage' };
      const small = found.filter((e) => e.fontPx > 0 && e.fontPx < px);
      return res(name, small.map((e) => `"${e.text.slice(0, 16)}" ${e.fontPx.toFixed(1)} px`).map((s) => `${s} (< ${px})`), `${found.length} words all at ${px} px or more`);
    }
    case 'labels-side':
      return labelsSide(cx);
    case 'same-role-same-size': {
      // lines of one role in one sequence (narration: a plain `say`) share one size and one alignment
      const ids = [...cx.answer.script.matchAll(/^say (\S+)((?: [^|\s=]+(?:=\S+)?)*) \|/gm)].filter((m) => !/\b(title|strong|aside|choice|label|caption|small)\b/.test(m[2] as string)).map((m) => m[1] as string);
      const lines = ids.map((id) => shown(cx.answer).find((e) => e.id === id)).filter((e): e is LiveElement => e !== undefined && e.fontPx > 0);
      if (lines.length < 3) return { check: name, verdict: 'FAIL', detail: `only ${lines.length} narration line(s) on stage at rest` };
      const sizes = lines.map((e) => e.fontPx);
      const ratio = Math.max(...sizes) / Math.min(...sizes);
      const lefts = lines.map((e) => e.box.x);
      const mids = lines.map((e) => centre(e.box).x);
      const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
      const aligned = Math.min(spread(lefts), spread(mids)) <= 0.04 * cx.screen.width;
      const bad: string[] = [];
      if (ratio > 1.15) bad.push(`sizes ${sizes.map((n) => n.toFixed(0)).join('/')} px in one sequence`);
      const ys = lines.map((e) => e.box.y);
      if (ys.some((y, i) => i > 0 && y <= (ys[i - 1] as number))) bad.push('the lines are not in the order they were written, top to bottom');
      // the space between one line's foot and the next line's top, not top to top: a line of two rows and a line of one are evenly spaced when the air between them is
      const gaps = lines.slice(1).map((e, i) => e.box.y - ((lines[i] as LiveElement).box.y + (lines[i] as LiveElement).box.height));
      const line = Math.max(...lines.map((e) => e.fontPx)) * 1.3;
      if (gaps.length >= 2 && Math.max(...gaps) - Math.min(...gaps) > Math.max(0.5 * line, 0.6 * Math.max(...gaps))) bad.push(`uneven spacing between lines (${gaps.map((g) => Math.round(g)).join('/')} px)`);
      if (!aligned) bad.push(`the lines do not share one alignment (left edges spread ${Math.round(spread(lefts))} px, centres ${Math.round(spread(mids))} px)`);
      return res(name, bad, `${lines.length} narration lines at one size and one alignment`);
    }
    case 'no-raw-braces': {
      const texts = [...cx.answer.live.map((e) => e.text), ...(await cx.tab.eval<string[]>(`[window.__stage.elements().map((e) => String(e.text || '')).join('\\n'), document.body.innerText].join('\\n').split('\\n')`))];
      const hits = [...new Set(texts.filter((t) => /\{[A-Za-z_][A-Za-z0-9_ *+\-/.]{0,20}\}/.test(t)).map((t) => t.trim().slice(0, 40)))];
      return res(name, hits.map((h) => `raw braces in "${h}"`), 'no raw {name} on stage');
    }
    case 'slider-whole': {
      const sliders = (await controls(cx.tab)).filter((c) => c.control === 'slider');
      if (sliders.length === 0) return { check: name, verdict: 'FAIL', detail: 'no slider on stage' };
      return res(name, sliders.filter((s) => /\d[.,]\d/.test(s.valueText)).map((s) => `slider "${s.label}" reads ${s.valueText}`), `${sliders.length} sliders read whole numbers`);
    }
    case 'controls-default': {
      const sliders = (await controls(cx.tab)).filter((c) => c.control === 'slider');
      if (sliders.length === 0) return { check: name, verdict: 'FAIL', detail: 'no slider on stage' };
      return res(name, sliders.filter((s) => Number(s.value) !== Number(spec['expect'])).map((s) => `slider "${s.label}" starts at ${String(s.value)}, not ${String(spec['expect'])}`), `${sliders.length} sliders back at ${String(spec['expect'])}`);
    }
    case 'options-differ': {
      const ctl = (await controls(cx.tab)).find((c) => c.id === spec['id']);
      if (ctl === undefined) return { check: name, verdict: 'FAIL', detail: `no control ${String(spec['id'])}` };
      const seen = new Set<string>();
      for (const option of ctl.options) {
        await cx.tab.eval(`window.__stage.control(${JSON.stringify(ctl.id)}, ${JSON.stringify(option)})`);
        await sleep(900);
        seen.add(await cx.tab.shot());
      }
      return seen.size >= Math.min(2, ctl.options.length) ? { check: name, verdict: 'PASS', detail: `${seen.size} different pictures for ${ctl.options.length} options` } : { check: name, verdict: 'FAIL', detail: `picking each of ${ctl.options.join(' / ')} gives the same picture: the bind did not match` };
    }
    case 'flow-labels-off-lines': {
      const links = cx.answer.live.filter((e) => (e.kind === 'link' || e.kind === 'edge') && e.phase === 'on');
      const bad: string[] = [];
      for (const l of shown(cx.answer)) {
        if (!/^[a-z ]{3,16}$/.test(l.text.trim())) continue;
        for (const k of links) if (inter(l.box, k.box) > 0.5 * area(l.box) && (k.box.width < 5 || k.box.height < 5)) bad.push(`"${l.text}" lies on a line`);
      }
      const noted = (cx.answer.report?.sight ?? []).filter((s) => s.notes.some((n) => ['crossed', 'collides'].includes(n)) && s.kind === 'text');
      return res(name, [...bad, ...noted.map((s) => `${s.id} ${s.notes.join('/')}`)], 'no link label on a line');
    }
    case 'showall-clear':
      return cx.watched.pillSeen === 0 ? { check: name, verdict: 'SKIP', detail: 'the Show all pill never appeared while the answer played' } : cx.watched.showAllOver === null ? { check: name, verdict: 'PASS', detail: `the Show all pill (seen ${cx.watched.pillSeen} times) never stood on words` } : { check: name, verdict: 'FAIL', detail: cx.watched.showAllOver };
    case 'fields-clear': {
      const fields = await cx.tab.eval<{ x: number; y: number; width: number; height: number; label: string }[]>(
        `[...document.querySelectorAll('input:not([type=file]),textarea,[contenteditable=true]')].filter((e) => !e.closest('.composer,.prompt,.ink-bar,.transcript__panel')).map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, label: String(e.placeholder || e.getAttribute('aria-label') || '') }; }).filter((r) => r.width > 8 && r.height > 8)`,
      );
      const own = (await controls(cx.tab)).filter((c) => c.control === 'input' || c.control === 'field' || c.control === 'text');
      const boxes = [...fields.map((f) => ({ ...f })), ...own.map((c) => ({ ...c.box, label: c.label }))];
      if (boxes.length === 0) return { check: name, verdict: 'FAIL', detail: 'no input on stage to place' };
      const bad: string[] = [];
      for (const f of boxes) for (const w of shown(cx.answer)) if (inter(f, w.box) > 0.15 * Math.min(area(f), area(w.box))) bad.push(`the field "${f.label.slice(0, 20)}" is over "${w.text.slice(0, 24)}"`);
      return res(name, bad, `${boxes.length} field(s), clear of every caption`);
    }
    case 'skills-list':
      return skillsListed(cx, spec);
    case 'skills-chip':
      return skillsChip(cx, spec);
    case 'no-file-offered': {
      // a result is drawn, not handed back: no line names a file or a download
      const bad = shown(cx.answer).map((e) => e.text.trim()).filter((t) => /\.(?:xlsx|docx|pptx|pdf|csv)\b|\bdownload|\battached\b|\bsaved (?:it )?(?:as|to)\b/i.test(t));
      return res(name, bad.map((t) => `a line names a file: "${t.slice(0, 50)}"`), 'no line names a file or a download');
    }
    case 'brief-skill': {
      // live only: the block of a held skill in the brief is at most `max` characters and names what was left out; or, with `none`, there is no skill text at all
      const brief = await lastBrief(briefDataDir);
      if (brief === null) return { check: name, verdict: 'FAIL', detail: 'no brief was found in the session log' };
      const at = brief.indexOf('SKILL ');
      if (spec['none'] === true) return res(name, at >= 0 ? ['the brief carries skill text with nothing held'] : [], 'no skill text in the brief');
      if (at < 0) return { check: name, verdict: 'FAIL', detail: 'the brief has no skill block' };
      const end = brief.indexOf('--- end of the skill ---', at);
      const block = brief.slice(at, end < 0 ? undefined : end + 24);
      const bad: string[] = [];
      if (block.length > Number(spec['max'])) bad.push(`the skill block is ${block.length} characters, more than ${String(spec['max'])}`);
      if (spec['leftOut'] === true && !/Headings left out:/.test(block)) bad.push('the cut does not name the headings left out');
      return res(name, bad, `the skill block is ${block.length} characters${spec['leftOut'] === true ? ' and names the headings left out' : ''}`);
    }
    case 'all-present': {
      const texts = shown(cx.answer).map((e) => e.text.trim());
      const missing = (spec['items'] as string[]).filter((re) => !texts.some((t) => new RegExp(re).test(t)));
      return res(name, missing.map((m) => `no line matching ${m} at rest`), 'every item is on stage at rest');
    }
    case 'shows-not-lists': {
      const kinds = new Set(cx.answer.live.filter((e) => e.phase !== 'struck' && e.kind !== 'text').map((e) => e.kind));
      const things = kinds.size + cx.answer.controls.length + cx.answer.charts.length;
      return things >= 2 ? { check: name, verdict: 'PASS', detail: `shows ${[...kinds].join(', ')} and ${cx.answer.controls.length} control(s)` } : { check: name, verdict: 'FAIL', detail: 'only words: a list, with nothing shown or tried' };
    }
    case 'script-count': {
      const n = cx.answer.script.split('\n').filter((l) => new RegExp(String(spec['re'])).test(l)).length;
      return n >= Number(spec['min']) ? { check: name, verdict: 'PASS', detail: `${n} items` } : { check: name, verdict: 'FAIL', detail: `${n} item(s), wanted ${String(spec['min'])}` };
    }
    case 'look-not': {
      const look = (await cx.tab.call<Probe>('probe')).look;
      return look !== spec['look'] ? { check: name, verdict: 'PASS', detail: `the look is ${look}` } : { check: name, verdict: 'FAIL', detail: `the look is still ${look} for an unrelated answer` };
    }
    case 'no-red-outline': {
      const after = await cx.tab.eval<{ red: number } | null>(redScan(JSON.stringify(cx.picture)));
      const before = await cx.tab.eval<{ red: number } | null>(redScan(JSON.stringify(cx.before)));
      if (after === null || before === null) return { check: name, verdict: 'FAIL', detail: 'no control was clicked' };
      const grew = after.red - before.red;
      return grew > 40 ? { check: name, verdict: 'FAIL', detail: `${grew} more red pixels round the clicked control after the click: a red box` } : { check: name, verdict: 'PASS', detail: 'no red box appeared round the clicked control' };
    }
    case 'screen-changed': {
      const now = await screenSig(cx.tab);
      return now !== cx.sig ? { check: name, verdict: 'PASS', detail: 'the screen is different after the tap' } : { check: name, verdict: 'FAIL', detail: `nothing on the screen changed after the tap (still: ${now.slice(0, 60)})` };
    }
    case 'document-open': {
      // the lesson view is a sandboxed frame, so its words cannot be read from here: it is open when its layer is up with the frame in it
      const now = await screenSig(cx.tab);
      return now.startsWith('document:') ? { check: name, verdict: 'PASS', detail: 'the document is open on the screen' } : { check: name, verdict: 'FAIL', detail: `no document is open on the screen (${now.slice(0, 60)})` };
    }
    case 'document-yields': {
      // a picture answer is seen: the document layer is put away (a pill brings it back) and the stage shows the drawing
      const now = await screenSig(cx.tab);
      const pill = await cx.tab.eval<boolean>(`(() => { const p = document.querySelector('[data-act="document"]'); return !!p && getComputedStyle(p).display !== 'none'; })()`);
      if (now.startsWith('document:')) return { check: name, verdict: 'FAIL', detail: 'the document is still over the picture answer' };
      return now.length > 'stage:'.length ? { check: name, verdict: 'PASS', detail: `the picture is on stage${pill ? ', the document one tap away' : ''}` } : { check: name, verdict: 'FAIL', detail: 'no document, but nothing on the stage either' };
    }
    case 'refresh-escape': {
      const view = await cx.tab.eval<{ doc: boolean; escape: boolean; prompt: boolean }>(
        `(() => { const d = document.querySelector('.stage__document'); const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 4 && r.height > 4 && cs.display !== 'none' && cs.visibility !== 'hidden'; }; const doc = !!d && vis(d) && (d.innerText || '').trim().length > 0; const escape = [...document.querySelectorAll('button,[role=button],a')].some((b) => vis(b) && /close|new conversation|new chat|back to|leave|exit/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent)); return { doc, escape, prompt: true }; })()`,
      );
      view.prompt = (await cx.tab.call<unknown>('promptInfo')) !== null;
      if (view.doc && !view.escape) return { check: name, verdict: 'FAIL', detail: 'after a refresh the lesson view is forced on with no Close or New conversation' };
      return !view.prompt ? { check: name, verdict: 'FAIL', detail: 'after a refresh the prompt box is not usable' } : { check: name, verdict: 'PASS', detail: view.doc ? 'the lesson view is open and has a way out' : 'the stage is not held by a lesson view' };
    }
    case 'steps-hidden': {
      const variants = [...cx.answer.script.matchAll(new RegExp(`^bind \\S+=\\S+[^|]*\\| correct ${String(spec['id'])} \\| (.+)$`, 'gm'))].map((m) => (m[1] as string).trim().slice(0, 28));
      if (variants.length === 0) return { check: name, verdict: 'FAIL', detail: 'the script has no bound step text' };
      const texts = (await cx.tab.eval<string[]>(`window.__stage.elements().filter((e) => e.phase === 'on' && e.opacity > 0.3).map((e) => String(e.text || ''))`)).join('\n');
      const drawn = variants.filter((v) => texts.includes(v));
      return drawn.length <= 1 ? { check: name, verdict: 'PASS', detail: `${drawn.length} of ${variants.length} step texts drawn` } : { check: name, verdict: 'FAIL', detail: `${drawn.length} of ${variants.length} step texts are drawn at once` };
    }
    case 'asks-answered': {
      const asks = cx.answer.script.split('\n').filter((l) => /^ask\b/.test(l));
      const doc = await cx.tab.eval<string>(`document.body.innerText`);
      const blank = asks.filter((l) => /\bis=\?/.test(l));
      return asks.length === 0 && doc.length < 10 ? { check: name, verdict: 'FAIL', detail: 'no asks reached the page' } : res(name, blank.map((l) => `an ask with no accepted answer: ${l.slice(0, 50)}`), `${asks.length} asks all have an accepted answer`);
    }
    case 'mockup-type-floor': {
      const onStage = cx.answer.live.filter((e) => e.kind === 'structure' && e.phase === 'on');
      const smallest = Math.min(...onStage.map((e) => (e.fontPx > 0 ? e.fontPx : Number.POSITIVE_INFINITY)));
      if (!Number.isFinite(smallest)) return { check: name, verdict: 'FAIL', detail: 'no mock-up type measured' };
      return smallest >= floorOf(cx) ? { check: name, verdict: 'PASS', detail: `smallest type ${smallest.toFixed(1)} px` } : { check: name, verdict: 'FAIL', detail: `smallest type in the mock-up ${smallest.toFixed(1)} px (< ${floorOf(cx)})` };
    }
    case 'words-visible': {
      const re = new RegExp(String(spec['re']), 'i');
      const found = shown(cx.answer).filter((e) => re.test(e.text));
      if (found.length === 0) return { check: name, verdict: 'FAIL', detail: 'the answer words are not on stage at all' };
      const frames = await cx.tab.eval<{ x: number; y: number; width: number; height: number }[]>(`[...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }).filter((r) => r.width > 100)`);
      const hidden = found.filter((w) => frames.some((f) => inter(w.box, f) > 0.5 * area(w.box)));
      return res(name, hidden.map((w) => `"${w.text.slice(0, 20)}" is behind a full-page app`), `${found.length} answer line(s) readable`);
    }
    case 'tappable-stops': {
      const picks = (await controls(cx.tab)).filter((c) => c.control === 'pick' || c.control === 'button');
      const stops = Math.max(...picks.map((c) => c.options.length), picks.length, 0);
      return stops >= Number(spec['min']) ? { check: name, verdict: 'PASS', detail: `${stops} tappable stops` } : { check: name, verdict: 'FAIL', detail: `${stops} tappable stop(s), wanted ${String(spec['min'])}: a step-by-step answer you cannot step through` };
    }
    case 'choices': {
      // a choice the person taps: `say choice` lines the stage shows, never a map of cards or a document
      const lines = cx.answer.script.split('\n').filter((l) => /^say\b[^|]*\bchoice\b/.test(l)).length;
      const want = Number(spec['min'] ?? 1);
      return lines >= want ? { check: name, verdict: 'PASS', detail: `${lines} choice(s) to tap` } : { check: name, verdict: 'FAIL', detail: `${lines} tappable choice(s), wanted ${want}` };
    }
    case 'ask-first': {
      // a problem for a learner: the question is a thing to answer (an ask line, or a field), never a stepper that walks the working, and no answer given away in a tap
      const script = cx.answer.script;
      const asks = script.split('\n').filter((l) => /^ask\b/.test(l)).length;
      const fields = (await controls(cx.tab)).filter((c) => c.control === 'input').length;
      const walks = script.split('\n').filter((l) => /^pick\b[^|]*\bsteps\b/.test(l));
      const bare = script.split('\n').filter((l) => /^say\b[^|]*\bchoice\b[^|]*\|\s*\W*\d+\W*$/.test(l));
      const bad: string[] = [];
      if (asks + fields === 0) bad.push('the question has no way to answer (no ask, no field)');
      if (walks.length > 0) bad.push(`a stepper walks the working: ${walks[0]?.slice(0, 50)}`);
      if (bare.length > 0) bad.push(`a choice is a bare number: ${bare[0]?.slice(0, 50)}`);
      return res(name, bad, `${asks} ask(s), ${fields} field(s), no stepper, no number as a choice`);
    }
    case 'one-stepper': {
      const steppers = (await controls(cx.tab)).filter((c) => c.control === 'pick' && c.form === 'steps');
      return res(name, steppers.length > Number(spec['max'] ?? 1) ? [`${steppers.length} steppers on stage at rest`] : [], `${steppers.length} stepper(s) on stage`);
    }
    case 'starts-new-scene': {
      const first = cx.answer.script.split('\n').find((l) => l.trim() !== '') ?? '';
      return res(name, /^(scene|look|part|deck)\b/.test(first) ? [] : [`the answer opens with "${first.slice(0, 40)}", not a scene: it continues the last drawing`], 'a new subject opens a scene (or a top-level part)');
    }
    case 'last-scene-has-drawing': {
      // a tour ends on a scene that still shows something drawn (or a control), not on words and choices alone
      const scenes = cx.answer.script.split(/^scene\b/m).slice(1);
      const last = scenes[scenes.length - 1] ?? '';
      const drawn = last.split('\n').filter((l) => /^(circle|ellipse|rect|line|poly|path|arc|chart|table|flow|tree|cycle|timeline|map|slider|toggle|pick|app|pix|screen|code|button)\b/.test(l.trim()));
      return res(name, scenes.length === 0 ? ['no scene'] : drawn.length === 0 ? ['the last scene holds words only, no drawing or control'] : [], `the last scene has ${drawn.length} drawn or control line(s)`);
    }
    case 'sealed-at-rest':
      return sealedScan(cx, (spec['values'] as string[] | undefined) ?? []);
    case 'asks-stand': {
      // HI1. The asks are controls of the stage (no app, no document), and the first is open while the later ones wait as numbered rows
      const all = (await controls(cx.tab)).filter((c) => c.askState !== undefined);
      const want = Number(spec['min'] ?? 1);
      const bad: string[] = [];
      if (all.length < want) bad.push(`${all.length} ask(s) on the stage, wanted ${want}`);
      if (all.length > 1 && all[0]?.askState?.locked === true) bad.push('the first ask is locked');
      if (all.length > 1 && all.slice(1).some((c) => c.askState?.locked !== true && c.askState?.verdict === 'open' && all[0]?.askState?.verdict === 'open')) bad.push('a later ask is open before the first is settled');
      return res(name, bad, `${all.length} ask(s) stand on the stage`);
    }
    case 'no-app': {
      const lines = cx.answer.script.split('\n').filter((l) => /^(app|code)\b/.test(l));
      return res(name, lines.map((l) => `a standing "no code" was broken: ${l.slice(0, 40)}`), 'no app or code block');
    }
    case 'steps-laid-out': {
      // a breakdown is on stage whole: at least `min` numbered steps shown at rest, none hidden behind a stepper
      const numbered = shown(cx.answer).filter((e) => /^\s*(?:step\s*)?\d+\s*[.):-]/i.test(e.text.trim()) || /^\s*step\s*\d+/i.test(e.text.trim()));
      return numbered.length >= Number(spec['min'] ?? 3) ? { check: name, verdict: 'PASS', detail: `${numbered.length} numbered steps on stage at rest` } : { check: name, verdict: 'FAIL', detail: `${numbered.length} numbered step(s) on stage at rest, wanted ${String(spec['min'] ?? 3)}` };
    }
    case 'blank-working': {
      // nothing the learner should work out is on stage at rest (`values`: regex of the answer and the in-between values), and one ask or field waits for the answer
      const texts = [...shown(cx.answer).map((e) => e.text), ...(await cx.tab.eval<string[]>(`[window.__stage.elements().map((e) => String(e.text || '')).join('\\n'), document.body.innerText].join('\\n').split('\\n')`))];
      const leaked = texts.filter((t) => new RegExp(String(spec['values'])).test(t));
      const asks = cx.answer.script.split('\n').filter((l) => /^ask\b/.test(l)).length;
      const fields = (await controls(cx.tab)).filter((c) => c.control === 'input' || (c.control === 'pick' && c.form !== 'steps')).length;
      const bad = leaked.slice(0, 2).map((t) => `a worked value is on stage at rest: "${t.slice(0, 40)}"`);
      if (asks + fields === 0) bad.push('no ask or field for the answer');
      if (asks > 1) bad.push(`${asks} asks, wanted one`);
      return res(name, bad, `no worked value at rest, ${asks} ask(s), ${fields} field(s)`);
    }
    case 'learner-native': {
      // a problem posed to a learner is done through the language's own pieces: something to answer or move (ask, pick, slider, field), no stepper walking the answer, no live app, no number given as a choice
      const script = cx.answer.script;
      const asks = script.split('\n').filter((l) => /^ask\b/.test(l)).length;
      const ctl = (await controls(cx.tab)).filter((c) => c.control === 'input' || c.control === 'slider' || c.control === 'toggle' || (c.control === 'pick' && c.form !== 'steps'));
      const apps = script.split('\n').filter((l) => /^app\b/.test(l)).length;
      const bad: string[] = [];
      // a lesson page of parts ("0 of 3 done") is the language's own home for asks: the asks are written as each part is opened
      const lessonPage = /\b\d+ of \d+ done\b/.test(await cx.tab.eval<string>(`document.body.innerText`));
      if (asks + ctl.length === 0 && !lessonPage) bad.push('nothing to answer or move (no ask, pick, slider or field, no lesson page)');
      if (apps > 0) bad.push('the answer is a live app');
      const walks = script.split('\n').filter((l) => /^pick\b[^|]*\bsteps\b/.test(l));
      if (walks.length > 0) bad.push(`a stepper walks the working: ${walks[0]?.slice(0, 50)}`);
      const bare = script.split('\n').filter((l) => /^say\b[^|]*\bchoice\b[^|]*\|\s*\W*\d+\W*$/.test(l));
      if (bare.length > 0) bad.push(`a choice is a bare number: ${bare[0]?.slice(0, 50)}`);
      return res(name, bad, `${asks} ask(s), ${ctl.length} control(s), no app, no stepper`);
    }
    case 'app-learner': {
      // a learner's problem as a small live app: on stage, answers to pointers and touch, shows no answer at rest, and fits the screen
      const rows = (await cx.tab.eval<string[]>(`[...document.querySelectorAll('iframe')].map((f) => f.srcdoc || '')`)).join('\n');
      const frames = await cx.tab.eval<{ x: number; right: number; height: number }[]>(`[...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); return { x: r.left, right: r.right, height: r.height }; }).filter((r) => r.height > 50)`);
      const bad: string[] = [];
      if (frames.length === 0 || rows.trim() === '') return { check: name, verdict: 'FAIL', detail: 'no live app on stage' };
      if (!/(pointerdown|touchstart|mousedown|onclick|onpointer|addEventListener\(\s*['"](?:click|pointer|touch|mouse))/.test(rows)) bad.push('the app has no pointer or touch handlers');
      if (/(pointermove|mousemove)/.test(rows) && !/(touch-action|touchmove)/.test(rows)) bad.push('the app drags with the pointer but is not set up for touch (touch-action)');
      const visible = rows.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ');
      const said = cx.answer.script.split('\n').filter((l) => /^say\b/.test(l)).map((l) => l.split('|').slice(1).join('|')).join('\n');
      const leak = /=\s*\d|\b(?:each|every)\b[^.\n]{0,25}\bgets?\s+\d|\bthe answer is\b/i.exec(`${visible}\n${said}`);
      if (leak !== null) bad.push(`an answer or a working shows at rest: "${leak[0]}"`);
      if (frames.some((f) => f.x < -1 || f.right > cx.screen.width + 1)) bad.push('the app does not fit the screen width');
      if (cx.answer.script.split('\n').some((l) => /^pick\b[^|]*\bsteps\b/.test(l))) bad.push('a stepper is on stage beside the app');
      return res(name, bad, 'a live app with pointer or touch handlers, fitting, no answer at rest');
    }
    case 'is-app': {
      const frames = await cx.tab.eval<number>(`[...document.querySelectorAll('iframe')].filter((f) => f.getBoundingClientRect().height > 50).length`);
      return res(name, frames === 0 ? ['the first answer is not a live app'] : [], `${frames} live app(s) on stage`);
    }
    case 'no-failed-requests': {
      const bad = [...new Set([...cx.early, ...cx.tab.failedRequests.map((f) => f.text)])];
      return res(name, bad.map((b) => `failed request ${b.slice(0, 60)}`), 'every request answered');
    }
    case 'controls-reachable': {
      const all = await controls(cx.tab);
      const bad = all.filter((c) => c.box.y + c.box.height > cx.screen.height + 1 || c.box.y < -1 || c.box.x + c.box.width > cx.screen.width + 1).map((c) => `control "${c.label.slice(0, 18)}" is at y ${Math.round(c.box.y)}, off a ${cx.screen.height} px stage`);
      return all.length === 0 ? { check: name, verdict: 'FAIL', detail: 'no controls on stage' } : res(name, bad, `${all.length} controls all on the stage`);
    }
    case 'pick-taps': {
      const picks = (await controls(cx.tab)).filter((c) => c.control === 'pick' && c.options.length >= 3);
      if (picks.length === 0) return { check: name, verdict: 'FAIL', detail: 'no pick with 3 or more options' };
      const bad: string[] = [];
      for (const p of picks.slice(0, 2)) {
        for (const i of [2, 1]) {
          const now = (await controls(cx.tab)).find((c) => c.id === p.id) ?? p;
          const before = JSON.stringify(now.value);
          // a pick that shows its options as a row or a list is tapped on the option; one that shows a stepper (back, the value, next) is tapped on its own arrow: its middle is not an option
          const own = now.parts?.find((part) => part.part === `option:${i + 1}`);
          const stepper = now.parts?.find((part) => part.part === 'next');
          const at = own?.box ?? stepper?.box ?? null;
          const x = at === null ? now.box.x + (now.box.width * (i + 0.5)) / now.options.length : at.x + at.width / 2;
          const y = at === null ? now.box.y + now.box.height / 2 : at.y + at.height / 2;
          await cx.tab.tap(x, y);
          await sleep(500);
          const after = JSON.stringify(((await controls(cx.tab)).find((c) => c.id === p.id) ?? p).value);
          if (after === before) bad.push(`tapping ${own === undefined && stepper !== undefined ? 'next' : `option ${i + 1}`} of "${p.id}" left the value at ${before}`);
        }
      }
      return res(name, bad, `taps move ${picks.length} pick(s)`);
    }
    case 'page-fits': {
      const m = await cx.tab.eval<{ top: number; over: number }>(`({ top: Math.round(document.scrollingElement.scrollTop), over: Math.round(document.scrollingElement.scrollHeight - innerHeight) })`);
      return res(name, m.top !== 0 || m.over > 2 ? [`the page itself scrolls (scrollTop ${m.top}, ${m.over} px taller than the window)`] : [], 'the page does not scroll');
    }
    case 'figure-fills': {
      const parts = cx.answer.live.filter((e) => e.kind !== 'text' && e.phase === 'on' && area(e.box) > 400 && area(e.box) < 0.8 * cx.screen.width * cx.screen.height);
      if (parts.length === 0) return { check: name, verdict: 'FAIL', detail: 'no figure on stage' };
      const y0 = Math.min(...parts.map((e) => e.box.y));
      const y1 = Math.max(...parts.map((e) => e.box.y + e.box.height));
      const share = (y1 - y0) / Math.max(1, cx.answer.viewport.height);
      return share >= Number(spec['min'] ?? 0.5) ? { check: name, verdict: 'PASS', detail: `the figure spans ${Math.round(share * 100)}% of the stage height` } : { check: name, verdict: 'FAIL', detail: `the figure spans only ${Math.round(share * 100)}% of the stage height` };
    }
    case 'group-rigid': {
      // a group moved as one: either all of its parts have left the stage, or every part is there at its own size and place about the others
      // (parts: id -> [centre x, centre y, width, height] in the group's own units; `unit` is a part of known size that sets px per unit)
      const parts = spec['parts'] as Record<string, readonly number[]>;
      const unitId = String(spec['unit']);
      const tol = Number(spec['tol'] ?? 0.35);
      const here = (id: string): LiveElement | undefined => cx.answer.live.find((e) => e.id === id && e.phase === 'on' && e.opacity > 0.05 && area(e.box) > 0);
      const ids = Object.keys(parts);
      const present = ids.filter((id) => here(id) !== undefined);
      if (present.length === 0) return spec['expect'] === 'there' ? { check: name, verdict: 'FAIL', detail: 'the group is not on stage' } : { check: name, verdict: 'PASS', detail: `all ${ids.length} parts left the stage together` };
      if (spec['expect'] === 'gone') return { check: name, verdict: 'FAIL', detail: `the group was sent off the canvas but ${present.join(', ')} are still on stage` };
      const bad: string[] = [];
      if (present.length < ids.length) bad.push(`only ${present.join(', ')} of ${ids.join(', ')} are on stage`);
      const ref = here(unitId);
      const refSpec = parts[unitId];
      if (ref === undefined || refSpec === undefined) return { check: name, verdict: 'FAIL', detail: `the unit part ${unitId} is not on stage`, };
      const unit = ref.box.width / (refSpec[2] as number);
      const refAt = centre(ref.box);
      for (const id of present) {
        const e = here(id) as LiveElement;
        const [cxu, cyu, w, h] = parts[id] as readonly number[];
        const wantW = (w as number) * unit;
        const wantH = (h as number) * unit;
        const slack = 2 * unit;
        if (e.box.width > wantW * (1 + tol) + slack || e.box.height > wantH * (1 + tol) + slack) bad.push(`${id} is ${Math.round(e.box.width)}x${Math.round(e.box.height)} px, its own size is about ${Math.round(wantW)}x${Math.round(wantH)}`);
        const at = centre(e.box);
        const dx = at.x - refAt.x - ((cxu as number) - (refSpec[0] as number)) * unit;
        const dy = at.y - refAt.y - ((cyu as number) - (refSpec[1] as number)) * unit;
        if (Math.hypot(dx, dy) > 4 * unit) bad.push(`${id} is ${Math.round(Math.hypot(dx, dy))} px from where the group holds it`);
      }
      // `apart`: the group came to where it was sent: this part stands this many of the group's units from another thing's centre
      const apart = spec['apart'] as { readonly from: string; readonly units: number; readonly tol: number } | undefined;
      if (apart !== undefined) {
        const other = here(apart.from);
        if (other === undefined) bad.push(`${apart.from} is not on stage`);
        else {
          const got = (refAt.x - centre(other.box).x) / unit;
          if (Math.abs(got - apart.units) > apart.tol) bad.push(`the group stands ${got.toFixed(0)} units right of ${apart.from}, it was sent to ${apart.units}`);
        }
      }
      return res(name, bad, `${present.length} parts at their own size and place about each other`);
    }
    case 'has-shapes': {
      const n = cx.answer.live.filter((e) => e.kind !== 'text' && e.phase === 'on' && area(e.box) > 100).length;
      return n >= Number(spec['min']) ? { check: name, verdict: 'PASS', detail: `${n} shapes on stage` } : { check: name, verdict: 'FAIL', detail: `${n} shape(s) on stage, wanted ${String(spec['min'])}: a table and a bar, no shapes` };
    }
    case 'photos-present': {
      const claims = /photo|picture|image/i.test(cx.answer.script);
      const has = /<img\s|background-image|url\(|^pic\b/m.test(cx.answer.script);
      return !claims ? { check: name, verdict: 'PASS', detail: 'no photo claimed' } : has ? { check: name, verdict: 'PASS', detail: 'the page carries pictures' } : { check: name, verdict: 'FAIL', detail: 'the answer claims photos but the page has no img, background image or pic' };
    }
    case 'kit-lint-clean': {
      const notes = cx.answer.mockups.flatMap((m) => m.notes).filter((n) => ['outside', 'overlap', 'lost-words'].includes(n.kind));
      return res(name, notes.map((n) => `${n.kind} ${n.id}`), `${cx.answer.mockups.length} mock-up(s), no lint notes`);
    }
    case 'dashboard-shape': {
      // a dashboard is one kit page: a row of headline numbers (`stat`) and panels (`card`), the kit's lint clean (no overlap, nothing outside)
      const lines = cx.answer.script.split('\n').map((l) => l.replace(/^\w+ \w+ \| (?=\s*(?:row|col|stat)\b)/, ''));
      const stats = lines.filter((l) => /^\s*stat\b/.test(l)).length;
      const panels = lines.filter((l) => /^\s*(?:col|row)\b[^|]*\bcard\b/.test(l)).length;
      const notes = cx.answer.mockups.flatMap((m) => m.notes).filter((n) => ['outside', 'overlap', 'lost-words'].includes(n.kind));
      const min = (k: string, d: number): number => Number(spec[k] ?? d);
      return res(name, [...(cx.answer.mockups.length === 0 ? ['no kit page on stage'] : []), ...(stats < min('stats', 3) ? [`${stats} stat card(s), want ${min('stats', 3)}`] : []), ...(panels < min('panels', 2) ? [`${panels} panel(s), want ${min('panels', 2)}`] : []), ...notes.map((n) => `${n.kind} ${n.id}`)], `${stats} stat cards, ${panels} panels, no lint notes`);
    }
    case 'app-type': {
      // an app's text is the stage's own size, and every target is a finger wide, on the screen as shown (frame size times the scale the frame is shown at)
      const reads = await frameReads(cx);
      if (reads.length === 0) return { check: name, verdict: 'FAIL', detail: 'no live app on stage' };
      const bodies = reads.map((r) => r.body).filter((b): b is number => b !== null);
      const body = stageBody(cx) ?? (bodies.length === 0 ? null : (bodies[0] as number));
      if (body === null) return { check: name, verdict: 'FAIL', detail: 'the stage body size is not known' };
      const floor = Number(spec['min'] ?? 0.8) * body;
      const tap = Number(spec['tap'] ?? 44);
      const bad: string[] = [];
      for (const r of reads) {
        for (const t of r.texts) if (t.px * r.scale < floor - 0.5) bad.push(`"${t.t}" ${(t.px * r.scale).toFixed(1)} px (< ${floor.toFixed(1)}, a stage body of ${body.toFixed(0)})`);
        for (const t of r.taps) if (Math.min(t.w, t.h) * r.scale < tap - 0.5) bad.push(`target "${t.t}" ${(t.w * r.scale).toFixed(0)}x${(t.h * r.scale).toFixed(0)} px (< ${tap})`);
      }
      const texts = reads.flatMap((r) => r.texts.map((t) => t.px * r.scale));
      const taps = reads.flatMap((r) => r.taps.map((t) => Math.min(t.w, t.h) * r.scale));
      return res(name, bad, `${texts.length} pieces of text, the smallest ${Math.min(...texts).toFixed(1)} px on a stage body of ${body.toFixed(0)} (${((Math.min(...texts) / body) * 100).toFixed(0)}%); ${taps.length} targets, the smallest ${taps.length === 0 ? 'none' : Math.min(...taps).toFixed(0)} px; shown at ${reads.map((r) => r.scale.toFixed(2)).join('/')}`);
    }
    case 'figure-type': {
      // a figure's labels and its strip are set from the stage's body size (not from the figure's own scale), and the figure fills the room it is given
      const figs = await cx.tab.eval<{ labelPx: number; captionPx: number; labels: number; scale: number; subject: { width: number; height: number }; stage: { width: number; height: number }; room: { width: number; height: number }; stepper: { prev: { width: number; height: number }; next: { width: number; height: number } } | null }[]>(
        `(() => { const out = []; for (const [, v] of (window.__figures || new Map())) { const l = v.layout; out.push({ labelPx: l.labelPx, captionPx: l.chrome.px, labels: l.labels.length, scale: l.scale, subject: l.subject, stage: l.stage, room: v.room, stepper: l.chrome.stepper ? { prev: l.chrome.stepper.prev, next: l.chrome.stepper.next } : null }); } return out; })()`,
      );
      if (figs.length === 0) return { check: name, verdict: 'FAIL', detail: 'no figure on stage' };
      const body = stageBody(cx);
      if (body === null) return { check: name, verdict: 'FAIL', detail: 'the stage body size is not known' };
      const bad: string[] = [];
      const notes: string[] = [];
      for (const f of figs) {
        const labelMin = Number(spec['label'] ?? 0.7) * body;
        const stripMin = Number(spec['strip'] ?? 0.75) * body;
        const fill = Math.max(f.subject.width / Math.max(1, f.stage.width), f.subject.height / Math.max(1, f.stage.height));
        if (f.labels > 0 && f.labelPx < labelMin - 0.5) bad.push(`labels ${f.labelPx} px (< ${labelMin.toFixed(1)}, a stage body of ${body.toFixed(0)})`);
        if (f.captionPx < stripMin - 0.5) bad.push(`the strip's words ${f.captionPx} px (< ${stripMin.toFixed(1)})`);
        if (fill < Number(spec['fill'] ?? 0.5)) bad.push(`the figure fills ${(fill * 100).toFixed(0)}% of the room it is given (the longer side of it)`);
        if (f.stepper !== null) for (const b of [f.stepper.prev, f.stepper.next]) if (Math.min(b.width, b.height) < 44) bad.push(`a step arrow ${b.width}x${b.height} px`);
        notes.push(`labels ${f.labelPx} px, strip ${f.captionPx} px of a ${body.toFixed(0)} px body, fills ${(fill * 100).toFixed(0)}% of its room (${Math.round(f.room.width)}x${Math.round(f.room.height)})`);
      }
      return res(name, bad, notes.join('; '));
    }
    case 'chart-labels': {
      // every bar has its words under it, and the chart's text is set at no less than the stage's small size, the title at the body size
      const charts = cx.answer.charts.filter((c) => !c.waiting);
      if (charts.length === 0) return { check: name, verdict: 'FAIL', detail: 'no chart on stage' };
      const bad: string[] = [];
      const notes: string[] = [];
      for (const c of charts) {
        const probe = await cx.tab.eval<{ ticks: { x: string[]; y: string[] }; type: { label: number; title: number; credit: number; small: number } } | null>(`window.__stage.chart(${JSON.stringify(c.id)}, { reset: true }).catch(() => null)`);
        if (probe === null) {
          bad.push(`chart ${c.id} could not be read`);
          continue;
        }
        const bars = /column|bar/.test(c.kind);
        const need = bars ? c.points : 2;
        if (probe.ticks.x.length < need) bad.push(`chart ${c.id}: ${probe.ticks.x.length} label(s) under ${c.points} point(s) [${probe.ticks.x.join(' | ')}]`);
        const { label, title, credit, small } = probe.type;
        if (label < small - 0.5) bad.push(`chart ${c.id}: tick and legend text ${label} px, under the stage's small size ${small}`);
        if (title < Math.round(small * 1.25) - 1.5) bad.push(`chart ${c.id}: title ${title} px, under the stage body ${Math.round(small * 1.25)}`);
        if (credit < 11) bad.push(`chart ${c.id}: credit ${credit} px`);
        notes.push(`${c.kind}: labels [${probe.ticks.x.join(' | ')}], text ${label}/${title}/${credit} px, stage small ${small}`);
      }
      return res(name, bad, notes.join('; '));
    }
    case 'page-own-type': {
      // a real page keeps its own type: at desk widths its nav is on one line (every item on the same row) and no price line breaks across two rows
      if (cx.screen.width < Number(spec['from'] ?? 1280)) return { check: name, verdict: 'PASS', detail: `${cx.screen.width} px wide: a phone-width page may stack` };
      const targets = await cx.tab.browser.send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets');
      const bad: string[] = [];
      let seen = 0;
      for (const target of targets.targetInfos.filter((t) => t.type === 'iframe')) {
        const attached = await cx.tab.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const expression = `(() => { const navs = [...document.querySelectorAll('nav')]; const out = { navs: navs.length, bad: [] };
          const rows = (el) => { const tops = [...el.querySelectorAll('*')].filter((c) => c.children.length === 0 && c.getBoundingClientRect().width > 0).map((c) => c.getBoundingClientRect()); const ys = tops.map((r) => r.top + r.height / 2); return ys.length === 0 ? 0 : Math.max(...ys) - Math.min(...ys); };
          const lineOf = (el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3;
          for (const n of navs) if (rows(n) > lineOf(n) * 0.9) out.bad.push('nav wraps: ' + n.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40));
          for (const b of document.querySelectorAll('b, .price, .row b')) { const r = b.getClientRects(); if (r.length > 1 && /[$€£]/.test(b.textContent)) out.bad.push('price breaks: ' + b.textContent.trim().slice(0, 30)); }
          return out; })()`;
        const got = await cx.tab.browser.send<{ result?: { value?: { navs: number; bad: string[] } } }>('Runtime.evaluate', { expression, returnByValue: true }, attached.sessionId);
        const v = got.result?.value;
        if (v === undefined) continue;
        seen += v.navs;
        bad.push(...v.bad);
      }
      if (seen === 0 && bad.length === 0) return { check: name, verdict: 'FAIL', detail: 'no page with a nav on stage' };
      return res(name, bad, `${seen} nav(s) on one line at ${cx.screen.width} px`);
    }
    case 'app-fills-stage': {
      const frames = await cx.tab.eval<{ height: number }[]>(`[...document.querySelectorAll('iframe')].map((f) => ({ height: f.getBoundingClientRect().height })).filter((r) => r.height > 50)`);
      if (frames.length === 0) return { check: name, verdict: 'FAIL', detail: 'no live app on stage' };
      const share = Math.max(...frames.map((f) => f.height)) / cx.screen.height;
      return share >= Number(spec['min'] ?? 0.5) ? { check: name, verdict: 'PASS', detail: `the app is ${Math.round(share * 100)}% of the window height` } : { check: name, verdict: 'FAIL', detail: `the app is only ${Math.round(share * 100)}% of the window height` };
    }
    case 'kept-after-reload': {
      const now = shown(cx.answer).map((e) => e.text.trim()).join(' ');
      const words = cx.words.split(/\s+/).filter((w) => w.length > 3);
      const kept = words.length === 0 ? 0 : words.filter((w) => now.includes(w)).length / words.length;
      const apps = await cx.tab.eval<number>(`document.querySelectorAll('iframe').length`);
      return kept >= 0.6 || apps > 0 ? { check: name, verdict: 'PASS', detail: `${Math.round(kept * 100)}% of the words are back after a reload` } : { check: name, verdict: 'FAIL', detail: `after a reload only ${Math.round(kept * 100)}% of the words are back: the painted answer is gone` };
    }
    case 'pen-draws':
      return { check: name, verdict: 'SKIP', detail: 'worked by the pen-ring action' };
    default:
      return { check: name, verdict: 'FAIL', detail: `unknown check ${name}` };
  }
}

function redScan(dataUrl: string): string {
  return `(async () => { const t = window.__catalogueClicked; if (!t) return null; const img = new Image(); img.src = ${dataUrl}; await img.decode(); const k = img.width / innerWidth; const c = document.createElement('canvas'); const pad = 26; const x = Math.max(0, Math.floor((t.x - pad) * k)); const y = Math.max(0, Math.floor((t.y - pad) * k)); const w = Math.min(img.width - x, Math.floor((t.width + 2 * pad) * k)); const h = Math.min(img.height - y, Math.floor((t.height + 2 * pad) * k)); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, x, y, w, h, 0, 0, w, h); const d = g.getImageData(0, 0, w, h).data; let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 70 && d[i + 2] < 70) red += 1; return { red: Math.round(red / (k * k)), box: t }; })()`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Actions between asking and judging

async function act(cx: Cx, action: Action): Promise<void> {
  const { tab } = cx;
  switch (action.a) {
    case 'control': {
      const ctl = (await controls(tab)).find((c) => c.id === action['id']);
      if (ctl === undefined) return;
      const value = action['index'] !== undefined ? ctl.options[Number(action['index'])] : action['value'];
      await tab.eval(`window.__stage.control(${JSON.stringify(ctl.id)}, ${JSON.stringify(value)})`);
      await sleep(Number(action['wait'] ?? 600));
      await cx.c.rest(null, false);
      break;
    }
    case 'click-control': {
      const ctl = (await controls(tab)).find((c) => c.id === action['id']);
      if (ctl === undefined) return;
      await tab.eval(`window.__catalogueClicked = ${JSON.stringify(ctl.box)}`);
      cx.before = await tab.shot();
      await tab.tap(ctl.box.x + ctl.box.width * 0.85, ctl.box.y + ctl.box.height / 2);
      await sleep(900);
      cx.picture = await tab.shot();
      break;
    }
    case 'close-document': {
      // the lesson view is a sandboxed frame: its Close button is found by where it sits, at the top right of the frame
      const frame = await tab.eval<{ x: number; y: number; w: number } | null>(
        `(() => { const f = document.querySelector('.stage__document iframe'); const d = document.querySelector('.stage__document'); if (!f || !d || getComputedStyle(d).display === 'none') return null; const r = f.getBoundingClientRect(); return r.width > 4 ? { x: r.left, y: r.top, w: r.width } : null; })()`,
      );
      if (frame === null) return;
      await tab.tap(frame.x + frame.w - 84, frame.y + 31);
      await sleep(900);
      break;
    }
    case 'reload': {
      await tab.send('Page.reload');
      await waitFor('the page to be ready again', 60_000, async () => {
        const probe = await tab.call<Probe>('probe').catch(() => null);
        return probe !== null && probe.ready ? probe : null;
      });
      await tab.eval('window.__stage.ready');
      await cx.c.rest(null, false);
      await sleep(1500);
      break;
    }
    case 'skills-hold': {
      // SK1: the way a person does it: [+], Skills, a tap on the row. The menu closes and the chip waits by the field.
      if (!(await openSkills(tab))) return;
      const row = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', `.skill[data-skill="${String(action['id'])}"]`);
      if (row === null) return;
      await tab.tap(row.x + row.w / 2, row.y + row.h / 2);
      await sleep(500);
      break;
    }
    case 'dump': {
      // a developer's lens: what the stage holds now, written beside the pictures
      const seen = await tab.eval<unknown>(`({ elements: window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: String(e.text || '').slice(0, 50), box: e.box, phase: e.phase, opacity: e.opacity })), controls: window.__stage.controls().map((c) => ({ id: c.id, box: c.box, enabled: c.enabled, askState: c.askState })), state: window.__stage.state() })`);
      await writeFile(join(cx.dir, `${cx.screen.name}-dump-${String(action['name'] ?? 'now')}.json`), JSON.stringify(seen, null, 1));
      break;
    }
    case 'pen-ring':
      break;
    default:
  }
}

/** HI1. Nothing an ask accepts is on the screen before a try: not in the words, not in a control's label, not in the page. `values`: what the asks accept. */
async function sealedScan(cx: Cx, values: readonly string[]): Promise<Res> {
  const seen = await cx.tab.eval<string>(`[window.__stage.elements().map((e) => String(e.text || '')).join('\\n'), window.__stage.controls().map((c) => String(c.label || '') + ' ' + String(c.valueText || '')).join('\\n'), document.body.innerText].join('\\n')`);
  const bad = values.filter((v) => new RegExp(`(^|[^\\w.])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w.])`, 'i').test(seen)).map((v) => `"${v}" is on the screen before a try`);
  return res('sealed-at-rest', bad, `${values.length} accepted answer(s), none on the screen before a try`);
}


/**
 * HI1. A person works an ask of the stage with real input: types into the blank (or taps a choice), presses Check, opens a hint, gives up with Show me.
 * `tries` are typed, or `#n` is the nth choice; each is checked on a press and the state read back. Every picture is kept beside the run's own.
 */
async function askFlowOne(cx: Cx, action: Action): Promise<Res[]> {
  const id = String(action['id']);
  const tries = (action['tries'] as string[] | undefined) ?? [];
  const wrongFirst = action['wrongFirst'] !== false;
  const out: Res[] = [];
  const { tab } = cx;
  const find = async (): Promise<Ctl | undefined> => (await controls(tab)).find((c) => c.id === id);
  const part = (ctl: Ctl, name: string): { x: number; y: number } | null => {
    const found = ctl.parts?.find((p) => p.part === name);
    return found === undefined ? null : { x: found.box.x + found.box.width / 2, y: found.box.y + found.box.height / 2 };
  };
  /** the page is read as a frame draws it, so a part that has only just arrived (Check, once the blank holds words) is waited for a little */
  const until = async <T,>(read: () => Promise<T | null | undefined | false>, ms = 2500): Promise<T | null> => {
    const end = Date.now() + ms;
    for (;;) {
      const got = await read();
      if (got !== null && got !== undefined && got !== false) return got;
      if (Date.now() > end) return null;
      await sleep(80);
    }
  };
  const press = async (name: string, settle = 350): Promise<boolean> => {
    const at = await until(async () => {
      const ctl = await find();
      return ctl === undefined ? null : part(ctl, name);
    });
    if (at === null) return false;
    await tab.tap(at.x, at.y);
    await sleep(settle);
    return true;
  };
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(cx.dir, `${cx.screen.name}-ask-${id}-${name}.png`), Buffer.from((await tab.shot()).split(',')[1] ?? '', 'base64'));
  };
  const state = async (): Promise<Ctl['askState']> => (await find())?.askState;
  const first = await find();
  if (first === undefined || first.askState === undefined) return [{ check: 'ask-on-stage', verdict: 'FAIL', detail: `no ask "${id}" is on the stage` }];
  out.push({ check: 'ask-on-stage', verdict: 'PASS', detail: `ask ${id} is a control on the stage` });
  if (Array.isArray(action['sealed'])) out.push(await sealedScan(cx, action['sealed'] as string[]));
  // every part a hand works is a finger across
  const small = (first.parts ?? []).filter((p) => p.part !== 'whole' && (p.box.width < 43.5 || p.box.height < 43.5)).map((p) => `${p.part} is ${Math.round(p.box.width)}x${Math.round(p.box.height)}`);
  out.push({ check: 'hands-44', verdict: small.length === 0 ? 'PASS' : 'FAIL', detail: small.length === 0 ? 'every part is at least 44 px' : small.join('; ') });
  await shot('open');
  let hinted = false;
  let asked = 0;
  for (const [index, entry] of tries.entries()) {
    const ctl = await find();
    if (ctl === undefined) break;
    if (entry.startsWith('#')) await press(`option:${entry.slice(1)}`);
    else {
      // the blank: touch it, clear what is there, type
      await press('field');
      const had = typeof ctl.value === 'string' ? ctl.value.length : 0;
      for (let i = 0; i < had; i += 1) await tab.key('Backspace');
      await tab.type(entry);
      await until(async () => (await find())?.value === entry);
      if (index === 0) await shot('typed');
    }
    const triesBefore = (await state())?.tries ?? 0;
    const checked = await press('check', 60);
    await until(async () => ((await state())?.tries ?? 0) > triesBefore || (await find()) === undefined, 3000);
    if (!checked) out.push({ check: 'check-pressable', verdict: 'FAIL', detail: `no Check to press with "${entry}" held` });
    asked += 1;
    const now = await state();
    const last = index === tries.length - 1;
    if (!last || action['end'] === 'wrong') {
      out.push({ check: `wrong-${index + 1}`, verdict: now?.verdict === 'wrong' ? 'PASS' : 'FAIL', detail: `after "${entry}" the ask is ${now?.verdict}` });
      await shot(`wrong-${index + 1}`);
      if (action['hint'] === true && !hinted) {
        const before = now?.hints ?? 0;
        const did = await press('hint');
        await until(async () => ((await state())?.hints ?? 0) > before, 2500);
        const after = await state();
        hinted = true;
        out.push({ check: 'hint-on-tap', verdict: did && (after?.hints ?? 0) === before + 1 && after?.verdict === 'wrong' ? 'PASS' : 'FAIL', detail: `hints ${before} -> ${after?.hints}, ask is ${after?.verdict}` });
        await shot('hint');
      }
      if (action['show'] === true && index === tries.length - 2) {
        const did = await press('show');
        await until(async () => (await state())?.verdict === 'shown', 2500);
        const after = await state();
        out.push({ check: 'show-me', verdict: did && after?.verdict === 'shown' ? 'PASS' : 'FAIL', detail: `after Show me the ask is ${after?.verdict}` });
        await shot('shown');
        break;
      }
    } else {
      // an ask that tells the brain starts the next turn at once, and the stage it leaves is the next answer's: then the page's own act is what says it was right
      const told = now === undefined ? (await tab.eval<{ id?: string; text?: string; send?: boolean }[]>(`window.__stage.events().filter((e) => e.type === 'control' && e.ask === true)`)).some((e) => e.id === id && e.send === true && /\(right/.test(e.text ?? '')) : false;
      out.push({ check: 'wrong-then-right', verdict: (now?.verdict === 'right' || told) && asked >= (wrongFirst ? 2 : 1) ? 'PASS' : 'FAIL', detail: `after ${asked} tr${asked === 1 ? 'y' : 'ies'} the ask is ${now?.verdict ?? (told ? 'right, and told to the brain at once' : 'gone')}` });
      await shot('right');
    }
  }
  // the keyboard up (a phone): the room is what is left above it, and the blank and its line must both still be on the screen
  const keyboard = Number(action['keyboard'] ?? 0);
  if (keyboard > 0 && cx.mobile) {
    const ctl = await find();
    const open = ctl?.parts?.some((p) => p.part === 'field') === true;
    if (open) {
      await press('field');
      const dpr = await tab.eval<number>('window.devicePixelRatio');
      await tab.send('Emulation.setDeviceMetricsOverride', { width: cx.screen.width, height: cx.screen.height - keyboard, deviceScaleFactor: dpr, mobile: true });
      await sleep(900);
      const now = await find();
      const field = now?.parts?.find((p) => p.part === 'field')?.box;
      const whole = now?.box;
      const room = cx.screen.height - keyboard;
      const inside = field !== undefined && field.y >= 0 && field.y + field.height <= room;
      const line = whole !== undefined && field !== undefined && whole.y >= -1 && whole.y + Math.min(whole.height, field.y - whole.y + field.height) <= room;
      out.push({ check: 'keyboard-field-reachable', verdict: inside && line ? 'PASS' : 'FAIL', detail: field === undefined ? 'no field' : `with ${keyboard} px of keyboard the field is at y ${Math.round(field.y)}..${Math.round(field.y + field.height)} of ${room}; its line starts at y ${Math.round(whole?.y ?? 0)}` });
      await shot('keyboard');
      await tab.send('Emulation.setDeviceMetricsOverride', { width: cx.screen.width, height: cx.screen.height, deviceScaleFactor: dpr, mobile: true });
      await sleep(500);
    }
  }
  // the next ask opens when this one is settled, and the field stays on the screen
  const after = await find();
  if (after?.parts?.some((p) => p.part === 'field') === true) {
    const f = after.parts.find((p) => p.part === 'field')?.box;
    const view = await tab.eval<{ h: number; w: number }>(`({ h: window.visualViewport ? window.visualViewport.height : innerHeight, w: innerWidth })`);
    out.push({ check: 'field-reachable', verdict: f !== undefined && f.y >= -1 && f.y + f.height <= view.h + 1 && f.x >= -1 && f.x + f.width <= view.w + 1 ? 'PASS' : 'FAIL', detail: f === undefined ? 'no field' : `field at y ${Math.round(f.y)}..${Math.round(f.y + f.height)} of ${Math.round(view.h)}` });
  }
  // the brain is told: the page's own events say what was tried, one act each, and the finishing one says it is for the brain when the ask is the last
  const events = await tab.eval<{ type: string; id?: string; text?: string; send?: boolean; ask?: boolean }[]>(`window.__stage.events().filter((e) => e.type === 'control' && e.ask === true).map((e) => ({ type: e.type, id: e.id, text: e.text, send: e.send, ask: e.ask }))`);
  const mine = events.filter((e) => e.id === id);
  const told = mine.length >= asked && mine.some((e) => /\((right|no)/.test(e.text ?? '') || /gave up/.test(e.text ?? ''));
  if (tries.length > 0) out.push({ check: 'eyes-told', verdict: told ? 'PASS' : 'FAIL', detail: `${mine.length} act(s) sent: ${mine.map((e) => `${e.text}${e.send === true ? ' [send]' : ''}`).join(' / ').slice(0, 200)}` });
  return out;
}

/** HI1. `id: "auto"` is for a live brain, whose ids and answers are its own: each ask the script wrote is worked in order from the script's own key (the page never has it), wrong first, a hint, then right; the second is given up on instead. */
async function askFlow(cx: Cx, action: Action): Promise<Res[]> {
  if (action['id'] !== 'auto') return askFlowOne(cx, action);
  const answer = await cx.tab.call<Answer>('answer');
  const decode = (raw: string): string[] => raw.split(',').map((v) => v.replaceAll('_', ' ').trim()).filter((v) => v !== '');
  const asks = [...answer.script.matchAll(/^ask (\S+)([^|\n]*)\|/gm)].map((m) => {
    const head = m[2] ?? '';
    const is = decode(/\bis=(\S+)/.exec(head)?.[1] ?? '');
    const pick = decode(/\bpick=(\S+)/.exec(head)?.[1] ?? '');
    const open = /\bcheck=(any|done)\b/.test(head);
    return { id: m[1] as string, is, pick, open };
  });
  if (asks.length === 0) return [{ check: 'ask-on-stage', verdict: 'FAIL', detail: 'the brain wrote no ask: nothing for the person to work' }];
  const out: Res[] = [];
  let at = 0;
  for (const ask of asks.slice(0, 4)) {
    at += 1;
    const right = ask.pick.length > 0 ? `#${Math.max(1, ask.pick.findIndex((p) => ask.is.some((a) => a.toLowerCase() === p.toLowerCase())) + 1)}` : (ask.is[0] ?? 'x');
    const wrong = ask.pick.length > 0 ? `#${Math.max(1, ask.pick.findIndex((p) => !ask.is.some((a) => a.toLowerCase() === p.toLowerCase())) + 1)}` : 'zq';
    const tries = ask.open ? [right] : [wrong, right];
    const giveUp = at === 2 && !ask.open;
    const rows = await askFlowOne(cx, { a: 'ask-flow', id: ask.id, tries: giveUp ? [wrong, wrong] : tries, hint: !ask.open, wrongFirst: !ask.open, ...(giveUp ? { show: true } : {}), ...(ask.open ? {} : {}), sealed: ask.open || ask.pick.length > 0 ? [] : [] });
    out.push(...rows.map((r) => ({ ...r, check: `${r.check}` })));
  }
  // an ask that tells the brain starts its next turn: it is waited for, so the picture that follows is the stage at rest
  await cx.c.rest(null, false).catch(() => undefined);
  return out;
}

/** [+] then Skills: the view is open and its rows are loaded; false when the page has no such entry */
async function openSkills(tab: Tab): Promise<boolean> {
  const plus = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__plus');
  if (plus === null) return false;
  await tab.tap(plus.x + plus.w / 2, plus.y + plus.h / 2);
  await sleep(300);
  const entry = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__item[data-item="skills"]');
  if (entry === null) return false;
  await tab.tap(entry.x + entry.w / 2, entry.y + entry.h / 2);
  await waitFor('the skills to be listed', 10_000, async () => ((await tab.eval<number>(`document.querySelectorAll('.skill').length`)) > 0 ? true : null)).catch(() => undefined);
  await sleep(200);
  return true;
}

interface SkillRow {
  readonly id: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly off: boolean;
  readonly tags: string;
}
const skillRows = (tab: Tab): Promise<SkillRow[]> =>
  tab.eval<SkillRow[]>(`[...document.querySelectorAll('.skill')].map((e) => ({ id: e.dataset.skill, name: e.querySelector('.composer__label').textContent, hidden: e.hidden, off: e.classList.contains('skill--off'), tags: e.querySelector('.skill__tags').textContent }))`);

/** the Skills view: each made-up skill once (the double once, a twin once), the switched-off one grey, a search narrows, the phone's list scrolls inside its view and leaves the bar clear */
async function skillsListed(cx: Cx, spec: Spec): Promise<Res> {
  const name = 'skills-list';
  const bad: string[] = [];
  if (!(await openSkills(cx.tab))) return { check: name, verdict: 'FAIL', detail: 'the [+] menu has no Skills entry' };
  const rows = await skillRows(cx.tab);
  const shown = rows.filter((row) => !row.hidden);
  for (const want of (spec['names'] as string[]) ?? []) {
    const n = shown.filter((row) => row.name === want).length;
    if (n !== 1) bad.push(`${want} is listed ${n} times`);
  }
  for (const want of (spec['grey'] as string[]) ?? []) if (!shown.some((row) => row.name === want && row.off)) bad.push(`${want} is not shown grey`);
  const noise = shown.filter((row) => !row.off && /off in Claude Code/.test(row.tags));
  if (noise.length > 0) bad.push('a skill that is on says it is off');
  await cx.tab.eval(`(() => { const i = document.querySelector('.skills__search'); i.focus(); i.value = ${JSON.stringify(spec['search'] ?? 'led')}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const found = (await skillRows(cx.tab)).filter((row) => !row.hidden).map((row) => row.name);
  const only = (spec['only'] as string[]) ?? [];
  if (found.join(',') !== only.join(',')) bad.push(`searching "${String(spec['search'] ?? 'led')}" leaves ${found.join(', ') || 'nothing'}, wanted ${only.join(', ')}`);
  await cx.tab.eval(`(() => { const i = document.querySelector('.skills__search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const geo = await cx.tab.eval<{ top: number; bottom: number; barTop: number; scrolls: boolean; inside: boolean; page: boolean; vw: number; left: number; right: number }>(
    `(() => { const m = document.querySelector('.composer__menu'); const b = m.getBoundingClientRect(); const bar = document.querySelector('.prompt__form').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, barTop: bar.top, scrolls: m.scrollHeight > m.clientHeight + 1 && getComputedStyle(m).overflowY !== 'visible', inside: b.top >= 0, page: document.documentElement.scrollHeight > innerHeight + 1, vw: innerWidth, left: b.left, right: b.right }; })()`,
  );
  if (!geo.inside) bad.push('the list starts above the screen');
  if (geo.bottom > geo.barTop + 1) bad.push('the list covers the bar');
  if (geo.page) bad.push('the page scrolls');
  if (geo.left < -1 || geo.right > geo.vw + 1) bad.push('the list runs off the side');
  if (cx.mobile && !geo.scrolls) bad.push('the list does not scroll inside its view');
  await cx.tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cx.tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(200);
  return res(name, bad, `${shown.length} skills, each once; ${((spec['grey'] as string[]) ?? []).join(', ')} grey; "${String(spec['search'] ?? 'led')}" leaves ${found.join(', ')}${cx.mobile ? '; the list scrolls inside its view and the bar is clear' : ''}`);
}

/** a tap on a row puts a chip by the field, closes the menu and leaves the field empty; the chip's x takes it away again */
async function skillsChip(cx: Cx, spec: Spec): Promise<Res> {
  const name = 'skills-chip';
  const id = String(spec['id']);
  if (!(await openSkills(cx.tab))) return { check: name, verdict: 'FAIL', detail: 'the [+] menu has no Skills entry' };
  const row = await cx.tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', `.skill[data-skill="${id}"]`);
  if (row === null) return { check: name, verdict: 'FAIL', detail: `no row for ${id}` };
  await cx.tab.tap(row.x + row.w / 2, row.y + row.h / 2);
  await sleep(500);
  const state = await cx.tab.eval<{ chips: string[]; open: boolean; focus: string; field: string; bar: boolean }>(
    `(() => { const m = document.querySelector('.composer__menu'); const chip = document.querySelector('.skill-chip'); const bar = document.querySelector('.prompt__form').getBoundingClientRect(); const c = chip ? chip.getBoundingClientRect() : null; return { chips: [...document.querySelectorAll('.skill-chip')].map((e) => e.dataset.skill), open: !m.hidden, focus: document.activeElement?.className || '', field: document.querySelector('.prompt__input').value, bar: c !== null && c.bottom <= bar.top + 1 && c.left >= 0 && c.right <= innerWidth } })()`,
  );
  const bad: string[] = [];
  if (state.chips.join(',') !== id) bad.push(`chips held: ${state.chips.join(', ') || 'none'}, wanted ${id}`);
  if (state.open) bad.push('the menu stayed open');
  if (state.field !== '') bad.push('the field was not left empty');
  if (!state.bar) bad.push('the chip is not above the field inside the screen');
  const remove = await cx.tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.skill-chip__remove');
  if (remove === null) bad.push('the chip has no remove button');
  else {
    if (remove.w < 40 || remove.h < 32) bad.push(`the chip's remove button is ${Math.round(remove.w)}x${Math.round(remove.h)} px, too small to tap`);
    await cx.tab.tap(remove.x + remove.w / 2, remove.y + remove.h / 2);
    await sleep(300);
    if ((await cx.tab.eval<number>(`document.querySelectorAll('.skill-chip').length`)) !== 0) bad.push('the chip stayed after its x was tapped');
  }
  return res(name, bad, `a tap on ${id} holds it as a chip above the field, the menu closes, and the chip's x takes it away`);
}

/** what the session log says the brain was sent (the newest brief of the newest session); only a live run keeps one in the data dir given */
async function lastBrief(dataDir: string): Promise<string | null> {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const file = files[files.length - 1];
  if (file === undefined) return null;
  const rows = (await readFile(join(dir, file), 'utf8')).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
  const brief = rows.filter((r) => r['type'] === 'brief' && r['form'] !== 'script' && (r['pass'] === undefined || r['pass'] === 1)).at(-1);
  return typeof brief?.['text'] === 'string' ? brief['text'] : null;
}
let briefDataDir = '';

/** the pen over a live mock-up part: a ring started on the pay button must draw, not press */
async function penRing(cx: Cx): Promise<Res> {
  const { tab } = cx;
  const plus = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__plus');
  if (plus === null) return { check: 'pen-draws', verdict: 'FAIL', detail: 'no + menu' };
  await tab.tap(plus.x + plus.w / 2, plus.y + plus.h / 2);
  await sleep(300);
  const draw = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__item[data-item="draw"]');
  if (draw === null) return { check: 'pen-draws', verdict: 'FAIL', detail: 'the + menu has no Draw' };
  await tab.tap(draw.x + draw.w / 2, draw.y + draw.h / 2);
  await sleep(700);
  // the part is chosen with the ink bar up: a stroke can only start on a part the bar does not cover (the bar is the pen's own tool, over the stage's top edge)
  const bar = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.ink-stage__bar');
  const covered = (h: { box: { x: number; y: number; width: number; height: number } }): boolean => bar !== null && h.box.x + h.box.width / 2 >= bar.x - 4 && h.box.x + h.box.width / 2 <= bar.x + bar.w + 4 && h.box.y + h.box.height / 2 >= bar.y - 4 && h.box.y + h.box.height / 2 <= bar.y + bar.h + 4;
  const hits = (await tab.call<Answer>('answer')).mockups.flatMap((m) => m.hits).filter((h) => !covered(h));
  const part = hits.find((h) => /pay|order|checkout|place/i.test(h.part)) ?? hits.find((h) => /button/i.test(h.part)) ?? hits[0];
  if (part === undefined) return { check: 'pen-draws', verdict: 'FAIL', detail: 'no live part on the mock-up to ring' };
  const before = (await tab.call<Answer>('answer')).mockups[0]?.screen;
  const b = part.box;
  const cx0 = b.x + b.width / 2;
  const cy0 = b.y + b.height / 2;
  const points = Array.from({ length: 41 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2 - Math.PI / 2;
    return { x: cx0 + (b.width / 2 + 16) * Math.cos(a), y: cy0 + (b.height / 2 + 14) * Math.sin(a) };
  });
  // start the stroke ON the part (its centre), then go round it
  const stroke = [{ x: cx0, y: cy0 }, ...points];
  if (tab.mobile) {
    await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [stroke[0]] });
    for (const p of stroke.slice(1)) {
      await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
      await sleep(12);
    }
    await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    const first = stroke[0] as { x: number; y: number };
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, pointerType: 'mouse' });
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (const p of stroke.slice(1)) {
      await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'mouse' });
      await sleep(12);
    }
    const last = stroke[stroke.length - 1] as { x: number; y: number };
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  }
  await sleep(300);
  const inked = await tab.eval<boolean>(`[...document.querySelectorAll('.ink-bar button')].some((e) => e.getAttribute('aria-label') === 'Clear everything' && !e.disabled)`);
  const after = (await tab.call<Answer>('answer')).mockups[0]?.screen;
  return inked ? { check: 'pen-draws', verdict: 'PASS', detail: 'a stroke started on a live part left ink on the pen' } : { check: 'pen-draws', verdict: 'FAIL', detail: `a stroke started on the part "${part.part}" drew nothing: the stage took it as a press (${before === after ? 'no screen change' : `the mock-up moved to ${String(after)}`})` };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A case on a screen

interface Cell {
  verdict: 'PASS' | 'OWN' | 'FAIL' | 'ERR' | 'NOREC' | 'SKIP';
  failed: string[];
  details: Res[];
  cost?: number;
  /** PLAN-canvas step 0: what the scene squeezed where each turn that was checked came to rest (facts only, never a verdict) */
  squeeze?: { turn: number; kinds: string[]; facts: string[] }[];
}

/** the tier-1 findings the critic wrote for the newest turn of the newest session in the data dir's logs */
async function criticGates(dataDir: string, since: number): Promise<{ problems: string[]; cost: number }> {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return { problems: [], cost: 0 };
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const file = files[files.length - 1];
  if (file === undefined) return { problems: [], cost: 0 };
  const deadline = Date.now() + 120_000;
  let problems: string[] = [];
  let cost = 0;
  for (;;) {
    const rows = (await readFile(join(dir, file), 'utf8')).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, any>);
    cost = rows.filter((r) => r['at'] >= 0).reduce((sum, r) => sum + Number(r['usage']?.costUsd ?? r['outcome']?.costUsd ?? r['costUsd'] ?? 0), 0);
    const found = rows.filter((r) => r['type'] === 'critic' && r['finding'] !== undefined);
    if (found.length > 0) {
      const last = found[found.length - 1] as Record<string, any>;
      problems = (last['finding']['problems'] as Record<string, any>[]).filter((p) => p['tier'] === 1).map((p) => `${String(p['gate'])}: ${String(p['what']).slice(0, 80)}`);
      break;
    }
    if (Date.now() > deadline || since < 0) break;
    await sleep(3000);
  }
  return { problems, cost };
}

async function runCell(args: Args, c: Case, screen: Args['screens'][number], url: string, out: string, watch: boolean): Promise<Cell> {
  const dir = join(out, c.id);
  await mkdir(dir, { recursive: true });
  let opened: Tab | null = null;
  for (let attempt = 0; attempt < 3 && opened === null; attempt += 1) opened = await Tab.open(screen.width, screen.height).catch(() => null);
  if (opened === null) return { verdict: 'ERR', failed: ['run'], details: [{ check: 'run', verdict: 'FAIL', detail: 'Chrome would not start (three tries)' }] };
  const tab: Tab = opened;
  const options: Options = { url, screens: [screen], out, turns: new Set(), timeoutMs: args.timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
  const conv = new Conversation(tab, options, screen, dir);
  const cx: Cx = { tab, c: conv, screen, dir, mobile: tab.mobile, answer: null as unknown as Answer, picture: '', watched: { showAllOver: null, pillSeen: 0 }, before: '', words: '', early: [], sig: '' };
  const details: Res[] = [];
  const squeezed: NonNullable<Cell['squeeze']> = [];
  let cost = 0;
  try {
    await tab.send('DOM.enable');
    await conv.start();
    let n = 0;
    for (const turn of c.turns) {
      n += 1;
      conv.current = n;
      const results: CheckResult[] = [];
      if (n === 1) cx.early = tab.failedRequests.map((f) => f.text);
      tab.drain();
      for (const action of turn.pre ?? []) await act(cx, action);
      cx.sig = await screenSig(tab);
      let sent: boolean;
      if (turn.tap !== undefined) {
        const label = turn.tap.toLowerCase();
        const ctl =
          (await controls(tab)).find((k) => k.label.toLowerCase().includes(label)) ??
          (await tab.eval<{ box: { x: number; y: number; width: number; height: number }; text: string }[]>(`window.__stage.elements().filter((e) => e.kind === 'text' && e.phase === 'on' && e.opacity > 0.3).map((e) => ({ text: String(e.text || ''), box: e.box }))`)).find((e) => e.text.toLowerCase().includes(label));
        if (ctl === undefined) {
          details.push({ check: 'tap-found', verdict: 'FAIL', detail: `no choice "${turn.tap}" on the screen to tap` });
          sent = false;
        } else {
          await tab.tap(ctl.box.x + ctl.box.width / 2, ctl.box.y + ctl.box.height / 2);
          sent = true;
        }
      } else sent = await conv.say(args.mode === 'live' ? turn.say : `${turn.say}${twinMark(c.id, turn.say)}`, results);
      // a poller beside the wait: the Show all pill is only there while an answer plays
      let polling = true;
      const poll = (async (): Promise<void> => {
        while (polling) {
          const over = await tab
            .eval<string | null>(
              `(() => { const b = [...document.querySelectorAll('button,[role=button]')].find((e) => /show all/i.test((e.textContent || '') + (e.getAttribute('aria-label') || ''))); if (!b) return null; const r = b.getBoundingClientRect(); if (r.width < 4) return null; window.__pillSeen = (window.__pillSeen || 0) + 1; const words = (window.__stage.elements() || []).filter((e) => e.kind === 'text' && e.phase === 'on' && e.opacity > 0.3); for (const w of words) { const x = Math.max(0, Math.min(r.right, w.box.x + w.box.width) - Math.max(r.left, w.box.x)); const y = Math.max(0, Math.min(r.bottom, w.box.y + w.box.height) - Math.max(r.top, w.box.y)); if (x * y > 0.15 * Math.min(r.width * r.height, w.box.width * w.box.height)) return 'the Show all pill stands on "' + String(w.text).slice(0, 24) + '"'; } return null; })()`,
            )
            .catch(() => null);
          if (over !== null) cx.watched.showAllOver ??= over;
          cx.watched.pillSeen = await tab.eval<number>('window.__pillSeen || 0').catch(() => 0);
          await sleep(250);
        }
      })();
      const note = sent ? await conv.rest(true) : 'the turn never started';
      polling = false;
      await poll;
      details.push({ check: `rest${c.turns.length > 1 ? `-${n}` : ''}`, verdict: note === '' ? 'PASS' : 'FAIL', detail: note === '' ? 'at rest' : note });
      cx.words = shown(await tab.call<Answer>('answer')).map((e) => e.text.trim()).join(' ');
      for (const action of (args.mode === 'live' ? (turn.liveDo ?? turn.do) : turn.do) ?? []) {
        if (action.a === 'pen-ring') details.push(await penRing(cx));
        else if (action.a === 'ask-flow') details.push(...(await askFlow(cx, action)));
        else await act(cx, action);
      }
      const checks = (args.mode === 'live' ? (turn.liveCheck ?? turn.check) : turn.check) ?? [];
      if (n === c.turns.length || checks.length > 0) {
        await sleep(400);
        if (cx.picture === '' || (turn.do ?? []).every((a) => a.a !== 'click-control')) cx.picture = await tab.shot();
        cx.answer = await tab.call<Answer>('answer');
        squeezed.push({ turn: n, kinds: [...(cx.answer.squeeze?.kinds ?? [])], facts: (cx.answer.squeeze?.facts ?? []).map((fact) => `${fact.kind} ${fact.key ?? ''}: ${fact.why}`.replace('  ', ' ')) });
        await writeFile(join(dir, `${screen.name}-t${n}.png`), Buffer.from(cx.picture.split(',')[1] ?? '', 'base64'));
        for (const spec of checks) if (!(spec.k === 'pen-draws')) details.push(await runCheck(cx, spec));
        if (n === c.turns.length && c.generic !== false) for (const r of await generic(cx)) if (!details.some((d) => d.check === r.check)) details.push(r);
        cx.picture = '';
      }
      if (args.mode === 'live') {
        const gates = await criticGates(args.data, 1);
        cost += gates.cost;
        for (const p of gates.problems) details.push({ check: 'critic-tier1', verdict: 'FAIL', detail: p });
        if (gates.problems.length === 0) details.push({ check: 'critic-tier1', verdict: 'PASS', detail: 'no tier-1 finding' });
      }
    }
  } catch (error) {
    details.push({ check: 'run', verdict: 'FAIL', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return { verdict: 'ERR', failed: ['run'], details, cost, squeeze: squeezed };
  } finally {
    await tab.close().catch(() => undefined);
  }
  void watch;
  const failed = details.filter((d) => d.verdict === 'FAIL' || d.verdict === 'SKIP').map((d) => d.check);
  const ownNames = new Set([...c.own, ...c.turns.flatMap((t) => (t.check ?? []).map((s) => s.k))]);
  const ownFailed = failed.filter((name) => ownNames.has(name) || name.startsWith('rest'));
  const verdict = failed.length === 0 ? 'PASS' : ownFailed.length === 0 ? 'OWN' : 'FAIL';
  return { verdict, failed: [...new Set(failed)], details, cost, squeeze: squeezed };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A server of the build under test

/** SK1. A test server reads the made-up skills of this repository and nothing of the owner's (`catalogue/skills`) */
function skillEnv(): Record<string, string> {
  const base = join(root, 'catalogue', 'skills');
  return { SKILL_ROOTS: `user=${join(base, 'user')},synced=${join(base, 'synced')}`, SKILL_SETTINGS: join(base, 'settings.json') };
}

async function startServer(args: Args, replayFile: string, out: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const data = join(out, 'server-data');
  await mkdir(data, { recursive: true });
  const live = args.mode === 'live';
  const child: ChildProcess = spawn('pnpm', ['--filter', '@conduit/server', 'start'], {
    cwd: args.build,
    env: { ...process.env, PORT: String(args.port), DATA_DIR: live ? args.data : data, BRAIN: live ? 'claude-cli' : 'replay', ...(live ? { CLAUDE_MODEL: process.env['CLAUDE_MODEL'] ?? 'sonnet' } : {}), ...(live ? {} : { REPLAY_CASE: replayFile, REPLAY_CPS: '6000' }), IMAGE_MODEL: 'none', PICTURES: 'openverse', AGENT_PERMITS: 'auto', NODE_ENV: 'production', ...skillEnv() },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${args.port}`;
  await waitFor('the server', 90_000, async () => ((await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) ? true : null));
  return {
    url,
    stop: async () => {
      child.kill('SIGTERM');
      await sleep(600);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Results, the scoreboard, the matrix

interface CellOut {
  v: Cell['verdict'];
  failed: string[];
  /** the kinds of squeeze seen at rest, over the turns checked (absent: none squeezed, or a run from before step 0) */
  squeeze?: string[];
}
interface CaseOut {
  desk?: CellOut;
  phone?: CellOut;
  live?: CellOut;
  since: string;
}
interface ResultFile {
  label: string;
  commit: string;
  at: string;
  mode: 'replay' | 'live';
  cases: Record<string, CaseOut>;
}

const readResults = (label: string): ResultFile | null => {
  const file = existsSync(label) ? label : join(resultsDir, `${label}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ResultFile) : null;
};
const green = (o: CaseOut): boolean => o.desk?.v === 'PASS' && o.phone?.v === 'PASS' && (o.live === undefined || o.live.v === 'PASS');
const cellText = (c: CellOut | undefined): string => (c === undefined ? '-' : c.v === 'PASS' ? 'PASS' : `${c.v}: ${c.failed.slice(0, 3).join(', ')}`);
const verdictKey = (o: CaseOut | undefined): string => (o === undefined ? '-' : `${o.desk?.v ?? '-'}/${o.phone?.v ?? '-'}/${o.live?.v ?? '-'}`);

function writeBoard(file: ResultFile, cases: readonly Case[]): string {
  const greens = cases.filter((c) => file.cases[c.id] !== undefined && green(file.cases[c.id] as CaseOut)).length;
  const lines = [
    '# Failure catalogue scoreboard',
    '',
    `**${greens} of ${cases.length} green** (run \`${file.label}\` on \`${file.commit}\`, ${file.at.slice(0, 16).replace('T', ' ')}, ${file.mode})`,
    '',
    'PASS = every general gate and the case\'s own checks; OWN = the case\'s own checks pass but a general gate is red; FAIL = the case\'s failure is still there; ERR = the run broke. Green = PASS at both sizes (and live, once a live run exists). Regenerated by `pnpm catalogue`.',
    '',
    '| case | family | owner | 1280x720 | 390x844 | live | last changed |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const c of cases) {
    const o = file.cases[c.id];
    lines.push(`| ${c.id} | ${c.family} | ${c.owner} | ${cellText(o?.desk)} | ${cellText(o?.phone)} | ${cellText(o?.live)} | ${o?.since ?? '-'} |`);
  }
  return `${lines.join('\n')}\n`;
}

function compareText(now: ResultFile, then: ResultFile): string {
  const flips: string[] = [];
  for (const id of Object.keys(now.cases)) {
    const a = verdictKey(then.cases[id]);
    const b = verdictKey(now.cases[id]);
    if (a !== b) flips.push(`  ${id}: ${a} -> ${b}`);
  }
  const g = (f: ResultFile): number => Object.values(f.cases).filter(green).length;
  return `compare ${then.label} (${then.commit}, ${g(then)} green) -> ${now.label} (${now.commit}, ${g(now)} green): ${flips.length === 0 ? 'no case flipped' : `${flips.length} flipped\n${flips.join('\n')}`}`;
}

function gitHead(dir: string): string {
  try {
    return require_exec(`git -C "${dir}" rev-parse --short HEAD`);
  } catch {
    return 'unknown';
  }
}
import { execSync } from 'node:child_process';
const require_exec = (cmd: string): string => execSync(cmd, { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------------------------------------------------------------------------
// Commands

async function pool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, width) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await work(next);
    }
  }));
}

async function prepare(args: Args): Promise<void> {
  const branch = args.rest[0];
  if (branch === undefined) usage('prepare needs a branch');
  const name = args.rest[1] ?? `cat-${branch}`;
  const dir = join(root, '..', name);
  if (!existsSync(dir)) execSync(`git -C "${root}" worktree add --detach "${dir}" ${branch}`, { stdio: 'inherit' });
  execSync('pnpm install --offline --frozen-lockfile', { cwd: dir, stdio: 'ignore' });
  execSync('pnpm build', { cwd: dir, stdio: 'ignore' });
  // the replay brain that reads REPLAY_CASE lives on v3-SC; the branches under test may predate it: lay this checkout's file over theirs
  await copyFile(join(root, 'server', 'src', 'brains', 'replay', 'replay-brain.ts'), join(dir, 'server', 'src', 'brains', 'replay', 'replay-brain.ts'));
  process.stdout.write(`${dir}\n`);
}

async function matrix(args: Args): Promise<void> {
  const labels = (args.rest[0] ?? '').split(',').filter((l) => l !== '');
  if (labels.length === 0) usage('matrix needs labels: head,v3-T1,...');
  const files = labels.map((l) => readResults(l)).filter((f): f is ResultFile => f !== null);
  const cases = loadCases(null, false);
  const mark = (o: CaseOut | undefined): string => (o === undefined ? '-' : `${o.desk?.v === 'PASS' ? 'G' : o.desk?.v === 'OWN' ? 'o' : 'R'}${o.phone?.v === 'PASS' ? 'G' : o.phone?.v === 'OWN' ? 'o' : 'R'}`);
  const lines = ['# Branch matrix', '', 'Each cell is desk then phone: G = PASS, o = own checks pass but a general gate is red, R = red. Replayed on that branch head with this checkout\'s tool.', '', `| case | family | owner | ${files.map((f) => `${f.label} (${f.commit})`).join(' | ')} |`, `| --- | --- | --- | ${files.map(() => '---').join(' | ')} |`];
  for (const c of cases) lines.push(`| ${c.id} | ${c.family} | ${c.owner} | ${files.map((f) => mark(f.cases[c.id])).join(' | ')} |`);
  lines.push(`| **green** | | | ${files.map((f) => `${Object.values(f.cases).filter(green).length} of ${cases.length}`).join(' | ')} |`);
  const text = `${lines.join('\n')}\n`;
  await writeFile(join(root, 'catalogue', 'MATRIX.md'), text);
  process.stdout.write(text);
}

async function run(args: Args): Promise<void> {
  const cases = loadCases(args.only, args.chat, args.mode === 'live');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(args.data, 'catalogue', 'runs', `${args.label}-${stamp}`);
  await mkdir(out, { recursive: true });
  // the recordings of every case, as one file for the replay brain
  const turns: { match: string; script: string }[] = [];
  const missing = new Set<string>();
  for (const c of cases) {
    const file = join(recDir(args), `${c.id}.json`);
    if (!existsSync(file)) {
      missing.add(c.id);
      continue;
    }
    turns.push(...(JSON.parse(readFileSync(file, 'utf8')) as Recorded).turns.map((turn) => ({ ...turn, case: c.id, match: `${turn.match}${twinMark(c.id, turn.match)}` })));
  }
  const replayFile = join(out, 'replay-case.json');
  await writeFile(replayFile, JSON.stringify({ turns }));
  briefDataDir = args.data;
  const server = args.mode === 'live' && args.url !== null ? { url: args.url, stop: async (): Promise<void> => undefined } : await startServer(args, replayFile, out);
  const prev = readResults(args.label);
  const outFile: ResultFile = { label: args.label, commit: gitHead(args.build), at: new Date().toISOString(), mode: args.mode, cases: {} };
  const details: Record<string, Record<string, Res[]>> = {};
  const squeezes: Record<string, NonNullable<Cell['squeeze']>> = {};
  let spent = 0;
  const jobs = cases.flatMap((c) => args.screens.map((screen) => ({ c, screen })));
  const key = (screen: string): 'desk' | 'phone' => (/^\d+/.test(screen) && Number(screen.split('x')[0]) < 600 ? 'phone' : 'desk');
  try {
    await pool(jobs, args.mode === 'live' ? 1 : args.jobs, async ({ c, screen }) => {
      const slot = (outFile.cases[c.id] ??= { since: new Date().toISOString().slice(0, 10) });
      const where = args.mode === 'live' ? 'live' : key(screen.name);
      if (missing.has(c.id)) {
        slot[where] = { v: 'NOREC', failed: ['no recording'] };
        return;
      }
      if (args.mode === 'live' && spent >= args.maxUsd) {
        slot[where] = { v: 'SKIP', failed: [`--max-usd ${args.maxUsd} reached`] };
        return;
      }
      const cell = await runCell(args, c, screen, server.url, out, false);
      spent += cell.cost ?? 0;
      const kinds = [...new Set((cell.squeeze ?? []).flatMap((entry) => entry.kinds))];
      slot[where] = { v: cell.verdict, failed: cell.failed, ...(kinds.length > 0 ? { squeeze: kinds } : {}) };
      (details[c.id] ??= {})[screen.name] = cell.details;
      squeezes[`${c.id} ${screen.name}`] = cell.squeeze ?? [];
      process.stdout.write(`${cell.verdict.padEnd(5)} ${c.id} ${screen.name}${cell.failed.length > 0 ? `  [${cell.failed.join(', ')}]` : ''}${kinds.length > 0 ? `  {squeezed: ${kinds.join(', ')}}` : ''}\n`);
    });
  } finally {
    await server.stop();
  }
  if (args.mode === 'live') {
    // keep the replay columns of the same label, add the live one
    const base = readResults('head');
    for (const [id, o] of Object.entries(outFile.cases)) if (base?.cases[id] !== undefined) outFile.cases[id] = { ...(base.cases[id] as CaseOut), ...o };
  }
  for (const [id, o] of Object.entries(outFile.cases)) {
    const before = prev?.cases[id];
    o.since = before !== undefined && verdictKey(before) === verdictKey(o) ? before.since : new Date().toISOString().slice(0, 10);
  }
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, `${args.label}.json`), `${JSON.stringify(outFile, null, 1)}\n`);
  await writeFile(join(out, 'details.json'), JSON.stringify(details, null, 1));
  await writeFile(join(out, 'squeeze.json'), JSON.stringify(squeezes, null, 1));
  const squeezedCells = Object.entries(squeezes).filter(([, turns]) => turns.some((turn) => turn.kinds.length > 0));
  process.stdout.write(`squeezed at rest: ${squeezedCells.length} of ${Object.keys(squeezes).length} cells (details in ${join(out, 'squeeze.json')})\n`);
  const greens = Object.values(outFile.cases).filter(green).length;
  process.stdout.write(`\n${greens} of ${cases.length} green (${args.label}, ${outFile.commit}); pictures and details in ${out}\n`);
  if (args.board && args.only === null && args.label === 'head') await writeFile(join(root, 'catalogue', 'SCOREBOARD.md'), writeBoard(outFile, cases));
  const against = args.compare ?? (prev !== null ? args.label : null);
  const then = against === null ? null : args.compare !== null ? readResults(args.compare) : prev;
  if (then !== null) process.stdout.write(`${compareText(outFile, then)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.sub === 'record') return recordAll(args);
  if (args.sub === 'prepare') return prepare(args);
  if (args.sub === 'matrix') return matrix(args);
  return run(args);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`catalogue: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
