// The shelf: finished art by name (PLAN-art.md, section 6). Two places hold sheets: `art/seed/*.json` in the repository, and
// `<DATA_DIR>/cache/art/<key>.json` (modelled on `pictures/cache.ts`: owner-only files with hex names, written through a rename).
// A sheet is checked by `readSheet` whenever it is read; one that fails is left out and logged, never put on stage.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../log';
import { readSheet } from './sheet';
import type { Sheet } from './sheet';

// ---- the words of a subject, and of a pose ----

const IRREGULAR: Readonly<Record<string, string>> = { children: 'child', mice: 'mouse', leaves: 'leaf', wolves: 'wolf', geese: 'goose', feet: 'foot', men: 'man', women: 'woman', people: 'person' };

/** A simple singular: foxes to fox, puppies to puppy, monsters to monster; bus, grass and iris are left alone. */
export function singular(word: string): string {
  const odd = IRREGULAR[word];
  if (odd !== undefined) return odd;
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|x|ss|zz)es$/.test(word)) return word.slice(0, -2);
  if (/(?:ss|us|is)$/.test(word)) return word;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** The words a brain says for what the shelf calls something else. The shelf's names are the values. */
const SYNONYMS: Readonly<Record<string, string>> = {
  kid: 'child', boy: 'child', girl: 'child', toddler: 'child', youngster: 'child', schoolchild: 'child', schoolkid: 'child',
  spaceship: 'rocket', 'space-ship': 'rocket', 'rocket-ship': 'rocket', rocketship: 'rocket', shuttle: 'rocket', 'space-rocket': 'rocket',
  home: 'house', cottage: 'house', cabin: 'house', hut: 'house', bungalow: 'house',
  creature: 'monster', beast: 'monster', troll: 'monster', ogre: 'monster', 'woodland-monster': 'monster',
  tree: 'oak-tree', oak: 'oak-tree', 'big-tree': 'oak-tree',
  vixen: 'fox', 'red-fox': 'fox',
};

/** The shelf's names a subject might be, best first: the whole phrase, then its last word and each earlier one (`red fox` finds `fox`). */
export function subjectCandidates(subject: string): string[] {
  const tokens = subject.toLowerCase().replace(/[^a-z0-9 -]+/g, ' ').split(/[\s]+/).filter((word) => word !== '' && !['a', 'an', 'the', 'some', 'of', 'little', 'small', 'big', 'cute', 'happy', 'friendly'].includes(word)).map((word) => singular(word.replace(/^-+|-+$/g, '')));
  const out: string[] = [];
  const add = (name: string): void => {
    const mapped = SYNONYMS[name] ?? name;
    if (name !== '' && !out.includes(mapped)) out.push(mapped);
    if (name !== '' && !out.includes(name)) out.push(name);
  };
  if (tokens.length > 1) add(tokens.join('-'));
  for (let i = tokens.length - 1; i >= 0; i -= 1) add(tokens[i] ?? '');
  return out;
}

/** The first of a subject's candidates: the name it is filed under in the shelf's key. */
export function normaliseSubject(subject: string): string {
  return subjectCandidates(subject)[0] ?? '';
}

const POSES: Readonly<Record<string, string>> = {
  sitting: 'sitting', sit: 'sitting', sits: 'sitting', seated: 'sitting',
  standing: 'standing', stand: 'standing', stands: 'standing',
  walking: 'walking', walk: 'walking', running: 'running', run: 'running', jumping: 'jumping', jump: 'jumping', leaping: 'jumping',
  sleeping: 'sleeping', sleep: 'sleeping', asleep: 'sleeping', lying: 'lying', resting: 'lying',
  waving: 'waving', wave: 'waving', flying: 'flying', fly: 'flying', crouching: 'crouching', pouncing: 'pouncing', launching: 'launching', blasting: 'launching',
};
const VIEWS: Readonly<Record<string, string>> = { front: 'front', frontal: 'front', side: 'side', profile: 'side', back: 'back', behind: 'back', 'three-quarter': 'three-quarter' };

export interface Wanted {
  readonly pose: string | null;
  readonly view: string | null;
  readonly facing: 'left' | 'right' | null;
  readonly mood: string | null;
}

/** What the words after the bar ask for: `sitting, facing left, curious`. */
export function wantedIn(detail: string): Wanted {
  let pose: string | null = null;
  let view: string | null = null;
  let facing: 'left' | 'right' | null = null;
  const rest: string[] = [];
  const said = detail.toLowerCase().replace(/[^a-z0-9, -]+/g, ' ');
  const left = /\b(?:facing|looking|turned|towards?|to the|pointing)\s+(?:the\s+)?(left|right)\b|\b(left|right)(?:-facing| facing)\b/.exec(said);
  if (left !== null) facing = (left[1] ?? left[2]) === 'left' ? 'left' : 'right';
  for (const word of said.split(/[\s,]+/)) {
    if (word === '') continue;
    if (pose === null && POSES[word] !== undefined) pose = POSES[word] ?? null;
    else if (view === null && VIEWS[word] !== undefined) view = VIEWS[word] ?? null;
    else if (!['facing', 'looking', 'left', 'right', 'the', 'and', 'a', 'to', 'turned', 'towards', 'toward', 'pointing', 'view', 'from'].includes(word)) rest.push(word);
  }
  return { pose, view, facing, mood: rest.length === 0 ? null : rest.join(' ').slice(0, 40) };
}

