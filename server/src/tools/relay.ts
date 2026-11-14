// Be the brain from another session (v2.1, package G; the steward's way in).
//
//   pnpm relay listen [--once]    long-poll the server for a turn that was handed to the relay and print one JSON line for each:
//                                 { turn, session, again, brief, links, snapshot, guide }. Run it in the background of a Claude Code
//                                 session, which is told when a line arrives. `again` is true when the turn was claimed before: it is
//                                 the look at that turn's draft (the brief says so, and names the file the picture of the draft is in).
//   pnpm relay say <turn> [--end] write the Series lines on stdin to that turn; with --end the turn is ended after them. Prints how many
//                                 were taken and which were not, with why.
//   pnpm relay end <turn>         end the turn.
//   pnpm relay status             what is waiting and what is claimed.
//
// The server is at CONDUIT_URL, or http://127.0.0.1:$PORT. There is no default. A turn arrives here only when its conversation is set to `steward`
// (`/brain steward`, with STEWARD=on) or the server runs BRAIN=relay. Nothing here sends anything anywhere but that server.

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API } from '@conduit/language';
import type { RelayAppendResponse, RelayClaim, RelayEventsResponse, RelayStatus } from '@conduit/language';
import { processEnvironment } from '../env';

const environment = processEnvironment();
const given = environment['CONDUIT_URL'] ?? (environment['PORT'] === undefined ? undefined : `http://127.0.0.1:${environment['PORT']}`);
if (given === undefined) {
  process.stderr.write('relay: say which server: CONDUIT_URL=http://127.0.0.1:<port> or PORT=<port> (there is no default, so that it can never claim a turn from a server that is not yours)\n');
  process.exit(2);
}
const base = given.replace(/\/+$/, '');
const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
const positional = rest.filter((arg) => !arg.startsWith('--'));

const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const complain = (message: string): void => {
  process.stderr.write(`relay: ${message}\n`);
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${base}${path}`, init);
  } catch (error) {
    throw new Error(`cannot reach the server at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function listen(): Promise<void> {
  const seen = new Set<string>();
  const dir = join(tmpdir(), 'conduit-relay');
  mkdirSync(dir, { recursive: true });
  let quiet = 0;
  for (;;) {
    let response: Response;
    try {
      response = await call(`${API.relayNext}?wait=25`, { method: 'POST' });
    } catch (error) {
      if (quiet === 0) complain(error instanceof Error ? error.message : String(error));
      quiet += 1;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      continue;
    }
    quiet = 0;
    if (response.status === 204) continue;
    if (!response.ok) {
      complain(`the server answered ${response.status} to a claim: ${(await response.text()).slice(0, 300)}`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      continue;
    }
    const claim = (await response.json()) as RelayClaim;
    let snapshot: string | null = null;
    if (claim.links.snapshot !== null) {
      const picture = await call(claim.links.snapshot).catch(() => null);
      if (picture?.ok === true) {
        snapshot = join(dir, `${claim.turn}-stage.${(picture.headers.get('content-type') ?? '').includes('png') ? 'png' : 'jpg'}`);
        writeFileSync(snapshot, Buffer.from(await picture.arrayBuffer()));
      }
    }
    write({ turn: claim.turn, session: claim.session, again: seen.has(claim.turn), brief: claim.brief, links: claim.links, snapshot, guide: `${base}${claim.links.guide}` });
    seen.add(claim.turn);
    if (flags.has('--once')) return;
  }
}

async function say(turn: string): Promise<void> {
  const lines = await readStdin();
  const response = await call(`${API.relayLines(turn)}${flags.has('--end') ? '?end=1' : ''}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: lines });
  if (!response.ok) throw new Error(`the server answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as RelayAppendResponse;
  write({ accepted: body.accepted, rejected: body.rejected, warnings: body.warnings, ended: body.ended, clock: body.clock });
}

async function end(turn: string): Promise<void> {
  const response = await call(API.relayEnd(turn), { method: 'POST' });
  if (!response.ok) throw new Error(`the server answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as RelayEventsResponse;
  write({ open: body.open, clock: body.clock });
}

async function status(): Promise<void> {
  const response = await call(API.relayStatus);
  if (!response.ok) throw new Error(`the server answered ${response.status}`);
  write((await response.json()) as RelayStatus);
}

try {
  const turn = positional[0];
  if (command === 'listen') await listen();
  else if (command === 'say' && turn !== undefined) await say(turn);
  else if (command === 'end' && turn !== undefined) await end(turn);
  else if (command === 'status') await status();
  else {
    complain('usage: pnpm relay listen [--once] | say <turn> [--end] < lines | end <turn> | status');
    process.exitCode = 2;
  }
} catch (error) {
  complain(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
