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
  EMPTY_STAGE,
  FULL_CAPABILITIES,
  FX_NAMES,
  heldTourCards,
  LineNormalizer,
  LineReader,
  LOOK_IDS,
  offeredChapters,
  parseLine,
  PROCEDURAL_MEDIA,
  readShowcase,
  serializeLine,
  settle,
  SHOWCASE_LIMITS,
  SHOWCASE_PAGE,
  SHOWCASE_REEL,
  STROKES,
  STRUCTURE_KINDS,
  TEXTURES,
  TOUR_CHAPTERS,
  tourActionOf,
  tourTryFor,
  TurnScore,
} from '../src/index';
import type { Line, ShowcaseReader, StageBase, TourChapter, TurnOpening } from '../src/index';

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

// ------------------------------------------------------------------------------------------------------------------------------ the pages

/** The pages of one category's file, by scene id: each is the lines from its `scene` line down, with the comments written just above it. */
function pageChunks(path: string): Map<string, string> {
  const chunks = new Map<string, string>();
  let pending: string[] = [];
  let current: string[] | null = null;
  let id: string | null = null;
  const close = (): void => {
    if (current !== null && id !== null && !chunks.has(id)) chunks.set(id, current.join('\n'));
  };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      pending = [];
      continue;
    }
    if (/^scene(\s|$)/.test(trimmed)) {
      close();
      const read = parseLine(raw);
      id = read.kind === 'line' && read.line.verb === 'scene' ? (read.line.id ?? null) : null;
      current = [...pending, raw];
      pending = [];
    } else if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
      pending.push(raw);
    } else {
      if (current !== null) current.push(...pending);
      pending = [];
      current?.push(raw);
    }
  }
  close();
  return chunks;
}

/** What a turn of a page comes to, played alone on the stage the turns before it left. */
interface TurnFacts {
  /** the turn's own end, seconds */
  readonly end: number;
  /** when the last thing arrived: an entrance, a change of something already there, a look */
  readonly arrived: number;
  readonly lines: number;
  /** the `say` lines: how many words, whether it is narration (no id, in the flow), and when it had arrived */
  readonly says: readonly { readonly words: number; readonly narration: boolean; readonly arrived: number; readonly text: string }[];
  readonly ids: readonly string[];
  readonly problems: string[];
  readonly stage: StageBase;
  /** each line with when it starts and ends, for `pnpm timeline showcase <id>` */
  readonly listing: readonly string[];
  readonly first: Line | null;
  readonly second: Line | null;
}

const wordsOf = (text: string): number => text.replace(/\{[^}]*\}/g, 'N').replace(/\*/g, '').trim().split(/\s+/).filter((word) => word.length > 0).length;

function playTurn(source: string, base: StageBase, opened: TurnOpening, who: string): TurnFacts {
  const problems: string[] = [];
  const score = new TurnScore(base, opened);
  const reader = new LineReader();
  let seq = 0;
  let auto = 0;
  let lines = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  const said = new Map<number, { words: number; narration: boolean; text: string }>();
  const kept: Line[] = [];
  source.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === '' || (trimmed.startsWith('#') && !trimmed.startsWith('#!'))) return;
    lines += 1;
    const read = reader.read(raw);
    if (read.kind === 'reject') problems.push(`${who}: line ${index + 1} is rejected: ${raw.trim().slice(0, 60)}`);
    if (read.kind !== 'line') return;
    const normalized = normalizer.normalize(read.line);
    if (normalized.line === null) {
      problems.push(`${who}: line ${index + 1} is dropped: ${raw.trim().slice(0, 60)}`);
      return;
    }
    seq += 1;
    const pushed = score.push(normalized.line, seq, 0);
    for (const issue of [...read.issues, ...normalized.issues, ...pushed.issues]) if (issue.severity === 'error' || issue.severity === 'warn') problems.push(`${who}: line ${index + 1} ${issue.code}: ${issue.message.slice(0, 80)}`);
    kept.push(read.line);
    if (read.line.verb === 'say') {
      const anonymous = read.line.id === '-' && read.line.props.at === undefined && read.line.props.near === undefined && read.line.props.in === undefined;
      said.set(seq, { words: wordsOf(read.line.text), narration: anonymous, text: read.line.text });
    }
  });
  const schedule = score.schedule;
  const texts = new Map<number, string>();
  for (const entry of score.score) if (!entry.void) texts.set(entry.seq, serializeLine(entry.line));
  const arrivals = [
    ...schedule.elements.flatMap((element) => (element.enter === null || element.carried ? [] : [element.enter.end])),
    // a ride along a path is motion for as long as it goes, not a thing arriving; every other change (a morph, a set, a move to a place) is
    ...schedule.elements.flatMap((element) => element.changes.filter((change) => !(change.kind === 'move' && change.along !== null)).map((change) => change.end)),
    ...schedule.looks.map((look) => look.end),
  ];
  const says = [...said].map(([at, info]) => ({ ...info, arrived: schedule.elements.find((element) => element.seq === at)?.enter?.end ?? 0 }));
  return {
    end: schedule.end,
    arrived: Math.max(0, ...arrivals),
    lines,
    says,
    ids: schedule.elements.map((element) => element.id),
    problems,
    stage: settle(schedule, base, schedule.end),
    listing: schedule.lines.map((time) => `    ${time.start.toFixed(2).padStart(6)} -> ${time.end.toFixed(2).padStart(6)}  ${(texts.get(time.seq) ?? '').slice(0, 100)}`),
    first: kept[0] ?? null,
    second: kept[1] ?? null,
  };
}

