// A scripted stand-in for `claude`, to check agent mode's gate without a model (v2.1, package G). Run by `agent-check.ts` through a
// wrapper it writes; it speaks as much of stream-json as the brain reads, and it asks the way the real CLI does (see the notes at the top
// of brains/claude-cli/warm.ts): before each call it prints a `can_use_tool` control request and waits for the answer on stdin.
//
// Every user message it is sent gets the same three calls, then one line of Series and a result:
//   1. WebSearch   (a read: the gate should answer by itself)
//   2. Write       (the model wants to write a file in its folder, and plants a secret in the content)
//   3. mcp__mail__send_email   (the model wants to send, and plants a secret in the body; the secret shape `api_key` is checked in the unit table instead)
// A call that is allowed "runs": it leaves a line in $STAND_IN_DIR/ran.log (and Write really writes the file). A call that is denied
// does not, and the tool result says so. `$STAND_IN_DIR/argv.json` records the arguments it was started with.

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env['STAND_IN_DIR'] ?? '.';
const ran = (what: string): void => appendFileSync(join(dir, 'ran.log'), `${what}\n`);
writeFileSync(join(dir, 'argv.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));

const SECRET = 'sk-ant-STANDINSECRET0123456789abcdef';
const send = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const calls = [
  { tool: 'WebSearch', input: { query: 'ZEC price today' } },
  { tool: 'Write', input: { file_path: join(process.cwd(), 'note.txt'), content: `note, token=${SECRET}` } },
  { tool: 'mcp__mail__send_email', input: { to: 'someone@example.com', subject: 'hello', body: `the key is ${SECRET}` } },
];

// The CLI's request ids are 36-character UUIDs, and a stand-in with short ones hid a bug that cut them (review P0-1).
const requestIdOf = (index: number): string => `3f2a9c1e-7b4d-4e0a-9f55-${String(100_000_000_000 + index)}`;
const waiting = new Map<string, (allow: boolean) => void>();
let turnRunning = false;
let interrupted = false;

async function turn(): Promise<void> {
  turnRunning = true;
  interrupted = false;
  send({ type: 'system', subtype: 'init', tools: ['WebSearch', 'Write'], mcp_servers: [{ name: 'mail' }], model: 'stand-in' });
  for (const [index, call] of calls.entries()) {
    if (interrupted) break;
    const id = `toolu_${index}`;
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: call.tool, input: call.input }] } });
    const allowed = await new Promise<boolean>((resolve) => {
      waiting.set(id, resolve);
      send({ type: 'control_request', request_id: requestIdOf(index), request: { subtype: 'can_use_tool', tool_name: call.tool, input: call.input, tool_use_id: id } });
    });
    if (allowed) {
      ran(call.tool);
      if (call.tool === 'Write') writeFileSync(join(process.cwd(), 'note.txt'), 'written');
    }
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: allowed ? 'ok' : 'denied', is_error: !allowed }] } });
  }
  if (!interrupted) {
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'scene layout=solo\nsay a1 | Done.\n' } } });
    send({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 });
  } else {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} });
  }
  turnRunning = false;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let at = buffer.indexOf('\n');
  while (at >= 0) {
    const raw = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf('\n');
    if (raw.trim() === '') continue;
    const message = JSON.parse(raw) as { type?: string; request_id?: string; request?: { subtype?: string }; response?: { request_id?: string; response?: { behavior?: string } } };
    if (message.type === 'user' && !turnRunning) void turn();
    else if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      interrupted = true;
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
      for (const [id, resolve] of waiting) {
        waiting.delete(id);
        resolve(false);
      }
    } else if (message.type === 'control_response') {
      const requestId = message.response?.request_id ?? '';
      const id = `toolu_${calls.findIndex((_call, index) => requestIdOf(index) === requestId)}`;
      const resolve = waiting.get(id);
      if (resolve !== undefined) {
        waiting.delete(id);
        resolve(message.response?.response?.behavior === 'allow');
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
