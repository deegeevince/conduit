// "What Conduit can do" (PLAN-catalogue.md): one capability, one short page, seven categories. This file is the whole table. The pages
// (language/demos/showcase/<category>.series, step S1), the check group that judges them (S2), the overview at /capabilities (S4) and the reel (S5)
// all read it and nothing else for what a page is, what it claims to show and what it needs of the painter. It holds no page text: those are the
// pages'. `pnpm timeline` checks the table (language/scripts/showcase-checks.ts).
//
// `needs` and `expect` are what keeps a page true. `needs` is what the painter must paint for the page to be live (`structure:flow`, `flag:decks`):
// a live page needing something unpainted fails, and a "not yet" entry whose needs are now all painted fails ("code is painted now: write its
// page"). `expect` is the ids the page must show, with ink, when it has come to rest.

import type { AmbientKind, CameraMove, ChartKind, ControlKind, ElementKind, FxName, LookId, Medium, StrokeCharacter, StructureKind, Texture } from './vocabulary';

export type ShowcaseCategoryId = 'ask' | 'words' | 'drawings' | 'diagrams' | 'numbers' | 'works' | 'keeps';

export interface ShowcaseCategory {
  readonly id: ShowcaseCategoryId;
  /** the band's name on the overview */
  readonly name: string;
  /** what the band holds, in a few words, under its name */
  readonly gist: string;
}

/**
 * How a page is made. `as-is`: a scene of a demo, unchanged. `cut`: a scene of a demo cut to fit. `new`: written for the catalogue.
 * `hand`: it needs a tap or a key to see it, so the overview explains it and the page cannot be played alone. `recorded`: a real still of a real
 * device (the pen, the mic), tagged as recorded.
 */
export type ShowcasePageKind = 'as-is' | 'cut' | 'new' | 'hand' | 'recorded';

export type ShowcaseStatus = 'live' | 'not yet';

/** What a `needs` entry is named after: the lists the painter advertises (`Capabilities`), a switch it advertises, or a `feature` it has no list for yet. */
export type ShowcaseNeed =
  | `structure:${StructureKind}`
  | `chart:${ChartKind}`
  | `control:${ControlKind}`
  | `medium:${Medium}`
  | `look:${LookId}`
  | `camera:${CameraMove}`
  | `ambient:${AmbientKind}`
  | `fx:${FxName}`
  | `texture:${Texture}`
  | `brush:${StrokeCharacter}`
  | `kind:${ElementKind}`
  | `flag:${'decks' | 'uploads' | 'links' | 'clockwork'}`
  | `feature:${string}`;

export interface ShowcaseEntry {
  /** also the scene's id on its page */
  readonly id: string;
  readonly category: ShowcaseCategoryId;
  /** the tile's name: at most `SHOWCASE_LIMITS.name` characters */
  readonly name: string;
  /** what a person gets: at most `SHOWCASE_LIMITS.caption` characters */
  readonly caption: string;
  /**
   * Where the page comes from today. `file#n` is the nth scene of `language/demos/<file>.series`, `file#id` the scene with that id; anything else
   * points at code or at a part of the app. Empty when there is nothing to cut from.
   */
  readonly today: readonly string[];
  /** null for an entry that is not yet painted: it has no page */
  readonly page: ShowcasePageKind | null;
  /** seconds in the reel, or null when the page is on the overview only */
  readonly reel: number | null;
  readonly needs: readonly ShowcaseNeed[];
  /** the ids the page must show. Empty until its page is written (S1); then it may not be empty for a page kept as a scene */
  readonly expect: readonly string[];
  /** the turns of a page that takes more than one, in order, each named in words; S1 puts the lines beside them */
  readonly turns?: readonly string[];
  readonly status: ShowcaseStatus;
  /** what a "not yet" entry waits on */
  readonly waits?: string;
  /** anything about the page the other fields cannot hold */
  readonly note?: string;
}

