import { DEMOS, FIRST_LOAD_DEMO, parseReplayDirective } from '@conduit/language';
import type { Brain, BrainEvent, TurnRequest } from '../../domain/brain';
import { brainEventsFromText } from '../../domain/lines';
import type { Logger } from '../../log';
import { loadScript } from './scripts';

export interface ReplayDeps {
  readonly log: Logger;
  /** the script played for a prompt when BRAIN=replay; null means: the script named by the prompt, else the first-load demo */
  readonly defaultScript: string | null;
  /** characters per second the fixture is streamed at, to feel like a model writing */
  readonly charsPerSecond?: number;
}

const DEFAULT_CHARS_PER_SECOND = 240;

/** Resolves true after `ms`, or false at once if the signal aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const KIND_DEMOS: readonly (readonly [RegExp, string])[] = [
  [/\b(chart|graph|plot|candles?|stock|price|prices|revenue|trend)\b/, 'charts'],
  [/\b(slider|control|explor|interactive|what if|simulat|toggle|button)\w*/, 'explorable'],
  [/\b(flow|diagram|tree|cycle|timeline|pipeline|process|map of|architecture|how does|works)\b/, 'diagrams'],
];

function scriptFor(request: TurnRequest, defaultScript: string | null): string {
  const { input } = request;
  if (input.kind === 'demo') return input.script;
  if (defaultScript !== null) return defaultScript;
  const said = input.kind === 'script' ? '' : input.text.trim().toLowerCase();
  const named = DEMOS.find((demo) => demo.name === said)?.name;
  if (named !== undefined) return named;
  // The battery's prompts have no demo of their own: the demo of the kind of answer they ask for stands in, when the language has one.
  const standIn = KIND_DEMOS.find(([pattern, demo]) => pattern.test(said) && DEMOS.some((candidate) => candidate.name === demo));
  return standIn?.[1] ?? FIRST_LOAD_DEMO;
}

/**
 * Plays a fixture script as if a model were writing it: chunk by chunk, at a
 * model's speed, honouring `#! stall` directives. Deterministic: the same
 * script always produces the same chunks with the same delays.
 */
export function createReplayBrain(deps: ReplayDeps): Brain {
  const perSecond = deps.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;

  async function* chunks(source: string, signal: AbortSignal): AsyncGenerator<string> {
    for (const raw of source.split('\n')) {
      const directive = parseReplayDirective(raw);
      if (directive !== null) {
        if (!(await pause(directive.seconds * 1000, signal))) return;
        continue;
      }
      if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
      if (!(await pause((raw.length / perSecond) * 1000, signal))) return;
      yield `${raw}\n`;
    }
  }

  async function* respond(request: TurnRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
    if (request.input.kind === 'script') {
      yield { type: 'brief', form: 'script', text: request.input.text, system: null, withSnapshot: false };
      // The user's own lines: played exactly as a fixture is, with nothing read from disk.
      deps.log.debug('replay.start', { turn: request.turn, script: '(pasted)' });
      yield* brainEventsFromText(chunks(request.input.text, signal), Object.keys(request.context.stage.styles));
      return;
    }
    const name = scriptFor(request, deps.defaultScript);
    deps.log.debug('replay.start', { turn: request.turn, script: name });
    const source = await loadScript(name);
    yield { type: 'brief', form: 'script', text: `fixture ${name}`, system: null, withSnapshot: false };
    yield* brainEventsFromText(chunks(source, signal), Object.keys(request.context.stage.styles));
  }

  return { id: 'replay', respond };
}
