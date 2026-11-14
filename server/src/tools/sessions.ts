// Reads session logs back. Not part of the server.
// Usage: pnpm sessions [--data <dir>]  lists the log files (in <DATA_DIR>/logs, newest first), with turns and total cost
//        pnpm sessions <file|session>  prints that conversation turn by turn: what the user did, what was shown
//                                      (struck text marked, drawn things in brackets), rejects, and one line of
//                                      numbers per turn: first line ms, first shown ms, total ms, output tokens
//                                      (thinking in brackets), cache read share, cost
//        pnpm sessions <file> --lines  the same with every brain line
//        pnpm sessions <file> --csv    one row per turn, for a spreadsheet
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ShownItem, TurnInput } from '@conduit/language';
import type { SessionRecord } from '../domain/session-log';
import { withDataFlag } from '../data-dir';
import { processEnvironment, resolveLogDir } from '../env';

type Of<T extends SessionRecord['type']> = Extract<SessionRecord, { type: T }>;

interface Turn {
  readonly open: Of<'turn'>;
  readonly briefs: Of<'brief'>[];
  readonly lines: Of<'line'>[];
  readonly rejects: Of<'reject'>[];
  readonly paints: Of<'paint'>[];
  readonly fetches: Of<'fetch'>[];
  readonly taps: Of<'tap'>[];
  readonly usages: Of<'usage'>[];
  readonly passes: Of<'pass'>[];
  readonly techniques: Of<'techniques'>[];
  readonly drafts: Of<'draft'>[];
  readonly data: Of<'data'>[];
  readonly controls: Of<'control'>[];
  readonly fixes: Of<'fix'>[];
  readonly critics: Of<'critic'>[];
  readonly activities: Of<'activity'>[];
  readonly permissions: Of<'permission'>[];
  readonly uploads: Of<'upload'>[];
  review: Of<'review'> | null;
  end: Of<'end'> | null;
  usage: Of<'usage'> | null;
  started: Of<'started'> | null;
  report: Of<'report'> | null;
  snapshot: Of<'snapshot'> | null;
}

interface Conversation {
  readonly file: string;
  readonly session: Of<'session'> | null;
  readonly turns: Turn[];
  readonly looseTaps: Of<'tap'>[];
  /** settings changed and pictures given, each with the turn it came before (null: after the last) */
  readonly loose: { readonly record: Of<'setting'> | Of<'upload'>; readonly before: string | null }[];
  readonly records: number;
}

function usageError(message: string): never {
  process.stderr.write(`sessions: ${message}\n`);
  process.exit(2);
}

function logFolder(): string {
  const dir = resolveLogDir(withDataFlag(process.argv.slice(2), processEnvironment()));
  if (dir === null) usageError('LOG_DIR=off: no logs are written');
  return dir;
}

async function files(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.jsonl')).sort().reverse();
}

async function load(file: string): Promise<Conversation> {
  const records: SessionRecord[] = [];
  for (const raw of (await readFile(file, 'utf8')).split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const record = JSON.parse(raw) as SessionRecord;
      if (typeof record.type === 'string' && typeof record.at === 'number') records.push(record);
    } catch {
      // A line cut short by a kill: the rest of the file is still good.
    }
  }
  let session: Of<'session'> | null = null;
  const turns = new Map<string, Turn>();
  const looseTaps: Of<'tap'>[] = [];
  const loose: { record: Of<'setting'> | Of<'upload'>; before: string | null }[] = [];
  const nextTurnAfter = (at: number): string | null => records.find((r): r is Of<'turn'> => r.type === 'turn' && r.at >= at)?.turn ?? null;
  for (const record of records) {
    if (record.type === 'session') {
      session = record;
    } else if (record.type === 'turn') {
      turns.set(record.turn, { open: record, briefs: [], lines: [], rejects: [], paints: [], fetches: [], taps: [], usages: [], passes: [], techniques: [], drafts: [], data: [], controls: [], fixes: [], critics: [], activities: [], permissions: [], uploads: [], review: null, end: null, usage: null, started: null, report: null, snapshot: null });
    } else if (record.type === 'tap') {
      const turn = record.turn === null ? undefined : turns.get(record.turn);
      if (turn === undefined) looseTaps.push(record);
      else turn.taps.push(record);
    } else if (record.type === 'setting' || (record.type === 'upload' && record.turn === null)) {
      loose.push({ record, before: nextTurnAfter(record.at) });
    } else if (record.turn === null) {
      continue;
    } else {
      const turn = turns.get(record.turn);
      if (turn === undefined) continue;
      if (record.type === 'brief') turn.briefs.push(record);
      else if (record.type === 'line') turn.lines.push(record);
      else if (record.type === 'reject') turn.rejects.push(record);
      else if (record.type === 'paint') turn.paints.push(record);
      else if (record.type === 'fetch') turn.fetches.push(record);
      else if (record.type === 'end') turn.end = record;
      else if (record.type === 'usage') {
        turn.usage ??= record;
        turn.usages.push(record);
      } else if (record.type === 'pass') turn.passes.push(record);
      else if (record.type === 'techniques') turn.techniques.push(record);
      else if (record.type === 'draft') turn.drafts.push(record);
      else if (record.type === 'data') turn.data.push(record);
      else if (record.type === 'control') turn.controls.push(record);
      else if (record.type === 'fix') turn.fixes.push(record);
      else if (record.type === 'critic') turn.critics.push(record);
      else if (record.type === 'activity') turn.activities.push(record);
      else if (record.type === 'permission') turn.permissions.push(record);
      else if (record.type === 'upload') turn.uploads.push(record);
      else if (record.type === 'review') turn.review = record;
      else if (record.type === 'started') turn.started = record;
      else if (record.type === 'report') turn.report = record;
      else if (record.type === 'snapshot') turn.snapshot = record;
    }
  }
  return { file, session, turns: [...turns.values()], looseTaps, loose, records: records.length };
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `$${value.toFixed(4)}`;
}