export interface PageFacts {
  readonly id: string;
  readonly seconds: number | null;
  /** the page's end: the turns' ends added */
  readonly end: number;
  readonly lines: number;
  readonly narration: number;
  readonly words: number;
  /** from the last arrival to the end, in the last turn */
  readonly hold: number;
  readonly turns: number;
  readonly problems: string[];
  readonly listing: readonly string[];
}

/** The page of every entry that has one, played turn by turn on the language's own schedule and held to `SHOWCASE_PAGE`. Empty while there is no folder of pages. */
export function pageFacts(reader: ShowcaseReader, pagesDir: string = PAGES_DIR): PageFacts[] {
  const facts: PageFacts[] = [];
  if (!existsSync(pagesDir)) return facts;
  const chunks = new Map<string, string>();
  for (const category of reader.categories) {
    const path = `${pagesDir}${category.id}.series`;
    if (existsSync(path)) for (const [id, source] of pageChunks(path)) if (!chunks.has(id)) chunks.set(id, source);
  }
  for (const entry of reader.live()) {
    const source = chunks.get(entry.id);
    if (source === undefined || entry.page === 'hand' || entry.page === 'recorded') continue;
    const who = entry.id;
    const problems: string[] = [];
    const seconds = reader.pageSeconds(entry);
    const scripts = [source, ...(entry.turns ?? []).map((turn) => turn.replaceAll('{1}', 't1'))];
    let base: StageBase = EMPTY_STAGE;
    const played: TurnFacts[] = [];
    scripts.forEach((script, at) => {
      const turn = playTurn(script, base, at === 0 ? 'none' : 'script', who);
      played.push(turn);
      base = turn.stage;
    });
    const first = played[0];
    const last = played[played.length - 1];
    if (first === undefined || last === undefined) continue;
    for (const turn of played) problems.push(...turn.problems);
    // the opening: the scene says its layout and `brisk`, the next line chooses the look
    const scene = first.first;
    if (scene === null || scene.verb !== 'scene') problems.push(`${who}: the page does not open with its scene line`);
    else {
      if (scene.id !== entry.id) problems.push(`${who}: the scene is called "${scene.id ?? ''}"`);
      if (scene.layout === undefined) problems.push(`${who}: the scene line does not say its layout`);
      if (scene.pace !== 'brisk') problems.push(`${who}: the scene line does not say brisk`);
    }
    if (first.second === null || first.second.verb !== 'look') problems.push(`${who}: the line after the scene is not a look`);
    const lines = played.reduce((sum, turn) => sum + turn.lines, 0);
    if (lines > SHOWCASE_PAGE.lines) problems.push(`${who}: ${lines} lines (at most ${SHOWCASE_PAGE.lines})`);
    const says = played.flatMap((turn) => turn.says);
    const narration = says.filter((line) => line.narration);
    if (narration.length > SHOWCASE_PAGE.narration) problems.push(`${who}: ${narration.length} narration lines (at most ${SHOWCASE_PAGE.narration}): a page narrates once`);
    for (const line of says) if (line.words > SHOWCASE_PAGE.words) problems.push(`${who}: a line of ${line.words} words (at most ${SHOWCASE_PAGE.words}): "${line.text.slice(0, 40)}"`);
    const words = says.reduce((sum, line) => sum + line.words, 0);
    if (words > SHOWCASE_PAGE.all) problems.push(`${who}: ${words} words said in all (at most ${SHOWCASE_PAGE.all})`);
    // the end: the turns together last the page's seconds, and the last thing arrives with time to look at it
    const end = played.reduce((sum, turn) => sum + turn.end, 0) + (entry.extra ?? 0);
    if (seconds === null) problems.push(`${who}: the page has no seconds (reel, or seconds)`);
    else {
      if (seconds < SHOWCASE_PAGE.min || seconds > SHOWCASE_PAGE.max) problems.push(`${who}: ${seconds} s is not ${SHOWCASE_PAGE.min}..${SHOWCASE_PAGE.max}`);
      if (Math.abs(end - seconds) > SHOWCASE_PAGE.tolerance) problems.push(`${who}: the page ends at ${end.toFixed(2)} s, not within ${SHOWCASE_PAGE.tolerance} s of its ${seconds} s`);
    }
    const hold = last.end - last.arrived;
    if (hold < SHOWCASE_PAGE.hold - 0.005) problems.push(`${who}: the last thing arrives ${hold.toFixed(2)} s before the end (at least ${SHOWCASE_PAGE.hold} s)`);
    // fb-023: a line stays up as long as reading it takes, counted from when it has arrived
    for (const line of last.says) {
      const need = line.words / SHOWCASE_PAGE.reading;
      if (last.end - line.arrived < need - 0.005) problems.push(`${who}: "${line.text.slice(0, 30)}" stays up ${(last.end - line.arrived).toFixed(2)} s, and reading it takes ${need.toFixed(2)} s`);
    }
    // what the page claims to show is there to be shown (a drawn figure's parts are made from its `draw` line by the server)
    const made = new Set(played.flatMap((turn) => turn.ids));
    const drawn = [...made].filter((id) => scripts.some((script) => new RegExp(`^draw\\s+${id}\\b`, 'm').test(script)));
    for (const id of entry.expect) if (!made.has(id) && !drawn.some((own) => id.startsWith(`${own}-`))) problems.push(`${who}: expect names "${id}", which no line of the page makes`);
    facts.push({ id: entry.id, seconds, end, lines, narration: narration.length, words, hold, turns: played.length, problems, listing: played.flatMap((turn, at) => [`  turn ${at + 1}: ends ${turn.end.toFixed(2)} s, arrived ${turn.arrived.toFixed(2)} s`, ...turn.listing]) });
  }
  return facts;
}

