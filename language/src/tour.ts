// `/demo`: a tour of what Conduit can do. It is one scripted page on the stage (a title, then chapters as tappable cards), each card plays a demo
// the server already has (no model), and every demo ends with "Back to the tour" and "Try it yourself". Only what works today is listed. This
// file is the whole of the tour's content; the page that shows it (web/src/chrome/tour.ts) only draws it and does what a tap says.

export type TourControl = 'mic' | 'photo' | 'draw' | 'typing';

/** What a tap on the tour (or on the bar after a demo) asks for. */
export type TourAction =
  | { readonly kind: 'tour' }
  | { readonly kind: 'chapter'; readonly id: string }
  | { readonly kind: 'demo'; readonly name: string; /** the language view is switched on first */ readonly lines?: true }
  /** the live sequence that brings earlier drawings back: real scripts played one after another */
  | { readonly kind: 'memory' }
  | { readonly kind: 'how'; readonly id: string }
  | { readonly kind: 'open'; readonly control: TourControl }
  /** a real prompt for the brain */
  | { readonly kind: 'try'; readonly text: string };

export interface TourDemoCard {
  readonly kind: 'demo';
  readonly label: string;
  readonly name: string;
  readonly lines?: true;
  /** the prompt "Try it yourself" sends to the brain after this demo */
  readonly tryText: string;
}
export interface TourMemoryCard {
  readonly kind: 'memory';
  readonly label: string;
  readonly tryText: string;
}
export interface TourHowCard {
  readonly kind: 'how';
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly steps: readonly string[];
  readonly open: { readonly control: TourControl; readonly label: string };
}
export type TourCard = TourDemoCard | TourMemoryCard | TourHowCard;

export interface TourChapter {
  readonly id: string;
  readonly title: string;
  readonly gist: string;
  readonly cards: readonly TourCard[];
}

export const TOUR_BACK = 'Back to the tour';
export const TOUR_TRY = 'Try it yourself';

