// The owner's "Report a problem" reports, read back. Not part of the server.
// Usage: pnpm reports [--data <dir>]            lists the reports, newest first: id, time, session, turn, the note's first line, how many events
//        pnpm reports show <id> [--data <dir>]  prints one in full (note, context, every event with how long before the report) and where its pictures are
//        (an id is a folder name in <DATA_DIR>/reports, or the start of one)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDataFlag } from '../data-dir';
import { resolveDataPaths } from '../env';

const argv = process.argv.slice(2);
const fail = (message: string): never => {
  process.stderr.write(`reports: ${message}\n`);
  return process.exit(2);
};
const paths = resolveDataPaths(withDataFlag(argv, process.env));
const args = argv.filter((arg, at) => !arg.startsWith('--') && argv[at - 1] !== '--data' && argv[at - 1] !== '--from');
const out = (text: string): void => void process.stdout.write(`${text}\n`);

interface Report {
  readonly id: string;
  readonly received: string;
  readonly session: string;
  readonly turn: string | null;
  readonly note: string;
  readonly context: Record<string, unknown>;
  readonly events: { readonly ago: number; readonly what: string; readonly detail?: Record<string, unknown> }[];
  readonly pictures: string[];
}

const folders = (): string[] => (existsSync(paths.reports) ? readdirSync(paths.reports).filter((name) => existsSync(join(paths.reports, name, 'report.json'))).sort().reverse() : []);
const read = (id: string): Report => JSON.parse(readFileSync(join(paths.reports, id, 'report.json'), 'utf8')) as Report;

if (args[0] === 'show') {
  const wanted = args[1];
  if (wanted === undefined) fail('show needs an id (see pnpm reports)');
  const hits = folders().filter((name) => name.startsWith(wanted ?? ''));
  if (hits.length !== 1) fail(hits.length === 0 ? `no report starts with ${wanted}` : `${hits.length} reports start with ${wanted}: ${hits.join(', ')}`);
  const id = hits[0] as string;
  const r = read(id);
  out(`report ${id}`);
  out(`received ${r.received}   session ${r.session}   turn ${r.turn ?? '-'}`);
  out(`\nnote:\n${r.note === '' ? '(none)' : r.note}`);
  out(`\ncontext:\n${JSON.stringify(r.context, null, 2)}`);
  out(`\nevents (${r.events.length}, oldest first; "ago" is seconds before the report):`);
  for (const e of r.events) out(`  -${(e.ago / 1000).toFixed(1).padStart(5)}s  ${e.what}${e.detail === undefined ? '' : `  ${Object.entries(e.detail).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`).join(' ')}`}`);
  out('\npictures:');
  for (const name of r.pictures) out(`  ${join(paths.reports, id, name)}`);
  if (r.pictures.length === 0) out('  (none)');
} else if (args.length > 0) {
  fail(`unknown command ${args[0]}; usage: pnpm reports [show <id>] [--data <dir>]`);
} else {
  const names = folders();
  if (names.length === 0) out(`no reports in ${paths.reports}`);
  for (const id of names) {
    const r = read(id);
    const first = r.note.split('\n')[0]?.trim() ?? '';
    out(`${id}  ${r.received.slice(0, 19).replace('T', ' ')}  session ${r.session}  turn ${r.turn ?? '-'}  ${String(r.events.length).padStart(3)} events  ${first === '' ? '(no note)' : first.slice(0, 80)}`);
  }
}
