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
  /**
   * The turns of a page that takes more than one, as real Series: the scripts of the turns AFTER the page's own scene (that scene, in the category's
   * file, is the first turn), in order, each opening with a `#` comment that says what it is in words. `restore {1}` means the first turn, as in
   * `MEMORY_STEPS`. A page whose first turn is the person's own (a photo given with the question) takes none: the check puts the photo up first.
   */
  readonly turns?: readonly string[];
  /** how long the page lasts, for a page that is not in the reel (one in the reel lasts its `reel` seconds). Together the turns of a page add up to it. */
  readonly seconds?: number;
  /**
   * Seconds the language cannot see in the page and the painter adds, as measured by playing it on the replay brain: the parts of a `draw` figure are put on
   * stage by the server after the page is scheduled, a `restore` brings back its drawing, and some things ease into place after their last arrival. The page's
   * real end is the language's plus this (`pnpm timeline` adds it before it compares the end with the seconds).
   */
  readonly extra?: number;
  /** the second of the page at which its still is taken, when the frame at rest does not show what it is about (a correction's strike-through has gone by then) */
  readonly still?: number;
  readonly status: ShowcaseStatus;
  /** what a "not yet" entry waits on */
  readonly waits?: string;
  /** anything about the page the other fields cannot hold */
  readonly note?: string;
}

export const SHOWCASE_LIMITS = { name: 22, caption: 90, gist: 60, perCategory: 7 } as const;

/**
 * What a page is held to (`pnpm timeline`, language/scripts/showcase-checks.ts). A page is the scene in its category's file, then the table's `turns` after it.
 * `lines`: the lines of the whole page, every row of a table or a block of code counted. `words`: the words of one `say`; `narration`: at most one `say` with no id
 * of its own, set in the flow (a page narrates once; a thing it names has an id and is looked for by `expect`); `all`: the words of every `say` together.
 * `hold`: seconds from the last thing arriving (an entrance, a change, a look) to the page's end. `reading`: words a second a person reads at, so a line
 * stays up for its words over that after it has arrived (fb-023: a page stays up as long as reading it takes). `tolerance`: how near the end is to the
 * page's seconds, which are `min`..`max`.
 */
export const SHOWCASE_PAGE = { lines: 14, words: 8, narration: 1, all: 24, hold: 1.5, reading: 3.5, tolerance: 0.2, min: 2.5, max: 4.5 } as const;

/**
 * The reel is the pages with a `reel` in table order, between an opening and a close, with a title card (`card` seconds) ahead of each category that has
 * pages in it. Together they come to `min`..`max` seconds. (The section order inside "Ask it" is the reel's own: the photo goes before the pen and the voice.)
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

/** The lines of a turn, as a script. */
const script = (...lines: readonly string[]): string => lines.join('\n');

const live = (entry: Omit<ShowcaseEntry, 'status'>): ShowcaseEntry => ({ ...entry, status: 'live' });
const notYet = (entry: Omit<ShowcaseEntry, 'status' | 'page' | 'reel' | 'expect'>): ShowcaseEntry => ({ ...entry, page: null, reel: null, expect: [], status: 'not yet' });

