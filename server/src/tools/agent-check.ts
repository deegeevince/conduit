// Checks agent mode's safety against a scripted stand-in for `claude`, with no model and no network (v2.1, package G).
//   pnpm --filter @conduit/server exec tsx src/tools/agent-check.ts          the stand-in, the policy table and the relay's look
//   pnpm --filter @conduit/server exec tsx src/tools/agent-check.ts --real   also one tiny live turn (sonnet, effort low) through the real CLI
// Each line printed is PASS or FAIL with what was observed. Exits 1 if any failed.
//
// What it shows: a read, a write and a send produce one free call and two `permission` events; neither held call runs without a
// `permit`; an unanswered one is denied at the deadline; a call to a service switched off is denied without asking; a secret planted in
// a tool's input appears in no event; an interrupted turn denies what it was holding; and the flags the process was started with.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_STAGE, FULL_CAPABILITIES, LEAD_WINDOW, NO_SERVICES, REFERENCE_SCREEN } from '@conduit/language';
import { createClaudeCliBrain } from '../brains/claude-cli/claude-cli-brain';
import { gateCall, redactSecrets, riskOf, summaryOf } from '../domain/agent';
import type { AgentSettings } from '../domain/agent';
import type { BrainEvent, TurnRequest } from '../domain/brain';
import { createLogger } from '../log';
import { RelayHub } from '../brains/relay/relay-hub';
import { createRelayBrain } from '../brains/relay/relay-brain';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(here, '../../node_modules/.bin/tsx');
const root = mkdtempSync(join(tmpdir(), 'conduit-agent-check-'));
const standIn = join(here, 'agent-stand-in.ts');
let failed = 0;
const check = (ok: boolean, what: string, saw: string): void => {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}   [${saw}]\n`);
};

/** One fresh world: a folder for the agent, a log the stand-in writes, and a brain whose `claude` is the stand-in. */
function world(answerMs: number) {
  const dir = mkdtempSync(join(root, 'w-'));
  const folder = join(dir, 'agent-folder');
  mkdirSync(folder);
  const wrapper = join(dir, 'claude');
  writeFileSync(wrapper, `#!/bin/sh\nSTAND_IN_DIR='${dir}' exec '${tsx}' '${standIn}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const mail = join(dir, 'mail.json');
  writeFileSync(mail, '{"mcpServers":{}}');
  const agent: AgentSettings = { enabled: true, tools: ['WebSearch', 'WebFetch', 'Read', 'Write'], services: [{ name: 'mail', config: mail, gist: 'a stand-in mailbox' }], dir: folder, answerMs };
  const brain = createClaudeCliBrain({
    log: createLogger('error'), bin: wrapper, model: 'stand-in', firstTokenTimeoutMs: 20_000, idleTimeoutMs: 20_000, tools: [], effort: 'low', variant: 'column', warm: true, maxWarm: 2, warmIdleMs: 60_000, recycleTokens: 1_000_000,
    agent, modes: ['plain', 'agent'],
  });
  brain.choose?.('s', { mode: 'agent' });
  const ranLog = (): string[] => (existsSync(join(dir, 'ran.log')) ? readFileSync(join(dir, 'ran.log'), 'utf8').split('\n').filter((line) => line !== '') : []);
  return { dir, folder, brain, ranLog };
}

function request(): TurnRequest {
  const session = { capabilities: FULL_CAPABILITIES, screen: REFERENCE_SCREEN, services: NO_SERVICES };
  return { turn: 't1', session: 's', input: { kind: 'prompt', text: 'email someone' }, context: { ...session, lead: LEAD_WINDOW, stage: EMPTY_STAGE, history: [], heard: [] }, snapshot: null };
}

/** Runs a turn and calls `onPermission` for each permission event, as the conductor and the owner would. */
async function drive(w: ReturnType<typeof world>, onPermission: (event: Extract<BrainEvent, { type: 'permission' }>, seenRan: string[]) => void, signal = new AbortController().signal): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const event of w.brain.respond(request(), signal)) {
    events.push(event);
    if (event.type === 'permission') onPermission(event, w.ranLog());
  }
  return events;
}

const permissions = (events: BrainEvent[]) => events.filter((event): event is Extract<BrainEvent, { type: 'permission' }> => event.type === 'permission');
const states = (events: BrainEvent[], tool: string): string[] => events.flatMap((event) => (event.type === 'activity' && event.tool === tool ? [event.state] : []));

