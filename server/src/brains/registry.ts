import type { BrainChange, BrainChoice, BrainMode } from '@conduit/language';
import type { AgentSettings } from '../domain/agent';
import type { Brain, BrainRegistry, ReviewRequest } from '../domain/brain';
import { errors } from '../errors';
import type { BrainSettings } from '../env';
import type { Logger } from '../log';
import { createClaudeCliBrain } from './claude-cli/claude-cli-brain';
import { createRelayBrain } from './relay/relay-brain';
import type { RelayHub } from './relay/relay-hub';
import { createReplayBrain } from './replay/replay-brain';

export interface BrainsDeps {
  readonly settings: BrainSettings;
  readonly log: Logger;
  /** shared with the relay routes; only used when the relay brain is selected */
  readonly relayHub: RelayHub;
  /**
   * v2.1. What agent mode may use, and the kinds of mind a session may choose. The configured brain answers `choice`, `choose`, `tools`,
   * `setTool` and `permit` from these; a session in `steward` has its turns handed to `relayHub` (`withStewardMode`).
   */
  readonly agent?: AgentSettings;
  readonly modes?: readonly BrainMode[];
}

/**
 * Builds the configured brain plus the replay brain, which always exists
 * because demo turns are answered by it whatever BRAIN says.
 */
export function createBrains(deps: BrainsDeps): BrainRegistry {
  const { settings, log } = deps;
  const replay = createReplayBrain({ log, defaultScript: settings.kind === 'replay' ? settings.script : null });
  let configured: Brain;
  switch (settings.kind) {
    case 'replay':
      configured = replay;
      break;
    case 'relay':
      configured = createRelayBrain(deps.relayHub);
      break;
    case 'claude-cli':
      configured = createClaudeCliBrain({
        log,
        bin: settings.bin,
        model: settings.model,
        firstTokenTimeoutMs: settings.firstTokenTimeoutMs,
        idleTimeoutMs: settings.idleTimeoutMs,
        tools: settings.tools,
        effort: settings.effort,
        variant: settings.variant,
        warm: settings.warm,
        maxWarm: settings.maxWarm,
        warmIdleMs: settings.warmIdleMs,
        recycleTokens: settings.recycleTokens,
        ...(deps.agent === undefined ? {} : { agent: deps.agent }),
        ...(deps.modes === undefined ? {} : { modes: deps.modes }),
      });
      break;
  }
  const all = configured === replay ? [replay] : [configured, replay];
  const offered = deps.modes ?? (['plain'] as const);
  if (offered.includes('steward') && settings.kind === 'claude-cli') configured = withStewardMode(configured, createRelayBrain(deps.relayHub), offered);
  return {
    configured,
    forInput: (input) => (input.kind === 'demo' || input.kind === 'script' ? replay : configured),
    close: async () => {
      await Promise.all(all.map((brain) => brain.close?.()));
    },
  };
}

/**
 * A brain that can be set to `steward` for one conversation (`/brain steward`): that conversation's turns, and the looks at them, are
 * handed to the relay for the steward's own Claude Code session to claim and answer (`pnpm relay listen`). The conversation's other
 * settings (model, effort, tools) stay with the real brain and come back untouched when it is set back. A conversation in `steward` has
 * no tools of its own: whatever the steward does, it does in its own session, under its own permissions.
 */
function withStewardMode(real: Brain, relay: Brain, offered: readonly BrainMode[]): Brain {
  const stewarded = new Set<string>();
  const realReview = real.review?.bind(real);
  const relayReview = relay.review?.bind(relay);
  const modeChoice = (session: string, choice: BrainChoice): BrainChoice => ({ ...choice, mode: stewarded.has(session) ? 'steward' : (choice.mode ?? 'plain'), modes: offered });
  return {
    ...real,
    respond: (request, signal) => (stewarded.has(request.session) ? relay.respond(request, signal) : real.respond(request, signal)),
    ...(realReview === undefined || relayReview === undefined ? {} : { review: (request: ReviewRequest, signal: AbortSignal) => (stewarded.has(request.session) ? relayReview(request, signal) : realReview(request, signal)) }),
    choice: (session) => modeChoice(session, real.choice?.(session) ?? { configurable: false, model: null, effort: null }),
    choose(session, change: BrainChange) {
      if (change.mode === 'steward') {
        if (!offered.includes('steward')) throw errors.badRequest('steward mode is not offered by this server (STEWARD=on)');
        stewarded.add(session);
        const rest: BrainChange = { ...(change.model === undefined ? {} : { model: change.model }), ...(change.effort === undefined ? {} : { effort: change.effort }) };
        return modeChoice(session, real.choose?.(session, rest) ?? real.choice?.(session) ?? { configurable: false, model: null, effort: null });
      }
      if (change.mode !== undefined) stewarded.delete(session);
      return modeChoice(session, real.choose?.(session, change) ?? real.choice?.(session) ?? { configurable: false, model: null, effort: null });
    },
    permit: (session, request, allow) => {
      if (!stewarded.has(session)) real.permit?.(session, request, allow);
    },
    tools: (session) => (stewarded.has(session) ? [] : (real.tools?.(session) ?? [])),
    setTool: (session, name, on) => (stewarded.has(session) ? [] : (real.setTool?.(session, name, on) ?? [])),
    release(session) {
      stewarded.delete(session);
      real.release?.(session);
    },
  };
}
