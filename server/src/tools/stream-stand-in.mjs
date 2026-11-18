// A scripted stand-in for `claude -p --input-format stream-json --output-format stream-json`, to time the brain's own reading of a stream with no model
// (`streamBrainCheck` in real-check.ts starts it through a wrapper). Every user message it is sent gets a recorded turn (check-fixtures/stream-turn.jsonl,
// $STAND_IN_FIXTURE) printed line by line, with $STAND_IN_GAP_MS (50) of silence before each text delta; the moment each delta was written goes to
// $STAND_IN_DIR/emitted.json (an array, one time in ms since the epoch per delta), before the turn's `result` is printed. Plain Node, no dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const dir = process.env.STAND_IN_DIR ?? '.';
const gap = Number(process.env.STAND_IN_GAP_MS ?? 50);
const lines = readFileSync(process.env.STAND_IN_FIXTURE ?? '', 'utf8').split('\n').filter((line) => line.trim() !== '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const typeOf = (line) => {
  try {
    return JSON.parse(line).type;
  } catch {
    return null;
  }
};

let busy = false;
createInterface({ input: process.stdin }).on('line', async (raw) => {
  let message = null;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message?.type !== 'user' || busy) return;
  busy = true;
  const emitted = [];
  for (const line of lines) {
    if (line.includes('"text_delta"')) await sleep(gap);
    if (typeOf(line) === 'result') writeFileSync(`${dir}/emitted.json`, JSON.stringify(emitted));
    if (line.includes('"text_delta"')) emitted.push(Date.now());
    process.stdout.write(`${line}\n`);
  }
  busy = false;
});
