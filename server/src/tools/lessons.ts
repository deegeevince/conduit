// From the live critic's findings to the technique library. Not part of the server.
//
//   pnpm lessons                  --dry-run (the default): read what the critic found since the last run, ask one `claude` call to
//                                 group the recurring problems and draft at most three technique proposals, check each one, and print
//                                 the proposals and the painter-bug list. Writes nothing.
//   pnpm lessons --write          the steward's: write each proposal to techniques/proposed/ as `Proposed technique: <title>`, append
//                                 the painter bugs to loop/queue/painter-bugs.md and move the cursor.
//   --data <dir>                  the data folder, with `loop/queue/` and `logs/` in it (default: DATA_DIR, else ~/Library/Application Support/Conduit); `--from` is its older spelling
//   --all                         ignore the cursor: every finding again
//   --force                       go ahead although the last hour is near the cap (USAGE_HOURLY_CAP): lessons stand down first
//
// A proposal is a technique in the library's own format that targets what the brain controls: how it writes Series. A problem that is
// the painter's (text drawn over text by the layout, a clipped label, a wrong default) is not a technique; it goes to the steward's list.
// A proposal is NOT read by the brain: the library skips every title that begins "Proposed technique:" (domain/techniques.ts
// `isProposedTitle`, applied in library/memory-library.ts `merge`; the library does not read techniques/proposed at all).
// Promotion is the improvement loop's: it measures a proposal with the battery, and only on a measured gain does the steward retitle it.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askObject } from '../judge/ask';
import { addUsage } from '../judge/ask';
import type { JudgeSettings, JudgeUsage } from '../judge/ask';
import { PROPOSED_PREFIX, lintTechnique } from '../domain/techniques';
import { dataPaths, resolveDataDir, withDataFlag } from '../data-dir';
import { appendUsage, capFromEnv, throttleOf } from '../usage';
import { readTechniqueDir, writeProposedFile } from '../library/files';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = (text: string): void => void process.stdout.write(`${text}\n`);
const fail = (text: string): never => {
  process.stderr.write(`lessons: ${text}\n`);
  return process.exit(2);
};

const argv = process.argv.slice(2);
const write = argv.includes('--write');
if (write && argv.includes('--dry-run')) fail('--write and --dry-run are opposites');
// The data folder: `--data <dir>` (older spelling `--from <dir>`), else DATA_DIR, else the default. `logs/` and `loop/queue/` are in it.
const root = resolve(resolveDataDir(withDataFlag(argv, process.env)));
const dataFolders = dataPaths(root);
const queueDir = dataFolders.queue;
const logsDir = dataFolders.logs;
const cursorPath = join(queueDir, 'lessons-cursor.json');
const bugsPath = join(queueDir, 'painter-bugs.md');

const MAX_PROPOSALS = 3;
const MAX_FINDINGS = 60;
const PROPOSED_NOTICE = 'PROPOSED: not yet measured; the brain does not read this until promoted.';

// ---------- what the critic found ----------