// 0. What the gate says about calls by name and by shape, with no process at all.
{
  const folder = '/work/agent';
  const call = (tool: string, input: Record<string, unknown> = {}) => ({ id: 'x', tool, input });
  const table: readonly [string, ReturnType<typeof call>, string][] = [
    ['a search is a read', call('WebSearch', { query: 'zec price' }), 'read'],
    ['a public page is a read', call('WebFetch', { url: 'https://example.com/a?b=1', prompt: 'x' }), 'read'],
    ['a page on the owner\'s own network is not', call('WebFetch', { url: 'http://192.168.1.1/admin' }), 'run'],
    ['a page with a sign-in in the address is not', call('WebFetch', { url: 'https://user:pw@example.com/' }), 'run'],
    ['a file inside the folder is a read', call('Read', { file_path: '/work/agent/notes.txt' }), 'read'],
    ['a file outside it is not', call('Read', { file_path: '/etc/hosts' }), 'run'],
    ['a path that climbs out of it is not', call('Read', { file_path: '/work/agent/../secrets' }), 'run'],
    ['a sibling folder with the same prefix is not', call('Read', { file_path: '/work/agent-other/x' }), 'run'],
    ['writing a file', call('Write', { file_path: '/work/agent/a', content: 'x' }), 'write'],
    ['a shell is run', call('Bash', { command: 'ls' }), 'run'],
    ['a mail tool sends', call('mcp__mail__send_email', { to: 'a@b.c' }), 'send'],
    ['a message tool, camel case, sends', call('mcp__chat__sendMessage', { text: 'hi' }), 'send'],
    ['a post is published', call('mcp__social__create_post', { text: 'hi' }), 'publish'],
    ['a purchase is a buy', call('mcp__shop__place_order', { sku: '1' }), 'buy'],
    ['an unnamed tool that takes a card is a buy', call('mcp__x__do', { card_number: '4' }), 'buy'],
    ['a delete is a delete', call('mcp__db__delete_rows', { table: 't' }), 'delete'],
    ['an authenticate is a sign-in', call('mcp__linear__authenticate'), 'signin'],
    ['a key in the input is a sign-in', call('mcp__x__get', { api_key: 'k' }), 'signin'],
    ['a POST through a fetch tool sends', call('mcp__http__request', { method: 'POST', url: 'https://a.b' }), 'send'],
    ['a service read with no hint is still asked for', call('mcp__remote__get_block', { id: '1' }), 'run'],
    ['a tool nobody has heard of is run', call('mcp__x__frobnicate'), 'run'],
  ];
  for (const [what, c, expected] of table) {
    const got = riskOf(c, false, folder);
    check(got === expected, `riskOf: ${what}`, `${c.tool} -> ${got}`);
  }
  check(riskOf(call('mcp__remote__get_block', { id: '1' }), true, folder) === 'read', 'riskOf: a service read is free only when the service itself says it only reads', 'with readOnlyHint');
  check(riskOf(call('mcp__mail__send_email', { to: 'a@b.c' }), true, folder) === 'send', 'riskOf: and the hint never frees what the name says sends', 'with readOnlyHint');
  const settings: AgentSettings = { enabled: true, tools: ['WebSearch'], services: [{ name: 'mail', config: '/x', gist: '' }], dir: null, answerMs: 1 };
  check(gateCall(call('Bash', { command: 'ls' }), settings, new Set(['WebSearch', 'mail'])).kind === 'deny', 'gateCall: a tool the owner did not offer is denied, not asked', 'Bash');
  check(gateCall(call('Read', { file_path: '/x' }), { ...settings, tools: ['Read'] }, new Set(['Read'])).kind === 'deny', 'gateCall: a file tool with no folder named is denied', 'Read, dir null');
  check(gateCall(call('mcp__mail__send_email', { to: 'a@b.c' }), settings, new Set(['WebSearch'])).kind === 'deny', 'gateCall: a service switched off is denied', 'mail off');
  check(gateCall(call('mcp__mail__send_email', { to: 'a@b.c' }), settings, new Set(['mail'])).kind === 'ask', 'gateCall: a send on a service that is on is asked for', 'mail on');
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const said = summaryOf(call('mcp__mail__send_email', { to: `x@y.z?token=${secret}`, body: secret }));
  check(!said.includes('ghp_') && !summaryOf(call('WebFetch', { url: `https://a.b/c?key=${secret}` })).includes('ghp_'), 'a summary never carries a secret, from a target or from a query', said);
  check(redactSecrets(`Authorization: Bearer ${secret} and password=hunter22`) === 'Authorization: [hidden] and password=[hidden]' || !redactSecrets(`Bearer ${secret} password=hunter22`).includes('hunter22'), 'redactSecrets hides a bearer token and a password', redactSecrets(`Bearer ${secret} password=hunter22`));
}

