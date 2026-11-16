// Agent mode: the same brain, with hands.
//
// The owner asked the canvas to do things ("i need you to do it"), and a brain with no tools can only say that it cannot. In agent
// mode the conversation's brain is the same `claude` process with a list of tools it may use: the CLI's own (`WebSearch`,
// `WebFetch`, `Read`, …) and connected services from the owner's allowlist (MCP servers, e.g. `remote`). It still answers in
// Series on the stage; it is never a second chat beside the canvas.
//
// Three rules, in this order, are the whole of its safety. They are code, not prompt:
//
//   1. NOTHING IS ON THAT THE OWNER DID NOT OFFER. The server's configuration (`BRAIN_TOOLS`, `AGENT_SERVICES`) is the allowlist; a
//      session can only switch on what is in it (`/tools`). The default is nothing.
//   2. READING IS FREE, EVERYTHING ELSE IS ASKED FOR. Every tool call is classified by `riskOf`. `read` on an allowlisted tool runs.
//      Anything else (`ASK_FIRST`: write, run, send, buy, delete, publish, sign in) stops and is put to the owner as a confirm
//      control on the stage, for that one call. There is no "always allow", no rule, flag or setting that answers for the owner, and
//      no answer in time is a no. A call that cannot be classified is `run`.
//   3. NO SECRET LEAVES THE PROCESS THAT HOLDS IT. What a tool was given and what it returned stay in the CLI's own conversation. The
//      brief, the stage, the session log and the activity strip get a few words about each call, passed through `redactSecrets`.
//      Anything that needs the owner's own hands (a sign-in, a code, a payment) is said plainly and left to the owner.
//
// The domain owns these types; `server/src/brains/claude-cli/` implements them against the CLI's permission prompts.

import { resolve as resolvePath, sep } from 'node:path';
import type { ActionRisk, AgentPermits, ToolChoice } from '@conduit/language';
import { browserVerdict, newBrowserState, quietAddress, sensitivityOf } from './browser';
import type { BrowserState } from './browser';
import { deniedDestination } from './destinations';

/** What the server's configuration offers a session. Everything else does not exist as far as a brain is concerned. */
export interface AgentSettings {
  /** agent mode may be chosen at all (`AGENT=on`) */
  readonly enabled: boolean;
  /** tools of the CLI's own the owner offers, by the CLI's names (`BRAIN_TOOLS`): `WebSearch`, `WebFetch`, `Read`, `Glob`, `Grep`, … */
  readonly tools: readonly string[];
  /** connected services the owner offers (`AGENT_SERVICES`): a name, and the path of the MCP configuration file that defines it */
  readonly services: readonly { readonly name: string; readonly config: string; readonly gist: string; /** tools the service itself says only read (its own note beside the configuration file); a call to one runs unasked */ readonly reads?: readonly string[] }[];
  /** the one folder file tools may touch (`AGENT_DIR`); the process is started in it and confined to it */
  readonly dir: string | null;
  /** ms the owner has to answer a confirm control before it is a no */
  readonly answerMs: number;
  /** the permit level a new conversation starts at (`AGENT_PERMITS`); `/tools auto` and `/tools ask` change one conversation's */
  readonly permits?: AgentPermits;
  /** private hosts the owner has allowed by name (`<DATA_DIR>/private-hosts.allow`); empty unless they wrote one */
  readonly allowPrivate?: readonly string[];
}

export const NO_AGENT: AgentSettings = { enabled: false, tools: [], services: [], dir: null, answerMs: 120_000, permits: 'ask' };

/** One call the model wants to make, as the CLI reported it and before anything has happened. */
export interface ToolCall {
  readonly id: string;
  /** the CLI's name for it: `WebFetch`, `Bash`, `mcp__remote__get_block` */
  readonly tool: string;
  /** the call's input as the CLI gave it; never logged, never sent anywhere */
  readonly input: Readonly<Record<string, unknown>>;
}

/** Tools of the CLI's own that only read. Anything not here, and every tool of a connected service not marked read-only by its own annotations, is asked for. */
export const READ_ONLY_TOOLS: readonly string[] = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'];

/** The CLI's tools that touch files: they are offered only when the owner named a folder (`AGENT_DIR`), and only inside it. */
export const FILE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * Words in a tool's name that say what it does in the world. A name is split into words (`post_message`, `postMessage`, `post-message`)
 * and a word counts when it begins with a stem, so `sendEmail` and `send_mail` both say `send`. The worst risk any word names is the
 * call's risk. `signin` outranks `publish` outranks `delete` outranks `buy` outranks `send` outranks `run` outranks `write`
 * (`ACTION_RISKS`' own order, worst last). Nouns are left out on purpose (`message`, `post` as a noun cannot be told from the verb, so
 * `post` is in: a tool that only reads a post is asked for too, which is the cost of erring upward).
 */
