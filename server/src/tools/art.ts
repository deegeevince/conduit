// pnpm art: the shelf's dev tool (PLAN-art.md, section 6).
//
//   pnpm art import <file.svg> --subject <words> [--pose <word>] [--view <word>] [--facing left|right|front] [--arm <B|D|…>] [--by <maker>]
//                    [--how <words>] [--licence <text>] [--brush ink|dry|…] [--out <file.json>|--print]
//       Reads the SVG with the strict converter, restyles it to the house palette and writes a sheet (default: art/seed/<subject>-<pose>-<arm>.json).
//   pnpm art check          Every sheet of the seed folder is read again by the sheet reader, and listed.
//   pnpm art shots [--subject fox] [--look paper,night] [--outline default|look|ink|…] [--size 800] [--out <dir>]
//       Renders every sheet of the seed folder through the page's own painter, one PNG each, for looking at.
//   pnpm art lines <file.json> [--id fox1] [--size 40] [--look paper|night|blueprint] [--mirror]
//       The Series lines a sheet expands to, as the server would put them on stage.
//
//   pnpm art fill [--list <file>] [--max N] [--into seed|cache] [--data <dir>] [--dry-run]
//       Commissions, one at a time, every subject of the list (default art/common.txt) that the shelf lacks, through the studio's own path (the same
//       prompt, converter and validation as a live miss). Each costs about $0.15 to $0.50 and 40 to 130 s on the owner's login; it stops near the usage
//       throttle and on Ctrl-C, keeping what is done. --into seed writes art/seed/ (made: fable, MIT); --into cache (the default) writes <data>/cache/art.
//       --dry-run lists what it would commission and projects the time and cost, calling no model.
//
// Everything but `fill` touches neither the network nor a model.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { EMPTY_STAGE, LOOK, parseLine, serializeLine } from '@conduit/language';
import type { Line } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { openEyes, repoRoot, stop, waitFor } from './explore-browser';
import type { LookId } from '@conduit/language';
import { importSvg } from '../art/import';
import { lookClassOf } from '../art/palette';
import { expandSheet, readSheet } from '../art/sheet';
import { normaliseSubject, createShelf } from '../art/shelf';
import { describeProjection, fill, parseList, project, seedingShelf } from '../art/fill';
import { oneShotMaker } from '../art/studio';
import type { MakerSettings } from '../art/studio';
import { dataPaths, resolveDataDir, withDataFlag } from '../data-dir';
import { createLogger } from '../log';
import { appendUsage, capFromEnv, throttleOf } from '../usage';

const SEED_DIR = resolve(fileURLToPath(new URL('../../../art/seed', import.meta.url)));

function usage(message: string): never {
  process.stderr.write(`art: ${message}\nusage: pnpm art import <file.svg> --subject <words> [--pose <word>] [--view <word>] [--facing left|right|front] [--arm <name>] [--by <maker>] [--how <words>] [--licence <text>] [--brush <stroke>] [--out <file>|--print]\n       pnpm art check\n       pnpm art fill [--list <file>] [--max N] [--into seed|cache] [--data <dir>] [--dry-run]\n       pnpm art lines <sheet.json> [--id fox1] [--size 40] [--look paper] [--mirror]\n`);
  process.exit(2);
}

function flagsOf(argv: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags.set(key, 'yes');
    else {
      flags.set(key, next);
      i += 1;
    }
  }
  return { positional, flags };
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function importCommand(argv: readonly string[]): void {
  const { positional, flags } = flagsOf(argv);
  const file = positional[0];
  if (file === undefined) usage('import needs an SVG file');
  const words = flags.get('subject');
  if (words === undefined) usage('import needs --subject');
  const subject = normaliseSubject(words);
  if (subject === '') usage('the subject has no words');
  const facing = flags.get('facing') ?? 'left';
  if (facing !== 'left' && facing !== 'right' && facing !== 'front') usage('--facing is left, right or front');
  const pose = slug(flags.get('pose') ?? '');
  const view = slug(flags.get('view') ?? 'side');
  const arm = flags.get('arm') ?? 'A';
  const brush = flags.get('brush');
  const result = importSvg(readFileSync(resolve(file), 'utf8'), {
    subject,
    pose,
    view,
    facing,
    by: flags.get('by') ?? 'fable',
    arm,
    how: flags.get('how') ?? 'an SVG drawn off the answer\'s clock, read by the strict converter and restyled to the house palette',
    licence: flags.get('licence') ?? 'MIT (made for this project on the owner\'s own subscription)',
    ...(brush === undefined ? {} : { brush }),
    ...(flags.has('score') ? { score: Number(flags.get('score')) } : {}),
  });
  if (!result.ok) {
    process.stderr.write(`art: not imported: ${result.reason}\n`);
    process.exit(1);
  }
  const text = `${JSON.stringify(result.sheet, null, 1)}\n`;
  if (flags.has('print')) {
    process.stdout.write(text);
    return;
  }
  const out = flags.get('out') ?? join(SEED_DIR, `${[subject, pose, arm.toLowerCase()].filter((part) => part !== '').join('-')}.json`);
  writeFileSync(out, text);
  process.stdout.write(`${basename(out)}: ${result.sheet.parts.length} parts, slots ${result.sheet.slots.map((slot) => `${slot.name}(${slot.hue})`).join(' ') || 'none'}${result.notes.length > 0 ? `; ${result.notes.join('; ')}` : ''}\n`);
}

