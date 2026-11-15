// The slash commands: one line starting with `/` is for the app, never for the brain. `APP_COMMANDS` (language/src/wire.ts)
// is the list: `/help` prints it, the brain's brief is made from it, and this file parses exactly those names.

import { APP_COMMANDS, HIDDEN_COMMANDS, BRAIN_EFFORTS, BRAIN_MODELS, BRAIN_MODES, LOOK_IDS, REFINE_LIMITS } from '@conduit/language';
import type { AppCommandName, BrainChange, BrainChoice, BrainEffort, BrainMode, BrainModel, LookId } from '@conduit/language';

export type ExportFormat = 'png' | 'svg' | 'film' | 'conversation' | 'pdf' | 'script';

/** What a line starting with `/` asks for. */
export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'show'; readonly setting: 'model' | 'effort' | 'brain' }
  | { readonly kind: 'set'; readonly change: BrainChange }
  | { readonly kind: 'tools'; readonly change: { readonly name: string; readonly on: boolean } | null }
  | { readonly kind: 'new' }
  | { readonly kind: 'status' }
  | { readonly kind: 'asks'; readonly clear: boolean }
  | { readonly kind: 'look'; readonly look: LookId | null }
  | { readonly kind: 'review'; readonly on: boolean | null; /** v3. `/review repair on|off`: the server tidies an answer after the critic has judged it */ readonly repair?: boolean | null }
  | { readonly kind: 'better'; readonly passes: number }
  | { readonly kind: 'stop' }
  | { readonly kind: 'stop-all'; readonly resume: boolean }
  | { readonly kind: 'usage' }
  | { readonly kind: 'show-all' }
  | { readonly kind: 'copy'; readonly what: 'script' | 'answer' }
  | { readonly kind: 'export'; readonly format: ExportFormat }
  | { readonly kind: 'lines'; readonly on: boolean | null }
  | { readonly kind: 'capture' }
  /** SK1. `/skills [words]` lists the owner's skills as a page (filtered by the words); `/skills refresh` reads the folders again */
  | { readonly kind: 'skills'; readonly query: string; readonly refresh: boolean }
  /** SK1. `/skill <name> [words]` holds that skill for the next message and sends the words with it (none: the skill stays held) */
  | { readonly kind: 'skill'; readonly name: string; readonly words: string }
  | { readonly kind: 'refused'; readonly message: string };

const EXPORT_FORMATS: readonly ExportFormat[] = ['png', 'svg', 'film', 'conversation', 'pdf', 'script'];

/** A command's name as the list spells it, or null for a word that is not one. */
function nameOf(word: string): AppCommandName | null {
  const found = APP_COMMANDS.find((command) => command.name === word);
  return found === undefined ? null : found.name;
}

/** The list as one line, for a status line or a refusal. */
export const HELP = `/${APP_COMMANDS.filter((command) => !HIDDEN_COMMANDS.includes(command.name)).map((command) => command.name).join(' /')}`;

/**
 * SK1. The two commands of the owner's skills. They are the app's, like the others, but they are not in `APP_COMMANDS`: that list is made into the
 * brain's note of the app, which is held to a budget, and the brain has nothing to say about a skill the person holds. `/help` shows them.
 */
export const SKILL_COMMANDS = [
  { name: 'skills', args: '[words|refresh]', gist: 'your own skills, read only; words narrow the list' },
  { name: 'skill', args: '<name> [words]', gist: 'hold a skill for the next message, and send the words with it' },
] as const;

/** What a command's arguments look like, written so they can sit in a table cell (a bar would end the cell). */
export function usageOf(command: { readonly name: string; readonly args: string }): string {
  const args = command.args.replaceAll('|', ' or ');
  return args === '' ? `/${command.name}` : `/${command.name} ${args}`;
}

/** Whether the words are a command rather than something to ask. A path or a date with a slash inside is not: only a leading `/` counts. */
export function isCommand(text: string): boolean {
  return text.startsWith('/');
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
  return allowed.find((item) => item === value) ?? null;
}

