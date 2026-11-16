// The technique library from the command line. Not part of the server.
// Usage: pnpm library                    what the library holds and where it came from
//        pnpm library list               every technique: source, title, when it applies
//        pnpm library match "<message>"  the techniques that message would be handed, with scores, and what they add to the brief
//        pnpm library check              every battery prompt against the library: which techniques each gets, and how long choosing takes
//        pnpm library lint [file…]       whether technique files may be written (default: every seed file)
//        pnpm library usage              how often each technique was handed over and how its answers judged, from the session logs and the runs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { estimateTokens, techniquesText } from '@conduit/language';
import type { ExploreBattery } from '@conduit/language';
import { cardOf, lintTechnique } from '../domain/techniques';
import type { Technique, TechniqueLibrary } from '../domain/techniques';
import { loadEnv, processEnvironment } from '../env';
import { expectationOf } from '../library/fit';
import { readTechniqueDir, splitTechniqueFile } from '../library/files';
import { createLibrary } from '../library/registry';
import { collectUsage } from '../library/usage';

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string): never {
  process.stderr.write(`library: ${message}\n`);
  process.exit(2);
}

type Env = ReturnType<typeof loadEnv>;

function open(): { library: TechniqueLibrary; env: Env; seedDir: string; exploreDir: string } {
  // The tools need the library's settings and nothing of the brain's.
  const env = loadEnv({ ...processEnvironment(), BRAIN: 'replay' });
  if (env.library.kind === 'none') fail('LIBRARY=none: there is no library to read');
  return { library: createLibrary(env.library), env, seedDir: env.library.seedDir, exploreDir: env.exploreDir };
}

function showMatch(library: TechniqueLibrary, message: string): void {
  const hits = library.match({ input: { kind: 'prompt', text: message }, documents: false });
  if (hits.length === 0) {
    out('no technique fits; the brief carries none');
    return;
  }
  for (const hit of hits) out(`${hit.score.toFixed(2).padStart(6)}  ${hit.technique.title}  [${hit.matched.join(', ')}]  (${hit.technique.source})`);
  const text = techniquesText(hits.map((hit) => cardOf(hit.technique))) ?? '';
  out(`\nadds ${text.length} characters, about ${estimateTokens(text)} tokens, to the brief:\n\n${text}`);
}

interface Tally {
  expected: number;
  fit: number;
  plain: number;
  plainClean: number;
  off: number;
  answered: number;
}

/** Row 22 (fit) and row 21 (time) against one battery file. Prints a line per prompt that is expected something or handed something. */
function checkBattery(library: TechniqueLibrary, file: string, stemOfTitle: ReadonlyMap<string, string>, micros: number[]): Tally {
  const battery = JSON.parse(readFileSync(file, 'utf8')) as ExploreBattery;
  const tally: Tally = { expected: 0, fit: 0, plain: 0, plainClean: 0, off: 0, answered: 0 };
  for (const prompt of battery.prompts) {
    const query = { input: { kind: 'prompt', text: prompt.prompt }, documents: false } as const;
    const began = process.hrtime.bigint();
    const hits = library.match(query);
    micros.push(Number(process.hrtime.bigint() - began) / 1000);
    const expectation = expectationOf(prompt);
    const stems = hits.map((hit) => stemOfTitle.get(hit.technique.title.trim().toLowerCase()) ?? hit.technique.title);
    let mark = '    ';
    if (expectation.kind === 'none') {
      tally.plain += 1;
      if (hits.length === 0) tally.plainClean += 1;
      else mark = 'EXTRA';
    } else if (expectation.kind === 'one-of') {
      tally.expected += 1;
      if (stems.some((stem) => expectation.stems.includes(stem))) tally.fit += 1;
      else mark = 'MISS ';
      tally.off += stems.filter((stem) => !expectation.stems.includes(stem)).length;
    }
    if (hits.length > 0) tally.answered += 1;
    out(`  ${mark} ${prompt.id.padEnd(20)} ${stems.join(', ') || '-'}${expectation.kind === 'one-of' ? `   (wants ${expectation.stems.join(' | ')})` : ''}`);
  }
  return tally;
}

