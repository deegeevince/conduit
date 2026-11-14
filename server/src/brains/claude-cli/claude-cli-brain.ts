import { buildSystemPrompt, buildTurnBrief } from '@conduit/language';
import type { BrainChange, BrainChoice, BrainEffort, PromptVariant } from '@conduit/language';
import type { BriefForm, Capabilities } from '@conduit/language';
import { buildReviewBrief, isKeep } from '@conduit/language';
import type { Brain, BrainEvent, BrainSession, ReviewRequest, Snapshot, TurnRequest } from '../../domain/brain';
import { askedOf } from '../../domain/review';
import { brainEventsFromText } from '../../domain/lines';
import { AppError, errors } from '../../errors';
import type { Logger } from '../../log';
import { startWarmProcess } from './warm';
import type { WarmProcess } from './warm';
import { failureOf, resultFactsOf, textDeltaOf } from './stream-json';
import type { ClaudeResultFacts } from './stream-json';

export interface ClaudeCliDeps {
  readonly log: Logger;
  readonly bin: string;
  readonly model: string;
  readonly firstTokenTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly effort: 'low' | 'medium' | 'high';
  readonly variant: PromptVariant;
  /** keep one process per conversation between turns (see warm.ts); false is v0's fresh process per turn */
  readonly warm: boolean;
  readonly maxWarm: number;
  readonly warmIdleMs: number;
  readonly recycleTokens: number;
}

/** What one conversation holds: a process that has heard the system prompt and everything since. */
interface Entry {
  readonly session: string;
  readonly system: string;
  /** what the process was started with; a turn that finds the session set to something else replaces it */
  readonly model: string;
  readonly effort: BrainEffort;
  readonly proc: WarmProcess;
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
}

/** How long a new turn waits for the previous one to finish unwinding before it abandons that process. */
const UNWIND_WAIT_MS = 3_000;

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

  // The system prompt is fixed for a conversation: it is built from what the painter can do and what the server offers,
  // never from the screen or the look, which change within a conversation and belong to each turn's brief.
  const systemFor = (s: Pick<BrainSession, 'capabilities' | 'services'>): string => {
    return buildSystemPrompt({ capabilities: s.capabilities, services: s.services, variant: deps.variant });
  };

  const makeEntry = (session: string, system: string, capabilities: Capabilities): Entry => ({
    session,
    system,
    ...settingsOf(session),
    proc: startWarmProcess({ bin: deps.bin, ...settingsOf(session), systemPrompt: system }, log),
    systemSent: false,
    capabilities,
    lastTurn: null,
    heardDocs: new Set(),
    lastUsed: Date.now(),
    costBase: 0,
    running: null,
  });

  const discard = (entry: Entry): void => {
    if (pool.get(entry.session) === entry) pool.delete(entry.session);
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
    const stale = current !== undefined && (current.model !== wanted.model || current.effort !== wanted.effort);
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
    readonly form: BriefForm;
    /** run once the message is on its way: what the process now knows */
    readonly sent: () => void;
  }

  function outgoingFor(request: TurnRequest, entry: Entry, form: BriefForm): Outgoing {
    const held = request.context.documents ?? [];
    const given = form === 'full' ? held : held.filter((doc) => !entry.heardDocs.has(doc.id));
    return {
      turn: request.turn,
      session: request.session,
      styles: Object.keys(request.context.stage.styles),
      text: buildTurnBrief({ ...request.context, documents: given }, request.input, form, entry.capabilities),
      image: request.snapshot,
      pdfs: (request.pdfs ?? []).filter((pdf) => given.some((doc) => doc.id === pdf.id && doc.kind === 'pdf')).map((pdf) => pdf.bytes),
      form,
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
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number, what: string): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = `${what} (${ms} ms)`;
        inner.abort();
      }, ms);
      timer.unref();
    };

    let firstTextAt: number | null = null;
    let facts: ClaudeResultFacts | null = null;
    let failure: string | null = null;

    async function* chunks(): AsyncGenerator<string> {
      arm(deps.firstTokenTimeoutMs, 'no first token from claude within CLAUDE_FIRST_TOKEN_TIMEOUT_MS');
      for await (const event of entry.proc.ask({ text, image: out.image, pdfs }, inner.signal)) {
        if (state.sawText) arm(deps.idleTimeoutMs, 'claude went quiet, longer than CLAUDE_IDLE_TIMEOUT_MS');
        if (event.type === 'system' && (event as { subtype?: unknown }).subtype === 'init') {
          const init = event as { tools?: readonly unknown[]; mcp_servers?: readonly unknown[]; model?: string };
          const tools = init.tools?.length ?? 0;
          const mcp = init.mcp_servers?.length ?? 0;
          turnLog.info('claude_init', { model: init.model, effort: entry.effort, requested: entry.model });
          if (tools > 0 || mcp > 0) turnLog.warn('claude_not_isolated', { model: init.model, tools, mcp_servers: mcp });
          continue;
        }
        const delta = textDeltaOf(event);
        if (delta !== null) {
          // An interrupted turn is drained to its result so the process survives; nothing it still says is a line.
          if (inner.signal.aborted) continue;
          if (!state.sawText) {
            state.sawText = true;
            firstTextAt = Date.now();
            arm(deps.idleTimeoutMs, 'claude went quiet, longer than CLAUDE_IDLE_TIMEOUT_MS');
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

    try {
      yield* brainEventsFromText(chunks(), out.styles);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onOuterAbort);
      inner.abort();
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
    if (signal.aborted) return;
    const entry = pool.get(request.session);
    if (entry === undefined || !entry.proc.alive || entry.running !== null || entry.lastTurn !== request.turn) {
      throw errors.brainFailed('the process that wrote the draft is no longer here to look at it');
    }
    let release!: () => void;
    entry.running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedAt = Date.now();
    const out: Outgoing = {
      turn: request.turn,
      session: request.session,
      styles: request.styles,
      text: buildReviewBrief({ asked: askedOf(request.input), sight: request.sight, problems: request.problems, picture: request.picture !== null, pass: request.pass }),
      image: request.picture,
      pdfs: [],
      form: 'since',
      sent: () => undefined,
    };
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
      entry.running = null;
      release();
      if (!entry.proc.alive) discard(entry);
    }
  }

  return {
    id: 'claude-cli',
    respond,
    ...(deps.warm ? { review } : {}),
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
    choice: (session) => ({ configurable: true, ...settingsOf(session) }) satisfies BrainChoice,
    choose(session, change: BrainChange) {
      const next = { ...settingsOf(session), ...change };
      chosen.set(session, next);
      // The warm process was started with the old settings. One that is mid-turn finishes it and is replaced by the next turn (acquire sees it is stale).
      const entry = pool.get(session);
      if (entry !== undefined && entry.running === null) {
        log.info('claude_warm_replaced', { session, why: 'settings_changed' });
        discard(entry);
      }
      return { configurable: true, ...next };
    },
    release(session) {
      chosen.delete(session);
      const entry = pool.get(session);
      if (entry !== undefined) discard(entry);
    },
    async close() {
      if (sweep) clearInterval(sweep);
      const all = [...pool.values()];
      pool.clear();
      await Promise.all(all.map((entry) => entry.proc.stop().catch(() => undefined)));
    },
  };
}