export const TOUR_CHAPTERS: readonly TourChapter[] = [
  {
    id: 'drawing',
    title: 'Drawing and art',
    gist: 'shapes, brushes, figures from the shelf',
    cards: [
      { kind: 'demo', label: 'Sketchbook: labels, a morph, a copy', name: 'sketchbook', tryText: 'Draw a lighthouse on a cliff at dusk and label its parts' },
      { kind: 'demo', label: 'The art shelf: a fox and a child by name', name: 'art', tryText: 'Draw a fox and label its tail' },
      { kind: 'demo', label: 'Brushes: dashes, pressure, gradients, clips', name: 'toolkit', tryText: 'Draw a sunset over water with soft glazes and a gradient sky' },
      { kind: 'demo', label: 'Textures and media', name: 'richness', tryText: 'Paint a mossy stone wall in oil' },
    ],
  },
  {
    id: 'explaining',
    title: 'Explaining',
    gist: 'diagrams, charts, tables, maths',
    cards: [
      { kind: 'demo', label: 'Diagrams: flow, tree, cycle, timeline, table', name: 'diagrams', tryText: 'Explain how a heat pump works' },
      { kind: 'demo', label: 'Charts: line, columns, candles', name: 'charts', tryText: 'Chart the average rainfall by month in London as columns' },
      { kind: 'demo', label: 'Maths: written methods, as on paper', name: 'maths', tryText: 'Teach my 7-year-old division' },
    ],
  },
  {
    id: 'interactive',
    title: 'Interactive',
    gist: 'sliders, picks, toggles, a live app',
    cards: [
      { kind: 'demo', label: 'Explorable: a slider bound to the drawing', name: 'explorable', tryText: 'Let me explore how compound interest grows with the rate' },
      { kind: 'demo', label: 'Controls: a pick, a toggle, a field', name: 'controls', tryText: 'Make a lamp I can switch on and off and change the colour of' },
      { kind: 'demo', label: 'A live app on the stage', name: 'app', tryText: 'Make a little piano I can play' },
    ],
  },
  {
    id: 'words',
    title: 'Words',
    gist: 'prose, titles, every language, code, music',
    cards: [
      { kind: 'demo', label: 'Plainly: a fact as prose', name: 'plainly', tryText: 'How far away is the moon?' },
      { kind: 'demo', label: 'Titles: type as the whole show', name: 'titles', tryText: 'Say good morning as a title card' },
      { kind: 'demo', label: 'Styles: one script in every look', name: 'styles', tryText: 'Explain how a bicycle stays upright' },
      { kind: 'demo', label: 'Every language it can write', name: 'scripts', tryText: 'Say hello in Greek, Arabic, Hindi and Thai' },
      { kind: 'demo', label: 'Code, kept exactly', name: 'code', tryText: 'Show me a small Python function that reverses a string' },
      // "A slide deck" (the `deck` demo) comes back when a deck stops at each slide and waits for the viewer (`DECKS_READY`, PLAN-v2.1 package T2): until then the slides play straight through (fb-027)
      { kind: 'demo', label: 'A tune you can hear', name: 'tune', tryText: 'Write me a short tune in a minor key' },
    ],
  },
  {
    id: 'memory',
    title: 'Iteration and memory',
    gist: 'improve in place, undo, bring drawings back',
    cards: [
      { kind: 'demo', label: 'Keep improving a drawing in place', name: 'iterate', tryText: 'Draw a boat, then give it a sail and a flag' },
      { kind: 'memory', label: 'Bring back an earlier drawing', tryText: 'Draw a cat, then draw a dog, then bring the cat back' },
    ],
  },
  {
    id: 'input',
    title: 'Input',
    gist: 'type, speak, upload, draw, tap',
    cards: [
      { kind: 'how', id: 'typing', label: 'Typing', title: 'Typing', steps: ['Write in the box and press Enter.', 'A line that starts with a slash is for the app, not the brain: /help lists them.'], open: { control: 'typing', label: 'Try it: the box' } },
      { kind: 'how', id: 'voice', label: 'Your voice', title: 'Your voice', steps: ['Tap the mic, speak, tap again to stop. Or hold it while you speak.', 'The words are read on your own computer and arrive in the box to send.'], open: { control: 'mic', label: 'Try it: the mic' } },
      { kind: 'how', id: 'photo', label: 'A photo or a PDF', title: 'A photo or a PDF', steps: ['Open the + menu and choose Add a photo or PDF. Paste works too.', 'Then ask: label the parts, explain this, redraw it simpler.'], open: { control: 'photo', label: 'Try it: the + menu' } },
      { kind: 'how', id: 'draw', label: 'The Pencil and Draw', title: 'The Pencil and Draw', steps: ['Turn on Draw, then write or sketch right on the canvas with the Pencil or a finger.', 'Send drawing: your marks go up with your words.'], open: { control: 'draw', label: 'Try it: Draw' } },
      { kind: 'how', id: 'taps', label: 'Taps on choices and controls', title: 'Taps', steps: ['A choice on the stage is a tap: it is sent as your answer.', 'A slider, a toggle or a pick changes the picture at once.'], open: { control: 'typing', label: 'Try it: the box' } },
      { kind: 'how', id: 'keys', label: 'The keyboard', title: 'The keyboard', steps: ['Enter sends. Escape closes the stage.', 'Tab moves between the stage\'s controls; the arrow keys move a slider.'], open: { control: 'typing', label: 'Try it: the box' } },
    ],
  },
  {
    id: 'language',
    title: 'The language view',
    gist: 'the lines that make the picture, beside it',
    cards: [{ kind: 'demo', label: 'Watch the picture being written', name: 'sketchbook', lines: true, tryText: 'Draw a lighthouse on a cliff at dusk and label its parts' }],
  },
];

/**
 * The earlier drawings the memory card plays: five real turns, one after another, so the server remembers them as it remembers an answer (`{1}` is the turn of the first). Both drawings are on
 * the square canvas, so nothing rescales; the colours are written as hex, so the moon is a moon in every look; one line of words under one id (`note`) is said again each turn. The last turn
 * puts the first drawing's moon over the house that is on stage (docs/demo-audit.md 1B).
 */
