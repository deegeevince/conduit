// The slash commands: one line starting with `/` is for the app, never for the brain. `APP_COMMANDS` (language/src/wire.ts)
// is the list: `/help` prints it, the brain's brief is made from it, and this file parses exactly those names.

import { APP_COMMANDS, BRAIN_EFFORTS, BRAIN_MODELS, BRAIN_MODES, LOOK_IDS, REFINE_LIMITS } from '@conduit/language';
import type { AppCommandName, BrainChange, BrainChoice, BrainEffort, BrainMode, BrainModel, LookId } from '@conduit/language';

export type ExportFormat = 'png' | 'svg' | 'film' | 'frames' | 'pdf' | 'script';

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
  | { readonly kind: 'review'; readonly on: boolean | null }
  | { readonly kind: 'better'; readonly passes: number }
  | { readonly kind: 'stop' }
  | { readonly kind: 'show-all' }
  | { readonly kind: 'copy'; readonly what: 'script' | 'answer' }
  | { readonly kind: 'export'; readonly format: ExportFormat }
  | { readonly kind: 'capture' }
  | { readonly kind: 'refused'; readonly message: string };

const EXPORT_FORMATS: readonly ExportFormat[] = ['png', 'svg', 'film', 'frames', 'pdf', 'script'];

/** A command's name as the list spells it, or null for a word that is not one. */
function nameOf(word: string): AppCommandName | null {
  const found = APP_COMMANDS.find((command) => command.name === word);
  return found === undefined ? null : found.name;
}

/** The list as one line, for a status line or a refusal. */
export const HELP = `/${APP_COMMANDS.map((command) => command.name).join(' /')}`;

/** What a command's arguments look like, written so they can sit in a table cell (a bar would end the cell). */
export function usageOf(command: (typeof APP_COMMANDS)[number]): string {
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
      return rest.length === 1 && mode !== null ? { kind: 'set', change: { mode } } : refuse(`/brain: "${rest.join(' ')}" is not one of ${BRAIN_MODES.join(' | ')}`);
    }
    case 'tools': {
      if (rest.length === 0) return { kind: 'tools', change: null };
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
      return rest.length === 1 && (first === 'on' || first === 'off') ? { kind: 'review', on: first === 'on' } : refuse('/review: say on or off');
    case 'better': {
      if (rest.length === 0) return { kind: 'better', passes: REFINE_LIMITS.passes };
      const passes = Number(first);
      if (rest.length === 1 && Number.isInteger(passes) && passes >= 1 && passes <= REFINE_LIMITS.max) return { kind: 'better', passes };
      return refuse(`/better: passes are a whole number from 1 to ${REFINE_LIMITS.max}`);
    }
    case 'stop':
      return { kind: 'stop' };
    case 'show-all':
      return { kind: 'show-all' };
    case 'copy':
      if (rest.length === 0) return { kind: 'copy', what: 'answer' };
      return first === 'script' && rest.length === 1 ? { kind: 'copy', what: 'script' } : refuse('/copy: bare copies the answer, "/copy script" copies its script');
    case 'export': {
      const format: ExportFormat | null = oneOf(first, EXPORT_FORMATS);
      return rest.length === 1 && format !== null ? { kind: 'export', format } : refuse(`/export: one of ${EXPORT_FORMATS.join(' | ')}`);
    }
    case 'capture':
      return { kind: 'capture' };
  }
}

/** The small label on the picker's button: "opus · medium", with the mode when there is more than one. */
export function brainLabel(choice: BrainChoice): string | null {
  if (!choice.configurable || choice.model === null || choice.effort === null) return null;
  const mode = choice.modes !== undefined && choice.modes.length > 1 && choice.mode !== undefined ? ` · ${choice.mode}` : '';
  return `${choice.model} · ${choice.effort}${mode}`;
}

/** The words that confirm a change or answer a bare command. */
export function confirmation(command: Command, choice: BrainChoice): string {
  if (command.kind === 'show' && command.setting === 'brain') return choice.mode === undefined ? 'This server has one mode of brain.' : `Brain: ${choice.mode}${choice.modes !== undefined ? ` (this server offers ${choice.modes.join(', ')})` : ''}`;
  if (command.kind === 'set' && command.change.mode !== undefined) return `Brain: ${choice.mode ?? command.change.mode} (next answer starts fresh)`;
  if (!choice.configurable) return 'This brain has no model or effort to set.';
  if (command.kind === 'show') return command.setting === 'model' ? `Model: ${choice.model}` : `Effort: ${choice.effort}`;
  if (command.kind === 'set') return command.change.model !== undefined ? `Model: ${choice.model} (next answer starts fresh)` : `Effort: ${choice.effort} (next answer starts fresh)`;
  return HELP;
}
