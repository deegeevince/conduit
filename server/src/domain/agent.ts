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

import type { ActionRisk, ToolChoice } from '@conduit/language';

/** What the server's configuration offers a session. Everything else does not exist as far as a brain is concerned. */
export interface AgentSettings {
  /** agent mode may be chosen at all (`AGENT=on`) */
  readonly enabled: boolean;
  /** tools of the CLI's own the owner offers, by the CLI's names (`BRAIN_TOOLS`): `WebSearch`, `WebFetch`, `Read`, `Glob`, `Grep`, … */
  readonly tools: readonly string[];
  /** connected services the owner offers (`AGENT_SERVICES`): a name, and the path of the MCP configuration file that defines it */
  readonly services: readonly { readonly name: string; readonly config: string; readonly gist: string }[];
  /** the one folder file tools may touch (`AGENT_DIR`); the process is started in it and confined to it */
  readonly dir: string | null;
  /** ms the owner has to answer a confirm control before it is a no */
  readonly answerMs: number;
}

export const NO_AGENT: AgentSettings = { enabled: false, tools: [], services: [], dir: null, answerMs: 120_000 };

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

/**
 * What a call would do in the world. Conservative by construction: it only ever answers `read` for a tool in `READ_ONLY_TOOLS`, or
 * for a connected service's tool that `readOnlyHint` (the service's own annotation, passed in by the adapter) says only reads.
 * STUB(PLAN-v2.1 package G): tell `send`, `buy`, `delete`, `publish` and `signin` apart from the tool's name and input, so the confirm
 * control can say what is being asked in the owner's words. Until then everything that is not a read is `run`, which is asked for.
 */
export function riskOf(call: ToolCall, readOnlyHint = false): ActionRisk {
  if (READ_ONLY_TOOLS.includes(call.tool)) return 'read';
  if (readOnlyHint && call.tool.startsWith('mcp__')) return 'read';
  return 'run';
}

const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xox[abprs]|AKIA|ASIA|AIza|ya29)[-_A-Za-z0-9.]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd|pwd|authorization|cookie|session[_-]?id)["']?\s*[:=]\s*["']?)[^\s"'&,;]{4,}/gi,
  /([?&](?:key|token|sig|signature|access_token|code|password)=)[^&\s]+/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/**
 * A few words about a tool call that are safe to show, log and send: anything shaped like a credential is replaced by `[hidden]`, and
 * the whole is cut to `max` characters. Used on every summary before it leaves the brain adapter. It is a net under the rule, not
 * the rule: the adapter builds a summary from the tool's name and the one field that names its target, never from its whole input.
 */
export function redactSecrets(text: string, max = 160): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (_match: string, lead?: unknown) => (typeof lead === 'string' ? `${lead}[hidden]` : '[hidden]'));
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** What `/tools` lists for a session: everything offered, and whether this session has it on. */
export function toolChoices(settings: AgentSettings, on: ReadonlySet<string>): ToolChoice[] {
  return [
    ...settings.tools.map((name): ToolChoice => ({ name, kind: 'tool', gist: READ_ONLY_TOOLS.includes(name) ? 'reads only' : 'asks before it acts', on: on.has(name), reads: READ_ONLY_TOOLS.includes(name) })),
    ...settings.services.map((service): ToolChoice => ({ name: service.name, kind: 'service', gist: service.gist, on: on.has(service.name), reads: false })),
  ];
}
