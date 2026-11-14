// Prints the schedule a script adds up to: when every line starts and ends,
// as if the whole script had arrived before playback began.
// Usage: pnpm timeline <demo name | path to a .series file>
//        pnpm timeline            checks every worked example in the brain's prompt, every demo and every seed technique,
//                                 and that each line reads back as itself
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMOS, EMPTY_STAGE, LineNormalizer, parseLine, LineReader, PROMPT_EXAMPLE_STRUCTURE, PROMPT_EXAMPLES, PROMPT_EXAMPLES_FLAT, serializeLine, TurnScore } from '../src/index';
import type { Issue } from '../src/index';

function describe(issues: readonly Issue[]): string {
  return issues.map((issue) => `${issue.severity} ${issue.code}: ${issue.message}`).join('; ');
}

function run(title: string, source: string): boolean {
  const score = new TurnScore(EMPTY_STAGE);
  const reader = new LineReader();
  let seq = 0;
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  let clean = true;
  source.split('\n').forEach((raw, index) => {
    const result = reader.read(raw);
    if (result.kind === 'reject') {
      clean = false;
      process.stdout.write(`  line ${index + 1} REJECTED  ${raw}\n      ${describe(result.issues)}\n`);
    }
    if (result.kind !== 'line') return;
    const normalized = normalizer.normalize(result.line);
    if (normalized.line === null) {
      clean = false;
      process.stdout.write(`  line ${index + 1} DROPPED  ${raw}\n      ${describe(normalized.issues)}\n`);
      return;
    }
    // Every line must read back as itself once written in its one canonical form.
    const written = serializeLine(normalized.line);
    const again = parseLine(written);
    if (again.kind !== 'line' || serializeLine(again.line) !== written) {
      clean = false;
      process.stdout.write(`  line ${index + 1} ROUND TRIP  ${written}\n      ${again.kind === 'line' ? serializeLine(again.line) : 'does not parse'}\n`);
    }
    seq += 1;
    const pushed = score.push(normalized.line, seq, 0);
    const problems = [...result.issues, ...normalized.issues, ...pushed.issues];
    if (problems.length > 0) {
      clean = false;
      process.stdout.write(`  line ${index + 1} ${pushed.outcome}  ${raw}\n      ${describe(problems)}\n`);
    }
  });
  const schedule = score.schedule;
  // The score, not the source: a `revise` shows up as the line it rewrote.
  const texts = new Map<number, string>();
  for (const entry of score.score) {
    if (!entry.void) texts.set(entry.seq, serializeLine(entry.line));
  }
  process.stdout.write(`\n${title}: pen ${schedule.pen.toFixed(2)}s, end ${schedule.end.toFixed(2)}s, ${schedule.elements.length} elements\n`);
  for (const time of schedule.lines) {
    process.stdout.write(`  ${time.start.toFixed(2).padStart(6)} -> ${time.end.toFixed(2).padStart(6)}  ${(texts.get(time.seq) ?? '').slice(0, 110)}\n`);
  }
  return clean;
}

const argument = process.argv[2];
let ok = true;
if (argument === undefined || argument === 'examples' || argument === 'all') {
  for (const example of [...PROMPT_EXAMPLES, PROMPT_EXAMPLE_STRUCTURE, ...PROMPT_EXAMPLES_FLAT]) ok = run(`prompt example ${example.title}`, example.lines.join('\n')) && ok;
}
if (argument === undefined || argument === 'all') {
  for (const demo of DEMOS) ok = run(`demo ${demo.name}`, readFileSync(fileURLToPath(new URL(`../demos/${demo.name}.series`, import.meta.url)), 'utf8')) && ok;
  const seedDir = fileURLToPath(new URL('../../techniques/seed/', import.meta.url));
  for (const file of readdirSync(seedDir).filter((name) => name.endsWith('.md')).sort()) {
    const blocks = [...readFileSync(`${seedDir}${file}`, 'utf8').matchAll(/```series\n([\s\S]*?)```/g)];
    blocks.forEach((block, at) => {
      ok = run(`seed ${file}${blocks.length > 1 ? ` #${at + 1}` : ''}`, block[1] ?? '') && ok;
    });
  }
}
if (argument !== undefined && argument !== 'examples' && argument !== 'all') {
  const path = argument.endsWith('.series') ? argument : fileURLToPath(new URL(`../demos/${argument}.series`, import.meta.url));
  ok = run(argument, readFileSync(path, 'utf8')) && ok;
}
process.exitCode = ok ? 0 : 1;
