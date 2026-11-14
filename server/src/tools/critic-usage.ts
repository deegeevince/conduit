// What the live critic costs. Not part of the server.
// Usage: pnpm critic-usage [--data <dir>]    critic looks, tokens and cost, per hour and per session, from `<DATA_DIR>/logs/*.jsonl` (the `critic`
//                                            records' `finding.usage`), plus `pnpm lessons --write` calls from <DATA_DIR>/loop/queue/lessons-usage.jsonl.
//                                            A look logged before usage was recorded counts as a look with no tokens (its cost, if it has one, is kept).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataPaths, resolveDataDir, withDataFlag } from '../data-dir';

const argv = process.argv.slice(2);
// The data folder (`--data <dir>`, or its older spelling `--from <dir>`, then DATA_DIR, then the default): it holds `logs/` and `loop/queue/`.
const root = resolve(resolveDataDir(withDataFlag(argv, process.env)));
const paths = dataPaths(root);

interface Total {
  looks: number;
  unmetered: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  cost: number;
  ms: number;
}
interface Counted {
  usage?: Record<string, unknown>;
  costUsd?: unknown;
  ms?: unknown;
}
const blank = (): Total => ({ looks: 0, unmetered: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0, cost: 0, ms: 0 });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function add(total: Total, finding: Counted): void {
  total.looks += 1;
  const u = finding.usage;
  if (u === undefined) {
    total.unmetered += 1;
    total.cost += num(finding.costUsd);
    total.ms += num(finding.ms);
    return;
  }
  total.input += num(u['inputTokens']);
  total.cacheRead += num(u['cacheReadTokens']);
  total.cacheWrite += num(u['cacheWriteTokens']);
  total.output += num(u['outputTokens']);
  total.thinking += num(u['thinkingTokens']);
  total.cost += num(u['costUsd']);
  total.ms += num(u['ms']);
}

const line = (label: string, t: Total, unit = 'looks'): string =>
  `${label.padEnd(24)} ${String(t.looks).padStart(4)} ${unit}  in ${String(t.input).padStart(7)}  cache r/w ${String(t.cacheRead).padStart(8)}/${String(t.cacheWrite).padStart(7)}  out ${String(t.output).padStart(6)} (thinking ${t.thinking})  $${t.cost.toFixed(3)}${t.unmetered > 0 ? `  [${t.unmetered} before usage was recorded]` : ''}`;

const bySession = new Map<string, Total>();
const byHour = new Map<string, Total>();
const all = blank();
const bump = (map: Map<string, Total>, key: string, finding: Counted): void => {
  const total = map.get(key) ?? blank();
  map.set(key, total);
  add(total, finding);
};

const logs = paths.logs;
if (existsSync(logs)) {
  for (const name of readdirSync(logs).filter((n) => n.endsWith('.jsonl')).sort()) {
    let started = 0;
    for (const raw of readFileSync(join(logs, name), 'utf8').split('\n')) {
      if (!raw.includes('"session"') && !raw.includes('"critic"')) continue;
      try {
        const r = JSON.parse(raw) as { type?: string; at?: number; started?: string; finding?: Counted };
        if (r.type === 'session' && typeof r.started === 'string') started = Date.parse(r.started);
        if (r.type !== 'critic' || r.finding === undefined) continue;
        const hour = new Date(started + num(r.at)).toISOString().slice(0, 13);
        add(all, r.finding);
        bump(bySession, name.replace(/\.jsonl$/, ''), r.finding);
        bump(byHour, `${hour}:00Z`, r.finding);
      } catch {
        // a torn line
      }
    }
  }
}
process.stdout.write(`${line('all critic looks', all)}\n\nper hour\n`);
for (const [k, t] of [...byHour].sort()) process.stdout.write(`  ${line(k, t)}\n`);
process.stdout.write('\nper session\n');
for (const [k, t] of [...bySession].sort()) process.stdout.write(`  ${line(k, t)}\n`);
const lessons = join(paths.queue, 'lessons-usage.jsonl');
if (existsSync(lessons)) {
  const t = blank();
  for (const raw of readFileSync(lessons, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      add(t, { usage: (JSON.parse(raw) as { usage?: Record<string, unknown> }).usage ?? {} });
    } catch {
      // skipped
    }
  }
  process.stdout.write(`\n${line('pnpm lessons --write', t, 'runs ')}\n`);
}
