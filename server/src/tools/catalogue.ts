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
    if (['live', 'replay', 'no-board', 'quiet'].includes(name)) flags.set(name, 'true');
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
    timeoutMs: Number(flags.get('timeout') ?? 180) * 1000,
  };
}

function loadCases(only: readonly string[] | null): Case[] {
  const all = readdirSync(casesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(casesDir, name), 'utf8')) as Case);
  const unknown = (only ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) usage(`no case ${unknown.join(', ')}`);
  return all.filter((c) => only === null || only.includes(c.id));
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
      const file = join(args.logs, `${session}.jsonl`);
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
        const wanted = turn.source.turns?.[0] ?? '';
        script = readLog(turn.source.log)
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
  readonly watched: { showAllOver: string | null };
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
  return tab.eval<Ctl[]>(`window.__stage.controls().map((c) => ({ id: c.id, control: c.control, label: c.label, options: c.options, min: c.min, value: c.value, valueText: c.valueText, box: c.box }))`);
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
  return out;
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
  for (const { label, part } of anchors) {
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
  return res('labels-side', bad, `${anchors.length} labels, each nearest its own part`);
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
  const shapes = cx.answer.live.filter((e) => e.kind === 'shape' && e.phase !== 'struck' && area(e.box) > 0);
  if (of === 'cells') {
    // the cells of a strip: the box that holds all of the shapes sitting among the words
    const near = shapes.filter((s) => matched.some((m) => Math.abs(centre(s.box).y - centre(m.box).y) < 3 * m.box.height));
    if (near.length === 0) return null;
    const x0 = Math.min(...near.map((s) => s.box.x));
    const y0 = Math.min(...near.map((s) => s.box.y));
    return { x: x0, y: y0, width: Math.max(...near.map((s) => s.box.x + s.box.width)) - x0, height: Math.max(...near.map((s) => s.box.y + s.box.height)) - y0 };
  }
  const big = shapes.filter((s) => area(s.box) < 0.85 * cx.screen.width * cx.screen.height).sort((a, b) => area(b.box) - area(a.box))[0];
  return big === undefined ? null : big.box;
}