const RISK_STEMS: readonly { readonly risk: ActionRisk; readonly stems: readonly string[]; readonly exact?: readonly string[] }[] = [
  { risk: 'signin', stems: ['login', 'signin', 'sign', 'authenticat', 'authoriz', 'oauth', 'password', 'passwd', 'credential', 'logout', 'signout', 'connect', 'pair', 'verify', 'otp'], exact: ['auth', 'sso', 'mfa', '2fa', 'pin'] },
  { risk: 'publish', stems: ['publish', 'post', 'tweet', 'deploy', 'release', 'share', 'push', 'upload', 'announce', 'broadcast', 'submit', 'merge', 'unpublish'], exact: ['pr'] },
  { risk: 'delete', stems: ['delete', 'remove', 'destroy', 'drop', 'erase', 'purge', 'wipe', 'trash', 'cancel', 'revoke', 'unlink', 'truncate', 'clear', 'reset', 'kill', 'terminate', 'unsubscribe', 'archive'], exact: ['rm'] },
  { risk: 'buy', stems: ['buy', 'purchas', 'order', 'checkout', 'pay', 'subscri', 'book', 'reserv', 'charge', 'donat', 'bid', 'refund', 'transfer', 'withdraw', 'deposit', 'invoice'] },
  { risk: 'send', stems: ['send', 'email', 'mail', 'reply', 'forward', 'notify', 'sms', 'invite', 'comment', 'dm', 'whisper', 'dispatch', 'dial'] },
  { risk: 'run', stems: ['run', 'exec', 'bash', 'shell', 'eval', 'spawn', 'launch', 'start', 'stop', 'restart', 'install', 'invoke', 'trigger', 'schedule', 'automate', 'script', 'command', 'cmd', 'click', 'type', 'navigate'] },
  { risk: 'write', stems: ['write', 'create', 'update', 'edit', 'add', 'set', 'put', 'patch', 'modif', 'renam', 'move', 'save', 'insert', 'append', 'mkdir', 'commit', 'change', 'replace', 'import', 'sync', 'assign', 'tag', 'label', 'star', 'follow', 'like', 'mark', 'rate', 'vote'] },
];

/** What the shape of a call's input says, whatever the tool is called. */
const INPUT_SIGNALS: readonly { readonly risk: ActionRisk; readonly keys: readonly string[] }[] = [
  { risk: 'signin', keys: ['password', 'passwd', 'otp', 'passcode', 'verification_code', 'credentials', 'client_secret', 'refresh_token', 'api_key', 'apikey'] },
  { risk: 'buy', keys: ['card', 'card_number', 'cvv', 'cvc', 'iban', 'amount', 'price', 'payment', 'payment_method', 'billing'] },
  { risk: 'send', keys: ['to', 'cc', 'bcc', 'recipient', 'recipients', 'subject', 'phone', 'sender'] },
];

const RISK_ORDER: readonly ActionRisk[] = ['read', 'write', 'run', 'send', 'buy', 'delete', 'publish', 'signin'];
const worse = (a: ActionRisk, b: ActionRisk): ActionRisk => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a);

/** `mcp__remote__get_block` -> `{ service: 'remote', action: 'get_block' }`; a tool of the CLI's own has no service. */
export function splitTool(tool: string): { readonly service: string | null; readonly action: string } {
  const match = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/.exec(tool);
  if (match === null) return { service: null, action: tool };
  // Claude in Chrome's server is called `claude-in-chrome` by the CLI; the owner offers it as `chrome`.
  const service = match[1] === 'claude-in-chrome' ? 'chrome' : (match[1] ?? null);
  return { service, action: match[2] ?? tool };
}

function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

function riskOfName(name: string): ActionRisk | null {
  let found: ActionRisk | null = null;
  const words = wordsOf(name);
  for (const word of words) {
    for (const row of RISK_STEMS) {
      const hit = (row.exact ?? []).includes(word) || row.stems.some((stem) => word.startsWith(stem.replace(/_/g, '')));
      if (hit) found = found === null ? row.risk : worse(found, row.risk);
    }
  }
  return found;
}

function hostIsPrivate(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || h.startsWith('[') || /^\d+$/.test(h);
}

/** A public page, by plain `http(s)`, with no credential in it. Whether its address could carry something out is `fetchIsQuiet`'s question, asked once a folder or a service is on. */
function fetchIsPlain(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 600) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return !hostIsPrivate(url.hostname);
}