/** The 36 that work today, in the order of the overview, then the 5 that do not yet. */
export const SHOWCASE: readonly ShowcaseEntry[] = [
  // Ask it
  live({ id: 'type', category: 'ask', name: 'Type a question', caption: 'Write what you want to know. The answer is drawn in front of you.', today: [], page: 'new', reel: 3.5, needs: [], expect: ['sun', 'beam', 'blue', 'red'], note: 'the answer to a typed question; the typing is a hand' }),
  live({ id: 'tap', category: 'ask', name: 'Tap an answer', caption: 'Tap a choice on the canvas and it becomes your next question.', today: ['plainly#1'], page: 'new', reel: 3.5, needs: [], expect: ['head', 'ear1', 'ear2', 'muzzle'], turns: [script('# the answer to the tapped choice', 'scene tapped caption brisk', 'circle head 80,50 22 fill=accent stroke=none', 'poly ear1 @with 62,36 64,12 80,30 fill=accent stroke=none', 'poly ear2 @with 98,36 96,12 80,30 fill=accent stroke=none', 'poly muzzle @with 68,56 80,74 92,56 fill=#f6efe4 stroke=none', 'circle nose @with 80,63 3 fill=ink stroke=none', 'say @with enter=fade by=all dur=0.2s | You tapped orange.', 'wait 0.1s')], note: 'the scene is the question with its choices; the tap and the turn it opens come next' }),
  live({ id: 'drag', category: 'ask', name: 'Drag a slider', caption: 'Move a slider and the picture follows your hand, no wait.', today: ['explorable#1'], page: 'cut', reel: 3.5, needs: ['control:slider'], expect: ['height', 'sun', 'shadow'] }),
  live({ id: 'pen', category: 'ask', name: 'Write with a pen', caption: 'Write your answer with an Apple Pencil or a finger. It reads your handwriting.', today: ['maths#2'], page: 'recorded', reel: 2.0, needs: [], expect: [] }),
  live({ id: 'voice', category: 'ask', name: 'Say it', caption: 'Talk instead of typing. Your words are read on your own Mac.', today: [], page: 'recorded', reel: 2.0, needs: [], expect: [] }),
  live({ id: 'photo', category: 'ask', name: 'Show it a photo', caption: 'Give it a photo or a PDF page and it points out the parts.', today: ['hard#photo'], page: 'cut', reel: 3.0, needs: ['flag:uploads'], expect: ['p1', 'c1', 'c2', 'c3'], note: 'the photo is the person\'s own turn, so the check puts it up first (as u1); a real photo once the owner gives one, the test pattern until then' }),

  // Words
  live({ id: 'prose', category: 'words', name: 'A plain answer', caption: 'A question of fact gets a plain answer in a reading column.', today: ['plainly#1'], page: 'cut', reel: null, seconds: 3.0, needs: [], expect: ['ans'] }),
  live({ id: 'bigtype', category: 'words', name: 'Big type', caption: "A few words set large, like a film's title card.", today: ['titles#1'], page: 'cut', reel: 2.5, needs: [], expect: ['big'] }),
  live({ id: 'fix', category: 'words', name: 'A visible fix', caption: 'It crosses out what it said and writes the right thing beside it.', today: ['titles#2'], page: 'cut', reel: null, seconds: 4.0, still: 2.7, needs: [], expect: ['a3'] }),
  live({ id: 'alphabets', category: 'words', name: 'Any alphabet', caption: 'Arabic, Hebrew, Hindi, Thai, Chinese, Japanese and Korean, each written as it should be.', today: ['scripts#1', 'hard#scripts'], page: 'cut', reel: 2.5, needs: [], expect: ['ar', 'he', 'hi', 'th', 'zh', 'ja', 'ko'] }),
  live({ id: 'code', category: 'words', name: 'Code, kept exactly', caption: 'Source taken exactly as written, indentation kept, monospaced and coloured.', today: ['code#3'], page: 'cut', reel: null, seconds: 3.0, needs: ['structure:code'], expect: ['cfg'] }),
  live({ id: 'aloud', category: 'words', name: 'Read aloud', caption: 'It reads the answer to you, on your own device.', today: ['web/src/chrome/speak.ts'], page: 'hand', reel: null, needs: [], expect: [] }),

  // Drawings
  live({ id: 'labels', category: 'drawings', name: 'A labelled drawing', caption: 'Each part named, the label beside its part.', today: ['sketchbook#1'], page: 'cut', reel: 3.0, needs: [], expect: ['beam', 'pivot', 'load'] }),
  live({ id: 'fox', category: 'drawings', name: 'A finished figure', caption: 'Ask for a fox and a finished fox arrives, with parts you can point at.', today: ['art#1'], page: 'cut', reel: 3.5, extra: 0.5, needs: [], expect: ['fox1', 'fox1-tail', 'fox1-nose'] }),
  live({ id: 'paint', category: 'drawings', name: 'Brush and paint', caption: 'Strokes that swell and thin, washes, gradients and glazes.', today: ['toolkit#2'], page: 'as-is', reel: 2.5, extra: 0.17, needs: [], expect: ['sky', 'moon', 'hills', 'glow'] }),
  live({ id: 'pixel', category: 'drawings', name: 'Pixel art', caption: 'A small picture set square by square, and it can move.', today: ['styles#1'], page: 'new', reel: null, seconds: 3.0, needs: ['kind:sprite'], expect: ['bug'], note: 'the pix block inside styles#1' }),
  live({ id: 'looks', category: 'drawings', name: 'Eleven looks', caption: 'The same answer on paper, blackboard, blueprint or a 1980s terminal.', today: ['styles#1'], page: 'new', reel: 4.0, needs: ['look:paper', 'look:chalk', 'look:blueprint', 'look:phosphor'], expect: ['sun', 'hill'] }),
  live({ id: 'motion', category: 'drawings', name: 'Things that move', caption: 'A planet goes round its track while its moon turns.', today: ['sketchbook#2'], page: 'cut', reel: 3.5, needs: [], expect: ['star', 'track', 'planet', 'moon'] }),
  live({ id: 'camera', category: 'drawings', name: 'Camera and weather', caption: 'The view moves in slowly while stars or rain fill the air.', today: ['titles#1', 'sketchbook#3'], page: 'new', reel: null, seconds: 3.5, needs: ['camera:push', 'ambient:stars', 'ambient:rain'], expect: ['sky', 'rain1', 'house'] }),

  // Diagrams
  live({ id: 'flow', category: 'diagrams', name: 'A flowchart', caption: 'Steps and decisions joined by arrows that go round every box.', today: ['diagrams#1'], page: 'cut', reel: 3.0, needs: ['structure:flow'], expect: ['plant', 'start', 'dry', 'water', 'wait', 'light'] }),
  live({ id: 'tree', category: 'diagrams', name: 'A tree', caption: 'Each thing drawn under the thing it belongs to.', today: ['diagrams#2'], page: 'as-is', reel: null, seconds: 3.5, needs: ['structure:tree'], expect: ['root', 'subject', 'predicate', 'noun', 'verb', 'object'] }),
  live({ id: 'cycle', category: 'diagrams', name: 'A cycle', caption: 'Things that go round, drawn as a ring that closes.', today: ['diagrams#3'], page: 'as-is', reel: null, seconds: 3.0, needs: ['structure:cycle'], expect: ['sea', 'cloud', 'rain', 'river'] }),
  live({ id: 'timeline', category: 'diagrams', name: 'A timeline', caption: 'Dates placed to scale along a line.', today: ['diagrams#4'], page: 'as-is', reel: 2.5, needs: ['structure:timeline'], expect: ['tl', 'sputnik', 'gagarin', 'apollo', 'programme'] }),
  live({ id: 'cutaway', category: 'diagrams', name: 'A labelled figure', caption: 'A cutaway drawing with every part named.', today: ['language/src/figure.ts:228'], page: 'new', reel: 3.0, needs: ['structure:figure'], expect: ['heart'], note: 'the taught example in figure.ts' }),
  live({ id: 'pins', category: 'diagrams', name: 'Pins on a map', caption: 'Places marked as pins on a route, each label clear of the others.', today: [], page: 'new', reel: null, seconds: 3.5, needs: ['structure:map'], expect: ['trip', 'station', 'market', 'library', 'park', 'harbour'] }),

  // Numbers
  live({ id: 'chart', category: 'numbers', name: 'A chart', caption: 'Your numbers as a chart with real axes and a crosshair you can move.', today: ['charts#1'], page: 'as-is', reel: 3.0, needs: ['structure:chart', 'chart:line'], expect: ['loaf'] }),
  live({ id: 'table', category: 'numbers', name: 'A table', caption: 'Rows and columns with the numbers lined up and shown as bars.', today: ['diagrams#5'], page: 'as-is', reel: null, seconds: 3.0, needs: ['structure:table'], expect: ['tea'] }),
  live({ id: 'maths', category: 'numbers', name: 'Sums as on paper', caption: 'A sum set out in columns as a child writes it, with empty boxes for the answer.', today: ['maths#2'], page: 'as-is', reel: 3.0, needs: ['structure:math'], expect: ['m2'] }),
  live({ id: 'sum', category: 'numbers', name: 'It checks your answer', caption: 'It asks before it tells. Write the answer and it is marked.', today: ['problem#3'], page: 'cut', reel: 3.0, needs: ['structure:problem'], expect: ['p3'], turns: [script('# the answer, written in the blank', 'fill p3 | 83', 'wait 1.5s')] }),

  // Things that work
  live({ id: 'switch', category: 'works', name: 'Switches and picks', caption: 'Flip a switch or pick a colour and the drawing changes at once.', today: ['controls#1'], page: 'cut', reel: null, seconds: 3.0, needs: ['control:toggle', 'control:pick'], expect: ['bulb', 'power', 'mood'] }),
  live({ id: 'app', category: 'works', name: 'A small app', caption: 'A working counter, game or tool that runs on the canvas in a locked box.', today: [], page: 'new', reel: null, seconds: 3.0, needs: ['structure:app'], expect: ['tally'], note: 'a counter written for the page: app#1 is the Galton board now' }),
  live({ id: 'mockup', category: 'works', name: 'An app mock-up', caption: 'A phone screen with real fields and buttons at its true size.', today: ['language/src/interface.ts:674'], page: 'new', reel: 2.5, needs: ['structure:screen'], expect: ['x1'], note: 'the taught example in interface.ts; x1 is the block that holds the screen s1' }),
  live({ id: 'music', category: 'works', name: 'A tune you can hear', caption: 'It writes the notes; the canvas draws and plays them.', today: ['tune#1'], page: 'new', reel: 3.5, needs: ['structure:tune'], expect: ['riff'], note: 'two bars' }),

  // It keeps going
  live({ id: 'changes', category: 'keeps', name: 'It edits, not redraws', caption: 'Ask for a bigger sail and one line arrives. The boat is not redrawn.', today: ['iterate#1'], page: 'cut', reel: 3.5, needs: [], expect: ['hull', 'mast', 'sail'], turns: [script('# one line: a bigger sail', 'poly sail 80,22 80,56 116,56 fill=accent', 'say enter=fade by=all | One line changed; nothing else moved.', 'wait 0.5s')] }),
  live({ id: 'undo', category: 'keeps', name: 'Undo', caption: 'One tap puts the drawing back as it was.', today: ['the Undo chip'], page: 'hand', reel: null, needs: [], expect: [] }),
  live({ id: 'back', category: 'keeps', name: 'It remembers drawings', caption: 'An earlier drawing returns whole.', today: ['language/src/tour.ts MEMORY_STEPS 1-3'], page: 'as-is', reel: 4.0, extra: 0.2, needs: [], expect: ['moon1', 'trunk1', 'crown1'], turns: [script('# a different drawing', 'scene day figure lines=1 brisk', 'circle sun2 120,20 10 fill=accent stroke=none', 'rect house2 @with 40,40 50x34 fill=ink', 'poly roof2 @with 36,40 65,22 94,40 fill=alt', 'wait 0.5s'), script('# the first drawing comes back whole', 'restore {1}', 'wait 2.1s')] }),
  live({ id: 'stream', category: 'keeps', name: 'It shows its working', caption: 'Open the language view and watch the lines that make the picture.', today: ['the tour chapter language'], page: 'hand', reel: 3.5, needs: [], expect: [] }),

  // Not yet: no page, not on the overview, not in the reel
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
  /** how long an entry's page lasts: its seconds in the reel, else its own `seconds`; null for an entry with no page of its own */
  pageSeconds(entry: ShowcaseEntry): number | null;
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
    pageSeconds: (entry) => entry.reel ?? entry.seconds ?? null,
    summary: () => `showcase: ${works().length} live, ${entries.length - works().length} not yet (${entries.filter((entry) => entry.status === 'not yet').map((entry) => entry.id).join(', ')})`,
  };
}