function checkCommand(): void {
  let bad = 0;
  for (const name of readdirSync(SEED_DIR).filter((entry) => entry.endsWith('.json')).sort()) {
    const read = readSheet(JSON.parse(readFileSync(join(SEED_DIR, name), 'utf8')));
    if (read.ok) process.stdout.write(`ok   ${name}: ${read.sheet.subject} ${read.sheet.pose || '-'} ${read.sheet.view} facing ${read.sheet.facing}, ${read.sheet.parts.length} parts, ${read.sheet.made.by} ${read.sheet.made.arm}, ${read.sheet.licence}\n`);
    else {
      bad += 1;
      process.stdout.write(`FAIL ${name}: ${read.reason}\n`);
    }
  }
  if (bad > 0) process.exit(1);
}

function linesCommand(argv: readonly string[]): void {
  const { positional, flags } = flagsOf(argv);
  const file = positional[0];
  if (file === undefined) usage('lines needs a sheet');
  const read = readSheet(JSON.parse(readFileSync(resolve(file), 'utf8')));
  if (!read.ok) usage(read.reason);
  const sheet = read.sheet;
  const lookId = (flags.get('look') ?? 'paper') as LookId;
  const spec = LOOK[lookId];
  if (spec === undefined) usage(`no look called ${lookId}`);
  const lines = expandSheet(
    sheet,
    { id: flags.get('id') ?? 'fig1', at: { x: 80, y: 45 }, size: Number(flags.get('size') ?? 36), mirror: flags.has('mirror'), over: 1 },
    { look: lookClassOf(lookId, spec.ground), roles: { ink: spec.ink, dim: spec.dim, accent: spec.accent, alt: spec.alt, ground: spec.ground }, main: flags.get('fill') ?? null },
  );
  for (const line of lines) process.stdout.write(`${serializeLine(line)}\n`);
}

