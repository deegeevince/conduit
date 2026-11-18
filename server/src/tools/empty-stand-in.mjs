// A scripted stand-in for `claude -p --input-format stream-json --output-format stream-json`, for the turn that draws nothing (fb-075, fb-008): `empty-check.ts` starts the
// real server with it as the brain's CLI and plays turns through the real conductor. No model, no network. Plain Node, no dependencies.
//
// $STAND_IN_PLAN is a JSON file: `{ "<case>": [reply, ...], ... }`. A process picks its case from the first message it is sent (the person's words carry `case:<name>`), then
// answers each user message it is sent with the next reply of the case, in order (the last is kept for any message after it). A reply is `{ "tools": ["canvas_fits", ...],
// "text": "...", "delayMs": 0 }`: the canvas tools it calls first (each a tool_use and its tool_result, as the CLI prints them for a tool the host let through), then the text, written in
// a few deltas, then the turn's `result`. Every user message's text is appended to $STAND_IN_DIR/messages.jsonl with its case, so the check can say how many times the brain
// was spoken to and what it was told.

import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const dir = process.env.STAND_IN_DIR ?? '.';
const plan = JSON.parse(readFileSync(process.env.STAND_IN_PLAN ?? '', 'utf8'));
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (message) => (message?.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');

let heard = 0;
let busy = false;
let replies = null;
let caseName = '';

async function reply(spoken) {
  busy = true;
  const planned = replies[Math.min(spoken, replies.length - 1)] ?? { text: '' };
  send({ type: 'system', subtype: 'init', model: 'stand-in', tools: [], mcp_servers: [] });
  send({ type: 'stream_event', event: { type: 'message_start' } });
  for (const [index, tool] of (planned.tools ?? []).entries()) {
    const id = `toolu_${spoken}_${index}`;
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__canvas__${tool}`, input: {} }] } });
    await sleep(30);
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'fits', is_error: false }] } });
  }
  // `delayMs`: a model that thinks a while before it writes (the page is seen saying "Trying again…" meanwhile)
  await sleep(planned.delayMs ?? 0);
  const text = planned.text ?? '';
  // a few deltas, cut anywhere, as a model's are
  for (let at = 0; at < text.length; at += 37) {
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(at, at + 37) } } });
    await sleep(5);
  }
  send({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 });
  busy = false;
}

createInterface({ input: process.stdin }).on('line', (raw) => {
  let message = null;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message?.type === 'control_request' && message.request?.subtype === 'interrupt') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    return;
  }
  if (message?.type !== 'user' || busy) return;
  const text = textOf(message);
  if (replies === null) {
    const name = /case:([a-z0-9-]+)/.exec(text)?.[1] ?? '';
    replies = plan[name] ?? [{ text: '' }];
    caseName = name;
  }
  appendFileSync(`${dir}/messages.jsonl`, `${JSON.stringify({ case: caseName, text })}\n`);
  const spoken = heard;
  heard += 1;
  void reply(spoken);
});
process.stdin.on('end', () => process.exit(0));