function check(library: TechniqueLibrary, seedDir: string, exploreDir: string): void {
  const stemOfTitle = new Map<string, string>(readTechniqueDir(seedDir, 'seed').map((technique) => [technique.title.trim().toLowerCase(), technique.id.replace(/^seed:/, '')]));
  const micros: number[] = [];
  const tune = join(exploreDir, 'battery.json');
  const heldout = join(exploreDir, 'sealed', 'heldout.json');
  if (!existsSync(tune)) fail('no battery found');
  out(`\ntune set: ${tune}`);
  const a = checkBattery(library, tune, stemOfTitle, micros);
  const report = (name: string, t: Tally): void =>
    out(`${name}: fit ${t.fit} of ${t.expected} (${((100 * t.fit) / Math.max(1, t.expected)).toFixed(0)}%, wanted 90%); plain prompts handed none ${t.plainClean} of ${t.plain} (${((100 * t.plainClean) / Math.max(1, t.plain)).toFixed(0)}%, wanted 100%); off-target techniques handed ${t.off}; ${t.answered} prompts handed something`);
  report('tune', a);
  if (existsSync(heldout) && process.argv.includes('--heldout')) {
    out(`\nheld-out set (read it, do not tune on it): ${heldout}`);
    report('held-out', checkBattery(library, heldout, stemOfTitle, micros));
  }
  // Row 21: the time to choose, over the prompts and again over many repeats, so that a cold first call does not hide in an average.
  const sorted = [...micros].sort((x, y) => x - y);
  const worst = sorted[sorted.length - 1] ?? 0;
  const steady: number[] = [];
  const prompts = (JSON.parse(readFileSync(tune, 'utf8')) as ExploreBattery).prompts;
  for (let round = 0; round < 20; round += 1) {
    for (const prompt of prompts) {
      const began = process.hrtime.bigint();
      library.match({ input: { kind: 'prompt', text: prompt.prompt }, documents: false });
      steady.push(Number(process.hrtime.bigint() - began) / 1000);
    }
  }
  steady.sort((x, y) => x - y);
  out(`choosing, steady (${steady.length} calls): p99 ${(steady[Math.floor(steady.length * 0.99)] ?? 0).toFixed(0)} us, worst ${(steady[steady.length - 1] ?? 0).toFixed(0)} us`);
  out(`choosing: median ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(0)} us, first pass worst ${worst.toFixed(0)} us over ${sorted.length} prompts (the process's first calls and a garbage collection can show here; limit 1000 us)`);
}

function lint(files: readonly string[]): void {
  let bad = 0;
  for (const file of files) {
    const parts = splitTechniqueFile(readFileSync(file, 'utf8'));
    const problems = parts === null ? ['it has no "# title" line'] : lintTechnique(parts.title, parts.summary, parts.reason, parts.markdown);
    if (problems.length > 0) bad += 1;
    out(`${problems.length === 0 ? 'ok  ' : 'BAD '} ${file}${problems.map((problem) => `\n       ${problem}`).join('')}`);
  }
  process.exitCode = bad === 0 ? 0 : 1;
}

function usage(env: Env, seedDir: string, exploreDir: string): void {
  const known: Technique[] = readTechniqueDir(seedDir, 'seed');
  const rows = collectUsage(known, env.logDir, exploreDir);
  out(`${'technique'.padEnd(58)} turns answers runs  score  without  flag`);
  for (const row of rows) out(`${row.title.slice(0, 57).padEnd(58)} ${String(row.turns).padStart(5)} ${String(row.answers).padStart(7)} ${String(row.runs).padStart(4)}  ${row.meanCoherence === null ? '   - ' : row.meanCoherence.toFixed(2)}  ${row.without === null ? '   -   ' : row.without.toFixed(2).padStart(6)}   ${row.flag ?? ''}`);
  out('\nscore is the judge\'s coherence, 1 to 5; "graduate" means handed over often, across runs, and scoring 4 or more: a candidate to become part of the language');
}

const [command = 'status', ...rest] = process.argv.slice(2);
const { library, env, seedDir, exploreDir } = open();
if (command === 'status') {
  const status = library.status();
  out(`${status.techniques} techniques: ${Object.entries(status.bySource).map(([source, count]) => `${count} ${source}`).join(', ')}`);
} else if (command === 'list') {
  for (const file of existsSync(seedDir) ? readdirSync(seedDir).sort() : []) out(`seed  ${file}`);
} else if (command === 'match') {
  if (rest.length === 0) fail('match needs a message: pnpm library match "how does a toilet flush?"');
  showMatch(library, rest.join(' '));
} else if (command === 'check') {
  check(library, seedDir, exploreDir);
} else if (command === 'lint') {
  lint(rest.length > 0 ? rest.map((file) => resolve(file)) : readdirSync(seedDir).filter((name) => name.endsWith('.md')).sort().map((name) => join(seedDir, name)));
} else if (command === 'usage') {
  usage(env, seedDir, exploreDir);
} else {
  fail(`unknown command "${command}"; try: status, list, match, check, lint, usage`);
}
