// The technique library from the command line. Not part of the server.
// Usage: pnpm library                    what the library holds and where it came from
//        pnpm library list               every technique: source, title, when it applies
//        pnpm library match "<message>"  the techniques that message would be handed, with scores, and what they add to the brief
//        pnpm library check              every battery prompt against the library: which techniques each gets, and how long choosing takes
//        pnpm library lint [file…]       whether technique files may be written (default: every seed file)
//        pnpm library sync               read Remote now, refresh the file cache, say what changed
//        pnpm library push <file>        write one technique to Remote. A DRY RUN unless --apply (steward only: REMOTE_AGENT=conduit-steward):
//                                        lint, an edit pass and a reader pass by cold sessions (--skip-passes), the block read again, its
//                                        fingerprint sent, the exact commands printed; with --apply, read back and compared
//        pnpm library usage              how often each technique was handed over and how its answers judged, from the session logs and the runs
//        pnpm library datasets ["<message>"]  what the owner's datasets index holds, as the brief says it; with a message, what it finds and the last row (needs DATASETS=remote)
//        pnpm library datasets raw       the keys and kinds of what `remote get datasets|dataset|rows` print, never a value
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, techniquesText } from '@conduit/language';
import type { ExploreBattery } from '@conduit/language';
import { datasetsText, factsOf } from '../domain/datasets';
import { cardOf, lintTechnique } from '../domain/techniques';
import type { Technique, TechniqueLibrary } from '../domain/techniques';
import { loadEnv, processEnvironment } from '../env';
import { claudeAsk, editPass, readerPass } from '../library/cold-passes';
import { expectationOf } from '../library/fit';
import { readCache, readTechniqueDir, splitTechniqueFile } from '../library/files';
import { createRemoteWriter, STEWARD, stewardIdentity } from '../library/remote/remote-cli';
import { createDatasets, createLibrary } from '../library/registry';
import { collectUsage } from '../library/usage';
import { createLogger } from '../log';

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string): never {
  process.stderr.write(`library: ${message}\n`);
  process.exit(2);
}

type Env = ReturnType<typeof loadEnv>;

