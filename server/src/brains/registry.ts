import type { Brain, BrainRegistry } from '../domain/brain';
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
        effort: settings.effort,
        variant: settings.variant,
        warm: settings.warm,
        maxWarm: settings.maxWarm,
        warmIdleMs: settings.warmIdleMs,
        recycleTokens: settings.recycleTokens,
      });
      break;
  }
  const all = configured === replay ? [replay] : [configured, replay];
  return {
    configured,
    forInput: (input) => (input.kind === 'demo' || input.kind === 'script' ? replay : configured),
    close: async () => {
      await Promise.all(all.map((brain) => brain.close?.()));
    },
  };
}