/** The key of a sheet's place on the shelf: the subject, then the pose and view when it has them. */
export function shelfKey(subject: string, pose: string | null, view: string | null): string {
  return [subject, ...(pose === null || pose === '' ? [] : [pose]), ...(view === null || view === '' ? [] : [view])].join('.');
}

export const KEY_PATTERN = /^[0-9a-f]{24}$/;
/** The file a cached sheet lives in: a hash of what makes it a different drawing, so the same words never write two files. */
export function cacheName(sheet: Sheet): string {
  return createHash('sha256').update(`${sheet.subject}\n${sheet.pose}\n${sheet.view}\n${sheet.made.by}\n${sheet.made.arm}`).digest('hex').slice(0, 24);
}

// ---- the shelf ----

export interface Found {
  /** the shelf's name for the subject */
  readonly subject: string;
  /** every sheet of the best kind, in a fixed order: the conversation's cast picks among them */
  readonly sheets: readonly Sheet[];
  /** the pose asked for is the pose of these sheets (or none was asked for) */
  readonly poseMatch: boolean;
}

export interface Shelf {
  find(subject: string, want: Pick<Wanted, 'pose' | 'view'>): Found | null;
  /** keeps a sheet in the cache and on the shelf; the caller has checked it with `readSheet` */
  write(sheet: Sheet): Promise<void>;
  subjects(): readonly string[];
  count(): number;
}

export interface ShelfOptions {
  /** `art/seed` in the repository */
  readonly seedDir: string;
  /** `<DATA_DIR>/cache/art`, or null for a shelf of seeds alone */
  readonly cacheDir: string | null;
  readonly log?: Logger;
}

interface Entry {
  readonly sheet: Sheet;
  /** where it came from, for the order: seeds first, by file name */
  readonly origin: string;
}

function loadDir(dir: string, label: string, log: Logger | undefined): Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const name of names) {
    try {
      const read = readSheet(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (read.ok) out.push({ sheet: read.sheet, origin: `${label}/${name}` });
      else log?.warn('art.sheet_refused', { file: `${label}/${name}`, reason: read.reason });
    } catch (error) {
      log?.warn('art.sheet_unreadable', { file: `${label}/${name}`, error });
    }
  }
  return out;
}

export function createShelf(options: ShelfOptions): Shelf {
  const { seedDir, cacheDir, log } = options;
  const seeds = loadDir(seedDir, 'seed', log);
  let cached: Entry[] = cacheDir === null ? [] : loadDir(cacheDir, 'cache', log);
  let cacheStamp = stamp(cacheDir);
  const added: Entry[] = [];

  function stamp(dir: string | null): number {
    try {
      return dir === null || !existsSync(dir) ? 0 : statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  }
  const all = (): Entry[] => {
    // what another process wrote into the cache since the last look is picked up here, and cheaply: one stat
    const now = stamp(cacheDir);
    if (cacheDir !== null && now !== cacheStamp) {
      cached = loadDir(cacheDir, 'cache', log);
      cacheStamp = now;
    }
    return [...seeds, ...cached, ...added];
  };
  const known = (sheet: Sheet): boolean => all().some((entry) => entry.sheet.subject === sheet.subject && entry.sheet.pose === sheet.pose && entry.sheet.view === sheet.view && entry.sheet.made.by === sheet.made.by && entry.sheet.made.arm === sheet.made.arm);

  return {
    find(subject, want) {
      const entries = all();
      for (const candidate of subjectCandidates(subject)) {
        const of = entries.filter((entry) => entry.sheet.subject === candidate);
        if (of.length === 0) continue;
        // a pose match first, then a view match; anything of the subject otherwise
        const score = (sheet: Sheet): number => (want.pose !== null && sheet.pose === want.pose ? 2 : 0) + (want.view !== null && sheet.view === want.view ? 1 : 0);
        const best = Math.max(...of.map((entry) => score(entry.sheet)));
        const tier = of.filter((entry) => score(entry.sheet) === best).sort((a, b) => a.origin.localeCompare(b.origin));
        return { subject: candidate, sheets: tier.map((entry) => entry.sheet), poseMatch: want.pose === null || best >= 2 };
      }
      return null;
    },
    async write(sheet) {
      if (known(sheet)) return;
      added.push({ sheet, origin: `cache/${cacheName(sheet)}.json` });
      if (cacheDir === null) return;
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const file = join(cacheDir, `${cacheName(sheet)}.json`);
      await writeFile(`${file}.part`, JSON.stringify(sheet), { mode: 0o600 });
      await rename(`${file}.part`, file);
    },
    subjects() {
      return [...new Set(all().map((entry) => entry.sheet.subject))].sort();
    },
    count() {
      return all().length;
    },
  };
}