try {
  // 1. The owner permits the write and refuses the send.
  {
    const w = world(30_000);
    const ranAtAsk: string[][] = [];
    const events = await drive(w, (event, seen) => {
      ranAtAsk.push(seen);
      w.brain.permit?.('s', event.request, event.tool === 'Write');
    });
    const asked = permissions(events);
    check(asked.length === 2, 'a read, a write and a send: two permission events, the read free', `${asked.map((a) => `${a.tool}:${a.risk}`).join(', ')}`);
    check(asked[0]?.risk === 'write' && asked[1]?.risk === 'send', 'the risks are told apart in words', `${asked.map((a) => a.risk).join(', ')}`);
    check(w.ranLog().join(',') === 'WebSearch,Write', 'only the read and the permitted write ran; the refused send did not', w.ranLog().join(','));
    check(!ranAtAsk.some((seen) => seen.includes('Write') && ranAtAsk.indexOf(seen) === 0), 'the write had not run when it was asked about', `ran at first ask: [${(ranAtAsk[0] ?? []).join(',')}]`);
    check(existsSync(join(w.folder, 'note.txt')), 'the permitted write really wrote its file, in the named folder', join(w.folder, 'note.txt'));
    check(states(events, 'mcp__mail__send_email').includes('denied') && !states(events, 'mcp__mail__send_email').includes('done'), 'the send shows as denied, never as done', states(events, 'mcp__mail__send_email').join(','));
    check(states(events, 'WebSearch').join(',') === 'running,done', 'the read shows as running then done', states(events, 'WebSearch').join(','));
    const everything = JSON.stringify(events);
    check(!everything.includes('STANDINSECRET') && !everything.includes('sk-ant'), 'a secret planted in two tools\' inputs is in no event', `${everything.length} characters of events searched`);
    const argv = JSON.parse(readFileSync(join(w.dir, 'argv.json'), 'utf8')) as { argv: string[]; cwd: string };
    const flags = argv.argv.join(' ');
    check(!/dangerously|bypassPermissions|acceptEdits|--bare/.test(flags) && flags.includes('--permission-mode manual') && flags.includes('--permission-prompt-tool stdio') && flags.includes('--restricted'), 'the process was started in manual mode with the host prompt tool, restricted, and with none of the forbidden flags', flags.replace(/--system-prompt \S+/, '--system-prompt …').slice(0, 300));
    check(flags.includes('--tools WebSearch,WebFetch,Read,Write') && flags.includes(`--mcp-config ${join(w.dir, 'mail.json')}`), 'its tools and services are exactly the ones offered', flags.match(/--tools \S+/)?.[0] ?? '');
    check(argv.cwd.endsWith('agent-folder'), 'it was started in the folder the owner named', argv.cwd);
    await w.brain.close?.();
  }

  // 2. Nobody answers: both held calls are denied at the deadline.
  {
    const w = world(1_200);
    const started = Date.now();
    const events = await drive(w, () => undefined);
    check(w.ranLog().join(',') === 'WebSearch', 'unanswered, neither held call ran', w.ranLog().join(','));
    check(Date.now() - started < 12_000 && events.some((e) => e.type === 'usage'), 'the turn went on and ended after the denials', `${Date.now() - started} ms`);
    check(states(events, 'Write').includes('denied'), 'the unanswered write shows as denied', states(events, 'Write').join(','));
    await w.brain.close?.();
  }

  // 3. A service switched off is refused without asking; so is anything not offered.
  {
    const w = world(30_000);
    w.brain.setTool?.('s', 'mail', false);
    const events = await drive(w, (event) => w.brain.permit?.('s', event.request, true));
    check(permissions(events).length === 1 && permissions(events)[0]?.tool === 'Write', 'with the mail service off, the send is denied outright and only the write is asked', permissions(events).map((p) => p.tool).join(','));
    check(!w.ranLog().includes('mcp__mail__send_email'), 'the send did not run', w.ranLog().join(','));
    check(w.brain.tools?.('s').find((tool) => tool.name === 'mail')?.on === false, '/tools reports the service as off', JSON.stringify(w.brain.tools?.('s').map((t) => `${t.name}:${t.on}`)));
    await w.brain.close?.();
  }

  // 4. A turn interrupted while a call is held denies it, and the process goes on.
  {
    const w = world(30_000);
    const abort = new AbortController();
    const events = await drive(w, (event) => {
      if (event.tool === 'Write') abort.abort();
    }, abort.signal);
    check(!w.ranLog().includes('Write') && !w.ranLog().includes('mcp__mail__send_email'), 'interrupted while a write was held: it did not run', w.ranLog().join(','));
    check(permissions(events).length === 1, 'and nothing further was asked', String(permissions(events).length));
    await w.brain.close?.();
  }

  // 5. Without a folder the file tools do not exist at all; a plain session has no tools.
  {
    const w = world(30_000);
    const plain = world(30_000);
    plain.brain.choose?.('s', { mode: 'plain' });
    const events = await drive(plain, () => undefined);
    check(permissions(events).length === 0 && plain.ranLog().length === 0, 'a plain session: nothing asked, nothing run, however the model behaves', `${plain.ranLog().length} calls ran`);
    const flags = (JSON.parse(readFileSync(join(plain.dir, 'argv.json'), 'utf8')) as { argv: string[] }).argv.join(' ');
    check(!flags.includes('--permission-prompt-tool') && flags.includes('--tools'), 'and its process has no tools flag beyond the empty one', flags.match(/--tools \S*/)?.[0] ?? 'no --tools');
    await w.brain.close?.();
    await plain.brain.close?.();
  }
  // 6. The relay can look: a review is offered to the claimer with its brief and the picture's file, `ok` keeps the draft, lines are the fix.
  {
    const hub = new RelayHub({ log: createLogger('error'), now: () => Date.now(), idleTimeoutMs: 5_000 });
    const relay = createRelayBrain(hub);
    const control = new AbortController();
    const turnEvents: BrainEvent[] = [];
    const turnDone = (async () => {
      for await (const event of relay.respond(request(), control.signal)) turnEvents.push(event);
    })();
    const claimed = await hub.claim(1_000, control.signal);
    check(claimed?.turn === 't1' && hub.reviewOf('t1') === null, 'the relay hands a turn to its claimer with no look attached', claimed?.turn ?? 'nothing');
    hub.append('t1', [{ type: 'reject', raw: 'a draft line', issues: [] }]);
    hub.end('t1');
    await turnDone;
    const picture = { mime: 'image/jpeg' as const, bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1 };
    const lookEvents: BrainEvent[] = [];
    const looking = (async () => {
      for await (const event of relay.review?.({ turn: 't1', session: 's', pass: 2, input: request().input, sight: null, picture, problems: [], styles: [], form: 'fix' }, control.signal) ?? []) lookEvents.push(event);
    })();
    const again = await hub.claim(1_000, control.signal);
    const offer = hub.reviewOf('t1');
    const path = /the file (\S+) /.exec(offer?.brief ?? '')?.[1] ?? null;
    check(again?.turn === 't1' && offer?.pass === 2 && path !== null && existsSync(path), 'the look is claimed like a turn, with the review brief and a picture file', `${offer?.brief.length ?? 0} characters, picture at ${path ?? 'none'}`);
    hub.append('t1', [{ type: 'reject', raw: 'ok', issues: [] }]);
    hub.end('t1');
    await looking;
    check(!lookEvents.some((event) => event.type === 'reject') && lookEvents[0]?.type === 'brief', '`ok` is the draft kept: it is not a line and not a rejection', lookEvents.map((e) => e.type).join(','));
    check(path !== null && !existsSync(path), 'the picture file is gone when the look is over', path ?? 'none');
  }

  if (process.argv.includes('--real')) {
    // 7. One live turn through the real CLI: a search is free, a write is asked for, and the owner's no is final.
    const dir = mkdtempSync(join(root, 'real-'));
    const mailless: AgentSettings = { enabled: true, tools: ['WebSearch', 'Write'], services: [], dir, answerMs: 60_000 };
    const brain = createClaudeCliBrain({ log: createLogger('error'), bin: 'claude', model: 'sonnet', firstTokenTimeoutMs: 90_000, idleTimeoutMs: 60_000, tools: [], effort: 'low', variant: 'column', warm: true, maxWarm: 1, warmIdleMs: 60_000, recycleTokens: 1_000_000, agent: mailless, modes: ['plain', 'agent'] });
    brain.choose?.('s', { mode: 'agent' });
    const seen: string[] = [];
    const asked: string[] = [];
    const base = request();
    const turn: TurnRequest = { ...base, input: { kind: 'prompt', text: 'Use WebSearch for "Oslo weather today", then use the Write tool to save one line of it to weather.txt, then tell me in one line.' } };
    for await (const event of brain.respond(turn, new AbortController().signal)) {
      if (event.type === 'activity') seen.push(`${event.tool}:${event.state}`);
      if (event.type === 'permission') {
        asked.push(`${event.tool}:${event.risk} "${event.summary}"`);
        brain.permit?.('s', event.request, false);
      }
    }
    check(seen.includes('WebSearch:running') && seen.includes('WebSearch:done'), 'live: the search ran without being asked', seen.join(' '));
    check(asked.length >= 1 && asked.every((a) => a.startsWith('Write:write')) && !existsSync(join(dir, 'weather.txt')), 'live: the write was asked for, the answer was no, and no file exists', asked.join(' | '));
    await brain.close?.();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.stdout.write(failed === 0 ? 'all passed\n' : `${failed} FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
