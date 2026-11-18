// A pass-through for `claude`, used by `stream-probe.ts` as CLAUDE_BIN: it runs the real CLI with the arguments it was given and writes every line the CLI prints
// to $TAP_FILE (one JSON object per line: kind, the time in ms since the epoch the line reached this process, and the line), unchanged on its way to the server.
// $TAP_REAL names the real CLI (default `claude`). Plain Node, no dependencies; it adds one pipe hop, which measured under a millisecond.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const file = process.env.TAP_FILE ?? '/dev/null';
const note = (record) => appendFileSync(file, `${JSON.stringify(record)}\n`);
const child = spawn(process.env.TAP_REAL ?? 'claude', process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
note({ kind: 'start', t: Date.now(), argv: process.argv.slice(2).map((arg) => (arg.length > 120 ? `${arg.slice(0, 60)}...(${arg.length} characters)` : arg)) });

process.stdin.on('data', (chunk) => {
  if (chunk.toString().includes('"type":"user"')) note({ kind: 'in', t: Date.now() });
  child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());

let pending = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  const t = Date.now();
  process.stdout.write(chunk);
  pending += chunk;
  for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
    const line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    if (line.trim() !== '') note({ kind: 'out', t, line });
  }
});
child.on('close', (code) => process.exit(code ?? 1));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
