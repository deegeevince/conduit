// The capability catalogue's table (language/src/showcase.ts) and the tour's list of what is judged: pure checks, no browser. Run by `pnpm timeline`.
// The check group that plays each page and compares the table with the painter is the server's (S2); this holds what needs no painter.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AMBIENT_KINDS,
  CAMERA_MOVES,
  CHART_KINDS,
  chapterSource,
  CONTROL_KINDS,
  DEMOS_NOT_PAINTED,
  ELEMENT_KINDS,
  FULL_CAPABILITIES,
  FX_NAMES,
  heldTourCards,
  LOOK_IDS,
  offeredChapters,
  parseLine,
  PROCEDURAL_MEDIA,
  readShowcase,
  SHOWCASE_LIMITS,
  SHOWCASE_REEL,
  STROKES,
  STRUCTURE_KINDS,
  TEXTURES,
  TOUR_CHAPTERS,
  tourActionOf,
  tourTryFor,
} from '../src/index';
import type { ShowcaseReader, TourChapter } from '../src/index';

const DEMOS_DIR = fileURLToPath(new URL('../demos/', import.meta.url));
const PAGES_DIR = `${DEMOS_DIR}showcase/`;

/** What each kind of `needs` entry may name. A `flag` is a switch of `Capabilities`; a `feature` is a name the painter has no list for yet. */
const NEED_NAMES: Readonly<Record<string, readonly string[] | null>> = {
  structure: STRUCTURE_KINDS,
  chart: CHART_KINDS,
  control: CONTROL_KINDS,
  medium: PROCEDURAL_MEDIA,
  look: LOOK_IDS,
  camera: CAMERA_MOVES,
  ambient: AMBIENT_KINDS,
  fx: FX_NAMES,
  texture: TEXTURES,
  brush: STROKES,
  kind: ELEMENT_KINDS,
  flag: Object.entries(FULL_CAPABILITIES).filter(([, value]) => typeof value === 'boolean').map(([key]) => key),
  feature: null,
};

/** The scenes of a `.series` file, in order: their ids (null where a scene has none), read as the language reads a scene line. */
function scenesOf(path: string): (string | null)[] {
  const scenes: (string | null)[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!/^scene(\s|$)/.test(raw)) continue;
    const read = parseLine(raw);
    scenes.push(read.kind === 'line' && read.line.verb === 'scene' ? (read.line.id ?? null) : null);
  }
  return scenes;
}

/** Whether `today` names a scene of a demo that is there: `file#n` (the nth scene) or `file#id`. Anything else points at code or the app and is not looked up. */
function sceneResolves(ref: string): boolean | null {
  const match = /^([a-z]+)#([a-z0-9-]+)$/.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const path = `${DEMOS_DIR}${match[1]}.series`;
  if (!existsSync(path)) return false;
  const scenes = scenesOf(path);
  return /^\d+$/.test(match[2]) ? Number(match[2]) >= 1 && Number(match[2]) <= scenes.length : scenes.includes(match[2]);
}

