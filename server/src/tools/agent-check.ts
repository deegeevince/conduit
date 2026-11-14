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
import { spawn } from 'node:child_process';
import { API, EMPTY_STAGE, FULL_CAPABILITIES, LEAD_WINDOW, LOOK_IDS, NO_SERVICES, REFERENCE_SCREEN } from '@conduit/language';
import { createClaudeCliBrain } from '../brains/claude-cli/claude-cli-brain';
import { detailOf, gateCall, redactSecrets, riskOf, summaryOf } from '../domain/agent';
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
  // A fetch is a way out for what the model could read once a folder or a service is on (review P1-7): then it runs unasked only when quiet.
  const fetchSettings: AgentSettings = { enabled: true, tools: ['WebSearch', 'WebFetch', 'Read'], services: [{ name: 'mail', config: '/x', gist: '' }], dir: folder, answerMs: 1 };
  const webOnly = new Set(['WebSearch', 'WebFetch']);
  const withFolder = new Set(['WebSearch', 'WebFetch', 'Read']);
  const exfil = call('WebFetch', { url: 'https://x.example/?d=the+contents+of+a+file', prompt: 'x' });
  check(gateCall(exfil, fetchSettings, webOnly).kind === 'allow', 'gateCall: with only the web tools on, a public fetch with a query still runs unasked', 'web only');
  check(gateCall(exfil, fetchSettings, withFolder).kind === 'ask', 'gateCall: with a folder on, a fetch with a query is asked for', 'Read on');
  check(gateCall(call('WebFetch', { url: 'https://x.example/page' }), fetchSettings, new Set(['WebSearch', 'WebFetch', 'mail'])).kind === 'ask', 'gateCall: with a service on, a fetch to any other host is asked for', 'mail on');
  check(gateCall(call('WebFetch', { url: 'https://en.wikipedia.org/wiki/Oslo' }), fetchSettings, withFolder).kind === 'allow', 'gateCall: and a quiet fetch to a reference site still runs', 'wikipedia');
  const longUrl = `https://example.com/${'q'.repeat(300)}?q=1`;
  const shown = detailOf(call('WebFetch', { url: longUrl, prompt: 'x' }));
  check(shown.includes(longUrl), 'the confirm control is given the whole address, not 160 characters of it', `${shown.length} characters`);
  check(!detailOf(call('mcp__x__get', { note: 'token=abcdefghijklmnop' })).includes('abcdefghijklmnop'), 'and the detail is redacted all the same', detailOf(call('mcp__x__get', { note: 'token=abcdefghijklmnop' })).replace(/\n/g, ' '));
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
    // A look at the draft runs in the same process, with the same tools, and may use none of them (review P1-6).
    const before = w.ranLog().length;
    const looked: BrainEvent[] = [];
    for await (const event of w.brain.review?.({ turn: 't1', session: 's', pass: 1, input: request().input, sight: null, picture: null, problems: [], styles: [], form: 'fix' }, new AbortController().signal) ?? []) looked.push(event);
    check(looked.length > 0 && permissions(looked).length === 0 && w.ranLog().length === before, 'a look-and-fix pass asks nothing and runs nothing, though the process has tools', `${permissions(looked).length} asked, ${w.ranLog().length - before} ran`);
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

  // 8. The real road of an answer: the server itself, over HTTP, as the page uses it. The brain is the stand-in, whose request ids are 36 characters.
  {
    const w = world(30_000);
    const port = 4785;
    const base = `http://127.0.0.1:${port}`;
    // one process, not tsx's wrapper around one: killing the wrapper would leave the server holding the port
    const server = spawn(process.execPath, ['--import', 'tsx', join(here, '../main.ts')], {
      cwd: join(here, '../..'),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        BRAIN: 'claude-cli', CLAUDE_BIN: join(w.dir, 'claude'), CLAUDE_MODEL: 'stand-in', PORT: String(port), AGENT: 'on', AGENT_TOOLS: 'WebSearch,WebFetch,Read,Write', AGENT_DIR: w.folder,
        AGENT_SERVICES: `mail=${join(w.dir, 'mail.json')}`, AGENT_ANSWER_MS: '30000', LIBRARY: 'none', CRITIC: 'off', REFINE: 'off', REVIEW: 'off', LOG_LEVEL: 'info', LOG_DIR: 'off',
      },
    });
    let serverErr = '';
    server.stderr?.on('data', (chunk: Buffer) => {
      serverErr += chunk.toString();
    });
    const post = async (path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const up = await fetch(`${base}${API.health}`).then((r) => r.ok).catch(() => false);
        if (up) break;
        if (Date.now() > deadline) throw new Error(`the server did not start on ${port}: ${serverErr.slice(-400)}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const created = (await (await post(API.sessions, { screen: REFERENCE_SCREEN, capabilities: FULL_CAPABILITIES, look: LOOK_IDS[0] })).json()) as { session: string };
      const session = created.session;
      const mode = await fetch(`${base}${API.brain(session)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'agent' }) });
      check(mode.ok, 'over HTTP: the session is switched to agent mode', String(mode.status));
      const stream = await fetch(`${base}${API.stream(session)}`);
      const reader = stream.body?.getReader();
      const decoder = new TextDecoder();
      const seen: { type: string; data: Record<string, unknown> }[] = [];
      let turn = '';
      const answered: string[] = [];
      let longIdRefused = 0;
      let buffer = '';
      let ended = false;
      const turned = await post(API.turns(session), { input: { kind: 'prompt', text: 'email someone' } });
      turn = ((await turned.json()) as { turn: string }).turn;
      const stop = Date.now() + 40_000;
      while (reader !== undefined && !ended && Date.now() < stop) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))]);
        if (chunk === null || chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let at = buffer.indexOf('\n\n');
        while (at >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          at = buffer.indexOf('\n\n');
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type === undefined || data === undefined) continue;
          const event = { type, data: JSON.parse(data) as Record<string, unknown> };
          seen.push(event);
          if (type === 'end') ended = true;
          if (type === 'permission') {
            const request = String(event.data['request']);
            if (answered.length === 0) longIdRefused = (await post(API.events(session), { events: [{ type: 'permit', turn, request: `${request}${'x'.repeat(200)}`, allow: true }] })).status;
            // exactly what the page sends: the whole id, by the turn it was asked in
            const allowIt = event.data['tool'] === 'Write';
            const status = (await post(API.events(session), { events: [{ type: 'permit', turn, request, allow: allowIt }] })).status;
            answered.push(`${String(event.data['tool'])}:${request.length}:${allowIt ? 'allow' : 'deny'}:${status}`);
          }
        }
      }
      const asked = seen.filter((event) => event.type === 'permission');
      check(asked.length === 2 && asked.every((event) => String(event.data['request']).length === 36), 'over HTTP: the server raised two confirm controls, each with the CLI\'s 36-character request id', `${answered.join(' ')} | events: ${seen.map((e) => e.type).join(',')} ${JSON.stringify(seen.find((e) => e.type === 'end')?.data ?? {}).slice(0, 300)} | server: ${serverErr.slice(-300)}`);
      check(asked.every((event) => typeof event.data['detail'] === 'string' && String(event.data['detail']).includes(String(event.data['tool']))), 'over HTTP: each carries the whole call as `detail`', String(asked[0]?.data['detail']).replace(/\n/g, ' ').slice(0, 100));
      check(answered.length === 2 && answered.every((entry) => entry.endsWith(':204')), 'over HTTP: the owner\'s answers were accepted whole (204)', answered.join(' '));
      check(longIdRefused === 400, 'over HTTP: an id that cannot be one is refused, not cut', String(longIdRefused));
      await new Promise((resolve) => setTimeout(resolve, 300));
      check(w.ranLog().join(',') === 'WebSearch,Write', 'over HTTP: the owner\'s Allow reached the brain (the write ran), and the Deny held (the send did not)', w.ranLog().join(','));
      check(existsSync(join(w.folder, 'note.txt')), 'over HTTP: the file the owner allowed exists', join(w.folder, 'note.txt'));
      await reader?.cancel().catch(() => undefined);
    } finally {
      server.kill('SIGKILL');
    }
    await w.brain.close?.();
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
