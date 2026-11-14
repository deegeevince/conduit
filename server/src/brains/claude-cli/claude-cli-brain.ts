import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asksWhatsNew, buildSystemPrompt, buildTurnBrief, VERBS } from '@conduit/language';
import type { ActionRisk, AgentPermits, AppStatus, BrainChange, BrainChoice, BrainEffort, BrainMode, PromptVariant, ToolChoice } from '@conduit/language';
import type { BriefForm, Capabilities } from '@conduit/language';
import { buildReviewBrief, isKeep } from '@conduit/language';
import type { AmendRequest, Brain, BrainEvent, BrainSession, ReviewRequest, Snapshot, TurnRequest } from '../../domain/brain';
import { detailOf, FILE_TOOLS, gateCall, NO_AGENT, splitTool, summaryOf, toolChoices } from '../../domain/agent';
import { addressesIn, deniedAfterResolving } from '../../domain/destinations';
import { newBrowserState, noteBrowserResult } from '../../domain/browser';
import type { BrowserState } from '../../domain/browser';
import type { AgentSettings } from '../../domain/agent';
import { askedOf } from '../../domain/review';
import { brainEventsFromText } from '../../domain/lines';
import { AppError, errors } from '../../errors';
import type { Logger } from '../../log';
import { NEVER_ENGAGED } from '../../kill';
import type { KillSwitch } from '../../kill';
import { startWarmProcess } from './warm';
import type { WarmProcess } from './warm';
import { Mailbox } from './mailbox';
import type { AgentRun } from './process';
import { cancelledAskOf, failureOf, permissionAskOf, resultFactsOf, textDeltaOf, toolResultsOf, toolResultTextsOf, toolUsesOf } from './stream-json';
import type { ClaudeResultFacts } from './stream-json';

/** Names of the language's own lines: the model sometimes calls one as if it were a tool; none is. */
const NOT_TOOLS: ReadonlySet<string> = new Set(VERBS.map((verb) => String(verb).toLowerCase()));

/**
 * SA4. How the brain's processes reach the canvas tools: the address of the server's MCP door, and a token for each process, bound to the
 * conversation it serves and revoked when the process is let go. The token is written, with the address, to a 0600 file in a folder of the
 * process's own (`--mcp-config`); it is never logged.
 */
export interface CanvasLink {
  readonly url: string;
  mint(session: string): string;
  revoke(token: string): void;
}

/** The name the CLI gives a canvas tool: `mcp__canvas__canvas_fits`. */
const isCanvasTool = (name: string): boolean => name.startsWith('mcp__canvas__');

export interface ClaudeCliDeps {
  readonly log: Logger;
  readonly bin: string;
  readonly model: string;
  readonly firstTokenTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly tools: readonly string[];
  readonly effort: 'low' | 'medium' | 'high';
  readonly variant: PromptVariant;
  /** keep one process per conversation between turns (see warm.ts); false is v0's fresh process per turn */
  readonly warm: boolean;
  readonly maxWarm: number;
  readonly warmIdleMs: number;
  readonly recycleTokens: number;
  /** v2.1. What agent mode may use; absent is `NO_AGENT`: the brain has one mode, `plain` */
  readonly agent?: AgentSettings;
  /** v2.1. The kinds of mind the server offers a session; `steward` is the registry's, not this brain's */
  readonly modes?: readonly BrainMode[];
  /** v2.1. The steward's account of where the product stands, as the brief's note about the app has it; read without waiting */
  readonly status?: () => AppStatus | null;
  /** v2.1. The changelog's newest section, given to a turn that asks what is new; read without waiting */
  readonly news?: () => string | null;
  /** v2.1 ops. The kill switch: engaged, every conversation is `plain`, every call the CLI asks about is refused, and `agent` cannot be chosen */
  readonly kill?: KillSwitch;
  /** SA4. The canvas tools: every process is started with them, in plain mode and agent mode alike. Absent: none. */
  readonly canvas?: CanvasLink;
}

/** A call the CLI is holding for the owner's answer. */
interface Held {
  readonly requestId: string;
  readonly toolUseId: string;
  readonly tool: string;
  readonly summary: string;
  readonly risk: ActionRisk;
  readonly input: Readonly<Record<string, unknown>>;
  readonly timer: NodeJS.Timeout;
  /** says what became of it: the owner's answer, the deadline, or the turn ending */
  readonly settle: (allow: boolean, why: 'owner' | 'deadline' | 'turn') => void;
}