export const MEMORY_STEPS: readonly string[] = [
  'look paper\nscene night figure canvas=square lines=1\nline ground1 6,80 94,80 thick=1\ncircle moon1 28,24 9 fill=#f2c94c stroke=none\nrect trunk1 64,56 4x24 fill=#6b4a2b\ncircle crown1 66,46 14 fill=#3d7a4f stroke=none\nsay note | A first drawing: a moon over a tree.\nwait 1s',
  'scene day figure canvas=square lines=1\nline ground2 6,80 94,80 thick=1\nrect house2 34,50 32x30 fill=#c96f4a\npoly roof2 30,50 50,32 70,50 fill=#7a3b2e\nrect door2 46,64 8x16 fill=#3a2a20\nsay note | Then a new drawing. The first has left the stage, but it is kept.\nwait 1s',
  'restore {1}\nsay note | "Bring back the first one." It returns whole, exactly as it was.\nwait 1s',
  'restore undo\nsay note | "Undo." One step back: the house again.\nwait 1s',
  'use moon1 from={1} at=78,18 scale=0.8\nsay note | "Put that moon over the house." Only the moon comes back, into the drawing that is here.\nwait 2s',
];

export const TOUR_MEMORY_NOTE = 'Five real turns, no model.';

const cardLabels = new Map<string, TourAction>();
const tryTexts = new Map<string, string>();
function indexCards(): void {
  for (const chapter of TOUR_CHAPTERS) {
    cardLabels.set(chapter.title, { kind: 'chapter', id: chapter.id });
    for (const card of chapter.cards) {
      if (card.kind === 'demo') {
        cardLabels.set(card.label, card.lines === true ? { kind: 'demo', name: card.name, lines: true } : { kind: 'demo', name: card.name });
        if (card.lines !== true) tryTexts.set(card.name, card.tryText);
      } else if (card.kind === 'memory') {
        cardLabels.set(card.label, { kind: 'memory' });
        tryTexts.set('memory', card.tryText);
      }
      else {
        cardLabels.set(card.label, { kind: 'how', id: card.id });
        cardLabels.set(card.open.label, { kind: 'open', control: card.open.control });
      }
    }
  }
  cardLabels.set(TOUR_BACK, { kind: 'tour' });
}
indexCards();

/** What a tapped choice of the tour's pages means; null for words that are not the tour's (those go to the brain as ever). */
export function tourActionOf(text: string): TourAction | null {
  return cardLabels.get(text.trim()) ?? null;
}

/** The prompt "Try it yourself" sends after this demo; null when there is none. */
export function tourTryFor(name: string): string | null {
  return tryTexts.get(name) ?? null;
}

export function tourChapterOf(id: string): TourChapter | null {
  return TOUR_CHAPTERS.find((chapter) => chapter.id === id) ?? null;
}

const flat = (text: string): string => text.replace(/[\r\n|]+/g, ' ').trim();

/** The tour's own page: the title, then a card for each chapter. */
export function tourSource(): string {
  const lines = ['scene stack lines=4 align=center', 'say size=xl enter=fade dur=0.4s | A tour of Conduit', 'say size=m enter=fade dur=0.4s | What it can draw, explain, play and hear. Every card plays at once, with no model call.'];
  for (const chapter of TOUR_CHAPTERS) lines.push(`say choice size=m enter=fade dur=0.2s | ${flat(chapter.title)}`);
  return lines.join('\n');
}

/** A chapter's page: its cards, and the way back. */
export function chapterSource(id: string): string {
  const chapter = tourChapterOf(id);
  if (chapter === null) return tourSource();
  const lines = ['scene stack lines=4 align=center', `say size=xl enter=fade dur=0.3s | ${flat(chapter.title)}`, `say size=m enter=fade dur=0.3s | ${flat(chapter.gist)}`];
  for (const card of chapter.cards) lines.push(`say choice size=m enter=fade dur=0.2s | ${flat(card.label)}`);
  lines.push(`say choice size=m enter=fade dur=0.2s | ${TOUR_BACK}`);
  return lines.join('\n');
}

/** An input card: how to do it, and the button that opens the real control. */
export function howSource(id: string): string {
  const card = TOUR_CHAPTERS.flatMap((chapter) => chapter.cards).find((candidate): candidate is TourHowCard => candidate.kind === 'how' && candidate.id === id);
  if (card === undefined) return tourSource();
  const lines = ['scene stack lines=4 align=center', `say size=xl enter=fade dur=0.3s | ${flat(card.title)}`];
  for (const step of card.steps) lines.push(`say size=m enter=fade dur=0.3s | ${flat(step)}`);
  lines.push(`say choice size=m enter=fade dur=0.2s | ${flat(card.open.label)}`, `say choice size=m enter=fade dur=0.2s | ${TOUR_BACK}`);
  return lines.join('\n');
}
