// "How it was made", in words. Pure: a `TurnTrace` in, the one quiet line under a reply and the timeline behind it out. No DOM here.

import type { ActivityState, PassState, TurnTrace } from '@conduit/language';

/** "420 ms", "3.2 s", "14 s", "2 min 5 s" */
export function span(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** `mcp__claude-in-chrome__read_page` is the tool `read page` of `chrome`; any other name is shown as it is */
export function toolName(tool: string): { readonly server: string | null; readonly name: string } {
  const found = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (found?.[1] === undefined || found[2] === undefined) return { server: null, name: tool };
  return { server: found[1].replace(/^claude-in-/, ''), name: found[2].replace(/_/g, ' ') };
}

export function toolLabel(tool: string): string {
  const { server, name } = toolName(tool);
  return server === null ? name : `${server}: ${name}`;
}

const STATE_WORDS: Readonly<Record<ActivityState, string>> = { running: 'running', done: 'done', failed: 'failed', waiting: 'waiting for you', denied: 'not allowed' };

const PASS_WORDS: Readonly<Record<PassState, string>> = {
  drafted: 'Draft finished, sent to be looked at',
  looking: 'Looking at its draft',
  fixing: 'Fixing: the first line of the fix arrived',
  kept: 'Looked and changed nothing',
  skipped: 'Not looked at',
  staged: 'Fix written, being tried out of sight',
  refused: 'Fix thrown away, the draft stands',
  refining: 'Making it better',
};

/** the critic's verdict in two or three words, and whether it is an alarm */
export function criticVerdict(critic: NonNullable<TurnTrace['critic']>): { readonly text: string; readonly alarm: boolean } {
  const blocks = critic.problems.some((problem) => problem.weight === 'blocks');
  if (critic.readable && critic.asked && critic.coherence >= 4 && !blocks) return { text: 'ok', alarm: false };
  if (blocks) return { text: plural(critic.problems.length, 'problem'), alarm: true };
  return { text: `${critic.coherence} of 5`, alarm: critic.coherence <= 2 || !critic.readable || !critic.asked };
}

/** what is going on, in a few words, for a reply still being made: null once it has ended */
export function phaseOf(trace: TurnTrace): string | null {
  if (trace.end !== null) return null;
  const running = [...trace.tools].reverse().find((tool) => tool.state === 'running' || tool.state === 'waiting');
  if (running !== undefined) return running.state === 'waiting' ? `waiting for you: ${toolLabel(running.tool)}` : `using ${toolLabel(running.tool)}${running.summary === '' ? '' : `: ${running.summary}`}`;
  const lastPass = trace.passes[trace.passes.length - 1];
  const lines = trace.lines.length;
  if (lastPass !== undefined) {
    if (lastPass.state === 'looking') return 'looking at its draft';
    if (lastPass.state === 'fixing' || lastPass.state === 'refining') return 'fixing';
    if (lastPass.state === 'staged') return 'trying a fix out of sight';
    if (lastPass.state === 'drafted') return 'checking its draft';
  }
  if (lines > 0) return `drawing… ${plural(lines, 'line')}`;
  const reading = trace.readings[trace.readings.length - 1];
  if (reading?.state === 'start') return `reading ${reading.label}`;
  return 'thinking…';
}

/** the part of the phase that changes the screen reader's mind: not counts, not times */
export function phaseKind(trace: TurnTrace): string {
  const phase = phaseOf(trace);
  if (phase === null) return 'done';
  return phase.replace(/… .*$/, '…').replace(/^(using [^:]+).*$/, '$1').replace(/^(waiting for you).*$/, '$1');
}

function once(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** The collapsed line. `elapsed` is what the clock says while the reply is being made. */
export function summaryLine(trace: TurnTrace, elapsed: number | null): string {
  const phase = phaseOf(trace);
  if (phase !== null) return `${phase.charAt(0).toUpperCase()}${phase.slice(1)}${elapsed === null ? '' : ` · ${span(elapsed)}`}`;
  const took = trace.end?.at ?? trace.usage.reduce((sum, row) => sum + row.totalMs, 0);
  const reason = trace.end?.reason ?? 'done';
  const parts: string[] = [reason === 'failed' || reason === 'timeout' ? `Stopped after ${span(took)}` : reason === 'interrupted' ? `Interrupted after ${span(took)}` : `Worked ${span(took)}`];
  if (trace.lines.length > 0) parts.push(plural(trace.lines.length, 'line'));
  if (trace.tools.length > 0) parts.push(plural(trace.tools.length, 'tool'));
  const looked = trace.passes.filter((pass) => pass.state === 'looking').length;
  if (looked > 0) {
    const fixedLines = trace.lines.filter((line) => line.pass > 1).length;
    const refused = trace.passes.some((pass) => pass.state === 'refused');
    parts.push(`looked ${once(looked)}, ${fixedLines > 0 ? `fixed ${fixedLines}` : refused ? 'fix not used' : 'kept it'}`);
  }
  if (trace.rejects.length > 0) parts.push(`${trace.rejects.length} dropped`);
  if (trace.critic !== null) parts.push(`critic ${criticVerdict(trace.critic).text}`);
  return parts.join(' · ');
}

export interface Entry {
  readonly key: string;
  /** ms from the turn's opening; null for the entries that belong to the whole turn */
  readonly at: number | null;
  readonly title: string;
  readonly detail?: string;
  /** a line of Series, shown in monospace */
  readonly raw?: string;
  /** more than a few words of lines, behind a toggle */
  readonly lines?: { readonly label: string; readonly text: string };
  readonly tone?: 'plain' | 'alarm' | 'quiet';
}

/** `say`, `circle`, … : a line's verb is its first word */
function verbOf(text: string): string {
  return /^\S+/.exec(text)?.[0] ?? '·';
}

export function verbCounts(lines: readonly { readonly text: string }[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(verbOf(line.text), (counts.get(verbOf(line.text)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([verb, n]) => `${verb} ${n}`).join(', ');
}

const tokens = (n: number | null): string => (n === null ? 'unknown' : n.toLocaleString('en-US'));
const dollars = (n: number | null): string => (n === null ? 'unknown' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** The timeline, in the order it happened, brain first and the totals last. */
export function timelineOf(trace: TurnTrace): Entry[] {
  const out: Entry[] = [];
  if (trace.brain !== null) {
    const { id, model, effort } = trace.brain;
    out.push({ key: 'brain', at: null, title: 'Brain', detail: `${model ?? 'model not recorded'}${effort === null ? '' : `, effort ${effort}`} (${id})` });
  }
  for (const [i, brief] of trace.briefs.entries()) {
    out.push({ key: `brief-${i}`, at: brief.at, title: brief.pass > 1 ? `Told the brain what it drew, to look` : 'Told the brain', detail: `a ${brief.form} brief, ${brief.chars.toLocaleString('en-US')} characters`, tone: 'quiet' });
  }
  for (const [i, reading] of trace.readings.entries()) {
    out.push({ key: `reading-${i}`, at: reading.at, title: reading.state === 'start' ? `Reading ${reading.label}` : reading.state === 'done' ? `Read ${reading.label}` : `Could not read ${reading.label}`, ...(reading.message === null ? {} : { detail: reading.message }), tone: reading.state === 'failed' ? 'alarm' : 'plain' });
  }
  const first = trace.lines[0];
  if (first !== undefined) out.push({ key: 'first', at: first.at, title: 'First line', raw: first.text });
  const passes = [...new Set(trace.lines.map((line) => line.pass))].sort((a, b) => a - b);
  for (const pass of passes) {
    const group = trace.lines.filter((line) => line.pass === pass);
    const head = group[0];
    const tail = group[group.length - 1];
    if (head === undefined || tail === undefined) continue;
    out.push({
      key: `lines-${pass}`,
      at: head.at,
      title: `${pass > 1 ? 'Fix lines' : 'Lines'}: ${group.length}`,
      detail: `${verbCounts(group)}${tail.at > head.at ? `; until ${span(tail.at)}` : ''}`,
      lines: { label: `${pass > 1 ? 'fix ' : ''}lines (${group.length})`, text: group.map((line) => line.text).join('\n') },
    });
  }
  for (const [i, reject] of trace.rejects.entries()) out.push({ key: `reject-${i}`, at: reject.at, title: 'Line dropped', detail: reject.why.length > 0 ? reject.why.join('; ') : 'it was not a usable line', raw: reject.raw, tone: 'quiet' });
  for (const tool of trace.tools) {
    out.push({
      key: `tool-${tool.id}`,
      at: tool.at,
      title: `Tool: ${toolLabel(tool.tool)}`,
      detail: `${tool.summary === '' ? '' : `${tool.summary} · `}${STATE_WORDS[tool.state]}${tool.ms === null ? '' : ` · ${span(tool.ms)}`}`,
      tone: tool.state === 'failed' || tool.state === 'denied' ? 'alarm' : 'plain',
    });
  }
  for (const [i, ask] of trace.asks.entries()) {
    out.push({ key: `ask-${i}`, at: ask.at, title: `Asked you: ${toolLabel(ask.tool)}`, detail: `${ask.summary} (${ask.risk}) · ${ask.allow === true ? 'you allowed it' : ask.allow === false ? 'you said no' : 'no answer'}`, tone: ask.allow === true ? 'plain' : 'alarm' });
  }
  for (const [i, pass] of trace.passes.entries()) {
    out.push({ key: `pass-${i}`, at: pass.at, title: `Look: ${PASS_WORDS[pass.state]}`, ...(pass.reason === null ? {} : { detail: pass.reason }), tone: pass.state === 'refused' || pass.state === 'skipped' ? 'quiet' : 'plain' });
  }
  for (const [i, fix] of trace.fixes.entries()) {
    out.push({
      key: `fix-${i}`,
      at: fix.at,
      title: `${fix.form === 'refine' ? 'Refinement' : 'Fix'} written: ${plural(fix.lines.length, 'line')}`,
      detail: `${fix.shown === null ? 'being weighed' : fix.shown ? 'shown' : 'not shown'}${fix.why === null ? '' : `: ${fix.why}`}`,
      ...(fix.lines.length > 0 ? { lines: { label: `fix candidate (${fix.lines.length})`, text: fix.lines.join('\n') } } : {}),
    });
  }
  if (trace.end !== null) {
    const { reason, message } = trace.end;
    out.push({ key: 'end', at: trace.end.at, title: reason === 'done' ? 'Finished' : reason === 'interrupted' ? 'Interrupted' : reason === 'timeout' ? 'Timed out' : 'Failed', ...(message === null ? {} : { detail: message }), tone: reason === 'failed' || reason === 'timeout' ? 'alarm' : 'plain' });
  }
  if (trace.critic !== null) {
    const verdict = criticVerdict(trace.critic);
    const worst = [...trace.critic.problems].sort((a, b) => ['blocks', 'hurts', 'polish'].indexOf(a.weight) - ['blocks', 'hurts', 'polish'].indexOf(b.weight));
    const bad = worst.slice(0, 3).map((problem) => `${problem.weight}: ${problem.what.replace(/\.$/, '')}`);
    if (worst.length > 3) bad.push(`and ${worst.length - 3} more`);
    out.push({
      key: 'critic',
      at: trace.critic.at,
      title: `Critic: ${verdict.text}`,
      detail: `coherence ${trace.critic.coherence} of 5, ${trace.critic.readable ? 'reads well' : 'hard to read'}, ${trace.critic.asked ? 'matches what you asked' : 'not what you asked'}${bad.length > 0 ? `. ${bad.join('. ')}.` : ''}`,
      tone: verdict.alarm ? 'alarm' : 'plain',
    });
  }
  const timed = out.filter((entry) => entry.at !== null);
  const whole = out.filter((entry) => entry.at === null);
  timed.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const result = [...whole, ...timed];
  for (const row of trace.usage) {
    result.push({
      key: `usage-${row.pass}`,
      at: null,
      title: trace.usage.length > 1 ? `Usage, ${row.pass > 1 ? `pass ${row.pass}` : 'draft'}` : 'Usage',
      detail: `input ${tokens(row.inputTokens)}, cache read ${tokens(row.cacheReadTokens)}${row.cacheWriteTokens === null ? '' : ` (written ${tokens(row.cacheWriteTokens)})`}, output ${tokens(row.outputTokens)}, thinking ${tokens(row.thinkingTokens)} · ${dollars(row.costUsd)} · ${span(row.totalMs)}`,
    });
  }
  if (trace.usage.length > 1) {
    const cost = trace.usage.reduce<number | null>((sum, row) => (row.costUsd === null ? sum : (sum ?? 0) + row.costUsd), null);
    result.push({ key: 'usage-total', at: null, title: 'Cost in all', detail: dollars(cost) });
  }
  if (trace.review !== null) result.push({ key: 'review', at: null, title: 'Look and fix', detail: `${trace.review.result}, ${plural(trace.review.passes, 'pass', 'passes')}${trace.review.why === null ? '' : `: ${trace.review.why}`}`, tone: 'quiet' });
  return result;
}