/** What one conversation holds: a process that has heard the system prompt and everything since. */
interface Entry {
  readonly session: string;
  readonly system: string;
  /** what the process was started with; a turn that finds the session set to something else replaces it */
  readonly model: string;
  readonly effort: BrainEffort;
  readonly proc: WarmProcess;
  /** what the process was started with beyond model and effort: the mode and, in agent mode, the tools and services it was given */
  readonly agentKey: string;
  /** calls this process has put to the owner and not had answered, by the CLI's request id */
  readonly held: Map<string, Held>;
  systemSent: boolean;
  /** the capabilities the system prompt was written for; a later difference is told in a brief, never by a new prompt */
  capabilities: Capabilities;
  /** the last turn this process was asked, so a brief that assumes it heard everything is only used when it did */
  lastTurn: string | null;
  /** documents this process has been given; a warm turn gives it only the rest */
  readonly heardDocs: Set<string>;
  lastUsed: number;
  /** `total_cost_usd` is cumulative for a process; this is where the last turn left it */
  costBase: number;
  /** settles when the turn using this process has fully let go of it */
  running: Promise<void> | null;
  /** the browser's tabs this process has opened and where they are (`domain/browser.ts`); empty and unused unless `chrome` is on */
  readonly browser: BrowserState;
  /** SA4. Lets go of the process's canvas token and its folder; once */
  readonly forgetCanvas: () => void;
}

/** How long a new turn waits for the previous one to finish unwinding before it abandons that process. */
const UNWIND_WAIT_MS = 3_000;

/** A tool that is running (a page being read, a service answering) is allowed longer than a model that has gone quiet. */
const TOOL_IDLE_MS = 180_000;

/**
 * A real streaming model as the brain, through the Claude Code CLI, so no API
 * key is needed. One long-lived process per conversation (warm.ts) keeps the
 * conversation and the provider's prompt cache; memory is still what was
 * shown, so a warm turn is told only what happened since (`since`) and a cold
 * one is told everything (`full`).
 *
 * Timeouts live here, where events are understood: `firstTokenTimeoutMs`
 * until the first text delta, `idleTimeoutMs` between any two events after
 * it. Either one interrupts the turn, and the process is then discarded:
 * a process that went quiet is not trusted with the next conversation turn.
 */
