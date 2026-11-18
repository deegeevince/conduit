// Times one real turn at every hop, so that "it arrived in one burst" can be told from "we held it back" (the burst probe of docs/technology.md, "Streaming").
//
//   pnpm stream-probe [--model opus] [--effort low|medium|high] [--thinking on|off] [--canvas on|off] [--agent on|off] [--claude <bin>] [--timeout 240] "Show me the main parts of a car"
//
// It starts this server (BRAIN=claude-cli, a throwaway DATA_DIR, a port from CHECK_PORTS or any free one) with `claude` replaced by `stream-tap.mjs`, which writes down the
// moment every line the CLI prints reached it; opens the session's event stream the way the page does and stamps every event as it arrives; asks for the turn with look-and-fix
// off; and prints two tables from the same clock: what the CLI printed, message by message (the model's thinking, a tool call's input as it is typed, the text), and what the
// page was sent (typing, then each line). ONE MODEL CALL on the owner's login (a few cents with opus); it stops its server and leaves nothing running.
//
// Reading it: a text message whose deltas all fall within a few hundred milliseconds, after seconds of silence, came out of the API in one piece (nothing of ours is in
// that gap: compare the CLI's "text" row with the page's first "line" row, which are milliseconds apart). A tool call's input, typed as the model writes it, is spread.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { API, FULL_CAPABILITIES, LOOK_IDS, REFERENCE_SCREEN } from '@conduit/language';
import { spawnTracked } from '../brains/claude-cli/process';
import { claimPort, releasePort } from './check-ports';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const flagValues = new Set(['--model', '--effort', '--thinking', '--canvas', '--agent', '--claude', '--timeout']);
const prompt = args.filter((arg, at) => !arg.startsWith('--') && !flagValues.has(args[at - 1] ?? '')).join(' ').trim();
if (prompt === '') {
  process.stderr.write('usage: stream-probe [--model opus] [--effort low|medium|high] [--thinking on|off] [--canvas on|off] [--agent on|off] [--claude <bin>] [--timeout 240] "a prompt"\n');
  process.exit(2);
}
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const here = import.meta.dirname;
const dir = mkdtempSync(join(tmpdir(), 'conduit-stream-probe-'));
const tapFile = join(dir, 'tap.jsonl');
const wrapper = join(dir, 'claude');
writeFileSync(wrapper, `#!/bin/sh\nTAP_FILE='${tapFile}' exec '${process.execPath}' '${join(here, 'stream-tap.mjs')}' "$@"\n`);
chmodSync(wrapper, 0o755);

const port = await claimPort('the stream probe');
const base = `http://127.0.0.1:${port}`;
const server = spawnTracked(resolve(here, '../../node_modules/.bin/tsx'), ['src/main.ts'], undefined, {
  cwd: resolve(here, '../..'),
  quiet: true,
  env: {
    PORT: String(port), DATA_DIR: join(dir, 'data'), BRAIN: 'claude-cli', CLAUDE_BIN: wrapper, CLAUDE_MODEL: opt('model', 'opus'), BRAIN_EFFORT: opt('effort', 'medium'),
    BRAIN_THINKING: opt('thinking', 'on'), CANVAS_TOOLS: opt('canvas', 'on'), AGENT: opt('agent', 'on'), IMAGE_MODEL: 'none', TAP_REAL: opt('claude', 'claude'),
  },
});
const stop = async (): Promise<void> => {
  server.kill('SIGTERM');
  await Promise.race([new Promise((done) => server.once('close', done)), sleep(4_000)]);
  server.kill('SIGKILL');
  releasePort(port);
  rmSync(dir, { recursive: true, force: true });
};