export const SHOWCASE_LIMITS = { name: 22, caption: 90, gist: 60, perCategory: 7 } as const;

/**
 * The reel is the pages with a `reel` in table order, between an opening and a close, with a one-second card ahead of each category that has pages in
 * it. Together they come to `min`..`max` seconds. (The section order inside "Ask it" is the reel's own: the photo goes before the pen and the voice.)
 */
export const SHOWCASE_REEL = { opening: 4.0, close: 4.0, card: 1.2, min: 60, max: 90 } as const;

export const SHOWCASE_CATEGORIES: readonly ShowcaseCategory[] = [
  { id: 'ask', name: 'Ask it', gist: 'type, tap, drag, write, speak, show a photo' },
  { id: 'words', name: 'Words', gist: 'plain answers, big type, every alphabet' },
  { id: 'drawings', name: 'Drawings', gist: 'figures, brushes, looks, things that move' },
  { id: 'diagrams', name: 'Diagrams', gist: 'flows, trees, cycles, timelines, maps' },
  { id: 'numbers', name: 'Numbers', gist: 'charts, tables, sums as on paper' },
  { id: 'works', name: 'Things that work', gist: 'switches, small apps, mock-ups, music' },
  { id: 'keeps', name: 'It keeps going', gist: 'change in place, undo, bring back, its working' },
];

const live = (entry: Omit<ShowcaseEntry, 'status'>): ShowcaseEntry => ({ ...entry, status: 'live' });
const notYet = (entry: Omit<ShowcaseEntry, 'status' | 'page' | 'reel' | 'expect'>): ShowcaseEntry => ({ ...entry, page: null, reel: null, expect: [], status: 'not yet' });