async function shotsCommand(argv: readonly string[]): Promise<void> {
  const { flags } = flagsOf(argv);
  const looks = (flags.get('look') ?? 'paper,night').split(',') as LookId[];
  const outlines = (flags.get('outline') ?? 'look').split(',');
  const side = Number(flags.get('size') ?? 800);
  const out = resolve(flags.get('out') ?? join(process.cwd(), 'art-shots'));
  const only = flags.get('subject');
  mkdirSync(out, { recursive: true });
  const port = 4877;
  const web = `http://127.0.0.1:${port}`;
  const vite = spawnTracked('pnpm', ['--filter', '@conduit/web', 'exec', 'vite'], undefined, { cwd: repoRoot(), env: { VITE_PORT: String(port), VITE_API: 'http://127.0.0.1:1' }, quiet: true });
  try {
    await waitFor('the web dev server', 60_000, async () => ((await fetch(`${web}/explore.html`)).ok ? true : null));
    for (const name of readdirSync(SEED_DIR).filter((entry) => entry.endsWith('.json')).sort()) {
      const read = readSheet(JSON.parse(readFileSync(join(SEED_DIR, name), 'utf8')));
      if (!read.ok || (only !== undefined && read.sheet.subject !== only)) continue;
      for (const lookId of looks) {
        for (const outline of outlines) {
          const spec = LOOK[lookId];
          const lines: Line[] = ['scene art layout=free canvas=square']
            .map((raw) => parseLine(raw))
            .flatMap((parsed) => (parsed.kind === 'line' ? [parsed.line] : []));
          const look = parseLine(`look ${lookId}`);
          if (look.kind !== 'line') continue;
          lines.unshift(look.line);
          lines.push(...expandSheet(read.sheet, { id: 'a1', at: { x: 50, y: 50 }, size: 96, mirror: false, over: 0.1 }, { look: lookClassOf(lookId, spec.ground), roles: { ink: spec.ink, dim: spec.dim, accent: spec.accent, alt: spec.alt, ground: spec.ground }, main: null, ...(outline === 'default' ? {} : { outline }) }));
          const eyes = await openEyes({ web, port, repo: repoRoot() });
          try {
            const reply = await eyes.look({ turn: 't1', base: EMPTY_STAGE, lines: lines.map((line, at) => ({ seq: at + 1, line })), viewport: { width: side, height: side, dpr: 1 }, playhead: null, earlier: [], judgeSide: side, look: lookId });
            const png = reply.judge[reply.judge.length - 1];
            if (png === undefined) throw new Error('the page took no picture');
            const file = join(out, `${basename(name, '.json')}.${lookId}.${outline}.png`);
            writeFileSync(file, Buffer.from(png.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
            process.stdout.write(`${file}\n`);
          } finally {
            await eyes.close().catch(() => undefined);
          }
        }
      }
    }
  } finally {
    await stop(vite);
  }
}


const REPO_ART = resolve(SEED_DIR, '..');

async function fillCommand(argv: readonly string[]): Promise<void> {
  const { flags } = flagsOf(argv);
  const listFile = resolve(flags.get('list') ?? join(REPO_ART, 'common.txt'));
  const maxRaw = flags.get('max');
  const max = maxRaw === undefined ? Number.POSITIVE_INFINITY : Number(maxRaw);
  if (!(max > 0)) usage('--max is a number of drawings above 0');
  const into = flags.get('into') ?? 'cache';
  if (into !== 'seed' && into !== 'cache') usage('--into is seed or cache');
  const source = withDataFlag(flags.has('data') ? ['--data', flags.get('data') ?? ''] : [], process.env);
  const paths = dataPaths(resolveDataDir(source));
  const log = createLogger('warn', { part: 'art-fill' });
  const base = createShelf({ seedDir: SEED_DIR, cacheDir: paths.artCache, log });
  const wants = parseList(readFileSync(listFile, 'utf8'));
  const plan = project(wants, base, max);
  process.stdout.write(`${listFile}\nshelf: ${base.count()} sheets of ${base.subjects().length} subjects; filling into ${into === 'seed' ? SEED_DIR : paths.artCache}\n${describeProjection(plan)}\n`);
  if (flags.has('dry-run') || plan.toMake.length === 0) return;
  const throttle = throttleOf(paths.usage, capFromEnv(process.env));
  const settings: MakerSettings = {
    bin: process.env['CLAUDE_BIN'] ?? 'claude',
    callMs: 300_000,
    meter: (call) => void appendUsage(paths.usage, { time: new Date().toISOString(), kind: 'art', model: call.model, session: null, turn: null, login: null, inputTokens: call.usage.inputTokens, cacheReadTokens: call.usage.cacheReadTokens, cacheWriteTokens: call.usage.cacheWriteTokens, outputTokens: call.usage.outputTokens, thinkingTokens: call.usage.thinkingTokens, costUsd: call.usage.costUsd, ms: call.usage.ms }),
  };
  const shelf = into === 'seed' ? seedingShelf(base, SEED_DIR, (file) => process.stdout.write(`      wrote ${file}\n`)) : base;
  let stopped = false;
  let current: { stop(): void } | null = null;
  process.on('SIGINT', () => {
    if (stopped) process.exit(130);
    stopped = true;
    process.stdout.write('\nstopping: the drawing in hand is abandoned, what is done is kept (Ctrl-C again to quit at once)\n');
    current?.stop();
  });
  const result = await fill(plan.toMake, { shelf, maker: oneShotMaker(settings), throttle, log, now: Date.now, say: (text) => process.stdout.write(`${text}\n`), interrupted: () => stopped, onStudio: (studio) => (current = studio) });
  const spent = result.made.reduce((sum, made) => sum + (made.usd ?? 0), 0);
  process.stdout.write(`\nmade ${result.made.length}, failed ${result.failed.length}${result.stopped === null ? '' : `, stopped: ${result.stopped}`}; $${spent.toFixed(2)} cost-equivalent\n`);
  if (into === 'seed' && result.made.length > 0) process.stdout.write('add a row for each new sheet to art/LICENCES.md, then: pnpm art check\n');
  if (result.failed.length > 0 && result.made.length === 0) process.exitCode = 1;
}

const [command = '', ...rest] = process.argv.slice(2);
if (command === 'import') importCommand(rest);
else if (command === 'check') checkCommand();
else if (command === 'lines') linesCommand(rest);
else if (command === 'fill') await fillCommand(rest);
else if (command === 'shots') await shotsCommand(rest);
else usage(command === '' ? 'a command is needed' : `no command called ${command}`);