async function runCheck(cx: Cx, spec: Spec): Promise<Res> {
  const name = spec.k;
  const words = spec['words'] as string[] | undefined;
  const match = spec['match'] as string | undefined;
  switch (name) {
    case 'words-in-grid': {
      const found = wordBoxes(cx, words, match);
      if (found.length === 0) return { check: name, verdict: 'FAIL', detail: 'none of the words are on stage' };
      const box = gridBox(cx, spec['of'] as string | undefined, found);
      if (box === null) return { check: name, verdict: 'FAIL', detail: 'no grid or cell shape on stage to hold the words' };
      const pad = 3;
      const out = found.filter((e) => {
        const c = centre(e.box);
        return c.x < box.x - pad || c.x > box.x + box.width + pad || c.y < box.y - pad || c.y > box.y + box.height + pad;
      });
      return res(name, out.map((e) => `"${e.text.slice(0, 14)}" is outside the grid`), `${found.length} words all inside the grid`);
    }
    case 'row-aligned': {
      const order = spec['order'] as string[];
      const picked = order.map((w) => shown(cx.answer).find((e) => e.text.trim() === w || e.text.trim().startsWith(w)));
      const missing = order.filter((_, i) => picked[i] === undefined);
      if (missing.length > 0) return { check: name, verdict: 'FAIL', detail: `not on stage: ${missing.join(', ')}` };
      const boxes = picked as LiveElement[];
      const ys = boxes.map((e) => centre(e.box).y).sort((a, b) => a - b);
      const mid = ys[Math.floor(ys.length / 2)] as number;
      const lineH = Math.max(...boxes.map((e) => e.box.height));
      const bad: string[] = [];
      boxes.forEach((e, i) => {
        if (Math.abs(centre(e.box).y - mid) > 0.6 * lineH) bad.push(`${order[i]} is off the row by ${Math.round(Math.abs(centre(e.box).y - mid))} px`);
        const prev = boxes[i - 1];
        if (prev !== undefined && centre(e.box).x <= centre(prev.box).x) bad.push(`${order[i]} is not to the right of ${order[i - 1]}`);
      });
      return res(name, bad, `${order.length} labels on one row, in order`);
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
      return cx.watched.showAllOver === null ? { check: name, verdict: 'PASS', detail: 'the Show all pill never stood on words while the answer played' } : { check: name, verdict: 'FAIL', detail: cx.watched.showAllOver };
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
      const hit = await cx.tab.eval<{ red: number; box: unknown } | null>(redScan(JSON.stringify(cx.picture)));
      return hit === null ? { check: name, verdict: 'FAIL', detail: 'no control was clicked' } : hit.red > 40 ? { check: name, verdict: 'FAIL', detail: `${hit.red} red outline pixels round the clicked control` } : { check: name, verdict: 'PASS', detail: 'no red box round the clicked control' };
    }
    case 'refresh-escape': {
      const view = await cx.tab.eval<{ doc: boolean; escape: boolean; prompt: boolean }>(
        `(() => { const d = document.querySelector('.stage__document'); const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 4 && r.height > 4 && cs.display !== 'none' && cs.visibility !== 'hidden'; }; const doc = !!d && vis(d) && (d.innerText || '').trim().length > 0; const escape = [...document.querySelectorAll('button,[role=button],a')].some((b) => vis(b) && /close|new conversation|new chat|back to|leave|exit/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent)); const p = document.querySelector('.composer textarea, .composer input, .prompt textarea, .prompt input'); return { doc, escape, prompt: !!p && vis(p) }; })()`,
      );
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
  const part = (await tab.call<Answer>('answer')).mockups.flatMap((m) => m.hits).find((h) => /pay|order|checkout|place/i.test(h.part)) ?? (await tab.call<Answer>('answer')).mockups.flatMap((m) => m.hits)[0];
  if (part === undefined) return { check: 'pen-draws', verdict: 'FAIL', detail: 'no live part on the mock-up to ring' };
  const plus = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__plus');
  if (plus === null) return { check: 'pen-draws', verdict: 'FAIL', detail: 'no + menu' };
  await tab.tap(plus.x + plus.w / 2, plus.y + plus.h / 2);
  await sleep(300);
  const draw = await tab.call<{ x: number; y: number; w: number; h: number } | null>('rect', '.composer__item[data-item="draw"]');
  if (draw === null) return { check: 'pen-draws', verdict: 'FAIL', detail: 'the + menu has no Draw' };
  await tab.tap(draw.x + draw.w / 2, draw.y + draw.h / 2);
  await sleep(700);
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
  const tab = await Tab.open(screen.width, screen.height);
  const options: Options = { url, screens: [screen], out, turns: new Set(), timeoutMs: args.timeoutMs, parallel: false, demo: false, quiet: true, page: '', say: null, chat: 'off' };
  const conv = new Conversation(tab, options, screen, dir);
  const cx: Cx = { tab, c: conv, screen, dir, mobile: tab.mobile, answer: null as unknown as Answer, picture: '', watched: { showAllOver: null } };
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
      tab.drain();
      const sent = await conv.say(turn.say, results);
      // a poller beside the wait: the Show all pill is only there while an answer plays
      let polling = true;
      const poll = (async (): Promise<void> => {
        while (polling) {
          const over = await tab
            .eval<string | null>(
              `(() => { const b = [...document.querySelectorAll('button,[role=button]')].find((e) => /show all/i.test((e.textContent || '') + (e.getAttribute('aria-label') || ''))); if (!b) return null; const r = b.getBoundingClientRect(); if (r.width < 4) return null; const words = (window.__stage.elements() || []).filter((e) => e.kind === 'text' && e.phase === 'on' && e.opacity > 0.3); for (const w of words) { const x = Math.max(0, Math.min(r.right, w.box.x + w.box.width) - Math.max(r.left, w.box.x)); const y = Math.max(0, Math.min(r.bottom, w.box.y + w.box.height) - Math.max(r.top, w.box.y)); if (x * y > 0.15 * Math.min(r.width * r.height, w.box.width * w.box.height)) return 'the Show all pill stands on "' + String(w.text).slice(0, 24) + '"'; } return null; })()`,
            )
            .catch(() => null);
          if (over !== null) cx.watched.showAllOver ??= over;
          await sleep(250);
        }
      })();
      const note = sent ? await conv.rest(true) : 'the turn never started';
      polling = false;
      await poll;
      details.push({ check: `rest${c.turns.length > 1 ? `-${n}` : ''}`, verdict: note === '' ? 'PASS' : 'FAIL', detail: note === '' ? 'at rest' : note });
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
        if (n === c.turns.length) for (const r of await generic(cx)) details.push(r);
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
  const failed = details.filter((d) => d.verdict === 'FAIL').map((d) => d.check);
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
    env: { ...process.env, PORT: String(args.port), DATA_DIR: live ? args.data : data, BRAIN: live ? 'claude-cli' : 'replay', ...(live ? {} : { REPLAY_CASE: replayFile, REPLAY_CPS: '6000' }), IMAGE_MODEL: 'none', PICTURES: 'openverse', AGENT_PERMITS: 'auto', NODE_ENV: 'production' },
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
  const cases = loadCases(null);
  const mark = (o: CaseOut | undefined): string => (o === undefined ? '-' : `${o.desk?.v === 'PASS' ? 'G' : o.desk?.v === 'OWN' ? 'o' : 'R'}${o.phone?.v === 'PASS' ? 'G' : o.phone?.v === 'OWN' ? 'o' : 'R'}`);
  const lines = ['# Branch matrix', '', 'Each cell is desk then phone: G = PASS, o = own checks pass but a general gate is red, R = red. Replayed on that branch head with this checkout\'s tool.', '', `| case | family | owner | ${files.map((f) => `${f.label} (${f.commit})`).join(' | ')} |`, `| --- | --- | --- | ${files.map(() => '---').join(' | ')} |`];
  for (const c of cases) lines.push(`| ${c.id} | ${c.family} | ${c.owner} | ${files.map((f) => mark(f.cases[c.id])).join(' | ')} |`);
  lines.push(`| **green** | | | ${files.map((f) => `${Object.values(f.cases).filter(green).length} of ${cases.length}`).join(' | ')} |`);
  const text = `${lines.join('\n')}\n`;
  await writeFile(join(root, 'catalogue', 'MATRIX.md'), text);
  process.stdout.write(text);
}

async function run(args: Args): Promise<void> {
  const cases = loadCases(args.only);
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
    turns.push(...(JSON.parse(readFileSync(file, 'utf8')) as Recorded).turns);
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