function costOf(conversation: Conversation): number {
  let total = 0;
  for (const turn of conversation.turns) {
    for (const usage of turn.usages) total += usage.usage.costUsd ?? 0;
    for (const paint of turn.paints) total += paint.costUsd ?? 0;
  }
  return total;
}

function inputText(input: TurnInput): string {
  if (input.kind === 'prompt') return `typed: ${JSON.stringify(input.text)}${(input.images?.length ?? 0) > 0 ? ` with photos ${(input.images ?? []).join(', ')}` : ''}${input.marks === undefined ? '' : ` with ink (${input.marks.strokes.length} strokes, ${input.marks.image})`}`;
  if (input.kind === 'tap') return `tapped: ${JSON.stringify(input.text)} (${input.id})`;
  if (input.kind === 'demo') return `demo: ${input.script}`;
  if (input.kind === 'act') return `worked control ${input.id}: ${JSON.stringify(input.text)}`;
  if (input.kind === 'refine') return `asked to keep making it better, up to ${input.passes} passes`;
  return `script of ${input.text.split('\n').length} lines (${input.text.length} characters)`;
}

function shownText(item: ShownItem): string {
  const partial = item.partial ? ' (partly)' : '';
  if (item.kind === 'text') return item.struck ? `~${item.text}~${partial}` : `${item.text}${partial}`;
  return `[${item.id}: ${item.text}]${item.struck ? ' (struck)' : ''}${partial}`;
}