/** The pages as a table: what `pnpm timeline showcase` prints while they are being tuned, or with an id the lines of that page and what is wrong with it. */
export function pageTable(reader: ShowcaseReader, only: string | undefined = undefined): string {
  if (only !== undefined) {
    const fact = pageFacts(reader).find((entry) => entry.id === only);
    return fact === undefined ? `  no page ${only}` : [`  ${fact.id}: ${fact.seconds ?? '-'} s, ends ${fact.end.toFixed(2)} s (${fact.seconds === null ? '' : `${fact.seconds - fact.end >= 0 ? 'wait ' : 'cut '}${Math.abs(fact.seconds - fact.end).toFixed(2)} s`}), hold ${fact.hold.toFixed(2)} s`, ...fact.listing, ...fact.problems.map((problem) => `  ! ${problem}`)].join('\n');
  }
  const rows = pageFacts(reader).map((fact) => `  ${fact.id.padEnd(10)} ${String(fact.seconds ?? '-').padStart(4)} s  end ${fact.end.toFixed(2).padStart(5)} (${fact.seconds === null ? '' : (fact.seconds - fact.end).toFixed(2).padStart(5)})  hold ${fact.hold.toFixed(2).padStart(5)}  ${String(fact.lines).padStart(2)} lines  ${fact.words} words  ${fact.turns} turn${fact.turns === 1 ? '' : 's'}${fact.problems.length > 0 ? `  <- ${fact.problems.length} to fix` : ''}`);
  return rows.join('\n');
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
    if (entry.still !== undefined && (entry.still <= 0 || entry.still >= (entry.reel ?? entry.seconds ?? 0))) problems.push(`${at} the still is taken at ${entry.still} s, which is not inside the page`);
    if (entry.turns !== undefined && entry.turns.length < 1) problems.push(`${at} a page that takes turns holds the scripts of the turns after its scene`);
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
    for (const fact of pageFacts(reader, pagesDir)) problems.push(...fact.problems);
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

export function showcaseChecks(table = false): boolean {
  const reader = readShowcase();
  const problems = [...showcaseProblems(reader), ...tourProblems()];
  process.stdout.write(`\n${reader.summary()}\n`);
  const pending = reader.live().filter((entry) => entry.page !== 'hand' && entry.page !== 'recorded').length;
  process.stdout.write(`  reel ${reader.reelSeconds()} s from ${reader.reel().length} pages; ${existsSync(PAGES_DIR) ? 'pages checked' : `pages not written yet (S1): ${pending} to write`}\n`);
  if (table) process.stdout.write(`${pageTable(reader, process.argv[3])}\n`);
  for (const problem of problems) process.stdout.write(`  SHOWCASE CHECK FAILED: ${problem}\n`);
  return problems.length === 0;
}