interface Problem {
  readonly what: string;
  readonly weight: string;
}
interface Found {
  /** the id the model cites: f1, f2, … */
  id: string;
  readonly key: string;
  readonly log: string;
  readonly turn: string;
  readonly asked: string;
  readonly coherence: number;
  readonly problems: readonly Problem[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function foundFrom(log: string, turn: string, asked: string, finding: unknown): Found | null {
  if (typeof finding !== 'object' || finding === null) return null;
  const f = finding as { coherence?: unknown; pass?: unknown; problems?: unknown };
  if (typeof f.coherence !== 'number' || !Array.isArray(f.problems)) return null;
  const problems = (f.problems as unknown[]).flatMap((p): Problem[] => {
    const entry = p as { what?: unknown; weight?: unknown } | null;
    return entry !== null && typeof entry === 'object' && text(entry.what) !== '' ? [{ what: text(entry.what), weight: text(entry.weight) || 'hurts' }] : [];
  });
  return { id: '', key: `${log}#${turn}#${typeof f.pass === 'number' ? f.pass : 1}`, log, turn, asked, coherence: f.coherence, problems };
}

function readFindings(): Found[] {
  const seen = new Map<string, Found>();
  const queue = join(queueDir, 'findings.jsonl');
  if (existsSync(queue)) {
    for (const line of readFileSync(queue, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as { log?: unknown; turn?: unknown; asked?: unknown; finding?: unknown };
        const found = foundFrom(text(row.log), text(row.turn), text(row.asked), row.finding);
        if (found !== null) seen.set(found.key, found);
      } catch {
        // a torn line is skipped
      }
    }
  }
  if (existsSync(logsDir)) {
    for (const name of readdirSync(logsDir).filter((n) => n.endsWith('.jsonl')).sort()) {
      const asks = new Map<string, string>();
      for (const line of readFileSync(join(logsDir, name), 'utf8').split('\n')) {
        if (!line.includes('"turn"') && !line.includes('"critic"')) continue;
        try {
          const row = JSON.parse(line) as { type?: unknown; turn?: unknown; input?: { text?: unknown }; finding?: unknown };
          if (row.type === 'turn') asks.set(text(row.turn), text(row.input?.text));
          else if (row.type === 'critic') {
            const found = foundFrom(name, text(row.turn), asks.get(text(row.turn)) ?? '', row.finding);
            if (found !== null && !seen.has(found.key)) seen.set(found.key, found);
          }
        } catch {
          // skipped
        }
      }
    }
  }
  return [...seen.values()];
}

function readCursor(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath, 'utf8')) as { seen?: unknown };
    return new Set(Array.isArray(parsed.seen) ? (parsed.seen as unknown[]).filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

// ---------- the one model call ----------

function claudeBin(): string {
  return process.env['CLAUDE_BIN'] ?? 'claude';
}
const SETTINGS: JudgeSettings = {
  bin: claudeBin(),
  model: 'sonnet',
  effort: 'low',
  timeoutMs: 240_000,
  // Every call this tool makes goes into the same usage meter the server writes to, so the hour's total is the machine's.
  meter: ({ model, usage }) =>
    void appendUsage(dataFolders.usage, {
      time: new Date().toISOString(),
      kind: 'lessons',
      model,
      session: null,
      turn: null,
      login: null,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      thinkingTokens: usage.thinkingTokens,
      costUsd: usage.costUsd,
      ms: usage.ms,
    }),
};

function run(file: string, args: readonly string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    execFile(file, [...args], { cwd, timeout: 120_000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
      done({ code, output: `${stdout}${stderr}` });
    });
  });
}

function systemPrompt(language: string, seedExample: string, existing: readonly string[]): string {
  return `You help improve a program called Conduit. A language model (the "brain") answers by writing "Series", a line-based scene language; a separate painter (code, not the brain) draws it. A critic looked at pictures of real answers and listed problems. You group the problems that RECUR across turns and draft technique proposals.

A technique is a short recipe the brain is handed when a request matches it. It changes how the brain WRITES Series. So a proposal is right only for problems the brain causes by what it chose to write: too much on one stage, labels it set too long or too small, the wrong structure for the request, a number that contradicts its own chart, missing axis labels it could have written, controls it forgot, a subject it did not draw. A problem that the painter caused with correct Series (text drawn over other text by the layout engine, a clip or truncation in code, a look's colours, wrong default sizes) is NOT a technique: list it under painterBugs. When unsure whether the brain or the painter caused it, prefer painterBugs.

Only propose when the same kind of problem appears in at least two different turns. At most ${MAX_PROPOSALS} proposals; fewer or none is fine. A proposal must not duplicate an existing technique: ${existing.join('; ')}.

Write each technique in this exact shape, in the present tense, with no dates, no history ("previously", "no longer"), no change numbers:
- title: a short noun phrase for the kind of request (no prefix; one will be added)
- summary: one or two sentences saying when it applies, in the words a person asks in (this is what a message is matched on)
- reason: begins "only if you are drawing <subject>"
- purpose: one line, what it is for
- when: when to use it
- notWhen: when not to
- example: an array of at most 14 lines of valid Series (see the language reference below). Every line must parse. No blank strings in the array. It is a worked example of the practice, on one concrete subject.
- failed: what goes wrong without it, taken from the findings
- cites: the finding ids (f1, f2, …) it came from, at least two

Here is one finished technique, to copy the format of:

${seedExample}

Reply with ONE JSON object and nothing else:
{"proposals":[{"title":"","summary":"","reason":"","purpose":"","when":"","notWhen":"","example":[""],"failed":"","cites":["f1"]}],"painterBugs":[{"what":"one sentence, specific enough for the steward to reproduce","cites":["f3"]}]}

=== THE SERIES LANGUAGE (what the brain is told) ===
${language}`;
}

function requestText(found: readonly Found[]): string {
  return `Findings from the live critic (coherence 1 to 5; problems weighted blocks, hurts, polish):\n\n${found
    .map((f) => `${f.id}  [${f.log} ${f.turn}]  coherence ${f.coherence}  asked: ${f.asked.slice(0, 160)}\n${f.problems.map((p) => `   - (${p.weight}) ${p.what}`).join('\n')}`)
    .join('\n\n')}`;
}

