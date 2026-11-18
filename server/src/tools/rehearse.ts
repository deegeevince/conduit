// pnpm rehearse: the iPad demo, end to end, on a real brain, in headless Chrome at 820x971 (dpr 2) with a finger and a pen.
//
//   pnpm rehearse --out <dir> --thinking on|off [--effort low|medium|high (high)] [--photo <jpg>] [--fake] [--case <file>]
//
// The flow the owner records: hold the maths skill, add a photo of a word problem, ask for help; Claude draws it up (callouts on the photo's numbers, then the
// working as a `math` column with empty boxes); the pen writes the digits (one deliberately wrong) in the boxes, and Send puts the picture of the sum with the writing on
// it up as one drawing turn; Claude answers with what is next. Every step is timed and photographed; what the page and the brain did is written to <out>/run.json and
// printed. The worksheet photo is made here (`rehearse-photo.ts`), never a real child's.
//
// A live run costs model calls (the brain's turns and the critic): `--fake` is the free dry run (BRAIN=replay with `--case`) to prove the driver itself.

import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnTracked } from '../brains/claude-cli/process';
import { claimPort, releasePort } from './check-ports';
import { repoRoot, sleep, stop, waitFor } from './explore-browser';
import { makePhoto } from './rehearse-photo';
import type { PhotoSpots } from './rehearse-photo';
import { MathsTab, INPUT_SCREENS } from './math-check';
import type { Point } from './lens-check';

interface Args {
  readonly out: string;
  readonly thinking: 'on' | 'off';
  readonly photo: string | null;
  readonly fake: boolean;
  readonly caseFile: string | null;
  readonly critic: 'on' | 'off';
  readonly wrong: string;
  readonly firstOnly: boolean;
  readonly effort: 'low' | 'medium' | 'high';
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => (argv.includes(`--${name}`) ? (argv[argv.indexOf(`--${name}`) + 1] ?? null) : null);
  const out = get('out');
  if (out === null) throw new Error('usage: pnpm rehearse --out <dir> [--thinking on|off] [--photo <jpg>] [--fake] [--case <file>]');
  return {
    out: resolve(out),
    thinking: get('thinking') === 'off' ? 'off' : 'on',
    photo: get('photo'),
    fake: argv.includes('--fake'),
    caseFile: get('case'),
    critic: get('critic') === 'off' ? 'off' : 'on',
    wrong: get('wrong') ?? '7',
    firstOnly: argv.includes('--first-only'),
    effort: get('effort') === 'low' ? 'low' : get('effort') === 'medium' ? 'medium' : 'high',
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Handwriting: a few strokes for each digit, as a child might write it, so that the model has something real to read

type Unit = readonly (readonly [number, number])[];
const DIGIT_STROKES: Readonly<Record<string, readonly Unit[]>> = {
  '0': [[[0.5, 0.1], [0.3, 0.2], [0.24, 0.5], [0.3, 0.8], [0.5, 0.92], [0.7, 0.8], [0.76, 0.5], [0.7, 0.2], [0.5, 0.1]]],
  '1': [[[0.34, 0.3], [0.52, 0.12], [0.52, 0.5], [0.52, 0.9]]],
  '2': [[[0.26, 0.3], [0.36, 0.16], [0.54, 0.12], [0.7, 0.2], [0.74, 0.36], [0.62, 0.54], [0.4, 0.74], [0.24, 0.88], [0.78, 0.88]]],
  '3': [[[0.28, 0.2], [0.5, 0.12], [0.7, 0.2], [0.66, 0.4], [0.44, 0.48], [0.7, 0.58], [0.76, 0.76], [0.58, 0.9], [0.34, 0.88], [0.24, 0.78]]],
  '4': [[[0.62, 0.12], [0.26, 0.62], [0.8, 0.62]], [[0.62, 0.3], [0.62, 0.9]]],
  '5': [[[0.7, 0.14], [0.34, 0.14], [0.3, 0.5], [0.48, 0.42], [0.68, 0.46], [0.78, 0.62], [0.74, 0.8], [0.58, 0.92], [0.4, 0.92], [0.26, 0.84]]],
  '6': [[[0.68, 0.14], [0.46, 0.3], [0.32, 0.54], [0.28, 0.74], [0.38, 0.9], [0.58, 0.92], [0.72, 0.8], [0.7, 0.62], [0.54, 0.52], [0.36, 0.58]]],
  '7': [[[0.24, 0.16], [0.78, 0.16]], [[0.78, 0.16], [0.6, 0.5], [0.44, 0.9]]],
  '8': [[[0.5, 0.48], [0.3, 0.36], [0.34, 0.18], [0.5, 0.1], [0.66, 0.18], [0.7, 0.36], [0.5, 0.48], [0.28, 0.64], [0.32, 0.84], [0.5, 0.92], [0.68, 0.84], [0.72, 0.64], [0.5, 0.48]]],
  '9': [[[0.7, 0.3], [0.6, 0.14], [0.42, 0.12], [0.28, 0.26], [0.34, 0.44], [0.52, 0.48], [0.7, 0.36], [0.68, 0.6], [0.56, 0.9]]],
};

/** Points along a polyline through the key points, a few pixels apart, with a little shake of a hand. */
function along(keys: Unit, box: { x: number; y: number; width: number; height: number }, seed: number, scale = 1): Point[] {
  const pad = (1 - 0.72 * scale) / 2;
  const at = ([u, v]: readonly [number, number]): Point => ({ x: box.x + box.width * (pad + u * 0.72 * scale), y: box.y + box.height * (0.08 + v * 0.84 * scale) });
  const points: Point[] = [];
  let shake = seed;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = at(keys[i] as readonly [number, number]);
    const b = at(keys[i + 1] as readonly [number, number]);
    const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 5));
    for (let s = 0; s < steps; s += 1) {
      shake = (shake * 9301 + 49297) % 233280;
      const jitter = (shake / 233280 - 0.5) * 1.2;
      points.push({ x: a.x + ((b.x - a.x) * s) / steps + jitter, y: a.y + ((b.y - a.y) * s) / steps - jitter });
    }
  }
  points.push(at(keys[keys.length - 1] as readonly [number, number]));
  return points;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A server on the owner's login, with its log kept