export function createClaudeCliBrain(deps: ClaudeCliDeps): Brain {
  const { log } = deps;
  const pool = new Map<string, Entry>();
  /** what the owner chose for a conversation (`/model`, `/effort`); a conversation without a choice runs on the server's settings */
  const chosen = new Map<string, { model: string; effort: BrainEffort }>();
  const settingsOf = (session: string): { model: string; effort: BrainEffort } => chosen.get(session) ?? { model: deps.model, effort: deps.effort };

  // v2.1, agent mode. What the owner's configuration offers, what each conversation has switched on, and the mode it is in.
  const agent = deps.agent ?? NO_AGENT;
  const switchedOn = new Map<string, Set<string>>();
  /** `/tools auto` and `/tools ask`: how a conversation's permit prompts are answered; read at each call, so a change is at once */
  const permitsChosen = new Map<string, AgentPermits>();
  const permitsOf = (session: string): AgentPermits => (kill.engaged() ? 'ask' : (permitsChosen.get(session) ?? agent.permits ?? 'ask'));
  // The brain is the agent whenever the server has one; there is no plain beside it. The one exception is the kill switch: while it is
  // engaged the brain has no tools at all (`plain`), until the owner switches them back on.
  const kill = deps.kill ?? NEVER_ENGAGED;
  const modeOf = (_session: string): 'plain' | 'agent' => (agent.enabled && !kill.engaged() ? 'agent' : 'plain');
  /** Everything offered is on until the owner switches it off (`/tools`): it was the owner who offered it. Nothing else can ever be on. */
  const onOf = (session: string): Set<string> => {
    let on = switchedOn.get(session);
    if (on === undefined) {
      on = new Set([...agent.tools, ...agent.services.map((service) => service.name)]);
      switchedOn.set(session, on);
    }
    return on;
  };
  let scratch: string | null = null;
  /** The folder the process starts in: the owner's, or an empty one of ours when none was named (and then no file tool is offered at all). */
  const folder = (): string => {
    if (agent.dir !== null) return agent.dir;
    scratch ??= mkdtempSync(join(tmpdir(), 'conduit-agent-'));
    return scratch;
  };
  const agentRunOf = (session: string): AgentRun | null => {
    if (modeOf(session) !== 'agent') return null;
    const on = onOf(session);
    const builtIns = agent.tools.filter((name) => on.has(name) && (agent.dir !== null || !FILE_TOOLS.includes(name)));
    const services = agent.services.filter((service) => on.has(service.name));
    return {
      builtIns,
      freeReads: services.length === 0 && builtIns.every((name) => name === 'WebSearch' || name === 'WebFetch'),
      mcpConfigs: agent.services.filter((service) => on.has(service.name) && service.config !== '').map((service) => service.config),
      chrome: agent.services.some((service) => service.name === 'chrome') && on.has('chrome'),
      cwd: folder(),
    };
  };
  /** The names of what the model may use on this turn in agent mode (built-in tools and connected services); none in plain mode. */
  const toolNamesOf = (session: string): readonly string[] => {
    const run = agentRunOf(session);
    if (run === null) return [];
    const on = onOf(session);
    return [...run.builtIns, ...agent.services.filter((service) => on.has(service.name)).map((service) => service.name)];
  };
  const agentKeyOf = (session: string): string => {
    const run = agentRunOf(session);
    return run === null ? 'plain' : `agent|${run.builtIns.join(',')}|${run.mcpConfigs.join(',')}|${run.chrome === true ? 'chrome' : ''}`;
  };
  const webOn = (session: string): boolean => {
    const run = agentRunOf(session);
    return run === null ? deps.tools.length > 0 : run.builtIns.some((name) => name === 'WebSearch' || name === 'WebFetch');
  };

  // The system prompt is fixed for a conversation: it is built from what the painter can do and what the server offers,
  // never from the screen or the look, which change within a conversation and belong to each turn's brief.
  const systemFor = (s: Pick<BrainSession, 'capabilities' | 'services'>): string => {
    return buildSystemPrompt({ capabilities: s.capabilities, services: s.services, variant: deps.variant });
  };

  /** SA4. A token for this process and the 0600 file that tells the CLI where the canvas server is and how to knock. */
  const canvasFor = (session: string): { readonly file: string | undefined; readonly forget: () => void } => {
    const link = deps.canvas;
    if (link === undefined) return { file: undefined, forget: () => undefined };
    const token = link.mint(session);
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'conduit-canvas-'));
      const file = join(dir, 'mcp.json');
      writeFileSync(file, JSON.stringify({ mcpServers: { canvas: { type: 'http', url: link.url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
      const made = dir;
      let done = false;
      return {
        file,
        forget: () => {
          if (done) return;
          done = true;
          link.revoke(token);
          rmSync(made, { recursive: true, force: true });
        },
      };
    } catch (error) {
      link.revoke(token);
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      log.warn('canvas_config_failed', { session, message: error instanceof Error ? error.message : String(error) });
      return { file: undefined, forget: () => undefined };
    }
  };

  const makeEntry = (session: string, system: string, capabilities: Capabilities): Entry => {
    const canvas = canvasFor(session);
    return {
      session,
      system,
      ...settingsOf(session),
      proc: startWarmProcess({ bin: deps.bin, tools: deps.tools, ...settingsOf(session), systemPrompt: system, agent: agentRunOf(session), ...(canvas.file === undefined ? {} : { canvas: canvas.file }) }, log),
      agentKey: agentKeyOf(session),
      held: new Map(),
      systemSent: false,
      capabilities,
      lastTurn: null,
      heardDocs: new Set(),
      lastUsed: Date.now(),
      costBase: 0,
      running: null,
      browser: newBrowserState(),
      forgetCanvas: canvas.forget,
    };
  };

  const discard = (entry: Entry): void => {
    if (pool.get(entry.session) === entry) pool.delete(entry.session);
    for (const held of [...entry.held.values()]) held.settle(false, 'turn');
    // The token and the folder go now, not when the process has finished dying: a server that is shutting down does not wait for that.
    entry.forgetCanvas();
    void entry.proc.stop().catch(() => undefined);
  };

  const makeRoom = (): void => {
    while (pool.size >= deps.maxWarm) {
      let oldest: Entry | null = null;
      for (const entry of pool.values()) {
        if (entry.running !== null) continue;
        if (oldest === null || entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      if (oldest === null) return;
      log.info('claude_warm_evicted', { session: oldest.session });
      discard(oldest);
    }
  };

  const sweep = deps.warm
    ? setInterval(() => {
        const now = Date.now();
        for (const entry of [...pool.values()]) {
          if (entry.running === null && now - entry.lastUsed > deps.warmIdleMs) {
            log.info('claude_warm_idle_stopped', { session: entry.session });
            discard(entry);
          }
        }
      }, Math.min(30_000, Math.max(1_000, deps.warmIdleMs / 2)))
    : null;
  sweep?.unref();

  /**
   * The process for this turn and the form of brief it needs. The process is claimed before this returns,
   * synchronously with the decision, so two turns arriving together can never share one.
   */
  async function acquire(request: TurnRequest): Promise<{ entry: Entry; form: BriefForm; reused: boolean; release: () => void }> {
    const { session, context } = request;
    const existing = pool.get(session);
    if (existing?.running) {
      await Promise.race([existing.running, new Promise<void>((resolve) => setTimeout(resolve, UNWIND_WAIT_MS).unref())]);
    }
    const claim = (entry: Entry): (() => void) => {
      let release!: () => void;
      entry.running = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    };
    const current = pool.get(session);
    const wanted = settingsOf(session);
    const stale = current !== undefined && (current.model !== wanted.model || current.effort !== wanted.effort || current.agentKey !== agentKeyOf(session));
    if (deps.warm && current !== undefined && !stale && current.proc.alive && current.running === null && current.proc.contextTokens <= deps.recycleTokens) {
      const heardEverything = current.proc.turns > 0 && current.lastTurn === (context.history.at(-1)?.turn ?? null);
      return { entry: current, form: heardEverything ? 'since' : 'full', reused: current.proc.turns > 0, release: claim(current) };
    }
    if (current !== undefined) {
      const why = stale ? 'settings_changed' : !current.proc.alive ? 'dead' : current.running !== null ? 'busy' : 'recycled';
      log.info('claude_warm_replaced', { session, why, contextTokens: current.proc.contextTokens });
      discard(current);
    }
    if (deps.warm) makeRoom();
    const entry = makeEntry(session, systemFor(context), context.capabilities);
    if (deps.warm) pool.set(session, entry);
    return { entry, form: 'full', reused: false, release: claim(entry) };
  }

  /** One message to the process, with what the log should say of it. */
  interface Outgoing {
    readonly turn: string;
    readonly session: string;
    readonly styles: readonly string[];
    readonly text: string;
    readonly image: Snapshot | null;
    readonly pdfs: readonly Uint8Array[];
    /** v2.1. The user's own pictures for this turn, after the stage's snapshot */
    readonly images: readonly Snapshot[];
    readonly form: BriefForm;
    /** run once the message is on its way: what the process now knows */
    readonly sent: () => void;
    /** a look at the draft or a fix of it: it holds the same process, and so the same tools, but may use none of them */
    readonly noTools?: boolean;
  }

  function outgoingFor(request: TurnRequest, entry: Entry, form: BriefForm): Outgoing {
    const held = request.context.documents ?? [];
    const given = form === 'full' ? held : held.filter((doc) => !entry.heardDocs.has(doc.id));
    return {
      turn: request.turn,
      session: request.session,
      styles: Object.keys(request.context.stage.styles),
      text: buildTurnBrief({ ...request.context, documents: given }, request.input, form, entry.capabilities, {
        model: entry.model,
        effort: entry.effort,
        sees: request.snapshot !== null,
        look: deps.warm && request.look === true,
        web: webOn(request.session),
        mode: modeOf(request.session),
        tools: toolNamesOf(request.session),
        status: deps.status?.() ?? null,
        news: asksWhatsNew(request.input) ? (deps.news?.() ?? null) : null,
      }),
      image: request.snapshot,
      pdfs: (request.pdfs ?? []).filter((pdf) => given.some((doc) => doc.id === pdf.id && doc.kind === 'pdf')).map((pdf) => pdf.bytes),
      images: request.images ?? [],
      form,
      ...(request.quiet === true ? { noTools: true } : {}),
      sent: () => {
        entry.lastTurn = request.turn;
        for (const doc of given) entry.heardDocs.add(doc.id);
      },
    };
  }

  async function* turnOnce(
    out: Outgoing,
    signal: AbortSignal,
    entry: Entry,
    reused: boolean,
    startedAt: number,
    state: { sawText: boolean },
  ): AsyncGenerator<BrainEvent> {
    const turnLog = log.child({ turn: out.turn, session: out.session });
    const { text, pdfs } = out;
    yield { type: 'brief', form: out.form, text, system: entry.systemSent ? null : entry.system, withSnapshot: out.image !== null };
    entry.systemSent = true;
    out.sent();

    const inner = new AbortController();
    const onOuterAbort = (): void => inner.abort();
    signal.addEventListener('abort', onOuterAbort, { once: true });
    if (signal.aborted) inner.abort();

    let timedOut: string | null = null;
    let lookTools = 0;
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number, what: string): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = `${what} (${ms} ms)`;
        inner.abort();
      }, ms);
      timer.unref();
    };
    // Which clock is running depends on what the turn is waiting for. A call held for the owner stops it: the owner has `answerMs`.
    const notTools = new Set<string>();
    const running = new Map<string, { readonly tool: string; readonly summary: string; readonly at: number }>();
    const denied = new Set<string>();
    /** calls the owner's `auto` level let through: their activity events say so */
    const autoAllowed = new Set<string>();
    /** browser calls in flight, so that their results can teach the gate where its tabs are */
    const chromeUses = new Map<string, { readonly id: string; readonly tool: string; readonly input: Readonly<Record<string, unknown>> }>();
    const rearm = (): void => {
      if (entry.held.size > 0) clearTimeout(timer);
      else if (running.size > 0) arm(Math.max(deps.idleTimeoutMs, TOOL_IDLE_MS), 'a tool call took longer than the brain waits for one');
      else if (state.sawText) arm(deps.idleTimeoutMs, 'claude went quiet, longer than CLAUDE_IDLE_TIMEOUT_MS');
      else arm(deps.firstTokenTimeoutMs, 'no first token from claude within CLAUDE_FIRST_TOKEN_TIMEOUT_MS');
    };

    let firstTextAt: number | null = null;
    let facts: ClaudeResultFacts | null = null;
    let failure: string | null = null;
    const box = new Mailbox<BrainEvent>();
    const on = onOf(out.session);

    /** The address of the page a browser call is aimed at, for the confirm control; the gate's own record of it. */
    const pageOf = (call: { readonly tool: string; readonly input: Readonly<Record<string, unknown>> }): string | null => {
      const tab = call.input['tabId'];
      return splitTool(call.tool).service === 'chrome' && typeof tab === 'number' ? (entry.browser.urls.get(tab) ?? null) : null;
    };

    /** The CLI asks before a call. Whatever the answer, it is made here, by `gateCall`, and by the owner for what that says to ask. */
    const handleAsk = (ask: { requestId: string; toolUseId: string; tool: string; input: Readonly<Record<string, unknown>> }): void => {
      // A public name that points at a private number is refused too, which needs the name resolved: the answer waits for that, and for nothing else.
      if (out.noTools !== true && modeOf(out.session) === 'agent' && addressesIn(ask.input).length > 0 && !isCanvasTool(ask.tool)) {
        void deniedAfterResolving(ask.input, agent.allowPrivate).then((why) => {
          if (why === null) return handleAskNow(ask);
          if (inner.signal.aborted) return entry.proc.answer(ask.requestId, false, {}, 'The turn was stopped.');
          denied.add(ask.toolUseId);
          turnLog.info('agent_private_destination', { tool: ask.tool });
          entry.proc.answer(ask.requestId, false, {}, `Not allowed: ${why}. Say so plainly and offer what you can do without it.`);
        });
        return;
      }
      handleAskNow(ask);
    };
    const handleAskNow = (ask: { requestId: string; toolUseId: string; tool: string; input: Readonly<Record<string, unknown>> }): void => {
      const call = { id: ask.toolUseId, tool: ask.tool, input: ask.input };
      // SA4. The canvas tools read the stage and write nothing; the CLI is told to allow them itself, and this is only the net under that.
      if (isCanvasTool(ask.tool) && !inner.signal.aborted) {
        entry.proc.answer(ask.requestId, true, ask.input, '');
        return;
      }
      const verdict = out.noTools === true ? ({ kind: 'deny', risk: 'run', why: 'no tools in a look; write lines' } as const) : modeOf(out.session) === 'agent' ? gateCall(call, agent, on, false, entry.browser, permitsOf(out.session)) : ({ kind: 'deny', risk: 'run', why: kill.engaged() ? 'agent tools have been switched off by the kill switch' : 'this conversation has no tools' } as const);
      const summary = summaryOf(call);
      if (inner.signal.aborted) {
        // The turn was stopped (or timed out) and the model has not heard yet: nothing more is asked of the owner, nothing runs.
        entry.proc.answer(ask.requestId, false, {}, 'The turn was stopped.');
        denied.add(ask.toolUseId);
        return;
      }
      if (verdict.kind === 'allow') {
        entry.proc.answer(ask.requestId, true, ask.input, '');
        if (verdict.permit === 'auto') {
          // Allowed by the owner's `auto` level, not by the owner: said on the strip and in the log, with the risk it would have been asked at.
          autoAllowed.add(ask.toolUseId);
          turnLog.info('agent_auto_allowed', { tool: ask.tool, risk: verdict.risk, permit: 'auto' });
          if (!running.has(ask.toolUseId)) box.push({ type: 'activity', id: ask.toolUseId, tool: ask.tool, summary, state: 'running', ms: null, permit: 'auto' });
        }
        return;
      }
      if (verdict.kind === 'deny') {
        entry.proc.answer(ask.requestId, false, {}, out.noTools === true ? verdict.why : `Not allowed: ${verdict.why}. Say so plainly and offer what you can do without it.`);
        denied.add(ask.toolUseId);
        turnLog.info('agent_denied', { tool: ask.tool, why: verdict.why });
        box.push({ type: 'activity', id: ask.toolUseId, tool: ask.tool, summary, state: 'denied', ms: null });
        return;
      }
      const expiresMs = Date.now() + agent.answerMs;
      const settle = (allow: boolean, why: 'owner' | 'deadline' | 'turn'): void => {
        const held = entry.held.get(ask.requestId);
        if (held === undefined) return;
        entry.held.delete(ask.requestId);
        clearTimeout(held.timer);
        if (allow) {
          entry.proc.answer(ask.requestId, true, ask.input, '');
          box.push({ type: 'activity', id: ask.toolUseId, tool: ask.tool, summary, state: 'running', ms: null });
        } else {
          entry.proc.answer(ask.requestId, false, {}, why === 'owner' ? 'The owner said no. Do not try it another way; say what you could not do and offer what you can.' : 'The owner did not answer in time, which is a no. Do not try it another way; say what you could not do.');
          denied.add(ask.toolUseId);
          box.push({ type: 'activity', id: ask.toolUseId, tool: ask.tool, summary, state: 'denied', ms: null });
        }
        turnLog.info('agent_permission_settled', { tool: ask.tool, risk: verdict.risk, allowed: allow, by: why });
        if (!inner.signal.aborted) rearm();
      };
      const deadline = setTimeout(() => settle(false, 'deadline'), agent.answerMs);
      deadline.unref();
      entry.held.set(ask.requestId, { requestId: ask.requestId, toolUseId: ask.toolUseId, tool: ask.tool, summary, risk: verdict.risk, input: ask.input, timer: deadline, settle });
      turnLog.info('agent_permission_asked', { tool: ask.tool, risk: verdict.risk });
      box.push({ type: 'activity', id: ask.toolUseId, tool: ask.tool, summary, state: 'waiting', ms: null });
      box.push({ type: 'permission', request: ask.requestId, tool: ask.tool, summary, risk: verdict.risk, expiresMs, detail: detailOf(call, pageOf(call)) });
      rearm();
    };

    inner.signal.addEventListener('abort', () => {
      for (const held of [...entry.held.values()]) held.settle(false, 'turn');
    }, { once: true });

    async function* chunks(): AsyncGenerator<string> {
      rearm();
      for await (const event of entry.proc.ask({ text, image: out.image, pdfs, images: out.images }, inner.signal)) {
        if (event.type === 'system' && (event as { subtype?: unknown }).subtype === 'init') {
          const init = event as { tools?: readonly unknown[]; mcp_servers?: readonly unknown[]; model?: string };
          const tools = init.tools?.length ?? 0;
          const mcp = init.mcp_servers?.length ?? 0;
          turnLog.info('claude_init', { model: init.model, effort: entry.effort, requested: entry.model, mode: modeOf(out.session) });
          if (entry.agentKey === 'plain' && (tools > deps.tools.length + (deps.canvas === undefined ? 0 : 6) || mcp > (deps.canvas === undefined ? 0 : 1))) turnLog.warn('claude_not_isolated', { model: init.model, tools, mcp_servers: mcp });
          continue;
        }
        const ask = permissionAskOf(event);
        if (ask !== null) {
          handleAsk(ask);
          continue;
        }
        const withdrawn = cancelledAskOf(event);
        if (withdrawn !== null) {
          const held = entry.held.get(withdrawn);
          if (held !== undefined) {
            entry.held.delete(withdrawn);
            clearTimeout(held.timer);
            box.push({ type: 'activity', id: held.toolUseId, tool: held.tool, summary: held.summary, state: 'denied', ms: null });
            rearm();
          }
          continue;
        }
        // A tool call is told by name and by the one field that names its target, passed through `redactSecrets` (`summaryOf`);
        // its whole input and what it returned never leave this function.
        let toolsChanged = false;
        for (const use of toolUsesOf(event)) {
          // A line of the language is text, never a tool: when the model names a verb as a tool (`scene`, `say`) the call fails at once and is
          // not an event of the turn: it would only show on the activity strip as a failed call.
          if (NOT_TOOLS.has(use.tool.toLowerCase())) {
            notTools.add(use.id);
            continue;
          }
          if (out.noTools === true && !isCanvasTool(use.tool)) {
            // A look at the draft uses no tool. The process refuses the call at once, with a reason the model reads (`refuseTools`, `handleAsk`), and the
            // look goes on; it is not an event of the turn. Only a model that goes on reaching for tools past the refusal is stopped.
            notTools.add(use.id);
            lookTools += 1;
            turnLog.warn('review_used_tool', { tool: use.tool, refused: lookTools });
            if (lookTools > 3) {
              timedOut = 'a look at the draft kept using tools';
              inner.abort();
              break;
            }
            continue;
          }
          toolsChanged = true;
          // SA4. The ordering barrier. The model's call reaches the canvas server over HTTP while the text before it is still on its way through
          // here, so a line it has written and not ended is ended now, and the call is announced after every line before it has been taken:
          // the handler waits for that announcement (250 ms at most) before it reads the stage.
          if (isCanvasTool(use.tool)) yield '\n';
          if (splitTool(use.tool).service === 'chrome') chromeUses.set(use.id, use);
          const summary = summaryOf(use);
          running.set(use.id, { tool: use.tool, summary, at: Date.now() });
          turnLog.info('brain_tool', { tool: use.tool, summary });
          box.push({ type: 'activity', id: use.id, tool: use.tool, summary, state: 'running', ms: null, ...(autoAllowed.has(use.id) ? { permit: 'auto' as const } : {}) });
        }
        // What a browser tool returned is read for tab ids, each tab's address and credential fields, and nothing else (`noteBrowserResult`).
        for (const found of toolResultTextsOf(event)) {
          const use = chromeUses.get(found.id);
          if (use === undefined) continue;
          chromeUses.delete(found.id);
          if (!found.failed && !denied.has(found.id)) noteBrowserResult(entry.browser, use, found.texts);
        }
        for (const result of toolResultsOf(event)) {
          if (notTools.delete(result.id)) continue;
          const began = running.get(result.id);
          if (began === undefined) continue;
          toolsChanged = true;
          running.delete(result.id);
          const state = denied.has(result.id) ? 'denied' : result.failed ? 'failed' : 'done';
          if (state !== 'denied') box.push({ type: 'activity', id: result.id, tool: began.tool, summary: began.summary, state, ms: Date.now() - began.at, ...(autoAllowed.has(result.id) ? { permit: 'auto' as const } : {}) });
        }
        if (!inner.signal.aborted && (toolsChanged || state.sawText)) rearm();
        const delta = textDeltaOf(event);
        if (delta !== null) {
          // An interrupted turn is drained to its result so the process survives; nothing it still says is a line.
          if (inner.signal.aborted) continue;
          if (!state.sawText) {
            state.sawText = true;
            firstTextAt = Date.now();
            rearm();
          }
          yield delta;
          continue;
        }
        if (event.type === 'result') {
          facts = resultFactsOf(event);
          if (!inner.signal.aborted) failure = failureOf(event);
        }
      }
    }

    const pump = (async (): Promise<void> => {
      try {
        for await (const event of brainEventsFromText(chunks(), out.styles)) box.push(event);
        box.close();
      } catch (error) {
        box.fail(error);
      }
    })();

    try {
      yield* box.drain();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onOuterAbort);
      inner.abort();
      await pump;
      for (const held of [...entry.held.values()]) held.settle(false, 'turn');
    }

    if (timedOut !== null) throw errors.brainTimeout(`claude timed out: ${timedOut}`);
    if (failure !== null) throw errors.brainFailed(`claude reported a failure: ${failure}`);

    const f = facts as ClaudeResultFacts | null;
    if (f !== null) {
      const cost = f.totalCostUsd === null ? null : Math.max(0, f.totalCostUsd - entry.costBase);
      if (f.totalCostUsd !== null) entry.costBase = f.totalCostUsd;
      const now = Date.now();
      // An interrupted turn reports zeros for what it never got to measure; zero would be a claim.
      const measured = f.inputTokens + f.cacheReadTokens + f.cacheWriteTokens + f.outputTokens > 0;
      yield {
        type: 'usage',
        usage: {
          inputTokens: measured ? f.inputTokens : null,
          cacheReadTokens: measured ? f.cacheReadTokens : null,
          cacheWriteTokens: measured ? f.cacheWriteTokens : null,
          outputTokens: measured ? f.outputTokens : null,
          thinkingTokens: measured ? f.thinkingTokens : null,
          costUsd: measured ? cost : null,
          firstTextMs: firstTextAt === null ? null : (firstTextAt as number) - startedAt,
          totalMs: now - startedAt,
          warm: reused,
        },
      };
    }
  }

  async function* respond(request: TurnRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    if (signal.aborted) return;
    const startedAt = Date.now();

    for (let attempt = 0; ; attempt += 1) {
      const { entry, form, reused, release } = await acquire(request);
      const state = { sawText: false };
      try {
        yield* turnOnce(outgoingFor(request, entry, form), signal, entry, reused, startedAt, state);
        entry.lastUsed = Date.now();
        return;
      } catch (error) {
        discard(entry);
        // A process that died between turns is only discovered when it is asked; the viewer should never hear of it.
        if (reused && attempt === 0 && !state.sawText && !signal.aborted && error instanceof AppError && error.code === 'brain_failed') {
          log.warn('claude_warm_died_retrying', { session: request.session, message: error.message });
          continue;
        }
        throw error;
      } finally {
        entry.running = null;
        release();
        if (!deps.warm || !entry.proc.alive) discard(entry);
      }
    }
  }

  /**
   * The second message of a turn, to the process that wrote the draft. It is claimed for the length of the look, so that nothing else is
   * asked of it, and given back whatever happens: an abandoned look interrupts the model, reads it to its result, and the process,
   * with the conversation and the cache, goes on to the next turn. Only a process that is silent past the interrupt's grace is let go.
   */
  async function* review(request: ReviewRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    yield* followUp(
      {
        turn: request.turn,
        session: request.session,
        styles: request.styles,
        text: buildReviewBrief({
          asked: askedOf(request.input),
          sight: request.sight,
          problems: request.problems,
          picture: request.picture !== null,
          ...(deps.canvas === undefined ? {} : { canvas: true }),
          pass: request.pass,
          ...(request.form === undefined ? {} : { form: request.form }),
          ...(request.placed === undefined ? {} : { placed: request.placed }),
          ...(request.critic === undefined ? {} : { critic: request.critic }),
          ...(request.of === undefined ? {} : { of: request.of }),
          ...(request.standing === undefined ? {} : { standing: request.standing }),
          ...(request.eyes === undefined ? {} : { eyes: request.eyes }),
          ...(request.written === undefined ? {} : { written: request.written }),
        }),
      },
      request.picture,
      signal,
      // A repair mends the answer at rest, whenever it is: the conversation's own process is the one to ask, whatever it wrote last.
      request.form === 'repair',
    );
  }

  /** v3 (WS5). The reader's refusals, said to the process that wrote the turn: the same claim of the process as a look, and no tools. */
  async function* amend(request: AmendRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    yield* followUp({ turn: request.turn, session: request.session, styles: request.styles, text: request.text }, null, signal);
  }

  async function* followUp(message: { readonly turn: string; readonly session: string; readonly styles: readonly string[]; readonly text: string }, image: Snapshot | null, signal: AbortSignal, anyTurn = false): AsyncGenerator<BrainEvent> {
    if (signal.aborted) return;
    const entry = pool.get(message.session);
    if (entry === undefined || !entry.proc.alive || entry.running !== null || (!anyTurn && entry.lastTurn !== message.turn)) {
      throw errors.brainFailed('the process that wrote the draft is no longer here to look at it');
    }
    let release!: () => void;
    entry.running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedAt = Date.now();
    const out: Outgoing = {
      turn: message.turn,
      session: message.session,
      styles: message.styles,
      text: message.text,
      image,
      pdfs: [],
      images: [],
      form: 'since',
      sent: () => undefined,
      noTools: true,
    };
    entry.proc.refuseTools(true);
    try {
      for await (const event of turnOnce(out, signal, entry, true, startedAt, { sawText: false })) {
        // `ok`, alone on a line, is the draft kept: it is not a line and not a rejection.
        if (event.type === 'reject' && isKeep(event.raw)) continue;
        yield event;
      }
      entry.lastUsed = Date.now();
    } catch (error) {
      // A look that timed out or failed is not trusted with the conversation again, unless the interrupt was answered and it is still here.
      if (!entry.proc.alive) discard(entry);
      throw error;
    } finally {
      entry.proc.refuseTools(false);
      entry.running = null;
      release();
      if (!entry.proc.alive) discard(entry);
    }
  }

  return {
    id: 'claude-cli',
    respond,
    ...(deps.warm ? { review, amend } : {}),
    open(session) {
      if (!deps.warm) return;
      try {
        const existing = pool.get(session.session);
        if (existing !== undefined && (existing.running !== null || existing.proc.alive)) return;
        if (existing !== undefined) discard(existing);
        makeRoom();
        pool.set(session.session, makeEntry(session.session, systemFor(session), session.capabilities));
      } catch (error) {
        log.warn('claude_open_failed', { session: session.session, message: error instanceof Error ? error.message : String(error) });
      }
    },
    choice: (session) => ({ configurable: true, ...settingsOf(session), ...(agent.enabled ? { mode: modeOf(session), modes: deps.modes ?? (['agent'] as const), permits: permitsOf(session) } : {}) }) satisfies BrainChoice,
    choose(session, change: BrainChange) {
      const { mode, permits, ...rest } = change;
      if (permits !== undefined) {
        if (!agent.enabled) throw errors.badRequest('permits are an agent mode setting, and agent mode is not offered by this server (AGENT=on)');
        // Read at each call by the gate; the process is not started again for it.
        permitsChosen.set(session, permits);
        if (mode === undefined && Object.keys(rest).length === 0) return { configurable: true, ...settingsOf(session), mode: modeOf(session), modes: deps.modes ?? (['agent'] as const), permits: permitsOf(session) };
      }
      if (mode !== undefined && mode !== 'steward') {
        if (mode === 'agent' && !agent.enabled) throw errors.badRequest('agent mode is not offered by this server (AGENT=on)');
        // The brain is the agent; there is no plain beside it. A request for it is refused in words, not obeyed or ignored.
        if (mode === 'plain' && agent.enabled) throw errors.badRequest('there is no plain mode: the brain can always use its tools, and asks you first before anything but reading');
        if (mode === 'agent' && kill.engaged()) throw errors.conflict('agent tools were switched off by the kill switch and stay off until the owner switches them back on (/stop-all resume)');
      }
      const next = { ...settingsOf(session), ...rest };
      chosen.set(session, next);
      // The warm process was started with the old settings. One that is mid-turn finishes it and is replaced by the next turn (acquire sees it is stale).
      const entry = pool.get(session);
      if (entry !== undefined && entry.running === null) {
        log.info('claude_warm_replaced', { session, why: 'settings_changed' });
        discard(entry);
      }
      return { configurable: true, ...next, ...(agent.enabled ? { mode: modeOf(session), modes: deps.modes ?? (['agent'] as const), permits: permitsOf(session) } : {}) };
    },
    ...(agent.enabled
      ? {
          permit(session: string, request: string, allow: boolean): void {
            // Only the owner's `permit` reaches here; a request that is unknown, answered or from another conversation is ignored.
            pool.get(session)?.held.get(request)?.settle(allow, 'owner');
          },
          tools: (session: string): readonly ToolChoice[] => (kill.engaged() ? [] : toolChoices(agent, onOf(session))),
          setTool(session: string, name: string, on: boolean): readonly ToolChoice[] {
            const offered = agent.tools.includes(name) || agent.services.some((service) => service.name === name);
            if (offered) {
              const set = onOf(session);
              if (on) set.add(name);
              else set.delete(name);
            }
            return toolChoices(agent, onOf(session));
          },
        }
      : {}),
    release(session) {
      chosen.delete(session);
      permitsChosen.delete(session);
      switchedOn.delete(session);
      const entry = pool.get(session);
      if (entry !== undefined) discard(entry);
    },
    killAll() {
      // Every held call is told no (so the CLI is not left waiting on a question), and every process is let go without waiting for its `close`.
      // The tabs the brain opened in the owner's Chrome belong to the extension's tab group, which only a call through the CLI could close:
      // with the CLI gone there is none, so they are counted and said, and the owner closes the group.
      const all = [...pool.values()];
      const browserTabs = all.reduce((sum, entry) => sum + entry.browser.tabs.size, 0);
      pool.clear();
      for (const entry of all) {
        for (const held of [...entry.held.values()]) {
          try {
            held.settle(false, 'turn');
          } catch (error) {
            log.warn('claude_kill_settle_failed', { session: entry.session, error });
          }
        }
        entry.forgetCanvas();
        void entry.proc.stop().catch(() => undefined);
      }
      log.warn('claude_killed_all', { processes: all.length, browserTabs });
      return { processes: all.length, browserTabs };
    },
    async close() {
      if (sweep) clearInterval(sweep);
      const all = [...pool.values()];
      pool.clear();
      for (const entry of all) for (const held of [...entry.held.values()]) held.settle(false, 'turn');
      for (const entry of all) entry.forgetCanvas();
      await Promise.all(all.map((entry) => entry.proc.stop().catch(() => undefined)));
      if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
    },
  };
}