interface Proposal {
  title: string;
  summary: string;
  reason: string;
  purpose: string;
  when: string;
  notWhen: string;
  example: string[];
  failed: string;
  cites: Found[];
}
interface Bug {
  what: string;
  cites: Found[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : []);

function readReply(object: Record<string, unknown>, found: readonly Found[]): { proposals: Proposal[]; bugs: Bug[] } {
  const byId = new Map(found.map((f) => [f.id, f]));
  const cites = (value: unknown): Found[] => strings(value).flatMap((id) => byId.get(id) ?? []);
  const proposals: Proposal[] = [];
  for (const raw of Array.isArray(object['proposals']) ? (object['proposals'] as unknown[]) : []) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const proposal: Proposal = {
      title: text(p['title']).replace(/^proposed technique:\s*/i, '').trim(),
      summary: text(p['summary']).trim(),
      reason: text(p['reason']).trim(),
      purpose: text(p['purpose']).trim(),
      when: text(p['when']).trim(),
      notWhen: text(p['notWhen']).trim(),
      example: strings(p['example']).map((l) => l.trimEnd()).filter((l) => l.trim() !== ''),
      failed: text(p['failed']).trim(),
      cites: cites(p['cites']),
    };
    if (proposal.title !== '') proposals.push(proposal);
  }
  const bugs: Bug[] = [];
  for (const raw of Array.isArray(object['painterBugs']) ? (object['painterBugs'] as unknown[]) : []) {
    const b = (raw ?? {}) as Record<string, unknown>;
    if (text(b['what']).trim() !== '') bugs.push({ what: text(b['what']).trim(), cites: cites(b['cites']) });
  }
  return { proposals: proposals.slice(0, MAX_PROPOSALS), bugs };
}

// ---------- the body, and checking it ----------

const citeLine = (cites: readonly Found[]): string => cites.map((c) => `${c.log} ${c.turn}`).join('; ');

function bodyOf(p: Proposal): string {
  return [
    p.purpose,
    '',
    PROPOSED_NOTICE,
    '',
    `**Use it when** ${p.when}`,
    '',
    `**Not when** ${p.notWhen}`,
    '',
    '**Example**',
    '```series',
    ...p.example,
    '```',
    '',
    `**What failed** ${p.failed} Seen in: ${citeLine(p.cites)}.`,
    '',
    '**Score** Not measured yet.',
  ].join('\n');
}

const titleOf = (p: Proposal): string => `${PROPOSED_PREFIX} ${p.title}`;