export function parseCommand(text: string): Command {
  const [name = '', ...rest] = text.trim().split(/\s+/);
  const word = name.slice(1).toLowerCase();
  const first = (rest[0] ?? '').toLowerCase();
  // SK1. `/skill` takes the words after the name as typed, not split and lower-cased
  if (word === 'skills') {
    const query = rest.join(' ').trim();
    return { kind: 'skills', query: query.toLowerCase() === 'refresh' ? '' : query, refresh: query.toLowerCase() === 'refresh' };
  }
  if (word === 'skill') {
    const typed = text.trim().replace(/^\/skill\s*/i, '');
    if (typed === '') return { kind: 'refused', message: '/skill: say which, like "/skill pdf" or "/skill pdf summarise this". /skills lists them' };
    return { kind: 'skill', name: rest[0] ?? '', words: typed.slice((rest[0] ?? '').length).trim() };
  }
  const known = word === '?' ? 'help' : nameOf(word);
  const refuse = (message: string): Command => ({ kind: 'refused', message });
  switch (known) {
    case null:
      return refuse(`unknown command ${name}. Type /help to see what there is`);
    case 'help':
      return { kind: 'help' };
    case 'model': {
      if (rest.length === 0) return { kind: 'show', setting: 'model' };
      const model: BrainModel | null = oneOf(first, BRAIN_MODELS);
      return rest.length === 1 && model !== null ? { kind: 'set', change: { model } } : refuse(`/model: "${rest.join(' ')}" is not one of ${BRAIN_MODELS.join(' | ')}`);
    }
    case 'effort': {
      if (rest.length === 0) return { kind: 'show', setting: 'effort' };
      const effort: BrainEffort | null = oneOf(first, BRAIN_EFFORTS);
      return rest.length === 1 && effort !== null ? { kind: 'set', change: { effort } } : refuse(`/effort: "${rest.join(' ')}" is not one of ${BRAIN_EFFORTS.join(' | ')}`);
    }
    case 'brain': {
      if (rest.length === 0) return { kind: 'show', setting: 'brain' };
      const mode: BrainMode | null = oneOf(first, BRAIN_MODES);
      return rest.length === 1 && mode !== null && mode !== 'plain' ? { kind: 'set', change: { mode } } : refuse(`/brain: "${rest.join(' ')}" is not a mode this app has${first === 'plain' ? ' (the brain always has its tools, and asks before it acts)' : ''}`);
    }
    case 'tools': {
      if (rest.length === 0) return { kind: 'tools', change: null };
      // `/tools auto` lets the brain's browser reads, writes and runs go without asking; `/tools ask` brings every prompt back.
      if (rest.length === 1 && (first === 'auto' || first === 'ask')) return { kind: 'set', change: { permits: first } };
      const state = (rest[rest.length - 1] ?? '').toLowerCase();
      const toolName = rest.slice(0, -1).join(' ');
      if (rest.length < 2 || toolName === '' || (state !== 'on' && state !== 'off')) return refuse('/tools: say which and whether, like "/tools WebSearch off"');
      return { kind: 'tools', change: { name: toolName, on: state === 'on' } };
    }
    case 'new':
      return { kind: 'new' };
    case 'status':
      return { kind: 'status' };
    case 'asks':
      if (rest.length === 0) return { kind: 'asks', clear: false };
      return first === 'clear' && rest.length === 1 ? { kind: 'asks', clear: true } : refuse('/asks: bare lists them, "/asks clear" forgets them');
    case 'look': {
      if (rest.length === 0) return { kind: 'look', look: null };
      const look: LookId | null = oneOf(first, LOOK_IDS);
      return rest.length === 1 && look !== null ? { kind: 'look', look } : refuse(`/look: "${rest.join(' ')}" is not one of ${LOOK_IDS.join(' | ')}`);
    }
    case 'review':
      if (rest.length === 0) return { kind: 'review', on: null };
      if (first === 'repair') return rest.length === 1 ? { kind: 'review', on: null, repair: null } : rest.length === 2 && ((rest[1] ?? '').toLowerCase() === 'on' || (rest[1] ?? '').toLowerCase() === 'off') ? { kind: 'review', on: null, repair: (rest[1] ?? '').toLowerCase() === 'on' } : refuse('/review repair: say on or off');
      return rest.length === 1 && (first === 'on' || first === 'off') ? { kind: 'review', on: first === 'on' } : refuse('/review: say on or off, or "repair on" or "repair off"');
    case 'better': {
      if (rest.length === 0) return { kind: 'better', passes: REFINE_LIMITS.passes };
      const passes = Number(first);
      if (rest.length === 1 && Number.isInteger(passes) && passes >= 1 && passes <= REFINE_LIMITS.max) return { kind: 'better', passes };
      return refuse(`/better: passes are a whole number from 1 to ${REFINE_LIMITS.max}`);
    }
    case 'stop':
      return { kind: 'stop' };
    case 'usage':
      return { kind: 'usage' };
    case 'stop-all':
      if (rest.length === 0) return { kind: 'stop-all', resume: false };
      return first === 'resume' && rest.length === 1 ? { kind: 'stop-all', resume: true } : refuse('/stop-all: bare stops everything, "/stop-all resume" switches agent tools back on');
    case 'show-all':
      return { kind: 'show-all' };
    case 'copy':
      if (rest.length === 0) return { kind: 'copy', what: 'answer' };
      return first === 'script' && rest.length === 1 ? { kind: 'copy', what: 'script' } : refuse('/copy: bare copies the answer, "/copy script" copies its script');
    case 'export': {
      const format: ExportFormat | null = oneOf(first, EXPORT_FORMATS);
      return rest.length === 1 && format !== null ? { kind: 'export', format } : refuse(`/export: one of ${EXPORT_FORMATS.join(' | ')}`);
    }
    case 'lines':
      if (rest.length === 0) return { kind: 'lines', on: null };
      return rest.length === 1 && (first === 'on' || first === 'off') ? { kind: 'lines', on: first === 'on' } : refuse('/lines: bare switches it, or say on or off');
    case 'capture':
      return { kind: 'capture' };
  }
}

