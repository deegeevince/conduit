// A live app (`app`): rows of one HTML document, taken exactly, run in a locked sandbox on the stage. This file is what the language knows of it:
// how the rows become the one source text, and the words that make the brain write one. Where the sandbox is, and what it allows, is the app
// shell's (web/src/app/live-app.ts); nothing here runs anything.

import type { StructureRow } from './schedule';
import { LIMITS } from './vocabulary';
import type { AppShelf } from './vocabulary';

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
  /\b(working|fully interactive|interactive|usable|actually\s+(?:work|works|working|use|usable|do|does)|really\s+(?:work|works|working)|that\s+(?:work|works)|i\s+can\s+(?:use|play(?:\s+with)?|try|add|tick|type|click|tap|drag|change|bounce|throw|toss|drop|roll|push|kick|spin|swing|launch|fling|flick|stack|pour|shake|tilt|move|fire|shoot)|(?:let\s+me|lets?\s+me|so\s+i\s+can)\s+(?:play\s+with|bounce|throw|drop|roll|push|kick|spin|swing|launch|fling|stack|pour)|physics\s+(?:sim|toy|demo)|(?:real|working|live|actual|publishable|ready[- ]to[- ]publish)\s+(?:web\s*)?(?:page|site|website|landing\s+page|homepage)|(?:build|make|create|render|write|design)\s+(?:me\s+)?(?:a\s+|an\s+|my\s+)?(?:small\s+|simple\s+)?(?:web\s*page|web\s*site|website|landing\s+page|homepage)|(?:make|let)\s+(?:it|them)\s+(?:bounce|roll|fall|swing)|play(?:ing)?\s+with\s+(?:a|an|the)\s+(?:ball|pendulum|spring|marble|block|domino)|live\s+app|real\s+app|web\s*app|(?:replicate|recreate|re-create|clone|rebuild|remake)\b|(?:an?\s+|the\s+|my\s+)?(?:calculator|stop-?watch|timer|countdown|tracker|converter|planner|to-?do(?:\s+list)?|checklist|quiz|game|flash-?cards?|simulator|playground|sandbox|generator|counter|budget\s+(?:tool|app)|tip\s+calculator|worksheet|practice\s+(?:sheet|page)|sudoku|tic-?tac-?toe|memory\s+game|drum\s+machine|metronome|piano|soundboard|paint\s+app|drawing\s+app|notes?\s+app|kanban|habit\s+tracker)|check(?:s|ing)?\s+(?:her|his|their|my|your|the)\s+answers?|cheers?\s+when)\b/i;
/** Words that say the user wants a picture of an interface, not an interface: a mock-up, a wireframe, a storyboard. */
const ASKS_FOR_PICTURE = /\b(mock[- ]?ups?|wire[- ]?frames?|storyboards?|figma|user journey|design (?:of|for)|screens? (?:for|of))\b/i;

/** Whether the user's words are about something that works, so that this turn is taught `app`. A mock-up is not that, unless they say it must work. */
export function asksForLiveApp(text: string): boolean {
  if (!ASKS_FOR_WORKING.test(text)) return false;
  return !ASKS_FOR_PICTURE.test(text) || /\b(working|fully interactive|actually|really|real|interactive|usable|publish\w*)\b/i.test(text);
}

/** What a document reaches for by name, whichever shelf word it said: the library's own global in its code is as good as asking, so an app that forgets `uses=` still runs. */
const SHELF_GLOBALS: readonly (readonly [RegExp, AppShelf])[] = [
  [/\bMatter\b/, 'physics'],
  [/font[^;}]{0,80}\b(?:Inter|Source Serif(?: 4)?|Archivo Black|JetBrains Mono)\b/, 'fonts'],
  [/(?:\bTone\s*\.|=\s*Tone\b)/, 'sound'],
  [/\bkatex\b/, 'maths'],
  [/(?:\bd3\s*\.[a-z]|=\s*d3\b)/, 'charts'],
];
export function shelfOf(asked: readonly AppShelf[] | undefined, source: string): readonly AppShelf[] {
  const out = [...(asked ?? [])];
  for (const [pattern, shelf] of SHELF_GLOBALS) if (!out.includes(shelf) && pattern.test(source)) out.push(shelf);
  return out;
}

/** Making or copying something to play or use: the thing itself is the answer, whatever recipe the library would also offer (a walk-through of steps). */
export function asksToMakeGame(text: string): boolean {
  return /\b(?:make|build|create|write|design|code|give\s+me)\b[^.?!]{0,40}\b(?:game|app)\b|\b(?:replicate|recreate|re-create|clone|rebuild|remake)\b/i.test(text);
}