async function problemsOf(p: Proposal, existing: ReadonlySet<string>): Promise<string[]> {
  const problems = lintTechnique(titleOf(p), p.summary, p.reason, bodyOf(p));
  if (p.cites.length < 2) problems.push('it cites fewer than two findings');
  if (new Set(p.cites.map((c) => `${c.log}#${c.turn}`)).size < 2) problems.push('its findings are not from two different turns');
  if (existing.has(titleOf(p).toLowerCase()) || existing.has(p.title.toLowerCase())) problems.push(`a technique titled "${p.title}" already exists`);
  if (p.example.length > 0) {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
    try {
      const file = join(dir, 'proposal.series');
      writeFileSync(file, `${p.example.join('\n')}\n`);
      const result = await run('pnpm', ['--silent', 'timeline', file], repo);
      if (result.code !== 0) problems.push(`pnpm timeline fails on its example: ${result.output.split('\n').filter((l) => /REJECTED|DROPPED|ROUND|error|reject|warn/i.test(l) || l.startsWith('      ')).slice(0, 4).join(' | ')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return problems;
}

// ---------- main ----------

async function main(): Promise<void> {
  const seedDir = join(repo, 'techniques', 'seed');
  const proposedDir = join(repo, 'techniques', 'proposed');

  const all = readFindings();
  const seen = argv.includes('--all') ? new Set<string>() : readCursor();
  const fresh = all.filter((f) => !seen.has(f.key)).slice(-MAX_FINDINGS);
  out(`${write ? 'WRITE' : 'dry run (nothing is written)'}: ${all.length} findings in ${root}, ${fresh.length} since the last run`);
  if (fresh.length < 2) {
    out('too few new findings to see a recurrence; nothing to do');
    return;
  }
  fresh.forEach((f, i) => (f.id = `f${i + 1}`));

  const limit = AbortSignal.timeout(600_000);
  const existing = new Set<string>();
  for (const seed of readTechniqueDir(seedDir, 'seed')) existing.add(seed.title.trim().toLowerCase());
  for (const proposed of readTechniqueDir(proposedDir, 'seed')) existing.add(proposed.title.trim().toLowerCase());
  const language = (await run('pnpm', ['--silent', 'prompt'], repo)).output;
  const seedExample = readFileSync(join(seedDir, 'flow-process.md'), 'utf8');
  const system = systemPrompt(language, seedExample, [...existing].filter((t) => !t.startsWith(PROPOSED_PREFIX.toLowerCase())).slice(0, 80));

  // The lessons are the first thing to stand down when the hour's spending nears the cap (USAGE_HOURLY_CAP). `--force` is the owner's word.
  const hour = throttleOf(dataFolders.usage, capFromEnv(process.env));
  const level = hour.state(Date.now());
  if ((level === 'near' || level === 'over') && !argv.includes('--force')) {
    fail(`the last hour has used $${hour.spentLastHour(Date.now()).toFixed(2)} of the $${String(hour.capUsd)} an hour set (USAGE_HOURLY_CAP): lessons stand down first. Run it later, or with --force`);
  }
  let asked = await askObject(system, requestText(fresh), [], SETTINGS, limit);
  if (asked.object === null) fail(`the model gave no answer I can read (${asked.failure ?? asked.reply.slice(0, 200)})`);
  let { proposals, bugs } = readReply(asked.object ?? {}, fresh);
  let cost = asked.cost ?? 0;
  let usage: JudgeUsage = asked.usage;

  // One repair round: the model is shown what its example or text did wrong.
  const verdicts = await Promise.all(proposals.map((p) => problemsOf(p, existing)));
  if (verdicts.some((v) => v.length > 0)) {
    const notes = proposals.map((p, i) => `${p.title}: ${(verdicts[i] ?? []).length === 0 ? 'ok' : (verdicts[i] ?? []).join('; ')}`).join('\n');
    asked = await askObject(system, `${requestText(fresh)}\n\nYour earlier answer:\n${JSON.stringify(asked.object)}\n\nChecks on its proposals:\n${notes}\n\nReply again, in the same JSON shape, with the failing proposals fixed (or dropped).`, [], SETTINGS, limit);
    cost += asked.cost ?? 0;
    usage = addUsage(usage, asked.usage);
    if (asked.object !== null) ({ proposals, bugs } = readReply(asked.object, fresh));
  }
  const finalVerdicts = await Promise.all(proposals.map((p) => problemsOf(p, existing)));
  const good = proposals.filter((_, i) => (finalVerdicts[i] ?? []).length === 0);
  out(`model: sonnet, effort low, cost about $${cost.toFixed(3)}`);
  out(`usage: ${JSON.stringify(usage)}`);

  out(`\n=== PROPOSALS (${good.length} of ${proposals.length} drafted pass lint and pnpm timeline) ===`);
  proposals.forEach((p, i) => {
    const problems = finalVerdicts[i] ?? [];
    if (problems.length > 0) out(`\n[dropped] ${p.title}\n${problems.map((x) => `   - ${x}`).join('\n')}`);
  });
  for (const p of good) {
    out(`\n# ${titleOf(p)}\nsummary: ${p.summary}\nreason: ${p.reason}\n\n${bodyOf(p)}\n\ncited: ${citeLine(p.cites)}`);
  }

  out('\n=== PAINTER BUGS (for the steward: loop/queue/painter-bugs.md) ===');
  if (bugs.length === 0) out('(none)');
  for (const b of bugs) out(`- ${b.what}  [${citeLine(b.cites)}]`);

  out(`\n=== ${write ? `FILES WRITTEN to ${proposedDir}` : 'FILES (written by --write)'} ===`);
  let wrote = 0;
  for (const p of good) {
    if (!write) continue;
    const result = writeProposedFile(proposedDir, { title: titleOf(p), summary: p.summary, reason: p.reason, markdown: bodyOf(p) });
    out(`${result.written ? 'written' : 'already there'}: ${result.path}`);
    if (result.written) wrote += 1;
  }
  if (!write) {
    if (good.length === 0) out('(no proposal to write)');
    out('\ndry run complete: nothing was written; --write puts each proposal in techniques/proposed/');
    return;
  }
  mkdirSync(queueDir, { recursive: true });
  appendFileSync(join(queueDir, 'lessons-usage.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), kind: 'lessons', findings: fresh.length, usage })}\n`);
  if (bugs.length > 0) {
    const header = existsSync(bugsPath) ? '' : '# Painter bugs the critic found\n\nProblems the brain did not cause: for the steward. One line each, with the log and turn it was seen in.\n\n';
    appendFileSync(bugsPath, `${header}${bugs.map((b) => `- ${b.what}  [${citeLine(b.cites)}]\n`).join('')}`);
    out(`\npainter bugs appended to ${bugsPath}`);
  }
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(cursorPath, `${JSON.stringify({ seen: [...seen, ...fresh.map((f) => f.key)] })}\n`);
  out(`cursor moved past ${fresh.length} findings; ${wrote} proposal(s) written`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
