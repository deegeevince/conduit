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
}
type Spec = { readonly k: string } & Record<string, unknown>;
type Action = { readonly a: string } & Record<string, unknown>;
interface CaseTurn {
  readonly say: string;
  readonly source: Source;
  readonly do?: readonly Action[];
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

function loadCases(only: readonly string[] | null, chat = true): Case[] {
  const all = readdirSync(casesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(casesDir, name), 'utf8')) as Case);
  const unknown = (only ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) usage(`no case ${unknown.join(', ')}`);
  return all.filter((c) => (only === null || only.includes(c.id)) && (chat || c.surface !== 'chat' || (only?.includes(c.id) ?? false)));
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
  for (const c of loadCases(args.only)) {
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
  return tab.eval<Ctl[]>(`window.__stage.controls().map((c) => ({ id: c.id, control: c.control, label: c.label, options: c.options, min: c.min, value: c.value, valueText: c.valueText, box: c.box, form: c.form, parts: c.parts }))`);
}

/** every general gate: the words are in their shapes, labels on their part's side, nothing over anything, readable, whole */
async function generic(cx: Cx): Promise<Res[]> {
  const out: Res[] = [];
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
    case 'pen-ring':
      break;
    default:
  }
}

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
  const cx: Cx = { tab, c: conv, screen, dir, mobile: tab.mobile, answer: null as unknown as Answer, picture: '', watched: { showAllOver: null, pillSeen: 0 }, before: '', words: '', early: [] };
  const details: Res[] = [];
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
      const sent = await conv.say(args.mode === 'live' ? turn.say : `${turn.say}${twinMark(c.id, turn.say)}`, results);
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
      for (const action of turn.do ?? []) {
        if (action.a === 'pen-ring') details.push(await penRing(cx));
        else await act(cx, action);
      }
      if (n === c.turns.length || (turn.check ?? []).length > 0) {
        await sleep(400);
        if (cx.picture === '' || (turn.do ?? []).every((a) => a.a !== 'click-control')) cx.picture = await tab.shot();
        cx.answer = await tab.call<Answer>('answer');
        await writeFile(join(dir, `${screen.name}-t${n}.png`), Buffer.from(cx.picture.split(',')[1] ?? '', 'base64'));
        for (const spec of turn.check ?? []) if (!(spec.k === 'pen-draws')) details.push(await runCheck(cx, spec));
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
    return { verdict: 'ERR', failed: ['run'], details, cost };
  } finally {
    await tab.close().catch(() => undefined);
  }
  void watch;
  const failed = details.filter((d) => d.verdict === 'FAIL' || d.verdict === 'SKIP').map((d) => d.check);
  const ownNames = new Set([...c.own, ...c.turns.flatMap((t) => (t.check ?? []).map((s) => s.k))]);
  const ownFailed = failed.filter((name) => ownNames.has(name) || name.startsWith('rest'));
  const verdict = failed.length === 0 ? 'PASS' : ownFailed.length === 0 ? 'OWN' : 'FAIL';
  return { verdict, failed: [...new Set(failed)], details, cost };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A server of the build under test

async function startServer(args: Args, replayFile: string, out: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const data = join(out, 'server-data');
  await mkdir(data, { recursive: true });
  const live = args.mode === 'live';
  const child: ChildProcess = spawn('pnpm', ['--filter', '@conduit/server', 'start'], {
    cwd: args.build,
    env: { ...process.env, PORT: String(args.port), DATA_DIR: live ? args.data : data, BRAIN: live ? 'claude-cli' : 'replay', ...(live ? { CLAUDE_MODEL: process.env['CLAUDE_MODEL'] ?? 'sonnet' } : {}), ...(live ? {} : { REPLAY_CASE: replayFile, REPLAY_CPS: '6000' }), IMAGE_MODEL: 'none', PICTURES: 'openverse', AGENT_PERMITS: 'auto', NODE_ENV: 'production' },
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
  const cases = loadCases(args.only, args.chat);
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
    turns.push(...(JSON.parse(readFileSync(file, 'utf8')) as Recorded).turns.map((turn) => ({ ...turn, match: `${turn.match}${twinMark(c.id, turn.match)}` })));
  }
  const replayFile = join(out, 'replay-case.json');
  await writeFile(replayFile, JSON.stringify({ turns }));
  const server = args.mode === 'live' && args.url !== null ? { url: args.url, stop: async (): Promise<void> => undefined } : await startServer(args, replayFile, out);
  const prev = readResults(args.label);
  const outFile: ResultFile = { label: args.label, commit: gitHead(args.build), at: new Date().toISOString(), mode: args.mode, cases: {} };
  const details: Record<string, Record<string, Res[]>> = {};
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
      slot[where] = { v: cell.verdict, failed: cell.failed };
      (details[c.id] ??= {})[screen.name] = cell.details;
      process.stdout.write(`${cell.verdict.padEnd(5)} ${c.id} ${screen.name}${cell.failed.length > 0 ? `  [${cell.failed.join(', ')}]` : ''}\n`);
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