/** Everything wrong with the table, one sentence each. `pagesDir` is where the pages go once S1 lands; while it is not there no page is looked for. */
export function showcaseProblems(reader: ShowcaseReader, pagesDir: string = PAGES_DIR): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const kinds = new Set<string>(reader.categories.map((category) => category.id));
  if (kinds.size !== reader.categories.length) problems.push('two categories share an id');
  for (const category of reader.categories) {
    if (category.name.length === 0 || category.name.length > SHOWCASE_LIMITS.name) problems.push(`category ${category.id}: name "${category.name}" is ${category.name.length} characters (1..${SHOWCASE_LIMITS.name})`);
    if (category.gist.length === 0 || category.gist.length > SHOWCASE_LIMITS.gist) problems.push(`category ${category.id}: gist is ${category.gist.length} characters (1..${SHOWCASE_LIMITS.gist})`);
  }
  for (const entry of reader.entries) {
    const at = `${entry.id}:`;
    if (!/^[a-z][a-z0-9]*$/.test(entry.id)) problems.push(`${at} the id is not lower-case letters and digits`);
    if (seen.has(entry.id)) problems.push(`${at} the id is used twice`);
    seen.add(entry.id);
    if (!kinds.has(entry.category)) problems.push(`${at} the category "${entry.category}" is not one of the seven`);
    if (entry.name.length === 0 || entry.name.length > SHOWCASE_LIMITS.name) problems.push(`${at} the name "${entry.name}" is ${entry.name.length} characters (1..${SHOWCASE_LIMITS.name})`);
    if (entry.caption.length === 0 || entry.caption.length > SHOWCASE_LIMITS.caption) problems.push(`${at} the caption is ${entry.caption.length} characters (1..${SHOWCASE_LIMITS.caption})`);
    if (entry.status === 'live') {
      if (entry.page === null) problems.push(`${at} a live entry has no page kind`);
      if (entry.waits !== undefined) problems.push(`${at} a live entry waits on ${entry.waits}`);
    } else {
      if (entry.page !== null || entry.reel !== null || entry.expect.length > 0) problems.push(`${at} a "not yet" entry has no page, no reel seconds and nothing to expect`);
      if (entry.waits === undefined || entry.waits.length === 0) problems.push(`${at} a "not yet" entry says what it waits on`);
      if (entry.needs.length === 0) problems.push(`${at} a "not yet" entry names what it needs, or the painter cannot say when it works`);
    }
    if (entry.reel !== null && (entry.reel < 2 || entry.reel > 4.5)) problems.push(`${at} ${entry.reel} s in the reel (2..4.5)`);
    if (entry.turns !== undefined && entry.turns.length < 2) problems.push(`${at} a page that takes turns takes at least two`);
    for (const need of entry.needs) {
      const [dimension, name, ...rest] = need.split(':');
      const names = dimension === undefined ? undefined : NEED_NAMES[dimension];
      if (dimension === undefined || names === undefined || name === undefined || name.length === 0 || (names !== null && !names.includes(name))) {
        problems.push(`${at} needs "${need}", which names nothing the painter lists`);
      } else if (rest.length > 0) problems.push(`${at} needs "${need}" is not kind:name`);
    }
    for (const ref of entry.today) if (sceneResolves(ref) === false) problems.push(`${at} today "${ref}" is not a scene of a demo`);
  }
  for (const category of reader.categories) {
    const held = reader.band(category.id).length;
    if (held > SHOWCASE_LIMITS.perCategory) problems.push(`category ${category.id}: ${held} entries that work (at most ${SHOWCASE_LIMITS.perCategory})`);
    if (held === 0) problems.push(`category ${category.id}: nothing in it works`);
  }
  const seconds = reader.reelSeconds();
  if (seconds < SHOWCASE_REEL.min || seconds > SHOWCASE_REEL.max) problems.push(`the reel is ${seconds} s (${SHOWCASE_REEL.min}..${SHOWCASE_REEL.max})`);
  // Once the pages exist (S1), each entry kept as a scene is one: in its category's file, under its own id, and says what it shows.
  if (existsSync(pagesDir)) {
    const ids = new Map<string, string>();
    for (const category of reader.categories) {
      const path = `${pagesDir}${category.id}.series`;
      if (!existsSync(path)) {
        if (reader.band(category.id).some((entry) => entry.page !== 'hand' && entry.page !== 'recorded')) problems.push(`category ${category.id}: no page file ${category.id}.series`);
        continue;
      }
      for (const id of scenesOf(path)) if (id !== null) ids.set(id, category.id);
    }
    for (const file of readdirSync(pagesDir).filter((name) => name.endsWith('.series'))) {
      if (!kinds.has(file.replace(/\.series$/, ''))) problems.push(`pages: ${file} is not a category's file`);
    }
    for (const entry of reader.live()) {
      if (entry.page === 'hand' || entry.page === 'recorded') continue;
      if (ids.get(entry.id) !== entry.category) problems.push(`${entry.id}: no scene "${entry.id}" in ${entry.category}.series`);
      if (entry.expect.length === 0) problems.push(`${entry.id}: the page says nothing it must show (expect)`);
    }
    for (const [id, category] of ids) {
      const entry = reader.entry(id);
      if (entry === null || entry.status !== 'live' || entry.category !== category) problems.push(`pages: the scene "${id}" in ${category}.series is not a live entry of that category`);
      else if (entry.page === 'hand' || entry.page === 'recorded') problems.push(`pages: the scene "${id}" is a ${entry.page} entry and has no page of its own`);
    }
  }
  return problems;
}

/** The tour lists only what is judged: a card whose demo the painter does not paint yet is not offered, nor named in the chapter's gist. */
export function tourProblems(): string[] {
  const problems: string[] = [];
  const sample: TourChapter = {
    id: 'x',
    title: 'X',
    gist: 'one, held, two',
    cards: [
      { kind: 'demo', label: 'One', name: 'one', tryText: 'one' },
      { kind: 'demo', label: 'Held', name: 'held', gistTerm: 'held', tryText: 'held' },
      { kind: 'memory', label: 'Memory', tryText: 'memory' },
    ],
  };
  const held = offeredChapters([sample], ['held'])[0];
  if (held === undefined || held.cards.map((card) => card.label).join('|') !== 'One|Memory') problems.push('a card of a held demo is still offered, or a card that is not a demo was dropped');
  if (held?.gist !== 'one, two') problems.push(`the gist of a chapter keeps the word of a held demo ("${held?.gist}")`);
  const free = offeredChapters([sample], [])[0];
  if (free === undefined || free.cards.length !== 3 || free.gist !== 'one, held, two') problems.push('with nothing held, the chapter is not whole');
  const heldCards = heldTourCards();
  for (const chapter of TOUR_CHAPTERS) {
    const page = chapterSource(chapter.id);
    for (const card of chapter.cards) if (card.kind === 'demo' && DEMOS_NOT_PAINTED.includes(card.name)) problems.push(`the tour offers "${card.label}", whose demo ${card.name} is not painted`);
    for (const card of heldCards) if (page.includes(`| ${card.label}`)) problems.push(`the page of "${chapter.title}" lists "${card.label}", whose demo ${card.name} is not painted`);
  }
  for (const card of heldCards) {
    if (tourActionOf(card.label) !== null) problems.push(`a tap on "${card.label}" is still the tour's, though ${card.name} is not painted`);
    if (tourTryFor(card.name) === null) problems.push(`/demo ${card.name} has lost its "Try it yourself"`);
    const chapter = TOUR_CHAPTERS.find((entry) => entry.gist.split(', ').includes(card.gistTerm ?? '\u0000'));
    if (chapter !== undefined) problems.push(`the gist of "${chapter.title}" still says "${card.gistTerm}"`);
  }
  return problems;
}

export function showcaseChecks(): boolean {
  const reader = readShowcase();
  const problems = [...showcaseProblems(reader), ...tourProblems()];
  process.stdout.write(`\n${reader.summary()}\n`);
  const pending = reader.live().filter((entry) => entry.page !== 'hand' && entry.page !== 'recorded').length;
  process.stdout.write(`  reel ${reader.reelSeconds()} s from ${reader.reel().length} pages; ${existsSync(PAGES_DIR) ? 'pages checked' : `pages not written yet (S1): ${pending} to write`}\n`);
  for (const problem of problems) process.stdout.write(`  SHOWCASE CHECK FAILED: ${problem}\n`);
  return problems.length === 0;
}