function ms(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)}ms`;
}

function numbersOf(turn: Turn): { firstLine: number | null; firstShown: number | null; total: number | null } {
  const first = turn.lines[0];
  return {
    firstLine: first === undefined ? null : first.at - turn.open.at,
    firstShown: turn.started === null ? null : turn.started.at - turn.open.at,
    total: turn.end === null ? null : turn.end.at - turn.open.at,
  };
}

function cacheShare(turn: Turn): number | null {
  const usage = turn.usage?.usage;
  if (usage === undefined) return null;
  const read = usage.cacheReadTokens ?? 0;
  const all = (usage.inputTokens ?? 0) + read + (usage.cacheWriteTokens ?? 0);
  return all === 0 ? null : read / all;
}

function tokensText(turn: Turn): string {
  const usage = turn.usage?.usage;
  if (usage === undefined || usage.outputTokens === null) return '-';
  return usage.thinkingTokens === null ? String(usage.outputTokens) : `${usage.outputTokens} (${usage.thinkingTokens})`;
}

function printTurn(turn: Turn, withLines: boolean): void {
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  const reason = turn.end === null ? 'no end recorded' : turn.end.reason + (turn.end.message === null ? '' : `: ${turn.end.message}`);
  out(`${turn.open.turn}  ${inputText(turn.open.input)}  [${turn.open.brain}; ${reason}]`);
  for (const tap of turn.taps) out(`  tap at ${(tap.at - turn.open.at) / 1000}s: ${JSON.stringify(tap.text)} (${tap.id})`);
  const report = turn.report?.report;
  if (report === undefined) {
    out(`  shown: no report from the painter (${turn.lines.length} lines written)`);
  } else {
    out(`  shown (${report.outcome}, playhead ${report.playhead.toFixed(1)}s${report.skippedAt === null ? '' : `, show-all at ${report.skippedAt.toFixed(1)}s`}):`);
    for (const item of report.shown) out(`    ${shownText(item)}`);
    const noted = report.sight.items.filter((item) => item.notes.length > 0);
    for (const item of noted) out(`    sight: ${item.id} (${item.kind}): ${item.notes.join(', ')}`);
  }
  for (const reject of turn.rejects) out(`  rejected: ${reject.raw.trim()}  -- ${reject.issues.map((issue) => issue.message).join('; ')}`);
  const warned = turn.lines.filter((line) => line.issues.some((issue) => issue.severity === 'warn'));
  for (const line of warned) out(`  warned: ${line.text}  -- ${line.issues.map((issue) => issue.message).join('; ')}`);
  for (const fetch of turn.fetches) out(`  fetch ${fetch.url}${fetch.finalUrl === null || fetch.finalUrl === fetch.url ? '' : ` -> ${fetch.finalUrl}`}: ${fetch.outcome}${fetch.status === null ? '' : ` ${fetch.status}`}, ${fetch.contentType ?? 'no type'}, ${fetch.bytes} bytes, ${fetch.ms}ms${fetch.reason === null ? '' : ` (${fetch.reason})`}`);
  for (const record of turn.techniques) out(`  techniques handed over: ${record.ids.join(', ')}`);
  for (const control of turn.controls) out(`  control at ${((control.at - turn.open.at) / 1000).toFixed(1)}s: ${control.id} = ${JSON.stringify(control.value)}${control.send ? ' (sent)' : ''}`);
  for (const data of turn.data) out(`  data ${data.id} (${data.source}, ${data.rows} rows): ${data.status}${data.reason === null ? '' : ` (${data.reason})`}`);
  for (const pass of turn.passes) out(`  pass ${pass.pass} ${pass.state} at ${((pass.at - turn.open.at) / 1000).toFixed(1)}s${pass.reason === null ? '' : `: ${pass.reason}`}`);
  for (const draft of turn.drafts) if (draft.file !== null || draft.noted > 0) out(`  draft ${draft.pass}: ${draft.noted} noted${draft.file === null ? '' : `, picture ${draft.file}`}`);
  if (turn.review !== null) {
    const r = turn.review;
    out(`  look and fix: ${r.outcome.result}, ${r.outcome.passes} pass${r.outcome.passes === 1 ? '' : 'es'}${r.outcome.why === null ? '' : ` (${r.outcome.why})`}; first line of fix ${ms(r.firstLineMs)}, total ${ms(r.totalMs)}, cost ${money(r.costUsd)}`);
  }
  for (const fix of turn.fixes) out(`  fix pass ${fix.pass} (${fix.form}) at ${((fix.at - turn.open.at) / 1000).toFixed(1)}s: ${fix.shown ? 'shown' : `refused${fix.why === null ? '' : ` (${fix.why})`}`}, ${fix.lines.length} line${fix.lines.length === 1 ? '' : 's'}`);
  for (const critic of turn.critics) {
    const f = critic.finding;
    out(`  critic at ${((critic.at - turn.open.at) / 1000).toFixed(1)}s: coherence ${f.coherence}/5, ${f.readable ? 'readable' : 'NOT readable'}, ${f.asked ? 'as asked' : 'NOT as asked'}${critic.queued ? ', queued for the loop' : ''} (${ms(f.ms)}, ${money(f.costUsd)}${f.usage === undefined ? '' : `, ${f.usage.inputTokens + f.usage.cacheReadTokens + f.usage.cacheWriteTokens} in / ${f.usage.outputTokens} out tokens`})`);
    for (const problem of f.problems) out(`    ${problem.weight}${problem.id === null ? '' : ` [${problem.id}]`}: ${problem.what}`);
    for (const suggestion of f.suggestions) out(`    suggest: ${suggestion}`);
  }
  for (const activity of turn.activities) if (activity.state !== 'running') out(`  tool ${activity.tool} ${activity.state}${activity.ms === null ? '' : ` in ${activity.ms}ms`}: ${activity.summary}`);
  for (const permission of turn.permissions) out(`  permission (${permission.risk}) ${permission.tool}: ${permission.summary} -> ${permission.allow === null ? 'no answer (denied)' : permission.allow ? 'allowed' : 'denied'} after ${ms(permission.ms)}`);
  for (const upload of turn.uploads) out(`  upload ${upload.id}: ${upload.mime}, ${upload.bytes} bytes, ${upload.width}x${upload.height}`);
  for (const paint of turn.paints) out(`  painting ${paint.key}: ${paint.status} in ${paint.ms}ms${paint.costUsd === null ? '' : `, ${money(paint.costUsd)}`}${paint.reason === null ? '' : ` (${paint.reason})`}`);
  if (turn.snapshot !== null) out(`  snapshot: ${turn.snapshot.file}`);
  if (withLines) for (const line of turn.lines) out(`  line ${line.seq}${line.pass !== undefined && line.pass > 1 ? ` (pass ${line.pass})` : ''} @${line.start.toFixed(2)}s  ${line.text}`);
  const n = numbersOf(turn);
  const share = cacheShare(turn);
  out(
    `  first line ${ms(n.firstLine)}, first shown ${ms(n.firstShown)}, total ${ms(n.total)}, output tokens ${tokensText(turn)}, cache read ${share === null ? '-' : `${Math.round(share * 100)}%`}, cost ${money(turn.usages.length === 0 ? null : turn.usages.reduce((sum, u) => sum + (u.usage.costUsd ?? 0), 0))}`,
  );
  out('');
}

async function list(dir: string): Promise<void> {
  const names = await files(dir);
  if (names.length === 0) {
    process.stdout.write(`no session logs in ${dir}\n`);
    return;
  }
  const rows: string[][] = [['file', 'brain', 'turns', 'cost']];
  for (const name of names) {
    const conversation = await load(join(dir, name));
    rows.push([name, conversation.session?.brain ?? '-', String(conversation.turns.length), money(costOf(conversation))]);
  }
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  for (const row of rows) process.stdout.write(`${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()}\n`);
}

async function resolveFile(dir: string, what: string): Promise<string> {
  if (existsSync(what) && (await stat(what)).isFile()) return resolve(what);
  const names = await files(dir);
  const found = names.find((name) => name === what || name === basename(what) || name.endsWith(`-${what}.jsonl`) || name.startsWith(what));
  if (found === undefined) usageError(`no session log matches "${what}" in ${dir}`);
  return join(dir, found);
}

function csv(conversation: Conversation): void {
  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const out = ['turn,input,end,first_line_ms,first_shown_ms,total_ms,output_tokens,thinking_tokens,cache_read_share,cost_usd,rejects'];
  for (const turn of conversation.turns) {
    const n = numbersOf(turn);
    const usage = turn.usage?.usage;
    out.push(
      [
        turn.open.turn,
        quote(inputText(turn.open.input)),
        turn.end?.reason ?? '',
        n.firstLine ?? '',
        n.firstShown ?? '',
        n.total ?? '',
        usage?.outputTokens ?? '',
        usage?.thinkingTokens ?? '',
        cacheShare(turn)?.toFixed(3) ?? '',
        usage?.costUsd ?? '',
        turn.rejects.length,
      ].join(','),
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // `--data <dir>` names another data folder; its value is not a log to look for
  const dataAt = args.indexOf('--data');
  const rest = dataAt < 0 ? args : args.filter((_, index) => index !== dataAt && index !== dataAt + 1);
  const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
  for (const flag of flags) if (flag !== '--lines' && flag !== '--csv') usageError(`unknown flag ${flag}`);
  const what = rest.find((arg) => !arg.startsWith('--'));
  const dir = logFolder();
  if (what === undefined) return list(dir);
  const conversation = await load(await resolveFile(dir, what));
  if (flags.has('--csv')) return csv(conversation);
  const session = conversation.session;
  process.stdout.write(`${basename(conversation.file)}  ${session === null ? '' : `${session.brain}, started ${session.started}, language ${session.language}, paint ${session.services.paint ? 'on' : 'off'}`}\n\n`);
  for (const tap of conversation.looseTaps) process.stdout.write(`tap: ${JSON.stringify(tap.text)} (${tap.id})\n`);
  const loose = (before: string | null): void => {
    for (const item of conversation.loose.filter((entry) => entry.before === before)) {
      const r = item.record;
      process.stdout.write(r.type === 'setting' ? `setting: ${r.name} = ${r.value}\n` : `upload ${r.id}: ${r.mime}, ${r.bytes} bytes${r.file === null ? '' : `, ${r.file}`}\n`);
    }
  };
  for (const turn of conversation.turns) {
    loose(turn.open.turn);
    printTurn(turn, flags.has('--lines'));
  }
  loose(null);
  process.stdout.write(`${conversation.turns.length} turns, ${conversation.records} records, cost ${money(costOf(conversation))}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`sessions: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
