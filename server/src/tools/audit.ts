// The audit trail, read back. Not part of the server.
// Usage: pnpm audit-log [--data <dir>] [--kind tool|permission_asked|permission_answered|setting|connector|kill|refused|upload|server]
//                       [--session <id>] [--login <login>] [--since <ISO time | 30m | 6h | 2d>] [--limit n] [--json]
//        (`pnpm run audit` is the same: a bare `pnpm audit` is pnpm's own check for vulnerable packages and never reaches this script.)
// Prints the newest entries first, one line each: time, who, kind, tool, target, what was decided and by whom.
import { readAudit } from '../audit';
import { resolveDataPaths } from '../env';
import { withDataFlag } from '../data-dir';

const argv = process.argv.slice(2);
const fail = (message: string): never => {
  process.stderr.write(`audit: ${message}\n`);
  return process.exit(2);
};
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? fail(`--${name} needs a value`) : value;
};
for (const arg of argv) if (arg.startsWith('--') && !['--data', '--from', '--kind', '--session', '--login', '--since', '--limit', '--json'].includes(arg)) fail(`unknown flag ${arg}`);

function sinceOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const relative = /^(\d+)([mhd])$/.exec(raw);
  if (relative !== null) return new Date(Date.now() - Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'm' | 'h' | 'd']).toISOString();
  if (Number.isNaN(Date.parse(raw))) return fail('--since is an ISO time or like 30m, 6h, 2d');
  return new Date(raw).toISOString();
}

const paths = resolveDataPaths(withDataFlag(argv, process.env));
const limit = Number(flag('limit') ?? 50);
if (!Number.isInteger(limit) || limit < 1) fail('--limit is a whole number from 1');
const kind = flag('kind');
const session = flag('session');
const login = flag('login');
const since = sinceOf(flag('since'));
const entries = readAudit(paths.audit, { limit, ...(kind === undefined ? {} : { kind }), ...(session === undefined ? {} : { session }), ...(login === undefined ? {} : { login }), ...(since === undefined ? {} : { since }) });
if (argv.includes('--json')) {
  for (const entry of entries) process.stdout.write(`${JSON.stringify(entry)}\n`);
} else if (entries.length === 0) {
  process.stdout.write(`nothing in ${paths.audit}\n`);
} else {
  for (const e of entries) {
    const where = [e.session, e.turn].filter((part) => part !== null).join('/');
    const decided = e.decision === null ? '' : `  ${e.decision}${e.decidedBy === null ? '' : ` by ${e.decidedBy}`}`;
    process.stdout.write(`${e.time.slice(0, 19).replace('T', ' ')}  ${e.login.padEnd(10)}  ${e.kind.padEnd(19)} ${(e.tool ?? '-').padEnd(12)} ${e.target ?? ''}${decided}${where === '' ? '' : `  [${where}]`}${e.note === undefined ? '' : `  (${e.note})`}\n`);
  }
}
