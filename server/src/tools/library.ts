// The technique library from the command line. Not part of the server.
// Usage: pnpm library                    what the library holds and where it came from
//        pnpm library list               every technique: source, title, when it applies
//        pnpm library match "<message>"  the techniques that message would be handed, with scores, and what they add to the brief
//        pnpm library check              every battery prompt against the library: which techniques each gets, and how long choosing takes
//        pnpm library lint [file…]       whether technique files may be written (default: every seed file)
// Not built yet (PLAN-v2.md, package S2):
//        pnpm library sync               read Remote now and refresh the file cache
//        pnpm library push <file>        write one technique to Remote: lint, an edit pass and a reader pass by cold sessions,
//                                        read the block again, send its fingerprint, re-apply on a conflict
//        pnpm library usage              how often each technique was handed over and how its answers judged, from the session logs and the runs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { estimateTokens, techniquesText } from '@conduit/language';
import type { ExploreBattery } from '@conduit/language';
import { cardOf, lintTechnique } from '../domain/techniques';
import type { TechniqueLibrary } from '../domain/techniques';
import { loadEnv, processEnvironment } from '../env';
import { createLibrary } from '../library/registry';
import { createLogger } from '../log';

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string): never {
  process.stderr.write(`library: ${message}\n`);
  process.exit(2);
}

function open(): { library: TechniqueLibrary; seedDir: string; exploreDir: string } {
  const source = processEnvironment();
  // The tools need the library's settings and nothing of the brain's.
  const env = loadEnv({ ...source, BRAIN: 'replay', LIBRARY: source['LIBRARY'] ?? 'seed' });
  if (env.library.kind === 'none') fail('LIBRARY=none: there is no library to read');
  return { library: createLibrary(env.library, createLogger('warn'), () => Date.now()), seedDir: env.library.seedDir, exploreDir: env.exploreDir };
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

function check(library: TechniqueLibrary, exploreDir: string): void {
  const files = [join(exploreDir, 'battery.json'), join(exploreDir, 'sealed', 'heldout.json')].filter((file) => existsSync(file));
  let asked = 0;
  let served = 0;
  let nanos = 0n;
  for (const file of files) {
    const battery = JSON.parse(readFileSync(file, 'utf8')) as ExploreBattery;
    out(`\n${file}`);
    for (const prompt of battery.prompts) {
      const began = process.hrtime.bigint();
      const hits = library.match({ input: { kind: 'prompt', text: prompt.prompt }, documents: false });
      nanos += process.hrtime.bigint() - began;
      asked += 1;
      if (hits.length > 0) served += 1;
      out(`  ${prompt.id.padEnd(20)} ${prompt.expects.padEnd(10)} ${hits.length === 0 ? '-' : hits.map((hit) => `${hit.technique.title} (${hit.score.toFixed(1)})`).join('; ')}`);
    }
  }
  if (asked === 0) fail('no battery found');
  out(`\n${served} of ${asked} prompts are handed at least one technique; choosing takes ${(Number(nanos) / asked / 1000).toFixed(0)} microseconds a prompt`);
}

function lint(files: readonly string[]): void {
  let bad = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const title = (lines.find((line) => line.startsWith('# ')) ?? '').slice(2).trim();
    const summary = (lines.find((line) => /^summary:/i.test(line)) ?? '').replace(/^summary:/i, '').trim();
    const reason = (lines.find((line) => /^reason:/i.test(line)) ?? '').replace(/^reason:/i, '').trim();
    const body = lines.filter((line) => !line.startsWith('# ') && !/^(?:summary|reason):/i.test(line)).join('\n');
    const problems = lintTechnique(title, summary, reason, body);
    if (problems.length > 0) bad += 1;
    out(`${problems.length === 0 ? 'ok  ' : 'BAD '} ${file}${problems.map((problem) => `\n       ${problem}`).join('')}`);
  }
  process.exitCode = bad === 0 ? 0 : 1;
}

const [command = 'status', ...rest] = process.argv.slice(2);
if (command === 'sync' || command === 'push' || command === 'usage') fail(`"${command}" is not built yet; see PLAN-v2.md, package S2`);
const { library, seedDir, exploreDir } = open();
if (command === 'status') {
  const status = library.status();
  out(`${status.techniques} techniques: ${Object.entries(status.bySource).map(([source, count]) => `${count} ${source}`).join(', ')}`);
  out(status.refreshedAt === null ? 'Remote has not been read in this process' : `Remote read at ${status.refreshedAt}`);
} else if (command === 'list') {
  for (const hit of library.match({ input: { kind: 'prompt', text: '' }, documents: false })) out(hit.technique.title);
  for (const file of existsSync(seedDir) ? readdirSync(seedDir).sort() : []) out(`seed  ${file}`);
} else if (command === 'match') {
  if (rest.length === 0) fail('match needs a message: pnpm library match "how does a toilet flush?"');
  showMatch(library, rest.join(' '));
} else if (command === 'check') {
  check(library, exploreDir);
} else if (command === 'lint') {
  lint(rest.length > 0 ? rest.map((file) => resolve(file)) : readdirSync(seedDir).filter((name) => name.endsWith('.md')).sort().map((name) => join(seedDir, name)));
} else {
  fail(`unknown command "${command}"; try: status, list, match, check, lint`);
}