interface Live {
  readonly url: string;
  readonly logFile: string;
  readonly dataDir: string;
  stop(): Promise<void>;
}

async function startLive(args: Args, skills: string): Promise<Live> {
  const root = repoRoot();
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('there is no build to rehearse on: run "pnpm build" first');
  const dataDir = join(args.out, 'data');
  const logFile = join(args.out, 'server.log');
  await mkdir(dataDir, { recursive: true });
  const port = await claimPort('the rehearsal server');
  const live: Record<string, string> = args.fake
    ? { BRAIN: 'replay', REPLAY_CPS: '600', ...(args.caseFile === null ? {} : { REPLAY_CASE: args.caseFile }) }
    : { BRAIN: 'claude-cli', CLAUDE_MODEL: 'opus', BRAIN_EFFORT: args.effort, BRAIN_THINKING: args.thinking, CRITIC: args.critic, CRITIC_MODEL: 'fable', CRITIC_EFFORT: 'high', CRITIC_LOOK_MS: '150000' };
  let log = '';
  const child: ChildProcess = spawnTracked(process.execPath, ['--import', 'tsx', 'src/main.ts'], undefined, {
    cwd: join(root, 'server'),
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, SKILL_ROOTS: `user=${skills}`, LIBRARY: 'seed', READ_LINKS: 'off', LOG_LEVEL: 'info', IMAGE_MODEL: 'none', ...live },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const stopAll = async (): Promise<void> => {
    await stop(child);
    releasePort(port);
    await writeFile(logFile, log);
  };
  try {
    await waitFor('the server', 60_000, async () => {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}:\n${log.slice(-2000)}`);
      return (await fetch(`${url}/api/health`)).ok ? true : null;
    });
  } catch (error) {
    await stopAll();
    throw error;
  }
  return { url, logFile, dataDir, stop: stopAll };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The run

class StopRun extends Error {}

/** What the server's own session log says, once it has stopped: when each turn began, its first and last line and its end by the server's clock, the model's own first-text time, and what the brain was told for each turn after the first. */
function logSummary(dataDir: string, out: string, note: (step: string, verdict: Finding['verdict'], detail: string) => void, findings: Finding[]): void {
  try {
    const dir = join(dataDir, 'logs');
    const file = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().at(-1);
    if (file === undefined) return;
    const records = readFileSync(join(dir, file), 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown> & { type: string; at: number; turn?: string });
    const turns = [...new Set(records.filter((r) => r.type === 'turn').map((r) => String(r.turn)))];
    const lines: string[] = [];
    for (const turn of turns) {
      const started = records.find((r) => r.type === 'turn' && r.turn === turn)?.at ?? 0;
      const written = records.filter((r) => r.type === 'line' && r.turn === turn).map((r) => r.at);
      const usage = records.find((r) => r.type === 'usage' && r.turn === turn) as { usage?: Record<string, number> } | undefined;
      const end = records.find((r) => r.type === 'end' && r.turn === turn)?.at;
      const first = written[0] ?? 0;
      const last = written.at(-1) ?? 0;
      lines.push(`${turn}: ${written.length} lines, first ${written.length === 0 ? 'none' : seconds(first - started)} after the turn began, last ${written.length === 0 ? 'none' : seconds(last - started)}${end === undefined ? '' : `, ended ${seconds(end - started)}`}; the model: first text ${usage?.usage?.['firstTextMs'] === undefined ? '?' : seconds(usage.usage['firstTextMs'])}, ${usage?.usage?.['thinkingTokens'] ?? '?'} thinking tokens, ${usage?.usage?.['outputTokens'] ?? '?'} out, $${usage?.usage?.['costUsd']?.toFixed(3) ?? '?'}`);
      if (written.length > 2) lines.push(`   the lines reached the server over ${seconds(last - first)}${last - first < 1500 ? ' (a burst: the whole answer arrived at once)' : ' (they streamed)'}`);
    }
    const kinds = new Map<string, number>();
    for (const line of (existsSync(join(dataDir, 'usage.jsonl')) ? readFileSync(join(dataDir, 'usage.jsonl'), 'utf8') : '').split('\n').filter((l) => l.trim() !== '')) {
      const r = JSON.parse(line) as { kind: string };
      kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    }
    lines.push(`model calls by kind: ${[...kinds].map(([k, n]) => `${k} x${n}`).join(', ')}`);
    for (const r of records.filter((x) => x.type === 'brief' && x.turn !== turns[0])) {
      const text = String((r as { text?: unknown }).text ?? '');
      const wanted = text.split('\n').filter((l) => /^(THE USER (SET|POINTED AT|DID)|NOW:|LAST TURN:)/.test(l)).map((l) => l.slice(0, 400));
      lines.push(`what Claude was told for ${String(r.turn)}: ${wanted.join(' // ')}`);
      const digest = text.split('\n').find((l) => /m1: (ones|tens|hundreds|all right)/.test(l));
      if (digest !== undefined) lines.push(`   (the page's own digest of what she did: ${digest.trim().slice(0, 400)})`);
    }
    writeFileSync(join(out, 'server-timeline.txt'), `${lines.join('\n')}\n`);
    for (const line of lines) note('server-log', 'INFO', line);
  } catch (error) {
    note('server-log', 'INFO', `the session log could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface Finding {
  readonly step: string;
  readonly verdict: 'PASS' | 'FAIL' | 'INFO';
  readonly detail: string;
}
interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Elem {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly phase: string;
  readonly box: Box;
  readonly tappable: boolean;
  readonly opacity: number;
}
interface Sample {
  readonly t: number;
  readonly elements: number;
  readonly maths: number;
  readonly status: string;
  readonly turn: string | null;
  readonly ids: string;
}

const overlap = (a: Box, b: Box): number => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const shots = join(args.out, 'shots');
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });
  const findings: Finding[] = [];
  const timings: Record<string, number> = {};
  const note = (step: string, verdict: Finding['verdict'], detail: string): void => {
    findings.push({ step, verdict, detail });
    process.stdout.write(`${verdict} ${step}: ${detail}\n`);
  };
  const say = (text: string): void => void process.stdout.write(`... ${text}\n`);

  // the worksheet photo, made here
  const photoFile = args.photo ?? join(args.out, 'worksheet.jpg');
  let spots: PhotoSpots;
  if (args.photo !== null && existsSync(`${args.photo}.spots.json`)) spots = JSON.parse(readFileSync(`${args.photo}.spots.json`, 'utf8')) as PhotoSpots;
  else spots = await makePhoto(photoFile);

  // the maths skill, the owner's own, copied into a folder of its own so that this server reads that skill and no other
  const skills = join(args.out, 'skills');
  await rm(skills, { recursive: true, force: true });
  await mkdir(skills, { recursive: true });
  const owners = join(homedir(), '.claude', 'skills', 'conduit-maths');
  if (!existsSync(join(owners, 'SKILL.md'))) throw new Error('the conduit-maths skill is not in ~/.claude/skills');
  await cp(owners, join(skills, 'conduit-maths'), { recursive: true });

  const server = await startLive(args, skills);
  const screen = INPUT_SCREENS[0] as (typeof INPUT_SCREENS)[number];
  let mine: MathsTab | null = null;
  const samples: Sample[] = [];
  let watching = true;
  let shotNo = 0;
  try {
    mine = await MathsTab.open(server.url, screen, shots, 120_000);
    const { tab, hands } = mine;
    const picture = async (name: string): Promise<string> => mine!.shot(shots, `${String(++shotNo).padStart(2, '0')}-${name}.png`);

    // ---- a watcher: what is on the stage and what the page is doing, five times a second, so that a time is a measurement and not a guess
    const t0 = Date.now();
    let lastIds = '';
    let lastShotAt = 0;
    let duringShots = 0;
    let sentAt = 0;
    const watcher = (async (): Promise<void> => {
      while (watching) {
        try {
          const s = await tab.eval<{ elements: number; maths: number; status: string; turn: string | null; ids: string }>(`(() => { const s = window.__stage; const st = s.state(); return { elements: st.elements.length, maths: s.maths().length, status: (document.querySelector('.prompt__status') || {}).textContent || '', turn: st.turn, ids: st.elements.map((e) => e.id + ':' + e.kind).join(',') }; })()`);
          samples.push({ t: Date.now() - t0, ...s });
          // a picture whenever the stage has changed while Claude is drawing (at most one a second and a bit, ten to a turn), so each stage of the drawing is seen
          if (sentAt > 0 && s.turn !== null && s.ids !== lastIds && Date.now() - lastShotAt > 1200 && duringShots < 10) {
            lastIds = s.ids;
            lastShotAt = Date.now();
            duringShots += 1;
            await picture(`drawing-${Math.round((Date.now() - sentAt) / 1000)}s`);
          }
        } catch {
          // a page busy with a frame: the next sample
        }
        await sleep(200);
      }
    })();

    const elementsNow = (): Promise<Elem[]> => tab.eval<Elem[]>(`window.__stage.elements().map((e) => ({ id: e.id, kind: e.kind, text: e.text, phase: e.phase, box: e.box, tappable: e.tappable, opacity: e.opacity }))`);
    const errorsNow = (step: string): void => {
      const drained = tab.drain();
      for (const e of drained.consoleErrors) note(step, 'FAIL', `console error: ${e.text}`);
      for (const e of drained.failedRequests) note(step, 'FAIL', `failed request: ${e.text}`);
    };
    const sendWords = async (text: string): Promise<void> => {
      const info = await tab.call<{ rect: { x: number; y: number; w: number; h: number } }>('promptInfo');
      await tab.tap(info.rect.x + info.rect.w / 2, info.rect.y + info.rect.h / 2);
      await tab.type(text);
      await tab.key('Enter');
    };

    // ---- 0. the empty page
    await picture('page-open');

    // ---- 1. /skill conduit-maths
    const skillAt = Date.now();
    await sendWords('/skill conduit-maths');
    const held = await waitFor('the skill chip', 20_000, async () => ((await tab.eval<number>(`document.querySelectorAll('.skill-chip').length`)) > 0 ? true : null)).then(() => true, () => false);
    timings['skill-held'] = Date.now() - skillAt;
    const announced = await tab.eval<string>(`(document.querySelector('.skills__note--tray') || {}).textContent || ''`);
    note('skill', held ? 'PASS' : 'FAIL', held ? `"/skill conduit-maths" held the skill as a chip in ${seconds(timings['skill-held'] as number)} (${announced.trim() || 'no note'})` : 'no chip for conduit-maths: the server did not list the skill');
    await picture('skill-held');

    // ---- 2. the photo, by the [+] menu
    await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
    let chooser: ((id: number) => void) | null = null;
    const chosen = new Promise<number>((resolve) => { chooser = resolve; });
    tab.browser.onEvent((event) => {
      if (event.sessionId === tab.session && event.method === 'Page.fileChooserOpened') chooser?.(Number(event.params['backendNodeId']));
    });
    const rectOf = (selector: string): Promise<{ x: number; y: number; w: number; h: number; hidden?: boolean } | null> => tab.call('rect', selector);
    const plus = await rectOf('.composer__plus');
    if (plus === null) throw new Error('no [+] in the bar');
    await tab.tap(plus.x + plus.w / 2, plus.y + plus.h / 2);
    await sleep(300);
    await picture('plus-menu');
    const entry = await rectOf('[data-item="photo"]');
    if (entry === null || entry.hidden === true) note('photo', 'FAIL', 'the [+] menu has no Photo entry');
    else await tab.tap(entry.x + entry.w / 2, entry.y + entry.h / 2);
    const backend = await Promise.race([chosen, sleep(4000).then(() => 0)]);
    const upAt = Date.now();
    if (backend > 0) await tab.send('DOM.setFileInputFiles', { files: [photoFile], backendNodeId: backend });
    else {
      note('photo', 'INFO', 'the Photo entry opened no file chooser here; the file input was given the photo directly');
      const found = await tab.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: `document.querySelector('input[data-photos="pick"]')` });
      if (found.result.objectId !== undefined) await tab.send('DOM.setFileInputFiles', { objectId: found.result.objectId, files: [photoFile] });
    }
    await waitFor('the photo to be sent', 30_000, async () => ((await tab.eval<number>(`document.querySelectorAll('.photo--ready').length`)) > 0 ? true : null));
    timings['photo-upload'] = Date.now() - upAt;
    note('photo', 'PASS', `the photo was added from the [+] menu and uploaded in ${seconds(timings['photo-upload'] as number)}`);
    await picture('photo-added');

    // ---- 3. ask
    const words = "Help me work this out, don't tell me the answer";
    const before = samples.at(-1)?.elements ?? 0;
    const sendAt = Date.now();
    sentAt = sendAt;
    await sendWords(words);
    say(`sent "${words}" with the photo`);
    // the first line is the first thing the stage holds; the column is the first math block; rest is the page's own
    const first = await waitFor('the first line', 240_000, async () => (samples.find((s) => s.t >= sendAt - t0 && s.elements > before) ?? null)).catch(() => null);
    timings['first-line'] = first === null ? -1 : first.t - (sendAt - t0);
    if (first !== null) say(`first thing on the stage after ${seconds(timings['first-line'] as number)}`);
    const restProblem = await mine.conv.rest(true, true, 300_000);
    timings['answer-rest'] = Date.now() - sendAt;
    const column = samples.find((s) => s.t >= sendAt - t0 && s.maths > 0) ?? null;
    timings['column'] = column === null ? -1 : column.t - (sendAt - t0);
    await picture('answer-1');
    note('answer', restProblem === '' ? 'PASS' : 'FAIL', `${restProblem === '' ? 'the answer came to rest' : restProblem}: first thing ${seconds(timings['first-line'] as number)}, the column ${column === null ? 'never' : seconds(timings['column'] as number)}, at rest ${seconds(timings['answer-rest'] as number)}`);
    errorsNow('answer');

    // ---- 4. what is on the stage
    const answer = await tab.call<{ script: string; live: readonly Elem[]; leaders: readonly { label: string; part: string; end: Point; distance: number }[] | null }>('answer');
    await writeFile(join(args.out, 'answer-1.script.txt'), `${answer.script}\n`);
    const turn1Lines = answer.script.split('\n');
    const mathLine = turn1Lines.find((line) => /^math\s+\S+\s+column\b/.test(line.trim()));
    note('column', mathLine === undefined ? 'FAIL' : 'PASS', mathLine === undefined ? `no "math … column" line in the script (${turn1Lines.length} lines)` : `the script has: ${mathLine.trim()}`);
    const blocks = (await mine.blocks()) as unknown as (Awaited<ReturnType<MathsTab['blocks']>>[number] & { box: Box })[];
    const block = blocks[0];
    if (block === undefined) {
      note('column', 'FAIL', 'no written method with boxes is on the stage');
    } else {
      const filled = block.cells.filter((cell) => cell.value !== '');
      note('blanks', filled.length === 0 ? 'PASS' : 'FAIL', `${block.cells.length} boxes (${block.cells.filter((c) => !c.optional).length} asked, ${block.cells.filter((c) => c.optional).length} optional: ${block.cells.map((c) => `${c.part}${c.optional ? '?' : ''}`).join(' ')}); ${filled.length === 0 ? 'every one empty' : `already holding digits: ${filled.map((c) => `${c.part}=${c.value}`).join(' ')}`}`);
      const tiny = block.cells.filter((c) => c.box.width < 44 || c.box.height < 44);
      note('blanks', tiny.length === 0 ? 'PASS' : 'FAIL', tiny.length === 0 ? `every box is at least 44 px (${Math.round(Math.min(...block.cells.map((c) => c.box.width)))} x ${Math.round(Math.min(...block.cells.map((c) => c.box.height)))} the smallest)` : `boxes under 44 px: ${tiny.map((c) => c.part).join(' ')}`);
    }
    // the answer in no words
    const everything = await tab.eval<string>(`[document.body.innerText, ...[...document.querySelectorAll('[aria-label],[title],[alt]')].map((n) => n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('alt'))].join('\\n')`);
    const leaked = [...answer.script.matchAll(/\b225\b|two hundred (?:and )?twenty[- ]five|\btwenty[- ]five\b/gi), ...everything.matchAll(/\b225\b|two hundred (?:and )?twenty[- ]five|\btwenty[- ]five\b/gi)];
    note('answer-sealed', leaked.length === 0 ? 'PASS' : 'FAIL', leaked.length === 0 ? '225 is nowhere in the script, on the stage or in the page text (digits or words)' : `the answer is written: ${leaked.map((m) => m[0]).join(', ')}`);
    const placed = turn1Lines.filter((line) => /^\s*say\b.*\bat=/.test(line) && /\|\s*\d{1,3}\s*$/.test(line));
    note('hand-placed', placed.length === 0 ? 'PASS' : 'FAIL', placed.length === 0 ? 'no digit is placed by hand with say at=' : `hand-placed digits: ${placed.join(' // ')}`);
    // callouts on the photo's numbers: where each `say … at=x,y in=<photo>` of the script puts its leader, against where the photo's number really is (the painter's own
    // hold of a leader on its spot is `pnpm photo-check`)
    const elements = await elementsNow();
    const calloutLines = turn1Lines.map((line) => /^\s*say\s+(\S+)?[^|]*\bat=(-?[\d.]+),(-?[\d.]+)[^|]*\bin=(\S+)[^|]*\|\s*(.*)$/.exec(line)).filter((m): m is RegExpExecArray => m !== null);
    if (calloutLines.length === 0) note('callouts', 'FAIL', `no callout on a photo in the script (lines with a photo: ${turn1Lines.filter((l) => /\bpic\b|callout|in=/.test(l)).join(' // ') || 'none'})`);
    else {
      const report = Object.entries(spots.spots).map(([name, at]) => {
        const nearest = calloutLines.map((m) => ({ words: m[5] ?? '', d: Math.hypot(((Number(m[2]) / 100) - at.x) * spots.width, ((Number(m[3]) / 100) - at.y) * spots.height) / spots.width })).sort((x, y) => x.d - y.d)[0];
        return { name, d: nearest?.d ?? null, words: nearest?.words ?? '' };
      });
      const bad = report.filter((r) => r.d === null || r.d > 0.07);
      note('callouts', bad.length === 0 ? 'PASS' : 'FAIL', `${calloutLines.length} callouts; ${report.map((r) => `${r.name}: nearest callout is ${r.d === null ? 'none' : `${(r.d * 100).toFixed(1)}% of the photo's width from it ("${r.words.slice(0, 40)}")`}`).join('; ')}`);
      note('callout-lines', 'INFO', calloutLines.map((m) => m[0].trim()).join(' // '));
    }
    const photoEl = elements.find((e) => /^(image|picture|pic|photo)$/.test(e.kind));
    // nothing overlaps: every visible thing on the stage against every other, bar a label on its own photo
    const seen = elements.filter((e) => e.opacity > 0.3 && e.box.width > 1 && e.box.height > 1 && e.phase !== 'leaving' && e.phase !== 'struck');
    const crossings: string[] = [];
    for (let i = 0; i < seen.length; i += 1) {
      for (let j = i + 1; j < seen.length; j += 1) {
        const a = seen[i] as Elem;
        const b = seen[j] as Elem;
        const area = overlap(a.box, b.box);
        if (area <= 0) continue;
        const small = Math.min(a.box.width * a.box.height, b.box.width * b.box.height);
        if (area / small < 0.04) continue;
        crossings.push(`${a.id}(${a.kind}) x ${b.id}(${b.kind}) ${(100 * (area / small)).toFixed(0)}%`);
      }
    }
    if (block !== undefined && photoEl !== undefined) {
      const area = overlap(block.box, photoEl.box);
      if (area > 0) crossings.push(`math block x photo ${Math.round(area)} px²`);
    }
    const viewport = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    const off = [...(block === undefined ? [] : [{ id: 'math block', box: block.box }]), ...seen.map((e) => ({ id: e.id, box: e.box }))].filter((e) => e.box.y + e.box.height > viewport.h + 1 || e.box.x + e.box.width > viewport.w + 1 || e.box.x < -1 || e.box.y < -1);
    note('overlap', crossings.length === 0 ? 'PASS' : 'FAIL', crossings.length === 0 ? `${seen.length} things on the stage, none over another (the screenshot is the judge)` : crossings.slice(0, 10).join('; '));
    note('on-screen', off.length === 0 ? 'PASS' : 'FAIL', off.length === 0 ? 'everything stands inside the screen' : `past the screen's edge (${viewport.w}x${viewport.h}): ${off.map((e) => `${e.id} bottom ${Math.round(e.box.y + e.box.height)}`).join('; ')}`);
    const squeeze = await tab.eval<unknown>('window.__stage.state().squeeze || null');
    if (squeeze !== null) note('squeeze', 'INFO', JSON.stringify(squeeze).slice(0, 300));

    if (args.firstOnly) throw new StopRun();

    // ---- 5. the pen: the person writes in the boxes, as on paper. Nothing reads it, nothing marks it
    if (block === undefined) {
      note('stop', 'FAIL', 'no written method to write in: the rehearsal stops after the first answer');
      watching = false;
      await watcher;
      await writeFile(join(args.out, 'samples.json'), JSON.stringify(samples));
      throw new StopRun();
    }
    const cellOf = async (part: string) => (await mine!.cell(block.id, part)) ?? null;
    const writes = async (part: string, digit: string, scale = 1, seed = 7): Promise<void> => {
      const cell = await cellOf(part);
      if (cell === null) throw new Error(`no box ${part}`);
      const origin = await hands.origin();
      for (const [at, keys] of (DIGIT_STROKES[digit] ?? []).entries()) {
        const path = along(keys, cell.box, seed + at + Number(digit), scale).map((p) => ({ x: p.x + origin.x, y: p.y + origin.y }));
        await hands.pen(path);
      }
    };
    const grid = block.cells.map((c) => c.part);
    const asked = block.cells.filter((c) => !c.optional).map((c) => c.part);
    say(`boxes: ${grid.join(' ')}; asked: ${asked.join(' ')}`);
    const answerCells = ['ans-ones', 'ans-tens', 'ans-hundreds'].filter((part) => grid.includes(part));
    if (answerCells.length !== 3) note('pen', 'FAIL', `expected ans-ones, ans-tens, ans-hundreds among the boxes, got ${grid.join(' ')}`);
    const plan: [string, string][] = [['ans-ones', '5'], ['ans-tens', args.wrong], ['ans-hundreds', '2']];
    await picture('before-writing');
    const wroteAt = Date.now();
    for (const [part, digit] of plan) await writes(part, digit);
    timings['writing'] = Date.now() - wroteAt;
    const inked = await hands.strokes();
    note('pen', (inked?.strokes.length ?? 0) > 0 ? 'PASS' : 'FAIL', `wrote ${plan.map(([, d]) => d).join('')} in three boxes in ${seconds(timings['writing'] as number)}: ${inked?.strokes.length ?? 0} stroke(s) on the stage`);
    const reads = await tab.eval<number>('(window.__mathReads || []).length');
    const buttons = await tab.eval<number>(`[...document.querySelectorAll('button')].filter((b) => /^(check|hint|show me)\\b/i.test((b.textContent || '').trim())).length`);
    note('no-check', reads === 0 && buttons === 0 ? 'PASS' : 'FAIL', `${reads} handwriting read(s) made, ${buttons} Check/Hint button(s) in the page`);
    await picture('digits-written');
    errorsNow('pen');

    // ---- 6. Send: the picture of the stage with the writing on it goes up as one drawing turn, and Claude decides what is next
    await sleep(700);
    const postedAtSend = tab.posted.length;
    const eventsAtSend = samples.at(-1)?.elements ?? 0;
    const sendButton = await tab.call<{ x: number; y: number; w: number; h: number; hidden?: boolean } | null>('rect', '.ink-btn--send');
    if (sendButton === null || sendButton.hidden === true) throw new Error('the ink bar shows no Send with the writing on the stage');
    const sendAtMs = Date.now();
    sentAt = sendAtMs;
    await tab.tap(sendButton.x + sendButton.w / 2, sendButton.y + sendButton.h / 2);
    const sentTurn = await waitFor('the drawing turn', 20_000, async () => (tab.posted.length > postedAtSend ? (tab.posted[tab.posted.length - 1] ?? null) : null)).catch(() => null);
    if (sentTurn === null) note('send', 'FAIL', 'Send posted no turn');
    else {
      const marks = (JSON.parse(sentTurn.body) as { input?: { marks?: { strokes?: unknown[]; on?: { element?: string } } } }).input?.marks;
      note('send', sentTurn.kind === 'prompt' && marks?.on?.element === block.id ? 'PASS' : 'FAIL', `Send posted a ${sentTurn.kind} turn "${sentTurn.text}" with ${marks?.strokes?.length ?? 0} stroke(s) drawn on element ${marks?.on?.element ?? 'none'} (the sum is ${block.id})`);
      await writeFile(join(args.out, 'turn-2-request.json'), sentTurn.body);
    }
    const second = await mine.conv.rest(true, true, 300_000);
    timings['reply-rest'] = Date.now() - sendAtMs;
    const firstReply = samples.find((s) => s.t >= sendAtMs - t0 && s.elements !== eventsAtSend) ?? null;
    timings['reply-first-line'] = firstReply === null ? -1 : firstReply.t - (sendAtMs - t0);
    await picture('reply');
    const reply = await tab.call<{ script: string }>('answer');
    await writeFile(join(args.out, 'answer-2.script.txt'), `${reply.script}\n`);
    note('reply', second === '' ? 'PASS' : 'FAIL', `${second === '' ? 'Claude answered' : second}: first thing ${firstReply === null ? 'unseen' : seconds(timings['reply-first-line'] as number)} after Send, at rest ${seconds(timings['reply-rest'] as number)}`);
    const text = (await elementsNow()).map((e) => e.text).join(' | ');
    note('reply-words', 'INFO', text.slice(0, 600));
    note('reply-script', 'INFO', reply.script.split('\n').slice(0, 12).join(' // ').slice(0, 800));
    errorsNow('reply');

    // ---- turns that happened without being asked for (a critic repair, a fill ahead), seen by the watcher
    const turnsSeen = [...new Set(samples.map((s) => s.turn).filter((t): t is string => t !== null))];
    note('turns', 'INFO', `turn ids the stage played: ${turnsSeen.join(', ')}; page posted ${tab.posted.map((p) => `${p.kind}:${(p.text ?? '').slice(0, 30)}`).join(' | ')}`);
    watching = false;
    await watcher;
    await writeFile(join(args.out, 'samples.json'), JSON.stringify(samples));
  } catch (error) {
    if (!(error instanceof StopRun)) throw error;
  } finally {
    watching = false;
    await writeFile(join(args.out, 'samples.json'), JSON.stringify(samples)).catch(() => undefined);
    await writeFile(join(args.out, 'run.json'), JSON.stringify({ args: { ...args, out: undefined }, timings, findings }, null, 2)).catch(() => undefined);
    await mine?.close().catch(() => undefined);
    await server.stop();
    logSummary(server.dataDir, args.out, note, findings);
  }
  process.stdout.write(`\ntimings: ${Object.entries(timings).map(([k, v]) => `${k} ${v < 0 ? 'n/a' : seconds(v)}`).join(', ')}\n`);
  process.stdout.write(`${findings.filter((f) => f.verdict === 'FAIL').length} failing, ${findings.filter((f) => f.verdict === 'PASS').length} passing\n`);
  process.exit(findings.some((f) => f.verdict === 'FAIL') ? 1 : 0);
}

if (process.argv[1] !== undefined && /rehearse\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`rehearse stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  });
}
