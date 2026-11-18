// A turn that drew nothing (fb-075, fb-008).
//
// The brain's first turn called the canvas tools four times, then wrote "ok": 38 s, no line, an empty stage. An older turn described a time slider in
// prose, drew nothing, and its markdown bullets were all refused. Both are the same thing: the turn ended and nothing the brain wrote had landed.
// The conductor tells the brain so, in the same conversation, and lets it write again once (`Conductor.retryEmpty`). What it says is here.

/** What a turn that drew nothing came to: how many lines were refused, how many only said as text, and a few of the refused ones as the brain wrote them */
export interface EmptyTurn {
  readonly refused: number;
  readonly said: number;
  readonly examples: readonly string[];
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The facts as words: for the brain's message, the log and the turn's pass record */
export function emptyTurnFacts(found: EmptyTurn): string {
  const parts: string[] = [];
  if (found.refused > 0) {
    const shown = found.examples.slice(0, 2).map((raw) => `"${raw.length > 60 ? `${raw.slice(0, 59)}…` : raw}"`);
    parts.push(`${plural(found.refused, 'line was', 'lines were')} refused${shown.length === 0 ? '' : `: ${shown.join(', ')}`}`);
  }
  if (found.said > 0) parts.push(`${plural(found.said, 'line was', 'lines were')} only said as plain text`);
  return parts.length === 0 ? 'it had no lines at all' : parts.join('; ');
}

/**
 * What the brain is told when its turn ended with nothing drawn: what happened, said plainly, and what to write. It is a message to the process that wrote
 * the turn, as the reader's refusals are (`refusalBrief`); no rule against tools is in it, only what tools do.
 */
export function emptyTurnBrief(found: EmptyTurn): string {
  return `Nothing was drawn: your reply had no Series lines that put anything on the stage (${emptyTurnFacts(found)}). Tools draft, they do not draw: only the lines you write are shown. Write the answer as Series lines now; if it needs only words, \`say | …\`.`;
}

/** What the person is told when the second try drew nothing either (the `end` event's message): short, and not a failure of the app */
export const EMPTY_AGAIN = 'Nothing was drawn, even when asked again. Try saying it another way.';
/** What the person is told when the brain could not be asked a second time */
export const EMPTY_NOT_ASKED = 'Nothing was drawn, and asking again did not work. Try saying it again.';