/** Hosts of search and reference sites: the only places a fetch is free once anything beyond the web tools is on. */
const SEARCH_HOSTS: readonly string[] = ['duckduckgo.com', 'google.com', 'bing.com', 'search.brave.com', 'wikipedia.org', 'wikimedia.org'];

/**
 * A fetch that cannot carry something out: no query, no fragment, a short path, and a search or reference site. When the model also
 * holds a folder or a connected service, an address is a way to send what it read (`https://x.example/?d=<what it read>`), so only
 * this kind runs unasked; every other asks, and the confirm control shows the whole address.
 */
function fetchIsQuiet(raw: unknown): boolean {
  if (!fetchIsPlain(raw) || typeof raw !== 'string') return false;
  const url = new URL(raw);
  if (url.search !== '' || url.hash !== '' || url.pathname.length > 100) return false;
  const host = url.hostname.toLowerCase();
  return SEARCH_HOSTS.some((site) => host === site || host.endsWith(`.${site}`));
}

/** Whether a path the model gave names something inside `dir`. Symlinks are the CLI's own business (`--restricted` confines it); this is the net under that. */
function insideDir(raw: unknown, dir: string | null): boolean {
  if (dir === null) return false;
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return false;
  const root = resolvePath(dir);
  const target = resolvePath(root, raw);
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * What a call would do in the world. Conservative by construction, and erring upward: it answers `read` only for a tool in
 * `READ_ONLY_TOOLS` that is doing a plain read (a page that is public and plain, a path inside `dir`), or for a connected service's tool
 * that `readOnlyHint` (the service's own annotation, passed in by the adapter) says only reads. Everything else is the worst thing its
 * name or the shape of its input says, and `run` when it says nothing: a call that cannot be classified is asked for.
 */
export function riskOf(call: ToolCall, readOnlyHint = false, dir: string | null = null, strictFetch = false, browser: BrowserState | null = null): ActionRisk {
  const { service, action } = splitTool(call.tool);
  if (service === 'chrome') return browserVerdict(call, browser ?? newBrowserState()).risk;
  let risk: ActionRisk | null = null;
  for (const signal of INPUT_SIGNALS) {
    if (Object.keys(call.input).some((key) => signal.keys.includes(key.toLowerCase()))) risk = risk === null ? signal.risk : worse(risk, signal.risk);
  }
  const method = call.input['method'];
  if (typeof method === 'string' && /^(?:post|put|patch|delete)$/i.test(method)) risk = worse(risk ?? 'write', /^delete$/i.test(method) ? 'delete' : 'send');
  const named = riskOfName(action);
  if (named !== null) risk = risk === null ? named : worse(risk, named);

  if (service === null && READ_ONLY_TOOLS.includes(call.tool)) {
    if (risk === null || risk === 'write') {
      if (call.tool === 'WebFetch') return !fetchIsPlain(call.input['url']) ? 'run' : strictFetch && !fetchIsQuiet(call.input['url']) ? 'send' : 'read';
      if (call.tool === 'WebSearch') return typeof call.input['query'] === 'string' ? 'read' : 'run';
      const where = call.input['file_path'] ?? call.input['path'] ?? (call.tool === 'Read' ? undefined : '.');
      return insideDir(where, dir) ? 'read' : 'run';
    }
  }
  if (service !== null && readOnlyHint && (risk === null || risk === 'write')) return 'read';
  return risk ?? 'run';
}

/** Whether the owner's own note on a connected service says this tool only reads. The service's note, never the model's word. */
export function serviceReads(settings: AgentSettings, tool: string): boolean {
  const { service, action } = splitTool(tool);
  return service !== null && settings.services.some((entry) => entry.name === service && entry.reads?.includes(action) === true);
}

/** `?` and what follows is cut from a URL: a query is the commonest place for a token. */
function bareUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search === '' ? '' : '?…'}`;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

const PLAIN_VERBS: Readonly<Record<string, string>> = { WebSearch: 'search the web for', WebFetch: 'read the page', Read: 'read', Glob: 'list files matching', Grep: 'search files for', Write: 'write', Edit: 'edit' };

/** The keys that name what a call is aimed at, best first. Never `body`, `content`, `text` or anything that could hold what the owner would not want shown. */
const TARGET_KEYS: readonly string[] = ['query', 'url', 'action_summary', 'file_path', 'path', 'pattern', 'to', 'channel', 'recipient', 'name', 'title', 'subject', 'id', 'key', 'repo', 'issue', 'query_string'];

/**
 * A few plain words about a call, for the activity strip, the log and the confirm control: the tool's name and the one field that
 * names its target. Built from the tool and that field, never from the whole input, and passed through `redactSecrets`.
 */
export function summaryOf(call: ToolCall): string {
  const { service, action } = splitTool(call.tool);
  const verb = (service === 'chrome' && action === 'computer' && typeof call.input['action'] === 'string' ? call.input['action'] : action).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const what = service === null ? (PLAIN_VERBS[call.tool] ?? verb) : `${service}: ${verb}`;
  let target = '';
  for (const key of TARGET_KEYS) {
    const value = call.input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      target = key === 'url' ? bareUrl(value) : value;
      break;
    }
    if (typeof value === 'number') {
      target = String(value);
      break;
    }
  }
  if (target.includes('/') && (call.tool === 'Read' || call.tool === 'Write' || call.tool === 'Edit' || call.tool === 'Glob' || call.tool === 'Grep')) target = target.split('/').slice(-2).join('/');
  return redactSecrets(target === '' ? what : `${what} ${call.tool === 'WebSearch' ? `"${target}"` : target}`);
}

/** The most the confirm control is given of one call. */
export const DETAIL_MAX = 4_000;

/**
 * The whole call for the confirm control, so that the owner consents to what will happen and not to a summary of it: the tool's name
 * and every field of its input, pretty-printed, each string whole (a full address, a full path, a whole message), passed through
 * `redactSecrets`. Goes to that one event and nowhere else; the log and the strip keep `summaryOf`.
 */
export function detailOf(call: ToolCall, context: string | null = null): string {
  let body: string;
  try {
    body = JSON.stringify(call.input, (_key, value: unknown) => (typeof value === 'string' && value.length > 1_500 ? `${value.slice(0, 1_500)}… (${String(value.length - 1_500)} more characters)` : value), 2);
  } catch {
    body = '(the input could not be shown)';
  }
  return redactSecrets(`${call.tool}${context === null ? '' : `\non the page ${context}`}\n${body}`, DETAIL_MAX, true);
}

/**
 * THE PERMIT TABLE, the one place that says whether a browser call that is not forbidden outright runs by itself. Pure: risk, level and
 * whether the page is a sign-in, payment or checkout page in; allow, ask or deny out.
 *
 *   forbidden (a credential, another tab, a download, a removed tool)   deny    in every level
 *   page is a sign-in, payment or checkout page                          ask     in every level (even for a read)
 *   read                                                                 allow   in every level
 *   write, run                                                           ask     when ask;  allow when auto
 *   send, buy, delete, publish, signin                                   ask     in every level
 *
 * `auto` is a decision this layer makes about a `can_use_tool` question; the CLI's own permission flags are not touched.
 */
export function permitDecision(input: { readonly risk: ActionRisk; readonly permits: AgentPermits; readonly pageSensitive: boolean; readonly forbidden: boolean }): 'allow' | 'ask' | 'deny' {
  if (input.forbidden) return 'deny';
  if (input.pageSensitive) return 'ask';
  if (input.risk === 'read') return 'allow';
  if (input.permits === 'auto' && (input.risk === 'write' || input.risk === 'run')) return 'allow';
  return 'ask';
}

/** What the gate says about one call the CLI is asking to make. */
export type CallVerdict =
  /** runs without asking: a read, or (`permit: 'auto'`) a write or run the owner's `auto` level lets through; the activity strip and the log say which */
  | { readonly kind: 'allow'; readonly risk: ActionRisk; readonly permit?: 'auto' }
  /** not on: the owner's configuration did not offer it, or this session has it switched off. The model is told no. */
  | { readonly kind: 'deny'; readonly risk: ActionRisk; readonly why: string }
  /** needs the owner's yes, once, on the stage */
  | { readonly kind: 'ask'; readonly risk: ActionRisk };

/**
 * The whole of agent mode's policy for one call, as a pure function so it can be tested with no model. `on` is what this session has
 * switched on, by name: a tool of the CLI's own, or a service (a call to `mcp__<service>__…` is on when `<service>` is).
 *   1. a tool not in `on` is denied, whatever it is and whoever asks;
 *   2. a `read` runs; 3. everything else is asked for. There is no fourth outcome and no setting that makes one.
 */
export function gateCall(call: ToolCall, settings: AgentSettings, on: ReadonlySet<string>, readOnlyHint = false, browser: BrowserState | null = null, permits: AgentPermits = 'ask'): CallVerdict {
  const { service, action } = splitTool(call.tool);
  const name = service ?? call.tool;
  const offered = service === null ? settings.tools.includes(call.tool) : settings.services.some((entry) => entry.name === service);
  if (!settings.enabled || !offered || !on.has(name)) return { kind: 'deny', risk: riskOf(call, false, settings.dir), why: `${service === null ? call.tool : `${service}: ${action}`} is not switched on` };
  // Where a call goes: this machine and private networks are refused in every permit level (destinations.ts).
  const elsewhere = deniedDestination(call.input, settings.allowPrivate);
  if (elsewhere !== null) return { kind: 'deny', risk: 'run', why: elsewhere };
  if (service === null && FILE_TOOLS.includes(call.tool) && settings.dir === null) return { kind: 'deny', risk: 'run', why: 'no folder has been named for file tools' };
  if (service === 'chrome') {
    // The owner's browser has its own rules (`browser.ts`): its own tabs only, a credential never typed, a sign-in or payment page always asked.
    const verdict = browserVerdict(call, browser ?? newBrowserState());
    const outcome = permitDecision({ risk: verdict.risk, permits, pageSensitive: verdict.sensitive, forbidden: verdict.deny !== null });
    if (outcome === 'deny') return { kind: 'deny', risk: verdict.risk, why: verdict.deny ?? 'not allowed' };
    if (outcome === 'ask') return { kind: 'ask', risk: verdict.risk };
    return verdict.risk === 'read' ? { kind: 'allow', risk: 'read' } : { kind: 'allow', risk: verdict.risk, permit: 'auto' };
  }
  // Anything beyond the web tools on makes an address a way out for what that thing could read: a fetch then runs unasked only when it is quiet.
  const strictFetch = [...on].some((entry) => entry !== 'WebSearch' && entry !== 'WebFetch' && (settings.tools.includes(entry) || settings.services.some((s) => s.name === entry)));
  const risk = riskOf(call, readOnlyHint, settings.dir, strictFetch);
  // In `auto`, a fetch of a public address that carries nothing out (the very test the browser's `navigate` uses, and no sign-in or
  // payment page) is the same act as the brain opening that page in its own tab, which `auto` already lets through: it runs, and is flagged.
  if (permits === 'auto' && call.tool === 'WebFetch' && risk === 'send') {
    const target = call.input['url'];
    if (typeof target === 'string' && quietAddress(target.trim()) === 'quiet' && sensitivityOf(target) === null) return { kind: 'allow', risk: 'read', permit: 'auto' };
  }
  return risk === 'read' ? { kind: 'allow', risk } : { kind: 'ask', risk };
}

const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xox[abprs]|AKIA|ASIA|AIza|ya29)[-_A-Za-z0-9.]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd|pwd|authorization|cookie|session[_-]?id)["']?\s*[:=]\s*["']?)[^\s"'&,;]{4,}/gi,
  /([?&](?:key|token|sig|signature|access_token|code|password)=)[^&\s]+/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/** Whether the text holds anything shaped like a credential (a key, a token, a signed header): a file that does is not handed to the brain. */
export function hasSecretShape(text: string): boolean {
  return SECRET_SHAPES.some((shape) => new RegExp(shape.source, shape.flags.replace('g', '')).test(text));
}

/**
 * A few words about a tool call that are safe to show, log and send: anything shaped like a credential is replaced by `[hidden]`, and
 * the whole is cut to `max` characters. Used on every summary before it leaves the brain adapter. It is a net under the rule, not
 * the rule: the adapter builds a summary from the tool's name and the one field that names its target, never from its whole input.
 */
export function redactSecrets(text: string, max = 160, keepLines = false): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (_match: string, lead?: unknown) => (typeof lead === 'string' ? `${lead}[hidden]` : '[hidden]'));
  out = keepLines ? out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** What `/tools` says of the browser. */
export const CHROME_GIST = "your Chrome, in a tab of its own; reads free, every action asked; you sign in yourself";

/** What `/tools` lists for a session: everything offered, and whether this session has it on. */
export function toolChoices(settings: AgentSettings, on: ReadonlySet<string>): ToolChoice[] {
  return [
    ...settings.tools.map((name): ToolChoice => ({ name, kind: 'tool', gist: READ_ONLY_TOOLS.includes(name) ? 'reads only' : 'asks before it acts', on: on.has(name), reads: READ_ONLY_TOOLS.includes(name) })),
    ...settings.services.map((service): ToolChoice => ({ name: service.name, kind: 'service', gist: service.name === 'chrome' ? CHROME_GIST : service.gist, on: on.has(service.name), reads: false })),
  ];
}