/** The 36 that work today, in the order of the overview, then the 5 that do not yet. */
export const SHOWCASE: readonly ShowcaseEntry[] = [
  // Ask it
  live({ id: 'type', category: 'ask', name: 'Type a question', caption: 'Write what you want to know. The answer is drawn in front of you.', today: [], page: 'new', reel: 4.5, needs: [], expect: [], note: 'nearest today: plainly#1' }),
  live({ id: 'tap', category: 'ask', name: 'Tap an answer', caption: 'Tap a choice on the canvas and it becomes your next question.', today: ['plainly#1'], page: 'new', reel: 3.0, needs: [], expect: [], turns: ['a question with choices', 'the answer to the tapped choice'], note: 'the choices of plainly#1; the page is a second turn' }),
  live({ id: 'drag', category: 'ask', name: 'Drag a slider', caption: 'Move a slider and the picture follows your hand, no wait.', today: ['explorable#1'], page: 'cut', reel: 3.5, needs: ['control:slider'], expect: ['height', 'sun', 'shadow'] }),
  live({ id: 'pen', category: 'ask', name: 'Write with a pen', caption: 'Write your answer with an Apple Pencil or a finger. It reads your handwriting.', today: ['maths#2'], page: 'recorded', reel: 2.0, needs: [], expect: [] }),
  live({ id: 'voice', category: 'ask', name: 'Say it', caption: 'Talk instead of typing. Your words are read on your own Mac.', today: [], page: 'recorded', reel: 2.0, needs: [], expect: [] }),
  live({ id: 'photo', category: 'ask', name: 'Show it a photo', caption: 'Give it a photo or a PDF page and it points out the parts.', today: ['hard#photo'], page: 'cut', reel: 3.0, needs: ['flag:uploads'], expect: ['p1', 'c1', 'c2', 'c3'], turns: ['the photo, given with the question', 'a pic and three callout lines'], note: 'a real photo once the owner gives one; the test pattern until then' }),

  // Words
  live({ id: 'prose', category: 'words', name: 'A plain answer', caption: 'A question of fact gets a few clear sentences.', today: ['plainly#1'], page: 'cut', reel: null, needs: [], expect: [] }),
  live({ id: 'bigtype', category: 'words', name: 'Big type', caption: "A few words set large, like a film's title card.", today: ['titles#1'], page: 'cut', reel: 2.5, needs: [], expect: [] }),
  live({ id: 'fix', category: 'words', name: 'A visible fix', caption: 'It crosses out what it said and writes the right thing beside it.', today: ['titles#2'], page: 'cut', reel: null, needs: [], expect: ['a3'] }),
  live({ id: 'alphabets', category: 'words', name: 'Any alphabet', caption: 'Arabic, Hebrew, Hindi, Thai, Chinese, Japanese and Korean, each written as it should be.', today: ['scripts#1', 'hard#scripts'], page: 'cut', reel: 2.5, needs: [], expect: ['ar', 'he', 'hi', 'th', 'zh', 'ja', 'ko'] }),
  live({ id: 'aloud', category: 'words', name: 'Read aloud', caption: 'It reads the answer to you, on your own device.', today: ['web/src/chrome/speak.ts'], page: 'hand', reel: null, needs: [], expect: [] }),

  // Drawings
  live({ id: 'labels', category: 'drawings', name: 'A labelled drawing', caption: 'Each part named, the label beside its part.', today: ['sketchbook#1'], page: 'cut', reel: 3.0, needs: [], expect: ['beam', 'pivot', 'load'] }),
  live({ id: 'fox', category: 'drawings', name: 'A finished figure', caption: 'Ask for a fox and a finished fox arrives, with parts you can point at.', today: ['art#1'], page: 'cut', reel: 3.0, needs: [], expect: ['fox1', 'fox1-tail'] }),
  live({ id: 'paint', category: 'drawings', name: 'Brush and paint', caption: 'Strokes that swell and thin, washes, gradients and glazes.', today: ['toolkit#2'], page: 'as-is', reel: 2.5, needs: [], expect: ['sky', 'moon', 'hills', 'glow'] }),
  live({ id: 'pixel', category: 'drawings', name: 'Pixel art', caption: 'A small picture set square by square, and it can move.', today: ['styles#1'], page: 'new', reel: null, needs: ['kind:sprite'], expect: [], note: 'the pix block inside styles#1' }),
  live({ id: 'looks', category: 'drawings', name: 'Eleven looks', caption: 'The same answer on paper, blackboard, blueprint or a 1980s terminal.', today: ['styles#1'], page: 'new', reel: 3.5, needs: ['look:paper', 'look:chalk', 'look:blueprint', 'look:phosphor'], expect: [] }),
  live({ id: 'motion', category: 'drawings', name: 'Things that move', caption: 'A planet goes round its track while its moon turns.', today: ['sketchbook#2'], page: 'cut', reel: 3.5, needs: [], expect: ['star', 'track', 'planet', 'moon'] }),
  live({ id: 'camera', category: 'drawings', name: 'Camera and weather', caption: 'The view moves in slowly while stars, rain or snow fill the air.', today: ['titles#1', 'sketchbook#3'], page: 'new', reel: null, needs: ['camera:push', 'ambient:stars', 'ambient:rain', 'ambient:snow'], expect: [] }),

  // Diagrams
  live({ id: 'flow', category: 'diagrams', name: 'A flowchart', caption: 'Steps and decisions joined by arrows that go round every box.', today: ['diagrams#1'], page: 'cut', reel: 3.0, needs: ['structure:flow'], expect: ['plant', 'start', 'dry', 'water', 'wait', 'light'] }),
  live({ id: 'tree', category: 'diagrams', name: 'A tree', caption: 'Each thing drawn under the thing it belongs to.', today: ['diagrams#2'], page: 'as-is', reel: null, needs: ['structure:tree'], expect: ['root', 'subject', 'predicate', 'noun', 'verb', 'object'] }),
  live({ id: 'cycle', category: 'diagrams', name: 'A cycle', caption: 'Things that go round, drawn as a ring that closes.', today: ['diagrams#3'], page: 'as-is', reel: null, needs: ['structure:cycle'], expect: ['sea', 'cloud', 'rain', 'river'] }),
  live({ id: 'timeline', category: 'diagrams', name: 'A timeline', caption: 'Dates placed to scale along a line.', today: ['diagrams#4'], page: 'as-is', reel: 2.5, needs: ['structure:timeline'], expect: [] }),
  live({ id: 'cutaway', category: 'diagrams', name: 'A labelled figure', caption: 'A cutaway drawing with every part named.', today: ['language/src/figure.ts:228'], page: 'new', reel: 3.0, needs: ['structure:figure'], expect: [], note: 'the taught example in figure.ts' }),
  live({ id: 'pins', category: 'diagrams', name: 'Pins on a map', caption: 'Places marked on a drawing, each label clear of the others.', today: [], page: 'new', reel: null, needs: ['structure:map'], expect: [] }),

  // Numbers
  live({ id: 'chart', category: 'numbers', name: 'A chart', caption: 'Your numbers as a chart with real axes and a crosshair you can move.', today: ['charts#1'], page: 'as-is', reel: 3.0, needs: ['structure:chart', 'chart:line'], expect: [] }),
  live({ id: 'table', category: 'numbers', name: 'A table', caption: 'Rows and columns with the numbers lined up and shown as bars.', today: ['diagrams#5'], page: 'as-is', reel: null, needs: ['structure:table'], expect: [] }),
  live({ id: 'maths', category: 'numbers', name: 'Sums as on paper', caption: 'A sum set out in columns as a child writes it, with empty boxes for the answer.', today: ['maths#2'], page: 'as-is', reel: 3.0, needs: ['structure:math'], expect: ['m2'] }),
  live({ id: 'sum', category: 'numbers', name: 'It checks your answer', caption: 'It asks before it tells. Write the answer and it is marked.', today: ['problem#3'], page: 'cut', reel: 3.0, needs: ['structure:problem'], expect: ['p3'], turns: ['problem', 'fill'] }),

  // Things that work
  live({ id: 'switch', category: 'works', name: 'Switches and picks', caption: 'Flip a switch or pick a colour and the drawing changes at once.', today: ['controls#1'], page: 'cut', reel: null, needs: ['control:toggle', 'control:pick'], expect: ['bulb', 'power', 'mood'] }),
  live({ id: 'app', category: 'works', name: 'A small app', caption: 'A working counter, game or tool that runs on the canvas in a locked box.', today: ['app#1'], page: 'cut', reel: null, needs: ['structure:app'], expect: ['tally'] }),
  live({ id: 'mockup', category: 'works', name: 'An app mock-up', caption: 'A phone screen with real fields and buttons at its true size.', today: ['language/src/interface.ts:674'], page: 'new', reel: 2.5, needs: ['structure:screen'], expect: [], note: 'the taught example in interface.ts' }),
  live({ id: 'music', category: 'works', name: 'A tune you can hear', caption: 'It writes the notes; the canvas draws and plays them.', today: ['tune#1'], page: 'new', reel: 3.5, needs: ['structure:tune'], expect: [], note: 'two bars' }),

  // It keeps going
  live({ id: 'changes', category: 'keeps', name: 'It edits, not redraws', caption: 'Ask for a bigger sail and one line arrives. The boat is not redrawn.', today: ['iterate#1'], page: 'cut', reel: 3.5, needs: [], expect: ['hull', 'mast', 'sail'], turns: ['the boat', 'one poly sail line'] }),
  live({ id: 'undo', category: 'keeps', name: 'Undo', caption: 'One tap puts the drawing back as it was.', today: ['the Undo chip'], page: 'hand', reel: null, needs: [], expect: [] }),
  live({ id: 'back', category: 'keeps', name: 'It remembers drawings', caption: 'An earlier drawing returns whole.', today: ['language/src/tour.ts MEMORY_STEPS 1-3'], page: 'as-is', reel: 4.0, needs: [], expect: ['moon1', 'trunk1', 'crown1'], turns: ['a moon and a tree', 'a house', 'restore the first'] }),
  live({ id: 'stream', category: 'keeps', name: 'It shows its working', caption: 'Open the language view and watch the lines that make the picture.', today: ['the tour chapter language'], page: 'hand', reel: 3.5, needs: [], expect: [] }),

  // Not yet: no page, not on the overview, not in the reel
  notYet({ id: 'code', category: 'words', name: 'Code, kept exactly', caption: 'Source taken exactly as written, indentation kept, monospaced and coloured.', today: ['code#1'], needs: ['structure:code'], waits: 'v3-codefix' }),
  notYet({ id: 'link', category: 'ask', name: 'Read a link', caption: 'Give it a link and it reads the page before it answers.', today: [], needs: ['flag:links'], waits: 'LINKS_READY' }),
  notYet({ id: 'slides', category: 'words', name: 'A slide deck', caption: 'A short talk, a scene to a slide, that you step through.', today: ['deck#1'], needs: ['flag:decks'], waits: 'DECKS_READY' }),
  notYet({ id: 'formula', category: 'numbers', name: 'A typeset formula', caption: 'A formula set as in a textbook, in a sentence or on a line of its own.', today: [], needs: ['feature:formula'], waits: 'PLAN-maths M7' }),
  notYet({ id: 'orbit', category: 'drawings', name: 'Motion that keeps time', caption: 'Things that circle, swing and pulse on a clock you can slow or scrub.', today: [], needs: ['flag:clockwork'], waits: 'PLAN-motion steps 2-6, then it replaces motion' }),
];