/** The small label on the picker's button: "opus · medium", with the mode when there is more than one. */
export function brainLabel(choice: BrainChoice): string | null {
  if (!choice.configurable || choice.model === null || choice.effort === null) return null;
  // The brain is always the agent: only the developer's own mode is worth a word on the button.
  const mode = choice.mode === 'steward' ? ' · steward' : '';
  const permits = choice.permits === undefined || choice.mode === 'steward' ? '' : ` · agent · ${choice.permits}`;
  return `${choice.model} · ${choice.effort}${mode}${permits}`;
}

/** The words that confirm a change or answer a bare command. */
export function confirmation(command: Command, choice: BrainChoice): string {
  if (command.kind === 'show' && command.setting === 'brain') return choice.mode === undefined ? 'This server has one mode of brain.' : choice.mode === 'agent' ? 'The brain can use its tools and asks you first, every time.' : `Brain: ${choice.mode}`;
  if (command.kind === 'set' && command.change.permits !== undefined) return command.change.permits === 'auto' ? 'Agent: auto. The brain\'s browser reads, writes and runs in its own tabs go without asking; sending, buying, deleting, posting and sign-in pages still ask. /tools ask turns it off.' : 'Agent: ask. The brain asks before every action again.';
  if (command.kind === 'set' && command.change.mode !== undefined) return `Brain: ${choice.mode ?? command.change.mode} (next answer starts fresh)`;
  if (!choice.configurable) return 'This brain has no model or effort to set.';
  if (command.kind === 'show') return command.setting === 'model' ? `Model: ${choice.model}` : `Effort: ${choice.effort}`;
  if (command.kind === 'set') return command.change.model !== undefined ? `Model: ${choice.model} (next answer starts fresh)` : `Effort: ${choice.effort} (next answer starts fresh)`;
  return HELP;
}