interface Seen { readonly at: number; readonly name: string; readonly text: string }
const seen: Seen[] = [];
let askedAt = 0;
try {
  for (let waited = 0; ; waited += 250) {
    if (waited > 30_000) throw new Error('the server did not start');
    if ((await fetch(`${base}${API.demos}`).catch(() => null))?.ok === true) break;
    await sleep(250);
  }
  const created = (await (await fetch(`${base}${API.sessions}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screen: REFERENCE_SCREEN, capabilities: FULL_CAPABILITIES, look: LOOK_IDS[0] }) })).json()) as { session: string };
  const stream = await fetch(`${base}${API.stream(created.session)}`);
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  let over = false;
  const reading = (async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const at = Date.now();
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (.*)$/m.exec(frame)?.[1] ?? '?';
        if (name === 'heartbeat' || askedAt === 0) continue;
        let data: { text?: string; line?: { text?: string } } = {};
        try {
          data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? '{}') as typeof data;
        } catch {
          // a frame that is not JSON is not one of ours
        }
        seen.push({ at, name, text: data.line?.text ?? data.text ?? '' });
        if (name === 'end') over = true;
      }
    }
  })();
  await sleep(500);
  askedAt = Date.now();
  await fetch(`${base}${API.turns(created.session)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-conduit-review': 'off' }, body: JSON.stringify({ input: { kind: 'prompt', text: prompt } }) });
  const deadline = askedAt + Number(opt('timeout', '240')) * 1000;
  while (!over && Date.now() < deadline) await sleep(200);
  await reader.cancel().catch(() => undefined);
  await reading.catch(() => undefined);
  if (!over) process.stdout.write('\n(the turn did not end in time; what follows is what came)\n');

  // ---- the CLI's side
  interface Out { readonly at: number; readonly what: string; readonly key: string; readonly size: number }
  const tap = readFileSync(tapFile, 'utf8').split('\n').filter((row) => row !== '').map((row) => JSON.parse(row) as { kind: string; t: number; line?: string; argv?: string[] });
  const sent = tap.find((row) => row.kind === 'in' && row.t >= askedAt - 50)?.t ?? askedAt;
  const outs: Out[] = [];
  for (const row of tap) {
    if (row.kind !== 'out' || row.t < sent - 5 || row.line === undefined) continue;
    let event: { type?: string; subtype?: string; event?: { type?: string; index?: number; delta?: { type?: string; text?: string; partial_json?: string }; content_block?: { type?: string; name?: string } } } = {};
    try {
      event = JSON.parse(row.line) as typeof event;
    } catch {
      continue;
    }
    const inner = event.event;
    if (event.type === 'stream_event' && inner?.type === 'content_block_start') outs.push({ at: row.t, what: `${inner.content_block?.type ?? '?'}${inner.content_block?.name === undefined ? '' : ` ${inner.content_block.name}`}`, key: 'start', size: 0 });
    else if (event.type === 'stream_event' && inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') outs.push({ at: row.t, what: 'text', key: 'text', size: inner.delta.text?.length ?? 0 });
    else if (event.type === 'stream_event' && inner?.type === 'content_block_delta' && inner.delta?.type === 'input_json_delta') outs.push({ at: row.t, what: 'tool input', key: 'input', size: inner.delta.partial_json?.length ?? 0 });
    else if (event.type === 'stream_event' && inner?.type === 'message_start') outs.push({ at: row.t, what: 'message_start', key: 'start', size: 0 });
    else if (event.type === 'user') outs.push({ at: row.t, what: 'tool result', key: 'result', size: 0 });
    else if (event.type === 'result') outs.push({ at: row.t, what: 'result', key: 'result', size: 0 });
  }
  const sec = (at: number): string => ((at - sent) / 1000).toFixed(2).padStart(7);
  const argv = tap.find((row) => row.kind === 'start')?.argv ?? [];
  process.stdout.write(`\nclaude ${['--model', '--effort', '--thinking'].map((flag) => (argv.includes(flag) ? `${flag} ${argv[argv.indexOf(flag) + 1] ?? ''}` : `(no ${flag})`)).join(' ')}\n`);
  process.stdout.write(`\nwhat the CLI printed (seconds from the user message; runs of deltas collapsed)\n`);
  for (let at = 0; at < outs.length; ) {
    const row = outs[at] as Out;
    if (row.key !== 'text' && row.key !== 'input') {
      process.stdout.write(`${sec(row.at)}  ${row.what}\n`);
      at += 1;
      continue;
    }
    let end = at;
    let size = 0;
    while (end < outs.length && outs[end]?.key === row.key) size += (outs[end++] as Out).size;
    const last = outs[end - 1] as Out;
    process.stdout.write(`${sec(row.at)}  ${row.what}: ${end - at} deltas, ${size} characters, until ${sec(last.at).trim()} (${((last.at - row.at) / 1000).toFixed(2)} s)${row.key === 'text' && end - at >= 20 && last.at - row.at < 400 ? '   <- ONE BURST' : ''}\n`);
    at = end;
  }

  // ---- the page's side
  const lines = seen.filter((row) => row.name === 'line');
  process.stdout.write(`\nwhat the page was sent (seconds from the request; ${lines.length} lines, typing events not listed)\n`);
  for (const row of lines) process.stdout.write(`${((row.at - askedAt) / 1000).toFixed(2).padStart(7)}  ${row.text.slice(0, 90)}\n`);
  const texts = outs.filter((row) => row.key === 'text');
  const firstText = texts[0];
  const firstTyping = seen.find((row) => row.name === 'typing');
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const inWindow = (width: number): number => Math.max(0, ...lines.map((row) => lines.filter((other) => other.at >= row.at && other.at < row.at + width).length));
  process.stdout.write('\nsummary\n');
  process.stdout.write(`  model's first text, from the request    ${firstText === undefined ? 'none' : `${((firstText.at - askedAt) / 1000).toFixed(2)} s`}\n`);
  process.stdout.write(`  first sign of text at the page          ${firstTyping === undefined ? 'none' : `${((firstTyping.at - askedAt) / 1000).toFixed(2)} s${firstText === undefined ? '' : `  (${firstTyping.at - firstText.at} ms after the CLI's first text: our hops)`}`}\n`);
  process.stdout.write(`  first line at the page                  ${firstLine === undefined ? 'none' : `${((firstLine.at - askedAt) / 1000).toFixed(2)} s`}\n`);
  process.stdout.write(`  last line at the page                   ${lastLine === undefined ? 'none' : `${((lastLine.at - askedAt) / 1000).toFixed(2)} s`}\n`);
  process.stdout.write(`  lines spread over                       ${firstLine === undefined || lastLine === undefined ? 'n/a' : `${((lastLine.at - firstLine.at) / 1000).toFixed(2)} s`}; most lines within 250 ms of each other: ${inWindow(250)} of ${lines.length}\n`);
  process.stdout.write(`  tool calls before the first text        ${outs.filter((row) => row.what.startsWith('tool_use') && (firstText === undefined || row.at < firstText.at)).length}\n`);
  process.stdout.write('  model calls made: 1\n');
} finally {
  await stop();
}
