// A live app (`app`): rows of one HTML document, taken exactly, run in a locked sandbox on the stage. This file is what the language knows of it:
// how the rows become the one source text, and the words that make the brain write one. Where the sandbox is, and what it allows, is the app
// shell's (web/src/app/live-app.ts); nothing here runs anything.

import type { StructureRow } from './schedule';
import { LIMITS } from './vocabulary';

/** The document a block's rows make: one line a row, as written, cut at the last whole line that fits `LIMITS.appChars`. */
export function appSourceOf(rows: readonly StructureRow[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const row of rows) {
    const line = row.cells[0] ?? '';
    if (size + line.length + 1 > LIMITS.appChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

/** The user's words ask for something that WORKS, not a picture of one: an app, a game, a calculator, a tool, a tracker, a quiz, a worksheet that checks answers. */
const ASKS_FOR_WORKING =
  /\b(working|fully interactive|interactive|usable|actually\s+(?:work|works|working|use|usable|do|does)|really\s+(?:work|works|working)|that\s+(?:work|works)|i\s+can\s+(?:use|play|try|add|tick|type|click|tap|drag|change)|live\s+app|real\s+app|web\s*app|(?:an?\s+|the\s+|my\s+)?(?:calculator|stop-?watch|timer|countdown|tracker|converter|planner|to-?do(?:\s+list)?|checklist|quiz|game|flash-?cards?|simulator|playground|sandbox|generator|counter|budget\s+(?:tool|app)|tip\s+calculator|worksheet|practice\s+(?:sheet|page)|sudoku|tic-?tac-?toe|memory\s+game|drum\s+machine|metronome|piano|soundboard|paint\s+app|drawing\s+app|notes?\s+app|kanban|habit\s+tracker)|check(?:s|ing)?\s+(?:her|his|their|my|your|the)\s+answers?|cheers?\s+when)\b/i;
/** Words that say the user wants a picture of an interface, not an interface: a mock-up, a wireframe, a storyboard. */
const ASKS_FOR_PICTURE = /\b(mock[- ]?ups?|wire[- ]?frames?|storyboards?|figma|user journey|design (?:of|for)|screens? (?:for|of))\b/i;

/** Whether the user's words are about something that works, so that this turn is taught `app`. A mock-up is not that, unless they say it must work. */
export function asksForLiveApp(text: string): boolean {
  if (!ASKS_FOR_WORKING.test(text)) return false;
  return !ASKS_FOR_PICTURE.test(text) || /\b(working|fully interactive|actually|really|interactive|usable)\b/i.test(text);
}
