// A check of the claude-cli brain without the server. Each argument is one turn of one conversation:
//   pnpm --filter @conduit/server exec tsx src/brains/claude-cli/probe.ts "pixel art of a fox" "now make it blue"
// Options: --image <jpeg|png>   attach it to the first turn as the snapshot of the stage
//          --interrupt <ms>     abort the first turn after this long (the next turn should be answered by the same process)
//          --pause <ms>         wait between turns (to kill the process by hand)
//          --sessions <n>       turn i belongs to session i mod n (pool and eviction checks)
// Prints every event with the time since its request, the brief's form, and the usage line.
// Defaults to haiku; set CLAUDE_MODEL for anything else. Stops its process when it is done.

import { readFileSync } from 'node:fs';
import { EMPTY_STAGE, FULL_CAPABILITIES, LEAD_WINDOW, NO_SERVICES, REFERENCE_SCREEN, serializeLine } from '@conduit/language';
import type { TurnMemory } from '@conduit/language';
import type { Snapshot, TurnRequest } from '../../domain/brain';
import { loadEnv, processEnvironment } from '../../env';
import { AppError } from '../../errors';
import { createLogger } from '../../log';
import { createClaudeCliBrain } from './claude-cli-brain';
import { warmArguments } from './warm';

const args = process.argv.slice(2);
const prompts: string[] = [];
let imagePath: string | null = null;
let interruptMs: number | null = null;
let sessions = 1;
let pauseMs = 0;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] ?? '';
  if (arg === '--image') imagePath = args[(i += 1)] ?? null;
  else if (arg === '--interrupt') interruptMs = Number(args[(i += 1)]);
  else if (arg === '--pause') pauseMs = Number(args[(i += 1)]);
  else if (arg === '--sessions') sessions = Math.max(1, Number(args[(i += 1)]));
  else prompts.push(arg);
}
if (prompts.length === 0) {
  process.stderr.write('usage: probe.ts [--image file] [--interrupt ms] [--sessions n] "first prompt" ["second prompt" ...]\n');
  process.exit(2);
}
if (prompts.length === 1 && imagePath === null) prompts.push('Now say the same thing again, but shorter.');

const source = processEnvironment();
const env = loadEnv({ ...source, BRAIN: 'claude-cli', CLAUDE_MODEL: source['CLAUDE_MODEL'] ?? 'haiku' });
if (env.brain.kind !== 'claude-cli') throw new Error('unreachable');
const settings = env.brain;
const log = createLogger(env.logLevel);

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

let snapshot: Snapshot | null = null;
if (imagePath !== null) {
  const bytes = readFileSync(imagePath);
  snapshot = { mime: imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', bytes: new Uint8Array(bytes), width: 0, height: 0 };
}

const brain = createClaudeCliBrain({ log, ...settings });
const controller = new AbortController();
let interrupting = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    controller.abort();
    void brain.close?.().finally(() => process.exit(130));
  });
}

const histories = new Map<string, TurnMemory[]>();
const session = { capabilities: FULL_CAPABILITIES, screen: REFERENCE_SCREEN, services: NO_SERVICES };
const argv = warmArguments({ bin: settings.bin, model: settings.model, effort: settings.effort, thinking: settings.thinking, tools: settings.tools, systemPrompt: '<system prompt>' });
out(`${settings.bin} ${argv.map((a) => JSON.stringify(a)).join(' ')}   (warm ${settings.warm ? 'on' : 'off'})`);
for (let s = 0; s < sessions; s += 1) brain.open?.({ session: `probe${s}`, ...session });

let exit = 0;
try {
  for (const [index, text] of prompts.entries()) {
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const id = `probe${index % sessions}`;
    const history = histories.get(id) ?? [];
    const request: TurnRequest = {
      turn: `t${index + 1}`,
      session: id,
      input: { kind: 'prompt', text },
      context: { ...session, lead: LEAD_WINDOW, stage: EMPTY_STAGE, history, heard: [] },
      snapshot: index === 0 ? snapshot : null,
    };
    out(`\n--- turn ${index + 1} (${id}): ${text}`);
    const turnAbort = new AbortController();
    controller.signal.addEventListener('abort', () => turnAbort.abort(), { once: true });
    const started = Date.now();
    const stamp = (): string => `${((Date.now() - started) / 1000).toFixed(2).padStart(6)}s`;
    const timer = index === 0 && interruptMs !== null ? setTimeout(() => { interrupting = true; turnAbort.abort(); }, interruptMs) : undefined;
    const shown: string[] = [];
    try {
      for await (const event of brain.respond(request, turnAbort.signal)) {
        if (event.type === 'line') {
          const written = serializeLine(event.line);
          shown.push(written);
          out(`${stamp()}  ${written}${event.issues.length > 0 ? `   [${event.issues.map((i) => i.message).join('; ')}]` : ''}`);
        } else if (event.type === 'reject') out(`${stamp()}  REJECT ${JSON.stringify(event.raw)}   [${event.issues.map((i) => i.message).join('; ')}]`);
        else if (event.type === 'usage') {
          const u = event.usage;
          const read = u.cacheReadTokens ?? 0;
          const total = (u.inputTokens ?? 0) + read + (u.cacheWriteTokens ?? 0);
          out(`${stamp()}  USAGE ${JSON.stringify(u)}   cache read ${total === 0 ? 'n/a' : `${Math.round((100 * read) / total)}%`}`);
        } else if (event.type === 'tool') out(`${stamp()}  TOOL ${event.tool} ${event.target ?? ''}`);
        else if (event.type === 'activity') out(`${stamp()}  TOOL ${event.tool} ${event.state}: ${event.summary}`);
        else if (event.type === 'typing') continue;
        else if (event.type === 'model') out(`${stamp()}  MODEL ${event.model} (effort ${event.effort})`);
        else if (event.type === 'permission') out(`${stamp()}  ASKS ${event.tool} (${event.risk}): ${event.summary}`);
        else out(`${stamp()}  BRIEF ${event.form}, ${event.text.length} characters${event.system === null ? '' : `, with system prompt ${event.system.length}`}${event.withSnapshot ? ', with snapshot' : ''}`);
      }
      out(`${stamp()}  ${turnAbort.signal.aborted ? 'interrupted' : 'done'}`);
    } catch (error) {
      out(`${stamp()}  FAILED ${error instanceof AppError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}`);
      exit = 1;
    } finally {
      clearTimeout(timer);
    }
    histories.set(id, [
      ...history,
      {
        turn: request.turn,
        input: request.input,
        outcome: interrupting && index === 0 ? 'interrupted' : 'finished',
        playhead: null,
        shown: shown.map((t, i) => ({ id: `l${i}`, kind: 'text' as const, text: t, struck: false, partial: false })),
        sight: null,
        skippedAt: null,
        problems: [],
        snapshot: false,
      },
    ]);
  }
} finally {
  await brain.close?.();
}
process.exitCode = exit;