/** The table, read: by id, by category, the ones that work, the ones that do not yet, the reel. Built over any table, so a check can read a broken one. */
export interface ShowcaseReader {
  readonly entries: readonly ShowcaseEntry[];
  readonly categories: readonly ShowcaseCategory[];
  /** null for an id the table does not hold */
  entry(id: string): ShowcaseEntry | null;
  category(id: string): ShowcaseCategory | null;
  /** the entries that work, in the table's order */
  live(): readonly ShowcaseEntry[];
  notYet(): readonly ShowcaseEntry[];
  /** a category's entries that work: a band of the overview */
  band(category: string): readonly ShowcaseEntry[];
  /** the pages with seconds in the reel, in the table's order */
  reel(): readonly ShowcaseEntry[];
  /** the whole reel: its pages, a card for each category that has any, the opening and the close */
  reelSeconds(): number;
  /** `showcase: 36 live, 5 not yet (code, link, slides, formula, orbit)` */
  summary(): string;
}

export function readShowcase(entries: readonly ShowcaseEntry[] = SHOWCASE, categories: readonly ShowcaseCategory[] = SHOWCASE_CATEGORIES): ShowcaseReader {
  const byId = new Map<string, ShowcaseEntry>();
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  const works = (): readonly ShowcaseEntry[] => entries.filter((entry) => entry.status === 'live');
  const reel = (): readonly ShowcaseEntry[] => works().filter((entry) => entry.reel !== null);
  return {
    entries,
    categories,
    entry: (id) => byId.get(id) ?? null,
    category: (id) => categories.find((category) => category.id === id) ?? null,
    live: works,
    notYet: () => entries.filter((entry) => entry.status === 'not yet'),
    band: (category) => works().filter((entry) => entry.category === category),
    reel,
    reelSeconds: () => {
      const pages = reel();
      const cards = new Set(pages.map((entry) => entry.category)).size;
      const seconds = pages.reduce((sum, entry) => sum + (entry.reel ?? 0), 0) + cards * SHOWCASE_REEL.card + SHOWCASE_REEL.opening + SHOWCASE_REEL.close;
      return Math.round(seconds * 10) / 10;
    },
    summary: () => `showcase: ${works().length} live, ${entries.length - works().length} not yet (${entries.filter((entry) => entry.status === 'not yet').map((entry) => entry.id).join(', ')})`,
  };
}
