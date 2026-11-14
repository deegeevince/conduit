import { BRAIN_EFFORTS, BRAIN_MODELS } from '@conduit/language';
import type { BrainChange, BrainChoice, BrainEffort, BrainModel } from '@conduit/language';

/** What a line starting with `/` asks for. The app handles it; the brain never sees it. */
export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'show'; readonly setting: 'model' | 'effort' }
  | { readonly kind: 'set'; readonly change: BrainChange }
  | { readonly kind: 'refused'; readonly message: string };

export const HELP =
  `/model <${BRAIN_MODELS.join('|')}>, /effort <${BRAIN_EFFORTS.join('|')}> (this session only; bare shows the current one), /help`;

/** Whether the words are a command rather than something to ask. A path or a date with a slash inside is not: only a leading `/` counts. */
export function isCommand(text: string): boolean {
  return text.startsWith('/');
}

export function parseCommand(text: string): Command {
  const [name = '', ...rest] = text.trim().split(/\s+/);
  const word = name.slice(1).toLowerCase();
  const value = rest.join(' ').toLowerCase();
  if (word === 'help' || word === '?') return { kind: 'help' };
  if (word === 'model' || word === 'effort') {
    if (rest.length === 0) return { kind: 'show', setting: word };
    const allowed: readonly string[] = word === 'model' ? BRAIN_MODELS : BRAIN_EFFORTS;
    if (rest.length > 1 || !allowed.includes(value)) return { kind: 'refused', message: `/${word}: "${rest.join(' ')}" is not one of ${allowed.join(' | ')}` };
    return { kind: 'set', change: word === 'model' ? { model: value as BrainModel } : { effort: value as BrainEffort } };
  }
  return { kind: 'refused', message: `unknown command ${name}. ${HELP}` };
}

/** The small label for the chrome: "opus · medium". */
export function brainLabel(choice: BrainChoice): string | null {
  return choice.configurable && choice.model !== null && choice.effort !== null ? `${choice.model} · ${choice.effort}` : null;
}

/** The words that confirm a change or answer a bare command. */
export function confirmation(command: Command, choice: BrainChoice): string {
  if (!choice.configurable) return 'This brain has no model or effort to set.';
  if (command.kind === 'show') return command.setting === 'model' ? `Model: ${choice.model}` : `Effort: ${choice.effort}`;
  if (command.kind === 'set') return command.change.model !== undefined ? `Model: ${choice.model} (next answer starts fresh)` : `Effort: ${choice.effort} (next answer starts fresh)`;
  return HELP;
}