function open(): { library: TechniqueLibrary; env: Env; seedDir: string; exploreDir: string } {
  const source = processEnvironment();
  // The tools need the library's settings and nothing of the brain's.
  const env = loadEnv({ ...source, BRAIN: 'replay', LIBRARY: source['LIBRARY'] ?? (['sync', 'push', 'usage'].includes(process.argv[2] ?? '') ? 'remote' : 'seed') });
  if (env.library.kind === 'none') fail('LIBRARY=none: there is no library to read');
  return { library: createLibrary(env.library, createLogger('warn'), () => Date.now()), env, seedDir: env.library.seedDir, exploreDir: env.exploreDir };
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

async function sync(env: Env): Promise<void> {
  if (env.library.kind !== 'remote') fail('sync reads Remote: run it with LIBRARY=remote (the default for the server)');
  const library = createLibrary(env.library, createLogger('info'), () => Date.now());
  const before = library.status();
  out(`before: ${before.techniques} techniques (${Object.entries(before.bySource).map(([source, count]) => `${count} ${source}`).join(', ')})`);
  const began = Date.now();
  const after = await library.refresh(new AbortController().signal);
  out(`after:  ${after.techniques} techniques (${Object.entries(after.bySource).map(([source, count]) => `${count} ${source}`).join(', ')}) in ${Date.now() - began} ms`);
  if (after.failure !== null) {
    out(`Remote could not be read: ${after.failure}\nthe library serves the cache and the seed`);
    process.exitCode = 1;
  } else out(`read at ${after.refreshedAt ?? ''}; cache at ${env.library.cacheDir}`);
}

async function push(env: Env, rest: readonly string[]): Promise<void> {
  if (env.library.kind !== 'remote') fail('push writes to Remote: run it with LIBRARY=remote');
  const settings = env.library;
  const file = rest.find((word) => !word.startsWith('--'));
  if (file === undefined) fail('push needs a technique file: pnpm library push techniques/seed/chart-candles.md');
  const apply = rest.includes('--apply');
  const parts = splitTechniqueFile(readFileSync(resolve(file), 'utf8'));
  if (parts === null) fail(`${file} has no "# title" line`);
  const identity = stewardIdentity(!apply);
  if (apply && identity.agent !== STEWARD) fail(`--apply writes to Remote and only the steward may: set REMOTE_AGENT=${STEWARD} (this is ${identity.agent})`);
  out(apply ? `APPLY as ${identity.agent} on ${settings.env}` : `dry run (nothing is written; --apply is the steward's)  on ${settings.env}`);
  const problems = lintTechnique(parts.title, parts.summary, parts.reason, parts.markdown);
  if (problems.length > 0) {
    for (const problem of problems) out(`refused: ${problem}`);
    process.exit(1);
  }
  out('lint: ok');
  const limit = AbortSignal.timeout(300_000);
  if (!rest.includes('--skip-passes')) {
    const ask = claudeAsk(env.brain.kind === 'claude-cli' ? env.brain.bin : (processEnvironment()['CLAUDE_BIN'] ?? 'claude'), processEnvironment()['CLAUDE_MODEL'] ?? 'sonnet');
    const text = `# ${parts.title}\n\nsummary: ${parts.summary}\nreason: ${parts.reason}\n\n${parts.markdown}`;
    const [edit, reader] = await Promise.all([editPass(ask, text, limit), readerPass(ask, text, limit)]);
    out(`edit pass: ${edit.ok ? 'ok' : 'problems'}${edit.problems.map((p) => `\n   ${p}`).join('')}`);
    out(`reader pass: ${reader.ok ? 'ok' : 'confusions'}${reader.problems.map((p) => `\n   ${p}`).join('')}\n   understood as: ${reader.understood}`);
    if (!edit.ok || !reader.ok) {
      out('not written: change the file and push again');
      process.exit(1);
    }
  } else out('cold passes: skipped');

  const writer = createRemoteWriter(settings, identity, createLogger('warn'));
  const existing = (await writer.index(limit)).find((entry) => entry.title.trim().toLowerCase() === parts.title.trim().toLowerCase());
  const current = existing === undefined ? null : await writer.read(existing.id, limit);
  if (existing !== undefined && current !== null && current.markdown.replace(/\r\n/g, '\n').trim() === parts.markdown && current.summary.trim() === parts.summary && existing.reason.trim() === parts.reason) {
    out(`already there and identical: ${existing.id}`);
    return;
  }
  out(existing === undefined ? 'new technique: it will be created and linked from the root' : `existing technique ${existing.id}: it will be rewritten from fingerprint ${current?.fingerprint ?? '?'}`);
  const result = await writer.write({ id: existing?.id ?? null, title: parts.title, summary: parts.summary, reason: parts.reason, markdown: parts.markdown }, current?.fingerprint ?? null, limit);
  for (const step of writer.plan) out(`\n${step.line}${step.stdin === null ? '' : `\n----- body.md -----\n${step.stdin}-------------------`}`);
  if (result.outcome === 'refused') {
    for (const problem of result.problems) out(`refused: ${problem}`);
    process.exit(1);
  }
  if (result.outcome === 'conflict') {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../techniques/.cache/conflicts');
    mkdirSync(dir, { recursive: true });
    const saved = join(dir, `${result.id}.md`);
    writeFileSync(saved, result.current);
    out(`CONFLICT: ${result.id} changed since it was read (now at ${result.fingerprint}). Its text is saved at ${saved}. Merge by hand and push again; nothing was written.`);
    process.exit(3);
  }
  if (!apply) {
    out('\ndry run complete: the commands above are exactly what --apply would run');
    return;
  }
  const back = await writer.read(result.id, limit);
  const same = back !== null && back.markdown.replace(/\r\n/g, '\n').trim() === parts.markdown && back.title.trim() === parts.title && back.summary.trim() === parts.summary;
  out(same ? `written and read back identical: ${result.id}` : `WRITTEN BUT THE READ-BACK DIFFERS: ${result.id}; read it and repair`);
  if (!same) process.exit(1);
}

function usage(env: Env, seedDir: string, exploreDir: string, library: TechniqueLibrary): void {
  void library;
  const cacheDir = env.library.kind === 'remote' ? env.library.cacheDir : null;
  const known: Technique[] = [...readTechniqueDir(seedDir, 'seed'), ...(cacheDir === null ? [] : readCache(cacheDir))];
  const rows = collectUsage(known, env.logDir, exploreDir);
  out(`${'technique'.padEnd(58)} turns answers runs  score  without  flag`);
  for (const row of rows) out(`${row.title.slice(0, 57).padEnd(58)} ${String(row.turns).padStart(5)} ${String(row.answers).padStart(7)} ${String(row.runs).padStart(4)}  ${row.meanCoherence === null ? '   - ' : row.meanCoherence.toFixed(2)}  ${row.without === null ? '   -   ' : row.without.toFixed(2).padStart(6)}   ${row.flag ?? ''}`);
  out('\nscore is the judge\'s coherence, 1 to 5; "graduate" means handed over often, across runs, and scoring 4 or more: a candidate to become part of the language');
}

/** The keys and kinds of a JSON value, never its values: what the shape is, safe to paste. */
function shapeOf(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return `[${value.length > 0 && depth < 4 ? shapeOf(value[0], depth + 1) : ''}] x${value.length}`;
  if (typeof value === 'object' && value !== null) return depth >= 4 ? '{...}' : `{ ${Object.entries(value).map(([key, inner]) => `${key}: ${shapeOf(inner, depth + 1)}`).join(', ')} }`;
  return value === null ? 'null' : typeof value;
}

async function datasets(env: Env): Promise<void> {
  if (env.datasets.kind === 'none') fail('DATASETS is off; set DATASETS=remote (and DATASETS_ACTOR to the owner\'s account) to read them');
  const { runRemote, parseJson } = await import('../library/remote/run');
  const settings = env.datasets;
  const rest = process.argv.slice(4);
  if (rest[0] === 'raw') {
    // The shape of each command's output, keys and kinds only: what to read before changing the adapter.
    const identity = { session: `conduit-datasets-raw-${process.pid}`, agent: 'conduit-s2' };
    const run = (args: readonly string[]): Promise<string> => runRemote({ bin: settings.bin, args: [...args, ...(settings.actor === null ? [] : ['--as', settings.actor]), '--env', settings.env], identity, timeoutMs: settings.timeoutMs * 3, signal: AbortSignal.timeout(60_000) });
    const list = parseJson(await run(['get', 'datasets']), 'datasets');
    out(`get datasets: ${shapeOf(list)}`);
    const first = Array.isArray(list) ? list[0] : (Object.values((list ?? {}) as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined)?.[0];
    const name = typeof first === 'string' ? first : typeof first === 'object' && first !== null ? String((first as Record<string, unknown>)['name'] ?? '') : '';
    if (name === '') return;
    out(`get dataset ${name}: ${shapeOf(parseJson(await run(['get', 'dataset', name]), 'dataset'))}`);
    out(`get rows ${name}: ${shapeOf(parseJson(await run(['get', 'rows', name, '--limit', '2']), 'rows'))}`);
    return;
  }
  const library = createDatasets(env.datasets, createLogger('warn'));
  await library.refresh(AbortSignal.timeout(60_000)).catch((error: unknown) => out(`could not read Remote: ${error instanceof Error ? error.message : String(error)}\n(what is shown below is what the cache on disk holds)`));
  const facts = library.facts(Date.now());
  out(datasetsText(facts) ?? 'the index holds no dataset');
  const message = rest.join(' ');
  if (message === '') return;
  const found = library.find(message);
  out(found.length === 0 ? '\nno dataset named in that message' : `\n${found.map((entry) => `${entry.dataset}${entry.instrument === null ? '' : ` / ${entry.instrument}`}: ${entry.fields.join(', ')}; last ${entry.last ?? 'unknown'}`).join('\n')}`);
  const entry = found[0];
  if (entry === undefined) return;
  const table = await library.rows(entry, AbortSignal.timeout(settings.timeoutMs * 3));
  const shown = factsOf(table, true);
  out(`\nrows: ${shown.count} of ${table.source}; columns ${table.columns.join(', ')}; last row ${shown.sample.at(-1)?.join(' | ') ?? 'none'}`);
}

const [command = 'status', ...rest] = process.argv.slice(2);
const { library, env, seedDir, exploreDir } = open();
if (command === 'status') {
  const status = library.status();
  out(`${status.techniques} techniques: ${Object.entries(status.bySource).map(([source, count]) => `${count} ${source}`).join(', ')}`);
  out(status.refreshedAt === null ? 'Remote has not been read in this process' : `Remote read at ${status.refreshedAt}`);
} else if (command === 'list') {
  for (const file of existsSync(seedDir) ? readdirSync(seedDir).sort() : []) out(`seed  ${file}`);
} else if (command === 'match') {
  if (rest.length === 0) fail('match needs a message: pnpm library match "how does a toilet flush?"');
  showMatch(library, rest.join(' '));
} else if (command === 'check') {
  check(library, seedDir, exploreDir);
} else if (command === 'lint') {
  lint(rest.length > 0 ? rest.map((file) => resolve(file)) : readdirSync(seedDir).filter((name) => name.endsWith('.md')).sort().map((name) => join(seedDir, name)));
} else if (command === 'sync') {
  await sync(env);
} else if (command === 'push') {
  await push(env, rest);
} else if (command === 'usage') {
  usage(env, seedDir, exploreDir, library);
} else if (command === 'datasets') {
  await datasets(env);
} else {
  fail(`unknown command "${command}"; try: status, list, match, check, lint, sync, push, usage, datasets`);
}
